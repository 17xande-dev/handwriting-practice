// Where checked lines are kept, so the progress page can show history.
//
// The device's browser (IndexedDB) is the source of truth and works signed
// out. When the user signs in (see sync.ts), the same store also queues what
// is added and deleted, in the same transaction as the change itself, so a
// crash can never leave a record unqueued. Everything the pages use goes
// through the ProgressStore interface; the sync loop uses SyncStore.

/** One checked practice line. */
export interface CheckRecord {
  /** Sync identity: a UUID, or a derived "legacy-…" one for a line checked before sync existed. */
  id: string;
  /** Always equal to `at`; the field the server and the iPad app order by. */
  ts: number;
  /** When it was checked, ms since the epoch. */
  at: number;
  /** The worksheet's slug, or "custom" for the user's own text. */
  sheet: string;
  sheetTitle: string;
  /** The model line that was copied. */
  line: string;
  /** Model font id and its real name. */
  model: string;
  modelName: string;
  /**
   * "monoline" or "edged" today; any non-empty string is accepted, since the
   * iPad app is adding pen kinds ("pointed", "pencil") that this app only stores.
   */
  pen: string;
  /** 0–100, as shown on the line. */
  score: number;
  letters: Array<{ char: string; score: number; missing: boolean }>;
  metrics: { slantDiff: number; size: number; width: number; baseline: number };
  /**
   * M5 extras (the iPad repo's docs/metrics.md). Optional members are omitted
   * when absent; every number may be null (NaN) or missing. A reader treats a
   * malformed value as absent; this store carries both untouched.
   */
  metrics2?: Metrics2;
  pen2?: Pen2Record;
}

/** The `pen2` member: the pen's details and what drove it. */
export interface Pen2Record {
  kind: string;
  weight?: number;
  nibs?: number;
  angle?: number;
  followsRoll?: boolean;
  lead?: number;
  swell?: boolean;
  /** "pencil" or "touch". */
  input: string;
}

type Nums<K extends string> = { [P in K]?: number | null };

/** The `metrics2` member of a check record. */
export interface Metrics2 {
  v: number;
  shape?: {
    letters?: Array<{ char: string; precision?: number | null; coverage?: number | null }>;
    zone?: Nums<"ascender" | "body" | "descender">;
    worst?: { stroke: number; from: number; to: number; letter: number; mean?: number | null };
  };
  consistency?: Nums<
    "slantSD" | "sizeSD" | "baselineSD" | "spacingDevSD" | "spacingCV" | "wordSpace" | "repeatDist"
  >;
  pen?: Nums<
    | "pressureMean"
    | "pressureCV"
    | "pressureContrast"
    | "nibMean"
    | "nibTarget"
    | "nibDev"
    | "nibSD"
    | "altMean"
    | "altSD"
    | "azimuthSD"
  >;
  fluency?: Nums<
    | "speedMedian"
    | "speedCV"
    | "hesitations"
    | "pauses"
    | "slowRuns"
    | "liftsPerLetter"
    | "modelLiftsPerLetter"
    | "lettersPerMinute"
    | "activeMs"
  >;
  scores?: { shape?: number; consistency?: number; pen?: number; fluency?: number; order?: number };
  notes?: string[];
  /** Stroke order and direction (iPad docs/strokes.md, "Record"); omitted when no letter was judged. */
  order?: {
    judged?: number;
    matched?: number;
    reversed?: number;
    wrongStart?: number;
    wrongOrder?: number;
    extraLifts?: number;
    missingLifts?: number;
    missingStrokes?: number;
    letters?: Array<{
      char: string;
      matched?: number;
      reversed?: number;
      wrongStart?: number;
      wrongOrder?: number;
      extraLifts?: number;
      missingLifts?: number;
      missingStrokes?: number;
      credit?: number | null;
    }>;
  };
}

/** What a caller records: the identity is assigned by the store. */
export type NewCheck = Omit<CheckRecord, "id" | "ts">;

/**
 * A record as it may arrive from a backup or an old database: well formed
 * apart from an identity, which only records made before sync existed lack.
 */
export type LooseCheck = NewCheck & { id?: string; ts?: number };

/**
 * The packed strokes of one checked attempt (see ink-codec.ts for the
 * layout, docs/sync-api.md for the contract). Beyond the identity, the server
 * and this store look at nothing.
 */
export interface InkRecord {
  id: string;
  ts: number;
  /** The id of the check these strokes belong to. */
  check: string;
  [field: string]: unknown;
}

/**
 * A person's stroke definitions for one font (iPad docs/strokes.md, "Sync"): `strokes-<fontId>`, or
 * `strokes-<fontId>-<n>` when split. Kept and synced as it came (no UI yet); unlike the other kinds
 * it is edited in place, so the greater `ts` wins (`newerRecords`).
 */
export interface StrokesRecord {
  id: string;
  ts: number;
  [field: string]: unknown;
}

export type Kind = "check" | "ink" | "strokes";
export const KINDS: Kind[] = ["check", "ink", "strokes"];

/** The records that are new or have a greater ts than the one held under the same id. */
export function newerRecords(have: Map<string, number>, records: unknown[]): StrokesRecord[] {
  const out = new Map<string, StrokesRecord>();
  for (const r of records) {
    if (!hasIdentity(r)) continue;
    const held = Math.max(have.get(r.id) ?? -Infinity, out.get(r.id)?.ts ?? -Infinity);
    if (r.ts > held) out.set(r.id, r as StrokesRecord);
  }
  return [...out.values()];
}

/** A record named without its data: a queued add, or a deletion. */
export interface SyncEntry {
  kind: Kind;
  id: string;
}

/** Sync state; its absence means sync is off (signed out, or never signed in here). */
export interface SyncState {
  email: string;
  /** The highest server seq seen; 0 pulls everything. */
  cursor: number;
  pendingAdds: SyncEntry[];
  pendingDeletes: SyncEntry[];
  lastSyncAt: number | null;
}

export interface ProgressStore {
  /** Record a check, assigning its identity. Resolves to the stored record. */
  add(r: NewCheck): Promise<CheckRecord>;
  all(): Promise<CheckRecord[]>;
  /** Add records from a backup, skipping any already present. Returns how many were new. */
  merge(rs: LooseCheck[]): Promise<number>;
  /** Delete every check and ink record, queuing their deletion while sync is on. */
  clear(): Promise<void>;
  /** The writing on a sheet row, kept on this device (never synced) so it survives a reload. */
  loadStrokes(key: string): Promise<unknown>;
  /** A row's writing with what was recorded from it (see stroke-store.ts `Recorded`), both unchecked. */
  loadWriting(key: string): Promise<{ strokes: unknown; recorded: unknown }>;
  /** Keep (or, with null, forget) the writing of a row, with the check last recorded from it. */
  saveStrokes(key: string, strokes: unknown | null, recorded?: unknown): Promise<void>;
  /** Store the ink of a checked attempt. */
  addInk(r: InkRecord): Promise<void>;
  allInk(): Promise<InkRecord[]>;
}

/** What the sync loop needs from a store. Local history stays the source of truth. */
export interface SyncStore {
  syncState(): Promise<SyncState | null>;
  /** Change the sync state atomically; does nothing while sync is off. */
  updateSync(change: (s: SyncState) => void): Promise<void>;
  /** Turn sync on for this account with nothing queued and an empty cursor. */
  enableSync(email: string): Promise<void>;
  /** Turn sync off (signed out). Local history stays. */
  disableSync(): Promise<void>;
  /**
   * Bumped whenever sync is turned on or off. A sync that finds it changed
   * while a request was in flight throws that response away: it belongs to a
   * sign-in that is over.
   */
  readonly generation: number;
  /** The local records of a kind with these ids, for a push. Missing ids are absent. */
  localRecords(kind: Kind, ids: string[]): Promise<Map<string, unknown>>;
  /** Store records pulled from the server. Returns how many were new. Queues nothing. */
  mergeRecords(kind: Kind, records: unknown[]): Promise<number>;
  /** Delete pulled tombstones locally. Returns the ids that were here. Queues nothing. */
  removeIds(kind: Kind, ids: string[]): Promise<string[]>;
}

// ---- identity ----------------------------------------------------------------

/**
 * A fresh id. crypto.randomUUID needs a secure context, which the app is not
 * on a plain-HTTP LAN address, so fall back to building a v4 UUID from
 * getRandomValues, which works anywhere. Ids are opaque to everyone else.
 */
export function newId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** cyrb53: a small, stable, non-cryptographic 53-bit string hash, as lowercase hex. */
export function cyrb53(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * The id given to a record that has none (a line checked before sync
 * existed). It depends only on `at`, `sheet` and `line`, so every device
 * computes the same id for the same old record, and syncing them does not
 * make two copies. The exact derivation is in docs/sync-api.md, which the
 * iPad app copies:
 *
 *   s  = String(trunc(at)) + "|" + sheet + "|" + line
 *   id = "legacy-" + base36(trunc(at)) + "-" + hex(cyrb53(s))
 *
 * cyrb53 runs over the UTF-16 code units of s. Records made from now on get
 * a random UUID instead.
 */
export function legacyId(r: Pick<NewCheck, "at" | "sheet" | "line">): string {
  const at = Math.trunc(r.at);
  return `legacy-${at.toString(36)}-${cyrb53(`${at}|${r.sheet}|${r.line}`)}`;
}

const utf8 = new TextEncoder();

/**
 * Whether an id is acceptable to the server: a string of 1-64 bytes of UTF-8
 * (bytes, not UTF-16 units: "é" is two, an emoji four).
 */
export function validId(id: unknown): id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return false;
  return utf8.encode(id).length <= 64;
}

/**
 * Give a record its sync identity: the id it has, or a legacy one, and
 * ts = at. The server refuses a ts that is not positive, so a record whose
 * `at` is not cannot be synced and is refused here instead.
 */
export function identify(r: LooseCheck): CheckRecord {
  if (!(r.at > 0)) throw new RangeError("a record needs a positive at to be identified");
  const id = validId(r.id) ? r.id : legacyId(r);
  return { ...r, id, ts: r.at };
}

/** Whether a stored value is a check that can be given an identity, even if it fails isRecord. */
function identifiable(x: unknown): x is LooseCheck {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.at === "number" && Number.isFinite(r.at) && r.at > 0 &&
    typeof r.sheet === "string" &&
    typeof r.line === "string";
}

/** A record's identity for de-duplicating backups: the same line checked at the same moment. */
export function key(r: NewCheck): string {
  return `${r.at}|${r.sheet}|${r.line}`;
}

/**
 * Whether a value from a backup file or the server is a well-formed record.
 * Those are outside input, so their contents are checked, not trusted. An id
 * is optional (old records have none) but must be sane when present.
 */
export function isRecord(x: unknown): x is LooseCheck {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return (r.id === undefined || validId(r.id)) &&
    (r.ts === undefined || num(r.ts)) &&
    num(r.at) && (r.at as number) > 0 && str(r.sheet, 64) && str(r.sheetTitle, 200) &&
    str(r.line, 200) &&
    str(r.model, 64) && str(r.modelName, 200) && str(r.pen, 32) && (r.pen as string).length > 0 &&
    num(r.score) && (r.score as number) >= 0 && (r.score as number) <= 100 &&
    Array.isArray(r.letters) && r.letters.length <= 200 &&
    r.letters.every((l) =>
      typeof l === "object" && l !== null && str((l as Record<string, unknown>).char, 8) &&
      num((l as Record<string, unknown>).score) &&
      typeof (l as Record<string, unknown>).missing === "boolean"
    ) &&
    typeof r.metrics === "object" && r.metrics !== null;
}

/** The generic shape sync needs of any record: an id and a timestamp. */
export function hasIdentity(x: unknown): x is { id: string; ts: number } {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return validId(r.id) &&
    typeof r.ts === "number" && Number.isFinite(r.ts) && r.ts > 0;
}

/**
 * Decide what a merge adds: the valid records not already here by id or by
 * backup identity, each given its identity. Pure, so the IndexedDB store and
 * the tests share it.
 */
export function planMerge(
  have: CheckRecord[],
  incoming: unknown[],
): { fresh: CheckRecord[]; invalid: number; duplicate: number } {
  const ids = new Set(have.map((r) => r.id));
  const keys = new Set(have.map(key));
  const fresh: CheckRecord[] = [];
  let invalid = 0, duplicate = 0;
  for (const x of incoming) {
    if (!isRecord(x)) {
      invalid++;
      continue;
    }
    const r = identify(x);
    if (ids.has(r.id) || keys.has(key(r))) {
      duplicate++;
      continue;
    }
    ids.add(r.id);
    keys.add(key(r));
    fresh.push(r);
  }
  return { fresh, invalid, duplicate };
}

// ---- the queue ----------------------------------------------------------------

export const entryKey = (e: SyncEntry): string => `${e.kind}:${e.id}`;

/**
 * Queue new records for the next sync. A not-yet-sent deletion of the same
 * record is dropped: the record is back (restored after Clear history, before
 * the next sync), so the delete, which never reached the server, must not take
 * it away again. (A delete that was already sent is a tombstone at the server,
 * which wins for that id.)
 */
export function queueAdds(s: SyncState, entries: SyncEntry[]): void {
  const back = new Set(entries.map(entryKey));
  s.pendingDeletes = s.pendingDeletes.filter((e) => !back.has(entryKey(e)));
  const have = new Set(s.pendingAdds.map(entryKey));
  for (const e of entries) {
    if (!have.has(entryKey(e))) s.pendingAdds.push(e);
    have.add(entryKey(e));
  }
}

/** Queue deletions, and forget any not-yet-sent adds of the same records. */
export function queueDeletes(s: SyncState, entries: SyncEntry[]): void {
  const gone = new Set(entries.map(entryKey));
  s.pendingAdds = s.pendingAdds.filter((e) => !gone.has(entryKey(e)));
  const have = new Set(s.pendingDeletes.map(entryKey));
  for (const e of entries) {
    if (!have.has(entryKey(e))) s.pendingDeletes.push(e);
    have.add(entryKey(e));
  }
}

/** A stored sync state, or null unless it is well formed. */
export function parseSyncState(raw: unknown): SyncState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.email !== "string" || typeof r.cursor !== "number" || !Number.isFinite(r.cursor)) {
    return null;
  }
  const entries = (v: unknown): SyncEntry[] =>
    Array.isArray(v)
      ? v.filter((e): e is SyncEntry =>
        typeof e === "object" && e !== null && typeof (e as SyncEntry).id === "string" &&
        KINDS.includes((e as SyncEntry).kind)
      ).map((e) => ({ kind: e.kind, id: e.id }))
      : [];
  return {
    email: r.email,
    cursor: r.cursor,
    pendingAdds: entries(r.pendingAdds),
    pendingDeletes: entries(r.pendingDeletes),
    lastSyncAt: typeof r.lastSyncAt === "number" && Number.isFinite(r.lastSyncAt)
      ? r.lastSyncAt
      : null,
  };
}

export function freshSyncState(email: string): SyncState {
  return { email, cursor: 0, pendingAdds: [], pendingDeletes: [], lastSyncAt: null };
}

// ---- IndexedDB ----------------------------------------------------------------

const dbName = "italic-practice";
// Version 2 adds the id index on checks, the ink and meta stores, and gives
// every existing check its identity. Version 3 adds the store of what is
// written on each sheet row. Version 4 indexes the ink records by ts, so the oldest can be pruned.
// Version 5 adds the store of synced stroke definitions.
const dbVersion = 5;
const strokes = "strokes";
const checks = "checks";
const ink = "ink";
const meta = "meta";
const writing = "writing";
/** Rows of writing kept on this device; the least recently written go first. */
export const maxWritingRows = 300;
/**
 * Ink records kept on this device (the latest by ts); older ones are dropped locally. A pruned
 * record is never queued for deletion: the server and the iPad keep theirs.
 */
export const maxInkRecords = 2000;
const syncKey = "sync";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, dbVersion);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction!;
      let s: IDBObjectStore;
      if (ev.oldVersion < 1) {
        s = db.createObjectStore(checks, { autoIncrement: true });
        s.createIndex("at", "at");
      } else {
        s = tx.objectStore(checks);
      }
      if (ev.oldVersion < 2) {
        s.createIndex("id", "id");
        db.createObjectStore(ink, { keyPath: "id" });
        db.createObjectStore(meta);
        // Persist an identity on every record made before sync existed, so
        // the id a line is synced under never changes afterwards. Only the id
        // and ts are added: a record this code does not fully understand (a
        // newer client's) keeps every other field exactly as it was.
        s.openCursor().onsuccess = (e) => {
          const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cur) return;
          if (identifiable(cur.value) && cur.value.id === undefined) {
            cur.update(identify(cur.value));
          }
          cur.continue();
        };
      }
      if (ev.oldVersion < 3) db.createObjectStore(writing);
      if (ev.oldVersion < 4) tx.objectStore(ink).createIndex("ts", "ts");
      if (ev.oldVersion < 5) db.createObjectStore(strokes, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Inside an open transaction on the ink store: delete the oldest records beyond `keep`. Queues nothing. */
function pruneInk(tx: IDBTransaction, keep = maxInkRecords): void {
  const index = tx.objectStore(ink).index("ts");
  index.count().onsuccess = (e) => {
    let excess = (e.target as IDBRequest<number>).result - keep;
    if (excess <= 0) return;
    index.openCursor().onsuccess = (ev) => {
      const cur = (ev.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (!cur || excess <= 0) return;
      cur.delete();
      excess--;
      cur.continue();
    };
  };
}

/** Read-modify-write the sync state inside a transaction that is already open. */
function changeSync(tx: IDBTransaction, change: (s: SyncState) => void): void {
  const m = tx.objectStore(meta);
  m.get(syncKey).onsuccess = (e) => {
    const s = parseSyncState((e.target as IDBRequest).result);
    if (!s) return;
    change(s);
    m.put(s, syncKey);
  };
}

export class DeviceStore implements ProgressStore, SyncStore {
  #db: Promise<IDBDatabase> | null = null;
  #generation = 0;

  #open(): Promise<IDBDatabase> {
    return (this.#db ??= open());
  }

  get generation(): number {
    return this.#generation;
  }

  async add(r: NewCheck): Promise<CheckRecord> {
    const rec = identify({ ...r, id: newId() });
    const tx = (await this.#open()).transaction([checks, meta], "readwrite");
    tx.objectStore(checks).add(rec);
    changeSync(tx, (s) => queueAdds(s, [{ kind: "check", id: rec.id }]));
    await done(tx);
    return rec;
  }

  async all(): Promise<CheckRecord[]> {
    const tx = (await this.#open()).transaction(checks, "readonly");
    const req = tx.objectStore(checks).index("at").getAll();
    await done(tx);
    return req.result as CheckRecord[];
  }

  async merge(rs: LooseCheck[]): Promise<number> {
    const { fresh } = planMerge(await this.all(), rs);
    if (!fresh.length) return 0;
    const tx = (await this.#open()).transaction([checks, meta], "readwrite");
    const s = tx.objectStore(checks);
    for (const r of fresh) s.add(r);
    changeSync(tx, (st) => queueAdds(st, fresh.map((r) => ({ kind: "check", id: r.id }))));
    await done(tx);
    return fresh.length;
  }

  async clear(): Promise<void> {
    const tx = (await this.#open()).transaction([checks, ink, meta], "readwrite");
    const gone: SyncEntry[] = [];
    // Read the ids and clear in one transaction, so a check added in between
    // is neither lost from the queue nor left behind undeleted.
    tx.objectStore(checks).getAll().onsuccess = (e) => {
      for (const r of (e.target as IDBRequest<CheckRecord[]>).result) {
        if (typeof r.id === "string") gone.push({ kind: "check", id: r.id });
      }
      tx.objectStore(checks).clear();
    };
    tx.objectStore(ink).getAllKeys().onsuccess = (e) => {
      for (const id of (e.target as IDBRequest<IDBValidKey[]>).result) {
        gone.push({ kind: "ink", id: String(id) });
      }
      tx.objectStore(ink).clear();
      changeSync(tx, (s) => queueDeletes(s, gone));
    };
    await done(tx);
  }

  async loadStrokes(key: string): Promise<unknown> {
    return (await this.loadWriting(key)).strokes;
  }

  async loadWriting(key: string): Promise<{ strokes: unknown; recorded: unknown }> {
    const tx = (await this.#open()).transaction(writing, "readonly");
    const req = tx.objectStore(writing).get(key);
    await done(tx);
    const v = req.result as { strokes?: unknown; recorded?: unknown } | undefined;
    return { strokes: v?.strokes ?? null, recorded: v?.recorded ?? null };
  }

  async saveStrokes(key: string, strokes: unknown | null, recorded?: unknown): Promise<void> {
    const tx = (await this.#open()).transaction(writing, "readwrite");
    const s = tx.objectStore(writing);
    if (strokes === null) {
      s.delete(key);
    } else {
      s.put({ at: Date.now(), strokes, ...(recorded ? { recorded } : {}) }, key);
      // Keep the store bounded: forget the rows written longest ago.
      const all: Array<[IDBValidKey, number]> = [];
      s.openCursor().onsuccess = (e) => {
        const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cur) {
          all.push([cur.key, (cur.value as { at?: number }).at ?? 0]);
          cur.continue();
          return;
        }
        all.sort((x, y) => x[1] - y[1]);
        for (const [k] of all.slice(0, Math.max(0, all.length - maxWritingRows))) s.delete(k);
      };
    }
    await done(tx);
  }

  async addInk(r: InkRecord): Promise<void> {
    const tx = (await this.#open()).transaction([ink, meta], "readwrite");
    tx.objectStore(ink).put(r);
    changeSync(tx, (s) => queueAdds(s, [{ kind: "ink", id: r.id }]));
    pruneInk(tx);
    await done(tx);
  }

  async allInk(): Promise<InkRecord[]> {
    const tx = (await this.#open()).transaction(ink, "readonly");
    const req = tx.objectStore(ink).getAll();
    await done(tx);
    return req.result as InkRecord[];
  }

  // ---- SyncStore ----

  async syncState(): Promise<SyncState | null> {
    const tx = (await this.#open()).transaction(meta, "readonly");
    return parseSyncState(await result(tx.objectStore(meta).get(syncKey)));
  }

  async updateSync(change: (s: SyncState) => void): Promise<void> {
    const tx = (await this.#open()).transaction(meta, "readwrite");
    changeSync(tx, change);
    await done(tx);
  }

  async enableSync(email: string): Promise<void> {
    this.#generation++;
    const tx = (await this.#open()).transaction(meta, "readwrite");
    tx.objectStore(meta).put(freshSyncState(email), syncKey);
    await done(tx);
  }

  async disableSync(): Promise<void> {
    this.#generation++;
    const tx = (await this.#open()).transaction(meta, "readwrite");
    tx.objectStore(meta).delete(syncKey);
    await done(tx);
  }

  /** Every local record, as entries: the "add this browser's checks" offer. */
  async allEntries(): Promise<SyncEntry[]> {
    const tx = (await this.#open()).transaction([checks, ink, strokes], "readonly");
    const c = tx.objectStore(checks).getAll();
    const i = tx.objectStore(ink).getAllKeys();
    const st = tx.objectStore(strokes).getAllKeys();
    await done(tx);
    return [
      ...(c.result as CheckRecord[]).filter((r) => typeof r.id === "string").map((r) => ({
        kind: "check" as const,
        id: r.id,
      })),
      ...i.result.map((id) => ({ kind: "ink" as const, id: String(id) })),
      ...st.result.map((id) => ({ kind: "strokes" as const, id: String(id) })),
    ];
  }

  /** Every stored `strokes` record (the person's stroke definitions, in parts), as they are. */
  async allStrokesRecords(): Promise<StrokesRecord[]> {
    const tx = (await this.#open()).transaction(strokes, "readonly");
    const req = tx.objectStore(strokes).getAll();
    await done(tx);
    return req.result as StrokesRecord[];
  }

  /**
   * Store `strokes` records the person edited here (every part of the new version, old parts
   * emptied) and queue them for the next sync, in one transaction.
   */
  async saveStrokesRecords(records: StrokesRecord[]): Promise<void> {
    if (!records.length) return;
    const tx = (await this.#open()).transaction([strokes, meta], "readwrite");
    for (const r of records) tx.objectStore(strokes).put(r);
    changeSync(
      tx,
      (s) => queueAdds(s, records.map((r) => ({ kind: "strokes" as const, id: r.id }))),
    );
    await done(tx);
  }

  /** Queue records for the next sync (a no-op while sync is off). */
  async queueAdds(entries: SyncEntry[]): Promise<void> {
    if (entries.length) await this.updateSync((s) => queueAdds(s, entries));
  }

  async localRecords(kind: Kind, ids: string[]): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>();
    if (!ids.length) return out;
    if (kind === "strokes") {
      const tx = (await this.#open()).transaction(strokes, "readonly");
      const reqs = ids.map((id) => tx.objectStore(strokes).get(id));
      await done(tx);
      for (const q of reqs) if (q.result) out.set((q.result as StrokesRecord).id, q.result);
      return out;
    }
    if (kind === "ink") {
      const tx = (await this.#open()).transaction(ink, "readonly");
      const reqs = ids.map((id) => tx.objectStore(ink).get(id));
      await done(tx);
      for (const q of reqs) if (q.result) out.set((q.result as InkRecord).id, q.result);
      return out;
    }
    const want = new Set(ids);
    for (const r of await this.all()) if (want.has(r.id)) out.set(r.id, r);
    return out;
  }

  async mergeRecords(kind: Kind, records: unknown[]): Promise<number> {
    if (kind === "strokes") {
      // Read and write in one transaction, so a concurrent edit is never overwritten by an older record.
      const tx = (await this.#open()).transaction(strokes, "readwrite");
      let n = 0;
      tx.objectStore(strokes).getAll().onsuccess = (e) => {
        const have = new Map(
          (e.target as IDBRequest<StrokesRecord[]>).result.map((r) => [r.id, r.ts]),
        );
        const fresh = newerRecords(have, records);
        n = fresh.length;
        for (const r of fresh) tx.objectStore(strokes).put(r);
      };
      await done(tx);
      return n;
    }
    if (kind === "check") {
      const { fresh } = planMerge(await this.all(), records);
      if (!fresh.length) return 0;
      const tx = (await this.#open()).transaction(checks, "readwrite");
      for (const r of fresh) tx.objectStore(checks).add(r);
      await done(tx);
      return fresh.length;
    }
    const have = new Set((await this.allInk()).map((r) => r.id));
    const fresh = records.filter(hasIdentity).filter((r) => !have.has(r.id));
    if (!fresh.length) return 0;
    const tx = (await this.#open()).transaction(ink, "readwrite");
    for (const r of fresh) tx.objectStore(ink).put(r);
    pruneInk(tx);
    await done(tx);
    return fresh.length;
  }

  async removeIds(kind: Kind, ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const gone: string[] = [];
    if (kind === "ink" || kind === "strokes") {
      const store = kind === "ink" ? ink : strokes;
      const tx = (await this.#open()).transaction(store, "readwrite");
      const s = tx.objectStore(store);
      for (const id of ids) {
        s.getKey(id).onsuccess = (e) => {
          if ((e.target as IDBRequest).result !== undefined) {
            gone.push(id);
            s.delete(id);
          }
        };
      }
      await done(tx);
      return gone;
    }
    const drop = new Set(ids);
    const tx = (await this.#open()).transaction(checks, "readwrite");
    const s = tx.objectStore(checks);
    s.openCursor().onsuccess = (e) => {
      const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (!cur) return;
      if (drop.has((cur.value as CheckRecord).id)) {
        gone.push((cur.value as CheckRecord).id);
        cur.delete();
      }
      cur.continue();
    };
    await done(tx);
    return gone;
  }
}

/** The backup file: a version, so a future format can still read old files. */
export interface Backup {
  app: "italic-practice";
  /** 2 carries each record's id and ts; 1 (older files) has neither, and is still read. */
  version: 1 | 2;
  exported: string;
  records: LooseCheck[];
}

export const BACKUP_VERSION = 2;
