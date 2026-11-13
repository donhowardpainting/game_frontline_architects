import { MAP } from '../core/config';

export interface Pt {
  x: number;
  z: number;
}

export interface PathOpts {
  team: number;
  /** allow routing through enemy structures (they must then be destroyed) */
  breach?: boolean;
  /** weight applied to the per-team danger field (turret coverage) */
  danger?: number;
  /** vehicles need a wider corridor */
  wide?: boolean;
}

/**
 * Uniform navigation grid with A* pathfinding.
 * Structures are stamped into the grid so that building and destroying them
 * genuinely changes how both armies move.
 */
export class NavGrid {
  readonly cell = MAP.cell;
  readonly w: number;
  readonly h: number;
  readonly n: number;
  readonly ox: number;
  readonly oz: number;
  solid: Uint8Array;
  struct: Int32Array;
  structTeam: Int8Array;
  breachCost: Float32Array;
  danger: [Float32Array, Float32Array];
  version = 1;

  private g: Float32Array;
  private f: Float32Array;
  private parent: Int32Array;
  private seen: Uint32Array;
  private closed: Uint32Array;
  private gen = 0;
  private heap: number[] = [];

  constructor(halfW = MAP.halfW, halfH = MAP.halfH) {
    this.w = Math.round((halfW * 2) / this.cell);
    this.h = Math.round((halfH * 2) / this.cell);
    this.n = this.w * this.h;
    this.ox = -halfW;
    this.oz = -halfH;
    this.solid = new Uint8Array(this.n);
    this.struct = new Int32Array(this.n);
    this.structTeam = new Int8Array(this.n);
    this.breachCost = new Float32Array(this.n);
    this.danger = [new Float32Array(this.n), new Float32Array(this.n)];
    this.g = new Float32Array(this.n);
    this.f = new Float32Array(this.n);
    this.parent = new Int32Array(this.n);
    this.seen = new Uint32Array(this.n);
    this.closed = new Uint32Array(this.n);
  }

  cx(x: number): number {
    const c = Math.floor((x - this.ox) / this.cell);
    return c < 0 ? 0 : c >= this.w ? this.w - 1 : c;
  }
  cz(z: number): number {
    const c = Math.floor((z - this.oz) / this.cell);
    return c < 0 ? 0 : c >= this.h ? this.h - 1 : c;
  }
  cellAt(x: number, z: number): number {
    return this.cz(z) * this.w + this.cx(x);
  }
  centerX(i: number): number {
    return this.ox + ((i % this.w) + 0.5) * this.cell;
  }
  centerZ(i: number): number {
    return this.oz + (Math.floor(i / this.w) + 0.5) * this.cell;
  }
  /** true when nothing (terrain or structure) occupies the cell */
  open(i: number): boolean {
    return this.solid[i] === 0 && this.struct[i] === 0;
  }
  walkable(x: number, z: number): boolean {
    return this.open(this.cellAt(x, z));
  }

  setSolid(i: number, v = 1): void {
    this.solid[i] = v;
  }
  /** Mark every cell whose centre lies within r of (x,z) as solid. */
  stampCircle(x: number, z: number, r: number): void {
    const x0 = this.cx(x - r), x1 = this.cx(x + r), z0 = this.cz(z - r), z1 = this.cz(z + r);
    let any = false;
    for (let j = z0; j <= z1; j++)
      for (let i = x0; i <= x1; i++) {
        const c = j * this.w + i;
        if (Math.hypot(this.centerX(c) - x, this.centerZ(c) - z) <= r) {
          this.solid[c] = 1;
          any = true;
        }
      }
    if (!any) this.solid[this.cellAt(x, z)] = 1;
  }

  addStructure(id: number, team: number, cells: number[], breachCost: number): void {
    for (const c of cells) {
      this.struct[c] = id;
      this.structTeam[c] = team;
      this.breachCost[c] = breachCost;
    }
    this.version++;
  }
  removeStructure(cells: number[]): void {
    for (const c of cells) {
      this.struct[c] = 0;
      this.breachCost[c] = 0;
    }
    this.version++;
  }

  private passable(i: number, o: PathOpts): boolean {
    if (this.solid[i]) return false;
    if (this.struct[i] !== 0 && !(o.breach && this.structTeam[i] !== o.team)) return false;
    if (o.wide) {
      const x = i % this.w, z = (i / this.w) | 0;
      if (x > 0 && this.solid[i - 1]) return false;
      if (x < this.w - 1 && this.solid[i + 1]) return false;
      if (z > 0 && this.solid[i - this.w]) return false;
      if (z < this.h - 1 && this.solid[i + this.w]) return false;
    }
    return true;
  }

  /** Spiral search for the nearest open cell. Returns -1 if none within maxR cells. */
  nearestOpen(x: number, z: number, maxR = 10, o?: PathOpts): number {
    const cx = this.cx(x), cz = this.cz(z);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= maxR; r++) {
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const i = cx + dx, j = cz + dz;
          if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
          const c = j * this.w + i;
          if (o ? !this.passable(c, o) || this.struct[c] !== 0 : !this.open(c)) continue;
          const d = Math.hypot(this.centerX(c) - x, this.centerZ(c) - z);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Straight-line walkability test used for path smoothing. */
  lineClear(x0: number, z0: number, x1: number, z1: number, o?: PathOpts, avoid?: Float32Array | null): boolean {
    const d = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(d / (this.cell * 0.4)));
    let pcx = this.cx(x0), pcz = this.cz(z0);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const ccx = this.cx(x0 + (x1 - x0) * t), ccz = this.cz(z0 + (z1 - z0) * t);
      if (ccx === pcx && ccz === pcz) continue;
      const ok = (c: number) => this.open(c) && (!o || this.passable(c, o)) && (!avoid || avoid[c] === 0);
      if (!ok(ccz * this.w + ccx)) return false;
      if (ccx !== pcx && ccz !== pcz) {
        if (!ok(pcz * this.w + ccx) || !ok(ccz * this.w + pcx)) return false;
      }
      pcx = ccx;
      pcz = ccz;
    }
    return true;
  }

  private heapPush(i: number): void {
    const h = this.heap, f = this.f;
    h.push(i);
    let k = h.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (f[h[p]] <= f[h[k]]) break;
      const t = h[p];
      h[p] = h[k];
      h[k] = t;
      k = p;
    }
  }
  private heapPop(): number {
    const h = this.heap, f = this.f;
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let k = 0;
      for (;;) {
        const l = k * 2 + 1, r = l + 1;
        let m = k;
        if (l < h.length && f[h[l]] < f[h[m]]) m = l;
        if (r < h.length && f[h[r]] < f[h[m]]) m = r;
        if (m === k) break;
        const t = h[m];
        h[m] = h[k];
        h[k] = t;
        k = m;
      }
    }
    return top;
  }

  /**
   * A* over the grid. Always returns a usable path: if the goal cannot be
   * reached the path leads to the closest reachable cell.
   * Waypoints lying inside an (enemy) structure cell are preserved so the
   * follower knows it has to breach.
   */
  findPath(sx: number, sz: number, gx: number, gz: number, o: PathOpts): Pt[] {
    let start = this.cellAt(sx, sz);
    let goal = this.cellAt(gx, gz);
    let exactGoal = true;
    if (!this.passable(goal, o) || this.struct[goal] !== 0) {
      goal = this.nearestOpen(gx, gz, 14, o);
      exactGoal = false;
      if (goal < 0) return [];
    }
    if (!this.passable(start, o)) {
      const s = this.nearestOpen(sx, sz, 8, o);
      if (s < 0) return [];
      start = s;
    }
    if (start === goal) return [exactGoal ? { x: gx, z: gz } : { x: this.centerX(goal), z: this.centerZ(goal) }];

    const gen = ++this.gen;
    const { g, f, parent, seen, closed, w, h } = this;
    const gxC = goal % w, gzC = (goal / w) | 0;
    const heur = (i: number) => {
      const dx = Math.abs((i % w) - gxC), dz = Math.abs(((i / w) | 0) - gzC);
      return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
    };
    this.heap.length = 0;
    g[start] = 0;
    f[start] = heur(start);
    parent[start] = -1;
    seen[start] = gen;
    this.heapPush(start);
    const dmap = o.danger ? this.danger[o.team] : null;
    let best = start, bestH = heur(start);
    let found = false;

    while (this.heap.length) {
      const cur = this.heapPop();
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      if (cur === goal) {
        found = true;
        break;
      }
      const x = cur % w, z = (cur / w) | 0;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
          const nb = nz * w + nx;
          if (closed[nb] === gen || !this.passable(nb, o)) continue;
          if (dx && dz) {
            // no corner cutting
            if (!this.passable(z * w + nx, o) || !this.passable(nz * w + x, o)) continue;
            if (this.struct[z * w + nx] || this.struct[nz * w + x]) continue;
          }
          let cost = dx && dz ? 1.4142 : 1;
          if (this.struct[nb]) cost += this.breachCost[nb];
          if (dmap) cost += dmap[nb] * o.danger!;
          const ng = g[cur] + cost;
          if (seen[nb] !== gen || ng < g[nb]) {
            g[nb] = ng;
            const hh = heur(nb);
            f[nb] = ng + hh;
            parent[nb] = cur;
            seen[nb] = gen;
            if (hh < bestH) {
              bestH = hh;
              best = nb;
            }
            this.heapPush(nb);
          }
        }
    }

    const end = found ? goal : best;
    const cells: number[] = [];
    for (let c = end; c !== -1; c = parent[c]) cells.push(c);
    cells.reverse();

    // String-pull smoothing. Structure cells are kept as hard waypoints.
    const out: Pt[] = [];
    let anchorX = sx, anchorZ = sz;
    let i = 1;
    while (i < cells.length) {
      let j = i;
      if (!this.struct[cells[i]]) {
        while (
          j + 1 < cells.length &&
          !this.struct[cells[j + 1]] &&
          this.lineClear(anchorX, anchorZ, this.centerX(cells[j + 1]), this.centerZ(cells[j + 1]), o.wide ? o : undefined, dmap)
        )
          j++;
      }
      anchorX = this.centerX(cells[j]);
      anchorZ = this.centerZ(cells[j]);
      out.push({ x: anchorX, z: anchorZ });
      i = j + 1;
    }
    if (found && exactGoal && out.length) out[out.length - 1] = { x: gx, z: gz };
    return out;
  }
}
