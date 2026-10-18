// Replay of a checked attempt: the strokes written again with their real
// timing (pen-up gaps cut to at most `maxGap` seconds), as ink or as a heat
// line coloured by speed or by pressure. A port of the iPad's ReplayView. The
// timeline and the colours are pure; `Replay` draws on a canvas laid over the
// practice line and runs on requestAnimationFrame.

import { type Band, toPixels } from "./geometry.ts";
import { drawStroke, type Point, type Stroke } from "./ink.ts";

export type ReplayMode = "ink" | "speed" | "pressure";

/** The longest pause between strokes kept in a replay, seconds. */
export const maxGap = 0.8;

export interface Timed {
  stroke: Stroke;
  /** Seconds from the start of the replay to each point. */
  times: number[];
  /** x-heights per second at each point. */
  speeds: number[];
}

export interface Timeline {
  items: Timed[];
  duration: number;
  /** The 90th percentile speed: full red in the speed heat. */
  speedRef: number;
}

/** Speed at each point over a window of the neighbouring points. */
export function pointSpeeds(s: Stroke, times: number[]): number[] {
  const p = s.points;
  return p.map((_, i) => {
    const a = Math.max(0, i - 2), b = Math.min(p.length - 1, i + 2);
    const dt = times[b] - times[a];
    return dt > 0 ? Math.hypot(p[b].u - p[a].u, p[b].v - p[a].v) / dt : 0;
  });
}

/** Strokes `t` are ms; the first stroke's first point is time 0. Empty strokes are skipped. */
export function buildTimeline(all: Stroke[]): Timeline {
  const strokes = all.filter((s) => s.points.length > 0);
  if (strokes.length === 0) return { items: [], duration: 0, speedRef: 1 };
  const origin = strokes[0].points[0].t;
  const items: Timed[] = [];
  const speeds: number[] = [];
  let clock = 0, lastEnd = 0;
  for (const s of strokes) {
    const begin = (s.points[0].t - origin) / 1000;
    // The gap since the previous stroke ended is cut to maxGap.
    if (items.length) clock += Math.min(maxGap, Math.max(0, begin - lastEnd));
    const times = s.points.map((p) => clock + (p.t - s.points[0].t) / 1000);
    const sp = pointSpeeds(s, times);
    items.push({ stroke: s, times, speeds: sp });
    speeds.push(...sp.filter((x) => x > 0));
    clock = times[times.length - 1];
    lastEnd = (s.points[s.points.length - 1].t - origin) / 1000;
  }
  speeds.sort((a, b) => a - b);
  const ref = speeds.length
    ? speeds[Math.min(speeds.length - 1, Math.floor(speeds.length * 0.9))]
    : 1;
  return { items, duration: clock, speedRef: Math.max(0.5, ref) };
}

/** Strokes whose last point is written by `now` are finished (they are in time order). */
export function finishedCount(tl: Timeline, now: number): number {
  let n = 0;
  while (n < tl.items.length && tl.items[n].times[tl.items[n].times.length - 1] <= now) n++;
  return n;
}

/** The points of `t` written by `now`, plus one interpolated to the exact time. */
export function writtenPoints(t: Timed, now: number): Point[] {
  if (now < t.times[0]) return [];
  let n = t.times.findIndex((x) => x > now);
  if (n < 0) n = t.times.length;
  const pts = t.stroke.points.slice(0, n);
  if (n < t.times.length && n > 0) {
    const a = t.stroke.points[n - 1], b = t.stroke.points[n];
    const f = (now - t.times[n - 1]) / Math.max(1e-6, t.times[n] - t.times[n - 1]);
    pts.push({
      ...b,
      u: a.u + (b.u - a.u) * f,
      v: a.v + (b.v - a.v) * f,
      p: a.p + (b.p - a.p) * f,
    });
  }
  return pts;
}

/** Slow is blue, fast (or firm) is red: hue 0.62 down to 0 at saturation and brightness 0.85. */
export function heat(x: number): string {
  const hue = 0.62 * (1 - Math.min(1, Math.max(0, x)));
  const s = 0.85, v = 0.85;
  const f = (n: number) => {
    const k = (n + hue * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const c = (n: number) => Math.round(f(n) * 255);
  return `rgb(${c(5)}, ${c(3)}, ${c(1)})`;
}

/** Draw `pts`, the first points of `t`'s stroke, in the given mode. */
export function drawReplayStroke(
  ctx: CanvasRenderingContext2D,
  b: Band,
  tl: Timeline,
  t: Timed,
  pts: Point[],
  mode: ReplayMode,
  ink: string,
) {
  if (mode === "ink") {
    drawStroke(ctx, b, { ...t.stroke, points: pts }, ink);
    return;
  }
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2.5, b.xh * 0.09);
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = toPixels(b, pts[i - 1].u, pts[i - 1].v);
    const [bx, by] = toPixels(b, pts[i].u, pts[i].v);
    const x = mode === "speed"
      ? t.speeds[Math.min(i, t.speeds.length - 1)] / tl.speedRef
      : (pts[i].p + pts[i - 1].p) / 2;
    ctx.strokeStyle = heat(x);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }
  ctx.restore();
}

/** Plays a timeline on a canvas (sized in CSS pixels by the owner, ctx transform for the dpr). */
export class Replay {
  #canvas: HTMLCanvasElement;
  #tl: Timeline | null = null;
  #mode: ReplayMode = "ink";
  #speed = 1;
  #startedAt = 0;
  #frame = 0;
  #cache: HTMLCanvasElement | null = null;
  #cached = 0;
  #band: Band | null = null;
  #ink = "#14213d";
  /** Called when the replay ends or is stopped. */
  onEnd: () => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    canvas.hidden = true;
  }

  get playing(): boolean {
    return this.#tl !== null;
  }

  /** The band changed (a relayout): the cache of finished strokes no longer fits. */
  setBand(b: Band) {
    this.#band = b;
    this.#cache = null;
    this.#cached = 0;
  }

  start(strokes: Stroke[], mode: ReplayMode, speed: number, b: Band, ink: string) {
    this.stop(false);
    const tl = buildTimeline(strokes);
    if (tl.items.length === 0) return;
    this.#tl = tl;
    this.#mode = mode;
    this.#speed = speed;
    this.#band = b;
    this.#ink = ink;
    this.#cache = null;
    this.#cached = 0;
    this.#canvas.hidden = false;
    this.#startedAt = performance.now();
    this.#frame = requestAnimationFrame(this.#tick);
  }

  stop(notify = true) {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    const was = this.#tl !== null;
    this.#tl = null;
    this.#cache = null;
    this.#cached = 0;
    this.#canvas.hidden = true;
    const ctx = this.#canvas.getContext("2d");
    if (ctx) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
      ctx.restore();
    }
    if (was && notify) this.onEnd();
  }

  #tick = () => {
    const tl = this.#tl;
    if (!tl) return;
    const now = (performance.now() - this.#startedAt) / 1000 * this.#speed;
    if (now >= tl.duration + 0.5) {
      this.stop();
      return;
    }
    this.#draw(tl, now);
    this.#frame = requestAnimationFrame(this.#tick);
  };

  #draw(tl: Timeline, now: number) {
    const b = this.#band;
    const ctx = this.#canvas.getContext("2d");
    if (!b || !ctx) return;
    const finished = finishedCount(tl, now);
    // Finished strokes are drawn once into a bitmap; each frame then draws only the live stroke.
    if (!this.#cache || this.#cache.width !== this.#canvas.width) {
      this.#cache = document.createElement("canvas");
      this.#cache.width = this.#canvas.width;
      this.#cache.height = this.#canvas.height;
      this.#cached = 0;
    }
    if (finished > this.#cached) {
      const cctx = this.#cache.getContext("2d")!;
      const dpr = this.#canvas.width / b.width;
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (let i = this.#cached; i < finished; i++) {
        const t = tl.items[i];
        drawReplayStroke(cctx, b, tl, t, t.stroke.points, this.#mode, this.#ink);
      }
      this.#cached = finished;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    ctx.drawImage(this.#cache, 0, 0);
    ctx.restore();
    if (finished < tl.items.length) {
      const t = tl.items[finished];
      const pts = writtenPoints(t, now);
      if (pts.length) drawReplayStroke(ctx, b, tl, t, pts, this.#mode, this.#ink);
    }
    if (this.#mode !== "ink") this.#legend(ctx, b);
  }

  /** A small slow-to-fast / light-to-firm key in the corner. */
  #legend(ctx: CanvasRenderingContext2D, b: Band) {
    const w = 90, h = 6;
    const x = b.width - w - 10, y = b.height - 30;
    for (let i = 0; i < w; i++) {
      ctx.fillStyle = heat(i / w);
      ctx.fillRect(x + i, y + 12, 1, h);
    }
    ctx.fillStyle = "#4b5058";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(this.#mode === "speed" ? "slow → fast" : "light → firm", x, y);
  }
}
