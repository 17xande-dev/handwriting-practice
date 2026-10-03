/// <reference lib="deno.ns" />

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  byExercise,
  byLetter,
  daily,
  dayOf,
  headline,
  since,
  trendPerWeek,
} from "./progress-stats.ts";
import { type CheckRecord, isRecord } from "./progress-store.ts";

const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

function rec(at: number, score: number, sheet = "arches", letters = "nm"): CheckRecord {
  return {
    at,
    sheet,
    sheetTitle: sheet === "custom" ? "Your text" : "Branching arches",
    line: "n m",
    model: "italic",
    modelName: "Edu SA Beginner",
    pen: "monoline",
    score,
    letters: [...letters].map((char) => ({ char, score, missing: false })),
    metrics: { slantDiff: 0, size: 1, width: 1, baseline: 0 },
  };
}

Deno.test("daily means group by local calendar day", () => {
  const d1 = noon(2026, 10, 1), d2 = noon(2026, 10, 3);
  const days = daily([rec(d1, 60), rec(d1 + 3_600_000, 80), rec(d2, 90)]);
  assertEquals(days.map((d) => [d.day - dayOf(d1), d.mean, d.lines]), [[0, 70, 2], [2, 90, 1]]);
});

Deno.test("exercises are counted by lines and days, most practised first", () => {
  const d1 = noon(2026, 10, 1), d2 = noon(2026, 10, 2);
  const ex = byExercise([rec(d1, 50), rec(d1, 70), rec(d2, 90), rec(d2, 80, "ovals")]);
  assertEquals(ex.map((e) => e.sheet), ["arches", "ovals"]);
  assertEquals(ex[0].lines, 3);
  assertEquals(ex[0].days, 2);
  assertEquals(ex[0].best, 90);
  assertEquals(ex[0].firstDayMean, 60);
  assertEquals(ex[0].lastDayMean, 90);
});

Deno.test("letters: lowercase only, alphabetical", () => {
  const ls = byLetter([rec(noon(2026, 10, 1), 80, "custom", "ba,A ")]);
  assertEquals(ls.map((l) => l.char), ["a", "b"]);
});

// A streak survives until the end of the day after the last practice, so
// opening the app in the morning doesn't show it broken.
Deno.test("streak counts back from today or yesterday", () => {
  const now = noon(2026, 10, 10);
  const days = (ds: number[]) => ds.map((d) => rec(noon(2026, 10, d), 80));
  assertEquals(headline(days([8, 9, 10]), now).streak, 3);
  assertEquals(headline(days([7, 8, 9]), now).streak, 3);
  assertEquals(headline(days([6, 7]), now).streak, 0);
  const h = headline([...days([9, 10]), rec(noon(2026, 9, 20), 50)], now);
  assertEquals(h.recentMean, 80);
  assertEquals(h.previousMean, 50);
  assertEquals(h.practiceDays, 3);
});

Deno.test("trend is the slope of daily means, per week", () => {
  const days = [0, 1, 2, 3].map((i) => ({ day: 100 + i, mean: 60 + 2 * i, lines: 1 }));
  assertAlmostEquals(trendPerWeek(days), 14, 1e-9);
  assert(Number.isNaN(trendPerWeek(days.slice(0, 2))));
});

Deno.test("since keeps the last N days", () => {
  const now = noon(2026, 10, 10);
  const rs = [rec(noon(2026, 10, 10), 1), rec(noon(2026, 10, 4), 2), rec(noon(2026, 9, 1), 3)];
  assertEquals(since(rs, now, 7).map((r) => r.score), [1, 2]);
  assertEquals(since(rs, now, Infinity).length, 3);
});

// A backup is a file the user picks: anything malformed is refused, not stored.
Deno.test("backup records are validated", () => {
  assert(isRecord(rec(1, 50)));
  for (
    const bad of [
      null,
      { ...rec(1, 50), score: 101 },
      { ...rec(1, 50), pen: "brush" },
      { ...rec(1, 50), line: "x".repeat(500) },
      { ...rec(1, 50), letters: [{ char: "a", score: "high", missing: false }] },
      { ...rec(1, 50), at: "yesterday" },
    ]
  ) assert(!isRecord(bad), JSON.stringify(bad)?.slice(0, 60));
});
