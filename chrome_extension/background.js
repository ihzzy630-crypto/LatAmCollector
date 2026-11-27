"use strict";

importScripts("review_core.js", "review_jobs.js");

const API_URL = "http://127.0.0.1:8765/api/capture";

async function updateState(result) {
  const current = await chrome.storage.local.get({
    captureCount: 0,
    productCount: 0,
    reviewCount: 0,
    lastCapture: null,
    lastError: null
  });
  const next = {
    captureCount: current.captureCount + 1,
    productCount: current.productCount + Number(result.products || 0),
    reviewCount: current.reviewCount + Number(result.reviews || 0),
    lastCapture: new Date().toISOString(),
    lastError: null
  };
  await chrome.storage.local.set(next);
  await chrome.action.setBadgeBackgroundColor({ color: "#198754" });
  await chrome.action.setBadgeText({ text: String(Math.min(next.captureCount, 99)) });
}

async function recordError(message) {
  await chrome.storage.local.set({ lastError: String(message), lastErrorAt: new Date().toISOString() });
  await chrome.action.setBadgeBackgroundColor({ color: "#d83d27" });
  await chrome.action.setBadgeText({ text: "!" });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "LATAM_BULK_STATUS") {
    (async () => {
      const data = message.data && typeof message.data === "object" ? message.data : {};
      await chrome.storage.local.set({ bulkStatus: data });
      if (data.status === "running") {
        await chrome.action.setBadgeBackgroundColor({ color: "#2b6cb0" });
        await chrome.action.setBadgeText({ text: String(Math.min(Number(data.page || 0), 99)) });
      } else if (data.status === "done") {
        await chrome.action.setBadgeBackgroundColor({ color: "#198754" });
        await chrome.action.setBadgeText({ text: "✓" });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type !== "LATAM_CAPTURE") return false;

  (async () => {
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message.data)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || `Local API returned ${response.status}`);
      await updateState(result);
      sendResponse({ ok: true, result });
    } catch (error) {
      await recordError(error.message || error);
      sendResponse({ ok: false, error: String(error.message || error) });
    }
  })();
  return true;
});

