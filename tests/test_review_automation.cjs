"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const core = require("../chrome_extension/review_core.js");

const script = name => fs.readFileSync(path.join(__dirname, "../chrome_extension", name), "utf8");
const product = { platform: "shopee", shop_id: "12", item_id: "441" };
const url = "https://shopee.com.br/product/12/441";

test("Review automation recognizes product links and keeps its commands on their exact product", () => {
  assert.ok(core.sameProduct("https://www.shopee.com.br/Caneta-i.12.441?page=2", product));
  assert.ok(!core.sameProduct("https://shopee.com.br/product/20/441", product));
  assert.equal(core.productPage("https://shopee.com.br.example.com/product/12/441"), null);
  assert.equal(core.productPage("http://shopee.com.br/product/12/441"), null);
  assert.ok(core.sameProduct("https://br.shein.com/Bolsa-p-441.html", { platform: "shein", item_id: "441" }));
  assert.ok(!core.reviewListResponse("https://br.shein.com/api/comment/abccommentimages/query"));
  assert.ok(core.reviewListResponse("https://shopee.com.br/api/v2/item/get_ratings?shopid=12&itemid=441"));
});

function driveScenario(mode) {
  let now = 0;
  let clicked = 0;
  const updates = [];
  const receipts = [{ sequence: 1, phase: "saving", batch: null }];
  const observer = { issue: "", receipts, get sequence() { return receipts.at(-1).sequence; } };
  const job = { run: "test-job", product };
  const section = { scrollIntoView() {} };
  const batch = (sequence, id) => ({ sequence, phase: "saved", batch: { ...product, ids: [id] } });

  return new Promise((resolve, reject) => {
    const context = {
      location: { href: url },
      document: { readyState: "complete", body: { innerText: "Avaliações" } },
      Date: { now: () => now },
      setTimeout(callback, time) {
        now += time;
        if (now >= 850 && receipts[0].phase === "saving") receipts[0] = batch(1, "r-1");
        queueMicrotask(callback);
      },
      chrome: { runtime: {
        onMessage: { addListener() {} },
        async sendMessage(message) {
          if (message.type === "LATAM_REVIEW_ATTACH") return { ok: true, result: job };
          updates.push(message);
          if (message.status !== "running") resolve({ updates, clicked });
          return { ok: true, result: job };
        }
      } },
      LatAmReviewObserver: observer,
      LatAmReviews: {
        ...core,
        findSection: () => section,
        findEntry: () => null,
        emptyReviews: () => false,
        pagination() {
          if (clicked >= 2) return { action: "end" };
          return { action: "next", control: {
            isConnected: true,
            scrollIntoView() {},
            click() {
              if (receipts[0].phase !== "saved") reject(new Error("Clicked before the first local acknowledgement"));
              clicked += 1;
              if (mode === "denied") observer.issue = "平台评论请求过多（HTTP 429）";
              else receipts.push(batch(clicked + 1, mode === "repeated" ? "r-1" : "r-" + (clicked + 1)));
            }
          } };
        }
      }
    };
    vm.runInNewContext(script("review_driver.js"), context);
  });
}

test("The driver saves three consecutive review pages and stops on the disabled next control", async () => {
  const result = await driveScenario("normal");
  const last = result.updates.at(-1);
  assert.equal(result.clicked, 2);
  assert.deepEqual([last.status, last.pages, last.count], ["done", 3, 3]);
});

test("The driver pauses after a denial or a repeated response, keeping the confirmed reviews", async () => {
  for (const mode of ["denied", "repeated"]) {
    const result = await driveScenario(mode);
    const last = result.updates.at(-1);
    assert.equal(result.clicked, 1);
    assert.deepEqual([last.status, last.pages, last.count], ["paused", 1, 1]);
    assert.match(last.message, mode === "denied" ? /429/ : /重复/);
  }
});
