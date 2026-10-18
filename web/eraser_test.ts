/// <reference lib="deno.ns" />

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  distanceBetweenSegments,
  distanceToSegment,
  eraserTolerance,
  strokesHit,
  strokeTouches,
} from "./eraser.ts";
import type { Stroke } from "./ink.ts";

const P = (u: number, v: number) => ({ u, v });
const stroke = (...pts: Array<[number, number]>): Stroke => ({
  pen: { kind: "monoline", weight: 3 },
  points: pts.map(([u, v]) => ({ u, v, p: 0.5, t: 0 })),
});

Deno.test("distance to a segment: interior, ends and a zero-length segment", () => {
  assertAlmostEquals(distanceToSegment(P(0.5, 1), P(0, 0), P(1, 0)), 1);
  assertAlmostEquals(distanceToSegment(P(2, 0), P(0, 0), P(1, 0)), 1);
  assertAlmostEquals(distanceToSegment(P(-1, 1), P(0, 0), P(1, 0)), Math.SQRT2);
  assertAlmostEquals(distanceToSegment(P(3, 4), P(0, 0), P(0, 0)), 5);
});

Deno.test("crossing segments are at distance zero; parallel ones keep their gap", () => {
  assertEquals(distanceBetweenSegments(P(0, 0), P(1, 1), P(0, 1), P(1, 0)), 0);
  assertAlmostEquals(distanceBetweenSegments(P(0, 0), P(1, 0), P(0, 2), P(1, 2)), 2);
});

Deno.test("a stroke is hit when the eraser passes within tolerance, not beyond", () => {
  const s = stroke([0, 0], [2, 0]);
  assert(strokeTouches(s, [P(1, 0.25)], eraserTolerance));
  assert(!strokeTouches(s, [P(1, 0.35)], eraserTolerance));
  // A swipe across the stroke hits it even though no sample is near.
  assert(strokeTouches(s, [P(1, -2), P(1, 2)], eraserTolerance));
});

Deno.test("single-point strokes (dots) and single-point paths work", () => {
  assert(strokeTouches(stroke([1, 1]), [P(1.1, 1)], eraserTolerance));
  assert(!strokeTouches(stroke([1, 1]), [P(2, 1)], eraserTolerance));
  assert(!strokeTouches(stroke(), [P(0, 0)], eraserTolerance));
  assert(!strokeTouches(stroke([0, 0]), [], eraserTolerance));
});

Deno.test("strokesHit returns the indices of only the touched strokes", () => {
  const strokes = [stroke([0, 0], [1, 0]), stroke([5, 5], [6, 5]), stroke([0.5, -1], [0.5, 1])];
  assertEquals(strokesHit(strokes, [P(0.5, 0.1), P(0.6, 0.1)], eraserTolerance), [0, 2]);
  assertEquals(strokesHit(strokes, [P(9, 9)], eraserTolerance), []);
});
