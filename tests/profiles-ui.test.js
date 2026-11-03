// Studio Profiles in the real Studio (headless Chrome against the real server): persistence across
// a reload, applying onto a different dataset, safe application, no redundant map bakes, hostile
// names and unavailable storage. The map bake endpoint is stubbed (and counted); nothing leaves the machine.
//   node --test tests/profiles-ui.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome } from "../src/map/render-basemap.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server, browser, base;
const freePort = () => new Promise((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // The online style is pointed at a dead port: the composer uses offline outlines, no network is needed.
  server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), LR_MAP_STYLE_URL: "http://127.0.0.1:9/style.json" }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((res, rej) => { server.stdout.on("data", (d) => String(d).includes("http://") && res()); server.on("error", rej); setTimeout(() => rej(new Error("server did not start")), 15000); });
  const { default: puppeteer } = await import("puppeteer-core");
  browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); server?.kill(); });

/** A fresh Studio page: bakes are stubbed and counted in `page.bakes`; `storage: false` makes localStorage throw. */
async function studio({ storage = true, seed = null } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.bakes = [];
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname === "/api/basemap" && req.method() === "POST") {
      const body = JSON.parse(req.postData());
      page.bakes.push({ format: body.format, quality: body.quality, layers: body.layers });
      const out = body.format === "portrait" ? [1080, 1920] : body.format === "square" ? [1080, 1080] : [1920, 1080];
      return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ url: `/stub/${page.bakes.length}.png`, id: `stub${page.bakes.length}`, attribution: "test", provider: "stub", output: out, camera: { zoom: 6 }, alignment: { maxErrorPx: 0 }, cached: false }) });
    }
    if (url.pathname.startsWith("/stub/")) return req.respond({ status: 200, contentType: "image/png", body: PNG });
    req.continue();
  });
  if (!storage) await page.evaluateOnNewDocument(() => Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError"); } }));
  if (seed) await page.evaluateOnNewDocument((s) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(s.key, s.value); sessionStorage.setItem("seeded", "1"); } }, seed);
  await page.goto(base);
  await page.waitForFunction(() => window.__studio && document.querySelector("#sample option"));
  return page;
}
const loadSample = async (page, name) => {
  await page.evaluate((n) => { const s = document.getElementById("sample"); s.value = [...s.options].find((o) => o.value.includes(n) && o.value.endsWith(".json")).value; document.getElementById("load-sample").click(); }, name);
  await page.waitForFunction((n) => window.__studio.state.filename?.includes(n) && window.__studio.state.model, {}, name);
};
const lock = async (page) => {
  await page.evaluate(() => window.__studio.lockFrame());
  await page.waitForFunction(() => window.__studio.state.mode === "locked" && !window.__studio.state.mapBusy && window.__studio.state.mapImage);
};
const settled = async (page, ms = 900) => { await sleep(ms); await page.waitForFunction(() => !window.__studio.state.mapBusy); };

/** Build the walkthrough composition through the real controls. */
async function build(page) {
  await page.click('[data-format="portrait"]');
  await page.evaluate(() => {
    const fire = (el, ev = "input") => el.dispatchEvent(new Event(ev, { bubbles: true }));
    const water = document.querySelector('.layer[data-id="water"] [data-role="waterMode"]');
    water.value = "teal"; fire(water);
    for (const id of ["roadsMinor", "labels"]) { const c = document.querySelector(`.layer[data-id="${id}"] [data-role="visible"]`); c.checked = false; fire(c); }
    const d = document.getElementById("duration"); d.value = 30; fire(d, "change");
    const tr = document.getElementById("trail"); tr.value = 45; fire(tr, "change");
    document.querySelector('[data-shading="subtle"]').click();
    const S = window.__studio;
    S.state.layouts.set("portrait", "title", { x: 0.5, y: 0.2, scale: 0.8 });
    S.state.layouts.set("portrait", "clock", { x: 0.9, y: 0.3, scale: 1.2, locked: true });
    S.state.layouts.set("landscape", "counter", { x: 0.3, y: 0.8, scale: 1.1 });
    S.state.layouts.set("square", "legend", { x: 0.6, y: 0.7, scale: 0.9 });
  });
}
const saveAs = async (page, name) => {
  await page.click("#profile-save");
  await page.type("#profile-name", name);
  await page.click("#profile-ok");
};
const snapshot = (page) => page.evaluate(() => {
  const S = window.__studio;
  return { settings: S.captureProfile(), filename: S.state.filename, events: S.state.model?.totalEvents, mode: S.state.mode, t: S.state.t, format: S.state.format };
});

test("U1. save a portrait composition, reload, load another dataset, apply once: the look returns and the data stays", { timeout: 120000 }, async () => {
  const page = await studio();
  await loadSample(page, "istanbul");
  await build(page);
  const saved = (await snapshot(page)).settings;
  await saveAs(page, "Cinematic Mediterranean");
  assert.equal(await page.$eval("#profile-select", (s) => s.selectedOptions[0].text), "Cinematic Mediterranean");

  // Same browser profile, new page load = "close and reopen".
  const stored = await page.evaluate(() => localStorage.getItem("lightning-replay-studio:profiles"));
  const again = await studio({ seed: { key: "lightning-replay-studio:profiles", value: stored } });
  assert.deepEqual(await again.$$eval("#profile-select option", (o) => o.map((x) => x.text)), ["Choose a profile…", "Cinematic Mediterranean"]);

  await loadSample(again, "ankara");
  const ankara = await again.evaluate(() => ({ text: window.__studio.state.text, frame: window.__studio.state.frame, events: window.__studio.state.model.totalEvents }));
  // Make everything different, then apply with one click.
  await again.evaluate(() => {
    const S = window.__studio;
    document.querySelector('[data-quality="draft"]').click();
    document.querySelector('[data-shading="standard"]').click();
    S.state.layouts.resetAll("square");
    const d = document.getElementById("duration"); d.value = 12; d.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("profile-select").selectedIndex = 1;
    document.getElementById("profile-select").dispatchEvent(new Event("change", { bubbles: true }));
  });
  await again.click("#profile-apply");
  const after = await snapshot(again);
  assert.deepEqual(after.settings, saved, "every saved setting is back, including all three formats' layouts");
  assert.equal(after.filename, "sample-ankara-storm.json");
  assert.equal(after.events, ankara.events);
  assert.equal(await again.evaluate(() => window.__studio.state.text), ankara.text, "the loaded dataset is untouched");
  // The Ankara frame was kept (same centre), adapted to 9:16, never replaced by Istanbul's.
  const f = await again.evaluate(() => window.__studio.state.frame);
  const mid = (a, b) => (a + b) / 2;
  assert.ok(Math.abs(mid(f.south, f.north) - mid(ankara.frame.south, ankara.frame.north)) < 0.1, "same centre (latitude is Mercator, so not exactly the arithmetic mean)");
  assert.ok(Math.abs(mid(f.west, f.east) - mid(ankara.frame.west, ankara.frame.east)) < 1e-6);
  assert.equal(await again.$eval("#profile-badge", (b) => b.hidden), true, "nothing is modified right after applying");
  // The other formats' layouts are there when switching formats.
  for (const [format, id] of [["landscape", "counter"], ["square", "legend"]]) {
    await again.click(`[data-format="${format}"]`);
    assert.ok(await again.evaluate((i) => !!window.__studio.state.model.settings.overlayLayout[i], id), `${format}: ${id} override restored`);
  }
  assert.deepEqual(again.errors, []);
  await page.close(); await again.close();
});

test("U2. applying is coordinated: the same profile again, overlay-only and replay changes never re-bake; only layers or size do", { timeout: 180000 }, async () => {
  const page = await studio();
  await loadSample(page, "istanbul");
  await build(page);
  await saveAs(page, "Look");
  await lock(page);
  assert.equal(page.bakes.length, 1);
  await page.evaluate(() => { window.__studio.state.t = 6; });

  const apply = async () => { await page.click("#profile-apply"); await settled(page); };
  await apply();
  assert.equal(page.bakes.length, 1, "identical settings: no bake");
  assert.equal((await snapshot(page)).mode, "locked");

  // Overlay, layout, shading, grid and replay timing: drawn by the renderer, the map image is still right.
  await page.evaluate(() => {
    const S = window.__studio;
    document.querySelector('[data-shading="off"]').click();
    S.state.layouts.resetAll("portrait");
    document.querySelector('#overlays input[data-id="legend"]').click();
    const g = document.getElementById("grid-visible"); g.checked = !g.checked; g.dispatchEvent(new Event("input", { bubbles: true }));
    const tr = document.getElementById("trail"); tr.value = 10; tr.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await apply();
  const s1 = await snapshot(page);
  assert.equal(page.bakes.length, 1, "no re-bake for overlays, layouts, shading, grid or trail");
  assert.equal(s1.mode, "locked");
  assert.equal(s1.t, 6, "the replay position is preserved");
  assert.equal(await page.$eval("#profile-badge", (b) => b.hidden), true);

  // A change that does touch the map (water colour) and is then reverted before it settles: still no bake.
  await page.evaluate(() => { const w = document.querySelector('.layer[data-id="water"] [data-role="waterMode"]'); w.value = "blue"; w.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.click("#profile-apply");
  await settled(page);
  assert.equal(page.bakes.length, 1, "reverting to the prepared map's settings needs no new bake");

  // A real map difference: exactly one bake, export blocked until it is ready, the map layers are the profile's.
  await page.evaluate(() => { const w = document.querySelector('.layer[data-id="water"] [data-role="waterMode"]'); w.value = "original"; w.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForFunction(() => window.__studio.state.mapBusy || window.__studio.state.mapImage?.bakeKey.includes("original") === false, { timeout: 5000 }).catch(() => {});
  await settled(page, 1200);
  const afterChange = page.bakes.length; // the user's own change baked once
  await page.evaluate(() => { window.__studio.state.t = 8; });
  await page.click("#profile-apply");
  assert.equal(await page.$eval("#export", (b) => b.disabled), true, "export waits for the new map");
  await settled(page, 1200);
  assert.equal(page.bakes.length, afterChange + 1, "one bake for the profile's layers");
  assert.equal(page.bakes.at(-1).layers.water.colorMode, "teal");
  assert.equal(await page.$eval("#export", (b) => b.disabled), false);
  assert.equal((await snapshot(page)).t, 8);

  // A different format leaves the locked frame (the prepared map is shape-specific): no bake until it is locked again.
  await page.click('[data-format="landscape"]');
  const before = page.bakes.length;
  await page.click("#profile-apply");
  await settled(page);
  assert.equal(page.bakes.length, before);
  const s2 = await snapshot(page);
  assert.equal(s2.mode, "compose");
  assert.equal(s2.format, "portrait");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("U3. an optional saved map frame is restored only when asked", { timeout: 120000 }, async () => {
  const page = await studio();
  await loadSample(page, "istanbul");
  const istanbulFrame = await page.evaluate(() => window.__studio.state.frame);
  await page.click('[data-format="portrait"]');
  await page.evaluate(() => { document.getElementById("profile-save-frame").checked = true; });
  await saveAs(page, "With frame");
  assert.ok((await page.evaluate(() => window.__studio.profileStore.list()[0].settings.frame)), "frame saved because the box was ticked");
  await loadSample(page, "ankara");
  await page.click('[data-format="landscape"]');
  const ankaraFrame = await page.evaluate(() => window.__studio.state.frame);
  await page.evaluate(() => { const s = document.getElementById("profile-select"); s.selectedIndex = 1; s.dispatchEvent(new Event("change", { bubbles: true })); });
  assert.equal(await page.$eval("#profile-restore-row", (r) => r.hidden), false, "the choice is offered, not made silently");
  assert.equal(await page.$eval("#profile-restore-frame", (c) => c.checked), false, "off by default");
  await page.click("#profile-apply");
  const kept = await page.evaluate(() => window.__studio.state.frame);
  const mid = (f) => [(f.west + f.east) / 2, (f.south + f.north) / 2];
  assert.ok(Math.abs(mid(kept)[0] - mid(ankaraFrame)[0]) < 1e-6 && Math.abs(mid(kept)[1] - mid(ankaraFrame)[1]) < 0.1, "default: the Ankara area stays");
  await page.click("#profile-restore-frame");
  await page.click("#profile-apply");
  const restored = await page.evaluate(() => window.__studio.state.frame);
  assert.ok(Math.abs(mid(restored)[0] - mid(istanbulFrame)[0]) < 0.5, "explicitly asked: the saved Istanbul frame returns");
  assert.equal((await snapshot(page)).filename, "sample-ankara-storm.json", "the dataset is still the loaded one");
  await page.close();
});

test("U4. hostile names stay text; bad imports are refused without changing anything; delete asks first", { timeout: 120000 }, async () => {
  const page = await studio();
  const evil = '<img src=x onerror="window.__pwned=1"><b>x</b><script>__pwned=2</script>'.slice(0, 60);
  await saveAs(page, evil);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.$eval("#profile-select", (s) => s.selectedOptions[0].text), evil);
  assert.equal(await page.$$eval("#profiles img, #profiles script", (n) => n.length), 0, "markup in a name is never parsed");

  const importText = (text) => page.evaluate(async (t) => {
    const input = document.getElementById("profile-file");
    const dt = new DataTransfer(); dt.items.add(new File([t], "p.json", { type: "application/json" })); input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return { options: document.querySelectorAll("#profile-select option").length, state: document.getElementById("profile-state").textContent, bad: document.getElementById("profile-state").classList.contains("bad") };
  }, text);
  for (const bad of ["{ nope", "[1,2]", JSON.stringify({ schemaVersion: 1, name: "no marker", settings: {} }), JSON.stringify({ schemaVersion: 9, settings: {} }), "x".repeat(300 * 1024)]) {
    const r = await importText(bad);
    assert.equal(r.options, 2, "list unchanged");
    assert.ok(r.bad, `refused: ${bad.slice(0, 20)}`);
  }
  const ok = await importText(JSON.stringify({ kind: "lightning-replay-studio-profile", schemaVersion: 1, name: "Imported <b>look</b>", settings: { format: "square", hudShading: 0.25 } }));
  assert.equal(ok.options, 3);
  assert.equal(await page.$eval("#profile-select", (s) => s.selectedOptions[0].text), "Imported <b>look</b>");
  assert.equal((await snapshot(page)).format, "landscape", "importing never applies by itself");

  await page.click('#profile-links [data-act="delete"]');
  assert.equal(await page.$eval("#profile-form", (f) => f.hidden), false);
  assert.equal(await page.evaluate(() => window.__studio.profileStore.list().length), 2, "still there until confirmed");
  await page.click("#profile-cancel");
  assert.equal(await page.evaluate(() => window.__studio.profileStore.list().length), 2);
  await page.click('#profile-links [data-act="delete"]');
  await page.click("#profile-ok");
  assert.equal(await page.evaluate(() => window.__studio.profileStore.list().length), 1);

  // Saving over an existing name is refused, not silently replaced.
  await saveAs(page, evil);
  assert.match(await page.$eval("#profile-state", (n) => n.textContent), /already exists/);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("U5. with browser storage blocked or damaged the Studio still works", { timeout: 120000 }, async () => {
  const blocked = await studio({ storage: false });
  assert.match(await blocked.$eval("#profile-state", (n) => n.textContent), /unavailable/);
  await loadSample(blocked, "istanbul");
  await saveAs(blocked, "Session only");
  assert.equal(await blocked.$eval("#profile-select", (s) => s.selectedOptions[0].text), "Session only");
  assert.deepEqual(blocked.errors, []);
  await blocked.close();

  const damaged = await studio({ seed: { key: "lightning-replay-studio:profiles", value: "{not json" } });
  assert.match(await damaged.$eval("#profile-state", (n) => n.textContent), /unreadable/);
  await loadSample(damaged, "ankara");
  assert.equal((await snapshot(damaged)).events, 200);
  assert.deepEqual(damaged.errors, []);
  await damaged.close();
});

test("U6. Update can drop a saved map frame; the restore-frame choice resets with every selection", { timeout: 120000 }, async () => {
  const page = await studio();
  await loadSample(page, "istanbul");
  const profiles = () => page.evaluate(() => window.__studio.profileStore.list().map((p) => ({ name: p.name, frame: !!p.settings.frame })));
  const select = (index) => page.evaluate((i) => { const s = document.getElementById("profile-select"); s.selectedIndex = i; s.dispatchEvent(new Event("change", { bubbles: true })); }, index);
  const restore = () => page.$eval("#profile-restore-frame", (c) => c.checked);

  await page.click("#profile-save-frame");
  await saveAs(page, "Framed");
  await page.click("#profile-save-frame"); // back to unticked for the next save
  await saveAs(page, "Plain");
  assert.deepEqual(await profiles(), [{ name: "Framed", frame: true }, { name: "Plain", frame: false }]);

  // Update opens with the box showing what the profile has; unticking it really removes the frame.
  await select(1);
  await page.click('#profile-update');
  assert.equal(await page.$eval("#profile-save-frame", (c) => c.checked), true, "the form shows the profile's saved frame");
  await page.click("#profile-save-frame");
  await page.click("#profile-ok");
  assert.deepEqual(await profiles(), [{ name: "Framed", frame: false }, { name: "Plain", frame: false }], "frame removed");
  // Ticking it again saves the current frame; leaving it ticked keeps one.
  await page.click("#profile-update");
  await page.click("#profile-save-frame");
  await page.click("#profile-ok");
  assert.equal((await profiles())[0].frame, true);
  await page.click("#profile-update");
  assert.equal(await page.$eval("#profile-save-frame", (c) => c.checked), true);
  await page.click("#profile-ok");
  assert.equal((await profiles())[0].frame, true, "kept when left ticked");

  // Restore choice: never carried from one selection to the next.
  await select(1);
  assert.equal(await page.$eval("#profile-restore-row", (r) => r.hidden), false);
  await page.click("#profile-restore-frame");
  assert.equal(await restore(), true);
  await select(2);
  assert.equal(await page.$eval("#profile-restore-row", (r) => r.hidden), true, "a profile without a frame offers nothing");
  await select(1);
  assert.equal(await restore(), false, "back on the framed profile it is unchecked again");
  await page.click("#profile-restore-frame");
  await select(0);
  await select(1);
  assert.equal(await restore(), false, "also after clearing the selection");
  assert.deepEqual(page.errors, []);
  await page.close();
});
