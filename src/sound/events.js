// The bridge between the replay and the sound: turns the replay model's strikes into the events the
// Performer plays. Timing comes ONLY from the replay's own time map (src/core/timeline.js), so a note
// can never drift from the strike it belongs to, in the preview or in an export. The rule: every frame
// that shows a new flash in the picture is heard, and nothing is heard that the picture does not show.
import { mulberry32 } from "./rng.js";
import { groupBursts } from "./geo.js";

/**
 * Seed for all reproducible musical randomness of a dataset: a hash of every valid strike's time and
 * position (in the dataset's chronological order). Same file = same seed, on any machine.
 */
export function strikesSeed(events) {
  let h = 2166136261;
  for (const e of events) {
    for (const n of [Math.round(e.t), Math.round(e.lat * 1e5), Math.round(e.lon * 1e5)]) {
      h ^= n | 0;
      h = Math.imul(h, 16777619) >>> 0;
      h ^= Math.floor(n / 4294967296) | 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h % 1000000;
}

/**
 * The fixed "voicing" of every strike of a dataset: loudness and the random numbers Random Notes uses.
 * It is drawn once per dataset, in chronological order, and kept per strike (by its record index), so
 * changing the video duration or the event time range never changes how a strike sounds.
 * Strength is not in the data, so it is seeded random (as in Lightning Sound Lab).
 * @param {{events: {index:number, t:number, lat:number, lon:number}[]}} dataset parsed dataset (src/core/parse.js)
 */
export function strikeVoicing(dataset) {
  const seed = strikesSeed(dataset.events);
  const rng = mulberry32(Math.floor(seed) * 2654435761 + 17);
  const byIndex = new Map();
  for (const e of dataset.events) {
    byIndex.set(e.index, {
      strength: Math.min(1, Math.max(0.12, 0.3 + 0.7 * Math.pow(rng(), 0.7))),
      pitchRand: rng(),
      velRand: rng(),
      pan: (rng() * 2 - 1) * 0.7,
    });
  }
  return { seed, byIndex };
}

/** Video time of the first frame on which a strike at video time v is drawn (same rule as the preview and export). */
export const flashTime = (timeMap, v, fps) => timeMap.frameOf(v, fps) / fps;

/**
 * Is a strike inside the video frame? The frame is stored as the geographic edges of the whole picture (Web Mercator:
 * longitude and latitude are monotonic in x and y), so this is exactly "its projected position is in the picture".
 */
export const inPicture = (e, frame) => e.lat >= frame.south && e.lat <= frame.north && e.lon >= frame.west && e.lon <= frame.east;

/** Loudness of a frame's flash from the strikes on it: the strongest one, a little louder for a crowd (never above 1). */
export const flashStrength = (strengths) => Math.min(1, Math.max(...strengths) * (1 + 0.15 * Math.log2(strengths.length)));

/**
 * The strikes of a replay model as sound events: one event per video frame that shows a new flash, in time order.
 *  - Only strikes inside the video frame (`frame`, else the model's own extent) can be heard: no sound without a
 *    visible flash.
 *  - The event sounds exactly on that frame, so sound and picture meet on the same frame.
 *  - Strikes on the same frame are one flash: the strongest strike leads (its position, its random numbers), the
 *    others are its `members` (strongest first), and the flash is a little louder for a crowd.
 * Bursts (runs of flashes) follow the playback gaps, because that is what the ear perceives after stretching or
 * squeezing the storm.
 * @returns {readonly import("./performer.js").SoundEvent[]}
 */
export function soundEvents(model, voicing, frame = null) {
  const fps = model.settings.fps;
  const box = frame ?? model.extent;
  const fallback = { strength: 0.5, pitchRand: 0.5, velRand: 0.5, pan: 0 };
  const groups = new Map(); // frame number -> strikes on it (model order = time order)
  for (const e of model.events) {
    if (!inPicture(e, box)) continue;
    const f = model.timeMap.frameOf(e.v, fps);
    const strike = { e, voice: voicing.byIndex.get(e.index) ?? fallback };
    const g = groups.get(f);
    if (g) g.push(strike);
    else groups.set(f, [strike]);
  }
  const frames = [...groups.keys()]; // ascending: events are in time order and frameOf is monotonic
  const { index: burstIndex, size: burstSize } = groupBursts(frames.map((f) => f / fps));
  return Object.freeze(
    frames.map((f, i) => {
      const strikes = [...groups.get(f)].sort((a, b) => b.voice.strength - a.voice.strength || a.e.v - b.e.v);
      const [lead, ...rest] = strikes;
      return Object.freeze({
        t: f / fps,
        frame: f,
        strike: lead.e.index,
        strikes: Object.freeze(strikes.map((s) => s.e.index)),
        ...lead.voice,
        strength: flashStrength(strikes.map((s) => s.voice.strength)),
        burstIndex: burstIndex[i],
        burstSize: burstSize[i],
        lat: lead.e.lat,
        lon: lead.e.lon,
        members: Object.freeze(rest.map((s) => Object.freeze({ lat: s.e.lat, lon: s.e.lon, strength: s.voice.strength, strike: s.e.index }))),
      });
    }),
  );
}
