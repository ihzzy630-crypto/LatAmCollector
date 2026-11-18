(() => {
  "use strict";
  const EVENT_NAME = "LATAM_COLLECTOR_CAPTURE_V1";

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
})();

