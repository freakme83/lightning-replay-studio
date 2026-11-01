// The single time transform shared by the interactive preview and the exported video.
// Dataset time maps linearly onto [leadIn, duration - tail] of the video; nothing is
// reordered, stretched or eased, so relative spacing between strikes is preserved.

/** Opening hold and closing hold, in video seconds. They shrink for very short videos. */
export function timelinePads(duration) {
  return {
    leadIn: Math.min(1.2, duration * 0.06),
    tail: Math.min(1.8, duration * 0.09),
  };
}

/**
 * @param {{startMs:number, endMs:number, duration:number}} o
 *   startMs/endMs: the dataset time range shown (defaults to first/last strike)
 *   duration: output video length in seconds
 */
export function createTimeMap({ startMs, endMs, duration }) {
  if (!(duration > 0)) throw new Error("Video duration must be positive.");
  if (!(endMs >= startMs)) throw new Error("Time range end must not precede its start.");
  const { leadIn, tail } = timelinePads(duration);
  const span = duration - leadIn - tail;
  const dataSpan = endMs - startMs;
  // A zero-length range (one strike, or all strikes at one instant) sits mid-span.
  const toVideo = (ms) => (dataSpan === 0 ? leadIn + span / 2 : leadIn + ((ms - startMs) / dataSpan) * span);
  const toData = (v) => {
    if (dataSpan === 0) return startMs;
    const ms = startMs + ((v - leadIn) / span) * dataSpan;
    return Math.min(endMs, Math.max(startMs, ms));
  };
  return {
    startMs, endMs, duration, leadIn, tail, span,
    /** Video seconds per dataset millisecond. */
    rate: dataSpan === 0 ? 0 : span / dataSpan,
    toVideo,
    toData,
    /** First frame on which an event at video time v is visible. */
    frameOf: (v, fps) => Math.ceil(v * fps - 1e-6),
  };
}
