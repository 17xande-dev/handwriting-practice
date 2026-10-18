// Shared by the golden tests (metrics_test.ts, ink-codec_test.ts): comparing a result with a
// golden file within its tolerance, and reading the files' stroke form.

import { assert, assertEquals } from "@std/assert";
import type { Pen, Point, Stroke } from "./ink.ts";

// deno-lint-ignore no-explicit-any
export type J = any;

/** Compare `actual` with the golden `expected`; a null in the file is a NaN (or null) here. */
export function same(actual: unknown, expected: unknown, tol: number, path: string, ints = true) {
  if (expected === null) {
    assert(
      actual === null || actual === undefined || (typeof actual === "number" && isNaN(actual)),
      `${path}: expected null, got ${actual}`,
    );
  } else if (typeof expected === "number") {
    assert(typeof actual === "number", `${path}: expected a number, got ${actual}`);
    if (ints && Number.isInteger(expected) && !Number.isInteger(actual)) {
      throw new Error(`${path}: expected integer ${expected}, got ${actual}`);
    }
    assert(
      Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)),
      `${path}: ${actual} != ${expected}`,
    );
  } else if (Array.isArray(expected)) {
    assert(Array.isArray(actual), `${path}: not an array`);
    assertEquals(actual.length, expected.length, `${path}: length`);
    expected.forEach((e, i) => same(actual[i], e, tol, `${path}[${i}]`, ints));
  } else if (expected && typeof expected === "object") {
    assert(actual && typeof actual === "object", `${path}: not an object`);
    const a = actual as Record<string, unknown>;
    for (const [k, v] of Object.entries(expected)) same(a[k], v, tol, `${path}.${k}`, ints);
  } else {
    assertEquals(actual, expected, path);
  }
}

export const orNaN = (x: unknown): number => x === null || x === undefined ? NaN : x as number;

export function parseStroke(j: J): Stroke {
  const pen: Pen = j.pen.kind === "edged"
    ? { kind: "edged", nibs: j.pen.nibs, angle: j.pen.angle }
    : { kind: "monoline", weight: j.pen.weight };
  const points = j.points.map((a: Array<number | null>): Point => {
    const p: Point = { u: a[0]!, v: a[1]!, p: a[2]!, t: a[3]! };
    if (a[4] != null) p.alt = a[4];
    if (a[5] != null) p.az = a[5];
    if (a[6] != null) p.roll = a[6];
    return p;
  });
  const s: Stroke = { pen, points };
  if (j.fr === true) s.followsRoll = true;
  if (j.rr !== null && j.rr !== undefined) s.rollRef = j.rr;
  return s;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** The golden's stroke form of a decoded stroke. */
export function strokeJson(s: Stroke) {
  const pen = s.pen.kind === "edged"
    ? { kind: "edged", nibs: s.pen.nibs, angle: s.pen.angle }
    : { kind: "monoline", weight: s.pen.weight };
  const o = (x: number | undefined) => x === undefined ? null : round6(x);
  return {
    pen,
    fr: s.followsRoll === true,
    rr: o(s.rollRef),
    points: s.points.map((
      p,
    ) => [round6(p.u), round6(p.v), round6(p.p), p.t, o(p.alt), o(p.az), o(p.roll)]),
  };
}

export function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return `{${
      Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")
    }}`;
  }
  return JSON.stringify(x);
}
