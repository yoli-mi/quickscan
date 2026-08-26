import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import jsQR from "jsqr";

type Kind = "url" | "wifi" | "text";

interface ScanResult {
  content: string;
  kind: Kind;
  at: number;
}

interface Settings {
  hotkey: string;
  autoCopy: boolean;
  sound: boolean;
  alwaysOnTop: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- 小部件 ----
const hero = $("hero");
const btnCapture = $<HTMLButtonElement>("btn-capture");
const resultSheet = $("result-sheet");
const resultType = $("result-type");
const resultContent = $("result-content");
const btnCopy = $("btn-copy");
const btnOpen = $("btn-open");
const scanApp = $("app");
const settingsPage = $("settings-page");
const hotkeyHint = $("hotkey-hint");
const hotkeyBtn = $("hotkey-btn");
let hotkeyCapturing = false;
const toastEl = $("toast");

// ---- 全屏框选 ----
const overlay = $("capture-overlay");
const canvas = $<HTMLCanvasElement>("capture-canvas");
const selRect = $("sel-rect");
const selSize = $("sel-size");
const maskTop = $("mask-top");
const maskBottom = $("mask-bottom");
const maskLeft = $("mask-left");
const maskRight = $("mask-right");
const cResultSheet = $("capture-result");
const cResultType = $("c-result-type");
const cResultContent = $("c-result-content");
const cBtnCopy = $("c-btn-copy");
const cBtnOpen = $("c-btn-open");

const decodeCanvas = document.createElement("canvas");
const decodeCtx = decodeCanvas.getContext("2d", { willReadFrequently: true })!;

let settings: Settings = {
  hotkey: "Ctrl+Alt+Q",
  autoCopy: false,
  sound: true,
  alwaysOnTop: true,
};

let audioCtx: AudioContext | null = null;

// ---- 框选状态 ----
let capW = 0; // 截图像素宽
let capH = 0; // 截图像素高
let capCssW = 0; // 窗口 CSS 宽
let capCssH = 0;
let drag: { x0: number; y0: number; x: number; y: number; active: boolean } = {
  x0: 0,
  y0: 0,
  x: 0,
  y: 0,
  active: false,
};
let captureActive = false;
let lastDetected = { text: "", at: 0 };
let resultEntry: ScanResult | null = null;

// ---------------- 生命周期 ----------------

void listen("scan-window-shown", () => {
  document.body.classList.add("window-visible");
  showSettings(false);
  hideResult();
  btnCapture.focus();
});

void listen("scan-window-hidden", () => {
  document.body.classList.remove("window-visible");
  // 播放收起动效（壳收缩下沉，与呼出的弹性放大镜像）；随后清理，避免残留状态
  document.body.classList.add("closing");
  window.setTimeout(() => document.body.classList.remove("closing"), 420);
  resetCapture();
});

void listen("capture-mode-on", (e) => {
  // 进入框选：立即隐藏小部件外壳（双保险，避免框选画面里出现 UI）
  document.body.classList.remove("window-visible");
  // Rust 已截好屏：payload = [文件路径, 宽, 高]
  const payload = e.payload as [string, number, number];
  void beginCapture(payload[0], payload[1], payload[2]);
});

void listen("open-settings", () => {
  showSettings(true);
});

void listen("hotkey-changed", (e) => {
  if (typeof e.payload === "string") hotkeyHint.textContent = e.payload;
});

// ---------------- 截屏框选 ----------------

async function beginCapture(path: string, w: number, h: number): Promise<void> {
  resetCapture();
  captureActive = true;
  overlay.hidden = false;
  document.body.classList.add("capturing");
  try {
    const url = convertFileSrc(path);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`读取截屏失败: ${resp.status}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    capW = w;
    capH = h;
    capCssW = window.innerWidth;
    capCssH = window.innerHeight;
    canvas.width = capW;
    canvas.height = capH;
    const ctx = canvas.getContext("2d")!;
    const imageData = new ImageData(new Uint8ClampedArray(buf), capW, capH);
    ctx.putImageData(imageData, 0, 0);
  } catch (err) {
    console.error("capture failed:", err);
    toast(`截屏失败：${err instanceof Error ? err.message : String(err)}`);
    await exitCapture();
  }
}

function resetCapture(): void {
  captureActive = false;
  overlay.hidden = true;
  document.body.classList.remove("capturing");
  drag.active = false;
  selRect.classList.remove("show");
  // 清掉上次框选的残留：遮罩尺寸与选区样式
  selRect.style.left = "0px";
  selRect.style.top = "0px";
  selRect.style.width = "0px";
  selRect.style.height = "0px";
  hideMasks();
  hideCaptureResult();
  // 释放全屏截图画布（约 8MB 位图），下次进入重绘
  canvas.width = 1;
  canvas.height = 1;
}

function selRectCss(): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(drag.x0, drag.x),
    y: Math.min(drag.y0, drag.y),
    w: Math.abs(drag.x - drag.x0),
    h: Math.abs(drag.y - drag.y0),
  };
}

function updateMasks(): void {
  const r = selRectCss();
  maskTop.style.top = "0";
  maskTop.style.left = "0";
  maskTop.style.width = "100%";
  maskTop.style.height = `${r.y}px`;
  maskBottom.style.top = `${r.y + r.h}px`;
  maskBottom.style.left = "0";
  maskBottom.style.width = "100%";
  maskBottom.style.height = `${capCssH - r.y - r.h}px`;
  maskLeft.style.top = `${r.y}px`;
  maskLeft.style.left = "0";
  maskLeft.style.width = `${r.x}px`;
  maskLeft.style.height = `${r.h}px`;
  maskRight.style.top = `${r.y}px`;
  maskRight.style.left = `${r.x + r.w}px`;
  maskRight.style.width = `${capCssW - r.x - r.w}px`;
  maskRight.style.height = `${r.h}px`;
}

function onPointerDown(e: PointerEvent): void {
  if (!captureActive || cResultSheet.classList.contains("show")) return;
  drag.x0 = e.clientX;
  drag.y0 = e.clientY;
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.active = true;
  selRect.classList.add("show");
  selRect.style.left = "0px";
  selRect.style.top = "0px";
  selRect.style.width = "0px";
  selRect.style.height = "0px";
  updateMasks();
}

function onPointerMove(e: PointerEvent): void {
  if (!drag.active) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  const r = selRectCss();
  selRect.style.left = `${r.x}px`;
  selRect.style.top = `${r.y}px`;
  selRect.style.width = `${r.w}px`;
  selRect.style.height = `${r.h}px`;
  selSize.textContent = `${Math.round(r.w * (capW / capCssW))} × ${Math.round(
    r.h * (capH / capCssH),
  )}`;
  updateMasks();
}

async function onPointerUp(): Promise<void> {
  if (!drag.active) return;
  drag.active = false;
  const r = selRectCss();
  if (r.w < 14 || r.h < 14) {
    selRect.classList.remove("show");
    return;
  }
  await decodeRegion(r);
}

async function decodeRegion(r: { x: number; y: number; w: number; h: number }): Promise<void> {
  if (capW === 0) return;
  const rx = capW / capCssW;
  const ry = capH / capCssH;
  const sx = Math.max(0, Math.round(r.x * rx));
  const sy = Math.max(0, Math.round(r.y * ry));
  const sw = Math.min(capW - sx, Math.round(r.w * rx));
  const sh = Math.min(capH - sy, Math.round(r.h * ry));
  decodeCanvas.width = sw;
  decodeCanvas.height = sh;
  decodeCtx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  const img = decodeCtx.getImageData(0, 0, sw, sh);
  const code = jsQR(img.data, sw, sh, { inversionAttempts: "attemptBoth" });
  if (code && code.data) {
    onDetected(code.data, true);
  } else {
    toast("所选区域没有二维码，请重新框选");
    selRect.classList.remove("show");
    hideMasks();
  }
}

// ---------------- 识别结果 ----------------

function onDetected(text: string, fromCapture: boolean): void {
  const now = Date.now();
  if (text === lastDetected.text && now - lastDetected.at < 2500) return;
  lastDetected = { text, at: now };

  const entry: ScanResult = { content: text, kind: classify(text), at: now };
  resultEntry = entry;
  showSuccessFeedback(fromCapture);
  if (fromCapture) {
    showCaptureResult(entry);
  } else {
    showResult(entry);
  }
  // 结果页不自动消失，由用户手动关闭（复制/打开/×/Esc）
  if (settings.autoCopy) {
    void copyNow(entry.content, true, fromCapture);
  }
}

function classify(text: string): Kind {
  if (/^https?:\/\//i.test(text)) return "url";
  if (/^WIFI:/i.test(text)) return "wifi";
  return "text";
}

function fillResultSheet(
  typeEl: HTMLElement,
  contentEl: HTMLElement,
  entry: ScanResult,
): void {
  const kindLabel: Record<Kind, string> = { url: "链接", wifi: "WiFi", text: "文本" };
  typeEl.textContent = kindLabel[entry.kind];
  contentEl.textContent = entry.kind === "wifi" ? formatWifi(entry.content) : entry.content;
  contentEl.title = entry.content;
  contentEl.classList.toggle("long", entry.content.length > 56);
}

function showResult(entry: ScanResult): void {
  fillResultSheet(resultType, resultContent, entry);
  btnOpen.classList.toggle("hidden", entry.kind !== "url");
  resultSheet.classList.add("show");
  resultSheet.setAttribute("aria-hidden", "false");
  void invoke("set_result_open", { open: true });
}

function hideResult(): void {
  resultSheet.classList.remove("show");
  resultSheet.setAttribute("aria-hidden", "true");
  void invoke("set_result_open", { open: false });
}

function showCaptureResult(entry: ScanResult): void {
  fillResultSheet(cResultType, cResultContent, entry);
  cBtnOpen.classList.toggle("hidden", entry.kind !== "url");
  cResultSheet.classList.add("show");
  cResultSheet.setAttribute("aria-hidden", "false");
  void invoke("set_result_open", { open: true });
}

function hideCaptureResult(): void {
  cResultSheet.classList.remove("show");
  cResultSheet.setAttribute("aria-hidden", "true");
  void invoke("set_result_open", { open: false });
}

function formatWifi(text: string): string {
  const m = /S:([^;]*)/.exec(text);
  return m ? `WiFi 名称：${m[1]}` : text;
}

async function copyNow(text: string, silent = false, _fromCapture = false): Promise<void> {
  try {
    await invoke("copy_text", { text });
    if (!silent) toast("已复制到剪贴板");
    // 复制后结果页保留，由用户手动关闭
  } catch {
    toast("复制失败");
  }
}

function showSuccessFeedback(fromCapture: boolean): void {
  if (settings.sound) playSuccess();
  if (fromCapture) {
    selRect.classList.add("success");
    window.setTimeout(() => selRect.classList.remove("success"), 700);
  } else {
    hero.classList.add("success");
    window.setTimeout(() => hero.classList.remove("success"), 700);
  }
}

/** WebAudio 合成轻提示音，零资源文件 */
function playSuccess(): void {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1046.5, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.14, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.17);
  } catch {
    /* 音频不可用时静默忽略 */
  }
}

// ---------------- 图片识别（粘贴 / 拖拽） ----------------

async function decodeFile(file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("图片加载失败"));
      img.src = url;
    });
    const scale = Math.min(1, 960 / Math.max(img.width, img.height));
    decodeCanvas.width = Math.round(img.width * scale);
    decodeCanvas.height = Math.round(img.height * scale);
    decodeCtx.drawImage(img, 0, 0, decodeCanvas.width, decodeCanvas.height);
    const data = decodeCtx.getImageData(0, 0, decodeCanvas.width, decodeCanvas.height);
    const code = jsQR(data.data, decodeCanvas.width, decodeCanvas.height, {
      inversionAttempts: "attemptBoth",
    });
    if (code && code.data) {
      onDetected(code.data, false);
    } else {
      toast("未在图片中找到二维码");
    }
  } catch {
    toast("图片读取失败");
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------- 模式切换 ----------------

async function startCapture(): Promise<void> {
  try {
    await invoke("enter_capture_mode");
  } catch (err) {
    toast(String(err));
  }
}

async function exitCapture(): Promise<void> {
  await invoke("exit_capture_mode");
}

function hideMasks(): void {
  maskTop.style.height = "0";
  maskBottom.style.height = "0";
  maskLeft.style.width = "0";
  maskRight.style.width = "0";
}

// ---------------- 视图切换 / 提示 ----------------

/** 设置页为独立整页：与扫码页互斥显示，并让窗口平滑切换到对应尺寸 */
function showSettings(on: boolean): void {
  settingsPage.hidden = !on;
  scanApp.hidden = on;
  void invoke("set_view", { settings: on });
}

function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  window.setTimeout(() => toastEl.classList.remove("show"), 1600);
}

async function hideWindow(): Promise<void> {
  await invoke("hide_window");
}

// ---------------- 设置 ----------------

function syncSettingsUI(): void {
  hotkeyHint.textContent = settings.hotkey;
  if (!hotkeyCapturing) hotkeyBtn.textContent = settings.hotkey;
  setSwitch($("sw-autocopy"), settings.autoCopy);
  setSwitch($("sw-sound"), settings.sound);
  setSwitch($("sw-pin"), settings.alwaysOnTop);
}

function setSwitch(el: HTMLElement, on: boolean): void {
  el.classList.toggle("on", on);
  el.setAttribute("aria-checked", String(on));
}

async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  settings[key] = value;
  await invoke("set_setting", { key, value });
}

// ---------------- 快捷键捕获 ----------------

function cancelHotkeyCapture(): void {
  hotkeyCapturing = false;
  hotkeyBtn.classList.remove("listening");
  hotkeyBtn.textContent = settings.hotkey;
}

/** 从按键事件组合出 "Ctrl+Alt+Q" 样式；null=还在等主键，""=不合法 */
function hotkeyComboFromEvent(e: KeyboardEvent): string | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.metaKey) mods.push("Super");
  if (e.shiftKey) mods.push("Shift");
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return "";
  let key = e.key;
  if (key.length === 1 && /[a-z0-9]/i.test(key)) {
    key = key.toUpperCase();
  } else if (/^F\d{1,2}$/.test(key)) {
    /* 功能键原样 */
  } else if (key.startsWith("Arrow")) {
    key = key.slice(5);
  } else if (["Space", "Home", "End", "PageUp", "PageDown"].includes(key)) {
    /* 原样 */
  } else {
    return "";
  }
  return [...mods, key].join("+");
}

async function applyHotkey(combo: string): Promise<void> {
  try {
    const saved = await invoke<string>("set_hotkey", { key: combo });
    settings.hotkey = saved;
    cancelHotkeyCapture();
    toast("快捷键已更新");
  } catch (err) {
    toast(String(err).replace(/^Error invoking remote function 'set_hotkey': /, ""));
    cancelHotkeyCapture();
  }
}

// ---------------- 事件绑定 ----------------

function bindEvents(): void {
  // 主入口
  btnCapture.addEventListener("click", () => void startCapture());

  // 小部件结果卡片
  btnCopy.addEventListener("click", () => {
    if (resultEntry) void copyNow(resultEntry.content);
  });
  btnOpen.addEventListener("click", () => {
    if (resultEntry && resultEntry.kind === "url") {
      void invoke("open_url", { url: resultEntry.content });
      void hideWindow();
    }
  });
  $("result-close").addEventListener("click", () => hideResult());

  // 框选结果卡片
  cBtnCopy.addEventListener("click", () => {
    if (resultEntry) void copyNow(resultEntry.content, false, true);
  });
  cBtnOpen.addEventListener("click", () => {
    if (resultEntry && resultEntry.kind === "url") {
      void invoke("open_url", { url: resultEntry.content });
      void exitCapture();
    }
  });
  $("c-result-close").addEventListener("click", () => {
    hideCaptureResult();
    selRect.classList.remove("show");
    hideMasks();
  });

  // 设置项
  $("sw-autocopy").addEventListener("click", (e) => {
    const el = e.currentTarget as HTMLElement;
    void setSetting("autoCopy", !el.classList.contains("on")).then(syncSettingsUI);
  });
  $("sw-sound").addEventListener("click", (e) => {
    const el = e.currentTarget as HTMLElement;
    void setSetting("sound", !el.classList.contains("on")).then(syncSettingsUI);
  });
  $("sw-pin").addEventListener("click", (e) => {
    const el = e.currentTarget as HTMLElement;
    void setSetting("alwaysOnTop", !el.classList.contains("on")).then(syncSettingsUI);
  });
  $("sw-autostart").addEventListener("click", async (e) => {
    const el = e.currentTarget as HTMLElement;
    const next = !el.classList.contains("on");
    try {
      await invoke("set_autostart", { enabled: next });
      setSwitch(el, next);
      toast(next ? "已开启开机自启动" : "已关闭开机自启动");
    } catch (err) {
      toast(String(err));
    }
  });

  // 快捷键：点击捕获 —— 按下组合键立即生效，无需保存
  hotkeyBtn.addEventListener("click", () => {
    hotkeyCapturing = true;
    hotkeyBtn.classList.add("listening");
    hotkeyBtn.textContent = "按下新组合键…";
  });

  // 键盘
  document.addEventListener("keydown", (e) => {
    // 快捷键捕获模式：优先于其他按键逻辑
    if (hotkeyCapturing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        cancelHotkeyCapture();
        return;
      }
      const combo = hotkeyComboFromEvent(e);
      if (combo === null) return; // 只按了修饰键，继续等主键
      if (combo === "") {
        toast("需包含 Ctrl / Alt / Shift 等修饰键");
        return;
      }
      void applyHotkey(combo);
      return;
    }
    if (e.key !== "Escape") return;
    if (captureActive) {
      if (cResultSheet.classList.contains("show")) {
        hideCaptureResult();
        selRect.classList.remove("show");
        hideMasks();
      } else {
        void exitCapture();
      }
    } else {
      if (!settingsPage.hidden) {
        showSettings(false);
        return;
      }
      if (resultSheet.classList.contains("show")) {
        hideResult();
      } else {
        void hideWindow();
      }
    }
  });

  // 粘贴图片
  document.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) void decodeFile(file);
        return;
      }
    }
  });

  // 拖拽图片
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (file) void decodeFile(file);
  });

  // 设置页返回
  $("btn-back").addEventListener("click", () => showSettings(false));

  // 框选拖拽
  canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", () => void onPointerUp());
}

// ---------------- 启动 ----------------

async function init(): Promise<void> {
  bindEvents();
  settings = await invoke<Settings>("get_settings");
  syncSettingsUI();
  // 开机自启动状态以系统为准（注册表），启动时同步一次
  try {
    setSwitch($("sw-autostart"), await invoke<boolean>("get_autostart"));
  } catch {
    /* 忽略 */
  }
  // 页面加载/重载后同步窗口可见状态（HMR 重载会让外壳保持透明）
  try {
    const visible = await getCurrentWindow().isVisible();
    document.body.classList.toggle("window-visible", visible);
  } catch {
    /* 忽略 */
  }
}

void init();
