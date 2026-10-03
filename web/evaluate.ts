// "Check my writing": compare a practice line with its model, letter by
// letter, and draw where the writing strayed.
//
// Everything happens in an analysis raster at a fixed scale (S pixels per
// x-height), whatever the size on screen. The user writes on the same guides
// as the model, so the two already agree vertically; only the horizontal
// needs aligning, which DTW does over the columns. The raster is sheared to
// stand the letters upright first, so a column holds one letter's stem
// rather than slicing diagonally across two.
//
// Nothing here leaves the page.

import {
  distanceTransform,
  dtw,
  median,
  type Raster,
  raster,
  sample,
  scoreLetter,
  skeleton,
} from "./evalcore.ts";
import type { Band } from "./geometry.ts";
import type { Stroke } from "./ink.ts";
import { type FontInfo, fontString } from "./measure.ts";

/** Analysis pixels per x-height. */
const S = 40;
/**
 * Credit for a line's distance from the model's centreline: full within
 * `full`, nothing beyond `zero`, graded between (see evalcore.credit).
 * 0.04 x-height is about a pencil line's width at writing size; 0.2 is a
 * clear miss.
 */
const full = 0.04 * S;
const zero = 0.2 * S;

export interface LetterResult {
  char: string;
  score: number;
  missing: boolean;
}

/** Line-level measurements, kept numeric so a sheet can average them. */
export interface Metrics {
  /** User slant minus model slant, degrees; NaN if too little to measure. */
  slantDiff: number;
  /** User x-height ÷ model x-height. */
  size: number;
  /** User letter width ÷ model letter width. */
  width: number;
  /** User baseline − model baseline, in x-heights (positive: below). */
  baseline: number;
}

export interface CheckResult {
  letters: LetterResult[];
  /** 0–100: the letters' mean, less a deduction for slant, size, width and baseline. */
  score: number;
  metrics: Metrics;
  notes: string[];
  /** For each stroke, for each point: 0 on the model, 1 near, 2 off. */
  pointClass: number[][];
  /** The model, placed where the user wrote it, and its unreached parts. */
  overlay: HTMLCanvasElement;
  /** Analysis-space frame, for drawing the overlay on a band. */
  frame: { uMin: number; vTop: number; tan: number };
}

/** The model line rendered into the analysis frame. */
interface ModelRender {
  model: Raster;
  skel: Raster;
  W: number;
  H: number;
  /** Baseline and x-height rows. */
  Yb: number;
  Yx: number;
  uMin: number;
  vTop: number;
  tan: number;
  /** Where each character starts along the line, in analysis columns (one extra at the end). */
  bounds: number[];
  chars: string[];
}

/**
 * Draw the model text on the shared baseline, sheared upright, `extraU`
 * x-heights wider than the text so a longer line of writing still fits.
 */
function renderModel(
  text: string,
  font: FontInfo,
  extraU: (modelU: number, tan: number) => number,
): ModelRender {
  const tan = Math.tan((font.slant * Math.PI) / 180);
  const vTop = -(1 + font.proportions.asc + 0.6);
  const vBottom = font.proportions.desc + 0.6;
  const H = Math.ceil((vBottom - vTop) * S);
  const Yb = -vTop * S;
  const uMin = -1.5;

  // The model's width in x-heights, and where each letter starts along it.
  const probe = document.createElement("canvas").getContext("2d")!;
  const px = S / font.xRatio;
  probe.font = fontString(font, px);
  const chars = [...text];
  const starts: number[] = [];
  let prefix = "";
  for (const ch of chars) {
    starts.push(probe.measureText(prefix).width);
    prefix += ch;
  }
  starts.push(probe.measureText(text).width);
  const modelU = starts[starts.length - 1] / S;
  const W = Math.ceil((Math.max(modelU, extraU(modelU, tan)) - uMin + 2) * S);

  const mc = document.createElement("canvas");
  mc.width = W;
  mc.height = H;
  const mctx = mc.getContext("2d", { willReadFrequently: true })!;
  mctx.setTransform(1, 0, tan, 1, -tan * Yb, 0);
  mctx.font = fontString(font, px);
  mctx.textBaseline = "alphabetic";
  mctx.fillText(text, -uMin * S, Yb);
  const model = raster(W, H);
  const pixels = mctx.getImageData(0, 0, W, H).data;
  for (let i = 0; i < W * H; i++) model.data[i] = pixels[i * 4 + 3] > 110 ? 1 : 0;

  return {
    model,
    skel: skeleton(model),
    W,
    H,
    Yb,
    Yx: Yb - S,
    uMin,
    vTop,
    tan,
    bounds: starts.map((s) => -uMin * S + s),
    chars,
  };
}

/**
 * Compare a line's strokes with its model text. Returns null when there is
 * nothing to compare (no ink, or a model with no letters).
 */
export function check(text: string, font: FontInfo, strokes: Stroke[]): CheckResult | null {
  const points = strokes.flatMap((s) => s.points);
  if (points.length === 0 || text.trim() === "") return null;

  const m = renderModel(text, font, (_, tan) => {
    let max = 0;
    for (const p of points) max = Math.max(max, p.u + p.v * tan);
    return max;
  });
  const { model, W, H, Yb, Yx, uMin, vTop, tan, bounds, chars } = m;
  const modelSkel = m.skel;

  /** Units → deslanted analysis pixels. */
  const toX = (u: number, v: number) => (u + v * tan - uMin) * S;
  const toY = (v: number) => (v - vTop) * S;

  // User ink: stroke centrelines, resampled to under a pixel apart.
  const userSamples: Array<[number, number]> = [];
  for (const s of strokes) {
    for (let i = 0; i < s.points.length; i++) {
      const a = s.points[i], b = s.points[Math.min(i + 1, s.points.length - 1)];
      const ax = toX(a.u, a.v), ay = toY(a.v), bx = toX(b.u, b.v), by = toY(b.v);
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      for (let k = 0; k < n; k++) {
        userSamples.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
      }
    }
  }
  const user = plot(W, H, userSamples);

  // Columns that carry ink, at either end, bound the alignment.
  const span = (r: Raster) => {
    let lo = r.w, hi = -1;
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        if (r.data[y * r.w + x]) {
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
      }
    }
    return [lo, hi];
  };
  const [m0, m1] = span(modelSkel);
  const [u0, u1] = span(user);
  if (m1 < m0 || u1 < u0) return null;

  // Per column: ink in the ascender zone, the x-height band and the
  // descender zone, lightly smoothed. Model skeleton and user centreline are
  // both one pixel wide, so their counts are comparable.
  const features = (r: Raster, from: number, to: number) => {
    const raw: number[][] = [];
    for (let x = from; x <= to; x++) {
      const f = [0, 0, 0];
      for (let y = 0; y < r.h; y++) {
        if (!r.data[y * r.w + x]) continue;
        f[y < Yx ? 0 : y < Yb ? 1 : 2] += 1;
      }
      raw.push(f.map((c) => Math.min(c, 4) / 4));
    }
    return raw.map((_, i) => {
      const acc = [0, 0, 0];
      let n = 0;
      for (let k = Math.max(0, i - 2); k <= Math.min(raw.length - 1, i + 2); k++) {
        for (let z = 0; z < 3; z++) acc[z] += raw[k][z];
        n++;
      }
      return acc.map((a) => a / n);
    });
  };
  const map = dtw(features(modelSkel, m0, m1), features(user, u0, u1));
  // DTW places each letter, absorbing where the line starts and how it is
  // spaced. Within a letter the mapping is a straight stretch between its
  // ends: warping freely inside a letter would bend a misshapen letter back
  // into shape (squeeze a too-wide arch) and hide exactly what the check is for.
  const toUserX = (x: number) => u0 + sample(map, x - m0);
  const userBounds = bounds.map(toUserX);
  for (let i = 1; i < userBounds.length; i++) {
    userBounds[i] = Math.max(userBounds[i], userBounds[i - 1]); // keep it monotonic
  }
  const toModelX = (x: number) => piecewise(userBounds, bounds, x);

  // The user's ink moved into the model's frame, letter for letter.
  const warped = userSamples.map(([x, y]) => [toModelX(x), y] as [number, number]);
  const warpedRaster = plot(W, H, warped);
  // Distance to the model's centreline, not its ink: a thin line anywhere
  // inside a thick stroke would otherwise count as perfect.
  const dtModel = distanceTransform(modelSkel);
  const dtUser = distanceTransform(warpedRaster);
  const at = (dt: Float32Array, x: number, y: number) =>
    dt[
      Math.min(H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)))
    ];

  // A letter with no model ink (a space) isn't scored.
  const letterOf = (x: number) => {
    for (let i = 0; i < chars.length; i++) if (x < bounds[i + 1]) return i;
    return chars.length - 1;
  };
  const userToModel = chars.map(() => [] as number[]);
  const userTop = chars.map(() => Infinity), userBottom = chars.map(() => -Infinity);
  for (const [x, y] of warped) {
    if (x < bounds[0] - S || x > bounds[chars.length] + S) continue;
    const i = letterOf(x);
    userToModel[i].push(at(dtModel, x, y));
    userTop[i] = Math.min(userTop[i], y);
    userBottom[i] = Math.max(userBottom[i], y);
  }
  const modelToUser = chars.map(() => [] as number[]);
  const modelTop = chars.map(() => Infinity), modelBottom = chars.map(() => -Infinity);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!modelSkel.data[y * W + x]) continue;
      // Extents come from the centreline, like the user's, so a thick model
      // stroke doesn't make the user's letters look short.
      const i = letterOf(x);
      modelTop[i] = Math.min(modelTop[i], y);
      modelBottom[i] = Math.max(modelBottom[i], y);
      modelToUser[i].push(dtUser[y * W + x]);
    }
  }

  const letters: LetterResult[] = [];
  const sizes: number[] = [], widths: number[] = [], baselines: number[] = [];
  chars.forEach((char, i) => {
    // A space isn't a letter, even when a neighbour's swash (a joined f's
    // descender, say) reaches into its slot.
    if (/\s/.test(char) || modelToUser[i].length === 0) return;
    const s = scoreLetter(userToModel[i], modelToUser[i], full, zero);
    letters.push({ char, score: s.score, missing: s.missing });
    if (s.missing) return;
    const modelWidth = bounds[i + 1] - bounds[i];
    if (modelWidth > 0.2 * S) {
      widths.push((toUserX(bounds[i + 1]) - toUserX(bounds[i])) / modelWidth);
    }
    // Size and baseline are judged on letters that sit within the x-height
    // band (a, c, e, m, n, o, …), where the model's own extent is reliable.
    const bodyOnly = modelTop[i] > Yx - 0.2 * S && modelBottom[i] < Yb + 0.2 * S;
    if (bodyOnly && userToModel[i].length > 5) {
      sizes.push((Yb - userTop[i]) / (Yb - modelTop[i]));
      baselines.push((userBottom[i] - modelBottom[i]) / S);
    }
  });
  if (letters.length === 0) return null;

  const metrics: Metrics = {
    // Against the model's own downstrokes, measured the same way, rather than
    // the font's nominal slope: Edu SA is catalogued at 5° but its letters
    // measure about 6°, which would read as a lean on every line.
    slantDiff: strokeSlant(strokes) - strokeSlant(trace(m)),
    size: median(sizes),
    width: median(widths),
    baseline: median(baselines),
  };

  const pointClass = strokes.map((s) =>
    s.points.map((p) => {
      const d = at(dtModel, toModelX(toX(p.u, p.v)), toY(p.v));
      // Green with full credit, amber while some credit remains, red beyond.
      return d <= full * 1.5 ? 0 : d <= zero ? 1 : 2;
    })
  );

  // The overlay, in the user's (deslanted) frame: for each column the user
  // wrote in, the model column it was matched to, so the ghost letters sit
  // under the user's own and stretch with them.
  const overlay = document.createElement("canvas");
  overlay.width = W;
  overlay.height = H;
  const octx = overlay.getContext("2d")!;
  const img = octx.createImageData(W, H);
  const unwritten: Array<[number, number]> = [];
  for (let x = Math.max(0, u0 - S); x <= Math.min(W - 1, u1 + S); x++) {
    const mx = Math.round(toModelX(x));
    if (mx < 0 || mx >= W) continue;
    for (let y = 0; y < H; y++) {
      const k = y * W + mx, o = (y * W + x) * 4;
      if (modelSkel.data[k] && dtUser[k] > (full + zero) / 2) {
        unwritten.push([x, y]); // a part of the letter never written
      }
      if (model.data[k]) {
        img.data.set([90, 140, 220, 70], o); // the model, faint
      }
    }
  }
  octx.putImageData(img, 0, 0);
  // Drawn after the ghost, and wider than the one-pixel centreline, so a
  // missed part of a letter is plain to see at screen size.
  octx.fillStyle = "rgba(200, 40, 40, 0.9)";
  for (const [x, y] of unwritten) octx.fillRect(x - 1.5, y - 1.5, 3, 3);

  const shapes = letters.reduce((a, l) => a + l.score, 0) / letters.length;
  const score = Math.round(shapes * (1 - proportionPenalty(metrics)));
  return {
    letters,
    score,
    metrics,
    notes: notes(metrics),
    pointClass,
    overlay,
    frame: { uMin, vTop, tan },
  };
}

/**
 * For browser tests: the model's own centreline as strokes, as if written
 * perfectly. A check of these should score near 100%.
 */
export function modelStrokes(text: string, font: FontInfo): Stroke[] {
  return trace(renderModel(text, font, () => 0));
}

/** Walk a rendered model's skeleton into strokes, in x-height units. */
function trace(m: ModelRender): Stroke[] {
  const { skel, W, H } = m;
  const left = new Uint8Array(skel.data);
  const neighbours = (i: number) => {
    const x = i % W, y = (i - x) / W, out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if ((dx || dy) && xx >= 0 && yy >= 0 && xx < W && yy < H && left[yy * W + xx]) {
          out.push(yy * W + xx);
        }
      }
    }
    return out;
  };
  const strokes: Stroke[] = [];
  for (;;) {
    // Start from an end of a line where there is one, so paths aren't split.
    let start = -1;
    for (let i = 0; i < left.length; i++) {
      if (!left[i]) continue;
      if (start < 0) start = i;
      if (neighbours(i).length === 1) {
        start = i;
        break;
      }
    }
    if (start < 0) break;
    const path = [start];
    left[start] = 0;
    for (let next = neighbours(start); next.length; next = neighbours(path[path.length - 1])) {
      left[next[0]] = 0;
      path.push(next[0]);
    }
    if (path.length < 4) continue;
    strokes.push({
      pen: { kind: "monoline", weight: 3 },
      points: path.filter((_, k) => k % 3 === 0 || k === path.length - 1).map((i, k) => {
        const X = i % W, Y = (i - X) / W;
        const v = Y / S + m.vTop;
        return { u: X / S + m.uMin - v * m.tan, v, p: 0.5, t: k };
      }),
    });
  }
  return strokes;
}

/**
 * Map x through matching breakpoints `from` → `to`, linearly between them and
 * with a slope of 1 beyond the ends. Zero-width spans map to their start.
 */
function piecewise(from: number[], to: number[], x: number): number {
  const n = from.length;
  if (x <= from[0]) return to[0] + (x - from[0]);
  if (x >= from[n - 1]) return to[n - 1] + (x - from[n - 1]);
  let k = 0;
  while (k < n - 2 && x >= from[k + 1]) k++;
  const span = from[k + 1] - from[k];
  return span > 0 ? to[k] + ((x - from[k]) * (to[k + 1] - to[k])) / span : to[k];
}

function plot(w: number, h: number, pts: Array<[number, number]>): Raster {
  const r = raster(w, h);
  for (const [x, y] of pts) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi >= 0 && yi >= 0 && xi < w && yi < h) r.data[yi * w + xi] = 1;
  }
  return r;
}

/**
 * The slope of the writing's downstrokes, in degrees right of vertical: the
 * length-weighted median over straight, steep, downward stretches at least
 * 0.4 x-height long. Curves (arches, bowls) are left out, because their
 * chords lean whichever way the curve happens to turn. NaN when there are
 * too few straight stretches to judge.
 */
export function strokeSlant(strokes: Stroke[]): number {
  const found: Array<[angle: number, weight: number]> = [];
  for (const s of strokes) {
    const pts = s.points;
    let i = 0;
    while (i < pts.length - 1) {
      let arc = 0, j = i;
      while (j < pts.length - 1 && arc < 0.4) {
        arc += Math.hypot(pts[j + 1].u - pts[j].u, pts[j + 1].v - pts[j].v);
        j++;
      }
      if (arc < 0.4) break;
      const dx = pts[j].u - pts[i].u, dy = pts[j].v - pts[i].v; // dy > 0 is downwards
      const chord = Math.hypot(dx, dy);
      if (chord / arc > 0.97 && dy > 0 && Math.abs(dx) < 0.7 * dy) {
        // Writing down and to the left is a stroke leaning right.
        found.push([(Math.atan2(-dx, dy) * 180) / Math.PI, chord]);
      }
      // Step on half a window, so stretches overlap but aren't counted many times.
      let step = 0, k = i;
      while (k < j && step < arc / 2) {
        step += Math.hypot(pts[k + 1].u - pts[k].u, pts[k + 1].v - pts[k].v);
        k++;
      }
      i = Math.max(k, i + 1);
    }
  }
  const total = found.reduce((a, [, w]) => a + w, 0);
  if (total < 0.8) return NaN;
  found.sort((a, b) => a[0] - b[0]);
  let acc = 0;
  for (const [angle, w] of found) {
    acc += w;
    if (acc >= total / 2) return angle;
  }
  return found[found.length - 1][0];
}

/**
 * How much of a line's score its proportions take away, 0–0.3. The letter
 * scores judge shape; a line can match every shape and still lean or sprawl,
 * and its score shouldn't read as perfect when the notes say otherwise.
 */
export function proportionPenalty(m: Metrics): number {
  const over = (
    x: number,
    free: number,
  ) => (Number.isFinite(x) ? Math.max(0, Math.abs(x) - free) : 0);
  const p = 0.02 * over(m.slantDiff, 2) + 0.5 * over(m.size - 1, 0.08) +
    0.3 * over(Math.log(m.width), 0.15) + 0.5 * over(m.baseline, 0.1);
  return Math.min(0.3, p);
}

/** Plain advice from the measurements, the most notable first, at most three. */
export function notes(m: Metrics): string[] {
  const found: Array<[number, string]> = [];
  if (Number.isFinite(m.slantDiff) && Math.abs(m.slantDiff) >= 3) {
    const d = Math.round(Math.abs(m.slantDiff));
    found.push([
      Math.abs(m.slantDiff) / 3,
      m.slantDiff > 0
        ? `Letters lean ${d}° more than the model.`
        : `Letters lean ${d}° less than the model.`,
    ]);
  }
  if (Number.isFinite(m.size) && Math.abs(m.size - 1) >= 0.12) {
    const pct = Math.round(Math.abs(m.size - 1) * 100);
    found.push([
      Math.abs(m.size - 1) / 0.12,
      `x-height about ${pct}% ${m.size > 1 ? "tall" : "short"}.`,
    ]);
  }
  if (Number.isFinite(m.width) && (m.width >= 1.2 || m.width <= 0.83)) {
    found.push([
      Math.abs(Math.log(m.width)) / 0.18,
      m.width > 1 ? "Letters wider than the model." : "Letters narrower than the model.",
    ]);
  }
  if (Number.isFinite(m.baseline) && Math.abs(m.baseline) >= 0.15) {
    found.push([
      Math.abs(m.baseline) / 0.15,
      m.baseline > 0 ? "Letters dip below the baseline." : "Letters float above the baseline.",
    ]);
  }
  return found.sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, t]) => t);
}

/** Draw a result over a practice line: the ghost model, then the coloured ink. */
export function drawOverlay(ctx: CanvasRenderingContext2D, b: Band, r: CheckResult) {
  const { uMin, vTop, tan } = r.frame;
  const k = b.xh / S;
  ctx.save();
  // Analysis (deslanted) pixels → band pixels: undo the shear, then scale.
  ctx.transform(k, 0, -tan * k, k, b.left + b.xh * (uMin - vTop * tan), b.baseline + b.xh * vTop);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(r.overlay, 0, 0);
  ctx.restore();
}

/** The colours for on, near and off the model. */
export const deviationColors = ["#2e8540", "#d08a00", "#c0392b"];

/** Split a stroke into runs of one deviation class, overlapping by a point. */
export function colouredRuns(s: Stroke, classes: number[]): Array<{ stroke: Stroke; cls: number }> {
  const runs: Array<{ stroke: Stroke; cls: number }> = [];
  let start = 0;
  for (let i = 1; i <= s.points.length; i++) {
    if (i === s.points.length || classes[i] !== classes[start]) {
      runs.push({
        stroke: { pen: s.pen, points: s.points.slice(start, Math.min(i + 1, s.points.length)) },
        cls: classes[start],
      });
      start = i;
    }
  }
  return runs;
}
