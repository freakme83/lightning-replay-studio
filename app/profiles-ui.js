// Studio Profiles panel: pick, apply, save, update, rename, duplicate, delete, import and export.
// All text from profiles (names above all) is untrusted and only ever set through textContent /
// option.text, never as HTML. The panel knows nothing about the Studio's internals: `capture()`
// returns the current settings (normalized, see captureSettings), `apply(profile, { restoreFrame })` applies a profile and returns a
// short note for the user.
import { PROFILE_LIMITS, ProfileError, profileFileName, sameSettings, serializeProfile } from "/src/profiles/profile.js";

export function createProfilesUi({ $, store, capture, apply }) {
  const el = {
    select: $("profile-select"), apply: $("profile-apply"), save: $("profile-save"), update: $("profile-update"),
    badge: $("profile-badge"), saveFrame: $("profile-save-frame"), restoreRow: $("profile-restore-row"), restoreFrame: $("profile-restore-frame"),
    form: $("profile-form"), name: $("profile-name"), ok: $("profile-ok"), cancel: $("profile-cancel"), formNote: $("profile-form-note"),
    state: $("profile-state"), file: $("profile-file"), links: $("profile-links"),
  };
  let mode = null; // the open inline form: save | update | rename | duplicate | delete
  let timer = null;

  const selected = () => store.get(el.select.value);
  const say = (text, kind = "") => { el.state.textContent = text; el.state.className = `note ${kind}`; };
  const fail = (e) => say(e instanceof ProfileError ? e.message : `Something went wrong: ${e?.message ?? e}`, "bad");

  function fillSelect(keepId) {
    const list = store.list();
    el.select.replaceChildren(new Option(list.length ? "Choose a profile…" : "No profiles yet", ""));
    for (const p of list) el.select.add(new Option(p.name, p.id));
    el.select.value = list.some((p) => p.id === keepId) ? keepId : "";
    el.restoreFrame.checked = false; // restoring a frame is a choice made per selection, never carried over
  }

  /** The "modified" badge: do the current settings differ from the selected profile? (The map frame is ignored.) */
  function refresh() {
    clearTimeout(timer);
    const p = selected();
    const has = !!p;
    for (const b of [el.apply, el.update]) b.disabled = !has;
    for (const b of el.links.querySelectorAll("[data-act]")) b.disabled = !has && b.dataset.act !== "import";
    el.restoreRow.hidden = !p?.settings.frame;
    let dirty = false;
    if (p && store.activeId() === p.id) {
      dirty = !sameSettings(capture(), p.settings);
    }
    el.badge.hidden = !dirty;
    el.badge.title = "The current settings differ from this profile. Update it to keep the changes, or Apply to go back.";
  }
  /** Settings change often (dragging an overlay): re-check once things settle. */
  const scheduleRefresh = () => { clearTimeout(timer); timer = setTimeout(refresh, 150); };

  function closeForm() {
    mode = null;
    el.form.hidden = true;
  }
  function openForm(m) {
    const p = selected();
    if (m !== "save" && !p) return;
    mode = m;
    const text = {
      save: ["Name this profile", "Save profile", ""],
      rename: ["New name", "Rename", p?.name],
      duplicate: ["Name of the copy", "Duplicate", p && `${p.name} copy`],
      update: [`Replace “${p?.name}” with the current settings?`, "Update profile", null],
      delete: [`Delete “${p?.name}”? This cannot be undone.`, "Delete", null],
    }[m];
    if (m === "update") el.saveFrame.checked = !!p.settings.frame; // keep (or knowingly drop) its saved frame
    el.formNote.textContent = text[0];
    el.ok.textContent = text[1];
    el.ok.classList.toggle("danger", m === "delete");
    el.name.hidden = text[2] === null;
    if (text[2] !== null) el.name.value = text[2];
    el.form.hidden = false;
    (el.name.hidden ? el.ok : el.name).focus();
    if (!el.name.hidden) el.name.select();
  }

  function submit() {
    try {
      const p = selected();
      if (mode === "save") {
        const created = store.create(el.name.value, capture({ includeFrame: el.saveFrame.checked }));
        fillSelect(created.id);
        say(`Saved “${created.name}”${created.settings.frame ? " with its map frame" : ""}.`, "ok");
      } else if (mode === "update" && p) {
        const updated = store.update(p.id, capture({ includeFrame: el.saveFrame.checked }));
        fillSelect(updated.id);
        say(`Updated “${updated.name}”.`, "ok");
      } else if (mode === "rename" && p) {
        const r = store.rename(p.id, el.name.value);
        fillSelect(r.id);
        say(`Renamed to “${r.name}”.`, "ok");
      } else if (mode === "duplicate" && p) {
        const d = store.duplicate(p.id, el.name.value);
        fillSelect(d.id);
        say(`Created “${d.name}”.`, "ok");
      } else if (mode === "delete" && p) {
        store.remove(p.id);
        fillSelect(null);
        say(`Deleted “${p.name}”.`, "ok");
      }
      closeForm();
    } catch (e) {
      fail(e); // the form stays open so the name can be corrected
    }
    refresh();
  }

  function applySelected() {
    const p = selected();
    if (!p) return;
    try {
      const note = apply(p, { restoreFrame: el.restoreFrame.checked && !!p.settings.frame });
      store.setActive(p.id);
      say(`Applied “${p.name}”. ${note}`.trim(), "ok");
    } catch (e) {
      fail(e);
    }
    refresh();
  }

  function exportSelected() {
    const p = selected();
    if (!p) return;
    const url = URL.createObjectURL(new Blob([serializeProfile(p)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: profileFileName(p.name) });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(`Exported “${p.name}”.`, "ok");
  }

  async function importFile(file) {
    if (!file) return;
    try {
      if (file.size > PROFILE_LIMITS.maxBytes) throw new ProfileError(`The file is too large for a profile (limit ${PROFILE_LIMITS.maxBytes / 1024} KB).`);
      const p = store.importText(await file.text());
      fillSelect(p.id);
      say(`Imported “${p.name}”. Apply it when you are ready; nothing changed yet.`, "ok");
    } catch (e) {
      fail(e);
    }
    el.file.value = "";
    refresh();
  }

  el.select.addEventListener("change", () => { el.restoreFrame.checked = false; closeForm(); say(""); refresh(); });
  el.apply.addEventListener("click", applySelected);
  el.save.addEventListener("click", () => openForm("save"));
  el.update.addEventListener("click", () => openForm("update"));
  el.links.addEventListener("click", (e) => {
    const act = e.target.dataset?.act;
    if (act === "import") el.file.click();
    else if (act === "export") exportSelected();
    else if (act) openForm(act);
  });
  el.form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  el.cancel.addEventListener("click", () => { closeForm(); say(""); });
  el.form.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeForm(); say(""); } });
  el.file.addEventListener("change", () => importFile(el.file.files[0]));

  fillSelect(store.activeId());
  const st = store.status();
  if (!st.persistent) say(st.problem, "warn");
  else if (st.skipped) say(`${st.skipped} saved profile(s) could not be read and were skipped.`, "warn");
  refresh();

  return { refresh: scheduleRefresh, select: (id) => { fillSelect(id); refresh(); } };
}
