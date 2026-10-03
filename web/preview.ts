// The toolbar's pen preview: a short "nu" written with the current pen, on
// guides at the current slant, so a change of weight, nib or angle shows
// before it reaches the page.

import { band } from "./geometry.ts";
import { drawGuides, type GuideColors } from "./guides.ts";
import { drawStroke, type Pen, type Point, type Stroke } from "./ink.ts";

const xh = 20;
const width = 132;
const proportions = { asc: 0.45, desc: 0.35 };

/**
 * The sample's path in x-heights (y up is negative), before slanting: an
 * italic n (stem, retrace, branching arch), a diagonal join, then a u (stem,
 * bowl, stem, exit). Wide enough that a broad nib doesn't fill the counters.
 */
function samplePath(): Array<[number, number]> {
  const pts: Array<[number, number]> = [[0, -1]];
  const seg = (x0: number, y0: number, x1: number, y1: number, n: number) => {
    for (let i = 1; i <= n; i++) pts.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
  };
  const arc = (cx: number, cy: number, rx: number, ry: number, from: number, to: number) => {
    for (let i = 1; i <= 16; i++) {
      const t = from + ((to - from) * i) / 16;
      pts.push([cx + rx * Math.cos(t), cy - ry * Math.sin(t)]);
    }
  };
  seg(0, -1, 0, 0, 10); // n: stem down
  seg(0, 0, 0, -0.5, 5); // retrace up
  arc(0.35, -0.55, 0.35, 0.45, Math.PI, 0); // branching arch
  seg(0.7, -0.55, 0.7, 0, 6); // down to the baseline
  seg(0.7, 0, 1.15, -1, 8); // diagonal join to the top of the u
  seg(1.15, -1, 1.15, -0.3, 7); // u: stem down
  arc(1.5, -0.3, 0.35, 0.3, Math.PI, 2 * Math.PI); // bowl
  seg(1.85, -0.3, 1.85, -1, 7); // up to the x-height
  seg(1.85, -1, 1.85, 0, 10); // stem down
  seg(1.85, 0, 2.0, -0.12, 3); // exit
  return pts;
}

const path = samplePath();

export function drawPreview(
  canvas: HTMLCanvasElement,
  pen: Pen,
  slant: number,
  guides: GuideColors,
  ink: string,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const b = band(xh, width, proportions);
  const dpr = globalThis.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(b.height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${b.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawGuides(ctx, b, guides, slant);

  // Slant the sample to match the paper, and press harder on the
  // downstrokes, as a writer does, so pressure shows in monoline.
  const tan = Math.tan((slant * Math.PI) / 180);
  const points: Point[] = path.map(([u, v], i) => {
    const prev = path[Math.max(0, i - 1)];
    const down = v - prev[1] > 0.01;
    return { u: 1.8 + u - v * tan, v, p: down ? 0.75 : 0.35, t: i };
  });
  const stroke: Stroke = { pen, points };
  drawStroke(ctx, b, stroke, ink);
}
