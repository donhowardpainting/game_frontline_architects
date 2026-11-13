import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COLORS, type StructKind, type Team, type UnitKind } from '../core/config';
import type { Obstacle } from '../sim/entities';

/** Tiny procedural modelling helper: coloured primitives merged into one flat-shaded mesh. */
export class Geo {
  parts: THREE.BufferGeometry[] = [];
  private static m = new THREE.Matrix4();
  private static e = new THREE.Euler();
  private static c = new THREE.Color();

  private add(g: THREE.BufferGeometry, color: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): this {
    if (g.index) g = g.toNonIndexed();
    Geo.m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(Geo.e.set(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
    g.applyMatrix4(Geo.m);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    Geo.c.set(color);
    for (let i = 0; i < n; i++) {
      col[i * 3] = Geo.c.r;
      col[i * 3 + 1] = Geo.c.g;
      col[i * 3 + 2] = Geo.c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    this.parts.push(g);
    return this;
  }
  box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, rx = 0, ry = 0, rz = 0): this {
    return this.add(new THREE.BoxGeometry(w, h, d), color, x, y, z, rx, ry, rz);
  }
  cyl(rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, color: number, rx = 0, ry = 0, rz = 0): this {
    return this.add(new THREE.CylinderGeometry(rt, rb, h, seg), color, x, y, z, rx, ry, rz);
  }
  ball(r: number, x: number, y: number, z: number, color: number, sx = 1, sy = 1, sz = 1, detail = 1): this {
    return this.add(new THREE.IcosahedronGeometry(r, detail), color, x, y, z, 0, 0, 0, sx, sy, sz);
  }
  raw(g: THREE.BufferGeometry, color: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): this {
    return this.add(g, color, x, y, z, rx, ry, rz);
  }
  get empty(): boolean {
    return this.parts.length === 0;
  }
  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts, false)!;
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const hdr = (hex: number, k: number) => new THREE.Color(hex).multiplyScalar(k);

export const MAT = {
  solid: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6, metalness: 0.35 }),
  rough: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0.02 }),
  glow: [
    new THREE.MeshBasicMaterial({ color: hdr(COLORS.player, 2.4) }),
    new THREE.MeshBasicMaterial({ color: hdr(COLORS.enemy, 2.6) }),
  ],
  glowBuild: new THREE.MeshBasicMaterial({ color: hdr(COLORS.build, 2.2) }),
  crystal: new THREE.MeshBasicMaterial({ color: hdr(0x7a5cff, 1.9) }),
  blueprint: new THREE.MeshBasicMaterial({ color: 0x4fe3ff, transparent: true, opacity: 0.16, depthWrite: false, wireframe: false }),
  blueprintWire: new THREE.MeshBasicMaterial({ color: hdr(0x4fe3ff, 1.4), wireframe: true, transparent: true, opacity: 0.5 }),
};

const PAL = [
  { armor: 0x566878, plate: 0x93a8ba, dark: 0x232a33, cloth: 0x3a4652, gun: 0x1b1f26 },
  { armor: 0x3a242c, plate: 0x6a3442, dark: 0x140d12, cloth: 0x24161c, gun: 0x0e0a0d },
];

export interface UnitParts {
  body: THREE.BufferGeometry;
  leg?: THREE.BufferGeometry;
  arms?: THREE.BufferGeometry;
  turret?: THREE.BufferGeometry;
  glow: THREE.BufferGeometry;
  turretGlow?: THREE.BufferGeometry;
}

const cache = new Map<string, any>();
const memo = <T>(key: string, fn: () => T): T => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};

export function unitParts(kind: UnitKind, team: Team): UnitParts {
  return memo(`u-${kind}-${team}`, () => (kind === 'tank' ? tankParts(team) : infantryParts(kind, team)));
}

function gunGeo(g: Geo, glow: Geo, kind: UnitKind, c: (typeof PAL)[0], x = 0.16, y = -0.06, z = 0): void {
  if (kind === 'heavy') {
    g.cyl(0.14, 0.14, 1.35, 7, x + 0.12, y + 0.3, z + 0.1, c.gun, Math.PI / 2);
    g.cyl(0.19, 0.16, 0.25, 7, x + 0.12, y + 0.3, z + 0.82, c.dark, Math.PI / 2);
    g.box(0.12, 0.2, 0.3, x + 0.12, y + 0.12, z + 0.25, c.dark);
    glow.box(0.05, 0.05, 0.3, x + 0.12, y + 0.46, z + 0.2, 0xffffff);
  } else if (kind === 'engineer') {
    g.box(0.16, 0.2, 0.5, x, y, z + 0.4, 0x8a6a2a);
    g.cyl(0.05, 0.08, 0.3, 6, x, y, z + 0.78, c.gun, Math.PI / 2);
    g.box(0.1, 0.22, 0.12, x, y - 0.18, z + 0.3, c.dark);
    glow.box(0.08, 0.08, 0.06, x, y, z + 0.95, 0xffffff);
  } else if (kind === 'sapper') {
    g.box(0.12, 0.14, 0.5, x, y, z + 0.4, c.gun);
    g.box(0.05, 0.3, 0.7, x, y + 0.02, z + 0.95, c.dark);
    glow.box(0.03, 0.22, 0.66, x, y + 0.02, z + 0.97, 0xffffff);
  } else {
    g.box(0.1, 0.16, 0.85, x, y, z + 0.5, c.gun);
    g.box(0.06, 0.07, 0.4, x, y + 0.02, z + 1.05, c.dark);
    g.box(0.08, 0.24, 0.12, x, y - 0.18, z + 0.42, c.dark);
    g.box(0.07, 0.07, 0.24, x, y + 0.13, z + 0.45, c.plate);
    glow.box(0.03, 0.03, 0.2, x, y + 0.18, z + 0.45, 0xffffff);
  }
}

function infantryParts(kind: UnitKind, team: Team): UnitParts {
  const c = PAL[team];
  const plate = kind === 'engineer' ? 0xe0a030 : kind === 'heavy' ? (team ? 0x7a3a2a : 0x6c8098) : c.plate;
  const bulk = kind === 'heavy' ? 1.2 : kind === 'sapper' ? 0.9 : 1;
  const b = new Geo(), glow = new Geo();
  b.box(0.46 * bulk, 0.22, 0.3, 0, 0.9, 0, c.cloth);
  b.box(0.58 * bulk, 0.56, 0.36, 0, 1.25, 0, c.armor);
  b.box(0.5 * bulk, 0.34, 0.1, 0, 1.32, 0.2, plate);
  b.box(0.22, 0.2, 0.26, -0.39 * bulk, 1.48, 0, plate);
  b.box(0.22, 0.2, 0.26, 0.39 * bulk, 1.48, 0, plate);
  b.box(0.16, 0.1, 0.16, 0, 1.56, 0, c.dark);
  b.box(0.27, 0.27, 0.29, 0, 1.72, 0, c.armor);
  if (team === 0) {
    b.box(0.31, 0.11, 0.33, 0, 1.86, -0.01, plate);
    b.box(0.42, 0.5, 0.22, 0, 1.28, -0.28, c.cloth);
    b.cyl(0.015, 0.015, 0.6, 4, 0.16, 1.8, -0.3, c.dark);
    glow.box(0.23, 0.07, 0.04, 0, 1.73, 0.15, 0xffffff);
    glow.box(0.08, 0.08, 0.03, 0, 1.4, -0.4, 0xffffff);
    if (kind === 'engineer') {
      b.box(0.5, 0.3, 0.26, 0, 1.62, -0.3, 0x6b5a30);
      b.cyl(0.02, 0.02, 0.9, 4, -0.18, 2.1, -0.32, c.dark);
      glow.box(0.06, 0.06, 0.06, -0.18, 2.56, -0.32, 0xffffff);
    }
  } else {
    b.raw(new THREE.ConeGeometry(0.2, 0.42, 4), plate, 0, 1.98, -0.02, 0, Math.PI / 4);
    b.box(0.08, 0.36, 0.3, 0, 1.4, -0.28, plate, 0.3);
    glow.box(0.25, 0.05, 0.04, 0, 1.75, 0.15, 0xffffff);
    glow.box(0.05, 0.16, 0.04, 0, 1.68, 0.15, 0xffffff);
    glow.box(0.04, 0.3, 0.03, 0, 1.42, -0.45, 0xffffff);
  }
  const leg = new Geo();
  leg.box(0.2, 0.44, 0.24, 0, -0.2, 0, c.cloth);
  leg.box(0.18, 0.4, 0.2, 0, -0.56, -0.01, c.armor);
  leg.box(0.16, 0.2, 0.08, 0, -0.42, 0.13, plate);
  leg.box(0.2, 0.12, 0.34, 0, -0.8, 0.05, c.dark);
  const arms = new Geo();
  arms.box(0.15, 0.15, 0.5, -0.33 * bulk, -0.02, 0.2, c.armor, 0, 0.35);
  arms.box(0.15, 0.15, 0.48, 0.33 * bulk, -0.04, 0.16, c.armor, 0, -0.1);
  gunGeo(arms, glow2(), kind, c);
  // weapon glow lives with the arms so it follows the aim
  const ag = new Geo();
  gunGeo(new Geo(), ag, kind, c);
  return { body: b.build(), leg: leg.build(), arms: arms.build(), glow: glow.build(), turretGlow: ag.build() };
}
const glow2 = () => new Geo();

function tankParts(team: Team): UnitParts {
  const c = PAL[team];
  const b = new Geo(), glow = new Geo(), t = new Geo(), tg = new Geo();
  for (const s of [-1, 1]) {
    b.box(0.8, 0.9, 5.3, s * 1.45, 0.5, 0, c.dark);
    b.box(0.86, 0.3, 4.6, s * 1.45, 0.98, 0, c.armor);
    b.box(0.82, 0.5, 0.6, s * 1.45, 0.6, 2.6, c.dark, -0.6);
    b.box(0.82, 0.5, 0.6, s * 1.45, 0.6, -2.6, c.dark, 0.6);
    for (let i = -2; i <= 2; i++) b.cyl(0.36, 0.36, 0.84, 8, s * 1.45, 0.42, i * 1.05, 0x0c0d10, 0, 0, Math.PI / 2);
    glow.box(0.04, 0.08, 3.6, s * 1.9, 1.0, 0, 0xffffff);
  }
  b.box(2.3, 0.75, 4.5, 0, 0.95, 0, c.armor);
  b.box(2.3, 0.5, 1.3, 0, 1.0, 2.35, c.plate, 0.55);
  b.box(2.1, 0.3, 2.6, 0, 1.42, -0.5, c.plate);
  b.box(1.6, 0.5, 0.7, 0, 1.25, -2.3, c.dark);
  b.box(0.5, 0.35, 0.5, -0.7, 1.55, -1.9, c.dark);
  if (team === 1) {
    b.raw(new THREE.ConeGeometry(0.25, 1.1, 4), c.plate, -1.45, 1.5, 1.9, 0.5);
    b.raw(new THREE.ConeGeometry(0.25, 1.1, 4), c.plate, 1.45, 1.5, 1.9, 0.5);
    b.raw(new THREE.ConeGeometry(0.22, 0.9, 4), c.plate, 0, 1.3, 3.0, 1.3);
  }
  glow.box(0.7, 0.1, 0.05, 0, 1.12, 2.72, 0xffffff);
  // turret (origin at ring)
  t.cyl(1.05, 1.2, 0.6, 8, 0, 0.3, 0, c.armor);
  t.box(1.5, 0.55, 1.3, 0, 0.42, -0.8, c.plate);
  t.box(1.3, 0.5, 0.9, 0, 0.38, 0.9, c.plate, 0.25);
  t.cyl(0.17, 0.2, 3.0, 8, 0, 0.42, 2.5, c.gun, Math.PI / 2);
  t.cyl(0.26, 0.26, 0.5, 8, 0, 0.42, 3.9, c.dark, Math.PI / 2);
  t.box(0.4, 0.3, 0.5, 0.6, 0.8, -0.2, c.dark);
  t.cyl(0.02, 0.02, 1.4, 4, -0.6, 1.3, -0.9, c.dark);
  tg.box(0.3, 0.12, 0.05, 0.6, 0.82, 0.07, 0xffffff);
  tg.box(0.06, 0.06, 0.06, -0.6, 2.02, -0.9, 0xffffff);
  tg.box(1.52, 0.06, 0.4, 0, 0.5, -0.9, 0xffffff);
  return { body: b.build(), turret: t.build(), glow: glow.build(), turretGlow: tg.build() };
}

export interface StructParts {
  main: THREE.BufferGeometry;
  glow: THREE.BufferGeometry;
  head?: THREE.BufferGeometry;
  headGlow?: THREE.BufferGeometry;
  headY?: number;
}

export function structParts(kind: StructKind, team: Team): StructParts {
  return memo(`s-${kind}-${team}`, () => {
    const c = PAL[team];
    const conc = team === 0 ? 0x6f7a84 : 0x3a2a30;
    const concD = team === 0 ? 0x4a535c : 0x24181d;
    const m = new Geo(), g = new Geo();
    if (kind === 'wall') {
      m.box(2.0, 0.45, 1.05, 0, 0.22, 0, concD);
      m.box(2.0, 2.0, 0.66, 0, 1.4, 0, conc);
      m.box(2.0, 0.22, 0.86, 0, 2.52, 0, c.plate);
      m.box(0.24, 2.3, 0.9, -0.88, 1.3, 0, concD);
      m.box(0.24, 2.3, 0.9, 0.88, 1.3, 0, concD);
      m.box(1.3, 0.5, 0.72, 0, 1.0, 0, c.armor);
      g.box(1.3, 0.07, 0.74, 0, 1.95, 0, 0xffffff);
    } else if (kind === 'barricade') {
      m.box(2.0, 0.5, 1.0, 0, 0.25, 0, concD);
      m.box(1.9, 0.5, 0.6, 0, 0.74, 0, conc);
      m.box(0.5, 0.52, 0.64, -0.5, 0.74, 0, 0xd9a520);
      m.box(0.5, 0.52, 0.64, 0.5, 0.74, 0, 0x1c1c1c);
      m.box(1.96, 0.08, 0.7, 0, 1.02, 0, c.plate);
      g.box(0.1, 0.08, 0.72, -0.9, 0.9, 0, 0xffffff);
      g.box(0.1, 0.08, 0.72, 0.9, 0.9, 0, 0xffffff);
    } else if (kind === 'turret') {
      m.cyl(0.7, 0.95, 0.7, 6, 0, 0.35, 0, concD);
      m.cyl(0.42, 0.55, 1.1, 6, 0, 1.2, 0, c.armor);
      m.box(0.3, 0.5, 1.9, 0, 0.3, 0, c.dark);
      m.box(1.9, 0.5, 0.3, 0, 0.3, 0, c.dark);
      g.cyl(0.57, 0.57, 0.06, 6, 0, 0.74, 0, 0xffffff);
      const h = new Geo(), hg = new Geo();
      h.box(1.0, 0.62, 1.2, 0, 0.3, 0, c.plate);
      h.box(1.2, 0.3, 0.7, 0, 0.26, -0.2, c.armor);
      h.cyl(0.07, 0.07, 1.3, 6, -0.24, 0.32, 1.1, c.gun, Math.PI / 2);
      h.cyl(0.07, 0.07, 1.3, 6, 0.24, 0.32, 1.1, c.gun, Math.PI / 2);
      h.box(0.2, 0.2, 0.2, 0, 0.72, -0.3, c.dark);
      hg.box(0.5, 0.1, 0.04, 0, 0.5, 0.62, 0xffffff);
      hg.box(0.08, 0.08, 0.08, 0, 0.86, -0.3, 0xffffff);
      return { main: m.build(), glow: g.build(), head: h.build(), headGlow: hg.build(), headY: 1.78 };
    } else if (kind === 'bunker') {
      m.cyl(2.0, 2.25, 1.7, 8, 0, 0.85, 0, conc, 0, Math.PI / 8);
      m.cyl(1.25, 1.95, 0.6, 8, 0, 2.0, 0, concD, 0, Math.PI / 8);
      m.cyl(1.0, 1.2, 0.3, 8, 0, 2.42, 0, c.plate, 0, Math.PI / 8);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        m.box(1.2, 0.26, 0.3, Math.sin(a) * 2.02, 1.15, Math.cos(a) * 2.02, 0x08090b, 0, a);
        m.box(0.5, 1.9, 0.6, Math.sin(a + 0.785) * 2.15, 0.95, Math.cos(a + 0.785) * 2.15, concD, 0, a + 0.785);
      }
      m.cyl(0.04, 0.04, 2.4, 4, 0.6, 3.6, -0.4, c.dark);
      m.cyl(0.5, 0.2, 0.25, 8, -0.4, 2.7, 0.3, c.armor);
      g.cyl(1.27, 1.27, 0.07, 8, 0, 2.28, 0, 0xffffff, 0, Math.PI / 8);
      g.box(0.1, 0.1, 0.1, 0.6, 4.84, -0.4, 0xffffff);
    } else if (team === 0) {
      // Aegis Command Core
      m.box(8.0, 1.0, 8.0, 0, 0.5, 0, concD);
      m.cyl(3.6, 4.2, 2.6, 8, 0, 2.2, 0, conc, 0, Math.PI / 8);
      m.cyl(2.5, 3.3, 1.2, 8, 0, 4.1, 0, c.plate, 0, Math.PI / 8);
      m.cyl(1.2, 1.5, 4.4, 8, 0, 6.8, 0, c.armor);
      m.cyl(1.7, 1.7, 0.5, 8, 0, 8.6, 0, c.plate);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        m.box(1.4, 3.4, 1.4, Math.sin(a) * 4.6, 1.7, Math.cos(a) * 4.6, concD, 0, a);
        m.box(0.5, 0.5, 3.2, Math.sin(a) * 3.2, 4.0, Math.cos(a) * 3.2, c.armor, 0.6, a);
        g.box(0.4, 1.6, 0.1, Math.sin(a) * 5.34, 2.2, Math.cos(a) * 5.34, 0xffffff, 0, a);
      }
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        g.box(1.3, 0.3, 0.08, Math.sin(a) * 3.7, 2.7, Math.cos(a) * 3.7, 0xffffff, 0, a);
      }
      g.cyl(1.24, 1.24, 0.14, 8, 0, 7.6, 0, 0xffffff);
      g.cyl(1.52, 1.52, 0.1, 8, 0, 5.2, 0, 0xffffff);
      m.cyl(0.05, 0.05, 4, 4, 0, 10.8, 0, c.dark);
      g.box(0.14, 0.14, 0.14, 0, 12.8, 0, 0xffffff);
      const h = new Geo(), hg = new Geo();
      h.cyl(0.2, 0.2, 0.8, 6, 1.1, 0.4, 0, c.dark);
      h.raw(new THREE.SphereGeometry(1.3, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2.4), c.plate, 1.1, 2.0, 0, Math.PI * 0.75);
      h.cyl(0.03, 0.03, 1.2, 4, 1.1, 1.3, 0.5, c.dark, -0.8);
      hg.box(0.12, 0.12, 0.12, 1.1, 1.7, 0.95, 0xffffff);
      return { main: m.build(), glow: g.build(), head: h.build(), headGlow: hg.build(), headY: 8.85 };
    } else {
      // Vanta Spire
      m.cyl(4.6, 5.2, 1.0, 5, 0, 0.5, 0, concD);
      m.cyl(1.9, 3.6, 5.5, 5, 0, 3.6, 0, conc);
      m.cyl(0.9, 1.9, 4.2, 5, 0, 8.4, 0, c.plate);
      m.raw(new THREE.ConeGeometry(0.9, 3.2, 5), c.armor, 0, 12.1, 0);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        m.raw(new THREE.ConeGeometry(0.7, 5.5, 4), concD, Math.sin(a) * 4.3, 2.6, Math.cos(a) * 4.3, Math.cos(a) * 0.35, 0, -Math.sin(a) * 0.35);
        g.box(0.12, 4.2, 0.12, Math.sin(a + 0.63) * 2.55, 3.6, Math.cos(a + 0.63) * 2.55, 0xffffff, Math.cos(a + 0.63) * 0.3, 0, -Math.sin(a + 0.63) * 0.3);
      }
      g.ball(0.75, 0, 10.9, 0, 0xffffff);
      const h = new Geo(), hg = new Geo();
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        h.raw(new THREE.OctahedronGeometry(0.55), c.plate, Math.sin(a) * 2.6, 0, Math.cos(a) * 2.6, 0.4, a);
        hg.raw(new THREE.OctahedronGeometry(0.2), 0xffffff, Math.sin(a + 1) * 2.0, 0.8, Math.cos(a + 1) * 2.0);
      }
      return { main: m.build(), glow: g.build(), head: h.build(), headGlow: hg.build(), headY: 9.6 };
    }
    return { main: m.build(), glow: g.build() };
  });
}

function rnd(seed: number) {
  let s = seed * 9301 + 49297;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/** All static scenery merged into two meshes (lit + emissive). */
export function buildScenery(obstacles: Obstacle[]): { solid: THREE.BufferGeometry; glow: THREE.BufferGeometry | null } {
  const g = new Geo(), glow = new Geo();
  for (const o of obstacles) {
    const r = rnd(o.seed);
    if (o.type === 'rock') {
      const n = 1 + Math.floor(r() * 2.2);
      for (let k = 0; k < n; k++) {
        const rr = k === 0 ? o.r : o.r * (0.35 + r() * 0.3);
        const ico = new THREE.IcosahedronGeometry(rr, 1);
        const p = ico.attributes.position;
        // jitter vertices coherently (same position -> same offset) to keep the mesh closed
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
          const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + o.seed) * 43758.5453;
          const f = 0.8 + (h - Math.floor(h)) * 0.42;
          p.setXYZ(i, x * f, y * f, z * f);
        }
        const a = r() * 6.28, d = k === 0 ? 0 : o.r * 0.75;
        const shade = 0.75 + r() * 0.35;
        const col = new THREE.Color(0x4a4744).multiplyScalar(shade).getHex();
        ico.scale(1, (o.h / o.r) * (k === 0 ? 0.8 : 0.6), 1);
        g.raw(ico, col, o.x + Math.cos(a) * d, o.y + (k === 0 ? o.h * 0.25 : 0.1), o.z + Math.sin(a) * d, r() * 0.4, r() * 6.28, r() * 0.4);
      }
    } else if (o.type === 'ruin') {
      const c = Math.cos(o.rot), s = Math.sin(o.rot);
      const segs = Math.max(3, Math.round(o.w / 0.9));
      for (let i = 0; i < segs; i++) {
        const t = (i + 0.5) / segs - 0.5;
        const h = o.h * (0.72 + r() * 0.5) * (r() < 0.14 ? 0.5 : 1);
        const shade = new THREE.Color(0x5d5f60).multiplyScalar(0.8 + r() * 0.3).getHex();
        g.box(o.w / segs + 0.02, h, o.d * (0.85 + r() * 0.3), o.x + c * t * o.w, o.y + h / 2 - 0.25, o.z - s * t * o.w, shade, 0, o.rot, 0);
        if (r() < 0.3) g.cyl(0.03, 0.03, 0.8, 4, o.x + c * t * o.w, o.y + h + 0.1, o.z - s * t * o.w, 0x2a1c14, r() * 0.5, 0, r() * 0.5);
      }
      g.box(o.w * 1.05, 0.3, o.d * 1.5, o.x, o.y + 0.02, o.z, 0x3c3d3e, 0, o.rot, 0);
    } else if (o.type === 'crystal') {
      const n = 3 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) {
        const h = o.h * (k === 0 ? 1 : 0.35 + r() * 0.5);
        const a = r() * 6.28, d = k === 0 ? 0 : 0.5 + r() * 0.6;
        const geo = new THREE.CylinderGeometry(0, 0.42 * (h / o.h + 0.3), h, 5);
        glow.raw(geo, 0xffffff, o.x + Math.cos(a) * d, o.y + h / 2 - 0.3, o.z + Math.sin(a) * d, (r() - 0.5) * 0.7, r() * 6, (r() - 0.5) * 0.7);
      }
      g.ball(1.3, o.x, o.y - 0.2, o.z, 0x2c2a33, 1, 0.5, 1);
    } else {
      // wrecked hull
      g.box(o.w, 1.1, o.d, o.x, o.y + 0.6, o.z, 0x2a2623, 0.08, o.rot, 0.1);
      g.box(o.w * 0.5, 0.8, o.d * 0.7, o.x, o.y + 1.4, o.z, 0x201d1b, -0.1, o.rot + 0.3, 0.14);
      g.cyl(0.12, 0.12, 2.6, 6, o.x + Math.cos(o.rot) * 1.2, o.y + 1.6, o.z - Math.sin(o.rot) * 1.2, 0x171514, 0.4, o.rot, 1.3);
      g.box(o.w * 1.05, 0.5, 0.5, o.x + Math.sin(o.rot) * o.d * 0.5, o.y + 0.3, o.z + Math.cos(o.rot) * o.d * 0.5, 0x151312, 0, o.rot, 0);
    }
  }
  return { solid: g.build(), glow: glow.empty ? null : glow.build() };
}

export function podGeo(): { main: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
  return memo('pod', () => {
    const m = new Geo(), g = new Geo();
    m.cyl(0.95, 1.1, 2.4, 6, 0, 1.9, 0, 0x55626e);
    m.cyl(1.1, 0.4, 0.8, 6, 0, 0.4, 0, 0x2c333b);
    m.cyl(0.4, 0.95, 0.7, 6, 0, 3.4, 0, 0x93a8ba);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      m.box(0.12, 1.6, 0.9, Math.sin(a) * 1.3, 2.6, Math.cos(a) * 1.3, 0x3a4652, 0, a);
      g.box(0.5, 0.9, 0.05, Math.sin(a + 1.05) * 1.0, 2.0, Math.cos(a + 1.05) * 1.0, 0xffffff, 0, a + 1.05);
    }
    return { main: m.build(), glow: g.build() };
  });
}

/** First-person weapon models (origin at grip, pointing -Z in camera space). */
export function viewModel(kind: UnitKind): { main: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
  return memo('vm-' + kind, () => {
    const m = new Geo(), g = new Geo();
    const c = PAL[0];
    if (kind === 'heavy') {
      m.cyl(0.075, 0.075, 0.95, 10, 0, 0.02, -0.25, 0x55626e, Math.PI / 2);
      m.cyl(0.1, 0.085, 0.16, 10, 0, 0.02, -0.76, 0x2a323c, Math.PI / 2);
      m.box(0.06, 0.14, 0.08, 0, -0.1, -0.1, 0x2a323c);
      m.box(0.05, 0.07, 0.22, 0.09, 0.07, -0.2, c.plate);
      g.box(0.02, 0.02, 0.2, 0.09, 0.115, -0.2, 0xffffff);
    } else if (kind === 'engineer') {
      m.box(0.09, 0.11, 0.34, 0, 0, -0.2, 0xb8862a);
      m.box(0.06, 0.16, 0.08, 0, -0.11, -0.08, 0x2a323c);
      m.cyl(0.028, 0.045, 0.2, 8, 0, 0.01, -0.46, 0x353f4a, Math.PI / 2);
      m.box(0.11, 0.03, 0.2, 0, 0.07, -0.2, c.plate);
      g.box(0.04, 0.04, 0.03, 0, 0.01, -0.57, 0xffffff);
      g.box(0.1, 0.012, 0.12, 0, 0.09, -0.2, 0xffffff);
    } else {
      m.box(0.07, 0.11, 0.62, 0, 0, -0.3, 0x4a5866);
      m.box(0.045, 0.05, 0.3, 0, 0.012, -0.72, 0x2a323c);
      m.box(0.055, 0.17, 0.09, 0, -0.12, -0.3, 0x2a323c);
      m.box(0.05, 0.13, 0.07, 0, -0.1, -0.08, 0x353f4a, 0.25);
      m.box(0.06, 0.06, 0.2, 0, 0.085, -0.25, c.plate);
      m.box(0.075, 0.09, 0.22, 0, -0.01, 0.1, c.armor);
      g.box(0.02, 0.02, 0.16, 0, 0.12, -0.25, 0xffffff);
      g.box(0.075, 0.012, 0.3, 0, 0.03, -0.42, 0xffffff);
    }
    return { main: m.build(), glow: g.build() };
  });
}
