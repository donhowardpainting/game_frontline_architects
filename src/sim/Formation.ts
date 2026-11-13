import type { Pt } from './NavGrid';

/**
 * Block formation centred on (cx,cz), facing along (dirX,dirZ).
 * Front rank first, so the toughest units can be assigned forward slots.
 */
export function formationSlots(n: number, cx: number, cz: number, dirX: number, dirZ: number, spacing = 2.6): Pt[] {
  const len = Math.hypot(dirX, dirZ) || 1;
  const fx = dirX / len, fz = dirZ / len;
  const rx = -fz, rz = fx;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.8)));
  const rows = Math.ceil(n / cols);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const col = i - row * cols;
    const side = (col - (inRow - 1) / 2) * spacing;
    const back = ((rows - 1) / 2 - row) * spacing;
    out.push({ x: cx + rx * side + fx * back, z: cz + rz * side + fz * back });
  }
  return out;
}

/** Greedy nearest assignment of units to slots; returns slot index per unit. */
export function assignSlots(units: Pt[], slots: Pt[]): number[] {
  const taken = new Array(slots.length).fill(false);
  const result = new Array(units.length).fill(-1);
  const pairs: Array<[number, number, number]> = [];
  for (let u = 0; u < units.length; u++)
    for (let s = 0; s < slots.length; s++)
      pairs.push([Math.hypot(units[u].x - slots[s].x, units[u].z - slots[s].z), u, s]);
  pairs.sort((a, b) => a[0] - b[0]);
  for (const [, u, s] of pairs) {
    if (result[u] !== -1 || taken[s]) continue;
    result[u] = s;
    taken[s] = true;
  }
  return result;
}
