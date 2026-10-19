// What is written on a sheet row, kept on this device so it survives a reload
// (never synced: the ink records of checked attempts are what sync carries).
// Stored values come from IndexedDB, which other code could have written, so
// they are checked and rebuilt rather than trusted.

import type { Pen, Point, Stroke } from "./ink.ts";
import { cyrb53 } from "./progress-store.ts";

const maxStrokes = 2000;
const maxPoints = 20_000;

/** The key of one row's writing: the sheet, the row's place on it and its model text. */
export function rowKey(sheet: string, index: number, text: string): string {
  return `${sheet}|${index}|${text}`;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function readPen(x: unknown): Pen | null {
  if (!isObj(x)) return null;
  if (x.kind === "monoline" && num(x.weight)) return { kind: "monoline", weight: x.weight };
  if (x.kind === "edged" && num(x.nibs) && num(x.angle)) {
    return x.swell === true
      ? { kind: "edged", nibs: x.nibs, angle: x.angle, swell: true }
      : { kind: "edged", nibs: x.nibs, angle: x.angle };
  }
  if (x.kind === "pointed" && num(x.weight)) return { kind: "pointed", weight: x.weight };
  if (x.kind === "pencil" && num(x.lead)) return { kind: "pencil", lead: x.lead };
  return null;
}

function readPoint(x: unknown): Point | null {
  if (!isObj(x) || !num(x.u) || !num(x.v) || !num(x.p) || !num(x.t)) return null;
  const p: Point = { u: x.u, v: x.v, p: x.p, t: x.t };
  for (const k of ["alt", "az", "roll", "force"] as const) if (num(x[k])) p[k] = x[k];
  return p;
}

/** The strokes in a stored value; anything malformed is dropped, never thrown on. */
export function sanitizeStrokes(x: unknown): Stroke[] {
  if (!Array.isArray(x)) return [];
  const out: Stroke[] = [];
  for (const s of x.slice(0, maxStrokes)) {
    if (!isObj(s) || !Array.isArray(s.points)) continue;
    const pen = readPen(s.pen);
    if (!pen) continue;
    const points = s.points.slice(0, maxPoints).map(readPoint).filter((p): p is Point =>
      p !== null
    );
    if (points.length === 0) continue;
    const stroke: Stroke = { pen, points };
    if (s.followsRoll === true) stroke.followsRoll = true;
    if (num(s.rollRef)) stroke.rollRef = s.rollRef;
    out.push(stroke);
  }
  return out;
}

/** The check a row's writing was last recorded as, so re-checking identical writing adds no record. */
export interface Recorded {
  /** `fingerprint` of the writing and model when it was recorded. */
  fp: string;
  /** The recorded check's id; empty until the store has assigned it. */
  check: string;
}

/**
 * A stable hash of what makes a check a new attempt: every stroke's pen and points, and the model
 * (font family, style and slant) it was checked against. Identical writing restored from storage
 * hashes the same, because sanitizeStrokes keeps every number exactly.
 */
export function fingerprint(
  strokes: Stroke[],
  font: { family: string; style: string; slant: number } | null,
): string {
  const parts = strokes.map((s) =>
    JSON.stringify([
      s.pen,
      s.followsRoll === true,
      s.rollRef ?? null,
      s.points.map((p) => [p.u, p.v, p.p, p.t, p.alt ?? null, p.az ?? null, p.roll ?? null]),
    ])
  );
  return cyrb53(`${font?.family}|${font?.style}|${font?.slant}|${parts.join(";")}`);
}

/** A stored `recorded` member, or null unless it is well formed. */
export function sanitizeRecorded(x: unknown): Recorded | null {
  if (!isObj(x) || typeof x.fp !== "string" || typeof x.check !== "string") return null;
  return x.fp.length <= 64 && x.check.length <= 64 ? { fp: x.fp, check: x.check } : null;
}
