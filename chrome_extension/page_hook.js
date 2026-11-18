(() => {
  "use strict";
  if (window.__LATAM_COLLECTOR_HOOKED__) return;
  window.__LATAM_COLLECTOR_HOOKED__ = true;

  const EVENT_NAME = "LATAM_COLLECTOR_CAPTURE_V1";
  const URL_MARKERS = ["search_items", "recommend_v2", "get_ratings", "item/get", "pdp/get_pc"];
  const MAX_TEXT_LENGTH = 12 * 1024 * 1024;

  function isSupportedUrl(url) {
    try {
      const parsed = new URL(String(url), location.href);
      const host = parsed.hostname.toLowerCase();
      return (host === "shopee.com.br" || host.endsWith(".shopee.com.br")) && URL_MARKERS.some((part) => parsed.href.includes(part));
    } catch (_) {
      return false;
    }
  }

  function publish(url, payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const message = JSON.stringify({
      source_url: String(url),
      captured_at: new Date().toISOString(),
      payload
    });
    document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: message }));
  }

  async function inspectFetchResponse(response) {
    if (!isSupportedUrl(response.url)) return;
    try {
      const text = await response.clone().text();
      if (!text || text.length > MAX_TEXT_LENGTH) return;
      publish(response.url, JSON.parse(text));
    } catch (_) {
      // The page must never be interrupted when a response is unreadable.
    }
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const pending = originalFetch.apply(this, args);
    pending.then(inspectFetchResponse).catch(() => {});
    return pending;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__latamCollectorUrl = String(url || "");
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (isSupportedUrl(this.__latamCollectorUrl)) {
      this.addEventListener("load", () => {
        try {
          const finalUrl = this.responseURL || this.__latamCollectorUrl;
          let payload;
          if (this.responseType === "json") payload = this.response;
          else if (!this.responseType || this.responseType === "text") {
            if (!this.responseText || this.responseText.length > MAX_TEXT_LENGTH) return;
            payload = JSON.parse(this.responseText);
          }
          publish(finalUrl, payload);
        } catch (_) {
          // Ignore unsupported or non-JSON responses.
        }
      }, { once: true });
    }
    return originalSend.apply(this, args);
  };
})();

