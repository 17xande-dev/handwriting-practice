// The pens' pure maths: the pressure curve, smoothing, the pointed nib's widths and taper, the
// pencil's stamps and paper grain. A port of the iPad app's HandwritingCore/Pens.swift, specified
// in its docs/pens.md; ink.ts draws the results. Nothing here touches a canvas.

// ---- pressure curve ---------------------------------------------------------------------------

/** Raw pressure at and below which the calibrated pressure is 0 (the Pencil's resting noise). */
export const pressureLower = 0.02;
/** Raw pressure at which the calibrated pressure reaches 1 (default; the Pressure setting moves it). */
export const pressureUpperDefault = 0.45;
export const pressureUpperRange: readonly [number, number] = [0.3, 0.7];
export const pressureGamma = 0.7;
/** The raw pressure used where none is measured (mouse, finger, an estimate not yet reported). */
export const neutralPressure = 0.15;

/** `q = clamp((p - 0.02) / (upper - 0.02), 0, 1) ^ 0.7`; a non-finite `p` is the neutral pressure. */
export function pressureCurve(p: number, upper: number = pressureUpperDefault): number {
  const pp = Number.isFinite(p) ? p : neutralPressure;
  const hi = Math.max(pressureLower + 0.05, Number.isFinite(upper) ? upper : pressureUpperDefault);
  const x = Math.min(1, Math.max(0, (pp - pressureLower) / (hi - pressureLower)));
  return Math.pow(x, pressureGamma);
}

/** The calibration the renderers use: a device setting, never stored in strokes. */
let pressureUpper = pressureUpperDefault;
export function setPressureUpper(v: number) {
  pressureUpper = Number.isFinite(v)
    ? Math.min(pressureUpperRange[1], Math.max(pressureUpperRange[0], v))
    : pressureUpperDefault;
}
export function getPressureUpper(): number {
  return pressureUpper;
}

// ---- smoothing --------------------------------------------------------------------------------

/** Weight of the newest sample in the exponential smoothing along a stroke (per point). */
export const penSmoothing = 0.3;

/** `s[0] = x[0]; s[i] = s[i-1] + 0.3 (x[i] - s[i-1])`. */
export function smoothed(x: number[], alpha: number = penSmoothing): number[] {
  const out = x.slice();
  if (x.length === 0) return out;
  let s = x[0];
  for (let i = 1; i < x.length; i++) {
    s += alpha * (x[i] - s);
    out[i] = s;
  }
  return out;
}

// ---- pointed nib ------------------------------------------------------------------------------

export const pointedBaseWidth = (weight: number): number => 0.04 + 0.02 * weight;
/** 0.15 (hairline) to 1.75 (full swell) for calibrated pressure q. */
export const pointedWidthFactor = (q: number): number => 0.15 + 1.6 * Math.min(1, Math.max(0, q));
export const pointedTaperLength = 0.12;
export const pointedTaperFloor = 0.3;

/**
 * The pointed nib's width in px at every point: `base * xh * (0.15 + 1.6 q)` smoothed along the
 * stroke, times the taper `0.3 + 0.7 min(1, s / L)` with s the arc length in x-heights from the
 * start and, for a finished stroke, also from the end; `L = min(0.12, total / 2)`.
 */
export function pointedWidths(
  xy: Array<[number, number]>,
  pressure: number[],
  xh: number,
  weight: number,
  upper: number = pressureUpperDefault,
  finished = true,
): number[] {
  if (xy.length === 0 || xy.length !== pressure.length) return [];
  const base = pointedBaseWidth(weight) * xh;
  const w = smoothed(pressure.map((p) => base * pointedWidthFactor(pressureCurve(p, upper))));
  const s = new Array<number>(xy.length).fill(0);
  for (let i = 1; i < xy.length; i++) {
    s[i] = s[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]) / xh;
  }
  const total = s[s.length - 1];
  const len = Math.min(pointedTaperLength, total / 2);
  const taper = (d: number) =>
    len > 0 ? pointedTaperFloor + (1 - pointedTaperFloor) * Math.min(1, d / len) : 1;
  return w.map((wi, i) => {
    let f = taper(s[i]);
    if (finished) f = Math.min(f, taper(total - s[i]));
    return wi * f;
  });
}

// ---- pencil -----------------------------------------------------------------------------------

/** Footprint minor axis in px: `max(0.8, (0.025 + 0.012 lead) xh)`. */
export const pencilBaseWidth = (lead: number, xh: number): number =>
  Math.max(0.8, (0.025 + 0.012 * lead) * xh);

/** How far the pencil leans, 0 (upright) to 1 (flat): `(1 - alt / (pi/2)) ^ 1.5`. */
export const pencilTilt = (alt: number): number =>
  Math.pow(1 - Math.min(Math.PI / 2, Math.max(0, alt)) / (Math.PI / 2), 1.5);

/** Footprint length along the azimuth: `base * (1 + 2.5 tilt)`. */
export const pencilMajor = (base: number, alt: number): number =>
  base * (1 + 2.5 * pencilTilt(alt));

/** Darkness of the graphite for calibrated pressure q: 0.25 ... 0.95. */
export const pencilOpacity = (q: number): number => 0.25 + 0.7 * Math.min(1, Math.max(0, q));

/** Spacing of stamps along the path as a fraction of the footprint's minor axis. */
export const pencilSpacing = 0.25;

export interface PencilSample {
  x: number;
  y: number;
  /** Raw pressure. */
  p: number;
  /** Altitude (radians; undefined = upright) and azimuth (view's y-down plane; undefined = 0). */
  alt?: number;
  az?: number;
}

export interface PencilStamp {
  x: number;
  y: number;
  major: number;
  minor: number;
  /** Direction of the major axis, radians (the azimuth). */
  angle: number;
  /** Opacity of this one stamp; overlapping stamps accumulate towards `pencilOpacity`. */
  alpha: number;
  /** The segment (point `seg` to `seg + 1`) the stamp sits on and how far along it (0-1). */
  seg: number;
  along: number;
}

/**
 * The graphite footprints along a stroke. Pressure and altitude are smoothed per point; the
 * azimuth is interpolated unsmoothed. Stamps sit every `max(0.4, 0.25 minor)` px of arc length
 * from the first point (which is always stamped, the distance carrying over between points), with
 * every attribute interpolated linearly. A stamp's alpha is `1 - (1 - A)^(1/n)`, `A` the darkness
 * and `n = max(1, extent / spacing)` how many stamps overlap along the direction of travel.
 */
export function pencilStamps(
  s: PencilSample[],
  lead: number,
  xh: number,
  upper: number = pressureUpperDefault,
): PencilStamp[] {
  if (s.length === 0) return [];
  const base = pencilBaseWidth(lead, xh);
  const q = smoothed(s.map((x) => pressureCurve(x.p, upper)));
  const alt = smoothed(s.map((x) => Math.min(Math.PI / 2, Math.max(0, x.alt ?? Math.PI / 2))));
  const spacing = Math.max(0.4, pencilSpacing * base);
  const stamp = (i: number, j: number, f: number, dir: number, seg: number): PencilStamp => {
    const mix = (a: number, b: number) => a + (b - a) * f;
    const qq = mix(q[i], q[j]), aa = mix(alt[i], alt[j]);
    const az = mix(s[i].az ?? 0, s[j].az ?? 0);
    const major = pencilMajor(base, aa);
    const phi = dir - az;
    const extent = Math.hypot(major * Math.cos(phi), base * Math.sin(phi));
    const n = Math.max(1, extent / spacing);
    const A = pencilOpacity(qq);
    return {
      x: mix(s[i].x, s[j].x),
      y: mix(s[i].y, s[j].y),
      major,
      minor: base,
      angle: az,
      alpha: 1 - Math.pow(1 - A, 1 / n),
      seg,
      along: f,
    };
  };
  if (s.length === 1) return [stamp(0, 0, 0, 0, 0)];
  const out: PencilStamp[] = [];
  let carry = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const dx = s[i + 1].x - s[i].x, dy = s[i + 1].y - s[i].y;
    const len = Math.hypot(dx, dy);
    const dir = len > 0 ? Math.atan2(dy, dx) : 0;
    if (i === 0 && out.length === 0) {
      out.push(stamp(0, 1, 0, dir, 0));
      carry = spacing;
    }
    if (!(len > 0)) continue;
    let at = carry;
    while (at <= len) {
      out.push(stamp(i, i + 1, at / len, dir, i));
      at += spacing;
    }
    carry = at - len;
  }
  return out;
}

/** Cells of the grain tile per side, and the cell's size in view units. */
export const grainCells = 128;
export const grainCellSize = 0.5;

/** The 32-bit hash of a grain cell, 0 <= h < 1. */
export function grainHash(x: number, y: number): number {
  let h = (Math.imul(x, 0x27D4EB2D) ^ Math.imul(y, 0x165667B1)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x85EBCA6B) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xC2B2AE35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** The paper grain of cell (ix, iy), 0..1, repeating every 128 cells. */
export function pencilGrain(ix: number, iy: number): number {
  const x = ((ix % grainCells) + grainCells) % grainCells;
  const y = ((iy % grainCells) + grainCells) % grainCells;
  return 0.65 * grainHash(x, y) + 0.35 * grainHash(1000 + (x >> 1), 1000 + (y >> 1));
}

/** How much graphite the paper lets through at grain value g. */
export const pencilGrainFactor = (g: number): number => Math.min(1, 0.35 + 0.9 * g);

/** The grain tile's alpha bytes, row-major, `grainCells` square. */
export function grainTileAlpha(): Uint8Array {
  const out = new Uint8Array(grainCells * grainCells);
  for (let y = 0; y < grainCells; y++) {
    for (let x = 0; x < grainCells; x++) {
      out[y * grainCells + x] = Math.round(pencilGrainFactor(pencilGrain(x, y)) * 255);
    }
  }
  return out;
}
