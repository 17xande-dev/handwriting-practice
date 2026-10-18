// The `ink` record: one checked attempt's strokes, packed small enough for the
// sync server's 64 KB record limit. A port of the iPad app's InkCodec.swift;
// the byte layout, quantisation and decimation are specified in its
// docs/metrics.md ("Ink record") and pinned by testdata/metrics/ink*.json.
// Strokes are in x-height units; the record keeps them as 10 bytes per point.

import type { Pen, Point, Stroke } from "./ink.ts";
import { type Pen2, pen2Of } from "./metric-scores.ts";

/** Bytes per point in `d`. */
export const pointBytes = 10;
export const maxRecordBytes = 65_536;
/** Encoded JSON is decimated until it is at most this long. */
export const targetBytes = 60_000;
const absent = 255;
const posLimit = 1_000_000_000;
const timeLimit = 2_147_483_647;

export interface InkStrokeRecord {
  /** The edged nib followed the barrel roll while this stroke was written. */
  fr: boolean;
  /** Roll reference (radians, 4 decimals), null when none. */
  rr: number | null;
  /** Time of the stroke's first point, ms after the first stroke's first point. */
  t0: number;
  /** Position of the first point, integers in 1/1000 x-height; a reader uses [0, 0] if absent or malformed. */
  o: [number, number];
  /** Packed points, base64. */
  d: string;
  /** Only when this stroke's pen differs from the record's. */
  pen?: Pen2;
}

export interface InkRecordV1 {
  id: string;
  /** The check's `at`. */
  ts: number;
  /** The check record's id. */
  check: string;
  v: 1;
  pen: Pen2;
  /** Points per x-height when written; informational. */
  xh: number;
  /** Decimation step used: every `dec`-th point kept (1 = none). */
  dec: number;
  strokes: InkStrokeRecord[];
}

const clamp16 = (x: number) => Math.min(32767, Math.max(-32768, x));

/** `round(x)` clamped to lo..hi; 0 if x is not finite (never NaN). */
function qint(x: number, lo: number, hi: number): number {
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : 0;
}

/** A direction or roll into one byte 0..253, wrapping; 255 = absent. */
function circ(x: number | undefined, lo: number): number {
  if (x === undefined || !Number.isFinite(x)) return absent;
  const d = x - lo;
  const w = d - 2 * Math.PI * Math.floor(d / (2 * Math.PI));
  return qint(w / (2 * Math.PI) * 254, 0, 254) % 254;
}

/**
 * Pack the points of one stroke: the stroke origin `o` (qu, qv of the first
 * point) and 10 bytes per point. Each delta is the quantised value minus what
 * the decoder has reconstructed so far, so a clamped jump is caught up by the
 * following points and error never accumulates.
 */
export function pack(points: Point[]): { origin: [number, number]; data: Uint8Array } {
  if (points.length === 0) return { origin: [0, 0], data: new Uint8Array(0) };
  const t0 = points[0].t;
  const out = new Uint8Array(points.length * pointBytes);
  const view = new DataView(out.buffer);
  let ru = 0, rv = 0, rt = 0;
  let origin: [number, number] = [0, 0];
  points.forEach((pt, i) => {
    const qu = qint(pt.u * 1000, -posLimit, posLimit);
    const qv = qint(pt.v * 1000, -posLimit, posLimit);
    const qt = qint(pt.t - t0, 0, timeLimit);
    let du = 0, dv = 0, dt = 0;
    if (i === 0) {
      origin = [qu, qv];
      ru = qu;
      rv = qv;
    } else {
      du = clamp16(qu - ru);
      dv = clamp16(qv - rv);
      dt = Math.min(32767, Math.max(0, qt - rt));
      ru += du;
      rv += dv;
      rt += dt;
    }
    const o = i * pointBytes;
    view.setInt16(o, du, true);
    view.setInt16(o + 2, dv, true);
    view.setInt16(o + 4, dt, true);
    out[o + 6] = Number.isFinite(pt.p) ? qint(Math.min(1, Math.max(0, pt.p)) * 255, 0, 255) : 0;
    out[o + 7] = pt.alt === undefined || !Number.isFinite(pt.alt)
      ? absent
      : qint(Math.min(Math.PI / 2, Math.max(0, pt.alt)) / (Math.PI / 2) * 253, 0, 253);
    out[o + 8] = circ(pt.az, 0);
    out[o + 9] = circ(pt.roll, -Math.PI);
  });
  return { origin, data: out };
}

/** Unpack `pack`'s bytes; a trailing partial point is ignored. */
export function unpack(data: Uint8Array, origin: [number, number], t0: number): Point[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pts: Point[] = [];
  let u = origin[0], v = origin[1], t = 0;
  for (let i = 0; i + pointBytes <= data.length; i += pointBytes) {
    u += view.getInt16(i, true);
    v += view.getInt16(i + 2, true);
    t += view.getInt16(i + 4, true);
    const alt = data[i + 7], az = data[i + 8], roll = data[i + 9];
    const p: Point = { u: u / 1000, v: v / 1000, p: data[i + 6] / 255, t: t0 + t };
    if (alt !== absent) p.alt = alt / 253 * (Math.PI / 2);
    if (az !== absent) p.az = az / 254 * 2 * Math.PI;
    if (roll !== absent) p.roll = roll / 254 * 2 * Math.PI - Math.PI;
    pts.push(p);
  }
  return pts;
}

/** Keep every `k`-th point, and always the first and last. */
export function decimate(points: Point[], k: number): Point[] {
  if (k <= 1 || points.length <= 2) return points;
  return points.filter((_, i) => i % k === 0 || i === points.length - 1);
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Strict standard base64 (padded); null for anything else. Never throws. */
export function fromBase64(s: string): Uint8Array | null {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const utf8 = new TextEncoder();
const byteLength = (s: string) => utf8.encode(s).length;
const round4 = (x: number) => Math.round(x * 10000) / 10000;

function samePen(a: Pen2, b: Pen2): boolean {
  return a.kind === b.kind && a.weight === b.weight && a.nibs === b.nibs && a.angle === b.angle;
}

export interface Encoded {
  record: InkRecordV1;
  json: string;
  bytes: number;
  decimation: number;
}

/**
 * The ink record for a check's strokes, id "<checkId>-ink", decimated until its
 * JSON is at most `target` bytes. Null without points, when the id exceeds 64
 * bytes, when a number cannot be written, or when even two points per stroke
 * do not fit.
 */
export function encodeInk(
  strokes: Stroke[],
  checkId: string,
  at: number,
  xh: number,
  target = targetBytes,
): Encoded | null {
  const before = strokes.reduce((a, s) => a + s.points.length, 0);
  const first = strokes.find((s) => s.points.length > 0);
  const pen = pen2Of(strokes);
  if (before === 0 || !first || !pen) return null;
  const origin = first.points[0].t;
  const id = `${checkId}-ink`;
  if (byteLength(id) > 64 || !Number.isFinite(at)) return null;
  if ([pen.weight, pen.nibs, pen.angle].some((x) => x !== undefined && !Number.isFinite(x))) {
    return null;
  }
  const longest = Math.max(...strokes.map((s) => s.points.length));
  let k = 1;
  for (;;) {
    const recs = strokes.filter((s) => s.points.length > 0).map((s): InkStrokeRecord => {
      const pts = decimate(s.points, k);
      const sp = pen2Of([s])!;
      const packed = pack(pts);
      const ref = s.rollRef ?? s.points[0].roll;
      const rec: InkStrokeRecord = {
        fr: s.followsRoll === true,
        rr: ref !== undefined && Number.isFinite(ref) ? round4(ref) : null,
        t0: qint(pts[0].t - origin, 0, timeLimit),
        o: packed.origin,
        d: toBase64(packed.data),
      };
      if (!samePen(sp, pen)) rec.pen = sp;
      return rec;
    });
    const record: InkRecordV1 = {
      id,
      ts: at,
      check: checkId,
      v: 1,
      pen,
      xh: Number.isFinite(xh) ? Math.round(xh * 100) / 100 : 0,
      dec: k,
      strokes: recs,
    };
    const json = JSON.stringify(record);
    const bytes = byteLength(json);
    if (bytes <= target) return { record, json, bytes, decimation: k };
    if (k >= longest) return null;
    k = Math.max(k + 1, Math.min(longest, Math.ceil(k * bytes / target)));
  }
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** A pen object read from a record: any kind is kept, and missing numbers are left out. */
function readPen2(x: unknown): Pen2 | null {
  if (!isObj(x) || typeof x.kind !== "string" || x.kind === "") return null;
  const p: Pen2 = { kind: x.kind, input: typeof x.input === "string" ? x.input : "touch" };
  for (const k of ["weight", "nibs", "angle"] as const) if (isNum(x[k])) p[k] = x[k];
  if (typeof x.followsRoll === "boolean") p.followsRoll = x.followsRoll;
  return p;
}

/** The drawing pen of a pen object: missing edged `nibs`/`angle` default to 5/45, a missing `weight` to 3. */
export function penOf(p: Pen2): Pen {
  return p.kind === "edged"
    ? { kind: "edged", nibs: p.nibs ?? 5, angle: p.angle ?? 45 }
    : { kind: "monoline", weight: p.weight ?? 3 };
}

/**
 * The strokes of an ink record (a JSON string or an already parsed value), with
 * timestamps relative to the first point of the first stroke. Null for a record
 * that is too big, not JSON, not version 1 or missing a required member. Bad
 * data in one stroke gives that stroke no points; nothing throws.
 */
export function decodeInk(input: string | unknown): Stroke[] | null {
  let r: unknown = input;
  if (typeof input === "string") {
    if (byteLength(input) > maxRecordBytes) return null;
    try {
      r = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (
    !isObj(r) || r.v !== 1 || typeof r.id !== "string" || !isNum(r.ts) ||
    typeof r.check !== "string" || !Array.isArray(r.strokes)
  ) {
    return null;
  }
  const recPen = readPen2(r.pen);
  if (!recPen) return null;
  const out: Stroke[] = [];
  for (const s of r.strokes) {
    if (!isObj(s) || typeof s.d !== "string" || !isNum(s.t0)) return null;
    const pen = penOf(readPen2(s.pen) ?? recPen);
    const o: [number, number] = Array.isArray(s.o) && s.o.length === 2 &&
        s.o.every((x) => Number.isInteger(x))
      ? [s.o[0] as number, s.o[1] as number]
      : [0, 0];
    const bytes = fromBase64(s.d);
    const stroke: Stroke = { pen, points: bytes ? unpack(bytes, o, s.t0) : [] };
    if (s.fr === true) stroke.followsRoll = true;
    if (isNum(s.rr)) stroke.rollRef = s.rr;
    out.push(stroke);
  }
  return out;
}

/** Whether a stored or pulled value is an ink record the server and this app accept. */
export function inkEntry(x: unknown): { id: string; ts: number; check: string } | null {
  if (
    !isObj(x) || typeof x.id !== "string" || !isNum(x.ts) || !(x.ts > 0) ||
    typeof x.check !== "string" || x.check === ""
  ) {
    return null;
  }
  const n = byteLength(x.id);
  return n >= 1 && n <= 64 ? { id: x.id, ts: x.ts, check: x.check } : null;
}

export interface RoundTripError {
  position: number;
  time: number;
  pressure: number;
}

/** Largest differences between `original` (decimated the same way) and `decoded`. */
export function roundTripError(original: Stroke[], decoded: Stroke[]): RoundTripError {
  const e: RoundTripError = { position: 0, time: 0, pressure: 0 };
  const origin = original.find((s) => s.points.length > 0)?.points[0].t ?? 0;
  original.forEach((a, i) => {
    const b = decoded[i];
    if (!b) return;
    a.points.forEach((p, j) => {
      const q = b.points[j];
      if (!q) return;
      e.position = Math.max(e.position, Math.abs(p.u - q.u), Math.abs(p.v - q.v));
      e.time = Math.max(e.time, Math.abs((p.t - origin) - q.t));
      e.pressure = Math.max(e.pressure, Math.abs(p.p - q.p));
    });
  });
  return e;
}
