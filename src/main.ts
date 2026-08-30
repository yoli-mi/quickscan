import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { readBarcodes } from "zxing-wasm/reader";

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
  autoScan: boolean;
  openExit: boolean;
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
const multiView = $("multi-view");
const qrMarkers = $("qr-markers");
const multiList = $("multi-list");
const multiCount = $("multi-count");

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
  autoScan: false,
  openExit: false,
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
    // 自动扫码：全屏识别所有二维码，多结果视图逐一定位
    if (settings.autoScan) {
      const found = await scanAll();
      if (found.length === 0) {
        toast("未在屏幕上发现二维码");
        await exitCapture();
        return;
      }
      // 单码也用居中面板（带位置标记），不占满底部
      showMultiResults(found);
      return;
    }
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
  hideMultiResults();
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
  if (!captureActive || cResultSheet.classList.contains("show") || !multiView.hidden) return;
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

// ---------------- 自动扫码（多二维码） ----------------

interface FoundQr {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 全屏扫描：zxing 一次检测所有二维码并返回各自坐标（物理像素 → CSS 像素） */
async function scanAll(): Promise<FoundQr[]> {
  const img = canvas.getContext("2d")!.getImageData(0, 0, capW, capH);
  try {
    const results = await readBarcodes(img, {
      tryHarder: true,
      tryRotate: false,
      tryInvert: true,
      formats: ["QRCode"],
    });

    const rx = capCssW / capW;
    const ry = capCssH / capH;
    // 不按内容去重：相同内容的二维码也要各自独立展示（每个码都有自己的指向标记）
    const out: FoundQr[] = [];
    for (const r of results) {
      if (!r.text) continue;
      const xs = [r.position.topLeft.x, r.position.topRight.x, r.position.bottomLeft.x, r.position.bottomRight.x];
      const ys = [r.position.topLeft.y, r.position.topRight.y, r.position.bottomLeft.y, r.position.bottomRight.y];
      const px = Math.min(...xs);
      const py = Math.min(...ys);
      const w = Math.max(...xs) - px;
      const h = Math.max(...ys) - py;
      if (w < 8 || h < 8) continue; // 过滤误检的退化框
      out.push({ text: r.text, x: px * rx, y: py * ry, w: w * rx, h: h * ry });
    }
    return out;
  } catch {
    return [];
  }
}

function kindLabel(text: string): string {
  const k = classify(text);
  return k === "url" ? "链接" : k === "wifi" ? "WiFi" : "文本";
}

let panelFromManual = false;

function showMultiResults(list: FoundQr[], fromManual = false): void {
  panelFromManual = fromManual;
  qrMarkers.innerHTML = "";
  multiList.innerHTML = "";
  multiCount.textContent = String(list.length);
  list.forEach((it, i) => {
    const marker = document.createElement("div");
    marker.className = "qr-marker";
    marker.style.left = `${it.x - 6}px`;
    marker.style.top = `${it.y - 6}px`;
    marker.style.width = `${it.w + 12}px`;
    marker.style.height = `${it.h + 12}px`;
    const num = document.createElement("span");
    num.className = "qr-num";
    num.textContent = String(i + 1);
    marker.appendChild(num);
    qrMarkers.appendChild(marker);

    const li = document.createElement("li");
    const numEl = document.createElement("span");
    numEl.className = "qr-num";
    numEl.textContent = String(i + 1);
    const text = document.createElement("span");
    text.className = "m-text";
    text.textContent = it.text;
    text.title = it.text;
    const chip = document.createElement("span");
    chip.className = "type-chip";
    chip.textContent = kindLabel(it.text);
    const copy = document.createElement("button");
    copy.className = "m-copy";
    copy.textContent = "复制";
    copy.addEventListener("click", async (e) => {
      e.stopPropagation();
      await invoke("copy_text", { text: it.text });
      toast("已复制到剪贴板");
    });
    li.append(numEl, text, chip, copy);

    // 链接类型：追加「打开」按钮（复用平台引擎：B站深链/夸克客户端/浏览器）
    const rule = matchPlatform(it.text);
    const isUrl = /^https?:\/\//i.test(it.text);
    if (rule || isUrl) {
      const open = document.createElement("button");
      open.className = "m-copy";
      open.textContent = rule ? `在${rule.name}打开` : "打开";
      open.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await openByPlatform(it.text);
          toast(rule ? `已在${rule.name}打开` : "已打开");
          if (settings.openExit || panelFromManual) void exitCapture();
        } catch (err) {
          toast(String(err).replace(/^Error invoking remote function '[^']+': /, ""));
        }
      });
      li.appendChild(open);
    }
    li.addEventListener("mouseenter", () => marker.classList.add("active"));
    li.addEventListener("mouseleave", () => marker.classList.remove("active"));
    multiList.appendChild(li);
  });
  multiView.hidden = false;
}

function hideMultiResults(): void {
  multiView.hidden = true;
  qrMarkers.innerHTML = "";
  multiList.innerHTML = "";
}

/**
 * 带重试的解码（zxing-wasm）：白色静区 + 双尺度，返回内容与全画布 CSS 坐标
 */
async function decodeWithRetry(
  source: HTMLCanvasElement | HTMLImageElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): Promise<FoundQr | null> {
  for (const scale of [1, 2]) {
    const qw = Math.min(Math.round(sw * scale), 2200);
    const qh = Math.max(1, Math.round(qw * (sh / sw)));
    const qz = Math.max(16, Math.round(Math.max(qw, qh) * 0.06));
    decodeCanvas.width = qw + qz * 2;
    decodeCanvas.height = qh + qz * 2;
    decodeCtx.fillStyle = "#ffffff";
    decodeCtx.fillRect(0, 0, decodeCanvas.width, decodeCanvas.height);
    decodeCtx.imageSmoothingEnabled = scale > 1;
    decodeCtx.drawImage(source, sx, sy, sw, sh, qz, qz, qw, qh);
    const img = decodeCtx.getImageData(0, 0, decodeCanvas.width, decodeCanvas.height);
    try {
      const results = await readBarcodes(img, {
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
        formats: ["QRCode"],
      });
      const hit = results.find((r) => r.text);
      if (hit) {
        // 解码画布内坐标 → 全画布 CSS 坐标（扣除静区、除以缩放）
        const rx = capCssW / capW;
        const ry = capCssH / capH;
        const px = hit.position.topLeft.x;
        const py = hit.position.topLeft.y;
        return {
          text: hit.text,
          x: ((qz + px) / scale + sx) * rx,
          y: ((qz + py) / scale + sy) * ry,
          w: ((hit.position.bottomRight.x - px) / scale) * rx,
          h: ((hit.position.bottomRight.y - py) / scale) * ry,
        };
      }
    } catch {
      // 本尺度失败，继续下一尺度
    }
  }
  return null;
}

async function decodeRegion(r: { x: number; y: number; w: number; h: number }): Promise<void> {
  if (capW === 0) return;
  const rx = capW / capCssW;
  const ry = capH / capCssH;
  const sx = Math.max(0, Math.round(r.x * rx));
  const sy = Math.max(0, Math.round(r.y * ry));
  const sw = Math.min(capW - sx, Math.round(r.w * rx));
  const sh = Math.min(capH - sy, Math.round(r.h * ry));

  const hit = await decodeWithRetry(canvas, sx, sy, sw, sh);
  if (hit) {
    showSuccessFeedback(true);
    // 手动框选与自动扫码同款：居中面板 + 位置标记
    showMultiResults([hit], true);
    if (settings.autoCopy) {
      await invoke("copy_text", { text: hit.text });
      toast("已复制到剪贴板");
    }
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

// ---------------- 平台打开（B站深链 / 夸克客户端 / 支付宝路由） ----------------

interface PlatformRule {
  id: string;
  name: string;
  /** 注册表检测的类/协议（任一存在即视为安装了应用） */
  schemes: string[];
  test: RegExp;
  /** 内容 → 深链/目标 */
  toDeeplink?: (content: string) => Promise<string>;
  /** 自定义打开方式（夸克：命令行带 URL 启动客户端） */
  openVia?: (content: string) => Promise<void>;
}

const PLATFORM_RULES: PlatformRule[] = [
  {
    id: "quark", name: "夸克网盘", schemes: ["QuarkHTM"],
    test: /pan\.quark\.cn|quark\.cn/i,
    openVia: async (c) => {
      await invoke("open_with_quark", { url: c });
    },
  },
  {
    id: "bilibili", name: "B站", schemes: ["bilibili"],
    test: /b23\.tv|bilibili\.com/i,
    toDeeplink: async (c) => {
      let url = c;
      if (/b23\.tv/i.test(c)) {
        try { url = await invoke<string>("resolve_url", { url: c }); } catch { /* 解析失败按原链处理 */ }
      }
      const m = /video\/(BV[0-9A-Za-z]+)/i.exec(url);
      return m ? `bilibili://video/${m[1]}` : "bilibili://";
    },
  },
  {
    id: "alipay", name: "支付宝", schemes: ["alipay", "alipays"],
    test: /^(alipay|alipays):\/\//i,
    toDeeplink: async (c) => c,
  },
];

function matchPlatform(content: string): PlatformRule | null {
  return PLATFORM_RULES.find((r) => r.test.test(content)) ?? null;
}

/** 按平台规则打开内容（无规则时原样交给系统路由） */
async function openByPlatform(content: string): Promise<void> {
  const rule = matchPlatform(content);
  if (rule?.openVia) {
    await rule.openVia(content);
    return;
  }
  let target = content;
  if (rule?.toDeeplink) {
    target = await rule.toDeeplink(content);
  }
  await invoke("open_content", { content: target });
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
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    decodeCanvas.width = w;
    decodeCanvas.height = h;
    decodeCtx.drawImage(img, 0, 0, w, h);
    const hit = await decodeWithRetry(decodeCanvas, 0, 0, w, h);
    if (hit) {
      onDetected(hit.text, false);
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
let switchTimer = 0;
function showSettings(on: boolean): void {
  settingsPage.hidden = !on;
  scanApp.hidden = on;
  // 窗口缩放动画期间关闭毛玻璃合成，避免逐帧模糊造成的卡顿
  document.body.classList.add("view-switching");
  window.clearTimeout(switchTimer);
  switchTimer = window.setTimeout(() => document.body.classList.remove("view-switching"), 320);
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
  setSwitch($("sw-autoscan"), settings.autoScan);
  setSwitch($("sw-openexit"), settings.openExit);
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
  $("sw-openexit").addEventListener("click", (e) => {
    const el = e.currentTarget as HTMLElement;
    void setSetting("openExit", !el.classList.contains("on")).then(syncSettingsUI);
  });
  $("sw-autoscan").addEventListener("click", (e) => {
    const el = e.currentTarget as HTMLElement;
    void setSetting("autoScan", !el.classList.contains("on")).then(syncSettingsUI);
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
      if (!multiView.hidden) {
        hideMultiResults();
        void exitCapture();
        return;
      }
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

  // 多结果视图关闭
  $("multi-close").addEventListener("click", () => {
    hideMultiResults();
    void exitCapture();
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

// zxing wasm 预热：提前完成初始化（首次调用约 1-2 秒，避免首屏识别时卡顿）
const warmNoise = new Uint8ClampedArray(64 * 64 * 4);
for (let i = 0; i < warmNoise.length; i++) warmNoise[i] = (i * 37) % 256;
void readBarcodes(new ImageData(warmNoise, 64, 64), {
  tryHarder: false,
  formats: ["QRCode"],
}).catch(() => {
  /* 噪声图解码失败无所谓，wasm 已完成初始化 */
});

void init();
