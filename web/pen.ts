// Pointer Events input for a practice canvas.
//
// Only the Apple Pencil (pointerType "pen") writes by default. The canvas has
// `touch-action: none`, which stops the Pencil scrolling or zooming the page
// mid-stroke, but it also stops a finger scrolling. So finger drags over the
// canvas are turned back into page scrolling here.

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

// Palms brush the glass while the Pencil is writing. A touch that starts
// during a pen stroke, or just after one, is a palm and is ignored entirely
// rather than allowed to scroll the page under the pen.
const palmGuardMs = 400;
let lastPenActivity = -Infinity;

// One finger scroll at a time, shared across every canvas, so the Pencil
// touching down anywhere can stop a palm that had already started scrolling.
let scrolling: { id: number; y: number; x: number } | null = null;

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

export function attachPen(canvas: HTMLCanvasElement, h: PenHandlers): void {
  let drawing: number | null = null; // pointerId of the writing pointer
  let rect = canvas.getBoundingClientRect();

  const writes = (e: PointerEvent) => e.pointerType === "pen" || h.touchWrites();

  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "pen") {
      lastPenActivity = e.timeStamp;
      scrolling = null;
    }
    if (drawing !== null || e.button !== 0) return;

    if (!writes(e)) {
      if (e.pointerType === "touch" && !scrolling && e.timeStamp - lastPenActivity > palmGuardMs) {
        scrolling = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }
      return;
    }
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
    if (e.pointerType === "pen") lastPenActivity = e.timeStamp;

    if (scrolling && e.pointerId === scrolling.id) {
      globalThis.scrollBy(scrolling.x - e.clientX, scrolling.y - e.clientY);
      scrolling.x = e.clientX;
      scrolling.y = e.clientY;
      return;
    }
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
    if (scrolling && e.pointerId === scrolling.id) scrolling = null;
    if (e.pointerId !== drawing) return;
    if (e.pointerType === "pen") lastPenActivity = e.timeStamp;
    drawing = null;
    h.end();
  };
  canvas.addEventListener("pointerup", finish);
  // iPadOS cancels a pointer when it decides a touch was a palm or a system
  // gesture. Keep what was written rather than throwing the stroke away.
  canvas.addEventListener("pointercancel", finish);
  canvas.addEventListener("lostpointercapture", finish);

  // The long-press callout and selection loupe can still appear on iPadOS
  // without this, despite the CSS.
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
}
