// Live sound for the preview. It runs on the browser's precise audio clock and becomes the preview's
// clock while sound is on: the picture shows the video time that is being *heard* (the device's output
// latency and the limiter's look-ahead included), so a flash and its note meet even on slow (e.g.
// Bluetooth) outputs.
import { Performer } from "./performer.js";
import { measureChainDelay, noteTime } from "./render.js";

const LOOKAHEAD = 0.15; // seconds of audio scheduled in advance
const TICK_MS = 25;
const START_DELAY = 0.08; // a short gap so the first note is never scheduled in the past

/** First index whose event is at or after video time t. */
function lowerBound(events, t) {
  let lo = 0,
    hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t < t - 1e-6) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class SoundPlayer {
  /**
   * @param {{getMusic(): import("./music.js").MusicConfig, onNote?(n: import("./performer.js").PlayedNote): void}} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.ctx = null;
    this.perf = null;
    this.analyser = null;
    this.timer = null;
    this.events = [];
    this.seed = 0;
    this.bounds = null;
    this.running = false;
    this.from = 0; // video time the current run started at
    this.base = 0; // audio-clock time of video time 0 for the current run
    this.nextIdx = 0;
    this.chainDelay = 0; // seconds the output chain (limiter look-ahead) adds; measured once per audio context
  }

  get audioContext() { return this.ctx; }
  get performer() { return this.perf; }
  get level() { return this.analyser; }

  /** New strikes (another dataset, duration or time range) or listening area. A running pass continues from where it is. */
  setEvents(events, seed, bounds) {
    this.events = events;
    this.seed = seed;
    this.bounds = bounds;
    if (this.running) this.nextIdx = lowerBound(events, this.horizon() - this.base);
  }

  setBounds(bounds) { this.bounds = bounds; }

  applyLive(c) { this.perf?.applyLive(c); }

  /** Seconds between scheduling a note and hearing it: the device's output latency plus the output chain's delay. */
  latency() {
    const c = this.ctx;
    if (!c) return 0;
    const device = Number.isFinite(c.outputLatency) && c.outputLatency > 0 ? c.outputLatency : c.baseLatency || 0;
    return device + this.chainDelay;
  }

  /** Start sounding from video time `fromT`. Notes before it are skipped; the musical memory starts fresh. */
  async start(fromT) {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      this.perf = new Performer(this.ctx);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.perf.out.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      const Offline = globalThis.OfflineAudioContext;
      if (Offline) measureChainDelay(Offline, this.ctx.sampleRate).then((d) => (this.chainDelay = d), () => {});
    }
    this.stopTimer();
    this.perf.stopAll();
    this.perf.resetMemory();
    this.perf.applyLive(this.hooks.getMusic(), true);
    await this.ctx.resume();
    this.from = fromT;
    this.base = this.ctx.currentTime + START_DELAY - fromT;
    this.nextIdx = lowerBound(this.events, fromT);
    this.running = true;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  /** Video seconds being heard right now (never before the start point, while the first note is on its way). */
  position() {
    if (!this.running || !this.ctx) return this.from;
    return Math.max(this.from, this.ctx.currentTime - this.latency() - this.base);
  }

  /**
   * Stop scheduling. `ringOut` lets the notes already sounding fade naturally (end of the video);
   * otherwise they fade out quickly (pause, seek).
   */
  stop({ ringOut = false } = {}) {
    this.stopTimer();
    if (!this.running) return;
    this.running = false;
    this.from = this.position();
    if (!ringOut) this.perf?.stopAll();
  }

  async dispose() {
    this.stopTimer();
    this.running = false;
    const ctx = this.ctx;
    this.ctx = this.perf = this.analyser = null;
    if (ctx && ctx.state !== "closed") await ctx.close();
  }

  horizon() { return (this.ctx?.currentTime ?? 0) + LOOKAHEAD; }

  stopTimer() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const ctx = this.ctx, perf = this.perf;
    if (!ctx || !perf || !this.running) return;
    const now = ctx.currentTime, horizon = now + LOOKAHEAD;
    const music = this.hooks.getMusic();
    for (let guard = 0; guard < 400 && this.nextIdx < this.events.length; guard++) {
      const ev = this.events[this.nextIdx];
      const when = noteTime(ev, music, this.base);
      if (when > horizon) break;
      const note = perf.trigger(ev, this.nextIdx, Math.max(when, now + 0.005), music, this.seed, this.bounds);
      if (note) this.hooks.onNote?.(note);
      this.nextIdx++;
    }
  }
}
