export interface Settings {
  quality: 'low' | 'medium' | 'high';
  volume: number;
  music: number;
  sensitivity: number;
  difficulty: string;
  edgeScroll: boolean;
}
export interface Records {
  wins: number;
  losses: number;
  best: Record<string, number>;
  tutorialDone: boolean;
}

const KEY = 'frontline-architects/v1';
const defaults = {
  settings: { quality: 'high', volume: 0.8, music: 0.6, sensitivity: 1, difficulty: 'veteran', edgeScroll: false } as Settings,
  records: { wins: 0, losses: 0, best: {}, tutorialDone: false } as Records,
};

/** localStorage-backed persistence for settings and battle records. */
export class Storage {
  settings: Settings = { ...defaults.settings };
  records: Records = { ...defaults.records, best: {} };

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        Object.assign(this.settings, d.settings);
        Object.assign(this.records, d.records);
      }
    } catch {
      /* storage unavailable */
    }
  }
  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ settings: this.settings, records: this.records }));
    } catch {
      /* ignore */
    }
  }
  recordResult(difficulty: string, won: boolean, time: number): boolean {
    let best = false;
    if (won) {
      this.records.wins++;
      const prev = this.records.best[difficulty];
      if (prev === undefined || time < prev) {
        this.records.best[difficulty] = time;
        best = true;
      }
    } else this.records.losses++;
    this.save();
    return best;
  }
}
