// Ruled guidelines, drawn identically behind the model and the practice line
// so the two can be compared directly.

import type { Band } from "./geometry.ts";

export interface GuideColors {
  strong: string;
  faint: string;
}

/** Getty-Dubay italic slopes about 5° to the right of vertical. */
const slant = (5 * Math.PI) / 180;

export function drawGuides(ctx: CanvasRenderingContext2D, b: Band, c: GuideColors) {
  ctx.save();
  const line = (y: number, color: string, width: number, dash: number[] = []) => {
    ctx.beginPath();
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    // Align a 1px line to the pixel grid so it stays crisp.
    const yy = Math.round(y) + (width % 2 ? 0.5 : 0);
    ctx.moveTo(0, yy);
    ctx.lineTo(b.width, yy);
    ctx.stroke();
  };

  // Slant lines first, so the horizontal rules sit on top of them.
  ctx.beginPath();
  ctx.setLineDash([]);
  ctx.strokeStyle = c.faint;
  ctx.lineWidth = 1;
  const rise = b.descender - b.ascender;
  const run = Math.tan(slant) * rise;
  for (let x = b.left; x < b.width + run; x += b.xh * 1.5) {
    ctx.moveTo(x - run, b.descender);
    ctx.lineTo(x, b.ascender);
  }
  ctx.stroke();

  line(b.ascender, c.strong, 1, [4, 4]);
  line(b.xline, c.strong, 1);
  line(b.baseline, c.strong, 2);
  line(b.descender, c.strong, 1, [4, 4]);
  ctx.restore();
}
