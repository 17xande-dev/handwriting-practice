// Favourite fonts: which model fonts the worksheet toolbar offers, in order.
//
// The list is a `prefs` record (docs/sync-api.md) that lives in localStorage as a cache and is
// synced when signed in: `{"id":"prefs-favourites","ts":<ms>,"v":1,"favourites":[{id,kind,family,
// variant?}]}`. Every edit bumps `ts`, and the greater `ts` wins when records meet. A favourite is
// a catalogue family (kind "builtin", `id` the font id of its first font, `family` the family
// tile's name) or a Google Fonts family (kind "google", or "custom" for a name that is not in the
// curated list; `id` is "google:<family>"). Members this code does not understand are kept, in
// place, and written back as they were. Storage is a convenience: every call tolerates failure.

import { validFamilyName } from "./googlefont.ts";

export const favouritesKey = "italic-practice:favourites:v1";
export const prefsId = "prefs-favourites";

export interface Favourite {
  id: string;
  kind: string;
  family: string;
  variant?: string;
  [field: string]: unknown;
}

export interface FavouritesRecord {
  id: string;
  ts: number;
  v: number;
  favourites: Favourite[];
  [field: string]: unknown;
}

/** A catalogue family and the ids of its fonts, in picker order. */
export interface CatalogGroup {
  name: string;
  ids: string[];
}

/** What a favourite stands for in the toolbar. */
export interface Resolved {
  /** "builtin:<group>" or "google:<family>": the same key for the same tile. */
  key: string;
  kind: "builtin" | "google";
  /** The group name, or the Google family. */
  name: string;
  entry: Favourite;
}

/** What to add or remove. */
export type Target =
  | { kind: "builtin"; group: string }
  | { kind: "google"; family: string; custom?: boolean };

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** The defaults: every catalogue family, in catalogue order (ts 0, so any real edit is newer). */
export function defaultRecord(groups: CatalogGroup[]): FavouritesRecord {
  return {
    id: prefsId,
    ts: 0,
    v: 1,
    favourites: groups.filter((g) => g.ids.length > 0).map((g) => ({
      id: g.ids[0],
      kind: "builtin",
      family: g.name,
    })),
  };
}

function sanitizeEntry(x: unknown): Favourite | null {
  if (!isObj(x)) return null;
  if (typeof x.id !== "string" || x.id === "" || x.id.length > 64) return null;
  if (typeof x.kind !== "string" || typeof x.family !== "string") return null;
  if ((x.kind === "google" || x.kind === "custom") && !validFamilyName(x.family)) return null;
  if (x.variant !== undefined && typeof x.variant !== "string") return null;
  return x as Favourite;
}

/**
 * A record from untrusted JSON (storage, a sync reply): null unless it has the shape. A bare array
 * of entries is read too. Entries that are malformed are dropped; the rest are kept as they are.
 */
export function sanitizeRecord(x: unknown): FavouritesRecord | null {
  const list = Array.isArray(x) ? x : isObj(x) ? x.favourites : undefined;
  if (!Array.isArray(list)) return null;
  const favourites: Favourite[] = [];
  for (const e of list.slice(0, 500)) {
    const f = sanitizeEntry(e);
    if (f) favourites.push(f);
  }
  const base = isObj(x) ? x : {};
  const ts = typeof base.ts === "number" && Number.isFinite(base.ts) && base.ts > 0 ? base.ts : 0;
  return { ...base, id: prefsId, ts, v: 1, favourites };
}

export function parseRecord(raw: string | null): FavouritesRecord | null {
  if (raw === null) return null;
  try {
    return sanitizeRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const local = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** The stored record, or null when there is none (or storage is unreadable). */
export function loadStored(storage: Store | null = local()): FavouritesRecord | null {
  try {
    return parseRecord(storage?.getItem(favouritesKey) ?? null);
  } catch {
    return null;
  }
}

/** The record in effect: the stored one, or the defaults. */
export function loadRecord(groups: CatalogGroup[], storage: Store | null = local()) {
  return loadStored(storage) ?? defaultRecord(groups);
}

export function saveRecord(rec: FavouritesRecord, storage: Store | null = local()): boolean {
  try {
    storage?.setItem(favouritesKey, JSON.stringify(rec));
    return storage !== null;
  } catch {
    return false; // Not remembered.
  }
}

export function clearRecord(storage: Store | null = local()): void {
  try {
    storage?.removeItem(favouritesKey);
  } catch {
    // Nothing to do.
  }
}

/** The tile a favourite stands for, or null for a kind (or catalogue font) this code does not know. */
export function resolveEntry(f: Favourite, groups: CatalogGroup[]): Resolved | null {
  if (f.kind === "builtin") {
    const g = groups.find((g) => g.ids.includes(f.id)) ?? groups.find((g) => g.name === f.family);
    return g ? { key: `builtin:${g.name}`, kind: "builtin", name: g.name, entry: f } : null;
  }
  if (f.kind === "google" || f.kind === "custom") {
    return { key: `google:${f.family}`, kind: "google", name: f.family, entry: f };
  }
  return null;
}

/** The toolbar's tiles: resolvable favourites in order, the first of any repeat kept. */
export function resolved(rec: FavouritesRecord, groups: CatalogGroup[]): Resolved[] {
  const seen = new Set<string>();
  const out: Resolved[] = [];
  for (const f of rec.favourites) {
    const r = resolveEntry(f, groups);
    if (r && !seen.has(r.key)) {
      seen.add(r.key);
      out.push(r);
    }
  }
  return out;
}

export const targetKey = (t: Target): string =>
  t.kind === "builtin" ? `builtin:${t.group}` : `google:${t.family}`;

export function isFavourite(rec: FavouritesRecord, t: Target, groups: CatalogGroup[]): boolean {
  return resolved(rec, groups).some((r) => r.key === targetKey(t));
}

/** A strictly later time than the record's own, so an edit always wins over what it replaced. */
const nextTs = (rec: FavouritesRecord, now: number) => Math.max(now, rec.ts + 1);

/** Star or unstar: removes every entry for the tile, or appends one. Other members stay. */
export function toggle(
  rec: FavouritesRecord,
  t: Target,
  groups: CatalogGroup[],
  now = Date.now(),
): FavouritesRecord {
  const key = targetKey(t);
  const present = rec.favourites.some((f) => resolveEntry(f, groups)?.key === key);
  let favourites: Favourite[];
  if (present) {
    favourites = rec.favourites.filter((f) => resolveEntry(f, groups)?.key !== key);
  } else if (t.kind === "builtin") {
    const g = groups.find((g) => g.name === t.group);
    if (!g || g.ids.length === 0) return rec;
    favourites = [...rec.favourites, { id: g.ids[0], kind: "builtin", family: g.name }];
  } else {
    if (!validFamilyName(t.family)) return rec;
    favourites = [...rec.favourites, {
      id: `google:${t.family}`,
      kind: t.custom ? "custom" : "google",
      family: t.family,
    }];
  }
  return { ...rec, ts: nextTs(rec, now), favourites };
}

/**
 * Move a favourite one place up (delta -1) or down (+1) among the visible ones. It swaps with its
 * neighbour; members that are not shown keep their places. At an end this changes nothing.
 */
export function move(
  rec: FavouritesRecord,
  key: string,
  delta: -1 | 1,
  groups: CatalogGroup[],
  now = Date.now(),
): FavouritesRecord {
  const shown: number[] = [];
  const seen = new Set<string>();
  rec.favourites.forEach((f, i) => {
    const r = resolveEntry(f, groups);
    if (r && !seen.has(r.key)) {
      seen.add(r.key);
      shown.push(i);
    }
  });
  const at = shown.findIndex((i) => resolveEntry(rec.favourites[i], groups)?.key === key);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= shown.length) return rec;
  const favourites = [...rec.favourites];
  [favourites[shown[at]], favourites[shown[to]]] = [favourites[shown[to]], favourites[shown[at]]];
  return { ...rec, ts: nextTs(rec, now), favourites };
}

/** Back to the catalogue's defaults, as an edit: later than the record it replaces, so it syncs. */
export function resetRecord(
  rec: FavouritesRecord,
  groups: CatalogGroup[],
  now = Date.now(),
): FavouritesRecord {
  return { ...defaultRecord(groups), ts: nextTs(rec, now) };
}

/**
 * Meet a record from the server: the incoming one is taken only if its ts is greater than the
 * local one's (no local record counts as ts 0). Returns what to keep, and whether it is the
 * incoming one.
 */
export function mergeNewer(
  local: FavouritesRecord | null,
  incoming: unknown,
): { rec: FavouritesRecord | null; took: boolean } {
  const inc = sanitizeRecord(incoming);
  if (inc && inc.ts > (local?.ts ?? 0)) return { rec: inc, took: true };
  return { rec: local, took: false };
}

/** The catalogue as the page lists it: elements with data-group and data-ids (space separated). */
export function catalogFromDocument(doc: Document = document): CatalogGroup[] {
  const out: CatalogGroup[] = [];
  for (const el of doc.querySelectorAll<HTMLElement>("[data-catalog-group]")) {
    const name = el.dataset.catalogGroup ?? "";
    if (name && !out.some((g) => g.name === name)) {
      out.push({ name, ids: (el.dataset.ids ?? "").split(" ").filter(Boolean) });
    }
  }
  return out;
}
