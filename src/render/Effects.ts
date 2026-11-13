import * as THREE from 'three';
import { COLORS } from '../core/config';

const pVert = /* glsl */ `
uniform float uScale;
attribute vec4 aColor; attribute float aSize;
varying vec4 vColor;
void main(){
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aSize * uScale / max(-mv.z, 0.1), 900.0);
}`;
const pFrag = /* glsl */ `
varying vec4 vColor;
uniform float uSoft;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, uSoft, d);
  if (a * vColor.a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
}`;

/** CPU-simulated point-sprite particle pool. */
class ParticleLayer {
  points: THREE.Points;
  private n = 0;
  private pos: Float32Array; private col: Float32Array; private size: Float32Array;
  private vel: Float32Array; private life: Float32Array; private max: Float32Array;
  private s0: Float32Array; private s1: Float32Array; private a0: Float32Array;
  private grav: Float32Array; private drag: Float32Array;
  private mat: THREE.ShaderMaterial;

  constructor(private cap: number, additive: boolean) {
    this.pos = new Float32Array(cap * 3); this.col = new Float32Array(cap * 4); this.size = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3); this.life = new Float32Array(cap); this.max = new Float32Array(cap);
    this.s0 = new Float32Array(cap); this.s1 = new Float32Array(cap); this.a0 = new Float32Array(cap);
    this.grav = new Float32Array(cap); this.drag = new Float32Array(cap);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: pVert, fragmentShader: pFrag, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uScale: { value: 600 }, uSoft: { value: additive ? 0.0 : 0.12 } },
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 12 : 11;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number,
    r: number, g: number, b: number, a: number, grav = 0, drag = 0): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.max[i] = life; this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
    this.grav[i] = grav; this.drag[i] = drag;
    this.size[i] = s0;
  }

  update(dt: number, scale: number): void {
    const { pos, vel, life, max, col, size } = this;
    for (let i = 0; i < this.n; i++) {
      life[i] -= dt;
      if (life[i] <= 0) {
        const l = --this.n;
        if (i !== l) {
          for (let k = 0; k < 3; k++) { pos[i * 3 + k] = pos[l * 3 + k]; vel[i * 3 + k] = vel[l * 3 + k]; }
          for (let k = 0; k < 4; k++) col[i * 4 + k] = col[l * 4 + k];
          life[i] = life[l]; max[i] = max[l]; this.s0[i] = this.s0[l]; this.s1[i] = this.s1[l];
          this.a0[i] = this.a0[l]; this.grav[i] = this.grav[l]; this.drag[i] = this.drag[l];
          i--;
        }
        continue;
      }
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      vel[i * 3] *= dr; vel[i * 3 + 2] *= dr;
      vel[i * 3 + 1] = vel[i * 3 + 1] * dr - this.grav[i] * dt;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      const t = 1 - life[i] / max[i];
      size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      col[i * 4 + 3] = this.a0[i] * Math.min(1, t * 12) * (1 - t) * (1 - t * t);
    }
    const g = this.points.geometry;
    g.setDrawRange(0, this.n);
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    this.mat.uniforms.uScale.value = scale;
  }
}

interface Tracer { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; len: number; t: number; speed: number; team: number; w: number }
interface Ring { mesh: THREE.Mesh; t: number; life: number; r0: number; r1: number }
interface Beam { mesh: THREE.Mesh; t: number; life: number; w: number }
interface Flash { light: THREE.PointLight; t: number; life: number; power: number }

const R = () => Math.random();
const RS = () => Math.random() * 2 - 1;

/** Every transient visual: particles, tracers, shockwaves, scorch marks, light flashes, beams. */
export class Effects {
  group = new THREE.Group();
  private add: ParticleLayer;
  private smoke: ParticleLayer;
  private tracers: Tracer[] = [];
  private tracerMesh: THREE.InstancedMesh;
  private rings: Ring[] = [];
  private beams: Beam[] = [];
  private flashes: Flash[] = [];
  private decals: THREE.Mesh[] = [];
  private decalIdx = 0;
  private dummy = new THREE.Object3D();
  private ringGeo = new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2);
  private discTex: THREE.Texture;
  private tcol = [new THREE.Color(COLORS.player).multiplyScalar(2.2), new THREE.Color(0xff6a4a).multiplyScalar(2.4)];

  constructor(private height: (x: number, z: number) => number) {
    this.add = new ParticleLayer(5000, true);
    this.smoke = new ParticleLayer(2600, false);
    this.group.add(this.smoke.points, this.add.points);

    const tg = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
    this.tracerMesh = new THREE.InstancedMesh(tg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), 300);
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.count = 0;
    this.tracerMesh.setColorAt(0, this.tcol[0]);
    this.group.add(this.tracerMesh);

    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const cx = cv.getContext('2d')!;
    const gr = cx.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, 'rgba(0,0,0,0.92)');
    gr.addColorStop(0.45, 'rgba(8,6,5,0.7)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = gr;
    cx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 40; i++) {
      cx.fillStyle = `rgba(0,0,0,${0.15 + R() * 0.2})`;
      const a = R() * 6.28, d = 20 + R() * 34;
      cx.beginPath();
      cx.arc(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 2 + R() * 6, 0, 6.28);
      cx.fill();
    }
    this.discTex = new THREE.CanvasTexture(cv);
    const dg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    for (let i = 0; i < 48; i++) {
      const m = new THREE.Mesh(dg, new THREE.MeshBasicMaterial({ map: this.discTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, opacity: 0.9 }));
      m.visible = false;
      m.renderOrder = 2;
      this.decals.push(m);
      this.group.add(m);
    }
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xffaa66, 0, 60, 1.6);
      this.flashes.push({ light, t: 1, life: 1, power: 0 });
      this.group.add(light);
    }
  }

  // ---- primitives

  tracer(ox: number, oy: number, oz: number, tx: number, ty: number, tz: number, team: number, w = 0.07): void {
    if (this.tracers.length >= 300) return;
    const dx = tx - ox, dy = ty - oy, dz = tz - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.5) return;
    this.tracers.push({ ox, oy, oz, dx: dx / len, dy: dy / len, dz: dz / len, len, t: 0, speed: 260, team, w });
  }

  ring(x: number, y: number, z: number, r0: number, r1: number, life: number, color: number, opacity = 0.8): void {
    const mesh = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.6), transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    mesh.position.set(x, y, z);
    mesh.userData.op = opacity;
    this.group.add(mesh);
    this.rings.push({ mesh, t: 0, life, r0, r1 });
  }

  beam(x: number, z: number, y0: number, y1: number, w: number, life: number, color: number): void {
    const g = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.5), transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    mesh.position.set(x, (y0 + y1) / 2, z);
    mesh.scale.set(w, y1 - y0, w);
    this.group.add(mesh);
    this.beams.push({ mesh, t: 0, life, w });
  }

  flash(x: number, y: number, z: number, color: number, power: number, life: number): void {
    let best = this.flashes[0];
    for (const f of this.flashes) if (f.t / f.life > best.t / best.life) best = f;
    best.light.position.set(x, y, z);
    best.light.color.set(color);
    best.t = 0;
    best.life = life;
    best.power = power;
  }

  scorch(x: number, z: number, size: number): void {
    const m = this.decals[this.decalIdx++ % this.decals.length];
    m.visible = true;
    m.position.set(x, this.height(x, z) + 0.06, z);
    m.scale.set(size, 1, size);
    m.rotation.y = R() * 6.28;
  }

  // ---- composed effects

  muzzle(x: number, y: number, z: number, dx: number, dy: number, dz: number, big = 1): void {
    this.add.spawn(x, y, z, dx * 2, dy * 2, dz * 2, 0.06, 1.1 * big, 0.5 * big, 1.0, 0.75, 0.35, 1);
    for (let i = 0; i < 3; i++) this.add.spawn(x, y, z, dx * (8 + R() * 14) + RS() * 2, dy * 10 + RS() * 2, dz * (8 + R() * 14) + RS() * 2, 0.08 + R() * 0.06, 0.3 * big, 0.05, 1, 0.8, 0.4, 0.9);
    if (big > 1.5) for (let i = 0; i < 8; i++) this.smoke.spawn(x, y, z, dx * (2 + R() * 8) + RS(), 0.5 + R(), dz * (2 + R() * 8) + RS(), 0.8 + R() * 0.6, 0.6, 2.4, 0.5, 0.48, 0.45, 0.35, -0.4, 2);
  }

  impact(x: number, y: number, z: number, kind: 'unit' | 'cover' | 'struct' | 'miss', team: number): void {
    if (kind === 'unit') {
      const c = team === 0 ? [1, 0.25, 0.2] : [0.3, 0.9, 1];
      for (let i = 0; i < 4; i++) this.add.spawn(x, y, z, RS() * 3, R() * 3, RS() * 3, 0.18 + R() * 0.12, 0.16, 0.04, c[0], c[1], c[2], 1, 9);
      return;
    }
    for (let i = 0; i < 5; i++) this.add.spawn(x, y, z, RS() * 5, 1 + R() * 5, RS() * 5, 0.2 + R() * 0.2, 0.12, 0.03, 1, 0.8, 0.45, 1, 14);
    if (R() < 0.6) this.smoke.spawn(x, y, z, RS() * 0.6, 0.6 + R(), RS() * 0.6, 0.6 + R() * 0.5, 0.3, 1.3, 0.42, 0.4, 0.37, 0.35, -0.3, 1.5);
  }

  dust(x: number, y: number, z: number, n: number, spread: number, size = 1): void {
    for (let i = 0; i < n; i++) {
      const a = R() * 6.28, s = spread * (0.4 + R() * 0.6);
      this.smoke.spawn(x, y + 0.2, z, Math.cos(a) * s, 0.4 + R() * 1.8, Math.sin(a) * s, 1 + R() * 1.4, 0.8 * size, 3.6 * size, 0.36, 0.33, 0.3, 0.32, -0.2, 1.7);
    }
  }

  explosion(x: number, y: number, z: number, radius: number, kind: string): void {
    const s = radius / 5;
    const orbital = kind === 'orbital';
    const hot = orbital ? [0.55, 0.9, 1.0] : [1.0, 0.62, 0.22];
    this.add.spawn(x, y + 0.5, z, 0, 0, 0, 0.14, 9 * s, 14 * s, 1, 0.95, 0.8, 1);
    for (let i = 0; i < 26 * s + 8; i++) {
      const a = R() * 6.28, e = R() * 1.4, v = (5 + R() * 13) * s;
      this.add.spawn(x, y + 0.3, z, Math.cos(a) * Math.cos(e) * v, Math.sin(e) * v + 2, Math.sin(a) * Math.cos(e) * v, 0.35 + R() * 0.45, (1.8 + R() * 1.6) * s, 0.3, hot[0], hot[1] * (0.6 + R() * 0.4), hot[2], 0.9, 3, 2.5);
    }
    for (let i = 0; i < 22; i++) {
      const a = R() * 6.28, v = 6 + R() * 16 * s;
      this.add.spawn(x, y + 0.4, z, Math.cos(a) * v, 4 + R() * 14 * s, Math.sin(a) * v, 0.5 + R() * 0.9, 0.2, 0.05, 1, 0.75, 0.35, 1, 22, 0.4);
    }
    for (let i = 0; i < 16 * s + 6; i++) {
      const a = R() * 6.28, v = R() * 4 * s;
      const g = 0.16 + R() * 0.14;
      this.smoke.spawn(x + RS() * s, y + 0.6 + R() * s, z + RS() * s, Math.cos(a) * v, 1.5 + R() * 4.5 * s, Math.sin(a) * v, 2.2 + R() * 2.2, 1.6 * s, 6.5 * s, g, g, g * 1.05, 0.55, -0.5, 1.1);
    }
    this.dust(x, y, z, 10, 7 * s, 1.2 * s);
    this.ring(x, this.height(x, z) + 0.25, z, 0.5, radius * 1.5, 0.45, orbital ? 0x7fe8ff : 0xffc890, 0.7);
    this.flash(x, y + 2.5, z, orbital ? 0x8fe6ff : 0xffa050, 900 * s * s, 0.45);
    this.scorch(x, z, radius * 1.5);
    if (orbital) {
      this.beam(x, z, y - 2, y + 320, 5.5, 0.7, 0x8fe6ff);
      this.ring(x, this.height(x, z) + 0.3, z, 1, radius * 2.6, 0.9, 0x8fe6ff, 0.6);
    }
  }

  smokeTrail(x: number, y: number, z: number, hot = true): void {
    if (hot) this.add.spawn(x, y, z, RS(), RS(), RS(), 0.12, 0.7, 0.2, 1, 0.6, 0.25, 0.9);
    this.smoke.spawn(x, y, z, RS() * 0.5, 0.3 + R() * 0.5, RS() * 0.5, 0.7 + R() * 0.5, 0.35, 1.5, 0.55, 0.53, 0.5, 0.3, -0.2, 1);
  }

  damageSmoke(x: number, y: number, z: number, fire: boolean): void {
    const g = 0.1 + R() * 0.08;
    this.smoke.spawn(x + RS() * 0.4, y, z + RS() * 0.4, 0.8 + RS() * 0.4, 1.6 + R() * 1.2, RS() * 0.4, 1.8 + R(), 0.6, 2.6, g, g, g, 0.5, -0.3, 0.4);
    if (fire) this.add.spawn(x + RS() * 0.4, y - 0.2, z + RS() * 0.4, RS() * 0.4, 1.5 + R() * 1.5, RS() * 0.4, 0.3 + R() * 0.3, 0.9, 0.15, 1, 0.5, 0.15, 0.8);
  }

  sparks(x: number, y: number, z: number, n: number, color: number, speed = 4): void {
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) this.add.spawn(x, y, z, RS() * speed, R() * speed * 1.2, RS() * speed, 0.25 + R() * 0.4, 0.14, 0.03, c.r * 1.6, c.g * 1.6, c.b * 1.6, 1, 10);
  }

  glowPuff(x: number, y: number, z: number, color: number, size: number, life = 0.4): void {
    const c = new THREE.Color(color);
    this.add.spawn(x, y, z, 0, 0.5, 0, life, size, size * 0.3, c.r, c.g, c.b, 0.8);
  }

  warp(x: number, y: number, z: number, team: number): void {
    const color = team === 0 ? COLORS.player : COLORS.enemy;
    this.beam(x, z, y, y + 26, 0.55, 0.55, color);
    this.ring(x, y + 0.15, z, 0.3, 3, 0.5, color, 0.8);
    this.sparks(x, y + 1, z, 12, color, 5);
  }

  marker(x: number, z: number, color: number): void {
    const y = this.height(x, z) + 0.2;
    this.ring(x, y, z, 2.6, 0.5, 0.45, color, 0.9);
    this.ring(x, y, z, 0.4, 1.2, 0.6, color, 0.6);
  }

  podTrail(x: number, y: number, z: number): void {
    for (let i = 0; i < 2; i++) {
      this.add.spawn(x + RS() * 0.4, y + 3 + R() * 2, z + RS() * 0.4, RS(), 4 + R() * 6, RS(), 0.25 + R() * 0.2, 2.4, 0.4, 1, 0.55, 0.2, 0.9);
      this.smoke.spawn(x + RS() * 0.5, y + 4, z + RS() * 0.5, RS(), 2, RS(), 1.2 + R(), 1.2, 4, 0.5, 0.48, 0.47, 0.3, 0, 0.6);
    }
  }

  strikeTelegraph(x: number, z: number, delay: number): void {
    const y = this.height(x, z);
    this.beam(x, z, y, y + 300, 0.16, delay, 0xff5a5a);
    this.ring(x, y + 0.3, z, 11, 1, delay, 0xff6a5a, 0.9);
    this.ring(x, y + 0.3, z, 11, 11.01, delay, 0xff6a5a, 0.5);
  }

  update(dt: number, scale: number): void {
    this.add.update(dt, scale);
    this.smoke.update(dt, scale);

    let n = 0;
    const d = this.dummy;
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.t += dt;
      const head = t.t * t.speed;
      const seg = Math.min(9, t.len);
      if (head - seg > t.len) {
        this.tracers.splice(i, 1);
        continue;
      }
      const a = Math.max(0, head - seg), b = Math.min(t.len, head);
      d.position.set(t.ox + t.dx * a, t.oy + t.dy * a, t.oz + t.dz * a);
      d.lookAt(t.ox + t.dx * (a + 1), t.oy + t.dy * (a + 1), t.oz + t.dz * (a + 1));
      d.scale.set(t.w, t.w, Math.max(0.01, b - a));
      d.updateMatrix();
      this.tracerMesh.setMatrixAt(n, d.matrix);
      this.tracerMesh.setColorAt(n, this.tcol[t.team]);
      n++;
    }
    this.tracerMesh.count = n;
    this.tracerMesh.instanceMatrix.needsUpdate = true;
    if (this.tracerMesh.instanceColor) this.tracerMesh.instanceColor.needsUpdate = true;

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const k = Math.min(1, r.t / r.life);
      const e = 1 - (1 - k) * (1 - k);
      const s = r.r0 + (r.r1 - r.r0) * (r.r1 > r.r0 ? e : k);
      r.mesh.scale.set(s, 1, s);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = r.mesh.userData.op * (r.r1 > r.r0 ? 1 - k : 0.4 + 0.6 * k);
      if (k >= 1) {
        this.group.remove(r.mesh);
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
      }
    }
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.t += dt;
      const k = Math.min(1, b.t / b.life);
      const w = b.w * (b.life > 1.5 ? 0.6 + Math.sin(b.t * 30) * 0.4 : 1 - k * k);
      b.mesh.scale.x = b.mesh.scale.z = Math.max(0.01, w);
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = b.life > 1.5 ? 0.8 : 0.9 * (1 - k);
      if (k >= 1) {
        this.group.remove(b.mesh);
        b.mesh.geometry.dispose();
        (b.mesh.material as THREE.Material).dispose();
        this.beams.splice(i, 1);
      }
    }
    for (const f of this.flashes) {
      f.t += dt;
      const k = Math.min(1, f.t / f.life);
      f.light.intensity = f.power * (1 - k) * (1 - k);
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    });
    this.discTex.dispose();
  }
}
