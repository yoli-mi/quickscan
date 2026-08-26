# QuickScan · 轻量桌面扫码工具

[English](#english) | 中文

常驻系统托盘的二维码扫码器：按快捷键呼出，**截屏框选**屏幕上任意二维码——网页、聊天窗口、图片,立即识别，一键复制或打开。

## 使用

1. 按 `Ctrl+Alt+Q`（默认快捷键）呼出小部件
2. 点击「截屏扫码」，屏幕进入框选模式
3. 拖拽框选二维码后自动识别
4. 结果卡片：一键复制 / 浏览器打开；自动收起（可配置）

也可以直接把二维码图片 `Ctrl+V` 粘贴或拖入窗口识别。

## 功能

- **截屏框选识别**：全屏覆盖 + 拖拽选区（实时尺寸标注），松手即识别
- 结果自动分类：链接 / WiFi / 文本；一键复制、浏览器打开
- **全局快捷键**呼出 / 收起（默认 `Ctrl+Alt+Q`；设置中点击后直接按下新组合键即生效）
- 极简风格动效
- 系统托盘常驻：左键呼出，右键菜单（呼出 / 设置 / 退出）
- 粘贴 / 拖拽图片识别；明暗模式跟随系统

## 技术栈与轻量化

- **Tauri 2**（Rust + WebView2）：安装包 **~1.4 MB**，驻留内存 **~30 MB**
- 原生 TypeScript + Vite，零前端框架；jsQR 解码（仅对框选区域解码）
- 截屏：`xcap` 抓主屏 RGBA 直传（无图片编码开销），用完即删、画布即释
- 动画只走 `transform` / `opacity`（GPU 合成）；`prefers-reduced-motion` 自动降级
- release 构建：`opt-level=z` + LTO + strip + `panic=abort`
- 设置本地 JSON 持久化，零数据库依赖

## 开发

前置：Node ≥ 18、Rust 工具链、WebView2 运行时（Windows 10/11 自带）。

```bash
npm install
npm run tauri dev     # 开发（热更新）
npm run tauri build   # 打包 NSIS / MSI 安装包
```

> 国内环境建议配置 rsproxy.cn 镜像加速 cargo，并将 rustup 安装到纯 ASCII 路径。

---

<a name="english"></a>

# QuickScan · Lightweight Desktop QR Scanner

中文 | [English](#english)

A tray-resident QR code scanner: press a hotkey, **frame-select any QR code on your screen** — on web pages, in chat windows, inside images — and get the result instantly, ready to copy or open. **No phone, no browser, nearly zero footprint.**

## Usage

1. Press `Ctrl+Alt+Q` (customizable) to summon the widget
2. Click "Capture & Scan" — the screen enters selection mode
3. Drag to frame the QR code → decoded instantly
4. Result card: copy / open in browser; auto-collapse (configurable)

You can also paste (`Ctrl+V`) or drag an image with a QR code onto the widget.

## Features

- **Screen-capture selection**: fullscreen overlay with drag selection (live size hint), decode on release
- Auto classification: URL / Wi-Fi / text; one-click copy and open-in-browser
- **Global hotkey** to show/hide (default `Ctrl+Alt+Q`; in settings, click and press a new combo — applied instantly)
- Apple-style motion: pops in from the tray corner, collapses back along the mirrored path
- Dedicated settings page: auto-copy, sound, always-on-top, launch at startup, auto-hide
- Tray icon: left-click to summon; right-click menu (show / settings / quit)
- Paste / drag-image decoding; light/dark theme follows the system

## Tech & Footprint

- **Tauri 2** (Rust + WebView2): installer **~1.4 MB**, resident memory **~30 MB**
- Plain TypeScript + Vite, zero frontend framework; jsQR decodes only the selected region
- Capture: raw RGBA via `xcap` (no image-encoding overhead); temp file deleted right after use, canvas released on exit
- Animations use only `transform` / `opacity` (GPU-composited); honors `prefers-reduced-motion`
- Release build: `opt-level=z` + LTO + strip + `panic=abort`
- Settings persisted as local JSON — no database

## Development

Prerequisites: Node ≥ 18, Rust toolchain, WebView2 Runtime (bundled with Windows 10/11).

```bash
npm install
npm run tauri dev     # dev mode (HMR)
npm run tauri build   # build NSIS / MSI installers
```


