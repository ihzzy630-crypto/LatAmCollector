"use strict";

(() => {
  const core = globalThis.LatAmReviews;
  const STATE_KEY = "latamReviewJob";
  const ACTIVE = new Set(["opening", "running"]);
  let operations = Promise.resolve();

  async function readJob() {
    const job = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] || null;
    if (job && ACTIVE.has(job.status) && Date.now() - job.updatedAt > 150000) {
      const paused = { ...job, status: "paused", message: "采集页暂未响应，请查看页面后继续" };
      await writeJob(paused);
      await chrome.tabs.sendMessage(job.tabId, { type: "LATAM_REVIEW_CANCEL", run: job.run }).catch(() => {});
      await translateSaved(paused);
      return paused;
    }
    return job;
  }

  async function writeJob(job) {
    await chrome.storage.session.set({ [STATE_KEY]: job });
  }

  async function localFetch(path, options) {
    const response = await fetch(core.LOCAL_ORIGIN + path, { ...options, signal: AbortSignal.timeout(5000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "读取本地平台失败");
    return data;
  }

  function fromDashboard(sender) {
    try {
      return sender.frameId === 0 && new URL(sender.url).origin === core.LOCAL_ORIGIN && Number.isInteger(sender.tab?.id);
    } catch {
      return false;
    }
  }

  function summary(job, productId) {
    if (!job) return { status: "idle", pages: 0, count: 0 };
    if (job.productId !== productId) {
      return { status: ACTIVE.has(job.status) ? "busy" : "idle", pages: 0, count: 0 };
    }
    return {
      status: job.status, pages: job.pages, count: job.count, message: job.message,
      canOpen: Number.isInteger(job.tabId), run: job.run
    };
  }

  async function start(productId, sender) {
    const previous = await readJob();
    if (previous && ACTIVE.has(previous.status)) return summary(previous, productId);
    const product = await localFetch("/api/products/" + productId);
    if (!core.sameProduct(product.product_url, product)) throw new Error("这个商品缺少可识别的原商品链接");
    const oldTab = previous?.productId === productId && previous.status === "paused" && Number.isInteger(previous.tabId)
      ? await chrome.tabs.get(previous.tabId).catch(() => null) : null;
    if (oldTab && !core.sameProduct(oldTab.url, product)) {
      throw new Error("采集页还未回到该商品，请点「查看采集页」处理页面提示");
    }
    const tab = oldTab || await chrome.tabs.create({ url: "about:blank", active: false, openerTabId: sender.tab.id });
    const job = {
      run: crypto.randomUUID(), productId, product, tabId: tab.id,
      status: "opening", pages: 0, count: 0, message: "正在打开原商品并寻找评论区", updatedAt: Date.now()
    };
    await writeJob(job);
    try {
      if (oldTab) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: "LATAM_REVIEW_RUN", job });
        } catch {
          await chrome.tabs.reload(tab.id);
        }
      } else {
        await chrome.tabs.update(tab.id, { url: product.product_url });
      }
    } catch (error) {
      await writeJob({ ...job, status: "paused", message: "无法打开商品采集页" });
      throw error;
    }
    return summary(job, productId);
  }

  async function translateSaved(job) {
    if (!job.pages) return;
    try {
      await localFetch("/api/products/" + job.productId + "/review-translation", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
      });
    } catch {
      // The platform may have been closed. The review page can retry translation.
    }
  }

  async function dashboardAction(message, sender) {
    const { action, productId } = message;
    if (!fromDashboard(sender) || !Number.isSafeInteger(productId) || productId <= 0) throw new Error("无效的商品任务");
    if (action === "start") return start(productId, sender);
    const job = await readJob();
    if (action === "status") return summary(job, productId);
    if (!job || job.productId !== productId || !Number.isInteger(job.tabId)) return summary(null, productId);
    if (action === "open") {
      await chrome.tabs.update(job.tabId, { active: true });
    } else if (action === "stop" && ACTIVE.has(job.status)) {
      job.status = "paused";
      job.message = "已暂停，已入库评论可以查看";
      await writeJob(job);
      await chrome.tabs.sendMessage(job.tabId, { type: "LATAM_REVIEW_CANCEL", run: job.run }).catch(() => {});
      await translateSaved(job);
    }
    return summary(job, productId);
  }

  async function driverAction(message, sender) {
    const job = await readJob();
    if (!job || !ACTIVE.has(job.status) || sender.frameId !== 0 || job.tabId !== sender.tab?.id ||
        !core.sameProduct(sender.url, job.product)) return null;
    if (message.type === "LATAM_REVIEW_ATTACH") return job;
    if (message.run !== job.run) return null;
    const status = ["running", "done", "paused"].includes(message.status) ? message.status : "paused";
    const count = Number.isSafeInteger(message.count) ? Math.max(job.count, message.count) : job.count;
    const pages = Number.isSafeInteger(message.pages) ? Math.max(job.pages, message.pages) : job.pages;
    const saved = { ...job, status, pages, count, message: String(message.message || "").slice(0, 180), updatedAt: Date.now() };
    await writeJob(saved);
    if (!ACTIVE.has(saved.status)) await translateSaved(saved);
    return saved;
  }

  function serialize(operation) {
    const result = operations.then(operation);
    operations = result.catch(() => {});
    return result;
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    let operation;
    if (message?.type === "LATAM_REVIEW_DASHBOARD") operation = () => dashboardAction(message, sender);
    else if (["LATAM_REVIEW_ATTACH", "LATAM_REVIEW_PROGRESS"].includes(message?.type)) operation = () => driverAction(message, sender);
    else return false;
    serialize(operation).then(result => respond({ ok: true, result }), error =>
      respond({ ok: false, error: String(error.message || error) })
    );
    return true;
  });

  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (!change.url || change.url === "about:blank") return;
    serialize(async () => {
      const job = await readJob();
      if (tabId !== job?.tabId || !ACTIVE.has(job.status) || core.sameProduct(change.url, job.product)) return;
      const issue = core.pageIssue(change.url) || "采集标签页已离开当前商品";
      await writeJob({ ...job, status: "paused", message: issue + "，请查看采集页" });
      await translateSaved(job);
    });
  });

  chrome.tabs.onRemoved.addListener(tabId => {
    serialize(async () => {
      const job = await readJob();
      if (tabId !== job?.tabId) return;
      const active = ACTIVE.has(job.status);
      const state = active ? { status: "paused", message: "采集标签页已关闭" } : {};
      await writeJob({ ...job, ...state, tabId: null });
      if (active) await translateSaved(job);
    });
  });
})();
