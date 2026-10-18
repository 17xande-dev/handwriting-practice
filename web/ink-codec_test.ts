/// <reference lib="deno.ns" />

// The ink golden vectors of the iPad app's docs/metrics.md (testdata/metrics):
// an ink record must come out byte for byte the same here, and malformed ones
// must decode without throwing.

import { assert, assertEquals } from "@std/assert";
import { decimate, decodeInk, encodeInk, roundTripError } from "./ink-codec.ts";
import { canonical, type J, parseStroke, same, strokeJson } from "./golden-util.ts";
import type { Stroke } from "./ink.ts";
import ink from "../testdata/metrics/ink.json" with { type: "json" };
import inkDecode from "../testdata/metrics/ink-decode.json" with { type: "json" };

Deno.test("golden: ink records, byte for byte", () => {
  for (const c of ink.cases as J[]) {
    const strokes = c.input.strokes.map(parseStroke);
    const kept = strokes.map((s: Stroke) => ({ ...s, points: decimate(s.points, c.input.every) }));
    const target = c.input.targetBytes ?? 60_000;
    const e = encodeInk(kept, c.input.checkID, c.input.at, c.input.xh, target);
    if (c.expected.record === null) {
      assertEquals(e, null, c.name);
      continue;
    }
    assert(e, `${c.name}: no record`);
    assertEquals(canonical(JSON.parse(e.json)), canonical(c.expected.record), c.name);
    assertEquals(e.bytes, c.expected.bytes, `${c.name}: bytes`);
    const dec = decodeInk(e.json);
    assert(dec, c.name);
    same(dec.map(strokeJson), c.expected.decoded, 1e-9, `${c.name}.decoded`);
    const after = kept.map((s: Stroke) => ({ ...s, points: decimate(s.points, e.decimation) }));
    same(roundTripError(after, dec), c.expected.error, 1e-9, `${c.name}.error`);
  }
  const rec = (n: string) => (ink.cases as J[]).find((c) => c.name === n).expected.record;
  assert(rec("decimation-loop-small-target").dec > 1);
  assert(rec("decimation-loop-tiny-target").dec > rec("decimation-loop-small-target").dec);
  assert(rec("decimation-jump-to-longest").dec > 15);
  assertEquals(rec("long-row-origin-and-clamps").strokes[1].o, [60000, -500]);
});

Deno.test("golden: decoding malformed ink never throws", () => {
  for (const c of inkDecode.cases as J[]) {
    const got = decodeInk(JSON.stringify(c.input));
    if (c.expected.record === null) {
      assertEquals(got, null, c.name);
      continue;
    }
    assert(got, c.name);
    same(got.map(strokeJson), c.expected.strokes, 1e-9, c.name);
  }
  assertEquals(decodeInk("not json"), null);
  assertEquals(
    decodeInk(
      JSON.stringify({ v: 2, id: "x", ts: 1, check: "c", pen: { kind: "monoline" }, strokes: [] }),
    ),
    null,
  );
  assertEquals(decodeInk(" ".repeat(70_000)), null);
});

Deno.test("ink: a forward-compatible pen kind decodes as a monoline pen", () => {
  const rec = {
    v: 1,
    id: "a-ink",
    ts: 1,
    check: "a",
    pen: { kind: "pointed", input: "pencil" },
    strokes: [{ fr: false, rr: null, t0: 0, o: [0, 0], d: "" }],
  };
  const got = decodeInk(rec);
  assertEquals(got?.[0].pen, { kind: "monoline", weight: 3 });
});
