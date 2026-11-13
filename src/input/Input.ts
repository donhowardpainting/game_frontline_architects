/** Raw input state: keys, mouse, wheel, pointer lock. Controllers poll this each frame. */
export class Input {
  keys = new Set<string>();
  pressed = new Set<string>();
  mx = 0;
  my = 0;
  dx = 0;
  dy = 0;
  wheel = 0;
  buttons = [false, false, false];
  down = [false, false, false];
  up = [false, false, false];
  dbl = false;
  shift = false;
  ctrl = false;
  locked = false;
  everLocked = false;
  onLockLost: (() => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1', 'Home'].includes(e.code) || (e.ctrlKey && /Digit\d/.test(e.code))) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
      this.shift = e.shiftKey;
      this.ctrl = e.ctrlKey || e.metaKey;
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.shift = e.shiftKey;
      this.ctrl = e.ctrlKey || e.metaKey;
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.buttons.fill(false);
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button > 2) return;
      this.buttons[e.button] = true;
      this.down[e.button] = true;
      this.shift = e.shiftKey;
      this.ctrl = e.ctrlKey || e.metaKey;
      e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button > 2) return;
      if (this.buttons[e.button]) this.up[e.button] = true;
      this.buttons[e.button] = false;
    });
    canvas.addEventListener('dblclick', () => (this.dbl = true));
    window.addEventListener('mousemove', (e) => {
      this.mx = e.clientX;
      this.my = e.clientY;
      const mx = e.movementX || 0, my = e.movementY || 0;
      // Pointer lock occasionally reports a huge bogus jump (browser warp); drop those.
      if (this.locked && (Math.abs(mx) > 350 || Math.abs(my) > 250)) return;
      this.dx += mx;
      this.dy += my;
    });
    canvas.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === canvas;
      if (this.locked) this.everLocked = true;
      if (was && !this.locked) this.onLockLost?.();
    });
  }

  lock(): void {
    if (this.locked) return;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* pointer lock unavailable: mouse-look still works from movement deltas */
    }
  }
  unlock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }
  key(code: string): boolean {
    return this.keys.has(code);
  }
  hit(code: string): boolean {
    return this.pressed.has(code);
  }
  endFrame(): void {
    this.pressed.clear();
    this.dx = this.dy = this.wheel = 0;
    this.down.fill(false);
    this.up.fill(false);
    this.dbl = false;
  }
}
