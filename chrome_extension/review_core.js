(() => {
  "use strict";

  const LOCAL_ORIGIN = "http://127.0.0.1:8765";
  const SHOPEE = new Set(["shopee.com.br", "www.shopee.com.br"]);
  const SHEIN = new Set(["br.shein.com", "www.br.shein.com"]);
  const REVIEW_SECTION = [
    ".product-ratings", "#product-ratings", "#product-reviews", "#product-review", "#comment",
    ".product-intro__reviews", ".common-reviews", ".product-review", ".product-comment",
    'section[id*="review" i]', 'section[id*="rating" i]', '[data-testid="product-reviews"]',
    '[data-testid="review-section"]', '[data-testid="reviews-section"]'
  ].join(",");
  const PAGER = [
    ".shopee-page-controller", ".shopee-pagination", ".sui-pagination", ".s-pagination", ".review-pagination",
    '[data-testid="review-pagination"]', '[data-testid="pagination"]', '[class*="pagination" i]',
    'nav[aria-label*="page" i]', 'nav[aria-label*="pág" i]'
  ].join(",");
  const CONTROLS = 'a[href],button,[role="button"],[role="tab"]';
  const NEXT_NAMES = new Set(["proxima", "proximo", "proxima pagina", "pagina seguinte", "next", "next page", ">", "›", "❯"]);
  const NEXT_CONTROL = [
    '.shopee-icon-button--right', '.shopee-mini-page-controller__next-btn', '.sui-pagination__next',
    '.s-pagination__next', '[data-testid="review-next"]', '[data-testid="pagination-next"]', 'a[rel~="next"]'
  ].join(",");

  function publicUrl(value, base) {
    try {
      const url = new URL(value, base);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
      return url;
    } catch {
      return null;
    }
  }

  function productPage(value, base) {
    const url = publicUrl(value, base);
    if (!url) return null;
    if (SHOPEE.has(url.hostname)) {
      const match = /^\/product\/(\d+)\/(\d+)\/?$/i.exec(url.pathname) || /-i\.(\d+)\.(\d+)\/?$/i.exec(url.pathname);
      if (match) return { platform: "shopee", shop_id: match[1], item_id: match[2], url: url.href };
    }
    if (SHEIN.has(url.hostname)) {
      const match = /-p-(\d+)\.html\/?$/i.exec(url.pathname);
      if (match) return { platform: "shein", item_id: match[1], url: url.href };
    }
    return null;
  }

  function sameProduct(value, expected, base) {
    const page = productPage(value, base);
    return Boolean(page && page.platform === expected?.platform && page.item_id === String(expected.item_id) &&
      (page.platform === "shein" || page.shop_id === String(expected.shop_id)));
  }

  function reviewListResponse(value) {
    const url = publicUrl(value);
    if (!url) return false;
    const path = url.pathname.toLowerCase().replace(/\/$/, "");
    return (SHOPEE.has(url.hostname) && path.endsWith("/get_ratings")) ||
      (SHEIN.has(url.hostname) && ["/api/comment/abccommentinfo/query", "/product/get_goods_comment_offset", "/product/get_goods_review_detail"].includes(path));
  }

  function normalize(value) {
    return String(value ?? "").normalize("NFKD").replace(/\p{Mark}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function pageIssue(value, text = "") {
    const url = publicUrl(value);
    const path = url?.pathname || "";
    if (/\/(?:captcha|verify|verification|challenge)(?:\/|$)/i.test(path)) return "平台要求验证或暂时限制访问";
    if (/\/(?:login|signin|sign-in)(?:\/|$)/i.test(path)) return "平台要求登录";
    const words = normalize(text).slice(0, 16000);
    if (/verify (?:that )?you are human|verifi(?:que|car) (?:se|que) voce e humano|eu sou humano/.test(words)) return "平台要求人工验证";
    if (/pagina indisponivel|nenhum artigo encontrado|acesso negado|access denied|too many requests|atividade incomum/.test(words)) return "平台页面暂不可用";
    return "";
  }

  function visible(element) {
    if (!element?.isConnected || element.closest('[hidden],[aria-hidden="true"]') || !element.getClientRects().length) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function disabled(element, scope) {
    for (let node = element; node && node !== scope; node = node.parentElement) {
      if (node.matches(':disabled,[disabled],[aria-disabled="true"],[data-disabled="true"]') ||
          /(?:^|[-_\s])disabled(?:$|[-_\s])/i.test(String(node.className))) return true;
    }
    return false;
  }

  function controlText(node) {
    return [node.getAttribute("aria-label"), node.getAttribute("title"), node.textContent].filter(Boolean).map(normalize);
  }

  function internalControl(node, product, currentUrl) {
    if (node.tagName !== "A") return true;
    const href = node.getAttribute("href");
    if (!href || node.target === "_blank") return false;
    return sameProduct(href, product, currentUrl);
  }

  function reviewHeading(text) {
    return /^(?:(?:ver|mostrar) (?:todas as |mais )?)?(?:(?:[\d.,]+\+?\s+)?(?:avaliacoes|avaliacao|comentarios|reviews))(?: (?:do produto|de clientes?|dos clientes|dos compradores|de compradores|de usuarios))?(?:\s*\([\d.,]+\+?\))?$/.test(text);
  }

  function findSection(doc) {
    const dialog = [...doc.querySelectorAll('[role="dialog"]')].find(node => visible(node) &&
      [...node.querySelectorAll('h2,h3,[role="heading"]')].some(heading => reviewHeading(normalize(heading.textContent))));
    if (dialog) return dialog;
    const identified = [...doc.querySelectorAll(REVIEW_SECTION)].find(visible);
    if (identified) return identified;
    for (const heading of doc.querySelectorAll('h2,h3,h4,[role="heading"]')) {
      if (!visible(heading) || !reviewHeading(normalize(heading.textContent))) continue;
      const parent = heading.closest("section,[role='region']");
      if (parent && parent !== doc.body && parent.getBoundingClientRect().height >= heading.getBoundingClientRect().height) return parent;
    }
    return null;
  }

  function findEntry(doc, product, currentUrl, section) {
    const scope = section || doc;
    return [...scope.querySelectorAll(CONTROLS)].find(node =>
      visible(node) && !disabled(node, scope) && controlText(node).some(reviewHeading) && internalControl(node, product, currentUrl)
    ) || null;
  }

  function emptyReviews(section) {
    return /\b(?:sem avaliacoes|ainda nao ha (?:avaliacoes|comentarios)|nao ha avaliacoes|nenhuma avaliacao|no reviews yet)\b/.test(normalize(section?.innerText));
  }

  function pagination(section, product, url) {
    if (!section) return { action: "waiting" };
    const controls = new Set(section.querySelectorAll(NEXT_CONTROL));
    for (const pager of section.querySelectorAll(PAGER)) {
      for (const control of pager.querySelectorAll(CONTROLS)) {
        if (controlText(control).some(text => NEXT_NAMES.has(text))) controls.add(control);
      }
    }
    const visibleNext = [...controls].filter(node => visible(node));
    const next = visibleNext.find(node => !disabled(node, section) && internalControl(node, product, url));
    if (next) return { action: "next", control: next };
    if (visibleNext.length && visibleNext.every(node => disabled(node, section))) return { action: "end" };

    for (const pager of section.querySelectorAll(PAGER)) {
      const current = [...pager.querySelectorAll('[aria-current="page"],.shopee-button-solid,.sui-pagination__item--active,.active')]
        .find(node => visible(node) && /^\d+$/.test(normalize(node.textContent)));
      if (!current) continue;
      const number = Number(normalize(current.textContent)) + 1;
      const control = [...pager.querySelectorAll(CONTROLS)].find(node =>
        visible(node) && !disabled(node, pager) && normalize(node.textContent) === String(number) && internalControl(node, product, url)
      );
      if (control) return { action: "next", control };
    }
    return { action: "waiting" };
  }

  const core = { LOCAL_ORIGIN, productPage, sameProduct, reviewListResponse, pageIssue, findSection, findEntry, emptyReviews, pagination };
  if (typeof module === "object" && module.exports) module.exports = core;
  else globalThis.LatAmReviews = core;
})();
