// Measuring a model font from its own glyphs, so the guides fit whichever
// font is chosen rather than assuming one.

import { defaultProportions, type Proportions } from "./geometry.ts";

/** What the reference font looks like, measured once it has loaded. */
export interface FontInfo {
  /** A CSS font-family list, e.g. `"Edu SA Beginner", cursive`. */
  family: string;
  /** CSS font-style: "normal" or "italic". */
  style: string;
  /** x-height as a fraction of the font size. */
  xRatio: number;
  proportions: Proportions;
  /** Slope in degrees right of vertical, for the slant guides. */
  slant: number;
}

/** A CSS font shorthand for canvas: style, size, family. */
export function fontString(f: { style: string; family: string }, px: number): string {
  return `${f.style} ${px}px ${f.family}`;
}

/** Alpha above which a pixel counts as ink when finding a glyph's extent. */
const inkAlpha = 127;

/**
 * Where a glyph's ink starts and ends vertically, in pixels above the
 * baseline (positive up; a descender's bottom is negative). Found by drawing
 * it large and scanning for inked rows, not by actualBoundingBox*, which
 * Chromium quantises to 1/64 em (3% of an x-height). At this size the
 * anti-aliasing half-pixel is 0.05% of an em.
 */
function inkExtent(font: string, ch: string, size: number): { top: number; bottom: number } | null {
  const w = Math.round(size * 1.6), h = Math.round(size * 2), baseline = Math.round(size * 1.3);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(ch, Math.round(size * 0.3), baseline);
  const data = ctx.getImageData(0, 0, w, h).data;
  const rowInked = (y: number) => {
    for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > inkAlpha) return true;
    return false;
  };
  let first = -1, last = -1;
  for (let y = 0; y < h; y++) {
    if (rowInked(y)) {
      first = y;
      break;
    }
  }
  if (first < 0) return null;
  for (let y = h - 1; y >= first; y--) {
    if (rowInked(y)) {
      last = y;
      break;
    }
  }
  // Row y covers [y, y+1): the glyph reaches up to the top edge of the first
  // inked row and down to the bottom edge of the last.
  return { top: baseline - first, bottom: baseline - (last + 1) };
}

export function measureFont(family: string, style: string, slant: number): FontInfo {
  // Large, because only the proportions leave this function and the scan is
  // exact to a pixel: the x-height must match the outline bounds CoreText
  // gives the iPad, or web models render a percent or two short of the line.
  const size = 1000;
  const font = fontString({ style, family }, size);
  const x = inkExtent(font, "x", size)?.top ?? 0;
  if (!(x > 0)) return { family, style, xRatio: 0.5, proportions: defaultProportions, slant };
  const asc = inkExtent(font, "l", size)?.top ?? x;
  const desc = -(inkExtent(font, "p", size)?.bottom ?? 0);
  // Rounded so that guides don't shift by a hair between fonts that are
  // meant to share proportions.
  const round = (n: number) => Math.min(1.6, Math.max(0.5, Math.round(n * 20) / 20));
  return {
    family,
    style,
    xRatio: x / size,
    proportions: { asc: round((asc - x) / x), desc: round(desc / x) },
    slant,
  };
}

/** A measured slope, and whether the letters agreed on it. */
export interface Slant {
  degrees: number;
  reliable: boolean;
}

/** Slants a handwriting model plausibly has: some hands lean backwards. */
export const minSlant = -20;
export const maxSlant = 30;

/**
 * Measure how far a font slopes, in degrees right of vertical, from the
 * ascender stems of l, h, k, b and d. Between the top of the letter and the
 * x-height each of those is a single stroke, so on every pixel row there is
 * one run of ink. Its centre is taken on each row and a straight line fitted
 * through them; the answer is the median over the letters. Rows with more
 * than one run (a looped ascender) are skipped, and a letter without enough
 * clean rows doesn't vote.
 *
 * It is unreliable when fewer than two letters could be measured or they
 * disagree by more than a few degrees, as with looped script fonts.
 *
 * Only fonts picked by name use this. The catalogue's slants are chosen,
 * not measured: Edu SA measures 6°, but Getty-Dubay italic is written at 5°.
 */
export function measureSlant(family: string, style: string): Slant {
  const votes: number[] = [];
  for (const ch of "lhkbd") {
    const v = stemSlant(family, style, ch);
    if (v !== null) votes.push(v);
  }
  if (votes.length === 0) return { degrees: 0, reliable: false };
  votes.sort((a, b) => a - b);
  const mid = votes.length >> 1;
  const median = votes.length % 2 ? votes[mid] : (votes[mid - 1] + votes[mid]) / 2;
  // Half-degree steps, clamped to the slider's range.
  const degrees = Math.min(maxSlant, Math.max(minSlant, Math.round(median * 2) / 2));
  const reliable = votes.length >= 2 && votes[votes.length - 1] - votes[0] <= 6;
  return { degrees, reliable };
}

function stemSlant(family: string, style: string, ch: string): number | null {
  const size = 200, w = 500, h = 500, baseline = 380;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.font = fontString({ style, family }, size);
  const xHeight = ctx.measureText("x").actualBoundingBoxAscent;
  const top = baseline - ctx.measureText(ch).actualBoundingBoxAscent;
  const xline = baseline - xHeight;
  if (!(xHeight > 0) || xline - top < 0.4 * xHeight) return null; // no real ascender
  ctx.fillText(ch, 180, baseline);
  const data = ctx.getImageData(0, 0, w, h).data;

  const ys: number[] = [], xs: number[] = [];
  // The ascender, clear of the very tip and of where the bowl or arch starts.
  const from = Math.round(top + (xline - top) * 0.15);
  const to = Math.round(xline - (xline - top) * 0.1);
  for (let y = Math.max(0, from); y <= Math.min(h - 1, to); y++) {
    let runs = 0, sum = 0, n = 0, inRun = false;
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 128) {
        sum += x;
        n++;
        if (!inRun) runs++;
        inRun = true;
      } else {
        inRun = false;
      }
    }
    if (runs === 1) {
      ys.push(y);
      xs.push(sum / n);
    }
  }
  if (ys.length < 8) return null;
  const my = ys.reduce((a, b) => a + b) / ys.length;
  const mx = xs.reduce((a, b) => a + b) / xs.length;
  let num = 0, den = 0;
  for (let i = 0; i < ys.length; i++) {
    num += (ys[i] - my) * (xs[i] - mx);
    den += (ys[i] - my) ** 2;
  }
  // Canvas y grows downwards, so a stem leaning right has x falling as y rises.
  return (Math.atan(-num / den) * 180) / Math.PI;
}
