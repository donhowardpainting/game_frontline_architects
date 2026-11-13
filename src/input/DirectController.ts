import * as THREE from 'three';
import { BUILDABLE, COLORS, MAP, PLAYER, STRUCT_DEFS, type StructKind, type UnitKind } from '../core/config';
import type { Game } from '../core/Game';
import { angDiff, clamp, damp, turnToward } from '../core/math';
import type { Character } from '../physics/Physics';
import { MAT, structParts, viewModel } from '../render/models';
import type { Structure, Unit } from '../sim/entities';
import type { Pose } from './CommanderController';

interface Weapon {
  name: string;
  dmg: number;
  cd: number;
  mag: number;
  reload: number;
  spread: number;
  range: number;
  struct: number;
  projectile?: 'rocket' | 'shell';
  radius?: number;
  speed?: number;
  kick: number;
}

const WEAPONS: Partial<Record<UnitKind, Weapon>> = {
  rifle: { name: 'VX-9 Pulse Rifle', dmg: 16, cd: 0.1, mag: 32, reload: 1.5, spread: 0.011, range: 110, struct: 0.35, kick: 0.012 },
  engineer: { name: 'Arc Sidearm', dmg: 22, cd: 0.2, mag: 14, reload: 1.2, spread: 0.009, range: 70, struct: 0.35, kick: 0.016 },
  heavy: { name: 'Lance Launcher', dmg: 120, cd: 0.9, mag: 3, reload: 2.4, spread: 0.004, range: 150, struct: 1.7, projectile: 'rocket', radius: 5.2, speed: 75, kick: 0.05 },
  tank: { name: '120mm Railcannon', dmg: 160, cd: 1.5, mag: 999, reload: 0, spread: 0.002, range: 200, struct: 1.6, projectile: 'shell', radius: 6.2, speed: 130, kick: 0.03 },
};

const ghostOk = new THREE.MeshBasicMaterial({ color: 0x59ffb0, transparent: true, opacity: 0.4, depthWrite: false });
const ghostBad = new THREE.MeshBasicMaterial({ color: 0xff4455, transparent: true, opacity: 0.4, depthWrite: false });

/**
 * Direct Control: the player inhabits one unit. Movement goes through the
 * Rapier character controller so walls, rocks and built cover are solid.
 */
export class DirectController {
  pose: Pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 72 };
  unit: Unit | null = null;
  weapon: Weapon = WEAPONS.rifle!;
  ammo = 0;
  reloadT = 0;
  grenadeCd = 0;
  third = false;
  buildKind: StructKind | null = null;
  linkTarget: Unit | null = null;
  workTarget: Structure | null = null;
  presence = 0;
  hitT = 0;
  hitKill = false;
  ads = 0;
  private char: Character | null = null;
  private yaw = 0;
  private pitch = 0;
  private hullYaw = 0;
  private vx = 0;
  private vy = 0;
  private vz = 0;
  private throttle = 0;
  private fireCd = 0;
  private mgCd = 0;
  private recoil = 0;
  private kick = 0;
  private bob = 0;
  private sway = new THREE.Vector2();
  private vm = new THREE.Group();
  private vmMesh: THREE.Mesh | null = null;
  private vmGlow: THREE.Mesh | null = null;
  private flash: THREE.Mesh;
  private ghost: THREE.Mesh;
  private ghostValid = false;
  private ghostPos = new THREE.Vector3();
  private ghostRot = 0;
  private ghostLen = 1;
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private ammoStore = new Map<number, number>();

  constructor(private game: Game) {
    const fc = document.createElement('canvas');
    fc.width = fc.height = 64;
    const fx = fc.getContext('2d')!;
    const gr = fx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.25, 'rgba(255,200,120,.8)');
    gr.addColorStop(1, 'rgba(255,120,30,0)');
    fx.fillStyle = gr;
    fx.beginPath();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2, r = i % 2 ? 12 : 32;
      fx.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
    }
    fx.fill();
    this.flash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.3),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(fc), color: new THREE.Color(1.0, 0.8, 0.5).multiplyScalar(2.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }),
    );
    this.flash.visible = false;
    this.vm.add(this.flash);
    this.vm.visible = false;
    this.vm.scale.setScalar(0.85);
    game.engine.camera.add(this.vm);
    this.ghost = new THREE.Mesh(undefined, ghostOk);
    this.ghost.visible = false;
    this.ghost.renderOrder = 6;
  }

  get isVehicle(): boolean {
    return !!this.unit && !this.unit.def.infantry;
  }
  get firstPerson(): boolean {
    return !!this.unit && this.unit.def.infantry && !this.third;
  }

  attach(u: Unit): void {
    const g = this.game, w = g.world;
    this.detach(false);
    this.unit = u;
    u.controlled = true;
    w.controlled = u;
    u.path = [];
    u.goal = null;
    u.order = { type: 'idle' };
    u.toCover = false;
    u.building = null;
    this.yaw = u.def.infantry ? u.yaw : u.aimYaw;
    this.hullYaw = u.yaw;
    this.pitch = 0;
    this.vx = this.vy = this.vz = this.throttle = 0;
    this.weapon = WEAPONS[u.kind] ?? WEAPONS.rifle!;
    this.ammo = this.ammoStore.get(u.id) ?? this.weapon.mag;
    this.reloadT = 0;
    this.fireCd = 0.25;
    this.buildKind = null;
    this.third = false;
    this.char = w.physics.createCharacter(u.x, u.y, u.z, u.def.infantry ? 0.42 : 1.7, u.def.infantry ? 1.8 : 3.4);
    if (this.vmMesh) this.vm.remove(this.vmMesh, this.vmGlow!);
    const vm = viewModel(u.kind);
    this.vmMesh = new THREE.Mesh(vm.main, MAT.solid);
    this.vmGlow = new THREE.Mesh(vm.glow, u.kind === 'engineer' ? MAT.glowBuild : MAT.glow[0]);
    this.vmMesh.renderOrder = 30;
    this.vm.add(this.vmMesh, this.vmGlow);
    this.flash.position.set(0, 0.02, u.kind === 'heavy' ? -0.95 : u.kind === 'engineer' ? -0.62 : -0.95);
    g.view.root.add(this.ghost);
    g.view.selected.clear();
    g.view.selected.add(u);
  }

  detach(release = true): void {
    const u = this.unit;
    if (!u) return;
    const w = this.game.world;
    this.ammoStore.set(u.id, this.ammo);
    u.controlled = false;
    u.building = null;
    u.aimPitch = 0;
    if (w.controlled === u) w.controlled = null;
    if (this.char) w.physics.removeCharacter(this.char);
    this.char = null;
    // hand back to the AI on walkable ground
    if (u.alive) {
      if (!w.grid.walkable(u.x, u.z)) {
        const c = w.grid.nearestOpen(u.x, u.z, 8);
        if (c >= 0) {
          u.x = w.grid.centerX(c);
          u.z = w.grid.centerZ(c);
        }
      }
      u.vx = u.vz = 0;
      u.order = { type: 'idle' };
    }
    this.unit = null;
    this.vm.visible = false;
    this.ghost.visible = false;
    this.ghost.removeFromParent();
    this.linkTarget = null;
    this.workTarget = null;
    if (release) this.game.audio.engine(0);
  }

  private aimPoint(out: THREE.Vector3, max = 220): number {
    const p = this.pose.pos, f = this.fwd;
    const hit = this.game.world.physics.raycast(p.x, p.y, p.z, f.x, f.y, f.z, max);
    const t = hit ? hit.t : max;
    out.set(p.x + f.x * t, p.y + f.y * t, p.z + f.z * t);
    return t;
  }

  private fire(alt: boolean): void {
    const g = this.game, w = g.world, u = this.unit!, wp = this.weapon;
    const p = this.pose.pos;
    const f = this.fwd.clone();
    const spread = wp.spread * (1 + Math.hypot(this.vx, this.vz) * 0.25) * (1 - this.ads * 0.6);
    f.addScaledVector(this.right, (Math.random() - 0.5) * 2 * spread).addScaledVector(this.up, (Math.random() - 0.5) * 2 * spread).normalize();

    if (alt) {
      // tank coaxial machine gun
      const aim = new THREE.Vector3();
      this.aimPoint(aim);
      const [ox, oy, oz] = w.muzzle(u);
      const d = aim.sub(new THREE.Vector3(ox, oy + 0.3, oz)).normalize();
      const r = w.playerHitscan(u, ox, oy + 0.3, oz, d.x + (Math.random() - 0.5) * 0.02, d.y + (Math.random() - 0.5) * 0.02, d.z + (Math.random() - 0.5) * 0.02, 13, 120, 0.3);
      this.registerHit(r.kind, r.kill, r.head);
      g.audio.play('prifle', undefined, undefined, 0.6);
      return;
    }

    if (wp.projectile) {
      const aim = new THREE.Vector3();
      this.aimPoint(aim);
      let ox: number, oy: number, oz: number;
      if (this.isVehicle) [ox, oy, oz] = w.muzzle(u);
      else {
        ox = p.x + this.right.x * 0.25 + f.x * 0.8;
        oy = p.y - 0.12 + f.y * 0.8;
        oz = p.z + this.right.z * 0.25 + f.z * 0.8;
      }
      w.launch(wp.projectile, PLAYER, ox, oy, oz, aim.x - ox, aim.y - oy, aim.z - oz, wp.speed!, wp.dmg, wp.radius!, wp.struct, u);
      g.engine.addShake(this.isVehicle ? 0.35 : 0.2);
    } else {
      let ox = p.x, oy = p.y, oz = p.z;
      if (!this.firstPerson) {
        // third person: converge on what the crosshair sees, fire from the unit
        const aim = new THREE.Vector3();
        this.aimPoint(aim);
        ox = u.x;
        oy = u.y + 1.75;
        oz = u.z;
        f.copy(aim).sub(new THREE.Vector3(ox, oy, oz)).normalize();
      }
      const r = w.playerHitscan(u, ox, oy, oz, f.x, f.y, f.z, wp.dmg, wp.range, wp.struct);
      this.registerHit(r.kind, r.kill, r.head);
      g.audio.play('prifle');
      g.engine.addShake(0.03);
      if (this.firstPerson) g.view.fx.flash(p.x + f.x, p.y, p.z + f.z, 0xffb060, 26, 0.06);
    }
    this.ammo--;
    this.recoil = 1;
    this.kick = Math.min(0.12, this.kick + wp.kick * (0.7 + Math.random() * 0.6));
    this.yaw += wp.kick * (Math.random() - 0.5) * 0.8;
    this.flash.visible = true;
    this.flash.rotation.z = Math.random() * 6.28;
    this.flash.scale.setScalar(wp.projectile ? 2.2 : 0.8 + Math.random() * 0.6);
    if (this.ammo <= 0 && wp.reload > 0) this.startReload();
  }

  registerHit(kind: string, kill: boolean, head: boolean): void {
    if (kind !== 'unit' && kind !== 'struct') return;
    this.hitT = kill ? 0.5 : 0.18;
    this.hitKill = kill;
    this.game.audio.play(kill ? 'kill' : 'hit', undefined, undefined, head ? 1.3 : 1);
    if (kill && kind === 'unit') this.game.hud.toast(head ? 'HEADSHOT' : 'TARGET DOWN', 'kill');
  }

  private startReload(): void {
    if (this.reloadT > 0 || this.ammo >= this.weapon.mag || this.weapon.reload <= 0) return;
    this.reloadT = this.weapon.reload;
    this.game.audio.play('reload');
  }

  private updateEngineer(dt: number): void {
    const g = this.game, w = g.world, u = this.unit!, inp = g.input;
    BUILDABLE.forEach((k, i) => {
      if (inp.hit('Digit' + (i + 1))) {
        this.buildKind = this.buildKind === k ? null : k;
        g.audio.play('click');
      }
    });
    if (inp.down[2] && this.buildKind) this.buildKind = null;

    // nearest friendly structure in front that needs work
    let best: Structure | null = null, bd = 7.5;
    for (const s of w.structures) {
      if (!s.alive || s.team !== PLAYER || (s.done && s.hp >= s.maxHp)) continue;
      const dx = s.x - u.x, dz = s.z - u.z;
      const d = Math.hypot(dx, dz) - s.def.cells;
      if (d > bd || (dx * this.fwd.x + dz * this.fwd.z) / (Math.hypot(dx, dz) || 1) < 0.2) continue;
      bd = d;
      best = s;
    }
    this.workTarget = best;
    u.building = null;
    if (best && inp.key('KeyE')) {
      u.building = best;
      if (!best.done) w.addBuildProgress(best, (dt * 2.6) / best.def.buildTime);
      else best.hp = Math.min(best.maxHp, best.hp + 110 * dt);
    }

    this.ghost.visible = !!this.buildKind;
    if (this.buildKind) {
      const aim = new THREE.Vector3();
      const t = this.aimPoint(aim, 14);
      if (t >= 14 || aim.y > w.height(aim.x, aim.z) + 0.6) {
        const d = Math.min(t, 8);
        aim.set(u.x + Math.sin(this.yaw) * d, 0, u.z + Math.cos(this.yaw) * d);
      }
      const kind = this.buildKind;
      const x = w.snap(kind, aim.x), z = w.snap(kind, aim.z);
      const linear = kind === 'wall' || kind === 'barricade';
      this.ghostRot = linear ? Math.round(this.yaw / (Math.PI / 4)) * (Math.PI / 4) : 0;
      this.ghostLen = linear ? 1 / Math.max(Math.abs(Math.cos(this.ghostRot)), Math.abs(Math.sin(this.ghostRot))) : 1;
      this.ghostValid = w.canPlace(kind, x, z) && w.teams[PLAYER].supply >= STRUCT_DEFS[kind].cost && Math.hypot(x - u.x, z - u.z) > 1.6;
      this.ghostPos.set(x, w.height(x, z), z);
      this.ghost.geometry = structParts(kind, PLAYER).main;
      this.ghost.material = this.ghostValid ? ghostOk : ghostBad;
      this.ghost.position.copy(this.ghostPos);
      this.ghost.rotation.y = this.ghostRot;
      this.ghost.scale.set(this.ghostLen, 1, 1);
      if (inp.down[0]) {
        if (this.ghostValid && w.placeStructure(PLAYER, kind, x, z, this.ghostRot, this.ghostLen)) {
          g.audio.play('place');
          g.noteAction('build');
          if (!linear) this.buildKind = null;
        } else g.audio.play('error');
      }
    }
  }

  update(dt: number, active: boolean): void {
    const u = this.unit;
    if (!u) return;
    const g = this.game, w = g.world, inp = g.input, c = this.char!;
    const sens = 0.0022 * g.storage.settings.sensitivity * (1 - this.ads * 0.45);

    if (active) {
      this.yaw -= inp.dx * sens;
      this.pitch = clamp(this.pitch - inp.dy * sens, this.isVehicle ? -0.45 : -1.45, this.isVehicle ? 0.5 : 1.45);
    }
    this.kick = Math.max(0, this.kick - dt * (0.05 + this.kick * 6));
    this.e.set(clamp(this.pitch + this.kick, -1.5, 1.5), this.yaw + Math.PI, 0);
    this.pose.quat.setFromEuler(this.e);
    this.fwd.set(0, 0, -1).applyQuaternion(this.pose.quat);
    this.right.set(1, 0, 0).applyQuaternion(this.pose.quat);
    this.up.set(0, 1, 0).applyQuaternion(this.pose.quat);

    // ---- movement
    let ix = 0, iz = 0;
    if (active) {
      if (inp.key('KeyW')) iz += 1;
      if (inp.key('KeyS')) iz -= 1;
      if (inp.key('KeyD')) ix += 1;
      if (inp.key('KeyA')) ix -= 1;
    }
    if (this.isVehicle) {
      this.hullYaw -= ix * 1.5 * dt * (this.throttle < -0.1 ? -1 : 1);
      this.throttle += (iz - this.throttle) * damp(2.2, dt);
      const sp = u.def.speed * 1.35 * this.throttle;
      this.vx = Math.sin(this.hullYaw) * sp;
      this.vz = Math.cos(this.hullYaw) * sp;
      u.yaw = this.hullYaw;
      u.aimYaw = turnToward(u.aimYaw, this.yaw, 2.8 * dt);
      g.audio.engine(0.3 + Math.abs(this.throttle));
    } else {
      const sprint = active && inp.key('ShiftLeft') && iz > 0 && this.ads < 0.3;
      const sp = u.def.speed * (sprint ? 1.75 : 1.15) * (1 - this.ads * 0.4);
      const len = Math.hypot(ix, iz) || 1;
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const wx = ((fx * iz - fz * ix) / len) * sp, wz = ((fz * iz + fx * ix) / len) * sp;
      const k = damp(c.grounded ? 14 : 3, dt);
      this.vx += (wx - this.vx) * k;
      this.vz += (wz - this.vz) * k;
      if (active && inp.hit('Space') && c.grounded) this.vy = 7.6;
      u.yaw = this.yaw;
      u.aimYaw = this.yaw;
      u.aimPitch = this.pitch;
    }
    this.vy = c.grounded && this.vy <= 0 ? -2 : this.vy - 22 * dt;
    w.physics.moveCharacter(c, this.vx * dt, this.vy * dt, this.vz * dt);
    if (Math.abs(c.x) > MAP.playW || Math.abs(c.z) > MAP.playH) {
      const nx = clamp(c.x, -MAP.playW, MAP.playW), nz = clamp(c.z, -MAP.playH, MAP.playH);
      c.body.setTranslation({ x: nx, y: c.body.translation().y, z: nz }, true);
      c.x = nx;
      c.z = nz;
    }
    u.vx = (c.x - u.x) / Math.max(dt, 1e-4);
    u.vz = (c.z - u.z) / Math.max(dt, 1e-4);
    u.x = c.x;
    u.y = c.y;
    u.z = c.z;
    if (u.y < w.height(u.x, u.z) - 3) {
      // safety net: never fall through the world
      const y = w.height(u.x, u.z) + 1.5;
      c.body.setTranslation({ x: u.x, y: y + c.halfH + c.radius, z: u.z }, true);
      this.vy = 0;
    }
    const speed = Math.hypot(this.vx, this.vz);
    if (c.grounded && !this.isVehicle) this.bob += dt * speed * 1.9;

    // regenerate when out of the fight
    if (u.sinceHit > 5 && u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + (u.def.infantry ? 9 : 14) * dt);

    // ---- camera
    this.ads += ((active && inp.buttons[2] && u.def.infantry && !this.buildKind ? 1 : 0) - this.ads) * damp(14, dt);
    if (this.isVehicle) {
      const back = 11.5, upH = 5.2;
      this.pose.pos.set(u.x - this.fwd.x * back, u.y + upH - this.fwd.y * back * 0.6, u.z - this.fwd.z * back);
      this.pose.pos.y = Math.max(this.pose.pos.y, w.height(this.pose.pos.x, this.pose.pos.z) + 1.2);
      this.pose.fov = 62;
    } else if (this.third) {
      const tx = u.x + this.right.x * 0.7, ty = u.y + 1.95, tz = u.z + this.right.z * 0.7;
      let back = 3.6;
      const hit = w.physics.raycast(tx, ty, tz, -this.fwd.x, -this.fwd.y, -this.fwd.z, back + 0.3);
      if (hit) back = Math.max(0.4, hit.t - 0.3);
      this.pose.pos.set(tx - this.fwd.x * back, ty - this.fwd.y * back, tz - this.fwd.z * back);
      this.pose.fov = 68 - this.ads * 16;
    } else {
      const b = c.grounded ? Math.sin(this.bob) * 0.045 * Math.min(1, speed / 5) : 0;
      this.pose.pos.set(u.x, u.y + 1.74 + b, u.z);
      this.pose.fov = 74 - this.ads * 24 + Math.min(6, speed * 0.5);
    }

    // ---- actions
    this.fireCd -= dt;
    this.mgCd -= dt;
    this.grenadeCd = Math.max(0, this.grenadeCd - dt);
    this.hitT = Math.max(0, this.hitT - dt);
    this.recoil = Math.max(0, this.recoil - dt * 9);
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) this.ammo = this.weapon.mag;
    }
    this.linkTarget = null;
    this.workTarget = null;
    if (active) {
      if (u.kind === 'engineer') this.updateEngineer(dt);
      const placing = !!this.buildKind;
      if (!placing && inp.buttons[0] && this.fireCd <= 0 && this.reloadT <= 0 && this.ammo > 0) {
        const aligned = !this.isVehicle || Math.abs(angDiff(u.aimYaw, this.yaw)) < 0.08;
        if (aligned) {
          this.fireCd = this.weapon.cd;
          this.fire(false);
        }
      }
      if (this.isVehicle && inp.buttons[2] && this.mgCd <= 0) {
        this.mgCd = 0.085;
        this.fire(true);
      }
      if (inp.hit('KeyR')) this.startReload();
      if (inp.hit('KeyV') && u.def.infantry) this.third = !this.third;
      if (inp.hit('KeyG') && u.def.infantry && this.grenadeCd <= 0) {
        this.grenadeCd = 5;
        const p = this.pose.pos, f = this.fwd;
        w.throwGrenade(u, u.x + f.x * 0.7, u.y + 1.6, u.z + f.z * 0.7, f.x * 17 + this.vx, f.y * 17 + 4.5, f.z * 17 + this.vz);
        g.audio.play('grenade');
        void p;
      }
      // link transfer: hop into the ally under the crosshair
      let bestA = 0.07;
      const p = this.pose.pos;
      for (const o of w.units) {
        if (o === u || o.team !== PLAYER || !o.alive || o.spawnDelay > 0) continue;
        const dx = o.x - p.x, dy = o.y + 1.2 - p.y, dz = o.z - p.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > 140 || d < 0.5) continue;
        const ang = Math.acos(clamp((dx * this.fwd.x + dy * this.fwd.y + dz * this.fwd.z) / d, -1, 1));
        const tol = Math.max(0.035, Math.min(0.2, 1.6 / d));
        if (ang < tol && ang / tol < bestA / 0.07 && w.canSeeFrom(p.x, p.y, p.z, o)) {
          bestA = (ang / tol) * 0.07;
          this.linkTarget = o;
        }
      }
      if (inp.hit('KeyF') && this.linkTarget) g.enterDirect(this.linkTarget);
      // field command: send nearby allies to where you are looking
      if (inp.hit('KeyC')) {
        const aim = new THREE.Vector3();
        this.aimPoint(aim, 160);
        const squad = w.units.filter((o) => o !== u && o.team === PLAYER && o.alive && o.kind !== 'engineer' && Math.hypot(o.x - u.x, o.z - u.z) < 45);
        if (squad.length) {
          w.orderMove(squad, aim.x, aim.z, true);
          g.view.fx.marker(aim.x, aim.z, COLORS.player);
          g.audio.play('order');
          g.hud.toast(`${squad.length} units: assault that position`);
        }
      }
      if (inp.hit('KeyX')) {
        const squad = w.units.filter((o) => o !== u && o.team === PLAYER && o.alive && o.kind !== 'engineer' && Math.hypot(o.x - u.x, o.z - u.z) < 45);
        if (squad.length) {
          w.orderMove(squad, u.x - Math.sin(this.yaw) * 3, u.z - Math.cos(this.yaw) * 3, false);
          g.audio.play('order');
          g.hud.toast(`${squad.length} units: regroup on me`);
        }
      }
    } else {
      u.building = null;
      this.ghost.visible = false;
    }
    let pres = 0;
    for (const o of w.units) if (o !== u && o.team === PLAYER && o.alive && Math.hypot(o.x - u.x, o.z - u.z) < 18) pres++;
    this.presence = pres;

    // ---- view model
    this.vm.visible = this.firstPerson && g.mode !== 'commander';
    if (this.vm.visible) {
      this.sway.x += (clamp(-inp.dx * 0.0006, -0.03, 0.03) - this.sway.x) * damp(8, dt);
      this.sway.y += (clamp(inp.dy * 0.0006, -0.03, 0.03) - this.sway.y) * damp(8, dt);
      const bobX = Math.cos(this.bob * 0.5) * 0.008 * Math.min(1, speed / 4), bobY = Math.sin(this.bob) * 0.008 * Math.min(1, speed / 4);
      const hipX = u.kind === 'heavy' ? 0.27 : 0.2, hipY = u.kind === 'heavy' ? -0.13 : -0.19;
      const rl = this.reloadT > 0 ? Math.sin(Math.min(1, this.reloadT / this.weapon.reload) * Math.PI) : 0;
      this.vm.position.set(
        hipX * (1 - this.ads) + this.sway.x + bobX,
        hipY * (1 - this.ads) - this.ads * 0.105 + this.sway.y + bobY - rl * 0.16,
        -0.4 + this.recoil * 0.05 + this.ads * 0.08,
      );
      this.vm.rotation.set(this.recoil * 0.06 - rl * 0.7, this.sway.x * 2, rl * 0.3);
    }
    if (this.flash.visible && this.fireCd < this.weapon.cd - 0.045) this.flash.visible = false;
  }
}
