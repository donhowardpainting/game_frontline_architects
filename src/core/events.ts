/** Minimal typed event emitter used to decouple the simulation from rendering, audio and UI. */
export class Emitter<T extends Record<string, unknown>> {
  private handlers = new Map<keyof T, Array<(p: any) => void>>();
  on<K extends keyof T>(key: K, fn: (payload: T[K]) => void): void {
    let list = this.handlers.get(key);
    if (!list) this.handlers.set(key, (list = []));
    list.push(fn);
  }
  emit<K extends keyof T>(key: K, payload: T[K]): void {
    const list = this.handlers.get(key);
    if (list) for (const fn of list) fn(payload);
  }
  clear(): void {
    this.handlers.clear();
  }
}
