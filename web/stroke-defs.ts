// The person's own stroke definitions (iPad docs/strokes.md, "Define strokes and the user store"
// and "Sync"): one file per model font, in the schema of the built-in strokes/<modelId>.json,
// kept on this device as `strokes` records in IndexedDB (the same records the sync carries) and so
// shared with the iPad.
//
// A font's file travels as records `{id: "strokes-<fontId>", ts, v: 1, model, glyphs}`, each at most
// 64 KB. When the glyphs do not fit they are split by glyph range, sorted by character, into
// `strokes-<fontId>` (part 0) and `strokes-<fontId>-<n>` (n >= 1); every part of one version carries
// the same `ts`. A part no longer needed is sent with no glyphs, never deleted (a tombstone is
// permanent). A greater `ts` than the font's replaces its glyphs, an equal `ts` adds a part's glyphs,
// an older one is ignored (last writer wins). Unknown top-level fields of a record, and unknown
// fields of a glyph, survive edits.
//
// Everything here is pure; DeviceStore (progress-store.ts) reads and writes the records.

import { sanitizeGlyph } from "./stroke-models.ts";
import type { StrokeGlyph, StrokeLookup } from "./stroke-order.ts";

/** Records are split to stay under this many bytes (the server's cap is 65536). */
export const strokesRecordBudget = 60_000;

export interface StrokesRec {
  id: string;
  ts: number;
  [field: string]: unknown;
}

/** `strokes-<fontId>` for part 0, `strokes-<fontId>-<n>` after. */
export function strokesRecordID(font: string, part: number): string {
  return part === 0 ? `strokes-${font}` : `strokes-${font}-${part}`;
}

/** The part number of a record id for a known font, null if the id is not one of its parts. */
export function strokesPart(id: string, font: string): number | null {
  if (id === strokesRecordID(font, 0)) return 0;
  const prefix = `strokes-${font}-`;
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  if (!/^[0-9]+$/.test(rest)) return null;
  const n = Number(rest);
  return n >= 1 ? n : null;
}

/** A font's definitions as assembled from its records. */
export interface FontDefs {
  font: string;
  /** The time of the last edit (the sync's last-writer-wins key). */
  ts: number;
  /** How many records the font has had (the high-water mark; parts are never deleted). */
  parts: number;
  /** The raw glyphs, with whatever fields they carry. */
  glyphs: Record<string, Record<string, unknown>>;
  /** Unknown top-level fields, kept and sent back. */
  extras: Record<string, unknown>;
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const ownKeys = new Set(["v", "model", "source", "ts", "parts", "glyphs", "id"]);

/** The fonts that have records. */
export function fontsOf(records: unknown[]): string[] {
  const out = new Set<string>();
  for (const r of records) {
    if (isObj(r) && typeof r.model === "string" && typeof r.id === "string") {
      if (strokesPart(r.id, r.model) !== null) out.add(r.model);
    }
  }
  return [...out].sort();
}

/** A font's definitions from the stored records (any mix of fonts); null when it has none. */
export function assemble(records: unknown[], font: string): FontDefs | null {
  const mine: Array<{ part: number; r: StrokesRec }> = [];
  for (const r of records) {
    if (!isObj(r) || typeof r.id !== "string" || typeof r.ts !== "number") continue;
    if (r.model !== font) continue;
    const part = strokesPart(r.id, font);
    if (part !== null && Number.isFinite(r.ts)) mine.push({ part, r: r as StrokesRec });
  }
  if (mine.length === 0) return null;
  const ts = Math.max(...mine.map((m) => m.r.ts));
  const glyphs: Record<string, Record<string, unknown>> = {};
  let extras: Record<string, unknown> = {};
  const current = mine.filter((m) => m.r.ts === ts).sort((a, b) => a.part - b.part);
  for (const { r } of current) {
    if (isObj(r.glyphs)) {
      for (const [c, g] of Object.entries(r.glyphs)) if (isObj(g)) glyphs[c] = g;
    }
  }
  const head = current.find((m) => m.part === 0) ?? current[0];
  for (const [k, v] of Object.entries(head.r)) if (!ownKeys.has(k)) extras[k] = v;
  extras = structuredClone(extras);
  return {
    font,
    ts,
    parts: Math.max(...mine.map((m) => m.part)) + 1,
    glyphs,
    extras,
  };
}

/** The glyphs that decode (one that does not is left out, and stays in the records). */
export function userGlyphs(defs: FontDefs | null): Record<string, StrokeGlyph> {
  const out: Record<string, StrokeGlyph> = {};
  if (!defs) return out;
  for (const [c, g] of Object.entries(defs.glyphs)) {
    const s = sanitizeGlyph(g);
    if (s && s.strokes.length > 0) out[c] = s;
  }
  return out;
}

export function userLookup(defs: FontDefs | null): StrokeLookup | null {
  const g = userGlyphs(defs);
  if (Object.keys(g).length === 0) return null;
  return (c) => Object.hasOwn(g, c) ? g[c] : undefined;
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;

/** A glyph as stored: coordinates to 4 decimals, confidence to 2, `kind` only when not main. */
export function encodeGlyph(g: StrokeGlyph): Record<string, unknown> {
  return {
    strokes: g.strokes.map((s) => ({
      pts: s.pts.map((p) => [r4(p[0]), r4(p[1])]),
      ...(s.kind && s.kind !== "main" ? { kind: s.kind } : {}),
    })),
    verified: g.verified,
    origin: g.origin,
    confidence: Math.round(g.confidence * 100) / 100,
  };
}

const encoder = new TextEncoder();
const bytes = (x: unknown): number => encoder.encode(JSON.stringify(x)).length;

/** The records of a font's definitions: glyph ranges sorted by character, each part within the budget. */
export function splitRecords(
  font: string,
  ts: number,
  glyphs: Record<string, unknown>,
  extras: Record<string, unknown>,
  minParts = 1,
): StrokesRec[] {
  const record = (part: number, g: Record<string, unknown>): StrokesRec => ({
    ...extras,
    id: strokesRecordID(font, part),
    ts,
    v: 1,
    model: font,
    glyphs: g,
  });
  const out: StrokesRec[] = [];
  let cur: Record<string, unknown> = {};
  const base = bytes(record(0, {}));
  let size = base;
  for (const c of Object.keys(glyphs).sort()) {
    const gs = bytes({ g: glyphs[c] }) + encoder.encode(c).length + 4;
    if (Object.keys(cur).length > 0 && size + gs > strokesRecordBudget) {
      out.push(record(out.length, cur));
      cur = {};
      size = base;
    }
    cur[c] = glyphs[c];
    size += gs;
  }
  out.push(record(out.length, cur));
  // A part once sent stays alive, empty, rather than being deleted.
  while (out.length < minParts) out.push(record(out.length, {}));
  return out;
}

/**
 * Set or replace glyphs (`null` removes one) and return the records to store and sync: every part,
 * old and new. Unknown fields of a glyph being replaced, and of the file, are kept.
 */
export function applyEdits(
  defs: FontDefs | null,
  font: string,
  edits: Record<string, StrokeGlyph | null>,
  now = Date.now(),
): StrokesRec[] {
  const glyphs: Record<string, unknown> = { ...(defs?.glyphs ?? {}) };
  for (const [c, g] of Object.entries(edits)) {
    if (g === null) {
      delete glyphs[c];
      continue;
    }
    const old = glyphs[c];
    glyphs[c] = isObj(old) ? { ...old, ...encodeGlyph(g) } : encodeGlyph(g);
  }
  // Greater than any version held, so the edit wins over what a sync brought.
  const ts = Math.max(Math.round(now), (defs?.ts ?? 0) + 1);
  return splitRecords(font, ts, glyphs, defs?.extras ?? {}, defs?.parts ?? 1);
}

/** The font's definitions as a strokes file (the schema of `strokes/<modelId>.json`), pretty printed. */
export function exportFile(defs: FontDefs): string {
  return JSON.stringify(
    {
      ...defs.extras,
      v: 1,
      model: defs.font,
      source: "Your own definitions",
      ts: defs.ts,
      glyphs: defs.glyphs,
    },
    null,
    2,
  );
}

export type ImportResult = { ok: true; glyphs: Record<string, StrokeGlyph> } | {
  ok: false;
  error: string;
};

/** The glyphs of a strokes file (any font's), to be added to the chosen font; glyphs that do not decode are skipped. */
export function parseImport(text: string): ImportResult {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return { ok: false, error: "That is not a strokes file." };
  }
  if (!isObj(o) || o.v !== 1 || !isObj(o.glyphs)) {
    return { ok: false, error: "That is not a strokes file." };
  }
  const glyphs: Record<string, StrokeGlyph> = {};
  for (const [c, g] of Object.entries(o.glyphs)) {
    const s = sanitizeGlyph(g);
    if (s && s.strokes.length > 0) glyphs[c] = s;
  }
  if (Object.keys(glyphs).length === 0) return { ok: false, error: "The file has no glyphs." };
  return { ok: true, glyphs };
}
