const { app, BrowserWindow, ipcMain, shell } = require("electron");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const DEFAULT_PORT = 18789;
const DEFAULT_BASE_URL = "http://haihai131.xyz/v1/";
const DEFAULT_MODEL = "gpt-5.5";
const READY_TIMEOUT_MS = 180000;

let launcherWindow = null;
let dashboardWindow = null;
let gatewayProcess = null;
let gatewayState = { status: "stopped", error: "", startedByLauncher: false };

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function getRuntimeBase() {
  return app.isPackaged ? process.resourcesPath : __dirname;
}

function getPaths() {
  const runtimeBase = getRuntimeBase();
  const dataRoot = path.join(app.getPath("userData"), "OpenClaw_Data");
  const stateDir = path.join(dataRoot, "state");
  const logsDir = path.join(dataRoot, "logs");
  const envRoot = path.join(runtimeBase, "runtime", "openclaw-env");
  return {
    runtimeBase,
    dataRoot,
    stateDir,
    logsDir,
    envRoot,
    settingsPath: path.join(dataRoot, "launcher-settings.json"),
    configPath: path.join(dataRoot, "config.json"),
    portableBaseDir: app.isPackaged ? path.dirname(path.dirname(path.dirname(process.execPath))) : __dirname
  };
}

function ensurePaths() {
  const paths = getPaths();
  ensureDir(paths.dataRoot);
  ensureDir(paths.stateDir);
  ensureDir(paths.logsDir);
  return paths;
}

function sanitizePort(value) {
  const port = Number.parseInt(String(value || DEFAULT_PORT), 10);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT;
}

function loadSettings() {
  const paths = ensurePaths();
  const raw = readJson(paths.settingsPath, {});
  return {
    apiKey: String(raw.apiKey || ""),
    port: sanitizePort(raw.port),
    launchOnOpen: Boolean(raw.launchOnOpen)
  };
}

function baseUrlForPort(port) {
  return `http://127.0.0.1:${sanitizePort(port)}`;
}

function findExecutable(root, names) {
  if (!fs.existsSync(root)) return null;
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && wanted.has(entry.name.toLowerCase())) return fullPath;
      if (entry.isDirectory()) queue.push(fullPath);
    }
  }
  return null;
}

function getRuntimeInfo() {
  const paths = ensurePaths();
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const npmName = process.platform === "win32" ? "npm.cmd" : "npm";
  const nodePath = findExecutable(path.join(paths.envRoot, "nodejs"), [nodeName]);
  const npmPath = findExecutable(path.join(paths.envRoot, "nodejs"), [npmName]);
  const openclawPath = path.join(paths.envRoot, "node_modules", "openclaw", "openclaw.mjs");
  if (!fs.existsSync(paths.envRoot)) return { ready: false, envRoot: paths.envRoot, error: "缺少 runtime/openclaw-env 运行时目录。" };
  if (!nodePath) return { ready: false, envRoot: paths.envRoot, error: "运行时里没有找到 Node 可执行文件。" };
  if (!fs.existsSync(openclawPath)) return { ready: false, envRoot: paths.envRoot, error: "运行时里没有找到 openclaw.mjs。" };
  return { ready: true, envRoot: paths.envRoot, nodePath, npmPath, openclawPath };
}

function buildConfig(settings) {
  const providerId = "haihai";
  return {
    messages: { ackReactionScope: "group-mentions" },
    agents: {
      defaults: {
        model: { primary: `${providerId}/${DEFAULT_MODEL}` },
        maxConcurrent: 1,
        subagents: { maxConcurrent: 1 },
        compaction: { mode: "safeguard" },
        workspace: path.join(os.homedir(), "OpenClaw_Workspace")
      }
    },
    models: {
      providers: {
        [providerId]: {
          baseUrl: DEFAULT_BASE_URL,
          apiKey: settings.apiKey,
          api: "openai",
          headers: { Authorization: "Bearer {{apiKey}}" },
          models: [{ id: DEFAULT_MODEL, name: DEFAULT_MODEL, contextWindow: 200000, maxTokens: 8192 }]
        }
      }
    },
    gateway: {
      mode: "local",
      auth: { mode: "none" },
      port: settings.port,
      bind: "loopback",
      tailscale: { mode: "off", resetOnExit: false },
      controlUi: { allowInsecureAuth: true }
    },
    logging: { level: "info", consoleLevel: "warn", consoleStyle: "pretty" }
  };
}

function saveSettings(input) {
  const settings = {
    apiKey: String(input.apiKey || "").trim(),
    port: sanitizePort(input.port),
    launchOnOpen: Boolean(input.launchOnOpen)
  };
  if (!settings.apiKey) throw new Error("请先填写 API Key。");
  const paths = ensurePaths();
  writeJson(paths.settingsPath, settings);
  writeJson(paths.configPath, buildConfig(settings));
  return settings;
}

function isPortOpen(port, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

function fetchWebUi(baseUrl, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(baseUrl); } catch { resolve({ ok: false, statusCode: 0 }); return; }
    const req = http.request({ hostname: url.hostname, port: url.port, path: "/", method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, statusCode: 0 }); });
    req.on("error", () => resolve({ ok: false, statusCode: 0 }));
    req.end();
  });
}

async function waitForReady(baseUrl, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const probe = await fetchWebUi(baseUrl, 1500);
    if (probe.ok) return true;
    if (gatewayProcess && gatewayProcess.exitCode !== null) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function readLogTail(file, maxChars = 1800) {
  try {
    if (!fs.existsSync(file)) return "";
    const text = fs.readFileSync(file, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-18).join("\n").slice(-maxChars);
  } catch {
    return "";
  }
}

function launchGateway(runtime, paths, settings) {
  const logPath = path.join(paths.logsDir, "gateway-launcher.log");
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] launcher start\n`, "utf8");
  const out = fs.openSync(logPath, "a");
  const child = spawn(runtime.nodePath, [runtime.openclawPath, "gateway", "run", "--allow-unconfigured", "--port", String(settings.port)], {
    cwd: paths.portableBaseDir,
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir, OPENCLAW_CONFIG_PATH: paths.configPath },
    detached: true,
    stdio: ["ignore", out, out]
  });
  child.unref();
  gatewayProcess = child;
  return { pid: child.pid, logPath };
}

function stopProcess(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGTERM");
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
}

async function startGateway(input = {}) {
  const settings = saveSettings(input.apiKey ? input : loadSettings());
  const runtime = getRuntimeInfo();
  if (!runtime.ready) return { ok: false, error: runtime.error };
  const paths = ensurePaths();
  const baseUrl = baseUrlForPort(settings.port);
  gatewayState = { status: "starting", error: "", startedByLauncher: false };

  if (await fetchWebUi(baseUrl, 800).then((probe) => probe.ok)) {
    gatewayState = { status: "running", error: "", startedByLauncher: false };
    return { ok: true, baseUrl, reused: true };
  }
  if (await isPortOpen(settings.port)) {
    const error = `端口 ${settings.port} 已被其他程序占用，请换一个本地端口后重试。`;
    gatewayState = { status: "error", error, startedByLauncher: false };
    return { ok: false, error };
  }

  const launched = launchGateway(runtime, paths, settings);
  const ready = await waitForReady(baseUrl, READY_TIMEOUT_MS);
  if (!ready) {
    const tail = readLogTail(launched.logPath);
    const error = `等待网关就绪超时。请换一个本地端口后重试；如果仍失败，通常是运行时文件缺失、系统拦截或当前目录权限问题。${tail ? `\n\n最近日志：\n${tail}` : ""}`;
    gatewayState = { status: "error", error, startedByLauncher: true };
    return { ok: false, error };
  }

  gatewayState = { status: "running", error: "", startedByLauncher: true };
  return { ok: true, baseUrl };
}

async function stopGateway() {
  if (gatewayProcess) stopProcess(gatewayProcess.pid);
  gatewayProcess = null;
  gatewayState = { status: "stopped", error: "", startedByLauncher: false };
  return { ok: true };
}

function resetData() {
  const paths = ensurePaths();
  const keep = new Set([path.basename(paths.settingsPath), path.basename(paths.configPath)]);
  for (const entry of fs.readdirSync(paths.dataRoot)) {
    if (keep.has(entry)) continue;
    fs.rmSync(path.join(paths.dataRoot, entry), { recursive: true, force: true });
  }
  ensurePaths();
  return { ok: true };
}

function fetchJson(url, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "GET", headers, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error("额度接口返回的不是 JSON。")); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("额度查询超时。")); });
    req.on("error", reject);
    req.end();
  });
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

async function getQuota(apiKey) {
  const key = String(apiKey || loadSettings().apiKey || "").trim();
  if (!key) return { ok: false, error: "请先填写 API Key。" };
  try {
    const data = await fetchJson(`${DEFAULT_BASE_URL.replace(/\/+$/, "")}/usage`, { Authorization: `Bearer ${key}` });
    const used = firstNumber(data.used, data.total_used, data.usage && data.usage.total, data.usage && data.usage.total_cost, data.usage && data.usage.actual_cost, 0);
    const remaining = firstNumber(data.remaining, data.balance, data.credit, data.quota && data.quota.remaining);
    const total = firstNumber(data.total, data.granted, data.quota && data.quota.total, remaining !== null && used !== null ? remaining + used : null);
    return { ok: true, quota: { total, used, remaining, unit: data.unit || "USD", note: data.planName || data.plan || "额度已同步。" } };
  } catch (error) {
    return { ok: false, error: error.message || "额度查询失败。" };
  }
}

async function collectStatus() {
  const settings = loadSettings();
  const runtime = getRuntimeInfo();
  const baseUrl = baseUrlForPort(settings.port);
  const running = await fetchWebUi(baseUrl, 500).then((probe) => probe.ok);
  return {
    runtime,
    settings,
    preset: { port: settings.port, baseUrl: DEFAULT_BASE_URL, modelId: DEFAULT_MODEL },
    gateway: { running, baseUrl, status: running ? "running" : gatewayState.status, error: running ? "" : gatewayState.error }
  };
}

function focusWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createLauncherWindow() {
  launcherWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 720,
    backgroundColor: "#081018",
    title: "OpenClaw Portable",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  launcherWindow.removeMenu();
  launcherWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  launcherWindow.on("closed", () => { launcherWindow = null; });
}

function openDashboard(baseUrl) {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.loadURL(baseUrl);
    focusWindow(dashboardWindow);
    return;
  }
  dashboardWindow = new BrowserWindow({ width: 1280, height: 860, minWidth: 980, minHeight: 720, title: "OpenClaw" });
  dashboardWindow.loadURL(baseUrl);
  dashboardWindow.on("closed", () => { dashboardWindow = null; });
}

ipcMain.handle("status", collectStatus);
ipcMain.handle("save", (_event, payload) => {
  try { return { ok: true, settings: saveSettings(payload || {}) }; }
  catch (error) { return { ok: false, error: error.message || String(error) }; }
});
ipcMain.handle("quota", (_event, payload = {}) => getQuota(payload.apiKey));
ipcMain.handle("start", async (_event, payload = {}) => {
  const result = await startGateway(payload);
  if (result.ok) openDashboard(result.baseUrl);
  return result;
});
ipcMain.handle("stop", stopGateway);
ipcMain.handle("reset", () => {
  try { return resetData(); }
  catch (error) { return { ok: false, error: error.message || String(error) }; }
});
ipcMain.handle("open", async () => {
  const settings = loadSettings();
  const baseUrl = baseUrlForPort(settings.port);
  const ready = await fetchWebUi(baseUrl, 800).then((probe) => probe.ok);
  if (!ready) return { ok: false, error: "本地控制台还没有启动。" };
  openDashboard(baseUrl);
  return { ok: true, baseUrl };
});

app.whenReady().then(async () => {
  ensurePaths();
  createLauncherWindow();
  const settings = loadSettings();
  if (settings.launchOnOpen && settings.apiKey) await startGateway(settings);
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (!launcherWindow) createLauncherWindow(); });
app.on("before-quit", () => { if (gatewayState.startedByLauncher && gatewayProcess) stopProcess(gatewayProcess.pid); });
