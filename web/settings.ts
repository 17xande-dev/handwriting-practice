// The toolbar: reads the pen and paper settings from the form, keeps the
// controls' illustrations in step, and remembers the choice on this device.
// Remembering is a convenience only, so every storage call tolerates failure
// (private browsing, blocked storage).

import type { Pen } from "./ink.ts";
import { pressureUpperDefault, pressureUpperRange } from "./pens.ts";

/** A Google family's tile and chips are filed under "google:<family>". */
export const googlePrefix = "google:";

export interface Settings {
  pen: Pen;
  /** x-height in CSS pixels. */
  xh: number;
  /** Model font id from the catalogue, or "custom" for a Google font by name. */
  model: string;
  /** The family the model belongs to, as the picker's tiles name it ("google:<family>" for a Google font). */
  group: string;
  /** CSS font-style of the model: "normal" or "italic". */
  style: string;
  /** Slope of the model font, degrees right of vertical. */
  slant: number;
  /** The Google Fonts family typed in for the "custom" model. */
  customFont: string;
  touchWrites: boolean;
  /** The raw pressure at which a stroke reaches full pressure (light 0.3 ... firm 0.7). */
  pressure: number;
}

const storageKey = "italic-practice:toolbar:v2";
/** The last variant chosen in each family, so going back to a family returns to it. */
const variantsKey = "italic-practice:variants";

export class Toolbar {
  #form: HTMLFormElement;
  #listeners: Array<(now: Settings, before: Settings) => void> = [];
  #choosers: Array<(s: Settings) => void> = [];
  #last: Settings;

  constructor(form: HTMLFormElement) {
    this.#form = form;
    this.#restore();
    this.#sync();
    this.#last = this.read();
    // The variant the page opens with counts as used, so leaving its family
    // and coming back returns to it.
    this.#rememberVariant(this.#last);
    // The form never submits: Enter in a field would otherwise reload the page.
    form.addEventListener("submit", (e) => e.preventDefault());
    // Some controls (the model picker) sit outside the form and join it with
    // form="toolbar"; their events don't bubble through the form, so listen
    // on the document and keep those that belong to it.
    document.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement | null;
      if (t?.form === form) this.changed();
    });
    // Choosing a family tile chooses a variant within it: the one last used
    // in that family, or its first. The tiles aren't part of the form, and
    // which one is lit always follows the chosen variant (see #sync).
    // The favourites' tiles and chips come and go, so listen on the document.
    document.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement | null;
      if (t?.name === "family") this.#chooseFamily(t.value);
      else if (t?.name === "styleChip") this.#chooseStyle(t.value);
    });
  }

  /** Called after the person picks a Google family or one of its styles (not when they type a name). */
  onChoose(fn: (s: Settings) => void) {
    this.#choosers.push(fn);
  }

  #chooseStyle(style: string) {
    this.set("customStyle", style === "italic" ? "italic" : "normal");
    for (const fn of this.#choosers) fn(this.read());
  }

  #chooseFamily(group: string) {
    if (group.startsWith(googlePrefix)) {
      const remembered = this.#rememberedVariants()[group];
      const custom = this.#inputs().find((e) => e.name === "model" && e.value === "custom");
      const name = this.#form.elements.namedItem("customFont");
      const style = this.#form.elements.namedItem("customStyle");
      if (!custom || !(name instanceof HTMLInputElement)) return;
      custom.checked = true;
      name.value = group.slice(googlePrefix.length);
      if (style instanceof HTMLInputElement) {
        style.value = remembered === "italic" ? "italic" : "normal";
      }
      this.changed();
      for (const fn of this.#choosers) fn(this.read());
      return;
    }
    const variants = this.#inputs().filter((e) => e.name === "model" && e.dataset.group === group);
    if (variants.length === 0) return;
    const remembered = this.#rememberedVariants()[group];
    const pick = variants.find((e) => e.value === remembered) ?? variants[0];
    pick.checked = true;
    this.changed();
  }

  #rememberedVariants(): Record<string, string> {
    try {
      const v = JSON.parse(localStorage.getItem(variantsKey) ?? "{}");
      return typeof v === "object" && v !== null ? v : {};
    } catch {
      return {};
    }
  }

  #rememberVariant(s: Settings) {
    if (!s.group) return;
    try {
      localStorage.setItem(
        variantsKey,
        JSON.stringify({
          ...this.#rememberedVariants(),
          [s.group]: s.model === "custom" ? s.style : s.model,
        }),
      );
    } catch {
      // Not remembered; the family's first variant is chosen next time.
    }
  }

  /** Re-read the settings and tell listeners; also used after a script sets a value. */
  changed() {
    this.#sync();
    this.#save();
    const now = this.read();
    this.#rememberVariant(now);
    const before = this.#last;
    this.#last = now;
    for (const fn of this.#listeners) fn(now, before);
  }

  /** Set a control's value from script (which fires no input event) and notify. */
  set(name: string, value: string) {
    const el = this.#form.elements.namedItem(name);
    if (el instanceof HTMLInputElement) {
      el.value = value;
      this.changed();
    }
  }

  /** Every input belonging to the form, including those outside it. */
  #inputs(): HTMLInputElement[] {
    return [...this.#form.elements].filter((e): e is HTMLInputElement =>
      e instanceof HTMLInputElement && e.name !== ""
    );
  }

  onChange(fn: (now: Settings, before: Settings) => void) {
    this.#listeners.push(fn);
  }

  read(): Settings {
    const f = new FormData(this.#form);
    const num = (k: string, d: number) => {
      const v = f.get(k);
      const n = Number(v);
      return v !== null && v !== "" && Number.isFinite(n) ? n : d;
    };
    const kind = f.get("pen");
    const pen: Pen = kind === "edged"
      ? {
        kind: "edged",
        nibs: num("nibs", 5),
        angle: num("angle", 45),
        ...(f.get("swell") === "on" ? { swell: true } : {}),
      }
      : kind === "pointed"
      ? { kind: "pointed", weight: num("weight", 3) }
      : kind === "pencil"
      ? { kind: "pencil", lead: num("lead", 3) }
      : { kind: "monoline", weight: num("weight", 3) };
    const models = this.#inputs().filter((e) => e.name === "model");
    const model = models.find((e) => e.checked) ?? models[0];
    const custom = model?.value === "custom";
    const customFont = String(f.get("customFont") ?? "").trim().replace(/\s+/g, " ");
    return {
      pen,
      xh: num("xh", 32),
      model: model?.value ?? "",
      // A Google font's tile is named for its family; the one "custom" model serves them all.
      group: custom ? `${googlePrefix}${customFont}` : model?.dataset.group ?? "",
      style: custom
        ? (f.get("customStyle") === "italic" ? "italic" : "normal")
        : model?.dataset.style ?? "normal",
      slant: custom ? num("customSlant", 0) : Number(model?.dataset.slant ?? 0) || 0,
      customFont,
      touchWrites: f.get("finger") === "on",
      pressure: Math.min(
        pressureUpperRange[1],
        Math.max(pressureUpperRange[0], num("pressure", pressureUpperDefault)),
      ),
    };
  }

  /** Show only the controls for the chosen pen, and update their illustrations. */
  #sync() {
    const s = this.read();
    for (const el of this.#form.querySelectorAll<HTMLElement>("[data-pen]")) {
      // A control may serve several pens: data-pen="monoline pointed".
      el.hidden = !(el.dataset.pen ?? "").split(" ").includes(s.pen.kind);
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-model]")) {
      el.hidden = el.dataset.model !== s.model;
    }
    // Light the chosen variant's family tile, and show only that family's chips.
    for (const tile of document.querySelectorAll<HTMLInputElement>('input[name="family"]')) {
      tile.checked = tile.value === s.group;
    }
    for (const chip of document.querySelectorAll<HTMLElement>(".chip[data-group]")) {
      chip.hidden = chip.dataset.group !== s.group;
    }
    // A Google family's style chips (Regular, Italic) follow the chosen style.
    for (const chip of document.querySelectorAll<HTMLInputElement>('input[name="styleChip"]')) {
      chip.checked = s.model === "custom" && chip.value === s.style;
    }
    const slantOut = document.getElementById("custom-slant-out");
    if (slantOut instanceof HTMLOutputElement && s.model === "custom") {
      slantOut.value = `${s.slant}°`;
    }
    const out = (name: string, text: string) => {
      const o = this.#form.elements.namedItem(name);
      if (o instanceof HTMLOutputElement) o.value = text;
    };
    if (s.pen.kind === "pencil") out("leadOut", `lead ${s.pen.lead}`);
    out("pressureOut", s.pressure < 0.4 ? "light" : s.pressure > 0.55 ? "firm" : "medium");
    if (s.pen.kind === "edged") {
      out("nibsOut", `${s.pen.nibs} nibs`);
      out("angleOut", `${s.pen.angle}°`);
      // SVG rotation is clockwise and y points down, so negate for an
      // anticlockwise pen angle. An attribute, not a style, so the CSP allows it.
      this.#form.querySelector("#angle-nib")?.setAttribute("transform", `rotate(${-s.pen.angle})`);
    }
  }

  #save() {
    const values: Record<string, string> = {};
    for (const [k, v] of new FormData(this.#form)) values[k] = String(v);
    try {
      localStorage.setItem(storageKey, JSON.stringify(values));
    } catch {
      // Storage unavailable: the settings just won't be remembered.
    }
  }

  #restore() {
    let values: unknown;
    try {
      values = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    } catch {
      return;
    }
    if (typeof values !== "object" || values === null) return;
    const stored = values as Record<string, unknown>;
    // Radios are only changed if the stored value still exists, so a font
    // dropped from the catalogue leaves the default selected, not nothing.
    const radios = new Map<string, HTMLInputElement[]>();
    for (const el of this.#inputs()) {
      const v = stored[el.name];
      if (el.type === "radio") radios.set(el.name, [...(radios.get(el.name) ?? []), el]);
      else if (el.type === "checkbox") el.checked = v === "on";
      else if (typeof v === "string") el.value = v;
    }
    for (const [name, els] of radios) {
      const match = els.find((el) => el.value === stored[name]);
      if (match) match.checked = true;
    }
  }
}
