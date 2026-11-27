(() => {
  "use strict";
  const origin = "http://127.0.0.1:8765";
  if (location.origin !== origin || window.top !== window) return;

  window.addEventListener("message", async event => {
    if (event.source !== window || event.origin !== origin) return;
    const { type, id, action, productId } = event.data || {};
    if (type !== "LATAM_LOCAL_REVIEW_COMMAND" || typeof id !== "string" ||
        !["start", "stop", "open", "status"].includes(action) || !Number.isSafeInteger(productId)) return;
    try {
      const response = await chrome.runtime.sendMessage({ type: "LATAM_REVIEW_DASHBOARD", action, productId });
      window.postMessage({ type: "LATAM_LOCAL_REVIEW_RESULT", id, ...response }, origin);
    } catch {
      window.postMessage({ type: "LATAM_LOCAL_REVIEW_RESULT", id, ok: false, error: "请重新加载 Chrome 采集助手并刷新本地平台" }, origin);
    }
  });
})();
