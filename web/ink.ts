// Ink renderers. Two pen models:
//
//  - monoline: a round pen whose width follows pressure, which is how basic
//    Getty-Dubay italic is written (pencil or fine-tip pen);
//  - edged: a broad nib held at a fixed angle. Each segment is filled as the
//    parallelogram the nib edge sweeps between two samples, so thick and thin
//    strokes fall out of the stroke direction, just as with a real chisel nib.

import { type Band, toPixels } from "./geometry.ts";

export type Pen =
  | { kind: "monoline"; weight: number }
  | { kind: "edged"; nibs: number; angle: number };

export interface Point {
  /** Position in x-heights (see geometry.ts). */
  u: number;
  v: number;
  /** Normalised pressure, 0–1. */
  p: number;
  /** Event timestamp in ms; kept for later analysis of rhythm and speed. */
  t: number;
  /** Pencil altitude and azimuth in radians, when the browser reports them. */
  alt?: number;
  az?: number;
}

export interface Stroke {
  /** The pen in use when the stroke was written; later changes don't restyle it. */
  pen: Pen;
  points: Point[];
}

/** Monoline width in x-heights for a weight setting of 1–5. */
function monolineWidth(weight: number): number {
  return 0.03 + 0.015 * weight;
}

/** Pressure → width multiplier. A light touch still leaves a visible line. */
function pressureScale(p: number): number {
  return 0.45 + 1.1 * Math.min(1, Math.max(0, p));
}

export function drawStroke(ctx: CanvasRenderingContext2D, b: Band, s: Stroke, color: string) {
  if (s.points.length === 0) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (s.pen.kind === "monoline") drawMonoline(ctx, b, s.points, monolineWidth(s.pen.weight) * b.xh);
  else drawEdged(ctx, b, s.points, b.xh / s.pen.nibs, (s.pen.angle * Math.PI) / 180);
  ctx.restore();
}

function drawMonoline(ctx: CanvasRenderingContext2D, b: Band, pts: Point[], base: number) {
  const xy = pts.map((q) => toPixels(b, q.u, q.v));
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(xy[0][0], xy[0][1], (base * pressureScale(pts[0].p)) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // Each segment runs midpoint to midpoint with the sample as the control
  // point, which smooths the polyline. Segments are stroked separately so the
  // width can follow pressure along the stroke; round caps hide the seams.
  const mid = (i: number, j: number): [number, number] => [
    (xy[i][0] + xy[j][0]) / 2,
    (xy[i][1] + xy[j][1]) / 2,
  ];
  const last = pts.length - 1;
  for (let i = 0; i < last; i++) {
    const start = i === 0 ? xy[0] : mid(i - 1, i);
    const end = i + 1 === last ? xy[last] : mid(i, i + 1);
    ctx.beginPath();
    ctx.lineWidth = base * pressureScale((pts[i].p + pts[i + 1].p) / 2);
    ctx.moveTo(start[0], start[1]);
    if (i === 0) ctx.lineTo(end[0], end[1]);
    else ctx.quadraticCurveTo(xy[i][0], xy[i][1], end[0], end[1]);
    ctx.stroke();
  }
}

function drawEdged(
  ctx: CanvasRenderingContext2D,
  b: Band,
  pts: Point[],
  nib: number,
  angle: number,
) {
  // Half the nib edge as a vector. Canvas y grows downwards, so a nib angle
  // measured anticlockwise from the baseline has a negative y component.
  const half = (p: number): [number, number] => {
    const w = (nib * (0.85 + 0.3 * p)) / 2;
    return [Math.cos(angle) * w, -Math.sin(angle) * w];
  };
  // A real nib has some thickness, so a stroke along the edge is a hairline
  // rather than nothing at all.
  ctx.lineWidth = Math.max(0.75, nib * 0.07);

  const xy = pts.map((q) => toPixels(b, q.u, q.v));
  if (pts.length === 1) {
    const [hx, hy] = half(pts[0].p);
    ctx.beginPath();
    ctx.moveTo(xy[0][0] - hx, xy[0][1] - hy);
    ctx.lineTo(xy[0][0] + hx, xy[0][1] + hy);
    ctx.stroke();
    return;
  }
  // Each parallelogram is filled on its own. Their winding direction flips
  // with the stroke direction, so one combined path would cancel to a hole
  // wherever a stroke doubles back over itself.
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = xy[i];
    const [bx, by] = xy[i + 1];
    const [h0x, h0y] = half(pts[i].p);
    const [h1x, h1y] = half(pts[i + 1].p);
    ctx.beginPath();
    ctx.moveTo(ax - h0x, ay - h0y);
    ctx.lineTo(ax + h0x, ay + h0y);
    ctx.lineTo(bx + h1x, by + h1y);
    ctx.lineTo(bx - h1x, by - h1y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}
