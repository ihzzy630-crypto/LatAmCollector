"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const extensionFile = (name) => readFileSync(join(__dirname, "../chrome_extension", name), "utf8");
const hook = extensionFile("page_hook.js");
const bridge = extensionFile("bridge.js");
const queueCore = extensionFile("queue_core.js");
const popup = extensionFile("popup.js");
const home = "https://shopee.com.br/";
const listUrl = new URL("/api/v4/search/search_items?keyword=test&limit=1", home).href;
const categoryUrl = new URL("Papelaria-cat.11059939", home).href;
const recommendUrl = new URL("/api/v4/recommend/recommend_v2", home).href;
const pageUnavailable = "Página indisponível\nDesculpe, algo deu errado. Tente novamente.";
const tick = () => new Promise((resolve) => setImmediate(resolve));

function response(body, { status = 200, url = listUrl } = {}) {
  return {
    url,
    status,
    ok: status >= 200 && status < 300,
    clone() { return this; },
    async text() { return typeof body === "string" ? body : JSON.stringify(body); }
  };
}

function products(itemid, total = 2) {
  return response({ error: 0, items: [{ itemid, shopid: 1 }], total_count: total });
}

function recommendations() {
  const item = { item_data: { itemid: 7, shopid: 8 }, item_card_displayed_asset: { name: "Caneta" } };
  return response({
    error: null,
    data: { total: 231, units: [{ item }, { item }, { banner: {} }] }
  }, { url: recommendUrl });
}

function createTab({ url = new URL("search?keyword=test", home).href, text = "",
  storage = new Map(), onCapture = () => undefined, nextControl = null } = {}) {
  const document = new EventTarget();
  document.readyState = "complete";
  document.body = { innerText: text };
  document.querySelectorAll = () => nextControl ? [nextControl] : [];
  const requests = [];
  const responses = [];
  const timers = [];
  const captured = [];
  let observeChanges;
  let receiveMessage;
  const window = {
    async fetch(url, options) {
      requests.push({ url, options });
      assert.ok(responses.length, "Every request is served by a fixture");
      return responses.shift();
    }
  };
  runInNewContext(hook, {
    document, window, location: new URL(url), URL, AbortController, CustomEvent,
    XMLHttpRequest: class { open() {} send() {} },
    MutationObserver: class {
      constructor(callback) { observeChanges = callback; }
      observe() {}
    },
    sessionStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key)
    },
    setTimeout: (callback) => timers.push(callback)
  });
  runInNewContext(queueCore + "\n" + bridge, {
    document, URL, URLSearchParams, CustomEvent, performance, location: new URL(url),
    chrome: { runtime: {
      onMessage: { addListener: (listener) => { receiveMessage = listener; } },
      async sendMessage(message) {
        if (message.type !== "LATAM_CAPTURE") return;
        captured.push(message.data);
        return onCapture(message.data);
      }
    } }
  });

  function message(payload) {
    let reply;
    receiveMessage(payload, {}, (value) => { reply = value; });
    return reply;
  }
  return {
    url, requests, responses, captured, storage, message,
    status: () => message({ type: "LATAM_GET_SHOPEE_STATUS" }).status,
    start: () => message({ type: "LATAM_BULK_COMMAND", command: { action: "start" } }),
    saveCategory: () => message({ type: "LATAM_BULK_COMMAND", command: { action: "save_category" } }),
    async loadList(result) {
      responses.push(result);
      await window.fetch(result.url);
      await tick();
    },
    async runNextTimer() {
      assert.ok(timers.length);
      timers.shift()();
      await tick();
    },
    changeText(value) {
      document.body.innerText = value;
      observeChanges();
    }
  };
}

test("The Portuguese error page and human verification are identified separately", () => {
  const error = createTab({ url: new URL("verify/traffic/error", home).href, text: pageUnavailable });
  assert.equal(error.status().status, "blocked");
  assert.match(error.status().message, /Página indisponível/);
  error.start();
  assert.equal(error.requests.length, 0);

  const verify = createTab({ text: "Verifique se você é humano" });
  assert.equal(verify.status().status, "blocked");
  assert.match(verify.status().message, /人工验证/);
  verify.start();
  assert.equal(verify.requests.length, 0);
});

test("HTTP 429 stops after the completed batch and requires manual restart on a healthy list", async () => {
  const tab = createTab();
  await tab.loadList(products(1));
  assert.equal(tab.status().status, "ready");

  tab.responses.push(products(1));
  tab.start();
  await tick();
  assert.equal(tab.status().captured, 1);
  tab.responses.push(response({}, { status: 429 }));
  await tab.runNextTimer();
  assert.equal(tab.status().status, "blocked");
  assert.match(tab.status().message, /HTTP 429/);
  assert.equal(tab.status().captured, 1);
  tab.start();
  assert.equal(tab.requests.length, 3);

  const reloaded = createTab({ storage: tab.storage });
  assert.equal(reloaded.status().status, "blocked");
  reloaded.start();
  assert.equal(reloaded.requests.length, 0);
  await reloaded.loadList(products(1));
  assert.equal(reloaded.status().status, "stopped");
  assert.equal(reloaded.status().captured, 1);
  assert.equal(reloaded.requests.length, 1);
  reloaded.responses.push(products(2));
  reloaded.start();
  await tick();
  assert.equal(reloaded.status().status, "done");
  assert.equal(reloaded.status().captured, 2);
});

test("A rendered error aborts a pending helper request and discards its late response", async () => {
  const tab = createTab();
  await tab.loadList(products(1));
  let resolveBatch;
  tab.responses.push(new Promise((resolve) => { resolveBatch = resolve; }));
  tab.start();
  const request = tab.requests.at(-1);
  assert.equal(request.options.signal.aborted, false);

  tab.changeText(pageUnavailable);
  await tab.runNextTimer();
  assert.equal(request.options.signal.aborted, true);
  resolveBatch(products(2));
  await tick();
  assert.equal(tab.status().status, "blocked");
  assert.equal(tab.captured.length, 1);
  assert.equal(tab.requests.length, 2);
});

test("A page-owned request returning an access error pauses capture in that tab", async () => {
  const tab = createTab();
  await tab.loadList(response({}, { status: 403 }));
  assert.equal(tab.status().status, "blocked");
  assert.match(tab.status().message, /HTTP 403/);
  assert.equal(tab.captured.length, 0);
  assert.equal(createTab().status().status, "idle");
});

test("Popular shows the current products and retries a failed local save without another Shopee request", async () => {
  let accept;
  const tab = createTab({ url: categoryUrl, onCapture: () => accept });
  let finishSave;
  accept = new Promise((resolve) => { finishSave = resolve; });
  await tab.loadList(recommendations());
  assert.equal(tab.status().mode, "category_page");
  assert.equal(tab.status().status, "running");
  assert.equal(tab.status().total, 1);
  assert.equal(tab.status().captured, 0);

  finishSave({ ok: false });
  await tick();
  assert.equal(tab.status().status, "error");
  accept = { ok: true, result: { products: 1 } };
  tab.saveCategory();
  await tick();
  assert.equal(tab.status().status, "done");
  assert.equal(tab.status().captured, 1);
  tab.saveCategory();
  assert.equal(tab.requests.length, 1);
  assert.equal(tab.captured.length, 2);
  assert.deepEqual(tab.captured[0].payload, tab.captured[1].payload);
});

test("Category detection keeps the search list available and ignores detail-page recommendations", async () => {
  const detail = createTab({ url: new URL("product/8/7", home).href });
  await detail.loadList(recommendations());
  assert.equal(detail.status().status, "idle");
  assert.equal(detail.captured.length, 1);

  const search = createTab({ url: categoryUrl });
  await search.loadList(products(1));
  await search.loadList(recommendations());
  assert.equal(search.status().mode, undefined);
  assert.equal(search.status().status, "ready");
});

test("Popular still pauses on a refusal and waits for an explicit save after reopening", async () => {
  const tab = createTab({ url: categoryUrl });
  await tab.loadList(response({}, { url: recommendUrl, status: 403 }));
  assert.equal(tab.status().status, "blocked");
  tab.saveCategory();
  assert.equal(tab.captured.length, 0);

  const reloaded = createTab({
    url: categoryUrl, storage: tab.storage, onCapture: () => ({ ok: true, result: { products: 1 } })
  });
  await reloaded.loadList(recommendations());
  assert.equal(reloaded.status().status, "ready");
  assert.equal(reloaded.captured.length, 0);
  reloaded.saveCategory();
  await tick();
  assert.equal(reloaded.status().status, "done");
  assert.equal(reloaded.requests.length, 1);
});

test("The queue waits for local acknowledgement and rechecks the page before clicking Next", async () => {
  let clicks = 0;
  let finishSave;
  const pendingSave = new Promise((resolve) => { finishSave = resolve; });
  const nextControl = {
    matches: () => true, closest: () => null, getAttribute: () => null,
    getClientRects: () => [{}], click: () => { clicks += 1; }
  };
  const tab = createTab({ nextControl, onCapture: () => pendingSave });
  const snapshot = () => tab.message({ type: "LATAM_QUEUE_STATUS" });
  const next = (receiptId) => tab.message({ type: "LATAM_QUEUE_NEXT", scope: "search:test", receiptId });
  assert.equal(next().action, "pause");
  await tab.loadList(products(123));
  const { receipt } = snapshot();
  assert.equal(receipt.phase, "saving");
  assert.equal(next(receipt.id).action, "pause");
  assert.equal(clicks, 0);

  finishSave({ ok: true, result: { products: 1, new_products: 1 } });
  await tick();
  assert.equal(snapshot().receipt.phase, "saved");
  assert.equal(snapshot().receipt.added, 1);
  assert.equal(next("stale-page").action, "pause");
  assert.equal(next(receipt.id).action, "clicked");
  assert.equal(clicks, 1);

  tab.changeText(pageUnavailable);
  const paused = next(receipt.id);
  assert.equal(paused.action, "pause");
  assert.equal(paused.needsReview, true);
  assert.equal(clicks, 1);
  assert.equal(tab.requests.length, 1);
});

test("An explicit queue restart after manual recovery saves the already loaded list", async () => {
  const tab = createTab();
  await tab.loadList(response({}, { status: 429 }));
  const reloaded = createTab({ storage: tab.storage, onCapture: () => ({ ok: true, result: { products: 1 } }) });
  const prepare = () => reloaded.message({ type: "LATAM_QUEUE_PREPARE", scope: "search:test" });
  assert.equal(prepare().ok, false);
  await reloaded.loadList(products(1));
  assert.equal(reloaded.captured.length, 0);
  assert.equal(prepare().ok, true);
  await tick();
  assert.equal(reloaded.message({ type: "LATAM_QUEUE_STATUS" }).receipt.phase, "saved");
  assert.equal(reloaded.requests.length, 1);
  await reloaded.loadList(products(2));
  assert.equal(reloaded.captured.length, 2);
});

async function createPopup(tab) {
  const elements = new Map();
  const opened = [];
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        style: {},
        addEventListener(event, listener) { this[event] = listener; }
      });
      return elements.get(id);
    }
  };
  runInNewContext(popup, {
    document, URL, AbortSignal,
    fetch: async () => ({ ok: true, json: async () => ({ products: 1, reviews: 0 }) }),
    chrome: {
      tabs: {
        query: async () => [{ id: 1, url: tab.url }],
        sendMessage: async (_id, message) => tab.message(message),
        create: ({ url }) => opened.push(url)
      },
      storage: { local: {
        get: async (defaults) => ({
          ...defaults,
          bulkStatus: { platform: "shopee", status: "blocked", message: "Other tab error" }
        })
      } }
    },
    setTimeout() {}
  });
  await tick();
  return { elements, opened };
}

test("The popup uses the active tab and the Shopee button opens the official homepage", async () => {
  const tab = createTab();
  await tab.loadList(products(1));
  const { elements, opened } = await createPopup(tab);
  assert.equal(elements.get("platform").textContent, "运行中");
  assert.equal(elements.get("page").textContent, "已连接");
  assert.equal(elements.get("bulk-start").disabled, false);
  elements.get("shopee-home").click();
  assert.deepEqual(opened, [home]);
});

test("The popup reports a saved Popular list without offering an unrelated bulk action", async () => {
  const tab = createTab({ url: categoryUrl, onCapture: () => ({ ok: true, result: { products: 1 } }) });
  await tab.loadList(recommendations());
  const { elements } = await createPopup(tab);
  assert.equal(elements.get("page").textContent, "已识别分类列表");
  assert.equal(elements.get("bulk-state").textContent, "本页 1 件商品已入库");
  assert.equal(elements.get("bulk-start").textContent, "本页已入库");
  assert.equal(elements.get("bulk-limit").hidden, true);
});

if (process.env.LATAM_SHOPEE_POPULAR_FIXTURE) {
  test("Recognizes the previously saved Shopee Popular response", async () => {
    const payload = JSON.parse(readFileSync(process.env.LATAM_SHOPEE_POPULAR_FIXTURE, "utf8"));
    const tab = createTab({ url: categoryUrl, onCapture: () => ({ ok: true, result: { products: 60 } }) });
    await tab.loadList(response(payload, { url: recommendUrl }));
    assert.equal(tab.status().total, 60);
    assert.equal(tab.status().captured, 60);
    assert.equal(tab.status().status, "done");
  });
}
