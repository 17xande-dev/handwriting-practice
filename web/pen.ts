// Pointer Events input for the worksheet.
//
// The writing area (every row) is taken over from the browser: it has
// `touch-action: none` and no text selection, so nothing Safari would do with
// a touch there (scroll, zoom, select, magnify) can happen while the hand
// rests on the glass. Instead:
//
//  - the Pencil writes on a practice line, and does nothing anywhere else;
//  - a finger scrolls the page, from script, with momentum;
//  - a palm (a broad contact, or any touch that lands while or just after the
//    Pencil is writing) does nothing at all.
//
// "Finger draws" in the toolbar lets touch and mouse write too, for testing.

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

/** A touch that lands this soon after the Pencil was last on the glass is a palm. */
const palmGuardMs = 500;
/** A contact this many CSS pixels across is a palm or the side of a hand, not a fingertip. */
const palmContactPx = 40;
/** A finger must move this far before it scrolls, so a resting hand doesn't nudge the page. */
const scrollSlopPx = 8;

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
 * Take the writing area over from the browser: no selection, no native
 * gestures, finger scrolling from script, palms ignored.
 */
export function attachWritingArea(area: HTMLElement, touchWrites: () => boolean): void {
  let scroll:
    | { id: number; x: number; y: number; started: boolean; trail: Array<[number, number]> }
    | null = null;
  let glide = 0; // requestAnimationFrame id of the momentum animation

  const stopGlide = () => {
    if (glide) cancelAnimationFrame(glide);
    glide = 0;
  };

  const isPalm = (e: PointerEvent) =>
    e.timeStamp - lastPenActivity < palmGuardMs ||
    e.width > palmContactPx || e.height > palmContactPx;

  area.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "pen") {
      lastPenActivity = e.timeStamp;
      // A palm that touched down first and started a scroll stops the moment
      // the Pencil lands, and any stray selection goes.
      scroll = null;
      stopGlide();
      getSelection()?.removeAllRanges();
      // The Pencil only writes on a practice line; anywhere else it does nothing.
      e.preventDefault();
      return;
    }
    if (e.defaultPrevented || e.pointerType !== "touch" || touchWrites()) return;
    stopGlide();
    if (scroll || isPalm(e)) return;
    scroll = { id: e.pointerId, x: e.clientX, y: e.clientY, started: false, trail: [] };
  });

  area.addEventListener("pointermove", (e) => {
    if (e.pointerType === "pen") {
      lastPenActivity = e.timeStamp;
      return;
    }
    if (!scroll || e.pointerId !== scroll.id) return;
    // A hand that turns out to be a palm (it grew, or the Pencil came down)
    // stops scrolling where it is.
    if (isPalm(e)) {
      scroll = null;
      return;
    }
    const dx = scroll.x - e.clientX;
    const dy = scroll.y - e.clientY;
    if (!scroll.started && Math.hypot(dx, dy) < scrollSlopPx) return;
    scroll.started = true;
    globalThis.scrollBy(dx, dy);
    scroll.x = e.clientX;
    scroll.y = e.clientY;
    scroll.trail.push([e.timeStamp, e.clientY]);
    if (scroll.trail.length > 6) scroll.trail.shift();
  });

  const release = (e: PointerEvent) => {
    if (!scroll || e.pointerId !== scroll.id) return;
    const { trail, started } = scroll;
    scroll = null;
    if (!started || trail.length < 2 || e.type === "pointercancel") return;
    // Carry on in the direction of the flick, slowing down, like native scrolling.
    const [t0, y0] = trail[0];
    const [t1, y1] = trail[trail.length - 1];
    if (e.timeStamp - t1 > 80) return; // the finger had stopped before lifting
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
