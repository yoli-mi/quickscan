use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, State,
    WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const DEFAULT_HOTKEY: &str = "Ctrl+Alt+Q";
const WIDGET_SIZE: (u32, u32) = (420, 400);
/// 设置页独立尺寸：更窄、更高
const SETTINGS_SIZE: (u32, u32) = (380, 480);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    hotkey: String,
    auto_copy: bool,
    sound: bool,
    auto_hide_seconds: u32,
    always_on_top: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: DEFAULT_HOTKEY.into(),
            auto_copy: false,
            sound: true,
            auto_hide_seconds: 5,
            always_on_top: true,
        }
    }
}

struct AppState {
    settings: Mutex<Settings>,
    /// 截屏框选模式（全屏覆盖）进行中：期间禁用"失焦自动隐藏"
    capture_active: Mutex<bool>,
    /// 窗口逻辑可见状态（与 is_visible 解耦，避免异步隐藏/线程竞态导致状态错乱）
    window_shown: AtomicBool,
    /// 结果卡片展示中：期间禁用"失焦自动隐藏"（用户可能切去别处对照/粘贴）
    result_open: AtomicBool,
}

// ---------------- 持久化（本地 JSON，零依赖） ----------------

fn config_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))
}

fn load_settings(app: &AppHandle) -> Settings {
    let Ok(dir) = config_dir(app) else {
        return Settings::default();
    };
    let Ok(text) = std::fs::read_to_string(dir.join("settings.json")) else {
        return Settings::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) {
    let Ok(dir) = config_dir(app) else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(text) = serde_json::to_string_pretty(s) {
        let _ = std::fs::write(dir.join("settings.json"), text);
    }
}

// ---------------- 屏幕截取 ----------------

/// 截取主屏并写入缓存文件，返回 (文件路径, 宽, 高)
fn capture_screen_to_file(app: &AppHandle) -> Result<(String, u32, u32), String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    // 明确选主显示器（机器上可能有虚拟显示器，first() 不一定是主屏）
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or("未找到显示器")?;
    let image = monitor.capture_image().map_err(|e| e.to_string())?;
    let (w, h) = image.dimensions();
    let raw = image.into_raw();

    let cache_dir = app
        .path()
        .cache_dir() // 系统缓存目录，对应 asset 协议作用域中的 $CACHE
        .map_err(|e| format!("无法定位缓存目录: {e}"))?;
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let path = cache_dir.join("quickscan-capture.rgba");
    std::fs::write(&path, raw).map_err(|e| e.to_string())?;
    // 前端异步拉取后清理缓存文件（约 8MB，不留盘）
    let cleanup = path.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(3000));
        let _ = std::fs::remove_file(&cleanup);
    });
    Ok((path.to_string_lossy().into_owned(), w, h))
}

// ---------------- 窗口控制 ----------------

/// 主屏上某逻辑宽度窗口的顶部居中位置
fn centered_position(app: &AppHandle, logical_w: u32) -> Option<(i32, i32)> {
    let mon = app.primary_monitor().ok().flatten()?;
    let area = mon.work_area();
    let sf = mon.scale_factor();
    let w = (logical_w as f64 * sf) as u32;
    let x = area.position.x + (area.size.width.saturating_sub(w)) as i32 / 2;
    let y = area.position.y + 48;
    Some((x, y))
}

/// 主屏上小部件的最终位置（顶部居中）
fn widget_position(app: &AppHandle) -> Option<(i32, i32)> {
    centered_position(app, WIDGET_SIZE.0)
}

/// 按已知小部件尺寸（×主屏缩放系数）计算顶部居中位置
/// 用 primary_monitor 而非 current_monitor：隐藏/移动中的窗口 current_monitor 不稳定
fn position_widget(app: &AppHandle) {
    if let Some((x, y)) = widget_position(app) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.set_position(Position::Physical(PhysicalPosition::new(x, y)));
        }
    }
}

fn resize_widget(app: &AppHandle) {
    if let Ok(Some(mon)) = app.primary_monitor() {
        let sf = mon.scale_factor();
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.set_size(Size::Physical(PhysicalSize::new(
                (WIDGET_SIZE.0 as f64 * sf) as u32,
                (WIDGET_SIZE.1 as f64 * sf) as u32,
            )));
        }
    }
}

/// 主屏工作区右下角（托盘区上方）——呼出的起点 / 收起的终点
/// 尺寸取窗口实际值（扫码/设置两视图宽度高度不同）
fn tray_corner(app: &AppHandle, fallback: (i32, i32)) -> (i32, i32) {
    let w_ok = app.primary_monitor().ok().flatten();
    let size = app
        .get_webview_window("main")
        .and_then(|w| w.inner_size().ok())
        .map(|s| (s.width as i32, s.height as i32));
    if let (Some(mon), Some((w, h))) = (w_ok, size) {
        if w > 0 && h > 0 {
            let area = mon.work_area();
            return (
                area.position.x + area.size.width as i32 - w - 8,
                area.position.y + area.size.height as i32 - h - 8,
            );
        }
    }
    fallback
}

/// 呼出：窗口从右下角托盘区弹入到顶部居中（easeOutCubic 位置动画）
fn show_window(app: &AppHandle) {
    app.state::<AppState>().window_shown.store(true, Ordering::SeqCst);
    let Some(win) = app.get_webview_window("main") else { return };
    resize_widget(app);

    let (end_x, end_y) = widget_position(app).unwrap_or((685, 48));
    let (start_x, start_y) = tray_corner(app, (end_x, end_y));

    let _ = win.set_position(Position::Physical(PhysicalPosition::new(start_x, start_y)));
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit("scan-window-shown", ());

    // 位置动画：约 360ms，easeOutCubic
    // 纳入 VIEW_GEN 代数守卫：托盘"设置"等场景下 set_view 动画可接管，避免双线程竞写位置
    let gen = VIEW_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        const FRAMES: usize = 22;
        const STEP_MS: u64 = 16;
        for i in 1..=FRAMES {
            if VIEW_GEN.load(Ordering::SeqCst) != gen {
                return; // 已被 set_view 等更新的动画接管
            }
            let t = i as f64 / FRAMES as f64;
            let e = 1.0 - (1.0 - t).powi(3);
            let x = start_x as f64 + (end_x as f64 - start_x as f64) * e;
            let y = start_y as f64 + (end_y as f64 - start_y as f64) * e;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_position(Position::Physical(PhysicalPosition::new(
                    x.round() as i32,
                    y.round() as i32,
                )));
            }
            std::thread::sleep(Duration::from_millis(STEP_MS));
        }
    });
}

/// 收起：窗口从当前位置滑回右下角托盘区（easeInCubic 位置动画，与呼出的 easeOutCubic 镜像），
/// 前端同时播放壳收缩；动画播完再真正隐藏。
/// 动画线程每帧检查"逻辑可见状态"——期间重新呼出（window_shown 变 true）则交还 show_window
fn hide_window_smooth(app: &AppHandle) {
    app.state::<AppState>().window_shown.store(false, Ordering::SeqCst);
    *app.state::<AppState>().capture_active.lock().unwrap() = false;

    let (target_x, target_y) = tray_corner(app, widget_position(app).unwrap_or((685, 48)));
    // 起点：当前窗口位置（可能是动画中途被再次呼出再收起，也能平滑衔接）
    let (start_x, start_y) = app
        .get_webview_window("main")
        .and_then(|w| w.outer_position().ok())
        .map(|p| (p.x, p.y))
        .unwrap_or((target_x, target_y));

    let _ = app.emit("scan-window-hidden", ());

    // 位置动画：约 350ms，easeInCubic
    let app = app.clone();
    std::thread::spawn(move || {
        const FRAMES: usize = 22;
        const STEP_MS: u64 = 16;
        for i in 1..=FRAMES {
            if app.state::<AppState>().window_shown.load(Ordering::SeqCst) {
                return; // 动画期间被重新呼出：位置交给 show_window，不隐藏
            }
            let t = i as f64 / FRAMES as f64;
            let e = t * t * t;
            let x = start_x as f64 + (target_x as f64 - start_x as f64) * e;
            let y = start_y as f64 + (target_y as f64 - start_y as f64) * e;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_position(Position::Physical(PhysicalPosition::new(
                    x.round() as i32,
                    y.round() as i32,
                )));
            }
            std::thread::sleep(Duration::from_millis(STEP_MS));
        }
        // 留给前端壳收缩的收尾时间
        std::thread::sleep(Duration::from_millis(120));
        if !app.state::<AppState>().window_shown.load(Ordering::SeqCst) {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.hide();
            }
        }
    });
}

fn toggle_window(app: &AppHandle) {
    if app.state::<AppState>().window_shown.load(Ordering::SeqCst) {
        hide_window_smooth(app);
    } else {
        show_window(app);
    }
}

// ---------------- 托盘 ----------------

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "呼出扫码", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &settings, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().unwrap())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(format!("QuickScan · {DEFAULT_HOTKEY} 呼出"))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => toggle_window(app),
            "settings" => {
                show_window(app);
                let _ = app.emit("open-settings", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// ---------------- 全局快捷键 ----------------

fn register_hotkey(app: &AppHandle) -> Result<(), String> {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    let sc: tauri_plugin_global_shortcut::Shortcut = s
        .hotkey
        .parse()
        .map_err(|e| format!("快捷键解析失败: {e}"))?;
    app.global_shortcut()
        .register(sc)
        .map_err(|e| format!("快捷键注册失败（可能被其他程序占用）: {e}"))
}

// ---------------- 命令 ----------------

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn set_setting(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let mut s = state.settings.lock().unwrap();
    match key.as_str() {
        "autoCopy" => s.auto_copy = value.as_bool().unwrap_or(s.auto_copy),
        "sound" => s.sound = value.as_bool().unwrap_or(s.sound),
        "autoHideSeconds" => {
            s.auto_hide_seconds = value.as_u64().unwrap_or(s.auto_hide_seconds as u64) as u32
        }
        "alwaysOnTop" => {
            s.always_on_top = value.as_bool().unwrap_or(s.always_on_top);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_always_on_top(s.always_on_top);
            }
        }
        _ => return Err("未知设置项".into()),
    }
    let snapshot = s.clone();
    drop(s);
    save_settings(&app, &snapshot);
    Ok(())
}

#[tauri::command]
fn set_hotkey(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<String, String> {
    let trimmed = key.trim().to_string();
    if trimmed.is_empty() {
        return Err("快捷键不能为空".into());
    }
    let shortcut = trimmed
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| format!("快捷键格式无法识别（示例：Ctrl+Alt+Q）: {e}"))?;

    let mut s = state.settings.lock().unwrap();
    if s.hotkey == trimmed {
        return Ok(trimmed);
    }
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| format!("注销旧快捷键失败: {e}"))?;
    if let Err(e) = app.global_shortcut().register(shortcut) {
        // 注册失败则恢复旧快捷键
        if let Ok(old) = s.hotkey.parse::<tauri_plugin_global_shortcut::Shortcut>() {
            let _ = app.global_shortcut().register(old);
        }
        return Err(format!("快捷键注册失败（可能被其他程序占用）: {e}"));
    }
    s.hotkey = trimmed.clone();
    let snapshot = s.clone();
    drop(s);
    save_settings(&app, &snapshot);
    let _ = app.emit("hotkey-changed", trimmed.clone());
    Ok(trimmed)
}

#[tauri::command]
fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard()
        .write_text(&text)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    hide_window_smooth(&app);
}

/// 进入截屏框选模式：先隐藏小部件再截屏（避免 UI 进入截图），随后铺满主屏显示
#[tauri::command]
fn enter_capture_mode(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Err("窗口不存在".into());
    };
    // 关键：先隐藏小部件，截屏画面里就不会有小部件本身
    state.window_shown.store(false, Ordering::SeqCst);
    let hide_result = win.hide();
    eprintln!("[quickscan] capture: hide result: {hide_result:?}");
    // 等窗口真正从合成器移除（隐藏是异步生效的，立即截屏会拍到残留的壳）
    std::thread::sleep(Duration::from_millis(250));
    let (path, w, h) = capture_screen_to_file(&app)?;
    let Some(mon) = win.current_monitor().map_err(|e| e.to_string())? else {
        return Err("未找到显示器".into());
    };
    let _ = win.set_always_on_top(true);
    let _ = win.set_position(Position::Physical(*mon.position()));
    let _ = win.set_size(Size::Physical(*mon.size()));
    *state.capture_active.lock().unwrap() = true;
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit("capture-mode-on", (path, w, h));
    Ok(())
}

/// 退出截屏框选模式：恢复小窗尺寸/位置/置顶并收起
#[tauri::command]
fn exit_capture_mode(app: AppHandle, state: State<'_, AppState>) {
    *state.capture_active.lock().unwrap() = false;
    if let Some(win) = app.get_webview_window("main") {
        resize_widget(&app);
        let on_top = state.settings.lock().unwrap().always_on_top;
        let _ = win.set_always_on_top(on_top);
        position_widget(&app);
    }
    hide_window_smooth(&app);
}

// ---------------- 开机自启动 ----------------

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let auto = app.autolaunch();
    if enabled {
        auto.enable().map_err(|e| e.to_string())
    } else {
        auto.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn set_result_open(state: State<'_, AppState>, open: bool) {
    state.result_open.store(open, Ordering::SeqCst);
}

// ---------------- 视图尺寸切换（扫码 ⇄ 设置） ----------------

/// 视图动画代数：新的切换使旧动画失效
static VIEW_GEN: AtomicU64 = AtomicU64::new(0);

/// 扫码页 ⇄ 设置页：窗口尺寸/位置平滑过渡（约 220ms，easeOutCubic），保持顶部居中
#[tauri::command]
fn set_view(app: AppHandle, settings: bool) {
    let gen = VIEW_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(win) = app.get_webview_window("main") else { return };
    let sf = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);

    let target = if settings { SETTINGS_SIZE } else { WIDGET_SIZE };
    let (to_w, to_h) = (
        (target.0 as f64 * sf) as i32,
        (target.1 as f64 * sf) as i32,
    );
    let from_size = win.inner_size().map(|s| (s.width as i32, s.height as i32)).unwrap_or((to_w, to_h));
    let from_pos = win.outer_position().map(|p| (p.x, p.y)).ok();
    let to_pos = centered_position(&app, target.0).unwrap_or_else(|| from_pos.unwrap_or((0, 0)));

    let app = app.clone();
    std::thread::spawn(move || {
        const FRAMES: usize = 14;
        const STEP_MS: u64 = 16;
        for i in 1..=FRAMES {
            if VIEW_GEN.load(Ordering::SeqCst) != gen {
                return; // 已被更新的切换接管
            }
            let t = i as f64 / FRAMES as f64;
            let e = 1.0 - (1.0 - t).powi(3);
            let w = from_size.0 as f64 + (to_w as f64 - from_size.0 as f64) * e;
            let h = from_size.1 as f64 + (to_h as f64 - from_size.1 as f64) * e;
            if let Some(wv) = app.get_webview_window("main") {
                let _ = wv.set_size(Size::Physical(PhysicalSize::new(
                    w.round().max(1.0) as u32,
                    h.round().max(1.0) as u32,
                )));
                if let Some((fx, fy)) = from_pos {
                    let x = fx as f64 + (to_pos.0 as f64 - fx as f64) * e;
                    let y = fy as f64 + (to_pos.1 as f64 - fy as f64) * e;
                    let _ = wv.set_position(Position::Physical(PhysicalPosition::new(
                        x.round() as i32,
                        y.round() as i32,
                    )));
                }
            }
            std::thread::sleep(Duration::from_millis(STEP_MS));
        }
        // 收尾对齐，消除取整误差
        if VIEW_GEN.load(Ordering::SeqCst) == gen {
            if let Some(wv) = app.get_webview_window("main") {
                let _ = wv.set_size(Size::Physical(PhysicalSize::new(to_w as u32, to_h as u32)));
                let _ = wv.set_position(Position::Physical(PhysicalPosition::new(to_pos.0, to_pos.1)));
            }
        }
    });
}

// ---------------- 入口 ----------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例：重复启动时呼出已有窗口
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_window(app);
                    }
                })
                .build(),
        )
        // 自定义协议方案在 WebView2 中无法 fetch，改用命令 + 缓存文件 + asset 协议
        .manage(AppState {
            settings: Mutex::new(Settings::default()),
            capture_active: Mutex::new(false),
            window_shown: AtomicBool::new(false),
            result_open: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_setting,
            set_hotkey,
            copy_text,
            open_url,
            hide_window,
            enter_capture_mode,
            exit_capture_mode,
            get_autostart,
            set_autostart,
            set_view,
            set_result_open
        ])
        .setup(|app| {
            let handle = app.handle();
            {
                let state = handle.state::<AppState>();
                let mut s = state.settings.lock().unwrap();
                *s = load_settings(handle);
            }

            let _window = WebviewWindowBuilder::new(
                handle,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("QuickScan")
            .inner_size(WIDGET_SIZE.0 as f64, WIDGET_SIZE.1 as f64)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .background_color(tauri::window::Color(0, 0, 0, 0))
            .build()
            .expect("failed to build main window");

            // 玻璃效果由 CSS 半透明实现（透明窗口 + 圆角外壳）
            // 不用 Acrylic：它会涂抹整个窗口矩形，圆角外会残留方形边角

            setup_tray(handle)?;
            // 热键注册失败不致命：托盘仍可用，用户可在设置中改键
            if let Err(e) = register_hotkey(handle) {
                eprintln!("[quickscan] 快捷键注册失败: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(false) => {
                // 截屏框选期间、结果展示中或窗口逻辑上已隐藏时不处理；
                // 否则失焦 800ms 后自动收起
                let state = window.app_handle().state::<AppState>();
                if *state.capture_active.lock().unwrap()
                    || state.result_open.load(Ordering::SeqCst)
                    || !state.window_shown.load(Ordering::SeqCst)
                {
                    return;
                }
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(800));
                    if let Some(win) = app.get_webview_window("main") {
                        if !win.is_focused().unwrap_or(true) && win.is_visible().unwrap_or(false) {
                            hide_window_smooth(&app);
                        }
                    }
                });
            }
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                hide_window_smooth(window.app_handle());
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {});
}
