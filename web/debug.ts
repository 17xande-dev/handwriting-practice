// The test-only half of the app, bundled separately as /static/debug.js and
// loaded by main.ts only under #debug (see exportFixture there), so ordinary
// visitors never download it.

export { buildFixture } from "./fixture.ts";
export { fixtureModelOf } from "./fixture.ts";

import { renderModelRaster, S } from "./evaluate.ts";
import type { FontInfo } from "./measure.ts";
import type { Stroke } from "./ink.ts";
import type { StrokeLookup } from "./stroke-order.ts";

/**
 * The line written the way its stroke models say (their order, direction and start), placed on the
 * model's own letters: what a perfect writer would do. For browser tests of stroke order.
 */
export function definedStrokes(text: string, font: FontInfo, lookup: StrokeLookup): Stroke[] {
  const raster = renderModelRaster(text, font, () => 0);
  const tan = Math.tan((raster.slant * Math.PI) / 180);
  const out: Stroke[] = [];
  [...text].forEach((c, i) => {
    for (const s of lookup(c)?.strokes ?? []) {
      out.push({
        pen: { kind: "monoline", weight: 3 },
        points: s.pts.map((p, n) => ({
          u: (raster.bounds[i] + p[0] * S) / S + raster.uMin - p[1] * tan,
          v: p[1],
          p: 0.5,
          t: n * 16,
        })),
      });
    }
  });
  return out;
}
