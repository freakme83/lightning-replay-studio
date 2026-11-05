// The bridge between the replay and the sound: turns the replay model's strikes into the events the
// Performer plays. Timing comes ONLY from the replay's own time map (src/core/timeline.js), so a note
// can never drift from the strike it belongs to, in the preview or in an export.
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
 * The strikes of a replay model as sound events, in time order.
 * Each note starts exactly on the first video frame that shows its strike's flash, so sound and picture
 * meet on the same frame. Strikes on the same frame sound together. Flash grouping (bursts) follows the
 * playback gaps, because that is what the ear perceives after stretching or squeezing the storm.
 * @returns {readonly import("./performer.js").SoundEvent[]}
 */
export function soundEvents(model, voicing) {
  const fps = model.settings.fps;
  const times = model.events.map((e) => flashTime(model.timeMap, e.v, fps));
  const { index: burstIndex, size: burstSize } = groupBursts(times);
  return Object.freeze(
    model.events.map((e, i) =>
      Object.freeze({
        t: times[i],
        strike: e.index,
        ...(voicing.byIndex.get(e.index) ?? { strength: 0.5, pitchRand: 0.5, velRand: 0.5, pan: 0 }),
        burstIndex: burstIndex[i],
        burstSize: burstSize[i],
        lat: e.lat,
        lon: e.lon,
      }),
    ),
  );
}
