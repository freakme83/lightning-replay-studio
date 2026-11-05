// Note strip for the Sound tab (ported from Lightning Sound Lab v1.3): strikes on top, the notes they played below.
const COL = { A: "108,196,255", B: "255,200,87" };

/** Draws the event strip (top) and the notes that were played (bottom). */
export function drawViz(canvas, events, notes, pos, now, range, flash, duration) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const padX = 10,
    stripH = 46,
    gap = 10;
  const x0 = padX,
    x1 = w - padX;
  const X = (t) => x0 + (t / duration) * (x1 - x0);

  // glow when lightning just struck
  if (flash > 0) {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, `rgba(255,241,184,${0.16 * flash})`);
    grd.addColorStop(1, "rgba(255,241,184,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  }

  // seconds grid
  g.strokeStyle = "rgba(255,255,255,0.05)";
  g.lineWidth = 1;
  g.fillStyle = "rgba(160,175,195,0.55)";
  g.font = "10px ui-monospace, monospace";
  const tick = duration <= 45 ? 5 : duration <= 130 ? 10 : Math.pow(10, Math.floor(Math.log10(duration / 5)));
  for (let s = 0; s <= duration; s += tick) {
    g.beginPath();
    g.moveTo(X(s) + 0.5, 0);
    g.lineTo(X(s) + 0.5, h);
    g.stroke();
    g.fillText(`${s}s`, X(s) + 3, h - 4);
  }

  // event strip: one bar per lightning event, taller = stronger
  for (const e of events) {
    const played = e.t <= pos;
    const bh = 6 + e.strength * (stripH - 10);
    g.fillStyle = played ? `rgba(255,241,184,${0.55 + 0.4 * e.strength})` : "rgba(150,165,190,0.35)";
    g.fillRect(X(e.t) - 0.75, stripH - bh, 1.5, bh);
  }

  // notes: height = pitch, size = loudness, bright while ringing
  const top = stripH + gap,
    bottom = h - 18;
  const [lo, hi] = range;
  const Y = (m) => bottom - ((m - lo) / Math.max(1, hi - lo)) * (bottom - top);
  for (const n of notes) {
    const age = now - n.time;
    const ringing = age >= 0 && age < n.length ? 1 - age / n.length : 0;
    const a = 0.22 + 0.78 * ringing;
    const r = 2.5 + n.vel * 6;
    g.fillStyle = `rgba(${COL[n.slot]},${a})`;
    g.beginPath();
    g.arc(X(n.simT), Math.max(top, Math.min(bottom, Y(n.midi))), r, 0, Math.PI * 2);
    g.fill();
    if (ringing > 0.1) {
      g.strokeStyle = `rgba(${COL[n.slot]},${0.5 * ringing})`;
      g.beginPath();
      g.arc(X(n.simT), Math.max(top, Math.min(bottom, Y(n.midi))), r + 4 * (1 - ringing) + 2, 0, Math.PI * 2);
      g.stroke();
    }
  }

  // shadow notes (Rich): small hollow diamonds, so they can never be mistaken for the filled main notes
  for (const n of notes) {
    if (!n.shadow) continue;
    const age = now - n.time;
    const ringing = age >= 0 && age < n.shadow.length ? 1 - age / n.shadow.length : 0;
    const cx = X(n.simT),
      cy = Math.max(top, Math.min(bottom, Y(n.shadow.midi))),
      r = 4;
    g.strokeStyle = `rgba(${COL[n.slot]},${0.35 + 0.55 * ringing})`;
    g.lineWidth = 1.25;
    g.beginPath();
    g.moveTo(cx, cy - r);
    g.lineTo(cx + r, cy);
    g.lineTo(cx, cy + r);
    g.lineTo(cx - r, cy);
    g.closePath();
    g.stroke();
    g.lineWidth = 1;
  }

  // playhead
  g.strokeStyle = "rgba(230,240,255,0.85)";
  g.beginPath();
  g.moveTo(X(pos) + 0.5, 0);
  g.lineTo(X(pos) + 0.5, h - 16);
  g.stroke();
}
