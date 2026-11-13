import * as THREE from 'three';
import { BASES, BUILDABLE, COLORS, MAP, PLAYER, STRUCT_DEFS, TRAINABLE, type StructKind } from '../core/config';
import type { Game } from '../core/Game';
import { clamp, damp } from '../core/math';
import type { Structure, Unit } from '../sim/entities';
import { structParts } from '../render/models';

export interface Pose {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  fov: number;
}

interface Placement { x: number; z: number; rot: number; len: number; ok: boolean }

const ghostOk = new THREE.MeshBasicMaterial({ color: 0x59ffb0, transparent: true, opacity: 0.45, depthWrite: false });
const ghostBad = new THREE.MeshBasicMaterial({ color: 0xff4455, transparent: true, opacity: 0.45, depthWrite: false });

/** Commander Mode: RTS camera, selection, orders, construction placement and abilities. */
export class CommanderController {
  pose: Pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 40 };
  focus = new THREE.Vector3(BASES[0].spawnX + 8, 0, 0);
  dist = 62;
  yaw = 0;
  pitch = 0.98;
  buildKind: StructKind | null = null;
  strikeMode = false;
  buildRot = 0;
  dragging = false;
  dragX = 0;
  dragY = 0;
  groups: Unit[][] = [[], [], [], [], []];
  lastAlert: { x: number; z: number } | null = null;
  hover: Unit | Structure | null = null;
  private tFocus = this.focus.clone();
  private tDist = this.dist;
  private tYaw = 0;
  private buildStart: { x: number; z: number } | null = null;
  private ghosts: THREE.Mesh[] = [];
  private ghostGroup = new THREE.Group();
  private range: THREE.Mesh;
  private ray = new THREE.Raycaster();
  private v = new THREE.Vector3();
  private ndc = new THREE.Vector2();
  private placements: Placement[] = [];

  constructor(private game: Game) {
    this.range = new THREE.Mesh(
      new THREE.RingGeometry(0.985, 1, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: COLORS.player, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    this.range.visible = false;
    this.ghostGroup.add(this.range);
  }

  attach(): void {
    this.game.view.root.add(this.ghostGroup);
  }

  jumpTo(x: number, z: number): void {
    this.tFocus.set(clamp(x, -MAP.playW, MAP.playW), 0, clamp(z, -MAP.playH, MAP.playH));
  }
  snapTo(x: number, z: number): void {
    this.jumpTo(x, z);
    this.focus.copy(this.tFocus);
  }

  /** World position on the terrain under a screen point. */
  ground(sx: number, sy: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    const cam = this.game.engine.camera;
    this.ndc.set((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1);
    this.ray.setFromCamera(this.ndc, cam);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    if (d.y > -0.02) return null;
    let y = 0;
    for (let i = 0; i < 4; i++) {
      const t = (y - o.y) / d.y;
      out.set(o.x + d.x * t, y, o.z + d.z * t);
      y = this.game.world.height(out.x, out.z);
    }
    out.y = y;
    return out;
  }

  private screen(x: number, y: number, z: number): { x: number; y: number; behind: boolean } {
    this.v.set(x, y, z).project(this.game.engine.camera);
    return { x: (this.v.x * 0.5 + 0.5) * window.innerWidth, y: (-this.v.y * 0.5 + 0.5) * window.innerHeight, behind: this.v.z > 1 };
  }

  private pickUnit(sx: number, sy: number, team?: number): Unit | null {
    let best: Unit | null = null, bd = 30;
    for (const u of this.game.world.units) {
      if (!u.alive || u.spawnDelay > 0 || (team !== undefined && u.team !== team)) continue;
      const s = this.screen(u.x, u.y + (u.def.infantry ? 1.1 : 1.5), u.z);
      if (s.behind) continue;
      const d = Math.hypot(s.x - sx, s.y - sy) / (u.def.infantry ? 1 : 2.2);
      if (d < bd) {
        bd = d;
        best = u;
      }
    }
    return best;
  }

  private pickStruct(p: THREE.Vector3 | null): Structure | null {
    if (!p) return null;
    const g = this.game.world.grid;
    const id = g.struct[g.cellAt(p.x, p.z)];
    return id ? this.game.world.structById.get(id) ?? null : null;
  }

  selection(): Unit[] {
    return [...this.game.view.selected].filter((u) => u.alive);
  }

  setBuild(kind: StructKind | null): void {
    this.buildKind = this.buildKind === kind ? null : kind;
    this.strikeMode = false;
    this.buildStart = null;
    this.game.audio.play('click');
  }
  setStrike(): void {
    const t = this.game.world.teams[PLAYER];
    if (t.strikeCd > 0 || t.supply < 120) {
      this.game.audio.play('error');
      return;
    }
    this.strikeMode = !this.strikeMode;
    this.buildKind = null;
    this.game.audio.play('click');
  }
  cancelModes(): boolean {
    const had = !!this.buildKind || this.strikeMode;
    this.buildKind = null;
    this.strikeMode = false;
    this.buildStart = null;
    return had;
  }

  private computePlacements(p: THREE.Vector3): void {
    const w = this.game.world, kind = this.buildKind!;
    const out: Placement[] = [];
    const linear = kind === 'wall' || kind === 'barricade';
    let rot = this.buildRot, len = 1;
    const cells: Array<{ x: number; z: number }> = [];
    if (linear && this.buildStart) {
      const c = MAP.cell;
      const ax = Math.floor(this.buildStart.x / c), az = Math.floor(this.buildStart.z / c);
      const bx = Math.floor(p.x / c), bz = Math.floor(p.z / c);
      const n = Math.min(24, Math.max(Math.abs(bx - ax), Math.abs(bz - az)));
      for (let i = 0; i <= n; i++) {
        const t = n ? i / n : 0;
        cells.push({ x: (Math.round(ax + (bx - ax) * t) + 0.5) * c, z: (Math.round(az + (bz - az) * t) + 0.5) * c });
      }
      if (n > 0) {
        const dx = cells[n].x - cells[0].x, dz = cells[n].z - cells[0].z;
        // snap to 45° so segments tile
        rot = Math.round(Math.atan2(-dz, dx) / (Math.PI / 4)) * (Math.PI / 4);
      }
    } else cells.push({ x: p.x, z: p.z });
    len = 1 / Math.max(Math.abs(Math.cos(rot)), Math.abs(Math.sin(rot)));
    if (!linear) len = 1;
    let budget = w.teams[PLAYER].supply;
    const cost = STRUCT_DEFS[kind].cost;
    const seen = new Set<string>();
    for (const c of cells) {
      const x = w.snap(kind, c.x), z = w.snap(kind, c.z);
      const key = x + ',' + z;
      if (seen.has(key)) continue;
      seen.add(key);
      const ok = w.canPlace(kind, x, z) && budget >= cost;
      if (ok) budget -= cost;
      out.push({ x, z, rot, len, ok });
    }
    this.placements = out;
  }

  private drawGhosts(): void {
    const kind = this.buildKind;
    const w = this.game.world;
    const n = kind ? this.placements.length : 0;
    while (this.ghosts.length < n) {
      const m = new THREE.Mesh(undefined, ghostOk);
      m.renderOrder = 6;
      this.ghosts.push(m);
      this.ghostGroup.add(m);
    }
    this.ghosts.forEach((m, i) => {
      m.visible = i < n;
      if (i >= n) return;
      const p = this.placements[i];
      m.geometry = structParts(kind!, PLAYER).main;
      m.material = p.ok ? ghostOk : ghostBad;
      m.position.set(p.x, w.height(p.x, p.z), p.z);
      m.rotation.y = p.rot;
      m.scale.set(p.len, 1, 1);
    });
    const def = kind ? STRUCT_DEFS[kind] : null;
    const r = def?.weapon?.range ?? def?.aura ?? 0;
    this.range.visible = !!kind && r > 0 && n > 0;
    if (this.range.visible) {
      const p = this.placements[0];
      this.range.position.set(p.x, w.height(p.x, p.z) + 0.4, p.z);
      this.range.scale.set(r, 1, r);
    }
  }

  private commitBuild(): void {
    const w = this.game.world, kind = this.buildKind!;
    const placed: Structure[] = [];
    for (const p of this.placements) {
      if (!p.ok) continue;
      const s = w.placeStructure(PLAYER, kind, p.x, p.z, p.rot, p.len);
      if (s) placed.push(s);
    }
    if (!placed.length) {
      this.game.audio.play('error');
      this.game.hud.toast(w.teams[PLAYER].supply < STRUCT_DEFS[kind].cost ? 'Not enough supply' : 'Cannot build there');
      return;
    }
    this.game.audio.play('place');
    this.game.noteAction('build');
    const engs = this.selection().filter((u) => u.kind === 'engineer');
    engs.forEach((e, i) => w.orderBuild([e], placed[Math.min(placed.length - 1, Math.floor((i / engs.length) * placed.length))]));
    if (!w.units.some((u) => u.team === PLAYER && u.kind === 'engineer' && u.alive)) this.game.hud.toast('No Architects alive — train one to build this');
    if (!this.game.input.shift) this.buildKind = null;
  }

  private rightClick(p: THREE.Vector3 | null, sx: number, sy: number): void {
    const g = this.game, w = g.world;
    const sel = this.selection();
    if (!sel.length) return;
    const enemy = this.pickUnit(sx, sy, 1);
    const st = this.pickStruct(p);
    if (enemy) {
      w.orderAttack(sel, enemy);
      g.view.fx.marker(enemy.x, enemy.z, COLORS.enemy);
      g.audio.play('order');
    } else if (st && st.team !== PLAYER) {
      w.orderAttack(sel, st);
      g.view.fx.marker(st.x, st.z, COLORS.enemy);
      g.audio.play('order');
    } else if (st && st.team === PLAYER && (!st.done || st.hp < st.maxHp) && sel.some((u) => u.kind === 'engineer')) {
      w.orderBuild(sel, st);
      w.orderMove(sel.filter((u) => u.kind !== 'engineer'), st.x, st.z);
      g.view.fx.marker(st.x, st.z, COLORS.build);
      g.audio.play('order');
    } else if (p) {
      w.orderMove(sel, p.x, p.z, g.input.ctrl);
      g.view.fx.marker(p.x, p.z, g.input.ctrl ? 0xffa040 : COLORS.player);
      g.audio.play('order');
      g.noteAction('move');
    }
  }

  /** Orders issued through the minimap. */
  minimapOrder(x: number, z: number): void {
    const sel = this.selection();
    if (!sel.length) return;
    this.game.world.orderMove(sel, x, z);
    this.game.view.fx.marker(x, z, COLORS.player);
    this.game.audio.play('order');
  }

  update(dt: number, active: boolean): void {
    const g = this.game, inp = g.input, w = g.world, view = g.view;
    if (active) {
      // camera
      const sp = (26 + this.dist * 0.55) * dt;
      let mx = 0, mz = 0;
      if (inp.key('KeyW') || inp.key('ArrowUp')) mz -= 1;
      if (inp.key('KeyS') || inp.key('ArrowDown')) mz += 1;
      if (inp.key('KeyA') || inp.key('ArrowLeft')) mx -= 1;
      if (inp.key('KeyD') || inp.key('ArrowRight')) mx += 1;
      if (g.storage.settings.edgeScroll && document.hasFocus()) {
        if (inp.mx < 4) mx -= 1;
        if (inp.mx > window.innerWidth - 4) mx += 1;
        if (inp.my < 4) mz -= 1;
        if (inp.my > window.innerHeight - 4) mz += 1;
      }
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      this.tFocus.x = clamp(this.tFocus.x + (mx * c + mz * s) * sp, -MAP.playW, MAP.playW);
      this.tFocus.z = clamp(this.tFocus.z + (-mx * s + mz * c) * sp, -MAP.playH, MAP.playH);
      if (inp.key('KeyQ')) this.tYaw += 1.6 * dt;
      if (inp.key('KeyE')) this.tYaw -= 1.6 * dt;
      if (inp.buttons[1]) this.tYaw -= inp.dx * 0.005;
      if (inp.wheel) this.tDist = clamp(this.tDist * (1 + inp.wheel * 0.12), 24, 125);

      const p = this.ground(inp.mx, inp.my);
      this.hover = this.pickUnit(inp.mx, inp.my) ?? this.pickStruct(p);

      // hotkeys
      const keys: Array<[string, StructKind]> = [['KeyZ', 'wall'], ['KeyX', 'barricade'], ['KeyC', 'turret'], ['KeyV', 'bunker']];
      for (const [k, kind] of keys) if (inp.hit(k)) this.setBuild(kind);
      const tk = ['KeyT', 'KeyY', 'KeyU', 'KeyI'];
      tk.forEach((k, i) => inp.hit(k) && g.train(TRAINABLE[i]));
      if (inp.hit('KeyO')) this.setStrike();
      if (inp.hit('KeyR')) this.buildRot = (this.buildRot + Math.PI / 4) % Math.PI;
      if (inp.hit('KeyH')) {
        w.orderHold(this.selection());
        g.audio.play('order');
      }
      if (inp.hit('Space') && this.lastAlert) this.jumpTo(this.lastAlert.x, this.lastAlert.z);
      if (inp.hit('Home')) this.jumpTo(BASES[0].spawnX, 0);
      for (let i = 0; i < 5; i++) {
        if (!inp.hit('Digit' + (i + 1))) continue;
        if (inp.ctrl) {
          this.groups[i] = this.selection();
          g.hud.toast(`Group ${i + 1} assigned`);
        } else {
          const grp = this.groups[i].filter((u) => u.alive);
          if (grp.length) {
            const same = grp.length === view.selected.size && grp.every((u) => view.selected.has(u));
            view.selected = new Set(grp);
            view.selectedStruct = null;
            if (same) this.jumpTo(grp[0].x, grp[0].z);
          }
        }
      }
      if (inp.hit('KeyF') || inp.hit('Tab')) {
        const sel = this.selection();
        let u: Unit | null = sel[0] ?? null;
        if (!u) {
          let bd = Infinity;
          for (const o of w.units) {
            if (o.team !== PLAYER || !o.alive || o.spawnDelay > 0) continue;
            const d = Math.hypot(o.x - this.focus.x, o.z - this.focus.z);
            if (d < bd) {
              bd = d;
              u = o;
            }
          }
        }
        if (u) g.enterDirect(u);
      }

      // mouse
      if (this.buildKind) {
        if (p) {
          if (inp.down[0]) this.buildStart = { x: p.x, z: p.z };
          this.computePlacements(p);
          if (inp.up[0] && this.buildStart) {
            this.commitBuild();
            this.buildStart = null;
          }
        }
        if (inp.down[2]) this.cancelModes();
      } else if (this.strikeMode) {
        if (inp.down[0] && p) {
          if (w.orbitalStrike(PLAYER, p.x, p.z)) g.hud.toast('Orbital strike inbound');
          else g.audio.play('error');
          this.strikeMode = false;
        }
        if (inp.down[2]) this.strikeMode = false;
      } else {
        if (inp.down[0]) {
          this.dragging = true;
          this.dragX = inp.mx;
          this.dragY = inp.my;
        }
        if (inp.up[0] && this.dragging) {
          this.dragging = false;
          const x0 = Math.min(this.dragX, inp.mx), x1 = Math.max(this.dragX, inp.mx);
          const y0 = Math.min(this.dragY, inp.my), y1 = Math.max(this.dragY, inp.my);
          if (!inp.shift) view.selected.clear();
          view.selectedStruct = null;
          if (x1 - x0 < 6 && y1 - y0 < 6) {
            const u = this.pickUnit(inp.mx, inp.my, PLAYER);
            if (u) {
              if (inp.shift && view.selected.has(u)) view.selected.delete(u);
              else view.selected.add(u);
              g.audio.play('click');
            } else {
              const s = this.pickStruct(p);
              if (s && s.team === PLAYER) view.selectedStruct = s;
            }
          } else {
            for (const u of w.units) {
              if (u.team !== PLAYER || !u.alive || u.spawnDelay > 0) continue;
              const s = this.screen(u.x, u.y + 1, u.z);
              if (!s.behind && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) view.selected.add(u);
            }
            if (view.selected.size) g.audio.play('click');
          }
        }
        if (inp.dbl) {
          const u = this.pickUnit(inp.mx, inp.my, PLAYER);
          if (u) {
            for (const o of w.units) {
              if (o.team !== PLAYER || o.kind !== u.kind || !o.alive) continue;
              const s = this.screen(o.x, o.y + 1, o.z);
              if (!s.behind && s.x > 0 && s.y > 0 && s.x < window.innerWidth && s.y < window.innerHeight) view.selected.add(o);
            }
          }
        }
        if (inp.down[2]) this.rightClick(p, inp.mx, inp.my);
      }
    } else {
      this.dragging = false;
      this.hover = null;
    }
    if (!this.buildKind || !active) this.placements = [];
    this.drawGhosts();
    for (const u of view.selected) if (!u.alive) view.selected.delete(u);

    // smooth rig
    const k = damp(9, dt);
    this.focus.lerp(this.tFocus, k);
    this.dist += (this.tDist - this.dist) * k;
    this.yaw += (this.tYaw - this.yaw) * k;
    this.focus.y = w.height(this.focus.x, this.focus.z);
    const pitch = this.pitch - (125 - this.dist) * 0.0022;
    const h = Math.sin(pitch) * this.dist, r = Math.cos(pitch) * this.dist;
    this.pose.pos.set(this.focus.x + Math.sin(this.yaw) * r, this.focus.y + h, this.focus.z + Math.cos(this.yaw) * r);
    const m = new THREE.Matrix4().lookAt(this.pose.pos, this.focus, THREE.Object3D.DEFAULT_UP);
    this.pose.quat.setFromRotationMatrix(m);
    this.pose.fov = 40;
  }

  dispose(): void {
    this.ghostGroup.removeFromParent();
    this.ghosts = [];
    this.ghostGroup.clear();
    this.ghostGroup.add(this.range);
  }
}

export { BUILDABLE };
