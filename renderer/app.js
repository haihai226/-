const $ = (id) => document.getElementById(id);
const els = {
  status: $("status-pill"),
  runtime: $("runtime-status"),
  gatewayUrl: $("gateway-url"),
  quotaSummary: $("quota-summary"),
  message: $("message"),
  apiKey: $("api-key"),
  port: $("port"),
  launchOnOpen: $("launch-on-open"),
  quotaTotal: $("quota-total"),
  quotaUsed: $("quota-used"),
  quotaRemaining: $("quota-remaining"),
  quotaNote: $("quota-note"),
  save: $("save"),
  refreshQuota: $("refresh-quota"),
  quotaButton: $("quota-button"),
  start: $("start"),
  open: $("open"),
  stop: $("stop"),
  reset: $("reset")
};

function money(value, unit = "USD") {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const symbol = unit === "USD" ? "$" : `${unit} `;
  return `${symbol}${Number(value).toFixed(2)}`;
}

function showMessage(text = "") {
  els.message.textContent = text;
}

function readPayload() {
  return {
    apiKey: els.apiKey.value.trim(),
    port: Number(els.port.value || 18789),
    launchOnOpen: els.launchOnOpen.checked
  };
}

function applyStatus(status) {
  els.runtime.textContent = status.runtime.ready ? "就绪" : "缺少运行时";
  els.gatewayUrl.textContent = status.gateway.baseUrl;
  els.port.value = String(status.preset.port || 18789);
  els.launchOnOpen.checked = Boolean(status.settings.launchOnOpen);
  if (status.settings.apiKey && !els.apiKey.value) els.apiKey.value = status.settings.apiKey;

  els.status.className = "pill";
  if (status.gateway.running) {
    els.status.textContent = "运行中";
    els.status.classList.add("ok");
  } else if (status.gateway.error || !status.runtime.ready) {
    els.status.textContent = "错误";
    els.status.classList.add("error");
  } else {
    els.status.textContent = "就绪";
    els.status.classList.add("ok");
  }

  els.open.disabled = !status.gateway.running;
  els.stop.disabled = !status.gateway.running;
  if (status.gateway.error) showMessage(status.gateway.error);
}

async function refreshStatus() {
  const status = await window.launcher.invoke("status");
  applyStatus(status);
  return status;
}

async function save() {
  showMessage("");
  const payload = readPayload();
  if (!payload.apiKey) {
    showMessage("请先填写 API Key。");
    return false;
  }
  if (!Number.isInteger(payload.port) || payload.port < 1024 || payload.port > 65535) {
    showMessage("本地端口必须是 1024 到 65535 之间的数字。");
    return false;
  }
  const result = await window.launcher.invoke("save", payload);
  if (!result.ok) {
    showMessage(result.error || "保存失败。");
    return false;
  }
  await refreshStatus();
  return true;
}

async function refreshQuota() {
  els.quotaNote.textContent = "正在查询额度...";
  const result = await window.launcher.invoke("quota", { apiKey: els.apiKey.value.trim() });
  if (!result.ok) {
    els.quotaNote.textContent = result.error || "额度查询失败。";
    return;
  }
  const q = result.quota;
  els.quotaTotal.textContent = money(q.total, q.unit);
  els.quotaUsed.textContent = money(q.used, q.unit);
  els.quotaRemaining.textContent = money(q.remaining, q.unit);
  els.quotaSummary.textContent = money(q.remaining, q.unit);
  els.quotaNote.textContent = q.note || "额度已同步。";
}

els.save.addEventListener("click", save);
els.refreshQuota.addEventListener("click", refreshQuota);
els.quotaButton.addEventListener("click", refreshQuota);
els.start.addEventListener("click", async () => {
  if (!(await save())) return;
  showMessage("正在启动网关...");
  const result = await window.launcher.invoke("start", readPayload());
  if (!result.ok) showMessage(result.error || "启动失败。");
  else showMessage("");
  await refreshStatus();
});
els.open.addEventListener("click", async () => {
  const result = await window.launcher.invoke("open");
  if (!result.ok) showMessage(result.error || "打开失败。");
});
els.stop.addEventListener("click", async () => {
  await window.launcher.invoke("stop");
  await refreshStatus();
});
els.reset.addEventListener("click", async () => {
  if (!confirm("确定清空本机 OpenClaw 会话、记忆、缓存和历史状态吗？")) return;
  const result = await window.launcher.invoke("reset");
  showMessage(result.ok ? "用户数据已重置。" : result.error || "重置失败。");
  await refreshStatus();
});

refreshStatus().catch((error) => showMessage(String(error && error.message || error)));
setInterval(refreshStatus, 3000);
