// The toolbar: reads the pen settings from the form, keeps the visible
// controls in step with the chosen pen, and remembers the choice on this
// device. Remembering is a convenience only, so every storage call tolerates
// failure (private browsing, blocked storage).

import type { Pen } from "./ink.ts";

export interface Settings {
  pen: Pen;
  /** x-height in CSS pixels. */
  xh: number;
  touchWrites: boolean;
}

const sizes: Record<string, number> = { s: 24, m: 32, l: 44 };
const storageKey = "italic-practice:toolbar";

export class Toolbar {
  #form: HTMLFormElement;
  #listeners: Array<(s: Settings, sizeChanged: boolean) => void> = [];
  #xh = 0;

  constructor(form: HTMLFormElement) {
    this.#form = form;
    this.#restore();
    this.#sync();
    this.#xh = this.read().xh;
    // The form never submits: Enter in a field would otherwise reload the page.
    form.addEventListener("submit", (e) => e.preventDefault());
    form.addEventListener("input", () => {
      this.#sync();
      this.#save();
      const s = this.read();
      const sizeChanged = s.xh !== this.#xh;
      this.#xh = s.xh;
      for (const fn of this.#listeners) fn(s, sizeChanged);
    });
  }

  onChange(fn: (s: Settings, sizeChanged: boolean) => void) {
    this.#listeners.push(fn);
  }

  read(): Settings {
    const f = new FormData(this.#form);
    const num = (k: string, d: number) => {
      const n = Number(f.get(k));
      return Number.isFinite(n) && n > 0 ? n : d;
    };
    const pen: Pen = f.get("pen") === "edged"
      ? { kind: "edged", nibs: num("nibs", 5), angle: num("angle", 45) }
      : { kind: "monoline", weight: num("weight", 3) };
    return {
      pen,
      xh: sizes[String(f.get("size"))] ?? sizes.m,
      touchWrites: f.get("finger") === "on",
    };
  }

  /** Show only the controls for the chosen pen, and echo slider values. */
  #sync() {
    const s = this.read();
    for (const el of this.#form.querySelectorAll<HTMLElement>("[data-pen]")) {
      el.hidden = el.dataset.pen !== s.pen.kind;
    }
    const out = (name: string, text: string) => {
      const o = this.#form.elements.namedItem(name);
      if (o instanceof HTMLOutputElement) o.value = text;
    };
    if (s.pen.kind === "edged") {
      out("nibsOut", `${s.pen.nibs} nibs`);
      out("angleOut", `${s.pen.angle}°`);
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
    let values: Record<string, unknown>;
    try {
      values = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    } catch {
      return;
    }
    if (typeof values !== "object" || values === null) return;
    for (const el of this.#form.querySelectorAll<HTMLInputElement>("input[name]")) {
      const v = values[el.name];
      if (el.type === "checkbox") el.checked = v === "on";
      else if (el.type === "radio") {
        if (typeof v === "string") el.checked = el.value === v;
      } else if (typeof v === "string") el.value = v;
    }
  }
}
