"use strict";

function setStatus(id, text, ok) {
  const element = document.getElementById(id);
  element.textContent = text;
  element.className = ok ? "ok" : "bad";
}

async function refresh() {
  let serverStats = null;
  try {
    const response = await fetch("http://127.0.0.1:8765/api/system");
    setStatus("platform", response.ok ? "运行中" : "异常", response.ok);
    if (response.ok) {
      const statsResponse = await fetch("http://127.0.0.1:8765/api/stats");
      if (statsResponse.ok) serverStats = await statsResponse.json();
    }
  } catch (_) {
    setStatus("platform", "未启动", false);
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let isShopee = false;
  try {
    const host = new URL(tab?.url || "").hostname;
    isShopee = host === "shopee.com.br" || host.endsWith(".shopee.com.br");
  } catch (_) {}
  setStatus("page", isShopee ? "已连接" : "请打开 Shopee", isShopee);

  const state = await chrome.storage.local.get({ captureCount: 0, productCount: 0, reviewCount: 0, lastCapture: null, lastError: null });
  document.getElementById("captures").textContent = state.captureCount;
  document.getElementById("products").textContent = serverStats ? serverStats.products : state.productCount;
  document.getElementById("reviews").textContent = serverStats ? serverStats.reviews : state.reviewCount;
  const last = document.getElementById("last");
  if (state.lastError) {
    last.textContent = "最近错误：" + state.lastError;
    last.className = "muted bad";
  } else if (state.lastCapture) {
    last.textContent = "最近捕获：" + new Date(state.lastCapture).toLocaleString();
  }
}

document.getElementById("dashboard").addEventListener("click", () => chrome.tabs.create({ url: "http://127.0.0.1:8765/?page=products" }));
refresh();

