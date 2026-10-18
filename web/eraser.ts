// Stroke-eraser hit testing, in x-height units (a port of the iPad app's
// Eraser.swift). Whole strokes are erased: one whose path passes within
// `eraserTolerance` of the eraser path is removed.

import type { Stroke } from "./ink.ts";

export interface UV {
  u: number;
  v: number;
}

/** Stroke eraser reach in x-heights (the iPad app's value). */
export const eraserTolerance = 0.3;

/** Distance from point p to the segment a-b. */
export function distanceToSegment(p: UV, a: UV, b: UV): number {
  const dx = b.u - a.u, dy = b.v - a.v;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.u - a.u, p.v - a.v);
  const t = Math.max(0, Math.min(1, ((p.u - a.u) * dx + (p.v - a.v) * dy) / len2));
  return Math.hypot(p.u - (a.u + t * dx), p.v - (a.v + t * dy));
}

const cross = (o: UV, a: UV, b: UV) => (a.u - o.u) * (b.v - o.v) - (a.v - o.v) * (b.u - o.u);

/** Whether segments a-b and c-d properly cross. */
function crosses(a: UV, b: UV, c: UV, d: UV): boolean {
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Shortest distance between segments a-b and c-d (0 when they cross). */
export function distanceBetweenSegments(a: UV, b: UV, c: UV, d: UV): number {
  if (crosses(a, b, c, d)) return 0;
  return Math.min(
    distanceToSegment(a, c, d),
    distanceToSegment(b, c, d),
    distanceToSegment(c, a, b),
    distanceToSegment(d, a, b),
  );
}

function bounds(pts: UV[]) {
  let loU = pts[0].u, loV = pts[0].v, hiU = loU, hiV = loV;
  for (const q of pts) {
    loU = Math.min(loU, q.u);
    loV = Math.min(loV, q.v);
    hiU = Math.max(hiU, q.u);
    hiV = Math.max(hiV, q.v);
  }
  return { loU, loV, hiU, hiV };
}

/**
 * Whether a stroke's path passes within `tolerance` of the eraser path (a
 * polyline; one point is a dot). Call it with just the newest eraser segment
 * as the pen moves.
 */
export function strokeTouches(stroke: Stroke, path: UV[], tolerance: number): boolean {
  const pts = stroke.points;
  if (pts.length === 0 || path.length === 0) return false;
  // Bounding-box precheck: most strokes are nowhere near the eraser.
  const s = bounds(pts), e = bounds(path);
  if (
    e.hiU < s.loU - tolerance || e.loU > s.hiU + tolerance ||
    e.hiV < s.loV - tolerance || e.loV > s.hiV + tolerance
  ) return false;
  for (let i = 0; i < Math.max(pts.length - 1, 1); i++) {
    const a = pts[i], b = pts.length > 1 ? pts[i + 1] : pts[i];
    for (let j = 0; j < Math.max(path.length - 1, 1); j++) {
      const c = path[j], d = path.length > 1 ? path[j + 1] : path[j];
      if (distanceBetweenSegments(a, b, c, d) <= tolerance) return true;
    }
  }
  return false;
}

/** Indices of the strokes hit by the eraser path. */
export function strokesHit(strokes: Stroke[], path: UV[], tolerance: number): number[] {
  const hit: number[] = [];
  strokes.forEach((s, i) => {
    if (strokeTouches(s, path, tolerance)) hit.push(i);
  });
  return hit;
}
