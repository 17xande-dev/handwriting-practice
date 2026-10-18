/// <reference lib="deno.ns" />

import { assert, assertEquals } from "@std/assert";
import type { Stroke } from "./ink.ts";
import {
  buildTimeline,
  finishedCount,
  heat,
  maxGap,
  pointSpeeds,
  writtenPoints,
} from "./replay.ts";

const stroke = (t0: number, n: number, dt = 10, du = 0.05): Stroke => ({
  pen: { kind: "monoline", weight: 3 },
  points: Array.from({ length: n }, (_, i) => ({ u: i * du, v: 0, p: 0.5, t: t0 + i * dt })),
});

Deno.test("a replay keeps the writing's timing but cuts pen-up gaps to 0.8 s", () => {
  // The second stroke starts 5 s after the first ends.
  const tl = buildTimeline([stroke(1000, 11), stroke(1000 + 100 + 5000, 11)]);
  assertEquals(tl.items.length, 2);
  assertEquals(tl.items[0].times[0], 0);
  assert(Math.abs(tl.items[0].times[10] - 0.1) < 1e-9);
  assert(Math.abs(tl.items[1].times[0] - (0.1 + maxGap)) < 1e-9);
  assert(Math.abs(tl.duration - (0.2 + maxGap)) < 1e-9);
  // A shorter gap is kept as it is.
  const short = buildTimeline([stroke(0, 11), stroke(100 + 300, 11)]);
  assert(Math.abs(short.items[1].times[0] - 0.4) < 1e-9);
});

Deno.test("speed per point and the colour scale", () => {
  const s = stroke(0, 11); // 0.05 xh per 10 ms = 5 xh/s
  const sp = pointSpeeds(s, s.points.map((p) => p.t / 1000));
  assert(sp.every((x) => Math.abs(x - 5) < 1e-9));
  assert(Math.abs(buildTimeline([s]).speedRef - 5) < 1e-9);
  assertEquals(heat(0), "rgb(33, 84, 217)");
  assertEquals(heat(1), "rgb(217, 33, 33)");
});

Deno.test("what is written by a time: finished strokes and the live one's points plus an interpolated tip", () => {
  const tl = buildTimeline([stroke(0, 11), stroke(500, 11)]);
  assertEquals(finishedCount(tl, 0.05), 0);
  assertEquals(finishedCount(tl, 0.1), 1);
  const pts = writtenPoints(tl.items[0], 0.055);
  assertEquals(pts.length, 7); // points 0..5, plus the tip between 5 and 6
  assert(Math.abs(pts[6].u - 0.275) < 1e-9);
  assertEquals(writtenPoints(tl.items[1], 0.05), []);
});
