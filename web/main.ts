// Entry point: wires the toolbar to every row on a worksheet page.

import { defaultProportions } from "./geometry.ts";
import { type FontInfo, Row, type Theme } from "./row.ts";
import { Toolbar } from "./settings.ts";

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Measure the reference font's proportions from its own glyphs, so the guides
 * fit whatever font is configured rather than assuming one.
 */
function measureFont(family: string): FontInfo {
  const ctx = document.createElement("canvas").getContext("2d")!;
  const size = 100;
  ctx.font = `${size}px ${family}`;
  const ascent = (ch: string) => ctx.measureText(ch).actualBoundingBoxAscent;
  const x = ascent("x");
  if (!(x > 0)) return { family, xRatio: 0.5, proportions: defaultProportions };
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
  const family = `${cssVar("--ref-font", "serif")}, cursive`;

  const toolbar = new Toolbar(form);
  const rows = [...rowsEl.querySelectorAll<HTMLElement>(".row")].map(
    (el) => new Row(el, () => toolbar.read(), theme),
  );

  let font = measureFont(family);
  const layoutAll = () => {
    const { xh } = toolbar.read();
    for (const r of rows) r.layout(xh, font);
  };
  layoutAll();

  // A web font arrives after first paint. Lay out again with its real metrics
  // once it does; until then the fallback font stands in.
  document.fonts.load(`32px ${family}`).then(() => {
    font = measureFont(family);
    layoutAll();
  }).catch(() => {});

  toolbar.onChange((_, sizeChanged) => {
    if (sizeChanged) layoutAll();
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
