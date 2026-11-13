import {
  BASES, DIFFICULTIES, ECON, ENEMY, MAP, PLAYER, POINT_DEFS, STRUCT_DEFS, UNIT_DEFS,
  type Difficulty, type StructKind, type Team, type UnitKind,
} from '../core/config';
import { Emitter } from '../core/events';
import { Rng } from '../core/rng';
import { Physics } from '../physics/Physics';
import { CapturePoint } from './CapturePoint';
import { Director } from './Director';
import { assignSlots, formationSlots } from './Formation';
import { NavGrid, type Pt } from './NavGrid';
import { Structure, Unit, newId, type Entity, type Obstacle, type Projectile } from './entities';
import { makeHeightFn, type HeightFn } from './terrain';
import { updateUnit } from './UnitAI';

export interface WorldEvents extends Record<string, unknown> {
  unitSpawn: { unit: Unit; via: 'pod' | 'base' | 'warp' };
  unitDie: { unit: Unit; killer: Entity | null };
  unitHit: { unit: Unit; dmg: number; attacker: Entity | null };
  structAdd: { s: Structure };
  structDone: { s: Structure };
  structDie: { s: Structure };
  structHit: { s: Structure };
  shot: {
    team: Team; kind: 'bullet' | 'cutter' | 'turret';
    ox: number; oy: number; oz: number; tx: number; ty: number; tz: number;
    shooter: Entity | null; impact: 'unit' | 'cover' | 'struct' | 'miss';
  };
  projSpawn: { p: Projectile };
  explosion: { x: number; y: number; z: number; radius: number; kind: 'rocket' | 'shell' | 'grenade' | 'orbital' | 'vehicle' };
  pointChange: { point: CapturePoint; prev: number };
  alert: { text: string; x?: number; z?: number; level: 'info' | 'warn' | 'good' | 'bad' };
  orbital: { x: number; z: number; delay: number; team: Team };
  gameOver: { winner: Team; reason: string };
}

export interface TeamState {
  supply: number;
  pop: number;
  popCap: number;
  queue: Array<{ kind: UnitKind; t: number; total: number }>;
  spawnSite: Structure | null;
  strikeCd: number;
  income: number;
}

export interface PlayerHit {
  kind: 'unit' | 'struct' | 'world' | 'none';
  kill: boolean;
  head: boolean;
  x: number;
  y: number;
  z: number;
}

export interface WorldOpts {
  seed?: number;
  difficulty?: string;
}

const dist2d = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);

/**
 * The authoritative battle simulation. It has no dependency on rendering,
 * input or the DOM; everything observable is announced through `events`.
 * It runs identically whether the player is commanding from above or
 * embodied in a single unit.
 */
export class World {
  time = 0;
  over = false;
  winner: Team | null = null;
  rng: Rng;
  grid = new NavGrid();
  height: HeightFn;
  units: Unit[] = [];
  structures: Structure[] = [];
  structById = new Map<number, Structure>();
  colliderOwner = new Map<number, Structure>();
  points: CapturePoint[];
  projectiles: Projectile[] = [];
  obstacles: Obstacle[] = [];
  teams: [TeamState, TeamState];
  /** -100 (enemy wins) .. +100 (player wins) */
  dominance = 0;
  events = new Emitter<WorldEvents>();
  director: Director;
  hq!: [Structure, Structure];
  controlled: Unit | null = null;
  difficulty: Difficulty;
  seed: number;
  stats = { kills: 0, losses: 0, built: 0, structLost: 0, razed: 0, directKills: 0, captures: 0, strikes: 0 };
  private strikes: Array<{ x: number; z: number; t: number; team: Team }> = [];
  private pathBudget = 0;
  private dangerVer = -1;
  private lowWarn = [false, false];

  static async create(opts: WorldOpts = {}): Promise<World> {
    const physics = await Physics.create();
    return new World(physics, opts);
  }

  constructor(public physics: Physics, opts: WorldOpts = {}) {
    this.seed = opts.seed ?? (Math.random() * 1e9) | 0;
    this.rng = new Rng(this.seed);
    this.difficulty = DIFFICULTIES.find((d) => d.id === opts.difficulty) ?? DIFFICULTIES[1];
    this.height = makeHeightFn(this.seed);
    this.points = POINT_DEFS.map((p, i) => new CapturePoint(i, p.name, p.x, p.z));
    const mk = (): TeamState => ({
      supply: ECON.startSupply, pop: 0, popCap: ECON.basePop, queue: [], spawnSite: null, strikeCd: 20, income: 0,
    });
    this.teams = [mk(), mk()];
    this.physics.buildTerrain(this.height, MAP.halfW + 30, MAP.halfH + 30);
    this.generateMap();
    this.director = new Director(this);
    this.setupForces();
  }

  // ------------------------------------------------------------------ setup

  private generateMap(): void {
    const g = this.grid;
    for (let i = 0; i < g.n; i++) {
      const x = g.centerX(i), z = g.centerZ(i);
      if (Math.abs(x) > MAP.playW || Math.abs(z) > MAP.playH) g.setSolid(i);
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      const saved = g.solid.slice();
      const obs: Obstacle[] = [];
      const rng = this.rng;
      const free = (x: number, z: number, r: number) => {
        for (const b of BASES) if (dist2d(x, z, b.x, b.z) < 34 + r) return false;
        for (const p of POINT_DEFS) if (dist2d(x, z, p.x, p.z) < 6 + r) return false;
        for (const o of obs) if (dist2d(x, z, o.x, o.z) < o.r + r + 3.5) return false;
        return Math.abs(x) < MAP.playW - 4 && Math.abs(z) < MAP.playH - 4;
      };
      const add = (o: Obstacle) => {
        o.y = this.height(o.x, o.z);
        obs.push(o);
      };
      // Ruined walls ring each objective: pre-existing cover worth fighting over.
      for (const p of POINT_DEFS) {
        const n = 4 + rng.int(0, 1);
        const a0 = rng.range(0, Math.PI * 2);
        for (let i = 0; i < n; i++) {
          const a = a0 + (i / n) * Math.PI * 2 + rng.range(-0.25, 0.25);
          const rad = rng.range(7.5, 12.5);
          const tall = rng.chance(0.4);
          add({
            type: 'ruin', x: p.x + Math.cos(a) * rad, z: p.z + Math.sin(a) * rad, y: 0, r: 2.2,
            h: tall ? 2.6 : 1.15, w: rng.range(3.4, 5), d: 0.9, rot: a + Math.PI / 2 + rng.range(-0.4, 0.4), seed: rng.int(0, 9999),
          });
        }
      }
      for (let i = 0; i < 70 && obs.length < 62; i++) {
        const x = rng.range(-MAP.playW, MAP.playW), z = rng.range(-MAP.playH, MAP.playH);
        const roll = rng.next();
        if (roll < 0.14) {
          if (free(x, z, 2)) add({ type: 'crystal', x, z, y: 0, r: 1.4, h: rng.range(3, 5.5), w: 0, d: 0, rot: rng.range(0, 6.28), seed: rng.int(0, 9999) });
        } else if (roll < 0.26) {
          if (free(x, z, 3)) add({ type: 'wreck', x, z, y: 0, r: 2.4, h: 1.9, w: 4.6, d: 2.6, rot: rng.range(0, 6.28), seed: rng.int(0, 9999) });
        } else {
          const r = rng.range(1.3, 3.3);
          if (free(x, z, r)) add({ type: 'rock', x, z, y: 0, r, h: r * rng.range(0.9, 1.5), w: 0, d: 0, rot: rng.range(0, 6.28), seed: rng.int(0, 9999) });
        }
      }
      for (const o of obs) {
        if (o.type === 'ruin' || o.type === 'wreck') {
          const c = Math.cos(o.rot), s = Math.sin(o.rot);
          for (let t = -o.w / 2; t <= o.w / 2 + 0.01; t += 1)
            for (let k = -o.d / 2; k <= o.d / 2 + 0.01; k += Math.max(0.5, o.d / 2))
              g.setSolid(g.cellAt(o.x + c * t + s * k, o.z - s * t + c * k));
        } else g.stampCircle(o.x, o.z, o.r * 0.8);
      }
      // Reject layouts that wall anything off.
      const opt = { team: 0 };
      const reach = (x: number, z: number) => {
        const p = g.findPath(BASES[0].spawnX, 0, x, z, opt);
        return p.length > 0 && dist2d(p[p.length - 1].x, p[p.length - 1].z, x, z) < 4;
      };
      if (POINT_DEFS.every((p) => reach(p.x + 3, p.z)) && reach(BASES[1].spawnX, 0)) {
        this.obstacles = obs;
        break;
      }
      g.solid = saved;
    }
    for (const o of this.obstacles) {
      if (o.type === 'ruin' || o.type === 'wreck') this.physics.addBox(o.x, o.y + o.h / 2 - 0.3, o.z, o.w / 2, o.h / 2 + 0.3, o.d / 2, o.rot);
      else this.physics.addCylinder(o.x, o.y + o.h / 2 - 0.5, o.z, o.h / 2 + 0.5, o.r * 0.85);
    }
  }

  private setupForces(): void {
    const hqP = this.placeStructure(PLAYER, 'hq', BASES[0].x, BASES[0].z, 0, 1, true)!;
    const hqE = this.placeStructure(ENEMY, 'hq', BASES[1].x, BASES[1].z, 0, 1, true)!;
    this.hq = [hqP, hqE];
    this.placeStructure(ENEMY, 'turret', 87, -15, 0, 1, true);
    this.placeStructure(ENEMY, 'turret', 87, 15, 0, 1, true);
    const pods: Array<[UnitKind, number, number]> = [
      ['rifle', -84, -5], ['rifle', -81, 0], ['rifle', -84, 5], ['rifle', -78, -7],
      ['engineer', -88, -9], ['engineer', -88, 9], ['heavy', -78, 7],
    ];
    pods.forEach(([k, x, z], i) => {
      const u = this.spawnUnit(k, PLAYER, x, z, 'pod');
      u.spawnDelay = 1.6 + i * 0.42;
      u.yaw = Math.PI / 2;
    });
    const tank = this.spawnUnit('tank', PLAYER, -92, 16, 'base');
    tank.yaw = tank.aimYaw = Math.PI / 2;
    this.director.spawnGarrison();
  }

  // --------------------------------------------------------------- entities

  spawnUnit(kind: UnitKind, team: Team, x: number, z: number, via: 'pod' | 'base' | 'warp'): Unit {
    const c = this.grid.nearestOpen(x, z, 8);
    if (c >= 0 && !this.grid.walkable(x, z)) {
      x = this.grid.centerX(c);
      z = this.grid.centerZ(c);
    }
    const u = new Unit(kind, team, x, z);
    u.y = this.height(x, z);
    u.yaw = u.aimYaw = team === PLAYER ? Math.PI / 2 : -Math.PI / 2;
    if (via === 'warp') u.spawnDelay = 0.8;
    this.units.push(u);
    this.teams[team].pop += u.def.pop;
    this.events.emit('unitSpawn', { unit: u, via });
    return u;
  }

  snap(kind: StructKind, v: number): number {
    const c = MAP.cell;
    return STRUCT_DEFS[kind].cells % 2 === 1 ? (Math.floor(v / c) + 0.5) * c : Math.round(v / c) * c;
  }

  private footprint(kind: StructKind, x: number, z: number): number[] {
    const n = STRUCT_DEFS[kind].cells, c = MAP.cell;
    const out: number[] = [];
    const start = -(n - 1) / 2;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) out.push(this.grid.cellAt(x + (start + i) * c, z + (start + j) * c));
    return out;
  }

  canPlace(kind: StructKind, x: number, z: number): boolean {
    x = this.snap(kind, x);
    z = this.snap(kind, z);
    if (Math.abs(x) > MAP.playW - 2 || Math.abs(z) > MAP.playH - 2) return false;
    for (const c of this.footprint(kind, x, z)) if (!this.grid.open(c)) return false;
    if (kind !== 'hq') {
      for (const p of this.points) if (dist2d(x, z, p.x, p.z) < 3.4) return false;
      if (dist2d(x, z, BASES[1].x, BASES[1].z) < 30) return false;
      if (dist2d(x, z, BASES[0].spawnX, 0) < 4) return false;
    }
    return true;
  }

  /** Place a blueprint (or an instantly finished structure when `instant`). */
  placeStructure(team: Team, kind: StructKind, x: number, z: number, rot = 0, len = 1, instant = false): Structure | null {
    x = this.snap(kind, x);
    z = this.snap(kind, z);
    if (!this.canPlace(kind, x, z)) return null;
    const def = STRUCT_DEFS[kind];
    if (!instant) {
      if (this.teams[team].supply < def.cost) return null;
      this.teams[team].supply -= def.cost;
    }
    const s = new Structure(kind, team, x, z, rot);
    s.len = len;
    s.y = this.height(x, z);
    s.cells = this.footprint(kind, x, z);
    this.grid.addStructure(s.id, team, s.cells, def.breachCost);
    this.structures.push(s);
    this.structById.set(s.id, s);
    this.events.emit('structAdd', { s });
    if (instant) {
      s.progress = 1;
      s.hp = s.maxHp;
      this.finishStructure(s, true);
    }
    return s;
  }

  private ensureCollider(s: Structure): void {
    if (s.colliders.length) return;
    const [w, h, d] = s.def.size;
    const handle =
      s.kind === 'turret'
        ? this.physics.addCylinder(s.x, s.y + h / 2 - 0.3, s.z, h / 2 + 0.3, 0.85)
        : this.physics.addBox(s.x, s.y + h / 2 - 0.3, s.z, (w * s.len) / 2, h / 2 + 0.3, d / 2, s.rot);
    s.colliders.push(handle);
    this.colliderOwner.set(handle, s);
  }

  addBuildProgress(s: Structure, amount: number): void {
    if (s.done || !s.alive) return;
    s.progress = Math.min(1, s.progress + amount);
    s.hp = Math.min(s.maxHp, s.hp + amount * s.maxHp * 0.85);
    if (s.progress >= 0.3) this.ensureCollider(s);
    if (s.progress >= 1) this.finishStructure(s, false);
  }

  private finishStructure(s: Structure, silent: boolean): void {
    s.done = true;
    s.progress = 1;
    this.ensureCollider(s);
    this.dangerVer = -1;
    if (!silent) {
      if (s.team === PLAYER) this.stats.built++;
      this.events.emit('structDone', { s });
    }
  }

  damageStructure(s: Structure, dmg: number, attacker: Entity | null): void {
    if (!s.alive || this.over) return;
    s.hp -= dmg;
    s.sinceHit = 0;
    this.events.emit('structHit', { s });
    if (s.kind === 'hq' && !this.lowWarn[s.team] && s.hp < s.maxHp * 0.5) {
      this.lowWarn[s.team] = true;
      this.events.emit('alert', s.team === PLAYER
        ? { text: 'COMMAND CORE AT 50% INTEGRITY', x: s.x, z: s.z, level: 'bad' }
        : { text: 'ENEMY SPIRE IS FAILING — PRESS THE ATTACK', x: s.x, z: s.z, level: 'good' });
    }
    if (s.hp <= 0) this.destroyStructure(s, attacker);
  }

  destroyStructure(s: Structure, _attacker: Entity | null): void {
    if (!s.alive) return;
    s.alive = false;
    s.hp = 0;
    this.grid.removeStructure(s.cells);
    for (const h of s.colliders) {
      this.physics.removeStatic(h);
      this.colliderOwner.delete(h);
    }
    s.colliders.length = 0;
    this.structById.delete(s.id);
    this.dangerVer = -1;
    if (s.team === PLAYER) this.stats.structLost++;
    else this.stats.razed++;
    if (this.teams[s.team].spawnSite === s) this.teams[s.team].spawnSite = null;
    this.events.emit('structDie', { s });
    if (s.kind === 'hq') this.end(s.team === PLAYER ? ENEMY : PLAYER, s.team === PLAYER ? 'Command Core destroyed' : 'Enemy Spire destroyed');
  }

  damageUnit(u: Unit, dmg: number, attacker: Entity | null): void {
    if (!u.alive || this.over) return;
    if (u.controlled) dmg *= 0.55;
    u.hp -= dmg;
    u.sinceHit = 0;
    this.events.emit('unitHit', { unit: u, dmg, attacker });
    if (u.hp <= 0) {
      u.alive = false;
      u.hp = 0;
      this.teams[u.team].pop -= u.def.pop;
      if (u.team === ENEMY) {
        this.stats.kills++;
        if (attacker && attacker.isUnit) {
          attacker.kills++;
          if (attacker.controlled) this.stats.directKills++;
        }
      } else this.stats.losses++;
      if (u.kind === 'tank') {
        this.events.emit('explosion', { x: u.x, y: u.y + 1.2, z: u.z, radius: 6, kind: 'vehicle' });
      }
      this.events.emit('unitDie', { unit: u, killer: attacker });
    }
  }

  // ----------------------------------------------------------------- orders

  private clearOrders(u: Unit): void {
    u.breach = null;
    u.toCover = false;
    u.building = null;
    u.target = null;
  }

  setGoal(u: Unit, x: number, z: number): void {
    u.goal = { x, z };
    u.needPath = true;
  }

  orderMove(units: Unit[], x: number, z: number, assault = false): void {
    units = units.filter((u) => u.alive && !u.controlled);
    if (!units.length) return;
    let cx = 0, cz = 0;
    for (const u of units) {
      cx += u.x;
      cz += u.z;
    }
    cx /= units.length;
    cz /= units.length;
    const sorted = [...units].sort((a, b) => b.def.hp - a.def.hp);
    const slots = formationSlots(sorted.length, x, z, x - cx, z - cz, sorted.some((u) => !u.def.infantry) ? 4.2 : 2.6);
    const assign = assignSlots(sorted, slots);
    sorted.forEach((u, i) => {
      const s = slots[assign[i]];
      this.clearOrders(u);
      u.order = { type: 'move', x: s.x, z: s.z, assault };
      this.setGoal(u, s.x, s.z);
    });
  }

  orderAttack(units: Unit[], target: Entity): void {
    for (const u of units) {
      if (!u.alive || u.controlled) continue;
      this.clearOrders(u);
      u.order = { type: 'attack', target };
      u.target = target;
      u.thinkT = 0;
    }
  }

  orderBuild(units: Unit[], s: Structure): void {
    for (const u of units) {
      if (!u.alive || u.controlled || u.kind !== 'engineer') continue;
      this.clearOrders(u);
      u.order = { type: 'build', target: s };
      u.goal = null;
    }
  }

  orderHold(units: Unit[]): void {
    for (const u of units) {
      if (!u.alive || u.controlled) continue;
      this.clearOrders(u);
      u.order = { type: 'hold' };
      u.path = [];
      u.goal = null;
    }
  }

  queueUnit(team: Team, kind: UnitKind): boolean {
    const t = this.teams[team], def = UNIT_DEFS[kind];
    const queuedPop = t.queue.reduce((a, q) => a + UNIT_DEFS[q.kind].pop, 0);
    if (t.supply < def.cost || t.pop + queuedPop + def.pop > t.popCap || t.queue.length >= 6) return false;
    t.supply -= def.cost;
    t.queue.push({ kind, t: 0, total: def.buildTime });
    return true;
  }

  spawnPos(team: Team): Pt {
    const site = this.teams[team].spawnSite;
    if (site && site.alive && site.done) return { x: site.x + 4.2, z: site.z + this.rng.range(-2, 2) };
    return { x: BASES[team].spawnX + this.rng.range(-2, 2), z: this.rng.range(-7, 7) };
  }

  orbitalStrike(team: Team, x: number, z: number): boolean {
    const t = this.teams[team];
    if (t.strikeCd > 0 || t.supply < ECON.strikeCost) return false;
    t.supply -= ECON.strikeCost;
    t.strikeCd = ECON.strikeCooldown;
    this.strikes.push({ x, z, t: ECON.strikeDelay, team });
    this.stats.strikes++;
    this.events.emit('orbital', { x, z, delay: ECON.strikeDelay, team });
    return true;
  }

  // ----------------------------------------------------------------- combat

  muzzle(e: Entity): [number, number, number] {
    if (e.isUnit) {
      const f = e.def.infantry ? 0.7 : 2.6;
      return [e.x + Math.sin(e.aimYaw) * f, e.y + e.def.eye - (e.def.infantry ? 0.18 : 0.1), e.z + Math.cos(e.aimYaw) * f];
    }
    const eye = e.def.weapon?.eye ?? 2;
    return [e.x + Math.sin(e.aimYaw) * 1.2, e.y + eye, e.z + Math.cos(e.aimYaw) * 1.2];
  }

  aimPoint(e: Entity): [number, number, number] {
    if (e.isUnit) return [e.x, e.y + (e.def.infantry ? 1.1 : 1.4), e.z];
    return [e.x, e.y + e.def.size[1] * (e.kind === 'hq' ? 0.8 : 0.55), e.z];
  }

  canSee(from: Entity, to: Entity): boolean {
    const eye = from.isUnit ? from.def.eye : from.def.weapon?.eye ?? 2;
    return this.canSeeFrom(from.x, from.y + eye, from.z, to);
  }

  canSeeFrom(ox: number, oy: number, oz: number, to: Entity): boolean {
    const [tx, ty, tz] = this.aimPoint(to);
    const d = Math.hypot(tx - ox, ty - oy, tz - oz);
    const hit = this.physics.raycast(ox, oy, oz, tx - ox, ty - oy, tz - oz, d);
    if (!hit) return true;
    if (!to.isUnit && this.colliderOwner.get(hit.handle) === to) return true;
    return hit.t >= d - 0.45;
  }

  private presence(u: Entity): boolean {
    const c = this.controlled;
    return !!c && c.alive && u.team === c.team && u !== c && dist2d(u.x, u.z, c.x, c.z) < 18;
  }

  /** AI weapon fire (units and turrets). */
  fire(shooter: Entity, tgt: Entity, moving: boolean): void {
    const weapon = shooter.isUnit ? shooter.def.weapon : 'bullet';
    const damage = shooter.isUnit ? shooter.def.damage : shooter.def.weapon!.damage;
    const structMult = shooter.isUnit ? shooter.def.structMult : 0.3;
    let acc = shooter.isUnit ? shooter.def.accuracy : shooter.def.weapon!.accuracy;
    const range = shooter.isUnit ? shooter.def.range : shooter.def.weapon!.range;
    if (shooter.team === ENEMY) acc *= this.difficulty.accuracy;
    if (this.presence(shooter)) acc += 0.12;
    shooter.sinceShot = 0;
    const [ox, oy, oz] = this.muzzle(shooter);
    let [tx, ty, tz] = this.aimPoint(tgt);

    if (weapon === 'rocket' || weapon === 'shell') {
      const spread = (1 - acc) * 3 + (moving ? 1 : 0);
      tx += this.rng.range(-spread, spread);
      tz += this.rng.range(-spread, spread);
      if (tgt.isUnit && tgt.def.infantry) ty = tgt.y + 0.3;
      this.launch(weapon, shooter.team, ox, oy, oz, tx - ox, ty - oy, tz - oz, weapon === 'rocket' ? 55 : 95,
        damage, (shooter as Unit).def.splash, structMult, shooter);
      return;
    }

    const kind = !shooter.isUnit ? 'turret' : weapon === 'cutter' ? 'cutter' : 'bullet';
    const d = Math.hypot(tx - ox, tz - oz);
    let impact: WorldEvents['shot']['impact'] = 'miss';
    if (!tgt.isUnit) {
      impact = 'struct';
      this.damageStructure(tgt, damage * structMult, shooter);
    } else {
      if (moving) acc *= 0.55;
      if (d > range * 0.7) acc *= 0.85;
      if (tgt.controlled) acc *= 0.6;
      let hit = this.rng.next() < acc;
      if (hit && tgt.def.infantry && weapon !== 'cutter') {
        // Low ray: anything solid just in front of the target is cover.
        const gy = shooter.isUnit ? shooter.y : shooter.y + 0.2;
        const low = this.physics.segment(ox, gy + 0.6, oz, tx, tgt.y + 0.55, tz);
        if (low && low.t > d - 3.6 && low.t < d - 0.3 && this.rng.next() < 0.62) {
          hit = false;
          impact = 'cover';
          const k = low.t / Math.max(d, 0.01);
          tx = ox + (tx - ox) * k;
          tz = oz + (tz - oz) * k;
          ty = tgt.y + 0.7;
          const cover = this.colliderOwner.get(low.handle);
          if (cover && cover.team === tgt.team) this.damageStructure(cover, damage * 0.3, shooter);
        }
      }
      if (hit) {
        impact = 'unit';
        this.damageUnit(tgt, damage * (weapon === 'cutter' ? 1 : tgt.def.armor), shooter);
      } else if (impact === 'miss') {
        tx += this.rng.range(-1.3, 1.3);
        ty += this.rng.range(-0.6, 0.9);
        tz += this.rng.range(-1.3, 1.3);
      }
    }
    this.events.emit('shot', { team: shooter.team, kind, ox, oy, oz, tx, ty, tz, shooter, impact });
  }

  launch(kind: 'rocket' | 'shell', team: Team, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
    speed: number, dmg: number, radius: number, structMult: number, owner: Entity | null): Projectile {
    const len = Math.hypot(dx, dy, dz) || 1;
    const p: Projectile = {
      id: newId(), kind, team, x: ox, y: oy, z: oz,
      vx: (dx / len) * speed, vy: (dy / len) * speed, vz: (dz / len) * speed,
      life: 2.2, dmg, radius, structMult, owner, alive: true,
    };
    this.projectiles.push(p);
    this.events.emit('projSpawn', { p });
    return p;
  }

  throwGrenade(owner: Unit, ox: number, oy: number, oz: number, vx: number, vy: number, vz: number): void {
    const body = this.physics.spawnBall(ox, oy, oz, 0.16, vx, vy, vz);
    const p: Projectile = {
      id: newId(), kind: 'grenade', team: owner.team, x: ox, y: oy, z: oz, vx, vy, vz,
      life: 2.1, dmg: 130, radius: 6.5, structMult: 1.2, owner, body, alive: true,
    };
    this.projectiles.push(p);
    this.events.emit('projSpawn', { p });
  }

  explode(x: number, y: number, z: number, radius: number, dmg: number, team: Team | -1, structMult: number,
    owner: Entity | null, kind: WorldEvents['explosion']['kind']): void {
    for (const u of this.units) {
      if (!u.alive || u.team === team || u.spawnDelay > 0) continue;
      const d = Math.hypot(u.x - x, u.z - z, (u.y + 1 - y) * 0.5) - u.def.radius;
      if (d > radius) continue;
      const fall = Math.max(0.25, 1 - Math.max(0, d) / radius);
      this.damageUnit(u, dmg * fall * (u.def.infantry ? 1 : 0.85), owner);
    }
    for (const s of [...this.structures]) {
      if (!s.alive || s.team === team) continue;
      const d = dist2d(s.x, s.z, x, z) - s.def.cells;
      if (d > radius) continue;
      this.damageStructure(s, dmg * structMult * Math.max(0.3, 1 - Math.max(0, d) / radius), owner);
    }
    this.events.emit('explosion', { x, y, z, radius, kind });
  }

  private updateProjectiles(dt: number): void {
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.kind === 'grenade') {
        const t = p.body!.translation();
        p.x = t.x; p.y = t.y; p.z = t.z;
        if (p.life <= 0) {
          p.alive = false;
          this.physics.removeBody(p.body as any);
          this.explode(p.x, p.y + 0.3, p.z, p.radius, p.dmg, p.team, p.structMult, p.owner, 'grenade');
        }
        continue;
      }
      const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
      let hitT = Infinity;
      const seg = Math.hypot(nx - p.x, ny - p.y, nz - p.z);
      const hit = this.physics.raycast(p.x, p.y, p.z, p.vx, p.vy, p.vz, seg);
      if (hit) {
        const owner = this.colliderOwner.get(hit.handle);
        if (!owner || owner.team !== p.team) hitT = hit.t / seg;
      }
      for (const u of this.units) {
        if (!u.alive || u.team === p.team || u.spawnDelay > 0) continue;
        // closest approach of the segment to the unit's centre
        const cy = u.y + (u.def.infantry ? 1 : 1.3);
        const ax = nx - p.x, ay = ny - p.y, az = nz - p.z;
        const t = Math.max(0, Math.min(1, ((u.x - p.x) * ax + (cy - p.y) * ay + (u.z - p.z) * az) / (seg * seg || 1)));
        const d = Math.hypot(p.x + ax * t - u.x, (p.y + ay * t - cy) * 0.6, p.z + az * t - u.z);
        if (d < u.def.radius + 0.45 && t < hitT) hitT = t;
      }
      if (hitT <= 1 || p.life <= 0) {
        const t = Math.min(1, hitT);
        p.alive = false;
        this.explode(p.x + (nx - p.x) * t, p.y + (ny - p.y) * t, p.z + (nz - p.z) * t, p.radius, p.dmg, p.team, p.structMult, p.owner, p.kind);
      } else {
        p.x = nx; p.y = ny; p.z = nz;
      }
    }
    if (this.projectiles.some((p) => !p.alive)) this.projectiles = this.projectiles.filter((p) => p.alive);
  }

  /** Player-aimed hitscan shot from a directly controlled unit. */
  playerHitscan(shooter: Unit, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
    dmg: number, range: number, structMult: number): PlayerHit {
    let bestT = range, hitUnit: Unit | null = null, head = false;
    const sphere = (cx: number, cy: number, cz: number, r: number): number => {
      const lx = cx - ox, ly = cy - oy, lz = cz - oz;
      const tca = lx * dx + ly * dy + lz * dz;
      if (tca < 0) return Infinity;
      const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
      if (d2 > r * r) return Infinity;
      return tca - Math.sqrt(r * r - d2);
    };
    for (const u of this.units) {
      if (!u.alive || u.team === shooter.team || u.spawnDelay > 0) continue;
      if (u.def.infantry) {
        const tb = Math.min(sphere(u.x, u.y + 1.05, u.z, 0.58), sphere(u.x, u.y + 0.45, u.z, 0.45));
        const th = sphere(u.x, u.y + 1.72, u.z, 0.3);
        const t = Math.min(tb, th);
        if (t < bestT) {
          bestT = t;
          hitUnit = u;
          head = th <= tb;
        }
      } else {
        const t = Math.min(sphere(u.x, u.y + 1.3, u.z, 2.1), sphere(u.x, u.y + 2.2, u.z, 1.3));
        if (t < bestT) {
          bestT = t;
          hitUnit = u;
          head = false;
        }
      }
    }
    const st = this.physics.raycast(ox, oy, oz, dx, dy, dz, bestT);
    const res: PlayerHit = { kind: 'none', kill: false, head: false, x: ox + dx * bestT, y: oy + dy * bestT, z: oz + dz * bestT };
    let impact: WorldEvents['shot']['impact'] = 'miss';
    if (st && st.t < bestT) {
      bestT = st.t;
      res.kind = 'world';
      impact = 'cover';
      const s = this.colliderOwner.get(st.handle);
      if (s && s.team !== shooter.team) {
        res.kind = 'struct';
        impact = 'struct';
        this.damageStructure(s, dmg * structMult, shooter);
        res.kill = !s.alive;
      }
    } else if (hitUnit) {
      res.kind = 'unit';
      res.head = head;
      impact = 'unit';
      this.damageUnit(hitUnit, dmg * (head ? 2 : 1) * (hitUnit.def.infantry ? 1 : Math.max(hitUnit.def.armor, 0.3)), shooter);
      res.kill = !hitUnit.alive;
    }
    res.x = ox + dx * bestT; res.y = oy + dy * bestT; res.z = oz + dz * bestT;
    shooter.sinceShot = 0;
    this.events.emit('shot', { team: shooter.team, kind: 'bullet', ox, oy, oz, tx: res.x, ty: res.y, tz: res.z, shooter, impact });
    return res;
  }

  // ------------------------------------------------------------------ cover

  /** Find a nearby cell that puts something solid between the unit and a threat while keeping a firing line. */
  findCover(u: Unit, tx: number, tz: number, tgt: Entity, radius = 6): Pt | null {
    const g = this.grid;
    const r = Math.ceil(radius / g.cell);
    const ucx = g.cx(u.x), ucz = g.cz(u.z);
    const cands: Array<{ c: number; score: number }> = [];
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        const i = ucx + dx, j = ucz + dz;
        if (i < 1 || j < 1 || i >= g.w - 1 || j >= g.h - 1) continue;
        const c = j * g.w + i;
        if (!g.open(c)) continue;
        const x = g.centerX(c), z = g.centerZ(c);
        const dT = dist2d(x, z, tx, tz);
        if (dT > u.def.range * 0.95 || dT < 5) continue;
        const ddx = Math.round((tx - x) / dT), ddz = Math.round((tz - z) / dT);
        const nb = (j + ddz) * g.w + (i + ddx);
        if (g.solid[nb] === 0 && (g.struct[nb] === 0 || g.structTeam[nb] !== u.team)) continue;
        if (this.units.some((o) => o !== u && o.alive && o.team === u.team && dist2d(o.x, o.z, x, z) < 1.3)) continue;
        cands.push({ c, score: dist2d(x, z, u.x, u.z) });
      }
    cands.sort((a, b) => a.score - b.score);
    for (let k = 0; k < Math.min(4, cands.length); k++) {
      const x = g.centerX(cands[k].c), z = g.centerZ(cands[k].c);
      if (this.canSeeFrom(x, this.height(x, z) + u.def.eye, z, tgt)) return { x, z };
    }
    return null;
  }

  // ------------------------------------------------------------------- tick

  private recomputeDanger(): void {
    const g = this.grid;
    for (const team of [PLAYER, ENEMY] as Team[]) {
      const d = g.danger[team];
      d.fill(0);
      for (const s of this.structures) {
        if (!s.alive || !s.done || s.team === team || !s.def.weapon) continue;
        const r = s.def.weapon.range * 0.9;
        const x0 = g.cx(s.x - r), x1 = g.cx(s.x + r), z0 = g.cz(s.z - r), z1 = g.cz(s.z + r);
        for (let j = z0; j <= z1; j++)
          for (let i = x0; i <= x1; i++) {
            const c = j * g.w + i;
            if (dist2d(g.centerX(c), g.centerZ(c), s.x, s.z) <= r) d[c] += s.kind === 'hq' ? 0.6 : 1.6;
          }
      }
    }
    g.version++;
  }

  private separation(): void {
    const us = this.units;
    for (const u of us) {
      u.sepX = 0;
      u.sepZ = 0;
    }
    for (let i = 0; i < us.length; i++) {
      const a = us[i];
      if (!a.alive || a.spawnDelay > 0) continue;
      for (let j = i + 1; j < us.length; j++) {
        const b = us[j];
        if (!b.alive || b.spawnDelay > 0) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const min = a.def.radius + b.def.radius + 0.35;
        if (Math.abs(dx) > min || Math.abs(dz) > min) continue;
        const d = Math.hypot(dx, dz);
        if (d >= min) continue;
        const nx = d > 0.001 ? dx / d : Math.cos(a.id), nz = d > 0.001 ? dz / d : Math.sin(a.id);
        const push = ((min - d) / min) * 5;
        const wa = b.def.infantry && !a.def.infantry ? 0.15 : 1, wb = a.def.infantry && !b.def.infantry ? 0.15 : 1;
        a.sepX -= nx * push * wa; a.sepZ -= nz * push * wa;
        b.sepX += nx * push * wb; b.sepZ += nz * push * wb;
      }
    }
  }

  private updateStructures(dt: number): void {
    for (const s of this.structures) {
      if (!s.alive) continue;
      s.sinceHit += dt;
      s.sinceShot += dt;
      if (!s.done) continue;
      if (s.def.aura || s.kind === 'hq') {
        const r = s.def.aura ?? 14;
        for (const u of this.units)
          if (u.alive && u.team === s.team && u.hp < u.maxHp && u.sinceHit > 4 && dist2d(u.x, u.z, s.x, s.z) < r)
            u.hp = Math.min(u.maxHp, u.hp + (u.def.infantry ? 7 : 16) * dt);
      }
      const w = s.def.weapon;
      if (!w) continue;
      s.cooldown -= dt;
      s.thinkT -= dt;
      if (s.thinkT <= 0) {
        s.thinkT = 0.4;
        let best: Unit | null = null, bd = w.range;
        for (const u of this.units) {
          if (!u.alive || u.team === s.team || u.spawnDelay > 0) continue;
          const d = dist2d(u.x, u.z, s.x, s.z);
          if (d < bd && this.canSee(s, u)) {
            bd = d;
            best = u;
          }
        }
        s.target = best;
      }
      const t = s.target;
      if (t && t.alive) {
        const want = Math.atan2(t.x - s.x, t.z - s.z);
        let diff = want - s.aimYaw;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        s.aimYaw += Math.sign(diff) * Math.min(Math.abs(diff), 5 * dt);
        if (s.cooldown <= 0 && Math.abs(diff) < 0.25) {
          s.cooldown = w.cooldown;
          this.fire(s, t, false);
        }
      } else s.target = null;
    }
  }

  private updateEconomy(dt: number): void {
    const owned = [0, 0];
    for (const p of this.points) if (p.owner >= 0) owned[p.owner]++;
    for (const team of [PLAYER, ENEMY] as Team[]) {
      const t = this.teams[team];
      t.income = ECON.baseIncome + ECON.pointIncome * owned[team];
      t.supply += t.income * dt;
      t.popCap = ECON.basePop + ECON.pointPop * owned[team];
      t.strikeCd = Math.max(0, t.strikeCd - dt);
      const q = t.queue[0];
      if (q) {
        q.t += dt;
        if (q.t >= q.total) {
          t.queue.shift();
          const pos = this.spawnPos(team);
          const u = this.spawnUnit(q.kind, team, pos.x, pos.z, 'base');
          if (team === PLAYER) {
            // step clear of the spawn pad
            const site = t.spawnSite;
            const rx = (site ? site.x : BASES[0].spawnX) + 8 + this.rng.range(0, 6);
            const rz = (site ? site.z : 0) + this.rng.range(-9, 9);
            u.order = { type: 'move', x: rx, z: rz, assault: false };
            this.setGoal(u, rx, rz);
          }
        }
      }
    }
    this.dominance += (owned[PLAYER] - owned[ENEMY]) * ECON.dominanceRate * dt;
    this.dominance = Math.max(-100, Math.min(100, this.dominance));
    if (this.dominance >= 100) this.end(PLAYER, 'Battlefield dominance achieved');
    else if (this.dominance <= -100) this.end(ENEMY, 'The enemy controls the field');
  }

  private updatePoints(dt: number): void {
    for (const p of this.points) {
      let np = 0, ne = 0;
      for (const u of this.units) {
        if (!u.alive || u.spawnDelay > 0) continue;
        if (dist2d(u.x, u.z, p.x, p.z) <= p.radius) u.team === PLAYER ? np++ : ne++;
      }
      const prev = p.update(dt, np, ne);
      if (prev !== null) {
        if (p.owner === PLAYER) {
          this.stats.captures++;
          this.events.emit('alert', { text: `POINT ${p.name} SECURED`, x: p.x, z: p.z, level: 'good' });
        } else if (p.owner === ENEMY) this.events.emit('alert', { text: `POINT ${p.name} LOST TO THE ENEMY`, x: p.x, z: p.z, level: 'bad' });
        else if (prev === PLAYER) this.events.emit('alert', { text: `POINT ${p.name} NEUTRALISED`, x: p.x, z: p.z, level: 'warn' });
        else this.events.emit('alert', { text: `POINT ${p.name} LIBERATED`, x: p.x, z: p.z, level: 'info' });
        this.events.emit('pointChange', { point: p, prev });
      }
    }
  }

  end(winner: Team, reason: string): void {
    if (this.over) return;
    this.over = true;
    this.winner = winner;
    this.events.emit('gameOver', { winner, reason });
  }

  update(dt: number): void {
    if (this.over) {
      this.physics.step(dt);
      return;
    }
    this.time += dt;
    if (this.dangerVer !== 0) {
      this.dangerVer = 0;
      this.recomputeDanger();
    }
    this.updateEconomy(dt);
    this.director.update(dt);

    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.t -= dt;
      if (s.t <= 0) {
        this.strikes.splice(i, 1);
        this.explode(s.x, this.height(s.x, s.z) + 1, s.z, ECON.strikeRadius, ECON.strikeDamage, -1, 1.6, null, 'orbital');
      }
    }

    // Path requests are budgeted so a wave spawning never stalls a frame.
    this.pathBudget = 5;
    for (const u of this.units) {
      if (!u.alive) continue;
      if (u.spawnDelay > 0) {
        u.spawnDelay -= dt;
        continue;
      }
      if (u.needPath && u.goal && !u.controlled && this.pathBudget > 0) {
        this.pathBudget--;
        u.needPath = false;
        u.path = this.grid.findPath(u.x, u.z, u.goal.x, u.goal.z, {
          team: u.team, breach: u.team === ENEMY, danger: u.team === ENEMY ? 1 : 0, wide: !u.def.infantry,
        });
        u.pi = 0;
        u.navVer = this.grid.version;
        u.repathT = 1.5 + this.rng.next();
      }
    }
    this.separation();
    for (const u of this.units) if (u.alive && u.spawnDelay <= 0) updateUnit(this, u, dt);
    this.updateStructures(dt);
    this.updateProjectiles(dt);
    this.updatePoints(dt);
    this.physics.step(dt);

    if (this.units.some((u) => !u.alive)) this.units = this.units.filter((u) => u.alive);
    if (this.structures.some((s) => !s.alive)) this.structures = this.structures.filter((s) => s.alive);
    if (this.controlled && !this.controlled.alive) this.controlled = null;
  }

  dispose(): void {
    this.events.clear();
    this.physics.dispose();
  }
}
