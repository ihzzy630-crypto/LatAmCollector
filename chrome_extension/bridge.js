(() => {
  "use strict";
  const EVENT_NAME = "LATAM_COLLECTOR_CAPTURE_V1";
  const BULK_COMMAND_EVENT = "LATAM_COLLECTOR_BULK_COMMAND_V1";
  const BULK_STATUS_EVENT = "LATAM_COLLECTOR_BULK_STATUS_V1";

  document.addEventListener(EVENT_NAME, (event) => {
    try {
      const data = JSON.parse(event.detail);
      if (!data || typeof data !== "object") return;
      const url = new URL(String(data.source_url || ""));
      if (!(url.hostname === "shopee.com.br" || url.hostname.endsWith(".shopee.com.br"))) return;
      chrome.runtime.sendMessage({ type: "LATAM_CAPTURE", data });
    } catch (_) {
      // Discard malformed page events.
    }
  });

  document.addEventListener(BULK_STATUS_EVENT, (event) => {
    try {
      const data = JSON.parse(event.detail || "{}");
      chrome.runtime.sendMessage({ type: "LATAM_BULK_STATUS", data });
    } catch (_) {
      // Discard malformed progress events.
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "LATAM_BULK_COMMAND") return false;
    document.dispatchEvent(new CustomEvent(BULK_COMMAND_EVENT, {
      detail: JSON.stringify(message.command || {})
    }));
    sendResponse({ ok: true });
    return false;
  });
})();

