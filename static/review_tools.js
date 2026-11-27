"use strict";

const reviewTools = (() => {
  const captureActive = new Set(["opening", "running"]);
  const translationActive = new Set(["queued", "translating"]);
  let product = "";
  let generation = 0;
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
        reject(new Error("请在已加载 v0.8.0 采集助手的 Chrome 中刷新本地平台"));
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

  async function refreshKeywords(id, stamp) {
    try {
      const data = await api(productApi(id, "keywords"));
      if (stamp !== generation) return;
      byId("review-keywords").innerHTML = data.keywords.map(term => `<div class="review-keyword">
        <strong>${escapeHtml(term.chinese || term.text)}</strong>
        ${term.chinese ? `<span class="muted small" lang="pt-BR">${escapeHtml(term.text)}</span>` : ""}
        <span class="muted small">${number(term.count)} 条提及${term.positive ? ` · 高分 ${number(term.positive)}` : ""}
        ${term.negative ? ` <span class="keyword-negative">· 低分 ${number(term.negative)}</span>` : ""}</span>
      </div>`).join("") || '<p class="muted small">暂无可统计的评论关键词</p>';
    } catch (error) {
      if (stamp === generation) byId("review-keywords").textContent = error.message;
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
      idle: "从原商品页找到评论，入库后自动继续下一页。",
      busy: "正在采集另一件商品，完成后可开始此任务。"
    };
    byId("review-job-status").textContent = detail + (state.message || descriptions[state.status] || "");
  }

  function renderTranslation(state) {
    const button = byId("review-translate");
    const text = byId("review-translation-status");
    const count = `中文译文 ${number(state.translated)} / ${number(state.total)} 条文字评论`;
    const busy = translationActive.has(state.state);
    button.disabled = startingTranslation || busy;
    button.hidden = !state.models_ready || busy || (state.translated === state.total && state.state !== "error");
    button.textContent = state.state === "error" ? "重试翻译" : "翻译已入库评论";
    const messages = {
      needs_models: "当前安装缺少离线翻译模型，请使用完整的 Windows 安装包。",
      queued: "已加入本机翻译队列",
      translating: count + " · 本机翻译中",
      ready: count,
      error: state.error || "本机翻译未完成"
    };
    text.textContent = messages[state.state] || count;
  }

  async function check(id, stamp) {
    const [capture, translated] = await Promise.allSettled([
      command("status", id), api(productApi(id, "translation"))
    ]);
    if (stamp !== generation) return;
    const nextJob = capture.status === "fulfilled" ? capture.value : {
      status: "unavailable", message: capture.reason.message
    };
    const nextTranslation = translated.status === "fulfilled" ? translated.value : null;
    const capturedMore = job && (nextJob.pages > job.pages ||
      (nextJob.run && nextJob.run !== job.run && nextJob.pages > 0));
    const captureFinished = job && captureActive.has(job.status) && ["paused", "done"].includes(nextJob.status);
    const translatedMore = nextTranslation && translation && nextTranslation.translated !== translation.translated;
    const translationFinished = nextTranslation && translation &&
      translationActive.has(translation.state) && !translationActive.has(nextTranslation.state);
    job = nextJob;
    translation = nextTranslation;
    renderJob(job);
    if (translation) renderTranslation(translation);
    else {
      byId("review-translate").hidden = true;
      byId("review-translation-status").textContent = translated.reason.message;
    }
    if (capturedMore || captureFinished || translatedMore || translationFinished) {
      loadReviews(reviews.page);
      if (capturedMore || captureFinished || translationFinished) refreshKeywords(id, stamp);
    }
    if (captureActive.has(job.status) || job.status === "busy" || translationActive.has(translation?.state) || captureFinished) {
      timer = setTimeout(() => check(id, stamp), 1800);
    }
  }

  function show(id) {
    clearTimeout(timer);
    if (product !== id) {
      const available = Boolean(id);
      byId("review-collection").hidden = !available;
      byId("review-keyword-panel").hidden = !available;
      byId("review-keywords").replaceChildren();
      byId("review-translate").hidden = true;
      byId("review-start").disabled = true;
      byId("review-stop").hidden = true;
      byId("review-open-tab").hidden = true;
      byId("review-job-status").textContent = "正在连接 Chrome 采集助手…";
      byId("review-translation-status").textContent = "正在检查中文翻译…";
      job = null;
      translation = null;
      product = id;
    }
    const stamp = ++generation;
    if (!id) return;
    refreshKeywords(id, stamp);
    check(id, stamp);
  }

  async function control(action) {
    if (!product || issuingCommand) return;
    const id = product;
    const stamp = generation;
    issuingCommand = true;
    renderJob(job || { status: "idle" });
    try {
      const result = await command(action, id);
      if (stamp !== generation) return;
      renderJob(result);
    } catch (error) {
      if (stamp === generation) toast(error.message);
    } finally {
      issuingCommand = false;
      if (product) {
        clearTimeout(timer);
        check(product, ++generation);
      }
    }
  }

  async function startTranslation() {
    if (!product || !translation || startingTranslation) return;
    const id = product;
    const stamp = generation;
    startingTranslation = true;
    renderTranslation(translation);
    try {
      const result = await api(productApi(id, "translation"), jsonOptions("POST", {}));
      if (stamp !== generation) return;
      renderTranslation(result);
    } catch (error) {
      if (stamp === generation) toast(error.message);
    } finally {
      startingTranslation = false;
      if (product) {
        clearTimeout(timer);
        check(product, ++generation);
      }
    }
  }

  document.getElementById("review-start").addEventListener("click", () => control("start"));
  document.getElementById("review-stop").addEventListener("click", () => control("stop"));
  document.getElementById("review-open-tab").addEventListener("click", () => control("open"));
  document.getElementById("review-translate").addEventListener("click", startTranslation);
  return { show };
})();
