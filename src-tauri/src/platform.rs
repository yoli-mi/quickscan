// ---------------- 平台打开支持（链接白名单 + 协议检测 + 夸克客户端直启） ----------------

use std::time::Duration;

use tauri::State;

use crate::AppState;

/// 允许直接唤起的协议白名单（防止扫码内容触发任意系统处理器）
const SAFE_SCHEMES: &[&str] = &[
    "http", "https", "weixin", "wechat", "wxp", "mqq", "mqqapi", "qq",
    "bilibili", "alipay", "alipays", "taobao", "tbopen",
];

/// 按内容打开：http(s) 走浏览器，纯应用协议（weixin:// 等）交系统路由到对应应用
#[tauri::command]
pub fn open_content(content: String) -> Result<(), String> {
    let Some((scheme, _)) = content.split_once(':') else {
        return Err("内容不是可打开的链接".into());
    };
    let scheme = scheme.to_ascii_lowercase();
    if !SAFE_SCHEMES.contains(&scheme.as_str()) {
        return Err(format!("出于安全考虑，不支持打开 {scheme}:// 类型的内容"));
    }
    tauri_plugin_opener::open_url(content, None::<&str>).map_err(|e| e.to_string())
}

/// 检测某协议/类是否有应用注册（HKCU / HKLM 的 Software\Classes）
#[tauri::command]
pub fn is_scheme_registered(scheme: String) -> bool {
    use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    let sub = format!("Software\\Classes\\{}", scheme.trim());
    if RegKey::predef(HKEY_CURRENT_USER).open_subkey(&sub).is_ok() {
        return true;
    }
    if RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(&sub).is_ok() {
        return true;
    }
    RegKey::predef(HKEY_CLASSES_ROOT).open_subkey(&sub).is_ok()
}

/// 解析短链（如 b23.tv）→ 跟随重定向取最终真实链接
#[tauri::command]
pub async fn resolve_url(url: String) -> Result<String, String> {
    if !url.to_ascii_lowercase().starts_with("http") {
        return Err("仅支持解析 http(s) 链接".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let agent: ureq::Agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(4))
            .timeout(Duration::from_secs(6))
            .build();
        match agent.get(&url).call() {
            Ok(resp) => Ok(resp.get_url().to_string()),
            Err(ureq::Error::Status(_, resp)) => Ok(resp.get_url().to_string()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 用夸克客户端打开链接（从注册表 QuarkHTM.html 处理器解析出 quark.exe 路径）
#[tauri::command]
pub fn open_with_quark(_state: State<'_, AppState>, url: String) -> Result<(), String> {
    use winreg::enums::HKEY_CLASSES_ROOT;
    use winreg::RegKey;
    let sub = "Software\\Classes\\QuarkHTM.html\\shell\\open\\command";
    let cmd = RegKey::predef(HKEY_CLASSES_ROOT)
        .open_subkey(sub)
        .and_then(|k| k.get_value::<String, _>(""))
        .map_err(|_| "未找到夸克客户端，请先安装".to_string())?;
    let exe = cmd.split('"').nth(1).ok_or("无法解析夸克客户端路径")?;
    std::process::Command::new(exe)
        .args(["--brand-quark", &url])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
