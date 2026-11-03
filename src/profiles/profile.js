// Studio Profiles: a named, reusable composition. A profile holds the *look* of a video (format,
// quality, map layers and water appearance, overlays, per-format overlay layouts, HUD shading,
// grid, replay timing) and nothing about a particular storm: no strikes, no playback position, no
// images. The optional geographic frame is the one geography-specific field and is only present
// when the user asked to save it.
//
//   { schemaVersion: 1, id, name, createdAt, updatedAt, settings }
//
// Everything here is pure and DOM-free, so the browser Studio and the tests share it. All input
// (storage, imported files) is untrusted: it is parsed with a size cap and every field is passed
// through the same normalizers the rest of the application uses.
import { FORMATS, QUALITIES, DEFAULT_FORMAT, DEFAULT_QUALITY } from "../core/format.js";
import { normalizeOverlays } from "../core/overlays.js";
import { normalizeLayout, DEFAULT_SHADING } from "../core/hud.js";
import { validateBounds } from "../core/projection.js";
import { DEFAULTS } from "../core/replay.js";
import { normalizeLayers } from "../map/layers.js";

export const PROFILE_SCHEMA_VERSION = 1;
/** Marker of an exported file, so a random JSON file is recognised as "not a profile". */
export const PROFILE_FILE_KIND = "lightning-replay-studio-profile";
export const PROFILE_LIMITS = Object.freeze({ maxBytes: 256 * 1024, nameLength: 60, maxProfiles: 50 });

export class ProfileError extends Error {}

const FORMAT_IDS = Object.keys(FORMATS);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;
const finite = (v) => v !== null && v !== "" && v !== undefined && typeof v !== "object" && Number.isFinite(+v);
const num = (v, lo, hi, fallback, digits = 4) => (finite(v) ? round(clamp(+v, lo, hi), digits) : fallback);
const flag = (v, fallback) => (v === true || v === "true" ? true : v === false || v === "false" ? false : fallback);
const plain = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** Display name from untrusted text: printable characters only, single spaces, at most 60 characters. */
export function cleanName(input) {
  const s = typeof input === "string" ? input : "";
  const name = [...s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim()].slice(0, PROFILE_LIMITS.nameLength).join("").trim();
  return name || "Untitled profile";
}

/** Name that does not collide (case-insensitively) with `taken`: "Name", "Name (2)", "Name (3)", … */
export function uniqueName(name, taken) {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  const base = cleanName(name);
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`;
    const candidate = [...base].slice(0, PROFILE_LIMITS.nameLength - suffix.length).join("").trimEnd() + suffix;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

function normalizeFrame(f) {
  if (!f || typeof f !== "object") return null;
  const b = { west: +f.west, south: +f.south, east: +f.east, north: +f.north };
  if (![b.west, b.south, b.east, b.north].every(Number.isFinite) || validateBounds(b)) return null;
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, round(v, 5)]));
}

/**
 * Complete, valid settings from any input. Unknown and obsolete fields are dropped, out-of-range
 * numbers are clamped, anything missing or malformed falls back to the application default, so a
 * profile saved by an older Studio still applies and a damaged one never reaches the app as-is.
 * `frame` is present only when the input carries a valid geographic frame.
 */
export function normalizeProfileSettings(input) {
  const s = plain(input), replay = plain(s.replay), grid = plain(s.grid), layouts = plain(s.overlayLayouts);
  const out = {
    format: FORMATS[s.format] ? s.format : DEFAULT_FORMAT,
    quality: QUALITIES[s.quality] ? s.quality : DEFAULT_QUALITY,
    mapLayers: normalizeLayers(s.mapLayers),
    overlays: normalizeOverlays(s.overlays),
    overlayLayouts: Object.fromEntries(FORMAT_IDS.map((f) => [f, normalizeLayout(plain(layouts[f]))])),
    hudShading: num(s.hudShading, 0, 1, DEFAULT_SHADING, 2),
    grid: { visible: flag(grid.visible, DEFAULTS.showGrid), opacity: num(grid.opacity, 0, 1, DEFAULTS.gridOpacity, 2) },
    replay: {
      duration: num(replay.duration, 2, 3600, DEFAULTS.duration, 2),
      trailMinutes: num(replay.trailMinutes, 0, 1440, DEFAULTS.trailMinutes, 2),
      markerScale: num(replay.markerScale, 0.25, 4, DEFAULTS.markerScale, 2),
      showHistory: flag(replay.showHistory, DEFAULTS.showHistory),
    },
  };
  const frame = normalizeFrame(s.frame);
  if (frame) out.frame = frame;
  return out;
}

/** The settings of the current Studio state (see app/app.js); the frame only when `includeFrame` and one exists. */
export function captureSettings(current, { includeFrame = false } = {}) {
  return normalizeProfileSettings({
    format: current.format,
    quality: current.quality,
    mapLayers: current.mapLayers,
    overlays: current.overlays,
    overlayLayouts: current.overlayLayouts,
    hudShading: current.hudShading,
    grid: current.grid,
    replay: current.replay,
    frame: includeFrame ? current.frame : null,
  });
}

/** The same settings as the flat fields the replay builder and the exporter take (see readSettings in app.js). */
export function toReplaySettings(settings) {
  const s = normalizeProfileSettings(settings);
  return {
    format: s.format,
    quality: s.quality,
    duration: s.replay.duration,
    trailMinutes: s.replay.trailMinutes,
    markerScale: s.replay.markerScale,
    showHistory: s.replay.showHistory,
    overlays: s.overlays,
    overlayLayout: s.overlayLayouts[s.format],
    hudShading: s.hudShading,
    showGrid: s.grid.visible,
    gridOpacity: s.grid.opacity,
  };
}

/** Do two settings objects describe the same composition? (`frame` counts only when both saved one.) */
export function sameSettings(a, b) {
  const x = normalizeProfileSettings(a), y = normalizeProfileSettings(b);
  if (!(x.frame && y.frame)) delete x.frame, delete y.frame;
  return JSON.stringify(x) === JSON.stringify(y);
}

const isoOrNow = (v, now) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : now);

/**
 * A complete profile record from untrusted input. Throws ProfileError when it is not a profile at
 * all (wrong shape, or written by a newer schema this Studio cannot read).
 */
export function normalizeProfile(input, { now = new Date().toISOString(), newId = () => globalThis.crypto?.randomUUID?.() ?? `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ProfileError("This is not a Studio profile.");
  if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) throw new ProfileError("Not a Studio profile: it has no schema version.");
  if (input.schemaVersion > PROFILE_SCHEMA_VERSION)
    throw new ProfileError(`This profile was made by a newer Studio (schema ${input.schemaVersion}); this one reads schema ${PROFILE_SCHEMA_VERSION}.`);
  if (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings)) throw new ProfileError("The profile has no settings.");
  const id = typeof input.id === "string" && /^[\w-]{1,64}$/.test(input.id) ? input.id : newId();
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    id,
    name: cleanName(input.name),
    createdAt: isoOrNow(input.createdAt, now),
    updatedAt: isoOrNow(input.updatedAt, now),
    settings: normalizeProfileSettings(input.settings),
  };
}

/** Portable JSON text of one profile (a file any compatible Studio can import). */
export function serializeProfile(profile) {
  const p = normalizeProfile(profile);
  return JSON.stringify({ kind: PROFILE_FILE_KIND, ...p }, null, 2) + "\n";
}

/** Parse the text of an imported file. Throws ProfileError with a message fit for the user. */
export function parseProfileText(text, opts) {
  if (typeof text !== "string") throw new ProfileError("The file could not be read.");
  if (text.length > PROFILE_LIMITS.maxBytes || new TextEncoder().encode(text).length > PROFILE_LIMITS.maxBytes)
    throw new ProfileError(`The file is too large for a profile (limit ${PROFILE_LIMITS.maxBytes / 1024} KB).`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProfileError("The file is not valid JSON.");
  }
  // Files must carry the marker Export writes. (Profiles already in localStorage have none and are read by normalizeProfile directly.)
  if (!data || typeof data !== "object" || Array.isArray(data) || data.kind !== PROFILE_FILE_KIND)
    throw new ProfileError("This JSON file is not a Studio profile export (its \"kind\" marker is missing or different).");
  return normalizeProfile(data, opts);
}

/** Suggested file name for an export: lowercase words, no path characters. */
export const profileFileName = (name) => `${cleanName(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "profile"}.studio-profile.json`;
