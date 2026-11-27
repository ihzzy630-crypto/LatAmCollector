(() => {
  "use strict";

  const core = globalThis.LatAmReviews;
  const observer = globalThis.LatAmReviewObserver;
  const POLL_MS = 850;
  const PAGE_DELAY_MS = 2600;
  let active = null;

  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  function checkPage(run) {
    if (run.cancelled) throw new Error("已暂停");
    const issue = observer.issue || core.pageIssue(location.href, document.body?.innerText);
    if (issue) throw new Error(issue + "。请查看采集页");
    if (!core.sameProduct(location.href, run.product)) throw new Error("采集标签页已离开当前商品");
  }

  async function progress(run, status, message) {
    const response = await chrome.runtime.sendMessage({
      type: "LATAM_REVIEW_PROGRESS", run: run.run, status,
      pages: run.pages, count: run.seen.size, message
    });
    if (!response?.ok || !response.result) throw new Error("采集任务已停止");
  }

  async function locateSection(run) {
    const deadline = Date.now() + 45000;
    let opened = false;
    let scrolls = 0;
    do {
      checkPage(run);
      const section = core.findSection(document);
      if (section) {
        section.scrollIntoView({ block: "start" });
        return section;
      }
      const entry = opened ? null : core.findEntry(document, run.product, location.href, null);
      if (entry) {
        opened = true;
        entry.scrollIntoView({ block: "center" });
        entry.click();
      } else if (document.readyState !== "loading" && document.body && scrolls < 18) {
        window.scrollBy(0, Math.max(360, Math.floor(innerHeight * 0.7)));
        scrolls += 1;
      }
      await delay(POLL_MS);
    } while (Date.now() < deadline);
    throw new Error("未识别到评论区。请查看采集页是否有可用的评论区");
  }

  function matchingBatch(batch, product) {
    return batch && batch.platform === product.platform && batch.item_id === String(product.item_id) &&
      batch.shop_id === String(product.shop_id) && Array.isArray(batch.ids) && batch.ids.length > 0;
  }

  async function waitForBatch(run, after, initial) {
    const deadline = Date.now() + 24000;
    let repeated = false;
    let expanded = false;
    do {
      checkPage(run);
      const observations = observer.receipts.filter(receipt => receipt.sequence > after);
      for (const receipt of [...observations].reverse()) {
        if (receipt.phase !== "saved" || !matchingBatch(receipt.batch, run.product)) continue;
        if (receipt.batch.ids.some(id => !run.seen.has(id))) return receipt;
        repeated = true;
      }
      const section = core.findSection(document);
      if (initial && core.emptyReviews(section)) return null;
      // Some layouts put the full review list behind a separate in-page control.
      if (initial && !expanded && section && observations.every(receipt => receipt.phase !== "saving")) {
        const entry = core.findEntry(document, run.product, location.href, section);
        if (entry) {
          expanded = true;
          entry.scrollIntoView({ block: "center" });
          entry.click();
        }
      }
      await delay(POLL_MS);
    } while (Date.now() < deadline);
    const observations = observer.receipts.filter(receipt => receipt.sequence > after);
    if (observations.some(receipt => receipt.phase === "error")) throw new Error("评论未能保存到本地平台");
    if (repeated) throw new Error("翻页后返回了重复评论，已停在当前页");
    if (observations.some(receipt => receipt.phase === "unlinked")) throw new Error("评论响应缺少可确认的商品信息");
    throw new Error("等待评论入库超时，请查看采集页");
  }

  async function nextPage(run) {
    // Wait for the site's review controls to settle before reading the next page.
    await delay(PAGE_DELAY_MS);
    const deadline = Date.now() + 8500;
    do {
      checkPage(run);
      const next = core.pagination(core.findSection(document), run.product, location.href);
      if (next.action !== "waiting") return next;
      await delay(POLL_MS);
    } while (Date.now() < deadline);
    throw new Error("已保存当前页，暂未识别到评论下一页");
  }

  async function runJob(job) {
    if (!job || active?.run === job.run) return;
    if (active) active.cancelled = true;
    const run = { ...job, pages: 0, seen: new Set(), cancelled: false };
    active = run;
    try {
      await progress(run, "running", "正在寻找商品评论区");
      await locateSection(run);
      let receipt = await waitForBatch(run, 0, true);
      while (receipt) {
        for (const id of receipt.batch.ids) run.seen.add(id);
        run.pages += 1;
        await progress(run, "running", "评论已入库，正在检查下一页");
        if (receipt.batch.last_page === true) break;
        const next = await nextPage(run);
        if (next.action === "end") break;
        next.control.scrollIntoView({ block: "center" });
        checkPage(run);
        if (!next.control.isConnected) throw new Error("评论分页控件发生变化，请重试");
        const after = observer.sequence;
        next.control.click();
        receipt = await waitForBatch(run, after, false);
      }
      await progress(run, "done", run.pages ? "已采集到评论末页" : "该商品页面暂无评论");
    } catch (error) {
      if (!run.cancelled) {
        try { await progress(run, "paused", error.message || "评论采集已暂停"); } catch { /* The tab or job may have closed. */ }
      }
    } finally {
      if (active === run) active = null;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "LATAM_REVIEW_RUN") {
      respond({ ok: true });
      runJob(message.job);
    } else if (message?.type === "LATAM_REVIEW_CANCEL" && active?.run === message.run) {
      active.cancelled = true;
      respond({ ok: true });
    }
    return false;
  });

  if (core.productPage(location.href)) {
    chrome.runtime.sendMessage({ type: "LATAM_REVIEW_ATTACH" })
      .then(response => runJob(response?.result)).catch(() => {});
  }
})();
