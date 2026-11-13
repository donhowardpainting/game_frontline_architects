import * as THREE from 'three';
import { BASES, COLORS, MAP, PLAYER, POINT_DEFS, type Team } from '../core/config';
import { angDiff } from '../core/math';
import type { World } from '../sim/World';
import type { Projectile, Structure, Unit } from '../sim/entities';
import { fbm } from '../sim/terrain';
import { Effects } from './Effects';
import { Geo, MAT, buildScenery, podGeo, structParts, unitParts } from './models';

export interface ViewHooks {
  shake(amount: number, x?: number, z?: number): void;
  sound(name: string, x?: number, z?: number, vol?: number): void;
}

const UNIT_SCALE = 1.22;
const burnt = new THREE.MeshStandardMaterial({ color: 0x15120f, roughness: 1, flatShading: true });
const ringGeo = new THREE.RingGeometry(0.78, 1, 28).rotateX(-Math.PI / 2);
const ringGeoBig = new THREE.RingGeometry(0.93, 1, 40).rotateX(-Math.PI / 2);
const ringMats = [COLORS.player, COLORS.enemy].map(
  (c) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.28, depthWrite: false }),
);
const ringSel = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(1.5), transparent: true, opacity: 0.95, depthWrite: false });
const ringCtl = new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.build).multiplyScalar(2), transparent: true, opacity: 0.95, depthWrite: false });

class UnitView {
  group = new THREE.Group();
  inner = new THREE.Group();
  legs: THREE.Mesh[] = [];
  arms: THREE.Group | null = null;
  turret: THREE.Group | null = null;
  ring: THREE.Mesh;
  phase = Math.random() * 6;
  recoil = 0;
  smokeT = 0;
  constructor(public u: Unit) {
    const p = unitParts(u.kind, u.team);
    const glowMat = u.kind === 'engineer' ? MAT.glowBuild : MAT.glow[u.team];
    const body = new THREE.Mesh(p.body, MAT.solid);
    body.castShadow = true;
    this.inner.add(body, new THREE.Mesh(p.glow, glowMat));
    if (p.leg) {
      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(p.leg, MAT.solid);
        leg.position.set(s * 0.16, 0.86, 0);
        leg.castShadow = true;
        this.legs.push(leg);
        this.inner.add(leg);
      }
    }
    if (p.arms) {
      this.arms = new THREE.Group();
      this.arms.position.set(0, 1.36, 0.05);
      const a = new THREE.Mesh(p.arms, MAT.solid);
      a.castShadow = true;
      this.arms.add(a, new THREE.Mesh(p.turretGlow!, glowMat));
      this.inner.add(this.arms);
    }
    if (p.turret) {
      this.turret = new THREE.Group();
      this.turret.position.set(0, 1.55, -0.3);
      const t = new THREE.Mesh(p.turret, MAT.solid);
      t.castShadow = true;
      this.turret.add(t, new THREE.Mesh(p.turretGlow!, glowMat));
      this.inner.add(this.turret);
    }
    const sc = u.def.infantry ? UNIT_SCALE : 1;
    this.inner.scale.setScalar(sc);
    this.ring = new THREE.Mesh(ringGeo, ringMats[u.team]);
    const rr = u.def.infantry ? 0.95 : 3.1;
    if (!u.def.infantry) this.ring.geometry = ringGeoBig;
    this.ring.scale.set(rr, 1, rr);
    this.ring.position.y = 0.12;
    this.ring.renderOrder = 3;
    this.group.add(this.inner, this.ring);
  }
}

class StructView {
  group = new THREE.Group();
  main: THREE.Mesh;
  glow: THREE.Mesh;
  head: THREE.Group | null = null;
  wire: THREE.Mesh | null = null;
  clip: THREE.Plane | null = null;
  mat: THREE.Material | null = null;
  smokeT = Math.random();
  pop = 0;
  finished = false;
  constructor(public s: Structure) {
    const p = structParts(s.kind, s.team);
    this.main = new THREE.Mesh(p.main, MAT.solid);
    this.main.castShadow = true;
    this.main.receiveShadow = true;
    this.glow = new THREE.Mesh(p.glow, MAT.glow[s.team]);
    this.group.add(this.main, this.glow);
    if (p.head) {
      this.head = new THREE.Group();
      this.head.position.y = p.headY!;
      const h = new THREE.Mesh(p.head, MAT.solid);
      h.castShadow = true;
      this.head.add(h, new THREE.Mesh(p.headGlow!, MAT.glow[s.team]));
      this.group.add(this.head);
    }
    this.group.position.set(s.x, s.y, s.z);
    this.group.rotation.y = s.rot;
    if (s.kind === 'wall' || s.kind === 'barricade') this.group.scale.x = s.len;
    if (!s.done) {
      this.clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), s.y);
      this.mat = MAT.solid.clone();
      this.mat.clippingPlanes = [this.clip];
      this.main.material = this.mat;
      this.glow.visible = false;
      if (this.head) this.head.visible = false;
      this.wire = new THREE.Mesh(p.main, MAT.blueprintWire);
      this.wire.add(new THREE.Mesh(p.main, MAT.blueprint));
      this.group.add(this.wire);
    } else this.finished = true;
  }
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.main.material = MAT.solid;
    this.mat?.dispose();
    this.glow.visible = true;
    if (this.head) this.head.visible = true;
    if (this.wire) this.group.remove(this.wire);
    this.wire = null;
    this.pop = 1;
  }
}

interface Pod { mesh: THREE.Group; unit: Unit; t: number; land: number; x: number; y: number; z: number; landed: boolean }
interface Corpse { obj: THREE.Object3D; t: number; life: number; fall: boolean }

const pointVert = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const pointFrag = /* glsl */ `
uniform float uProgress, uTime, uContest; uniform vec3 uColor, uFill;
varying vec2 vUv;
void main(){
  vec2 p = (vUv - 0.5) * 24.0;
  float r = length(p);
  float ang = atan(p.x, p.y) / 6.2831853 + 0.5;
  float ring = smoothstep(0.22, 0.0, abs(r - 10.0));
  float dash = step(0.5, fract(ang * 48.0 + uTime * 0.05));
  float inner = smoothstep(0.3, 0.0, abs(r - 9.2)) * step(ang, abs(uProgress));
  float disc = smoothstep(10.0, 9.0, r) * (0.05 + 0.03 * sin(r * 2.5 - uTime * 3.0));
  float pulse = uContest * smoothstep(0.5, 0.0, abs(r - mod(uTime * 6.0, 10.0))) * 0.6;
  vec3 col = uColor * (ring * (0.55 + 0.45 * dash) + disc) + uFill * inner * 1.6 + vec3(1.0, 0.8, 0.3) * pulse;
  float a = ring * 0.85 + inner + disc + pulse;
  gl_FragColor = vec4(col * 1.6, a);
}`;

/** Visual representation of one battle: terrain, scenery, units, structures and effects. */
export class BattleView {
  root = new THREE.Group();
  fx: Effects;
  selected = new Set<Unit>();
  selectedStruct: Structure | null = null;
  /** unit whose body is hidden (first-person host) */
  hidden: Unit | null = null;
  private units = new Map<Unit, UnitView>();
  private structs = new Map<Structure, StructView>();
  private projs = new Map<Projectile, THREE.Mesh>();
  private pods: Pod[] = [];
  private corpses: Corpse[] = [];
  private debris: THREE.InstancedMesh;
  private pointViews: Array<{ mat: THREE.ShaderMaterial; gem: THREE.Mesh; beam: THREE.Mesh; gemMat: THREE.MeshBasicMaterial }> = [];
  private time = 0;
  private tmpColor = new THREE.Color();
  private dummy = new THREE.Object3D();
  private disposables: Array<{ dispose(): void }> = [];

  constructor(private world: World, private hooks: ViewHooks) {
    this.fx = new Effects(world.height);
    this.buildTerrain();
    this.buildScenery();
    this.buildPoints();
    this.root.add(this.fx.group);

    const dm = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.2, flatShading: true });
    this.debris = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), dm, 170);
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.castShadow = true;
    this.debris.frustumCulled = false;
    this.debris.count = 0;
    this.debris.setColorAt(0, this.tmpColor.set(0xffffff));
    this.root.add(this.debris);
    this.disposables.push(this.debris.geometry, dm);

    for (const s of world.structures) this.addStruct(s);
    for (const u of world.units) this.addUnit(u, u.spawnDelay > 0 ? 'pod' : 'base');
    this.wire();
  }

  // ------------------------------------------------------------ construction

  private buildTerrain(): void {
    const w = this.world;
    const hw = MAP.halfW + 70, hh = MAP.halfH + 70, step = 2;
    const nx = (hw * 2) / step, nz = (hh * 2) / step;
    const g = new THREE.PlaneGeometry(hw * 2, hh * 2, nx, nz).rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color(), mud = new THREE.Color(0x5a5148), moss = new THREE.Color(0x4c6450), dust = new THREE.Color(0x8a7a64),
      plate = new THREE.Color(0x565d66), rock = new THREE.Color(0x66625f), snow = new THREE.Color(0xa5a8b8), road = new THREE.Color(0x6e6252);
    const roads: Array<[number, number, number, number]> = [];
    for (const b of BASES) for (const p of POINT_DEFS) roads.push([b.spawnX, 0, p.x, p.z]);
    const segDist = (x: number, z: number, s: [number, number, number, number]) => {
      const dx = s[2] - s[0], dz = s[3] - s[1];
      const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / (dx * dx + dz * dz)));
      return Math.hypot(x - s[0] - dx * t, z - s[1] - dz * t);
    };
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const y = w.height(x, z);
      pos.setY(i, y);
      c.copy(mud).lerp(moss, THREE.MathUtils.smoothstep(fbm(x * 0.025, z * 0.025, w.seed + 5), 0.42, 0.6));
      c.lerp(dust, THREE.MathUtils.smoothstep(fbm(x * 0.06, z * 0.06, w.seed + 9), 0.5, 0.75) * 0.7);
      let rd = 99;
      for (const s of roads) rd = Math.min(rd, segDist(x, z, s) + (fbm(x * 0.2, z * 0.2, 3) - 0.5) * 3);
      c.lerp(road, (1 - THREE.MathUtils.smoothstep(rd, 1.5, 4.5)) * 0.75);
      for (const b of BASES) c.lerp(plate, 1 - THREE.MathUtils.smoothstep(Math.hypot(x - b.x, z - b.z), 17, 24));
      for (const p of POINT_DEFS) c.lerp(plate, (1 - THREE.MathUtils.smoothstep(Math.hypot(x - p.x, z - p.z), 3, 6)) * 0.9);
      c.lerp(rock, THREE.MathUtils.smoothstep(y, 2.5, 9));
      c.lerp(snow, THREE.MathUtils.smoothstep(y, 26, 44));
      c.multiplyScalar(0.92 + y * 0.03);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.05, flatShading: true });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWPos;
          float th(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
          float tn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
            return mix(mix(th(i),th(i+vec2(1,0)),f.x), mix(th(i+vec2(0,1)),th(i+vec2(1,1)),f.x), f.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float tn1 = tn(vWPos.xz * 1.3) * 0.6 + tn(vWPos.xz * 4.7) * 0.4;
          float tn2 = tn(vWPos.xz * 0.11 + 13.0);
          diffuseColor.rgb *= 0.72 + 0.5 * tn1;`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          float wet = smoothstep(0.52, 0.7, tn2 + (tn1 - 0.5) * 0.25) * step(vWPos.y, 1.2);
          roughnessFactor = mix(roughnessFactor, 0.22, wet);
          diffuseColor.rgb *= 1.0 - wet * 0.35;`);
    };
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    this.root.add(mesh);
    this.disposables.push(g, mat);

    // alien scrub: cheap instanced tufts for ground detail
    const tg = new Geo();
    for (let i = 0; i < 4; i++) tg.raw(new THREE.ConeGeometry(0.07, 0.55 + i * 0.12, 3), 0xffffff, Math.cos(i * 1.7) * 0.14, 0.28, Math.sin(i * 1.7) * 0.14, Math.cos(i) * 0.3, 0, Math.sin(i) * 0.3);
    const tuftGeo = tg.build();
    const tuftMat = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true });
    const N = 2600;
    const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, N);
    const rng = w.seed;
    let k = 0;
    const d = this.dummy;
    for (let i = 0; i < N * 4 && k < N; i++) {
      const r1 = Math.abs(Math.sin(i * 12.9898 + rng) * 43758.5453) % 1, r2 = Math.abs(Math.sin(i * 78.233 + rng * 1.3) * 43758.5453) % 1;
      const x = (r1 * 2 - 1) * MAP.playW, z = (r2 * 2 - 1) * MAP.playH;
      if (fbm(x * 0.025, z * 0.025, w.seed + 5) < 0.47) continue;
      if (BASES.some((b) => Math.hypot(x - b.x, z - b.z) < 26) || !w.grid.walkable(x, z)) continue;
      d.position.set(x, w.height(x, z) - 0.03, z);
      d.rotation.set(0, r1 * 40, 0);
      d.scale.setScalar(0.7 + r2 * 1.3);
      d.updateMatrix();
      tufts.setMatrixAt(k, d.matrix);
      tufts.setColorAt(k, this.tmpColor.setHSL(0.36 + r1 * 0.14, 0.3, 0.14 + r2 * 0.1));
      k++;
    }
    tufts.count = k;
    tufts.receiveShadow = true;
    this.root.add(tufts);
    this.disposables.push(tuftGeo, tuftMat);

    // base pads
    BASES.forEach((b, team) => {
      const pg = new Geo();
      pg.cyl(15, 16, 0.5, 10, 0, -0.05, 0, team === 0 ? 0x353b42 : 0x241a1e);
      pg.cyl(9.5, 9.5, 0.56, 10, 0, -0.05, 0, team === 0 ? 0x2a2f35 : 0x1a1216);
      const gg = new Geo();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        gg.box(0.5, 0.08, 2.4, Math.sin(a) * 13, 0.24, Math.cos(a) * 13, 0xffffff, 0, a);
        pg.cyl(0.1, 0.14, 4.5, 5, Math.sin(a + 0.31) * 15.6, 2.2, Math.cos(a + 0.31) * 15.6, 0x1c2026);
        gg.box(0.2, 0.2, 0.2, Math.sin(a + 0.31) * 15.6, 4.55, Math.cos(a + 0.31) * 15.6, 0xffffff);
      }
      for (let i = 0; i < 7; i++) {
        const a = i * 2.4 + team, r = 10.5 + (i % 3) * 1.4;
        pg.box(1.1, 0.9 + (i % 2) * 0.5, 1.1, Math.sin(a) * r, 0.7, Math.cos(a) * r, i % 2 ? 0x55606b : 0x6e5a2e, 0, a * 3);
      }
      const y = w.height(b.x, b.z);
      const pad = new THREE.Mesh(pg.build(), MAT.solid);
      pad.position.set(b.x, y, b.z);
      pad.receiveShadow = true;
      pad.castShadow = true;
      const glow = new THREE.Mesh(gg.build(), MAT.glow[team]);
      glow.position.copy(pad.position);
      this.root.add(pad, glow);
      this.disposables.push(pad.geometry, glow.geometry);
    });
  }

  private buildScenery(): void {
    const sc = buildScenery(this.world.obstacles);
    const mesh = new THREE.Mesh(sc.solid, MAT.rough);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    this.disposables.push(sc.solid);
    if (sc.glow) {
      this.root.add(new THREE.Mesh(sc.glow, MAT.crystal));
      this.disposables.push(sc.glow);
    }
  }

  private buildPoints(): void {
    for (const p of this.world.points) {
      const y = this.world.height(p.x, p.z);
      const mat = new THREE.ShaderMaterial({
        vertexShader: pointVert, fragmentShader: pointFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uProgress: { value: 0 }, uTime: { value: 0 }, uContest: { value: 0 }, uColor: { value: new THREE.Color(COLORS.neutral) }, uFill: { value: new THREE.Color(COLORS.player) } },
      });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(24, 24).rotateX(-Math.PI / 2), mat);
      plane.position.set(p.x, y + 0.35, p.z);
      plane.renderOrder = 4;
      const pg = new Geo();
      pg.cyl(2.2, 2.6, 0.5, 6, 0, 0.25, 0, 0x30353b);
      pg.cyl(1.2, 1.6, 0.5, 6, 0, 0.7, 0, 0x4a535c);
      pg.cyl(0.25, 0.4, 3.2, 6, 0, 2.5, 0, 0x232a33);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        pg.box(0.2, 2.2, 0.6, Math.sin(a) * 1.3, 1.5, Math.cos(a) * 1.3, 0x566878, Math.cos(a) * -0.3, 0, Math.sin(a) * 0.3);
      }
      const base = new THREE.Mesh(pg.build(), MAT.solid);
      base.position.set(p.x, y, p.z);
      base.castShadow = true;
      const gemMat = new THREE.MeshBasicMaterial({ color: COLORS.neutral });
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.8), gemMat);
      gem.position.set(p.x, y + 5.2, p.z);
      gem.scale.y = 1.5;
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.22, 60, 6, 1, true),
        new THREE.MeshBasicMaterial({ color: COLORS.neutral, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      beam.position.set(p.x, y + 36, p.z);
      this.root.add(plane, base, gem, beam);
      this.pointViews.push({ mat, gem, beam, gemMat });
      this.disposables.push(plane.geometry, mat, base.geometry, gem.geometry, gemMat, beam.geometry, beam.material as THREE.Material);
    }
  }

  // ----------------------------------------------------------------- events

  private addUnit(u: Unit, via: string): void {
    const v = new UnitView(u);
    v.group.position.set(u.x, u.y, u.z);
    this.units.set(u, v);
    this.root.add(v.group);
    if (via === 'pod') {
      v.group.visible = false;
      const pg = podGeo();
      const mesh = new THREE.Group();
      const m = new THREE.Mesh(pg.main, MAT.solid);
      m.castShadow = true;
      mesh.add(m, new THREE.Mesh(pg.glow, MAT.glow[0]));
      const px = u.x - 2.2, pz = u.z + (u.id % 2 ? 1.8 : -1.8);
      this.root.add(mesh);
      this.pods.push({ mesh, unit: u, t: 0, land: u.spawnDelay, x: px, y: this.world.height(px, pz), z: pz, landed: false });
    } else if (via === 'warp') {
      v.group.visible = false;
    } else if (this.world.time > 1) this.fx.warp(u.x, u.y, u.z, u.team);
  }

  private addStruct(s: Structure): void {
    const v = new StructView(s);
    this.structs.set(s, v);
    this.root.add(v.group);
  }

  private wire(): void {
    const ev = this.world.events, fx = this.fx, w = this.world;
    ev.on('unitSpawn', ({ unit, via }) => this.addUnit(unit, via));
    ev.on('structAdd', ({ s }) => this.addStruct(s));
    ev.on('structDone', ({ s }) => {
      this.structs.get(s)?.finish();
      fx.ring(s.x, s.y + 0.2, s.z, 0.5, s.def.cells * 2.4 + 1, 0.5, COLORS.player, 0.8);
      fx.sparks(s.x, s.y + s.def.size[1], s.z, 14, COLORS.build, 4);
      this.hooks.sound('built', s.x, s.z);
    });
    ev.on('structDie', ({ s }) => {
      const v = this.structs.get(s);
      if (v) {
        this.root.remove(v.group);
        v.mat?.dispose();
        this.structs.delete(s);
      }
      if (this.selectedStruct === s) this.selectedStruct = null;
      const [sw, sh, sd] = s.def.size;
      const n = s.kind === 'hq' ? 46 : s.kind === 'bunker' ? 22 : s.kind === 'turret' ? 12 : 9;
      const base = s.team === 0 ? 0x6f7a84 : 0x3a2a30;
      for (let i = 0; i < n; i++) {
        const k = 0.12 + Math.random() * 0.22 * Math.min(2.2, sw / 2);
        const c = Math.cos(s.rot), sn = Math.sin(s.rot);
        const lx = (Math.random() - 0.5) * sw * s.len, lz = (Math.random() - 0.5) * sd;
        w.physics.spawnDebris(
          s.x + c * lx + sn * lz, s.y + 0.3 + Math.random() * sh * (s.kind === 'hq' ? 1.8 : 1), s.z - sn * lx + c * lz,
          k * (0.6 + Math.random()), k * (0.5 + Math.random() * 0.8), k * (0.6 + Math.random()),
          (Math.random() - 0.5) * 9, 3 + Math.random() * 8, (Math.random() - 0.5) * 9,
          7 + Math.random() * 6, this.tmpColor.set(base).multiplyScalar(0.6 + Math.random() * 0.6).getHex(),
        );
      }
      const big = s.kind === 'hq';
      fx.explosion(s.x, s.y + sh * 0.4, s.z, big ? 14 : s.def.cells * 2 + 2.5, 'struct');
      if (big) for (let i = 0; i < 5; i++) fx.explosion(s.x + (Math.random() - 0.5) * 8, s.y + 2 + Math.random() * 7, s.z + (Math.random() - 0.5) * 8, 6, 'struct');
      this.hooks.shake(big ? 1.4 : 0.35, s.x, s.z);
      this.hooks.sound(big ? 'bigboom' : 'collapse', s.x, s.z);
    });
    ev.on('structHit', ({ s }) => {
      if (Math.random() < 0.25) fx.sparks(s.x + (Math.random() - 0.5) * 1.5, s.y + Math.random() * s.def.size[1], s.z + (Math.random() - 0.5) * 1.5, 2, 0xffc070, 3);
    });
    ev.on('unitDie', ({ unit }) => {
      const v = this.units.get(unit);
      if (!v) return;
      this.units.delete(unit);
      v.group.remove(v.ring);
      this.selected.delete(unit);
      v.group.visible = true;
      if (unit.def.infantry) {
        fx.sparks(unit.x, unit.y + 1.2, unit.z, 10, unit.team === 0 ? COLORS.player : COLORS.enemy, 4);
        fx.dust(unit.x, unit.y, unit.z, 3, 2, 0.6);
        this.corpses.push({ obj: v.group, t: 0, life: 7, fall: true });
        this.hooks.sound('death', unit.x, unit.z);
      } else {
        v.group.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) m.material = m.material === MAT.solid ? burnt : m.material;
        });
        v.group.children[0].children.forEach((o) => {
          if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).material !== burnt) o.visible = false;
        });
        if (v.turret) {
          v.turret.rotation.set(0.3, v.turret.rotation.y + 0.7, 0.2);
          v.turret.position.y -= 0.15;
          v.turret.children[1].visible = false;
        }
        for (let i = 0; i < 12; i++) w.physics.spawnDebris(unit.x + (Math.random() - 0.5) * 3, unit.y + 1 + Math.random() * 1.5, unit.z + (Math.random() - 0.5) * 3,
          0.15 + Math.random() * 0.3, 0.1 + Math.random() * 0.2, 0.15 + Math.random() * 0.4, (Math.random() - 0.5) * 12, 5 + Math.random() * 9, (Math.random() - 0.5) * 12, 8, 0x22201d);
        this.corpses.push({ obj: v.group, t: 0, life: 28, fall: false });
      }
    });
    ev.on('shot', (s) => {
      const dx = s.tx - s.ox, dy = s.ty - s.oy, dz = s.tz - s.oz;
      const len = Math.hypot(dx, dy, dz) || 1;
      if (s.kind === 'cutter') {
        fx.sparks(s.tx, s.ty, s.tz, 6, 0xff7a3a, 5);
        fx.glowPuff(s.tx, s.ty, s.tz, 0xff5a2a, 1.6, 0.15);
        this.hooks.sound('cutter', s.ox, s.oz, 0.5);
      } else {
        const hiddenShooter = s.shooter === this.hidden;
        if (!hiddenShooter) fx.muzzle(s.ox, s.oy, s.oz, dx / len, dy / len, dz / len, s.kind === 'turret' ? 1.2 : 1);
        fx.tracer(s.ox, s.oy, s.oz, s.tx, s.ty, s.tz, s.team, hiddenShooter ? 0.035 : 0.07);
        fx.impact(s.tx, s.ty, s.tz, s.impact, s.team);
        this.hooks.sound(s.kind === 'turret' ? 'turret' : s.team === 0 ? 'rifle' : 'erifle', s.ox, s.oz);
      }
      if (s.shooter && s.shooter.isUnit) {
        const v = this.units.get(s.shooter);
        if (v) v.recoil = 1;
      }
    });
    ev.on('projSpawn', ({ p }) => {
      const g = p.kind === 'grenade' ? new THREE.IcosahedronGeometry(0.16, 0) : new THREE.BoxGeometry(0.16, 0.16, p.kind === 'shell' ? 1.6 : 0.9);
      const m = new THREE.Mesh(g, p.kind === 'grenade' ? MAT.glowBuild : new THREE.MeshBasicMaterial({ color: new THREE.Color(p.team === 0 ? 0xffd9a0 : 0xff8a6a).multiplyScalar(3) }));
      m.position.set(p.x, p.y, p.z);
      m.lookAt(p.x + p.vx, p.y + p.vy, p.z + p.vz);
      this.projs.set(p, m);
      this.root.add(m);
      if (p.kind !== 'grenade') {
        const l = Math.hypot(p.vx, p.vy, p.vz) || 1;
        if (p.owner !== this.hidden) fx.muzzle(p.x, p.y, p.z, p.vx / l, p.vy / l, p.vz / l, p.kind === 'shell' ? 3 : 2);
        this.hooks.sound(p.kind === 'shell' ? 'cannon' : 'rocket', p.x, p.z);
        if (p.owner && p.owner.isUnit) {
          const v = this.units.get(p.owner);
          if (v) v.recoil = 1.6;
        }
        if (p.kind === 'shell') this.hooks.shake(0.12, p.x, p.z);
      }
    });
    ev.on('explosion', (e) => {
      fx.explosion(e.x, e.y, e.z, e.radius, e.kind);
      this.hooks.shake(e.kind === 'orbital' ? 1.3 : e.kind === 'vehicle' ? 0.6 : 0.3 + e.radius * 0.03, e.x, e.z);
      this.hooks.sound(e.kind === 'orbital' ? 'bigboom' : 'explosion', e.x, e.z, e.radius / 5);
    });
    ev.on('orbital', ({ x, z, delay }) => {
      fx.strikeTelegraph(x, z, delay);
      this.hooks.sound('strike', x, z);
    });
    ev.on('pointChange', ({ point }) => {
      const color = point.owner === 0 ? COLORS.player : point.owner === 1 ? COLORS.enemy : COLORS.neutral;
      const y = w.height(point.x, point.z);
      fx.ring(point.x, y + 0.4, point.z, 1, 26, 1.1, color, 0.9);
      fx.beam(point.x, point.z, y, y + 90, 1.6, 1.0, color);
      fx.sparks(point.x, y + 5, point.z, 30, color, 9);
    });
  }

  // ------------------------------------------------------------------ frame

  update(dt: number, camera: THREE.Camera, pointScale: number): void {
    const w = this.world, fx = this.fx;
    this.time += dt;

    for (const [u, v] of this.units) {
      if (u.spawnDelay > 0) {
        if (v.group.visible) v.group.visible = false;
        continue;
      }
      if (!v.group.visible && u !== this.hidden) {
        v.group.visible = true;
        if (u.team === 1 || w.time > 6) {
          fx.warp(u.x, u.y, u.z, u.team);
          this.hooks.sound('warp', u.x, u.z, 0.6);
        }
      }
      v.group.visible = u !== this.hidden;
      v.group.position.set(u.x, u.y, u.z);
      v.group.rotation.y = u.yaw;
      const speed = Math.hypot(u.vx, u.vz);
      v.recoil = Math.max(0, v.recoil - dt * 7);
      if (u.def.infantry) {
        v.phase += dt * (speed > 0.4 ? speed * 2.1 : 0);
        const sw = speed > 0.4 ? Math.sin(v.phase) * 0.75 : 0;
        v.legs[0].rotation.x = sw;
        v.legs[1].rotation.x = -sw;
        v.inner.position.y = speed > 0.4 ? Math.abs(Math.cos(v.phase)) * 0.07 : 0;
        v.inner.rotation.x = speed > 0.4 ? 0.12 : 0;
        if (v.arms) {
          v.arms.rotation.y = angDiff(u.yaw, u.aimYaw);
          v.arms.rotation.x = -u.aimPitch - v.recoil * 0.12 + (u.building ? 0.35 : 0);
          v.arms.position.z = 0.05 - v.recoil * 0.07;
        }
      } else if (v.turret) {
        v.turret.rotation.y = angDiff(u.yaw, u.aimYaw);
        v.turret.position.z = -0.3 - v.recoil * 0.12;
        if (speed > 1 && Math.random() < dt * 14) fx.dust(u.x - Math.sin(u.yaw) * 2.6, u.y, u.z - Math.cos(u.yaw) * 2.6, 1, 1.5, 0.8);
        if (u.hp < u.maxHp * 0.45) {
          v.smokeT -= dt;
          if (v.smokeT <= 0) {
            v.smokeT = 0.12;
            fx.damageSmoke(u.x, u.y + 2, u.z, u.hp < u.maxHp * 0.25);
          }
        }
      }
      const sel = this.selected.has(u);
      v.ring.material = u.controlled ? ringCtl : sel ? ringSel : ringMats[u.team];
      if (u.building && Math.random() < dt * 30) {
        const s = u.building, k = Math.random();
        const hx = u.x + Math.sin(u.yaw) * 0.8, hz = u.z + Math.cos(u.yaw) * 0.8;
        const ty = s.y + Math.random() * s.def.size[1] * Math.max(0.2, s.progress);
        fx.glowPuff(hx + (s.x - hx) * k, u.y + 1.4 + (ty - u.y - 1.4) * k, hz + (s.z - hz) * k, COLORS.build, 0.35, 0.18);
        if (k > 0.7) fx.sparks(s.x + (Math.random() - 0.5) * s.def.size[0], ty, s.z + (Math.random() - 0.5) * s.def.size[2], 1, COLORS.build, 2);
      }
    }

    for (const [s, v] of this.structs) {
      if (v.clip) {
        if (s.done) v.finish();
        else v.clip.constant = s.y + s.def.size[1] * 1.9 * s.progress + 0.05 + (s.kind === 'hq' ? 8 : 0);
      }
      if (v.pop > 0) {
        v.pop = Math.max(0, v.pop - dt * 3);
        const k = 1 + Math.sin(v.pop * Math.PI) * 0.12;
        v.group.scale.set((s.kind === 'wall' || s.kind === 'barricade' ? s.len : 1) * k, k, k);
      }
      if (v.head) {
        if (s.kind === 'turret') v.head.rotation.y = s.aimYaw - s.rot;
        else v.head.rotation.y += dt * (s.team === 0 ? 0.9 : -0.5);
        if (s.kind === 'hq' && s.team === 1) v.head.position.y = 9.6 + Math.sin(this.time * 1.3) * 0.4;
      }
      if (s.done && s.hp < s.maxHp * 0.5) {
        v.smokeT -= dt;
        if (v.smokeT <= 0) {
          v.smokeT = s.kind === 'hq' ? 0.06 : 0.22;
          const r = s.def.cells * 0.8;
          fx.damageSmoke(s.x + (Math.random() - 0.5) * r, s.y + s.def.size[1] * (s.kind === 'hq' ? 1 + Math.random() : 0.9), s.z + (Math.random() - 0.5) * r, s.hp < s.maxHp * 0.25);
        }
      }
    }

    // projectiles
    for (const [p, m] of this.projs) {
      if (!p.alive) {
        this.root.remove(m);
        m.geometry.dispose();
        this.projs.delete(p);
        continue;
      }
      m.position.set(p.x, p.y, p.z);
      if (p.kind === 'rocket') fx.smokeTrail(p.x, p.y, p.z);
      else if (p.kind === 'shell') fx.glowPuff(p.x, p.y, p.z, 0xffb060, 0.9, 0.12);
      else if (Math.random() < 0.3) fx.glowPuff(p.x, p.y, p.z, COLORS.build, 0.5, 0.2);
    }

    // drop pods
    for (let i = this.pods.length - 1; i >= 0; i--) {
      const p = this.pods[i];
      p.t += dt;
      if (!p.landed) {
        const k = Math.max(0, p.land - p.t);
        const y = p.y + k * k * 22 + k * 60;
        p.mesh.position.set(p.x + k * 14, y, p.z);
        p.mesh.rotation.z = -0.22 * Math.min(1, k);
        fx.podTrail(p.x + k * 14, y, p.z);
        if (k <= 0) {
          p.landed = true;
          p.mesh.position.set(p.x, p.y - 0.4, p.z);
          p.mesh.rotation.z = 0.06 * (p.unit.id % 2 ? 1 : -1);
          fx.dust(p.x, p.y, p.z, 26, 9, 1.4);
          fx.ring(p.x, p.y + 0.2, p.z, 0.5, 9, 0.5, 0xffd2a0, 0.8);
          fx.sparks(p.x, p.y + 0.5, p.z, 24, 0xffb060, 9);
          fx.flash(p.x, p.y + 2, p.z, 0xffa050, 500, 0.35);
          fx.scorch(p.x, p.z, 6);
          this.hooks.shake(0.5, p.x, p.z);
          this.hooks.sound('podland', p.x, p.z);
        }
      } else if (p.t > p.land + 14) {
        p.mesh.position.y -= dt * 0.9;
        if (p.t > p.land + 18) {
          this.root.remove(p.mesh);
          this.pods.splice(i, 1);
        }
      }
    }

    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.t += dt;
      if (c.fall) {
        const k = Math.min(1, c.t / 0.45);
        c.obj.children[0].rotation.x = -k * k * 1.5;
        c.obj.children[0].position.y = k * 0.22;
      } else if (Math.random() < dt * 6 && c.t < c.life - 4) this.fx.damageSmoke(c.obj.position.x, c.obj.position.y + 1.8, c.obj.position.z, c.t < 9);
      if (c.t > c.life - 2) c.obj.position.y -= dt * (c.fall ? 0.4 : 1.4);
      if (c.t > c.life) {
        this.root.remove(c.obj);
        this.corpses.splice(i, 1);
      }
    }

    // physics debris
    const deb = w.physics.debris;
    const d = this.dummy;
    for (let i = 0; i < deb.length && i < 170; i++) {
      const b = deb[i];
      const t = b.body.translation(), r = b.body.rotation();
      d.position.set(t.x, t.y, t.z);
      d.quaternion.set(r.x, r.y, r.z, r.w);
      const fade = Math.min(1, b.life);
      d.scale.set(b.hx * 2 * fade, b.hy * 2 * fade, b.hz * 2 * fade);
      d.updateMatrix();
      this.debris.setMatrixAt(i, d.matrix);
      this.debris.setColorAt(i, this.tmpColor.set(b.color));
    }
    this.debris.count = Math.min(deb.length, 170);
    this.debris.instanceMatrix.needsUpdate = true;
    if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;

    // capture points
    w.points.forEach((p, i) => {
      const v = this.pointViews[i];
      const col = p.owner === 0 ? COLORS.player : p.owner === 1 ? COLORS.enemy : COLORS.neutral;
      v.mat.uniforms.uTime.value = this.time;
      v.mat.uniforms.uProgress.value = p.progress;
      v.mat.uniforms.uContest.value = p.contested ? 1 : 0;
      (v.mat.uniforms.uColor.value as THREE.Color).set(col);
      (v.mat.uniforms.uFill.value as THREE.Color).set(p.progress >= 0 ? COLORS.player : COLORS.enemy);
      v.gemMat.color.set(col).multiplyScalar(2.2);
      (v.beam.material as THREE.MeshBasicMaterial).color.set(col);
      v.gem.rotation.y += dt * 1.2;
      v.gem.position.y = w.height(p.x, p.z) + 5.2 + Math.sin(this.time * 2 + i) * 0.25;
    });

    fx.update(dt, pointScale);
    void camera;
  }

  unitScreenAnchor(u: Unit, out: THREE.Vector3): THREE.Vector3 {
    return out.set(u.x, u.y + (u.def.infantry ? 2.55 : 3.6), u.z);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.fx.dispose();
    for (const d of this.disposables) d.dispose();
    for (const v of this.structs.values()) v.mat?.dispose();
  }
}

export const teamColor = (t: Team | -1) => (t === PLAYER ? COLORS.player : t === 1 ? COLORS.enemy : COLORS.neutral);
