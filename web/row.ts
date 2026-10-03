// One worksheet row: the model drawn on guides, and the practice line beneath
// it where the strokes are written.

import { type Band, band, toUnits } from "./geometry.ts";
import { drawGuides, type GuideColors } from "./guides.ts";
import { check, type CheckResult, colouredRuns, deviationColors, drawOverlay } from "./evaluate.ts";
import { drawStroke, type Point, type Stroke } from "./ink.ts";
import { type FontInfo, fontString } from "./measure.ts";
import { attachPen, type Sample } from "./pen.ts";
import type { Settings } from "./settings.ts";

export interface Theme {
  guides: GuideColors;
  modelInk: string;
  penInk: string;
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
  #check: HTMLButtonElement;
  #resultEl: HTMLElement;

  #band: Band | null = null;
  #font: FontInfo | null = null;
  #slant = 0;
  /** The last check, while it still describes what's on the line. */
  #result: CheckResult | null = null;
  #showResult = true;
  /** Called after this row is checked or its check is cleared. */
  onResult: () => void = () => {};
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
    this.#check = el.querySelector('[data-action="check"]') as HTMLButtonElement;
    this.#resultEl = el.querySelector(".check-result") as HTMLElement;
    this.#check.addEventListener("click", () => this.check());

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
    // A different model makes a check meaningless; a new size or width
    // doesn't, since strokes and results are in x-height units.
    if (
      this.#font && (this.#font.family !== font.family || this.#font.style !== font.style ||
        this.#font.slant !== font.slant)
    ) {
      this.#clearResult();
    }
    this.#font = font;
    this.#slant = font.slant;

    const ctx = this.#ref.ctx;
    ctx.font = fontString(font, xh / font.xRatio);
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
    this.#ref.ctx.font = fontString(font, fitted / font.xRatio);
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

  /** The line's text, its score if checked, for the sheet summary. */
  get text(): string {
    return this.#text;
  }
  get result(): CheckResult | null {
    return this.#result;
  }
  get hasInk(): boolean {
    return this.#strokes.length > 0;
  }

  /** For browser tests only (#debug): replace the line's writing. */
  debugWrite(make: (text: string, font: FontInfo) => Stroke[]) {
    if (!this.#font) return;
    this.#strokes = make(this.#text, this.#font);
    this.#changed();
  }

  /** Compare what's written with the model, and show where it strays. */
  check(): CheckResult | null {
    if (!this.#font || this.#strokes.length === 0) return null;
    this.#result = check(this.#text, this.#font, this.#strokes);
    this.#showResult = true;
    this.#renderResult();
    this.#rebuildBase();
    this.#draw();
    this.onResult();
    return this.#result;
  }

  #clearResult() {
    if (!this.#result) return;
    this.#result = null;
    this.#renderResult();
    this.onResult();
  }

  /** The strip under the line: a chip per letter, the score, and notes. */
  #renderResult() {
    const r = this.#result;
    const el = this.#resultEl;
    this.#check.textContent = r ? "Check again" : "Check";
    el.replaceChildren();
    el.hidden = !r;
    if (!r) return;

    const head = document.createElement("div");
    head.className = "result-head";
    const score = document.createElement("strong");
    score.className = `result-score ${scoreClass(r.score)}`;
    score.textContent = `${r.score}%`;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "result-toggle";
    toggle.textContent = this.#showResult ? "Hide results" : "Show results";
    toggle.addEventListener("click", () => {
      this.#showResult = !this.#showResult;
      toggle.textContent = this.#showResult ? "Hide results" : "Show results";
      this.#rebuildBase();
      this.#draw();
    });
    head.append(score, toggle);

    const letters = document.createElement("ol");
    letters.className = "result-letters";
    for (const l of r.letters) {
      const li = document.createElement("li");
      li.className = `letter ${l.missing ? "missing" : scoreClass(l.score)}`;
      const ch = document.createElement("span");
      ch.className = "letter-char";
      ch.textContent = l.char;
      const sc = document.createElement("span");
      sc.className = "letter-score";
      sc.textContent = l.missing ? "missing" : `${l.score}`;
      li.append(ch, sc);
      letters.append(li);
    }

    el.append(head, letters);
    if (r.notes.length) {
      const notes = document.createElement("ul");
      notes.className = "result-notes";
      for (const n of r.notes) {
        const li = document.createElement("li");
        li.textContent = n;
        notes.append(li);
      }
      el.append(notes);
    }
  }

  #changed() {
    const n = this.#strokes.length;
    this.#undo.disabled = n === 0;
    this.#clear.disabled = n === 0;
    this.#check.disabled = n === 0;
    // Anything written, undone or cleared makes the last check stale.
    this.#clearResult();
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
    const r = this.#showResult ? this.#result : null;
    if (!r) {
      for (const s of this.#strokes) drawStroke(ctx, b, s, this.#theme.penInk);
      return;
    }
    // Results view: the model as a ghost under the writing, then the
    // writing coloured by how far each part is from the model.
    drawOverlay(ctx, b, r);
    this.#strokes.forEach((s, i) => {
      for (const run of colouredRuns(s, r.pointClass[i])) {
        drawStroke(ctx, b, run.stroke, deviationColors[run.cls]);
      }
    });
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

/** A score's colour band, as a class name. */
function scoreClass(score: number): string {
  return score >= 85 ? "good" : score >= 65 ? "fair" : "poor";
}
