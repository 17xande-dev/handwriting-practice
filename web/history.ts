// One undo history for the whole worksheet. Every stroke written and every
// line cleared is an edit; Undo and Redo walk back and forth through them in
// order, whichever line they were on.

export interface Edit {
  undo(): void;
  redo(): void;
  /** The line the edit was on, brought into view when it is undone or redone. */
  where?: Element;
}

export class History {
  #done: Edit[] = [];
  #undone: Edit[] = [];
  #listeners: Array<() => void> = [];

  /** Record a new edit. Anything undone before it can no longer be redone. */
  push(e: Edit) {
    this.#done.push(e);
    this.#undone = [];
    this.#notify();
  }

  undo(): boolean {
    const e = this.#done.pop();
    if (!e) return false;
    e.undo();
    this.#undone.push(e);
    this.#reveal(e);
    this.#notify();
    return true;
  }

  redo(): boolean {
    const e = this.#undone.pop();
    if (!e) return false;
    e.redo();
    this.#done.push(e);
    this.#reveal(e);
    this.#notify();
    return true;
  }

  get canUndo(): boolean {
    return this.#done.length > 0;
  }

  get canRedo(): boolean {
    return this.#undone.length > 0;
  }

  onChange(fn: () => void) {
    this.#listeners.push(fn);
  }

  #notify() {
    for (const fn of this.#listeners) fn();
  }

  /** An undo on a line scrolled out of view would otherwise look like nothing happened. */
  #reveal(e: Edit) {
    const el = e.where;
    if (!el || typeof el.getBoundingClientRect !== "function") return;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > globalThis.innerHeight) {
      // Instant, not smooth: an animated scroll still running when the
      // fingers start scrolling again fights them, and the page jumps about.
      el.scrollIntoView({ block: "center", behavior: "instant" });
    }
  }
}
