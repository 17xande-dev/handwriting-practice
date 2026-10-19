/// <reference lib="deno.ns" />

// Order and direction through the whole check: the built-in model's own strokes written onto a
// model raster, checked, and judged (the path Row.check takes), as the iPad does it.

import { assert, assertEquals } from "@std/assert";
import type { J } from "./golden-util.ts";
import { checkWithModel, S } from "./evaluate.ts";
import { type Fixture, fromFixtureModel } from "./fixture.ts";
import type { Stroke } from "./ink.ts";
import { lineMetrics, metrics2Of } from "./metric-scores.ts";
import { lookupOf, parseModelFile } from "./stroke-models.ts";
import { letterFlags, pairOrderLetters } from "./stroke-order.ts";
import { renderPanel } from "./details.ts";
import italicModel from "../internal/handler/static/strokes/italic.json" with { type: "json" };
import italicA from "../testdata/parity/italic-a-family-0.json" with { type: "json" };

const models = parseModelFile(italicModel)!;
const lookup = lookupOf(models.glyphs);

/** The model's own strokes for the characters of `text`, written onto the raster, optionally altered. */
function written(
  f: Fixture,
  edit: (letter: number, stroke: number, pts: number[][]) => number[][],
) {
  const raster = fromFixtureModel(f.text, f.slant, f.model);
  const tan = Math.tan((raster.slant * Math.PI) / 180);
  const strokes: Stroke[] = [];
  [...f.text].forEach((c, i) => {
    const g = lookup(c);
    if (!g || c === " ") return;
    g.strokes.forEach((s, k) => {
      const pts = edit(i, k, s.pts);
      strokes.push({
        pen: { kind: "monoline", weight: 3 },
        points: pts.map((p, n) => ({
          u: (raster.bounds[i] + p[0] * S) / S + raster.uMin - p[1] * tan,
          v: p[1],
          p: 0.5,
          t: n * 16,
        })),
      });
    });
  });
  return { raster, strokes };
}

Deno.test("the model's own strokes score 100 for order; the record carries it", () => {
  const f = italicA as unknown as Fixture;
  const { raster, strokes } = written(f, (_i, _k, pts) => pts);
  const r = checkWithModel(raster, strokes)!;
  const m = lineMetrics(f.text, strokes, r, lookup);
  assertEquals(m.scores.order, 100);
  assertEquals(m.order!.letters.length, [...f.text].filter((c) => c !== " ").length);
  assertEquals(m.notes.filter((n) => n.includes("stroke")), []);
  const rec = metrics2Of(m, r.letters) as Record<string, J>;
  assertEquals(rec.scores.order, 100);
  assertEquals(rec.order.judged, m.order!.letters.length);
  assertEquals(Object.keys(rec.order.letters[0]).sort(), [
    "char",
    "credit",
    "extraLifts",
    "matched",
    "missingLifts",
    "missingStrokes",
    "reversed",
    "wrongOrder",
    "wrongStart",
  ]);
  // Without models: no order member and no sub-score (omitted, never null).
  const plain = lineMetrics(f.text, strokes, r);
  assertEquals(plain.scores.order, undefined);
  const prec = metrics2Of(plain, r.letters) as Record<string, J>;
  assert(!("order" in prec) && !("order" in prec.scores));
});

Deno.test("one stroke reversed is flagged, noted and costs credit", () => {
  const f = italicA as unknown as Fixture;
  const { raster, strokes } = written(
    f,
    (i, k, pts) => i === 6 && k === 0 ? [...pts].reverse() : pts,
  );
  const r = checkWithModel(raster, strokes)!;
  const m = lineMetrics(f.text, strokes, r, lookup);
  assert(m.scores.order! < 100);
  assert(m.order!.letters.some((l) => l.reversed > 0));
  assert(m.notes.some((n) => n.endsWith("a stroke is drawn in the wrong direction.")));
  const paired = pairOrderLetters(r.letters, m.order!.letters);
  const flagged = [...paired].filter(([, l]) => letterFlags(l).includes("reversed"));
  assertEquals(flagged.length, 1);
  assertEquals(r.letters.find((l) => l.index === flagged[0][0])!.char, f.text[6]);
});

Deno.test("a character with no strokes is not judged; none judged is no order result", () => {
  const f = italicA as unknown as Fixture;
  const { raster, strokes } = written(f, (_i, _k, pts) => pts);
  const r = checkWithModel(raster, strokes)!;
  assertEquals(lineMetrics(f.text, strokes, r, () => undefined).order, undefined);
  const onlyA = lineMetrics(f.text, strokes, r, (c) => c === "a" ? lookup(c) : undefined);
  assertEquals(onlyA.order!.letters.every((l) => l.char === "a"), true);
});

Deno.test("an unmeasurable slant (NaN) is no correction, not a broken judgement", () => {
  const f = italicA as unknown as Fixture;
  const { raster, strokes } = written(f, (_i, _k, pts) => pts);
  const r = checkWithModel(raster, strokes)!;
  r.metrics.slantDiff = NaN;
  assertEquals(lineMetrics(f.text, strokes, r, lookup).scores.order, 100);
});

Deno.test("renderPanel needs a DOM; the order rows are plain text", async () => {
  const { metricRows } = await import("./details.ts");
  const f = italicA as unknown as Fixture;
  const { raster, strokes } = written(f, (_i, _k, pts) => pts);
  const r = checkWithModel(raster, strokes)!;
  const rows = metricRows(lineMetrics(f.text, strokes, r, lookup));
  assertEquals(rows[0][0], "Order: letters judged");
  assert(rows[1][1].startsWith("wrong way 0, wrong start 0, wrong order 0"));
  assert(typeof renderPanel === "function");
});
