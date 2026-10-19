// Stroke models: the built-in files (`/static/strokes/<modelId>.json`, from the iPad app's
// strokes/), what a font's characters have (status and coverage, for the Stroke models page), and
// the id definitions are filed under. See the iPad repo's docs/strokes.md. The person's own
// definitions are in stroke-defs.ts; `chainLookups` puts them first.

import {
  OrderLimits,
  type StrokeGlyph,
  type StrokeKind,
  type StrokeLookup,
  type StrokeModelFile,
  type StrokeOrigin,
} from "./stroke-order.ts";

/** Catalogue models that have a built-in stroke file (a font without one is judged for shape only). */
export const builtinModelIds = ["italic", "briem-print"];

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const origins: StrokeOrigin[] = ["table", "font", "user", "transfer"];
const kinds: StrokeKind[] = ["main", "dot", "cross"];

/** A glyph from untrusted JSON (a file, IndexedDB, a sync record): null unless it is well formed. */
export function sanitizeGlyph(x: unknown): StrokeGlyph | null {
  if (!isObj(x) || !Array.isArray(x.strokes)) return null;
  const strokes: StrokeGlyph["strokes"] = [];
  for (const s of x.strokes.slice(0, 64)) {
    if (!isObj(s) || !Array.isArray(s.pts)) return null;
    const pts: number[][] = [];
    for (const p of s.pts.slice(0, 2000)) {
      if (!Array.isArray(p) || p.length < 2 || !num(p[0]) || !num(p[1])) return null;
      pts.push([p[0], p[1]]);
    }
    if (pts.length === 0) return null;
    const kind = kinds.find((k) => k === s.kind);
    strokes.push(kind && kind !== "main" ? { pts, kind } : { pts });
  }
  const origin = origins.find((o) => o === x.origin) ?? "table";
  return {
    strokes,
    verified: x.verified === true,
    origin,
    confidence: num(x.confidence) ? Math.min(1, Math.max(0, x.confidence)) : 0,
  };
}

/** A model file from untrusted JSON: its well-formed glyphs only; null if it is not a strokes file. */
export function parseModelFile(x: unknown): StrokeModelFile | null {
  if (!isObj(x) || x.v !== 1 || !isObj(x.glyphs)) return null;
  const glyphs: Record<string, StrokeGlyph> = {};
  for (const [c, g] of Object.entries(x.glyphs)) {
    const s = sanitizeGlyph(g);
    if (s) glyphs[c] = s;
  }
  const f: StrokeModelFile = {
    v: 1,
    model: typeof x.model === "string" ? x.model : "",
    source: typeof x.source === "string" ? x.source : "",
    glyphs,
  };
  if (typeof x.copyright === "string") f.copyright = x.copyright;
  if (typeof x.licence === "string") f.licence = x.licence;
  if (num(x.slant)) f.slant = x.slant;
  return f;
}

export const lookupOf = (glyphs: Record<string, StrokeGlyph>): StrokeLookup => (c) =>
  Object.hasOwn(glyphs, c) ? glyphs[c] : undefined;

type FetchFn = (url: string) => Promise<Response>;
const builtinCache = new Map<string, Promise<StrokeModelFile | null>>();

/** The built-in model file of a catalogue model, or null (none for the font, or it could not be read). */
export function loadBuiltin(
  id: string,
  f: FetchFn = (u) => fetch(u),
): Promise<StrokeModelFile | null> {
  if (!builtinModelIds.includes(id)) return Promise.resolve(null);
  let p = builtinCache.get(id);
  if (!p) {
    p = f(`/static/strokes/${id}.json`).then((r) => r.ok ? r.json() : null).then(parseModelFile)
      .catch(() => null);
    builtinCache.set(id, p);
    // A failed load is tried again next time, not remembered.
    p.then((v) => {
      if (!v) builtinCache.delete(id);
    });
  }
  return p;
}

/**
 * The id the definitions of a model font are filed under: the catalogue id, or `custom-<family>` for a
 * custom font (family reduced to [a-z0-9-] and cut so every record id stays within 64 bytes).
 */
export function strokesFontID(model: string, family: string): string {
  if (model !== "custom") return model;
  let s = "";
  for (const c of family.toLowerCase()) {
    if (/^[a-z0-9]$/.test(c)) s += c;
    else if (!s.endsWith("-")) s += "-";
  }
  s = s.replace(/^-+|-+$/g, "");
  if (s === "") s = "font";
  return "custom-" + s.slice(0, 32);
}

// ---- what a font has (docs/strokes.md, "Define strokes and the user store") ------------------

export type GlyphStatus =
  | "user"
  | "builtinVerified"
  | "builtinUnverified"
  | "suggested"
  | "missing";

export const statusTitle: Record<GlyphStatus, string> = {
  user: "Your definition",
  builtinVerified: "Built-in, verified",
  builtinUnverified: "Built-in, unverified",
  suggested: "Suggested from a similar font",
  missing: "Missing",
};

/** Strokes that judging uses (a suggestion is not used until the person accepts it). */
export const statusDefined = (s: GlyphStatus): boolean =>
  s === "user" || s === "builtinVerified" || s === "builtinUnverified";

const lower = "abcdefghijklmnopqrstuvwxyz";
const upper = lower.toUpperCase();
const digits = "0123456789";
const punctuation = ".,;:!?'-";

/** The character set a model should cover, in sections. */
export const glyphSections: Array<{ name: string; chars: string[] }> = [
  { name: "Lower case", chars: [...lower] },
  { name: "Capitals", chars: [...upper] },
  { name: "Numerals", chars: [...digits] },
  { name: "Punctuation", chars: [...punctuation] },
];

export const allGlyphChars: string[] = glyphSections.flatMap((s) => s.chars);

/** The status of a character: the person's own first, then the built-in one (not judged below the confidence), then a suggestion. */
export function glyphStatus(
  user: StrokeGlyph | undefined,
  builtin: StrokeGlyph | undefined,
  suggestion?: StrokeGlyph,
): GlyphStatus {
  if (user && user.strokes.length > 0) return "user";
  if (builtin && builtin.strokes.length > 0 && builtin.confidence >= OrderLimits.minConfidence) {
    return builtin.verified ? "builtinVerified" : "builtinUnverified";
  }
  if (suggestion && suggestion.strokes.length > 0) return "suggested";
  return "missing";
}

/** Whole percent of the characters that judging has strokes for. */
export function coveragePercent(statuses: GlyphStatus[]): number {
  if (statuses.length === 0) return 0;
  return Math.round((100 * statuses.filter(statusDefined).length) / statuses.length);
}
