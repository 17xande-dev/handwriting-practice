/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import {
  type CatalogGroup,
  defaultRecord,
  favouritesKey,
  isFavourite,
  loadRecord,
  loadStored,
  mergeNewer,
  move,
  parseRecord,
  prefsId,
  resetRecord,
  resolved,
  saveRecord,
  toggle,
} from "./favourites.ts";

const groups: CatalogGroup[] = [
  { name: "Briem Hand", ids: ["briem-print", "briem-hand"] },
  { name: "Edu SA Beginner", ids: ["italic"] },
  { name: "Playwrite GB", ids: ["gb-s", "gb-s-italic", "gb-j", "gb-j-italic"] },
  { name: "Playwrite US", ids: ["upright"] },
];

class MemStorage {
  items = new Map<string, string>();
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
  removeItem(k: string) {
    this.items.delete(k);
  }
}

const names = (r: ReturnType<typeof defaultRecord>) => resolved(r, groups).map((x) => x.key);

Deno.test("defaults are the built-in families in catalogue order", () => {
  const d = defaultRecord(groups);
  assertEquals(d.ts, 0);
  assertEquals(names(d), [
    "builtin:Briem Hand",
    "builtin:Edu SA Beginner",
    "builtin:Playwrite GB",
    "builtin:Playwrite US",
  ]);
  assertEquals(d.favourites[0], { id: "briem-print", kind: "builtin", family: "Briem Hand" });
});

Deno.test("nothing stored gives the defaults; a saved record round-trips", () => {
  const s = new MemStorage();
  assertEquals(loadRecord(groups, s), defaultRecord(groups));
  const edited = toggle(defaultRecord(groups), { kind: "google", family: "Caveat" }, groups, 1000);
  assertEquals(saveRecord(edited, s), true);
  assertEquals(loadRecord(groups, s), edited);
  assertEquals(JSON.parse(s.items.get(favouritesKey)!).id, prefsId);
});

Deno.test("storage is read tolerantly", () => {
  const s = new MemStorage();
  for (const raw of ["", "not json", "null", "7", '"x"', "{}", '{"favourites":5}']) {
    s.items.set(favouritesKey, raw);
    assertEquals(loadStored(s), null, raw);
    assertEquals(loadRecord(groups, s), defaultRecord(groups), raw);
  }
  // A bare array is read; bad members are dropped, good ones kept.
  const r = parseRecord(JSON.stringify([
    { id: "italic", kind: "builtin", family: "Edu SA Beginner" },
    { id: 4 },
    "junk",
    { id: "google:../x", kind: "google", family: "../x" },
    { id: "google:Caveat", kind: "google", family: "Caveat" },
  ]));
  assertEquals(r?.favourites.map((f) => f.id), ["italic", "google:Caveat"]);
  assertEquals(r?.ts, 0);
  // An empty list is a real choice: no favourites.
  s.items.set(favouritesKey, '{"id":"prefs-favourites","ts":5,"v":1,"favourites":[]}');
  assertEquals(loadRecord(groups, s).favourites, []);
  // Storage that throws is the same as none.
  const broken = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {},
  };
  assertEquals(loadRecord(groups, broken), defaultRecord(groups));
  assertEquals(saveRecord(defaultRecord(groups), broken), false);
});

Deno.test("toggle adds at the end, removes, and bumps ts past the old one", () => {
  const d = defaultRecord(groups);
  const a = toggle(d, { kind: "google", family: "Caveat" }, groups, 500);
  assertEquals(names(a).at(-1), "google:Caveat");
  assertEquals(a.favourites.at(-1), { id: "google:Caveat", kind: "google", family: "Caveat" });
  assertEquals(a.ts, 500);
  assertEquals(isFavourite(a, { kind: "google", family: "Caveat" }, groups), true);
  const b = toggle(a, { kind: "google", family: "Caveat" }, groups, 100); // clock went backwards
  assertEquals(names(b), names(d));
  assertEquals(b.ts, 501);
  const c = toggle(b, { kind: "builtin", group: "Playwrite GB" }, groups, 600);
  assertEquals(names(c), ["builtin:Briem Hand", "builtin:Edu SA Beginner", "builtin:Playwrite US"]);
  const back = toggle(c, { kind: "builtin", group: "Playwrite GB" }, groups, 700);
  assertEquals(back.favourites.at(-1)?.id, "gb-s");
  const custom = toggle(d, { kind: "google", family: "My Font", custom: true }, groups, 1);
  assertEquals(custom.favourites.at(-1)?.kind, "custom");
  // A name that fails validation is refused.
  assertEquals(toggle(d, { kind: "google", family: "a;b" }, groups, 1), d);
});

Deno.test("a font recorded under any of its family's ids is the same tile", () => {
  const r = parseRecord(JSON.stringify({
    ts: 9,
    favourites: [{ id: "gb-j-italic", kind: "builtin", family: "Playwrite GB J" }],
  }))!;
  assertEquals(names(r), ["builtin:Playwrite GB"]);
  assertEquals(names(toggle(r, { kind: "builtin", group: "Playwrite GB" }, groups, 10)), []);
});

Deno.test("move swaps with the neighbour, and does nothing at the ends", () => {
  const d = defaultRecord(groups);
  const up = move(d, "builtin:Playwrite US", -1, groups, 50);
  assertEquals(names(up).slice(-2), ["builtin:Playwrite US", "builtin:Playwrite GB"]);
  assertEquals(up.ts, 50);
  const down = move(d, "builtin:Briem Hand", 1, groups, 50);
  assertEquals(names(down).slice(0, 2), ["builtin:Edu SA Beginner", "builtin:Briem Hand"]);
  assertEquals(move(d, "builtin:Briem Hand", -1, groups, 50), d);
  assertEquals(move(d, "builtin:Playwrite US", 1, groups, 50), d);
  assertEquals(move(d, "google:Nope", 1, groups, 50), d);
});

Deno.test("unknown members survive edits and keep their places", () => {
  const mystery = { id: "z", kind: "future", family: "Z", extra: { a: 1 } };
  const rec = {
    ...defaultRecord(groups),
    ts: 3,
    note: "kept",
    favourites: [
      { id: "italic", kind: "builtin", family: "Edu SA Beginner" },
      mystery,
      { id: "google:Caveat", kind: "google", family: "Caveat", variant: "italic" },
    ],
  };
  const saved = sanitizeRoundTrip(rec);
  assertEquals(saved.favourites[1], mystery);
  assertEquals(saved.note, "kept");
  const moved = move(saved, "google:Caveat", -1, groups, 10);
  assertEquals(moved.favourites.map((f) => f.id), ["google:Caveat", "z", "italic"]);
  assertEquals(moved.favourites[1], mystery);
  assertEquals(moved.favourites[0].variant, "italic");
  const removed = toggle(moved, { kind: "google", family: "Caveat" }, groups, 11);
  assertEquals(removed.favourites.map((f) => f.id), ["z", "italic"]);
});

function sanitizeRoundTrip(rec: ReturnType<typeof defaultRecord>) {
  return parseRecord(JSON.stringify(rec))!;
}

Deno.test("merge by ts: the greater wins, an equal or older one does not", () => {
  const local = { ...defaultRecord(groups), ts: 100 };
  const newer = { id: prefsId, ts: 200, v: 1, favourites: [] };
  const older = { id: prefsId, ts: 50, v: 1, favourites: [] };
  const equal = { id: prefsId, ts: 100, v: 1, favourites: [] };
  assertEquals(mergeNewer(local, newer), { rec: { ...newer }, took: true });
  assertEquals(mergeNewer(local, older), { rec: local, took: false });
  assertEquals(mergeNewer(local, equal), { rec: local, took: false });
  // Nothing edited here (no record, or defaults at ts 0): any real record wins.
  assertEquals(mergeNewer(null, newer).took, true);
  assertEquals(mergeNewer(defaultRecord(groups), newer).took, true);
  // Rubbish is never taken, and the local record is untouched.
  assertEquals(mergeNewer(local, { ts: 999, favourites: "x" }), { rec: local, took: false });
  assertEquals(mergeNewer(local, null).took, false);
  assertEquals(mergeNewer(null, { id: prefsId, ts: 0, favourites: [] }).took, false);
});

Deno.test("reset restores the defaults as a newer edit", () => {
  const edited = toggle(defaultRecord(groups), { kind: "google", family: "Caveat" }, groups, 900);
  const back = resetRecord(edited, groups, 100);
  assertEquals(names(back), names(defaultRecord(groups)));
  assertEquals(back.ts, 901);
});
