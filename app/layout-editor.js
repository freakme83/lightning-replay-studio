// Edit Layout mode: select, drag, resize and nudge the replay's informational overlays directly on
// the preview. This layer only handles input and draws outlines and guides (never on the canvas,
// so never in an export); every change goes back to the studio as an override in the shared
// layout model, which the canvas renderer — preview and MP4 alike — draws from.
import { OVERLAYS } from "/src/core/overlays.js";
import { SNAP, dragBox, freeAxis, nudge, outputPerCss, overrideOf, resizeFromCorner, snapTargets, toCss, toOutput } from "/src/editor/layout-edit.js";

const LABEL = Object.fromEntries(OVERLAYS.map((o) => [o.id, o.label]));
const CORNERS = ["nw", "ne", "sw", "se"];

/**
 * @param layer   element covering the preview canvas exactly
 * @param canvas  the preview canvas (its CSS box is the video frame)
 * @param geometry () => { model, boxes } with boxes from overlayGeometry() (output px), or null
 * @param onChange (id, override|null, { live }) a placement changed (null = restore no override)
 * @param onSelect (id|null) selection changed
 * @param isLocked (id) => boolean
 * @param snapping () => boolean
 */
export function createLayoutEditor({ layer, canvas, geometry, onChange, onSelect, isLocked, snapping }) {
  let selected = null, hover = null, drag = null;
  const boxEls = {};
  const guides = document.createElement("div");
  guides.className = "hud-guides";
  layer.appendChild(guides);
  for (const o of OVERLAYS) {
    const el = document.createElement("div");
    el.className = "hud-box";
    el.dataset.id = o.id;
    el.innerHTML = `<span class="hud-tag"></span>${CORNERS.map((c) => `<i class="hud-handle ${c}" data-corner="${c}"></i>`).join("")}`;
    layer.appendChild(el);
    boxEls[o.id] = el;
  }

  const frame = () => {
    const g = geometry();
    if (!g) return null;
    const { width: W, height: H } = g.model.settings;
    return { ...g, W, H, rect: canvas.getBoundingClientRect() };
  };

  /** Topmost useful overlay under a point: the selected one first, then the smallest visible box. */
  function hitTest(f, pt) {
    const pad = 4 * outputPerCss(f.rect, f.W); // a few CSS px of slack around thin overlays
    const inside = (b) => b && pt[0] >= b.x - pad && pt[0] <= b.x + b.w + pad && pt[1] >= b.y - pad && pt[1] <= b.y + b.h + pad;
    if (selected && inside(f.boxes[selected].box)) return selected;
    let best = null;
    for (const g of Object.values(f.boxes)) {
      if (!g.visible || !inside(g.box)) continue;
      if (!best || g.box.w * g.box.h < best.box.w * best.box.h) best = g;
    }
    return best?.id ?? null;
  }

  function showGuides(f, held) {
    const lines = [];
    const fpx = f.rect.width / f.W;
    for (const [axis, t] of [["x", held?.x], ["y", held?.y]]) {
      if (!t) continue;
      const cls = `hud-guide ${axis === "x" ? "v" : "h"} ${t.major ? "major" : t.kind}`;
      const pos = Math.round(t.v * fpx) - 0.5;
      lines.push(`<i class="${cls}" style="${axis === "x" ? "left" : "top"}:${pos}px"></i>`);
    }
    guides.innerHTML = lines.join("");
  }

  /** Re-place outlines from the current geometry (after every draw while editing). */
  function refresh() {
    const f = frame();
    if (!f || layer.hidden) return;
    for (const o of OVERLAYS) {
      const el = boxEls[o.id], g = f.boxes[o.id];
      const show = g.box && (g.visible || o.id === selected);
      el.hidden = !show;
      if (!show) continue;
      const c = toCss(g.box, f.rect, f.W);
      Object.assign(el.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` });
      el.classList.toggle("selected", o.id === selected);
      el.classList.toggle("hover", o.id === hover && o.id !== selected);
      el.classList.toggle("ghost", !g.visible);
      el.classList.toggle("locked", isLocked(o.id));
      const pct = Math.round(g.placement.s * 100);
      el.querySelector(".hud-tag").textContent = `${LABEL[o.id]}${g.visible ? "" : " · hidden"}${isLocked(o.id) ? " · locked" : ""}${pct !== 100 ? ` · ${pct}%` : ""}`;
    }
  }

  function select(id) {
    if (id === selected) return;
    selected = id;
    refresh();
    onSelect(id);
  }

  function cancelDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    layer.classList.remove("dragging");
    guides.innerHTML = "";
    onChange(d.id, d.before, { live: false, revert: true });
  }

  layer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const f = frame();
    if (!f) return;
    layer.focus({ preventScroll: true });
    const pt = toOutput(e.clientX, e.clientY, f.rect, f.W, f.H);
    const corner = e.target.dataset?.corner;
    const id = corner ? e.target.parentElement.dataset.id : hitTest(f, pt);
    select(id);
    if (!id || isLocked(id)) return;
    const g = f.boxes[id];
    if (!g.base) return;
    e.preventDefault();
    try { layer.setPointerCapture(e.pointerId); } catch {} // keeps the drag even when the pointer leaves the frame
    const others = Object.values(f.boxes).filter((o) => o.visible && o.id !== id).map((o) => ({ ...o.box, id: o.id }));
    drag = {
      id, pointerId: e.pointerId, corner, start: pt, startBox: g.box, startP: g.placement, base: g.base,
      before: f.overrides[id] ? { ...f.overrides[id] } : null,
      targets: snapTargets(f.model.layout, f.W, f.H, others), axes: { x: freeAxis(), y: freeAxis() },
    };
    layer.classList.add("dragging");
  });

  layer.addEventListener("pointermove", (e) => {
    const f = frame();
    if (!f) return;
    const pt = toOutput(e.clientX, e.clientY, f.rect, f.W, f.H);
    if (!drag) {
      const h = e.target.dataset?.corner ? e.target.parentElement.dataset.id : hitTest(f, pt);
      if (h !== hover) { hover = h; refresh(); }
      layer.style.cursor = h ? (isLocked(h) ? "not-allowed" : "move") : "default";
      return;
    }
    if (e.pointerId !== drag.pointerId) return;
    let p;
    if (drag.corner) {
      p = resizeFromCorner(drag.startP, drag.base, drag.corner, pt, f.W, f.H);
    } else {
      // Thresholds are preview CSS px, converted to output px at the current preview size.
      const opc = outputPerCss(f.rect, f.W);
      const th = { capture: SNAP.capture * opc, release: SNAP.release * opc };
      const r = dragBox(drag.startBox, [pt[0] - drag.start[0], pt[1] - drag.start[1]], drag.axes, drag.targets, th, snapping() && !e.shiftKey, f.W, f.H);
      drag.axes = r.axes;
      showGuides(f, { x: r.axes.x.held, y: r.axes.y.held });
      const cur = drag.startBox;
      p = { ...drag.startP, x: drag.startP.x + (r.box.x - cur.x), y: drag.startP.y + (r.box.y - cur.y) };
    }
    onChange(drag.id, { ...f.overrides[drag.id], ...overrideOf(p, f.W, f.H) }, { live: true });
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const id = drag.id;
    drag = null;
    layer.classList.remove("dragging");
    guides.innerHTML = "";
    onChange(id, undefined, { live: false }); // commit what is displayed
  };
  layer.addEventListener("pointerup", endDrag);
  layer.addEventListener("pointercancel", () => cancelDrag());
  layer.addEventListener("lostpointercapture", (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(e); });
  layer.addEventListener("pointerleave", () => { if (!drag && hover) { hover = null; refresh(); } });

  /** Keyboard while editing: arrows nudge (Shift = 10×), Escape cancels a drag, then clears the selection. */
  function keydown(e) {
    if (layer.hidden) return false;
    if (e.key === "Escape") {
      if (drag) cancelDrag();
      else select(null);
      return true;
    }
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!dir || !selected) return false;
    e.preventDefault();
    const f = frame();
    const g = f?.boxes[selected];
    if (!g?.base || isLocked(selected)) return true;
    const step = (e.shiftKey ? 10 : 1) * f.model.layout.k; // design units: same relative step in Draft and Full HD
    const p = nudge(g.placement, g.base, dir[0] * step, dir[1] * step, f.W, f.H);
    onChange(selected, { ...f.overrides[selected], ...overrideOf(p, f.W, f.H) }, { live: false });
    return true;
  }

  return {
    refresh,
    select,
    selected: () => selected,
    keydown,
    cancelDrag,
    dragging: () => !!drag,
  };
}
