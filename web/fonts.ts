// The Fonts page (/fonts): the library of bundled models and Google handwriting fonts, where a
// person stars the ones they want in the worksheet toolbar and puts them in order. Each entry
// shows a live sample, loaded only when it scrolls into view, and, where stroke definitions
// exist for the font, how much of the character set they cover.

import {
  catalogFromDocument,
  type CatalogGroup,
  favouritesKey,
  type FavouritesRecord,
  isFavourite,
  loadRecord,
  move,
  parseRecord,
  resetRecord,
  type Resolved,
  resolved,
  saveRecord,
  type Target,
  toggle,
} from "./favourites.ts";
import { familyList, loadPreviewFont, validFamilyName } from "./googlefont.ts";
import { DeviceStore } from "./progress-store.ts";
import { installSync } from "./sync-triggers.ts";
import { StrokeModels } from "./stroke-lookup.ts";
import { userGlyphs } from "./stroke-defs.ts";
import {
  allGlyphChars,
  builtinModelIds,
  coveragePercent,
  glyphStatus,
  loadBuiltin,
  strokesFontID,
} from "./stroke-models.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sample = "minimum quick";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

interface GoogleFamily {
  family: string;
  italic: boolean;
}

function main() {
  const root = document.getElementById("fonts-page");
  if (!root) return;
  const groups: CatalogGroup[] = catalogFromDocument();
  let rec: FavouritesRecord = loadRecord(groups);
  const store = new DeviceStore();
  // Signed in, the favourites are a `prefs` record: synced after every edit, and a newer one from
  // another device replaces this list (greater ts wins).
  const syncer = installSync(store, {
    onResult: (r) => {
      if (r.status === "ok" && r.changed) {
        rec = loadRecord(groups);
        renderFavourites();
      }
    },
  });
  /** Stroke coverage in whole percent, by "builtin:<font id>" or "google:<family>"; absent means none. */
  const coverage = new Map<string, number>();
  const googleNames = new Set<string>();

  const say = (text: string) => {
    $("fonts-status").textContent = text;
  };

  // ---- lazy samples ------------------------------------------------------------------------
  const observer = "IntersectionObserver" in globalThis
    ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer?.unobserve(e.target);
        const node = e.target as HTMLElement;
        const family = node.dataset.family ?? "";
        void loadPreviewFont(family, sample).then((ok) => {
          node.classList.remove("pending");
          if (ok) node.style.fontFamily = familyList(family);
          else node.classList.add("unavailable");
        });
      }
    }, { rootMargin: "300px" })
    : null;

  /** A sample of a Google family, fetched when it nears the screen. */
  function googleSample(family: string): HTMLElement {
    const p = el("span", "font-preview pending", sample);
    p.dataset.family = family;
    p.setAttribute("aria-hidden", "true");
    if (observer) observer.observe(p);
    else void loadPreviewFont(family, sample).then(() => (p.style.fontFamily = familyList(family)));
    return p;
  }

  // ---- stars -------------------------------------------------------------------------------
  const targetOf = (b: HTMLElement): Target =>
    b.dataset.kind === "builtin"
      ? { kind: "builtin", group: b.dataset.name ?? "" }
      : { kind: "google", family: b.dataset.name ?? "", custom: b.dataset.custom === "1" };

  const paintStars = () => {
    for (const b of document.querySelectorAll<HTMLButtonElement>(".star")) {
      const on = isFavourite(rec, targetOf(b), groups);
      b.setAttribute("aria-pressed", String(on));
      const glyph = b.firstElementChild;
      if (glyph) glyph.textContent = on ? "★" : "☆";
    }
  };

  function starButton(kind: "builtin" | "google", name: string, custom = false): HTMLButtonElement {
    const b = el("button", "star");
    b.type = "button";
    b.dataset.kind = kind;
    b.dataset.name = name;
    if (custom) b.dataset.custom = "1";
    b.setAttribute("aria-label", `Favourite: ${name}`);
    b.append(el("span", undefined, "☆"));
    b.firstElementChild?.setAttribute("aria-hidden", "true");
    return b;
  }

  // ---- coverage badges -----------------------------------------------------------------------
  const percentOf = (r: Resolved): number => {
    if (r.kind === "google") return coverage.get(`google:${r.name}`) ?? 0;
    const g = groups.find((g) => g.name === r.name);
    return Math.max(0, ...(g?.ids ?? []).map((id) => coverage.get(`builtin:${id}`) ?? 0));
  };
  const badge = (b: HTMLElement, pct: number) => {
    b.hidden = pct <= 0;
    b.textContent = `${pct}% strokes`;
    b.title = "How much of the character set has stroke order and direction defined";
  };
  const paintBadges = () => {
    for (const v of document.querySelectorAll<HTMLElement>(".font-variant[data-font]")) {
      const b = v.querySelector<HTMLElement>(".coverage-badge");
      if (b) badge(b, coverage.get(`builtin:${v.dataset.font}`) ?? 0);
    }
    for (const b of document.querySelectorAll<HTMLElement>(".coverage-badge[data-family]")) {
      badge(b, coverage.get(`google:${b.dataset.family}`) ?? 0);
    }
    for (const b of document.querySelectorAll<HTMLElement>(".coverage-badge[data-group]")) {
      const g = groups.find((g) => g.name === b.dataset.group);
      badge(b, Math.max(0, ...(g?.ids ?? []).map((id) => coverage.get(`builtin:${id}`) ?? 0)));
    }
  };

  async function loadCoverage() {
    try {
      const models = new StrokeModels(store);
      await models.refresh();
      const records = await store.allStrokesRecords();
      const withUser = new Set(records.map((r) => String(r.model)));
      const pct = async (model: string, fontId: string) => {
        const built = builtinModelIds.includes(model) ? await loadBuiltin(model) : null;
        if (!built && !withUser.has(fontId)) return 0;
        const mine = userGlyphs(models.defs(fontId));
        return coveragePercent(
          allGlyphChars.map((c) => glyphStatus(mine[c], built?.glyphs[c])),
        );
      };
      for (const g of groups) {
        for (const id of g.ids) coverage.set(`builtin:${id}`, await pct(id, id));
      }
      for (const fontId of withUser) {
        if (!fontId.startsWith("custom-")) continue;
        for (const name of knownFamilies()) {
          if (strokesFontID("custom", name) === fontId) {
            coverage.set(`google:${name}`, await pct("custom", fontId));
          }
        }
      }
    } catch {
      // No storage: no badges.
    }
    paintBadges();
    renderFavourites();
  }

  /** Every Google family named on the page, to match stroke records filed under custom-<slug>. */
  const knownFamilies = (): Set<string> => {
    const out = new Set(googleNames);
    for (const f of rec.favourites) {
      if (f.kind === "google" || f.kind === "custom") out.add(f.family);
    }
    return out;
  };

  // ---- the favourites, in order --------------------------------------------------------------
  function renderFavourites(focus?: { key: string; dir: "up" | "down" }) {
    const list = $("fav-list");
    const items = resolved(rec, groups);
    list.replaceChildren();
    $("fav-empty").hidden = items.length > 0;
    items.forEach((r, i) => {
      const li = el("li", "font-entry");
      li.dataset.key = r.key;
      const star = starButton(r.kind, r.name, r.entry.kind === "custom");
      const body = el("div", "font-entry-body");
      body.append(el("span", "font-entry-name", r.name));
      const line = el("div", "font-variant");
      if (r.kind === "builtin") {
        const g = groups.find((g) => g.name === r.name);
        const p = el("span", `font-preview font-${g?.ids[0] ?? ""}`, sample);
        p.setAttribute("aria-hidden", "true");
        line.append(p);
      } else {
        line.append(googleSample(r.name));
      }
      const b = el("span", "coverage-badge");
      badge(b, percentOf(r));
      line.append(b);
      body.append(line);
      const actions = el("div", "font-entry-actions");
      for (const dir of ["up", "down"] as const) {
        const m = el("button", "move", dir === "up" ? "↑" : "↓");
        m.type = "button";
        m.dataset.key = r.key;
        m.dataset.dir = dir;
        m.setAttribute("aria-label", `Move ${r.name} ${dir}`);
        m.disabled = dir === "up" ? i === 0 : i === items.length - 1;
        actions.append(m);
      }
      li.append(star, body, actions);
      list.append(li);
    });
    paintStars();
    if (focus) {
      const row = [...list.children].find((c) => (c as HTMLElement).dataset.key === focus.key);
      const want = row?.querySelector<HTMLButtonElement>(`.move[data-dir="${focus.dir}"]`);
      const other = row?.querySelector<HTMLButtonElement>(".move:not(:disabled)");
      (want && !want.disabled ? want : other ?? row?.querySelector<HTMLElement>(".star"))?.focus();
    }
  }

  /** Keep an edit: remembered here, then shown everywhere. */
  function edit(next: FavouritesRecord) {
    if (next === rec) return;
    rec = next;
    // Kept in localStorage and queued for sync (nothing is sent while signed out).
    void store.saveFavourites(rec).then(() => syncer.now()).catch(() => saveRecord(rec));
  }

  {
    // Star toggles and moves are handled in one place for every list on the page.
    root.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLButtonElement>("button.star, button.move");
      if (!t) return;
      if (t.classList.contains("star")) {
        const target = targetOf(t);
        const was = isFavourite(rec, target, groups);
        const row = t.closest<HTMLElement>("#fav-list > li");
        const siblingKey = row?.nextElementSibling instanceof HTMLElement
          ? row.nextElementSibling.dataset.key
          : row?.previousElementSibling instanceof HTMLElement
          ? row.previousElementSibling.dataset.key
          : undefined;
        edit(toggle(rec, target, groups));
        say(`${t.dataset.name} ${was ? "removed from" : "added to"} your favourites.`);
        renderFavourites();
        if (row) {
          // The row that held focus is gone: continue at its neighbour, or at the heading.
          const next = siblingKey
            ? [...$("fav-list").children].find((c) => (c as HTMLElement).dataset.key === siblingKey)
              ?.querySelector<HTMLElement>(".star")
            : null;
          (next ?? $("fav-heading")).focus();
        }
        return;
      }
      const key = t.dataset.key ?? "";
      const dir = t.dataset.dir === "up" ? "up" : "down";
      const before = resolved(rec, groups).findIndex((r) => r.key === key);
      edit(move(rec, key, dir === "up" ? -1 : 1, groups));
      const after = resolved(rec, groups);
      const at = after.findIndex((r) => r.key === key);
      if (at !== before) {
        say(`${after[at].name} moved to position ${at + 1} of ${after.length}.`);
      }
      renderFavourites({ key, dir });
    });
  }

  $("fav-reset").addEventListener("click", () => {
    edit(resetRecord(rec, groups));
    say("Favourites reset to the defaults.");
    renderFavourites();
    $("fav-heading").focus();
  });

  // ---- the Google list -----------------------------------------------------------------------
  const bundledFamilies = new Set<string>();
  for (const li of document.querySelectorAll<HTMLElement>("#bundled-list [data-families]")) {
    for (const f of (li.dataset.families ?? "").split("|")) bundledFamilies.add(f);
  }

  function buildGoogle(families: GoogleFamily[]) {
    const list = $("google-list");
    const frag = document.createDocumentFragment();
    for (const f of families) {
      // The bundled models that are Google families are listed above; not twice.
      if (bundledFamilies.has(f.family)) continue;
      googleNames.add(f.family);
      const li = el("li", "font-entry");
      li.dataset.name = f.family.toLowerCase();
      const body = el("div", "font-entry-body");
      body.append(el("span", "font-entry-name", f.family));
      const line = el("div", "font-variant");
      line.append(googleSample(f.family));
      const b = el("span", "coverage-badge");
      b.dataset.family = f.family;
      b.hidden = true;
      line.append(b);
      body.append(line);
      if (f.italic) body.append(el("span", "font-entry-note", "has an italic"));
      li.append(starButton("google", f.family), body);
      frag.append(li);
    }
    list.append(frag);
    paintStars();
    paintBadges();
    applyFilter();
  }

  function applyFilter() {
    const q = $<HTMLInputElement>("google-filter").value.trim().toLowerCase();
    let shown = 0;
    const items = $("google-list").children;
    for (const li of items) {
      const hide = q !== "" && !(li as HTMLElement).dataset.name?.includes(q);
      (li as HTMLElement).hidden = hide;
      if (!hide) shown++;
    }
    $("google-count").textContent = items.length === 0
      ? ""
      : `${shown} of ${items.length} families`;
  }
  $("google-filter").addEventListener("input", applyFilter);

  fetch(root.dataset.catalogue ?? "").then((r) => r.ok ? r.json() : Promise.reject(r.status))
    .then((j: { families?: unknown }) => {
      const out: GoogleFamily[] = [];
      for (const f of Array.isArray(j.families) ? j.families : []) {
        if (typeof f?.family === "string" && validFamilyName(f.family)) {
          out.push({ family: f.family, italic: f.italic === true });
        }
      }
      buildGoogle(out);
      void loadCoverage();
    }).catch(() => {
      $("google-count").textContent = "The list of Google handwriting fonts could not be loaded.";
    });

  // ---- a family by name ----------------------------------------------------------------------
  const ownStatus = $("own-status");
  const addOwn = async () => {
    const name = $<HTMLInputElement>("own-family").value.trim().replace(/\s+/g, " ");
    if (!validFamilyName(name)) {
      ownStatus.textContent =
        "Use the family name as Google Fonts shows it: letters, numbers, spaces.";
      ownStatus.classList.add("error");
      return;
    }
    ownStatus.classList.remove("error");
    const target: Target = { kind: "google", family: name, custom: !googleNames.has(name) };
    if (isFavourite(rec, target, groups)) {
      ownStatus.textContent = `“${name}” is already a favourite.`;
      return;
    }
    ownStatus.textContent = `Checking “${name}”…`;
    if (!(await loadPreviewFont(name, sample))) {
      ownStatus.textContent = `Google Fonts has no family called “${name}”, or it didn't load.`;
      ownStatus.classList.add("error");
      return;
    }
    edit(toggle(rec, target, groups));
    ownStatus.textContent = `Added “${name}” to your favourites.`;
    $<HTMLInputElement>("own-family").value = "";
    renderFavourites();
  };
  $("own-add").addEventListener("click", () => void addOwn());
  $("own-family").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void addOwn();
    }
  });

  // Edited in another tab.
  addEventListener("storage", (e) => {
    if (e.key !== favouritesKey) return;
    rec = parseRecord(e.newValue) ?? loadRecord(groups);
    renderFavourites();
  });

  renderFavourites();
  void loadCoverage();
}

main();
