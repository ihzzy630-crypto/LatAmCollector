"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
require("../chrome_extension/queue_core.js");
require("../chrome_extension/queue_keywords.js");
const { HOME, listingEntry, keywordEntry, categoryLinks, listingReceipt, nextListingControl, runQueue, QueuePause } = globalThis.LatAmQueue;

const rootUrl = HOME + "Casa-e-Construção-cat.11059983";
const childUrl = HOME + "Decoração-cat.11059983.11059984";
const searchUrl = HOME + "search?keyword=luminária";
const makeEntry = (entry) => ({ ...entry, status: "queued", pages: [], saved: 0, added: 0, message: "" });
const makeState = (...entries) => ({ entries: entries.map(makeEntry), currentKey: "", needsReview: false, pageLimit: 4, includeChildren: true });
const makeReceipt = (id, fingerprint = id) => ({ id, fingerprint, count: 8, saved: 8, added: 3 });

test("Public category links and Portuguese searches deduplicate paging and tracking URLs", () => {
  const root = listingEntry(rootUrl + "?page=3&utm_source=ignore", "Casa e Construção");
  assert.equal(root.scope, "category:11059983");
  assert.equal(root.url, new URL(rootUrl).href);
  assert.equal(listingEntry(childUrl).scope, "category:11059983.11059984");
  assert.equal(listingEntry(searchUrl + "&page=1").key, keywordEntry("  LUMINÁRIA  ").key);
  assert.equal(listingEntry(searchUrl + "&sortBy=ctime").key, "search:luminária?sortBy=ctime");
  for (const invalid of ["http://shopee.com.br/search?keyword=x", "https://example.com/foo-cat.1", "https://shopee.com.br.evil.test/foo-cat.1", "https://user@shopee.com.br/foo-cat.1", "/product/5/6", "", undefined]) {
    assert.equal(listingEntry(invalid), null);
  }
  assert.equal(new URL(listingEntry(HOME + "/example.com/a-cat.1").url).hostname, "shopee.com.br");
  const words = globalThis.LatAmShopeeKeywords.flatMap(([, entries]) => entries.map(keywordEntry));
  assert.equal(words.length, 160);
  assert.equal(new Set(words.map(({ key }) => key)).size, words.length);
});

test("Category discovery accepts only public category links in the open page", () => {
  const links = [childUrl, childUrl + "?page=2", "https://example.com/Outra-cat.123"].map((url) => ({
    innerText: "Decoração", getAttribute: () => url
  }));
  const discovered = categoryLinks({ querySelectorAll: () => links }, rootUrl);
  assert.deepEqual(discovered.map(({ scope }) => scope), ["category:11059983.11059984", "category:11059983"]);
});

test("Receipts are scoped to product lists and fingerprint unique products irrespective of order", () => {
  const endpoint = HOME + "api/v4/search/search_items?keyword=luminária";
  const first = { itemid: 1, shopid: 19 };
  const second = { itemid: 2, shopid: 35 };
  const a = listingReceipt(endpoint, searchUrl, { items: [first, second, first] });
  const b = listingReceipt(endpoint, searchUrl + "&page=1", { items: [second, first] });
  assert.equal(a.count, 2);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(listingReceipt(endpoint + "x", searchUrl, { items: [] }), null);
  assert.equal(listingReceipt(endpoint, HOME + "search?keyword=caneta", { items: [first] }), null);
  assert.equal(listingReceipt(endpoint, searchUrl, { items: [], error: 403 }), null);
  assert.equal(listingReceipt(endpoint, searchUrl, { items: [] }).count, 0);
});

test("Only a visible next control that stays in the same listing can be clicked", () => {
  const control = (href, { disabled = false, hidden = false } = {}) => ({
    disabled, matches: () => true, closest: () => null,
    getAttribute: (name) => name === "href" ? href : null,
    getClientRects: () => hidden ? [] : [{}]
  });
  const valid = control(searchUrl + "&page=2");
  const other = control(HOME + "search?keyword=caneta&page=3");
  const external = control("https://example.com/search?keyword=luminária");
  const hidden = control(searchUrl, { hidden: true });
  const disabled = control(searchUrl, { disabled: true });
  const doc = { querySelectorAll: () => [other, external, hidden, disabled, valid] };
  assert.equal(nextListingControl(doc, searchUrl), valid);
  assert.equal(nextListingControl({ querySelectorAll: () => [disabled] }, searchUrl), null);
});

test("The queue expands discovered children, stops repeated pages and reports only confirmed saves", async () => {
  const state = makeState(listingEntry(rootUrl), keywordEntry("caneta"));
  const order = [];
  const receipts = [makeReceipt("1", "a"), makeReceipt("2", "a"), makeReceipt("3"), makeReceipt("4")];
  let clicks = 0;
  await runQueue(state, {
    save: async () => {},
    arrive: async (entry) => { order.push(entry.scope); },
    read: async () => receipts.shift(),
    next: async (entry) => { clicks += 1; return entry.scope === "category:11059983"; },
    addChildren: async (entry) => {
      if (entry.scope === "category:11059983") state.entries.push(makeEntry(listingEntry(childUrl)));
    }
  }, new AbortController().signal);
  assert.deepEqual(order, ["category:11059983", "search:caneta", "category:11059983.11059984"]);
  assert.equal(clicks, 3);
  assert.deepEqual(state.entries.map(({ saved, added }) => [saved, added]), [[8, 3], [8, 3], [8, 3]]);
  assert.equal(state.status, "done");
});

test("A block stops all later entries and resuming preserves the confirmed page totals", async () => {
  const state = makeState(keywordEntry("caneta"), keywordEntry("trena"));
  state.pageLimit = 2;
  const order = [];
  const receipts = [makeReceipt("1"), new QueuePause("人工验证", true), makeReceipt("3", "1"), makeReceipt("4"), makeReceipt("5")];
  const io = {
    save: async () => {},
    arrive: async (entry, resuming, needsReview) => { order.push([entry.label, resuming, needsReview]); },
    read: async () => {
      const result = receipts.shift();
      if (result instanceof Error) throw result;
      return result;
    },
    next: async (entry) => entry.label === "caneta"
  };
  await runQueue(state, io, new AbortController().signal);
  assert.equal(state.status, "paused");
  assert.equal(state.needsReview, true);
  assert.equal(state.entries[0].saved, 8);
  assert.deepEqual(order, [["caneta", false, false]]);

  await runQueue(state, io, new AbortController().signal);
  assert.equal(state.status, "done");
  assert.equal(state.needsReview, false);
  assert.deepEqual(state.entries[0].pages, ["1", "4"]);
  assert.equal(state.entries[0].saved, 16);
  assert.equal(state.entries[0].added, 6);
  assert.deepEqual(order, [["caneta", false, false], ["caneta", true, true], ["trena", false, false]]);
});

test("Pausing between entries preserves the last finished entry", async () => {
  const state = makeState(keywordEntry("caneta"), keywordEntry("trena"));
  const controller = new AbortController();
  await runQueue(state, {
    save: async () => { if (state.entries[0].status === "done") controller.abort(); },
    arrive: async () => {},
    read: async () => makeReceipt("1"),
    next: async () => false
  }, controller.signal);
  assert.equal(state.status, "paused");
  assert.equal(state.entries[0].status, "done");
  assert.equal(state.entries[1].status, "queued");
});
