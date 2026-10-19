/// <reference lib="deno.ns" />

import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import {
  type CheckRecord,
  cyrb53,
  freshSyncState,
  hasIdentity,
  identify,
  isRecord,
  legacyId,
  type LooseCheck,
  newId,
  parseSyncState,
  planMerge,
  queueAdds,
  queueDeletes,
  validId,
} from "./progress-store.ts";

const line = (at: number, over: Partial<LooseCheck> = {}): LooseCheck => ({
  at,
  sheet: "arches",
  sheetTitle: "Branching arches",
  line: "n m",
  model: "italic",
  modelName: "Edu SA Beginner",
  pen: "monoline",
  score: 80,
  letters: [{ char: "n", score: 80, missing: false }],
  metrics: { slantDiff: 0, size: 1, width: 1, baseline: 0 },
  ...over,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

Deno.test("newId makes a v4 UUID, also where crypto.randomUUID is missing", () => {
  assertMatch(newId(), UUID);
  assertNotEquals(newId(), newId());
  // A plain-HTTP LAN page is not a secure context: no randomUUID there.
  const real = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues } });
  try {
    assertMatch(newId(), UUID);
  } finally {
    Object.defineProperty(globalThis, "crypto", real);
  }
});

Deno.test("identify keeps an id it has and sets ts to at", () => {
  const r = identify(line(1000, { id: "abc" }));
  assertEquals([r.id, r.ts], ["abc", 1000]);
  // A stray ts from outside never disagrees with at.
  assertEquals(identify(line(1000, { id: "abc", ts: 5 })).ts, 1000);
});

Deno.test("a record without an id is given a stable one, the same on every device", () => {
  const old = line(1_700_000_000_000);
  const a = identify(old), b = identify({ ...old });
  assertEquals(a.id, b.id);
  assertMatch(a.id, /^legacy-[0-9a-z]+-[0-9a-f]+$/);
  assert(a.id.length <= 64);
  // Different lines (even at the same moment) get different ids.
  assertNotEquals(a.id, identify(line(old.at, { line: "u i" })).id);
  assertNotEquals(a.id, identify(line(old.at + 1)).id);
  assertEquals(legacyId(old), a.id);
  // An id outside the server's 1-64 characters is replaced, not forwarded to be rejected.
  assertEquals(identify(line(5, { id: "x".repeat(65) })).id, legacyId(line(5)));
});

Deno.test("isRecord accepts old records without an id and refuses a bad id or ts", () => {
  assert(isRecord(line(1)));
  assert(isRecord(line(1, { id: "abc", ts: 1 })));
  assert(!isRecord(line(1, { id: "" })));
  assert(!isRecord(line(1, { id: 5 as unknown as string })));
  assert(!isRecord(line(1, { id: "x".repeat(65) })));
  assert(!isRecord(line(1, { ts: "1" as unknown as number })));
});

Deno.test("planMerge skips what is here by id or by backup identity, and ids the rest", () => {
  const have: CheckRecord[] = [identify(line(1, { id: "one" }))];
  const plan = planMerge(have, [
    line(1, { id: "one" }), // same id
    line(1, { id: "other-id" }), // same line at the same moment: the backup's identity
    line(2), // an old record: gets a legacy id
    line(2), // repeated within the batch
    { not: "a record" },
  ]);
  assertEquals([plan.fresh.length, plan.duplicate, plan.invalid], [1, 3, 1]);
  assertEquals(plan.fresh[0].id, legacyId(line(2)));
  assertEquals(plan.fresh[0].ts, 2);
});

Deno.test("restoring a version 1 backup twice, or on two devices, adds each line once with one id", () => {
  const backup = [line(10), line(20), line(30)];
  const first = planMerge([], backup).fresh;
  const again = planMerge(first, backup);
  assertEquals([again.fresh.length, again.duplicate], [0, 3]);
  const otherDevice = planMerge([], backup).fresh;
  assertEquals(first.map((r) => r.id), otherDevice.map((r) => r.id));
});

Deno.test("queueAdds and queueDeletes keep the queues free of repeats", () => {
  const s = freshSyncState("a@b.c");
  queueAdds(s, [{ kind: "check", id: "1" }, { kind: "check", id: "1" }, { kind: "ink", id: "1" }]);
  assertEquals(s.pendingAdds.length, 2); // same id, different kind: two records
  queueDeletes(s, [{ kind: "check", id: "1" }, { kind: "check", id: "1" }]);
  assertEquals(s.pendingAdds, [{ kind: "ink", id: "1" }]);
  assertEquals(s.pendingDeletes, [{ kind: "check", id: "1" }]);
});

Deno.test("queueAdds cancels a pending delete of the same record that was never sent", () => {
  const s = freshSyncState("a@b.c");
  queueDeletes(s, [{ kind: "check", id: "1" }, { kind: "ink", id: "1-ink" }, {
    kind: "check",
    id: "2",
  }]);
  queueAdds(s, [{ kind: "check", id: "1" }, { kind: "ink", id: "1-ink" }]);
  assertEquals(s.pendingAdds, [{ kind: "check", id: "1" }, { kind: "ink", id: "1-ink" }]);
  assertEquals(s.pendingDeletes, [{ kind: "check", id: "2" }]);
});

Deno.test("sync state survives only when well formed", () => {
  assertEquals(parseSyncState(null), null);
  assertEquals(parseSyncState({ email: "a@b.c" }), null);
  const s = parseSyncState({
    email: "a@b.c",
    cursor: 3,
    pendingAdds: [{ kind: "x", id: "1" }, { kind: "ink", id: "2" }, { kind: "check" }],
    pendingDeletes: "nope",
  });
  assertEquals(s, {
    email: "a@b.c",
    cursor: 3,
    pendingAdds: [{ kind: "ink", id: "2" }],
    pendingDeletes: [],
    lastSyncAt: null,
  });
});

// The iPad app copies this derivation byte for byte (docs/sync-api.md), so
// these vectors are the contract: change one and the two apps stop agreeing
// on which old record is which.
Deno.test("legacy id test vectors", () => {
  assertEquals(cyrb53(""), "bdcb81aee8d83");
  assertEquals(cyrb53("a"), "1c2ba782c97901");
  assertEquals(cyrb53("1700000000000|arches|n m"), "14cd5db9c318a8");
  assertEquals(
    legacyId({ at: 1700000000000, sheet: "arches", line: "n m" }),
    "legacy-loyw3v28-14cd5db9c318a8",
  );
  // Non-ASCII text is hashed as UTF-16 code units.
  assertEquals(
    legacyId({ at: 1700000000123, sheet: "custom", line: "Café ñ — “quoted”" }),
    "legacy-loyw3v5n-6a49beccf0e0d",
  );
  // A fractional at is truncated, in the id and in the hashed text.
  assertEquals(
    legacyId({ at: 1700000000000.9, sheet: "x", line: "y" }),
    "legacy-loyw3v28-cd46e230def4c",
  );
});

Deno.test("ids count UTF-8 bytes, and a record needs a positive at", () => {
  assert(validId("a".repeat(64)));
  assertFalse(validId("a".repeat(65)));
  assertFalse(validId(""));
  assert(validId("é".repeat(32))); // 64 bytes
  assertFalse(validId("é".repeat(33))); // 33 UTF-16 units but 66 bytes
  assertFalse(validId("😀".repeat(17))); // 34 units, 68 bytes
  assertFalse(isRecord(line(0)));
  assertFalse(isRecord(line(-5)));
  assertFalse(isRecord(line(1000, { id: "é".repeat(33) })));
  assertFalse(hasIdentity({ id: "é".repeat(33), ts: 1 }));
  assertThrows(() => identify(line(0)));
  // A 66-byte id is not kept: the record gets its derived one instead.
  assertEquals(identify(line(5, { id: "é".repeat(33) })).id, legacyId(line(5)));
});

Deno.test("a check with metrics2 and pen2 is accepted and carried untouched", () => {
  const extra = {
    metrics2: { v: 1, scores: { shape: 80, consistency: 70 }, notes: [] },
    pen2: { kind: "edged", nibs: 5, angle: 45, followsRoll: true, input: "pencil" },
  };
  const r = line(1000, { ...extra, pen: "pointed" });
  assert(isRecord(r));
  const got = identify(r);
  assertEquals(got.metrics2, extra.metrics2);
  assertEquals(got.pen2, extra.pen2);
  assertEquals(got.pen, "pointed");
});
