// Band geometry: where the guidelines sit for a given x-height, and the
// conversion between canvas pixels and the x-height units strokes are stored in.
//
// Strokes are stored relative to the baseline and measured in x-heights, so a
// change of size (or a rotation that changes the fitted size) rescales the
// ink instead of leaving it stranded off the guides.

/** Font proportions, in x-heights, measured from the reference font. */
export interface Proportions {
  /** Ascender height above the x-height line ("l" minus "x"). */
  asc: number;
  /** Descender depth below the baseline ("p"). */
  desc: number;
}

/** Fallback when a font cannot be measured. */
export const defaultProportions: Proportions = { asc: 1, desc: 1 };

/** Space above the ascender line and below the descender line, in x-heights. */
const pad = 0.35;
/** Left margin before the first letter, in x-heights. */
const marginLeft = 0.5;

export interface Band {
  /** x-height in CSS pixels. */
  xh: number;
  width: number;
  height: number;
  ascender: number;
  xline: number;
  baseline: number;
  descender: number;
  left: number;
}

export function band(xh: number, width: number, p: Proportions): Band {
  const ascender = pad * xh;
  const xline = ascender + p.asc * xh;
  const baseline = xline + xh;
  const descender = baseline + p.desc * xh;
  return {
    xh,
    width,
    height: Math.ceil(descender + pad * xh),
    ascender,
    xline,
    baseline,
    descender,
    left: marginLeft * xh,
  };
}

/** Canvas CSS pixels → stored units (x-heights from the left margin and baseline). */
export function toUnits(b: Band, x: number, y: number): [number, number] {
  return [(x - b.left) / b.xh, (y - b.baseline) / b.xh];
}

/** Stored units → canvas CSS pixels. */
export function toPixels(b: Band, u: number, v: number): [number, number] {
  return [b.left + u * b.xh, b.baseline + v * b.xh];
}
