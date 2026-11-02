// Keeping the Strikes table's current row visible without ever moving the page.
//
// Element.scrollIntoView() scrolls *every* scrollable ancestor, so following the latest strike
// during playback dragged the whole browser window (and the video preview with it). Here only the
// table's own scroll container is touched, and automatic following steps aside for a moment after
// the user has scrolled the table themselves.

/** Pixels the table header covers at the top of the scroll container (it is sticky). */
function headerHeight(container) {
  return container.querySelector?.("thead")?.getBoundingClientRect().height ?? 0;
}

/**
 * Scroll `container` just enough to bring `row` into view ("nearest" semantics). Only
 * `container.scrollTop` changes; nothing else on the page can move.
 * Returns true when the container actually scrolled.
 */
export function scrollRowIntoContainer(container, row) {
  if (!container || !row) return false;
  const c = container.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const head = headerHeight(container);
  const above = r.top - (c.top + head);
  const below = r.bottom - c.bottom;
  const before = container.scrollTop;
  if (above < 0) container.scrollTop = before + above;
  else if (below > 0) container.scrollTop = before + Math.min(below, above);
  return container.scrollTop !== before;
}

/**
 * Pause automatic following after user interaction with the table. `touch()` is called on wheel,
 * touch, scrollbar drag and key events; `active()` says whether automatic following may run again.
 */
export function createFollowGate(holdMs = 4000, now = () => performance.now()) {
  let until = -Infinity;
  return {
    touch() { until = now() + holdMs; },
    active() { return now() >= until; },
  };
}

/** Wire the user-interaction events of a table container to a follow gate. */
export function watchUserScroll(container, gate) {
  const touch = () => gate.touch();
  for (const ev of ["wheel", "touchstart", "touchmove", "keydown"]) container.addEventListener(ev, touch, { passive: true });
  // pointerdown on the container also covers dragging its scrollbar.
  container.addEventListener("pointerdown", touch, { passive: true });
}
