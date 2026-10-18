/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import type { Stroke } from "./ink.ts";
import { rowKey, sanitizeStrokes } from "./stroke-store.ts";

Deno.test("a stored row of writing comes back as it was", () => {
  const strokes: Stroke[] = [
    {
      pen: { kind: "edged", nibs: 5, angle: 45 },
      followsRoll: true,
      rollRef: 0.3,
      points: [{ u: 0.1, v: -0.5, p: 0.4, t: 12, alt: 1, az: 2, roll: -1, force: 0.4 }],
    },
    { pen: { kind: "monoline", weight: 3 }, points: [{ u: 1, v: 0, p: 0.5, t: 99 }] },
  ];
  assertEquals(sanitizeStrokes(JSON.parse(JSON.stringify(strokes))), strokes);
});

Deno.test("malformed stored writing is dropped without throwing", () => {
  assertEquals(sanitizeStrokes(null), []);
  assertEquals(sanitizeStrokes("x"), []);
  const bad = [
    { pen: { kind: "laser" }, points: [{ u: 0, v: 0, p: 0, t: 0 }] },
    {
      pen: { kind: "monoline", weight: 3 },
      points: [{ u: NaN, v: 0, p: 0, t: 0 }, { u: 0, v: 0 }],
    },
    { pen: { kind: "monoline", weight: 3 }, points: [{ u: 0, v: 0, p: 0, t: 0, alt: "x" }] },
    7,
  ];
  assertEquals(sanitizeStrokes(bad), [
    { pen: { kind: "monoline", weight: 3 }, points: [{ u: 0, v: 0, p: 0, t: 0 }] },
  ]);
});

Deno.test("a row's key names its sheet, place and text", () => {
  assertEquals(rowKey("arches", 2, "n m"), "arches|2|n m");
});
