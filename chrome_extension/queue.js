"use strict";

const core = globalThis.LatAmQueue;
const keywordGroups = globalThis.LatAmShopeeKeywords;
const taskId = new URLSearchParams(location.search).get("current") || "";
const currentMode = /^[a-f0-9-]{36}$/i.test(taskId);
const STATE_KEY = currentMode ? core.CURRENT_TASK_PREFIX + taskId : "latamShopeeQueueV1";
const stateStore = currentMode ? chrome.storage.session : chrome.storage.local;
const WORKER_KEY = "latamShopeeQueueTab";
const LOCK = "latam-shopee-queue";
const LOCAL_SYSTEM = "http://127.0.0.1:8765/api/system";
const ENTRY_LABELS = { queued: "等待", running: "采集中", paused: "已暂停", done: "已结束" };
const el = (id) => document.getElementById(id);
const setText = (id, text) => { el(id).textContent = text; };
const number = new Intl.NumberFormat("zh-CN");

let state = { status: "idle", message: "", entries: [], currentKey: "", pageLimit: 4, includeChildren: true, needsReview: false };
let controller = null;
let choices = [];
let editing = false;
let discovering = false;

async function load() {
  const data = await stateStore.get(STATE_KEY);
  if (data[STATE_KEY]) state = data[STATE_KEY];
}

function hasPending() {
  return state.entries.some((entry) => entry.status !== "done");
}

function pageLimit(value) {
  return Math.max(1, Math.min(50, Math.trunc(Number(value)) || 4));
}

function render() {
  const running = state.status === "running" || controller !== null;
  const locked = running || editing;
  const current = state.entries.find((entry) => entry.key === state.currentKey);
  const done = state.entries.filter((entry) => entry.status === "done").length;
  const saved = state.entries.reduce((sum, entry) => sum + entry.saved, 0);
  const added = state.entries.reduce((sum, entry) => sum + entry.added, 0);
  for (const input of document.querySelectorAll("[data-edit],#category-choices input")) input.disabled = locked;
  el("discover").disabled = locked || discovering;
  el("add-categories").disabled = locked || !choices.length;
  el("clear-done").disabled = locked || done === 0;
  el("start").disabled = locked || !hasPending();
  el("start").textContent = state.status === "paused" && current ? "继续采集" : "一键开始";
  el("pause").disabled = !controller || controller.signal.aborted;
  el("show-worker").disabled = currentMode ? !state.entries.length : !current && !state.entries.some((entry) => entry.pages.length);
  if (document.activeElement !== el("page-limit")) el("page-limit").value = state.pageLimit;
  el("include-children").checked = state.includeChildren;
  setText("queue-stats", `已结束 ${done}/${state.entries.length} 个入口 · 入库 ${number.format(saved)} 条次 · 新增 ${number.format(added)} 件`);
  el("queue-status").dataset.status = state.status;
  const message = running && current ? `${current.label} · ${current.message}` : state.message;
  setText("queue-status", message || (currentMode ? "等待当前列表加载。" : "添加分类或搜索词后即可开始。"));

  const rows = document.createDocumentFragment();
  for (const entry of state.entries) {
    const row = document.createElement("tr");
    const listing = row.insertCell();
    const tag = document.createElement("span");
    tag.className = "entry-kind";
    tag.textContent = entry.kind === "category" ? "分类" : "搜索";
    const link = document.createElement("a");
    link.href = entry.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = entry.label;
    listing.append(tag, link);
    const status = row.insertCell();
    status.textContent = ENTRY_LABELS[entry.status];
    if (entry.message) {
      const detail = document.createElement("span");
      detail.className = "entry-message";
      detail.textContent = entry.message;
      status.append(detail);
    }
    row.insertCell().textContent = String(entry.pages.length);
    row.insertCell().textContent = number.format(entry.saved);
    row.insertCell().textContent = number.format(entry.added);
    if (!currentMode) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "quiet";
      remove.textContent = "移除";
      remove.dataset.remove = entry.key;
      remove.setAttribute("aria-label", `移除 ${entry.label}`);
      remove.disabled = locked || (state.needsReview && entry.key === state.currentKey);
      row.insertCell().append(remove);
    }
    rows.append(row);
  }
  if (!state.entries.length) {
    const row = document.createElement("tr");
    const cell = row.insertCell();
    cell.colSpan = currentMode ? 5 : 6;
    cell.className = "empty";
    cell.textContent = "队列为空";
    rows.append(row);
  }
  el("entries").replaceChildren(rows);
}

async function save() {
  await stateStore.set({ [STATE_KEY]: state });
  render();
}

function markInterrupted() {
  if (state.status !== "running") return;
  const current = state.entries.find((entry) => entry.key === state.currentKey);
  state.status = "paused";
  state.message = "上次采集已中断，可继续当前入口。";
  if (current) {
    current.status = "paused";
    current.message = state.message;
  }
}

async function exclusive(work) {
  try {
    await navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) return setText(currentMode ? "queue-status" : "edit-feedback", "另一个采集窗口正在运行。请暂停后再开始。");
      editing = true;
      try {
        await load();
        markInterrupted();
        await work();
      } finally {
        editing = false;
        render();
      }
    });
  } catch (error) {
    setText(currentMode ? "queue-status" : "edit-feedback", error?.message || "无法更新采集队列");
  }
}

function addEntries(entries) {
  const existing = new Set(state.entries.map((entry) => entry.key));
  let count = 0;
  for (const entry of entries) {
    if (!entry || existing.has(entry.key)) continue;
    existing.add(entry.key);
    state.entries.push(core.queuedEntry(entry));
    count += 1;
  }
  return count;
}

function enqueue(entries, ignored = 0) {
  return exclusive(async () => {
    const count = addEntries(entries);
    if (count && state.status === "done") {
      state.status = "idle";
      state.message = "";
    }
    await save();
    const repeats = entries.length - count;
    setText("edit-feedback", `已添加 ${count} 个入口${repeats ? `，重复 ${repeats} 个` : ""}${ignored ? `，跳过 ${ignored} 个无效链接` : ""}。`);
  });
}

async function messageTab(tabId, type, extra = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type, ...extra }, { frameId: 0 });
  } catch (_) {
    return null;
  }
}

async function discover() {
  discovering = true;
  render();
  try {
    const tabs = await chrome.tabs.query({ url: ["https://shopee.com.br/*", "https://www.shopee.com.br/*"] });
    const replies = await Promise.all(tabs.map((tab) => messageTab(tab.id, "LATAM_QUEUE_CATEGORIES")));
    const found = new Map();
    for (const reply of replies) {
      for (const entry of reply?.entries || []) {
        if (!found.has(entry.key)) found.set(entry.key, entry);
      }
    }
    choices = [...found.values()].sort((left, right) => left.label.localeCompare(right.label, "pt-BR"));
    const rows = document.createDocumentFragment();
    for (const [index, entry] of choices.entries()) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.value = String(index);
      label.append(checkbox, entry.label);
      rows.append(label);
    }
    el("category-choices").replaceChildren(rows);
    setText("discovery-feedback", choices.length ? `找到 ${choices.length} 个分类链接，默认全部勾选。` : "暂未读到分类。打开或刷新 Shopee 分类页后再试。");
  } catch (_) {
    setText("discovery-feedback", "暂时无法读取已打开的 Shopee 标签页。");
  } finally {
    discovering = false;
    render();
  }
}

async function workerTab() {
  const id = currentMode ? state.sourceTabId : (await chrome.storage.session.get(WORKER_KEY))[WORKER_KEY];
  if (!Number.isInteger(id)) return null;
  try {
    return await chrome.tabs.get(id);
  } catch (_) {
    return null;
  }
}

async function openWorker(entry, active) {
  const tab = await chrome.tabs.create({ url: entry.url, active });
  await chrome.storage.session.set({ [WORKER_KEY]: tab.id });
  return tab;
}

function sleep(milliseconds, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function verifyLocal(signal) {
  try {
    const response = await fetch(LOCAL_SYSTEM, { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
    if (response.ok) return;
  } catch (_) {}
  signal.throwIfAborted();
  throw new core.QueuePause("本地平台未连接。请打开 LatAmCollector 桌面快捷方式后继续。");
}

function runIO(signal) {
  let tabId = null;
  let navigatingSince = 0;
  let staleReceipt = "";
  let allowPrepare = false;
  let localChecked = false;

  function matchesListing(entry, page) {
    return currentMode ? page?.key === entry.key : page?.scope === entry.scope;
  }

  async function arrive(entry, resuming, needsReview) {
    if (!localChecked) await verifyLocal(signal);
    localChecked = true;
    const worker = await workerTab();
    const page = core.listingEntry(worker?.pendingUrl || worker?.url);
    if ((currentMode || resuming) && matchesListing(entry, page)) {
      tabId = worker.id;
      allowPrepare = true;
      navigatingSince = Date.now();
      staleReceipt = "";
      return;
    }
    if (currentMode) {
      throw new core.QueuePause("原 Shopee 标签页已关闭或切换列表。请回到该列表，或在要采集的标签页重新开始。", true);
    }
    if (needsReview || (worker?.url && !core.publicShopeeUrl(worker.url))) {
      throw new core.QueuePause("请点「查看采集页」，处理页面提示并打开队列中的当前入口，然后继续。", true);
    }
    if (worker) {
      const snapshot = await messageTab(worker.id, "LATAM_QUEUE_STATUS");
      if (snapshot?.status?.status === "blocked") throw new core.QueuePause(snapshot.status.message, true);
      if (snapshot?.status?.status === "running" && snapshot.status.mode !== "category_page") {
        throw new core.QueuePause("采集页正在运行另一个任务，请暂停该任务后继续。");
      }
      staleReceipt = snapshot?.receipt?.id || "";
      signal.throwIfAborted();
      tabId = worker.id;
      await chrome.tabs.update(tabId, { url: entry.url });
    } else {
      signal.throwIfAborted();
      tabId = (await openWorker(entry, false)).id;
      staleReceipt = "";
    }
    allowPrepare = false;
    navigatingSince = Date.now();
  }

  async function read(entry, previous) {
    const started = Date.now();
    const deadline = started + 40000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new core.QueuePause(currentMode
        ? "原 Shopee 标签页已关闭，请从正常商品列表重新开始。"
        : "采集标签页已关闭。请点「查看采集页」重新打开当前入口后继续。");
      if (tab.status === "complete") {
        const page = core.listingEntry(tab.url);
        const snapshot = await messageTab(tabId, "LATAM_QUEUE_STATUS");
        const status = snapshot?.status;
        if (status?.status === "blocked") throw new core.QueuePause(status.message, true);
        if (!matchesListing(entry, page) && Date.now() - navigatingSince > 2000) {
          throw new core.QueuePause("Shopee 打开了另一个页面。请检查采集页，再打开当前入口。", true);
        }
        if (matchesListing(entry, page) && snapshot?.scope === entry.scope && status?.platform === "shopee") {
          const receipt = snapshot.receipt;
          if (status.status === "running" && status.mode !== "category_page") {
            throw new core.QueuePause("采集页正在运行另一个任务，请暂停该任务后继续。");
          }
          if (receipt?.id !== previous && receipt?.id !== staleReceipt && receipt?.phase === "saved") return receipt;
          if (allowPrepare && (receipt?.phase === "error" || ["ready", "stopped", "error"].includes(status.status))) {
            allowPrepare = false;
            signal.throwIfAborted();
            await messageTab(tabId, "LATAM_QUEUE_PREPARE", { scope: entry.scope });
          } else if (receipt?.phase === "error") {
            throw new core.QueuePause("本页商品入库失败。请确认本地平台运行后继续。");
          }
        }
      }
      await sleep(700, signal);
    }
    throw new core.QueuePause("未等到当前列表入库。请检查采集页，手动刷新正常列表后继续。", true);
  }

  async function next(entry, page) {
    await sleep(2300, signal);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      signal.throwIfAborted();
      const result = await messageTab(tabId, "LATAM_QUEUE_NEXT", {
        scope: entry.scope, listingKey: currentMode ? entry.key : undefined,
        receiptId: page.id, lookForPagination: attempt === 0
      });
      if (result?.action === "clicked") return true;
      if (result?.action === "end") return false;
      if (result?.action !== "waiting") {
        throw new core.QueuePause(result?.message || "翻页时采集页发生变化，请检查当前页面。", result?.needsReview ?? true);
      }
      await sleep(700, signal);
    }
    throw new core.QueuePause("本页已入库。暂未识别到分页控件，请查看采集页后继续。", true);
  }

  async function addChildren(entry) {
    const result = await messageTab(tabId, "LATAM_QUEUE_CATEGORIES");
    const children = (result?.entries || []).filter((child) => child.scope.startsWith(entry.scope + "."));
    if (addEntries(children)) await save();
  }

  return { arrive, read, next, addChildren, save };
}

for (const [index, [group, words]] of keywordGroups.entries()) {
  el("keyword-group").add(new Option(`${group}（${words.length} 词）`, index));
}
el("add-group").onclick = () => enqueue(keywordGroups[el("keyword-group").value][1].map(core.keywordEntry));
el("add-all").onclick = () => enqueue(keywordGroups.flatMap(([, words]) => words.map(core.keywordEntry)));
el("add-custom").onclick = async () => {
  const lines = el("custom").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const entries = lines.map((line) => /^(?:[a-z][\w+.-]*:|\/\/|www\.|shopee\.com\.br\/)/i.test(line)
    ? core.listingEntry(/^https:\/\//i.test(line) ? line : "https://" + line)
    : core.keywordEntry(line)).filter(Boolean);
  if (lines.length) await enqueue(entries, lines.length - entries.length);
};
el("discover").onclick = discover;
el("add-categories").onclick = () => enqueue([...el("category-choices").querySelectorAll("input:checked")].map((input) => choices[Number(input.value)]));
el("page-limit").onchange = () => {
  const value = pageLimit(el("page-limit").value);
  el("page-limit").value = value;
  return exclusive(async () => { state.pageLimit = value; await save(); });
};
el("include-children").onchange = () => {
  const value = el("include-children").checked;
  return exclusive(async () => { state.includeChildren = value; await save(); });
};
el("entries").onclick = (event) => {
  const key = event.target.closest("button[data-remove]")?.dataset.remove;
  if (!key) return;
  return exclusive(async () => {
    if (key === state.currentKey && state.needsReview) return;
    state.entries = state.entries.filter((entry) => entry.key !== key);
    if (key === state.currentKey) state.currentKey = "";
    if (!state.entries.length) Object.assign(state, { status: "idle", message: "" });
    await save();
  });
};
el("clear-done").onclick = () => exclusive(async () => {
  state.entries = state.entries.filter((entry) => entry.status !== "done");
  if (!state.entries.length) Object.assign(state, { status: "idle", message: "" });
  await save();
});
async function startRun() {
  if (!hasPending()) return;
  controller = new AbortController();
  state.message = "";
  render();
  try {
    await core.runQueue(state, runIO(controller.signal), controller.signal);
  } finally {
    controller = null;
  }
}

el("start").onclick = () => exclusive(startRun);
el("pause").onclick = () => { controller?.abort(); render(); };
el("show-worker").onclick = async () => {
  try {
    const current = state.entries.find((entry) => entry.key === state.currentKey);
    let tab = await workerTab();
    if (!tab && !currentMode && current && state.status === "paused") {
      await exclusive(async () => {
        tab = await workerTab() || await openWorker(current, true);
        await save();
      });
    }
    if (!tab) return setText("queue-status", "原采集标签页已关闭。请从 Shopee 商品列表重新开始。");
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) {
    setText("queue-status", "无法打开采集页。请打开当前入口后再试。");
  }
};

chrome.storage.onChanged.addListener((changes, area) => {
  const value = area === (currentMode ? "session" : "local") && changes[STATE_KEY]?.newValue;
  if (value && !editing) {
    state = value;
    render();
  }
});

(async () => {
  if (currentMode) {
    document.title = "Shopee 当前列表 · LatAm Collector";
    setText("page-title", "Shopee 当前列表");
    setText("page-description", "从原标签页的当前页继续翻页，直到 Shopee 的可用分页末尾。");
    for (const id of ["sources", "options", "clear-done", "operations"]) el(id).hidden = true;
  }
  await load();
  render();
  if (currentMode && !state.entries.length) {
    setText("queue-status", "当前任务已关闭。请在 Shopee 商品列表打开助手重新开始。");
    return;
  }
  if (state.status === "running") {
    await exclusive(save);
  } else if (currentMode && state.status === "idle") {
    await exclusive(async () => {
      if (state.status === "idle") await startRun();
    });
  }
})().catch(() => setText("queue-status", "无法读取采集队列，请重新打开此页。"));
