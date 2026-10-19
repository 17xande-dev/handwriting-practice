// A one-pixel skeleton as a graph, and snapping a drawn stroke onto it: a port of the iPad's
// SkeletonGraph.swift and StrokeSnap.swift (docs/strokes.md, "Pipeline" and "Define strokes").
// Nodes sit at endpoints and junctions, edges are pixel paths; junction clusters are merged and short
// spurs pruned. The Stroke models editor snaps what the person draws onto the glyph's centreline.
// Pure and deterministic.

import type { Raster } from "./evalcore.ts";
import { skeleton } from "./evalcore.ts";
import type { ModelRaster } from "./evaluate.ts";
import {
  centroid,
  type ModelStroke,
  OrderLimits,
  pathLength,
  type Pt,
  resampleEven,
} from "./stroke-order.ts";

export interface GraphNode {
  /** Pixels (y * w + x) of the merged cluster; `rep` is the member nearest its centre. */
  pixels: number[];
  rep: number;
  degree: number;
}

export interface GraphEdge {
  a: number;
  b: number;
  /** Pixel path from node a's cluster to node b's (both ends included). */
  path: number[];
}

export interface SkeletonGraph {
  w: number;
  h: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const ring: Array<[number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

/** Number of ring neighbours of (x, y) that are ink and how many separate groups they form. */
function ringGroups(d: Uint8Array, w: number, h: number, x: number, y: number): number {
  const on: boolean[] = [];
  let n = 0;
  for (const [ox, oy] of ring) {
    const xx = x + ox, yy = y + oy;
    const v = xx >= 0 && yy >= 0 && xx < w && yy < h && d[yy * w + xx] !== 0;
    on.push(v);
    if (v) n++;
  }
  let g = 0;
  for (let k = 0; k < 8; k++) if (on[k] && !on[(k + 7) % 8]) g++;
  if (n === 8) g = 1;
  return g;
}

/**
 * Build the graph of a thinned raster. A staircase pixel is not a junction: only the number of
 * separate neighbour groups counts (3 or more is a junction, 1 or none an endpoint).
 */
export function buildSkeletonGraph(skel: Raster): SkeletonGraph {
  const { w, h } = skel;
  const d = skel.data;
  const isNode = new Array<boolean>(w * h).fill(false);
  const nodePixels: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[y * w + x] !== 0 && ringGroups(d, w, h, x, y) !== 2) {
        isNode[y * w + x] = true;
        nodePixels.push(y * w + x);
      }
    }
  }
  const cluster = new Array<number>(w * h).fill(-1);
  const nodes: GraphNode[] = [];
  const neighbours = (p: number): number[] => {
    const x = p % w, y = Math.floor(p / w);
    const out: number[] = [];
    for (const [ox, oy] of ring) {
      const xx = x + ox, yy = y + oy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && d[yy * w + xx] !== 0) out.push(yy * w + xx);
    }
    return out;
  };
  const newCluster = (seed: number, nodeTest: (p: number) => boolean) => {
    const id = nodes.length;
    const members = [seed], stack = [seed];
    cluster[seed] = id;
    while (stack.length) {
      const p = stack.pop()!;
      for (const q of neighbours(p)) {
        if (nodeTest(q) && cluster[q] < 0) {
          cluster[q] = id;
          members.push(q);
          stack.push(q);
        }
      }
    }
    const cx = members.reduce((a, m) => a + (m % w), 0) / members.length;
    const cy = members.reduce((a, m) => a + Math.floor(m / w), 0) / members.length;
    let rep = members[0], best = Infinity;
    for (const m of members) {
      const dd = Math.hypot((m % w) - cx, Math.floor(m / w) - cy);
      if (dd < best || (dd === best && m < rep)) {
        best = dd;
        rep = m;
      }
    }
    nodes.push({ pixels: [...members].sort((a, b) => a - b), rep, degree: 0 });
  };
  for (const p of nodePixels) if (cluster[p] < 0) newCluster(p, (q) => isNode[q]);

  const visited = new Array<boolean>(w * h).fill(false);
  const edges: GraphEdge[] = [];
  const trace = (start: number, first: number) => {
    const path = [start, first];
    visited[first] = true;
    let prev = start, cur = first;
    for (;;) {
      const ns = neighbours(cur);
      // Reached a node pixel (not where we came from, unless the path has gone around).
      const end = ns.find((q) =>
        isNode[q] && q !== prev && (cluster[q] !== cluster[start] || path.length > 3)
      );
      if (end !== undefined) {
        path.push(end);
        edges.push({ a: cluster[start], b: cluster[end], path });
        return;
      }
      const cands = ns.filter((q) => !isNode[q] && !visited[q]);
      // 4-neighbours first, then reading order: a deterministic choice among staircase pixels.
      const manhattan = (q: number) =>
        Math.abs((q % w) - (cur % w)) + Math.abs(Math.floor(q / w) - Math.floor(cur / w));
      cands.sort((a, b) => manhattan(a) !== manhattan(b) ? manhattan(a) - manhattan(b) : a - b);
      const nx = cands[0];
      if (nx === undefined) return; // a dead end: only stray pixels
      visited[nx] = true;
      path.push(nx);
      prev = cur;
      cur = nx;
    }
  };
  for (let id = 0; id < nodes.length; id++) {
    for (const p of nodes[id].pixels) {
      for (const q of neighbours(p)) if (!isNode[q] && !visited[q]) trace(p, q);
    }
  }
  // Closed loops with no node at all: start anywhere.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (d[p] !== 0 && !isNode[p] && !visited[p]) {
        isNode[p] = true;
        newCluster(p, (q) => q === p);
        const q = neighbours(p).find((n) => !isNode[n] && !visited[n]);
        if (q !== undefined) trace(p, q);
      }
    }
  }
  for (const e of edges) {
    nodes[e.a].degree++;
    nodes[e.b].degree++;
  }
  return { w, h, nodes, edges };
}

/** Remove spurs (an endpoint to a junction shorter than `minLength` pixels), repeating until nothing changes. */
export function pruneSpurs(skel: Raster, minLength: number): Raster {
  const cur: Raster = { w: skel.w, h: skel.h, data: new Uint8Array(skel.data) };
  for (let iter = 0; iter < 6; iter++) {
    const g = buildSkeletonGraph(cur);
    const remove: number[] = [];
    for (const e of g.edges) {
      if (e.a === e.b) continue;
      const a = g.nodes[e.a], b = g.nodes[e.b];
      const spurOnA = a.degree === 1 && b.degree >= 3;
      const spurOnB = b.degree === 1 && a.degree >= 3;
      if (!(spurOnA || spurOnB) || !(e.path.length < minLength)) continue;
      const drop = spurOnA ? a.pixels : b.pixels;
      const keep = new Set([...a.pixels, ...b.pixels].filter((p) => !drop.includes(p)));
      for (const p of e.path) if (!keep.has(p)) remove.push(p);
      remove.push(...drop);
    }
    if (remove.length === 0) break;
    for (const p of remove) cur.data[p] = 0;
  }
  return cur;
}

/** Connected components (8-neighbour) of the ink pixels, as pixel index lists. */
export function components8(r: Raster): number[][] {
  const seen = new Uint8Array(r.w * r.h);
  const out: number[][] = [];
  for (let s = 0; s < r.w * r.h; s++) {
    if (r.data[s] === 0 || seen[s]) continue;
    const comp = [s], stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % r.w, y = Math.floor(p / r.w);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < r.w && yy < r.h) {
            const q = yy * r.w + xx;
            if (r.data[q] !== 0 && !seen[q]) {
              seen[q] = 1;
              comp.push(q);
              stack.push(q);
            }
          }
        }
      }
    }
    out.push(comp);
  }
  return out;
}

type XY = [number, number];

function distToSegment(px: number, py: number, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/** Ramer-Douglas-Peucker on a polyline of (x, y). */
export function simplify(pts: XY[], epsilon: number): XY[] {
  if (pts.length < 3) return pts;
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let worst = 0, wi = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToSegment(pts[i][0], pts[i][1], pts[lo], pts[hi]);
      if (d > worst) {
        worst = d;
        wi = i;
      }
    }
    if (wi >= 0 && worst > epsilon) {
      keep[wi] = true;
      stack.push([lo, wi], [wi, hi]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Where pixel coordinates meet the glyph frame: `u = (x - ox) / scale`, `v = (y - oy) / scale`. */
export interface PixelFrame {
  ox: number;
  oy: number;
  scale: number;
}

const frameUV = (f: PixelFrame, x: number, y: number): Pt => ({
  u: (x - f.ox) / f.scale,
  v: (y - f.oy) / f.scale,
});

/** Spurs shorter than this many x-heights are pruned. */
export const spurLength = 0.15;

/** A glyph's skeleton, ready to snap strokes to: thinned and spur-pruned like the pipeline's, plus its graph. */
export interface SnapTarget {
  skeleton: Raster;
  frame: PixelFrame;
  graph: SkeletonGraph;
  pixels: number[];
  /** Components smaller than a dot (`0.45 S` pixels), by their pixels. */
  dots: number[][];
}

export function snapTargetOfSkeleton(skel: Raster, frame: PixelFrame): SnapTarget {
  const pixels: number[] = [];
  for (let i = 0; i < skel.w * skel.h; i++) if (skel.data[i] !== 0) pixels.push(i);
  return {
    skeleton: skel,
    frame,
    graph: buildSkeletonGraph(skel),
    pixels,
    dots: components8(skel).filter((c) => c.length <= 0.45 * frame.scale),
  };
}

/** The target of a single-character model raster (the glyph's own centreline). */
export function snapTargetOf(r: ModelRaster): SnapTarget {
  const model: Raster = { w: r.w, h: r.h, data: r.ink };
  const skel = pruneSpurs(skeleton(model), Math.round(spurLength * r.S));
  return snapTargetOfSkeleton(skel, { ox: r.bounds[0], oy: r.Yb, scale: r.S });
}

/** Skeleton pixels in the glyph frame (for drawing). */
export function targetPoints(t: SnapTarget): Pt[] {
  return t.pixels.map((p) => frameUV(t.frame, p % t.skeleton.w, Math.floor(p / t.skeleton.w)));
}

export interface SnappedStroke {
  stroke: ModelStroke;
  /** Mean distance of the drawn waypoints from the skeleton (x-heights); large means the stroke was not on the glyph. */
  meanDistance: number;
}

class MinHeap {
  a: Array<[number, number]> = [];
  get size() {
    return this.a.length;
  }
  push(x: [number, number]) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Snap a drawn stroke (glyph frame, upright) onto the target's skeleton: resampled every `spacing`
 * x-heights, each waypoint to the nearest skeleton pixel within `reach`, the ends onto a graph node when
 * one is close (an endpoint within 0.22, a junction within 0.14), consecutive waypoints joined by the
 * cheapest path along the skeleton (pulled towards the straight run between them, so loops are followed
 * the way they were drawn), smoothed (5-point mean) and simplified (0.5 px). A drawing shorter than 0.15
 * is a dot at the nearest small component. Null when empty or nowhere near the skeleton.
 */
export function snapDrawnStroke(
  drawn: Pt[],
  t: SnapTarget,
  spacing = 0.2,
  reach = 0.7,
): SnappedStroke | null {
  if (drawn.length === 0 || t.pixels.length === 0) return null;
  const { w, h } = t.skeleton;
  const S = t.frame.scale;
  const px = (p: Pt): XY => [p.u * S + t.frame.ox, p.v * S + t.frame.oy];
  const arc = pathLength(drawn);

  if (arc < OrderLimits.tinyArc) {
    const c = centroid(drawn);
    const [cx, cy] = px(c);
    let best: [Pt, number] | null = null;
    for (const comp of t.dots) {
      const mx = comp.reduce((a, p) => a + (p % w), 0) / comp.length;
      const my = comp.reduce((a, p) => a + Math.floor(p / w), 0) / comp.length;
      const d = Math.hypot(mx - cx, my - cy) / S;
      if (d <= reach && (!best || d < best[1])) best = [frameUV(t.frame, mx, my), d];
    }
    const p = best ? best[0] : c;
    return { stroke: { pts: [[p.u, p.v]], kind: "dot" }, meanDistance: best ? best[1] : 0 };
  }

  const n = Math.max(4, Math.min(60, Math.ceil(arc / spacing) + 1));
  const way = resampleEven(drawn, n);
  const nearest = (q: XY): [number, number] | null => {
    let best = -1, bd = Infinity;
    for (const p of t.pixels) {
      const d = Math.hypot((p % w) - q[0], Math.floor(p / w) - q[1]);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best >= 0 && bd / S <= reach ? [best, bd / S] : null;
  };
  const snapped: Array<{ pixel: number; target: XY }> = [];
  const dists: number[] = [];
  for (const p of way) {
    const q = px(p);
    const r = nearest(q);
    if (!r) continue;
    dists.push(r[1]);
    if (snapped.length === 0 || snapped[snapped.length - 1].pixel !== r[0]) {
      snapped.push({ pixel: r[0], target: q });
    }
  }
  if (snapped.length < 2) return null;

  const toNode = (p: number): number => {
    const x = p % w, y = Math.floor(p / w);
    let best = p, bd = Infinity;
    for (const node of t.graph.nodes) {
      const r = node.rep;
      const d = Math.hypot((r % w) - x, Math.floor(r / w) - y) / S * (node.degree === 1 ? 1 : 1.6);
      if (d < bd && d <= 0.22) {
        bd = d;
        best = r;
      }
    }
    return best;
  };
  snapped[0].pixel = toNode(snapped[0].pixel);
  snapped[snapped.length - 1].pixel = toNode(snapped[snapped.length - 1].pixel);

  const usable = new Uint8Array(w * h);
  for (const p of t.pixels) usable[p] = 1;
  const offsets: Array<[number, number]> = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];
  const path = (a: number, b: number, ca: XY, cb: XY): number[] | null => {
    if (a === b) return [a];
    const dist = new Float64Array(w * h).fill(Infinity);
    const prev = new Int32Array(w * h).fill(-1);
    const heap = new MinHeap();
    dist[a] = 0;
    heap.push([0, a]);
    for (let top = heap.pop(); top; top = heap.pop()) {
      const [d, p] = top;
      if (d > dist[p]) continue;
      if (p === b) break;
      const x = p % w, y = Math.floor(p / w);
      for (const [dx, dy] of offsets) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || !usable[yy * w + xx]) continue;
        const q = yy * w + xx;
        const step = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
        const off = distToSegment(xx, yy, ca, cb) / (0.4 * S);
        const nd = d + step * (1 + 2 * Math.min(1, off));
        if (nd < dist[q]) {
          dist[q] = nd;
          prev[q] = p;
          heap.push([nd, q]);
        }
      }
    }
    if (!Number.isFinite(dist[b])) return null;
    const out = [b];
    for (let cur = b; cur !== a;) {
      cur = prev[cur];
      out.push(cur);
    }
    return out.reverse();
  };
  const chain: number[] = [];
  for (let i = 0; i < snapped.length - 1; i++) {
    const a = snapped[i], b = snapped[i + 1];
    const seg = path(a.pixel, b.pixel, a.target, b.target);
    if (seg) chain.push(...(chain.length === 0 ? seg : seg.slice(1)));
    else {
      // Not connected on the skeleton (the stroke jumped between pieces): go straight.
      if (chain.length === 0) chain.push(a.pixel);
      chain.push(b.pixel);
    }
  }
  // Smooth the staircase, keep the corners.
  const src: XY[] = chain.map((p) => [p % w, Math.floor(p / w)]);
  const pts: XY[] = src.map((p) => [p[0], p[1]]);
  if (pts.length > 5) {
    for (let i = 2; i < src.length - 2; i++) {
      let sx = 0, sy = 0;
      for (let k = i - 2; k <= i + 2; k++) {
        sx += src[k][0];
        sy += src[k][1];
      }
      pts[i] = [sx / 5, sy / 5];
    }
  }
  const simp = simplify(pts, 0.5);
  const mean = dists.reduce((a, b) => a + b, 0) / Math.max(1, dists.length);
  return {
    stroke: {
      pts: simp.map(([x, y]) => {
        const p = frameUV(t.frame, x, y);
        return [p.u, p.v];
      }),
    },
    meanDistance: mean,
  };
}

/** A stroke drawn the other way round (the "Reverse" control). */
export const reversedStroke = (s: ModelStroke): ModelStroke => ({
  pts: [...s.pts].reverse(),
  ...(s.kind ? { kind: s.kind } : {}),
});
