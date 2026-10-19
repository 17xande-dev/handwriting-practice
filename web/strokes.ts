// The Stroke models page (/strokes): a glyph grid per font with each character's status (your
// definition, built-in verified or not, missing) and coverage, and an editor where the strokes of a
// letter are written with the pen or mouse and snapped to the glyph's centreline. Definitions are
// kept on this device and synced as `strokes` records, in the iPad's JSON shape, so both use them
// (iPad docs/strokes.md, "Define strokes and the user store").
//
// TODO: suggestions from similar fonts (the iPad's StrokeSuggest: ranking fonts by topology, slant
// and x-height, transferring a similar font's strokes onto this font's skeleton, with a confidence)
// are not ported. The grid has no "suggested" status for now, and the editor's one shortcut is
// "Start from built-in".

import { type Band, band } from "./geometry.ts";
import { type FontInfo, measureFont, measureSlant } from "./measure.ts";
import { drawGuides } from "./guides.ts";
import { fontString } from "./measure.ts";
import { familyList, loadGoogleFont, validFamilyName } from "./googlefont.ts";
import { renderModelRaster } from "./evaluate.ts";
import { DeviceStore } from "./progress-store.ts";
import { installSync } from "./sync-triggers.ts";
import { applyEdits, exportFile, type FontDefs, parseImport, userGlyphs } from "./stroke-defs.ts";
import { StrokeModels } from "./stroke-lookup.ts";
import {
  allGlyphChars,
  coveragePercent,
  glyphSections,
  type GlyphStatus,
  glyphStatus,
  loadBuiltin,
  statusTitle,
  strokesFontID,
} from "./stroke-models.ts";
import {
  type ModelStroke,
  OrderLimits,
  pathLength,
  type Pt,
  type StrokeGlyph,
  type StrokeModelFile,
  strokePoints,
} from "./stroke-order.ts";
import { arrowAt } from "./stroke-aids.ts";
import {
  reversedStroke,
  snapDrawnStroke,
  type SnapTarget,
  snapTargetOf,
  targetPoints,
} from "./skeleton-graph.ts";

interface FontEntry {
  /** A catalogue id, or "custom". */
  model: string;
  family: string;
  style: string;
  slant: number;
  button: HTMLButtonElement;
  /** The name of a custom font. */
  customName?: string;
}

const marker: Record<GlyphStatus, string> = {
  user: "●",
  builtinVerified: "✓",
  builtinUnverified: "○",
  suggested: "◐",
  missing: "–",
};

const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function main() {
  if (!document.getElementById("strokes")) return;
  const store = new DeviceStore();
  const models = new StrokeModels(store);
  const syncer = installSync(store, {
    onResult: (r) => {
      if (r.status === "ok" && r.changed) void reload();
      void syncLine();
    },
  });

  const entries: FontEntry[] = [];
  let current: FontEntry | null = null;
  let builtin: StrokeModelFile | null = null;
  let defs: FontDefs | null = null;
  let fontInfo: FontInfo | null = null;
  let editing: Editor | null = null;

  const fontId = (e: FontEntry) => strokesFontID(e.model, e.customName ?? "");
  const familyOf = (e: FontEntry) =>
    e.model === "custom" ? familyList(e.customName ?? "") : e.family;

  for (const b of document.querySelectorAll<HTMLButtonElement>(".font-pick")) {
    const model = b.dataset.font!;
    const e: FontEntry = {
      model,
      family: cssVar(`--font-${model}`, "serif"),
      style: b.dataset.style ?? "normal",
      slant: Number(b.dataset.slant ?? 0) || 0,
      button: b,
    };
    entries.push(e);
    b.addEventListener("click", () => void select(e));
  }

  const statuses = async (e: FontEntry): Promise<Map<string, GlyphStatus>> => {
    const built = await loadBuiltin(e.model);
    const mine = userGlyphs(models.defs(fontId(e)));
    const out = new Map<string, GlyphStatus>();
    for (const c of allGlyphChars) out.set(c, glyphStatus(mine[c], built?.glyphs[c]));
    return out;
  };

  /** Coverage bar and percent beside every font. The percent has a fixed width so the bars line up. */
  const coverage = async () => {
    for (const e of entries) {
      const pct = coveragePercent([...(await statuses(e)).values()]);
      e.button.querySelector<HTMLElement>(".coverage-text")!.textContent = `${pct}%`;
      e.button.querySelector<HTMLElement>(".coverage-fill")!.style.width = `${pct}%`;
      e.button.dataset.coverage = String(pct);
    }
  };

  const reload = async () => {
    await models.refresh();
    await coverage();
    if (current) {
      defs = models.defs(fontId(current));
      await renderGrid();
    }
  };

  async function select(e: FontEntry) {
    editing = null;
    $("editor").hidden = true;
    current = e;
    for (const x of entries) x.button.setAttribute("aria-pressed", String(x === e));
    $("grid-section").hidden = false;
    $("grid-status").textContent = "Loading the font…";
    await document.fonts.load(`${e.style} 32px ${familyOf(e)}`).catch(() => {});
    fontInfo = measureFont(familyOf(e), e.style, e.slant);
    builtin = await loadBuiltin(e.model);
    await models.refresh();
    defs = models.defs(fontId(e));
    $("grid-status").textContent = "";
    await renderGrid();
  }

  async function renderGrid() {
    const e = current;
    if (!e) return;
    const st = await statuses(e);
    const grid = $("grid");
    grid.replaceChildren();
    for (const sec of glyphSections) {
      const h = document.createElement("h3");
      h.textContent = sec.name;
      const row = document.createElement("div");
      row.className = "glyph-grid";
      for (const c of sec.chars) {
        const s = st.get(c)!;
        const b = document.createElement("button");
        b.type = "button";
        b.className = `glyph-cell st-${s}`;
        b.dataset.char = c;
        b.dataset.status = s;
        b.title = `${c}: ${statusTitle[s]}`;
        b.setAttribute("aria-label", `${c}, ${statusTitle[s]}`);
        const ch = document.createElement("span");
        ch.className = "glyph-char";
        ch.textContent = c;
        ch.style.fontFamily = familyOf(e);
        ch.style.fontStyle = e.style;
        const m = document.createElement("span");
        m.className = "glyph-mark";
        m.textContent = marker[s];
        m.setAttribute("aria-hidden", "true");
        b.append(ch, m);
        b.addEventListener("click", () => void openEditor(c));
        row.append(b);
      }
      grid.append(h, row);
    }
    const pct = coveragePercent([...st.values()]);
    $("grid-heading").textContent = `Characters: ${pct}% have strokes`;
  }

  // ---- the editor -----------------------------------------------------------------------

  async function openEditor(char: string) {
    const e = current;
    if (!e || !fontInfo) return;
    await document.fonts.load(`${e.style} 32px ${familyOf(e)}`).catch(() => {});
    editing = new Editor(
      char,
      e,
      fontInfo,
      userGlyphs(defs)[char] ?? undefined,
      builtin?.glyphs[char],
      {
        saved: async (glyph) => {
          const edits = { [char]: glyph && glyph.strokes.length ? glyph : null };
          // Definitions as stored now: a sync may have brought newer ones since this page loaded.
          await models.refresh();
          await store.saveStrokesRecords(applyEdits(models.defs(fontId(e)), fontId(e), edits));
          await reload();
          void syncer.now();
        },
        close: () => {
          editing = null;
          $("editor").hidden = true;
          $("grid-section").hidden = false;
        },
      },
    );
    $("grid-section").hidden = true;
    $("editor").hidden = false;
    $("editor-char").textContent = char;
    $("editor-status").textContent = "";
    editing.mount();
  }

  // ---- export and import ----------------------------------------------------------------

  $("export-strokes").addEventListener("click", () => {
    const say = (t: string) => $("grid-status").textContent = t;
    if (!current) return;
    const d = models.defs(fontId(current));
    if (!d || Object.keys(userGlyphs(d)).length === 0) {
      say("You have not defined any strokes for this font yet.");
      return;
    }
    const blob = new Blob([exportFile(d)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `strokes-${fontId(current)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    say(`Exported ${Object.keys(userGlyphs(d)).length} characters.`);
  });

  $("import-strokes").addEventListener("change", async (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    const say = (t: string) => $("grid-status").textContent = t;
    if (!file || !current) return;
    const r = parseImport(await file.text());
    if (!r.ok) {
      say(r.error);
      return;
    }
    const edits: Record<string, StrokeGlyph> = r.glyphs;
    await models.refresh();
    await store.saveStrokesRecords(
      applyEdits(models.defs(fontId(current)), fontId(current), edits),
    );
    await reload();
    void syncer.now();
    say(`Imported ${Object.keys(r.glyphs).length} characters into this font.`);
  });

  // ---- a Google font by name ------------------------------------------------------------

  const load = async () => {
    const input = $<HTMLInputElement>("custom-font");
    const status = $("custom-font-status");
    const name = input.value.replace(/\s+/g, " ").trim();
    if (!validFamilyName(name)) {
      status.textContent = "Type a family name from fonts.google.com, then Load.";
      return;
    }
    status.textContent = `Loading “${name}”…`;
    try {
      await loadGoogleFont(name);
    } catch (err) {
      status.textContent = (err as Error).message;
      return;
    }
    const slant = measureSlant(familyList(name), "normal");
    let e = entries.find((x) => x.model === "custom");
    if (!e) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "font-pick";
      b.setAttribute("aria-pressed", "false");
      b.innerHTML =
        '<span class="font-pick-name"></span><span class="font-pick-note">Google font</span><span class="coverage" aria-hidden="true"><span class="coverage-fill"></span></span><span class="coverage-text"></span>';
      li.append(b);
      $("font-list").append(li);
      e = { model: "custom", family: "", style: "normal", slant: 0, button: b };
      entries.push(e);
      const entry = e;
      b.addEventListener("click", () => void select(entry));
    }
    e.customName = name;
    e.slant = slant.degrees;
    e.button.querySelector<HTMLElement>(".font-pick-name")!.textContent = name;
    status.textContent = `Loaded “${name}”.`;
    await models.refresh();
    await coverage();
    await select(e);
  };
  $("custom-font-load").addEventListener("click", () => void load());
  $("custom-font").addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key === "Enter") {
      ev.preventDefault();
      void load();
    }
  });

  // ---- sync line --------------------------------------------------------------------------

  async function syncLine() {
    let text =
      "Your definitions are kept in this browser only. Sign in on the Account page to sync them with your other devices and the iPad app.";
    try {
      const s = await store.syncState();
      if (s) {
        text =
          `Syncing with ${s.email}: your definitions travel to your other devices and the iPad app.`;
      }
    } catch {
      // Storage unavailable.
    }
    $("strokes-sync").textContent = text;
  }

  void models.refresh().then(coverage).then(syncLine);

  if (location.hash === "#debug") {
    (globalThis as Record<string, unknown>).__strokes = {
      select: (m: string) => select(entries.find((x) => x.model === m)!),
      open: (c: string) => openEditor(c),
      editor: () => editing,
      store,
    };
  }
}

// ---- the glyph editor ---------------------------------------------------------------------

interface EditorHooks {
  saved: (glyph: StrokeGlyph | null) => Promise<void>;
  close: () => void;
}

/** The strokes being written for one character of one font. */
class Editor {
  strokes: ModelStroke[];
  selected: number | null = null;
  dirty = false;
  #undo: ModelStroke[][] = [];
  #target: SnapTarget | null = null;
  #band: Band | null = null;
  #live: Array<[number, number]> | null = null;
  #tan: number;
  #canvas = $<HTMLCanvasElement>("editor-canvas");
  #wired = false;

  constructor(
    readonly char: string,
    readonly entry: FontEntry,
    readonly font: FontInfo,
    saved: StrokeGlyph | undefined,
    readonly builtin: StrokeGlyph | undefined,
    readonly hooks: EditorHooks,
  ) {
    this.strokes = structuredClone(saved?.strokes ?? []);
    this.#tan = Math.tan((font.slant * Math.PI) / 180);
  }

  mount() {
    const box = this.#canvas.parentElement!;
    const width = Math.max(240, Math.min(720, box.clientWidth || 600));
    // The letter big, with room for a wide one: the x-height follows the width, up to 110 px.
    const xh = Math.min(110, Math.max(40, width / 6));
    this.#band = band(xh, width, this.font.proportions);
    const dpr = globalThis.devicePixelRatio || 1;
    const b = this.#band;
    this.#canvas.width = Math.round(b.width * dpr);
    this.#canvas.height = Math.round(b.height * dpr);
    this.#canvas.style.width = `${b.width}px`;
    this.#canvas.style.height = `${b.height}px`;
    this.#canvas.getContext("2d")!.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.#target = snapTargetOf(renderModelRaster(this.char, this.font, () => 0));
    this.#wire();
    this.refresh();
  }

  #wire() {
    if (this.#wired) return;
    this.#wired = true;
    const c = this.#canvas;
    const pos = (e: PointerEvent): [number, number] => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      this.#live = [pos(e)];
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        // Not an active pointer (a synthetic event): the stroke still draws.
      }
      e.preventDefault();
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.#live) return;
      const list = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      for (const x of list.length ? list : [e]) this.#live.push(pos(x));
      this.#draw();
    });
    const end = (e: PointerEvent) => {
      const live = this.#live;
      if (!live) return;
      this.#live = null;
      live.push(pos(e));
      this.addDrawnScreen(live);
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", () => {
      this.#live = null;
      this.#draw();
    });
    const on = (id: string, f: () => void) => $(id).addEventListener("click", f);
    on("ed-undo", () => this.undo());
    on("ed-clear", () => this.clear());
    on("ed-reverse", () => this.reverse());
    on("ed-delete", () => this.deleteSelected());
    on("ed-builtin", () => this.useBuiltin());
    on("ed-save", () => void this.save());
    on("ed-done", () => void this.done());
  }

  /** Screen pixels of the canvas to the upright glyph frame (x-heights from the origin, baseline 0). */
  #toGlyph(x: number, y: number): Pt {
    const b = this.#band!;
    const v = (y - b.baseline) / b.xh;
    return { u: (x - b.left) / b.xh + this.#tan * v, v };
  }

  toScreen(p: Pt): [number, number] {
    const b = this.#band!;
    return [b.left + (p.u - this.#tan * p.v) * b.xh, b.baseline + p.v * b.xh];
  }

  /** A stroke written by the person: snapped to the skeleton and added; kept as drawn if nowhere near it. */
  addDrawnScreen(screen: Array<[number, number]>) {
    this.addDrawn(screen.map(([x, y]) => this.#toGlyph(x, y)));
  }

  addDrawn(pts: Pt[]) {
    if (pts.length === 0 || !this.#target) return;
    const snapped = snapDrawnStroke(pts, this.#target);
    const raw: ModelStroke = {
      pts: pts.map((p) => [p.u, p.v]),
      ...(pathLength(pts) < OrderLimits.tinyArc ? { kind: "dot" as const } : {}),
    };
    this.#push();
    this.strokes.push(snapped?.stroke ?? raw);
    this.selected = null;
    this.#changed(snapped ? "" : "That stroke is not on the letter; kept as drawn.");
  }

  #push() {
    this.#undo.push(structuredClone(this.strokes));
    if (this.#undo.length > 100) this.#undo.shift();
  }

  #changed(message = "") {
    this.dirty = true;
    $("editor-status").textContent = message;
    this.refresh();
  }

  undo() {
    const last = this.#undo.pop();
    if (!last) return;
    this.strokes = last;
    this.selected = null;
    this.#changed();
  }

  clear() {
    if (this.strokes.length === 0) return;
    this.#push();
    this.strokes = [];
    this.selected = null;
    this.#changed();
  }

  /** The stroke the Reverse and Delete controls act on: the selected one, else the last. */
  get #target_index(): number | null {
    return this.selected ?? (this.strokes.length ? this.strokes.length - 1 : null);
  }

  reverse() {
    const i = this.#target_index;
    if (i === null) return;
    this.#push();
    this.strokes[i] = reversedStroke(this.strokes[i]);
    this.#changed();
  }

  deleteSelected() {
    const i = this.#target_index;
    if (i === null) return;
    this.#push();
    this.strokes.splice(i, 1);
    this.selected = null;
    this.#changed();
  }

  move(i: number, by: -1 | 1) {
    const j = i + by;
    if (j < 0 || j >= this.strokes.length) return;
    this.#push();
    [this.strokes[i], this.strokes[j]] = [this.strokes[j], this.strokes[i]];
    this.selected = j;
    this.#changed();
  }

  useBuiltin() {
    if (!this.builtin || this.builtin.strokes.length === 0) {
      $("editor-status").textContent = "This font has no built-in strokes for this character.";
      return;
    }
    this.#push();
    this.strokes = structuredClone(this.builtin.strokes);
    this.selected = null;
    this.#changed("The built-in strokes are in; check them, then Save and verify.");
  }

  /** Saving makes the person's own definition (origin user, verified); no strokes forgets it. */
  async save() {
    const glyph: StrokeGlyph | null = this.strokes.length
      ? { strokes: this.strokes, verified: true, origin: "user", confidence: 1 }
      : null;
    await this.hooks.saved(glyph);
    this.dirty = false;
    $("editor-status").textContent = glyph
      ? `Saved: ${this.strokes.length} stroke${
        this.strokes.length === 1 ? "" : "s"
      } for ${this.char}.`
      : `Your definition of ${this.char} is forgotten; the built-in one applies.`;
  }

  async done() {
    if (this.dirty) await this.save();
    this.hooks.close();
  }

  refresh() {
    this.#draw();
    this.#renderList();
  }

  #renderList() {
    const ol = $("stroke-list");
    ol.replaceChildren();
    this.strokes.forEach((s, i) => {
      const li = document.createElement("li");
      li.className = "stroke-item";
      if (this.selected === i) li.setAttribute("aria-current", "true");
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "stroke-pick";
      const dot = s.kind === "dot";
      pick.textContent = `${i + 1}. ${
        dot ? "dot" : s.kind === "cross" ? "cross-bar" : "stroke"
      }, ${s.pts.length} point${s.pts.length === 1 ? "" : "s"}`;
      pick.addEventListener("click", () => {
        this.selected = this.selected === i ? null : i;
        this.refresh();
      });
      const up = document.createElement("button");
      up.type = "button";
      up.textContent = "Up";
      up.setAttribute("aria-label", `Move stroke ${i + 1} up`);
      up.disabled = i === 0;
      up.addEventListener("click", () => this.move(i, -1));
      const down = document.createElement("button");
      down.type = "button";
      down.textContent = "Down";
      down.setAttribute("aria-label", `Move stroke ${i + 1} down`);
      down.disabled = i === this.strokes.length - 1;
      down.addEventListener("click", () => this.move(i, 1));
      li.append(pick, up, down);
      ol.append(li);
    });
    $<HTMLButtonElement>("ed-undo").disabled = this.#undo.length === 0;
    $<HTMLButtonElement>("ed-clear").disabled = this.strokes.length === 0;
    $<HTMLButtonElement>("ed-reverse").disabled = this.strokes.length === 0;
    $<HTMLButtonElement>("ed-delete").disabled = this.strokes.length === 0;
    $<HTMLButtonElement>("ed-builtin").disabled = !this.builtin;
  }

  #draw() {
    const b = this.#band;
    if (!b) return;
    const ctx = this.#canvas.getContext("2d")!;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    ctx.restore();
    drawGuides(ctx, b, {
      strong: cssVar("--guide-strong", "#9fb4cf"),
      faint: cssVar("--guide-faint", "#d6dfeb"),
    }, this.font.slant);
    // The glyph, faint, with its skeleton.
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = cssVar("--model-ink", "#222");
    ctx.font = fontString(this.font, b.xh / this.font.xRatio);
    ctx.textBaseline = "alphabetic";
    ctx.fillText(this.char, b.left, b.baseline);
    ctx.restore();
    if (this.#target) {
      ctx.save();
      ctx.fillStyle = cssVar("--ink-faint", "#868c94");
      ctx.globalAlpha = 0.5;
      for (const p of targetPoints(this.#target)) {
        const [x, y] = this.toScreen(p);
        ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
      }
      ctx.restore();
    }
    const accent = cssVar("--accent", "#1f3a5f");
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    this.strokes.forEach((s, i) => {
      const pts = strokePoints(s);
      const sel = this.selected === i;
      ctx.strokeStyle = accent;
      ctx.fillStyle = accent;
      ctx.globalAlpha = sel ? 1 : 0.7;
      ctx.lineWidth = sel ? 5 : 3;
      if (s.kind !== "dot" && pts.length > 1) {
        ctx.beginPath();
        pts.forEach((p, k) => {
          const [x, y] = this.toScreen(p);
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        const a = arrowAt(pts, 0.6);
        if (a) {
          const [ax, ay] = this.toScreen(a.at);
          let dx = a.dir.u - this.#tan * a.dir.v, dy = a.dir.v;
          const l = Math.hypot(dx, dy) || 1;
          dx /= l;
          dy /= l;
          ctx.beginPath();
          ctx.moveTo(ax + dx * 10, ay + dy * 10);
          ctx.lineTo(ax - dx * 6 - dy * 7, ay - dy * 6 + dx * 7);
          ctx.lineTo(ax - dx * 6 + dy * 7, ay - dy * 6 - dx * 7);
          ctx.closePath();
          ctx.fill();
        }
      }
      if (pts.length) {
        const [sx, sy] = this.toScreen(pts[0]);
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(sx, sy, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = cssVar("--paper", "#fff");
        ctx.font = "600 12px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), sx, sy + 0.5);
      }
    });
    if (this.#live && this.#live.length > 1) {
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = cssVar("--pen-ink", "#14213d");
      ctx.lineWidth = 3;
      ctx.beginPath();
      this.#live.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
    }
    ctx.restore();
  }
}

main();
