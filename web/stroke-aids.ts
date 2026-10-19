// The teaching aids of M10 (iPad docs/strokes.md, "Teaching aids"), as pure geometry: where each model
// letter's strokes sit on a model line, the timeline of an animated stroke-order demo, the progress of
// "trace first" through a line's strokes. None of this judges anything: the rules are in
// stroke-order.ts, and stroke-aids-view.ts draws what is computed here.

import {
  dist,
  OrderLimits,
  pathLength,
  type Pt,
  type StrokeGlyph,
  type StrokeKind,
  strokeKind,
  type StrokeLookup,
  strokePoints,
} from "./stroke-order.ts";

/** One letter of a model line with its model strokes. `originU` is its origin in x-heights from the line's left. */
export interface PlacedLetter {
  /** Position of the character in the model text, by code point. */
  index: number;
  char: string;
  originU: number;
  /** Right end of the letter's advance in the same units. */
  endU: number;
  glyph: StrokeGlyph;
}

/**
 * The letters of `text` that have model strokes (at or above the judging confidence). `starts` has one
 * more entry than the text has code points: the x-height position of each code point's advance start
 * and of the end of the line.
 */
export function placeLetters(text: string, starts: number[], lookup: StrokeLookup): PlacedLetter[] {
  const chars = [...text];
  if (starts.length !== chars.length + 1) return [];
  const out: PlacedLetter[] = [];
  chars.forEach((c, i) => {
    const g = lookup(c);
    if (!g || g.strokes.length === 0 || !(g.confidence >= OrderLimits.minConfidence)) return;
    out.push({ index: i, char: c, originU: starts[i], endU: starts[i + 1], glyph: g });
  });
  return out;
}

/** A stroke of a placed line in the line frame, flattened in drawing order. */
export interface LineStroke {
  /** Index into the placed letters, and the stroke's number within its letter (0-based). */
  letter: number;
  number: number;
  kind: StrokeKind;
  pts: Pt[];
  isDot: boolean;
}

export function lineStrokes(letters: PlacedLetter[]): LineStroke[] {
  const out: LineStroke[] = [];
  letters.forEach((l, li) => {
    l.glyph.strokes.forEach((s, k) => {
      const kind = strokeKind(s);
      out.push({
        letter: li,
        number: k,
        kind,
        pts: strokePoints(s).map((p) => ({ u: p.u + l.originU, v: p.v })),
        isDot: kind === "dot",
      });
    });
  });
  return out;
}

/** The placed letter whose advance holds line-frame column `u` (the nearest one when none does). */
export function letterAt(letters: PlacedLetter[], u: number): number | null {
  if (letters.length === 0) return null;
  const i = letters.findIndex((l) => u >= l.originU && u < l.endU);
  if (i >= 0) return i;
  const mid = (l: PlacedLetter) => (l.originU + l.endU) / 2;
  let best = 0;
  for (let k = 1; k < letters.length; k++) {
    if (Math.abs(mid(letters[k]) - u) < Math.abs(mid(letters[best]) - u)) best = k;
  }
  return best;
}

/** A direction arrow along a stroke: its position at `fraction` of the arc and the unit direction there. */
export function arrowAt(pts: Pt[], fraction: number): { at: Pt; dir: Pt } | null {
  const L = pathLength(pts);
  if (pts.length < 2 || !(L > 0)) return null;
  const target = L * Math.min(1, Math.max(0, fraction));
  let run = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1].u - pts[i].u, pts[i + 1].v - pts[i].v);
    if (d > 0 && run + d >= target) {
      const t = (target - run) / d;
      return {
        at: {
          u: pts[i].u + (pts[i + 1].u - pts[i].u) * t,
          v: pts[i].v + (pts[i + 1].v - pts[i].v) * t,
        },
        dir: { u: (pts[i + 1].u - pts[i].u) / d, v: (pts[i + 1].v - pts[i].v) / d },
      };
    }
    run += d;
  }
  return null;
}

// ---- the demo timeline -----------------------------------------------------------------------

export interface DemoSettings {
  /** Pen speed in x-heights per second. */
  speed: number;
  /** Pause between strokes of a letter, and extra between letters (seconds). */
  strokePause: number;
  letterPause: number;
  /** How long a dot takes to be "put down". */
  dotTime: number;
}

export const demoSettings = (speed = 2): DemoSettings => ({
  speed,
  strokePause: 0.35,
  letterPause: 0.25,
  dotTime: 0.3,
});

export interface DemoItem {
  pts: Pt[];
  isDot: boolean;
  /** Strokes of one group (a letter) are separated by the short pause, groups by the long one. */
  group: number;
}

export interface DemoFrame {
  /** Items drawn completely. */
  finished: number[];
  /** The item being drawn, with the part of it drawn so far and the pen tip. */
  active: number | null;
  partial: Pt[];
  tip: Pt | null;
}

/** A demo laid out in time: item `i` is drawn from `starts[i]` to `ends[i]`, the pen then waits. */
export class DemoTimeline {
  readonly items: DemoItem[];
  readonly starts: number[] = [];
  readonly ends: number[] = [];
  /** Seconds, to the end of the last stroke. */
  readonly duration: number;

  constructor(items: DemoItem[], settings: DemoSettings = demoSettings()) {
    this.items = items;
    let t = 0;
    items.forEach((it, i) => {
      if (i > 0) {
        t += items[i - 1].group === it.group
          ? settings.strokePause
          : settings.strokePause + settings.letterPause;
      }
      const dur = it.isDot
        ? settings.dotTime
        : Math.max(0.25, pathLength(it.pts) / Math.max(0.1, settings.speed));
      this.starts.push(t);
      t += dur;
      this.ends.push(t);
    });
    this.duration = t;
  }

  /** The timeline of a line's strokes (every letter, or one when `only` names a placed letter). */
  static ofLine(line: LineStroke[], only: number | null = null, settings = demoSettings()) {
    return new DemoTimeline(
      line.filter((s) => only === null || s.letter === only)
        .map((s) => ({ pts: s.pts, isDot: s.isDot, group: s.letter })),
      settings,
    );
  }

  /** What is on the paper at time `t` (seconds). */
  frame(t: number): DemoFrame {
    const done: number[] = [];
    for (let i = 0; i < this.items.length; i++) {
      if (t >= this.ends[i]) {
        done.push(i);
        continue;
      }
      if (t >= this.starts[i]) {
        const f = (t - this.starts[i]) / Math.max(1e-9, this.ends[i] - this.starts[i]);
        const part = partial(this.items[i], f);
        return { finished: done, active: i, partial: part, tip: part[part.length - 1] ?? null };
      }
      break;
    }
    return { finished: done, active: null, partial: [], tip: null };
  }
}

function partial(it: DemoItem, f: number): Pt[] {
  if (it.isDot) return f >= 0.5 ? it.pts : [];
  const L = pathLength(it.pts);
  if (L === 0 || it.pts.length < 2) return it.pts;
  const target = L * f;
  const out = [it.pts[0]];
  let run = 0;
  for (let i = 0; i < it.pts.length - 1; i++) {
    const d = Math.hypot(it.pts[i + 1].u - it.pts[i].u, it.pts[i + 1].v - it.pts[i].v);
    if (run + d >= target) {
      const t = d > 0 ? (target - run) / d : 0;
      out.push({
        u: it.pts[i].u + (it.pts[i + 1].u - it.pts[i].u) * t,
        v: it.pts[i].v + (it.pts[i + 1].v - it.pts[i].v) * t,
      });
      return out;
    }
    out.push(it.pts[i + 1]);
    run += d;
  }
  return out;
}

// ---- trace first -----------------------------------------------------------------------------

export interface TraceProgress {
  /** Indices into the line's strokes that have been written. */
  done: Set<number>;
  /** The next stroke to write, null when all are done. */
  next: number | null;
}

/**
 * Which strokes of a line the writer has made so far, for the faint "next stroke" guide. Each writer
 * stroke (upright, in the line frame) is matched to one of the next few unmatched model strokes by
 * where it starts, so a dot or cross-bar written late still ticks off the right stroke. A guide, not a judgement.
 */
export function traceProgress(
  model: LineStroke[],
  written: Pt[][],
  startTolerance = 0.6,
  window = 3,
): TraceProgress {
  const done = new Set<number>();
  for (const w of written) {
    if (w.length === 0) continue;
    const s = w[0];
    const tiny = pathLength(w) < OrderLimits.tinyArc;
    let best: [number, number] | null = null;
    let seen = 0;
    for (let i = 0; i < model.length; i++) {
      const m = model[i];
      if (done.has(i)) continue;
      // A tiny mark can only tick off a dot, and a stroke only a stroke. Dots may come at any time.
      if (m.isDot !== tiny) continue;
      if (!m.isDot) seen++;
      if (!m.isDot && seen > window) break;
      if (m.pts.length === 0) continue;
      const d = dist(s, m.pts[0]);
      if (d <= (m.isDot ? OrderLimits.dotTolerance : startTolerance) && (!best || d < best[1])) {
        best = [i, d];
      }
    }
    if (best) done.add(best[0]);
  }
  let next: number | null = null;
  for (let i = 0; i < model.length; i++) {
    if (!done.has(i)) {
      next = i;
      break;
    }
  }
  return { done, next };
}
