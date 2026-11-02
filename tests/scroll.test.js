// Playback must never scroll the browser page: following the latest strike stays inside the
// Strikes table, and steps aside while the user scrolls the table themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFollowGate, scrollRowIntoContainer } from "../app/table-follow.js";
import { findChrome } from "../src/map/render-basemap.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A scroll container 100 px tall at y=0 with a 20 px header and 20 px rows. */
function fakeTable(rows, scrollTop = 0) {
  const c = {
    scrollTop,
    getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }),
    querySelector: () => ({ getBoundingClientRect: () => ({ height: 20 }) }),
  };
  const row = (i) => ({ getBoundingClientRect: () => ({ top: 20 + i * 20 - c.scrollTop, bottom: 40 + i * 20 - c.scrollTop }) });
  return { c, row, rows };
}

test("S1. row following scrolls only the table container, nearest-edge", () => {
  const { c, row } = fakeTable(50);
  assert.equal(scrollRowIntoContainer(c, row(2)), false, "a visible row does not move the table");
  assert.equal(c.scrollTop, 0);
  assert.equal(scrollRowIntoContainer(c, row(10)), true);
  assert.equal(c.scrollTop, 20 + 10 * 20 + 20 - 100 + 0, "row 10 ends at the bottom edge"); // bottom 240 → 240-100
  assert.equal(scrollRowIntoContainer(c, row(0)), true);
  assert.equal(c.scrollTop, 0, "a row hidden under the sticky header is brought back below it");
  assert.equal(scrollRowIntoContainer(c, null), false);
});

test("S2. automatic following pauses after user interaction and resumes", () => {
  let t = 0;
  const gate = createFollowGate(4000, () => t);
  assert.equal(gate.active(), true);
  gate.touch();
  t = 3999; assert.equal(gate.active(), false, "still suspended");
  t = 4000; assert.equal(gate.active(), true, "resumes after the hold");
  gate.touch(); t = 5000; gate.touch(); t = 8999;
  assert.equal(gate.active(), false, "a new interaction extends the hold");
});

test("S3. the strike table never calls scrollIntoView", async () => {
  const src = await readFile(join(ROOT, "app", "app.js"), "utf8");
  const offenders = src.split("\n").filter((l) => l.includes("scrollIntoView") && l.includes("ev-body"));
  assert.deepEqual(offenders, []);
});

test("S4. in a real browser following a strike leaves the page scroll untouched", { timeout: 120000 }, async () => {
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 700 });
    await page.setContent(`<!doctype html><body style="margin:0">
      <div style="height:900px">tall preview</div>
      <div class="table-wrap" style="height:200px;overflow:auto"><table><thead style="position:sticky;top:0"><tr><th>h</th></tr></thead>
      <tbody id="ev-body">${Array.from({ length: 200 }, (_, i) => `<tr data-i="${i}"><td style="height:20px;padding:0">${i}</td></tr>`).join("")}</tbody></table></div>
      <div style="height:900px"></div>`);
    const src = (await readFile(join(ROOT, "app", "table-follow.js"), "utf8")).replace(/^export /gm, "");
    const r = await page.evaluate((code) => {
      const { scrollRowIntoContainer } = new Function(`${code}; return { scrollRowIntoContainer };`)();
      const wrap = document.querySelector(".table-wrap");
      window.scrollTo(0, 800); // preview in view, table at the bottom of the viewport
      const page0 = window.scrollY;
      const rowAt = (i) => document.querySelector(`tr[data-i="${i}"]`);
      for (let i = 0; i < 120; i++) scrollRowIntoContainer(wrap, rowAt(i)); // 120 strikes arriving
      const follow = { pageY: window.scrollY, tableTop: wrap.scrollTop };
      // The control: the call the app used before moves the page.
      window.scrollTo(0, 0);
      rowAt(150).scrollIntoView({ block: "nearest" });
      return { page0, ...follow, legacyPageY: window.scrollY };
    }, src);
    assert.equal(r.pageY, r.page0, "page scroll is unchanged while following");
    assert.ok(r.tableTop > 1500, "the table itself followed the latest row");
    assert.ok(r.legacyPageY > 0, "control: scrollIntoView does move the page");
  } finally {
    await browser.close();
  }
});
