// History sync with the server: the client side of docs/sync-api.md.
//
// Local history (IndexedDB) stays the source of truth and works signed out.
// While sync is on (a sync state exists) the store queues new records and
// deletions, and `sync()` swaps them with the server and pulls what other
// devices did. Signing in itself happens on the server-rendered /account
// page: the session cookie is HttpOnly, so this code can only ask /api/me
// whether it is there.
//
// Kinds are handled generically: "check" and "ink" take exactly the same
// path, so whoever starts writing ink records needs only to store them.

import { entryKey, type Kind, KINDS, type SyncEntry, type SyncStore } from "./progress-store.ts";

/** Records sent per request (the server refuses more than 1000, deletions likewise). */
export const BATCH = 500;
/** Deletions sent per request. */
export const MAX_DELETES = 1000;
/** JSON bytes of records sent per request; the server's own cap is 16 MB. */
export const MAX_BODY_BYTES = 4 << 20;
/** A backstop against a loop that cannot make progress (storage refusing writes). */
const MAX_ROUNDS = 200;

export type SyncResult =
  | { status: "ok"; changed: boolean }
  /** Sync is not on here (or was turned off or on again mid-request): nothing was done. */
  | { status: "off" }
  /** The server said 401; sync is now off and local history is untouched. */
  | { status: "signed-out" }
  /**
   * The server said 409: the browser's session belongs to a different account
   * than the one this device was syncing. Sync is now off here, local history
   * untouched, and nothing was sent.
   */
  | { status: "account-mismatch" }
  /** The network failed; everything stays queued for the next trigger. */
  | { status: "offline" }
  | { status: "error"; message: string };

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchFn = (input, init) => globalThis.fetch(input, init);

let running: { promise: Promise<SyncResult>; generation: number } | null = null;

/**
 * Sync now. Two syncs never overlap: a call while one is running gets that
 * one's result (it also picks up anything queued meanwhile, see `rounds`).
 *
 * The exception is a round that started under an older sign-in (the store's
 * generation has moved since): its result will be "off" and it writes
 * nothing, so a call made after the sign-in must not join it. It starts a
 * round of its own, and the old one cannot free the new one's slot.
 */
export function sync(store: SyncStore, f: FetchFn = defaultFetch): Promise<SyncResult> {
  if (running && running.generation === store.generation) return running.promise;
  const promise: Promise<SyncResult> = rounds(store, f).finally(() => {
    if (running?.promise === promise) running = null;
  });
  running = { promise, generation: store.generation };
  return promise;
}

/** How much one request may carry; a 413 halves it for the rest of the sync. */
interface Cap {
  records: number;
  bytes: number;
}

async function rounds(store: SyncStore, f: FetchFn): Promise<SyncResult> {
  let changed = false;
  const cap: Cap = { records: BATCH, bytes: MAX_BODY_BYTES };
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const r = await round(store, f, cap);
    if (r.status === "too-big") {
      // The server refused the body: send half as much and try again. A single
      // record that is still too big cannot be helped.
      if (r.sent <= 1) {
        return { status: "error", message: "The server refused a record as too large." };
      }
      cap.records = Math.max(1, Math.floor(r.sent / 2));
      cap.bytes = Math.max(1, Math.floor(r.bytes / 2));
      continue;
    }
    if (r.status !== "ok") return r;
    changed ||= r.changed;
    // Done once the server has nothing more and nothing is waiting to go up,
    // including what was queued while the request was in flight.
    const s = await store.syncState();
    if (!s) return { status: "off" };
    if (!r.more && !s.pendingAdds.length && !s.pendingDeletes.length) {
      return { status: "ok", changed };
    }
    // Going round again must have achieved something: the queue shrank, the
    // cursor moved, or records came back. If not, repeating the request would
    // repeat the outcome for all MAX_ROUNDS rounds, so stop and say so.
    if (!r.progress) return { status: "error", message: "The server's reply stalled." };
  }
  return { status: "error", message: "Sync could not finish." };
}

type Round =
  | { status: "ok"; changed: boolean; more: boolean; progress: boolean }
  | { status: "too-big"; sent: number; bytes: number }
  | Exclude<SyncResult, { status: "ok" }>;

const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];

async function round(store: SyncStore, f: FetchFn, cap: Cap): Promise<Round> {
  const state = await store.syncState();
  if (!state) return { status: "off" };
  const generation = store.generation;

  // Look each queued record up locally; ones that are gone (deleted since)
  // have nothing to send but still leave the queue. Take entries in queue
  // order until the record count or the JSON size cap is reached (always at
  // least one, so a big record still goes).
  const candidates = state.pendingAdds.slice(0, cap.records);
  const locals: Record<string, Map<string, unknown>> = {};
  for (const kind of KINDS) {
    locals[kind] = await store.localRecords(
      kind,
      candidates.filter((e) => e.kind === kind).map((e) => e.id),
    );
  }
  const batch: SyncEntry[] = [];
  const push: Record<Kind, unknown[]> = { check: [], ink: [] };
  let bytes = 0, count = 0;
  for (const e of candidates) {
    const rec = locals[e.kind].get(e.id);
    if (rec) {
      const size = utf8Length(JSON.stringify(rec)) + 1;
      if (count > 0 && bytes + size > cap.bytes) break;
      bytes += size;
      count++;
      push[e.kind].push(rec);
    }
    batch.push(e);
  }
  const deletes = state.pendingDeletes.slice(0, MAX_DELETES);

  let res: Response;
  try {
    res = await f("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `account` lets the server refuse (409) when the session belongs to
      // someone other than the account this device syncs with.
      body: JSON.stringify({ account: state.email, cursor: state.cursor, push, deleted: deletes }),
    });
  } catch {
    return { status: "offline" };
  }
  // Signed out, or in again as someone else, while the request was out: this
  // response belongs to a sign-in that is over, so it must change nothing. The
  // generation catches a change made by this tab; the stored state catches one
  // made by another tab (a sign-out, or a different account's sign-in, writes
  // the shared IndexedDB, which this tab's counter never sees).
  const stale = async () => {
    if (store.generation !== generation) return true;
    const now = await store.syncState();
    return !now || now.email !== state.email;
  };
  if (await stale()) return { status: "off" };
  if (res.status === 401) {
    await store.disableSync();
    return { status: "signed-out" };
  }
  if (res.status === 409) {
    await store.disableSync();
    return { status: "account-mismatch" };
  }
  if (res.status === 413) return { status: "too-big", sent: batch.length + deletes.length, bytes };
  let body: Record<string, unknown>;
  try {
    body = await res.json();
  } catch {
    return { status: "error", message: `The server sent an unreadable reply (${res.status}).` };
  }
  if (!res.ok) {
    const msg = typeof body?.error === "string" ? body.error : `The server said ${res.status}.`;
    return { status: "error", message: msg };
  }

  // Drop exactly what was sent (and what the server refused); entries queued
  // while the request was in flight stay.
  const sent = new Set(batch.map(entryKey));
  for (const r of arr(body.rejected)) {
    const e = r as Partial<SyncEntry>;
    if (typeof e?.id === "string" && KINDS.includes(e.kind as Kind)) {
      sent.add(entryKey(e as SyncEntry));
    }
  }
  const sentDeletes = new Set(deletes.map(entryKey));
  let removed = 0;
  await store.updateSync((s) => {
    const before = s.pendingAdds.length + s.pendingDeletes.length;
    s.pendingAdds = s.pendingAdds.filter((e) => !sent.has(entryKey(e)));
    s.pendingDeletes = s.pendingDeletes.filter((e) => !sentDeletes.has(entryKey(e)));
    removed = before - s.pendingAdds.length - s.pendingDeletes.length;
  });

  // Merge what came back. A record deleted here since the request went out is
  // not welcomed back; its deletion is still queued and will reach the server.
  let changed = false;
  let pulled = 0;
  const waiting = new Set(((await store.syncState())?.pendingDeletes ?? []).map(entryKey));
  const records = (body.records ?? {}) as Record<string, unknown>;
  for (const kind of KINDS) {
    const got = arr(records[kind]);
    pulled += got.length;
    const wanted = got.filter((r) =>
      !waiting.has(entryKey({ kind, id: String((r as { id?: unknown })?.id) }))
    );
    if (await store.mergeRecords(kind, wanted)) changed = true;
  }

  // Tombstones: other devices deleted these.
  const dead = arr(body.deleted).filter((d): d is SyncEntry =>
    typeof (d as SyncEntry)?.id === "string" && KINDS.includes((d as SyncEntry).kind)
  );
  pulled += dead.length;
  for (const kind of KINDS) {
    const ids = dead.filter((d) => d.kind === kind).map((d) => d.id);
    if (ids.length && (await store.removeIds(kind, ids)).length) changed = true;
  }
  const deadKeys = new Set(dead.map(entryKey));
  const cursor = typeof body.cursor === "number" ? body.cursor : state.cursor;
  if (await stale()) return { status: "off" };
  await store.updateSync((s) => {
    s.pendingAdds = s.pendingAdds.filter((e) => !deadKeys.has(entryKey(e)));
    s.cursor = cursor;
    s.lastSyncAt = Date.now();
  });

  return {
    status: "ok",
    changed,
    more: body.more === true,
    progress: removed > 0 || pulled > 0 || cursor !== state.cursor,
  };
}

const encoder = new TextEncoder();
const utf8Length = (s: string): number => encoder.encode(s).length;

export type SignedIn = { state: "in"; email: string } | { state: "out" } | { state: "unknown" };

/** Ask the server whether this browser's session cookie is good. */
export async function checkSignedIn(f: FetchFn = defaultFetch): Promise<SignedIn> {
  try {
    const res = await f("/api/me");
    if (res.status === 401) return { state: "out" };
    if (!res.ok) return { state: "unknown" };
    const body = await res.json();
    return typeof body?.email === "string" ? { state: "in", email: body.email } : {
      state: "unknown",
    };
  } catch {
    return { state: "unknown" }; // offline: say nothing rather than guess
  }
}

/** "just now", "2 min ago", "3 h ago", or the date. */
export function ago(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { dateStyle: "medium" });
}
