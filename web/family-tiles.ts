// The toolbar's family tiles: the favourite fonts in order, then a "More…" tile that opens the
// Fonts page. The catalogue's tiles are in the page already (hidden unless favourite); a Google
// family's tile is made here. The selected font always has a tile, favourite or not, so removing
// it from the favourites never changes what is selected. A Google family that has an italic gets
// Regular and Italic chips.

import { catalogFromDocument, loadRecord, resolved } from "./favourites.ts";
import { familyList, loadTileFont } from "./googlefont.ts";
import { googlePrefix, type Settings, type Toolbar } from "./settings.ts";

interface CatalogueFile {
  families?: Array<{ family?: unknown; italic?: unknown }>;
}

/** Families of the curated list that have an italic style, by name (empty until/unless it loads). */
function italicFamilies(url: string): Promise<Set<string>> {
  return fetch(url).then((r) => r.ok ? r.json() : null).then((j: CatalogueFile | null) => {
    const out = new Set<string>();
    for (const f of j?.families ?? []) {
      if (typeof f.family === "string" && f.italic === true) out.add(f.family);
    }
    return out;
  }).catch(() => new Set<string>());
}

export function attachFamilyTiles(toolbar: Toolbar): { refresh(): void } {
  const box = document.getElementById("family-tiles");
  const chips = document.querySelector(".variant-chips");
  if (!box || !chips) return { refresh() {} };
  const groups = catalogFromDocument();
  const more = box.querySelector<HTMLElement>(".tile-more");
  const builtin = new Map<string, HTMLElement>();
  for (const el of box.querySelectorAll<HTMLElement>("[data-catalog-group]")) {
    builtin.set(el.dataset.catalogGroup ?? "", el);
  }
  const google = new Map<string, HTMLElement>();
  let italics: Set<string> | null = null;
  let italicsAsked = false;
  let drawn = "";

  const googleTile = (name: string): HTMLElement => {
    let el = google.get(name);
    if (el) return el;
    el = document.createElement("label");
    el.className = "tile";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "family";
    input.value = googlePrefix + name;
    const art = document.createElement("span");
    art.className = "tile-art";
    art.setAttribute("aria-hidden", "true");
    art.textContent = "an";
    const label = document.createElement("span");
    label.className = "tile-label";
    label.textContent = name;
    el.append(input, art, label);
    void loadTileFont(name).then((ok) => {
      if (ok) art.style.fontFamily = familyList(name);
    });
    google.set(name, el);
    return el;
  };

  const render = () => {
    const s: Settings = toolbar.read();
    const rec = loadRecord(groups);
    const keys = resolved(rec, groups).map((r) => ({ key: r.key, kind: r.kind, name: r.name }));
    // The selected font is always shown, favourite or not.
    const current = s.group.startsWith(googlePrefix)
      ? (s.customFont ? { key: s.group, kind: "google" as const, name: s.customFont } : null)
      : builtin.has(s.group)
      ? { key: `builtin:${s.group}`, kind: "builtin" as const, name: s.group }
      : null;
    if (current && !keys.some((k) => k.key === current.key)) keys.push(current);

    const wantItalics = s.group.startsWith(googlePrefix) && italics !== null &&
      italics.has(s.customFont);
    const sig = JSON.stringify([keys.map((k) => k.key), s.group, wantItalics]);
    if (sig === drawn) return;
    drawn = sig;

    const focused = document.activeElement;
    const shown: HTMLElement[] = [];
    const used = new Set<string>();
    for (const k of keys) {
      const el = k.kind === "builtin" ? builtin.get(k.name) : googleTile(k.name);
      if (!el) continue;
      if (k.kind === "google") used.add(k.name);
      el.hidden = false;
      shown.push(el);
    }
    for (const el of builtin.values()) if (!shown.includes(el)) el.hidden = true;
    for (const [name, el] of google) {
      if (!used.has(name)) {
        el.remove();
        google.delete(name);
      }
    }
    box.append(...shown);
    if (more) box.append(more);
    for (const el of box.querySelectorAll<HTMLInputElement>('input[name="family"]')) {
      el.checked = el.value === s.group;
    }

    // Moving nodes drops focus; give it back to what had it.
    if (
      focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused
    ) {
      focused.focus();
    }
    for (const el of chips.querySelectorAll(".chip-google")) el.remove();
    if (s.group.startsWith(googlePrefix) && s.customFont) {
      if (italics === null && !italicsAsked) {
        italicsAsked = true;
        const url = box.dataset.catalogue;
        if (url) {
          void italicFamilies(url).then((set) => {
            italics = set;
            drawn = "";
            render();
          });
        }
      }
      if (wantItalics) {
        for (const [value, label] of [["normal", "Regular"], ["italic", "Italic"]]) {
          const chip = document.createElement("label");
          chip.className = "chip chip-google";
          chip.dataset.group = s.group;
          const input = document.createElement("input");
          input.type = "radio";
          input.name = "styleChip";
          input.value = value;
          input.checked = value === s.style;
          const name = document.createElement("span");
          name.className = "chip-name";
          name.textContent = label;
          if (value === "italic") name.style.fontStyle = "italic";
          chip.append(input, name);
          chips.append(chip);
        }
      }
    }
  };

  toolbar.onChange(render);
  render();
  const refresh = () => {
    drawn = "";
    render();
  };
  // Favourites edited on the Fonts page in another tab, or coming back to this page from it.
  addEventListener("storage", refresh);
  addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) refresh();
  });
  return { refresh };
}
