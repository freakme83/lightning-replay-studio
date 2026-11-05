// The Sound tab's settings: two sound slots (A / B) to compare, which one is heard, the listening area
// choice and whether sound plays at all. Validated the same way wherever they come from (browser
// storage, a hand-edited file), so a bad value can never break the replay.
import { DEFAULT_A, DEFAULT_B, sanitizeMusic } from "./music.js";
import { AREA_CHOICES } from "./area.js";

/**
 * In the studio every strike has a position, so slot A starts with Geographic Mapping; B keeps Random Notes to compare.
 * Timing pull is always 0 here: it would delay Random Notes by up to 0.12 s (about three frames), and in the studio
 * every note must start on its strike's frame.
 */
export const STUDIO_A = Object.freeze({ ...DEFAULT_A, noteMode: "geographic", tightness: 0 });
export const STUDIO_B = Object.freeze({ ...DEFAULT_B, tightness: 0 });

/** A sound slot as the studio plays it (validated, timing pull off). */
export const studioMusic = (c, fallback) => ({ ...sanitizeMusic(c, fallback), tightness: 0 });

/**
 * @typedef {object} SoundSettings
 * @property {boolean} enabled  play sound with the replay
 * @property {"A"|"B"} active   the slot that is heard (and edited)
 * @property {{A: import("./music.js").MusicConfig, B: import("./music.js").MusicConfig}} slots
 * @property {"data"|"frame"} area listening area: the dataset's own area, or the video's map frame
 */

/** @returns {SoundSettings} */
export function defaultSoundSettings() {
  return { enabled: false, active: "A", slots: { A: { ...STUDIO_A }, B: { ...STUDIO_B } }, area: "data" };
}

/** @returns {SoundSettings} */
export function sanitizeSoundSettings(raw) {
  const d = defaultSoundSettings();
  if (!raw || typeof raw !== "object") return d;
  return {
    enabled: raw.enabled === true,
    active: raw.active === "B" ? "B" : "A",
    slots: { A: studioMusic(raw.slots?.A, STUDIO_A), B: studioMusic(raw.slots?.B, STUDIO_B) },
    area: AREA_CHOICES.includes(raw.area) ? raw.area : d.area,
  };
}

/** Sound can be exported for videos up to this long (the whole sound is rendered at once, in memory). */
export const SOUND_MAX_SECONDS = 600;

const KEY = "lightning-replay-studio:sound";

/** Settings from browser storage (defaults when storage is blocked, empty or unreadable). */
export function loadSoundSettings(storage) {
  try {
    const t = storage?.getItem(KEY);
    return t ? sanitizeSoundSettings(JSON.parse(t)) : defaultSoundSettings();
  } catch {
    return defaultSoundSettings();
  }
}

/** Returns false when browser storage is unavailable (the settings then live for this session only). */
export function saveSoundSettings(storage, s) {
  try {
    if (!storage) return false;
    storage.setItem(KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}
