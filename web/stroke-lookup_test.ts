/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { applyEdits } from "./stroke-defs.ts";
import { StrokeModels } from "./stroke-lookup.ts";
import type { StrokeGlyph } from "./stroke-order.ts";

const mine: StrokeGlyph = {
  strokes: [{ pts: [[0, 0], [0.5, -1]] }, { pts: [[0.5, 0], [0, -1]] }],
  verified: true,
  origin: "user",
  confidence: 1,
};

Deno.test("the person's own definition comes first, the built-in file second, else not judged", async () => {
  const records = applyEdits(null, "briem-print", { x: mine }, 1000);
  const builtin = {
    v: 1,
    model: "briem-print",
    source: "",
    glyphs: {
      x: {
        strokes: [{ pts: [[0, 0], [1, -1]] }],
        verified: true,
        origin: "table",
        confidence: 0.9,
      },
      y: {
        strokes: [{ pts: [[0, 0], [1, -1]] }],
        verified: false,
        origin: "table",
        confidence: 0.9,
      },
    },
  };
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify(builtin)))) as typeof fetch;
  try {
    const m = new StrokeModels({ allStrokesRecords: () => Promise.resolve(records) });
    await m.refresh();
    const l = (await m.lookup("briem-print", ""))!;
    assertEquals(l("x")?.origin, "user");
    assertEquals(l("x")?.strokes.length, 2);
    assertEquals(l("y")?.origin, "table");
    assertEquals(l("q"), undefined);
    // A custom font has definitions under custom-<family> and no built-in file.
    const c = new StrokeModels({
      allStrokesRecords: () => Promise.resolve(applyEdits(null, "custom-caveat", { x: mine }, 5)),
    });
    await c.refresh();
    const cl = (await c.lookup("custom", "Caveat"))!;
    assertEquals(cl("x")?.origin, "user");
    assertEquals(cl("y"), undefined);
    // Nothing anywhere: no lookup at all.
    assertEquals(await new StrokeModels(null).lookup("gb-s", ""), null);
  } finally {
    globalThis.fetch = real;
  }
});
