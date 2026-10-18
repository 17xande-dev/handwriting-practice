// Entry point: wires the toolbar to the pen preview and every row on a
// worksheet page.

import { modelStrokes, renderModelRaster } from "./evaluate.ts";
import { sheetScoreLine } from "./details.ts";
import { encodeInk } from "./ink-codec.ts";
import { lineCheckOf, metrics2Of, pen2Of, summarise } from "./metric-scores.ts";
import { rowKey, sanitizeStrokes } from "./stroke-store.ts";
import { familyList, loadGoogleFont, validFamilyName } from "./googlefont.ts";
import { History } from "./history.ts";
import { measureFont, measureSlant } from "./measure.ts";
import { drawPreview } from "./preview.ts";
import { attachWritingArea } from "./pen.ts";
import { Row, type Theme } from "./row.ts";
import { DeviceStore, type InkRecord, type Metrics2 } from "./progress-store.ts";
import { installSync } from "./sync-triggers.ts";
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
  const history = new History();
  attachHistory(history);
  const area = document.getElementById("writing-area") ?? rowsEl;
  // A quick two-finger tap undoes and a three-finger tap redoes.
  attachWritingArea(area, () => toolbar.read().touchWrites, (fingers) => {
    if (fingers === 2) history.undo();
    else if (fingers === 3) history.redo();
  });
  const erasing = attachEraser();
  const rows = [...rowsEl.querySelectorAll<HTMLElement>(".row")].map(
    (el) => new Row(el, () => toolbar.read(), theme, history, erasing),
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
    // One size for the whole sheet: the largest every line fits at.
    const xh = Math.min(...rows.map((r) => r.fit(s.xh, font)));
    for (const r of rows) r.layout(xh, font);
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

  attachSheetCheck(rows);

  // Every check is kept on this device for the progress page, and synced to
  // the account when signed in (nothing happens while signed out).
  const store = new DeviceStore();
  const syncer = installSync(store);
  const modelName = () => {
    const s = toolbar.read();
    if (s.model === "custom") return customLoaded || s.customFont || "Google font";
    const chip = document.querySelector(`.chip input[value="${CSS.escape(s.model)}"]`);
    return chip?.closest(".chip")?.querySelector(".chip-name")?.textContent ?? s.model;
  };
  for (const r of rows) {
    r.onRecord = (result, pen, metrics, strokes) => {
      const xh = r.xh;
      const pen2 = pen2Of(strokes);
      store.add({
        at: Date.now(),
        sheet: rowsEl.dataset.sheet || "custom",
        sheetTitle: rowsEl.dataset.title || "Your text",
        line: r.text,
        model: toolbar.read().model,
        modelName: modelName(),
        pen,
        score: result.score,
        letters: result.letters.map(({ char, score, missing }) => ({ char, score, missing })),
        metrics: result.metrics,
        metrics2: metrics2Of(metrics, result.letters) as unknown as Metrics2,
        ...(pen2 ? { pen2 } : {}),
      }).then(async (rec) => {
        // One ink record per recorded check, so the attempt can be shown again (and replayed
        // on the iPad); it syncs like the check does.
        const enc = encodeInk(strokes, rec.id, rec.at, xh);
        if (enc) await store.addInk(enc.record as unknown as InkRecord);
        syncer.schedule();
      }).catch(() => {
        // Storage unavailable (private browsing, quota): the check still shows.
      });
    };
  }
  keepWriting(rows, rowsEl.dataset.sheet || "custom", store);
}

/**
 * What is written survives a reload: each row's strokes are saved to IndexedDB a moment after
 * the last change (and at once when the page is hidden), and put back when the sheet opens.
 */
function keepWriting(rows: Row[], sheet: string, store: DeviceStore) {
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  const save = (i: number) => {
    clearTimeout(pending.get(i));
    pending.delete(i);
    const s = rows[i].strokes;
    store.saveStrokes(rowKey(sheet, i, rows[i].text), s.length ? s : null).catch(() => {
      // Storage unavailable: the writing just doesn't survive a reload.
    });
  };
  rows.forEach((r, i) => {
    r.onStrokes = () => {
      clearTimeout(pending.get(i));
      pending.set(i, setTimeout(() => save(i), 600));
    };
    store.loadStrokes(rowKey(sheet, i, r.text)).then((x) => r.restore(sanitizeStrokes(x))).catch(
      () => {},
    );
  });
  const flush = () => [...pending.keys()].forEach(save);
  addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

/**
 * The toolbar's Eraser toggle (and the E key). Not part of the remembered
 * settings: the page always opens ready to write. Returns whether erasing is on.
 */
function attachEraser(): () => boolean {
  const button = document.getElementById("eraser");
  let on = false;
  if (!(button instanceof HTMLButtonElement)) return () => false;
  const set = (v: boolean) => {
    on = v;
    button.setAttribute("aria-pressed", String(on));
    document.documentElement.classList.toggle("erasing", on);
  };
  button.addEventListener("click", () => set(!on));
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest("input[type=text], textarea")) return;
    if (e.key.toLowerCase() !== "e" || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    set(!on);
    e.preventDefault();
  });
  return () => on;
}

/**
 * The toolbar's Undo and Redo buttons, and the keyboard shortcuts for a
 * keyboard attached to the iPad (or a desktop): ⌘/Ctrl+Z, ⇧⌘/Ctrl+Z and Ctrl+Y.
 */
function attachHistory(history: History) {
  const undo = document.getElementById("undo");
  const redo = document.getElementById("redo");
  if (!(undo instanceof HTMLButtonElement) || !(redo instanceof HTMLButtonElement)) return;
  undo.addEventListener("click", () => history.undo());
  redo.addEventListener("click", () => history.redo());
  history.onChange(() => {
    undo.disabled = !history.canUndo;
    redo.disabled = !history.canRedo;
  });
  document.addEventListener("keydown", (e) => {
    // A text field keeps its own undo (the Google Fonts name, say).
    const t = e.target;
    if (t instanceof Element && t.closest("input[type=text], textarea")) return;
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) history.undo();
    else if ((key === "z" && e.shiftKey) || key === "y") history.redo();
    else return;
    e.preventDefault();
  });
}

/**
 * "Check my writing" for the whole sheet: check every line with writing on
 * it, then summarise. The summary hides itself as soon as any line's check
 * goes stale.
 */
function attachSheetCheck(rows: Row[]) {
  const button = document.getElementById("check-all");
  const summary = document.getElementById("sheet-summary");
  if (!(button instanceof HTMLButtonElement) || !summary) return;

  let shown = false;
  for (const r of rows) {
    r.onResult = () => {
      if (shown && rows.some((x) => x.hasInk && !x.result)) {
        shown = false;
        summary.hidden = true;
      }
    };
  }

  button.addEventListener("click", () => {
    const checkedRows = rows.filter((r) => r.hasInk && r.check() !== null);
    const checked = checkedRows.map((r) => r.result);
    summary.replaceChildren();
    shown = true;
    summary.hidden = false;
    const h = document.createElement("h2");
    h.textContent = "Your sheet";
    summary.append(h);
    if (checked.length === 0) {
      const p = document.createElement("p");
      p.textContent = "Nothing written yet. Copy a line with the Pencil, then check it.";
      summary.append(p);
      return;
    }

    const sum = summarise(
      checkedRows.map((r) => lineCheckOf(r.result!, r.metrics!, r.strokes)),
    )!;
    const p = document.createElement("p");
    p.textContent = sum.headline;
    summary.append(p);
    // Sub-score means across the lines that have them.
    if (sum.scores) {
      const scores = document.createElement("p");
      scores.className = "sheet-scores";
      scores.textContent = sheetScoreLine(sum.scores);
      summary.append(scores);
    }
    if (sum.tips.length) {
      const ul = document.createElement("ul");
      for (const t of sum.tips) {
        const li = document.createElement("li");
        li.textContent = t;
        ul.append(li);
      }
      summary.append(ul);
    }
    summary.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  // For testing in a browser: #debug exposes a way to write a line from the
  // model's own centreline, so a check can be verified end to end.
  if (location.hash === "#debug") {
    // exportFixture({ row }) resolves to a JSON string: the row's model raster
    // and the scores of a set of synthetic writings (see fixture.ts), for
    // tools/export-fixtures. It refuses until the model font has loaded.
    // The synthetic writings live in their own bundle (web/debug.ts, served
    // as /static/debug.js) and are fetched here, only under #debug, so the
    // production bundle does not carry them. The specifier is a variable so
    // the bundler leaves it alone instead of following it.
    const exportFixture = async (opts: { row?: number } = {}) => {
      const url = "/static/debug.js";
      const { buildFixture } = await import(url) as typeof import("./debug.ts");
      const r = rows[opts.row ?? 0];
      const font = r?.font;
      if (!font) throw new Error("row not laid out");
      if (!document.fonts.check(`${font.style} 32px ${font.family}`)) {
        throw new Error("model font not loaded");
      }
      const modelId =
        document.querySelector<HTMLInputElement>('input[name="model"]:checked')?.value ?? "";
      const raster = renderModelRaster(r.text, font, () => 0);
      return JSON.stringify(buildFixture(raster, modelId));
    };
    (globalThis as Record<string, unknown>).__italic = { rows, modelStrokes, exportFixture };
  }
}

main();
