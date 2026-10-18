/// <reference lib="deno.ns" />

// Guards the parity fixtures (testdata/parity, made by `make fixtures`): the
// scoring must still give the scores the browser gave when they were
// written. If this fails after a deliberate change to the scoring, run
// `make fixtures` and review the diff; the Swift port must follow.

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { checkWithModel, strokesFromModel } from "./evaluate.ts";
import {
  type Fixture,
  fromFixtureModel,
  fromFixtureStrokes,
  rleDecode,
  rleEncode,
  toFixtureResult,
  toFixtureStrokes,
} from "./fixture.ts";
import fixtureJson from "../testdata/parity/italic-a-family-0.json" with { type: "json" };

const fixture = fixtureJson as unknown as Fixture;

/** Deep equality with floats compared to 1e-9, since Math differs in the last bit between engines. */
function assertSame(actual: unknown, expected: unknown, path: string) {
  if (typeof expected === "number" && typeof actual === "number") {
    assertAlmostEquals(actual, expected, 1e-9, path);
  } else if (Array.isArray(expected)) {
    assert(Array.isArray(actual), `${path}: not an array`);
    assertEquals(actual.length, expected.length, `${path}: length`);
    expected.forEach((e, i) => assertSame(actual[i], e, `${path}[${i}]`));
  } else if (expected && typeof expected === "object") {
    const a = actual as Record<string, unknown>;
    assertEquals(Object.keys(a).sort(), Object.keys(expected).sort(), `${path}: keys`);
    for (const [k, v] of Object.entries(expected)) assertSame(a[k], v, `${path}.${k}`);
  } else {
    assertEquals(actual, expected, path);
  }
}

Deno.test("run lengths round-trip, starting with zeros", () => {
  assertEquals(rleEncode(Uint8Array.of(1, 1, 0, 1)), [0, 2, 1, 1]);
  assertEquals(rleEncode(Uint8Array.of(0, 0, 1)), [2, 1]);
  assertEquals(rleDecode([0, 2, 1, 1], 4), Uint8Array.of(1, 1, 0, 1));
  const m = fromFixtureModel(fixture.text, fixture.slant, fixture.model);
  assertEquals(rleEncode(m.ink), fixture.model.rle);
});

Deno.test("the model's centreline still traces to the fixture's perfect strokes", () => {
  const m = fromFixtureModel(fixture.text, fixture.slant, fixture.model);
  const perfect = fixture.cases.find((c) => c.name === "perfect")!;
  assertEquals(toFixtureStrokes(strokesFromModel(m)), perfect.strokes);
});

for (const c of fixture.cases) {
  Deno.test(`parity: ${fixture.font} ${JSON.stringify(fixture.text)} ${c.name}`, () => {
    const m = fromFixtureModel(fixture.text, fixture.slant, fixture.model);
    const got = toFixtureResult(checkWithModel(m, fromFixtureStrokes(c.strokes)));
    assertSame(got, c.result, c.name);
  });
}
