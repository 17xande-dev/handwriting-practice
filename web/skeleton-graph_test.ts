/// <reference lib="deno.ns" />

import { assert, assertEquals } from "@std/assert";
import {
  buildSkeletonGraph,
  pruneSpurs,
  reversedStroke,
  simplify,
  snapDrawnStroke,
  snapTargetOf,
} from "./skeleton-graph.ts";
import { type FixtureModel, fromFixtureModel, mulberry32 } from "./fixture.ts";
import { classify, pathLength, resampleEven, strokePoints } from "./stroke-order.ts";
import { parseModelFile } from "./stroke-models.ts";
import type { Raster } from "./evalcore.ts";
import glyphs from "../testdata/glyphs/italic.json" with { type: "json" };
import italicModel from "../internal/handler/static/strokes/italic.json" with { type: "json" };

const builtin = parseModelFile(italicModel)!;

/** A raster with the given pixels set. */
function rasterOf(w: number, h: number, pts: Array<[number, number]>): Raster {
  const data = new Uint8Array(w * h);
  for (const [x, y] of pts) data[y * w + x] = 1;
  return { w, h, data };
}

Deno.test("graph of a T: a junction and three endpoints; a short spur is pruned", () => {
  const px: Array<[number, number]> = [];
  for (let x = 2; x <= 22; x++) px.push([x, 3]);
  for (let y = 4; y <= 25; y++) px.push([12, y]);
  const r = rasterOf(26, 30, px);
  const g = buildSkeletonGraph(r);
  assertEquals(g.nodes.map((n) => n.degree).sort(), [1, 1, 1, 3]);
  assertEquals(g.edges.length, 3);
  // A 3 pixel spur off the stem goes with a minimum of 6, stays with a minimum of 2.
  const spur = rasterOf(26, 30, [...px, [13, 15], [14, 15], [15, 15]]);
  const count = (x: Raster) => x.data.reduce((a, b) => a + b, 0);
  assertEquals(count(pruneSpurs(spur, 6)), count(r));
  assertEquals(count(pruneSpurs(spur, 2)), count(spur));
});

Deno.test("a loop with no node still gets an edge", () => {
  // A diamond ring, one pixel thick with no corners that read as junctions.
  const px: Array<[number, number]> = [];
  for (let i = 0; i < 8; i++) {
    px.push([10 + i, 2 + i], [10 - i, 2 + i], [10 + i, 16 - i], [10 - i, 16 - i]);
  }
  const g = buildSkeletonGraph(rasterOf(24, 20, px));
  assert(g.edges.length >= 1);
});

Deno.test("simplify keeps the corners", () => {
  const out = simplify([[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]], 0.5);
  assertEquals(out, [[0, 0], [10, 0], [10, 10]]);
});

/** The target of a character from the fixture rasters (the glyph alone on the model font). */
function targetFor(ch: string) {
  const g = (glyphs.glyphs as unknown as Record<string, FixtureModel>)[ch];
  return snapTargetOf(fromFixtureModel(ch, glyphs.slant, g));
}

Deno.test("a stroke drawn along the built-in strokes snaps to one that judging reads as a match", () => {
  const rnd = mulberry32(7);
  let checked = 0;
  for (const ch of "aeilnotux") {
    const t = targetFor(ch);
    const glyph = builtin.glyphs[ch];
    glyph.strokes.forEach((s, k) => {
      const pts = strokePoints(s);
      if (s.kind === "dot") return;
      // Drawn by hand: resampled every 0.08 and wobbled by up to 0.04.
      const n = Math.max(4, Math.round(pathLength(pts) / 0.08));
      const drawn = resampleEven(pts, n).map((p) => ({
        u: p.u + (rnd() - 0.5) * 0.08,
        v: p.v + (rnd() - 0.5) * 0.08,
      }));
      const snapped = snapDrawnStroke(drawn, t);
      assert(snapped, `${ch}${k} did not snap`);
      assert(snapped.meanDistance < 0.15, `${ch}${k}: ${snapped.meanDistance}`);
      const c = classify(strokePoints(snapped.stroke), s);
      assertEquals(c?.kind, "match", `${ch}${k}`);
      // And the reverse button's stroke is read as reversed.
      assertEquals(
        classify(strokePoints(reversedStroke(snapped.stroke)), s)?.kind === "match",
        false,
        `${ch}${k} reversed`,
      );
      checked++;
    });
  }
  assert(checked >= 10);
});

Deno.test("a tap becomes a dot, on the small component when there is one", () => {
  const t = targetFor("i");
  const dot = builtin.glyphs["i"].strokes.find((s) => s.kind === "dot")!;
  const p = strokePoints(dot)[0];
  const s = snapDrawnStroke([{ u: p.u + 0.1, v: p.v + 0.05 }], t)!;
  assertEquals(s.stroke.kind, "dot");
  assert(Math.hypot(s.stroke.pts[0][0] - p.u, s.stroke.pts[0][1] - p.v) < 0.2);
});

Deno.test("a stroke nowhere near the glyph does not snap", () => {
  const t = targetFor("l");
  assertEquals(snapDrawnStroke([{ u: 5, v: 5 }, { u: 5.5, v: 6 }, { u: 6, v: 7 }], t), null);
});
