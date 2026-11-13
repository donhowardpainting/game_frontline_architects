/**
 * Fully procedural audio (no asset files): weapons, explosions, UI, rain,
 * thunder and a slow generative score. Positional sounds are attenuated and
 * panned relative to a listener the game moves with the camera.
 */
export class AudioSys {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private noise!: AudioBuffer;
  private last = new Map<string, number>();
  private engineOsc: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private musicTimer = 0;
  private step = 0;
  private intensity = 0;
  lx = 0;
  lz = 0;
  /** unit right vector of the listener on the ground plane */
  rx = 1;
  rz = 0;
  range = 120;
  volume = 0.8;
  musicVolume = 0.6;

  init(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 5;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = this.musicVolume * 0.5;
    this.music.connect(this.master);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // rain bed
    const rain = ctx.createBufferSource();
    rain.buffer = this.noise;
    rain.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 7000;
    const rg = ctx.createGain();
    rg.gain.value = 0.045;
    rain.connect(hp).connect(lp).connect(rg).connect(this.master);
    rain.start();
    // wind
    const wind = ctx.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;
    wind.playbackRate.value = 0.5;
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 320;
    wf.Q.value = 0.7;
    const wg = ctx.createGain();
    wg.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lg = ctx.createGain();
    lg.gain.value = 180;
    lfo.connect(lg).connect(wf.frequency);
    lfo.start();
    wind.connect(wf).connect(wg).connect(this.master);
    wind.start();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.value = v;
  }
  setMusicVolume(v: number): void {
    this.musicVolume = v;
    if (this.ctx) this.music.gain.value = v * 0.5;
  }
  setIntensity(v: number): void {
    this.intensity += (v - this.intensity) * 0.05;
  }

  private spatial(x?: number, z?: number): { gain: number; pan: number } | null {
    if (x === undefined || z === undefined) return { gain: 1, pan: 0 };
    const dx = x - this.lx, dz = z - this.lz;
    const d = Math.hypot(dx, dz);
    if (d > this.range) return null;
    const g = Math.pow(1 - d / this.range, 1.8);
    const pan = d > 1 ? Math.max(-0.8, Math.min(0.8, ((dx * this.rx + dz * this.rz) / d) * Math.min(1, d / 20))) : 0;
    return { gain: g, pan };
  }

  private out(gain: number, pan: number, dest?: AudioNode): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = gain;
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(dest ?? this.sfx);
    } else g.connect(dest ?? this.sfx);
    return g;
  }

  private burst(dest: AudioNode, dur: number, freq: number, q: number, type: BiquadFilterType, vol: number, freqEnd?: number, rate = 1): void {
    const ctx = this.ctx!, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rate;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  private tone(dest: AudioNode, type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0): void {
    const ctx = this.ctx!, t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Play a named sound; world-space position optional. */
  play(name: string, x?: number, z?: number, vol = 1): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const minGap = name === 'rifle' || name === 'erifle' || name === 'turret' ? 0.045 : name === 'cutter' ? 0.12 : 0.02;
    if (now - (this.last.get(name) ?? -1) < minGap) return;
    const sp = this.spatial(x, z);
    if (!sp) return;
    this.last.set(name, now);
    const o = this.out(sp.gain * vol, sp.pan);
    const far = 1 - sp.gain;
    switch (name) {
      case 'rifle':
        this.burst(o, 0.09, 2600 - far * 1500, 0.8, 'bandpass', 0.5, 700);
        this.tone(o, 'square', 190, 60, 0.07, 0.16);
        break;
      case 'prifle':
        this.burst(o, 0.12, 2200, 0.7, 'bandpass', 0.9, 500);
        this.tone(o, 'sawtooth', 160, 45, 0.1, 0.4);
        this.burst(o, 0.25, 500, 0.5, 'lowpass', 0.25, 120);
        break;
      case 'erifle':
        this.burst(o, 0.1, 1500 - far * 700, 2.5, 'bandpass', 0.5, 500);
        this.tone(o, 'sawtooth', 420, 110, 0.09, 0.14);
        break;
      case 'turret':
        this.burst(o, 0.07, 1900, 1.2, 'bandpass', 0.5, 800);
        this.tone(o, 'square', 120, 70, 0.06, 0.2);
        break;
      case 'cutter':
        this.tone(o, 'sawtooth', 900, 1400, 0.12, 0.08);
        this.burst(o, 0.12, 5000, 3, 'bandpass', 0.2);
        break;
      case 'rocket':
        this.burst(o, 0.7, 900, 0.6, 'bandpass', 0.6, 250);
        this.tone(o, 'sawtooth', 200, 80, 0.5, 0.15);
        break;
      case 'cannon':
        this.burst(o, 0.5, 700, 0.5, 'lowpass', 1.2, 90);
        this.tone(o, 'sine', 110, 32, 0.45, 0.9);
        break;
      case 'explosion':
        this.burst(o, 0.9, 900, 0.4, 'lowpass', 1.3, 60);
        this.tone(o, 'sine', 90, 28, 0.7, 0.9);
        this.burst(o, 0.25, 3000, 0.5, 'highpass', 0.3);
        break;
      case 'bigboom':
        this.burst(o, 2.4, 1200, 0.3, 'lowpass', 1.6, 40);
        this.tone(o, 'sine', 70, 20, 1.8, 1.2);
        this.tone(o, 'triangle', 140, 30, 1.2, 0.6, 0.05);
        break;
      case 'collapse':
        this.burst(o, 0.8, 600, 0.5, 'lowpass', 1.0, 80);
        this.burst(o, 0.5, 2500, 1, 'bandpass', 0.3, 600, 0.6);
        break;
      case 'podland':
        this.burst(o, 0.7, 500, 0.5, 'lowpass', 1.3, 60);
        this.tone(o, 'sine', 80, 26, 0.5, 1.0);
        this.tone(o, 'square', 600, 200, 0.15, 0.08, 0.1);
        break;
      case 'strike':
        this.tone(o, 'sawtooth', 200, 1800, 2.6, 0.12);
        this.tone(o, 'sine', 1200, 2400, 2.6, 0.06);
        break;
      case 'warp':
        this.tone(o, 'sine', 1400, 220, 0.4, 0.2);
        this.burst(o, 0.3, 3000, 4, 'bandpass', 0.15, 600);
        break;
      case 'death':
        this.burst(o, 0.2, 700, 1, 'bandpass', 0.3, 200);
        break;
      case 'built':
        this.tone(o, 'triangle', 520, 520, 0.12, 0.2);
        this.tone(o, 'triangle', 780, 780, 0.2, 0.2, 0.1);
        break;
      case 'hit':
        this.tone(o, 'square', 1500, 900, 0.05, 0.14);
        break;
      case 'kill':
        this.tone(o, 'square', 900, 900, 0.07, 0.16);
        this.tone(o, 'square', 1350, 1350, 0.14, 0.16, 0.07);
        break;
      case 'hurt':
        this.burst(o, 0.18, 300, 1, 'lowpass', 0.7, 90);
        break;
      case 'reload':
        this.burst(o, 0.04, 3000, 3, 'bandpass', 0.3);
        this.tone(o, 'square', 300, 240, 0.05, 0.08, 0.25);
        break;
      case 'grenade':
        this.burst(o, 0.15, 1200, 1, 'bandpass', 0.25, 400);
        break;
      case 'click':
        this.tone(o, 'square', 880, 660, 0.04, 0.07);
        break;
      case 'order':
        this.tone(o, 'triangle', 660, 880, 0.07, 0.12);
        break;
      case 'place':
        this.tone(o, 'triangle', 330, 440, 0.09, 0.16);
        this.burst(o, 0.06, 4000, 2, 'bandpass', 0.1);
        break;
      case 'error':
        this.tone(o, 'sawtooth', 160, 120, 0.16, 0.14);
        break;
      case 'linkIn':
        this.tone(o, 'sawtooth', 90, 900, 0.7, 0.18);
        this.burst(o, 0.8, 300, 1.5, 'bandpass', 0.5, 5000);
        this.tone(o, 'sine', 55, 40, 0.9, 0.5, 0.55);
        break;
      case 'linkOut':
        this.tone(o, 'sawtooth', 900, 110, 0.6, 0.16);
        this.burst(o, 0.7, 5000, 1.5, 'bandpass', 0.4, 300);
        break;
      case 'capture':
        [392, 523, 659, 784].forEach((f, i) => this.tone(o, 'triangle', f, f, 0.35, 0.2, i * 0.09));
        break;
      case 'lost':
        [392, 330, 262, 196].forEach((f, i) => this.tone(o, 'sawtooth', f, f * 0.98, 0.4, 0.12, i * 0.12));
        break;
      case 'alert':
        this.tone(o, 'square', 740, 740, 0.1, 0.1);
        this.tone(o, 'square', 740, 740, 0.1, 0.1, 0.16);
        break;
      case 'victory':
        [262, 330, 392, 523, 659, 784, 1047].forEach((f, i) => this.tone(o, 'triangle', f, f, 0.9, 0.22, i * 0.13));
        break;
      case 'defeat':
        [330, 294, 247, 196, 165, 131].forEach((f, i) => this.tone(o, 'sawtooth', f, f * 0.97, 1.0, 0.14, i * 0.22));
        break;
      case 'thunder':
        this.burst(o, 3.2, 400, 0.3, 'lowpass', 0.9, 50, 0.5);
        this.burst(o, 0.3, 2000, 0.5, 'highpass', 0.15);
        break;
    }
  }

  /** Continuous engine hum while driving a vehicle (level 0 disables). */
  engine(level: number): void {
    if (!this.ctx) return;
    if (level > 0 && !this.engineOsc) {
      this.engineOsc = this.ctx.createOscillator();
      this.engineOsc.type = 'sawtooth';
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 260;
      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.value = 0;
      this.engineOsc.connect(f).connect(this.engineGain).connect(this.sfx);
      this.engineOsc.start();
    }
    if (this.engineOsc && this.engineGain) {
      const t = this.ctx.currentTime;
      this.engineGain.gain.setTargetAtTime(level > 0 ? 0.1 + level * 0.07 : 0, t, 0.1);
      this.engineOsc.frequency.setTargetAtTime(38 + level * 34, t, 0.15);
    }
  }

  /** Generative score: a dark pad progression plus a pulse that rises with combat intensity. */
  update(dt: number): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.musicTimer -= dt;
    if (this.musicTimer > 0) return;
    const beat = 0.5;
    this.musicTimer = beat;
    const roots = [55, 55, 65.4, 49, 55, 73.4, 65.4, 49];
    const bar = Math.floor(this.step / 8) % roots.length;
    const root = roots[bar];
    const pos = this.step % 8;
    const m = this.music;
    if (pos === 0) {
      for (const [mul, v] of [[1, 0.2], [1.5, 0.1], [2, 0.09], [2.4, 0.06], [3, 0.04]] as Array<[number, number]>) {
        const ctx = this.ctx, t = ctx.currentTime;
        const o = ctx.createOscillator();
        o.type = mul < 2 ? 'sawtooth' : 'triangle';
        o.frequency.value = root * mul * (1 + (Math.random() - 0.5) * 0.004);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 380 + this.intensity * 600;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(v, t + 1.4);
        g.gain.linearRampToValueAtTime(0.0001, t + beat * 8 + 1.2);
        o.connect(f).connect(g).connect(m);
        o.start(t);
        o.stop(t + beat * 8 + 1.4);
      }
    }
    if (this.intensity > 0.25) {
      if (pos % 2 === 0) this.tone(m, 'sine', 95, 38, 0.22, 0.5 * this.intensity);
      if (this.intensity > 0.5 && pos % 2 === 1) this.burst(m, 0.05, 6000, 1, 'highpass', 0.12 * this.intensity);
      const arp = [1, 1.5, 2, 3, 2, 1.5, 2.4, 1.5][pos];
      this.tone(m, 'square', root * 2 * arp, root * 2 * arp, 0.16, 0.035 * this.intensity);
    }
    this.step++;
  }
}
