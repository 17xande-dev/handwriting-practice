// The pure core of "Check my writing": rasters, distances, thinning,
// alignment and scoring. Nothing here touches the DOM, so it is tested
// directly (evalcore_test.ts); evaluate.ts does the drawing and wiring.

/** A binary image: 1 is ink. Row-major, `w` columns by `h` rows. */
export interface Raster {
  w: number;
  h: number;
  data: Uint8Array;
}

export function raster(w: number, h: number): Raster {
  return { w, h, data: new Uint8Array(w * h) };
}

/** The squared-distance lower envelope along one line (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/**
 * Exact Euclidean distance, in pixels, from every pixel to the nearest ink
 * pixel (0 on ink). Separable: a 1-D pass down the columns, then along rows.
 */
export function distanceTransform(r: Raster): Float32Array {
  const { w, h, data } = r;
  const INF = 1e20;
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n);
  const v = new Int32Array(n), z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = data[y * w + x] ? 0 : INF;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}

/**
 * Thin ink to a one-pixel centreline (Zhang–Suen). The model letters are
 * filled shapes; their skeletons are the paths a pen would trace, which is
 * what the user's strokes are compared against.
 */
export function skeleton(r: Raster): Raster {
  const { w, h } = r;
  const img = new Uint8Array(r.data);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x]);
  const remove: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pass of [0, 1]) {
      remove.length = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!img[y * w + x]) continue;
          // Neighbours clockwise from north: p2..p9.
          const p = [
            at(x, y - 1),
            at(x + 1, y - 1),
            at(x + 1, y),
            at(x + 1, y + 1),
            at(x, y + 1),
            at(x - 1, y + 1),
            at(x - 1, y),
            at(x - 1, y - 1),
          ];
          const b = p.reduce((a, c) => a + c, 0);
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let i = 0; i < 8; i++) if (!p[i] && p[(i + 1) % 8]) a++;
          if (a !== 1) continue;
          if (pass === 0) {
            if (p[0] * p[2] * p[4] || p[2] * p[4] * p[6]) continue;
          } else if (p[0] * p[2] * p[6] || p[0] * p[4] * p[6]) continue;
          remove.push(y * w + x);
        }
      }
      for (const i of remove) img[i] = 0;
      if (remove.length) changed = true;
    }
  }
  return { w, h, data: img };
}

/**
 * Align two sequences of column features with dynamic time warping inside a
 * band, and return, for every index of `a`, the mean index of `b` it matched.
 * The map is monotonic. A small penalty on non-diagonal steps stops the warp
 * stretching freely where the columns are empty.
 */
export function dtw(
  a: number[][],
  b: number[][],
  bandFraction = 0.3,
  stepPenalty = 0.05,
): number[] {
  const n = a.length, m = b.length;
  if (n === 0) return [];
  if (m === 0) return a.map(() => 0);
  const band = Math.max(Math.ceil(bandFraction * Math.max(n, m)), Math.abs(n - m) + 2);
  const cost = (i: number, j: number) => {
    let s = 0;
    const ai = a[i], bj = b[j];
    for (let k = 0; k < ai.length; k++) s += Math.abs(ai[k] - bj[k]);
    return s;
  };
  const INF = Infinity;
  const acc = new Float64Array(n * m).fill(INF);
  const from = new Uint8Array(n * m); // 0 diagonal, 1 from (i-1, j), 2 from (i, j-1)
  for (let i = 0; i < n; i++) {
    const centre = Math.round((i * (m - 1)) / Math.max(1, n - 1));
    const lo = Math.max(0, centre - band), hi = Math.min(m - 1, centre + band);
    for (let j = lo; j <= hi; j++) {
      const c = cost(i, j);
      if (i === 0 && j === 0) {
        acc[0] = c;
        continue;
      }
      let best = INF, dir = 0;
      if (i > 0 && j > 0 && acc[(i - 1) * m + j - 1] < best) {
        best = acc[(i - 1) * m + j - 1];
        dir = 0;
      }
      if (i > 0 && acc[(i - 1) * m + j] + stepPenalty < best) {
        best = acc[(i - 1) * m + j] + stepPenalty;
        dir = 1;
      }
      if (j > 0 && acc[i * m + j - 1] + stepPenalty < best) {
        best = acc[i * m + j - 1] + stepPenalty;
        dir = 2;
      }
      acc[i * m + j] = best + c;
      from[i * m + j] = dir;
    }
  }
  const sum = new Float64Array(n), count = new Float64Array(n);
  let i = n - 1, j = m - 1;
  for (;;) {
    sum[i] += j;
    count[i]++;
    if (i === 0 && j === 0) break;
    const dir = from[i * m + j];
    if (i === 0) j--;
    else if (j === 0) i--;
    else if (dir === 0) {
      i--;
      j--;
    } else if (dir === 1) i--;
    else j--;
  }
  return Array.from(sum, (s, k) => (count[k] ? s / count[k] : 0));
}

/** Invert a monotonic map from 0..n-1 onto 0..m-1, linearly, for 0..m-1. */
export function invert(map: number[], m: number): number[] {
  const out = new Array<number>(m);
  let k = 0;
  for (let j = 0; j < m; j++) {
    while (k < map.length - 2 && map[k + 1] < j) k++;
    const a = map[k], b = map[Math.min(k + 1, map.length - 1)];
    const t = b > a ? Math.min(1, Math.max(0, (j - a) / (b - a))) : 0;
    out[j] = k + t;
  }
  return out;
}

/** Interpolate a column map at a fractional position. */
export function sample(map: number[], x: number): number {
  if (map.length === 0) return x;
  if (x <= 0) return map[0] + x;
  const last = map.length - 1;
  if (x >= last) return map[last] + (x - last);
  const i = Math.floor(x), t = x - i;
  return map[i] * (1 - t) + map[i + 1] * t;
}

export interface LetterScore {
  /** 0–100. */
  score: number;
  /** Share of the user's ink within tolerance of the model letter, 0–1. */
  precision: number;
  /** Share of the model letter's centreline the user's ink reached, 0–1. */
  coverage: number;
  /** No ink where the letter should be. */
  missing: boolean;
}

/**
 * Score one letter from distances already looked up:
 * `userToModel` — for each user ink sample in the letter, its distance to
 * the model's ink; `modelToUser` — for each model centreline pixel in the
 * letter, its distance to the user's ink. Both in pixels, against `tol`.
 */
export function scoreLetter(
  userToModel: number[],
  modelToUser: number[],
  tol: number,
): LetterScore {
  const within = (
    xs: number[],
    t: number,
  ) => (xs.length ? xs.filter((d) => d <= t).length / xs.length : 0);
  const precision = within(userToModel, tol);
  // The model's centreline is reached if the user's line passes near it; a
  // little more slack than for precision, since a pen line is drawn at its
  // own centre and the model's skeleton sits mid-stroke.
  const coverage = within(modelToUser, tol * 1.5);
  const missing = userToModel.length === 0 && coverage < 0.2;
  const score = missing ? 0 : Math.round(100 * (0.5 * precision + 0.5 * coverage));
  return { score, precision, coverage, missing };
}

/** The median of a list, or NaN for an empty one. */
export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
