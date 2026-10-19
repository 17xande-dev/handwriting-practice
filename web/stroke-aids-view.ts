// Drawing the teaching aids (stroke-aids.ts has the geometry): on the model line, numbered start dots
// and direction arrows, and the animated demo (a letter by a tap, the line by Play); on the practice
// line, the optional trace-first guide. Two canvases laid over the row's bands; nothing here judges.
// Colours are set on the canvas context (the CSP allows that), never in markup.

import { type Band } from "./geometry.ts";
import type { Stroke } from "./ink.ts";
import {
  arrowAt,
  demoSettings,
  DemoTimeline,
  letterAt,
  type LineStroke,
  lineStrokes,
  type PlacedLetter,
  placeLetters,
  traceProgress,
} from "./stroke-aids.ts";
import type { Pt, StrokeLookup } from "./stroke-order.ts";

export interface AidColors {
  /** Start dots, numbers and arrows. */
  aid: string;
  /** The demo pen's ink. */
  demo: string;
  /** The trace-first guide. */
  guide: string;
  paper: string;
}

function sized(c: HTMLCanvasElement, b: Band): CanvasRenderingContext2D {
  const dpr = globalThis.devicePixelRatio || 1;
  c.width = Math.round(b.width * dpr);
  c.height = Math.round(b.height * dpr);
  c.style.width = `${b.width}px`;
  c.style.height = `${b.height}px`;
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export class StrokeAidsView {
  #aids: HTMLCanvasElement;
  #guide: HTMLCanvasElement;
  #colors: AidColors;
  #band: Band | null = null;
  #tan = 0;
  #text = "";
  #starts: number[] = [];
  #lookup: StrokeLookup | null = null;
  #letters: PlacedLetter[] = [];
  #line: LineStroke[] = [];
  #show = false;
  #trace = false;
  #written: Pt[][] = [];
  #timeline: DemoTimeline | null = null;
  #startedAt = 0;
  #raf = 0;
  /** A demo started or ended (the Play button follows). */
  onPlaying: (playing: boolean) => void = () => {};

  constructor(reference: HTMLElement, practice: HTMLElement, colors: AidColors) {
    this.#colors = colors;
    this.#aids = document.createElement("canvas");
    this.#aids.className = "aids";
    this.#aids.setAttribute("aria-hidden", "true");
    reference.append(this.#aids);
    this.#guide = document.createElement("canvas");
    this.#guide.className = "guide";
    this.#guide.setAttribute("aria-hidden", "true");
    practice.append(this.#guide);
    // A tap on a model letter plays that letter (only while the aids are on).
    this.#aids.addEventListener("click", (e) => {
      const b = this.#band;
      if (!b || !this.#show) return;
      const r = this.#aids.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      // The model is sheared: undo the shear at the tap's height.
      const u = (x - b.left) / b.xh + this.#tan * ((y - b.baseline) / b.xh);
      const i = letterAt(this.#letters, u);
      if (i !== null) this.play(i);
    });
  }

  /** Whether the model has strokes for any letter of the line. */
  get available(): boolean {
    return this.#letters.length > 0;
  }

  get playing(): boolean {
    return this.#timeline !== null;
  }

  /** `starts`: x-height position of each code point's advance start, and of the line's end. */
  layout(b: Band, slant: number, text: string, starts: number[]) {
    this.stop();
    this.#band = b;
    this.#tan = Math.tan((slant * Math.PI) / 180);
    this.#text = text;
    this.#starts = starts;
    sized(this.#aids, b);
    sized(this.#guide, b);
    this.#place();
    this.#redraw();
  }

  setLookup(l: StrokeLookup | null) {
    this.#lookup = l;
    this.#place();
    this.#redraw();
  }

  setShow(on: boolean) {
    this.#show = on;
    this.#aids.classList.toggle("live", on);
    if (!on) this.stop();
    this.#redraw();
  }

  setTrace(on: boolean) {
    this.#trace = on;
    this.#redraw();
  }

  /** The writer's strokes so far (for the trace-first guide). */
  setWritten(strokes: Stroke[]) {
    this.#written = strokes.map((s) => s.points.map((p) => ({ u: p.u + p.v * this.#tan, v: p.v })));
    if (this.#trace) this.#drawGuide();
  }

  #place() {
    this.#letters = this.#lookup ? placeLetters(this.#text, this.#starts, this.#lookup) : [];
    this.#line = lineStrokes(this.#letters);
  }

  /** The model letter with this code point index, if it has strokes. */
  letterOfIndex(index: number): number | null {
    const i = this.#letters.findIndex((l) => l.index === index);
    return i < 0 ? null : i;
  }

  /** Play the whole line, or one placed letter. */
  play(letter: number | null = null) {
    if (!this.#band || this.#line.length === 0) return;
    this.stop();
    this.#timeline = DemoTimeline.ofLine(this.#line, letter, demoSettings(2));
    this.#startedAt = performance.now();
    this.onPlaying(true);
    const step = (now: number) => {
      const tl = this.#timeline;
      if (!tl) return;
      const t = (now - this.#startedAt) / 1000;
      this.#drawDemo(tl, t);
      if (t > tl.duration + 0.6) {
        this.stop();
        return;
      }
      this.#raf = requestAnimationFrame(step);
    };
    this.#raf = requestAnimationFrame(step);
  }

  stop() {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    if (this.#timeline) {
      this.#timeline = null;
      this.onPlaying(false);
      this.#redraw();
    }
  }

  // ---- drawing ---------------------------------------------------------------------------

  #xy(p: Pt): [number, number] {
    const b = this.#band!;
    return [b.left + (p.u - this.#tan * p.v) * b.xh, b.baseline + p.v * b.xh];
  }

  #path(ctx: CanvasRenderingContext2D, pts: Pt[]) {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const [x, y] = this.#xy(p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
  }

  #clear(c: HTMLCanvasElement) {
    const ctx = c.getContext("2d")!;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.restore();
    return ctx;
  }

  #redraw() {
    if (!this.#band) return;
    if (this.#timeline) return;
    const ctx = this.#clear(this.#aids);
    if (this.#show) this.#drawAids(ctx);
    this.#drawGuide();
  }

  /** Numbered start dots (hollow for an unverified glyph), an arrow 60% along each stroke, dashes when unverified. */
  #drawAids(ctx: CanvasRenderingContext2D) {
    const b = this.#band!;
    const r = Math.max(7, 0.2 * b.xh);
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const s of this.#line) {
      const verified = this.#letters[s.letter].glyph.verified;
      ctx.strokeStyle = this.#colors.aid;
      ctx.fillStyle = this.#colors.aid;
      ctx.globalAlpha = 0.55;
      if (!s.isDot && s.pts.length > 1) {
        ctx.lineWidth = Math.max(2, 0.07 * b.xh);
        ctx.setLineDash(verified ? [] : [6, 5]);
        this.#path(ctx, s.pts);
        ctx.stroke();
        ctx.setLineDash([]);
        const a = arrowAt(s.pts, 0.6);
        if (a) {
          const [ax, ay] = this.#xy(a.at);
          // The direction on screen: the shear applies to the direction too.
          let dx = a.dir.u - this.#tan * a.dir.v, dy = a.dir.v;
          const l = Math.hypot(dx, dy) || 1;
          dx /= l;
          dy /= l;
          const h = Math.max(6, 0.18 * b.xh);
          ctx.globalAlpha = 0.95;
          ctx.beginPath();
          ctx.moveTo(ax + dx * h, ay + dy * h);
          ctx.lineTo(ax - dx * h * 0.6 - dy * h * 0.7, ay - dy * h * 0.6 + dx * h * 0.7);
          ctx.lineTo(ax - dx * h * 0.6 + dy * h * 0.7, ay - dy * h * 0.6 - dx * h * 0.7);
          ctx.closePath();
          ctx.fill();
        }
      }
      const [sx, sy] = this.#xy(s.pts[0]);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      if (verified) {
        ctx.fillStyle = this.#colors.aid;
        ctx.fill();
        ctx.fillStyle = this.#colors.paper;
      } else {
        ctx.fillStyle = this.#colors.paper;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.fillStyle = this.#colors.aid;
      }
      ctx.font = `600 ${Math.round(r * 1.25)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(s.number + 1), sx, sy + 0.5);
    }
    ctx.restore();
  }

  /** The pen drawing the strokes in order: finished ones whole, the active one so far, the tip. */
  #drawDemo(tl: DemoTimeline, t: number) {
    const b = this.#band!;
    const ctx = this.#clear(this.#aids);
    if (this.#show) this.#drawAids(ctx);
    const f = tl.frame(t);
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = this.#colors.demo;
    ctx.fillStyle = this.#colors.demo;
    ctx.lineWidth = Math.max(3, 0.11 * b.xh);
    const draw = (item: number, pts: Pt[]) => {
      if (tl.items[item].isDot) {
        for (const p of pts) {
          const [x, y] = this.#xy(p);
          ctx.beginPath();
          ctx.arc(x, y, Math.max(3, 0.1 * b.xh), 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (pts.length > 1) {
        this.#path(ctx, pts);
        ctx.stroke();
      }
    };
    for (const i of f.finished) draw(i, tl.items[i].pts);
    if (f.active !== null) draw(f.active, f.partial);
    if (f.tip && f.active !== null && !tl.items[f.active].isDot) {
      const [x, y] = this.#xy(f.tip);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(5, 0.16 * b.xh), 0, Math.PI * 2);
      ctx.globalAlpha = 0.5;
      ctx.fill();
    }
    ctx.restore();
  }

  /** Trace first: the strokes not yet written, faint; the next one clear. */
  #drawGuide() {
    if (!this.#band) return;
    const ctx = this.#clear(this.#guide);
    if (!this.#trace || this.#line.length === 0) return;
    const b = this.#band;
    const progress = traceProgress(this.#line, this.#written);
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = this.#colors.guide;
    ctx.fillStyle = this.#colors.guide;
    ctx.lineWidth = Math.max(3, 0.1 * b.xh);
    this.#line.forEach((s, i) => {
      if (progress.done.has(i)) return;
      const next = i === progress.next;
      ctx.globalAlpha = next ? 0.75 : 0.25;
      if (s.isDot) {
        const [x, y] = this.#xy(s.pts[0]);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(3, 0.1 * b.xh), 0, Math.PI * 2);
        ctx.fill();
      } else {
        this.#path(ctx, s.pts);
        ctx.stroke();
      }
      if (next) {
        const [x, y] = this.#xy(s.pts[0]);
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(5, 0.16 * b.xh), 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.restore();
  }
}
