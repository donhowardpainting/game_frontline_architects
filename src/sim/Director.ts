import { BASES, ENEMY, PLAYER, UNIT_DEFS, type UnitKind } from '../core/config';
import { formationSlots } from './Formation';
import type { World } from './World';
import type { Squad, Unit } from './entities';

const dist = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);
const STRENGTH: Record<UnitKind, number> = { rifle: 1, engineer: 0.5, heavy: 1.5, tank: 4, sapper: 0.8 };

/**
 * The opposing commander. It does not cheat with map hacks beyond what the
 * player can see from Commander Mode: it scores objectives by value and by
 * how well they are defended, composes waves to counter what the player has
 * built, routes squads around turret kill-zones, reinforces contested
 * ground and pulls broken squads back to regroup.
 */
export class Director {
  budget = 240;
  waveT = 34;
  squads: Squad[] = [];
  private nextSquad = 1;
  private thinkT = 2;
  private defendCd = 0;
  private lastStand = false;
  private opened = false;
  wave = 0;

  constructor(private w: World) {}

  /** Opening move: two strike teams race for the objectives while the player is still landing. */
  private opening(): void {
    const w = this.w;
    const far = w.rng.chance(0.5) ? 0 : 2;
    for (const [index, kinds] of [[1, ['rifle', 'rifle', 'rifle', 'heavy']], [far, ['rifle', 'rifle', 'rifle']]] as Array<[number, UnitKind[]]>) {
      const members = kinds.map((k, i) => w.spawnUnit(k, ENEMY, BASES[1].spawnX - i * 2.5, (index - 1) * 9 + w.rng.range(-2, 2), 'warp'));
      this.sendSquad(this.addSquad(members, { kind: 'point', index }));
    }
    w.events.emit('alert', { text: 'VANTA STRIKE TEAMS ARE MOVING ON THE OBJECTIVES', x: BASES[1].spawnX, z: 0, level: 'warn' });
  }

  spawnGarrison(): void {
    const members: Unit[] = [];
    for (const [k, x, z] of [['rifle', 94, -8], ['rifle', 94, 8], ['heavy', 97, 0]] as Array<[UnitKind, number, number]>) {
      const u = this.w.spawnUnit(k, ENEMY, x, z, 'base');
      u.order = { type: 'hold' };
      members.push(u);
    }
    this.addSquad(members, { kind: 'defend' });
  }

  private addSquad(members: Unit[], objective: Squad['objective']): Squad {
    const s: Squad = { id: this.nextSquad++, members, initial: members.length, objective, state: 'advance', thinkT: 0, quietT: 0 };
    for (const m of members) m.squad = s;
    this.squads.push(s);
    return s;
  }

  private playerStrengthNear(x: number, z: number, r: number): number {
    let s = 0;
    for (const u of this.w.units) if (u.alive && u.team === PLAYER && dist(u.x, u.z, x, z) < r) s += STRENGTH[u.kind];
    for (const st of this.w.structures) {
      if (!st.alive || st.team !== PLAYER || !st.done) continue;
      if (st.kind === 'turret' && dist(st.x, st.z, x, z) < r + 8) s += 2.5;
      else if (st.kind === 'bunker' && dist(st.x, st.z, x, z) < r) s += 1;
    }
    return s;
  }

  private assigned(obj: Squad['objective'], except?: Squad): number {
    let s = 0;
    for (const q of this.squads) {
      if (q === except || q.state === 'retreat') continue;
      if (q.objective.kind === obj.kind && (obj.kind !== 'point' || (q.objective as any).index === obj.index))
        for (const m of q.members) if (m.alive) s += STRENGTH[m.kind];
    }
    return s;
  }

  private chooseObjective(squad: Squad | null, strength: number): Squad['objective'] {
    const w = this.w;
    let best: Squad['objective'] = { kind: 'point', index: 1 };
    let bestScore = -Infinity;
    const enemyPts = w.points.filter((p) => p.owner === ENEMY).length;
    for (const p of w.points) {
      const obj = { kind: 'point' as const, index: p.id };
      const def = this.playerStrengthNear(p.x, p.z, 24);
      const mine = this.assigned(obj, squad ?? undefined);
      let score: number;
      if (p.owner === ENEMY) score = (def > 0 ? 7 + def * 0.5 : 0.5) - mine * 0.9;
      else {
        score = 8 + (p.owner === PLAYER ? 2.5 : 0) - mine * 0.6;
        // Prefer fights we can win; overwhelming defences are avoided until we have the mass.
        score -= Math.max(0, def - strength * 0.9) * 1.1;
        if (def < strength * 0.4) score += 2;
      }
      score += w.rng.next() * 3;
      if (score > bestScore) {
        bestScore = score;
        best = obj;
      }
    }
    if (strength >= 5 && (w.time > 240 || (enemyPts >= 2 && w.time > 150))) {
      const def = this.playerStrengthNear(BASES[0].x, BASES[0].z, 34) + 3;
      const score = 4 + enemyPts * 2.2 + Math.min(4, w.time / 200) - Math.max(0, def - strength) * 1.0 - this.assigned({ kind: 'hq' }, squad ?? undefined) * 0.5 + w.rng.next() * 3;
      if (score > bestScore) best = { kind: 'hq' };
    }
    return best;
  }

  private objectivePos(o: Squad['objective']): { x: number; z: number } {
    if (o.kind === 'point') return this.w.points[o.index];
    if (o.kind === 'hq') return { x: BASES[0].x + 16, z: BASES[0].z };
    return { x: BASES[1].x - 12, z: 0 };
  }

  private sendSquad(s: Squad): void {
    const w = this.w;
    const pos = this.objectivePos(s.objective);
    const alive = s.members.filter((m) => m.alive);
    if (!alive.length) return;
    let cx = 0, cz = 0;
    for (const m of alive) {
      cx += m.x;
      cz += m.z;
    }
    cx /= alive.length;
    cz /= alive.length;
    const slots = formationSlots(alive.length, pos.x, pos.z, pos.x - cx, pos.z - cz, 3.2);
    alive.forEach((m, i) => {
      if (m.order.type === 'attack' && m.order.target.alive && m.kind === 'sapper') return;
      m.breach = null;
      m.toCover = false;
      m.order = { type: 'move', x: slots[i].x, z: slots[i].z, assault: true };
      w.setGoal(m, slots[i].x, slots[i].z);
    });
    s.state = 'advance';
  }

  private composeWave(): UnitKind[] {
    const w = this.w;
    const t = w.time;
    const pStructs = w.structures.filter((s) => s.team === PLAYER && s.kind !== 'hq');
    const turrets = pStructs.filter((s) => s.kind === 'turret').length;
    const walls = pStructs.length - turrets;
    const pTanks = w.units.filter((u) => u.team === PLAYER && u.kind === 'tank').length;
    const weights: Array<[UnitKind, number]> = [
      ['rifle', 5],
      ['sapper', t > 50 ? Math.min(4.5, 0.6 + walls * 0.35 + turrets * 0.6) : 0],
      ['heavy', (t > 110 ? 1.2 : 0) + pTanks * 1.6 + turrets * 0.5],
      ['tank', t > 230 ? 0.8 + t / 420 : 0],
    ];
    const cap = Math.min(this.budget, 260 + t * 0.9);
    let spend = 0;
    const out: UnitKind[] = [];
    const room = w.difficulty.cap - w.teams[ENEMY].pop;
    let pop = 0;
    for (let guard = 0; guard < 40 && out.length < 12; guard++) {
      const opts = weights.filter(([k, wt]) => wt > 0 && UNIT_DEFS[k].cost <= cap - spend && pop + UNIT_DEFS[k].pop <= room);
      if (!opts.length) break;
      let r = w.rng.next() * opts.reduce((a, o) => a + o[1], 0);
      let pick = opts[0][0];
      for (const [k, wt] of opts) {
        r -= wt;
        if (r <= 0) {
          pick = k;
          break;
        }
      }
      out.push(pick);
      spend += UNIT_DEFS[pick].cost;
      pop += UNIT_DEFS[pick].pop;
    }
    this.budget -= spend;
    return out;
  }

  private spawnWave(): void {
    const w = this.w;
    const kinds = this.composeWave();
    if (!kinds.length) return;
    this.wave++;
    const members: Unit[] = [];
    kinds.forEach((k, i) => {
      const u = w.spawnUnit(k, ENEMY, BASES[1].spawnX - (i % 3) * 3, ((i / 3) | 0) * 3.4 - 5 + w.rng.range(-1, 1), 'warp');
      members.push(u);
    });
    // Regrouping survivors join the fresh wave.
    for (const q of this.squads) {
      if (q.state !== 'retreat') continue;
      for (const m of q.members) if (m.alive) members.push(m);
      q.members = [];
    }
    const strength = members.reduce((a, m) => a + STRENGTH[m.kind], 0);
    const s = this.addSquad(members, this.chooseObjective(null, strength));
    this.sendSquad(s);
    if (s.objective.kind === 'hq') w.events.emit('alert', { text: 'ENEMY ASSAULT FORCE INBOUND ON YOUR COMMAND CORE', x: BASES[0].x, z: 0, level: 'bad' });
  }

  private thinkSquad(s: Squad): void {
    const w = this.w;
    s.members = s.members.filter((m) => m.alive);
    const alive = s.members;
    if (!alive.length) return;
    const pos = this.objectivePos(s.objective);
    let cx = 0, cz = 0, strength = 0, underFire = false;
    for (const m of alive) {
      cx += m.x;
      cz += m.z;
      strength += STRENGTH[m.kind];
      if (m.sinceHit < 3) underFire = true;
    }
    cx /= alive.length;
    cz /= alive.length;

    // Sappers peel off to demolish fortifications near the squad.
    for (const m of alive) {
      if (m.kind !== 'sapper' || (m.order.type === 'attack' && m.order.target.alive)) continue;
      let best = null, bd = 42;
      for (const st of w.structures) {
        if (!st.alive || st.team !== PLAYER) continue;
        const d = dist(m.x, m.z, st.x, st.z) * (st.kind === 'turret' ? 0.55 : st.kind === 'hq' ? 1.4 : 1);
        if (d < bd) {
          bd = d;
          best = st;
        }
      }
      if (best) {
        m.order = { type: 'attack', target: best };
        m.target = best;
        m.breach = null;
      }
    }

    if (s.objective.kind === 'defend') {
      // Home guard: step out to meet intruders, otherwise stay put.
      const threat = w.units.find((u) => u.alive && u.team === PLAYER && dist(u.x, u.z, BASES[1].x, BASES[1].z) < 48);
      if (threat) {
        for (const m of alive) {
          if (m.order.type === 'hold' || m.order.type === 'idle') {
            m.order = { type: 'move', x: threat.x, z: threat.z, assault: true };
            w.setGoal(m, threat.x, threat.z);
          }
        }
      } else {
        for (const m of alive) {
          if (m.order.type === 'idle' && dist(m.x, m.z, BASES[1].x - 10, 0) > 16) {
            const a = w.rng.range(0, 6.28);
            const x = BASES[1].x - 11 + Math.cos(a) * 5, z = Math.sin(a) * 9;
            m.order = { type: 'move', x, z, assault: true };
            w.setGoal(m, x, z);
          }
        }
      }
      return;
    }

    if (s.state === 'retreat') {
      for (const m of alive) {
        if (m.order.type === 'idle') m.order = { type: 'hold' };
      }
      return;
    }

    // Broken squads fall back and merge with the next wave.
    if (s.initial >= 3 && alive.length <= Math.max(1, Math.floor(s.initial / 3)) && underFire && this.playerStrengthNear(cx, cz, 30) > strength * 1.5) {
      s.state = 'retreat';
      for (const m of alive) {
        m.breach = null;
        m.toCover = false;
        const x = BASES[1].spawnX - 4 + w.rng.range(-3, 3), z = w.rng.range(-8, 8);
        m.order = { type: 'move', x, z, assault: false };
        w.setGoal(m, x, z);
      }
      return;
    }

    const near = dist(cx, cz, pos.x, pos.z) < 16;
    if (s.objective.kind === 'point') {
      const p = w.points[s.objective.index];
      const def = this.playerStrengthNear(p.x, p.z, 26);
      if (p.owner === ENEMY && def === 0) s.quietT += 2.5;
      else s.quietT = 0;
      if (s.quietT > 9) {
        // Ground taken. Leave a picket and push on.
        s.quietT = 0;
        if (alive.length >= 4) {
          const picket = alive.find((m) => m.kind === 'rifle') ?? alive[0];
          s.members = alive.filter((m) => m !== picket);
          picket.order = { type: 'hold' };
          this.addSquad([picket], { kind: 'point', index: p.id }).state = 'hold';
        }
        if (s.members.length) {
          s.objective = this.chooseObjective(s, strength);
          if (s.objective.kind !== 'point' || s.objective.index !== p.id) this.sendSquad(s);
        }
        return;
      }
    }
    if (s.state === 'hold') return;
    // Stragglers that went idle away from the objective get moving again.
    for (const m of alive) {
      if (m.order.type === 'idle' && dist(m.x, m.z, pos.x, pos.z) > (near ? 11 : 6) && !m.toCover) {
        const a = w.rng.range(0, 6.28), r = w.rng.range(2, 7);
        const x = pos.x + Math.cos(a) * r, z = pos.z + Math.sin(a) * r;
        m.order = { type: 'move', x, z, assault: true };
        w.setGoal(m, x, z);
      }
    }
    // Assault on the core: once in position, everything fires on the HQ.
    if (s.objective.kind === 'hq' && near) {
      for (const m of alive) if (m.order.type === 'idle' && w.hq[PLAYER].alive) {
        m.order = { type: 'attack', target: w.hq[PLAYER] };
      }
    }
  }

  update(dt: number): void {
    const w = this.w;
    const t = w.time;
    const pts = w.points.filter((p) => p.owner === ENEMY).length;
    const rate = (5.5 + Math.min(t, 900) * 0.012) * w.difficulty.budget * (0.8 + 0.15 * pts + (w.dominance > 35 ? 0.3 : 0));
    this.budget += rate * dt;
    this.waveT -= dt;
    if (!this.opened && t > 9) {
      this.opened = true;
      this.opening();
    }
    this.defendCd -= dt;

    if (!this.lastStand && w.dominance > 68) {
      this.lastStand = true;
      this.budget += 320 * w.difficulty.budget;
      this.waveT = Math.min(this.waveT, 3);
      w.events.emit('alert', { text: 'VANTA COUNTER-OFFENSIVE — HOLD THE LINE', x: BASES[1].spawnX, z: 0, level: 'bad' });
    }

    if (this.waveT <= 0) {
      if (w.teams[ENEMY].pop < w.difficulty.cap - 1 && this.budget >= 100) {
        this.spawnWave();
        this.waveT = Math.max(26, 42 - t * 0.016) + w.rng.range(-3, 3);
      } else this.waveT = 4;
    }

    // Emergency response when the player raids the enemy base.
    if (this.defendCd <= 0) {
      const raid = this.playerStrengthNear(BASES[1].x, BASES[1].z, 46);
      if (raid > 2) {
        this.defendCd = 40;
        this.budget += 120 * w.difficulty.budget;
        this.waveT = Math.min(this.waveT, 2);
        for (const s of this.squads) {
          if (s.objective.kind === 'point' && s.state === 'advance') {
            const c = s.members.find((m) => m.alive);
            if (c && dist(c.x, c.z, BASES[1].x, 0) < 70) {
              s.objective = { kind: 'defend' };
              this.sendSquad(s);
            }
          }
        }
      } else this.defendCd = 3;
    }

    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 2.5;
      for (const s of this.squads) this.thinkSquad(s);
      this.squads = this.squads.filter((s) => s.members.length > 0);
    }
  }
}
