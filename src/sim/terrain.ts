import { BASES, MAP, POINT_DEFS } from '../core/config';

function hash(x: number, z: number, seed: number): number {
  let h = (x * 374761393 + z * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function valueNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi, seed), b = hash(xi + 1, zi, seed);
  const c = hash(xi, zi + 1, seed), d = hash(xi + 1, zi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, z: number, seed: number, oct = 4): number {
  let amp = 0.5, f = 1, sum = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * valueNoise(x * f, z * f, seed + i * 17);
    amp *= 0.5;
    f *= 2.03;
  }
  return sum;
}

const sstep = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export type HeightFn = (x: number, z: number) => number;

/** Gentle rolling battlefield, flattened at bases/objectives, ringed by mountains. */
export function makeHeightFn(seed: number): HeightFn {
  return (x, z) => {
    let flat = 1;
    for (const b of BASES) flat = Math.min(flat, sstep(22, 44, Math.hypot(x - b.x, z - b.z)));
    for (const p of POINT_DEFS) flat = Math.min(flat, 0.25 + 0.75 * sstep(9, 22, Math.hypot(x - p.x, z - p.z)));
    let h = (fbm(x * 0.035, z * 0.035, seed) - 0.47) * 4.2 * flat;
    const edge = Math.max((Math.abs(x) - (MAP.playW + 2)) / 1.0, (Math.abs(z) - (MAP.playH + 2)) / 1.0);
    if (edge > 0) {
      const m = Math.min(edge, 60);
      h += m * m * 0.02 + m * (0.25 + fbm(x * 0.06, z * 0.06, seed + 99) * 1.1);
    }
    return h;
  };
}
