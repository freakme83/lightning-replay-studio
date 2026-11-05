// Schematic plot of the listening area for the Sound tab (ported from Lightning Sound Lab v1.3).
import { GEO_PAN_MAX } from "/src/sound/geo.js";
import { noteName } from "/src/sound/music.js";

const COL = { A: "108,196,255", B: "255,200,87" };

/**
 * A schematic (not a map): the listening area as a rectangle, west-east across, south-north up.
 * With Geographic Mapping the horizontal bands are the note ladder, so you can see which band = which note.
 */
export function drawGeo(canvas, v) {
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
  g.font = "10px ui-monospace, monospace";

  if (!v.bounds) {
    g.fillStyle = "rgba(160,175,195,0.7)";
    g.textAlign = "center";
    g.fillText("No strikes loaded.", w / 2, h / 2 - 6);
    g.fillText("Load a dataset in the Video tab.", w / 2, h / 2 + 10);
    g.textAlign = "start";
    return;
  }

  const left = 34,
    right = 8,
    top = 8,
    bottom = 18;
  const px0 = left,
    px1 = w - right,
    py0 = top,
    py1 = h - bottom;
  const b = v.bounds;
  const X = (lon) => px0 + ((lon - b.west) / (b.east - b.west)) * (px1 - px0);
  const Y = (lat) => py1 - ((lat - b.south) / (b.north - b.south)) * (py1 - py0);
  const cx = (lon) => Math.min(px1, Math.max(px0, X(lon)));
  const cy = (lat) => Math.min(py1, Math.max(py0, Y(lat)));

  // the listening area
  g.fillStyle = "#0a0e14";
  g.fillRect(px0, py0, px1 - px0, py1 - py0);

  // note ladder: equal bands, one per note
  const n = v.ladder?.length ?? 0;
  const last = v.notes.length ? v.notes[v.notes.length - 1] : null;
  const lastEv = last ? v.events[last.ev] : null;
  if (v.ladder && n > 0) {
    const bandH = (py1 - py0) / n;
    const labelEvery = bandH >= 12 ? 1 : bandH >= 6 ? 2 : 4;
    for (let i = 0; i < n; i++) {
      const yTop = py1 - (i + 1) * bandH;
      if (i % 2 === 0) {
        g.fillStyle = "rgba(255,255,255,0.03)";
        g.fillRect(px0, yTop, px1 - px0, bandH);
      }
      const active = last?.geographic && lastEv && Math.abs(last.midi - v.ladder[i]) < 0.5 && ringLevel(last, v.now) > 0;
      if (active) {
        g.fillStyle = `rgba(${COL[v.slot]},${0.1 + 0.25 * ringLevel(last, v.now)})`;
        g.fillRect(px0, yTop, px1 - px0, bandH);
      }
      if (i % labelEvery === 0) {
        g.fillStyle = active ? "rgba(230,240,255,0.95)" : "rgba(150,165,190,0.65)";
        g.fillText(noteName(v.ladder[i]), 3, yTop + bandH / 2 + 3);
      }
    }
  }
  g.strokeStyle = "rgba(255,255,255,0.14)";
  g.strokeRect(px0 + 0.5, py0 + 0.5, px1 - px0 - 1, py1 - py0 - 1);
  // the video frame: only strikes inside it are heard
  if (v.frame) {
    const fx0 = cx(v.frame.west), fx1 = cx(v.frame.east), fy0 = cy(v.frame.north), fy1 = cy(v.frame.south);
    g.save();
    g.setLineDash([4, 3]);
    g.strokeStyle = "rgba(63,224,204,0.55)";
    g.strokeRect(fx0 + 0.5, fy0 + 0.5, Math.max(0, fx1 - fx0 - 1), Math.max(0, fy1 - fy0 - 1));
    g.restore();
  }

  // events: dim = still to come, bright = already happened, line = the most recent path
  const played = [];
  for (let i = 0; i < v.events.length; i++) {
    const e = v.events[i];
    if (e.t > v.pos) break; // events are sorted by time
    played.push(i);
  }
  // every strike of a flash (the lead and the others on the same frame)
  const points = (e) => [e, ...(e.members ?? [])];
  for (const e of v.events) {
    if (e.t <= v.pos) continue;
    g.fillStyle = "rgba(150,165,190,0.28)";
    for (const p of points(e)) g.fillRect(cx(p.lon) - 1, cy(p.lat) - 1, 2, 2);
  }
  const trail = played.slice(-24);
  if (trail.length > 1) {
    g.strokeStyle = "rgba(255,241,184,0.18)";
    g.beginPath();
    trail.forEach((i, k) => {
      const e = v.events[i];
      k ? g.lineTo(cx(e.lon), cy(e.lat)) : g.moveTo(cx(e.lon), cy(e.lat));
    });
    g.stroke();
  }
  for (const i of played.slice(-300)) {
    const e = v.events[i];
    g.fillStyle = "rgba(255,241,184,0.55)";
    g.beginPath();
    for (const p of points(e)) {
      g.moveTo(cx(p.lon) + 2, cy(p.lat));
      g.arc(cx(p.lon), cy(p.lat), 2, 0, Math.PI * 2);
    }
    g.fill();
  }

  // notes that are still ringing: a ring in the slot colour
  for (const nt of v.notes.slice(-40)) {
    const e = v.events[nt.ev];
    const k = ringLevel(nt, v.now);
    if (!e || k <= 0) continue;
    g.strokeStyle = `rgba(${COL[v.slot]},${0.8 * k})`;
    g.beginPath();
    g.arc(cx(e.lon), cy(e.lat), 3 + 7 * (1 - k), 0, Math.PI * 2);
    g.stroke();
  }

  // shadow notes (Rich): hollow diamonds in the band of the shadow note, under the position of their strike
  if (v.ladder && n > 0) {
    const bandH = (py1 - py0) / n;
    for (const nt of v.notes.slice(-40)) {
      const e = v.events[nt.ev];
      const i = nt.shadow ? v.ladder.indexOf(nt.shadow.midi) : -1;
      if (!e || i < 0) continue;
      const k = Math.max(0.25, ringLevel({ ...nt, length: nt.shadow.length }, v.now));
      const x = cx(e.lon),
        y = py1 - (i + 0.5) * bandH,
        r = 4;
      g.strokeStyle = `rgba(${COL[v.slot]},${0.3 + 0.6 * k})`;
      g.beginPath();
      g.moveTo(x, y - r);
      g.lineTo(x + r, y);
      g.lineTo(x, y + r);
      g.lineTo(x - r, y);
      g.closePath();
      g.stroke();
    }
  }

  // the latest event: cross-hair + label (note and stereo position)
  if (last && lastEv) {
    const x = cx(lastEv.lon),
      y = cy(lastEv.lat);
    g.strokeStyle = "rgba(230,240,255,0.35)";
    g.beginPath();
    g.moveTo(x + 0.5, py0);
    g.lineTo(x + 0.5, py1);
    g.stroke();
    g.fillStyle = `rgb(${COL[v.slot]})`;
    g.beginPath();
    g.arc(x, y, 3.5, 0, Math.PI * 2);
    g.fill();
    const lr = last.pan === 0 ? "centre" : `${last.pan < 0 ? "L" : "R"} ${Math.round((Math.abs(last.pan) / GEO_PAN_MAX) * 100)}%`;
    const text = last.geographic
      ? `${noteName(last.midi)} · pan ${lr}${last.shadow ? ` · ◇ ${noteName(last.shadow.midi)}` : ""}`
      : `${noteName(last.midi)} (random note)`;
    g.textAlign = "right";
    g.fillStyle = "rgba(230,240,255,0.92)";
    g.fillText(text, px1 - 5, py0 + 12);
    g.textAlign = "start";
  }

  // compass hints
  g.fillStyle = "rgba(160,175,195,0.7)";
  g.fillText("W", px0, h - 5);
  g.textAlign = "right";
  g.fillText("E", px1, h - 5);
  g.textAlign = "center";
  g.fillText("west → east = left → right", (px0 + px1) / 2, h - 5);
  g.textAlign = "start";
}

/** 1 right after a note starts, fading to 0 when it has rung out. */
function ringLevel(n, t) {
  const age = t - n.time;
  return age >= 0 && age < n.length ? 1 - age / n.length : 0;
}
