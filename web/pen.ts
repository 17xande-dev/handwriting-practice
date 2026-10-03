// Pointer Events input for the worksheet.
//
// The writing area (everything below the toolbar) is taken over from the
// browser: it has `touch-action: none` and no text selection, so nothing
// Safari would do with a touch there (scroll, zoom, select, magnify) can
// happen while the hand rests on the glass. Instead:
//
//  - the Pencil writes on a practice line, and does nothing anywhere else;
//  - two fingers scroll the page, from script, with momentum;
//  - a quick two-finger tap undoes, a three-finger tap redoes;
//  - a single touch does nothing, so a resting palm is harmless.
//
// Contact size can't separate a palm from a finger: Safari reports fingertips
// 63–125px across on an iPad Air. Requiring two fingers to scroll is what
// makes a palm safe, as in most drawing apps.
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

/** Touches that land this soon after the Pencil was last on the glass are a palm. */
const palmGuardMs = 500;

let lastPenActivity = -Infinity;

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
 * Take the writing area over from the browser: no selection, no native
 * gestures, two-finger scrolling from script, single touches ignored.
 */
export function attachWritingArea(
  area: HTMLElement,
  touchWrites: () => boolean,
  onTap: (fingers: number) => void = () => {},
): void {
  const taps = new TapTracker();
  // Every touch currently down in the area, and where it last was.
  const touches = new Map<number, { x: number; y: number }>();
  // Scroll state while two or more fingers are down: the centroid it last
  // scrolled from, and recent centroid positions for the momentum on release.
  let pan: { x: number; y: number; trail: Array<[number, number]> } | null = null;
  let glide = 0; // requestAnimationFrame id of the momentum animation

  const stopGlide = () => {
    if (glide) cancelAnimationFrame(glide);
    glide = 0;
  };

  const centroid = () => {
    let x = 0, y = 0;
    for (const t of touches.values()) {
      x += t.x;
      y += t.y;
    }
    return { x: x / touches.size, y: y / touches.size };
  };

  /** Start, or restart from the current centroid when a finger is added or lifted. */
  const repan = () => {
    if (touches.size < 2 || performance.now() - lastPenActivity < palmGuardMs) {
      pan = null;
      return;
    }
    const c = centroid();
    pan = { x: c.x, y: c.y, trail: pan?.trail ?? [] };
    // Only a scroll captures its fingers, so they keep scrolling wherever they
    // go. A single finger is never captured: a capturing element receives the
    // click, which would stop a tap on Undo, Clear or a link from working.
    for (const id of touches.keys()) {
      try {
        area.setPointerCapture(id);
      } catch {
        // Synthetic or already-gone pointer.
      }
    }
  };

  area.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "pen") {
      lastPenActivity = e.timeStamp;
      taps.pen();
      // The Pencil landing ends any scroll, and clears any stray selection.
      pan = null;
      stopGlide();
      getSelection()?.removeAllRanges();
      // The Pencil only writes on a practice line; anywhere else it does nothing.
      e.preventDefault();
      return;
    }
    if (e.pointerType !== "touch" || (e.defaultPrevented && touchWrites())) return;
    stopGlide();
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    taps.down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
    repan();
  });

  area.addEventListener("pointermove", (e) => {
    if (e.pointerType === "pen") {
      lastPenActivity = e.timeStamp;
      taps.pen();
      return;
    }
    const t = touches.get(e.pointerId);
    if (!t) return;
    taps.move(e.pointerId, e.clientX, e.clientY);
    t.x = e.clientX;
    t.y = e.clientY;
    if (!pan) return;
    const c = centroid();
    globalThis.scrollBy(pan.x - c.x, pan.y - c.y);
    pan.x = c.x;
    pan.y = c.y;
    pan.trail.push([e.timeStamp, c.y]);
    if (pan.trail.length > 8) pan.trail.shift();
  });

  const release = (e: PointerEvent) => {
    if (!touches.delete(e.pointerId)) return;
    const fingers = taps.up(e.pointerId, e.timeStamp, e.type === "pointercancel");
    if (fingers) onTap(fingers);
    if (touches.size >= 2) {
      repan(); // three fingers down to two: keep scrolling from the new centroid
      return;
    }
    const trail = pan?.trail ?? [];
    pan = null;
    if (e.type === "pointercancel" || trail.length < 2) return;
    // Carry on in the direction of the flick, slowing down, like native scrolling.
    const [t0, y0] = trail[0];
    const [t1, y1] = trail[trail.length - 1];
    if (e.timeStamp - t1 > 80) return; // the fingers had stopped before lifting
    let v = (y0 - y1) / Math.max(1, t1 - t0); // px per ms, positive scrolls down
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      globalThis.scrollBy(0, v * dt);
      v *= Math.pow(0.995, dt);
      glide = Math.abs(v) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    glide = requestAnimationFrame(step);
  };
  area.addEventListener("pointerup", release);
  area.addEventListener("pointercancel", release);

  // Belt and braces with the CSS: Safari can still begin a selection or show
  // the callout from a long press on text inside the area.
  area.addEventListener("selectstart", (e) => e.preventDefault());
  area.addEventListener("contextmenu", (e) => e.preventDefault());
}
