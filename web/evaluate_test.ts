/// <reference lib="deno.ns" />

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { notes, proportionPenalty, strokeSlant } from "./evaluate.ts";
import type { Stroke } from "./ink.ts";

const pen = { kind: "monoline", weight: 3 } as const;

/** A straight downstroke from (u, -1) to the baseline, leaning `deg` right. */
function stem(u: number, deg: number, height = 1): Stroke {
  const t = Math.tan((deg * Math.PI) / 180);
  const points = Array.from({ length: 21 }, (_, i) => {
    const v = -height + (height * i) / 20;
    return { u: u - v * t, v, p: 0.5, t: i };
  });
  return { pen, points };
}

/** An arch over the x-height: curved, so it must not count towards slant. */
function arch(u: number): Stroke {
  const points = Array.from({ length: 31 }, (_, i) => {
    const a = Math.PI * (1 - i / 30);
    return { u: u + 0.3 + 0.3 * Math.cos(a), v: -0.5 - 0.5 * Math.sin(a), p: 0.5, t: i };
  });
  return { pen, points };
}

Deno.test("slant comes from straight downstrokes", () => {
  assertAlmostEquals(strokeSlant([stem(0, 5), stem(1, 5), stem(2, 5)]), 5, 0.01);
  assertAlmostEquals(strokeSlant([stem(0, -8), stem(1, -8)]), -8, 0.01);
});

// Scaling writing up doesn't change its angles, so it mustn't change the
// measured slant; and curves alone give no answer rather than a wrong one.
Deno.test("slant ignores size and curves", () => {
  const normal = strokeSlant([stem(0, 7), arch(0), stem(1, 7), arch(1)]);
  const big = strokeSlant([stem(0, 7, 1.3), arch(0), stem(1, 7, 1.3), arch(1)]);
  assertAlmostEquals(normal, 7, 0.01);
  assertAlmostEquals(big, 7, 0.01);
  assert(Number.isNaN(strokeSlant([arch(0), arch(1), arch(2)])));
});

Deno.test("proportions only cost score past their allowance", () => {
  const fine = { slantDiff: 1.5, size: 1.05, width: 1.1, baseline: 0.05 };
  assertEquals(proportionPenalty(fine), 0);
  assertEquals(notes(fine), []);
  const leaning = { ...fine, slantDiff: 9.5 };
  assertAlmostEquals(proportionPenalty(leaning), 0.15, 1e-9);
  assertEquals(notes(leaning), ["Letters lean 10° more than the model."]);
  // However bad, a line keeps most of its shape score.
  assertEquals(proportionPenalty({ slantDiff: 40, size: 3, width: 4, baseline: 2 }), 0.3);
  // Unmeasurable values cost nothing and say nothing.
  assertEquals(proportionPenalty({ slantDiff: NaN, size: NaN, width: NaN, baseline: NaN }), 0);
});
