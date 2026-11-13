import { ENEMY, PLAYER } from '../core/config';

export type Owner = -1 | 0 | 1;

/**
 * Territory control point. `progress` runs from -1 (enemy) to +1 (player).
 * Ownership is gained at the extremes and lost when progress crosses zero.
 */
export class CapturePoint {
  owner: Owner = -1;
  progress = 0;
  contested = false;
  nPlayer = 0;
  nEnemy = 0;
  readonly radius = 10;
  constructor(public id: number, public name: string, public x: number, public z: number) {}

  /** Returns the previous owner if ownership changed this tick, otherwise null. */
  update(dt: number, nPlayer: number, nEnemy: number): Owner | null {
    this.nPlayer = nPlayer;
    this.nEnemy = nEnemy;
    this.contested = nPlayer > 0 && nEnemy > 0;
    const diff = nPlayer - nEnemy;
    if (diff === 0) return null;
    const rate = Math.min(4, Math.abs(diff)) * 0.036 * Math.sign(diff);
    const prev = this.owner;
    const before = this.progress;
    this.progress = Math.max(-1, Math.min(1, this.progress + rate * dt));
    if (this.progress >= 1) this.owner = PLAYER;
    else if (this.progress <= -1) this.owner = ENEMY;
    else if (this.owner === PLAYER && this.progress <= 0) this.owner = -1;
    else if (this.owner === ENEMY && this.progress >= 0) this.owner = -1;
    void before;
    return this.owner !== prev ? prev : null;
  }
}
