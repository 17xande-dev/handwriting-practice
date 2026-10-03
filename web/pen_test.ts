/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { TapTracker } from "./pen.ts";

/** Fingers landing at `downs` ms, lifting at `ups` ms, moving `move` px. */
function gesture(downs: number[], ups: number[], move = 0, penAt?: number): number {
  const t = new TapTracker();
  let result = 0;
  const events: Array<[number, () => void]> = [];
  downs.forEach((at, id) => events.push([at, () => t.down(id, 100 * id, 100, at)]));
  downs.forEach((at, id) => events.push([at + 1, () => t.move(id, 100 * id + move, 100)]));
  ups.forEach((at, id) => events.push([at, () => (result = t.up(id, at) || result)]));
  if (penAt !== undefined) events.push([penAt, () => t.pen()]);
  for (const [, fn] of events.sort((a, b) => a[0] - b[0])) fn();
  return result;
}

Deno.test("two- and three-finger taps are recognised", () => {
  assertEquals(gesture([0, 30], [150, 170]), 2);
  assertEquals(gesture([0, 20, 40], [160, 170, 180]), 3);
});

// Everything that isn't a deliberate tap must do nothing: a mistaken undo
// throws away writing.
Deno.test("scrolls, slow presses, staggered landings, palms and the Pencil are not taps", () => {
  assertEquals(gesture([0], [100]), 0, "one finger");
  assertEquals(gesture([0, 30], [150, 170], 40), 0, "a two-finger scroll moves");
  assertEquals(gesture([0, 30], [600, 620]), 0, "held too long");
  assertEquals(gesture([0, 300], [350, 360]), 0, "second finger landed late, like a palm");
  assertEquals(gesture([0, 30], [150, 170], 0, 80), 0, "the Pencil was used meanwhile");
  assertEquals(gesture([0, 10, 20, 30], [150, 150, 150, 150]), 0, "four fingers");
});

Deno.test("a cancelled finger spoils the tap", () => {
  const t = new TapTracker();
  t.down(1, 0, 0, 0);
  t.down(2, 50, 0, 10);
  assertEquals(t.up(1, 100, true), 0);
  assertEquals(t.up(2, 110), 0);
});
