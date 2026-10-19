// Ink renderers, exact to the iPad app's (docs/pens.md there; the maths is in pens.ts):
//
//  - monoline: a round pen whose width follows (calibrated) pressure, which is how basic
//    Getty-Dubay italic is written (pencil or fine-tip pen);
//  - edged: a broad nib held at a fixed angle. Each segment is filled as the
//    parallelogram the nib edge sweeps between two samples, so thick and thin
//    strokes fall out of the stroke direction, just as with a real chisel nib;
//  - pointed: a copperplate flex nib, a smoothed, tapered, pressure-swelling ribbon;
//  - pencil: graphite, tilted elliptical stamps under a paper grain.
//
// Every renderer can draw only the stroke's tail (`from`), which is what live writing does.

import { type Band, toPixels } from "./geometry.ts";
import {
  getPressureUpper,
  grainCells,
  grainCellSize,
  grainTileAlpha,
  pencilStamps,
  pointedWidths,
  pressureCurve,
} from "./pens.ts";

export type Pen =
  | { kind: "monoline"; weight: number }
  | { kind: "edged"; nibs: number; angle: number; swell?: boolean }
  | { kind: "pointed"; weight: number }
  | { kind: "pencil"; lead: number };

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
  /** Barrel roll in radians, in [-PI, PI) (the iPad's `roll`), when the browser reports a twist. */
  roll?: number;
  /** The Pencil's pressure when the browser reported a real one; only says "a Pencil, not a finger", not stored in ink records. */
  force?: number;
}

export interface Stroke {
  /** The pen in use when the stroke was written; later changes don't restyle it. */
  pen: Pen;
  points: Point[];
  /** The edged nib followed the barrel roll while this stroke was written (never on the web: the nib angle is a setting). */
  followsRoll?: boolean;
  /** Roll reference in radians for a nib that follows the roll; absent: the roll of the first point. */
  rollRef?: number;
}

/** Monoline width in x-heights for a weight setting of 1–5. */
function monolineWidth(weight: number): number {
  return 0.03 + 0.015 * weight;
}

/** Calibrated pressure → width multiplier. A light touch still leaves a visible line. */
function pressureScale(q: number): number {
  return 0.45 + 1.1 * Math.min(1, Math.max(0, q));
}

/** Pointed and pencil strokes are drawn as a whole, so the check overlay can't cut them into runs. */
export function drawsWhole(pen: Pen): boolean {
  return pen.kind === "pointed" || pen.kind === "pencil";
}

/**
 * Draw a stroke. Segments `from` up to (not including) `to` are drawn: the tail of a stroke being
 * written, whose widths, stamps and tapers are still those of the whole stroke. `live` is a stroke still being written:
 * the pointed nib's end does not taper yet.
 */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  b: Band,
  s: Stroke,
  color: string,
  from = 0,
  live = false,
  to = Infinity,
) {
  if (s.points.length === 0) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const pen = s.pen;
  if (pen.kind === "monoline") {
    drawMonoline(ctx, b, s.points, monolineWidth(pen.weight) * b.xh, from, to);
  } else if (pen.kind === "edged") {
    drawEdged(
      ctx,
      b,
      s.points,
      b.xh / pen.nibs,
      (pen.angle * Math.PI) / 180,
      pen.swell === true,
      from,
      to,
    );
  } else if (pen.kind === "pointed") {
    drawPointed(ctx, b, s.points, pen.weight, from, to, live);
  } else {
    drawPencil(ctx, b, s.points, pen.lead, from, to, color);
  }
  ctx.restore();
}

/**
 * A pointed or pencil stroke coloured by point class (the check overlay): the widths, taper and
 * stamps of the whole stroke, each segment or stamp taking the class of its nearer point.
 */
export function drawStrokeClasses(
  ctx: CanvasRenderingContext2D,
  b: Band,
  s: Stroke,
  classes: number[],
  colors: string[],
) {
  if (s.points.length === 0 || classes.length !== s.points.length) return;
  ctx.save();
  ctx.fillStyle = colors[0] ?? "#000";
  if (s.pen.kind === "pointed") {
    drawPointed(ctx, b, s.points, s.pen.weight, 0, Infinity, false, classes, colors);
  } else if (s.pen.kind === "pencil") {
    drawPencil(ctx, b, s.points, s.pen.lead, 0, Infinity, colors[0] ?? "#000", classes, colors);
  }
  ctx.restore();
}

function drawMonoline(
  ctx: CanvasRenderingContext2D,
  b: Band,
  pts: Point[],
  base: number,
  from: number,
  to: number,
) {
  const upper = getPressureUpper();
  const xy = pts.map((q) => toPixels(b, q.u, q.v));
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(
      xy[0][0],
      xy[0][1],
      (base * pressureScale(pressureCurve(pts[0].p, upper))) / 2,
      0,
      Math.PI * 2,
    );
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
  for (let i = Math.max(0, from); i < Math.min(last, to); i++) {
    const start = i === 0 ? xy[0] : mid(i - 1, i);
    const end = i + 1 === last ? xy[last] : mid(i, i + 1);
    ctx.beginPath();
    ctx.lineWidth = base * pressureScale(pressureCurve((pts[i].p + pts[i + 1].p) / 2, upper));
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
  swell: boolean,
  from: number,
  to: number,
) {
  const upper = getPressureUpper();
  // Half the nib edge as a vector. Canvas y grows downwards, so a nib angle
  // measured anticlockwise from the baseline has a negative y component.
  // Without swell the edge follows the raw pressure, as it always has.
  const half = (p: number): [number, number] => {
    const f = swell ? 0.8 + 0.5 * pressureCurve(p, upper) : 0.85 + 0.3 * p;
    const w = (nib * f) / 2;
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
  for (let i = Math.max(0, from); i < Math.min(pts.length - 1, to); i++) {
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

const wrapAngle = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

/**
 * The pointed nib: a variable-width ribbon (widths: pens.ts pointedWidths). Every segment is a quad
 * offset along its own normal and every noticeable turn gets a round joint; all pieces share one
 * winding direction, so one nonzero fill is their union. With `classes`, one path per class.
 */
function drawPointed(
  ctx: CanvasRenderingContext2D,
  b: Band,
  pts: Point[],
  weight: number,
  from: number,
  to: number,
  live: boolean,
  classes?: number[],
  colors?: string[],
) {
  const xy = pts.map((q) => toPixels(b, q.u, q.v));
  const w = pointedWidths(xy, pts.map((q) => q.p), b.xh, weight, getPressureUpper(), !live);
  const paths = new Map<number, Path2D>();
  let path = new Path2D();
  const use = (point: number) => {
    const c = classes?.[point] ?? 0;
    let p = paths.get(c);
    if (!p) paths.set(c, p = new Path2D());
    path = p;
  };
  use(0);
  const disc = (c: [number, number], d: number) => {
    const r = Math.max(0.2, d / 2);
    const n = r > 3 ? 20 : 12;
    for (let k = 0; k < n; k++) {
      const t = (-2 * Math.PI * k) / n; // decreasing angle: the quads' winding
      const x = c[0] + r * Math.cos(t), y = c[1] + r * Math.sin(t);
      if (k === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    path.closePath();
  };
  if (pts.length === 1) {
    disc(xy[0], w[0]);
  } else {
    let prevDir: number | null = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = xy[i], c = xy[i + 1];
      const dx = c[0] - a[0], dy = c[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (!(len > 1e-6)) continue;
      const dir = Math.atan2(dy, dx);
      const show = i >= from && i < to;
      use(i + 1);
      if (show) {
        const nx = -dy / len, ny = dx / len;
        const r0 = w[i] / 2, r1 = w[i + 1] / 2;
        path.moveTo(a[0] + nx * r0, a[1] + ny * r0);
        path.lineTo(c[0] + nx * r1, c[1] + ny * r1);
        path.lineTo(c[0] - nx * r1, c[1] - ny * r1);
        path.lineTo(a[0] - nx * r0, a[1] - ny * r0);
        path.closePath();
      }
      // A round joint at the start of the segment when the path turns, and at both ends.
      if (show && i === 0) {
        use(0);
        disc(a, w[i]);
        use(i + 1);
      } else if (show && prevDir !== null && Math.abs(wrapAngle(dir - prevDir)) > 0.06) {
        disc(a, w[i]);
      }
      if (show && i === pts.length - 2) disc(c, w[i + 1]);
      prevDir = dir;
    }
  }
  for (const c of [...paths.keys()].sort((x, y) => x - y)) {
    if (colors?.[c]) ctx.fillStyle = colors[c];
    ctx.fill(paths.get(c)!, "nonzero");
  }
}

// ---- pencil -----------------------------------------------------------------------------------

let grainTile: HTMLCanvasElement | null = null;
/** One scratch layer, reused: the stamps of a stroke accumulate here before the grain is applied. */
let layer:
  | { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; grain: CanvasPattern }
  | null = null;

function grainCanvas(): HTMLCanvasElement {
  if (grainTile) return grainTile;
  const c = document.createElement("canvas");
  c.width = c.height = grainCells;
  const alpha = grainTileAlpha();
  const img = new ImageData(grainCells, grainCells);
  for (let i = 0; i < alpha.length; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = alpha[i];
  }
  c.getContext("2d")!.putImageData(img, 0, 0);
  return grainTile = c;
}

function scratch(w: number, h: number) {
  if (!layer) {
    const canvas = document.createElement("canvas");
    const lctx = canvas.getContext("2d", { willReadFrequently: false })!;
    const grain = lctx.createPattern(grainCanvas(), "repeat")!;
    // One tile pixel is one grain cell, 0.5 view units.
    grain.setTransform(new DOMMatrix().scale(grainCellSize));
    layer = { canvas, ctx: lctx, grain };
  }
  if (layer.canvas.width < w || layer.canvas.height < h) {
    layer.canvas.width = Math.max(layer.canvas.width, w);
    layer.canvas.height = Math.max(layer.canvas.height, h);
  }
  return layer;
}

/**
 * Ellipse stamps (pens.ts pencilStamps) accumulate in a transparency layer, then the paper grain,
 * anchored to the view's coordinates so every redraw matches, multiplies their alpha. With
 * `classes`, a layer per class (a stamp takes the class of its nearer point).
 */
function drawPencil(
  ctx: CanvasRenderingContext2D,
  b: Band,
  pts: Point[],
  lead: number,
  from: number,
  to: number,
  color: string,
  classes?: number[],
  colors?: string[],
) {
  const samples = pts.map((q) => {
    const [x, y] = toPixels(b, q.u, q.v);
    return { x, y, p: q.p, alt: q.alt, az: q.az };
  });
  const stamps = pencilStamps(samples, lead, b.xh, getPressureUpper());
  const groups = new Map<number, typeof stamps>();
  for (const s of stamps) {
    if (s.seg < from || s.seg >= to) continue;
    const c = classes ? classes[s.along < 0.5 ? s.seg : Math.min(pts.length - 1, s.seg + 1)] : 0;
    let g = groups.get(c);
    if (!g) groups.set(c, g = []);
    g.push(s);
  }
  const m = ctx.getTransform();
  const sc = m.a;
  const full = { w: ctx.canvas.width, h: ctx.canvas.height };
  for (const c of [...groups.keys()].sort((x, y) => x - y)) {
    const group = groups.get(c)!;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of group) {
      const r = s.major / 2 + 1;
      x0 = Math.min(x0, s.x - r);
      y0 = Math.min(y0, s.y - r);
      x1 = Math.max(x1, s.x + r);
      y1 = Math.max(y1, s.y + r);
    }
    // The layer is the stamps' bounds in device pixels, kept inside the canvas.
    const X0 = Math.max(0, Math.floor(x0 * sc + m.e)),
      X1 = Math.min(full.w, Math.ceil(x1 * sc + m.e));
    const Y0 = Math.max(0, Math.floor(y0 * sc + m.f)),
      Y1 = Math.min(full.h, Math.ceil(y1 * sc + m.f));
    const w = X1 - X0, h = Y1 - Y0;
    if (!(w > 0 && h > 0)) continue;
    const L = scratch(w, h);
    const l = L.ctx;
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.globalCompositeOperation = "source-over";
    l.globalAlpha = 1;
    l.clearRect(0, 0, w, h);
    l.setTransform(sc, 0, 0, sc, m.e - X0, m.f - Y0);
    l.fillStyle = colors?.[c] ?? color;
    for (const s of group) {
      l.globalAlpha = s.alpha;
      l.beginPath();
      l.ellipse(s.x, s.y, s.major / 2, s.minor / 2, s.angle, 0, 2 * Math.PI);
      l.fill();
    }
    l.globalAlpha = 1;
    l.globalCompositeOperation = "destination-in";
    l.imageSmoothingEnabled = false;
    l.fillStyle = L.grain;
    l.fillRect((X0 - m.e) / sc, (Y0 - m.f) / sc, w / sc, h / sc);
    l.globalCompositeOperation = "source-over";
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(L.canvas, 0, 0, w, h, X0, Y0, w, h);
    ctx.restore();
  }
}
