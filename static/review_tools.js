"use strict";

const reviewTools = (() => {
  const captureActive = new Set(["opening", "running"]);
  const translationActive = new Set(["queued", "translating"]);
  let product = null;
  let generation = 0;
  let statusRequest = 0;
  let keywordRequest = 0;
  let timer;
  let job = null;
  let translation = null;
  let issuingCommand = false;
  let startingTranslation = false;

  function command(action, id) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const wait = setTimeout(() => {
        window.removeEventListener("message", receive);
        reject(new Error("请在已加载采集助手的 Chrome 中刷新本地平台"));
      }, action === "status" ? 2400 : 8500);
      function receive(event) {
        if (event.source !== window || event.origin !== location.origin ||
            event.data?.type !== "LATAM_LOCAL_REVIEW_RESULT" || event.data?.id !== requestId) return;
        clearTimeout(wait);
        window.removeEventListener("message", receive);
        if (event.data.ok) resolve(event.data.result);
        else reject(new Error(event.data.error || "无法连接 Chrome 采集助手"));
      }
      window.addEventListener("message", receive);
      window.postMessage({ type: "LATAM_LOCAL_REVIEW_COMMAND", id: requestId, action, productId: Number(id) }, location.origin);
    });
  }

  function productApi(id, suffix) {
    return "/api/products/" + id + "/review-" + suffix;
  }

  function keywordBubble(term) {
    const label = term.chinese || term.text;
    const count = number(term.count);
    const tooltip = [term.text, count + " 条提及", "高分 " + number(term.positive), "低分 " + number(term.negative)].join(" · ");
    return `<button class="keyword-bubble${term.negative > term.positive ? " low-rating" : ""}"
      type="button" data-keyword="${escapeHtml(term.key)}" aria-controls="review-rows"
      aria-label="${escapeHtml(label)}，${count} 条提及" aria-pressed="false" title="${escapeHtml(tooltip)}">
      <span lang="${term.chinese ? "zh-CN" : "pt-BR"}">${escapeHtml(label)}</span><span class="keyword-count" aria-hidden="true">${count}</span>
    </button>`;
  }

  async function refreshKeywords(id, stamp) {
    const request = ++keywordRequest;
    const panel = byId("review-keywords");
    try {
      const { keywords } = await api(id ? productApi(id, "keywords") : "/api/review-keywords");
      if (stamp !== generation || request !== keywordRequest) return;
      const focusedKey = panel.contains(document.activeElement) ? document.activeElement.dataset.keyword : "";
      panel.innerHTML = keywords.map(keywordBubble).join("") || '<p class="muted small">暂无可提取关键词的评论</p>';
      const selected = keywords.find(term => term.key === reviews.keyword?.key);
      if (selected) reviews.keyword.label = selected.chinese || selected.text;
      renderReviewKeywordSelection();
      if (focusedKey) {
        Array.from(panel.querySelectorAll("[data-keyword]")).find(button => button.dataset.keyword === focusedKey)
          ?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (stamp === generation && request === keywordRequest) panel.textContent = error.message;
    }
  }

  function renderJob(state) {
    const start = byId("review-start");
    const stop = byId("review-stop");
    const open = byId("review-open-tab");
    const running = captureActive.has(state.status);
    start.disabled = issuingCommand || running || ["busy", "unavailable"].includes(state.status);
    start.textContent = state.status === "done" ? "重新采集" : state.status === "paused" ? "继续采集" : "开始采集评论";
    stop.hidden = !running;
    stop.disabled = issuingCommand;
    open.hidden = !state.canOpen;
    open.disabled = issuingCommand;
    const detail = state.pages ? `已保存 ${number(state.pages)} 页 · 本轮读取 ${number(state.count)} 条。` : "";
    const descriptions = {
      idle: "从商品页读取评论，逐页保存到本地。",
      busy: "另一件商品正在采集，完成后可开始。"
    };
    byId("review-job-status").textContent = detail + (state.message || descriptions[state.status] || "");
  }

  function translationComplete(state) {
    return state?.total > 0 && state.translated === state.total && state.state !== "error";
  }

  function renderTranslation(state, error = "") {
    const button = byId("review-translate");
    const text = byId("review-translation-status");
    const progress = byId("review-translation-progress");
    const total = state?.total ?? 0;
    const busy = startingTranslation || translationActive.has(state?.state);
    const complete = translationComplete(state);
    button.disabled = busy || !total || (!state.models_ready && !complete);
    button.setAttribute("aria-busy", String(busy));
    progress.hidden = !total;
    progress.max = total || 1;
    progress.value = state?.translated ?? 0;
    text.dataset.state = error ? "error" : state?.state || "";

    const count = `已翻译 ${number(state?.translated)} / ${number(total)} 条`;
    if (error) text.textContent = error;
    else if (!product) text.textContent = "进入单个商品的评论页后可翻译。";
    else if (!state) text.textContent = "正在检查翻译状态…";
    else if (busy) text.textContent = count + (state.state === "queued" ? " · 等待翻译" : " · 本机翻译中");
    else if (complete) text.textContent = count + " · 已完成";
    else if (!state.models_ready) text.textContent = "当前安装缺少离线翻译模型。";
    else if (!total) text.textContent = "采集或导入文字评论后即可翻译。";
    else if (state.state === "error") text.textContent = state.error || "本机翻译未完成，可再次点击翻译。";
    else text.textContent = count + " · 本机翻译";
  }

  async function check(id, stamp) {
    clearTimeout(timer);
    const request = ++statusRequest;
    const isCurrent = () => stamp === generation && request === statusRequest;
    const previousJob = job;
    const previousTranslation = translation;
    await Promise.all([
      command("status", id).catch(error => ({ status: "unavailable", message: error.message })).then(result => {
        if (!isCurrent()) return;
        job = result;
        renderJob(job);
      }),
      api(productApi(id, "translation")).then(state => {
        if (!isCurrent()) return;
        translation = state;
        renderTranslation(translation);
      }, error => {
        if (!isCurrent()) return;
        translation = null;
        renderTranslation(null, error.message);
      })
    ]);
    if (!isCurrent()) return;
    const capturedMore = previousJob && (job.pages > previousJob.pages ||
      (job.run && job.run !== previousJob.run && job.pages > 0));
    const captureFinished = ["paused", "done"].includes(job.status) &&
      (capturedMore || captureActive.has(previousJob?.status));
    const translatedMore = translation && previousTranslation && translation.translated !== previousTranslation.translated;
    const translating = translationActive.has(translation?.state);
    const translationFinished = translation && translationActive.has(previousTranslation?.state) && !translating;
    if (capturedMore || captureFinished || translatedMore || translationFinished) loadReviews(reviews.page);
    if (capturedMore || captureFinished || translationFinished || (translatedMore && !translating)) refreshKeywords(id, stamp);
    if (captureActive.has(job.status) || job.status === "busy" || translating || captureFinished) {
      timer = setTimeout(() => check(id, stamp), 1800);
    }
  }

  function show(id) {
    clearTimeout(timer);
    const stamp = ++generation;
    if (product !== id) {
      product = id;
      job = null;
      translation = null;
      byId("review-collection").hidden = !id;
      byId("review-workflow").classList.toggle("scoped", Boolean(id));
      byId("review-keyword-scope").textContent = id ? "当前商品 · 已入库评论" : "全部已入库评论";
      byId("review-keywords").innerHTML = '<p class="muted small">正在统计关键词…</p>';
      byId("review-start").disabled = true;
      byId("review-stop").hidden = true;
      byId("review-open-tab").hidden = true;
      byId("review-job-status").textContent = "正在连接 Chrome 采集助手…";
      renderTranslation(null);
    }
    if (id === null) return;
    refreshKeywords(id, stamp);
    if (id) check(id, stamp);
  }

  async function control(action) {
    if (!product || issuingCommand) return;
    const id = product;
    const stamp = generation;
    issuingCommand = true;
    renderJob(job || { status: "idle" });
    try {
      const result = await command(action, id);
      if (stamp === generation) renderJob(result);
    } catch (error) {
      if (stamp === generation) toast(error.message);
    } finally {
      issuingCommand = false;
      if (product) check(product, generation);
    }
  }

  async function startTranslation() {
    if (!product || byId("review-translate").disabled) return;
    if (translationComplete(translation)) {
      byId("review-list-title").focus();
      return;
    }
    const id = product;
    const stamp = generation;
    startingTranslation = true;
    renderTranslation(translation);
    try {
      await api(productApi(id, "translation"), jsonOptions("POST", {}));
    } catch (error) {
      if (stamp === generation) toast(error.message);
    } finally {
      startingTranslation = false;
      if (product) check(product, generation);
    }
  }

  document.getElementById("review-start").addEventListener("click", () => control("start"));
  document.getElementById("review-stop").addEventListener("click", () => control("stop"));
  document.getElementById("review-open-tab").addEventListener("click", () => control("open"));
  document.getElementById("review-translate").addEventListener("click", startTranslation);
  return { show };
})();
