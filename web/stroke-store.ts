// What is written on a sheet row, kept on this device so it survives a reload
// (never synced: the ink records of checked attempts are what sync carries).
// Stored values come from IndexedDB, which other code could have written, so
// they are checked and rebuilt rather than trusted.

import type { Pen, Point, Stroke } from "./ink.ts";

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
    return { kind: "edged", nibs: x.nibs, angle: x.angle };
  }
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
