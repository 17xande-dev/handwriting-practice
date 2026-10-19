// The numbers behind a checked line, as the iPad shows them (its
// MetricsPanelView): a sub-score line, four score bars, the notes and a list
// of every measurement. The text is pure so it can be tested; `renderPanel`
// builds the DOM (classes only, no inline styles; bar widths go through the CSSOM).

import type { LineMetrics, SubScores } from "./metric-scores.ts";
import { roundInt } from "./metrics.ts";
import { orderTotals } from "./stroke-order.ts";

const dash = "—";

/** A score's colour band, as a class name (good from 85, fair from 65). */
export function scoreClass(score: number): string {
  return score >= 85 ? "good" : score >= 65 ? "fair" : "poor";
}

/** "Consistency 98 · Pen control 73 · Fluency 80" (unmeasured parts left out). */
export function subScoreLine(s: SubScores): string {
  const parts: string[] = [];
  for (
    const [name, v] of [["Consistency", s.consistency], ["Pen control", s.penControl], [
      "Fluency",
      s.fluency,
    ]] as const
  ) {
    if (v !== undefined) parts.push(`${name} ${roundInt(v)}`);
  }
  return parts.length ? parts.join(" · ") : "Shape only: no pen or timing data";
}

/** The sheet's line: "Shape 85 · Consistency 80 · ..." (unmeasured parts left out). */
export function sheetScoreLine(s: SubScores): string {
  const parts = [`Shape ${roundInt(s.shape)}`];
  for (
    const [name, v] of [["Consistency", s.consistency], ["Pen control", s.penControl], [
      "Fluency",
      s.fluency,
    ]] as const
  ) {
    if (v !== undefined) parts.push(`${name} ${roundInt(v)}`);
  }
  return parts.join(" · ");
}

const fmt = (x: number, d = 2, unit = "") => Number.isFinite(x) ? x.toFixed(d) + unit : dash;

/** (label, value) rows, in the order of the spec; lifts are informational. */
export function metricRows(m: LineMetrics): Array<[string, string]> {
  const c = m.consistency, p = m.pen, f = m.fluency, z = m.shape;
  const pm = (a: number, b: number, unit: string) =>
    Number.isFinite(a) ? `${fmt(a, 0)}${unit} ±${fmt(b, 0)}${unit}` : dash;
  const o = m.order ? orderTotals(m.order) : null;
  const order: Array<[string, string]> = o
    ? [
      ["Order: letters judged", `${o.judged}, strokes matched ${o.matched}`],
      [
        "Order: problems",
        `wrong way ${o.reversed}, wrong start ${o.wrongStart}, wrong order ${o.wrongOrder}, lifts +${o.extraLifts} \u2212${o.missingLifts}, missing strokes ${o.missingStrokes}`,
      ],
    ]
    : [];
  return [
    ...order,
    ["Error: ascender", fmt(z.zoneAscender, 2, " xh")],
    ["Error: body", fmt(z.zoneBody, 2, " xh")],
    ["Error: descender", fmt(z.zoneDescender, 2, " xh")],
    ["Worst stretch", z.worst ? fmt(z.worst.mean, 2, " xh") : dash],
    ["Slant spread", fmt(c.slantSD, 1, "°")],
    ["Size spread", Number.isFinite(c.sizeSD) ? fmt(c.sizeSD * 100, 0, "%") : dash],
    ["Baseline wander", fmt(c.baselineSD, 2, " xh")],
    ["Gap evenness", fmt(c.spacingDevSD, 2, " xh")],
    ["Gap variation (CV)", fmt(c.spacingCV, 2)],
    ["Word space vs model", Number.isFinite(c.wordSpace) ? fmt(c.wordSpace * 100, 0, "%") : dash],
    ["Repeated letters", fmt(c.repeatDist, 2, " xh")],
    [
      "Pressure",
      Number.isFinite(p.pressureMean)
        ? `${fmt(p.pressureMean * 100, 0, "%")}, CV ${fmt(p.pressureCV, 2)}`
        : dash,
    ],
    ["Down vs up pressure", fmt(p.pressureContrast, 2, "×")],
    [
      "Nib angle",
      Number.isFinite(p.nibMean)
        ? `${pm(p.nibMean, p.nibSD, "°")} (target ${fmt(p.nibTarget, 0)}°)`
        : dash,
    ],
    ["Pen tilt", pm(p.altMean, p.altSD, "°")],
    ["Pen direction spread", fmt(p.azimuthSD, 0, "°")],
    [
      "Speed",
      Number.isFinite(f.speedMedian)
        ? `${fmt(f.speedMedian, 1)} xh/s, CV ${fmt(f.speedCV, 2)}`
        : dash,
    ],
    [
      "Hesitations",
      f.activeMs > 0 ? `${f.hesitations} (${f.pauses} pauses, ${f.slowRuns} slow)` : dash,
    ],
    [
      "Pen lifts / letter (info)",
      Number.isFinite(f.liftsPerLetter)
        ? `${fmt(f.liftsPerLetter, 1)} (model ${fmt(f.modelLiftsPerLetter, 1)})`
        : dash,
    ],
    ["Letters per minute", fmt(f.lettersPerMinute, 0)],
  ];
}

function bar(title: string, score: number | undefined): HTMLElement {
  const el = document.createElement("div");
  el.className = "score-bar";
  const name = document.createElement("span");
  name.className = "bar-name";
  name.textContent = title;
  const value = document.createElement("span");
  value.className = "bar-value";
  const track = document.createElement("div");
  track.className = "bar-track";
  const fill = document.createElement("div");
  fill.className = "bar-fill";
  if (score !== undefined) {
    const band = scoreClass(score);
    value.textContent = String(roundInt(score));
    value.classList.add(band);
    fill.classList.add(band);
    // Through the CSSOM, which the CSP allows (an inline style attribute it does not).
    fill.style.width = `${Math.min(100, Math.max(0, score))}%`;
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", `${title} ${roundInt(score)} out of 100`);
  } else {
    value.textContent = dash;
    value.classList.add("unmeasured");
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", `${title}, not measured`);
  }
  track.append(fill);
  el.append(name, value, track);
  return el;
}

/** The expandable detail under a checked row. */
export function renderPanel(m: LineMetrics): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "metrics-panel";
  const bars = document.createElement("div");
  bars.className = "score-bars";
  const s = m.scores;
  bars.append(
    bar("Shape", s.shape),
    bar("Consistency", s.consistency),
    bar("Pen control", s.penControl),
    bar("Fluency", s.fluency),
  );
  // Only measured where the model font has strokes for the line (docs/strokes.md).
  if (s.order !== undefined) bars.append(bar("Order & direction", s.order));
  panel.append(bars);
  if (m.notes.length) {
    const ul = document.createElement("ul");
    ul.className = "panel-notes";
    for (const n of m.notes) {
      const li = document.createElement("li");
      li.textContent = n;
      ul.append(li);
    }
    panel.append(ul);
  }
  const dl = document.createElement("dl");
  dl.className = "metric-list";
  for (const [label, value] of metricRows(m)) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    row.append(dt, dd);
    dl.append(row);
  }
  panel.append(dl);
  return panel;
}
