import { describe, expect, it } from 'vitest';
import { NavGrid } from '../src/sim/NavGrid';
import { assignSlots, formationSlots } from '../src/sim/Formation';
import { CapturePoint } from '../src/sim/CapturePoint';

const pathLen = (p: { x: number; z: number }[], sx: number, sz: number) => {
  let d = 0, x = sx, z = sz;
  for (const q of p) {
    d += Math.hypot(q.x - x, q.z - z);
    x = q.x;
    z = q.z;
  }
  return d;
};

function wallAcross(g: NavGrid, x: number, team: number, gapZ?: number) {
  const cells: number[] = [];
  for (let z = -89; z < 90; z += 2) if (gapZ === undefined || Math.abs(z - gapZ) > 2) cells.push(g.cellAt(x, z));
  g.addStructure(77, team, cells, 16);
  return cells;
}

describe('NavGrid', () => {
  it('finds a straight path on open ground', () => {
    const g = new NavGrid();
    const p = g.findPath(-50, 0, 50, 0, { team: 0 });
    expect(p.length).toBeGreaterThan(0);
    expect(p[p.length - 1]).toEqual({ x: 50, z: 0 });
    expect(pathLen(p, -50, 0)).toBeLessThan(104);
  });

  it('routes around structures and reopens when they are destroyed', () => {
    const g = new NavGrid();
    const cells = wallAcross(g, 1, 0, 61);
    const around = g.findPath(-20, 0, 20, 0, { team: 0 });
    expect(pathLen(around, -20, 0)).toBeGreaterThan(100);
    expect(around[around.length - 1]).toEqual({ x: 20, z: 0 });
    for (const p of around) expect(g.walkable(p.x, p.z)).toBe(true);
    g.removeStructure(cells);
    expect(pathLen(g.findPath(-20, 0, 20, 0, { team: 0 }), -20, 0)).toBeLessThan(45);
  });

  it('lets attackers breach a sealed wall but never the owner', () => {
    const g = new NavGrid();
    wallAcross(g, 1, 0);
    const own = g.findPath(-20, 0, 20, 0, { team: 0 });
    expect(Math.hypot(own[own.length - 1].x - 20, own[own.length - 1].z)).toBeGreaterThan(15);
    const breach = g.findPath(-20, 0, 20, 0, { team: 1, breach: true });
    expect(breach[breach.length - 1]).toEqual({ x: 20, z: 0 });
    expect(breach.some((p) => g.struct[g.cellAt(p.x, p.z)] === 77)).toBe(true);
  });

  it('prefers a detour over a breach when the gap is close', () => {
    const g = new NavGrid();
    wallAcross(g, 1, 0, 9);
    const p = g.findPath(-20, 0, 20, 0, { team: 1, breach: true });
    expect(p.some((q) => g.struct[g.cellAt(q.x, q.z)] !== 0)).toBe(false);
  });

  it('avoids danger zones when weighted', () => {
    const g = new NavGrid();
    for (let i = 0; i < g.n; i++) if (Math.hypot(g.centerX(i), g.centerZ(i)) < 20) g.danger[1][i] = 2;
    const safe = g.findPath(-40, 0, 40, 0, { team: 1, danger: 1 });
    const direct = g.findPath(-40, 0, 40, 0, { team: 1 });
    expect(pathLen(safe, -40, 0)).toBeGreaterThan(pathLen(direct, -40, 0) + 5);
  });
});

describe('Formation', () => {
  it('produces distinct slots centred on the target', () => {
    const slots = formationSlots(7, 10, 5, 1, 0);
    expect(slots).toHaveLength(7);
    const cx = slots.reduce((a, s) => a + s.x, 0) / 7;
    expect(Math.abs(cx - 10)).toBeLessThan(2);
    for (let i = 0; i < 7; i++) for (let j = i + 1; j < 7; j++)
      expect(Math.hypot(slots[i].x - slots[j].x, slots[i].z - slots[j].z)).toBeGreaterThan(2);
    expect(new Set(assignSlots(slots.map((s) => ({ x: s.x + 30, z: s.z })), slots)).size).toBe(7);
  });
});

describe('CapturePoint', () => {
  it('captures, contests and flips ownership', () => {
    const p = new CapturePoint(0, 'A', 0, 0);
    let changed = 0;
    for (let i = 0; i < 400 && p.owner !== 0; i++) if (p.update(0.1, 2, 0) !== null) changed++;
    expect(p.owner).toBe(0);
    expect(changed).toBe(1);
    p.update(1, 2, 2);
    expect(p.contested).toBe(true);
    expect(p.progress).toBe(1);
    for (let i = 0; i < 400 && p.owner === 0; i++) p.update(0.1, 0, 3);
    expect(p.owner).toBe(-1);
    for (let i = 0; i < 400 && p.owner !== 1; i++) p.update(0.1, 0, 3);
    expect(p.owner).toBe(1);
  });
});
