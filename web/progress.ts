// The progress page: headline numbers, three charts and their tables, drawn
// from the checks kept on this device, plus backup and clearing.
//
// Charts follow one restrained style: a single blue for the data, a light
// gray for context, hairline gridlines, and every value also in a table, so
// nothing depends on a tooltip or on colour alone.

import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  type ChartConfiguration,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  ScatterController,
  Tooltip,
} from "chart.js";
import {
  byExercise,
  byLetter,
  daily,
  dayLabel,
  dayOf,
  headline,
  since,
  trendPerWeek,
} from "./progress-stats.ts";
import { type Backup, type CheckRecord, DeviceStore, isRecord } from "./progress-store.ts";

Chart.register(
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  ScatterController,
  Tooltip,
);

/** Chart tokens. Blue and gray validated as a pair; gray marks always have a table. */
const ink = {
  series: "#2a78d6",
  context: "#b9b7ae",
  surface: "#ffffff",
  grid: "#e1e0d9",
  muted: "#6f6d67",
  text: "#1d1f22",
};

Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
Chart.defaults.color = ink.muted;
Chart.defaults.animation = false;

const tooltip = {
  backgroundColor: "#1d1f22",
  titleColor: "#c3c2b7",
  bodyColor: "#ffffff",
  bodyFont: { weight: "bold" as const },
  padding: 10,
  displayColors: false,
};

const axis = (extra: Record<string, unknown> = {}) => ({
  grid: { color: ink.grid, lineWidth: 1, drawTicks: false },
  border: { display: false },
  ticks: { padding: 6, color: ink.muted },
  ...extra,
});

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

/** Fill a table from a header row and data rows, as text (labels are user data). */
function table(t: HTMLTableElement, head: string[], rows: string[][]) {
  const thead = el("thead"), tr = el("tr");
  for (const h of head) tr.append(el("th", h));
  thead.append(tr);
  const tbody = el("tbody");
  for (const r of rows) {
    const row = el("tr");
    r.forEach((c, i) => row.append(el(i === 0 ? "th" : "td", c)));
    tbody.append(row);
  }
  t.replaceChildren(thead, tbody);
}

const pct = (x: number) => `${Math.round(x)}%`;
const shortDate = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function main() {
  const root = document.getElementById("progress");
  if (!root) return;
  const store = new DeviceStore();
  const charts: Chart[] = [];
  let all: CheckRecord[] = [];

  const range = () => {
    const v = (root.querySelector('input[name="range"]:checked') as HTMLInputElement)?.value;
    return v === "all" ? Infinity : Number(v);
  };

  const render = () => {
    for (const c of charts.splice(0)) c.destroy();
    const empty = all.length === 0;
    document.getElementById("progress-empty")!.hidden = !empty;
    document.getElementById("progress-body")!.hidden = empty;
    if (empty) return;

    const now = Date.now();
    const rs = since(all, now, range());
    renderTiles(headline(all, now), rs.length);
    const days = daily(rs);
    charts.push(scoreChart(rs, days));
    charts.push(exerciseChart(rs));
    charts.push(letterChart(rs));
  };

  root.querySelector(".range")?.addEventListener("change", render);
  attachHistoryTools(store, async () => {
    all = await store.all();
    render();
  });

  store.all().then((rs) => {
    all = rs;
    render();
  }).catch(() => {
    document.getElementById("progress-empty")!.hidden = false;
    say("This browser isn't letting the app store anything, so there's no history to show.", true);
  });
}

/** The headline numbers, as stat tiles. The average compares the last two fortnights. */
function renderTiles(h: ReturnType<typeof headline>, inRange: number) {
  const tiles = document.getElementById("stat-tiles")!;
  const tile = (label: string, value: string, delta?: { text: string; good: boolean }) => {
    const t = el("div", undefined, "stat-tile");
    t.append(el("span", label, "stat-label"), el("strong", value, "stat-value"));
    if (delta) t.append(el("span", delta.text, `stat-delta ${delta.good ? "up" : "down"}`));
    return t;
  };
  const delta = Number.isFinite(h.recentMean) && Number.isFinite(h.previousMean)
    ? h.recentMean - h.previousMean
    : NaN;
  tiles.replaceChildren(
    tile(
      "Average, last 14 days",
      Number.isFinite(h.recentMean) ? pct(h.recentMean) : "–",
      Number.isFinite(delta)
        ? {
          text: `${delta >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(delta))} on the fortnight before`,
          good: delta >= 0,
        }
        : undefined,
    ),
    tile("Lines checked", `${inRange}`),
    tile("Days practised", `${h.practiceDays}`),
    tile("Streak", `${h.streak} day${h.streak === 1 ? "" : "s"}`),
  );
}

function scoreChart(rs: CheckRecord[], days: ReturnType<typeof daily>): Chart {
  const trend = trendPerWeek(days);
  document.getElementById("score-sub")!.textContent = Number.isFinite(trend)
    ? Math.abs(trend) < 1
      ? "Holding steady."
      : trend > 0
      ? `Improving by about ${Math.round(trend)} points a week.`
      : `Down about ${
        Math.round(-trend)
      } points a week. Slower, careful lines usually bring it back.`
    : "Practise on a few more days to see a trend.";

  table(
    document.getElementById("table-score") as HTMLTableElement,
    ["Day", "Average", "Lines"],
    days.map((d) => [dayLabel(d.day), pct(d.mean), `${d.lines}`]),
  );

  // Each check sits on its day, spread a little across it so a day's
  // several checks don't stack on one point.
  const perDay = new Map<number, number>();
  const dots = rs.map((r) => {
    const d = dayOf(r.at), k = perDay.get(d) ?? 0;
    perDay.set(d, k + 1);
    return { x: d + ((k % 5) - 2) * 0.06, y: r.score };
  });
  const lo = days[0].day, hi = days[days.length - 1].day;

  const config: ChartConfiguration<"line" | "scatter"> = {
    type: "line",
    data: {
      datasets: [
        {
          type: "scatter",
          label: "Line checked",
          data: dots,
          backgroundColor: ink.context,
          borderColor: ink.surface,
          borderWidth: 1,
          pointRadius: 3,
          pointHoverRadius: 4,
          order: 2,
        },
        {
          type: "line",
          label: "Daily average",
          data: days.map((d) => ({ x: d.day, y: d.mean })),
          borderColor: ink.series,
          backgroundColor: ink.series,
          borderWidth: 2,
          borderCapStyle: "round",
          borderJoinStyle: "round",
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBorderColor: ink.surface,
          pointBorderWidth: 2,
          pointHitRadius: 14,
          tension: 0,
          order: 1,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: axis({
          type: "linear",
          min: lo - 0.5,
          max: hi + 0.5,
          // Ticks on whole days, evenly spaced, ending on the latest day.
          afterBuildTicks: (scale: { ticks: Array<{ value: number }> }) => {
            const step = Math.max(1, Math.ceil((hi - lo) / 6));
            const ticks = [];
            for (let d = hi; d >= lo; d -= step) ticks.unshift({ value: d });
            scale.ticks = ticks;
          },
          ticks: {
            color: ink.muted,
            padding: 6,
            autoSkip: false,
            callback: (v: number | string) => dayLabel(Number(v)),
          },
          grid: { display: false },
        }),
        y: axis({ min: 0, max: 100, ticks: { color: ink.muted, stepSize: 25, padding: 6 } }),
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltip,
          callbacks: {
            title: (items) => dayLabel(Math.round(items[0].parsed.x ?? 0)),
            label: (item) => `${pct(item.parsed.y ?? 0)} ${item.dataset.label?.toLowerCase()}`,
          },
        },
      },
    },
  };
  return new Chart(document.getElementById("chart-score") as HTMLCanvasElement, config);
}

function exerciseChart(rs: CheckRecord[]): Chart {
  const ex = byExercise(rs);
  table(
    document.getElementById("table-exercises") as HTMLTableElement,
    ["Exercise", "Lines", "Days", "Average", "Best", "First day → latest", "Last"],
    ex.map((e) => [
      e.title,
      `${e.lines}`,
      `${e.days}`,
      pct(e.mean),
      pct(e.best),
      e.days > 1 ? `${pct(e.firstDayMean)} → ${pct(e.lastDayMean)}` : "–",
      shortDate(e.last),
    ]),
  );
  // Bars are a fixed thickness, so the chart grows with the number of exercises.
  document.getElementById("exercise-box")!.style.height = `${40 + ex.length * 34}px`;
  return new Chart(document.getElementById("chart-exercises") as HTMLCanvasElement, {
    type: "bar",
    data: {
      labels: ex.map((e) => e.title),
      datasets: [{
        label: "Lines checked",
        data: ex.map((e) => e.lines),
        backgroundColor: ink.series,
        borderRadius: 4,
        borderSkipped: "start",
        maxBarThickness: 20,
      }],
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      scales: {
        x: axis({ beginAtZero: true, ticks: { color: ink.muted, precision: 0, padding: 6 } }),
        y: axis({ grid: { display: false }, ticks: { color: ink.text, padding: 6 } }),
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltip,
          callbacks: {
            label: (item) => {
              const e = ex[item.dataIndex];
              return `${e.lines} lines · average ${pct(e.mean)}`;
            },
          },
        },
      },
    },
  });
}

function letterChart(rs: CheckRecord[]): Chart {
  const ls = byLetter(rs);
  // Emphasis: the three weakest letters (with enough tries to mean something)
  // in blue, the rest in gray.
  const weakest = new Set(
    [...ls].filter((l) => l.count >= 3).sort((a, b) => a.mean - b.mean).slice(0, 3).map((l) =>
      l.char
    ),
  );
  document.getElementById("letter-sub")!.textContent = weakest.size
    ? `Average score per letter. Weakest, in blue: ${[...weakest].join(", ")}.`
    : "Average score per letter.";
  table(
    document.getElementById("table-letters") as HTMLTableElement,
    ["Letter", "Average", "Written", "Missed"],
    ls.map((l) => [l.char, pct(l.mean), `${l.count}`, `${l.missing}`]),
  );
  return new Chart(document.getElementById("chart-letters") as HTMLCanvasElement, {
    type: "bar",
    data: {
      labels: ls.map((l) => l.char),
      datasets: [{
        label: "Average score",
        data: ls.map((l) => l.mean),
        backgroundColor: ls.map((l) => (weakest.has(l.char) ? ink.series : ink.context)),
        borderRadius: 4,
        borderSkipped: "start",
        maxBarThickness: 20,
      }],
    },
    options: {
      maintainAspectRatio: false,
      scales: {
        x: axis({
          grid: { display: false },
          ticks: { color: ink.text, padding: 4, font: { size: 15 }, autoSkip: false },
        }),
        y: axis({ min: 0, max: 100, ticks: { color: ink.muted, stepSize: 25, padding: 6 } }),
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltip,
          callbacks: {
            label: (item) => {
              const l = ls[item.dataIndex];
              return `${pct(l.mean)} over ${l.count} written${
                l.missing ? `, ${l.missing} missed` : ""
              }`;
            },
          },
        },
      },
    },
  });
}

function say(text: string, error = false) {
  const s = document.getElementById("history-status");
  if (!s) return;
  s.textContent = text;
  s.classList.toggle("error", error);
}

function attachHistoryTools(store: DeviceStore, reload: () => Promise<void>) {
  document.getElementById("export-history")?.addEventListener("click", async () => {
    const records = await store.all();
    const backup: Backup = {
      app: "italic-practice",
      version: 1,
      exported: new Date().toISOString(),
      records,
    };
    const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `italic-practice-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    say(`Saved ${records.length} checked lines.`);
  });

  document.getElementById("import-history")?.addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      if (file.size > 20_000_000) throw new Error("too large");
      const data = JSON.parse(await file.text()) as Partial<Backup>;
      if (data.app !== "italic-practice" || !Array.isArray(data.records)) {
        throw new Error("not a backup");
      }
      const valid = data.records.filter(isRecord);
      const added = await store.merge(valid);
      const skipped = data.records.length - valid.length;
      say(
        `Restored ${added} checked line${added === 1 ? "" : "s"}` +
          (added < valid.length ? ` (${valid.length - added} already here)` : "") +
          (skipped
            ? `; ${skipped} unreadable ${skipped === 1 ? "entry" : "entries"} skipped.`
            : "."),
      );
      await reload();
    } catch {
      say("That file isn't a backup from this app.", true);
    }
  });

  document.getElementById("clear-history")?.addEventListener("click", async () => {
    if (
      !confirm(
        "Delete every checked line on this device? Save a backup first if you might want it back.",
      )
    ) {
      return;
    }
    await store.clear();
    say("History cleared.");
    await reload();
  });
}

main();
