import { describe, expect, it } from 'vitest';
import { PLAYER } from '../src/core/config';
import { World } from '../src/sim/World';

/**
 * A deliberately mediocre scripted commander (no walls, no direct control,
 * no orbital strikes). Used as a pacing guard: on Recruit even this bot
 * should be able to win, and battles must always resolve.
 */
async function play(difficulty: string, seed: number) {
  const w = await World.create({ seed, difficulty });
  let think = 0;
  for (let t = 0; t < 1800 && !w.over; t += 1 / 15) {
    w.update(1 / 15);
    think -= 1 / 15;
    if (think > 0 || w.time < 6) continue;
    think = 4;
    const team = w.teams[PLAYER];
    const idle = w.units.filter((u) => u.team === PLAYER && u.kind !== 'engineer' && u.order.type === 'idle');
    const pts = [...w.points].sort((a, b) => (a.owner === 0 ? 1 : 0) - (b.owner === 0 ? 1 : 0) || Math.abs(a.x + 100) - Math.abs(b.x + 100));
    if (idle.length >= 3 || w.time < 30) w.orderMove(idle, pts[0].x, pts[0].z, true);
    for (const p of w.points) {
      if (p.owner !== PLAYER) continue;
      const turrets = w.structures.filter((s) => s.team === PLAYER && s.kind === 'turret' && Math.hypot(s.x - p.x, s.z - p.z) < 16).length;
      if (turrets < 2 && team.supply > 140) w.placeStructure(PLAYER, 'turret', p.x + 9, p.z + (turrets ? 7 : -7));
    }
    const kinds = ['rifle', 'rifle', 'heavy', 'rifle', 'tank', 'engineer'] as const;
    if (w.units.filter((u) => u.team === PLAYER && u.kind === 'engineer').length < 2) w.queueUnit(PLAYER, 'engineer');
    else if (team.supply > 120) w.queueUnit(PLAYER, kinds[Math.floor(w.time / 4) % kinds.length]);
  }
  const result = { winner: w.winner, time: w.time, kills: w.stats.kills, losses: w.stats.losses };
  w.dispose();
  return result;
}

describe('battle pacing', () => {
  it('a basic strategy wins on Recruit, with real resistance', async () => {
    const r = await play('recruit', 11);
    expect(r.winner).toBe(PLAYER);
    expect(r.time).toBeGreaterThan(240);
    expect(r.losses).toBeGreaterThan(3);
  });
  it('the same basic strategy is not enough on Elite', async () => {
    const r = await play('elite', 11);
    expect(r.winner).not.toBe(PLAYER);
  });
});
