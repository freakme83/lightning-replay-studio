// Dataset parsing and validation for lightning-strike events (CSV or JSON).
// Runs unchanged in the browser, in Node and inside the HyperFrames composition.

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

const FIELD_ALIASES = {
  timestamp: ["timestamp", "time", "datetime", "date_time", "utc", "t"],
  lat: ["lat", "latitude", "y"],
  lon: ["lon", "lng", "long", "longitude", "x"],
  id: ["id", "strike_id", "event_id"],
  type: ["type", "kind", "stroke_type"],
  intensity: ["intensity", "amplitude", "peak_current", "kA", "ka"],
};

/**
 * Parse a timestamp into { ms, offsetMin } where offsetMin is the UTC offset
 * written in the source (null when the source had no offset).
 * Accepts ISO 8601 (with Z, ±HH:MM, ±HHMM or no offset) and numeric epoch
 * seconds / milliseconds. Returns null for anything invalid.
 */
export function parseTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || /^\s*-?\d+(\.\d+)?\s*$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    // Heuristic: values above 1e11 are milliseconds (1e11 s is year 5138).
    const ms = Math.abs(n) > 1e11 ? n : n * 1000;
    return { ms: Math.round(ms), offsetMin: null, epoch: true };
  }
  const m = ISO_RE.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "0", frac = "", tz] = m;
  const Y = +y, M = +mo, D = +d, H = +h, Mi = +mi, S = +s;
  if (M < 1 || M > 12 || D < 1 || D > 31 || H > 23 || Mi > 59 || S > 59) return null;
  const local = Date.UTC(Y, M - 1, D, H, Mi, S) + (frac ? Math.round(Number(frac) * 1000) : 0);
  // Reject impossible calendar dates such as 2026-02-30.
  const chk = new Date(Date.UTC(Y, M - 1, D));
  if (chk.getUTCFullYear() !== Y || chk.getUTCMonth() !== M - 1 || chk.getUTCDate() !== D) return null;
  let offsetMin = null;
  if (tz) {
    if (tz.toUpperCase() === "Z") offsetMin = 0;
    else {
      const sign = tz[0] === "-" ? -1 : 1;
      const digits = tz.slice(1).replace(":", "");
      const oh = +digits.slice(0, 2), om = digits.length > 2 ? +digits.slice(2, 4) : 0;
      if (oh > 14 || om > 59) return null;
      offsetMin = sign * (oh * 60 + om);
    }
  }
  return { ms: local - (offsetMin ?? 0) * 60000, offsetMin, epoch: false };
}

export function formatOffset(offsetMin) {
  const sign = offsetMin < 0 ? "-" : "+";
  const a = Math.abs(offsetMin);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** Wall-clock parts of `ms` in a fixed UTC offset (independent of the machine's timezone). */
export function formatLocal(ms, offsetMin = 0) {
  const d = new Date(ms + offsetMin * 60000);
  const p = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
    hm: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    zone: formatOffset(offsetMin),
  };
}

/** ISO 8601 string of `ms` written in the given offset, e.g. 2026-11-01T15:34:12+03:00. */
export function toIsoWithOffset(ms, offsetMin = 0) {
  const f = formatLocal(ms, offsetMin);
  return `${f.date}T${f.time}${offsetMin === 0 ? "Z" : f.zone.slice(3)}`;
}

/** Minimal RFC 4180 CSV reader. Lines starting with '#' before the header are metadata ("# key: value"). */
export function parseCsv(text) {
  const meta = {};
  const rows = [];
  let row = [], field = "", inQuotes = false, i = 0, lineStart = true;
  const src = text.replace(/^﻿/, "");
  while (i < src.length) {
    const c = src[i];
    if (lineStart && !inQuotes && rows.length === 0 && row.length === 0 && field === "" && c === "#") {
      const end = src.indexOf("\n", i);
      const line = src.slice(i + 1, end === -1 ? src.length : end).trim();
      const k = line.indexOf(":");
      if (k > 0) meta[line.slice(0, k).trim()] = line.slice(k + 1).trim();
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    lineStart = false;
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") {
      row.push(field); field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = []; i++; lineStart = true; continue;
    }
    field += c; i++;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  if (rows.length === 0) return { meta, records: [] };
  const header = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""])));
  return { meta, records };
}

function pick(record, key) {
  const lower = Object.fromEntries(Object.keys(record).map((k) => [k.toLowerCase().trim(), k]));
  for (const alias of FIELD_ALIASES[key]) {
    const k = lower[alias.toLowerCase()];
    if (k !== undefined && record[k] !== "" && record[k] !== null && record[k] !== undefined) return record[k];
  }
  return undefined;
}

function normalizeType(v) {
  if (v === undefined) return "unknown";
  const s = String(v).trim().toUpperCase();
  if (s === "CG" || s === "CLOUD-TO-GROUND" || s === "G") return "CG";
  if (s === "IC" || s === "INTRACLOUD" || s === "INTRA-CLOUD" || s === "CC" || s === "C") return "IC";
  return "unknown";
}

function coerceMeta(meta) {
  const out = { ...meta };
  if (typeof out.synthetic === "string") out.synthetic = /^(true|yes|1)$/i.test(out.synthetic);
  if (typeof out.intensityNormalized === "string") out.intensityNormalized = /^(true|yes|1)$/i.test(out.intensityNormalized);
  return out;
}

/**
 * Parse CSV or JSON text into a validated dataset.
 *
 * Rules (documented in README):
 *  - Required: timestamp, lat, lon. Optional: id, type (CG|IC|unknown), intensity.
 *  - Invalid records are rejected individually and reported; valid ones are kept.
 *  - Events are sorted by time; ties keep their original file order (stable).
 *  - No deduplication. Exact duplicates are only counted and reported.
 *  - Timestamps without an offset are interpreted as UTC and reported as a warning.
 */
export function parseDataset(text, filename = "") {
  const errors = [];
  const warnings = [];
  let meta = {};
  let records = [];
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { ok: false, events: [], errors: ["The file is empty."], warnings, meta, totalRecords: 0 };

  const looksJson = /\.json$/i.test(filename) || trimmed[0] === "[" || trimmed[0] === "{";
  if (looksJson) {
    let data;
    try { data = JSON.parse(trimmed); } catch (e) {
      return { ok: false, events: [], errors: [`Invalid JSON: ${e.message}`], warnings, meta, totalRecords: 0 };
    }
    if (Array.isArray(data)) records = data;
    else if (data && Array.isArray(data.events)) { records = data.events; meta = data.meta ?? {}; }
    else return { ok: false, events: [], errors: ['JSON must be an array of events or an object with an "events" array.'], warnings, meta, totalRecords: 0 };
  } else {
    ({ meta, records } = parseCsv(trimmed));
  }
  meta = coerceMeta(meta);

  const events = [];
  let naive = 0;
  records.forEach((rec, index) => {
    const where = looksJson ? `event #${index + 1}` : `CSV row ${index + 2}`;
    if (!rec || typeof rec !== "object") { errors.push(`${where}: not an object.`); return; }
    const tsRaw = pick(rec, "timestamp");
    const ts = parseTimestamp(tsRaw);
    if (!ts) { errors.push(`${where}: invalid or missing timestamp (${JSON.stringify(tsRaw ?? null)}).`); return; }
    const latRaw = pick(rec, "lat"), lonRaw = pick(rec, "lon");
    const lat = Number(latRaw), lon = Number(lonRaw);
    if (latRaw === undefined || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      errors.push(`${where}: invalid latitude (${JSON.stringify(latRaw ?? null)}), must be −90…90.`); return;
    }
    if (lonRaw === undefined || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      errors.push(`${where}: invalid longitude (${JSON.stringify(lonRaw ?? null)}), must be −180…180.`); return;
    }
    const intRaw = pick(rec, "intensity");
    let intensity = null;
    if (intRaw !== undefined) {
      intensity = Number(intRaw);
      if (!Number.isFinite(intensity)) { warnings.push(`${where}: non-numeric intensity ignored.`); intensity = null; }
    }
    const typeRaw = pick(rec, "type");
    const type = normalizeType(typeRaw);
    if (typeRaw !== undefined && type === "unknown" && !/^unknown$/i.test(String(typeRaw).trim())) {
      warnings.push(`${where}: unrecognised type ${JSON.stringify(typeRaw)} treated as unknown.`);
    }
    if (ts.offsetMin === null && !ts.epoch) naive++;
    const idRaw = pick(rec, "id");
    events.push({
      index,
      id: idRaw !== undefined ? String(idRaw) : `row-${index + 1}`,
      t: ts.ms,
      offsetMin: ts.offsetMin,
      lat, lon, type, intensity,
      raw: rec,
    });
  });

  if (naive) warnings.push(`${naive} timestamp(s) had no UTC offset and were interpreted as UTC.`);
  if (records.length === 0) errors.push("The dataset contains no events.");
  else if (events.length === 0) errors.push("No valid events: every record was rejected.");

  // Stable chronological sort; original order breaks ties.
  events.sort((a, b) => a.t - b.t || a.index - b.index);

  const seen = new Map();
  let dupes = 0;
  for (const e of events) {
    const key = `${e.t}|${e.lat}|${e.lon}`;
    if (seen.has(key)) dupes++; else seen.set(key, 1);
  }
  if (dupes) warnings.push(`${dupes} event(s) repeat the exact time and position of another event. They are kept (no automatic deduplication).`);

  // Display timezone: explicit meta.utcOffset, else the most common offset in the data, else UTC.
  let displayOffsetMin = 0;
  const explicit = meta.utcOffset !== undefined ? parseTimestamp(`2000-01-01T00:00:00${meta.utcOffset}`) : null;
  if (explicit && explicit.offsetMin !== null) displayOffsetMin = explicit.offsetMin;
  else {
    const counts = new Map();
    for (const e of events) if (e.offsetMin !== null) counts.set(e.offsetMin, (counts.get(e.offsetMin) ?? 0) + 1);
    let best = -1;
    for (const [k, v] of counts) if (v > best) { best = v; displayOffsetMin = k; }
    if (counts.size > 1) warnings.push(`Timestamps use ${counts.size} different UTC offsets; times are displayed in ${formatOffset(displayOffsetMin)}.`);
  }

  return {
    ok: events.length > 0,
    events,
    errors,
    warnings,
    meta,
    totalRecords: records.length,
    displayOffsetMin,
    timeRange: events.length ? { start: events[0].t, end: events[events.length - 1].t } : null,
  };
}
