import RAPIER from '@dimforge/rapier3d-compat';
import type { HeightFn } from '../sim/terrain';

const G_STATIC = 0x0001;
const G_DEBRIS = 0x0002;
const G_CHAR = 0x0004;
const groups = (member: number, filter: number) => ((member << 16) | filter) >>> 0;
const STATIC_GROUPS = groups(G_STATIC, G_STATIC | G_DEBRIS | G_CHAR);
const DEBRIS_GROUPS = groups(G_DEBRIS, G_STATIC | G_DEBRIS);
const CHAR_GROUPS = groups(G_CHAR, G_STATIC);
const RAY_GROUPS = groups(0xffff, G_STATIC);

export interface RayHit {
  t: number;
  handle: number;
}

export interface Debris {
  body: RAPIER.RigidBody;
  hx: number;
  hy: number;
  hz: number;
  life: number;
  color: number;
}

export interface Character {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  halfH: number;
  radius: number;
  x: number;
  y: number;
  z: number;
  grounded: boolean;
}

let rapierReady: Promise<void> | null = null;

/**
 * Thin wrapper around Rapier. Rapier owns: static world collision (terrain,
 * rocks, structures), line-of-sight raycasts, the direct-control character
 * controller, grenades and destruction debris.
 */
export class Physics {
  world: RAPIER.World;
  debris: Debris[] = [];
  terrainHandle = -1;
  private cc: RAPIER.KinematicCharacterController;
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  private statics = new Map<number, RAPIER.RigidBody>();

  static async create(): Promise<Physics> {
    if (!rapierReady) rapierReady = RAPIER.init();
    await rapierReady;
    return new Physics();
  }

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -18, z: 0 });
    this.cc = this.world.createCharacterController(0.06);
    this.cc.setUp({ x: 0, y: 1, z: 0 });
    this.cc.enableAutostep(0.45, 0.2, false);
    this.cc.enableSnapToGround(0.4);
    this.cc.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.cc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
  }

  buildTerrain(height: HeightFn, halfW: number, halfH: number, step = 4): void {
    const nx = Math.round((halfW * 2) / step) + 1, nz = Math.round((halfH * 2) / step) + 1;
    const verts = new Float32Array(nx * nz * 3);
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const x = -halfW + i * step, z = -halfH + j * step;
        const k = (j * nx + i) * 3;
        verts[k] = x;
        verts[k + 1] = height(x, z);
        verts[k + 2] = z;
      }
    let q = 0;
    for (let j = 0; j < nz - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx[q++] = a; idx[q++] = c; idx[q++] = b;
        idx[q++] = b; idx[q++] = c; idx[q++] = d;
      }
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const col = this.world.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx).setCollisionGroups(STATIC_GROUPS), body);
    this.terrainHandle = col.handle;
  }

  addBox(x: number, y: number, z: number, hx: number, hy: number, hz: number, rotY = 0): number {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(x, y, z)
        .setRotation({ x: 0, y: Math.sin(rotY / 2), z: 0, w: Math.cos(rotY / 2) }),
    );
    const col = this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setCollisionGroups(STATIC_GROUPS), body);
    this.statics.set(col.handle, body);
    return col.handle;
  }

  addCylinder(x: number, y: number, z: number, halfH: number, r: number): number {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    const col = this.world.createCollider(RAPIER.ColliderDesc.cylinder(halfH, r).setCollisionGroups(STATIC_GROUPS), body);
    this.statics.set(col.handle, body);
    return col.handle;
  }

  removeStatic(handle: number): void {
    const body = this.statics.get(handle);
    if (body) {
      this.world.removeRigidBody(body);
      this.statics.delete(handle);
    }
  }

  /** Raycast against the static world. Direction does not need to be normalised. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): RayHit | null {
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return null;
    this.ray.origin.x = ox; this.ray.origin.y = oy; this.ray.origin.z = oz;
    this.ray.dir.x = dx / len; this.ray.dir.y = dy / len; this.ray.dir.z = dz / len;
    const hit = this.world.castRay(this.ray, max, true, undefined, RAY_GROUPS);
    return hit ? { t: hit.timeOfImpact, handle: hit.collider.handle } : null;
  }

  /** First static hit between two points, or null if the segment is clear. */
  segment(ax: number, ay: number, az: number, bx: number, by: number, bz: number): RayHit | null {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    return this.raycast(ax, ay, az, dx, dy, dz, Math.hypot(dx, dy, dz));
  }

  createCharacter(x: number, y: number, z: number, radius: number, height: number): Character {
    const halfH = Math.max(0.05, height / 2 - radius);
    const cy = y + halfH + radius + 0.08;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, cy, z));
    const collider = this.world.createCollider(RAPIER.ColliderDesc.capsule(halfH, radius).setCollisionGroups(CHAR_GROUPS), body);
    return { body, collider, halfH, radius, x, y, z, grounded: true };
  }

  /** Move a character by a desired delta; returns resolved feet position on the character. */
  moveCharacter(c: Character, dx: number, dy: number, dz: number): void {
    this.cc.computeColliderMovement(c.collider, { x: dx, y: dy, z: dz }, undefined, CHAR_GROUPS);
    const m = this.cc.computedMovement();
    const p = c.body.translation();
    const nx = p.x + m.x, ny = p.y + m.y, nz = p.z + m.z;
    c.body.setTranslation({ x: nx, y: ny, z: nz }, true);
    c.grounded = this.cc.computedGrounded();
    c.x = nx;
    c.y = ny - c.halfH - c.radius;
    c.z = nz;
  }

  removeCharacter(c: Character): void {
    this.world.removeRigidBody(c.body);
  }

  spawnDebris(x: number, y: number, z: number, hx: number, hy: number, hz: number, vx: number, vy: number, vz: number, life: number, color: number): void {
    if (this.debris.length >= 160) {
      const old = this.debris.shift()!;
      this.world.removeRigidBody(old.body);
    }
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setLinvel(vx, vy, vz)
        .setAngvel({ x: (Math.random() - 0.5) * 12, y: (Math.random() - 0.5) * 12, z: (Math.random() - 0.5) * 12 })
        .setLinearDamping(0.15)
        .setAngularDamping(0.6),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setCollisionGroups(DEBRIS_GROUPS).setRestitution(0.25).setFriction(0.9).setDensity(2),
      body,
    );
    this.debris.push({ body, hx, hy, hz, life, color });
  }

  spawnBall(x: number, y: number, z: number, r: number, vx: number, vy: number, vz: number): RAPIER.RigidBody {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setLinvel(vx, vy, vz).setLinearDamping(0.1).setAngularDamping(1.5).setCcdEnabled(true),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(r).setCollisionGroups(DEBRIS_GROUPS).setRestitution(0.35).setFriction(1.2).setDensity(3),
      body,
    );
    return body;
  }

  removeBody(body: RAPIER.RigidBody): void {
    this.world.removeRigidBody(body);
  }

  step(dt: number): void {
    if (dt <= 0) return;
    this.world.timestep = Math.min(dt, 1 / 30);
    this.world.step();
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      if (d.life <= 0 || d.body.translation().y < -30) {
        this.world.removeRigidBody(d.body);
        this.debris.splice(i, 1);
      }
    }
  }

  dispose(): void {
    this.world.free();
  }
}
