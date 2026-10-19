/// <reference lib="deno.ns" />

import { assert, assertEquals } from "@std/assert";
import type { Stroke } from "./ink.ts";
import { fingerprint, rowKey, sanitizeRecorded, sanitizeStrokes } from "./stroke-store.ts";

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

Deno.test("the fingerprint survives a store round trip and tells writings and models apart", () => {
  const strokes: Stroke[] = [
    {
      pen: { kind: "pencil", lead: 3 },
      points: [{ u: 0.1234567, v: -0.5, p: 0.31, t: 12.5, alt: 0.7, az: 2 }],
    },
  ];
  const font = { family: "F", style: "normal", slant: 5 };
  const fp = fingerprint(strokes, font);
  const back = sanitizeStrokes(JSON.parse(JSON.stringify(strokes)));
  assertEquals(fingerprint(back, font), fp);
  assert(fingerprint(back, { ...font, slant: 6 }) !== fp);
  back[0].points[0].p = 0.32;
  assert(fingerprint(back, font) !== fp);
  assertEquals(
    sanitizeStrokes([{ pen: { kind: "pointed", weight: 2 }, points: strokes[0].points }])[0].pen,
    {
      kind: "pointed",
      weight: 2,
    },
  );
  assertEquals(sanitizeRecorded({ fp, check: "x" }), { fp, check: "x" });
  assertEquals(sanitizeRecorded({ fp: 1 }), null);
});
