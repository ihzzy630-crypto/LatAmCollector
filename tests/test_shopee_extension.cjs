"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const extensionFile = (name) => readFileSync(join(__dirname, "../chrome_extension", name), "utf8");
const hook = extensionFile("page_hook.js");
const bridge = extensionFile("bridge.js");
const popup = extensionFile("popup.js");
const home = "https://shopee.com.br/";
const listUrl = new URL("/api/v4/search/search_items?keyword=test&limit=1", home).href;
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

function createTab({ url = new URL("search?keyword=test", home).href, text = "", storage = new Map() } = {}) {
  const document = new EventTarget();
  document.readyState = "complete";
  document.body = { innerText: text };
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
  runInNewContext(bridge, {
    document, URL, CustomEvent,
    chrome: { runtime: {
      onMessage: { addListener: (listener) => { receiveMessage = listener; } },
      sendMessage: (message) => {
        if (message.type === "LATAM_CAPTURE") captured.push(message.data);
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
    async loadList(result) {
      responses.push(result);
      await window.fetch(listUrl);
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

test("The popup uses the active tab and the Shopee button opens the official homepage", async () => {
  const tab = createTab();
  await tab.loadList(products(1));
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
  assert.equal(elements.get("platform").textContent, "运行中");
  assert.equal(elements.get("page").textContent, "已连接");
  assert.equal(elements.get("bulk-start").disabled, false);
  elements.get("shopee-home").click();
  assert.deepEqual(opened, [home]);
});
