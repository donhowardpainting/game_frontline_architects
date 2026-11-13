import { describe, expect, it } from 'vitest';
import { ENEMY, PLAYER } from '../src/core/config';
import { World } from '../src/sim/World';

const run = (w: World, seconds: number, dt = 1 / 20) => {
  for (let t = 0; t < seconds && !w.over; t += dt) w.update(dt);
};

describe('World simulation (headless)', () => {
  it('generates a connected battlefield with both bases', async () => {
    const w = await World.create({ seed: 1234 });
    expect(w.hq[PLAYER].alive && w.hq[ENEMY].alive).toBe(true);
    expect(w.obstacles.length).toBeGreaterThan(20);
    expect(w.units.filter((u) => u.team === PLAYER).length).toBe(8);
    w.dispose();
  });

  it('engineers build structures that block movement and sight, and destruction reopens them', async () => {
    const w = await World.create({ seed: 42 });
    run(w, 6);
    const eng = w.units.find((u) => u.kind === 'engineer')!;
    const x = -70, z = 0;
    const s = w.placeStructure(PLAYER, 'wall', x, z)!;
    expect(s).toBeTruthy();
    expect(w.grid.walkable(s.x, s.z)).toBe(false);
    w.orderBuild([eng], s);
    run(w, 25);
    expect(s.done).toBe(true);
    expect(w.physics.segment(s.x - 3, s.y + 1.2, s.z, s.x + 3, s.y + 1.2, s.z)).not.toBeNull();
    w.damageStructure(s, 99999, null);
    expect(s.alive).toBe(false);
    expect(w.grid.walkable(s.x, s.z)).toBe(true);
    run(w, 0.2);
    expect(w.physics.segment(s.x - 3, s.y + 1.2, s.z, s.x + 3, s.y + 1.2, s.z)).toBeNull();
    w.dispose();
  });

  it('units follow move orders and capture territory', async () => {
    const w = await World.create({ seed: 7 });
    w.director.update = () => {};
    run(w, 6);
    const squad = w.units.filter((u) => u.team === PLAYER && u.kind === 'rifle');
    const a = w.points[0];
    w.orderMove(squad, a.x, a.z);
    run(w, 60);
    expect(squad.filter((u) => u.alive && Math.hypot(u.x - a.x, u.z - a.z) < a.radius).length).toBeGreaterThan(0);
    expect(a.progress).toBeGreaterThan(0);
    w.dispose();
  });

  it('the battle keeps evolving while a unit is under direct control', async () => {
    const w = await World.create({ seed: 99 });
    run(w, 6);
    const me = w.units.find((u) => u.team === PLAYER && u.kind === 'rifle')!;
    me.controlled = true;
    w.controlled = me;
    const others = w.units.filter((u) => u.team === PLAYER && u !== me && u.kind === 'rifle');
    w.orderMove(others, -40, 0);
    const before = { x: me.x, z: me.z };
    run(w, 20);
    expect(me.x).toBe(before.x);
    expect(others.some((u) => u.x > -60)).toBe(true);
    expect(w.units.filter((u) => u.team === ENEMY).length).toBeGreaterThan(3);
    w.dispose();
  });

  it('an unopposed enemy takes ground and eventually wins — with no stuck units', async () => {
    const w = await World.create({ seed: 5, difficulty: 'veteran' });
    let enemyCaptured = false;
    w.events.on('pointChange', ({ point }) => {
      if (point.owner === ENEMY) enemyCaptured = true;
    });
    run(w, 900, 1 / 15);
    expect(enemyCaptured).toBe(true);
    expect(w.over).toBe(true);
    expect(w.winner).toBe(ENEMY);
    w.dispose();
  });
});
