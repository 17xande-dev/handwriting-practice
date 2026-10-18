// M5 metrics, part 1: shared helpers, shape detail and consistency. Everything
// here is a pure function of the strokes and of a `CheckResult` (its `detail`,
// `userBounds`, `frame`, `letters`). A port of the iPad app's Metrics.swift; the
// contract, units and NaN rules are its docs/metrics.md, pinned by the golden
// vectors in testdata/metrics. Pen control and fluency are in pen-metrics.ts,
// scores and notes in metric-scores.ts.

import { median } from "./evalcore.ts";
import { type CheckResult, S, strokeSlant } from "./evaluate.ts";
import type { Point, Stroke } from "./ink.ts";

// ---- helpers ------------------------------------------------------------------

/** `round(x)` as an integer: JS Math.round, and 0 for NaN and infinities. */
export function roundInt(x: number): number {
  return Number.isFinite(x) ? Math.round(x) : 0;
}

/** Arithmetic mean, NaN for none. */
export function avg(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population standard deviation; NaN with fewer than `min` values. */
export function sdev(xs: number[], min = 3): number {
  if (xs.length < Math.max(min, 1)) return NaN;
  const m = avg(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / xs.length);
}

/** JS `/\s/` exactly; a character string is whitespace if any code point is. */
export function isWhitespaceChar(s: string): boolean {
  return /\s/.test(s);
}

/** An angle wrapped into (-PI, PI]; the C `fmod` sign rule (JS `%` is the same). */
export function wrap(a: number): number {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

/** 100 at or better than `good`, 0 at or worse than `bad`, linear between (either direction). */
export function lin(x: number, good: number, bad: number): number {
  if (Number.isNaN(x)) return NaN;
  const t = (x - good) / (bad - good);
  return 100 * (1 - Math.min(1, Math.max(0, t)));
}

/**
 * Exactly one decimal, with the halves going up on the doubled product, as the
 * spec says (`toFixed` would format the exact binary value: 0.15 gives "0.1").
 * Non-finite gives "0.0".
 */
export function oneDecimal(x: number): string {
  const t = roundInt(Math.abs(x) * 10);
  return `${x < 0 && t > 0 ? "-" : ""}${Math.floor(t / 10)}.${t % 10}`;
}

/**
 * Circular mean and SD of angles with period `period` (2PI for directions, PI
 * for a nib line), in radians; the mean lies in (-period/2, period/2]. Both NaN
 * for none or when the angles cancel.
 */
export function circularStats(angles: number[], period: number): { mean: number; sd: number } {
  if (angles.length === 0) return { mean: NaN, sd: NaN };
  const k = (2 * Math.PI) / period;
  let c = 0, s = 0;
  for (const a of angles) {
    c += Math.cos(a * k);
    s += Math.sin(a * k);
  }
  const R = Math.sqrt(c * c + s * s) / angles.length;
  if (R < 1e-9) return { mean: NaN, sd: NaN };
  const mean = Math.atan2(s, c) / k;
  const sd = R >= 1 ? 0 : Math.sqrt(-2 * Math.log(R)) / k;
  return { mean, sd };
}

// ---- letters of points ---------------------------------------------------------

/** The model character a point at analysis column `x` belongs to. */
export function letterIndexAt(x: number, bounds: number[]): number {
  const n = bounds.length - 1;
  for (let i = 0; i < Math.max(0, n); i++) if (x < bounds[i + 1]) return i;
  return Math.max(0, n - 1);
}

type Frame = Pick<CheckResult, "frame" | "userBounds">;

/** The model character index of each point of each stroke. */
export function pointLetters(strokes: Stroke[], r: Frame): number[][] {
  const f = r.frame;
  return strokes.map((s) =>
    s.points.map((p) => letterIndexAt((p.u + p.v * f.tan - f.uMin) * S, r.userBounds))
  );
}

/** Arc-length weight of each point: half of each adjacent segment; all zero (a dot) gives 1. */
function arcWeights(pts: Point[]): number[] {
  const w = new Array<number>(pts.length).fill(0);
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1].u - pts[i].u, pts[i + 1].v - pts[i].v);
    w[i] += l / 2;
    w[i + 1] += l / 2;
  }
  return w.every((x) => x === 0) ? w.map(() => 1) : w;
}

// ---- shape detail ----------------------------------------------------------------

export interface WorstSegment {
  stroke: number;
  /** Inclusive point indices within the stroke. */
  from: number;
  to: number;
  /** Mean distance to the model over the points, x-heights. */
  mean: number;
  /** Model character index at the middle of the stretch. */
  letter: number;
}

export const worstSegmentFloor = 0.1;
/** Shortest arc a worst-segment window must span, x-heights. */
export const worstSegmentArc = 0.3;

/** Worth outlining: the mean is at least `worstSegmentFloor`. */
export const significant = (w: WorstSegment): boolean => w.mean >= worstSegmentFloor;

export interface ShapeDetail {
  zoneAscender: number;
  zoneBody: number;
  zoneDescender: number;
  worst?: WorstSegment;
}

/**
 * Mean distance of the writing to the model per zone (by the point's own v:
 * ascender above -1.15, descender below +0.15), x-heights, NaN where nothing
 * was written; and the worst stretch.
 */
export function shapeDetail(strokes: Stroke[], r: CheckResult): ShapeDetail {
  const sum = [0, 0, 0], wsum = [0, 0, 0];
  strokes.forEach((s, si) => {
    if (si >= r.detail.pointDist.length) return;
    const w = arcWeights(s.points), d = r.detail.pointDist[si];
    s.points.forEach((p, i) => {
      if (i >= d.length) return;
      const z = p.v < -1.15 ? 0 : p.v > 0.15 ? 2 : 1;
      sum[z] += w[i] * d[i];
      wsum[z] += w[i];
    });
  });
  const zone = (z: number) => wsum[z] > 0 ? sum[z] / wsum[z] : NaN;

  let worst: WorstSegment | undefined;
  const letters = pointLetters(strokes, r);
  strokes.forEach((s, si) => {
    if (si >= r.detail.pointDist.length) return;
    const pts = s.points, d = r.detail.pointDist[si], n = pts.length;
    if (n < 2) return;
    for (let i = 0; i < n - 1; i++) {
      let arc = 0, j = i, total = 0;
      while (j < n - 1 && arc < worstSegmentArc) {
        arc += Math.hypot(pts[j + 1].u - pts[j].u, pts[j + 1].v - pts[j].v);
        j++;
      }
      if (arc < worstSegmentArc) break;
      for (let k = i; k <= j; k++) total += d[k];
      const m = total / (j - i + 1);
      if (!worst || m > worst.mean) {
        worst = {
          stroke: si,
          from: i,
          to: j,
          mean: m,
          letter: letters[si][Math.floor((i + j) / 2)],
        };
      }
    }
  });
  const out: ShapeDetail = {
    zoneAscender: zone(0),
    zoneBody: zone(1),
    zoneDescender: zone(2),
  };
  if (worst) out.worst = worst;
  return out;
}

// ---- letter shapes ------------------------------------------------------------------

export type UV = [u: number, v: number];

/** One written letter: the polylines of the writing inside the letter's span. */
export interface LetterShape {
  char: string;
  lines: UV[][];
}

/**
 * Cut every stroke into runs of consecutive points with the same letter,
 * grouped by the letter's position in `result.letters` (missing letters have none).
 */
export function letterRuns(strokes: Stroke[], r: CheckResult): Point[][][] {
  const slot = new Map<number, number>();
  r.letters.forEach((l, k) => {
    if (!l.missing) slot.set(l.index, k);
  });
  const out: Point[][][] = r.letters.map(() => []);
  const ls = pointLetters(strokes, r);
  strokes.forEach((s, si) => {
    if (s.points.length === 0) return;
    let start = 0;
    for (let i = 1; i <= s.points.length; i++) {
      if (i === s.points.length || ls[si][i] !== ls[si][start]) {
        const k = slot.get(ls[si][start]);
        if (k !== undefined) out[k].push(s.points.slice(start, i));
        start = i;
      }
    }
  });
  return out;
}

export function letterShapes(strokes: Stroke[], r: CheckResult): LetterShape[] {
  const runs = letterRuns(strokes, r);
  const out: LetterShape[] = [];
  r.letters.forEach((l, k) => {
    if (runs[k].length) {
      out.push({ char: l.char, lines: runs[k].map((run) => run.map((p): UV => [p.u, p.v])) });
    }
  });
  return out;
}

// ---- consistency ----------------------------------------------------------------------

export interface ConsistencyMetrics {
  /** SD across letters of each letter's own downstroke slant, degrees. */
  slantSD: number;
  /** SD of the x-height ratio across body letters. */
  sizeSD: number;
  /** SD of the letters' bottoms against the model's, x-heights. */
  baselineSD: number;
  /** SD of (user gap - model gap) between neighbouring letters of a word, x-heights. */
  spacingDevSD: number;
  /** Coefficient of variation of the gaps within words (NaN if their mean is under 0.05). */
  spacingCV: number;
  /** Median over word spaces of user gap / model gap. */
  wordSpace: number;
  /** Mean pairwise Chamfer distance between copies of the same letter, x-heights. */
  repeatDist: number;
}

export function consistencyMetrics(
  text: string,
  strokes: Stroke[],
  r: CheckResult,
): ConsistencyMetrics {
  const runs = letterRuns(strokes, r);
  const chars = [...text];

  const slants: number[] = [];
  r.letters.forEach((l, k) => {
    if (l.missing) return;
    const subs: Stroke[] = runs[k].map((points) => ({
      pen: { kind: "monoline", weight: 3 },
      points,
    }));
    const s = strokeSlant(subs, 0.5);
    if (Number.isFinite(s)) slants.push(s);
  });
  const sizes = r.detail.letterSize.filter(Number.isFinite);
  const bottoms = r.detail.letterBottom.filter(Number.isFinite);

  // Gaps between the extents of neighbouring written letters.
  const f = r.frame;
  const extents = r.letters.map((_, k) => {
    const xs = runs[k].flat().map((p) => p.u + p.v * f.tan - f.uMin);
    return xs.length ? { lo: Math.min(...xs), hi: Math.max(...xs) } : null;
  });
  const gaps: number[] = [], devs: number[] = [], wordRatios: number[] = [];
  let prev: number | null = null;
  for (let k = 0; k < r.letters.length; k++) {
    const e = extents[k];
    if (!e || r.letters[k].missing) continue;
    const p = prev;
    prev = k;
    // Only neighbouring entries of `letters` make a pair: a missing letter in between breaks the chain.
    if (p === null || p !== k - 1) continue;
    const pe = extents[p];
    if (!pe) continue;
    const userGap = e.lo - pe.hi;
    const modelGap = r.detail.modelLeft[k] - r.detail.modelRight[p];
    const a = r.letters[p].index, b = r.letters[k].index;
    const spaced = b - a > 1 && chars.slice(a + 1, b).some(isWhitespaceChar);
    if (spaced) {
      if (modelGap > 0.1) wordRatios.push(userGap / modelGap);
    } else {
      gaps.push(userGap);
      devs.push(userGap - modelGap);
    }
  }
  const gapMean = avg(gaps);
  const cv = gaps.length >= 2 && gapMean >= 0.05 ? sdev(gaps, 2) / gapMean : NaN;

  return {
    slantSD: sdev(slants),
    sizeSD: sdev(sizes),
    baselineSD: sdev(bottoms),
    spacingDevSD: sdev(devs, 2),
    spacingCV: cv,
    wordSpace: median(wordRatios),
    repeatDist: repeatConsistency(letterShapes(strokes, r)),
  };
}

// ---- repeated letters --------------------------------------------------------------------

/** Points per letter after resampling for the Chamfer distance. */
export const chamferPoints = 32;
/** At most this many copies of a letter are compared (the first ones written). */
export const repeatMaxCopies = 8;

/**
 * `n` points evenly spaced along the arc of the polylines (segments only, no
 * jumps between polylines), at distances (k + 0.5) L / n. Empty when the arc is
 * shorter than `minArc`.
 */
export function resampleArc(lines: UV[][], n: number, minArc: number): UV[] {
  const segs: Array<{ a: UV; b: UV; len: number }> = [];
  let total = 0;
  for (const l of lines) {
    if (l.length < 2) continue;
    for (let i = 0; i < l.length - 1; i++) {
      const len = Math.hypot(l[i + 1][0] - l[i][0], l[i + 1][1] - l[i][1]);
      if (len > 0) {
        segs.push({ a: l[i], b: l[i + 1], len });
        total += len;
      }
    }
  }
  if (total < minArc || segs.length === 0) return [];
  const out: UV[] = [];
  let k = 0, acc = 0;
  segs.forEach((s, idx) => {
    while (k < n) {
      const target = (k + 0.5) * total / n;
      if (target > acc + s.len && idx < segs.length - 1) break;
      const t = Math.min(1, Math.max(0, (target - acc) / s.len));
      out.push([s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]);
      k++;
    }
    acc += s.len;
  });
  return out;
}

function chamfer(a: UV[], b: UV[]): number {
  const oneWay = (x: UV[], y: UV[]) => {
    let s = 0;
    for (const p of x) {
      let best = Infinity;
      for (const q of y) best = Math.min(best, (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2);
      s += Math.sqrt(best);
    }
    return s / x.length;
  };
  return (oneWay(a, b) + oneWay(b, a)) / 2;
}

/**
 * Mean Chamfer distance, x-heights, between every pair of copies of each
 * letter written at least twice (each copy centred and scaled to its own
 * size), averaged over letters. Copies with under 0.1 x-height of ink are
 * ignored. NaN if no letter qualifies.
 */
export function repeatConsistency(shapes: LetterShape[]): number {
  const order: string[] = [];
  const groups = new Map<string, Array<{ pts: UV[]; scale: number }>>();
  for (const s of shapes) {
    const pts = resampleArc(s.lines, chamferPoints, 0.1);
    if (pts.length !== chamferPoints) continue;
    const all = s.lines.flat();
    const us = all.map((p) => p[0]), vs = all.map((p) => p[1]);
    const uMin = Math.min(...us),
      uMax = Math.max(...us),
      vMin = Math.min(...vs),
      vMax = Math.max(...vs);
    const cu = (uMin + uMax) / 2, cv = (vMin + vMax) / 2;
    const scale = Math.max(0.05, Math.max(uMax - uMin, vMax - vMin));
    let g = groups.get(s.char);
    if (!g) {
      order.push(s.char);
      groups.set(s.char, g = []);
    }
    if (g.length < repeatMaxCopies) {
      g.push({ pts: pts.map((p): UV => [(p[0] - cu) / scale, (p[1] - cv) / scale]), scale });
    }
  }
  const perLetter: number[] = [];
  for (const ch of order) {
    const g = groups.get(ch)!;
    if (g.length < 2) continue;
    const ds: number[] = [];
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        ds.push(chamfer(g[i].pts, g[j].pts) * (g[i].scale + g[j].scale) / 2);
      }
    }
    perLetter.push(avg(ds));
  }
  return avg(perLetter);
}
