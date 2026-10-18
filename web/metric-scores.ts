// M5 metrics, part 3: everything for one checked line in one value, the
// sub-scores, the plain-language notes, the sheet summary and the record
// members `metrics2` and `pen2`. A port of the iPad app's MetricScores.swift,
// MetricsRecord.swift and CheckSummary.swift; see its docs/metrics.md.

import { median } from "./evalcore.ts";
import {
  type CheckResult,
  type LetterResult,
  type Metrics,
  notes as shapeNotes,
} from "./evaluate.ts";
import type { Stroke } from "./ink.ts";
import {
  type ConsistencyMetrics,
  consistencyMetrics,
  type LetterShape,
  letterShapes,
  lin,
  repeatConsistency,
  roundInt,
  type ShapeDetail,
  shapeDetail,
} from "./metrics.ts";
import { type FluencyMetrics, fluencyMetrics, type PenMetrics, penMetrics } from "./pen-metrics.ts";

/** 0-100 sub-scores. `shape` is the line score; the others are absent when nothing could be measured. */
export interface SubScores {
  shape: number;
  consistency?: number;
  penControl?: number;
  fluency?: number;
}

export interface LineMetrics {
  shape: ShapeDetail;
  consistency: ConsistencyMetrics;
  pen: PenMetrics;
  fluency: FluencyMetrics;
  scores: SubScores;
  /** At most two notes on the worst non-shape issues, worst first. */
  notes: string[];
  /** Written letters (not missing) the rates are per. */
  letters: number;
}

export type Group = "consistency" | "pen" | "fluency";

export interface Component {
  key: string;
  group: Group;
  score: number;
  weight: number;
  note: string;
}

/** A component is worth a note when it scores under this. */
export const noteBelow = 75;

const deg = (x: number) => roundInt(Math.abs(x));

export function components(
  c: ConsistencyMetrics,
  p: PenMetrics,
  f: FluencyMetrics,
  letters: number,
): Component[] {
  const out: Component[] = [];
  const add = (
    key: string,
    group: Group,
    v: number,
    good: number,
    bad: number,
    weight: number,
    note: () => string,
  ) => {
    const score = lin(v, good, bad);
    if (Number.isFinite(score)) out.push({ key, group, score, weight, note: note() });
  };
  add(
    "slantSD",
    "consistency",
    c.slantSD,
    4,
    12,
    1,
    () =>
      `Slant varies by about ±${
        deg(c.slantSD)
      }° from letter to letter — keep your downstrokes parallel.`,
  );
  add(
    "sizeSD",
    "consistency",
    c.sizeSD,
    0.05,
    0.25,
    1,
    () =>
      `Letter heights vary (±${deg(c.sizeSD * 100)}%) — keep every letter to the same x-height.`,
  );
  add(
    "baselineSD",
    "consistency",
    c.baselineSD,
    0.04,
    0.2,
    1,
    () => "Letters sit at uneven heights — bring every letter down to the baseline.",
  );
  add(
    "spacingDevSD",
    "consistency",
    c.spacingDevSD,
    0.1,
    0.5,
    1,
    () => "Gaps between letters are uneven — aim for the same space each time.",
  );
  add(
    "repeatDist",
    "consistency",
    c.repeatDist,
    0.08,
    0.3,
    1,
    () => "The same letter changes shape from one copy to the next.",
  );
  add(
    "pressureCV",
    "pen",
    p.pressureCV,
    0.2,
    0.6,
    1,
    () => "Pressure varies a lot — aim for an even touch.",
  );
  add(
    "nibSD",
    "pen",
    p.nibSD,
    4,
    20,
    1,
    () => `Nib angle drifts ±${deg(p.nibSD)}° — hold it near ${deg(p.nibTarget)}°.`,
  );
  add(
    "nibDev",
    "pen",
    Math.abs(p.nibDev),
    5,
    25,
    1,
    () =>
      `Nib angle averages ${deg(p.nibDev)}° ${p.nibDev > 0 ? "above" : "below"} the ${
        deg(p.nibTarget)
      }° target.`,
  );
  add(
    "altSD",
    "pen",
    p.altSD,
    5,
    20,
    0.5,
    () => `The pen's tilt keeps changing (±${deg(p.altSD)}°) — hold it at a steady angle.`,
  );
  const n = Math.max(1, letters);
  add(
    "hesitations",
    "fluency",
    f.activeMs > 0 ? f.hesitations / n : NaN,
    0.1,
    0.6,
    1,
    () =>
      `${f.hesitations} hesitation${
        f.hesitations === 1 ? "" : "s"
      } mid-stroke — write each stroke in one flowing motion.`,
  );
  add(
    "speedCV",
    "fluency",
    f.speedCV,
    0.4,
    1.0,
    1,
    () => "Speed is uneven — keep a steady, flowing pace.",
  );
  return out;
}

/** `round(sum(score*weight) / sum(weight))` over the group's components; undefined if none. */
export function groupScore(cs: Component[], g: Group): number | undefined {
  const xs = cs.filter((c) => c.group === g);
  const w = xs.reduce((a, c) => a + c.weight, 0);
  return w > 0 ? Math.round(xs.reduce((a, c) => a + c.score * c.weight, 0) / w) : undefined;
}

/** The two lowest-scoring components under `noteBelow` (ties: table order), as notes. */
export function pickNotes(cs: Component[]): string[] {
  return cs.map((c, i) => ({ c, i })).filter((x) => x.c.score < noteBelow)
    .sort((a, b) => a.c.score !== b.c.score ? a.c.score - b.c.score : a.i - b.i)
    .slice(0, 2).map((x) => x.c.note);
}

export function lineMetrics(text: string, strokes: Stroke[], r: CheckResult): LineMetrics {
  const written = r.letters.map((_, i) => i).filter((i) => !r.letters[i].missing);
  const pieces = written.reduce((a, i) => a + r.detail.components[i], 0);
  const cons = consistencyMetrics(text, strokes, r);
  const pen = penMetrics(strokes);
  const flu = fluencyMetrics(strokes, written.length, pieces);
  const cs = components(cons, pen, flu, written.length);
  const scores: SubScores = { shape: r.score };
  const set = (k: "consistency" | "penControl" | "fluency", v: number | undefined) => {
    if (v !== undefined) scores[k] = v;
  };
  set("consistency", groupScore(cs, "consistency"));
  set("penControl", groupScore(cs, "pen"));
  set("fluency", groupScore(cs, "fluency"));
  return {
    shape: shapeDetail(strokes, r),
    consistency: cons,
    pen,
    fluency: flu,
    scores,
    notes: pickNotes(cs),
    letters: written.length,
  };
}

// ---- sheet summary ---------------------------------------------------------------------

/** The part of a line's check a sheet summary needs. */
export interface LineCheck {
  score: number;
  letters: Array<Pick<LetterResult, "char" | "score">>;
  metrics: Metrics;
  scores?: SubScores;
  shapes: LetterShape[];
}

export interface SheetSummary {
  overall: number;
  lineCount: number;
  headline: string;
  weakest: Array<{ char: string; average: number }>;
  /** "Letters to practise: ..." (if any), then the metric notes. */
  tips: string[];
  /** `shape` is the rounded mean line score; the others the rounded mean over the lines that have them. */
  scores?: SubScores;
  repeatDist: number;
}

const repeatNote = "The same letter changes shape from one copy to the next.";

/** The whole sheet's check; null when no line was checked. */
export function summarise(lines: LineCheck[]): SheetSummary | null {
  if (lines.length === 0) return null;
  const overall = roundInt(lines.reduce((a, l) => a + l.score, 0) / lines.length);

  const byChar = new Map<string, number[]>();
  for (const l of lines) {
    for (const letter of l.letters) {
      byChar.set(letter.char, [...(byChar.get(letter.char) ?? []), letter.score]);
    }
  }
  const weakest = [...byChar].map(([char, xs]) => ({
    char,
    average: xs.reduce((a, b) => a + b, 0) / xs.length,
  })).filter((w) => w.average < 85).sort((a, b) => a.average - b.average).slice(0, 3);

  const tips: string[] = [];
  if (weakest.length) {
    tips.push(
      `Letters to practise: ${
        weakest.map((w) => `${w.char} (${roundInt(w.average)}%)`).join(", ")
      }.`,
    );
  }
  const across = (k: keyof Metrics) =>
    median(lines.map((l) => l.metrics[k]).filter((x) => Number.isFinite(x)));
  tips.push(...shapeNotes({
    slantDiff: across("slantDiff"),
    size: across("size"),
    width: across("width"),
    baseline: across("baseline"),
  }));

  let scores: SubScores | undefined;
  const withScores = lines.flatMap((l) => l.scores ? [l.scores] : []);
  if (withScores.length) {
    const mean = (k: "consistency" | "penControl" | "fluency") => {
      const xs = withScores.flatMap((s) => s[k] === undefined ? [] : [s[k]!]);
      return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : undefined;
    };
    scores = { shape: Math.round(lines.reduce((a, l) => a + l.score, 0) / lines.length) };
    for (const k of ["consistency", "penControl", "fluency"] as const) {
      const v = mean(k);
      if (v !== undefined) scores[k] = v;
    }
  }
  const repeatDist = lines.some((l) => l.shapes.length)
    ? repeatConsistency(lines.flatMap((l) => l.shapes))
    : NaN;
  if (Number.isFinite(repeatDist) && lin(repeatDist, 0.08, 0.3) < noteBelow) tips.push(repeatNote);
  const out: SheetSummary = {
    overall,
    lineCount: lines.length,
    headline: `${overall}% across ${lines.length} line${lines.length === 1 ? "" : "s"}.`,
    weakest,
    tips,
    repeatDist,
  };
  if (scores) out.scores = scores;
  return out;
}

// ---- record members ----------------------------------------------------------------------

/** The `pen2` object of a record, and the `pen` of an ink record and of an ink stroke. */
export interface Pen2 {
  kind: string;
  weight?: number;
  nibs?: number;
  angle?: number;
  followsRoll?: boolean;
  /** "pencil" (a force was reported) or "touch". */
  input: string;
}

/**
 * The pen details of a line's writing: the last stroke's pen, `followsRoll`
 * if any stroke followed the roll, input "pencil" if any point carries a force.
 */
export function pen2Of(strokes: Stroke[]): Pen2 | null {
  const last = strokes[strokes.length - 1];
  if (!last) return null;
  const input = strokes.some((s) => s.points.some((p) => p.force !== undefined))
    ? "pencil"
    : "touch";
  if (last.pen.kind === "monoline") return { kind: "monoline", weight: last.pen.weight, input };
  return {
    kind: "edged",
    nibs: last.pen.nibs,
    angle: last.pen.angle,
    followsRoll: strokes.some((s) => s.followsRoll === true),
    input,
  };
}

/** The metrics2 member of a check record: every NaN is null, optional members omitted. */
export function metrics2Of(m: LineMetrics, letters: LetterResult[]): Record<string, unknown> {
  const n = (x: number) => Number.isFinite(x) ? x : null;
  const c = m.consistency, p = m.pen, f = m.fluency, z = m.shape;
  const shape: Record<string, unknown> = {
    letters: letters.map((l) => ({
      char: l.char,
      precision: n(l.precision),
      coverage: n(l.coverage),
    })),
    zone: { ascender: n(z.zoneAscender), body: n(z.zoneBody), descender: n(z.zoneDescender) },
  };
  if (z.worst) {
    const w = z.worst;
    shape.worst = { stroke: w.stroke, from: w.from, to: w.to, letter: w.letter, mean: n(w.mean) };
  }
  const scores: Record<string, number> = { shape: m.scores.shape };
  if (m.scores.consistency !== undefined) scores.consistency = m.scores.consistency;
  if (m.scores.penControl !== undefined) scores.pen = m.scores.penControl;
  if (m.scores.fluency !== undefined) scores.fluency = m.scores.fluency;
  return {
    v: 1,
    shape,
    consistency: {
      slantSD: n(c.slantSD),
      sizeSD: n(c.sizeSD),
      baselineSD: n(c.baselineSD),
      spacingDevSD: n(c.spacingDevSD),
      spacingCV: n(c.spacingCV),
      wordSpace: n(c.wordSpace),
      repeatDist: n(c.repeatDist),
    },
    pen: {
      pressureMean: n(p.pressureMean),
      pressureCV: n(p.pressureCV),
      pressureContrast: n(p.pressureContrast),
      nibMean: n(p.nibMean),
      nibTarget: n(p.nibTarget),
      nibDev: n(p.nibDev),
      nibSD: n(p.nibSD),
      altMean: n(p.altMean),
      altSD: n(p.altSD),
      azimuthSD: n(p.azimuthSD),
    },
    fluency: {
      speedMedian: n(f.speedMedian),
      speedCV: n(f.speedCV),
      hesitations: f.hesitations,
      pauses: f.pauses,
      slowRuns: f.slowRuns,
      liftsPerLetter: n(f.liftsPerLetter),
      modelLiftsPerLetter: n(f.modelLiftsPerLetter),
      lettersPerMinute: n(f.lettersPerMinute),
      activeMs: n(f.activeMs),
    },
    scores,
    notes: m.notes,
  };
}

/** What a sheet summary needs from a checked line, with its letter shapes. */
export function lineCheckOf(r: CheckResult, m: LineMetrics, strokes: Stroke[]): LineCheck {
  return {
    score: r.score,
    letters: r.letters,
    metrics: r.metrics,
    scores: m.scores,
    shapes: letterShapes(strokes, r),
  };
}
