// Where checked lines are kept, so the progress page can show history.
//
// For now that is this device's browser (IndexedDB): nothing is sent to the
// server and there are no accounts. Everything goes through the
// ProgressStore interface, so a server-backed store with accounts can
// replace it later without the pages changing.

/** One checked practice line. */
export interface CheckRecord {
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
  pen: "monoline" | "edged";
  /** 0–100, as shown on the line. */
  score: number;
  letters: Array<{ char: string; score: number; missing: boolean }>;
  metrics: { slantDiff: number; size: number; width: number; baseline: number };
}

export interface ProgressStore {
  add(r: CheckRecord): Promise<void>;
  all(): Promise<CheckRecord[]>;
  /** Add records from a backup, skipping any already present. Returns how many were new. */
  merge(rs: CheckRecord[]): Promise<number>;
  clear(): Promise<void>;
}

const dbName = "italic-practice";
const storeName = "checks";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(storeName, { autoIncrement: true });
      s.createIndex("at", "at");
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

/** A record's identity for de-duplicating backups: the same line checked at the same moment. */
function key(r: CheckRecord): string {
  return `${r.at}|${r.sheet}|${r.line}`;
}

export class DeviceStore implements ProgressStore {
  #db: Promise<IDBDatabase> | null = null;

  #open(): Promise<IDBDatabase> {
    return (this.#db ??= open());
  }

  async add(r: CheckRecord): Promise<void> {
    const tx = (await this.#open()).transaction(storeName, "readwrite");
    tx.objectStore(storeName).add(r);
    await done(tx);
  }

  async all(): Promise<CheckRecord[]> {
    const tx = (await this.#open()).transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).index("at").getAll();
    await done(tx);
    return req.result as CheckRecord[];
  }

  async merge(rs: CheckRecord[]): Promise<number> {
    const have = new Set((await this.all()).map(key));
    const fresh = rs.filter((r) => isRecord(r) && !have.has(key(r)));
    const tx = (await this.#open()).transaction(storeName, "readwrite");
    const s = tx.objectStore(storeName);
    for (const r of fresh) s.add(r);
    await done(tx);
    return fresh.length;
  }

  async clear(): Promise<void> {
    const tx = (await this.#open()).transaction(storeName, "readwrite");
    tx.objectStore(storeName).clear();
    await done(tx);
  }
}

/**
 * Whether a value from a backup file is a well-formed record. A backup is a
 * file the user picks, so its contents are checked, not trusted.
 */
export function isRecord(x: unknown): x is CheckRecord {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return num(r.at) && str(r.sheet, 64) && str(r.sheetTitle, 200) && str(r.line, 200) &&
    str(r.model, 64) && str(r.modelName, 200) && (r.pen === "monoline" || r.pen === "edged") &&
    num(r.score) && (r.score as number) >= 0 && (r.score as number) <= 100 &&
    Array.isArray(r.letters) && r.letters.length <= 200 &&
    r.letters.every((l) =>
      typeof l === "object" && l !== null && str((l as Record<string, unknown>).char, 8) &&
      num((l as Record<string, unknown>).score) &&
      typeof (l as Record<string, unknown>).missing === "boolean"
    ) &&
    typeof r.metrics === "object" && r.metrics !== null;
}

/** The backup file: a version, so a future format can still read old files. */
export interface Backup {
  app: "italic-practice";
  version: 1;
  exported: string;
  records: CheckRecord[];
}
