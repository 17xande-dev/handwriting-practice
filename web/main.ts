// Entry point: wires the toolbar to the pen preview and every row on a
// worksheet page.

import { defaultProportions } from "./geometry.ts";
import { drawPreview } from "./preview.ts";
import { attachWritingArea } from "./pen.ts";
import { type FontInfo, Row, type Theme } from "./row.ts";
import { type Settings, Toolbar } from "./settings.ts";

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Measure a model font's proportions from its own glyphs, so the guides fit
 * whichever font is chosen rather than assuming one.
 */
function measureFont(family: string, slant: number): FontInfo {
  const ctx = document.createElement("canvas").getContext("2d")!;
  const size = 100;
  ctx.font = `${size}px ${family}`;
  const ascent = (ch: string) => ctx.measureText(ch).actualBoundingBoxAscent;
  const x = ascent("x");
  if (!(x > 0)) return { family, xRatio: 0.5, proportions: defaultProportions, slant };
  // Rounded so that guides don't shift by a hair between fonts that are
  // meant to share proportions.
  const round = (n: number) => Math.min(1.6, Math.max(0.5, Math.round(n * 20) / 20));
  return {
    family,
    xRatio: x / size,
    proportions: {
      asc: round((ascent("l") - x) / x),
      desc: round(ctx.measureText("p").actualBoundingBoxDescent / x),
    },
    slant,
  };
}

function main() {
  document.documentElement.classList.add("js-ready");
  const form = document.getElementById("toolbar");
  const rowsEl = document.getElementById("rows");
  if (!(form instanceof HTMLFormElement) || !rowsEl) return;

  const theme: Theme = {
    guides: {
      strong: cssVar("--guide-strong", "#9fb4cf"),
      faint: cssVar("--guide-faint", "#d6dfeb"),
    },
    modelInk: cssVar("--model-ink", "#222"),
    penInk: cssVar("--pen-ink", "#123"),
  };

  const toolbar = new Toolbar(form);
  const area = document.getElementById("writing-area") ?? rowsEl;
  attachWritingArea(area, () => toolbar.read().touchWrites);
  const rows = [...rowsEl.querySelectorAll<HTMLElement>(".row")].map(
    (el) => new Row(el, () => toolbar.read(), theme),
  );

  const preview = document.getElementById("pen-preview");
  const redrawPreview = (s: Settings) => {
    if (preview instanceof HTMLCanvasElement) {
      drawPreview(preview, s.pen, s.slant, theme.guides, theme.penInk);
    }
  };

  // The family for a model comes from the generated font.css (--font-<id>).
  const family = (s: Settings) => cssVar(`--font-${s.model}`, cssVar("--ref-font", "serif"));
  const layoutAll = () => {
    const s = toolbar.read();
    const font = measureFont(family(s), s.slant);
    for (const r of rows) r.layout(s.xh, font);
  };

  // A web font arrives after first paint, and only once something asks for
  // it. Lay out now with whatever is available, then again with the real
  // metrics once the chosen font has loaded.
  const loadAndLayout = () => {
    layoutAll();
    const s = toolbar.read();
    document.fonts.load(`32px ${family(s)}`).then(() => {
      if (toolbar.read().model === s.model) layoutAll();
    }).catch(() => {});
  };
  loadAndLayout();
  redrawPreview(toolbar.read());

  toolbar.onChange((now, before) => {
    redrawPreview(now);
    if (now.model !== before.model) loadAndLayout();
    else if (now.xh !== before.xh) layoutAll();
  });

  // Rotation and split view change the width; redraw at the new size.
  let lastWidth = rowsEl.clientWidth;
  let pending = 0;
  new ResizeObserver(() => {
    if (rowsEl.clientWidth === lastWidth || pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      lastWidth = rowsEl.clientWidth;
      layoutAll();
    });
  }).observe(rowsEl);
}

main();
