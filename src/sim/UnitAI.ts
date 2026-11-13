import { ENEMY, PLAYER } from '../core/config';
import { angDiff, turnToward } from '../core/math';
import type { World } from './World';
import type { Entity, Structure, Unit } from './entities';

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const reach = (t: Entity) => (t.isUnit ? t.def.radius : t.def.cells * 0.9);

function isThreatStruct(s: Structure): boolean {
  return s.kind === 'turret' || s.kind === 'hq' || s.kind === 'bunker';
}

/** Pick what to shoot at. Runs a few times per second per unit. */
function think(w: World, u: Unit): void {
  if (u.order.type === 'attack') {
    const t = u.order.target;
    if (!t.alive) {
      u.order = { type: 'idle' };
      u.target = null;
    } else {
      u.target = t;
      u.targetVisible = dist(u, t) <= u.def.sight + 6 && w.canSee(u, t);
      return;
    }
  }
  if (u.breach && !u.breach.alive) u.breach = null;

  const cands: Array<{ e: Entity; score: number }> = [];
  const prefersHard = u.kind === 'heavy' || u.kind === 'tank';
  if (u.kind !== 'sapper' || !u.breach) {
    for (const e of w.units) {
      if (!e.alive || e.team === u.team || e.spawnDelay > 0) continue;
      const d = dist(u, e);
      if (d > u.def.sight) continue;
      let score = d;
      if (prefersHard) score *= e.def.infantry ? 1.25 : 0.55;
      else if (!e.def.infantry) score *= 1.5;
      if (e === u.target) score *= 0.8;
      if (u.kind === 'sapper') score *= 2.2;
      cands.push({ e, score });
    }
  }
  for (const s of w.structures) {
    if (!s.alive || s.team === u.team) continue;
    const d = dist(u, s) - s.def.cells;
    if (d > u.def.sight) continue;
    const allowed = isThreatStruct(s) || s === u.breach || u.kind === 'sapper' || (u.team === PLAYER && d < u.def.range * 0.6);
    if (!allowed) continue;
    let score = d * (prefersHard ? 0.7 : 1.6);
    if (u.kind === 'sapper') score = d * (s.kind === 'turret' ? 0.5 : s.kind === 'hq' ? 1.5 : 0.9);
    if (s === u.breach) score *= 0.5;
    cands.push({ e: s, score });
  }
  cands.sort((a, b) => a.score - b.score);
  u.target = null;
  u.targetVisible = false;
  for (let i = 0; i < Math.min(4, cands.length); i++) {
    if (w.canSee(u, cands[i].e)) {
      u.target = cands[i].e;
      u.targetVisible = true;
      break;
    }
  }
  if (!u.target && u.breach) {
    u.target = u.breach;
    u.targetVisible = w.canSee(u, u.breach);
  }
}

/** Advance along the current path; returns true when the final waypoint is reached. */
function followPath(w: World, u: Unit, dt: number): boolean {
  if (u.pi >= u.path.length) return true;
  const g = w.grid;
  const wp = u.path[u.pi];
  const sid = g.struct[g.cellAt(wp.x, wp.z)];
  if (sid) {
    const s = w.structById.get(sid);
    if (s && s.team !== u.team) {
      // The route goes through an enemy structure: breach it.
      u.breach = s;
      if (dist(u, s) < Math.min(u.def.range, 12) + s.def.cells && w.canSee(u, s)) {
        u.vx = u.vz = 0;
        return false;
      }
      if (dist(u, wp) < g.cell * 1.5) {
        u.vx = u.vz = 0;
        return false;
      }
    } else {
      u.needPath = true;
      return false;
    }
  }
  const last = u.pi === u.path.length - 1;
  const d = dist(u, wp);
  if (d < (last ? 0.45 : 1.1)) {
    u.pi++;
    return u.pi >= u.path.length;
  }
  const before = d;
  moveToward(w, u, wp.x, wp.z, dt);
  const progressed = before - dist(u, wp);
  if (progressed < u.def.speed * dt * 0.2) {
    u.stuckT += dt;
    if (last && d < 2.2 && u.stuckT > 0.6) {
      u.pi++;
      return true;
    }
    if (u.stuckT > 1.4) {
      u.stuckT = 0;
      u.needPath = true;
    }
  } else u.stuckT = Math.max(0, u.stuckT - dt);
  return false;
}

export function moveToward(w: World, u: Unit, tx: number, tz: number, dt: number): void {
  const dx = tx - u.x, dz = tz - u.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.05) {
    u.vx = u.vz = 0;
    return;
  }
  const sp = u.def.speed;
  let vx = (dx / d) * sp + u.sepX, vz = (dz / d) * sp + u.sepZ;
  const want = Math.atan2(vx, vz);
  u.yaw = turnToward(u.yaw, want, (u.def.infantry ? 9 : 2.4) * dt);
  if (!u.def.infantry) {
    const f = Math.max(0, Math.cos(angDiff(u.yaw, want)));
    vx = Math.sin(u.yaw) * sp * f + u.sepX * 0.3;
    vz = Math.cos(u.yaw) * sp * f + u.sepZ * 0.3;
  }
  const scale = Math.min(1, d / (sp * dt));
  let nx = u.x + vx * dt * scale, nz = u.z + vz * dt * scale;
  const g = w.grid;
  if (g.walkable(u.x, u.z)) {
    if (!g.walkable(nx, u.z)) nx = u.x;
    if (!g.walkable(nx, nz)) nz = u.z;
  }
  u.vx = (nx - u.x) / dt;
  u.vz = (nz - u.z) / dt;
  u.x = nx;
  u.z = nz;
}

function idleDrift(w: World, u: Unit, dt: number): void {
  // Even stationary units yield to neighbours so groups do not stack.
  u.vx = u.vz = 0;
  if (Math.abs(u.sepX) + Math.abs(u.sepZ) < 0.6) return;
  const nx = u.x + u.sepX * dt * 0.6, nz = u.z + u.sepZ * dt * 0.6;
  if (w.grid.walkable(nx, nz)) {
    u.x = nx;
    u.z = nz;
  }
}

function doBuild(w: World, u: Unit, dt: number): void {
  if (u.order.type !== 'build') return;
  const s = u.order.target;
  if (!s.alive || (s.done && s.hp >= s.maxHp)) {
    u.order = { type: 'idle' };
    u.building = null;
    u.jobT = 0;
    u.path = [];
    u.goal = null;
    return;
  }
  const d = dist(u, s);
  if (d > 3.4 + s.def.cells) {
    u.building = null;
    if (!u.goal || dist(u.goal, s) > 0.5) w.setGoal(u, s.x, s.z);
    if (u.path.length) followPath(w, u, dt);
  } else {
    u.path = [];
    u.yaw = turnToward(u.yaw, Math.atan2(s.x - u.x, s.z - u.z), 8 * dt);
    u.aimYaw = u.yaw;
    u.building = s;
    idleDrift(w, u, dt);
    if (!s.done) w.addBuildProgress(s, dt / s.def.buildTime);
    else s.hp = Math.min(s.maxHp, s.hp + 45 * dt);
  }
}

function findJob(w: World, u: Unit): void {
  let best: Structure | null = null, bd = 400;
  for (const s of w.structures) {
    if (!s.alive || s.team !== u.team) continue;
    if (s.done && s.hp >= s.maxHp * 0.85) continue;
    let d = dist(u, s);
    if (s.done) d += 12;
    // spread engineers across jobs
    for (const o of w.units) if (o !== u && o.alive && o.order.type === 'build' && o.order.target === s) d += 8;
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  if (best) u.order = { type: 'build', target: best };
}

export function updateUnit(w: World, u: Unit, dt: number): void {
  u.cooldown -= dt;
  u.thinkT -= dt;
  u.coverT -= dt;
  u.repathT -= dt;
  u.sinceHit += dt;
  u.sinceShot += dt;
  u.y = u.controlled ? u.y : w.height(u.x, u.z);
  if (u.controlled) return;

  const g = w.grid;
  // Shoved inside something (a blueprint was dropped on us): walk out.
  if (!g.walkable(u.x, u.z)) {
    const c = g.nearestOpen(u.x, u.z, 6);
    if (c >= 0) moveToward(w, u, g.centerX(c), g.centerZ(c), dt);
    return;
  }

  if (u.thinkT <= 0) {
    u.thinkT = 0.3 + w.rng.next() * 0.2;
    think(w, u);
    if (u.path.length && u.navVer !== g.version && u.repathT <= 0 && u.goal) u.needPath = true;
  }

  if (u.kind === 'engineer') {
    if (u.order.type === 'build') {
      doBuild(w, u, dt);
      return;
    }
    u.building = null;
    u.jobT -= dt;
    if (u.order.type === 'idle' && u.jobT <= 0 && u.team === PLAYER) {
      u.jobT = 1;
      findJob(w, u);
    }
  }

  const tgt = u.target && u.target.alive ? u.target : null;
  let engaged = false;
  let moving = false;

  if (tgt) {
    const d = dist(u, tgt);
    const inRange = u.targetVisible && d <= u.def.range + reach(tgt);
    const want = Math.atan2(tgt.x - u.x, tgt.z - u.z);
    u.aimYaw = turnToward(u.aimYaw, want, (u.def.infantry ? 9 : 2.6) * dt);
    if (inRange) {
      const o = u.order;
      const standAndFight = o.type !== 'move' || o.assault || tgt === u.breach;
      if (standAndFight) {
        engaged = true;
        // Infantry look for real cover instead of trading shots in the open.
        if (u.def.infantry && u.kind !== 'sapper' && o.type !== 'hold' && u.coverT <= 0 && !u.toCover && u.sinceHit < 6) {
          u.coverT = 4 + w.rng.next() * 3;
          const c = w.findCover(u, tgt.x, tgt.z, tgt, 7);
          if (c && dist(u, c) > 1.2) {
            u.toCover = true;
            u.path = g.findPath(u.x, u.z, c.x, c.z, { team: u.team });
            u.pi = 0;
            u.navVer = g.version;
          }
        }
      }
      const facing = Math.abs(angDiff(u.aimYaw, want)) < 0.2;
      moving = Math.hypot(u.vx, u.vz) > 1;
      if (u.cooldown <= 0 && facing) {
        const buff = u.team === PLAYER && w.controlled && dist(u, w.controlled) < 18 ? 0.75 : 1;
        u.burstLeft--;
        if (u.burstLeft <= 0) {
          u.burstLeft = u.def.burst;
          u.cooldown = (u.def.burst > 1 ? u.def.burstGap : u.def.cooldown) * (0.85 + w.rng.next() * 0.3) * buff;
        } else u.cooldown = u.def.cooldown;
        w.fire(u, tgt, moving);
      }
    } else if (u.order.type === 'attack' || tgt === u.breach) {
      // Close in on an ordered / breach target.
      if (u.repathT <= 0 || !u.goal || dist(u.goal, tgt) > 6) {
        if (!u.goal || dist(u.goal, tgt) > 3 || !u.path.length) w.setGoal(u, tgt.x, tgt.z);
        u.repathT = 1.2;
      }
    }
  } else {
    u.aimYaw = turnToward(u.aimYaw, u.yaw, 4 * dt);
  }

  if (u.toCover) {
    if (!engaged || followPath(w, u, dt)) {
      u.toCover = false;
      if (u.goal) u.needPath = true;
      else u.path = [];
    }
    return;
  }

  if (engaged) {
    if (u.def.infantry) u.yaw = turnToward(u.yaw, u.aimYaw, 8 * dt);
    idleDrift(w, u, dt);
    return;
  }

  if (u.goal && u.path.length && u.pi < u.path.length) {
    if (followPath(w, u, dt)) {
      u.path = [];
      if (u.order.type === 'move') {
        u.goal = null;
        u.order = { type: 'idle' };
      } else if (u.order.type !== 'attack') u.goal = null;
    }
  } else if (u.goal && !u.needPath && u.order.type === 'move') {
    // Path exhausted without arriving (blocked): try again shortly.
    if (dist(u, u.goal) > 2.5 && u.repathT <= 0) {
      u.needPath = true;
      u.repathT = 2;
    } else if (dist(u, u.goal) <= 2.5) {
      u.goal = null;
      u.order = { type: 'idle' };
    }
    idleDrift(w, u, dt);
  } else idleDrift(w, u, dt);
}

export const TEAM_NAMES = { [PLAYER]: 'Aegis', [ENEMY]: 'Vanta' };
