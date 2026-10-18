// M5 metrics, part 2: pen control and fluency, from the strokes alone
// (pressure, angles, timestamps), plus the model's piece count for pen lifts
// (informational). A port of the iPad app's PenMetrics.swift; see its
// docs/metrics.md. Pressure metrics stay scale-free: no absolute pressure threshold.

import { median } from "./evalcore.ts";
import type { Stroke } from "./ink.ts";
import { avg, circularStats, sdev, wrap } from "./metrics.ts";

export interface PenMetrics {
  /** Mean and CV of pressure over the steady points; NaN unless pressure varies. */
  pressureMean: number;
  pressureCV: number;
  /** Mean pressure of downstroke segments / of upstroke segments. */
  pressureContrast: number;
  /** Edged pens whose nib follows the roll: mean effective nib angle in (-90, 90], target, mean deviation, circular SD (degrees). */
  nibMean: number;
  nibTarget: number;
  nibDev: number;
  nibSD: number;
  /** Pen altitude above the page, mean and SD, degrees. */
  altMean: number;
  altSD: number;
  /** Circular SD of the azimuth, degrees. */
  azimuthSD: number;
}

export interface FluencyMetrics {
  speedMedian: number;
  speedCV: number;
  hesitations: number;
  pauses: number;
  slowRuns: number;
  /** Pen-downs per written letter, and the model's skeleton pieces per letter. Informational only. */
  liftsPerLetter: number;
  modelLiftsPerLetter: number;
  lettersPerMinute: number;
  activeMs: number;
}

const degrees = 180 / Math.PI;
/** Share of points that must carry a value for a pen-hold statistic to count. */
const minAvailable = 0.5;
/** Fewest points with a roll (nib statistics) or an azimuth (azimuthSD) for the statistic to count. */
export const minNibPoints = 5;
/** Pressure counts only if it varies at least this much (touch input reports a constant). */
export const pressureMinRange = 0.02;
/** First and last milliseconds of a stroke left out of the pressure mean and CV. */
export const pressureRampMs = 30;

/** The nib angle in radians: the configured angle plus the barrel roll since the reference, projected by altitude. */
function nibAngle(baseDegrees: number, roll: number, ref: number, altitude: number): number {
  const base = baseDegrees * Math.PI / 180;
  const d = wrap(roll - ref);
  // rollToNibSign = +1 (verified on a real Pencil Pro).
  return base + Math.atan2(Math.sin(d) * Math.sin(altitude), Math.cos(d));
}

const finite = (x: number | undefined): x is number => typeof x === "number" && Number.isFinite(x);

export function penMetrics(strokes: Stroke[]): PenMetrics {
  const pts = strokes.flatMap((s) => s.points);

  // Pressure: the force ramps at pen-down and pen-up, so statistics use the steady points.
  let pressureMean = NaN, pressureCV = NaN, pressureContrast = NaN;
  if (pts.length) {
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) {
      lo = Math.min(lo, p.p);
      hi = Math.max(hi, p.p);
    }
    if (hi - lo >= pressureMinRange) {
      const steady: number[] = [];
      for (const s of strokes) {
        if (s.points.length === 0) continue;
        const t0 = s.points[0].t, t1 = s.points[s.points.length - 1].t;
        for (const p of s.points) {
          if (p.t - t0 >= pressureRampMs && t1 - p.t >= pressureRampMs) steady.push(p.p);
        }
      }
      pressureMean = avg(steady);
      pressureCV = pressureMean > 0 ? sdev(steady, 5) / pressureMean : NaN;
      const down: number[] = [], up: number[] = [];
      for (const s of strokes) {
        for (let i = 0; i < s.points.length - 1; i++) {
          const a = s.points[i], b = s.points[i + 1];
          const len = Math.hypot(b.u - a.u, b.v - a.v), dy = b.v - a.v;
          if (len === 0) continue;
          if (dy > 0.5 * len) down.push((a.p + b.p) / 2);
          else if (dy < -0.5 * len) up.push((a.p + b.p) / 2);
        }
      }
      if (down.length >= 5 && up.length >= 5 && avg(up) > 0.001) {
        pressureContrast = avg(down) / avg(up);
      }
    }
  }

  // Nib angle: edged pens whose nib follows the roll only (a fixed angle is a setting).
  const devs: number[] = [], nibs: number[] = [], targets: number[] = [];
  for (const s of strokes) {
    if (s.pen.kind !== "edged" || s.followsRoll !== true) continue;
    const ref = s.rollRef ?? s.points[0]?.roll;
    if (!finite(ref)) continue;
    for (const p of s.points) {
      if (!finite(p.roll)) continue;
      const a = nibAngle(s.pen.angle, p.roll, ref, finite(p.alt) ? p.alt : Math.PI / 2);
      nibs.push(a);
      devs.push(a - s.pen.angle / degrees);
      targets.push(s.pen.angle);
    }
  }
  let nibMean = NaN, nibDev = NaN, nibSD = NaN, nibTarget = NaN;
  if (nibs.length >= minNibPoints) {
    nibMean = circularStats(nibs, Math.PI).mean * degrees;
    const d = circularStats(devs, Math.PI);
    nibDev = d.mean * degrees;
    nibSD = d.sd * degrees;
    nibTarget = avg(targets);
  }

  // Pen hold.
  const alts = pts.map((p) => p.alt).filter(finite), azs = pts.map((p) => p.az).filter(finite);
  let altMean = NaN, altSD = NaN, azimuthSD = NaN;
  if (pts.length && alts.length >= minAvailable * pts.length) {
    altMean = avg(alts) * degrees;
    altSD = sdev(alts, 5) * degrees;
  }
  if (azs.length >= minNibPoints && azs.length >= minAvailable * pts.length) {
    azimuthSD = circularStats(azs, 2 * Math.PI).sd * degrees;
  }
  return {
    pressureMean,
    pressureCV,
    pressureContrast,
    nibMean,
    nibTarget,
    nibDev,
    nibSD,
    altMean,
    altSD,
    azimuthSD,
  };
}

/** Window length for one speed sample, ms. */
export const speedWindowMs = 20;
export const pauseMs = 150;
export const pauseMove = 0.02;
export const slowFraction = 0.25;
export const slowMs = 100;

interface SpeedWindow {
  t0: number;
  t1: number;
  len: number;
  first: boolean;
  last: boolean;
}

const speedOf = (w: SpeedWindow) => w.len / ((w.t1 - w.t0) / 1000);

/** `pieces`: the model skeleton's pieces over the written letters; `letters`: how many were written. */
export function fluencyMetrics(strokes: Stroke[], letters: number, pieces: number): FluencyMetrics {
  // Speed windows: runs of consecutive segments of one stroke, closed once they span >= 20 ms.
  const windows: SpeedWindow[] = [];
  let active = 0;
  for (const s of strokes) {
    const p = s.points;
    if (p.length < 2) continue;
    active += Math.max(0, p[p.length - 1].t - p[0].t);
    const made: SpeedWindow[] = [];
    let i = 0, len = 0;
    for (let j = 1; j < p.length; j++) {
      len += Math.hypot(p[j].u - p[j - 1].u, p[j].v - p[j - 1].v);
      if (p[j].t - p[i].t >= speedWindowMs) {
        made.push({ t0: p[i].t, t1: p[j].t, len, first: made.length === 0, last: false });
        i = j;
        len = 0;
      }
    }
    if (made.length === 0 && p[p.length - 1].t > p[0].t) {
      made.push({ t0: p[0].t, t1: p[p.length - 1].t, len, first: true, last: true });
    }
    if (made.length) made[made.length - 1].last = true;
    windows.push(...made);
  }
  const speeds = windows.map(speedOf);
  const med = median(speeds);
  // speedCV leaves out each stroke's first and last window.
  const inner = windows.filter((w) => !w.first && !w.last).map(speedOf);
  const speedCV = inner.length >= 5 ? sdev(inner, 5) / avg(inner) : NaN;

  // Pauses: inside a stroke, the pen stays within 0.02 x-height of where a run began for > 150 ms.
  const pauseSpans: Array<[number, number]> = [];
  for (const s of strokes) {
    const p = s.points, n = p.length;
    let i = 0;
    while (i < n - 1) {
      let j = i;
      while (j + 1 < n && Math.hypot(p[j + 1].u - p[i].u, p[j + 1].v - p[i].v) < pauseMove) j++;
      if (i > 0 && j < n - 1 && p[j].t - p[i].t > pauseMs) pauseSpans.push([p[i].t, p[j].t]);
      i = j > i ? j : i + 1;
    }
  }

  // Slow runs: consecutive interior windows of one stroke under 25% of the median speed, > 100 ms
  // in all, that do not overlap a pause.
  let slow = 0;
  if (speeds.length >= 5 && med > 0) {
    let run: SpeedWindow[] = [];
    const close = () => {
      const a = run[0], b = run[run.length - 1];
      if (a && b && b.t1 - a.t0 > slowMs && !pauseSpans.some(([s, e]) => s < b.t1 && e > a.t0)) {
        slow++;
      }
      run = [];
    };
    for (const w of windows) {
      if (w.first && run.length) close();
      if (!w.first && !w.last && speedOf(w) < slowFraction * med) {
        const l = run[run.length - 1];
        if (l && l.t1 !== w.t0) close();
        run.push(w);
      } else {
        close();
      }
    }
    close();
  }

  return {
    speedMedian: med,
    speedCV,
    hesitations: pauseSpans.length + slow,
    pauses: pauseSpans.length,
    slowRuns: slow,
    liftsPerLetter: letters > 0 ? strokes.length / letters : NaN,
    modelLiftsPerLetter: letters > 0 ? pieces / letters : NaN,
    lettersPerMinute: active >= 1000 && letters > 0 ? letters / (active / 60000) : NaN,
    activeMs: active,
  };
}
