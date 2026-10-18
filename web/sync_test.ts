/// <reference lib="deno.ns" />

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  type CheckRecord,
  freshSyncState,
  hasIdentity,
  identify,
  type InkRecord,
  type Kind,
  type NewCheck,
  newId,
  planMerge,
  queueAdds,
  queueDeletes,
  type SyncEntry,
  type SyncState,
  type SyncStore,
} from "./progress-store.ts";
import { ago, BATCH, checkSignedIn, type FetchFn, sync } from "./sync.ts";

/**
 * An in-memory store with the same rules as DeviceStore, built from the same
 * pure helpers (identify, planMerge, queueAdds, queueDeletes). IndexedDB is
 * not available under Deno; the browser check covers the transactions.
 */
class MemStore implements SyncStore {
  checks: CheckRecord[] = [];
  ink = new Map<string, InkRecord>();
  state: SyncState | null = null;
  generation = 0;

  syncState() {
    return Promise.resolve(this.state ? structuredClone(this.state) : null);
  }
  updateSync(change: (s: SyncState) => void) {
    if (this.state) change(this.state);
    return Promise.resolve();
  }
  enableSync(email: string) {
    this.generation++;
    this.state = freshSyncState(email);
    return Promise.resolve();
  }
  disableSync() {
    this.generation++;
    this.state = null;
    return Promise.resolve();
  }
  localRecords(kind: Kind, ids: string[]) {
    const out = new Map<string, unknown>();
    for (const id of ids) {
      const r = kind === "ink" ? this.ink.get(id) : this.checks.find((c) => c.id === id);
      if (r) out.set(id, r);
    }
    return Promise.resolve(out);
  }
  mergeRecords(kind: Kind, records: unknown[]) {
    if (kind === "check") {
      const { fresh } = planMerge(this.checks, records);
      this.checks.push(...fresh);
      return Promise.resolve(fresh.length);
    }
    const fresh = records.filter(hasIdentity).filter((r) => !this.ink.has(r.id));
    for (const r of fresh) this.ink.set(r.id, r as InkRecord);
    return Promise.resolve(fresh.length);
  }
  removeIds(kind: Kind, ids: string[]) {
    const gone: string[] = [];
    for (const id of ids) {
      if (kind === "ink") {
        if (this.ink.delete(id)) gone.push(id);
      } else {
        const i = this.checks.findIndex((c) => c.id === id);
        if (i >= 0) {
          this.checks.splice(i, 1);
          gone.push(id);
        }
      }
    }
    return Promise.resolve(gone);
  }

  // What DeviceStore's add, addInk, clear and delete do, with the same queueing.
  add(r: NewCheck): CheckRecord {
    const rec = identify({ ...r, id: newId() });
    this.checks.push(rec);
    if (this.state) queueAdds(this.state, [{ kind: "check", id: rec.id }]);
    return rec;
  }
  addInk(r: InkRecord) {
    this.ink.set(r.id, r);
    if (this.state) queueAdds(this.state, [{ kind: "ink", id: r.id }]);
  }
  remove(kind: Kind, id: string) {
    if (kind === "ink") this.ink.delete(id);
    else this.checks = this.checks.filter((c) => c.id !== id);
    if (this.state) queueDeletes(this.state, [{ kind, id }]);
  }
  clear() {
    const gone: SyncEntry[] = [
      ...this.checks.map((c) => ({ kind: "check" as const, id: c.id })),
      ...[...this.ink.keys()].map((id) => ({ kind: "ink" as const, id })),
    ];
    this.checks = [];
    this.ink.clear();
    if (this.state) queueDeletes(this.state, gone);
  }
}

let clock = 1_700_000_000_000;
const check = (over: Partial<NewCheck> = {}): NewCheck => {
  const at = clock++;
  return {
    at,
    sheet: "arches",
    sheetTitle: "Branching arches",
    line: `n m ${at}`,
    model: "italic",
    modelName: "Edu SA Beginner",
    pen: "monoline",
    score: 80,
    letters: [{ char: "n", score: 80, missing: false }],
    metrics: { slantDiff: 0, size: 1, width: 1, baseline: 0 },
    ...over,
  };
};
const inkOf = (checkId: string, id = newId()): InkRecord => ({
  id,
  ts: clock++,
  check: checkId,
  strokes: [[[0, 0, 0, 5]]],
});

function syncedStore(over: Partial<SyncState> = {}) {
  const store = new MemStore();
  store.state = { ...freshSyncState("a@example.com"), ...over };
  return store;
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

Deno.test("sync off: nothing is queued and no state appears", () => {
  const store = new MemStore();
  const c = store.add(check());
  store.addInk(inkOf(c.id));
  store.remove("check", c.id);
  store.clear();
  assertEquals(store.state, null);
});

Deno.test("add and addInk queue their records; deleting queues the id and drops the add", () => {
  const store = syncedStore();
  const a = store.add(check());
  const b = store.add(check());
  const i = inkOf(a.id);
  store.addInk(i);
  assertEquals(store.state!.pendingAdds, [
    { kind: "check", id: a.id },
    { kind: "check", id: b.id },
    { kind: "ink", id: i.id },
  ]);
  store.remove("check", a.id);
  assertEquals(store.state!.pendingAdds.map((e) => e.id), [b.id, i.id]);
  assertEquals(store.state!.pendingDeletes, [{ kind: "check", id: a.id }]);
});

Deno.test("clear queues every removed check and ink record as a deletion", () => {
  const store = syncedStore();
  const a = store.add(check());
  const i = inkOf(a.id);
  store.addInk(i);
  store.clear();
  assertEquals(store.state!.pendingAdds, []);
  assertEquals(store.state!.pendingDeletes, [
    { kind: "check", id: a.id },
    { kind: "ink", id: i.id },
  ]);
});

// ---- the sync loop --------------------------------------------------------

interface Call {
  cursor: number;
  push: Record<string, { id: string }[]>;
  deleted: { kind: string; id: string }[];
}

/** A fake /api/sync: each handler answers one call in order. */
function fakeServer(...replies: ((c: Call) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const f: FetchFn = async (url, init) => {
    assertEquals(url, "/api/sync");
    const c = JSON.parse(init!.body as string) as Call;
    calls.push(c);
    const reply = replies[calls.length - 1];
    if (!reply) throw new Error("unexpected call");
    return await reply(c);
  };
  return { f, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const answer = (over: Record<string, unknown> = {}) => ({
  cursor: 1,
  records: { check: [], ink: [] },
  deleted: [],
  more: false,
  rejected: [],
  ...over,
});

Deno.test("sync pushes pending checks and ink, and clears the queue", async () => {
  const store = syncedStore();
  const a = store.add(check());
  const i = inkOf(a.id);
  store.addInk(i);
  const gone = store.add(check());
  store.remove("check", gone.id);
  const srv = fakeServer((c) => {
    assertEquals(c.push.check.map((r) => r.id), [a.id]);
    assertEquals(c.push.ink.map((r) => r.id), [i.id]);
    assertEquals(c.deleted, [{ kind: "check", id: gone.id }]); // queued then deleted: never sent as an add
    return json(answer({ cursor: 7, records: { check: c.push.check, ink: c.push.ink } }));
  });
  assertEquals(await sync(store, srv.f), { status: "ok", changed: false });
  const st = store.state!;
  assertEquals([st.cursor, st.pendingAdds, st.pendingDeletes], [7, [], []]);
  assert(st.lastSyncAt !== null);
});

Deno.test("sync pages while more is true, then merges both kinds", async () => {
  const store = syncedStore();
  const rec = (at: number) => identify({ ...check({ at }), id: `c${at}` });
  const srv = fakeServer(
    () => json(answer({ cursor: 2, more: true, records: { check: [rec(20)] } })),
    (c) => {
      assertEquals(c.cursor, 2);
      assertEquals(c.push, { check: [], ink: [] });
      return json(answer({ cursor: 3, records: { check: [rec(10)], ink: [inkOf("c10", "k1")] } }));
    },
  );
  assertEquals(await sync(store, srv.f), { status: "ok", changed: true });
  assertEquals(ids(store.checks).sort(), ["c10", "c20"]);
  assertEquals([...store.ink.keys()], ["k1"]);
  assertEquals(store.state!.cursor, 3);
});

Deno.test("an ink record from another device is stored without the web knowing its shape", async () => {
  const store = syncedStore();
  const foreign = { id: "k9", ts: 5, check: "c1", w: 640, strokes: "anything the writer likes" };
  const srv = fakeServer(() => json(answer({ records: { ink: [foreign, { id: "no-ts" }] } })));
  assertEquals((await sync(store, srv.f)).status, "ok");
  assertEquals(store.ink.get("k9"), foreign);
  assertEquals(store.ink.size, 1);
});

Deno.test("sync sends at most BATCH records per request and keeps going", async () => {
  const store = syncedStore();
  for (let i = 0; i < BATCH + 20; i++) store.add(check());
  const srv = fakeServer(
    (c) => {
      assertEquals(c.push.check.length, BATCH);
      return json(answer({ cursor: 1 }));
    },
    (c) => {
      assertEquals(c.push.check.length, 20);
      return json(answer({ cursor: 2 }));
    },
  );
  assertEquals((await sync(store, srv.f)).status, "ok");
  assertEquals(srv.calls.length, 2);
  assertEquals(store.state!.pendingAdds, []);
});

Deno.test("records queued while a request is in flight survive it", async () => {
  const store = syncedStore();
  store.add(check());
  let late = "";
  const srv = fakeServer(
    (c) => {
      late = store.add(check()).id; // recorded mid-request
      return json(answer({ cursor: 1, records: { check: c.push.check } }));
    },
    (c) => {
      assertEquals(c.push.check.map((r) => r.id), [late]);
      return json(answer({ cursor: 2 }));
    },
  );
  assertEquals((await sync(store, srv.f)).status, "ok");
  assertEquals(srv.calls.length, 2);
  assertEquals(store.state!.pendingAdds, []);
});

Deno.test("a record deleted while its push was in flight is not resurrected", async () => {
  const store = syncedStore();
  const a = store.add(check());
  const srv = fakeServer(
    (c) => {
      store.remove("check", a.id);
      return json(answer({ cursor: 1, records: { check: c.push.check } }));
    },
    (c) => {
      assertEquals(c.deleted, [{ kind: "check", id: a.id }]);
      return json(answer({ cursor: 2 }));
    },
  );
  await sync(store, srv.f);
  assertEquals(store.checks, []);
  assertEquals(store.state!.pendingDeletes, []);
});

Deno.test("rejected records leave the queue", async () => {
  const store = syncedStore();
  const a = store.add(check());
  const i = inkOf(a.id);
  store.addInk(i);
  const srv = fakeServer(() =>
    json(answer({ rejected: [{ kind: "ink", id: i.id, reason: "record over 65536 bytes" }] }))
  );
  assertEquals((await sync(store, srv.f)).status, "ok");
  assertEquals(store.state!.pendingAdds, []);
});

Deno.test("pending adds whose records are gone are dropped, not retried forever", async () => {
  const store = syncedStore({ pendingAdds: [{ kind: "check", id: "ghost" }] });
  const srv = fakeServer(() => json(answer()));
  assertEquals((await sync(store, srv.f)).status, "ok");
  assertEquals(store.state!.pendingAdds, []);
});

Deno.test("tombstones delete local records of both kinds, and their pending adds", async () => {
  const store = syncedStore();
  const a = store.add(check());
  const b = store.add(check());
  const i = inkOf(a.id);
  store.addInk(i);
  const srv = fakeServer((c) =>
    json(answer({
      cursor: 4,
      records: { check: c.push.check, ink: c.push.ink },
      deleted: [{ kind: "check", id: b.id }, { kind: "ink", id: i.id }],
    }))
  );
  assertEquals(await sync(store, srv.f), { status: "ok", changed: true });
  assertEquals(ids(store.checks), [a.id]);
  assertEquals(store.ink.size, 0);
  assertEquals(store.state!.pendingAdds, []);
});

Deno.test("401 turns sync off and keeps the history", async () => {
  const store = syncedStore();
  store.add(check());
  const srv = fakeServer(() => json({ error: "not signed in" }, 401));
  assertEquals(await sync(store, srv.f), { status: "signed-out" });
  assertEquals(store.state, null);
  assertEquals(store.checks.length, 1);
  assertEquals(await sync(store, srv.f), { status: "off" });
});

Deno.test("a network error or 5xx keeps everything pending", async () => {
  const store = syncedStore();
  const a = store.add(check());
  store.state!.pendingDeletes.push({ kind: "ink", id: "gone" });
  const down: FetchFn = () => Promise.reject(new TypeError("offline"));
  assertEquals(await sync(store, down), { status: "offline" });
  const srv = fakeServer(() => json({ error: "boom" }, 500));
  assertEquals((await sync(store, srv.f)).status, "error");
  const st = store.state!;
  assertEquals(st.pendingAdds, [{ kind: "check", id: a.id }]);
  assertEquals(st.pendingDeletes, [{ kind: "ink", id: "gone" }]);
});

Deno.test("a response that arrives after sign-out and sign-in again is thrown away", async () => {
  const store = syncedStore({ cursor: 5 });
  store.add(check());
  const srv = fakeServer(async () => {
    // The user signs out and in as someone else while the request is out.
    await store.disableSync();
    await store.enableSync("b@example.com");
    return json(
      answer({ cursor: 99, records: { check: [identify({ ...check(), id: "stale" })] } }),
    );
  });
  assertEquals(await sync(store, srv.f), { status: "off" });
  assertEquals(store.state!.email, "b@example.com");
  assertEquals([store.state!.cursor, store.state!.lastSyncAt], [0, null]);
  assertFalse(store.checks.some((c) => c.id === "stale"));
});

Deno.test("two syncs at once share one request", async () => {
  const store = syncedStore();
  store.add(check());
  const srv = fakeServer(() => json(answer()));
  const [x, y] = await Promise.all([sync(store, srv.f), sync(store, srv.f)]);
  assertEquals(x, y);
  assertEquals(srv.calls.length, 1);
});

Deno.test("checkSignedIn reads /api/me", async () => {
  assertEquals(await checkSignedIn(() => Promise.resolve(json({ email: "a@b.c" }))), {
    state: "in",
    email: "a@b.c",
  });
  assertEquals(await checkSignedIn(() => Promise.resolve(json({}, 401))), { state: "out" });
  assertEquals(await checkSignedIn(() => Promise.resolve(json({}, 500))), { state: "unknown" });
  assertEquals(await checkSignedIn(() => Promise.reject(new TypeError("x"))), {
    state: "unknown",
  });
});

Deno.test("ago words", () => {
  const now = 1_000_000_000_000;
  assertEquals(ago(now - 10_000, now), "just now");
  assertEquals(ago(now - 120_000, now), "2 min ago");
  assertEquals(ago(now - 3 * 3_600_000, now), "3 h ago");
  assertFalse(ago(now - 3 * 86_400_000, now).includes("ago"));
});
