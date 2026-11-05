// The Sound tab: turns the loaded replay into music (the Lightning Sound Lab engine, src/sound/).
// It never changes the replay: it reads the replay model's strikes and follows the preview's transport.
// Timing comes from the replay's own time map, so every note starts on the first video frame that shows
// its strike (src/sound/events.js).
import {
  INSTRUMENTS, ROOT_NAMES, SCALES, SOUND_PRESETS, VARIATION_MODES, buildPool, noteName, randomMusic,
} from "/src/sound/music.js";
import { boundsSizeKm, formatBounds } from "/src/sound/geo.js";
import { listeningArea } from "/src/sound/area.js";
import { soundEvents, strikeVoicing } from "/src/sound/events.js";
import { SoundPlayer } from "/src/sound/player.js";
import { MAX_STARTS_PER_SECOND } from "/src/sound/performer.js";
import { STUDIO_A, STUDIO_B, defaultSoundSettings, loadSoundSettings, saveSoundSettings, studioMusic } from "/src/sound/settings.js";
import { drawViz } from "./sound-viz.js";
import { drawGeo } from "./sound-geoviz.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (v) => `${Math.round(v * 100)}%`;

const SLIDERS = [
  { key: "length", label: "Note length", tip: "How long each note rings before fading away.", min: 0.25, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
  { key: "lowOctave", label: "Pitch height", tip: "Where the lowest note sits.", min: 1, max: 6, step: 1, fmt: (v) => `octave ${v}` },
  { key: "spread", label: "Pitch range", tip: "How many octaves above the lowest note may be used.", min: 1, max: 4, step: 1, fmt: (v) => `${v} oct` },
  { key: "reverb", label: "Reverb", tip: "The sense of space around the sound.", min: 0, max: 1, step: 0.01, fmt: pct },
  { key: "polyphony", label: "Max notes at once", tip: "The most notes allowed to ring together. When it is full, the oldest (or quietest) note fades quickly to make room.", min: 1, max: 24, step: 1, fmt: (v) => `${v}` },
  { key: "volume", label: "Volume", tip: "Overall loudness. A safety limiter always protects against harsh peaks.", min: 0, max: 1, step: 0.01, fmt: pct },
];

const NOTE_MODE_TEXT = {
  random: "Each strike picks a note from its own seeded random numbers. Positions are not used for the sound.",
  geographic: "Latitude chooses the note (north = higher), longitude the stereo position (west = left, east = right).",
};
const VARIATION_TEXT = {
  strict: { label: "Strict", hint: "Every strike plays its geographic note exactly." },
  natural: { label: "Natural", hint: "Same notes. Repeated notes vary in loudness and length, and ring shorter when strikes come fast." },
  rich: { label: "Rich", hint: "Natural, plus a quiet, short chord-tone note below the main note on some repeats (◇). It never replaces a main note." },
};
const AREA_TEXT = {
  data: "The dataset's own capture area, or an area suggested from its strikes. Panning or zooming the map does not change the sound.",
  frame: "The video's map frame: the top edge of the picture is the highest note, the left edge is the left ear. It follows the frame you set in the Video tab.",
};

const PANEL_HTML = `
<section>
  <h2>Sound <span id="snd-pill" class="pill">off</span></h2>
  <label class="check" title="Play the notes with the replay preview"><input type="checkbox" id="snd-enabled" /> Play sound with the replay</label>
  <p class="note" id="snd-enabled-note"></p>
  <span class="sub-h">Compare</span>
  <div class="seg two" id="snd-slots" role="radiogroup" aria-label="Sound slot">
    <button type="button" role="radio" data-slot="A" title="Hear and edit sound A"><b>A</b><em id="snd-sub-A"></em></button>
    <button type="button" role="radio" data-slot="B" title="Hear and edit sound B"><b>B</b><em id="snd-sub-B"></em></button>
  </div>
  <div class="row">
    <button type="button" class="secondary" id="snd-a2b" title="Copy all of A's settings to B">Copy A → B</button>
    <button type="button" class="secondary" id="snd-b2a" title="Copy all of B's settings to A">Copy B → A</button>
  </div>
  <p class="note">A and B play exactly the same strikes. Switch between them while it plays and listen for the difference. The controls below edit the slot you hear.</p>
</section>

<section>
  <h2>Notes <em class="snd-editing"></em></h2>
  <span class="sub-h">Note source</span>
  <div class="seg two" id="snd-notemode" role="radiogroup" aria-label="Note source">
    <button type="button" role="radio" data-notemode="geographic" title="${esc(NOTE_MODE_TEXT.geographic)}">Geographic</button>
    <button type="button" role="radio" data-notemode="random" title="${esc(NOTE_MODE_TEXT.random)}">Random notes</button>
  </div>
  <p class="note" id="snd-notemode-note"></p>
  <span class="sub-h">Variation <em>Geographic + Musical</em></span>
  <div class="seg three compact" id="snd-variation" role="radiogroup" aria-label="Variation">
    ${VARIATION_MODES.map((v) => `<button type="button" role="radio" data-variation="${v}" title="${esc(VARIATION_TEXT[v].hint)}">${VARIATION_TEXT[v].label}</button>`).join("")}
  </div>
  <p class="note" id="snd-variation-note"></p>
  <span class="sub-h">Listening area</span>
  <div class="seg two" id="snd-area" role="radiogroup" aria-label="Listening area">
    <button type="button" role="radio" data-area="data" title="${esc(AREA_TEXT.data)}">Data area</button>
    <button type="button" role="radio" data-area="frame" title="${esc(AREA_TEXT.frame)}">Map frame</button>
  </div>
  <div class="map-state" id="snd-area-info"></div>
  <p class="note" id="snd-area-note"></p>
</section>

<section>
  <h2>Sound character <em class="snd-editing"></em></h2>
  <span class="sub-h">Listening mode</span>
  <div class="seg two" id="snd-mode" role="radiogroup" aria-label="Listening mode">
    <button type="button" role="radio" data-mode="musical" title="Gentle musical organisation on top of the strikes">Musical</button>
    <button type="button" role="radio" data-mode="raw" title="Every strike plays exactly when it happens">Raw</button>
  </div>
  <p class="note" id="snd-mode-note"></p>
  <span class="sub-h">Instrument</span>
  <div class="seg two" id="snd-inst" role="radiogroup" aria-label="Instrument">
    ${Object.entries(INSTRUMENTS).map(([k, v]) => `<button type="button" role="radio" data-inst="${k}" title="${esc(v.blurb)}">${esc(v.name)}<em>${esc(v.blurb)}</em></button>`).join("")}
  </div>
  <span class="sub-h">Scale &amp; key</span>
  <div class="row snd-scale">
    <select id="snd-scale" aria-label="Scale">${Object.entries(SCALES).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join("")}</select>
    <select id="snd-root" aria-label="Key">${ROOT_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join("")}</select>
  </div>
  <p class="note" id="snd-scale-note"></p>
  ${SLIDERS.map((s) => `<label class="field" title="${esc(s.tip)}"><span>${s.label} <em id="snd-${s.key}-val"></em></span><input type="range" id="snd-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" /></label>`).join("")}
</section>

<section>
  <h2>Starting points <em class="snd-editing"></em></h2>
  <div class="chips" id="snd-presets">
    ${SOUND_PRESETS.map((p, i) => `<button type="button" class="secondary" data-preset="${i}" title="${esc(p.hint)}">${esc(p.name)}</button>`).join("")}
  </div>
  <div class="row">
    <button type="button" class="secondary" id="snd-random" title="A random instrument, scale and character for this slot (note source, variation, voices and volume are kept)">🎲 Surprise me</button>
    <button type="button" class="secondary" id="snd-reset" title="Both slots back to the defaults">Reset sound</button>
  </div>
  <p class="note" id="snd-storage-note"></p>
</section>`;

const VIZ_HTML = `
<div class="events-head">
  <h2>Sound <span id="snd-now"></span></h2>
  <div class="snd-meters">
    <span class="meter" title="Output level">Level <span class="bar"><i id="snd-level"></i></span></span>
    <span title="Notes ringing right now">Notes <b id="snd-voices">0</b></span>
    <span id="snd-thin-wrap" hidden title="Very dense timing: at most ${MAX_STARTS_PER_SECOND} notes start per second. Strikes held back since the last start are counted here; they still flash in the video.">Held back <b id="snd-thinned">0</b></span>
    <span class="lim" id="snd-limiter" title="Lights up when the safety limiter is gently turning peaks down">Limiter</span>
  </div>
</div>
<div class="snd-body">
  <canvas id="snd-notes" aria-label="Strikes (top) and the notes they played (bottom) over the video's time"></canvas>
  <div class="snd-geo-wrap">
    <canvas id="snd-geo" aria-label="Schematic plot of the listening area and the note ladder"></canvas>
  </div>
</div>
<p class="note snd-legend"><span style="color:#fff1b8">▎</span> strike &nbsp;<span style="color:rgb(108,196,255)">●</span> A note &nbsp;<span style="color:rgb(255,200,87)">●</span> B note &nbsp;◇ shadow note (Rich) &nbsp;· geographic plot: up = north, right = east, faint bands = note steps</p>`;

/**
 * @param {object} o
 * @param {HTMLElement} o.panel    sidebar container for the controls
 * @param {HTMLElement} o.viz      container below the preview for the note plots
 * @param {Storage|null} o.storage browser storage for the settings
 * @param {(enabled: boolean) => void} o.onEnabledChange sound switched on / off
 */
export function createSoundTab({ panel, viz, storage, onEnabledChange }) {
  panel.innerHTML = PANEL_HTML;
  viz.innerHTML = VIZ_HTML;
  const $ = (id) => document.getElementById(id);
  const all = (sel) => [...panel.querySelectorAll(sel)];

  const s = loadSoundSettings(storage);
  let stored = saveSoundSettings(storage, s);
  const cur = () => s.slots[s.active];

  // replay-derived state
  let model = null, dataset = null, frame = null;
  let voicing = null, voicingOf = null;
  let events = [];
  let area = null;
  let eventsKey = "";
  let notes = []; // played in the current run (for the plots)
  let peak = 0;

  const player = new SoundPlayer({
    getMusic: cur,
    onNote(n) {
      notes.push({ simT: n.simT, midi: n.midi, vel: n.vel, time: n.time, length: n.length, slot: s.active, ev: n.eventIndex, pan: n.pan, geographic: n.geographic, shadow: n.shadow ? { midi: n.shadow.midi, length: n.shadow.length } : undefined });
      if (notes.length > 900) notes.shift();
    },
  });

  function persist() {
    stored = saveSoundSettings(storage, s);
  }

  function refreshArea() {
    if (!dataset?.ok) { area = null; return; }
    area = listeningArea(s.area, dataset, frame);
    player.setBounds(area.bounds);
  }

  /** New replay model (dataset, duration, time range, …). Returns true when the strikes' timing changed. */
  function setReplay(nextModel, nextDataset, nextFrame) {
    model = nextModel;
    frame = nextFrame ?? null;
    if (nextDataset !== dataset) { dataset = nextDataset; voicing = null; }
    if (!model || !dataset?.ok) { events = []; area = null; eventsKey = ""; sync(); return false; }
    if (!voicing || voicingOf !== dataset) { voicing = strikeVoicing(dataset); voicingOf = dataset; }
    const tm = model.timeMap;
    const key = [dataset.events.length, voicing.seed, tm.startMs, tm.endMs, tm.duration, model.settings.fps, model.events.length].join("|");
    const changed = key !== eventsKey;
    eventsKey = key;
    if (changed) events = soundEvents(model, voicing);
    refreshArea();
    player.setEvents(events, voicing.seed, area?.bounds ?? null);
    sync();
    return changed;
  }

  /** The video's map frame moved (only matters when the listening area is the map frame). */
  function setFrame(nextFrame) {
    frame = nextFrame ?? null;
    if (s.area === "frame") { refreshArea(); syncArea(); }
  }

  /* ---------- controls ---------- */
  const pressed = (sel, attr, value) => all(sel).forEach((b) => b.setAttribute("aria-checked", String(b.dataset[attr] === String(value))));
  const describe = (c) => `${INSTRUMENTS[c.instrument].name} · ${SCALES[c.scale].name} in ${ROOT_NAMES[c.root]} · ${c.noteMode === "geographic" ? "geographic" : "random notes"}`;

  function syncArea() {
    pressed("[data-area]", "area", s.area);
    const info = $("snd-area-info");
    if (!area) {
      info.textContent = "No dataset loaded.";
    } else {
      const b = area.bounds, size = boundsSizeKm(b), pool = buildPool(cur()), n = pool.length;
      const origin = { file: "capture area stated in the file", suggested: "suggested from the strikes", frame: "the video's map frame" }[area.origin];
      info.innerHTML = [
        esc(formatBounds(b)),
        `≈ ${size.height.toFixed(0)} km N–S × ${size.width.toFixed(0)} km W–E · ${esc(origin)}`,
        `Ladder: ${n} notes (${noteName(pool[0].midi)}–${noteName(pool[n - 1].midi)}), ≈ ${(size.height / n).toFixed(1)} km per note`,
      ].map((l) => `<div>${l}</div>`).join("");
    }
    $("snd-area-note").textContent =
      AREA_TEXT[s.area] +
      (area?.fallback ? " No map frame yet, so the data area is used for now." : "") +
      (cur().noteMode !== "geographic" ? " (Used by Geographic Mapping only.)" : "");
  }

  function sync() {
    const c = cur();
    $("snd-enabled").checked = s.enabled;
    $("snd-pill").textContent = s.enabled ? `on · ${s.active}` : "off";
    $("snd-pill").classList.toggle("custom", !s.enabled);
    $("snd-enabled-note").textContent = s.enabled
      ? "Every note starts on the first video frame that shows its strike. Play the preview to hear it."
      : "Sound is off: the preview and the video stay silent.";
    pressed("[data-slot]", "slot", s.active);
    for (const k of ["A", "B"]) $(`snd-sub-${k}`).textContent = describe(s.slots[k]);
    for (const el of panel.querySelectorAll(".snd-editing")) el.textContent = `· editing ${s.active}`;
    pressed("[data-notemode]", "notemode", c.noteMode);
    $("snd-notemode-note").textContent = NOTE_MODE_TEXT[c.noteMode];
    pressed("[data-variation]", "variation", c.variation);
    const applies = c.noteMode === "geographic" && c.mode === "musical";
    $("snd-variation-note").textContent = VARIATION_TEXT[c.variation].hint + (applies || c.variation === "strict" ? "" : " Not active now: it applies to Geographic Mapping in Musical mode.");
    pressed("[data-mode]", "mode", c.mode);
    $("snd-mode-note").textContent = c.mode === "musical"
      ? "Musical: gentle dynamics; tiny weak flams within 50 ms are thinned out; a note that would rub against a ringing one plays softer."
      : "Raw: every strike plays, limited only by Max notes at once.";
    pressed("[data-inst]", "inst", c.instrument);
    $("snd-scale").value = c.scale;
    $("snd-root").value = String(c.root);
    $("snd-scale-note").textContent = SCALES[c.scale].hint;
    for (const sl of SLIDERS) {
      const el = $(`snd-${sl.key}`);
      if (document.activeElement !== el) el.value = String(c[sl.key]);
      $(`snd-${sl.key}-val`).textContent = sl.fmt(Number(c[sl.key]));
    }
    $("snd-storage-note").textContent = stored ? "" : "Browser storage is blocked: sound settings last for this session only.";
    syncArea();
  }

  function afterChange() {
    player.applyLive(cur());
    persist();
    sync();
  }

  $("snd-enabled").addEventListener("change", (e) => setEnabled(e.target.checked));
  function setEnabled(on) {
    if (s.enabled === on) return;
    s.enabled = on;
    persist();
    sync();
    onEnabledChange(on);
  }
  panel.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    const d = b.dataset;
    if (d.slot) { s.active = d.slot; afterChange(); }
    else if (d.notemode) { cur().noteMode = d.notemode; afterChange(); }
    else if (d.variation) { cur().variation = d.variation; afterChange(); }
    else if (d.area) { s.area = d.area; refreshArea(); afterChange(); }
    else if (d.mode) { cur().mode = d.mode; afterChange(); }
    else if (d.inst) { cur().instrument = d.inst; afterChange(); }
    else if (d.preset) { s.slots[s.active] = studioMusic({ ...cur(), ...SOUND_PRESETS[Number(d.preset)].cfg }, cur()); afterChange(); }
    else if (b.id === "snd-a2b") { s.slots.B = { ...s.slots.A }; afterChange(); }
    else if (b.id === "snd-b2a") { s.slots.A = { ...s.slots.B }; afterChange(); }
    else if (b.id === "snd-random") {
      const c = cur();
      s.slots[s.active] = studioMusic({ ...randomMusic(Math.random, c.mode), noteMode: c.noteMode, variation: c.variation, polyphony: c.polyphony, volume: c.volume }, c);
      afterChange();
    } else if (b.id === "snd-reset") {
      const d0 = defaultSoundSettings();
      s.slots = d0.slots;
      s.active = "A";
      s.area = d0.area;
      refreshArea();
      afterChange();
    }
  });
  $("snd-scale").addEventListener("change", (e) => { cur().scale = e.target.value; afterChange(); });
  $("snd-root").addEventListener("change", (e) => { cur().root = Number(e.target.value); afterChange(); });
  for (const sl of SLIDERS) {
    $(`snd-${sl.key}`).addEventListener("input", (e) => {
      cur()[sl.key] = Number(e.target.value);
      s.slots[s.active] = studioMusic(cur(), s.active === "A" ? STUDIO_A : STUDIO_B);
      afterChange();
    });
  }

  /* ---------- transport ---------- */
  /** Start sounding from video time t (no-op while sound is off). */
  function start(t) {
    notes = notes.filter((n) => n.simT < t - 1e-6);
    if (!s.enabled || !events.length) return Promise.resolve();
    return player.start(t);
  }

  /* ---------- plots ---------- */
  const notesCanvas = $("snd-notes"), geoCanvas = $("snd-geo");
  function draw(t) {
    if (viz.hidden) return;
    const c = cur();
    const now = player.audioContext?.currentTime ?? 0;
    const pool = buildPool(c);
    const lo = pool[0]?.midi ?? 48, hi = pool[pool.length - 1]?.midi ?? 84;
    const shown = notes.filter((n) => n.simT <= t + 1e-6);
    const last = shown[shown.length - 1];
    const flash = last && player.running ? Math.max(0, 1 - (now - last.time) / 0.35) : 0;
    drawViz(notesCanvas, events, shown, t, now, [lo - 2, hi + 2], flash, model?.settings.duration ?? 20);
    drawGeo(geoCanvas, {
      bounds: area?.bounds ?? null, events, pos: t, now, notes: shown,
      ladder: c.noteMode === "geographic" ? pool.map((p) => p.midi) : null, slot: s.active,
    });
    meters(now);
    $("snd-now").textContent = s.enabled ? `· hearing ${s.active} · ${describe(c)}` : "· off";
  }

  const buf = new Float32Array(1024);
  function meters(now) {
    const perf = player.performer, an = player.level;
    let level = 0;
    if (an && player.running) {
      an.getFloatTimeDomainData(buf);
      for (const x of buf) level = Math.max(level, Math.abs(x));
    }
    peak = Math.max(level, peak * 0.9);
    $("snd-level").style.width = `${Math.min(100, peak * 100)}%`;
    $("snd-voices").textContent = perf ? String(perf.activeVoices(now)) : "0";
    $("snd-limiter").classList.toggle("on", !!perf && player.running && perf.limiter.reduction < -1);
    const thinned = perf?.thinned ?? 0;
    $("snd-thin-wrap").hidden = thinned === 0;
    $("snd-thinned").textContent = String(thinned);
  }

  sync();
  return {
    setReplay,
    setFrame,
    start,
    stop: (o) => player.stop(o),
    position: () => player.position(),
    get running() { return player.running; },
    enabled: () => s.enabled,
    setEnabled,
    draw,
    player,
    settings: s,
    /** The current events, listening area and seed (for tests and checks in the browser). */
    snapshot: () => ({ events, area, seed: voicing?.seed ?? null, music: { ...cur() } }),
  };
}
