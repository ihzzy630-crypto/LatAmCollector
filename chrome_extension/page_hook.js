(() => {
  "use strict";
  if (window.__LATAM_COLLECTOR_HOOKED__) return;
  window.__LATAM_COLLECTOR_HOOKED__ = true;

  const EVENT_NAME = "LATAM_COLLECTOR_CAPTURE_V1";
  const BULK_COMMAND_EVENT = "LATAM_COLLECTOR_BULK_COMMAND_V1";
  const BULK_STATUS_EVENT = "LATAM_COLLECTOR_BULK_STATUS_V1";
  const URL_MARKERS = ["search_items", "recommend_v2", "get_ratings", "item/get", "pdp/get_pc"];
  const MAX_TEXT_LENGTH = 12 * 1024 * 1024;
  const BULK_INTERVAL_MS = 3000;
  let lastSearchUrl = "";
  let lastSearchTotal = 0;
  let bulkRunId = 0;
  let bulkRunning = false;
  let bulkProgress = {
    status: "idle",
    page: 0,
    captured: 0,
    total: 0,
    nextOffset: 0,
    message: "等待分类或搜索页面"
  };

  function isSupportedUrl(url) {
    try {
      const parsed = new URL(String(url), location.href);
      const host = parsed.hostname.toLowerCase();
      return (host === "shopee.com.br" || host.endsWith(".shopee.com.br")) && URL_MARKERS.some((part) => parsed.href.includes(part));
    } catch (_) {
      return false;
    }
  }

  function isSearchUrl(url) {
    try {
      const parsed = new URL(String(url), location.href);
      const host = parsed.hostname.toLowerCase();
      return (host === "shopee.com.br" || host.endsWith(".shopee.com.br")) && parsed.href.includes("search_items");
    } catch (_) {
      return false;
    }
  }

  function productCount(payload) {
    if (Array.isArray(payload?.items)) return payload.items.length;
    if (Array.isArray(payload?.data?.units)) return payload.data.units.length;
    return 0;
  }

  function pageSignature(payload) {
    let nodes = [];
    if (Array.isArray(payload?.items)) nodes = payload.items;
    else if (Array.isArray(payload?.data?.units)) nodes = payload.data.units.map((unit) => unit?.item || unit);
    const ids = nodes.map((node) => {
      const data = node?.item_data || node?.item_basic || node || {};
      return data.itemid ?? data.item_id ?? "";
    }).filter(Boolean);
    if (!ids.length) return "";
    return ids.slice(0, 5).concat(ids.slice(-5)).join("|");
  }

  function totalCount(payload) {
    const candidates = [payload?.total_count, payload?.data?.total_count, payload?.data?.total];
    for (const value of candidates) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) return number;
    }
    return 0;
  }

  function searchKey(url) {
    try {
      const parsed = new URL(String(url), location.href);
      for (const name of ["newest", "extra_params", "view_session_id"]) parsed.searchParams.delete(name);
      parsed.searchParams.sort();
      return parsed.pathname + "?" + parsed.searchParams.toString();
    } catch (_) {
      return "";
    }
  }

  function emitBulkStatus(status, extra = {}) {
    bulkProgress = {
      ...bulkProgress,
      ...extra,
      status,
      updatedAt: new Date().toISOString()
    };
    document.dispatchEvent(new CustomEvent(BULK_STATUS_EVENT, {
      detail: JSON.stringify(bulkProgress)
    }));
  }

  function rememberSearch(url, payload) {
    if (!isSearchUrl(url)) return;
    const previousKey = searchKey(lastSearchUrl);
    const nextKey = searchKey(url);
    if (previousKey && previousKey !== nextKey) lastSearchTotal = 0;
    lastSearchUrl = String(url);
    lastSearchTotal = totalCount(payload) || lastSearchTotal;
    if (!bulkRunning) {
      emitBulkStatus("ready", {
        total: lastSearchTotal,
        sourceUrl: lastSearchUrl,
        sourceKey: searchKey(lastSearchUrl),
        page: 0,
        captured: 0,
        nextOffset: 0,
        message: lastSearchTotal ? `已识别当前列表，共约 ${lastSearchTotal} 件` : "已识别当前商品列表"
      });
    }
  }

  function publish(url, payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    rememberSearch(url, payload);
    const message = JSON.stringify({
      source_url: String(url),
      captured_at: new Date().toISOString(),
      payload
    });
    document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: message }));
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function runBulk(command) {
    if (bulkRunning) {
      emitBulkStatus("running", { message: "批量采集已经在运行" });
      return;
    }
    if (!lastSearchUrl) {
      emitBulkStatus("error", { message: "请先刷新一次 Shopee 分类页或搜索结果页" });
      return;
    }

    const maxItems = Math.min(6000, Math.max(60, Number(command.maxItems) || 3000));
    const baseUrl = new URL(lastSearchUrl, location.href);
    const limit = Math.min(60, Math.max(1, Number(baseUrl.searchParams.get("limit")) || 60));
    const canResume = Boolean(command.resume && command.sourceKey && command.sourceKey === searchKey(lastSearchUrl));
    let offset = canResume ? Math.max(0, Number(command.startOffset) || 0) : 0;
    let captured = canResume ? Math.max(0, Number(command.captured) || 0) : 0;
    let page = Math.floor(offset / limit);
    const currentRunId = ++bulkRunId;
    const seenPages = new Set();
    bulkRunning = true;
    emitBulkStatus("running", {
      page,
      captured,
      total: lastSearchTotal,
      nextOffset: offset,
      sourceUrl: lastSearchUrl,
      sourceKey: searchKey(lastSearchUrl),
      maxItems,
      message: canResume ? "正在继续采集…" : "正在从第一批开始采集…"
    });

    try {
      while (bulkRunning && currentRunId === bulkRunId && captured < maxItems) {
        const requestUrl = new URL(baseUrl.href);
        requestUrl.searchParams.set("newest", String(offset));
        requestUrl.searchParams.set("limit", String(limit));
        emitBulkStatus("running", {
          page: page + 1,
          captured,
          nextOffset: offset,
          message: `正在读取第 ${page + 1} 批…`
        });

        const response = await originalFetch(requestUrl.href, {
          method: "GET",
          credentials: "include",
          headers: {
            "accept": "application/json",
            "x-api-source": "pc",
            "x-shopee-language": "pt-BR"
          }
        });
        if (response.status === 403 || response.status === 429) {
          throw new Error(`Shopee 返回 ${response.status}，已安全暂停，请稍后继续`);
        }
        if (!response.ok) throw new Error(`Shopee 返回 HTTP ${response.status}`);
        const text = await response.text();
        if (!text || text.length > MAX_TEXT_LENGTH) throw new Error("返回内容为空或过大");
        const payload = JSON.parse(text);
        const count = productCount(payload);
        const total = totalCount(payload) || lastSearchTotal;
        if (!count) {
          emitBulkStatus("done", {
            page,
            captured,
            total,
            nextOffset: offset,
            message: captured ? "后续没有更多商品，采集完成" : "当前接口没有返回商品"
          });
          bulkRunning = false;
          return;
        }

        const signature = pageSignature(payload);
        if (signature && seenPages.has(signature)) {
          bulkRunning = false;
          emitBulkStatus("done", {
            page,
            captured,
            total,
            nextOffset: offset,
            message: `Shopee 从第 ${page + 1} 批开始重复返回，已自动停止并保留前 ${captured} 件`
          });
          return;
        }
        if (signature) seenPages.add(signature);

        publish(requestUrl.href, payload);
        captured += count;
        offset += count;
        page += 1;
        emitBulkStatus("running", {
          page,
          captured,
          total,
          nextOffset: offset,
          message: `已读取 ${captured} 件，等待下一批…`
        });
        if ((total && offset >= total) || count < limit || captured >= maxItems) {
          bulkRunning = false;
          emitBulkStatus("done", {
            page,
            captured,
            total,
            nextOffset: offset,
            message: total && offset >= total ? "当前列表已全部采集" : `已达到本次上限 ${maxItems} 件`
          });
          return;
        }
        await delay(BULK_INTERVAL_MS);
      }
    } catch (error) {
      bulkRunning = false;
      emitBulkStatus("error", {
        page,
        captured,
        nextOffset: offset,
        message: error?.message || String(error)
      });
    }
  }

  document.addEventListener(BULK_COMMAND_EVENT, (event) => {
    try {
      const command = JSON.parse(event.detail || "{}");
      if (command.action === "stop") {
        bulkRunning = false;
        bulkRunId += 1;
        emitBulkStatus("stopped", { message: "已暂停，可稍后继续" });
      } else if (command.action === "start") {
        runBulk(command);
      }
    } catch (error) {
      emitBulkStatus("error", { message: error?.message || "批量命令无效" });
    }
  });

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

