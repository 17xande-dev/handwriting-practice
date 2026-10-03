// Entry point: wires the toolbar to the pen preview and every row on a
// worksheet page.

import { familyList, loadGoogleFont, validFamilyName } from "./googlefont.ts";
import { measureFont, measureSlant } from "./measure.ts";
import { drawPreview } from "./preview.ts";
import { attachWritingArea } from "./pen.ts";
import { Row, type Theme } from "./row.ts";
import { type Settings, Toolbar } from "./settings.ts";

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Remember the last custom text on this device, so coming back to the form
 * doesn't mean pasting it again. Prefill only an empty box: text posted back
 * by "Edit this text" wins.
 */
function rememberCustomText() {
  const box = document.getElementById("custom-text");
  if (!(box instanceof HTMLTextAreaElement)) return;
  const key = "italic-practice:custom-text";
  try {
    if (!box.value) box.value = localStorage.getItem(key) ?? "";
  } catch {
    // Storage unavailable: nothing to restore.
  }
  box.form?.addEventListener("submit", () => {
    try {
      localStorage.setItem(key, box.value);
    } catch {
      // Not remembered; the worksheet still works.
    }
  });
}

function main() {
  document.documentElement.classList.add("js-ready");
  rememberCustomText();
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

  // A catalogue font's family comes from the generated font.css
  // (--font-<id>); a custom one is whatever Google font has been loaded.
  let customLoaded = "";
  const family = (s: Settings) =>
    s.model === "custom"
      ? (customLoaded ? familyList(customLoaded) : "cursive")
      : cssVar(`--font-${s.model}`, cssVar("--ref-font", "serif"));
  const layoutAll = () => {
    const s = toolbar.read();
    const font = measureFont(family(s), s.style, s.slant);
    for (const r of rows) r.layout(s.xh, font);
  };

  // A web font arrives after first paint, and only once something asks for
  // it. Lay out now with whatever is available, then again with the real
  // metrics once the chosen font has loaded.
  const loadAndLayout = () => {
    layoutAll();
    const s = toolbar.read();
    document.fonts.load(`${s.style} 32px ${family(s)}`).then(() => {
      if (toolbar.read().model === s.model) layoutAll();
    }).catch(() => {});
  };

  // "Any Google font": load the named family, measure its slope for the
  // paper, and show it on its tile.
  const status = document.getElementById("custom-font-status");
  const art = document.getElementById("custom-art");
  const say = (text: string, error = false) => {
    if (!status) return;
    status.textContent = text;
    status.classList.toggle("error", error);
  };
  let loading = 0;
  const loadCustom = async (measure: boolean) => {
    const name = toolbar.read().customFont.replace(/\s+/g, " ");
    if (!name) {
      say("Type a family name from fonts.google.com, then Load.");
      return;
    }
    const ticket = ++loading;
    say(`Loading “${name}”…`);
    try {
      await loadGoogleFont(name);
    } catch (e) {
      if (ticket === loading) say((e as Error).message, true);
      return;
    }
    if (ticket !== loading) return; // a newer load superseded this one
    customLoaded = name;
    if (art) art.style.fontFamily = familyList(name);
    if (measure) {
      const slant = measureSlant(familyList(name), "normal");
      toolbar.set("customSlant", String(slant.degrees)); // notifies, which relays out
      say(
        slant.reliable
          ? `Loaded “${name}”. Its letters slope ${slant.degrees}°; adjust the slant if the paper doesn't match.`
          : `Loaded “${name}”. Its slope couldn't be measured (looped or decorative letters), so set the slant by eye.`,
      );
    } else {
      say(`Loaded “${name}”.`);
    }
    if (toolbar.read().model === "custom") layoutAll();
  };
  document.getElementById("custom-font-load")?.addEventListener("click", () => loadCustom(true));
  // Enter in the name field loads it too (the form itself never submits).
  document.getElementById("custom-font")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      loadCustom(true);
    }
  });
  // A font chosen on an earlier visit comes back with its saved slant.
  if (validFamilyName(toolbar.read().customFont)) loadCustom(false);

  loadAndLayout();
  redrawPreview(toolbar.read());

  toolbar.onChange((now, before) => {
    redrawPreview(now);
    if (now.model !== before.model || now.style !== before.style) loadAndLayout();
    else if (now.xh !== before.xh || now.slant !== before.slant) layoutAll();
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
