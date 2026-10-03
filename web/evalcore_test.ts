/// <reference lib="deno.ns" />

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  credit,
  distanceTransform,
  dtw,
  raster,
  sample,
  scoreLetter,
  skeleton,
} from "./evalcore.ts";

function randomRaster(w: number, h: number, density: number, seed: number) {
  const r = raster(w, h);
  let s = seed;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    r.data[i] = s / 0x7fffffff < density ? 1 : 0;
  }
  return r;
}

// The distance transform decides whether a stroke is "on" the model, so it
// must be exact, not an approximation that drifts on diagonals.
Deno.test("distance transform matches brute force", () => {
  for (const [w, h, density, seed] of [[17, 11, 0.05, 1], [23, 19, 0.01, 7], [9, 30, 0.2, 3]]) {
    const r = randomRaster(w, h, density, seed);
    r.data[0] = 1; // at least one ink pixel
    const dt = distanceTransform(r);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = Infinity;
        for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            if (r.data[yy * w + xx]) best = Math.min(best, Math.hypot(x - xx, y - yy));
          }
        }
        assertAlmostEquals(dt[y * w + x], best, 1e-4);
      }
    }
  }
});

// A model letter's stem is a filled band several pixels wide; its skeleton
// must be a single centred line, the path a pen would take.
Deno.test("skeleton of a thick bar is a one-pixel centreline", () => {
  const w = 40, h = 60;
  const r = raster(w, h);
  for (let y = 10; y < 50; y++) for (let x = 15; x < 24; x++) r.data[y * w + x] = 1;
  const s = skeleton(r);
  let rows = 0;
  for (let y = 15; y < 45; y++) {
    const xs: number[] = [];
    for (let x = 0; x < w; x++) if (s.data[y * w + x]) xs.push(x);
    assertEquals(xs.length, 1, `row ${y} has ${xs.length} skeleton pixels`);
    assert(Math.abs(xs[0] - 19) <= 1, `row ${y} centre at ${xs[0]}`);
    rows++;
  }
  assert(rows > 20);
});

// Writing that is the model stretched (wider letters, wider gaps) must still
// line up letter for letter.
Deno.test("dtw recovers a known stretch", () => {
  const pattern = (x: number) => [x % 10 < 3 ? 1 : 0, x % 20 < 2 ? 1 : 0, 0];
  const model = Array.from({ length: 100 }, (_, x) => pattern(x));
  const user = Array.from({ length: 150 }, (_, x) => pattern(Math.floor(x / 1.5)));
  const map = dtw(model, user);
  for (const x of [10, 30, 50, 70, 90]) {
    assert(Math.abs(map[x] - x * 1.5) <= 3, `model ${x} → ${map[x]}, want ~${x * 1.5}`);
  }
  for (let i = 1; i < map.length; i++) assert(map[i] >= map[i - 1], "map not monotonic");
  assertAlmostEquals(sample([0, 2, 4], 1.5), 3);
});

// The score must rank writing on the model's centreline above writing a
// little off it, above writing well off it, above no writing at all.
Deno.test("scores fall off with distance from the centreline", () => {
  const [full, zero] = [2, 8];
  const exact = scoreLetter([0, 1, 0.5, 2], [0, 1, 0.5, 2], full, zero);
  const near = scoreLetter([3, 4, 3, 5], [3, 4, 4, 3], full, zero);
  const far = scoreLetter([6, 7, 9, 12], [8, 6, 7, 10], full, zero);
  const absent = scoreLetter([], [30, 40, 50], full, zero);
  assertEquals(exact.score, 100);
  assert(
    near.score < exact.score && near.score > far.score,
    `near ${near.score}, far ${far.score}`,
  );
  assert(far.score > absent.score, `far ${far.score}`);
  assertEquals(absent.score, 0);
  assert(absent.missing);
  assert(!far.missing);
});

Deno.test("credit is full, then linear, then none", () => {
  assertEquals(credit(1, 2, 8), 1);
  assertEquals(credit(5, 2, 8), 0.5);
  assertEquals(credit(9, 2, 8), 0);
});
