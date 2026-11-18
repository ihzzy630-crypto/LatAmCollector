"use strict";

let activeTab = null;
let platformReady = false;
let shopeeReady = false;
let bulkSnapshot = {};

function setStatus(id, text, ok) {
  const element = document.getElementById(id);
  element.textContent = text;
  element.className = ok ? "ok" : "bad";
}

function renderBulk(status) {
  bulkSnapshot = status || {};
  const state = document.getElementById("bulk-state");
  const bar = document.getElementById("bulk-bar");
  const start = document.getElementById("bulk-start");
  const stop = document.getElementById("bulk-stop");
  const captured = Number(status?.captured || 0);
  const total = Number(status?.total || 0);
  const maxItems = Number(status?.maxItems || document.getElementById("bulk-max").value || 3000);
  const target = total ? Math.min(total, maxItems) : maxItems;
  bar.style.width = Math.min(100, target ? captured / target * 100 : 0) + "%";

  const labels = {
    idle: "先打开并刷新分类页或搜索结果页",
    ready: status?.message || "已识别当前商品列表",
    running: `第 ${Number(status?.page || 0)} 批 · 已读取 ${captured}${total ? " / " + total : ""} 件`,
    done: status?.message || `已完成，共读取 ${captured} 件`,
    stopped: `已暂停在 ${captured} 件，可继续`,
    error: status?.message || "批量采集发生错误"
  };
  const current = status?.status || "idle";
  state.textContent = labels[current] || status?.message || "等待开始";
  state.className = current === "error" ? "muted bad" : current === "running" ? "muted blue" : "muted";
  const running = current === "running";
  const resumable = ["stopped", "error"].includes(current) && Number(status?.nextOffset || 0) > 0;
  start.textContent = resumable ? "继续采集" : current === "done" ? "重新采集" : "开始全部采集";
  start.disabled = running || !platformReady || !shopeeReady;
  stop.disabled = !running;
}

async function refresh() {
  let serverStats = null;
  platformReady = false;
  try {
    const response = await fetch("http://127.0.0.1:8765/api/system");
    platformReady = response.ok;
    setStatus("platform", response.ok ? "运行中" : "异常", response.ok);
    if (response.ok) {
      const statsResponse = await fetch("http://127.0.0.1:8765/api/stats");
      if (statsResponse.ok) serverStats = await statsResponse.json();
    }
  } catch (_) {
    setStatus("platform", "未启动", false);
  }

  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  shopeeReady = false;
  try {
    const host = new URL(activeTab?.url || "").hostname;
    shopeeReady = host === "shopee.com.br" || host.endsWith(".shopee.com.br");
  } catch (_) {}
  setStatus("page", shopeeReady ? "已连接" : "请打开 Shopee", shopeeReady);

  const state = await chrome.storage.local.get({
    captureCount: 0,
    productCount: 0,
    reviewCount: 0,
    lastCapture: null,
    lastError: null,
    bulkStatus: { status: "idle" },
    bulkMaxItems: 3000
  });
  document.getElementById("captures").textContent = state.captureCount;
  document.getElementById("products").textContent = serverStats ? serverStats.products : state.productCount;
  document.getElementById("reviews").textContent = serverStats ? serverStats.reviews : state.reviewCount;
  if (document.activeElement !== document.getElementById("bulk-max")) {
    document.getElementById("bulk-max").value = state.bulkMaxItems || 3000;
  }
  const last = document.getElementById("last");
  if (state.lastError) {
    last.textContent = "最近错误：" + state.lastError;
    last.className = "muted bad";
  } else if (state.lastCapture) {
    last.textContent = "最近捕获：" + new Date(state.lastCapture).toLocaleString();
    last.className = "muted";
  }
  renderBulk(state.bulkStatus);
}

async function sendBulkCommand(action) {
  if (!activeTab?.id || !shopeeReady) {
    document.getElementById("bulk-state").textContent = "请先打开 Shopee 分类页或搜索结果页";
    return;
  }
  if (!platformReady) {
    document.getElementById("bulk-state").textContent = "本地平台未启动";
    return;
  }
  const input = document.getElementById("bulk-max");
  const maxItems = Math.min(6000, Math.max(60, Number(input.value) || 3000));
  input.value = maxItems;
  await chrome.storage.local.set({ bulkMaxItems: maxItems });
  const resume = action === "start" && ["stopped", "error"].includes(bulkSnapshot.status) && Number(bulkSnapshot.nextOffset || 0) > 0;
  try {
    await chrome.tabs.sendMessage(activeTab.id, {
      type: "LATAM_BULK_COMMAND",
      command: {
        action,
        maxItems,
        resume,
        startOffset: resume ? Number(bulkSnapshot.nextOffset || 0) : 0,
        captured: resume ? Number(bulkSnapshot.captured || 0) : 0,
        sourceKey: resume ? bulkSnapshot.sourceKey : ""
      }
    });
    document.getElementById("bulk-state").textContent = action === "stop" ? "正在暂停…" : "命令已发送，正在准备…";
  } catch (_) {
    document.getElementById("bulk-state").textContent = "请刷新 Shopee 页面后再试一次";
    document.getElementById("bulk-state").className = "muted bad";
  }
}

document.getElementById("bulk-start").addEventListener("click", () => sendBulkCommand("start"));
document.getElementById("bulk-stop").addEventListener("click", () => sendBulkCommand("stop"));
document.getElementById("bulk-max").addEventListener("change", async (event) => {
  const value = Math.min(6000, Math.max(60, Number(event.target.value) || 3000));
  event.target.value = value;
  await chrome.storage.local.set({ bulkMaxItems: value });
});
document.getElementById("dashboard").addEventListener("click", () => chrome.tabs.create({ url: "http://127.0.0.1:8765/?page=products" }));

refresh();
setInterval(refresh, 1200);
