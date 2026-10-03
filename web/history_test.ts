/// <reference lib="deno.ns" />

import { assert, assertEquals } from "@std/assert";
import { History } from "./history.ts";

/** A list edited by appending, as a line is by writing strokes. */
function line(h: History) {
  const items: string[] = [];
  return {
    items,
    write(x: string) {
      items.push(x);
      h.push({ undo: () => items.splice(items.lastIndexOf(x), 1), redo: () => items.push(x) });
    },
  };
}

Deno.test("undo and redo walk the edits in order across lines", () => {
  const h = new History();
  const a = line(h), b = line(h);
  a.write("a1");
  b.write("b1");
  a.write("a2");
  assert(h.undo());
  assertEquals([a.items, b.items], [["a1"], ["b1"]]);
  assert(h.undo());
  assertEquals([a.items, b.items], [["a1"], []]);
  assert(h.redo());
  assertEquals([a.items, b.items], [["a1"], ["b1"]]);
  assert(h.canUndo && h.canRedo);
});

// Writing something new after undoing makes the undone edits unreachable,
// as in every editor; redoing them then would replay onto a different line.
Deno.test("a new edit clears the redo stack", () => {
  const h = new History();
  const a = line(h);
  a.write("1");
  a.write("2");
  h.undo();
  a.write("3");
  assert(!h.canRedo);
  assert(!h.redo());
  assertEquals(a.items, ["1", "3"]);
});

Deno.test("undo with nothing to undo does nothing", () => {
  const h = new History();
  let changes = 0;
  h.onChange(() => changes++);
  assert(!h.undo());
  assert(!h.redo());
  assertEquals(changes, 0);
});
