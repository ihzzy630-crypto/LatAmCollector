(() => {
  "use strict";
  const HOME = "https://shopee.com.br/";
  const BROWSER_HOSTS = new Set(["shopee.com.br", "www.shopee.com.br"]);
  const SORT_KEYS = ["sortBy", "order", "minPrice", "maxPrice"];
  const NEXT_SELECTORS = [
    'a[rel~="next"]',
    ".shopee-mini-page-controller__next-btn",
    ".shopee-page-controller .shopee-icon-button--right",
    ':is(.shopee-page-controller,.shopee-mini-page-controller,.shopee-pagination,nav[aria-label*="paginação" i]) [aria-label]'
  ].join(",");
  const STANDARD_NEXT = ".shopee-mini-page-controller__next-btn,.shopee-icon-button--right,a[rel~='next']";

  function publicShopeeUrl(value, base = HOME) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, base);
      if (url.protocol !== "https:" || !BROWSER_HOSTS.has(url.hostname) || url.port || url.username || url.password) return null;
      return url;
    } catch (_) {
      return null;
    }
  }

  function cleanLabel(text) {
    return String(text || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function listingEntry(value, label = "", base = HOME) {
    const original = publicShopeeUrl(value, base);
    if (!original) return null;
    const path = original.pathname.replace(/\/+$/, "");
    const match = /-cat\.(\d+(?:\.\d+)*)$/i.exec(path) || /^\/category\/(\d+(?:\.\d+)*)$/i.exec(path);
    const sort = new URLSearchParams();
    for (const name of SORT_KEYS) {
      const value = original.searchParams.get(name);
      if (value && /^[\w.-]{1,30}$/.test(value)) sort.set(name, value);
    }
    const url = new URL(HOME);
    url.pathname = path;
    const keyword = path === "/search" ? cleanLabel(original.searchParams.get("keyword")) : "";
    if (keyword) url.searchParams.set("keyword", keyword);
    for (const [name, value] of sort) url.searchParams.set(name, value);
    const suffix = sort.size ? "?" + sort.toString() : "";
    if (keyword) {
      const scope = "search:" + keyword.toLocaleLowerCase("pt-BR");
      return { scope, key: scope + suffix, kind: "search", url: url.href, label: keyword };
    }
    if (!match) return null;
    const scope = "category:" + match[1];
    let caption = cleanLabel(label);
    if (!caption) {
      try {
        caption = cleanLabel(decodeURIComponent(path.split("/").at(-1)).replace(/-cat\.[\d.]+$/i, "").replace(/-/g, " "));
      } catch (_) {}
    }
    return { scope, key: scope + suffix, kind: "category", url: url.href, label: caption || "分类 " + match[1] };
  }

  function keywordEntry(keyword) {
    const word = cleanLabel(keyword);
    if (!word) return null;
    const url = new URL("/search", HOME);
    url.searchParams.set("keyword", word);
    return listingEntry(url.href);
  }

  function categoryLinks(document, page) {
    if (!publicShopeeUrl(page)) return [];
    const found = new Map();
    for (const link of document.querySelectorAll('a[href*="-cat."],a[href*="/category/"]')) {
      const entry = listingEntry(link.getAttribute("href"), link.innerText || link.textContent, page);
      if (entry?.kind === "category" && !found.has(entry.key)) found.set(entry.key, entry);
    }
    const current = listingEntry(page);
    if (current?.kind === "category" && !found.has(current.key)) found.set(current.key, current);
    return [...found.values()];
  }

  function listingReceipt(sourceUrl, pageUrl, payload) {
    const page = listingEntry(pageUrl);
    const source = publicShopeeUrl(sourceUrl);
    if (!page || !source || (payload?.error && payload.error !== "0")) return null;
    const isSearch = /\/search_items\/?$/i.test(source.pathname);
    const isRecommend = /\/recommend_v2\/?$/i.test(source.pathname);
    if (!isSearch && !(page.kind === "category" && isRecommend)) return null;
    const responseKeyword = cleanLabel(source.searchParams.get("keyword"));
    if (page.kind === "search" && responseKeyword &&
        keywordEntry(responseKeyword)?.scope !== page.scope) return null;
    const entries = payload?.items ?? payload?.data?.items ?? payload?.data?.units ?? payload?.data?.products;
    if (!Array.isArray(entries)) return null;
    const ids = new Set();
    for (const entry of entries) {
      const item = entry?.item || entry;
      const data = item?.item_data || item?.item_basic || item;
      const shop = String(data?.shopid ?? data?.shop_id ?? item?.shopid ?? "");
      const id = String(data?.itemid ?? data?.item_id ?? item?.itemid ?? "");
      if (/^\d+$/.test(shop) && /^\d+$/.test(id)) ids.add(shop + ":" + id);
    }
    if (entries.length && !ids.size) return null;
    let hash = 2166136261;
    for (const character of [...ids].sort().join("|")) {
      hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    }
    return { scope: page.scope, kind: isSearch ? "search" : "recommendation", fingerprint: ids.size + ":" + (hash >>> 0), count: ids.size };
  }

  function nextListingControl(document, pageUrl) {
    const page = listingEntry(pageUrl);
    if (!page) return null;
    for (const control of document.querySelectorAll(NEXT_SELECTORS)) {
      if (!control.matches('a,button,[role="button"]')) continue;
      const label = cleanLabel(control.getAttribute("aria-label")).toLocaleLowerCase("pt-BR");
      if (!control.matches(STANDARD_NEXT) &&
          !["próximo", "próxima página", "página seguinte", "next", "next page"].includes(label)) continue;
      if (control.disabled || control.closest('[disabled],[aria-disabled="true"],[aria-hidden="true"],[hidden],.disabled,.shopee-icon-button--disabled') ||
          /(?:^|[-_\s])disabled(?:$|[-_\s])/.test(String(control.className || "")) ||
          !control.getClientRects().length || document.defaultView?.getComputedStyle(control).visibility === "hidden") continue;
      const href = control.getAttribute("href");
      if (href && !href.startsWith("#") && listingEntry(href, "", pageUrl)?.scope !== page.scope) continue;
      return control;
    }
    return null;
  }

  class QueuePause extends Error {
    constructor(message, needsReview = false) {
      super(message);
      this.needsReview = needsReview;
    }
  }

  async function runQueue(state, io, signal) {
    let current = null;
    state.status = "running";
    try {
      // Entries discovered during browsing can be appended to this same array.
      for (const item of state.entries) {
        if (item.status === "done") continue;
        signal.throwIfAborted();
        current = item;
        const resuming = state.currentKey === item.key;
        state.currentKey = item.key;
        item.status = "running";
        item.message = "打开商品列表";
        await io.save();
        await io.arrive(item, resuming, state.needsReview);

        const visited = new Set();
        let previous = "";
        while (true) {
          signal.throwIfAborted();
          const page = await io.read(item, previous);
          signal.throwIfAborted();
          state.needsReview = false;
          if (state.includeChildren && previous === "" && item.kind === "category") {
            await io.addChildren(item);
          }
          if (!page.count) {
            item.message = "此列表没有商品";
            break;
          }
          if (visited.has(page.fingerprint)) {
            item.message = "页面重复，已结束此入口";
            break;
          }
          visited.add(page.fingerprint);
          if (!item.pages.includes(page.fingerprint)) {
            item.pages.push(page.fingerprint);
            item.saved += page.saved;
            item.added += page.added;
          }
          item.message = `已确认第 ${item.pages.length} 页入库`;
          await io.save();
          if (item.pages.length >= state.pageLimit) {
            item.message = "达到本入口页数设置";
            break;
          }
          signal.throwIfAborted();
          if (!(await io.next(item, page))) {
            item.message = "已到可用分页末尾";
            break;
          }
          previous = page.id;
        }
        item.status = "done";
        state.currentKey = "";
        current = null;
        await io.save();
      }
      state.status = "done";
      state.message = "队列已完成";
    } catch (error) {
      state.status = "paused";
      state.needsReview ||= error.needsReview === true;
      state.message = signal.aborted ? "已暂停，可继续当前入口" : error.message;
      if (current) {
        current.status = "paused";
        current.message = state.message;
      }
    }
    await io.save();
  }

  globalThis.LatAmQueue = { HOME, publicShopeeUrl, listingEntry, keywordEntry, categoryLinks, listingReceipt, nextListingControl, QueuePause, runQueue };
})();
