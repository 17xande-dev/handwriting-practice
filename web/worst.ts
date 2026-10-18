// The stretch of writing furthest from the model, outlined with a dashed
// rounded box (the iPad's CheckOverlayView.drawWorstSegment), only when it is
// far enough off to be worth showing.

import { type Band, toPixels } from "./geometry.ts";
import type { Stroke } from "./ink.ts";
import { significant, type WorstSegment } from "./metrics.ts";

export function drawWorstSegment(
  ctx: CanvasRenderingContext2D,
  b: Band,
  strokes: Stroke[],
  worst: WorstSegment | undefined,
  color = "#c0392b",
) {
  if (!worst || !significant(worst)) return;
  const pts = strokes[worst.stroke]?.points.slice(worst.from, worst.to + 1);
  if (!pts?.length) return;
  const xy = pts.map((p) => toPixels(b, p.u, p.v));
  const xs = xy.map((q) => q[0]), ys = xy.map((q) => q[1]);
  const m = b.xh * 0.2;
  let x = Math.min(...xs) - m, y = Math.min(...ys) - m;
  let w = Math.max(...xs) - Math.min(...xs) + 2 * m, h = Math.max(...ys) - Math.min(...ys) + 2 * m;
  // Never smaller than most of a letter, so a tight zigzag still gets an outline you can see.
  const minSide = b.xh * 0.8;
  if (w < minSide) {
    x -= (minSide - w) / 2;
    w = minSide;
  }
  if (h < minSide) {
    y -= (minSide - h) / 2;
    h = minSide;
  }
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(12, h / 2));
  ctx.stroke();
  ctx.restore();
}
