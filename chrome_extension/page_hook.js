(() => {
  "use strict";
  if (window.__LATAM_COLLECTOR_HOOKED__) return;
  window.__LATAM_COLLECTOR_HOOKED__ = true;

  const EVENT_NAME = "LATAM_COLLECTOR_CAPTURE_V1";
  const CAPTURE_RESULT_EVENT = "LATAM_COLLECTOR_CAPTURE_RESULT_V1";
  const BULK_COMMAND_EVENT = "LATAM_COLLECTOR_BULK_COMMAND_V1";
  const BULK_STATUS_EVENT = "LATAM_COLLECTOR_BULK_STATUS_V1";
  const SHOPEE_MARKERS = ["search_items", "recommend_v2", "get_ratings", "item/get", "pdp/get_pc"];
  const SHEIN_MARKERS = [
    "/api/productlist/info/get", "/api/productinfo/productdetail/get",
    "/api/productinfo/quickview/get", "/api/comment/abccommentinfo/query",
    "/api/comment/abccommentimages/query", "/api/comment/abccommentsummary/get",
    "/product/get_goods_review_detail", "/product/get_goods_comment_offset",
    "/category/real_category_goods_list", "/product/get_products_by_keywords",
    "/product/get_goods_detail_static_data", "/product/get_goods_detail_realtime_data",
    "/api/productlist/firstgold/get", "/category/get_select_product_list",
    "/category/get_tags_goods_list", "/category/category_daily_new",
    "/category/get_products_by_discount_list", "/product/search/getpregoodscomponent",
    "/product/search/getsearchcontentcarrier", "/search/card/non_category_by_keyword",
    "/search/card/non_category_by_keywords", "/navigation-api/store/new-arrivals",
    "/store-api/store/category/products", "/api/ccc/store/product/query"
  ];
  const MAX_TEXT_LENGTH = 12 * 1024 * 1024;
  const SHOPEE_INTERVAL_MS = 3000;
  const SHEIN_SCROLL_MIN_MS = 2600;
  const SHEIN_SCROLL_MAX_MS = 4200;
  const SHEIN_PAGE_PAUSE_MIN_MS = 6500;
  const SHEIN_PAGE_PAUSE_MAX_MS = 10000;
  const SHOPEE_STOP_KEY = "LATAM_COLLECTOR_SHOPEE_STOP_V1";
  const SHEIN_JOB_KEY = "LATAM_COLLECTOR_SHEIN_BULK_V1";
  let lastSearchUrl = "";
  let lastSearchPage = "";
  let lastSearchTotal = 0;
  let shopeeCategory = null;
  let shopeeCaptureId = 0;
  let shopeeBlocked = false;
  let shopeeCheckpoint = null;
  let shopeeController = null;
  const passiveSheinFingerprints = new Map();
  let domTimer = 0;
  let bulkRunId = 0;
  let bulkRunning = false;
  let bulkProgress = {
    status: "idle", platform: "", page: 0, captured: 0,
    total: 0, nextOffset: 0, message: "等待商品列表页面"
  };

  function platformFromUrl(url) {
    try {
      const host = new URL(String(url || location.href), location.href).hostname.toLowerCase();
      if (host === "shopee.com.br" || host.endsWith(".shopee.com.br")) return "shopee";
      if (host === "br.shein.com" || host.endsWith(".br.shein.com")) return "shein";
    } catch (_) {}
    return "";
  }

  function isSupportedUrl(url) {
    try {
      const parsed = new URL(String(url), location.href);
      const href = parsed.href.toLowerCase();
      const platform = platformFromUrl(parsed.href);
      const markers = platform === "shopee" ? SHOPEE_MARKERS : platform === "shein" ? SHEIN_MARKERS : [];
      return markers.some((part) => href.includes(part));
    } catch (_) {
      return false;
    }
  }

  function isShopeeSearchUrl(url) {
    return platformFromUrl(url) === "shopee" && String(url).toLowerCase().includes("search_items");
  }

  function currentPage() {
    return location.href.split("#", 1)[0];
  }

  function hasShopeeSearch() {
    return Boolean(lastSearchUrl && lastSearchPage === currentPage());
  }

  function isShopeeCategoryPage() {
    if (/-cat\.\d+(?:\.\d+)*\/?$/i.test(location.pathname) || /^\/category\/[^/]+/i.test(location.pathname)) return true;
    const text = String(document.body?.innerText || "").slice(0, 16000).toLowerCase();
    return text.includes("todas as categorias") && text.includes("classificar por");
  }

  function shopeePageIssue(text, path = "") {
    const message = String(text || "").slice(0, 16000).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").toLowerCase();
    if (/^\/verify\/traffic\/error(?:\/|$)/i.test(path) ||
        (message.includes("página indisponível") && message.includes("algo deu errado"))) {
      return "显示“页面不可用（Página indisponível）”";
    }
    if (/^\/(?:risk\/)?(?:captcha|verify|verification|challenge)(?:\/|$)/i.test(path) ||
        /verifi(?:que|car) (?:se|que) você é humano|verify (?:that )?you are human/.test(message)) {
      return "要求人工验证";
    }
    return "";
  }

  function currentShopeeIssue() {
    return shopeePageIssue(document.body?.innerText, location.pathname);
  }

  function shopeeResponseIssue(requestUrl, finalUrl, status) {
    if (platformFromUrl(location.href) !== "shopee" ||
        platformFromUrl(requestUrl) !== "shopee" || !isSupportedUrl(requestUrl)) return "";
    if (status === 401) return "返回 HTTP 401（需要登录）";
    if (status === 403) return "返回 HTTP 403（拒绝访问）";
    if (status === 429) return "返回 HTTP 429（请求过多）";
    if (finalUrl && platformFromUrl(finalUrl) === "shopee") {
      return shopeePageIssue("", new URL(finalUrl, location.href).pathname);
    }
    return "";
  }

  function shopeeListIssue(url, payload) {
    const error = payload?.error;
    return isShopeeSearchUrl(url) && error && error !== "0" ? "返回商品列表错误" : "";
  }

  function stopShopee(reason) {
    if (shopeeBlocked) return;
    shopeeBlocked = true;
    bulkRunning = false;
    bulkRunId += 1;
    shopeeController?.abort();

    const { page, captured, nextOffset, sourceKey, total, maxItems } = shopeeCheckpoint || bulkProgress;
    shopeeCheckpoint = { page, captured, nextOffset, sourceKey, total, maxItems };
    try { sessionStorage.setItem(SHOPEE_STOP_KEY, JSON.stringify(shopeeCheckpoint)); } catch (_) {}
    emitBulkStatus("blocked", {
      ...shopeeCheckpoint,
      platform: "shopee",
      message: `Shopee ${reason}，采集已暂停。请手动打开正常的商品列表。`
    });
  }

  function sheinPageIssue() {
    if (platformFromUrl(location.href) !== "shein") return "";
    const path = location.pathname.toLowerCase();
    const text = String(document.body?.innerText || "").slice(0, 10000).replace(/\s+/g, " ").toLowerCase();
    if (path.includes("/risk/challenge") || text.includes("verificar que você é humano") ||
        text.includes("eu sou humano") || text.includes("verify you are human") || text.includes("captcha")) {
      return "challenge";
    }
    const hasProducts = Boolean(document.querySelector('a[href*="-p-"],a[href*="goods_id="],a[data-goods-id]'));
    if (text.includes("nenhum artigo encontrado") ||
        (text.includes("por favor tente outras opções") && text.includes("ooops"))) {
      return "empty";
    }
    if (!hasProducts && (text.includes("acesso negado") || text.includes("access denied") ||
        text.includes("atividade incomum") || text.includes("unusual activity") || text.includes("too many requests"))) {
      return "blocked";
    }
    return "";
  }

  function isSheinChallenge() {
    return sheinPageIssue() === "challenge";
  }

  function sheinIssueMessage(issue) {
    if (issue === "challenge") return "SHEIN 要求人工验证，任务已安全暂停；请手动完成验证后再继续";
    if (issue === "empty") return "SHEIN 返回了空结果页，可能是临时限流或列表链接失效；任务已暂停，请点 Volte 返回并稍后继续";
    if (issue === "blocked") return "SHEIN 暂时拒绝了页面访问；任务已暂停，请等待几分钟后手动刷新再继续";
    return "";
  }

  function productCount(payload) {
    if (Array.isArray(payload?.items)) return payload.items.length;
    if (Array.isArray(payload?.data?.units)) return payload.data.units.length;
    if (Array.isArray(payload?.data?.products)) return payload.data.products.length;
    return 0;
  }

  function pageSignature(payload) {
    let nodes = [];
    if (Array.isArray(payload?.items)) nodes = payload.items;
    else if (Array.isArray(payload?.data?.units)) nodes = payload.data.units.map((unit) => unit?.item || unit);
    else if (Array.isArray(payload?.data?.products)) nodes = payload.data.products;
    const ids = nodes.map((node) => {
      const data = node?.item_data || node?.item_basic || node || {};
      return data.itemid ?? data.item_id ?? data.goods_id ?? data.product_id ?? "";
    }).filter(Boolean);
    return ids.length ? ids.slice(0, 5).concat(ids.slice(-5)).join("|") : "";
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

  function sheinSourceKey(url = location.href) {
    try {
      const parsed = new URL(url, location.href);
      for (const name of ["page", "ici", "src_identifier", "src_module", "src_tab_page_id"]) parsed.searchParams.delete(name);
      parsed.searchParams.sort();
      return parsed.pathname + "?" + parsed.searchParams.toString();
    } catch (_) {
      return location.pathname;
    }
  }

  function dispatchBulkStatus(progress) {
    document.dispatchEvent(new CustomEvent(BULK_STATUS_EVENT, { detail: JSON.stringify(progress) }));
  }

  function emitBulkStatus(status, extra = {}) {
    bulkProgress = { ...bulkProgress, ...extra, status, updatedAt: new Date().toISOString() };
    dispatchBulkStatus(bulkProgress);
  }

  function rememberSearch(url, payload) {
    if (!isShopeeSearchUrl(url)) return;
    if (!productCount(payload)) {
      if (!bulkRunning) {
        lastSearchUrl = "";
        lastSearchTotal = 0;
        const progress = shopeeCheckpoint || { total: 0, page: 0, captured: 0, nextOffset: 0, sourceKey: "" };
        emitBulkStatus(shopeeCheckpoint ? "blocked" : "idle", {
          ...progress,
          platform: "shopee", message: "当前搜索没有返回商品，请打开有商品的分类页或搜索结果页"
        });
      }
      return;
    }
    const previousKey = searchKey(lastSearchUrl);
    const nextKey = searchKey(url);
    if (previousKey && previousKey !== nextKey) lastSearchTotal = 0;
    lastSearchUrl = String(url);
    lastSearchPage = currentPage();
    lastSearchTotal = totalCount(payload) || lastSearchTotal;
    if (!bulkRunning) {
      const progress = shopeeCheckpoint || (bulkProgress.status === "stopped" ? bulkProgress : null);
      const resume = progress?.sourceKey === nextKey && progress.nextOffset > 0;
      const message = lastSearchTotal ? `已识别 Shopee 列表，共约 ${lastSearchTotal} 件` : "已识别 Shopee 商品列表";
      emitBulkStatus(resume ? "stopped" : "ready", {
        platform: "shopee", total: lastSearchTotal, sourceKey: nextKey,
        page: resume ? progress.page : 0,
        captured: resume ? progress.captured : 0,
        nextOffset: resume ? progress.nextOffset : 0,
        message: resume ? `已读取 ${progress.captured} 件，可手动继续` : message
      });
    }
  }

  function sendCapture(url, payload, captureId) {
    document.dispatchEvent(new CustomEvent(EVENT_NAME, {
      detail: JSON.stringify({
        source_url: String(url), captured_at: new Date().toISOString(), payload, capture_id: captureId
      })
    }));
  }

  function saveShopeeCategory(category) {
    if (!category || shopeeBlocked || category.status === "running" || category.status === "done") return;
    category.captureId = ++shopeeCaptureId;
    category.status = "running";
    sendCapture(category.url, category.payload, category.captureId);
  }

  function rememberShopeeCategory(url, payload) {
    if (bulkRunning || !/\/recommend_v2\/?$/i.test(new URL(url, location.href).pathname) || !isShopeeCategoryPage()) return false;
    if ((payload.error && payload.error !== "0") || !Array.isArray(payload.data?.units)) return false;
    const products = new Set();
    for (const unit of payload.data.units) {
      const item = unit?.item;
      const data = item?.item_data || item?.item_basic || item;
      const shopId = data?.shopid ?? data?.shop_id ?? item?.shopid;
      const itemId = data?.itemid ?? data?.item_id ?? item?.itemid;
      if (shopId && itemId) products.add(`${shopId}:${itemId}`);
    }
    if (!products.size) return false;
    shopeeCategory = {
      pageUrl: currentPage(), url, payload, count: products.size, saved: 0, status: "ready"
    };
    if (!shopeeCheckpoint) saveShopeeCategory(shopeeCategory);
    return true;
  }

  function currentShopeeCategory() {
    return !hasShopeeSearch() && shopeeCategory?.pageUrl === currentPage() ? shopeeCategory : null;
  }

  function shopeeStatusForTab() {
    if (shopeeBlocked || bulkRunning) return bulkProgress;
    const category = currentShopeeCategory();
    if (!category) {
      if (lastSearchUrl && !hasShopeeSearch() && !shopeeCheckpoint) {
        return { platform: "shopee", status: "idle", message: "等待当前页的商品列表" };
      }
      return bulkProgress;
    }
    const messages = {
      ready: `已识别本页 ${category.count} 件商品，可以保存到选品雷达`,
      running: `已识别本页 ${category.count} 件商品，正在入库`,
      done: `本页 ${category.saved} 件商品已入库`,
      error: `已识别本页 ${category.count} 件商品，入库未成功，可重试保存`
    };
    return {
      platform: "shopee", mode: "category_page", status: category.status,
      captured: category.saved, total: category.count, message: messages[category.status]
    };
  }

  document.addEventListener(CAPTURE_RESULT_EVENT, (event) => {
    try {
      const { captureId, products } = JSON.parse(event.detail || "{}");
      const category = shopeeCategory;
      if (!category || shopeeBlocked || category.captureId !== captureId || category.status !== "running") return;
      category.saved = Number.isInteger(products) && products > 0 ? products : 0;
      category.status = category.saved ? "done" : "error";
      if (category.saved) category.payload = null;
    } catch (_) {}
  });

  function publish(url, payload, page = currentPage()) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const isShopee = platformFromUrl(location.href) === "shopee" && platformFromUrl(url) === "shopee";
    if (isShopee) {
      const issue = currentShopeeIssue() || shopeeListIssue(url, payload);
      if (issue) stopShopee(issue);
      if (shopeeBlocked) return;
      if (page === currentPage()) {
        rememberSearch(url, payload);
        if (rememberShopeeCategory(url, payload)) return;
      }
      if (shopeeCheckpoint) return;
    }
    sendCapture(url, payload);
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function pacedDelay(minimum, maximum) {
    const low = Math.max(0, Number(minimum) || 0);
    const high = Math.max(low, Number(maximum) || low);
    return delay(Math.floor(low + Math.random() * (high - low + 1)));
  }

  function textOf(element) {
    return String(element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function sheinProductId(anchor, card) {
    const attributes = [
      anchor?.getAttribute("data-goods-id"), card?.getAttribute("data-goods-id"),
      anchor?.getAttribute("data-product-id"), card?.getAttribute("data-product-id")
    ];
    for (const value of attributes) if (/^\d+$/.test(String(value || ""))) return String(value);
    const href = String(anchor?.href || anchor?.getAttribute("href") || "");
    const match = href.match(/-p-(\d+)(?:\.html|[/?#]|$)/i) || href.match(/[?&](?:goods_id|product_id)=(\d+)/i);
    return match ? match[1] : "";
  }

  function sheinCard(anchor) {
    const fallback = anchor.closest('[data-goods-id],[data-product-id],[class*="product-card" i],[class*="product-item" i],[class*="goods-item" i],li') || anchor.parentElement;
    let current = anchor;
    for (let depth = 0; depth < 8 && current && current !== document.body; depth += 1) {
      const productLinks = current.querySelectorAll?.('a[href*="-p-"],a[href*="goods_id="]') || [];
      if (productLinks.length > 4) break;
      const text = textOf(current);
      const hasPrice = /R\$\s*[0-9]/i.test(text);
      const hasSales = /[0-9][0-9.,]*\s*(?:k|mil|mi|m)?\+?\s*vendid[oa]s?/i.test(text);
      if (hasPrice && hasSales) return current;
      current = current.parentElement;
    }
    return fallback;
  }

  function firstText(root, selectors) {
    for (const selector of selectors) {
      const value = textOf(root?.querySelector(selector));
      if (value) return value;
    }
    return "";
  }

  function scanSheinProducts() {
    if (platformFromUrl(location.href) !== "shein" || sheinPageIssue()) return [];
    const links = document.querySelectorAll('a[href*="-p-"],a[href*="goods_id="],a[data-goods-id]');
    const found = new Map();
    const category = firstText(document, ["h1", '[class*="category-title" i]']) || document.title;
    for (const anchor of links) {
      const card = sheinCard(anchor);
      const goodsId = sheinProductId(anchor, card);
      if (!goodsId || found.has(goodsId)) continue;
      const cardText = textOf(card).slice(0, 5000);
      const image = card?.querySelector("img") || anchor.querySelector("img");
      const title = anchor.getAttribute("title") || firstText(card, [
        '[data-goods-name]', '[class*="goods-title" i]', '[class*="product-title" i]', '[class*="item-title" i]'
      ]) || image?.alt || "未命名商品";
      const priceText = firstText(card, [
        '[class*="sale-price" i]', '[class*="product-price" i]', '[class*="goods-price" i]', '[class*="price" i]'
      ]);
      const priceMatch = (priceText || cardText).match(/R\$\s*[0-9][0-9.]*,[0-9]{2}|R\$\s*[0-9]+(?:[.,][0-9]{1,2})?/i);
      const soldMatch = cardText.match(/[0-9][0-9.,]*\s*(?:k|mil|mi|m)?\+?\s*vendid[oa]s?/i);
      const ratingMatch = cardText.match(/([0-5](?:[.,][0-9]{1,2}))\s*(?:\/\s*5|★|estrel)/i);
      const shopName = firstText(card, ['[class*="store-name" i]', '[class*="brand-name" i]', '[class*="mall-name" i]']);
      const rawImage = image?.currentSrc || image?.src || image?.getAttribute("data-src") || image?.getAttribute("data-original") || "";
      let productUrl = "";
      try { productUrl = new URL(anchor.href || anchor.getAttribute("href"), location.href).href; } catch (_) {}
      found.set(goodsId, {
        goods_id: goodsId,
        goods_name: String(title).trim().slice(0, 1000),
        sale_price_text: priceMatch?.[0] || "",
        sold_num_text: soldMatch?.[0] || "",
        comment_rank_average: ratingMatch?.[1]?.replace(",", ".") || "",
        category_name: category.slice(0, 300),
        mall_name: shopName.slice(0, 300),
        product_url: productUrl,
        goods_img: rawImage
      });
    }
    return [...found.values()];
  }

  function publishSheinDom(products) {
    if (!products.length) return;
    const source = new URL("/__latam_collector_dom__/product-list", location.origin);
    source.searchParams.set("page", location.pathname);
    publish(source.href, {
      latam_collector: { platform: "shein", kind: "products", source: "page_dom", version: 1 },
      data: { products }
    });
  }

  function passiveSheinCapture() {
    if (bulkRunning || sheinPageIssue()) return;
    const products = scanSheinProducts();
    const changed = products.filter((item) => {
      const fingerprint = [
        item.goods_name, item.sale_price_text, item.sold_num_text,
        item.comment_rank_average, item.product_url
      ].join("|");
      if (passiveSheinFingerprints.get(item.goods_id) === fingerprint) return false;
      passiveSheinFingerprints.set(item.goods_id, fingerprint);
      return true;
    });
    if (!changed.length) return;
    publishSheinDom(changed);
    emitBulkStatus("ready", {
      platform: "shein", page: 0, captured: 0, nextOffset: 0,
      sourceKey: sheinSourceKey(), message: `已识别当前 SHEIN 页面 ${products.length} 件商品`
    });
  }

  function schedulePassiveSheinCapture() {
    if (platformFromUrl(location.href) !== "shein") return;
    clearTimeout(domTimer);
    domTimer = setTimeout(passiveSheinCapture, 1800);
  }

  async function runShopeeBulk(command) {
    const pageIssue = currentShopeeIssue();
    if (pageIssue) stopShopee(pageIssue);
    if (shopeeBlocked) return;
    if (!hasShopeeSearch()) {
      if (shopeeCheckpoint) return;
      emitBulkStatus("idle", { platform: "shopee", message: "请先打开 Shopee 分类页或搜索结果页" });
      return;
    }
    if (shopeeCheckpoint) {
      const { nextOffset, captured, sourceKey } = shopeeCheckpoint;
      command = { ...command, resume: true, startOffset: nextOffset, captured, sourceKey };
      shopeeCheckpoint = null;
      try { sessionStorage.removeItem(SHOPEE_STOP_KEY); } catch (_) {}
    }
    const maxItems = Math.min(6000, Math.max(60, Number(command.maxItems) || 3000));
    const baseUrl = new URL(lastSearchUrl, location.href);
    const limit = Math.min(60, Math.max(1, Number(baseUrl.searchParams.get("limit")) || 60));
    const canResume = Boolean(command.resume && command.sourceKey && command.sourceKey === searchKey(lastSearchUrl));
    let offset = canResume ? Math.max(0, Number(command.startOffset) || 0) : 0;
    let captured = canResume ? Math.max(0, Number(command.captured) || 0) : 0;
    let page = Math.floor(offset / limit);
    if (captured >= maxItems) {
      emitBulkStatus("done", { platform: "shopee", page, captured, maxItems, message: `已达到本次上限 ${maxItems} 件` });
      return;
    }
    const currentRunId = ++bulkRunId;
    const controller = new AbortController();
    shopeeController = controller;
    const seenPages = new Set();
    bulkRunning = true;
    emitBulkStatus("running", {
      platform: "shopee", page, captured, total: lastSearchTotal, nextOffset: offset,
      sourceKey: searchKey(lastSearchUrl), maxItems,
      message: canResume ? "正在继续采集…" : "正在从第一批开始采集…"
    });
    try {
      while (bulkRunning && currentRunId === bulkRunId && captured < maxItems) {
        const issue = currentShopeeIssue();
        if (issue) return stopShopee(issue);
        const requestUrl = new URL(baseUrl.href);
        requestUrl.searchParams.set("newest", String(offset));
        requestUrl.searchParams.set("limit", String(limit));
        emitBulkStatus("running", { page: page + 1, captured, nextOffset: offset, message: `正在读取第 ${page + 1} 批…` });
        const response = await originalFetch(requestUrl.href, {
          method: "GET", credentials: "include", signal: controller.signal,
          headers: { "accept": "application/json", "x-api-source": "pc", "x-shopee-language": "pt-BR" }
        });
        if (currentRunId !== bulkRunId) return;
        const responseIssue = shopeeResponseIssue(requestUrl.href, response.url, response.status);
        if (responseIssue) return stopShopee(responseIssue);
        if (!response.ok) return stopShopee(`返回 HTTP ${response.status}`);
        const text = await response.text();
        if (currentRunId !== bulkRunId) return;
        const bodyIssue = currentShopeeIssue() || (/^\s*</.test(text) && shopeePageIssue(text));
        if (bodyIssue) return stopShopee(bodyIssue);
        if (!text || text.length > MAX_TEXT_LENGTH) return stopShopee("返回的列表内容为空或过大");
        const payload = JSON.parse(text);
        const listIssue = shopeeListIssue(requestUrl.href, payload);
        if (listIssue) return stopShopee(listIssue);
        const count = productCount(payload);
        const total = totalCount(payload) || lastSearchTotal;
        if (!count) {
          bulkRunning = false;
          emitBulkStatus("done", { page, captured, total, nextOffset: offset, message: captured ? "后续没有更多商品，采集完成" : "当前接口没有返回商品" });
          return;
        }
        const signature = pageSignature(payload);
        if (signature && seenPages.has(signature)) {
          bulkRunning = false;
          emitBulkStatus("done", { page, captured, total, nextOffset: offset, message: `Shopee 从第 ${page + 1} 批开始重复返回，已保留前 ${captured} 件` });
          return;
        }
        if (signature) seenPages.add(signature);
        publish(requestUrl.href, payload);
        if (currentRunId !== bulkRunId) return;
        captured += count;
        offset += count;
        page += 1;
        emitBulkStatus("running", { page, captured, total, nextOffset: offset, message: `已读取 ${captured} 件，等待下一批…` });
        if ((total && offset >= total) || count < limit || captured >= maxItems) {
          bulkRunning = false;
          emitBulkStatus("done", { page, captured, total, nextOffset: offset, message: total && offset >= total ? "当前列表已全部采集" : `已达到本次上限 ${maxItems} 件` });
          return;
        }
        await delay(SHOPEE_INTERVAL_MS);
      }
    } catch (error) {
      if (currentRunId !== bulkRunId) return;
      stopShopee(error?.name === "SyntaxError" ? "返回了无法读取的列表内容" : "商品列表请求失败");
    } finally {
      if (shopeeController === controller) shopeeController = null;
    }
  }

  function loadSheinJob(command) {
    let stored = null;
    try { stored = JSON.parse(sessionStorage.getItem(SHEIN_JOB_KEY) || "null"); } catch (_) {}
    if (command.resume && stored && stored.sourceKey === sheinSourceKey()) {
      stored.running = true;
      stored.maxItems = Math.min(6000, Math.max(20, Number(command.maxItems) || stored.maxItems || 3000));
      return stored;
    }
    return {
      running: true, sourceKey: sheinSourceKey(),
      maxItems: Math.min(6000, Math.max(20, Number(command.maxItems) || 3000)),
      page: 0, captured: 0, seenIds: [], visitedUrls: []
    };
  }

  function saveSheinJob(job) {
    try { sessionStorage.setItem(SHEIN_JOB_KEY, JSON.stringify(job)); } catch (_) {}
  }

  function clearSheinJob() {
    try { sessionStorage.removeItem(SHEIN_JOB_KEY); } catch (_) {}
  }

  async function scrollSheinPage(job, currentRunId) {
    let stableRounds = 0;
    let previousHeight = 0;
    let previousCount = 0;
    const collected = new Map();
    for (let round = 0; round < 80 && bulkRunning && currentRunId === bulkRunId; round += 1) {
      const issue = sheinPageIssue();
      if (issue) throw new Error(sheinIssueMessage(issue));
      for (const item of scanSheinProducts()) collected.set(item.goods_id, item);
      const visibleUnique = collected.size;
      const height = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
      emitBulkStatus("running", {
        platform: "shein", page: job.page + 1, captured: job.seenIds.length,
        nextOffset: job.seenIds.length, maxItems: job.maxItems,
        message: `SHEIN 第 ${job.page + 1} 页已加载 ${visibleUnique} 件，正在自动滚动…`
      });
      if (job.seenIds.length + visibleUnique >= job.maxItems) break;
      window.scrollTo({ top: height, behavior: "smooth" });
      await pacedDelay(SHEIN_SCROLL_MIN_MS, SHEIN_SCROLL_MAX_MS);
      const issueAfterScroll = sheinPageIssue();
      if (issueAfterScroll) throw new Error(sheinIssueMessage(issueAfterScroll));
      const nextHeight = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
      for (const item of scanSheinProducts()) collected.set(item.goods_id, item);
      const nextCount = collected.size;
      stableRounds = nextHeight === previousHeight && nextCount === previousCount ? stableRounds + 1 : 0;
      previousHeight = nextHeight;
      previousCount = nextCount;
      if (stableRounds >= 3) break;
    }
    for (const item of scanSheinProducts()) collected.set(item.goods_id, item);
    return [...collected.values()];
  }

  function nextSheinPageTarget() {
    const candidates = [...document.querySelectorAll(
      'a[rel="next"],[class*="pagination" i] a,[class*="pagination" i] button,[id*="pagination" i] a,[id*="pagination" i] button,nav[aria-label*="pag" i] a,nav[aria-label*="pag" i] button'
    )];
    for (const element of candidates) {
      const inPagination = element.matches('a[rel="next"]') || Boolean(element.closest(
        '[class*="pagination" i],[id*="pagination" i],nav[aria-label*="pag" i]'
      ));
      if (!inPagination) continue;
      const label = [textOf(element), element.getAttribute("aria-label"), element.getAttribute("title"), element.className]
        .filter(Boolean).join(" ");
      if (!/(pr[oó]xim|seguinte|next|pagination-next|\u203a|\u00bb)/i.test(label)) continue;
      if (element.disabled || element.getAttribute("aria-disabled") === "true" || String(element.className).toLowerCase().includes("disabled")) continue;
      const href = element.tagName === "A" ? element.href : "";
      if (href && platformFromUrl(href) !== "shein") continue;
      if (href && (href === location.href || sheinSourceKey(href) !== sheinSourceKey(location.href))) continue;
      return { element, href };
    }
    return null;
  }

  async function waitForSheinPageChange(previousSignature) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(800);
      const issue = sheinPageIssue();
      if (issue) throw new Error(sheinIssueMessage(issue));
      const signature = scanSheinProducts().map((item) => item.goods_id).slice(0, 8).join("|");
      if (signature && signature !== previousSignature) return true;
    }
    return false;
  }

  async function runSheinBulk(command) {
    const initialIssue = sheinPageIssue();
    if (initialIssue) {
      let stored = null;
      try { stored = JSON.parse(sessionStorage.getItem(SHEIN_JOB_KEY) || "null"); } catch (_) {}
      if (stored) { stored.running = false; saveSheinJob(stored); }
      emitBulkStatus("error", {
        platform: "shein", captured: stored?.seenIds?.length || 0,
        nextOffset: stored?.seenIds?.length || 0, message: sheinIssueMessage(initialIssue)
      });
      return;
    }
    const job = loadSheinJob(command);
    const currentRunId = ++bulkRunId;
    bulkRunning = true;
    saveSheinJob(job);
    emitBulkStatus("running", {
      platform: "shein", page: job.page, captured: job.captured, nextOffset: job.captured,
      sourceKey: job.sourceKey, maxItems: job.maxItems,
      message: command.resume ? "正在继续 SHEIN 采集…" : "正在读取 SHEIN 当前列表…"
    });
    try {
      while (bulkRunning && currentRunId === bulkRunId && job.seenIds.length < job.maxItems) {
        const currentUrl = location.href;
        const products = await scrollSheinPage(job, currentRunId);
        if (!bulkRunning || currentRunId !== bulkRunId) return;
        const seen = new Set(job.seenIds);
        const fresh = products.filter((item) => !seen.has(item.goods_id)).slice(0, job.maxItems - seen.size);
        if (fresh.length) {
          publishSheinDom(fresh);
          for (const item of fresh) seen.add(item.goods_id);
          job.seenIds = [...seen];
        }
        job.page += 1;
        job.captured = job.seenIds.length;
        if (!job.visitedUrls.includes(currentUrl)) job.visitedUrls.push(currentUrl);
        saveSheinJob(job);
        if (job.captured >= job.maxItems) {
          job.running = false;
          saveSheinJob(job);
          bulkRunning = false;
          emitBulkStatus("done", { platform: "shein", page: job.page, captured: job.captured, nextOffset: job.captured, message: `已达到本次上限 ${job.maxItems} 件` });
          return;
        }
        const next = nextSheinPageTarget();
        if (!next) {
          job.running = false;
          saveSheinJob(job);
          bulkRunning = false;
          emitBulkStatus("done", { platform: "shein", page: job.page, captured: job.captured, nextOffset: job.captured, message: `当前 SHEIN 列表已采集完，共 ${job.captured} 件` });
          return;
        }
        if (next.href && job.visitedUrls.includes(next.href)) {
          job.running = false;
          saveSheinJob(job);
          bulkRunning = false;
          emitBulkStatus("done", { platform: "shein", page: job.page, captured: job.captured, nextOffset: job.captured, message: `检测到重复分页，已保留 ${job.captured} 件` });
          return;
        }
        const previousSignature = products.map((item) => item.goods_id).slice(0, 8).join("|");
        emitBulkStatus("running", { platform: "shein", page: job.page, captured: job.captured, nextOffset: job.captured, message: `已保存 ${job.captured} 件，安全间隔后进入下一页…` });
        window.scrollTo(0, 0);
        saveSheinJob(job);
        await pacedDelay(SHEIN_PAGE_PAUSE_MIN_MS, SHEIN_PAGE_PAUSE_MAX_MS);
        if (!bulkRunning || currentRunId !== bulkRunId) return;
        const issueBeforePage = sheinPageIssue();
        if (issueBeforePage) throw new Error(sheinIssueMessage(issueBeforePage));
        if (next.href) {
          location.assign(next.href);
          return;
        }
        next.element.click();
        const changed = await waitForSheinPageChange(previousSignature);
        if (!changed) throw new Error("SHEIN 下一页在 24 秒内没有加载，任务已暂停，避免连续重复点击");
        await pacedDelay(SHEIN_SCROLL_MIN_MS, SHEIN_SCROLL_MAX_MS);
      }
    } catch (error) {
      job.running = false;
      saveSheinJob(job);
      bulkRunning = false;
      emitBulkStatus("error", { platform: "shein", page: job.page, captured: job.seenIds.length, nextOffset: job.seenIds.length, message: error?.message || String(error) });
    }
  }

  async function runBulk(command) {
    if (bulkRunning) {
      emitBulkStatus("running", { message: "批量采集已经在运行" });
      return;
    }
    const platform = platformFromUrl(location.href);
    if (platform === "shopee") await runShopeeBulk(command);
    else if (platform === "shein") await runSheinBulk(command);
    else emitBulkStatus("error", { message: "请先打开 Shopee 或 SHEIN 巴西站商品列表" });
  }

  document.addEventListener(BULK_COMMAND_EVENT, (event) => {
    try {
      const command = JSON.parse(event.detail || "{}");
      if (command.action === "status") {
        if (!shopeeBlocked && platformFromUrl(location.href) === "shopee") {
          const issue = currentShopeeIssue();
          if (issue) stopShopee(issue);
        }
        const status = platformFromUrl(location.href) === "shopee" ? shopeeStatusForTab() : bulkProgress;
        dispatchBulkStatus({ ...status, snapshot: true });
      } else if (command.action === "save_category" && platformFromUrl(location.href) === "shopee") {
        const issue = currentShopeeIssue();
        if (issue) stopShopee(issue);
        if (!bulkRunning) saveShopeeCategory(currentShopeeCategory());
      } else if (command.action === "stop") {
        if (shopeeBlocked || shopeeCheckpoint) return;
        bulkRunning = false;
        bulkRunId += 1;
        shopeeController?.abort();
        if (platformFromUrl(location.href) === "shein") {
          let job = null;
          try { job = JSON.parse(sessionStorage.getItem(SHEIN_JOB_KEY) || "null"); } catch (_) {}
          if (job) { job.running = false; saveSheinJob(job); }
        }
        emitBulkStatus("stopped", { message: "已暂停，可稍后继续" });
      } else if (command.action === "start") {
        runBulk(command);
      }
    } catch (error) {
      emitBulkStatus("error", { message: error?.message || "批量命令无效" });
    }
  });

  async function inspectFetchResponse(response, requestUrl, page) {
    const responseIssue = shopeeResponseIssue(requestUrl, response.url, response.status);
    if (responseIssue) return stopShopee(responseIssue);
    const onShopee = platformFromUrl(location.href) === "shopee" && platformFromUrl(response.url) === "shopee";
    if (!isSupportedUrl(response.url) || (onShopee && (shopeeBlocked || !response.ok))) return;
    try {
      const text = await response.clone().text();
      if (!text || text.length > MAX_TEXT_LENGTH) return;
      if (onShopee && /^\s*</.test(text)) {
        const issue = shopeePageIssue(text);
        if (issue) return stopShopee(issue);
      }
      publish(response.url, JSON.parse(text), page);
    } catch (_) {
      // The page must never be interrupted when a response is unreadable.
    }
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const page = currentPage();
    const pending = originalFetch.apply(this, args);
    pending.then((response) => inspectFetchResponse(response, args[0]?.url || args[0], page)).catch(() => {});
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
      const page = currentPage();
      this.addEventListener("load", () => {
        try {
          const finalUrl = this.responseURL || this.__latamCollectorUrl;
          const responseIssue = shopeeResponseIssue(this.__latamCollectorUrl, finalUrl, this.status);
          if (responseIssue) return stopShopee(responseIssue);
          const onShopee = platformFromUrl(location.href) === "shopee" && platformFromUrl(finalUrl) === "shopee";
          if (onShopee && (shopeeBlocked || this.status >= 400)) return;
          let payload;
          if (this.responseType === "json") payload = this.response;
          else if (!this.responseType || this.responseType === "text") {
            if (!this.responseText || this.responseText.length > MAX_TEXT_LENGTH) return;
            const bodyIssue = onShopee && /^\s*</.test(this.responseText) && shopeePageIssue(this.responseText);
            if (bodyIssue) return stopShopee(bodyIssue);
            payload = JSON.parse(this.responseText);
          }
          publish(finalUrl, payload, page);
        } catch (_) {
          // Ignore unsupported or non-JSON responses.
        }
      }, { once: true });
    }
    return originalSend.apply(this, args);
  };

  function initializeSheinPage() {
    if (platformFromUrl(location.href) !== "shein") return;
    const issue = sheinPageIssue();
    if (issue) {
      let job = null;
      try { job = JSON.parse(sessionStorage.getItem(SHEIN_JOB_KEY) || "null"); } catch (_) {}
      if (job?.running) {
        job.running = false;
        saveSheinJob(job);
        emitBulkStatus("error", {
          platform: "shein", captured: job.seenIds?.length || 0, nextOffset: job.seenIds?.length || 0,
          message: sheinIssueMessage(issue)
        });
      }
      return;
    }
    schedulePassiveSheinCapture();
    const observer = new MutationObserver(schedulePassiveSheinCapture);
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    let job = null;
    try { job = JSON.parse(sessionStorage.getItem(SHEIN_JOB_KEY) || "null"); } catch (_) {}
    if (job?.running && job.sourceKey === sheinSourceKey()) {
      setTimeout(() => runSheinBulk({ resume: true, maxItems: job.maxItems }), 4500 + Math.floor(Math.random() * 2500));
    }
  }

  function initializePage() {
    if (platformFromUrl(location.href) !== "shopee") return initializeSheinPage();
    const checkPage = () => {
      const issue = currentShopeeIssue();
      if (issue) stopShopee(issue);
    };
    checkPage();
    let timer;
    const observer = new MutationObserver(() => {
      if (shopeeBlocked || timer) return;
      timer = setTimeout(() => {
        timer = null;
        checkPage();
      }, 250);
    });
    if (document.body) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (platformFromUrl(location.href) === "shopee") {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SHOPEE_STOP_KEY) || "null");
      if (saved && typeof saved === "object") {
        const { page, captured, nextOffset, sourceKey, total, maxItems } = saved;
        shopeeCheckpoint = { page, captured, nextOffset, sourceKey, total, maxItems };
        emitBulkStatus("blocked", {
          ...shopeeCheckpoint, platform: "shopee",
          message: "上次采集已暂停，请手动打开正常的商品列表"
        });
      }
    } catch (_) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializePage, { once: true });
  else initializePage();
})();
