// Where Studio Profiles live: one namespaced localStorage key holding a versioned list.
//
//   localStorage["lightning-replay-studio:profiles"] =
//     { schemaVersion: 1, profiles: [ { schemaVersion, id, name, createdAt, updatedAt, settings }, … ], activeId }
//
// The store takes any Storage-like object. If it is missing, full, blocked or holds damaged data
// the Studio keeps working: profiles then live in memory for the session and `status()` says why.
import { PROFILE_LIMITS, PROFILE_SCHEMA_VERSION, ProfileError, cleanName, normalizeProfile, normalizeProfileSettings, parseProfileText, uniqueName } from "./profile.js";

export const PROFILE_STORAGE_KEY = "lightning-replay-studio:profiles";

export function createProfileStore(storage = null, { key = PROFILE_STORAGE_KEY, now = () => new Date().toISOString() } = {}) {
  let profiles = [];
  let activeId = null;
  let problem = null; // why the browser storage is not in use, for the UI
  let skipped = 0; // stored entries that could not be read

  const names = (except = null) => profiles.filter((p) => p.id !== except).map((p) => p.name);
  const find = (id) => profiles.find((p) => p.id === id) ?? null;
  const need = (id) => {
    const p = find(id);
    if (!p) throw new ProfileError("That profile no longer exists.");
    return p;
  };

  function persist() {
    if (!storage) return false;
    try {
      storage.setItem(key, JSON.stringify({ schemaVersion: PROFILE_SCHEMA_VERSION, profiles, activeId }));
      problem = null;
      return true;
    } catch (e) {
      problem = `Browser storage rejected the profiles (${e?.name ?? "error"}). They are kept for this session only.`;
      return false;
    }
  }

  function load() {
    profiles = [];
    activeId = null;
    skipped = 0;
    if (!storage) { problem = "Browser storage is unavailable. Profiles are kept for this session only."; return; }
    let raw;
    try {
      raw = storage.getItem(key);
    } catch {
      storage = null;
      problem = "Browser storage is unavailable. Profiles are kept for this session only.";
      return;
    }
    if (raw === null || raw === undefined) return;
    let data;
    try {
      if (raw.length > PROFILE_LIMITS.maxBytes * 8) throw new Error("too large");
      data = JSON.parse(raw);
    } catch {
      problem = "Saved profiles were unreadable and have been ignored.";
      return;
    }
    const list = Array.isArray(data?.profiles) ? data.profiles : [];
    const seen = new Set();
    for (const entry of list.slice(0, PROFILE_LIMITS.maxProfiles)) {
      try {
        const p = normalizeProfile(entry, { now: now() });
        if (seen.has(p.id)) throw new ProfileError("duplicate id");
        seen.add(p.id);
        p.name = uniqueName(p.name, names());
        profiles.push(p);
      } catch {
        skipped++;
      }
    }
    if (typeof data?.activeId === "string" && find(data.activeId)) activeId = data.activeId;
  }

  load();

  const full = () => {
    if (profiles.length >= PROFILE_LIMITS.maxProfiles) throw new ProfileError(`At most ${PROFILE_LIMITS.maxProfiles} profiles can be kept. Delete one first.`);
  };
  const free = (name, except = null) => {
    const clean = cleanName(name);
    if (names(except).some((n) => n.toLowerCase() === clean.toLowerCase())) throw new ProfileError(`A profile named “${clean}” already exists. Pick another name, or update that profile.`);
    return clean;
  };

  return {
    list: () => profiles.map((p) => structuredClone(p)),
    get: (id) => (find(id) ? structuredClone(find(id)) : null),
    activeId: () => activeId,
    status: () => ({ persistent: !!storage && !problem, problem, skipped }),
    reload: load,

    /** Save a new profile; a name that is already taken is an error (nothing is overwritten). */
    create(name, settings) {
      full();
      const t = now();
      const p = normalizeProfile({ schemaVersion: PROFILE_SCHEMA_VERSION, name: free(name), createdAt: t, updatedAt: t, settings }, { now: t });
      profiles.push(p);
      activeId = p.id;
      persist();
      return structuredClone(p);
    },
    /** Replace a profile's settings with `settings` (the caller has confirmed the overwrite). */
    update(id, settings) {
      const p = need(id);
      p.settings = normalizeProfileSettings(settings);
      p.updatedAt = now();
      activeId = id;
      persist();
      return structuredClone(p);
    },
    rename(id, name) {
      const p = need(id);
      p.name = free(name, id);
      p.updatedAt = now();
      persist();
      return structuredClone(p);
    },
    duplicate(id, name = null) {
      full();
      const src = need(id);
      const t = now();
      const p = normalizeProfile({ ...structuredClone(src), id: undefined, name: uniqueName(name ?? `${src.name} copy`, names()), createdAt: t, updatedAt: t }, { now: t });
      profiles.push(p);
      persist();
      return structuredClone(p);
    },
    remove(id) {
      need(id);
      profiles = profiles.filter((p) => p.id !== id);
      if (activeId === id) activeId = null;
      persist();
    },
    /** Remember which profile the Studio last applied or saved (for the "modified" indicator). */
    setActive(id) {
      activeId = id && find(id) ? id : null;
      persist();
    },
    /** Add an imported file as a new profile (fresh id, a free name); throws ProfileError on a bad file. */
    importText(text) {
      full();
      const t = now();
      const p = parseProfileText(text, { now: t });
      p.id = normalizeProfile({ ...p, id: undefined }, { now: t }).id;
      p.name = uniqueName(p.name, names());
      p.updatedAt = t;
      profiles.push(p);
      persist();
      return structuredClone(p);
    },
  };
}
