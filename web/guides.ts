// Ruled guidelines, drawn identically behind the model and the practice line
// so the two can be compared directly.

import type { Band } from "./geometry.ts";

export interface GuideColors {
  strong: string;
  faint: string;
}

/**
 * Draw the four rules and the slant lines. `slant` is degrees right of
 * vertical: about 5° for Getty-Dubay italic, 0° for upright paper, negative
 * for a hand that leans backwards.
 */
export function drawGuides(ctx: CanvasRenderingContext2D, b: Band, c: GuideColors, slant: number) {
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
  const run = Math.tan((slant * Math.PI) / 180) * rise;
  const step = b.xh * 1.5;
  // A backward slant (negative run) leans the other way, so start far enough
  // left that the bottom-left corner of the paper is still ruled.
  const first = run < 0 ? b.left - Math.ceil(-run / step) * step : b.left;
  for (let x = first; x < b.width + Math.max(0, run); x += step) {
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
