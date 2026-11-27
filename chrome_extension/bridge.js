(() => {
  "use strict";
  const EVENT_NAME = "LATAM_COLLECTOR_CAPTURE_V1";
  const CAPTURE_RESULT_EVENT = "LATAM_COLLECTOR_CAPTURE_RESULT_V1";
  const BULK_COMMAND_EVENT = "LATAM_COLLECTOR_BULK_COMMAND_V1";
  const BULK_STATUS_EVENT = "LATAM_COLLECTOR_BULK_STATUS_V1";
  const queue = globalThis.LatAmQueue;
  const reviews = globalThis.LatAmReviews;
  let pageStatus = null;
  let listReceipt = null;
  let listSequence = 0;
  let retryCapture = null;
  const reviewReceipts = [];
  let reviewSequence = 0;
  let reviewIssue = "";
  globalThis.LatAmReviewObserver = {
    get sequence() { return reviewSequence; },
    get receipts() { return reviewReceipts; },
    get issue() { return reviewIssue; }
  };

  function dispatchCommand(command) {
    document.dispatchEvent(new CustomEvent(BULK_COMMAND_EVENT, { detail: JSON.stringify(command) }));
  }

  function readMainStatus() {
    pageStatus = null;
    dispatchCommand({ action: "status" });
    return pageStatus;
  }

  function queuePageState() {
    const listing = queue?.listingEntry(globalThis.location?.href);
    const scope = listing?.scope;
    const current = readMainStatus();
    const status = current && scope ? { ...current, platform: "shopee" } : current;
    return {
      scope, key: listing?.key, status,
      receipt: scope && scope === listReceipt?.scope ? listReceipt : null
    };
  }

  async function forwardCapture(data) {
    const { capture_id: captureId, page_url: pageUrl, ...capture } = data;
    const reviewing = reviews?.productPage(pageUrl);
    let reviewReceipt = null;
    if (reviewing && reviews.sameProduct(location.href, reviewing) && reviews.reviewListResponse(capture.source_url)) {
      reviewReceipt = { sequence: ++reviewSequence, phase: "saving", batch: null };
      reviewReceipts.push(reviewReceipt);
      if (reviewReceipts.length > 16) reviewReceipts.shift();
    }
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
      const response = await chrome.runtime.sendMessage({ type: "LATAM_CAPTURE", data: { ...capture, page_url: pageUrl } });
      if (response?.ok) {
        products = Number(response.result?.products) || 0;
        if (reviewReceipt) {
          reviewReceipt.batch = response.result?.review_batch;
          reviewReceipt.phase = reviewReceipt.batch ? "saved" : "unlinked";
        }
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
    if (reviewReceipt?.phase === "saving") reviewReceipt.phase = "error";
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

  document.addEventListener("LATAM_COLLECTOR_REVIEW_ISSUE_V1", (event) => {
    try {
      const data = JSON.parse(event.detail);
      const page = reviews?.productPage(data.page);
      if (page && reviews.sameProduct(location.href, page)) reviewIssue = String(data.message || "").slice(0, 180);
    } catch {
      // Ignore incomplete observations.
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
      const { scope, key, receipt, status } = queuePageState();
      if (!status || status.status === "blocked") {
        sendResponse({ action: "pause", message: status?.message || "请检查 Shopee 页面", needsReview: true });
        return false;
      }
      if (!scope || scope !== message.scope || (message.listingKey && key !== message.listingKey) ||
          !receipt || receipt.id !== message.receiptId || receipt.phase !== "saved" ||
          (status.status === "running" && status.mode !== "category_page")) {
        sendResponse({ action: "pause", message: "商品列表已发生变化，请检查采集标签页", needsReview: true });
        return false;
      }
      const pagination = queue.listingPagination(document, location.href);
      if (pagination.action === "next") {
        sendResponse({ action: "clicked" });
        pagination.control.click();
      } else if (pagination.action === "end" || receipt.lastPage) {
        sendResponse({ action: "end" });
      } else {
        sendResponse({ action: "waiting" });
        if (message.lookForPagination && document.scrollingElement) {
          document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
        }
      }
      return false;
    }
    if (message?.type !== "LATAM_BULK_COMMAND") return false;
    dispatchCommand(message.command || {});
    sendResponse({ ok: true });
    return false;
  });
})();

