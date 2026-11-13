import * as THREE from 'three';
import { PLAYER } from '../core/config';
import type { Game } from '../core/Game';

/** 2D canvas drawn over the 3D view: health bars, objective markers, build progress. */
export class Overlay {
  private cv = document.getElementById('overlay') as HTMLCanvasElement;
  private c = this.cv.getContext('2d')!;
  private v = new THREE.Vector3();
  private dpr = 1;

  constructor(private game: Game) {
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }
  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cv.width = window.innerWidth * this.dpr;
    this.cv.height = window.innerHeight * this.dpr;
  }
  private project(x: number, y: number, z: number): { x: number; y: number; d: number } | null {
    const cam = this.game.engine.camera;
    this.v.set(x, y, z);
    const d = this.v.distanceTo(cam.position);
    this.v.project(cam);
    if (this.v.z > 1 || Math.abs(this.v.x) > 1.2 || Math.abs(this.v.y) > 1.2) return null;
    return { x: (this.v.x * 0.5 + 0.5) * window.innerWidth, y: (-this.v.y * 0.5 + 0.5) * window.innerHeight, d };
  }
  private bar(x: number, y: number, w: number, frac: number, color: string, h = 4): void {
    const c = this.c;
    c.fillStyle = 'rgba(0,0,0,.65)';
    c.fillRect(x - w / 2 - 1, y - 1, w + 2, h + 2);
    c.fillStyle = color;
    c.fillRect(x - w / 2, y, w * Math.max(0, Math.min(1, frac)), h);
  }

  draw(): void {
    const g = this.game, w = g.world, c = this.c;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (g.state !== 'playing' && g.state !== 'intro') return;
    const direct = g.mode === 'direct';
    const hover = g.commander.hover;

    for (const u of w.units) {
      if (!u.alive || u.spawnDelay > 0 || u === g.view.hidden) continue;
      const sel = g.view.selected.has(u);
      const hurt = u.hp < u.maxHp;
      if (direct) {
        if (u.team === PLAYER && !u.controlled) {
          const p = this.project(u.x, u.y + (u.def.infantry ? 2.7 : 3.9), u.z);
          if (!p || p.d > 150) continue;
          c.fillStyle = g.direct.linkTarget === u ? '#ffc14a' : 'rgba(79,227,255,.85)';
          c.beginPath();
          c.moveTo(p.x, p.y);
          c.lineTo(p.x - 5, p.y - 8);
          c.lineTo(p.x + 5, p.y - 8);
          c.fill();
          if (hurt) this.bar(p.x, p.y - 14, 26, u.hp / u.maxHp, '#4fe3ff', 3);
        } else if (u.team !== PLAYER && u.sinceHit < 2.5) {
          const p = this.project(u.x, u.y + (u.def.infantry ? 2.7 : 3.9), u.z);
          if (p) this.bar(p.x, p.y - 6, u.def.infantry ? 34 : 60, u.hp / u.maxHp, '#ff3b55', 4);
        }
        continue;
      }
      if (!sel && !hurt && u !== hover) continue;
      const p = this.project(u.x, u.y + (u.def.infantry ? 2.7 : 3.9), u.z);
      if (!p) continue;
      const k = Math.max(0.6, Math.min(1.5, 70 / p.d));
      this.bar(p.x, p.y, (u.def.infantry ? 26 : 46) * k, u.hp / u.maxHp, u.team === PLAYER ? (u.hp < u.maxHp * 0.35 ? '#ffb347' : '#59ffb0') : '#ff3b55', 3.5 * k);
    }

    for (const s of w.structures) {
      const sel = g.view.selectedStruct === s || hover === s;
      if (s.done && s.hp >= s.maxHp && !sel) continue;
      const p = this.project(s.x, s.y + s.def.size[1] + (s.kind === 'hq' ? 9 : 1.2), s.z);
      if (!p || (direct && p.d > 60)) continue;
      const k = Math.max(0.6, Math.min(1.4, 70 / p.d));
      const wd = (s.kind === 'hq' ? 90 : 20 + s.def.cells * 10) * k;
      if (!s.done) this.bar(p.x, p.y, wd, s.progress, '#ffc14a', 3 * k);
      else this.bar(p.x, p.y, wd, s.hp / s.maxHp, s.team === PLAYER ? '#4fe3ff' : '#ff3b55', 3.5 * k);
    }

    // objective markers
    c.textAlign = 'center';
    for (const pt of w.points) {
      const p = this.project(pt.x, w.height(pt.x, pt.z) + 9.5, pt.z);
      if (!p) continue;
      const col = pt.owner === 0 ? '#4fe3ff' : pt.owner === 1 ? '#ff3b55' : '#c9d2dc';
      const r = direct ? 15 : Math.max(11, Math.min(20, 900 / p.d));
      c.beginPath();
      c.arc(p.x, p.y, r, 0, 6.28);
      c.fillStyle = 'rgba(8,12,18,.72)';
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = col;
      c.stroke();
      if (Math.abs(pt.progress) < 1 && pt.progress !== 0) {
        c.beginPath();
        c.arc(p.x, p.y, r + 3.5, -Math.PI / 2, -Math.PI / 2 + Math.abs(pt.progress) * 6.283);
        c.strokeStyle = pt.progress > 0 ? '#4fe3ff' : '#ff3b55';
        c.lineWidth = 3;
        c.stroke();
      }
      c.fillStyle = pt.contested && Math.floor(performance.now() / 300) % 2 ? '#ffc14a' : col;
      c.font = `bold ${Math.round(r * 1.05)}px system-ui, sans-serif`;
      c.fillText(pt.name[0], p.x, p.y + r * 0.38);
      if (direct) {
        c.font = '11px system-ui, sans-serif';
        c.fillStyle = 'rgba(255,255,255,.8)';
        c.fillText(`${Math.round(p.d)}m`, p.x, p.y + r + 14);
      }
    }

    if (direct && g.direct.linkTarget) {
      const u = g.direct.linkTarget;
      const p = this.project(u.x, u.y + 1.2, u.z);
      if (p) {
        const r = Math.max(14, Math.min(60, 900 / p.d));
        c.strokeStyle = '#ffc14a';
        c.lineWidth = 2;
        for (let i = 0; i < 4; i++) {
          const sx = i % 2 ? 1 : -1, sy = i < 2 ? 1 : -1;
          c.beginPath();
          c.moveTo(p.x + sx * r, p.y + sy * r * 0.5);
          c.lineTo(p.x + sx * r, p.y + sy * r);
          c.lineTo(p.x + sx * r * 0.5, p.y + sy * r);
          c.stroke();
        }
      }
    }
  }
}
