import * as THREE from 'three';
import { AudioSys } from '../audio/Audio';
import { CommanderController, type Pose } from '../input/CommanderController';
import { DirectController } from '../input/DirectController';
import { Input } from '../input/Input';
import { Storage } from '../persistence/Storage';
import { BattleView } from '../render/BattleView';
import { Engine } from '../render/Engine';
import type { Unit } from '../sim/entities';
import { World } from '../sim/World';
import { HUD, Minimap } from '../ui/HUD';
import { Overlay } from '../ui/Overlay';
import { BASES, PLAYER, UNIT_DEFS, type UnitKind } from './config';
import { clamp, ease } from './math';

export type GameState = 'boot' | 'menu' | 'intro' | 'playing' | 'paused' | 'over';
export type Mode = 'commander' | 'direct';

const INTRO_TIME = 6.5;

/**
 * Orchestrates everything around the simulation: the frame loop, the two
 * control modes and the cinematic hand-over between them, menus and restart.
 * The World is ticked from exactly one place, regardless of perspective.
 */
export class Game {
  engine: Engine;
  input: Input;
  audio = new AudioSys();
  storage = new Storage();
  hud: HUD;
  minimap: Minimap;
  overlay: Overlay;
  world!: World;
  view!: BattleView;
  commander: CommanderController;
  direct: DirectController;
  state: GameState = 'boot';
  mode: Mode = 'commander';
  timeScale = 1;
  private transition: { t: number; dur: number; from: Pose; arc: number } | null = null;
  private last = 0;
  private stateT = 0;
  private heat = 0;
  private underAttackCd = 0;
  private coreAttackCd = 0;
  private endShown = false;
  private pausedAt = 0;
  private loading = false;
  private tmp = new THREE.Vector3();
  private introPose: Pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 50 };
  private frames = 0;
  private fpsT = 0;
  fps = 60;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas);
    this.input = new Input(canvas);
    this.commander = new CommanderController(this);
    this.direct = new DirectController(this);
    this.hud = new HUD(this);
    this.minimap = new Minimap(this);
    this.overlay = new Overlay(this);
    this.engine.onThunder = () => this.audio.play('thunder', undefined, undefined, 0.5 + Math.random() * 0.5);
    this.input.onLockLost = () => {
      if (this.state === 'playing' && this.mode === 'direct' && !this.transition) this.togglePause();
    };
    canvas.addEventListener('mousedown', () => {
      if (this.state === 'playing' && this.mode === 'direct') this.input.lock();
      if (this.state === 'intro') this.skipIntro();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') this.onEscape();
      if (e.code === 'KeyP' && (this.state === 'playing' || this.state === 'paused')) this.togglePause();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.togglePause();
    });
    this.applySettings();
  }

  async boot(): Promise<void> {
    await this.newBattle();
    this.state = 'menu';
    this.hud.setMode('menu');
    document.getElementById('boot')?.remove();
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  applySettings(): void {
    const s = this.storage.settings;
    this.engine.setQuality(s.quality);
    this.audio.setVolume(s.volume);
    this.audio.setMusicVolume(s.music);
  }

  // ----------------------------------------------------------------- battle

  private async newBattle(): Promise<void> {
    this.loading = true;
    if (this.view) {
      this.direct.detach();
      this.commander.dispose();
      this.view.dispose();
      this.world.dispose();
    }
    this.world = await World.create({ difficulty: this.storage.settings.difficulty });
    this.view = new BattleView(this.world, {
      shake: (a, x, z) => this.engine.addShake(a, x, z),
      sound: (n, x, z, v) => this.audio.play(n, x, z, v),
    });
    this.engine.scene.add(this.view.root);
    this.commander.attach();
    this.commander.cancelModes();
    this.commander.snapTo(BASES[0].spawnX + 8, 0);
    this.commander.groups = [[], [], [], [], []];
    this.minimap.rebuild();
    this.hud.reset();
    this.mode = 'commander';
    this.transition = null;
    this.timeScale = 1;
    this.endShown = false;
    this.heat = 0;
    this.wire();
    this.loading = false;
  }

  private wire(): void {
    const ev = this.world.events;
    ev.on('alert', (a) => {
      this.hud.alert(a.text, a.level, a.x, a.z);
      if (a.x !== undefined && a.z !== undefined) this.commander.lastAlert = { x: a.x, z: a.z };
      this.audio.play(a.level === 'good' ? 'capture' : a.level === 'bad' ? 'lost' : 'alert');
      if (a.level === 'good') this.engine.pulse = Math.max(this.engine.pulse, 0.35);
    });
    ev.on('shot', () => (this.heat = Math.min(1.5, this.heat + 0.03)));
    ev.on('explosion', () => (this.heat = Math.min(1.5, this.heat + 0.2)));
    ev.on('unitHit', ({ unit }) => {
      if (unit.controlled) {
        this.engine.damage = Math.min(1, this.engine.damage + 0.3);
        this.engine.addShake(0.08);
        this.audio.play('hurt');
      } else if (unit.team === PLAYER && this.underAttackCd <= 0 && this.mode === 'commander') {
        if (Math.hypot(unit.x - this.commander.focus.x, unit.z - this.commander.focus.z) > 55) {
          this.underAttackCd = 18;
          this.hud.alert('OUR FORCES ARE UNDER ATTACK', 'warn', unit.x, unit.z);
          this.commander.lastAlert = { x: unit.x, z: unit.z };
          this.audio.play('alert');
        }
      }
    });
    ev.on('structHit', ({ s }) => {
      if (s.kind === 'hq' && s.team === PLAYER && this.coreAttackCd <= 0) {
        this.coreAttackCd = 22;
        this.hud.alert('COMMAND CORE UNDER ATTACK', 'warn', s.x, s.z);
        this.commander.lastAlert = { x: s.x, z: s.z };
        this.audio.play('alert');
      }
    });
    ev.on('unitDie', ({ unit }) => {
      if (unit === this.direct.unit) {
        this.hud.banner('LINK SEVERED — HOST LOST', 'bad');
        this.exitDirect(true);
      }
    });
    ev.on('pointChange', ({ point }) => {
      if (point.owner === PLAYER) this.hud.noteHint('move');
    });
    ev.on('gameOver', ({ winner }) => {
      this.state = 'over';
      this.stateT = 0;
      if (this.mode === 'direct') this.exitDirect(false, true);
      this.commander.cancelModes();
      const hq = this.world.hq[winner === PLAYER ? 1 : 0];
      this.commander.jumpTo(hq.x, hq.z);
      this.transition = { t: 0, dur: 2.2, from: this.snapshot(), arc: 0 };
      this.audio.play(winner === PLAYER ? 'victory' : 'defeat');
      this.audio.engine(0);
    });
  }

  start(): void {
    if (this.loading || this.state !== 'menu') return;
    this.audio.init();
    this.audio.play('click');
    this.hud.show('menu', false);
    this.hud.setMode('commander');
    this.hud.intro(true);
    this.transition = { t: 0, dur: 1.4, from: this.snapshot(), arc: 0 };
    this.state = 'intro';
    this.stateT = 0;
  }

  skipIntro(): void {
    if (this.state === 'intro') this.stateT = Math.max(this.stateT, INTRO_TIME - 0.6);
  }

  async restart(startNow: boolean): Promise<void> {
    if (this.loading) return;
    this.input.unlock();
    this.hud.show('pause', false);
    this.hud.show('end', false);
    this.audio.engine(0);
    this.state = 'boot';
    await this.newBattle();
    this.state = 'menu';
    this.hud.setMode('menu');
    this.hud.syncSettings();
    if (startNow) this.start();
    else this.hud.show('menu', true);
  }

  togglePause(): void {
    if (this.state === 'playing') {
      this.state = 'paused';
      this.pausedAt = performance.now();
      this.hud.show('pause', true);
      this.input.unlock();
      this.audio.engine(0);
    } else if (this.state === 'paused') {
      this.state = 'playing';
      this.hud.show('pause', false);
      if (this.mode === 'direct') this.input.lock();
      this.last = performance.now();
    }
  }

  private onEscape(): void {
    if (this.state === 'intro') return this.skipIntro();
    if (this.state === 'paused') return performance.now() - this.pausedAt > 350 ? this.togglePause() : undefined;
    if (this.state !== 'playing') return;
    if (this.mode === 'commander' && this.commander.cancelModes()) return;
    // In direct mode the browser releases the pointer on Esc, which pauses via onLockLost.
    if (this.mode === 'direct' && this.input.locked) return;
    this.togglePause();
  }

  // ------------------------------------------------------------ mode switch

  private snapshot(): Pose {
    const c = this.engine.camera;
    return { pos: c.position.clone(), quat: c.quaternion.clone(), fov: c.fov };
  }

  /** Take direct control of a unit. Works from Commander Mode and from another host. */
  enterDirect(u: Unit): void {
    if (this.state !== 'playing' || !u.alive || u.team !== PLAYER || u.spawnDelay > 0) return;
    if (this.transition && this.transition.t < 0.4) return;
    const hop = this.mode === 'direct';
    this.commander.cancelModes();
    this.transition = { t: 0, dur: hop ? 0.55 : 1.05, from: this.snapshot(), arc: hop ? 2 : 0 };
    this.view.hidden = null;
    this.direct.attach(u);
    this.mode = 'direct';
    this.hud.setMode('direct');
    this.hud.linkFlash(hop ? `LINK TRANSFERRED — ${u.label.toUpperCase()}` : `NEURAL LINK — ${u.label.toUpperCase()}`);
    this.hud.noteHint('link');
    this.audio.play('linkIn');
    this.engine.pulse = 0.9;
    this.input.lock();
  }

  /** Return to Commander Mode; the unit goes straight back to its AI. */
  exitDirect(died = false, silent = false): void {
    if (this.mode !== 'direct') return;
    const u = this.direct.unit;
    this.transition = { t: 0, dur: died ? 1.5 : 0.9, from: this.snapshot(), arc: 0 };
    if (u) this.commander.snapTo(u.x, u.z);
    this.direct.detach();
    this.view.hidden = null;
    this.mode = 'commander';
    this.hud.setMode('commander');
    this.input.unlock();
    if (!silent) {
      this.hud.linkFlash(died ? 'LINK SEVERED' : 'COMMAND VIEW');
      this.audio.play('linkOut');
      this.hud.noteHint('return');
    }
    this.engine.pulse = died ? 0.3 : 0.6;
    if (died) this.engine.damage = 1;
    if (u && u.alive) {
      this.view.selected.clear();
      this.view.selected.add(u);
    }
  }

  // -------------------------------------------------------------- UI hooks

  train(kind: UnitKind): void {
    if (this.state !== 'playing') return;
    const t = this.world.teams[PLAYER], d = UNIT_DEFS[kind];
    if (this.world.queueUnit(PLAYER, kind)) {
      this.audio.play('place');
      return;
    }
    this.audio.play('error');
    this.hud.toast(t.supply < d.cost ? 'Not enough supply' : t.queue.length >= 6 ? 'Deployment queue full' : 'Army at capacity — hold more points');
  }

  cycleSpawnSite(): void {
    const t = this.world.teams[PLAYER];
    const bunkers = this.world.structures.filter((s) => s.team === PLAYER && s.kind === 'bunker' && s.done);
    const i = t.spawnSite ? bunkers.indexOf(t.spawnSite) : -1;
    t.spawnSite = i + 1 < bunkers.length ? bunkers[i + 1] : null;
    if (t.spawnSite) this.commander.jumpTo(t.spawnSite.x, t.spawnSite.z);
    this.audio.play('click');
  }

  noteAction(kind: 'move' | 'build'): void {
    if (kind === 'build') this.hud.noteHint('build');
  }

  // ------------------------------------------------------------------ frame

  private frame(now: number): void {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    this.frames++;
    this.fpsT += dt;
    if (this.fpsT > 0.5) {
      this.fps = this.frames / this.fpsT;
      this.frames = 0;
      this.fpsT = 0;
    }
    if (this.state === 'boot' || this.loading) return;
    this.update(dt);
    this.input.endFrame();
  }

  private update(dt: number): void {
    const cam = this.engine.camera;
    this.stateT += dt;
    const playing = this.state === 'playing' || this.state === 'intro';

    // ---- simulation (one place, always)
    let target = 1;
    if (this.transition && this.state === 'playing') target = 0.4;
    if (this.state === 'over') target = this.stateT < 3 ? 0.25 : 0.6;
    this.timeScale += (target - this.timeScale) * Math.min(1, dt * 8);
    const simDt = dt * this.timeScale;
    if (playing || this.state === 'over') this.world.update(simDt);

    // ---- controllers
    const tr = this.transition;
    const ctlActive = this.state === 'playing' && (!tr || tr.t > tr.dur * 0.75);
    this.commander.update(dt, ctlActive && this.mode === 'commander');
    if (this.mode === 'direct' && this.state !== 'paused') this.direct.update(dt, ctlActive);
    if (this.mode === 'direct' && ctlActive && this.input.hit('Tab')) this.exitDirect();

    // ---- camera
    let pose: Pose = this.mode === 'direct' ? this.direct.pose : this.commander.pose;
    if (this.state === 'menu' || this.state === 'intro' || this.state === 'over') pose = this.cinematicPose(pose);
    if (tr) {
      tr.t += dt;
      const k = ease(clamp(tr.t / tr.dur, 0, 1));
      cam.position.lerpVectors(tr.from.pos, pose.pos, k);
      cam.position.y += Math.sin(k * Math.PI) * tr.arc;
      cam.quaternion.slerpQuaternions(tr.from.quat, pose.quat, k);
      cam.fov = tr.from.fov + (pose.fov - tr.from.fov) * k + Math.sin(k * Math.PI) * 16;
      this.engine.aberr = Math.sin(k * Math.PI) * 1.4;
      // the host's body disappears only once the camera is inside its head
      this.view.hidden = this.mode === 'direct' && this.direct.firstPerson && k > 0.93 ? this.direct.unit : null;
      if (tr.t >= tr.dur) this.transition = null;
    } else {
      cam.position.copy(pose.pos);
      cam.quaternion.copy(pose.quat);
      cam.fov = pose.fov;
      this.engine.aberr = 0;
      this.view.hidden = this.mode === 'direct' && this.direct.firstPerson ? this.direct.unit : null;
    }
    cam.updateProjectionMatrix();

    if (this.state === 'intro' && this.stateT >= INTRO_TIME) {
      this.state = 'playing';
      this.hud.intro(false);
    }
    if (this.state === 'over' && !this.endShown && this.stateT > 3.2) {
      this.endShown = true;
      const won = this.world.winner === PLAYER;
      const best = this.storage.recordResult(this.world.difficulty.id, won, this.world.time);
      this.hud.showEnd(won, won ? 'The Vanta line has collapsed.' : 'The Aegis command link is gone.', best);
    }

    // ---- shadows & audio follow the action
    if (this.mode === 'direct' && this.direct.unit) {
      const u = this.direct.unit;
      this.engine.shadowFocus.set(u.x, u.y, u.z);
      this.engine.shadowExtent = 55;
      this.audio.lx = u.x;
      this.audio.lz = u.z;
      this.audio.range = 150;
    } else {
      this.engine.shadowFocus.copy(this.commander.focus);
      this.engine.shadowExtent = clamp(this.commander.dist * 1.25, 55, 130);
      this.audio.lx = this.commander.focus.x;
      this.audio.lz = this.commander.focus.z;
      this.audio.range = 70 + this.commander.dist * 1.3;
    }
    this.tmp.set(1, 0, 0).applyQuaternion(cam.quaternion);
    const rl = Math.hypot(this.tmp.x, this.tmp.z) || 1;
    this.audio.rx = this.tmp.x / rl;
    this.audio.rz = this.tmp.z / rl;
    this.heat = Math.max(0, this.heat - dt * 0.22);
    this.audio.setIntensity(playing ? clamp(this.heat, 0, 1) : 0);
    this.audio.update(dt);
    this.underAttackCd -= dt;
    this.coreAttackCd -= dt;

    // ---- render
    if (this.state !== 'paused') this.view.update(this.state === 'menu' ? dt : simDt || dt * 0.0001, cam, this.engine.pointScale);
    this.hud.update(dt);
    this.minimap.update(dt);
    this.overlay.draw();
    this.engine.render(dt);
  }

  /** Scripted cameras: menu orbit, drop-pod intro and the end-of-battle orbit. */
  private cinematicPose(gameplay: Pose): Pose {
    const p = this.introPose;
    const look = this.tmp;
    if (this.state === 'menu') {
      const a = performance.now() * 0.00004 + 2.4;
      look.set(-20, 4, 0);
      p.pos.set(look.x + Math.sin(a) * 120, 34, look.z + Math.cos(a) * 95);
      p.fov = 46;
    } else if (this.state === 'intro') {
      const k = clamp(this.stateT / INTRO_TIME, 0, 1);
      const e = ease(k);
      const a = -2.25 + e * 1.35;
      look.set(BASES[0].spawnX + 8, 2.5 + (1 - e) * 5, 0);
      p.pos.set(look.x + Math.sin(a) * (30 + e * 14), 5 + e * 28, look.z + Math.cos(a) * (30 + e * 14));
      p.fov = 58 - e * 14;
      p.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(p.pos, look, THREE.Object3D.DEFAULT_UP));
      // blend into the gameplay camera over the final stretch
      const b = ease(clamp((k - 0.72) / 0.28, 0, 1));
      p.pos.lerp(gameplay.pos, b);
      p.quat.slerp(gameplay.quat, b);
      p.fov += (gameplay.fov - p.fov) * b;
      return p;
    } else {
      const hq = this.world.hq[this.world.winner === PLAYER ? 1 : 0];
      const a = this.stateT * 0.12 + 1;
      look.set(hq.x, hq.y + 5, hq.z);
      p.pos.set(hq.x + Math.sin(a) * 42, hq.y + 20, hq.z + Math.cos(a) * 42);
      p.fov = 48;
    }
    p.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(p.pos, look, THREE.Object3D.DEFAULT_UP));
    return p;
  }
}
