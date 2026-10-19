// Stroke order and direction (M10): did the writer make each letter's strokes the way the model
// strokes say? A port of the iPad app's StrokeOrder.swift, to the contract of its docs/strokes.md,
// pinned by the golden vectors in testdata/strokes (stroke-order_test.ts). Works inside the letter
// spans the DTW alignment already gave.
//
// The per-stroke test is a port of the approach of Hanzi Writer's `strokeMatches` (MIT licence,
// Copyright David Chanin; https://github.com/chanind/hanzi-writer; see third_party/hanzi-writer):
// start and end distance, mean best cosine of edge directions, length ratio, a Frechet shape
// distance with a small rotation tolerance, and "does a later model stroke fit better" for order.
// No code is copied from hanzi-writer. Differences, all deliberate: strokes are resampled by arc
// length, the direction cosine is taken inside a window (so a clockwise circle is not excused by
// the counter-clockwise edge a quarter-turn away), closed loops get a turning-sense test, runs are
// trimmed of their lead-in and lead-out first (joins and flicks), and the stroke-to-stroke
// assignment is a deterministic greedy one by cost rather than one stroke at a time.

import type { Stroke } from "./ink.ts";
import { letterIndexAt } from "./metrics.ts";
import { piecewise, S } from "./evaluate.ts";

// ---- stroke model types (docs/strokes.md, "(a) Stroke model file") ---------------------------

export type StrokeKind = "main" | "dot" | "cross";
export type StrokeOrigin = "table" | "font" | "user" | "transfer";

/** One stroke: points `[u, v]` in x-heights from the glyph origin, upright, v down. Order is direction. */
export interface ModelStroke {
  pts: number[][];
  kind?: StrokeKind;
}

export interface StrokeGlyph {
  strokes: ModelStroke[];
  verified: boolean;
  origin: StrokeOrigin;
  confidence: number;
}

export interface StrokeModelFile {
  v: number;
  model: string;
  source: string;
  copyright?: string;
  licence?: string;
  slant?: number;
  glyphs: Record<string, StrokeGlyph>;
}

/** Finds the strokes of a character, or undefined. */
export type StrokeLookup = (char: string) => StrokeGlyph | undefined;

/** The first lookup that knows the character (the person's own definitions first, then the built-in). */
export function chainLookups(lookups: Array<StrokeLookup | null | undefined>): StrokeLookup | null {
  const l = lookups.filter((x): x is StrokeLookup => !!x);
  if (l.length === 0) return null;
  return (ch) => {
    for (const f of l) {
      const g = f(ch);
      if (g) return g;
    }
    return undefined;
  };
}

/** A point in a glyph, letter or line frame. */
export interface Pt {
  u: number;
  v: number;
}

export const strokePoints = (s: ModelStroke): Pt[] =>
  s.pts.filter((p) => p.length >= 2).map((p) => ({ u: p[0], v: p[1] }));

export const strokeKind = (s: ModelStroke): StrokeKind => s.kind ?? "main";

// ---- thresholds ------------------------------------------------------------------------------

export const OrderLimits = {
  /** Points per resampled curve (16 edges). */
  samples: 17,
  /** A run shorter than this (x-heights of arc) is a dot or a stray mark, not a stroke. */
  tinyArc: 0.15,
  /** A mark counts as a dot when its bounding box diagonal is at most this... */
  dotDiagonal: 0.35,
  /** ...and its centre is within this of the model dot's. */
  dotTolerance: 0.5,
  startTolerance: 0.4,
  startShare: 0.25,
  shapeTolerance: 0.3,
  shapeArcFloor: 0.8,
  lengthMin: 0.4,
  lengthMax: 2.5,
  directionMinimum: 0.5,
  directionWindow: 3,
  rotation: Math.PI / 16,
  turningMinimum: 1.2,
  hairpin: 2.6,
  closedEnds: 0.35,
  closedMinArc: 1.2,
  trimArc: 0.4,
  trimArcCut: 1.0,
  hysteresis: 0.1,
  nominalReach: 0.25,
  minConfidence: 0.5,
  creditWrongStart: 0.4,
  creditOutOfOrder: 0.5,
  creditRunTogether: 0.5,
  extraLiftPenalty: 0.15,
  unverifiedWeight: 0.5,
  sizeMin: 0.4,
  sizeMax: 2.5,
  bottomMin: -0.8,
  bottomMax: 0.8,
  slantLimit: 25,
} as const;

// ---- curve helpers ---------------------------------------------------------------------------

export function pathLength(p: Pt[]): number {
  let s = 0;
  for (let i = 0; i < p.length - 1; i++) s += Math.hypot(p[i + 1].u - p[i].u, p[i + 1].v - p[i].v);
  return s;
}

/** `n` points evenly spaced by arc length, both ends included. All the same point if the arc is 0. */
export function resampleEven(p: Pt[], n: number): Pt[] {
  if (p.length === 0) return [];
  const L = pathLength(p);
  if (L === 0 || p.length === 1) return Array.from({ length: n }, () => p[0]);
  const cum = [0];
  for (let i = 0; i < p.length - 1; i++) {
    cum.push(cum[i] + Math.hypot(p[i + 1].u - p[i].u, p[i + 1].v - p[i].v));
  }
  const out: Pt[] = [];
  let i = 0;
  for (let k = 0; k < n; k++) {
    const target = (L * k) / (n - 1);
    if (k === n - 1 || target >= L) {
      out.push(p[p.length - 1]);
      continue;
    }
    while (i < p.length - 2 && cum[i + 1] < target) i++;
    const seg = cum[i + 1] - cum[i];
    const t = seg > 0 ? (target - cum[i]) / seg : 0;
    out.push({
      u: p[i].u + (p[i + 1].u - p[i].u) * t,
      v: p[i].v + (p[i + 1].v - p[i].v) * t,
    });
  }
  return out;
}

export const dist = (a: Pt, b: Pt): number => Math.hypot(a.u - b.u, a.v - b.v);

export function centroid(p: Pt[]): Pt {
  const n = Math.max(1, p.length);
  return { u: p.reduce((a, q) => a + q.u, 0) / n, v: p.reduce((a, q) => a + q.v, 0) / n };
}

/** Diagonal of the bounding box of the points (0 for none). */
export function bboxDiagonal(p: Pt[]): number {
  if (p.length === 0) return 0;
  let u0 = p[0].u, u1 = p[0].u, v0 = p[0].v, v1 = p[0].v;
  for (const q of p) {
    u0 = Math.min(u0, q.u);
    u1 = Math.max(u1, q.u);
    v0 = Math.min(v0, q.v);
    v1 = Math.max(v1, q.v);
  }
  return Math.hypot(u1 - u0, v1 - v0);
}

const frechetBuf = new Float64Array(64 * 64);

/** Discrete Frechet distance of two curves (the dynamic programme over `|a_i - b_j|`). */
export function frechet(a: Pt[], b: Pt[]): number {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) return Infinity;
  const ca = n * m <= frechetBuf.length ? frechetBuf : new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const d = dist(a[i], b[j]);
      let best: number;
      if (i === 0 && j === 0) best = d;
      else if (i === 0) best = Math.max(ca[j - 1], d);
      else if (j === 0) best = Math.max(ca[(i - 1) * m], d);
      else {
        best = Math.max(
          Math.min(ca[(i - 1) * m + j], ca[(i - 1) * m + j - 1], ca[i * m + j - 1]),
          d,
        );
      }
      ca[i * m + j] = best;
    }
  }
  return ca[n * m - 1];
}

function rotated(p: Pt[], th: number): Pt[] {
  const c = Math.cos(th), s = Math.sin(th);
  return p.map((q) => ({ u: q.u * c - q.v * s, v: q.u * s + q.v * c }));
}

const minus = (p: Pt[], c: Pt): Pt[] => p.map((q) => ({ u: q.u - c.u, v: q.v - c.v }));

/**
 * The model orientations the shape test tries, centred on the centroid: forward and reversed, or for a
 * closed loop (both ends meet) every cyclic shift of the 16-point ring in both senses.
 */
export function shapeVariants(mm: Pt[], closed: boolean): Pt[][] {
  if (!closed) return [mm, [...mm].reverse()];
  const variants: Pt[][] = [];
  const ring = mm.slice(0, -1);
  for (const base of [ring, [...ring].reverse()]) {
    for (let sh = 0; sh < ring.length; sh++) {
      variants.push([...base.slice(sh), ...base.slice(0, sh), base[sh]]);
    }
  }
  return variants;
}

/** Frechet shape distance of resampled, centred curves over max(model arc, 0.8). */
function shapeDistancePrepared(rot: Pt[][], variants: Pt[][], modelArc: number): number {
  let best = Infinity;
  for (const orient of variants) {
    for (const r of rot) best = Math.min(best, frechet(r, orient));
  }
  return best / Math.max(modelArc, OrderLimits.shapeArcFloor);
}

/**
 * Frechet shape distance after centring both on their centroids, with the run rotated by at most
 * pi/16 either way and the model taken in either direction; divided by max(model arc, 0.8). With
 * `closed` the model's start may sit anywhere on the loop.
 */
export function shapeDistance(run: Pt[], model: Pt[], closed = false): number {
  const n = OrderLimits.samples;
  const r = resampleEven(run, n), m = resampleEven(model, n);
  const rr = minus(r, centroid(r));
  const rot = [rr, rotated(rr, -OrderLimits.rotation), rotated(rr, OrderLimits.rotation)];
  return shapeDistancePrepared(
    rot,
    shapeVariants(minus(m, centroid(m)), closed),
    pathLength(model),
  );
}

export function edges(p: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < p.length - 1; i++) {
    const dx = p[i + 1].u - p[i].u, dy = p[i + 1].v - p[i].v;
    const l = Math.hypot(dx, dy);
    out.push(l > 0 ? { u: dx / l, v: dy / l } : { u: 0, v: 0 });
  }
  return out;
}

/** Mean over the run's edges of the best cosine to a model edge within the window. */
function directionPrepared(er: Pt[], em: Pt[], cyclic: boolean): number {
  const ne = er.length, w = OrderLimits.directionWindow;
  const score = (shift: number): number => {
    let sum = 0;
    for (let i = 0; i < ne; i++) {
      let best = -2;
      for (let d = -w; d <= w; d++) {
        let j = i + d + shift;
        if (cyclic) j = ((j % ne) + ne) % ne;
        else if (j < 0 || j >= ne) continue;
        best = Math.max(best, er[i].u * em[j].u + er[i].v * em[j].v);
      }
      sum += best < -1.5 ? -1 : best;
    }
    return sum / ne;
  };
  if (!cyclic) return score(0);
  let best = -2;
  for (let s = 0; s < ne; s++) best = Math.max(best, score(s));
  return best;
}

export function directionScore(run: Pt[], model: Pt[], cyclic: boolean): number {
  const n = OrderLimits.samples;
  return directionPrepared(edges(resampleEven(run, n)), edges(resampleEven(model, n)), cyclic);
}

/** Net signed turning (radians) of a curve's resample, ignoring hairpin turns. Positive is clockwise on screen. */
export function turning(p: Pt[]): number {
  const e = edges(resampleEven(p, OrderLimits.samples));
  let sum = 0;
  for (let i = 0; i < e.length - 1; i++) {
    if ((e[i].u === 0 && e[i].v === 0) || (e[i + 1].u === 0 && e[i + 1].v === 0)) continue;
    const cross = e[i].u * e[i + 1].v - e[i].v * e[i + 1].u;
    const dot = e[i].u * e[i + 1].u + e[i].v * e[i + 1].v;
    const a = Math.atan2(cross, dot);
    if (Math.abs(a) <= OrderLimits.hairpin) sum += a;
  }
  return sum;
}

const senseConflictOf = (a: number, b: number): boolean =>
  Math.abs(a) > OrderLimits.turningMinimum && Math.abs(b) > OrderLimits.turningMinimum &&
  (a > 0) !== (b > 0);

export function isClosed(p: Pt[]): boolean {
  if (p.length === 0) return false;
  return dist(p[0], p[p.length - 1]) <= OrderLimits.closedEnds &&
    pathLength(p) >= OrderLimits.closedMinArc;
}

// ---- prepared curves -------------------------------------------------------------------------

/** A model stroke ready for matching. */
export class ModelCurve {
  readonly pts: Pt[];
  readonly isDot: boolean;
  readonly arc: number;
  readonly closed: boolean;
  readonly centre: Pt;
  readonly r: Pt[];
  readonly edges: Pt[];
  /** Unit edges of the stroke walked backwards. */
  readonly edgesBack: Pt[];
  readonly variants: Pt[][];
  readonly turning: number;
  /** Start tolerance for this stroke: max(0.4, 0.25 * arc). */
  readonly startTol: number;

  constructor(s: ModelStroke) {
    this.pts = strokePoints(s);
    this.isDot = strokeKind(s) === "dot";
    this.arc = pathLength(this.pts);
    this.closed = isClosed(this.pts);
    this.centre = centroid(this.pts);
    this.r = resampleEven(this.pts, OrderLimits.samples);
    this.edges = edges(this.r);
    this.edgesBack = [...this.edges].reverse().map((e) => ({ u: -e.u, v: -e.v }));
    this.variants = this.pts.length === 0
      ? []
      : shapeVariants(minus(this.r, centroid(this.r)), this.closed);
    this.turning = this.closed ? turning(this.pts) : 0;
    this.startTol = Math.max(OrderLimits.startTolerance, OrderLimits.startShare * this.arc);
  }
}

/** A part of a run (points `i...j`), resampled and measured. */
class RunVariant {
  readonly pts: Pt[];
  readonly arc: number;
  readonly closed: boolean;
  readonly r: Pt[];
  readonly rotations: Pt[][];
  readonly edges: Pt[];
  #turning: number | null = null;

  constructor(p: Pt[]) {
    this.pts = p;
    this.arc = pathLength(p);
    this.closed = isClosed(p);
    this.r = resampleEven(p, OrderLimits.samples);
    const rr = minus(this.r, centroid(this.r));
    this.rotations = [rr, rotated(rr, -OrderLimits.rotation), rotated(rr, OrderLimits.rotation)];
    this.edges = edges(this.r);
  }

  get turning(): number {
    return this.#turning ??= turning(this.pts);
  }
}

export interface VariantKey {
  i: number;
  j: number;
}

/** The writer's run, with the variants trimmed of lead-in and lead-out cached. */
export class RunCurve {
  readonly pts: Pt[];
  readonly cum: number[];
  readonly arc: number;
  readonly diagonal: number;
  readonly centre: Pt;
  readonly cutStart: boolean;
  readonly cutEnd: boolean;
  #cache = new Map<string, RunVariant>();

  constructor(p: Pt[], cutStart = false, cutEnd = false) {
    this.cutStart = cutStart;
    this.cutEnd = cutEnd;
    this.pts = p;
    const c = [0];
    for (let i = 0; i < p.length - 1; i++) c.push(c[i] + dist(p[i], p[i + 1]));
    this.cum = c;
    this.arc = c[c.length - 1] ?? 0;
    this.diagonal = bboxDiagonal(p);
    this.centre = centroid(p);
  }

  /** A mark that can be a dot: small in every direction (a bounding box diagonal of at most 0.35). */
  get dotLike(): boolean {
    return this.diagonal <= OrderLimits.dotDiagonal;
  }

  variant(k: VariantKey): RunVariant {
    const key = `${k.i},${k.j}`;
    let v = this.#cache.get(key);
    if (!v) {
      v = new RunVariant(this.pts.slice(k.i, k.j + 1));
      this.#cache.set(key, v);
    }
    return v;
  }

  /**
   * Indices `(i, j)` of the part of the run kept: `i` the point within the first `trimArc` of arc
   * (`trimArcCut` where the pen stroke came from another letter) nearest `head` (the first of
   * equals), `j` the point within the last `trimArc` (`trimArcCut` if it goes on into another
   * letter) nearest `tail` (the last of equals). The whole run when that leaves nothing, or under `tinyArc`.
   */
  trimRange(head: Pt, tail: Pt): VariantKey {
    const n = this.pts.length;
    const headLimit = this.cutStart ? OrderLimits.trimArcCut : OrderLimits.trimArc;
    const tailLimit = this.cutEnd ? OrderLimits.trimArcCut : OrderLimits.trimArc;
    let i = 0, bi = dist(this.pts[0], head);
    let k = 1;
    while (k < n && this.cum[k] <= headLimit) {
      const d = dist(this.pts[k], head);
      if (d < bi) {
        bi = d;
        i = k;
      }
      k++;
    }
    let j = n - 1, bj = dist(this.pts[n - 1], tail);
    k = n - 2;
    while (k >= 0 && this.arc - this.cum[k] <= tailLimit) {
      const d = dist(this.pts[k], tail);
      if (d < bj) {
        bj = d;
        j = k;
      }
      k--;
    }
    if (j <= i || this.cum[j] - this.cum[i] < OrderLimits.tinyArc) return { i: 0, j: n - 1 };
    return { i, j };
  }
}

// ---- one run against one model stroke --------------------------------------------------------

export type PairKind = "match" | "reversed" | "wrongStart";

export interface PairResult {
  kind: PairKind;
  /** Mean distance between the two resampled curves (x-heights), the assignment cost. */
  cost: number;
}

const rank = (k: PairKind): number => k === "match" ? 0 : k === "reversed" ? 1 : 2;

/** One part of a run against a model stroke. */
function classifyPart(v: RunVariant, m: ModelCurve): PairResult | null {
  if (!(v.arc >= OrderLimits.tinyArc) || v.pts.length === 0) return null;
  const ratio = (v.arc + 0.15) / (m.arc + 0.15);
  if (!(ratio >= OrderLimits.lengthMin && ratio <= OrderLimits.lengthMax)) return null;
  const closed = m.closed && v.closed;
  if (!(shapeDistancePrepared(v.rotations, m.variants, m.arc) <= OrderLimits.shapeTolerance)) {
    return null;
  }
  const conflict = closed && senseConflictOf(v.turning, m.turning);
  const dirF = directionPrepared(v.edges, m.edges, closed);
  const dirOK = dirF >= OrderLimits.directionMinimum && !conflict;
  // Whether it runs the model backwards: its edges fit the walked-back model better than the model
  // itself and well enough; for a loop the turning sense.
  let backOK = conflict;
  if (!closed) {
    const dirB = directionPrepared(v.edges, m.edgesBack, false);
    backOK = dirB >= OrderLimits.directionMinimum && dirB > dirF;
  }
  const startF = dist(v.pts[0], m.pts[0]), startB = dist(v.pts[0], m.pts[m.pts.length - 1]);
  const n = OrderLimits.samples;
  const cost = (ref: Pt[]): number => {
    let s = 0;
    for (let k = 0; k < n; k++) s += dist(v.r[k], ref[k]);
    return s / n;
  };
  const tol = m.startTol;
  if (startF <= tol && dirOK && !(startB <= tol && startB < startF && backOK)) {
    return { kind: "match", cost: cost(m.r) };
  }
  if ((startB <= tol && backOK) || conflict) {
    return { kind: "reversed", cost: cost([...m.r].reverse()) };
  }
  if (dirOK && startF > tol) return { kind: "wrongStart", cost: cost(m.r) };
  return null;
}

export function classifyPrepared(run: RunCurve, m: ModelCurve): PairResult | null {
  if (run.pts.length === 0 || m.pts.length === 0) return null;
  if (m.isDot) {
    // A dot is a mark of its own: a piece of a longer pen stroke is a join, not a dot.
    if (!run.dotLike || run.cutStart || run.cutEnd) return null;
    const d = dist(run.centre, m.centre);
    return d <= OrderLimits.dotTolerance ? { kind: "match", cost: d } : null;
  }
  if (run.arc < OrderLimits.tinyArc) return null;
  // The whole run first: a match stands, and so does a reversal (unless the run is a piece of a
  // longer pen stroke, whose ends are joins). Otherwise the run trimmed towards the model's ends,
  // and towards them reversed, may do better; the best explanation wins (match, then reversed,
  // then wrong start; then the lower cost).
  const whole: VariantKey = { i: 0, j: run.pts.length - 1 };
  let best = classifyPart(run.variant(whole), m);
  if (
    best && (best.kind === "match" || (best.kind === "reversed" && !run.cutStart && !run.cutEnd))
  ) {
    return best;
  }
  const keys: VariantKey[] = [whole];
  const first = m.pts[0], last = m.pts[m.pts.length - 1];
  for (const k of [run.trimRange(first, last), run.trimRange(last, first)]) {
    if (keys.some((x) => x.i === k.i && x.j === k.j)) continue;
    keys.push(k);
    const p = classifyPart(run.variant(k), m);
    if (!p) continue;
    if (
      !best || rank(p.kind) < rank(best.kind) ||
      (rank(p.kind) === rank(best.kind) && p.cost < best.cost)
    ) best = p;
  }
  return best;
}

/** How a run relates to a model stroke, null if it is not that stroke at all. */
export function classify(run: Pt[], model: ModelStroke): PairResult | null {
  return classifyPrepared(new RunCurve(run), new ModelCurve(model));
}

// ---- one letter ------------------------------------------------------------------------------

/** A run of the writer's pen inside one letter, with whether its pen stroke carried on from / into another letter. */
export interface RunPiece {
  pts: Pt[];
  cutStart: boolean;
  cutEnd: boolean;
}

export const piece = (pts: Pt[], cutStart = false, cutEnd = false): RunPiece => ({
  pts,
  cutStart,
  cutEnd,
});

export interface LetterOrder {
  char: string;
  verified: boolean;
  modelStrokes: number;
  runs: number;
  matched: number;
  reversed: number;
  wrongStart: number;
  wrongOrder: number;
  extraLifts: number;
  missingLifts: number;
  unmatched: number;
  credit: number;
  missingStrokes: number;
}

export function letterFlagged(l: LetterOrder): boolean {
  return l.reversed > 0 || l.wrongStart > 0 || l.wrongOrder > 0 || l.extraLifts > 0 ||
    l.missingLifts > 0 || l.missingStrokes > 0;
}

/** Indices (into `ks`) of the longest strictly increasing subsequence, as the spec says. */
export function longestIncreasing(ks: number[]): Set<number> {
  const n = ks.length;
  if (n === 0) return new Set();
  const dp = new Array<number>(n).fill(1), prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (ks[j] < ks[i] && dp[j] + 1 > dp[i]) {
        dp[i] = dp[j] + 1;
        prev[i] = j;
      }
    }
  }
  let end = 0;
  for (let i = 0; i < n; i++) if (dp[i] > dp[end]) end = i;
  const out = new Set<number>();
  for (let cur = end; cur >= 0; cur = prev[cur]) out.add(cur);
  return out;
}

/** What judging a letter leaves for its neighbours (marks that might be their dots). */
export interface LetterJudgement {
  order: LetterOrder;
  /** Indices of the letter's own pieces that are dot-sized marks no stroke took. */
  spareDots: number[];
  /** Model dot strokes no run took. */
  openDots: number[];
}

const splitSamples = 41;

/** Does `run`, cut somewhere, read as `a` then `b` (each part is any kind of match)? */
function explainsBoth(run: RunCurve, a: ModelCurve, b: ModelCurve): boolean {
  const pts = resampleEven(run.pts, splitSamples);
  for (let k = 4; k <= splitSamples - 5; k++) {
    if (
      classifyPrepared(new RunCurve(pts.slice(0, k + 1)), a) &&
      classifyPrepared(new RunCurve(pts.slice(k)), b)
    ) return true;
  }
  return false;
}

/**
 * Judge one letter. `pieces` are the writer's runs in drawing order, in the letter's frame (pieces
 * in `excluded` were taken by a neighbour); `borrowed` are dot-sized marks of neighbouring letters,
 * already carried into this letter's frame, that can only be this letter's dots.
 */
export function judgeLetter(
  char: string,
  glyph: StrokeGlyph,
  pieces: RunPiece[],
  excluded: Set<number> = new Set(),
  borrowed: Pt[][] = [],
): LetterJudgement {
  const models = glyph.strokes.map((s) => new ModelCurve(s));
  interface Run {
    id: number;
    run: RunCurve;
    piece: RunPiece;
    borrowed: boolean;
  }
  const runs: Run[] = [];
  pieces.forEach((p, i) => {
    if (!excluded.has(i)) {
      runs.push({
        id: i,
        run: new RunCurve(p.pts, p.cutStart, p.cutEnd),
        piece: p,
        borrowed: false,
      });
    }
  });
  borrowed.forEach((b, i) => {
    runs.push({
      id: pieces.length + i,
      run: new RunCurve(b),
      piece: piece(b),
      borrowed: true,
    });
  });

  interface Cand {
    run: number;
    model: number;
    pair: PairResult;
  }
  const cands: Cand[] = [];
  runs.forEach((r, j) => {
    models.forEach((m, k) => {
      if (r.borrowed && !m.isDot) return;
      const p = classifyPrepared(r.run, m);
      if (p) cands.push({ run: j, model: k, pair: p });
    });
  });
  // Deterministic greedy assignment: matches before the other kinds, then by cost, then run, then model.
  cands.sort((a, b) => {
    const ta = a.pair.kind === "match" ? 0 : 1, tb = b.pair.kind === "match" ? 0 : 1;
    if (ta !== tb) return ta - tb;
    if (a.pair.cost !== b.pair.cost) return a.pair.cost < b.pair.cost ? -1 : 1;
    if (a.run !== b.run) return a.run - b.run;
    return a.model - b.model;
  });
  const runTaken = new Set<number>(), modelTaken = new Set<number>();
  const assigned: Array<{ run: number; model: number; kind: PairKind }> = [];
  for (const c of cands) {
    if (runTaken.has(c.run) || modelTaken.has(c.model)) continue;
    runTaken.add(c.run);
    modelTaken.add(c.model);
    assigned.push({ run: c.run, model: c.model, kind: c.pair.kind });
  }
  assigned.sort((a, b) => a.run - b.run);

  // Unassigned runs: dot-sized marks are never strokes or lifts; a piece that crosses into another
  // letter is a join, never a lift; the rest are strokes the model has no place for.
  const unassigned = runs.map((_, i) => i).filter((i) => !runTaken.has(i) && !runs[i].borrowed);
  const spareDots = unassigned.filter((i) => runs[i].run.dotLike).map((i) => runs[i].id);
  const loose = unassigned.filter((i) =>
    !runs[i].run.dotLike && runs[i].run.arc >= OrderLimits.tinyArc
  );
  const lifts = loose.filter((i) => !(runs[i].piece.cutStart || runs[i].piece.cutEnd));
  const counted = assigned.length + lifts.length;
  const extra = Math.max(0, counted - models.length);

  // Required model strokes with no run: explained by one run that covers two of them, blamed on a
  // leftover run that fits nothing (a shape problem, not judged here), or missing.
  const open = models.map((_, i) => i).filter((i) => !modelTaken.has(i));
  const explained = new Set<number>();
  let missingLifts = 0;
  let free = [...loose];
  const byArc = [...loose].sort((a, b) =>
    runs[a].run.arc !== runs[b].run.arc ? (runs[a].run.arc > runs[b].run.arc ? -1 : 1) : a - b
  );
  for (const r of byArc) {
    if (!(runs[r].run.arc >= 0.3)) continue;
    const cand = open.filter((i) => !explained.has(i) && !models[i].isDot);
    let hit: [number, number] | null = null;
    search:
    for (const a of cand) {
      for (const b of cand) {
        if (b === a) continue;
        if (explainsBoth(runs[r].run, models[a], models[b])) {
          hit = [a, b];
          break search;
        }
      }
    }
    if (hit) {
      explained.add(hit[0]);
      explained.add(hit[1]);
      missingLifts++;
      free = free.filter((x) => x !== r);
    }
  }
  const left = open.filter((i) => !explained.has(i));
  const leftStrokes = left.filter((i) => !models[i].isDot).length;
  const neutral = Math.min(leftStrokes, free.length);
  const missingStrokes = left.length - neutral;

  const inOrder = longestIncreasing(assigned.map((a) => a.model));
  let credit = explained.size * OrderLimits.creditRunTogether;
  let matched = 0, reversed = 0, wrongStart = 0;
  assigned.forEach((a, i) => {
    if (a.kind === "match") matched++;
    else if (a.kind === "reversed") reversed++;
    else wrongStart++;
    const base = a.kind === "match"
      ? 1
      : a.kind === "wrongStart"
      ? OrderLimits.creditWrongStart
      : 0;
    credit += inOrder.has(i) ? base : base * OrderLimits.creditOutOfOrder;
  });
  const judgedStrokes = models.length - neutral;
  let q = judgedStrokes <= 0 ? 1 : credit / judgedStrokes;
  q = Math.max(0, Math.min(1, q - OrderLimits.extraLiftPenalty * extra));
  const order: LetterOrder = {
    char,
    verified: glyph.verified,
    modelStrokes: models.length,
    runs: counted,
    matched,
    reversed,
    wrongStart,
    wrongOrder: assigned.length - inOrder.size,
    extraLifts: extra,
    missingLifts,
    unmatched: open.length,
    credit: q,
    missingStrokes,
  };
  return { order, spareDots, openDots: open.filter((i) => models[i].isDot) };
}

/** Judge one letter: the writer's runs (in drawing order, in the letter's frame) against its model strokes. */
export function matchLetter(char: string, glyph: StrokeGlyph, pieces: RunPiece[]): LetterOrder {
  return judgeLetter(char, glyph, pieces).order;
}

// ---- a line ----------------------------------------------------------------------------------

/** What `orderMetrics` needs from a check. */
export interface OrderInput {
  uMin: number;
  tan: number;
  userBounds: number[];
  modelBounds: number[];
  letters: Array<{ index: number; char: string; missing: boolean }>;
  /** Per entry of `letters` (empty: no correction); NaN where the letter is not a body letter. */
  letterSize: number[];
  letterBottom: number[];
  /** The writer's slant relative to the model in degrees (the line metric `slantDiff`); 0 when absent. */
  slantDiff: number;
}

/** The u extent (x-heights, letter frame) of a glyph's strokes. */
function strokeExtent(g: StrokeGlyph): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (const s of g.strokes) {
    for (const p of strokePoints(s)) {
      lo = Math.min(lo, p.u);
      hi = Math.max(hi, p.u);
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * The writer's pieces per model character index, each in that letter's frame (x-heights from the
 * letter's origin in the model, upright, baseline 0). See docs/strokes.md, "Runs".
 */
export function letterPiecesInModelFrame(
  strokes: Stroke[],
  input: OrderInput,
  models: StrokeLookup | null = null,
): Map<number, RunPiece[]> {
  const out = new Map<number, RunPiece[]>();
  const n = input.userBounds.length - 1;
  if (n < 1 || input.modelBounds.length !== input.userBounds.length) return out;
  const known = new Set(input.letters.filter((l) => !l.missing).map((l) => l.index));
  const extent = new Map<number, [number, number]>();
  for (const i of known) {
    if (i < 0 || i >= n) continue;
    const ch = input.letters.find((l) => l.index === i)!.char;
    const g = models?.(ch);
    const e = g ? strokeExtent(g) : null;
    if (e) extent.set(i, e);
    else extent.set(i, [0, Math.max(0, (input.modelBounds[i + 1] - input.modelBounds[i]) / S)]);
  }
  // The writer's own lean over the model's is taken out about mid x-height.
  const slantDiff = Math.min(
    Math.max(input.slantDiff, -OrderLimits.slantLimit),
    OrderLimits.slantLimit,
  );
  const shear = Math.tan((slantDiff * Math.PI) / 180);

  const letterOf = (x: number, mx: number, cur: number | null): number | null => {
    const gap = (c: number): number | null => {
      if (c < 0 || c >= n || !known.has(c)) return null;
      const e = extent.get(c);
      if (!e) return null;
      const u = (mx - input.modelBounds[c]) / S;
      return Math.max(0, e[0] - u, u - e[1]);
    };
    if (cur !== null) {
      const g = gap(cur);
      if (g !== null && g <= OrderLimits.hysteresis) return cur;
    }
    const nominal = letterIndexAt(x, input.userBounds);
    const gn = gap(nominal);
    if (gn !== null && gn <= OrderLimits.nominalReach) return nominal;
    let best: { c: number; g: number } | null = null;
    for (const c of [nominal, nominal - 1, nominal + 1]) {
      const g = gap(c);
      if (g !== null && (best === null || g < best.g)) best = { c, g };
    }
    if (!best) return null;
    if (!known.has(nominal) && best.g > OrderLimits.hysteresis) return null;
    return best.c;
  };

  for (const s of strokes) {
    let cur: { idx: number; pts: Pt[]; first: number } | null = null;
    const parts: Array<{ idx: number; piece: RunPiece }> = [];
    const flush = (last: number) => {
      if (cur) {
        parts.push({
          idx: cur.idx,
          piece: piece(cur.pts, cur.first > 0, last < s.points.length - 1),
        });
      }
      cur = null;
    };
    s.points.forEach((p, k) => {
      const x = (p.u + p.v * input.tan - input.uMin + (p.v + 0.5) * shear) * S;
      const mx = piecewise(input.userBounds, input.modelBounds, x);
      const idx = letterOf(x, mx, cur ? (cur as { idx: number }).idx : null);
      if (idx === null) {
        flush(k - 1);
        return;
      }
      const pt = { u: (mx - input.modelBounds[idx]) / S, v: p.v };
      const c = cur as { idx: number; pts: Pt[]; first: number } | null;
      if (c && c.idx === idx) c.pts.push(pt);
      else {
        flush(k - 1);
        cur = { idx, pts: [pt], first: k };
      }
    });
    flush(s.points.length - 1);
    // A stub of less than `tinyArc` at either end of a pen stroke belongs to the piece it runs into.
    const absorb = (stub: number, into: number, prepend: boolean) => {
      const shift = (input.modelBounds[parts[stub].idx] - input.modelBounds[parts[into].idx]) / S;
      const moved = parts[stub].piece.pts.map((q) => ({ u: q.u + shift, v: q.v }));
      if (prepend) {
        parts[into].piece.pts = [...moved, ...parts[into].piece.pts];
        parts[into].piece.cutStart = parts[stub].piece.cutStart;
      } else {
        parts[into].piece.pts = [...parts[into].piece.pts, ...moved];
        parts[into].piece.cutEnd = parts[stub].piece.cutEnd;
      }
      parts.splice(stub, 1);
    };
    if (parts.length >= 2 && pathLength(parts[0].piece.pts) < OrderLimits.tinyArc) {
      absorb(0, 1, true);
    }
    if (parts.length >= 2 && pathLength(parts[parts.length - 1].piece.pts) < OrderLimits.tinyArc) {
      absorb(parts.length - 1, parts.length - 2, false);
    }
    for (const p of parts) {
      const list = out.get(p.idx);
      if (list) list.push(p.piece);
      else out.set(p.idx, [p.piece]);
    }
  }
  return out;
}

/** The same runs as bare points (what the aids draw beside a model demo). */
export function letterRunsInModelFrame(
  strokes: Stroke[],
  input: OrderInput,
  models: StrokeLookup | null = null,
): Map<number, Pt[][]> {
  const out = new Map<number, Pt[][]>();
  for (const [k, v] of letterPiecesInModelFrame(strokes, input, models)) {
    out.set(k, v.map((p) => p.pts));
  }
  return out;
}

export interface OrderMetrics {
  /** Judged letters, in line order. */
  letters: LetterOrder[];
  /** 0-100, the weighted mean of the letters' credit (unverified glyphs count half). */
  score: number;
  notes: string[];
}

const sumOf = (ls: LetterOrder[], k: keyof LetterOrder): number =>
  ls.reduce((a, l) => a + (l[k] as number), 0);

export const orderTotals = (m: OrderMetrics) => ({
  judged: m.letters.length,
  matched: sumOf(m.letters, "matched"),
  reversed: sumOf(m.letters, "reversed"),
  wrongStart: sumOf(m.letters, "wrongStart"),
  wrongOrder: sumOf(m.letters, "wrongOrder"),
  extraLifts: sumOf(m.letters, "extraLifts"),
  missingLifts: sumOf(m.letters, "missingLifts"),
  missingStrokes: sumOf(m.letters, "missingStrokes"),
});

/** The note texts, from the letters that have each kind of problem. */
export function orderNotes(letters: LetterOrder[]): string[] {
  const list = (pred: (l: LetterOrder) => boolean) => {
    const seen: string[] = [];
    for (const l of letters) if (pred(l) && !seen.includes(l.char)) seen.push(l.char);
    const shown = seen.slice(0, 3).join(", ");
    return { count: seen.length, text: seen.length > 3 ? `${shown} +${seen.length - 3}` : shown };
  };
  const kinds: Array<[(l: LetterOrder) => boolean, string]> = [
    [(l) => l.reversed > 0, "a stroke is drawn in the wrong direction."],
    [(l) => l.wrongStart > 0, "a stroke starts in the wrong place."],
    [(l) => l.wrongOrder > 0, "strokes are drawn in the wrong order."],
    [(l) => l.missingStrokes > 0, "a stroke is missing."],
    [(l) => l.extraLifts > 0, "the pen is lifted where the model keeps going."],
    [(l) => l.missingLifts > 0, "strokes run together where the model lifts the pen."],
  ];
  const found: Array<[number, number, string]> = [];
  kinds.forEach((k, i) => {
    const l = list(k[0]);
    if (l.count > 0) found.push([l.count, i, `${l.text}: ${k[1]}`]);
  });
  found.sort((a, b) => a[0] !== b[0] ? b[0] - a[0] : a[1] - b[1]);
  return found.slice(0, 2).map((f) => f[2]);
}

function medianOfFinite(xs: number[]): number | null {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** A letter's pieces corrected for the writer's size and bottom: v becomes `(v + s) / (s + b) - 1`. */
export function normalisedPieces(pieces: RunPiece[], size: number, bottom: number): RunPiece[] {
  const s = Math.min(Math.max(size, OrderLimits.sizeMin), OrderLimits.sizeMax);
  const b = Math.min(Math.max(bottom, OrderLimits.bottomMin), OrderLimits.bottomMax);
  const h = Math.max(0.3, s + b);
  return pieces.map((p) => ({
    ...p,
    pts: p.pts.map((q) => ({ u: q.u, v: (q.v + s) / h - 1 })),
  }));
}

/** Order and direction for a checked line, or null when no written letter has model strokes. */
export function orderMetrics(
  strokes: Stroke[],
  input: OrderInput,
  models: StrokeLookup,
): OrderMetrics | null {
  const raw = letterPiecesInModelFrame(strokes, input, models);
  const medSize = medianOfFinite(input.letterSize) ?? 1;
  const medBottom = medianOfFinite(input.letterBottom) ?? 0;
  interface Job {
    index: number;
    char: string;
    glyph: StrokeGlyph;
    pieces: RunPiece[];
  }
  const jobs: Job[] = [];
  input.letters.forEach((l, pos) => {
    if (l.missing) return;
    const g = models(l.char);
    if (!g || g.strokes.length === 0 || !(g.confidence >= OrderLimits.minConfidence)) return;
    let pieces = raw.get(l.index) ?? [];
    if (input.letterSize.length > 0) {
      const sz = pos < input.letterSize.length && Number.isFinite(input.letterSize[pos])
        ? input.letterSize[pos]
        : medSize;
      const bt = pos < input.letterBottom.length && Number.isFinite(input.letterBottom[pos])
        ? input.letterBottom[pos]
        : medBottom;
      pieces = normalisedPieces(pieces, sz, bt);
    }
    jobs.push({ index: l.index, char: l.char, glyph: g, pieces });
  });
  if (jobs.length === 0) return null;
  const judged = jobs.map((j) => judgeLetter(j.char, j.glyph, j.pieces));

  // A dot-sized mark that no stroke of its own letter took may be the dot of the letter next to it.
  const claimed = new Map<number, Set<number>>();
  const borrowed = new Map<number, Pt[][]>();
  for (let i = 0; i < jobs.length; i++) {
    if (judged[i].openDots.length === 0) continue;
    const mstrokes = jobs[i].glyph.strokes;
    for (const k of judged[i].openDots) {
      const target = centroid(strokePoints(mstrokes[k]));
      let best: { d: number; j: number; piece: number; pts: Pt[] } | null = null;
      for (let j = 0; j < jobs.length; j++) {
        if (Math.abs(jobs[j].index - jobs[i].index) !== 1) continue;
        const shift = (input.modelBounds[jobs[j].index] - input.modelBounds[jobs[i].index]) / S;
        for (const pi of judged[j].spareDots) {
          if (claimed.get(j)?.has(pi)) continue;
          const pts = jobs[j].pieces[pi].pts.map((q) => ({ u: q.u + shift, v: q.v }));
          const d = dist(centroid(pts), target);
          if (d <= OrderLimits.dotTolerance && (best === null || d < best.d)) {
            best = { d, j, piece: pi, pts };
          }
        }
      }
      if (best) {
        const set = claimed.get(best.j) ?? new Set<number>();
        set.add(best.piece);
        claimed.set(best.j, set);
        const list = borrowed.get(i) ?? [];
        list.push(best.pts);
        borrowed.set(i, list);
      }
    }
  }
  for (let i = 0; i < jobs.length; i++) {
    if (claimed.has(i) || borrowed.has(i)) {
      judged[i] = judgeLetter(
        jobs[i].char,
        jobs[i].glyph,
        jobs[i].pieces,
        claimed.get(i) ?? new Set(),
        borrowed.get(i) ?? [],
      );
    }
  }

  const out = judged.map((j) => j.order);
  const w = out.map((l) => l.verified ? 1 : OrderLimits.unverifiedWeight);
  const total = w.reduce((a, b) => a + b, 0);
  let sum = 0;
  out.forEach((l, i) => sum += l.credit * w[i]);
  return { letters: out, score: Math.round((100 * sum) / total), notes: orderNotes(out) };
}

// ---- the record (docs/strokes.md, "(d) Record") ----------------------------------------------

/** The `order` member of `metrics2`: counts and the per-letter credit (4 decimals). */
export function orderRecord(m: OrderMetrics): Record<string, unknown> {
  const t = orderTotals(m);
  return {
    ...t,
    letters: m.letters.map((l) => ({
      char: l.char,
      matched: l.matched,
      reversed: l.reversed,
      wrongStart: l.wrongStart,
      wrongOrder: l.wrongOrder,
      extraLifts: l.extraLifts,
      missingLifts: l.missingLifts,
      missingStrokes: l.missingStrokes,
      credit: Math.round(l.credit * 10000) / 10000,
    })),
  };
}

// ---- result flags (chips) --------------------------------------------------------------------

export type OrderFlag =
  | "reversed"
  | "wrongStart"
  | "wrongOrder"
  | "extraLift"
  | "missingLift"
  | "missingStroke";

export const flagSymbol: Record<OrderFlag, string> = {
  reversed: "↺",
  wrongStart: "•",
  wrongOrder: "1↔2",
  extraLift: "+lift",
  missingLift: "−lift",
  missingStroke: "−stroke",
};

export const flagTitle: Record<OrderFlag, string> = {
  reversed: "drawn the wrong way round",
  wrongStart: "started in the wrong place",
  wrongOrder: "strokes in the wrong order",
  extraLift: "pen lifted where the model keeps going",
  missingLift: "strokes run together where the model lifts",
  missingStroke: "a stroke is missing",
};

/** The flags to show for a letter, in the order of the notes. */
export function letterFlags(l: LetterOrder): OrderFlag[] {
  const f: OrderFlag[] = [];
  if (l.reversed > 0) f.push("reversed");
  if (l.wrongStart > 0) f.push("wrongStart");
  if (l.wrongOrder > 0) f.push("wrongOrder");
  if (l.extraLifts > 0) f.push("extraLift");
  if (l.missingLifts > 0) f.push("missingLift");
  if (l.missingStrokes > 0) f.push("missingStroke");
  return f;
}

/**
 * The order result of each written letter by its model character index. The judged letters are a
 * subsequence of the written ones, so they are matched by character, in order.
 */
export function pairOrderLetters(
  letters: Array<{ index: number; char: string; missing: boolean }>,
  orderLetters: LetterOrder[],
): Map<number, LetterOrder> {
  const out = new Map<number, LetterOrder>();
  let k = 0;
  for (const l of letters) {
    if (l.missing) continue;
    if (k >= orderLetters.length) break;
    if (orderLetters[k].char === l.char) {
      out.set(l.index, orderLetters[k]);
      k++;
    }
  }
  return out;
}
