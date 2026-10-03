// Pencil and finger input for the worksheet.
//
// Scrolling is Safari's own; this only decides when it may happen:
//
//  - the Pencil never scrolls: its touches are cancelled at touchstart
//    (Safari reports touchType "stylus"), so it only writes;
//  - one finger, or a palm, doesn't scroll: its moves are cancelled while it
//    is the only touch down;
//  - two fingers scroll natively, with Safari's own momentum;
//  - a quick two-finger tap undoes, a three-finger tap redoes.
//
// Scrolling from script was tried and abandoned: on the iPad, Safari reports
// a touch's position shifted by however far script has scrolled the page
// (clientY and screenY alike), so moving the page by the fingers' travel fed
// back into itself and the page shuddered or swung. Contact size can't tell a
// palm from a finger either (Safari reports fingertips 63-125px across), so
// the finger count is what makes a palm safe. And while the Pencil is on the
// glass, iPadOS stops delivering finger touches at all.
//
// "Finger draws" in the toolbar lets one finger (or a mouse) write instead,
// for testing on a desktop.

/** A raw sample in canvas CSS pixels. */
export interface Sample {
  x: number;
  y: number;
  p: number;
  t: number;
  alt?: number;
  az?: number;
}

export interface PenHandlers {
  /** Whether a finger (or mouse) should write rather than scroll. */
  touchWrites(): boolean;
  start(s: Sample): void;
  /** Coalesced samples since the last event, plus predicted ones (may be empty). */
  move(samples: Sample[], predicted: Sample[]): void;
  end(): void;
}

function sample(e: PointerEvent, rect: DOMRect): Sample {
  const s: Sample = {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
    // Mouse and touch report 0.5 or 0 while pressed; only a stylus has real pressure.
    p: e.pointerType === "pen" ? e.pressure : 0.5,
    t: e.timeStamp,
  };
  // Safari reports altitude and azimuth directly; other browsers may only have tilt.
  const angles = e as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
  if (typeof angles.altitudeAngle === "number") s.alt = angles.altitudeAngle;
  if (typeof angles.azimuthAngle === "number") s.az = angles.azimuthAngle;
  return s;
}

/** Writing on one practice canvas. Scrolling and palms are handled by attachWritingArea. */
export function attachPen(canvas: HTMLCanvasElement, h: PenHandlers): void {
  let drawing: number | null = null; // pointerId of the writing pointer
  let rect = canvas.getBoundingClientRect();

  canvas.addEventListener("pointerdown", (e) => {
    if (drawing !== null || e.button !== 0) return;
    if (e.pointerType !== "pen" && !h.touchWrites()) return; // the writing area scrolls instead
    // Marks the event as taken, so the writing area doesn't also scroll on it.
    e.preventDefault();
    try {
      // Keeps the stroke coming to this canvas if the Pencil strays off its edge.
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone (or synthetic); write without capture.
    }
    drawing = e.pointerId;
    rect = canvas.getBoundingClientRect();
    h.start(sample(e, rect));
  });

  canvas.addEventListener("pointermove", (e) => {
    // A hovering Pencil (M2 iPads and later) sends moves with no pointer down.
    if (e.pointerId !== drawing) return;
    // The Pencil samples at up to 240Hz but events arrive once per frame; the
    // coalesced list holds the samples in between, which is what makes curves smooth.
    const coalesced = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    const predicted = typeof e.getPredictedEvents === "function" ? e.getPredictedEvents() : [];
    const samples = (coalesced.length ? coalesced : [e]).map((c) => sample(c, rect));
    h.move(samples, predicted.map((c) => sample(c, rect)));
  });

  const finish = (e: PointerEvent) => {
    if (e.pointerId !== drawing) return;
    drawing = null;
    h.end();
  };
  canvas.addEventListener("pointerup", finish);
  // iPadOS cancels a pointer when it decides a touch was a palm or a system
  // gesture. Keep what was written rather than throwing the stroke away.
  canvas.addEventListener("pointercancel", finish);
  canvas.addEventListener("lostpointercapture", finish);
}

/**
 * Recognises quick multi-finger taps: two fingers for undo, three for redo.
 * A tap is fingers that land together, stay put and lift quickly, so a
 * two-finger scroll (they move), a resting palm (it stays down, and lands as
 * one contact) and the Pencil (not a touch) are never mistaken for one.
 */
export class TapTracker {
  /** Fingers must all land within this of the first. */
  static landWithinMs = 120;
  /** And all lift within this of the first landing. */
  static liftWithinMs = 350;
  /** And none may move further than this. */
  static slopPx = 12;

  #down = new Map<number, { x: number; y: number }>();
  #start = 0;
  #most = 0;
  #spoiled = false;

  down(id: number, x: number, y: number, t: number) {
    if (this.#down.size === 0) {
      this.#start = t;
      this.#most = 0;
      this.#spoiled = false;
    } else if (t - this.#start > TapTracker.landWithinMs) {
      this.#spoiled = true;
    }
    this.#down.set(id, { x, y });
    this.#most = Math.max(this.#most, this.#down.size);
  }

  move(id: number, x: number, y: number) {
    const p = this.#down.get(id);
    if (p && Math.hypot(x - p.x, y - p.y) > TapTracker.slopPx) this.#spoiled = true;
  }

  /** The Pencil touched down or moved: whatever the fingers were doing, it wasn't a tap. */
  pen() {
    if (this.#down.size) this.#spoiled = true;
  }

  /**
   * A finger lifted (or was cancelled). Returns the number of fingers in the
   * tap when this completes one, otherwise 0.
   */
  up(id: number, t: number, cancelled = false): number {
    if (!this.#down.delete(id)) return 0;
    if (cancelled) this.#spoiled = true;
    if (this.#down.size > 0) return 0;
    const ok = !this.#spoiled && t - this.#start <= TapTracker.liftWithinMs &&
      this.#most >= 2 && this.#most <= 3;
    return ok ? this.#most : 0;
  }
}

/**
 * Gate the browser's own touch handling over the writing area: the Pencil
 * writes and never scrolls, two fingers scroll, one finger or a palm does
 * nothing, and quick multi-finger taps undo and redo.
 */
export function attachWritingArea(
  area: HTMLElement,
  touchWrites: () => boolean,
  onTap: (fingers: number) => void = () => {},
): void {
  const taps = new TapTracker();
  const stylus = (t: Touch) => (t as Touch & { touchType?: string }).touchType === "stylus";

  // Touch events, not pointer events, because only cancelling these stops
  // Safari scrolling. Not passive, so they can be cancelled.
  area.addEventListener("touchstart", (e) => {
    if ([...e.changedTouches].some(stylus)) {
      e.preventDefault(); // the Pencil only writes
      return;
    }
    // With "Finger draws" on, a finger on a practice line writes instead.
    const t = e.target;
    if (touchWrites() && e.touches.length === 1 && t instanceof Element && t.closest(".practice")) {
      e.preventDefault();
    }
  }, { passive: false });

  area.addEventListener("touchmove", (e) => {
    const all = [...e.touches];
    const fingers = all.filter((t) => !stylus(t)).length;
    // Scroll only for two fingers or more, and never with the Pencil down.
    if (fingers < 2 || all.some(stylus)) e.preventDefault();
  }, { passive: false });

  // Taps are read from pointer events. Once Safari starts a native scroll it
  // cancels the fingers' pointers, which spoils any tap in progress, so a
  // scroll can never undo anything.
  area.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "pen") {
      taps.pen();
      getSelection()?.removeAllRanges();
      // The Pencil only writes on a practice line; anywhere else it does nothing.
      e.preventDefault();
      return;
    }
    if (e.pointerType === "touch") taps.down(e.pointerId, e.screenX, e.screenY, e.timeStamp);
  });
  area.addEventListener("pointermove", (e) => {
    if (e.pointerType === "pen") taps.pen();
    else if (e.pointerType === "touch") taps.move(e.pointerId, e.screenX, e.screenY);
  });
  const release = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    const fingers = taps.up(e.pointerId, e.timeStamp, e.type === "pointercancel");
    if (fingers) onTap(fingers);
  };
  area.addEventListener("pointerup", release);
  area.addEventListener("pointercancel", release);

  // Belt and braces with the CSS: Safari can still begin a selection or show
  // the callout from a long press on text inside the area.
  area.addEventListener("selectstart", (e) => e.preventDefault());
  area.addEventListener("contextmenu", (e) => e.preventDefault());
}
