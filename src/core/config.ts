/** Central gameplay tuning. Everything balance-related lives here. */

export const MAP = { halfW: 130, halfH: 90, cell: 2, playW: 122, playH: 84 };

export const PLAYER = 0 as const;
export const ENEMY = 1 as const;
export type Team = 0 | 1;

export type UnitKind = 'rifle' | 'engineer' | 'heavy' | 'tank' | 'sapper';
export type WeaponKind = 'bullet' | 'cutter' | 'rocket' | 'shell';

export interface UnitDef {
  kind: UnitKind;
  name: string;
  enemyName: string;
  role: string;
  hp: number;
  speed: number;
  radius: number;
  range: number;
  sight: number;
  damage: number;
  cooldown: number;
  burst: number;
  burstGap: number;
  accuracy: number;
  weapon: WeaponKind;
  splash: number;
  structMult: number;
  /** multiplier applied to incoming bullet damage */
  armor: number;
  cost: number;
  buildTime: number;
  pop: number;
  eye: number;
  infantry: boolean;
}

const U = (d: Partial<UnitDef> & { kind: UnitKind; name: string }): UnitDef => ({
  enemyName: d.name,
  role: '',
  hp: 100,
  speed: 5,
  radius: 0.55,
  range: 24,
  sight: 34,
  damage: 8,
  cooldown: 0.3,
  burst: 1,
  burstGap: 0,
  accuracy: 0.55,
  weapon: 'bullet',
  splash: 0,
  structMult: 0.3,
  armor: 1,
  cost: 50,
  buildTime: 6,
  pop: 1,
  eye: 1.55,
  infantry: true,
  ...d,
});

export const UNIT_DEFS: Record<UnitKind, UnitDef> = {
  rifle: U({
    kind: 'rifle', name: 'Vanguard', enemyName: 'Reaver', role: 'Line infantry',
    hp: 100, speed: 5.4, range: 25, damage: 8, cooldown: 0.13, burst: 4, burstGap: 0.85,
    accuracy: 0.55, cost: 50, buildTime: 6,
  }),
  engineer: U({
    kind: 'engineer', name: 'Architect', enemyName: 'Architect', role: 'Builds & repairs',
    hp: 85, speed: 5.2, range: 17, sight: 30, damage: 9, cooldown: 0.4, accuracy: 0.5,
    cost: 60, buildTime: 7,
  }),
  heavy: U({
    kind: 'heavy', name: 'Lancer', enemyName: 'Ravager', role: 'Anti-armor rockets',
    hp: 140, speed: 4.3, range: 28, sight: 36, damage: 75, cooldown: 3.4, accuracy: 0.85,
    weapon: 'rocket', splash: 4.5, structMult: 1.7, cost: 95, buildTime: 10,
  }),
  tank: U({
    kind: 'tank', name: 'Bastion', enemyName: 'Crawler', role: 'Armored siege',
    hp: 700, speed: 6.2, radius: 2.0, range: 34, sight: 40, damage: 120, cooldown: 3.2,
    accuracy: 0.9, weapon: 'shell', splash: 5.5, structMult: 1.5, armor: 0.2, cost: 230,
    buildTime: 18, pop: 3, eye: 2.3, infantry: false,
  }),
  sapper: U({
    kind: 'sapper', name: 'Breacher', enemyName: 'Breacher', role: 'Demolition',
    hp: 95, speed: 6.4, range: 4.6, sight: 30, damage: 16, cooldown: 0.45, accuracy: 0.95,
    weapon: 'cutter', structMult: 4, cost: 55,
  }),
};

export type StructKind = 'wall' | 'barricade' | 'turret' | 'bunker' | 'hq';

export interface StructDef {
  kind: StructKind;
  name: string;
  desc: string;
  hp: number;
  cost: number;
  buildTime: number;
  /** collider box: length (x), height, depth (z) */
  size: [number, number, number];
  /** footprint edge in nav cells */
  cells: number;
  weapon?: { range: number; damage: number; cooldown: number; accuracy: number; eye: number };
  aura?: number;
  breachCost: number;
}

export const STRUCT_DEFS: Record<StructKind, StructDef> = {
  wall: {
    kind: 'wall', name: 'Rampart', desc: 'Tall wall. Blocks movement and line of sight.',
    hp: 520, cost: 15, buildTime: 3.5, size: [2, 2.7, 1.0], cells: 1, breachCost: 16,
  },
  barricade: {
    kind: 'barricade', name: 'Barricade', desc: 'Low cover. Troops fire over it.',
    hp: 280, cost: 10, buildTime: 2.2, size: [2, 1.05, 1.1], cells: 1, breachCost: 9,
  },
  turret: {
    kind: 'turret', name: 'Sentry', desc: 'Automated gun. Enemies route around its kill zone.',
    hp: 400, cost: 90, buildTime: 10, size: [1.7, 2.4, 1.7], cells: 1, breachCost: 22,
    weapon: { range: 30, damage: 8, cooldown: 0.16, accuracy: 0.7, eye: 2.75 },
  },
  bunker: {
    kind: 'bunker', name: 'Relay Bunker', desc: 'Forward deploy point. Heals nearby troops.',
    hp: 1200, cost: 140, buildTime: 14, size: [3.8, 2.6, 3.8], cells: 2, aura: 10, breachCost: 40,
  },
  hq: {
    kind: 'hq', name: 'Command Core', desc: 'Lose this and the battle is over.',
    hp: 4500, cost: 0, buildTime: 1, size: [7.6, 5, 7.6], cells: 4, breachCost: 80,
    weapon: { range: 40, damage: 16, cooldown: 0.2, accuracy: 0.75, eye: 8 },
  },
};

export const BUILDABLE: StructKind[] = ['wall', 'barricade', 'turret', 'bunker'];
export const TRAINABLE: UnitKind[] = ['rifle', 'engineer', 'heavy', 'tank'];

export const POINT_DEFS = [
  { name: 'ALPHA', x: -6, z: -50 },
  { name: 'BRAVO', x: 6, z: 0 },
  { name: 'CHARLIE', x: -6, z: 50 },
];

export const BASES = [
  { x: -104, z: 0, spawnX: -92 },
  { x: 104, z: 0, spawnX: 92 },
];

export const ECON = {
  startSupply: 300,
  baseIncome: 2.2,
  pointIncome: 1.5,
  basePop: 14,
  pointPop: 4,
  dominanceRate: 0.1,
  strikeCost: 120,
  strikeCooldown: 45,
  strikeDelay: 2.8,
  strikeRadius: 11,
  strikeDamage: 340,
};

export interface Difficulty {
  id: string;
  name: string;
  budget: number;
  accuracy: number;
  cap: number;
  blurb: string;
}

export const DIFFICULTIES: Difficulty[] = [
  { id: 'recruit', name: 'Recruit', budget: 0.7, accuracy: 0.85, cap: 22, blurb: 'Learn the battlefield.' },
  { id: 'veteran', name: 'Veteran', budget: 1.0, accuracy: 1.0, cap: 30, blurb: 'The intended fight.' },
  { id: 'elite', name: 'Elite', budget: 1.35, accuracy: 1.1, cap: 38, blurb: 'They adapt faster than you build.' },
];

export const COLORS = {
  player: 0x4fe3ff,
  enemy: 0xff3b55,
  neutral: 0xc9d2dc,
  build: 0xffc14a,
};
