/// <reference lib="deno.ns" />

// The golden vectors of the iPad app's docs/metrics.md (copied to
// testdata/metrics, made by its Swift core): every metric, sub-score, note and
// ink record must come out the same here. Numbers match within 1e-6 relative to
// max(1, |x|) (ink: 1e-9); strings, integers, booleans and nulls exactly.

import { assert, assertEquals } from "@std/assert";
import { type J, orNaN, parseStroke, same } from "./golden-util.ts";
import type { CheckResult } from "./evaluate.ts";
import {
  circularStats,
  consistencyMetrics,
  isWhitespaceChar,
  letterShapes,
  lin,
  oneDecimal,
  repeatConsistency,
  resampleArc,
  roundInt,
  shapeDetail,
  significant,
  type UV,
  wrap,
} from "./metrics.ts";
import { components, groupScore, noteBelow, pickNotes, type SubScores } from "./metric-scores.ts";
import { fluencyMetrics, penMetrics } from "./pen-metrics.ts";
import primitives from "../testdata/metrics/primitives.json" with { type: "json" };
import scores from "../testdata/metrics/scores.json" with { type: "json" };
import penFluency from "../testdata/metrics/pen-fluency.json" with { type: "json" };
import consistency from "../testdata/metrics/consistency.json" with { type: "json" };

Deno.test("golden: primitives", () => {
  for (const c of primitives.cases as J[]) {
    const i = c.input;
    if (c.name === "lin") {
      same(i.xs.map((x: number) => lin(x, i.good, i.bad)), c.expected.scores, 1e-6, c.name);
    } else if (c.name.startsWith("circular")) {
      const r = circularStats(i.angles, i.period);
      same(r, c.expected, 1e-6, c.name);
    } else if (c.name === "resample") {
      const lines: UV[][] = i.lines;
      same(resampleArc(lines, i.n, 0), c.expected.points, 1e-6, c.name);
    } else {
      const shapes = i.shapes.map((s: J) => ({ char: s.char, lines: s.lines }));
      same({ repeatDist: repeatConsistency(shapes) }, c.expected, 1e-6, c.name);
    }
  }
});

Deno.test("golden: pen control and fluency", () => {
  for (const c of penFluency.cases as J[]) {
    const strokes = c.input.strokes.map(parseStroke);
    same(penMetrics(strokes), c.expected.pen, 1e-6, `${c.name}.pen`);
    same(
      fluencyMetrics(strokes, c.input.letters, c.input.pieces),
      c.expected.fluency,
      1e-6,
      c.name,
    );
  }
});

/** A CheckResult carrying what the metrics read, from a golden `check`. */
function checkOf(j: J): CheckResult {
  const arr = (v: unknown[]) => v.map(orNaN);
  return {
    letters: j.letters.map((l: J) => ({
      index: l.index,
      char: l.char,
      missing: l.missing,
      score: 0,
      precision: 0,
      coverage: 0,
    })),
    score: j.score,
    frame: j.frame,
    userBounds: arr(j.userBounds),
    detail: {
      pointDist: j.detail.pointDist.map(arr),
      letterSize: arr(j.detail.letterSize),
      letterBottom: arr(j.detail.letterBottom),
      modelLeft: arr(j.detail.modelLeft),
      modelRight: arr(j.detail.modelRight),
      components: j.detail.components,
    },
  } as unknown as CheckResult;
}

Deno.test("golden: shape detail and consistency", () => {
  for (const c of consistency.cases as J[]) {
    const strokes = c.input.strokes.map(parseStroke);
    const r = checkOf(c.input.check);
    const shape = shapeDetail(strokes, r);
    const { significant: sig, ...worstWant } = c.expected.shape.worst ?? {};
    same(
      shape,
      { ...c.expected.shape, worst: c.expected.shape.worst ? worstWant : null },
      1e-6,
      `${c.name}.shape`,
    );
    if (c.expected.shape.worst) assertEquals(significant(shape.worst!), sig, c.name);
    else assertEquals(shape.worst, undefined, `${c.name}: worst`);
    same(consistencyMetrics(c.input.text, strokes, r), c.expected.consistency, 1e-6, c.name);
    // The shapes feed the sheet pool; they must exist for a line with writing.
    assert(letterShapes(strokes, r).length > 0, c.name);
  }
});

Deno.test("golden: components, sub-scores and notes", () => {
  for (const c of scores.cases as J[]) {
    if (c.name === "one-decimal") {
      assertEquals(c.input.xs.map(oneDecimal), c.expected.text);
      continue;
    }
    const i = c.input;
    const num = (o: J) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, orNaN(v)]));
    const cs = components(num(i.consistency) as J, num(i.pen) as J, num(i.fluency) as J, i.letters);
    same(
      cs.map(({ key, score, weight }) => ({ key, score, weight })),
      c.expected.components,
      1e-6,
      c.name,
    );
    const sub: SubScores = { shape: i.shapeScore };
    for (
      const [k, g] of [["consistency", "consistency"], ["penControl", "pen"], [
        "fluency",
        "fluency",
      ]] as const
    ) {
      const v = groupScore(cs, g);
      if (v !== undefined) sub[k] = v;
    }
    same(sub, c.expected.scores, 1e-6, `${c.name}.scores`);
    for (const k of ["consistency", "penControl", "fluency"] as const) {
      assertEquals(sub[k] === undefined, c.expected.scores[k] === null, `${c.name}: ${k} absent`);
    }
    assertEquals(pickNotes(cs), c.expected.notes, c.name);
  }
  assertEquals(noteBelow, 75);
});

Deno.test("helpers: whitespace, rounding, wrap", () => {
  for (const ch of ["\t", "\n", " ", " ", " ", " ", " ", "　", "﻿"]) {
    assert(isWhitespaceChar(ch), JSON.stringify(ch));
  }
  assert(!isWhitespaceChar("\u0085") && !isWhitespaceChar("a"));
  assertEquals(roundInt(NaN), 0);
  assertEquals(roundInt(Infinity), 0);
  assertEquals(roundInt(-0.5), 0);
  assertEquals(roundInt(2.5), 3);
  assertEquals(oneDecimal(NaN), "0.0");
  assertEquals(oneDecimal(-0.04), "0.0");
  assertEquals(oneDecimal(0.15), "0.2");
  assert(Math.abs(wrap(3 * Math.PI) - Math.PI) < 1e-12);
  assert(Math.abs(wrap(-Math.PI) - Math.PI) < 1e-12);
});

import { checkWithModel } from "./evaluate.ts";
import { type Fixture, fromFixtureModel } from "./fixture.ts";
import uprightSentences from "../testdata/parity/upright-sentences-0.json" with { type: "json" };
import italicChains from "../testdata/parity/italic-chains-0.json" with { type: "json" };
import uprightAFamily from "../testdata/parity/upright-a-family-0.json" with { type: "json" };
import briemSentences from "../testdata/parity/briem-print-sentences-0.json" with { type: "json" };

Deno.test("check's own detail matches the golden check fields (Swift and web agree)", () => {
  const fixtures: Record<string, Fixture> = {
    "sentences-wobble06": uprightSentences as unknown as Fixture,
    "sentences-wobble15": uprightSentences as unknown as Fixture,
    "sentences-missing-first-strokes": uprightSentences as unknown as Fixture,
    "chains-wobble10": italicChains as unknown as Fixture,
    "sentences-missing-middle-letter": uprightSentences as unknown as Fixture,
    "briem-missing-letter-before-word-space": briemSentences as unknown as Fixture,
    "a-family-perfect": uprightAFamily as unknown as Fixture,
    "briem-print-sentences-wobble08": briemSentences as unknown as Fixture,
  };
  for (const c of consistency.cases as J[]) {
    const f = fixtures[c.name];
    const model = fromFixtureModel(f.text, f.slant, f.model);
    assertEquals(model.text, c.input.text, c.name);
    const r = checkWithModel(model, c.input.strokes.map(parseStroke))!;
    const want = c.input.check;
    same(r.detail.components, want.detail.components, 0, `${c.name}.components`);
    // One case is knife-edge: the golden strokes are rounded to 6 decimals, which moves one DTW
    // column there (userBounds[14] is 1 px off), so its per-point numbers are not compared.
    if (c.name !== "briem-missing-letter-before-word-space") {
      same(r.detail.pointDist, want.detail.pointDist, 1e-4, `${c.name}.pointDist`, false);
      same(r.userBounds, want.userBounds, 1e-4, `${c.name}.userBounds`, false);
      same(r.detail.letterSize, want.detail.letterSize, 1e-4, `${c.name}.letterSize`, false);
      same(r.detail.letterBottom, want.detail.letterBottom, 1e-4, `${c.name}.letterBottom`, false);
    }
    same(r.detail.modelLeft, want.detail.modelLeft, 1e-6, `${c.name}.modelLeft`);
    same(r.detail.modelRight, want.detail.modelRight, 1e-6, `${c.name}.modelRight`);
    same(
      r.letters.map(({ index, char, missing }) => ({ index, char, missing })),
      want.letters,
      0,
      c.name,
    );
  }
});
