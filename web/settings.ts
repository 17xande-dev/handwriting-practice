// The toolbar: reads the pen and paper settings from the form, keeps the
// controls' illustrations in step, and remembers the choice on this device.
// Remembering is a convenience only, so every storage call tolerates failure
// (private browsing, blocked storage).

import type { Pen } from "./ink.ts";

export interface Settings {
  pen: Pen;
  /** x-height in CSS pixels. */
  xh: number;
  /** Model font id from the catalogue, or "custom" for a Google font by name. */
  model: string;
  /** CSS font-style of the model: "normal" or "italic". */
  style: string;
  /** Slope of the model font, degrees right of vertical. */
  slant: number;
  /** The Google Fonts family typed in for the "custom" model. */
  customFont: string;
  touchWrites: boolean;
}

const storageKey = "italic-practice:toolbar:v2";

export class Toolbar {
  #form: HTMLFormElement;
  #listeners: Array<(now: Settings, before: Settings) => void> = [];
  #last: Settings;

  constructor(form: HTMLFormElement) {
    this.#form = form;
    this.#restore();
    this.#sync();
    this.#last = this.read();
    // The form never submits: Enter in a field would otherwise reload the page.
    form.addEventListener("submit", (e) => e.preventDefault());
    // Some controls (the model picker) sit outside the form and join it with
    // form="toolbar"; their events don't bubble through the form, so listen
    // on the document and keep those that belong to it.
    document.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement | null;
      if (t?.form === form) this.changed();
    });
  }

  /** Re-read the settings and tell listeners; also used after a script sets a value. */
  changed() {
    this.#sync();
    this.#save();
    const now = this.read();
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
    const pen: Pen = f.get("pen") === "edged"
      ? { kind: "edged", nibs: num("nibs", 5), angle: num("angle", 45) }
      : { kind: "monoline", weight: num("weight", 3) };
    const models = this.#inputs().filter((e) => e.name === "model");
    const model = models.find((e) => e.checked) ?? models[0];
    const custom = model?.value === "custom";
    return {
      pen,
      xh: num("xh", 32),
      model: model?.value ?? "",
      style: model?.dataset.style ?? "normal",
      slant: custom ? num("customSlant", 0) : Number(model?.dataset.slant ?? 0) || 0,
      customFont: String(f.get("customFont") ?? "").trim(),
      touchWrites: f.get("finger") === "on",
    };
  }

  /** Show only the controls for the chosen pen, and update their illustrations. */
  #sync() {
    const s = this.read();
    for (const el of this.#form.querySelectorAll<HTMLElement>("[data-pen]")) {
      el.hidden = el.dataset.pen !== s.pen.kind;
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-model]")) {
      el.hidden = el.dataset.model !== s.model;
    }
    const slantOut = document.getElementById("custom-slant-out");
    if (slantOut instanceof HTMLOutputElement && s.model === "custom") {
      slantOut.value = `${s.slant}°`;
    }
    const out = (name: string, text: string) => {
      const o = this.#form.elements.namedItem(name);
      if (o instanceof HTMLOutputElement) o.value = text;
    };
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
