// One worksheet row: the model drawn on guides, and the practice line beneath
// it where the strokes are written.

import { type Band, band, toUnits } from "./geometry.ts";
import { drawGuides, type GuideColors } from "./guides.ts";
import { check, type CheckResult, colouredRuns, deviationColors, drawOverlay } from "./evaluate.ts";
import { renderPanel, scoreClass, subScoreLine } from "./details.ts";
import { legacyPenKind, type LineMetrics, lineMetrics } from "./metric-scores.ts";
import { Replay, type ReplayMode } from "./replay.ts";
import { drawWorstSegment } from "./worst.ts";
import { drawStroke, drawStrokeClasses, drawsWhole, type Point, type Stroke } from "./ink.ts";
import { type FontInfo, fontString } from "./measure.ts";
import type { History } from "./history.ts";
import { attachPen, type Sample } from "./pen.ts";
import { eraserTolerance, strokesHit, type UV } from "./eraser.ts";
import type { Settings } from "./settings.ts";
import { fingerprint, type Recorded } from "./stroke-store.ts";
import { type AidColors, StrokeAidsView } from "./stroke-aids-view.ts";
import {
  flagSymbol,
  flagTitle,
  letterFlags,
  pairOrderLetters,
  type StrokeLookup,
} from "./stroke-order.ts";

export interface Theme {
  guides: GuideColors;
  modelInk: string;
  penInk: string;
  aids: AidColors;
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

/** Rows on the page, so each one's replay radio buttons get their own group name. */
let rowCount = 0;

export class Row {
  #id = ++rowCount;
  #el: HTMLElement;
  #text: string;
  #ref: Surface;
  #practice: Surface;
  /** Guides plus every committed stroke, so a frame is one blit plus the live stroke. */
  #base: Surface;
  #clear: HTMLButtonElement;
  #check: HTMLButtonElement;
  #resultEl: HTMLElement;

  #band: Band | null = null;
  #font: FontInfo | null = null;
  #slant = 0;
  /** The last check, while it still describes what's on the line. */
  #result: CheckResult | null = null;
  /** The last check's metrics, with the result. */
  #metrics: LineMetrics | null = null;
  #showResult = true;
  /** The Details panel is open. */
  #details = false;
  #replay: Replay;
  /** Start dots, arrows, the demo and the trace-first guide (stroke order's teaching aids). */
  #aidsView: StrokeAidsView;
  #play: HTMLButtonElement;
  #showAids = false;
  #replaySurface: Surface;
  #replaying = false;
  #replayMode: ReplayMode = "ink";
  #replaySpeed = 1;
  #replayButton: HTMLButtonElement | null = null;
  /** Set while a saved row of writing is put back, which is not an edit to save again. */
  #restoring = false;
  /** Called after this row is checked or its check is cleared. */
  onResult: () => void = () => {};
  /**
   * Called with a check worth keeping in the progress history: the first
   * check of each version of the writing. Checking again without writing
   * anything new isn't another attempt, not even after a reload (the writing is
   * recognised by its fingerprint, which is saved with it).
   */
  onRecord: (r: CheckResult, pen: string, m: LineMetrics, strokes: Stroke[]) => void = () => {};
  /** The stroke models to judge order and direction by (the person's own, then the built-in); null for none. */
  strokeLookup: () => StrokeLookup | null = () => null;
  /** Called with the line's writing after every change to it (the caller debounces its saving). */
  onStrokes: (strokes: Stroke[]) => void = () => {};
  /** The writing (and model) last recorded as a check, and that check's id once it is stored. */
  #recorded: Recorded | null = null;
  #strokes: Stroke[] = [];
  #live: Stroke | null = null;
  #predicted: Point[] = [];
  /**
   * The finished part of the stroke being written, so a frame draws only its tail: segments
   * `#liveDone` of `#liveFor` and before are already on this surface.
   */
  #liveLayer: Surface;
  #liveFor: Stroke | null = null;
  #liveDone = 0;
  #frame = 0;

  #settings: () => Settings;
  #theme: Theme;
  #history: History;
  #erasing: () => boolean;
  /** The eraser gesture in progress: the strokes at its start and its last point. */
  #erase: { before: Stroke[]; last: UV } | null = null;

  constructor(
    el: HTMLElement,
    settings: () => Settings,
    theme: Theme,
    history: History,
    erasing: () => boolean = () => false,
  ) {
    this.#erasing = erasing;
    this.#el = el;
    this.#settings = settings;
    this.#theme = theme;
    this.#history = history;
    this.#text = el.querySelector(".model")?.textContent?.trim() ?? "";
    this.#ref = surface(el.querySelector(".reference canvas") as HTMLCanvasElement);
    this.#practice = surface(el.querySelector(".practice canvas") as HTMLCanvasElement);
    this.#base = surface(document.createElement("canvas"));
    this.#liveLayer = surface(document.createElement("canvas"));
    // The replay's canvas lies over the practice line and never takes the pen.
    const replayCanvas = document.createElement("canvas");
    replayCanvas.className = "replay";
    replayCanvas.setAttribute("aria-hidden", "true");
    this.#practice.canvas.parentElement?.append(replayCanvas);
    this.#replaySurface = surface(replayCanvas);
    this.#replay = new Replay(replayCanvas);
    this.#replay.onEnd = () => this.#replayEnded();
    // A replay stops when the line scrolls out of view or the page is left.
    if (typeof IntersectionObserver === "function") {
      new IntersectionObserver((entries) => {
        if (entries.some((e) => !e.isIntersecting)) this.#replay.stop();
      }).observe(el);
    }
    addEventListener("pagehide", () => this.#replay.stop());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.#replay.stop();
    });
    this.#aidsView = new StrokeAidsView(
      el.querySelector(".reference") as HTMLElement,
      el.querySelector(".practice") as HTMLElement,
      theme.aids,
    );
    this.#play = document.createElement("button");
    this.#play.type = "button";
    this.#play.className = "icon-button play-strokes";
    this.#play.hidden = true;
    this.#play.setAttribute("aria-pressed", "false");
    this.#play.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg><span class="label">Play</span>';
    this.#play.addEventListener("click", () => {
      if (this.#aidsView.playing) this.#aidsView.stop();
      else this.#aidsView.play();
    });
    this.#aidsView.onPlaying = (on) => {
      this.#play.setAttribute("aria-pressed", String(on));
      const l = this.#play.querySelector(".label");
      if (l) l.textContent = on ? "Stop" : "Play";
    };
    el.querySelector(".row-actions")?.prepend(this.#play);
    this.#clear = el.querySelector('[data-action="clear"]') as HTMLButtonElement;
    this.#check = el.querySelector('[data-action="check"]') as HTMLButtonElement;
    this.#resultEl = el.querySelector(".check-result") as HTMLElement;
    this.#check.addEventListener("click", () => this.check());

    // Clearing is an edit like any other, so it can be undone.
    this.#clear.addEventListener("click", () => {
      const before = this.#strokes;
      if (before.length === 0) return;
      this.#setStrokes([]);
      this.#history.push({
        where: el,
        undo: () => this.#setStrokes(before),
        redo: () => this.#setStrokes([]),
      });
    });

    attachPen(this.#practice.canvas, {
      touchWrites: () => this.#settings().touchWrites,
      start: (s) => {
        if (this.#erasing()) {
          const p = this.#point(s);
          this.#erase = { before: this.#strokes, last: p };
          this.#eraseAlong([p]);
          return;
        }
        this.#live = { pen: this.#settings().pen, points: [this.#point(s)] };
        this.#schedule();
      },
      move: (samples, predicted) => {
        if (this.#erase) {
          this.#eraseAlong(samples.map((x) => this.#point(x)));
          return;
        }
        if (!this.#live) return;
        for (const s of samples) this.#live.points.push(this.#point(s));
        this.#predicted = predicted.map((s) => this.#point(s));
        this.#schedule();
      },
      end: () => {
        const gesture = this.#erase;
        if (gesture) {
          // One edit for the whole gesture, however many strokes it took.
          this.#erase = null;
          const before = gesture.before, after = this.#strokes;
          if (after.length !== before.length) {
            this.#history.push({
              where: el,
              undo: () => this.#setStrokes(before),
              redo: () => this.#setStrokes(after),
            });
          }
          return;
        }
        const stroke = this.#live;
        if (!stroke) return;
        this.#live = null;
        this.#predicted = [];
        this.#setStrokes([...this.#strokes, stroke]);
        this.#history.push({
          where: el,
          undo: () => this.#setStrokes(this.#strokes.filter((s) => s !== stroke)),
          redo: () => this.#setStrokes([...this.#strokes, stroke]),
        });
      },
    });
  }

  /** Remove, live, every stroke the eraser passes over on its way through these points. */
  #eraseAlong(points: UV[]) {
    const g = this.#erase;
    if (!g) return;
    const path = [g.last, ...points];
    g.last = path[path.length - 1];
    const hit = new Set(strokesHit(this.#strokes, path, eraserTolerance));
    if (hit.size) this.#setStrokes(this.#strokes.filter((_, i) => !hit.has(i)));
  }

  /**
   * Lay the row out for a given x-height and font. The x-height is reduced
   * for this row if the model would not otherwise fit the width, so a long
   * line on a narrow screen shrinks rather than running off the edge.
   */
  /**
   * The largest x-height, up to `xh`, at which this line's model fits the
   * width. A sheet lays every line out at the smallest of these, so one long
   * line doesn't leave the sheet at mixed sizes.
   */
  fit(xh: number, font: FontInfo): number {
    const width = this.#el.querySelector(".practice")!.clientWidth;
    if (width === 0) return xh;
    const ctx = this.#ref.ctx;
    ctx.font = fontString(font, xh / font.xRatio);
    const textWidth = ctx.measureText(this.#text).width;
    const room = width - 2 * band(xh, width, font.proportions).left;
    return textWidth > room ? Math.max(12, xh * (room / textWidth)) : xh;
  }

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
    this.#replay.stop();

    // Normally the sheet has already fitted xh to its longest line; this
    // only matters for a row laid out on its own.
    const fitted = this.fit(xh, font);
    const b = band(fitted, width, font.proportions);
    this.#band = b;
    for (const sel of [".reference", ".practice"]) {
      (this.#el.querySelector(sel) as HTMLElement).style.height = `${b.height}px`;
    }
    resize(this.#ref, b);
    resize(this.#practice, b);
    resize(this.#replaySurface, b);
    resize(this.#base, b);
    resize(this.#liveLayer, b);
    this.#liveFor = null;

    drawGuides(this.#ref.ctx, b, this.#theme.guides, this.#slant);
    this.#ref.ctx.font = fontString(font, fitted / font.xRatio);
    this.#ref.ctx.fillStyle = this.#theme.modelInk;
    this.#ref.ctx.textBaseline = "alphabetic";
    this.#ref.ctx.fillText(this.#text, b.left, b.baseline);
    // Where each letter's advance starts, in x-heights, for the stroke aids (the model's own advances).
    const starts: number[] = [];
    let prefix = "";
    for (const ch of this.#text) {
      starts.push(this.#ref.ctx.measureText(prefix).width / b.xh);
      prefix += ch;
    }
    starts.push(this.#ref.ctx.measureText(this.#text).width / b.xh);
    this.#aidsView.layout(b, font.slant, this.#text, starts);
    this.#aidsView.setWritten(this.#strokes);
    this.#syncPlay();

    this.#rebuildBase();
    this.#draw();
  }

  #point(s: Sample): Point {
    const [u, v] = this.#band ? toUnits(this.#band, s.x, s.y) : [0, 0];
    const p: Point = { u, v, p: s.p, t: s.t };
    if (s.alt !== undefined) p.alt = s.alt;
    if (s.az !== undefined) p.az = s.az;
    if (s.roll !== undefined) p.roll = s.roll;
    if (s.force !== undefined) p.force = s.force;
    return p;
  }

  /** The stroke models changed (a font, a definition, a sync): the aids follow. */
  refreshAids() {
    this.#aidsView.setLookup(this.strokeLookup());
    this.#syncPlay();
  }

  /** "Show strokes" and "Trace first" (the sheet's two toggles). */
  setAids(show: boolean, trace: boolean) {
    this.#showAids = show;
    this.#aidsView.setShow(show);
    this.#aidsView.setTrace(trace);
    this.#syncPlay();
  }

  #syncPlay() {
    this.#play.hidden = !(this.#showAids && this.#aidsView.available);
  }

  /** The line's text, its score if checked, for the sheet summary. */
  get text(): string {
    return this.#text;
  }
  /** The model font the line was last laid out with, if it has been. */
  get font(): FontInfo | null {
    return this.#font;
  }
  get result(): CheckResult | null {
    return this.#result;
  }
  get hasInk(): boolean {
    return this.#strokes.length > 0;
  }
  /** The last check's metrics (null once the writing has changed). */
  get metrics(): LineMetrics | null {
    return this.#metrics;
  }
  get strokes(): Stroke[] {
    return this.#strokes;
  }
  /** The x-height in CSS pixels the line is laid out at (0 before the first layout). */
  get xh(): number {
    return this.#band?.xh ?? 0;
  }

  /** Draw the writing again (the pressure calibration changed). */
  redraw() {
    this.#rebuildBase();
    this.#draw();
  }

  /** What was last recorded as a check, to be saved with the writing. */
  get recorded(): Recorded | null {
    return this.#recorded;
  }

  /** The stored id of the check just recorded; the row's writing is saved again with it. */
  noteRecorded(check: string) {
    if (!this.#recorded) return;
    this.#recorded = { ...this.#recorded, check };
    this.onStrokes(this.#strokes);
  }

  /** Put back writing saved earlier, unless something has been written since. */
  restore(strokes: Stroke[], recorded: Recorded | null = null) {
    if (this.#strokes.length || strokes.length === 0) return;
    this.#recorded = recorded;
    this.#restoring = true;
    this.#setStrokes(strokes);
    this.#restoring = false;
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
    this.#replay.stop();
    this.#result = check(this.#text, this.#font, this.#strokes);
    this.#metrics = this.#result
      ? lineMetrics(this.#text, this.#strokes, this.#result, this.strokeLookup())
      : null;
    this.#showResult = true;
    const fp = fingerprint(this.#strokes, this.#font);
    if (this.#result && this.#metrics && this.#recorded?.fp !== fp) {
      this.#recorded = { fp, check: "" };
      this.onRecord(this.#result, legacyPenKind(this.#strokes), this.#metrics, this.#strokes);
    }
    this.#renderResult();
    this.#rebuildBase();
    this.#draw();
    this.onResult();
    return this.#result;
  }

  #clearResult() {
    if (!this.#result) return;
    this.#result = null;
    this.#metrics = null;
    this.#details = false;
    this.#renderResult();
    this.onResult();
  }

  /** The strip under the line: a chip per letter, the score, and notes. */
  #renderResult() {
    const r = this.#result;
    const el = this.#resultEl;
    const label = this.#check.querySelector(".label");
    if (label) label.textContent = r ? "Check again" : "Check";
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
    const m = this.#metrics;
    const line = document.createElement("span");
    line.className = "result-scores";
    line.textContent = m ? subScoreLine(m.scores) : "";
    head.append(score, line);
    let panel: HTMLElement | null = null;
    if (m) {
      const details = document.createElement("button");
      details.type = "button";
      details.className = "result-toggle";
      const sync = () => {
        details.textContent = this.#details ? "Hide details" : "Details";
        details.setAttribute("aria-expanded", String(this.#details));
        if (panel) panel.hidden = !this.#details;
      };
      details.addEventListener("click", () => {
        this.#details = !this.#details;
        sync();
      });
      panel = renderPanel(m);
      sync();
      head.append(details);
    }
    head.append(toggle);

    const letters = document.createElement("ol");
    letters.className = "result-letters";
    // The judged letters are a subsequence of the written ones: matched by character, in order.
    const judged = m?.order ? pairOrderLetters(r.letters, m.order.letters) : null;
    for (const l of r.letters) {
      const li = document.createElement("li");
      li.className = `letter ${l.missing ? "missing" : scoreClass(l.score)}`;
      const ch = document.createElement("span");
      ch.className = "letter-char";
      ch.textContent = l.char;
      // In the line's own model font, so the letter matches the one it was
      // compared with. Set through the CSSOM, which the CSP allows.
      if (this.#font) {
        ch.style.fontFamily = this.#font.family;
        ch.style.fontStyle = this.#font.style;
      }
      const sc = document.createElement("span");
      sc.className = "letter-score";
      sc.textContent = l.missing ? "missing" : `${l.score}`;
      li.append(ch, sc);
      const order = judged?.get(l.index);
      const flags = order ? letterFlags(order) : [];
      if (flags.length) {
        // Tap a flagged letter to see how the model writes it.
        li.classList.add("playable");
        li.addEventListener("click", () => {
          const i = this.#aidsView.letterOfIndex(l.index);
          if (i !== null) this.#aidsView.play(i);
        });
        const fl = document.createElement("span");
        fl.className = "letter-flags";
        for (const f of flags) {
          const b = document.createElement("span");
          b.className = `flag flag-${f}`;
          b.textContent = flagSymbol[f];
          b.title = flagTitle[f];
          fl.append(b);
        }
        fl.setAttribute("aria-label", flags.map((f) => flagTitle[f]).join(", "));
        li.dataset.flags = flags.join(" ");
        li.append(fl);
      }
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
    if (m) el.append(this.#replayControls());
    if (panel) el.append(panel);
  }

  /** Replay, with its colour mode (Ink / Speed / Pressure heat) and speed (1x / 2x). */
  #replayControls(): HTMLElement {
    const box = document.createElement("div");
    box.className = "replay-controls";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "replay-button";
    button.addEventListener("click", () => {
      if (this.#replaying) this.#replay.stop();
      else this.#startReplay();
    });
    this.#replayButton = button;
    this.#syncReplayButton();
    const group = (
      label: string,
      name: string,
      options: Array<[string, string]>,
      current: string,
      pick: (v: string) => void,
    ) => {
      const g = document.createElement("fieldset");
      g.className = "range replay-seg";
      const legend = document.createElement("legend");
      legend.className = "visually-hidden";
      legend.textContent = label;
      g.append(legend);
      for (const [value, text] of options) {
        const l = document.createElement("label");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = `${name}-${this.#id}`;
        input.value = value;
        input.checked = value === current;
        input.addEventListener("change", () => {
          pick(value);
          // A running replay restarts with the new choice.
          if (this.#replaying) this.#startReplay();
        });
        const span = document.createElement("span");
        span.textContent = text;
        l.append(input, span);
        g.append(l);
      }
      return g;
    };
    box.append(
      button,
      group(
        "Replay colour",
        "replay-mode",
        [["ink", "Ink"], ["speed", "Speed"], ["pressure", "Pressure"]],
        this.#replayMode,
        (v) => this.#replayMode = v as ReplayMode,
      ),
      group(
        "Replay speed",
        "replay-speed",
        [["1", "1\u00D7"], ["2", "2\u00D7"]],
        String(this.#replaySpeed),
        (v) => this.#replaySpeed = Number(v),
      ),
    );
    return box;
  }

  #syncReplayButton() {
    const b = this.#replayButton;
    if (!b) return;
    b.textContent = this.#replaying ? "Stop" : "Replay";
    b.setAttribute("aria-pressed", String(this.#replaying));
  }

  /** Write the attempt again from its strokes, with its timing. */
  #startReplay() {
    const b = this.#band;
    if (!b || this.#strokes.length === 0) return;
    this.#replaying = true;
    this.#replay.start(this.#strokes, this.#replayMode, this.#replaySpeed, b, this.#theme.penInk);
    this.#syncReplayButton();
    // The finished ink gives way to the replay, which redraws it as it goes.
    this.#rebuildBase();
    this.#draw();
  }

  #replayEnded() {
    if (!this.#replaying) return;
    this.#replaying = false;
    this.#syncReplayButton();
    this.#rebuildBase();
    this.#draw();
  }

  /** Replace the line's writing (never mutated in place, so edits can hold the old list). */
  #setStrokes(strokes: Stroke[]) {
    this.#strokes = strokes;
    this.#changed();
  }

  #changed() {
    const n = this.#strokes.length;
    this.#clear.disabled = n === 0;
    this.#check.disabled = n === 0;
    // Anything written, undone or cleared makes the last check stale; a check of different
    // writing is a new attempt (see `#recorded`).
    this.#replay.stop();
    this.#clearResult();
    // Exposed for tests and the browser console; not used by the app itself.
    this.#practice.canvas.dataset.strokes = String(n);
    this.#aidsView.setWritten(this.#strokes);
    this.#rebuildBase();
    this.#draw();
    if (!this.#restoring) this.onStrokes(this.#strokes);
  }

  #rebuildBase() {
    const b = this.#band;
    if (!b) return;
    const ctx = this.#base.ctx;
    ctx.clearRect(0, 0, b.width, b.height);
    drawGuides(ctx, b, this.#theme.guides, this.#slant);
    // While replaying, the replay canvas is the ink: only the guides stay.
    if (this.#replaying) return;
    const r = this.#showResult ? this.#result : null;
    if (!r) {
      for (const s of this.#strokes) drawStroke(ctx, b, s, this.#theme.penInk);
      return;
    }
    // Results view: the model as a ghost under the writing, then the
    // writing coloured by how far each part is from the model.
    drawOverlay(ctx, b, r);
    this.#strokes.forEach((s, i) => {
      // Pointed and pencil strokes are drawn whole (their widths, taper and grain belong to the
      // stroke); the others in runs of one class.
      if (drawsWhole(s.pen)) {
        drawStrokeClasses(ctx, b, s, r.pointClass[i], deviationColors);
        return;
      }
      for (const run of colouredRuns(s, r.pointClass[i])) {
        drawStroke(ctx, b, run.stroke, deviationColors[run.cls]);
      }
    });
    drawWorstSegment(ctx, b, this.#strokes, this.#metrics?.shape.worst, deviationColors[2]);
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
      // Only the tail is drawn each frame: segments no later point can change are kept on the
      // live layer. A monoline segment's end depends on the next point, so the last real one waits.
      const lctx = this.#liveLayer.ctx;
      const ink = this.#theme.penInk;
      if (this.#liveFor !== this.#live) {
        lctx.save();
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.clearRect(0, 0, this.#liveLayer.canvas.width, this.#liveLayer.canvas.height);
        lctx.restore();
        this.#liveFor = this.#live;
        this.#liveDone = 0;
      }
      const stable = Math.max(0, this.#live.points.length - 2);
      if (stable > this.#liveDone) {
        drawStroke(lctx, b, this.#live, ink, this.#liveDone, true, stable);
        this.#liveDone = stable;
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.#liveLayer.canvas, 0, 0);
      ctx.restore();
      drawStroke(ctx, b, shown, ink, this.#liveDone, true);
    }
  }
}
