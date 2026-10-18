// Parity fixtures: a model raster, strokes and the scores the web app gives
// them, in a plain JSON form another implementation (the iPad app's Swift
// core) can replay. Nothing here needs a browser; only rendering the model
// does (evaluate.renderModelRaster), and the debug hook in main.ts does that.

import {
  type CheckResult,
  checkWithModel,
  type ModelRaster,
  S,
  strokesFromModel,
} from "./evaluate.ts";
import type { Stroke } from "./ink.ts";

/** Run lengths of a 0/1 sequence, alternating, starting with 0s (so the first may be 0). */
export function rleEncode(bits: Uint8Array): number[] {
  const runs: number[] = [];
  let cur = 0, n = 0;
  for (const b of bits) {
    if (b === cur) n++;
    else {
      runs.push(n);
      cur = b;
      n = 1;
    }
  }
  runs.push(n);
  return runs;
}

export function rleDecode(runs: number[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let i = 0, v = 0;
  for (const n of runs) {
    if (v) out.fill(1, i, i + n);
    i += n;
    v ^= 1;
  }
  return out;
}

/** A small seeded generator, uniform in [0, 1). Easy to port: 32-bit integer maths only. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FixtureModel {
  w: number;
  h: number;
  S: number;
  vTop: number;
  Yb: number;
  uMin: number;
  bounds: number[];
  asc: number;
  desc: number;
  xRatio: number;
  rle: number[];
}

/** One point: [u, v, p, t]. */
export type FixturePoint = [number, number, number, number];

export interface FixtureResult {
  letters: Array<
    { char: string; score: number; precision: number; coverage: number; missing: boolean }
  >;
  score: number;
  metrics: {
    slantDiff: number | null;
    size: number | null;
    width: number | null;
    baseline: number | null;
  };
  notes: string[];
  pointClass: number[][];
}

export interface FixtureCase {
  name: string;
  strokes: FixturePoint[][];
  /** null when there is nothing to compare (checkWithModel returned null). */
  result: FixtureResult | null;
}

export interface Fixture {
  version: 1;
  font: string;
  /** Model slant, degrees right of vertical. */
  slant: number;
  text: string;
  model: FixtureModel;
  cases: FixtureCase[];
}

const pen = { kind: "monoline", weight: 3 } as const;

/** Round to `d` decimals; fixtures keep strokes short, and score what they store. */
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** Strokes as stored in a fixture: u and v to 1e-4 x-height, p to 0.01, t whole ms. */
export function toFixtureStrokes(strokes: Stroke[]): FixturePoint[][] {
  return strokes.map((s) =>
    s.points.map((p) => [round(p.u, 4), round(p.v, 4), round(p.p, 2), Math.round(p.t)])
  );
}

export function fromFixtureStrokes(strokes: FixturePoint[][]): Stroke[] {
  return strokes.map((pts) => ({
    pen,
    points: pts.map(([u, v, p, t]) => ({ u, v, p, t })),
  }));
}

/** NaN has no JSON form; it is stored as null. */
const num = (x: number) => Number.isFinite(x) ? x : null;

export function toFixtureResult(r: CheckResult | null): FixtureResult | null {
  if (!r) return null;
  return {
    letters: r.letters.map((l) => ({
      char: l.char,
      score: l.score,
      precision: l.precision,
      coverage: l.coverage,
      missing: l.missing,
    })),
    score: r.score,
    metrics: {
      slantDiff: num(r.metrics.slantDiff),
      size: num(r.metrics.size),
      width: num(r.metrics.width),
      baseline: num(r.metrics.baseline),
    },
    notes: r.notes,
    pointClass: r.pointClass,
  };
}

export function fromFixtureModel(text: string, slant: number, m: FixtureModel): ModelRaster {
  return {
    text,
    w: m.w,
    h: m.h,
    S: m.S,
    vTop: m.vTop,
    Yb: m.Yb,
    uMin: m.uMin,
    bounds: m.bounds,
    asc: m.asc,
    desc: m.desc,
    xRatio: m.xRatio,
    slant,
    ink: rleDecode(m.rle, m.w * m.h),
  };
}

/** Every point moved by `du`, `dv`. */
function shift(strokes: Stroke[], du: number, dv: number): Stroke[] {
  return strokes.map((s) => ({
    pen: s.pen,
    points: s.points.map((p) => ({ ...p, u: p.u + du, v: p.v + dv })),
  }));
}

/**
 * Independent uniform noise of +/- `amp` x-heights on every point's u and v,
 * in stroke then point order: u first, then v, each `(2 * rand() - 1) * amp`.
 */
export function wobble(strokes: Stroke[], amp: number, seed: number): Stroke[] {
  const rand = mulberry32(seed);
  return strokes.map((s) => ({
    pen: s.pen,
    points: s.points.map((p) => {
      const du = (2 * rand() - 1) * amp;
      const dv = (2 * rand() - 1) * amp;
      return { ...p, u: p.u + du, v: p.v + dv };
    }),
  }));
}

/**
 * Drop the points that fall within letter `index`'s columns, splitting
 * strokes where they pass through it. A point's column is found as the check
 * does: shear by the slant, then scale to the raster.
 */
export function dropLetter(strokes: Stroke[], m: ModelRaster, index: number): Stroke[] {
  const tan = Math.tan((m.slant * Math.PI) / 180);
  const inside = (p: { u: number; v: number }) => {
    const x = (p.u + p.v * tan - m.uMin) * m.S;
    return x >= m.bounds[index] && x < m.bounds[index + 1];
  };
  const out: Stroke[] = [];
  for (const s of strokes) {
    let run: Stroke["points"] = [];
    const flush = () => {
      if (run.length >= 2) out.push({ pen: s.pen, points: run });
      run = [];
    };
    for (const p of s.points) {
      if (inside(p)) flush();
      else run.push(p);
    }
    flush();
  }
  return out;
}

/** The letter to drop for "missing-letter": the middle one that isn't a space. */
export function missingLetterIndex(text: string): number {
  const idx = [...text].flatMap((c, i) => /\s/.test(c) ? [] : [i]);
  return idx[idx.length >> 1];
}

const wobbles: Array<[string, number, number]> = [
  ["wobble06", 0.06, 6],
  ["wobble10", 0.10, 10],
  ["wobble15", 0.15, 15],
];

export function buildFixture(m: ModelRaster, fontId: string): Fixture {
  const perfect = fromFixtureStrokes(toFixtureStrokes(strokesFromModel(m)));
  const named: Array<[string, Stroke[]]> = [
    ["perfect", perfect],
    ["shifted", shift(perfect, 0.3, 0)],
    ...wobbles.map(([name, amp, seed]) => [name, wobble(perfect, amp, seed)] as [string, Stroke[]]),
    ["missing-letter", dropLetter(perfect, m, missingLetterIndex(m.text))],
    ["empty", []],
  ];
  const cases = named.map(([name, strokes]): FixtureCase => {
    // Score exactly what is stored, so the rounding can't matter.
    const stored = toFixtureStrokes(strokes);
    return {
      name,
      strokes: stored,
      result: toFixtureResult(checkWithModel(m, fromFixtureStrokes(stored))),
    };
  });
  return {
    version: 1,
    font: fontId,
    slant: m.slant,
    text: m.text,
    model: {
      w: m.w,
      h: m.h,
      S,
      vTop: m.vTop,
      Yb: m.Yb,
      uMin: m.uMin,
      bounds: m.bounds,
      asc: m.asc,
      desc: m.desc,
      xRatio: m.xRatio,
      rle: rleEncode(m.ink),
    },
    cases,
  };
}
