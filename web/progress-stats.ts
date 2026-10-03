// Summaries of checked lines for the progress page. Pure functions over the
// records, so they are tested directly (progress-stats_test.ts).

import type { CheckRecord } from "./progress-store.ts";

const msPerDay = 86_400_000;

/** A record's calendar day in the viewer's time zone, as days since 1970-01-01. */
export function dayOf(at: number): number {
  const d = new Date(at);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / msPerDay);
}

/** A day number back to a short date label, e.g. "3 Oct". */
export function dayLabel(day: number): string {
  return new Date(day * msPerDay).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export interface Day {
  day: number;
  mean: number;
  lines: number;
}

/** The mean score per practice day, oldest first. Days without practice are absent. */
export function daily(rs: CheckRecord[]): Day[] {
  const by = new Map<number, number[]>();
  for (const r of rs) {
    const d = dayOf(r.at);
    by.set(d, [...(by.get(d) ?? []), r.score]);
  }
  return [...by].sort((a, b) => a[0] - b[0]).map(([day, xs]) => ({
    day,
    mean: mean(xs),
    lines: xs.length,
  }));
}

export interface Exercise {
  sheet: string;
  title: string;
  /** Lines checked. */
  lines: number;
  /** Distinct days it was practised. */
  days: number;
  mean: number;
  best: number;
  last: number;
  /** Mean of the first and the most recent practice day, to show change. */
  firstDayMean: number;
  lastDayMean: number;
}

/** Per worksheet, most practised first. */
export function byExercise(rs: CheckRecord[]): Exercise[] {
  const by = new Map<string, CheckRecord[]>();
  for (const r of rs) by.set(r.sheet, [...(by.get(r.sheet) ?? []), r]);
  return [...by].map(([sheet, xs]) => {
    const days = daily(xs);
    return {
      sheet,
      title: xs[xs.length - 1].sheetTitle,
      lines: xs.length,
      days: days.length,
      mean: mean(xs.map((x) => x.score)),
      best: Math.max(...xs.map((x) => x.score)),
      last: Math.max(...xs.map((x) => x.at)),
      firstDayMean: days[0].mean,
      lastDayMean: days[days.length - 1].mean,
    };
  }).sort((a, b) => b.lines - a.lines || b.last - a.last);
}

export interface Letter {
  char: string;
  mean: number;
  count: number;
  missing: number;
}

/** Per letter written (lowercase letters only), alphabetically. */
export function byLetter(rs: CheckRecord[]): Letter[] {
  const by = new Map<string, { scores: number[]; missing: number }>();
  for (const r of rs) {
    for (const l of r.letters) {
      if (!/^\p{Ll}$/u.test(l.char)) continue;
      const e = by.get(l.char) ?? { scores: [], missing: 0 };
      e.scores.push(l.score);
      if (l.missing) e.missing++;
      by.set(l.char, e);
    }
  }
  return [...by].map(([char, e]) => ({
    char,
    mean: mean(e.scores),
    count: e.scores.length,
    missing: e.missing,
  })).sort((a, b) => a.char.localeCompare(b.char));
}

export interface Headline {
  lines: number;
  practiceDays: number;
  exercises: number;
  /** Consecutive practice days ending today or yesterday. */
  streak: number;
  /** Mean over the last `window` days, and over the window before it (NaN if none). */
  recentMean: number;
  previousMean: number;
}

export function headline(rs: CheckRecord[], now: number, window = 14): Headline {
  const today = dayOf(now);
  const days = new Set(rs.map((r) => dayOf(r.at)));
  let streak = 0;
  // A streak still counts if today hasn't been practised yet.
  for (let d = days.has(today) ? today : today - 1; days.has(d); d--) streak++;
  const inWindow = (from: number, to: number) =>
    rs.filter((r) => {
      const d = dayOf(r.at);
      return d > from && d <= to;
    }).map((r) => r.score);
  const recent = inWindow(today - window, today);
  const previous = inWindow(today - 2 * window, today - window);
  return {
    lines: rs.length,
    practiceDays: days.size,
    exercises: new Set(rs.map((r) => r.sheet)).size,
    streak,
    recentMean: recent.length ? mean(recent) : NaN,
    previousMean: previous.length ? mean(previous) : NaN,
  };
}

/**
 * A straight-line fit of daily means against day number: the slope in score
 * points per week, or NaN with fewer than three practice days. It answers
 * "am I improving?" without leaning on one good or bad day.
 */
export function trendPerWeek(days: Day[]): number {
  if (days.length < 3) return NaN;
  const xs = days.map((d) => d.day), ys = days.map((d) => d.mean);
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? (num / den) * 7 : NaN;
}

/** Keep records from the last `days` days (or all, for Infinity). */
export function since(rs: CheckRecord[], now: number, days: number): CheckRecord[] {
  if (!Number.isFinite(days)) return rs;
  const from = dayOf(now) - days;
  return rs.filter((r) => dayOf(r.at) > from);
}
