"use strict";

const LOCAL_URL = "http://127.0.0.1:8765";
const SHOPEE_HOME = "https://shopee.com.br/";
let activeTab = null;
let platformReady = false;
let pageReady = false;
let activePlatform = "";
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
  const categoryPage = status?.mode === "category_page";
  document.getElementById("bulk-title").textContent = categoryPage ? "当前分类商品" : "一键采集当前商品列表";
  document.getElementById("bulk-limit").hidden = categoryPage;
  document.getElementById("bulk-actions").style.gridTemplateColumns = categoryPage ? "1fr" : "";
  document.getElementById("bulk-help").textContent = categoryPage
    ? "分类页会收集正常浏览时加载的商品。想批量采集，可以切到「Mais Recente」或搜索商品。"
    : "Shopee 出现页面错误或验证时会暂停。手动打开正常商品列表后，可再开始采集。";
  stop.hidden = categoryPage;
  const captured = Number(status?.captured || 0);
  const total = Number(status?.total || 0);
  const maxItems = Number(status?.maxItems || document.getElementById("bulk-max").value || 3000);
  const target = categoryPage ? total : total ? Math.min(total, maxItems) : maxItems;
  bar.style.width = Math.min(100, target ? captured / target * 100 : 0) + "%";

  const labels = {
    idle: status?.message || "请先打开商品分类页或搜索结果页",
    ready: status?.message || "已识别当前商品列表",
    running: `第 ${Number(status?.page || 0)} 批 · 已读取 ${captured}${total ? " / " + total : ""} 件`,
    done: status?.message || `已完成，共读取 ${captured} 件`,
    stopped: status?.message || `已暂停在 ${captured} 件，可继续`,
    blocked: status?.message || "采集已暂停，请手动打开正常的商品列表",
    error: status?.message || "批量采集发生错误"
  };
  const current = status?.status || "idle";
  state.textContent = (categoryPage ? status?.message : labels[current]) || status?.message || "等待开始";
  state.className = ["blocked", "error"].includes(current) ? "muted bad" : current === "running" ? "muted blue" : "muted";
  const running = current === "running";
  const resumable = ["stopped", "error"].includes(current) && Number(status?.nextOffset || 0) > 0;
  start.textContent = "开始全部采集";
  if (current === "blocked") start.textContent = "等待页面恢复";
  else if (resumable) start.textContent = "继续采集";
  else if (current === "done") start.textContent = "重新采集";
  if (categoryPage) {
    const categoryLabels = { ready: "保存本页商品", running: "正在入库", done: "本页已入库", error: "重试保存本页" };
    start.textContent = categoryLabels[current];
  }
  const awaitingShopeeList = activePlatform === "shopee" && current === "idle";
  start.disabled = running || current === "blocked" || awaitingShopeeList ||
    (categoryPage && current === "done") || !platformReady || !pageReady;
  stop.disabled = !running || !pageReady;
}

async function readLocalPlatform() {
  try {
    const response = await fetch(LOCAL_URL + "/api/system", { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { ready: false, message: `响应异常（HTTP ${response.status}）` };
  } catch (_) {
    return { ready: false, message: "未连接，请打开桌面快捷方式" };
  }

  let stats = null;
  try {
    const response = await fetch(LOCAL_URL + "/api/stats", { signal: AbortSignal.timeout(2000) });
    if (response.ok) stats = await response.json();
  } catch (_) {}
  return { ready: true, message: "运行中", stats };
}

function platformForTab(tab) {
  try {
    const host = new URL(tab?.url || "").hostname;
    if (host === "shopee.com.br" || host.endsWith(".shopee.com.br")) return "shopee";
    if (host === "br.shein.com" || host.endsWith(".br.shein.com")) return "shein";
  } catch (_) {}
  return "";
}

async function readShopeeStatus(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "LATAM_GET_SHOPEE_STATUS" }, { frameId: 0 });
    if (response?.ok) return response.status;
  } catch (_) {}
  return null;
}

async function refresh() {
  const [local, [tab], state] = await Promise.all([
    readLocalPlatform(),
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.local.get({
      captureCount: 0,
      productCount: 0,
      reviewCount: 0,
      lastCapture: null,
      lastError: null,
      bulkStatus: { status: "idle" },
      bulkMaxItems: 3000
    })
  ]);
  const platform = platformForTab(tab);
  const shopeeStatus = platform === "shopee" ? await readShopeeStatus(tab.id) : null;
  activeTab = tab;
  activePlatform = platform;
  platformReady = local.ready;
  pageReady = platform === "shopee" ? Boolean(shopeeStatus) : platform === "shein";
  setStatus("platform", local.message, local.ready);
  document.getElementById("page-name").textContent = platform === "shein" ? "SHEIN 页面" : platform === "shopee" ? "Shopee 页面" : "采集页面";
  let pageMessage = "请打开 Shopee / SHEIN";
  if (platform === "shein") pageMessage = "已连接";
  if (platform === "shopee") {
    if (!shopeeStatus) pageMessage = "请重开或刷新当前标签页";
    else if (shopeeStatus.status === "blocked") pageMessage = "采集已暂停";
    else if (shopeeStatus.status === "idle") pageMessage = "等待商品列表";
    else if (shopeeStatus.mode === "category_page") pageMessage = "已识别分类列表";
    else pageMessage = "已连接";
  }
  setStatus("page", pageMessage, pageReady && shopeeStatus?.status !== "blocked");

  document.getElementById("captures").textContent = state.captureCount;
  document.getElementById("products").textContent = local.stats?.products ?? state.productCount;
  document.getElementById("reviews").textContent = local.stats?.reviews ?? state.reviewCount;
  if (document.activeElement !== document.getElementById("bulk-max")) {
    document.getElementById("bulk-max").value = state.bulkMaxItems || 3000;
  }
  const last = document.getElementById("last");
  if (state.lastError) {
    last.textContent = "本地入库错误：" + state.lastError;
    last.className = "muted bad";
  } else if (state.lastCapture) {
    last.textContent = "最近捕获：" + new Date(state.lastCapture).toLocaleString();
    last.className = "muted";
  }
  if (platform === "shopee") renderBulk(shopeeStatus || { status: "idle", message: "重开 Shopee 标签页后再查看采集状态" });
  else renderBulk(platform === "shein" && state.bulkStatus?.platform === "shein" ? state.bulkStatus : { status: "idle" });
}

async function sendBulkCommand(action) {
  if (activeTab?.id == null || !pageReady) {
    document.getElementById("bulk-state").textContent = "请先打开 Shopee 或 SHEIN 商品列表页";
    return;
  }
  const categoryPage = bulkSnapshot.mode === "category_page";
  if (action === "start" && (["blocked", "running"].includes(bulkSnapshot.status) ||
      (categoryPage && bulkSnapshot.status === "done"))) return;
  if (action === "start" && !platformReady) {
    document.getElementById("bulk-state").textContent = "本地平台未连接，请打开桌面快捷方式";
    return;
  }
  const input = document.getElementById("bulk-max");
  const maxItems = Math.min(6000, Math.max(20, Number(input.value) || 3000));
  input.value = maxItems;
  if (!categoryPage) await chrome.storage.local.set({ bulkMaxItems: maxItems });
  const resume = action === "start" && ["stopped", "error"].includes(bulkSnapshot.status) && Number(bulkSnapshot.nextOffset || 0) > 0;
  try {
    await chrome.tabs.sendMessage(activeTab.id, {
      type: "LATAM_BULK_COMMAND",
      command: {
        action: categoryPage && action === "start" ? "save_category" : action,
        maxItems,
        resume,
        startOffset: resume ? Number(bulkSnapshot.nextOffset || 0) : 0,
        captured: resume ? Number(bulkSnapshot.captured || 0) : 0,
        sourceKey: resume ? bulkSnapshot.sourceKey : ""
      }
    });
    document.getElementById("bulk-state").textContent = action === "stop"
      ? "正在暂停…" : categoryPage ? "正在保存本页…" : "命令已发送，正在准备…";
  } catch (_) {
    document.getElementById("bulk-state").textContent = "请刷新当前商品列表页面后再试一次";
    document.getElementById("bulk-state").className = "muted bad";
  }
}

document.getElementById("bulk-start").addEventListener("click", () => sendBulkCommand("start"));
document.getElementById("bulk-stop").addEventListener("click", () => sendBulkCommand("stop"));
document.getElementById("bulk-max").addEventListener("change", async (event) => {
  const value = Math.min(6000, Math.max(20, Number(event.target.value) || 3000));
  event.target.value = value;
  await chrome.storage.local.set({ bulkMaxItems: value });
});
document.getElementById("shopee-home").addEventListener("click", () => chrome.tabs.create({ url: SHOPEE_HOME }));
document.getElementById("dashboard").addEventListener("click", () => chrome.tabs.create({ url: LOCAL_URL + "/?page=products" }));

async function refreshLoop() {
  try {
    await refresh();
  } catch (_) {
    document.getElementById("bulk-start").disabled = true;
    setStatus("page", "请重新打开插件查看状态", false);
  } finally {
    setTimeout(refreshLoop, 1200);
  }
}

refreshLoop();
