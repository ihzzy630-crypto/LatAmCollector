"use strict";

const byId = id => document.getElementById(id);
const number = value => Number(value || 0).toLocaleString("zh-CN");
const platformName = value => ({ shopee: "Shopee", shein: "SHEIN", mercadolivre: "Mercado Livre" })[value] || value;
const money = value => Number(value) > 0 ? "R$ " + Number(value).toFixed(2) : "—";
const shortDate = value => value ? String(value).slice(0, 10) : "—";
const dateTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short", hourCycle: "h23" });
const escapeCharacters = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => escapeCharacters[char]);
const titles = {
  dashboard: "经营仪表盘", products: "选品雷达", reviews: "评论洞察", tasks: "任务中心",
  sources: "采集助手", import: "数据导入", exports: "导出中心", logs: "运行日志"
};
const subtitles = {
  products: "Shopee 与 SHEIN 商品库",
  reviews: "本地已入库评论",
  sources: "巴西站 Chrome 采集助手"
};
const categorySource = { platform: "平台品类", title: "按商品标题分类", legacy: "历史品类", manual: "手动分类", unknown: "待整理" };

const products = { page: 1, pages: 1, items: [], request: 0, view: "cards", categoryGroups: [] };
const reviews = { page: 1, pages: 1, scope: "", request: 0 };
let currentPage = "dashboard";
let lastCapture = null;
let editingProduct = null;
let toastTimer;

try {
  if (localStorage.getItem("latam-product-view") === "table") products.view = "table";
} catch {
  // The view still works when the browser disallows local storage.
}

function webUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {
    // Imported data can contain invalid or relative URLs.
  }
  return "";
}

function localTimestamp(value) {
  if (!value) return "—";
  const sqliteTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
  const date = new Date(sqliteTimestamp ? value.replace(" ", "T") + "Z" : value);
  return Number.isNaN(date.getTime()) ? String(value) : dateTime.format(date);
}

async function api(url, options) {
  const response = await fetch(url, options).catch(() => { throw new Error("无法连接本地服务"); });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `请求失败（${response.status}）`);
  return data;
}

function jsonOptions(method, body) {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function toast(message) {
  const element = byId("toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 3700);
}

function emptyState(message, details = "", action = "") {
  return `<div class="empty"><strong>${escapeHtml(message)}</strong>${details ? `<p>${escapeHtml(details)}</p>` : ""}${action}</div>`;
}

function productImage(product, classes = "", target = webUrl(product.product_url)) {
  const src = webUrl(product.image_url);
  const image = src ? `<img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : "";
  const fallback = `<span class="image-fallback"${src ? " hidden" : ""}>${src ? "图片不可用" : "暂无图片"}</span>`;
  return target
    ? `<a class="product-image ${classes}" href="${escapeHtml(target)}" target="_blank" rel="noreferrer" aria-label="打开原商品 ${escapeHtml(product.title)}">${image}${fallback}</a>`
    : `<span class="product-image ${classes}">${image}${fallback}</span>`;
}

document.addEventListener("error", event => {
  const image = event.target;
  if (!image.matches?.(".product-image img")) return;
  image.hidden = true;
  image.nextElementSibling.hidden = false;
}, true);

function platformTag(platform) {
  const modifier = platform === "shopee" || platform === "shein" ? platform : "";
  return `<span class="platform-tag ${modifier}">${escapeHtml(platformName(platform) || "未知平台")}</span>`;
}

function barRow(label, value, maximum) {
  const width = maximum > 0 ? Math.min(100, value * 100 / maximum) : 0;
  return `<div class="bar-row">
    <span>${escapeHtml(label)}</span>
    <span class="bar" aria-hidden="true"><span class="bar-fill" style="width:${width}%"></span></span>
    <strong>${number(value)}</strong>
  </div>`;
}

function delta(value, prefix = "") {
  const amount = Number(value || 0);
  if (!amount) return '<span class="muted">—</span>';
  const text = prefix ? Math.abs(amount).toFixed(2) : number(Math.abs(amount));
  return `<span class="delta ${amount > 0 ? "up" : "down"}">${amount > 0 ? "+" : "−"}${prefix}${text}</span>`;
}

function updateSubtitle() {
  const element = byId("page-subtitle");
  const subtitle = currentPage === "dashboard"
    ? (lastCapture ? `最近采集 · ${localTimestamp(lastCapture)}` : "等待首次采集")
    : subtitles[currentPage];
  element.textContent = subtitle || "";
  element.hidden = !subtitle;
}

async function loadService() {
  const status = byId("service-status");
  try {
    const system = await api("/api/system");
    status.textContent = "本地服务运行中";
    status.dataset.state = "ready";
    byId("app-version").textContent = `v${system.version}`;
  } catch {
    status.textContent = "本地服务未连接";
    status.dataset.state = "offline";
  }
}

async function loadStats() {
  try {
    const stats = await api("/api/stats");
    for (const key of ["products", "qualified", "reviews", "favorites", "captures", "tasks"]) {
      byId("stat-" + key).textContent = number(stats[key]);
    }
    lastCapture = stats.last_capture;
    updateSubtitle();
  } catch (error) { toast(error.message); }
}

async function loadAnalytics() {
  try {
    const data = await api("/api/analytics");
    const categories = data.categories.filter(category => category.monthly_sales > 0);
    const maxSales = Math.max(0, ...categories.map(category => category.monthly_sales));
    byId("category-bars").innerHTML = categories.length
      ? categories.map(category => barRow(category.category, category.monthly_sales, maxSales)).join("")
      : emptyState("暂无月销量", "入库商品有月销量后，这里会显示按品类汇总的数据。");
    const quality = [
      ["exact", "精确月销量", data.sales_quality.exact_count],
      ["estimated", "估算档位", data.sales_quality.estimated_count],
      ["missing", "暂缺月销量", data.sales_quality.missing_count]
    ];
    const segments = quality.filter(([, , value]) => value > 0).map(([kind, , value]) =>
      `<span class="part quality-${kind}" style="flex-grow:${Number(value)}"></span>`).join("");
    byId("quality-box").innerHTML = `<div class="quality-strip" aria-hidden="true">${segments}</div>
      <div class="quality-rows">${quality.map(([kind, label, value]) => `<div class="quality-row"><span class="quality-dot quality-${kind}" aria-hidden="true"></span><span>${label}</span><strong>${number(value)}</strong></div>`).join("")}</div>
      <p class="muted small">估算值取「1千+」等公开档位的下限。</p>`;
    byId("mover-rows").innerHTML = data.movers.map(product => `<tr>
      <td><div class="table-product">${productImage(product, "thumb")}<b class="product-title" title="${escapeHtml(product.title)}">${escapeHtml(product.title)}</b></div></td>
      <td class="tabular">${product.monthly_sold > 0 ? number(product.monthly_sold) : "—"}</td>
      <td>${delta(product.monthly_sold_delta)}</td><td>${delta(product.historical_sold_delta)}</td>
      <td>${delta(product.price_delta, "R$ ")}</td><td class="muted small">${escapeHtml(localTimestamp(product.imported_at))}</td>
    </tr>`).join("") || '<tr><td class="empty" colspan="6">重复采集后，这里会显示销量或价格有变化的商品。</td></tr>';
  } catch (error) { toast(error.message); }
}

async function loadOptions() {
  try {
    const data = await api("/api/product-options");
    const region = byId("location");
    const selected = region.value;
    region.replaceChildren(new Option("全部地区", ""), ...data.locations.map(name => new Option(name, name)));
    region.value = data.locations.includes(selected) ? selected : "";
  } catch (error) { toast(error.message); }
}

function fillCategorySelect(select, selected, counts) {
  const options = [];
  if (counts) {
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    options.push(new Option(`全部分类（${number(total)}）`, ""));
  }
  for (const [group, labels] of products.categoryGroups) {
    const section = document.createElement("optgroup");
    section.label = group;
    for (const label of labels) {
      section.append(new Option(counts ? `${label}（${number(counts[label])}）` : label, label));
    }
    options.push(section);
  }
  select.replaceChildren(...options);
  if (products.categoryGroups.some(([, labels]) => labels.includes(selected))) select.value = selected;
}

function updateSalesLabel() {
  byId("min-sales-label").textContent = byId("sales-metric").value === "historical" ? "最低累计销量" : "最低月销量";
}

function applyPlatformPreset() {
  const platform = byId("platform").value;
  byId("category").value = "";
  if (platform === "shein" || platform === "shopee") {
    const metric = platform === "shein" ? "historical" : "monthly";
    byId("sales-metric").value = metric;
    byId("sort-by").value = metric + "_sold";
    byId("min-sales").value = platform === "shein" ? "0" : "1000";
  }
  updateSalesLabel();
  loadProducts();
}

function readField(id) {
  const input = byId(id);
  return input.type === "number" && input.value ? String(input.valueAsNumber) : input.value.trim();
}

function productParams(page) {
  const filterIds = ["q", "platform", "category", "min-price", "max-price", "sales-metric", "sales-quality", "min-sales",
    "max-sales", "min-growth", "min-rating", "min-reviews", "location", "favorite", "image-state", "sort-by"];
  const params = new URLSearchParams({ page, page_size: 50 });
  for (const id of filterIds) params.set(id.replaceAll("-", "_"), readField(id));
  params.set("years", [...document.querySelectorAll(".product-year:checked")].map(box => box.value).join(","));
  return params;
}

function clearProductFilters() {
  byId("product-filter").reset();
  byId("min-price").value = "";
  byId("min-sales").value = "";
  byId("sort-by").value = "monthly_sold";
  updateSalesLabel();
  loadProducts();
}

function salesMarkup(product, key, showText = false) {
  const value = Number(product[key + "_sold"] || 0);
  const text = product[key + "_sold_text"];
  const quality = product[key + "_sold_quality"];
  if (quality === "未知" || (!value && !text)) {
    const label = key === "monthly" && product.platform === "shein" ? "未公开" : "暂无数据";
    return `<span class="sale-number muted small">${label}</span>`;
  }
  const badge = quality === "估算" ? '<span class="pill warn">估算</span>' : "";
  const detail = showText && text ? `<span class="sale-detail">${escapeHtml(text)}</span>` : "";
  return `<span class="sale-number"><strong>${number(value)}</strong>${badge}</span>${detail}`;
}

function favoriteButton(product) {
  const label = product.is_favorite ? "取消收藏" : "收藏商品";
  return `<button type="button" class="favorite-button" data-product="${product.id}" data-product-action="favorite"
      aria-label="${label}" title="${label}" aria-pressed="${Boolean(product.is_favorite)}">${product.is_favorite ? "★" : "☆"}</button>`;
}

function productReviewLink(productId) {
  return `?page=reviews&product=${encodeURIComponent(productId)}`;
}

function productActions(product) {
  const url = webUrl(product.product_url);
  return `<div class="product-main-actions">
    <a class="btn soft small" href="${escapeHtml(productReviewLink(product.id))}" data-route>查看评论</a>
    ${url ? `<a class="text-link small" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">打开原页 <span aria-hidden="true">↗</span></a>` : ""}
  </div>
  <div class="product-edits">
    <button type="button" class="text-button" data-product="${product.id}" data-product-action="category">改品类</button>
    <button type="button" class="text-button" data-product="${product.id}" data-product-action="note">备注</button>
  </div>`;
}

function productCategory(product) {
  const origin = categorySource[product.category_origin] || categorySource.unknown;
  return `<span class="pill" title="${escapeHtml(origin)}">${escapeHtml(product.category || "未分类")}</span>`;
}

function platformRating(product) {
  return product.rating > 0 ? `<span class="star-value" title="平台商品评分">★ ${Number(product.rating).toFixed(2)}</span>` : '<span class="muted small">暂无评分</span>';
}

function productCard(product) {
  const title = escapeHtml(product.title);
  const shop = escapeHtml(product.shop_name || "店铺未知");
  return `<article class="panel product-card">
    <div class="image-stage">
      ${productImage(product)}
      <div class="image-overlay">${platformTag(product.platform)}${favoriteButton(product)}</div>
    </div>
    <div class="card-content">
      <h3 class="product-title" title="${title}" lang="pt-BR">${title}</h3>
      <p class="shop-line" title="${shop}">${shop}</p>
      <div class="card-meta">${productCategory(product)}${product.created_at ? `<span>${escapeHtml(shortDate(product.created_at))} 上架</span>` : ""}</div>
      <div class="card-price-line"><span class="price">${money(product.price)}</span>${platformRating(product)}</div>
      <div class="card-sales">
        <div><span class="sale-title">月销量</span>${salesMarkup(product, "monthly")}</div>
        <div><span class="sale-title">累计销量</span>${salesMarkup(product, "historical")}</div>
      </div>
      ${product.note ? `<p class="card-note" title="${escapeHtml(product.note)}">备注 · ${escapeHtml(product.note)}</p>` : ""}
      ${productActions(product)}
    </div>
  </article>`;
}

function productRow(product, metric) {
  const shop = escapeHtml(product.shop_name || "店铺未知");
  return `<tr>
    <td><div class="table-product">${productImage(product, "thumb")}
      <div>
        <b class="product-title" lang="pt-BR" title="${escapeHtml(product.title)}">${escapeHtml(product.title)}</b>
        <div class="table-meta">${platformTag(product.platform)}<span class="shop-line" title="${shop}">${shop}</span></div>
        <span class="cell-detail">采集 ${number(product.capture_count)} 次</span>
        ${product.note ? `<span class="cell-detail">备注 · ${escapeHtml(product.note)}</span>` : ""}
      </div>
    </div></td>
    <td>${productCategory(product)}<span class="cell-detail">${escapeHtml(shortDate(product.created_at))}</span></td>
    <td><span class="price">${money(product.price)}</span><span class="cell-detail">${delta(product.price_delta, "R$ ")}</span></td>
    <td>${salesMarkup(product, "monthly", true)}</td><td>${salesMarkup(product, "historical", true)}</td>
    <td>${delta(product[metric + "_sold_delta"])}</td>
    <td><strong class="score">${escapeHtml(product.opportunity_score)}</strong><span class="cell-detail">${escapeHtml(product.lifecycle)}</span></td>
    <td>${platformRating(product)}<span class="cell-detail">${number(product.review_count)} 条</span></td>
    <td>${productActions(product)}<div class="product-edits">${favoriteButton(product)}</div></td>
  </tr>`;
}

function renderProducts() {
  const showCards = products.view === "cards" && products.items.length > 0;
  const showTable = products.view === "table" && products.items.length > 0;
  byId("product-cards").hidden = !showCards;
  byId("product-table").hidden = !showTable;
  byId("product-cards").innerHTML = showCards ? products.items.map(productCard).join("") : "";
  byId("product-rows").innerHTML = showTable ? products.items.map(product => productRow(product, products.metric)).join("") : "";
  document.querySelectorAll("[data-view]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.view === products.view));
  });
}

function updatePager(prefix, data) {
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  byId(prefix + "-pager").hidden = !data.total;
  byId(prefix + "-page").textContent = `${data.page} / ${pages} 页`;
  byId(prefix + "-prev").disabled = data.page <= 1;
  byId(prefix + "-next").disabled = data.page >= pages;
  const from = (data.page - 1) * data.page_size + 1;
  const to = Math.min(data.page * data.page_size, data.total);
  byId(prefix + "-range").textContent = `显示 ${number(from)}–${number(to)} 条`;
  return pages;
}

async function loadProducts(page = 1) {
  if (!byId("product-filter").reportValidity()) return;
  const request = ++products.request;
  byId("product-total").textContent = "正在读取…";
  const params = productParams(Math.max(1, Math.min(page, products.pages)));
  try {
    const data = await api("/api/products?" + params);
    if (request !== products.request) return;
    products.page = data.page;
    products.pages = updatePager("product", data);
    products.items = data.items;
    products.metric = params.get("sales_metric");
    products.categoryGroups = Array.isArray(data.category_groups) ? data.category_groups : [];
    const category = byId("category");
    fillCategorySelect(category, category.value, data.category_counts || {});
    byId("product-total").textContent = `${number(data.total)} 件商品`;
    byId("product-empty").hidden = data.items.length > 0;
    if (!data.items.length) {
      byId("product-empty").innerHTML = emptyState("没有符合条件的商品", "可扩大价格、销量或品类范围。", '<button type="button" class="btn secondary" data-clear-products>清空筛选</button>');
    }
    renderProducts();
  } catch (error) {
    if (request !== products.request) return;
    byId("product-total").textContent = "读取失败";
    products.items = [];
    renderProducts();
    byId("product-pager").hidden = true;
    byId("product-empty").hidden = false;
    byId("product-empty").innerHTML = emptyState(error.message, "可以点击页面右上角重新读取。");
  }
}

async function toggleFavorite(button, product) {
  button.disabled = true;
  try {
    await api("/api/products/" + product.id, jsonOptions("PATCH", { is_favorite: !product.is_favorite }));
    await Promise.all([loadProducts(products.page), loadStats()]);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

function editProduct(product, field) {
  editingProduct = { id: product.id, field };
  const category = field === "category";
  byId("editor-title").textContent = category ? "修改品类" : "选品备注";
  byId("editor-product").textContent = product.title;
  byId("edit-category-field").hidden = !category;
  byId("edit-note-field").hidden = category;
  byId("reset-category").hidden = !category;
  byId("editor-error").hidden = true;
  if (category) fillCategorySelect(byId("edit-category"), product.category);
  else byId("edit-note").value = product.note || "";
  byId("product-editor").showModal();
  byId(category ? "edit-category" : "edit-note").focus();
}

function setDialogBusy(dialog, busy) {
  dialog.dataset.busy = String(busy);
  dialog.querySelectorAll("button").forEach(button => { button.disabled = busy; });
}

async function saveProductEdit(resetCategory = false) {
  const dialog = byId("product-editor");
  if (!editingProduct || dialog.dataset.busy === "true") return;
  const { id, field } = editingProduct;
  const isCategory = field === "category";
  const value = isCategory ? (resetCategory ? null : byId("edit-category").value) : byId("edit-note").value;
  const error = byId("editor-error");
  error.hidden = true;
  setDialogBusy(dialog, true);
  try {
    await api("/api/products/" + id, jsonOptions("PATCH", { [field]: value }));
    dialog.close();
    toast(resetCategory ? "已恢复自动分类" : isCategory ? "品类已保存" : "备注已保存");
    loadProducts(products.page);
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  } finally {
    setDialogBusy(dialog, false);
  }
}

function resetReviewScope(scope) {
  if (scope === reviews.scope) return;
  reviews.scope = scope;
  reviews.page = 1;
  reviews.pages = 1;
  byId("review-filter").reset();
  byId("review-platform-field").hidden = Boolean(scope);
  byId("review-item-field").hidden = Boolean(scope);
  byId("review-platform-field").parentElement.classList.toggle("scoped", Boolean(scope));
  byId("review-product").hidden = !scope;
  byId("review-pager").hidden = true;
  for (const [id, text] of [["review-rows", "正在读取评论…"], ["review-rating", "正在读取评分…"], ["review-insights", "正在读取评论主题…"]]) {
    byId(id).innerHTML = `<p class="empty">${text}</p>`;
  }
}

async function loadReviewProduct() {
  const productId = reviews.scope;
  if (!productId) return;
  const panel = byId("review-product");
  const allReviews = '<a class="btn secondary small" href="?page=reviews" data-route>全部评论</a>';
  panel.innerHTML = `<span class="muted">正在读取商品…</span>${allReviews}`;
  try {
    const product = await api("/api/products/" + productId);
    if (productId !== reviews.scope) return;
    const url = webUrl(product.product_url);
    panel.innerHTML = `<div class="review-product-main">
      ${productImage(product, "thumb context-thumb")}
      <div class="review-product-text">
        <div class="review-context-details">${platformTag(product.platform)}<span class="muted small">商品 ID ${escapeHtml(product.item_id)}</span></div>
        <h2 lang="pt-BR">${escapeHtml(product.title)}</h2>
        ${product.shop_name ? `<span class="muted small">${escapeHtml(product.shop_name)}</span>` : ""}
      </div>
    </div>
    <div class="actions">${allReviews}${url ? `<a class="btn small" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">打开原商品 <span aria-hidden="true">↗</span></a>` : ""}</div>`;
  } catch (error) {
    if (productId === reviews.scope) panel.innerHTML = `<span class="muted">${escapeHtml(error.message)}</span>${allReviews}`;
  }
}

function reviewParams(page) {
  const from = readField("review-year-from");
  const to = readField("review-year-to");
  const params = new URLSearchParams({
    year_from: from || "1",
    year_to: to || "9999",
    all_years: !from && !to ? "true" : "false",
    sentiment: readField("review-sentiment"),
    topic: readField("review-topic"),
    has_media: readField("review-media"),
    q: readField("review-q"),
    page,
    page_size: "30"
  });
  if (reviews.scope) params.set("product_id", reviews.scope);
  else {
    params.set("platform", readField("review-platform"));
    params.set("item_id", readField("review-item"));
  }
  return params;
}

function stars(rating) {
  const value = Math.min(5, Math.max(0, Math.round(rating * 10) / 10));
  return `<span class="stars" aria-label="${value} 星" role="img"><span class="star-track" aria-hidden="true">★★★★★<span class="star-fill" style="width:${value * 20}%">★★★★★</span></span></span>`;
}

function renderReviewInsights(data) {
  const counts = [5, 4, 3, 2, 1].map(star => [star, Number(data.stars[star] || 0)]);
  const rated = counts.reduce((sum, [, count]) => sum + count, 0);
  const average = rated ? counts.reduce((sum, [star, count]) => sum + star * count, 0) / rated : 0;
  const ratingBars = counts.map(([star, count]) => barRow(star + " 星", count, rated)).join("");
  const stats = [["已入库", data.total], ["有文字", data.with_text], ["有图片或视频", data.with_media]];
  byId("review-rating").innerHTML = `<div class="rating-grid">
    <div class="rating-hero"><strong class="tabular">${rated ? average.toFixed(1) : "—"}</strong>
      ${rated ? stars(average) : ""}
      <span class="muted small">${rated ? `${number(rated)} 条有星级` : "暂无星级"}</span>
    </div>
    <div class="rating-bars">${ratingBars}</div>
  </div>
  <div class="rating-stats">${stats.map(([label, count]) => `<div><span>${label}</span><strong>${number(count)}</strong></div>`).join("")}</div>`;
  const topics = Object.entries(data.topics).sort((a, b) => b[1] - a[1]);
  byId("review-insights").innerHTML = topics.some(([, count]) => count > 0)
    ? `<div class="review-topics">${topics.map(([topic, count]) => barRow(topic, count, topics[0][1])).join("")}</div>`
    : emptyState("暂无主题记录", "含有相关葡语关键词的评论会显示在这里。");
}

function reviewItem(review) {
  const sentimentColor = { "正向": "good", "中性": "warn", "负向": "bad" }[review.sentiment] || "";
  const date = review.review_time ? escapeHtml(shortDate(review.review_time)) : "";
  const name = escapeHtml(review.title || (review.item_id ? `商品 ${review.item_id}` : "商品未关联"));
  const product = review.product_id ? `<a class="text-link" data-route href="${escapeHtml(productReviewLink(review.product_id))}" title="${name}">${name}</a>` : `<span>${name}</span>`;
  return `<article class="review-item">
    <div class="review-item-top">
      <div>${review.rating > 0 ? stars(review.rating) : ""}<span class="pill ${sentimentColor}">${escapeHtml(review.sentiment)}</span></div>
      ${date ? `<time class="muted small tabular" datetime="${date}">${date}</time>` : ""}
    </div>
    <p class="review-body"${review.comment?.trim() ? ' lang="pt-BR"' : ""}>${escapeHtml(review.comment?.trim() ? review.comment : "（无文字）")}</p>
    <div class="review-meta">
      ${review.topics.map(topic => `<span class="pill">${escapeHtml(topic)}</span>`).join("")}
      ${review.variant ? `<span class="muted small">规格 · ${escapeHtml(review.variant)}</span>` : ""}
      ${review.media_count > 0 ? `<span class="muted small">图片 / 视频 ${number(review.media_count)}</span>` : ""}
      ${review.likes > 0 ? `<span class="muted small">有帮助 ${number(review.likes)}</span>` : ""}
    </div>
    ${reviews.scope ? "" : `<div class="review-item-caption muted small">${product}${platformTag(review.platform)}</div>`}
  </article>`;
}

async function loadReviews(page = 1) {
  if (!byId("review-filter").reportValidity()) return;
  const from = readField("review-year-from");
  const to = readField("review-year-to");
  if (from && to && Number(from) > Number(to)) {
    toast("结束年份需要大于或等于起始年份");
    return;
  }
  const request = ++reviews.request;
  byId("review-total").textContent = "正在读取…";
  const params = reviewParams(Math.max(1, Math.min(page, reviews.pages)));
  const insights = new URLSearchParams(params);
  insights.delete("page");
  insights.delete("page_size");
  try {
    const [data, summary] = await Promise.all([api("/api/reviews?" + params), api("/api/review-insights?" + insights)]);
    if (request !== reviews.request) return;
    reviews.page = data.page;
    reviews.pages = updatePager("review", data);
    byId("review-total").textContent = `${number(data.total)} 条评论`;
    byId("review-rows").innerHTML = data.items.length ? data.items.map(reviewItem).join("")
      : emptyState("没有符合条件的评论", reviews.scope ? "可清空筛选，或前往原商品查看评论。" : "可清空筛选，或从数据导入页导入评论 JSON。");
    renderReviewInsights(summary);
  } catch (error) {
    if (request !== reviews.request) return;
    byId("review-total").textContent = "读取失败";
    byId("review-rows").innerHTML = emptyState(error.message);
    byId("review-pager").hidden = true;
    byId("review-rating").innerHTML = '<p class="empty">评分读取失败</p>';
    byId("review-insights").innerHTML = '<p class="empty">评论主题读取失败</p>';
  }
}

async function loadTasks() {
  try {
    const items = await api("/api/tasks");
    byId("task-rows").innerHTML = items.map(task => `<tr>
      <td>${escapeHtml(task.name)}</td><td>${platformTag(task.platform)}</td><td>${escapeHtml(task.task_type)}</td>
      <td>${escapeHtml(task.schedule)}</td><td><span class="pill">${escapeHtml(task.status)}</span></td>
      <td>${escapeHtml(localTimestamp(task.created_at))}</td>
    </tr>`).join("") || '<tr><td class="empty" colspan="6">暂无任务计划</td></tr>';
  } catch (error) { toast(error.message); }
}

async function saveTask(event) {
  event.preventDefault();
  const dialog = byId("task-modal");
  const error = byId("task-error");
  if (dialog.dataset.busy === "true") return;
  const task = {
    name: readField("task-name"), platform: readField("task-platform"),
    task_type: readField("task-type"), schedule: readField("task-schedule")
  };
  error.hidden = true;
  setDialogBusy(dialog, true);
  try {
    await api("/api/tasks", jsonOptions("POST", task));
    dialog.close();
    toast("任务计划已保存");
    loadTasks();
    loadStats();
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  } finally {
    setDialogBusy(dialog, false);
  }
}

async function loadCaptureStatus() {
  const status = byId("capture-status");
  try {
    const { totals, last } = await api("/api/capture-status");
    status.innerHTML = `<div class="rating-stats capture-totals">
      <div><span>捕获响应</span><strong>${number(totals.events)}</strong></div>
      <div><span>识别商品</span><strong>${number(totals.products)} 条次</strong></div>
      <div><span>识别评论</span><strong>${number(totals.reviews)} 条次</strong></div>
    </div><p class="muted small">${last
      ? `最近采集 · ${escapeHtml(localTimestamp(last.captured_at))} · ${escapeHtml(last.source_type)} · 新增 ${number(last.new_product_count)} 件商品、${number(last.new_review_count)} 条评论`
      : "暂无采集记录"}</p>`;
  } catch (error) { status.textContent = error.message; }
}

async function loadLogs() {
  try {
    const items = await api("/api/logs");
    byId("log-rows").innerHTML = items.map(log => `<div class="log">
      <span class="muted small tabular">${escapeHtml(localTimestamp(log.created_at))}</span>
      <div><span class="pill">${escapeHtml(log.level)}</span> <b>${escapeHtml(log.source)}</b> · ${escapeHtml(log.message)}</div>
    </div>`).join("") || emptyState("暂无运行日志");
  } catch (error) { toast(error.message); }
}

async function importFile(input) {
  const file = input.files[0];
  if (!file) return;
  const state = byId("import-state");
  input.disabled = true;
  state.hidden = false;
  state.textContent = "正在导入 " + file.name + "…";
  try {
    const body = await file.text();
    const data = await api("/api/import/json", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    state.textContent = data.message;
    loadStats();
    loadOptions();
  } catch (error) {
    state.textContent = "导入失败 · " + error.message;
  } finally {
    input.disabled = false;
    input.value = "";
  }
}

const pageLoaders = {
  dashboard: loadAnalytics,
  products: () => loadProducts(products.page),
  reviews: () => { loadReviewProduct(); loadReviews(reviews.page); },
  tasks: loadTasks,
  sources: loadCaptureStatus,
  logs: loadLogs
};

function renderRoute({ focus = false } = {}) {
  const params = new URLSearchParams(location.search);
  const requested = params.get("page");
  currentPage = Object.hasOwn(titles, requested) ? requested : "dashboard";
  if (currentPage === "reviews") {
    const scope = params.get("product") ?? "";
    resetReviewScope(/^[1-9]\d{0,17}$/.test(scope) ? scope : "");
  }
  document.querySelectorAll(".page").forEach(section => { section.hidden = section.id !== currentPage; });
  document.querySelectorAll(".navigation [data-page]").forEach(link => {
    if (link.dataset.page === currentPage) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const title = byId("page-title");
  title.textContent = titles[currentPage];
  document.title = titles[currentPage] + " · LatAm Collector";
  byId("refresh-page").hidden = !pageLoaders[currentPage];
  updateSubtitle();
  pageLoaders[currentPage]?.();
  if (focus) {
    title.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

function setDisclosure(button, expanded) {
  button.setAttribute("aria-expanded", String(expanded));
  byId(button.dataset.disclosure).hidden = !expanded;
}

document.addEventListener("click", event => {
  const link = event.target.closest("a[data-route]");
  if (link && !event.defaultPrevented && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    if (location.href !== link.href) history.pushState(null, "", link.href);
    renderRoute({ focus: true });
    return;
  }
  const button = event.target.closest("button");
  if (!button) return;
  const { disclosure, view, product: id, productAction, close, clearProducts } = button.dataset;
  if (disclosure) setDisclosure(button, button.getAttribute("aria-expanded") !== "true");
  if (view && view !== products.view) {
    products.view = view;
    try { localStorage.setItem("latam-product-view", view); } catch { /* Keep the in-memory setting. */ }
    renderProducts();
  }
  if (close) byId(close).close();
  if (clearProducts !== undefined) clearProductFilters();
  if (!id) return;
  const product = products.items.find(item => String(item.id) === id);
  if (!product) return;
  if (productAction === "favorite") toggleFavorite(button, product);
  else editProduct(product, productAction);
});

window.addEventListener("popstate", () => renderRoute());
byId("refresh-page").addEventListener("click", () => {
  loadService();
  loadStats();
  pageLoaders[currentPage]?.();
});
byId("product-filter").addEventListener("submit", event => { event.preventDefault(); loadProducts(); });
byId("review-filter").addEventListener("submit", event => { event.preventDefault(); loadReviews(); });
for (const form of ["product-filter", "review-filter"]) {
  byId(form).addEventListener("invalid", event => {
    const content = event.target.closest(".filter-advanced[hidden]");
    if (content) setDisclosure(byId(form).querySelector("[data-disclosure]"), true);
  }, true);
}
byId("clear-product-filters").addEventListener("click", clearProductFilters);
byId("clear-review-filters").addEventListener("click", () => { byId("review-filter").reset(); loadReviews(); });
byId("sales-metric").addEventListener("change", updateSalesLabel);
byId("platform").addEventListener("change", applyPlatformPreset);
byId("sort-by").addEventListener("change", () => loadProducts());
for (const [prefix, state, load] of [["product", products, loadProducts], ["review", reviews, loadReviews]]) {
  byId(prefix + "-prev").addEventListener("click", () => load(state.page - 1));
  byId(prefix + "-next").addEventListener("click", () => load(state.page + 1));
}

byId("product-editor-form").addEventListener("submit", event => { event.preventDefault(); saveProductEdit(); });
byId("reset-category").addEventListener("click", () => saveProductEdit(true));
byId("new-task").addEventListener("click", () => {
  byId("task-form").reset();
  byId("task-error").hidden = true;
  byId("task-modal").showModal();
});
byId("task-form").addEventListener("submit", saveTask);
document.querySelectorAll("dialog").forEach(dialog => dialog.addEventListener("cancel", event => {
  if (dialog.dataset.busy === "true") event.preventDefault();
}));
byId("json-file").addEventListener("change", event => importFile(event.target));

loadService();
loadStats();
loadOptions();
renderRoute();
