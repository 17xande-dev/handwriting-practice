// One worksheet row: the model drawn on guides, and the practice line beneath
// it where the strokes are written.

import { type Band, band, type Proportions, toUnits } from "./geometry.ts";
import { drawGuides, type GuideColors } from "./guides.ts";
import { drawStroke, type Point, type Stroke } from "./ink.ts";
import { attachPen, type Sample } from "./pen.ts";
import type { Settings } from "./settings.ts";

export interface Theme {
  guides: GuideColors;
  modelInk: string;
  penInk: string;
}

/** What the reference font looks like, measured once it has loaded. */
export interface FontInfo {
  /** A CSS font-family list, e.g. `"Edu SA Beginner", cursive`. */
  family: string;
  /** x-height as a fraction of the font size. */
  xRatio: number;
  proportions: Proportions;
  /** Slope in degrees right of vertical, for the slant guides. */
  slant: number;
}

interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

function surface(canvas: HTMLCanvasElement): Surface {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2D context unavailable");
  return { canvas, ctx };
}

/**
 * Size a canvas for a band: the backing store at the device pixel ratio, so
 * ink stays sharp on Retina, and the CSS size to match it exactly. Pointer
 * positions are in CSS pixels and ink is drawn in backing pixels / dpr, so if
 * the two sizes ever disagreed the browser would stretch the drawing and the
 * ink would drift away from the Pencil across the line.
 */
function resize(s: Surface, b: Band) {
  const dpr = globalThis.devicePixelRatio || 1;
  s.canvas.width = Math.round(b.width * dpr);
  s.canvas.height = Math.round(b.height * dpr);
  s.canvas.style.width = `${b.width}px`;
  s.canvas.style.height = `${b.height}px`;
  s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export class Row {
  #el: HTMLElement;
  #text: string;
  #ref: Surface;
  #practice: Surface;
  /** Guides plus every committed stroke, so a frame is one blit plus the live stroke. */
  #base: Surface;
  #undo: HTMLButtonElement;
  #clear: HTMLButtonElement;

  #band: Band | null = null;
  #slant = 0;
  #strokes: Stroke[] = [];
  #live: Stroke | null = null;
  #predicted: Point[] = [];
  #frame = 0;

  #settings: () => Settings;
  #theme: Theme;

  constructor(el: HTMLElement, settings: () => Settings, theme: Theme) {
    this.#el = el;
    this.#settings = settings;
    this.#theme = theme;
    this.#text = el.querySelector(".model")?.textContent?.trim() ?? "";
    this.#ref = surface(el.querySelector(".reference canvas") as HTMLCanvasElement);
    this.#practice = surface(el.querySelector(".practice canvas") as HTMLCanvasElement);
    this.#base = surface(document.createElement("canvas"));
    this.#undo = el.querySelector('[data-action="undo"]') as HTMLButtonElement;
    this.#clear = el.querySelector('[data-action="clear"]') as HTMLButtonElement;

    this.#undo.addEventListener("click", () => {
      this.#strokes.pop();
      this.#changed();
    });
    this.#clear.addEventListener("click", () => {
      this.#strokes = [];
      this.#changed();
    });

    attachPen(this.#practice.canvas, {
      touchWrites: () => this.#settings().touchWrites,
      start: (s) => {
        this.#live = { pen: this.#settings().pen, points: [this.#point(s)] };
        this.#schedule();
      },
      move: (samples, predicted) => {
        if (!this.#live) return;
        for (const s of samples) this.#live.points.push(this.#point(s));
        this.#predicted = predicted.map((s) => this.#point(s));
        this.#schedule();
      },
      end: () => {
        if (!this.#live) return;
        this.#strokes.push(this.#live);
        this.#live = null;
        this.#predicted = [];
        this.#changed();
      },
    });
  }

  /**
   * Lay the row out for a given x-height and font. The x-height is reduced
   * for this row if the model would not otherwise fit the width, so a long
   * line on a narrow screen shrinks rather than running off the edge.
   */
  layout(xh: number, font: FontInfo) {
    // The practice line is the one that must be exact, so it sets the width.
    // The model band sits in the same grid column and is the same width.
    const width = this.#el.querySelector(".practice")!.clientWidth;
    if (width === 0) return;
    this.#slant = font.slant;

    const ctx = this.#ref.ctx;
    ctx.font = `${xh / font.xRatio}px ${font.family}`;
    const textWidth = ctx.measureText(this.#text).width;
    const trial = band(xh, width, font.proportions);
    const room = width - 2 * trial.left;
    const fitted = textWidth > room ? Math.max(12, xh * (room / textWidth)) : xh;

    const b = band(fitted, width, font.proportions);
    this.#band = b;
    for (const sel of [".reference", ".practice"]) {
      (this.#el.querySelector(sel) as HTMLElement).style.height = `${b.height}px`;
    }
    resize(this.#ref, b);
    resize(this.#practice, b);
    resize(this.#base, b);

    drawGuides(this.#ref.ctx, b, this.#theme.guides, this.#slant);
    this.#ref.ctx.font = `${fitted / font.xRatio}px ${font.family}`;
    this.#ref.ctx.fillStyle = this.#theme.modelInk;
    this.#ref.ctx.textBaseline = "alphabetic";
    this.#ref.ctx.fillText(this.#text, b.left, b.baseline);

    this.#rebuildBase();
    this.#draw();
  }

  #point(s: Sample): Point {
    const [u, v] = this.#band ? toUnits(this.#band, s.x, s.y) : [0, 0];
    const p: Point = { u, v, p: s.p, t: s.t };
    if (s.alt !== undefined) p.alt = s.alt;
    if (s.az !== undefined) p.az = s.az;
    return p;
  }

  #changed() {
    const n = this.#strokes.length;
    this.#undo.disabled = n === 0;
    this.#clear.disabled = n === 0;
    // Exposed for tests and the browser console; not used by the app itself.
    this.#practice.canvas.dataset.strokes = String(n);
    this.#rebuildBase();
    this.#draw();
  }

  #rebuildBase() {
    const b = this.#band;
    if (!b) return;
    const ctx = this.#base.ctx;
    ctx.clearRect(0, 0, b.width, b.height);
    drawGuides(ctx, b, this.#theme.guides, this.#slant);
    for (const s of this.#strokes) drawStroke(ctx, b, s, this.#theme.penInk);
  }

  #schedule() {
    if (!this.#frame) {
      this.#frame = requestAnimationFrame(() => {
        this.#frame = 0;
        this.#draw();
      });
    }
  }

  #draw() {
    const b = this.#band;
    if (!b) return;
    const ctx = this.#practice.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.#practice.canvas.width, this.#practice.canvas.height);
    ctx.drawImage(this.#base.canvas, 0, 0);
    ctx.restore();
    if (this.#live) {
      // Predicted samples extend the live stroke towards where the Pencil is
      // about to be, hiding a frame of latency. They are replaced by real
      // samples on the next event and never committed.
      const shown = this.#predicted.length
        ? { pen: this.#live.pen, points: [...this.#live.points, ...this.#predicted] }
        : this.#live;
      drawStroke(ctx, b, shown, this.#theme.penInk);
    }
  }
}
