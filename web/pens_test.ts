/// <reference lib="deno.ns" />

// The pens' maths against values worked out by hand from the iPad repo's docs/pens.md (the
// formulas, not this code): the pressure curve, the pointed nib's smoothing and taper, the
// pencil's footprint and stamps, and the grain hash.

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  getPressureUpper,
  grainHash,
  grainTileAlpha,
  pencilBaseWidth,
  pencilGrain,
  pencilGrainFactor,
  pencilMajor,
  pencilOpacity,
  pencilStamps,
  pencilTilt,
  pointedWidths,
  pressureCurve,
  setPressureUpper,
  smoothed,
} from "./pens.ts";

const near = (a: number, b: number, msg?: string) => assertAlmostEquals(a, b, 1e-9, msg);

Deno.test("pressure curve: (p - 0.02) / (upper - 0.02), clamped, ^0.7", () => {
  near(pressureCurve(0.12), 0.3602235327609866);
  near(pressureCurve(0.15), 0.4328450224951221);
  assertEquals(pressureCurve(0.45), 1);
  assertEquals(pressureCurve(0.9), 1);
  assertEquals(pressureCurve(0.02), 0);
  assertEquals(pressureCurve(0), 0);
  assertEquals(pressureCurve(-1), 0);
  // The calibration: a light setting (upper 0.3) reaches full pressure sooner, a firm one later.
  assertEquals(pressureCurve(0.3, 0.3), 1);
  near(pressureCurve(0.15, 0.3), 0.5844531782645686);
  near(pressureCurve(0.3, 0.7), 0.5373464487700148);
});

Deno.test("a missing pressure is the neutral 0.15", () => {
  near(pressureCurve(NaN), pressureCurve(0.15));
  near(pressureCurve(Infinity), pressureCurve(0.15));
  near(pressureCurve(0.15, NaN), pressureCurve(0.15, 0.45));
});

Deno.test("the calibration setting is clamped to light 0.3 .. firm 0.7", () => {
  setPressureUpper(0.1);
  assertEquals(getPressureUpper(), 0.3);
  setPressureUpper(2);
  assertEquals(getPressureUpper(), 0.7);
  setPressureUpper(NaN);
  assertEquals(getPressureUpper(), 0.45);
  setPressureUpper(0.55);
  assertEquals(getPressureUpper(), 0.55);
  setPressureUpper(0.45);
});

Deno.test("smoothing is s[i] = s[i-1] + 0.3 (x[i] - s[i-1]) per point", () => {
  const s = smoothed([0, 10, 10, 0]);
  near(s[0], 0);
  near(s[1], 3);
  near(s[2], 5.1);
  near(s[3], 3.57);
  assertEquals(smoothed([]), []);
  assertEquals(smoothed([4]), [4]);
});

// xh 20, weight 3: base = (0.04 + 0.02 * 3) * 20 = 2 px. Five points 10 px (0.5 x-height) apart,
// 2 x-heights in all, so the taper length is 0.12.
const line = (n: number, step: number): Array<[number, number]> =>
  Array.from({ length: n }, (_, i) => [i * step, 0]);

Deno.test("pointed widths: pressure, smoothing, taper at both ends", () => {
  const p = [0.02, 0.45, 0.45, 0.15, 0.02];
  const fin = pointedWidths(line(5, 10), p, 20, 3, 0.45, true);
  // raw 2 * (0.15 + 1.6 q) = 0.3, 3.5, 3.5, 1.6851, 0.3; smoothed 0.3, 1.26, 1.932, 1.8579, 1.3906;
  // the first and last points are at taper 0.3.
  const expected = [0.09, 1.26, 1.932, 1.8579312215953172, 0.41716555653501664];
  fin.forEach((w, i) => near(w, expected[i], `finished ${i}`));
  // A stroke still being written only tapers at its start: the last point keeps its full width.
  const live = pointedWidths(line(5, 10), p, 20, 3, 0.45, false);
  near(live[0], 0.09);
  near(live[4], 1.3905518551167222);
  near(live[1], 1.26);
});

Deno.test("pointed taper: a dot tapers over half its length, a point or zero length not at all", () => {
  // 2 px = 0.1 x-height: L = 0.05, so the middle point is at full width and both ends at 0.3.
  const w = pointedWidths(line(3, 1), [0.45, 0.45, 0.45], 20, 3);
  // smoothed raw width is constant 3.5 * ... base 2 * 1.75 = 3.5
  near(w[0], 3.5 * 0.3);
  near(w[1], 3.5);
  near(w[2], 3.5 * 0.3);
  assertEquals(pointedWidths([[5, 5]], [0.45], 20, 3), [3.5]);
  assertEquals(pointedWidths([[5, 5], [5, 5]], [0.45, 0.45], 20, 3), [3.5, 3.5]);
  assertEquals(pointedWidths([], [], 20, 3), []);
  assertEquals(pointedWidths([[0, 0]], [], 20, 3), []);
});

Deno.test("pointed hairline and swell: 0.15 at no pressure, 1.75 at full, about 12:1", () => {
  const w = pointedWidths([[5, 5]], [0], 20, 3)[0];
  near(w, 2 * 0.15);
  near(pointedWidths([[5, 5]], [1], 20, 3)[0], 2 * 1.75);
});

Deno.test("pencil footprint: base, tilt, length, darkness", () => {
  // lead 3, xh 20: max(0.8, (0.025 + 0.036) * 20) = 1.22
  near(pencilBaseWidth(3, 20), 1.22);
  assertEquals(pencilBaseWidth(1, 10), 0.8);
  near(pencilTilt(Math.PI / 2), 0);
  near(pencilTilt(Math.PI / 4), 0.3535533905932738);
  near(pencilTilt(0), 1);
  near(pencilTilt(-1), 1);
  near(pencilTilt(9), 0);
  near(pencilMajor(1.22, Math.PI / 2), 1.22);
  near(pencilMajor(1.22, Math.PI / 4), 2.298337841309485);
  near(pencilMajor(1.22, 0), 4.27);
  near(pencilOpacity(0), 0.25);
  near(pencilOpacity(1), 0.95);
  near(pencilOpacity(pressureCurve(0.15)), 0.5529915157465854);
});

Deno.test("pencil stamps: first at the first point, then every max(0.4, 0.25 minor)", () => {
  // Level pressure q = 1, altitude 45 degrees, azimuth 0, three points 3 px apart.
  const s = [0, 3].map((x) => ({ x, y: 0, p: 0.45, alt: Math.PI / 4, az: 0 }));
  const st = pencilStamps(s, 3, 20);
  assertEquals(st.length, 8);
  [0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.4, 2.8].forEach((x, i) => near(st[i].x, x, `x ${i}`));
  // major 2.2983, travelling along the azimuth: n = 2.2983 / 0.4 = 5.7458 stamps overlap.
  near(st[0].major, 2.298337841309485);
  near(st[0].minor, 1.22);
  near(st[3].alpha, 0.40629558557349177);
  near(st[3].angle, 0);
  // Travelling across the footprint (azimuth 90 degrees): the extent is the minor axis, 1.22 / 0.4.
  const across = pencilStamps(
    s.map((x) => ({ ...x, az: Math.PI / 2 })),
    3,
    20,
  );
  near(across[3].alpha, 0.6255164127693447);
  near(across[3].angle, Math.PI / 2);
});

Deno.test("pencil stamps: the spacing carries over points, attributes interpolate", () => {
  // Two segments of 1.1 px (lead 3, xh 20: spacing 0.4): stamps at 0, 0.4, 0.8 and, carrying 0.1
  // over the point, at 1.2, 1.6, 2.0 (arc length).
  const s = [
    { x: 0, y: 0, p: 0.45 },
    { x: 1.1, y: 0, p: 0.45, az: 1 },
    { x: 2.2, y: 0, p: 0.45, az: 1 },
  ];
  const st = pencilStamps(s, 3, 20);
  assertEquals(st.map((x) => x.seg), [0, 0, 0, 1, 1, 1]);
  [0, 0.4, 0.8, 1.2, 1.6, 2.0].forEach((x, i) => near(st[i].x, x, `x ${i}`));
  near(st[1].along, 0.4 / 1.1);
  near(st[3].along, 0.1 / 1.1);
  // Missing altitude is upright (a round footprint), missing azimuth is 0, and az interpolates
  // linearly between the points of a segment: 0 -> 1 over the first one.
  near(st[0].major, 1.22);
  near(st[1].angle, 0.4 / 1.1);
  near(st[3].angle, 1);
  // A point alone is one stamp; a zero-length segment adds none.
  assertEquals(pencilStamps([{ x: 4, y: 5, p: 0.2 }], 3, 20).length, 1);
  assertEquals(pencilStamps([], 3, 20), []);
  assertEquals(
    pencilStamps([{ x: 1, y: 1, p: 0.2 }, { x: 1, y: 1, p: 0.2 }], 3, 20).length,
    1,
  );
});

Deno.test("pencil stamps smooth pressure along the stroke", () => {
  // q 0 then 1: smoothed q at the second point is 0.3, so the second stamp is lighter than raw.
  const st = pencilStamps([{ x: 0, y: 0, p: 0.02 }, { x: 10, y: 0, p: 0.45 }], 3, 20);
  const last = st[st.length - 1];
  // At along 0.975 (x 9.75... the last stamp sits at 9.6 or beyond): alpha derives from
  // A = 0.25 + 0.7 q with q between 0 and 0.3.
  assert(last.alpha > 0 && last.alpha < 1 - Math.pow(1 - pencilOpacity(0.3), 1 / 1));
});

Deno.test("grain hash and tile", () => {
  assertEquals(grainHash(0, 0), 0);
  near(grainHash(1, 0), 0.503745433408767);
  near(grainHash(5, 7), 0.8286196845583618);
  near(grainHash(127, 127), 0.3258457421325147);
  near(pencilGrain(0, 0), 0.21656220717122776);
  near(pencilGrain(1, 0), 0.5439967388869262);
  near(pencilGrain(5, 7), 0.8478794605704024);
  near(pencilGrain(127, 127), 0.24404376139864326);
  // The tile repeats every 128 cells, also for negative cells.
  near(pencilGrain(-1, -1), pencilGrain(127, 127));
  near(pencilGrain(130, 3), 0.5451297597261145);
  near(pencilGrain(130, 3), pencilGrain(2, 3));
  near(pencilGrainFactor(0.21656220717122776), 0.5449059864541049);
  near(pencilGrainFactor(0.8478794605704024), 1);
  const tile = grainTileAlpha();
  assertEquals(tile.length, 128 * 128);
  assertEquals(tile[0], Math.round(0.5449059864541049 * 255));
  assertEquals(tile[1], Math.round(0.8395970649982336 * 255));
  assertEquals(tile[7 * 128 + 5], 255);
  assert(tile.every((a) => a >= 0.35 * 255 - 1));
});
