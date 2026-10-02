/// <reference lib="deno.ns" />

import { assertAlmostEquals, assertEquals } from "@std/assert";
import { band, toPixels, toUnits } from "./geometry.ts";

Deno.test("guides stack top to bottom", () => {
  const b = band(32, 600, { asc: 1, desc: 1 });
  assertEquals(b.ascender < b.xline && b.xline < b.baseline && b.baseline < b.descender, true);
  assertEquals(b.baseline - b.xline, 32);
  assertEquals(b.height > b.descender, true);
});

// Strokes are stored in x-height units so that a size change rescales them;
// the conversion must round-trip or ink drifts off the guides on every resize.
Deno.test("units round-trip and scale with x-height", () => {
  const small = band(24, 600, { asc: 1.1, desc: 0.9 });
  const large = band(44, 600, { asc: 1.1, desc: 0.9 });
  const [u, v] = toUnits(small, 100, small.xline);
  assertAlmostEquals(v, -1);
  const [x, y] = toPixels(small, u, v);
  assertAlmostEquals(x, 100);
  assertAlmostEquals(y, small.xline);
  // The same stored point lands on the x-height line at any size.
  assertAlmostEquals(toPixels(large, u, v)[1], large.xline);
});
