/// <reference lib="deno.ns" />

// The golden vectors of the iPad app's docs/strokes.md (copied to testdata/strokes, made by its
// Swift core): resampling, the pair tests, trimming, the letter judging and whole lines must come
// out the same here. Numbers match within 1e-6 relative to max(1, |x|); strings, integers,
// booleans and nulls exactly.

import { assert, assertEquals } from "@std/assert";
import { type J, same } from "./golden-util.ts";
import type { Stroke } from "./ink.ts";
import {
  classify,
  classifyPrepared,
  directionScore,
  isClosed,
  longestIncreasing,
  matchLetter,
  ModelCurve,
  type ModelStroke,
  orderMetrics,
  orderNotes,
  pairOrderLetters,
  pathLength,
  piece,
  type Pt,
  resampleEven,
  RunCurve,
  shapeDistance,
  type StrokeGlyph,
  strokePoints,
  turning,
} from "./stroke-order.ts";
import primitives from "../testdata/strokes/primitives.json" with { type: "json" };
import matching from "../testdata/strokes/matching.json" with { type: "json" };
import line from "../testdata/strokes/line.json" with { type: "json" };

const pts = (a: number[][]): Pt[] => a.map((p) => ({ u: p[0], v: p[1] }));
const pj = (p: Pt[]) => p.map((q) => [q.u, q.v]);

function glyphOf(j: J): StrokeGlyph {
  return {
    strokes: j.strokes.map((s: J): ModelStroke => ({
      pts: s.pts,
      ...(s.kind ? { kind: s.kind } : {}),
    })),
    verified: j.verified,
    origin: "table",
    confidence: j.confidence,
  };
}

function letterJson(l: ReturnType<typeof matchLetter>) {
  return {
    char: l.char,
    verified: l.verified,
    modelStrokes: l.modelStrokes,
    runs: l.runs,
    matched: l.matched,
    reversed: l.reversed,
    wrongStart: l.wrongStart,
    wrongOrder: l.wrongOrder,
    extraLifts: l.extraLifts,
    missingLifts: l.missingLifts,
    unmatched: l.unmatched,
    missingStrokes: l.missingStrokes,
    credit: l.credit,
  };
}

Deno.test("golden: primitives (pair, dot, trim, lis, resample)", () => {
  const counts: Record<string, number> = {};
  for (const c of primitives.cases as J[]) {
    counts[c.fn] = (counts[c.fn] ?? 0) + 1;
    switch (c.fn) {
      case "pair": {
        const run = pts(c.run);
        const model: ModelStroke = { pts: c.model.pts };
        const m = strokePoints(model);
        const out: Record<string, unknown> = {
          shape: shapeDistance(run, m, c.closed),
          direction: directionScore(run, m, c.closed),
          turning: turning(run),
          turningModel: turning(m),
          length: pathLength(run),
        };
        const cls = classify(run, model);
        if (cls) {
          out.class = cls.kind;
          out.cost = cls.cost;
        } else out.class = "none";
        same(out, c.expected, 1e-6, c.name, false);
        // The input's `closed` is what the spec says it is.
        assertEquals(c.closed, isClosed(run) && isClosed(m), c.name);
        break;
      }
      case "dot": {
        const r = classifyPrepared(new RunCurve(pts(c.run), c.cut, false), new ModelCurve(c.model));
        same(r ? { class: r.kind, cost: r.cost } : { class: "none" }, c.expected, 1e-6, c.name);
        break;
      }
      case "trim": {
        const run = new RunCurve(pts(c.run), c.cutStart, c.cutEnd);
        const k = run.trimRange(pts([c.head])[0], pts([c.tail])[0]);
        same({ range: [k.i, k.j] }, c.expected, 0, c.name);
        break;
      }
      case "lis":
        same(
          { indices: [...longestIncreasing(c.ks)].sort((a, b) => a - b) },
          c.expected,
          0,
          c.name,
        );
        break;
      default:
        same({ pts: pj(resampleEven(pts(c.pts), c.n)) }, c.expected, 1e-6, c.name);
    }
  }
  assertEquals(Object.keys(counts).sort(), ["dot", "lis", "pair", "resample", "trim"]);
  assert(counts.pair > 50);
});

Deno.test("golden: matching (a letter against its glyph)", () => {
  assert(matching.cases.length >= 40);
  for (const c of matching.cases as J[]) {
    const cuts: boolean[][] = c.cut ?? c.runs.map(() => [false, false]);
    const pieces = c.runs.map((r: number[][], i: number) => piece(pts(r), cuts[i][0], cuts[i][1]));
    const got = matchLetter(c.char, glyphOf(c.glyph), pieces);
    same(letterJson(got), c.expected, 1e-6, c.name);
  }
});

Deno.test("golden: whole lines (strokes, letter frame, sub-score, notes)", () => {
  assert(line.cases.length >= 10);
  for (const c of line.cases as J[]) {
    const i = c.input;
    const nan = (a: Array<number | null> | undefined) => (a ?? []).map((x) => x ?? NaN);
    const input = {
      uMin: i.uMin,
      tan: i.tan,
      userBounds: i.userBounds,
      modelBounds: i.modelBounds,
      letters: i.letters,
      letterSize: nan(i.letterSize),
      letterBottom: nan(i.letterBottom),
      slantDiff: i.slantDiff ?? 0,
    };
    const strokes: Stroke[] = c.strokes.map((s: number[][]) => ({
      pen: { kind: "monoline", weight: 3 },
      points: s.map((p, k) => ({ u: p[0], v: p[1], p: 0.5, t: k })),
    }));
    const gs: Record<string, StrokeGlyph> = {};
    for (const [k, g] of Object.entries(c.glyphs)) gs[k] = glyphOf(g as J);
    const m = orderMetrics(strokes, input, (ch) => gs[ch]);
    if (!m) {
      assertEquals(c.expected.order, null, c.name);
      continue;
    }
    same(
      {
        score: m.score,
        notes: m.notes,
        judged: m.letters.length,
        letters: m.letters.map(letterJson),
      },
      c.expected.order,
      1e-6,
      c.name,
    );
  }
});

Deno.test("notes: kinds sort by distinct letters, then priority; at most two; +N for more", () => {
  const l = (char: string, o: Partial<ReturnType<typeof matchLetter>>) => ({
    char,
    verified: true,
    modelStrokes: 1,
    runs: 1,
    matched: 1,
    reversed: 0,
    wrongStart: 0,
    wrongOrder: 0,
    extraLifts: 0,
    missingLifts: 0,
    unmatched: 0,
    credit: 1,
    missingStrokes: 0,
    ...o,
  });
  const ls = [
    l("a", { reversed: 1 }),
    l("b", { reversed: 1 }),
    l("c", { reversed: 1 }),
    l("d", { reversed: 1 }),
    l("a", { wrongOrder: 1 }),
    l("e", { wrongOrder: 1 }),
    l("f", { wrongOrder: 1 }),
    l("a", { missingStrokes: 1 }),
    l("a", { extraLifts: 1 }),
  ];
  assertEquals(orderNotes(ls), [
    "a, b, c +1: a stroke is drawn in the wrong direction.",
    "a, e, f: strokes are drawn in the wrong order.",
  ]);
});

Deno.test("pairOrderLetters matches judged letters to written ones by character, in order", () => {
  const ls = [
    { index: 0, char: "a", missing: false },
    { index: 1, char: " ", missing: false },
    { index: 2, char: "b", missing: true },
    { index: 3, char: "c", missing: false },
  ];
  const o = (char: string) => ({ char }) as ReturnType<typeof matchLetter>;
  const m = pairOrderLetters(ls, [o("a"), o("c")]);
  assertEquals([...m.keys()], [0, 3]);
  const m2 = pairOrderLetters(ls, [o("c")]);
  assertEquals([...m2.keys()], [3]);
});
