(() => {
  "use strict";
  const EVENT_NAME = "LATAM_COLLECTOR_CAPTURE_V1";
  const CAPTURE_RESULT_EVENT = "LATAM_COLLECTOR_CAPTURE_RESULT_V1";
  const BULK_COMMAND_EVENT = "LATAM_COLLECTOR_BULK_COMMAND_V1";
  const BULK_STATUS_EVENT = "LATAM_COLLECTOR_BULK_STATUS_V1";
  let pageStatus = null;

  function dispatchCommand(command) {
    document.dispatchEvent(new CustomEvent(BULK_COMMAND_EVENT, { detail: JSON.stringify(command) }));
  }

  async function forwardCapture(data) {
    const { capture_id: captureId, ...capture } = data;
    let products = 0;
    try {
      const response = await chrome.runtime.sendMessage({ type: "LATAM_CAPTURE", data: capture });
      if (response?.ok) products = Number(response.result?.products) || 0;
    } catch (_) {
      // A reloaded extension or unavailable local service might not respond.
    }
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
      pageStatus = null;
      dispatchCommand({ action: "status" });
      sendResponse({ ok: pageStatus !== null, status: pageStatus });
      return false;
    }
    if (message?.type !== "LATAM_BULK_COMMAND") return false;
    dispatchCommand(message.command || {});
    sendResponse({ ok: true });
    return false;
  });
})();

