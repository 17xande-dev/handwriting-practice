/// <reference lib="deno.ns" />

// The aids' geometry, as the iPad's StrokeAidsTests check it (same numbers).

import { assert, assertEquals } from "@std/assert";
import {
  arrowAt,
  demoSettings,
  DemoTimeline,
  letterAt,
  lineStrokes,
  placeLetters,
  traceProgress,
} from "./stroke-aids.ts";
import { lookupOf, parseModelFile } from "./stroke-models.ts";
import { strokePoints } from "./stroke-order.ts";
import italicModel from "../internal/handler/static/strokes/italic.json" with { type: "json" };

const italic = parseModelFile(italicModel)!;

/** Text laid out with advances of 1.0 and then 0.5 x-heights. */
function line(text = "hi", file = italic) {
  const starts = [0];
  [...text].forEach((_, i) => starts.push(starts[i] + (i === 0 ? 1.0 : 0.5)));
  return placeLetters(text, starts, lookupOf(file.glyphs));
}

Deno.test("letters are laid out by advance; code point indices; shifted by origin", () => {
  const ls = line("h i");
  assertEquals(ls.map((l) => l.char), ["h", "i"]);
  assertEquals(ls.map((l) => l.index), [0, 2]);
  const strokes = lineStrokes(ls);
  assertEquals(strokes.filter((s) => s.letter === 1).length, italic.glyphs["i"].strokes.length);
  const i0 = strokePoints(italic.glyphs["i"].strokes[0])[0];
  const placed = strokes.find((s) => s.letter === 1)!.pts[0];
  assert(Math.abs(placed.u - (i0.u + ls[1].originU)) < 1e-12 && placed.v === i0.v);
  assertEquals(letterAt(ls, 0.2), 0);
  assertEquals(letterAt(ls, ls[1].originU + 0.1), 1);
  assertEquals(letterAt(ls, 99), 1);
});

Deno.test("low confidence glyphs are not placed", () => {
  const f = structuredClone(italic);
  f.glyphs["h"].confidence = 0.3;
  assertEquals(placeLetters("h", [0, 1], lookupOf(f.glyphs)), []);
});

Deno.test("the demo timeline orders strokes and pauses between", () => {
  const a = { pts: [{ u: 0, v: 0 }, { u: 0, v: -1 }], isDot: false, group: 0 };
  const b = { pts: [{ u: 1, v: 0 }, { u: 1, v: -2 }], isDot: false, group: 0 };
  const dot = { pts: [{ u: 2, v: -1.5 }], isDot: true, group: 1 };
  const t = new DemoTimeline([a, b, dot], {
    speed: 2,
    strokePause: 0.5,
    letterPause: 0.25,
    dotTime: 0.3,
  });
  assertEquals(t.starts[0], 0);
  assert(Math.abs(t.ends[0] - 0.5) < 1e-12);
  assert(Math.abs(t.starts[1] - 1.0) < 1e-12 && Math.abs(t.ends[1] - 2.0) < 1e-12);
  assert(Math.abs(t.starts[2] - 2.75) < 1e-12);
  assert(Math.abs(t.duration - 3.05) < 1e-12);
  const f = t.frame(1.5);
  assertEquals(f.finished, [0]);
  assertEquals(f.active, 1);
  assert(Math.abs(f.tip!.v - -1.0) < 1e-9 && f.tip!.u === 1);
  const g = t.frame(0.7);
  assertEquals([g.finished, g.active, g.tip], [[0], null, null]);
  assertEquals(t.frame(99).finished, [0, 1, 2]);
  assertEquals(t.frame(2.8).partial, []);
  assertEquals(t.frame(2.95).partial, [{ u: 2, v: -1.5 }]);
});

Deno.test("speed scales the demo; one letter's demo has its strokes", () => {
  const s = lineStrokes(line());
  assert(
    DemoTimeline.ofLine(s, null, demoSettings(1)).duration >
      DemoTimeline.ofLine(s, null, demoSettings(4)).duration,
  );
  assertEquals(DemoTimeline.ofLine(s, 1).items.length, italic.glyphs["i"].strokes.length);
});

Deno.test("arrows follow the stroke", () => {
  const p = [{ u: 0, v: 0 }, { u: 2, v: 0 }, { u: 2, v: 2 }];
  const a = arrowAt(p, 0.25)!;
  assert(Math.abs(a.at.u - 1) < 1e-12);
  assertEquals(a.dir, { u: 1, v: 0 });
  const b = arrowAt(p, 0.75)!;
  assert(Math.abs(b.at.v - 1) < 1e-12);
  assertEquals(b.dir, { u: 0, v: 1 });
  assertEquals(arrowAt([{ u: 1, v: 1 }], 0.5), null);
});

Deno.test("trace advances as strokes are written", () => {
  const model = lineStrokes(line("hi"));
  assertEquals(traceProgress(model, []).next, 0);
  const p1 = traceProgress(model, [model[0].pts]);
  assertEquals([[...p1.done], p1.next], [[0], 1]);
  const p2 = traceProgress(model, [[{ u: 9, v: 9 }, { u: 9.2, v: 9.3 }]]);
  assertEquals([p2.done.size, p2.next], [0, 0]);
  const dotIdx = model.findIndex((s) => s.isDot);
  const p3 = traceProgress(model, [model[dotIdx].pts]);
  assertEquals([[...p3.done], p3.next], [[dotIdx], 0]);
  const all = traceProgress(model, model.map((s) => s.pts));
  assertEquals([all.done.size, all.next], [model.length, null]);
});
