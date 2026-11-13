import { STRUCT_DEFS, UNIT_DEFS, type StructDef, type StructKind, type Team, type UnitDef, type UnitKind } from '../core/config';
import type { Pt } from './NavGrid';

let nextId = 1;
export const resetIds = () => (nextId = 1);

export type Order =
  | { type: 'idle' }
  | { type: 'hold' }
  | { type: 'move'; x: number; z: number; assault: boolean }
  | { type: 'attack'; target: Entity }
  | { type: 'build'; target: Structure };

export interface Squad {
  id: number;
  members: Unit[];
  initial: number;
  objective: { kind: 'point'; index: number } | { kind: 'hq' } | { kind: 'defend' };
  state: 'advance' | 'hold' | 'retreat';
  thinkT: number;
  quietT: number;
}

export class Unit {
  readonly isUnit = true as const;
  id = nextId++;
  def: UnitDef;
  hp: number;
  alive = true;
  y = 0;
  yaw = 0;
  aimYaw = 0;
  aimPitch = 0;
  vx = 0;
  vz = 0;
  sepX = 0;
  sepZ = 0;

  order: Order = { type: 'idle' };
  path: Pt[] = [];
  pi = 0;
  goal: Pt | null = null;
  needPath = false;
  repathT = 0;
  navVer = 0;
  stuckT = 0;

  target: Entity | null = null;
  targetVisible = false;
  breach: Structure | null = null;
  thinkT = Math.random() * 0.4;
  cooldown = 0.5;
  burstLeft: number;
  coverT = 0;
  toCover = false;
  sinceHit = 99;
  sinceShot = 99;
  jobT = 0;
  building: Structure | null = null;

  controlled = false;
  squad: Squad | null = null;
  kills = 0;
  /** seconds until the unit becomes active (drop pod / warp-in) */
  spawnDelay = 0;

  constructor(public kind: UnitKind, public team: Team, public x: number, public z: number) {
    this.def = UNIT_DEFS[kind];
    this.hp = this.def.hp;
    this.burstLeft = this.def.burst;
  }
  get maxHp(): number {
    return this.def.hp;
  }
  get label(): string {
    return this.team === 0 ? this.def.name : this.def.enemyName;
  }
}

export class Structure {
  readonly isUnit = false as const;
  id = nextId++;
  def: StructDef;
  hp: number;
  maxHp: number;
  progress = 0;
  done = false;
  alive = true;
  y = 0;
  /** length scale so diagonal wall segments still connect */
  len = 1;
  cells: number[] = [];
  colliders: number[] = [];
  cooldown = 0;
  thinkT = Math.random() * 0.5;
  target: Unit | null = null;
  aimYaw = 0;
  sinceHit = 99;
  sinceShot = 99;

  constructor(public kind: StructKind, public team: Team, public x: number, public z: number, public rot = 0) {
    this.def = STRUCT_DEFS[kind];
    this.maxHp = this.def.hp;
    this.hp = this.maxHp * 0.15;
  }
  get radius(): number {
    return this.def.cells;
  }
  get label(): string {
    return this.def.name;
  }
}

export type Entity = Unit | Structure;

export interface Projectile {
  id: number;
  kind: 'rocket' | 'shell' | 'grenade';
  team: Team;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  dmg: number;
  radius: number;
  structMult: number;
  owner: Entity | null;
  body?: { translation(): { x: number; y: number; z: number } };
  alive: boolean;
}

export interface Obstacle {
  type: 'rock' | 'ruin' | 'crystal' | 'wreck';
  x: number;
  z: number;
  y: number;
  r: number;
  h: number;
  w: number;
  d: number;
  rot: number;
  seed: number;
}

export const newId = () => nextId++;
