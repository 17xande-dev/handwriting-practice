/// <reference lib="deno.ns" />

import { assert, assertEquals } from "@std/assert";
import {
  applyEdits,
  assemble,
  encodeGlyph,
  exportFile,
  fontsOf,
  parseImport,
  strokesPart,
  strokesRecordBudget,
  strokesRecordID,
  userGlyphs,
} from "./stroke-defs.ts";
import {
  coveragePercent,
  glyphStatus,
  parseModelFile,
  sanitizeGlyph,
  strokesFontID,
} from "./stroke-models.ts";
import type { StrokeGlyph } from "./stroke-order.ts";

const glyph = (n = 1, verified = true): StrokeGlyph => ({
  strokes: Array.from({ length: n }, (_, k) => ({
    pts: [[0.123456 + k, -0.5], [0.4, -0.25], [0.6, 0]],
  })),
  verified,
  origin: "user",
  confidence: 1,
});

Deno.test("record ids and parts", () => {
  assertEquals(strokesRecordID("italic", 0), "strokes-italic");
  assertEquals(strokesRecordID("italic", 2), "strokes-italic-2");
  assertEquals(strokesPart("strokes-italic", "italic"), 0);
  assertEquals(strokesPart("strokes-italic-3", "italic"), 3);
  assertEquals(strokesPart("strokes-italic-x", "italic"), null);
  assertEquals(strokesPart("strokes-italic-0", "italic"), null);
  assertEquals(strokesPart("strokes-gb-s-1", "gb-s"), 1);
  // A part of one font is a font of its own for another: the record's `model` says which.
  assertEquals(strokesPart("strokes-gb-s", "gb"), null);
});

Deno.test("a font id for a custom font is custom-<family>, [a-z0-9-], at most 32", () => {
  assertEquals(strokesFontID("italic", "x"), "italic");
  assertEquals(strokesFontID("custom", "Caveat Brush"), "custom-caveat-brush");
  assertEquals(strokesFontID("custom", "  !! "), "custom-font");
  assertEquals(strokesFontID("custom", "A".repeat(80)).length, "custom-".length + 32);
});

Deno.test("saving writes the record shape the iPad reads, with rounded numbers", () => {
  const recs = applyEdits(null, "briem-print", { a: glyph() }, 1_760_000_000_000);
  assertEquals(recs.length, 1);
  const r = recs[0];
  assertEquals([r.id, r.ts, r.v, r.model], [
    "strokes-briem-print",
    1_760_000_000_000,
    1,
    "briem-print",
  ]);
  const g = (r.glyphs as Record<string, Record<string, unknown>>).a;
  assertEquals(g.verified, true);
  assertEquals(g.origin, "user");
  assertEquals(g.confidence, 1);
  assertEquals((g.strokes as Array<{ pts: number[][] }>)[0].pts[0], [0.1235, -0.5]);
  // No `kind` for a main stroke; a dot has one.
  assertEquals("kind" in (g.strokes as object[])[0], false);
  assertEquals(
    encodeGlyph({ ...glyph(), strokes: [{ pts: [[0, 0]], kind: "dot" }] }).strokes,
    [{ pts: [[0, 0]], kind: "dot" }],
  );
});

Deno.test("a font too big for one record is split by character, every part the same ts, each under the cap", () => {
  const edits: Record<string, StrokeGlyph> = {};
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (const c of chars) edits[c] = glyph(40);
  const recs = applyEdits(null, "big", edits, 5000);
  assert(recs.length > 1, `${recs.length} parts`);
  const enc = new TextEncoder();
  for (const r of recs) {
    assert(enc.encode(JSON.stringify(r)).length <= strokesRecordBudget + 2000);
    assert(enc.encode(JSON.stringify(r)).length < 64 << 10);
    assertEquals(r.ts, 5000);
  }
  assertEquals(recs.map((r) => r.id), recs.map((_, i) => strokesRecordID("big", i)));
  // Sorted by character across the parts.
  const keys = recs.flatMap((r) => Object.keys(r.glyphs as object));
  assertEquals(keys, [...keys].sort());
  assertEquals(keys.length, chars.length);
  // And whole again from the records.
  const d = assemble(recs, "big")!;
  assertEquals(Object.keys(d.glyphs).length, chars.length);
  assertEquals(d.parts, recs.length);
  assertEquals(Object.keys(userGlyphs(d)).length, chars.length);
});

Deno.test("fewer parts after an edit leaves the old ones, empty, at the new ts (never deleted)", () => {
  const edits: Record<string, StrokeGlyph> = {};
  for (const c of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ") edits[c] = glyph(40);
  const first = applyEdits(null, "f", edits, 1000);
  assert(first.length > 1);
  const d1 = assemble(first, "f")!;
  const gone: Record<string, null> = {};
  for (const c of Object.keys(edits)) if (c !== "a") gone[c] = null;
  const second = applyEdits(d1, "f", gone, 1001);
  assertEquals(second.length, first.length);
  assertEquals(second.map((r) => r.ts), second.map(() => 1001));
  assertEquals(Object.keys(second[0].glyphs as object), ["a"]);
  for (const r of second.slice(1)) assertEquals(r.glyphs, {});
  assertEquals(Object.keys(userGlyphs(assemble(second, "f"))), ["a"]);
});

Deno.test("an edit's ts beats whatever was held, even with a slow clock", () => {
  const first = applyEdits(null, "f", { a: glyph() }, 9000);
  const d = assemble(first, "f")!;
  const second = applyEdits(d, "f", { b: glyph() }, 100);
  assertEquals(second[0].ts, 9001);
});

Deno.test("merging pulled parts: greater ts replaces, equal adds, older is ignored", () => {
  const rec = (id: string, ts: number, glyphs: Record<string, unknown>) => ({
    id,
    ts,
    v: 1,
    model: "f",
    glyphs,
  });
  const g = (n: number) => encodeGlyph(glyph(n));
  const all = [
    rec("strokes-f", 10, { a: g(1) }),
    rec("strokes-f-1", 10, { b: g(1) }),
    rec("strokes-f-2", 5, { z: g(1) }), // an older version's part
  ];
  const d = assemble(all, "f")!;
  assertEquals(Object.keys(d.glyphs).sort(), ["a", "b"]);
  assertEquals(d.ts, 10);
  assertEquals(d.parts, 3);
  // A greater ts in part 0 alone replaces the glyphs of the font.
  const newer = assemble([...all, rec("strokes-f", 20, { c: g(1) })], "f")!;
  assertEquals(Object.keys(newer.glyphs), ["c"]);
  assertEquals(fontsOf(all), ["f"]);
});

Deno.test("unknown fields of a record and of a glyph survive an edit", () => {
  const stored = [{
    id: "strokes-f",
    ts: 10,
    v: 1,
    model: "f",
    glyphs: { a: { ...encodeGlyph(glyph()), note: "keep me" } },
    mystery: { x: 1 },
  }];
  const d = assemble(stored, "f")!;
  const out = applyEdits(d, "f", { a: glyph(2) }, 20)[0];
  assertEquals(out.mystery, { x: 1 });
  const a = (out.glyphs as Record<string, Record<string, unknown>>).a;
  assertEquals(a.note, "keep me");
  assertEquals((a.strokes as unknown[]).length, 2);
});

Deno.test("export and import", () => {
  const d = assemble(applyEdits(null, "f", { a: glyph(), b: glyph(2) }, 77), "f")!;
  const text = exportFile(d);
  const parsed = JSON.parse(text);
  assertEquals([parsed.v, parsed.model, parsed.ts], [1, "f", 77]);
  assertEquals("parts" in parsed, false);
  const back = parseImport(text);
  assert(back.ok);
  if (back.ok) assertEquals(Object.keys(back.glyphs).sort(), ["a", "b"]);
  assertEquals(parseImport("not json").ok, false);
  assertEquals(parseImport('{"v":2,"glyphs":{}}').ok, false);
  assertEquals(parseImport('{"v":1,"glyphs":{"a":{"strokes":[{"pts":[["x"]]}]}}}').ok, false);
});

Deno.test("glyph status and coverage", () => {
  const built = (verified: boolean, confidence: number): StrokeGlyph => ({
    ...glyph(),
    origin: "table",
    verified,
    confidence,
  });
  assertEquals(glyphStatus(glyph(), built(true, 0.9)), "user");
  assertEquals(glyphStatus(undefined, built(true, 0.9)), "builtinVerified");
  assertEquals(glyphStatus(undefined, built(false, 0.9)), "builtinUnverified");
  assertEquals(glyphStatus(undefined, built(true, 0.4)), "missing");
  assertEquals(glyphStatus(undefined, built(true, 0.4), glyph()), "suggested");
  assertEquals(coveragePercent(["user", "missing", "suggested", "builtinVerified"]), 50);
});

Deno.test("sanitizing refuses malformed glyphs and keeps the well formed ones of a file", () => {
  assertEquals(sanitizeGlyph({ strokes: [{ pts: [] }] }), null);
  assertEquals(sanitizeGlyph({ strokes: [{ pts: [[1]] }] }), null);
  assertEquals(sanitizeGlyph(null), null);
  const f = parseModelFile({ v: 1, glyphs: { a: glyph(), b: { strokes: "no" } } })!;
  assertEquals(Object.keys(f.glyphs), ["a"]);
  assertEquals(parseModelFile({ v: 2, glyphs: {} }), null);
});
