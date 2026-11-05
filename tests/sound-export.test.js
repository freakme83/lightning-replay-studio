// Sound in exported MP4s (node --test tests/sound-export.test.js). SE3 and SE7 render real MP4s with HyperFrames.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfflineAudioContext } from "node-web-audio-api";
import { parseDataset } from "../src/core/parse.js";
import { buildReplay } from "../src/core/replay.js";
import { buildComposition, ROOT } from "../src/export/composition.js";
import { renderComposition, probeVideo, checkVideo } from "../src/export/render.js";
import { SOUND_EXPORT, exportSound, interleave, muxSound, renderExportSound, soundProblem } from "../src/export/sound.js";
import { soundEvents, strikeVoicing } from "../src/sound/events.js";
import { dataArea } from "../src/sound/area.js";
import { endFade, measureChainDelay, renderSound } from "../src/sound/render.js";
import { STUDIO_A, defaultSoundSettings } from "../src/sound/settings.js";
import {
  PROFILE_FILE_KIND, PROFILE_SCHEMA_VERSION, captureSettings, normalizeProfile, normalizeProfileSettings, parseProfileText, sameSettings, serializeProfile,
} from "../src/profiles/profile.js";
import { decodeRgb } from "./helpers.js";

const RATE = SOUND_EXPORT.sampleRate;
const on = (over = {}) => ({ ...defaultSoundSettings(), enabled: true, ...over });
/** Short, dry notes: every onset stands alone (marimba, short, no reverb, plenty of voices). */
const dry = (over = {}) => on({ slots: { A: { ...STUDIO_A, instrument: "marimba", length: 0.4, reverb: 0, polyphony: 24, mode: "raw" }, B: defaultSoundSettings().slots.B }, ...over });

/** Isolated cloud-to-ground strikes at known places and times (one per flash, far apart in time). */
function isolatedDataset(n = 6) {
  const events = Array.from({ length: n }, (_, i) => ({
    id: `s${i}`, timestamp: new Date(Date.UTC(2026, 10, 1, 12, 0, 0) + i * 9 * 60000).toISOString(),
    lat: 39.8 + 0.05 * (i % 4), lon: 32.6 + 0.09 * i, type: "CG",
  }));
  return { text: JSON.stringify(events), dataset: parseDataset(JSON.stringify(events), "isolated.json") };
}

/** First sample at or after `from` whose level reaches `frac` of the peak in [from, to] (seconds). */
function onset(d, from, to, frac = 0.1) {
  const a = Math.max(0, Math.round(from * RATE)), b = Math.min(d.length, Math.round(to * RATE));
  let peak = 0;
  for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(d[i]));
  for (let i = a; i < b; i++) if (Math.abs(d[i]) >= peak * frac) return i / RATE;
  return null;
}

test("SE1. an export asks for sound only when it is on; long videos are refused up front", () => {
  assert.equal(exportSound(null), null);
  assert.equal(exportSound(defaultSoundSettings()), null, "sound off = silent video");
  const s = exportSound(on({ active: "B", area: "frame" }));
  assert.equal(s.slot, "B");
  assert.equal(s.area, "frame");
  assert.equal(s.music.noteMode, "random", "the heard slot's settings");
  assert.equal(exportSound(on({ slots: { A: { volume: 7, tightness: 1 } } })).music.volume, 1, "validated");
  assert.equal(exportSound(on({ slots: { A: { tightness: 1 } } })).music.tightness, 0, "no timing pull");
  assert.equal(soundProblem(600, s), null);
  assert.match(soundProblem(601, s), /up to 10 minutes/);
  assert.equal(soundProblem(3600, null), null, "a silent export has no length limit");
  assert.deepEqual(SOUND_EXPORT, { sampleRate: 48000, channels: 2, codec: "aac", bitrate: "256k", maxDuration: 600 });
  const pcm = interleave([new Float32Array([1, 2]), new Float32Array([3, 4])]);
  assert.deepEqual([...new Float32Array(pcm.buffer, pcm.byteOffset, 4)], [1, 3, 2, 4]);
});

test("SE2. the export's sound is frame-aligned: the limiter's delay is removed and it is exactly as long as the video", async () => {
  const { dataset } = isolatedDataset();
  const model = buildReplay(dataset, { duration: 12 });
  const events = soundEvents(model, strikeVoicing(dataset), model.extent);
  assert.equal(events.length, 6);
  const r = await renderExportSound({ model, dataset, sound: exportSound(dry()) });
  assert.equal(r.channels.length, 2);
  assert.equal(r.channels[0].length, 12 * RATE, "exactly the video's length");
  const delay = await measureChainDelay(OfflineAudioContext, RATE);
  assert.ok(Math.abs(r.summary.alignedMs - delay * 1000) < 0.01);
  // Without alignment every onset is late by the chain delay; with it, onsets land on their frames.
  const raw = await renderSound({ OfflineAudioContext, events, music: exportSound(dry()).music, seed: strikeVoicing(dataset).seed, bounds: dataArea(dataset).bounds, duration: 12, fade: endFade(model.timeMap), sampleRate: RATE });
  const d = r.channels[0], u = raw.channels[0];
  for (const ev of events) {
    const aligned = onset(d, ev.t - 0.05, ev.t + 0.05), late = onset(u, ev.t - 0.05, ev.t + 0.05);
    assert.ok(Math.abs(aligned - ev.t) < 0.0015, `flash at ${ev.t.toFixed(3)} s: note heard at ${aligned.toFixed(4)} s`);
    assert.ok(Math.abs(late - ev.t - delay) < 0.0015, "the unaligned render is late by the chain delay");
  }
  const last = d.subarray(d.length - Math.round(0.005 * RATE));
  assert.ok(Math.max(...last.map(Math.abs)) < 1e-3, "it fades to silence at the end");
});

test("SE3. a real MP4: AAC 48 kHz stereo 256 kbit/s, exactly as long as the video, every note on its flash's frame", { timeout: 300000 }, async (tc) => {
  const dir = mkdtempSync(join(tmpdir(), "lr-sound-"));
  try {
    const { text } = isolatedDataset();
    const settings = { duration: 8, quality: "draft", trailMinutes: 0 };
    const { model, dataset } = buildComposition({ text, filename: "isolated.json", settings, outDir: join(dir, "comp") });
    const out = join(dir, "sound.mp4");
    const sound = exportSound(dry());
    const [audio] = await Promise.all([renderExportSound({ model, dataset, sound }), renderComposition({ dir: join(dir, "comp"), output: out, fps: 24, quality: "draft" })]);
    muxSound(out, audio, model.settings.duration);
    const probe = probeVideo(out);
    assert.deepEqual(checkVideo(probe, model.settings, { sound: true }), []);
    assert.equal(probe.audio.profile, "LC");
    assert.equal(audio.summary.bitrate, "256k", "encoded at 256 kbit/s (the measured average is lower for sparse, quiet sound)");
    assert.equal(probe.frames, 8 * 24, "the picture is untouched");

    // Decode the AAC back and find every note's onset; decode the frames around every flash.
    const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", out, "-f", "f32le", "-ac", "1", "-ar", String(RATE), "-"], { maxBuffer: 64e6 });
    const d = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
    assert.ok(Math.abs(d.length / RATE - 8) < 0.025, `decoded audio is ${d.length / RATE} s`);
    const fps = 24;
    for (const e of model.events) {
      const f = model.timeMap.frameOf(e.v, fps);
      // Picture: the flash core appears on frame f (bright at the strike's pixel), not on frame f - 1.
      const frames = join(dir, `f${f}-%d.png`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-i", out, "-vf", `select='between(n\\,${f - 1}\\,${f})'`, "-vsync", "0", frames]);
      const lum = (k) => { const img = decodeRgb(join(dir, `f${f}-${k}.png`)); const i = (Math.round(e.y) * img.width + Math.round(e.x)) * 3; return img.data[i] + img.data[i + 1] + img.data[i + 2]; };
      assert.ok(lum(2) > 600 && lum(1) < 300, `${e.id}: flash first drawn on frame ${f} (luminance ${lum(1)} → ${lum(2)})`);
      // Sound: the note starts on the same frame's time, through the AAC encoder and decoder.
      const t = onset(d, f / fps - 0.06, f / fps + 0.06);
      assert.ok(Math.abs(t - f / fps) < 0.004, `${e.id}: note heard at ${t.toFixed(4)} s, frame ${f} is at ${(f / fps).toFixed(4)} s`);
      tc.diagnostic(`${e.id}: flash on frame ${f} (${(f / fps).toFixed(4)} s), note onset ${((t - f / fps) * 1000).toFixed(2)} ms from it`);
    }
    const tail = d.subarray(d.length - Math.round(0.01 * RATE));
    assert.ok(Math.max(...tail.map(Math.abs)) < 0.01, "silent at the end of the video");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SE4. with sound off the MP4 stays silent; the check notices a missing or unexpected audio stream", { timeout: 300000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-silent-"));
  try {
    const { text } = isolatedDataset(3);
    const { model } = buildComposition({ text, filename: "isolated.json", settings: { duration: 2, quality: "draft" }, outDir: join(dir, "comp") });
    const out = join(dir, "silent.mp4");
    await renderComposition({ dir: join(dir, "comp"), output: out, fps: 24, quality: "draft" });
    const probe = probeVideo(out);
    assert.equal(probe.audio, null);
    assert.deepEqual(checkVideo(probe, model.settings, { sound: false }), []);
    assert.deepEqual(checkVideo(probe, model.settings, { sound: true }), ["no audio stream"]);
    assert.deepEqual(checkVideo(probe, model.settings), [], "audio is not checked unless asked");
    const fake = { ...probe, audio: { codec: "mp3", sampleRate: 44100, channels: 1, bitRate: 1, duration: 1.5, start: 0.2 } };
    assert.equal(checkVideo(fake, model.settings, { sound: true }).length, 5);
    assert.deepEqual(checkVideo(fake, model.settings, { sound: false }), ["an audio stream is present although sound was off"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SE5. the same data and settings give the same sound, sample for sample", async () => {
  const { dataset } = isolatedDataset();
  const model = buildReplay(dataset, { duration: 6 });
  const a = await renderExportSound({ model, dataset, sound: exportSound(on()) });
  const b = await renderExportSound({ model, dataset, sound: exportSound(on()) });
  assert.ok(a.channels.every((c, i) => Buffer.compare(Buffer.from(c.buffer), Buffer.from(b.channels[i].buffer)) === 0));
  assert.deepEqual(a.summary, b.summary);
  const other = await renderExportSound({ model, dataset, sound: exportSound(on({ active: "B" })) });
  assert.ok(Buffer.compare(Buffer.from(a.channels[0].buffer), Buffer.from(other.channels[0].buffer)) !== 0, "slot B sounds different");
});

test("SE6. Studio profiles (schema 2) carry the sound; schema 1 profiles load without it", () => {
  assert.equal(PROFILE_SCHEMA_VERSION, 2);
  const snd = on({ active: "B", area: "frame" });
  snd.slots.B = { ...snd.slots.B, instrument: "marimba", variation: "rich" };
  const settings = captureSettings({ format: "portrait", sound: snd });
  assert.deepEqual(settings.sound, snd);
  const p = normalizeProfile({ schemaVersion: 2, name: "With sound", settings });
  assert.equal(p.schemaVersion, 2);
  const back = parseProfileText(serializeProfile(p));
  assert.deepEqual(back.settings.sound, snd, "export → import keeps the sound");
  // Hostile or broken values are validated like everything else.
  const messy = normalizeProfileSettings({ sound: { enabled: "yes", active: "Z", area: "moon", slots: { A: { volume: 9, scale: "<b>" }, B: "x" } } });
  assert.equal(messy.sound.enabled, false);
  assert.equal(messy.sound.active, "A");
  assert.equal(messy.sound.area, "data");
  assert.equal(messy.sound.slots.A.volume, 1);
  assert.equal(messy.sound.slots.A.scale, STUDIO_A.scale);
  assert.equal(normalizeProfileSettings({ sound: [1, 2] }).sound, undefined);
  // A schema 1 profile (from before sound) has none and stays that way; it never counts as "modified" for sound.
  const old = normalizeProfile({ schemaVersion: 1, name: "Old", settings: { format: "square" } });
  assert.equal(old.schemaVersion, 2);
  assert.equal("sound" in old.settings, false);
  assert.ok(sameSettings(captureSettings({ format: "square", sound: snd }), old.settings));
  assert.ok(!sameSettings(captureSettings({ format: "square", sound: snd }), captureSettings({ format: "square", sound: on() })), "a sound change is a change");
  assert.ok(!sameSettings(captureSettings({ sound: snd }), captureSettings({ sound: { ...snd, enabled: false } })));
});

test("SE7. command line: --sound with a profile export file, and the length limit", { timeout: 300000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-cli-sound-"));
  try {
    const snd = on({ active: "B" });
    snd.slots.B = { ...snd.slots.B, instrument: "marimba" };
    const profile = join(dir, "look.studio-profile.json");
    writeFileSync(profile, serializeProfile(normalizeProfile({ schemaVersion: 2, name: "Look", settings: captureSettings({ sound: { ...snd, enabled: false } }) })));
    assert.equal(JSON.parse(readFileSync(profile, "utf8")).kind, PROFILE_FILE_KIND);
    const out = join(dir, "cli.mp4");
    const log = execFileSync("node", [join(ROOT, "scripts", "render.js"), join(ROOT, "data", "sample-ankara-storm.json"), "-o", out, "--duration", "3", "--quality", "draft", "--outline", "--sound", profile, "--sound-area", "frame"], { cwd: ROOT, maxBuffer: 64e6 }).toString();
    assert.match(log, /sound: slot B, marimba, random \(frame area\)/, "the profile's sound, switched on, with the area override");
    assert.match(log, /verify: OK .*audio/);
    assert.equal(probeVideo(out).audio.codec, "aac");
    let failed = null;
    try {
      execFileSync("node", [join(ROOT, "scripts", "render.js"), join(ROOT, "data", "sample-ankara-storm.json"), "-o", join(dir, "long.mp4"), "--duration", "601", "--outline", "--sound"], { cwd: ROOT, stdio: "pipe" });
    } catch (e) {
      failed = e;
    }
    assert.ok(failed && failed.status === 2 && /up to 10 minutes/.test(failed.stderr.toString()), "refused before rendering");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
