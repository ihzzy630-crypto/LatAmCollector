(() => {
  "use strict";
  const EVENT_NAME = "LATAM_COLLECTOR_CAPTURE_V1";
  const CAPTURE_RESULT_EVENT = "LATAM_COLLECTOR_CAPTURE_RESULT_V1";
  const BULK_COMMAND_EVENT = "LATAM_COLLECTOR_BULK_COMMAND_V1";
  const BULK_STATUS_EVENT = "LATAM_COLLECTOR_BULK_STATUS_V1";
  const queue = globalThis.LatAmQueue;
  let pageStatus = null;
  let listReceipt = null;
  let listSequence = 0;
  let retryCapture = null;

  function dispatchCommand(command) {
    document.dispatchEvent(new CustomEvent(BULK_COMMAND_EVENT, { detail: JSON.stringify(command) }));
  }

  function readMainStatus() {
    pageStatus = null;
    dispatchCommand({ action: "status" });
    return pageStatus;
  }

  function queuePageState() {
    const scope = queue?.listingEntry(globalThis.location?.href)?.scope;
    const current = readMainStatus();
    const status = current && scope ? { ...current, platform: "shopee" } : current;
    return {
      scope, status,
      receipt: scope && scope === listReceipt?.scope ? listReceipt : null
    };
  }

  async function forwardCapture(data) {
    const { capture_id: captureId, page_url: pageUrl, ...capture } = data;
    const list = queue?.listingReceipt(capture.source_url, pageUrl, capture.payload);
    let observation = null;
    const currentScope = queue?.listingEntry(globalThis.location?.href)?.scope;
    if (list && list.scope === currentScope) {
      observation = {
        ...list, id: `${performance.timeOrigin}:${++listSequence}`, phase: "saving", saved: 0, added: 0
      };
      listReceipt = observation;
      retryCapture = data;
    }
    let products = 0;
    try {
      const response = await chrome.runtime.sendMessage({ type: "LATAM_CAPTURE", data: capture });
      if (response?.ok) {
        products = Number(response.result?.products) || 0;
        if (observation) {
          observation.saved = products;
          observation.added = Number(response.result?.new_products) || 0;
          observation.phase = products > 0 || observation.count === 0 ? "saved" : "error";
          if (observation === listReceipt && observation.phase === "saved") retryCapture = null;
        }
      }
    } catch (_) {
      // A reloaded extension or unavailable local service might not respond.
    }
    if (observation?.phase === "saving") observation.phase = "error";
    if (Number.isSafeInteger(captureId)) {
      document.dispatchEvent(new CustomEvent(CAPTURE_RESULT_EVENT, {
        detail: JSON.stringify({ captureId, products })
      }));
    }
  }

  document.addEventListener(EVENT_NAME, (event) => {
    try {
      const data = JSON.parse(event.detail);
      if (!data || typeof data !== "object") return;
      const url = new URL(String(data.source_url || ""));
      const host = url.hostname.toLowerCase();
      const allowed = host === "shopee.com.br" || host.endsWith(".shopee.com.br") ||
        host === "br.shein.com" || host.endsWith(".br.shein.com");
      if (!allowed) return;
      forwardCapture(data);
    } catch (_) {
      // Discard malformed page events.
    }
  });

  document.addEventListener(BULK_STATUS_EVENT, (event) => {
    try {
      const data = JSON.parse(event.detail || "{}");
      if (data.snapshot === true) {
        pageStatus = data;
        return;
      }
      chrome.runtime.sendMessage({ type: "LATAM_BULK_STATUS", data });
    } catch (_) {
      // Discard malformed progress events.
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "LATAM_GET_SHOPEE_STATUS") {
      const status = readMainStatus();
      sendResponse({ ok: status !== null, status });
      return false;
    }
    if (message?.type === "LATAM_QUEUE_STATUS") {
      sendResponse(queuePageState());
      return false;
    }
    if (message?.type === "LATAM_QUEUE_CATEGORIES") {
      const status = readMainStatus();
      const entries = status?.status === "blocked" ? [] : queue.categoryLinks(document, location.href);
      sendResponse({ entries });
      return false;
    }
    if (message?.type === "LATAM_QUEUE_PREPARE") {
      const { scope, receipt, status } = queuePageState();
      const healthy = scope && scope === message.scope && status && status.status !== "blocked" &&
        (status.status !== "running" || status.mode === "category_page");
      if (healthy) {
        if (status.mode !== "category_page" && receipt?.phase === "error" && retryCapture) {
          forwardCapture(retryCapture);
        } else {
          dispatchCommand({ action: "queue_prepare" });
        }
      }
      sendResponse({ ok: Boolean(healthy) });
      return false;
    }
    if (message?.type === "LATAM_QUEUE_NEXT") {
      const { scope, receipt, status } = queuePageState();
      if (!status || status.status === "blocked") {
        sendResponse({ action: "pause", message: status?.message || "请检查 Shopee 页面", needsReview: true });
        return false;
      }
      if (!scope || scope !== message.scope || !receipt || receipt.id !== message.receiptId || receipt.phase !== "saved" ||
          (status.status === "running" && status.mode !== "category_page")) {
        sendResponse({ action: "pause", message: "商品列表已发生变化，请检查采集标签页", needsReview: true });
        return false;
      }
      const next = queue.nextListingControl(document, location.href);
      sendResponse({ action: next ? "clicked" : "end" });
      if (next) next.click();
      return false;
    }
    if (message?.type !== "LATAM_BULK_COMMAND") return false;
    dispatchCommand(message.command || {});
    sendResponse({ ok: true });
    return false;
  });
})();

