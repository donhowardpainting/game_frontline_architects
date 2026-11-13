import { BUILDABLE, DIFFICULTIES, ECON, MAP, PLAYER, STRUCT_DEFS, TRAINABLE, UNIT_DEFS, type StructKind, type UnitKind } from '../core/config';
import type { Game } from '../core/Game';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmtTime = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

const ICON: Record<string, string> = {
  wall: '▮', barricade: '▂', turret: '✛', bunker: '⬢', rifle: '➤', engineer: '⚒', heavy: '✦', tank: '▰', sapper: '✂', hq: '⌂',
};
const BUILD_KEYS = ['Z', 'X', 'C', 'V'];
const TRAIN_KEYS = ['T', 'Y', 'U', 'I'];

const HINTS = [
  { id: 'move', text: '<b>Drag</b> to select your squad, then <b>right-click</b> a capture point to seize it.' },
  { id: 'build', text: 'Select an <b>Architect</b> and place a <b>Sentry</b> [C] or <b>Ramparts</b> [Z] — enemies route around kill-zones or breach them.' },
  { id: 'link', text: 'Select any unit and press <b>F</b> — <b>become</b> that soldier. The battle keeps running.' },
  { id: 'return', text: '<b>TAB</b> returns to command. Look at an ally and press <b>F</b> to jump bodies. <b>C</b> orders your squad forward.' },
];

/** All DOM UI: resource bar, command card, direct-control HUD, menus and notifications. */
export class HUD {
  private root = $('ui');
  private acc = 0;
  private hintStep = 0;
  private hintDone = new Set<string>();
  private bannerT = 0;
  private lastSel = '';

  constructor(private game: Game) {
    this.root.innerHTML = this.template();
    this.bind();
  }

  private template(): string {
    const buildBtns = BUILDABLE.map((k, i) => {
      const d = STRUCT_DEFS[k];
      return `<button class="cbtn" data-build="${k}" data-tip="<b>${d.name}</b> — ${d.desc}"><span class="ic">${ICON[k]}</span><span class="nm">${d.name}</span><span class="cost">◆${d.cost}</span><kbd>${BUILD_KEYS[i]}</kbd></button>`;
    }).join('');
    const trainBtns = TRAINABLE.map((k, i) => {
      const d = UNIT_DEFS[k];
      return `<button class="cbtn" data-train="${k}" data-tip="<b>${d.name}</b> — ${d.role}. ${d.hp} HP, pop ${d.pop}"><span class="ic">${ICON[k]}</span><span class="nm">${d.name}</span><span class="cost">◆${d.cost}</span><kbd>${TRAIN_KEYS[i]}</kbd></button>`;
    }).join('');
    const diffs = DIFFICULTIES.map((d) => `<button class="opt" data-diff="${d.id}"><b>${d.name}</b><small>${d.blurb}</small></button>`).join('');
    const settings = `
      <div class="settings">
        <label>Graphics <select data-set="quality"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
        <label>Volume <input type="range" min="0" max="1" step="0.05" data-set="volume"></label>
        <label>Music <input type="range" min="0" max="1" step="0.05" data-set="music"></label>
        <label>Look sensitivity <input type="range" min="0.3" max="2.5" step="0.05" data-set="sensitivity"></label>
        <label class="chk"><input type="checkbox" data-set="edgeScroll"> Edge scrolling</label>
      </div>`;
    const controls = `
      <div class="controls">
        <div><h4>Commander Mode</h4>
          <p><kbd>LMB</kbd> select · drag box · double-click type</p>
          <p><kbd>RMB</kbd> move / attack / assist build <small>(Ctrl = assault-move)</small></p>
          <p><kbd>WASD</kbd> pan · <kbd>Wheel</kbd> zoom · <kbd>Q</kbd><kbd>E</kbd> rotate</p>
          <p><kbd>Z</kbd><kbd>X</kbd><kbd>C</kbd><kbd>V</kbd> build · drag for wall lines · <kbd>R</kbd> rotate</p>
          <p><kbd>T</kbd><kbd>Y</kbd><kbd>U</kbd><kbd>I</kbd> train · <kbd>O</kbd> orbital strike · <kbd>H</kbd> hold</p>
          <p><kbd>F</kbd>/<kbd>Tab</kbd> take direct control · <kbd>Ctrl+1-5</kbd> groups</p></div>
        <div><h4>Direct Control</h4>
          <p><kbd>WASD</kbd> move · <kbd>Shift</kbd> sprint · <kbd>Space</kbd> jump</p>
          <p><kbd>LMB</kbd> fire · <kbd>RMB</kbd> aim / tank MG · <kbd>R</kbd> reload</p>
          <p><kbd>G</kbd> grenade · <kbd>V</kbd> third person</p>
          <p><kbd>F</kbd> jump into the ally you are looking at</p>
          <p><kbd>C</kbd> squad assault there · <kbd>X</kbd> regroup on me</p>
          <p>Architect: <kbd>1-4</kbd> blueprint · <kbd>LMB</kbd> place · hold <kbd>E</kbd> build</p>
          <p><kbd>Tab</kbd> return to Commander Mode</p></div>
      </div>`;
    return `
    <div id="top">
      <div class="res">
        <span class="stat" data-tip="Supply — earned from the Command Core and every capture point you hold"><i>◆</i><b id="supply">0</b><small id="income"></small></span>
        <span class="stat" data-tip="Army size / capacity. Each point you hold adds ${ECON.pointPop}."><i>▲</i><b id="pop">0</b></span>
      </div>
      <div class="dom" data-tip="Battlefield dominance. Hold more points than the enemy to push it. Fill it — or destroy their Spire — to win.">
        <div class="pips"><i id="pip0">A</i><i id="pip1">B</i><i id="pip2">C</i></div>
        <div class="bar"><div id="domE"></div><div id="domP"></div><span class="mid"></span></div>
        <div class="labels"><span class="e">VANTA</span><span id="domText"></span><span class="p">AEGIS</span></div>
      </div>
      <div class="right"><span id="hqhp" data-tip="Command Core integrity"></span><span id="clock">00:00</span><button id="btnPause" data-tip="Pause (Esc)">❚❚</button></div>
    </div>
    <div id="hint"></div>
    <div id="alerts"></div>
    <div id="banner"></div>
    <div id="toasts"></div>
    <div id="modeTag"></div>
    <div id="dragbox"></div>
    <div id="mapwrap"><canvas id="minimap" width="236" height="164"></canvas></div>
    <div id="cmd">
      <div id="selinfo"></div>
      <div id="card">
        <div class="row"><span class="lbl">BUILD</span>${buildBtns}</div>
        <div class="row"><span class="lbl">DEPLOY</span>${trainBtns}</div>
        <div class="row tools">
          <button class="cbtn wide" id="btnStrike" data-tip="<b>Orbital Strike</b> — devastates everything in the zone after ${ECON.strikeDelay}s. Yours included."><span class="ic">☄</span><span class="nm">Orbital Strike</span><span class="cost">◆${ECON.strikeCost}</span><kbd>O</kbd><em id="strikeCd"></em></button>
          <button class="cbtn wide" id="btnLink" data-tip="<b>Neural Link</b> — take direct control of the selected unit"><span class="ic">◉</span><span class="nm">Direct Control</span><kbd>F</kbd></button>
          <button class="cbtn wide" id="btnSite" data-tip="Where reinforcements arrive. Build a Relay Bunker to deploy at the front."><span class="ic">⇲</span><span class="nm" id="siteName">Deploy: Core</span></button>
        </div>
        <div id="queue"></div>
      </div>
    </div>
    <div id="direct">
      <div id="cross"><i></i><i></i><i></i><i></i><b></b><span id="hitm"></span></div>
      <div id="dPrompt"></div>
      <div id="dLeft"><div id="dName"></div><div class="hpbar"><div id="dHp"></div></div><div id="dPresence"></div></div>
      <div id="dRight"><div id="dWeapon"></div><div id="dAmmo"></div><div id="dSub"></div></div>
      <div id="dBuild"></div>
      <div id="dKeys"><span>Command view <kbd>Tab</kbd></span><span>Link to ally <kbd>F</kbd></span><span>Squad assault <kbd>C</kbd></span><span>Regroup <kbd>X</kbd></span><span>Grenade <kbd>G</kbd></span><span>Third person <kbd>V</kbd></span></div>
    </div>
    <div id="linkfx"><span></span></div>
    <div id="intro"><h2>OPERATION FIRST LIGHT</h2><p>Secure ALPHA, BRAVO and CHARLIE. Hold the line. Break the Spire.</p><small>click to skip</small></div>
    <div id="tooltip"></div>

    <div id="menu" class="screen">
      <div class="panel">
        <h1>FRONTLINE <span>ARCHITECTS</span></h1>
        <h3>Command the war. Fight the battle.</h3>
        <div class="diffs">${diffs}</div>
        <button class="big" id="btnStart">DEPLOY</button>
        <div id="records"></div>
        ${controls}
        ${settings}
      </div>
    </div>
    <div id="pause" class="screen hidden">
      <div class="panel small">
        <h2>PAUSED</h2>
        <button class="big" id="btnResume">RESUME</button>
        <button class="mid" id="btnRestart">RESTART BATTLE</button>
        <button class="mid" id="btnQuit">MAIN MENU</button>
        ${controls}
        ${settings}
      </div>
    </div>
    <div id="end" class="screen hidden">
      <div class="panel small">
        <h1 id="endTitle"></h1>
        <h3 id="endReason"></h3>
        <div id="endStats"></div>
        <button class="big" id="btnAgain">REDEPLOY</button>
        <button class="mid" id="btnMenu">MAIN MENU</button>
      </div>
    </div>`;
  }

  private bind(): void {
    const g = this.game;
    this.root.querySelectorAll<HTMLElement>('[data-build]').forEach((b) =>
      b.addEventListener('click', () => g.commander.setBuild(b.dataset.build as StructKind)));
    this.root.querySelectorAll<HTMLElement>('[data-train]').forEach((b) =>
      b.addEventListener('click', () => g.train(b.dataset.train as UnitKind)));
    $('btnStrike').addEventListener('click', () => g.commander.setStrike());
    $('btnLink').addEventListener('click', () => {
      const u = g.commander.selection()[0];
      if (u) g.enterDirect(u);
      else this.toast('Select a unit first');
    });
    $('btnSite').addEventListener('click', () => g.cycleSpawnSite());
    $('btnPause').addEventListener('click', () => g.togglePause());
    $('btnResume').addEventListener('click', () => g.togglePause());
    $('btnRestart').addEventListener('click', () => g.restart(true));
    $('btnQuit').addEventListener('click', () => g.restart(false));
    $('btnAgain').addEventListener('click', () => g.restart(true));
    $('btnMenu').addEventListener('click', () => g.restart(false));
    $('btnStart').addEventListener('click', () => g.start());
    $('intro').addEventListener('click', () => g.skipIntro());
    this.root.querySelectorAll<HTMLElement>('[data-diff]').forEach((b) =>
      b.addEventListener('click', () => {
        g.storage.settings.difficulty = b.dataset.diff!;
        g.storage.save();
        this.syncSettings();
        g.audio.play('click');
      }));
    this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-set]').forEach((el) =>
      el.addEventListener('input', () => {
        const key = el.dataset.set as keyof typeof g.storage.settings;
        const s = g.storage.settings as any;
        s[key] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? el.value : parseFloat(el.value);
        g.storage.save();
        g.applySettings();
        this.syncSettings();
      }));
    // tooltips
    const tip = $('tooltip');
    this.root.addEventListener('mouseover', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
      if (!t) {
        tip.style.opacity = '0';
        return;
      }
      tip.innerHTML = t.dataset.tip!;
      const r = t.getBoundingClientRect();
      tip.style.opacity = '1';
      const below = r.top < 200;
      tip.style.left = Math.max(8, Math.min(window.innerWidth - 300, r.left + r.width / 2 - 140)) + 'px';
      tip.style.top = below ? r.bottom + 8 + 'px' : '';
      tip.style.bottom = below ? '' : window.innerHeight - r.top + 8 + 'px';
    });
    this.syncSettings();
  }

  syncSettings(): void {
    const s = this.game.storage.settings as any;
    this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-set]').forEach((el) => {
      const v = s[el.dataset.set!];
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!v;
      else el.value = String(v);
    });
    this.root.querySelectorAll<HTMLElement>('[data-diff]').forEach((b) => b.classList.toggle('on', b.dataset.diff === s.difficulty));
    const r = this.game.storage.records;
    const best = Object.entries(r.best).map(([k, v]) => `${DIFFICULTIES.find((d) => d.id === k)?.name ?? k} ${fmtTime(v)}`).join(' · ');
    $('records').innerHTML = r.wins + r.losses > 0 ? `Record: <b>${r.wins}</b> won / <b>${r.losses}</b> lost${best ? ` · Fastest victory: ${best}` : ''}` : '';
  }

  show(id: 'menu' | 'pause' | 'end', on: boolean): void {
    $(id).classList.toggle('hidden', !on);
  }

  setMode(mode: 'commander' | 'direct' | 'menu'): void {
    document.body.dataset.mode = mode;
  }

  intro(on: boolean): void {
    $('intro').classList.toggle('on', on);
  }

  linkFlash(text: string): void {
    const el = $('linkfx');
    el.firstElementChild!.textContent = text;
    el.classList.remove('go');
    void el.offsetWidth;
    el.classList.add('go');
  }

  toast(text: string, cls = ''): void {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + cls;
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 3) box.firstElementChild!.remove();
    setTimeout(() => el.remove(), 2200);
  }

  alert(text: string, level: string, x?: number, z?: number): void {
    const box = $('alerts');
    const el = document.createElement('div');
    el.className = 'alert ' + level;
    el.textContent = text;
    if (x !== undefined && z !== undefined) {
      el.title = 'Click to view';
      el.addEventListener('click', () => this.game.commander.jumpTo(x, z));
    }
    box.appendChild(el);
    while (box.children.length > 5) box.firstElementChild!.remove();
    setTimeout(() => el.classList.add('out'), 7000);
    setTimeout(() => el.remove(), 7600);
    if (level === 'good' || level === 'bad') this.banner(text, level);
  }

  banner(text: string, level: string): void {
    const el = $('banner');
    el.textContent = text;
    el.className = level;
    void el.offsetWidth;
    el.classList.add('on');
    this.bannerT = 3.2;
  }

  noteHint(id: string): void {
    this.hintDone.add(id);
  }

  showEnd(won: boolean, reason: string, best: boolean): void {
    const w = this.game.world, s = w.stats;
    $('endTitle').textContent = won ? 'VICTORY' : 'DEFEAT';
    $('endTitle').className = won ? 'win' : 'lose';
    $('endReason').textContent = reason + (best ? ' — NEW FASTEST VICTORY' : '');
    const rows: Array<[string, string | number]> = [
      ['Battle time', fmtTime(w.time)], ['Difficulty', w.difficulty.name],
      ['Enemies destroyed', s.kills], ['— by your own hand', s.directKills],
      ['Units lost', s.losses], ['Structures built', s.built],
      ['Structures lost', s.structLost], ['Enemy structures razed', s.razed],
      ['Points captured', s.captures], ['Orbital strikes', s.strikes],
    ];
    $('endStats').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    this.show('end', true);
  }

  hitmarker(kill: boolean): void {
    const el = $('hitm');
    el.className = kill ? 'kill' : 'hit';
    void el.offsetWidth;
    el.classList.add('on');
  }

  reset(): void {
    this.hintStep = 0;
    this.hintDone.clear();
    $('alerts').innerHTML = '';
    $('toasts').innerHTML = '';
    $('banner').className = '';
    this.lastSel = '';
  }

  update(dt: number): void {
    const g = this.game, w = g.world;
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) $('banner').classList.remove('on');
    }
    // crosshair feedback every frame
    const d = g.direct;
    if (g.mode === 'direct' && d.unit) {
      $('cross').style.setProperty('--gap', `${6 + Math.min(14, Math.hypot(d.unit.vx, d.unit.vz) * 1.2) * (1 - d.ads)}px`);
      $('cross').classList.toggle('link', !!d.linkTarget);
    }
    const box = $('dragbox');
    const c = g.commander;
    if (c.dragging && g.mode === 'commander' && g.state === 'playing') {
      const x0 = Math.min(c.dragX, g.input.mx), y0 = Math.min(c.dragY, g.input.my);
      box.style.cssText = `display:block;left:${x0}px;top:${y0}px;width:${Math.abs(g.input.mx - c.dragX)}px;height:${Math.abs(g.input.my - c.dragY)}px`;
    } else box.style.display = 'none';

    this.acc += dt;
    if (this.acc < 0.1) return;
    this.acc = 0;

    const t = w.teams[PLAYER];
    $('supply').textContent = String(Math.floor(t.supply));
    $('income').textContent = `+${t.income.toFixed(1)}/s`;
    $('pop').textContent = `${t.pop}/${t.popCap}`;
    $('clock').textContent = fmtTime(w.time);
    const hq = w.hq[PLAYER];
    $('hqhp').textContent = `⌂ ${Math.max(0, Math.round((hq.hp / hq.maxHp) * 100))}%`;
    $('hqhp').classList.toggle('low', hq.hp < hq.maxHp * 0.5);
    $('domP').style.width = `${Math.max(0, w.dominance) / 2}%`;
    $('domE').style.width = `${Math.max(0, -w.dominance) / 2}%`;
    const own = w.points.filter((p) => p.owner === 0).length, eown = w.points.filter((p) => p.owner === 1).length;
    $('domText').textContent = own > eown ? `AEGIS ADVANCING ${Math.round(w.dominance)}` : eown > own ? `VANTA ADVANCING ${Math.round(w.dominance)}` : `STALEMATE ${Math.round(w.dominance)}`;
    w.points.forEach((p, i) => {
      const el = $('pip' + i);
      el.className = (p.owner === 0 ? 'p' : p.owner === 1 ? 'e' : '') + (p.contested ? ' c' : '');
      el.style.setProperty('--prog', `${Math.abs(p.progress) * 100}%`);
      el.style.setProperty('--pc', p.progress >= 0 ? 'var(--cy)' : 'var(--rd)');
    });

    // hints
    if (g.state === 'playing' && this.hintStep < HINTS.length) {
      if (this.hintDone.has(HINTS[this.hintStep].id)) this.hintStep++;
      const h = HINTS[this.hintStep];
      const el = $('hint');
      if (h) {
        if (el.dataset.id !== h.id) {
          el.dataset.id = h.id;
          el.innerHTML = `<span>${this.hintStep + 1}/${HINTS.length}</span> ${h.text}`;
        }
        el.classList.add('on');
      } else el.classList.remove('on');
    } else $('hint').classList.remove('on');

    if (g.mode === 'direct' && d.unit) this.updateDirect();
    else this.updateCommander();
  }

  private updateCommander(): void {
    const g = this.game, w = g.world, c = g.commander, t = w.teams[PLAYER];
    this.root.querySelectorAll<HTMLButtonElement>('[data-build]').forEach((b) => {
      const k = b.dataset.build as StructKind;
      b.classList.toggle('active', c.buildKind === k);
      b.classList.toggle('poor', t.supply < STRUCT_DEFS[k].cost);
    });
    const queuedPop = t.queue.reduce((a, q) => a + UNIT_DEFS[q.kind].pop, 0);
    this.root.querySelectorAll<HTMLButtonElement>('[data-train]').forEach((b) => {
      const d = UNIT_DEFS[b.dataset.train as UnitKind];
      b.classList.toggle('poor', t.supply < d.cost || t.pop + queuedPop + d.pop > t.popCap);
    });
    const sb = $('btnStrike');
    sb.classList.toggle('active', c.strikeMode);
    sb.classList.toggle('poor', t.strikeCd > 0 || t.supply < ECON.strikeCost);
    $('strikeCd').textContent = t.strikeCd > 0 ? Math.ceil(t.strikeCd) + 's' : '';
    $('strikeCd').style.display = t.strikeCd > 0 ? '' : 'none';
    const hasBunker = w.structures.some((s) => s.team === PLAYER && s.kind === 'bunker' && s.done);
    $('btnSite').style.display = hasBunker ? '' : 'none';
    $('siteName').textContent = t.spawnSite ? 'Deploy: Bunker' : 'Deploy: Core';
    $('queue').innerHTML = t.queue.length
      ? t.queue.map((q, i) => `<span class="q" style="--p:${i === 0 ? (q.t / q.total) * 100 : 0}%">${ICON[q.kind]}</span>`).join('')
      : '';

    const sel = c.selection();
    let html = '';
    if (c.buildKind) {
      const d = STRUCT_DEFS[c.buildKind];
      html = `<h4>${ICON[c.buildKind]} ${d.name}</h4><p>${d.desc}</p><p class="dim">${c.buildKind === 'wall' || c.buildKind === 'barricade' ? 'Click, or drag to draw a line. ' : ''}Shift: keep placing · RMB: cancel</p>`;
    } else if (c.strikeMode) html = `<h4>☄ Orbital Strike</h4><p>Click a target. Everything in the zone is hit — including your own forces.</p>`;
    else if (sel.length === 1) {
      const u = sel[0];
      const o = u.order.type;
      const st = u.building ? 'Constructing' : o === 'move' ? 'Moving' : o === 'attack' ? 'Attacking' : o === 'hold' ? 'Holding' : o === 'build' ? 'En route to build' : u.target ? 'Engaging' : 'Ready';
      html = `<h4>${ICON[u.kind]} ${u.label}</h4><p class="dim">${u.def.role}</p><div class="hpbar"><div style="width:${(u.hp / u.maxHp) * 100}%"></div></div><p>${Math.ceil(u.hp)}/${u.maxHp} HP · ${u.kills} kills</p><p class="state">${st}</p>`;
    } else if (sel.length > 1) {
      const by = new Map<string, number>();
      let hp = 0, max = 0;
      for (const u of sel) {
        by.set(u.kind, (by.get(u.kind) ?? 0) + 1);
        hp += u.hp;
        max += u.maxHp;
      }
      html = `<h4>${sel.length} units selected</h4><p>${[...by].map(([k, n]) => `${ICON[k]} ${n}× ${UNIT_DEFS[k as UnitKind].name}`).join('<br>')}</p><div class="hpbar"><div style="width:${(hp / max) * 100}%"></div></div>`;
    } else if (g.view.selectedStruct?.alive) {
      const s = g.view.selectedStruct;
      html = `<h4>${ICON[s.kind]} ${s.def.name}</h4><p class="dim">${s.def.desc}</p><div class="hpbar"><div style="width:${(s.hp / s.maxHp) * 100}%"></div></div><p>${Math.ceil(s.hp)}/${s.maxHp} HP${s.done ? '' : ` · ${Math.round(s.progress * 100)}% built`}</p>`;
    } else html = `<p class="dim">No selection.<br>Drag to select units.</p>`;
    if (html !== this.lastSel) {
      this.lastSel = html;
      $('selinfo').innerHTML = html;
    }
    const tag = c.buildKind ? 'PLACING ' + STRUCT_DEFS[c.buildKind].name.toUpperCase() : c.strikeMode ? 'DESIGNATE STRIKE TARGET' : '';
    $('modeTag').textContent = tag;
    $('modeTag').style.display = tag ? '' : 'none';
  }

  private updateDirect(): void {
    const g = this.game, d = g.direct, u = d.unit!, w = g.world;
    $('modeTag').style.display = 'none';
    $('dName').innerHTML = `${ICON[u.kind]} ${u.label.toUpperCase()} <small>${u.def.role}</small>`;
    $('dHp').style.width = `${(u.hp / u.maxHp) * 100}%`;
    $('dHp').classList.toggle('low', u.hp < u.maxHp * 0.35);
    $('dPresence').textContent = d.presence > 0 ? `COMMAND PRESENCE · ${d.presence} allies inspired` : '';
    $('dWeapon').textContent = d.weapon.name;
    $('dAmmo').innerHTML = d.reloadT > 0 ? '<span class="rl">RELOADING</span>' : d.weapon.mag > 900 ? '∞' : `${d.ammo}<small>/${d.weapon.mag}</small>`;
    $('dSub').textContent = u.def.infantry ? (d.grenadeCd > 0 ? `Grenade ${Math.ceil(d.grenadeCd)}s` : 'Grenade ready [G]') : 'RMB: coaxial MG';
    let prompt = '';
    if (d.linkTarget) prompt = `<kbd>F</kbd> LINK → ${d.linkTarget.label.toUpperCase()}`;
    else if (d.workTarget && !d.buildKind) prompt = `Hold <kbd>E</kbd> to ${d.workTarget.done ? 'repair' : 'build'} ${d.workTarget.def.name} ${d.workTarget.done ? '' : Math.round(d.workTarget.progress * 100) + '%'}`;
    else if (d.buildKind) prompt = `<kbd>LMB</kbd> place ${STRUCT_DEFS[d.buildKind].name} (◆${STRUCT_DEFS[d.buildKind].cost}) · <kbd>RMB</kbd> cancel`;
    else if (!g.input.locked && g.input.everLocked) prompt = 'Click to recapture the mouse';
    $('dPrompt').innerHTML = prompt;
    const bb = $('dBuild');
    if (u.kind === 'engineer') {
      bb.style.display = '';
      bb.innerHTML = BUILDABLE.map((k, i) => `<span class="${d.buildKind === k ? 'on' : ''} ${w.teams[PLAYER].supply < STRUCT_DEFS[k].cost ? 'poor' : ''}"><kbd>${i + 1}</kbd>${ICON[k]} ${STRUCT_DEFS[k].name} <small>◆${STRUCT_DEFS[k].cost}</small></span>`).join('');
    } else bb.style.display = 'none';
    if (d.hitT > 0 && !$('hitm').classList.contains('on')) this.hitmarker(d.hitKill);
    if (d.hitT <= 0) $('hitm').classList.remove('on');
  }
}

/** Tactical minimap: terrain tint, objectives, structures, units and the camera footprint. */
export class Minimap {
  private cv = $('minimap') as unknown as HTMLCanvasElement;
  private cx = this.cv.getContext('2d')!;
  private bg: HTMLCanvasElement | null = null;
  private acc = 0;
  private sx = this.cv.width / (MAP.halfW * 2);
  private sz = this.cv.height / (MAP.halfH * 2);

  constructor(private game: Game) {
    const toWorld = (e: MouseEvent) => {
      const r = this.cv.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * MAP.halfW * 2 - MAP.halfW, z: ((e.clientY - r.top) / r.height) * MAP.halfH * 2 - MAP.halfH };
    };
    let drag = false;
    this.cv.addEventListener('mousedown', (e) => {
      const p = toWorld(e);
      if (e.button === 0) {
        drag = true;
        game.commander.jumpTo(p.x, p.z);
      } else if (e.button === 2 && game.mode === 'commander') game.commander.minimapOrder(p.x, p.z);
      e.preventDefault();
    });
    this.cv.addEventListener('mousemove', (e) => {
      if (drag && e.buttons & 1) {
        const p = toWorld(e);
        game.commander.jumpTo(p.x, p.z);
      }
    });
    window.addEventListener('mouseup', () => (drag = false));
    this.cv.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  rebuild(): void {
    const w = this.game.world;
    const bg = (this.bg = document.createElement('canvas'));
    bg.width = this.cv.width;
    bg.height = this.cv.height;
    const c = bg.getContext('2d')!;
    const img = c.createImageData(bg.width, bg.height);
    for (let j = 0; j < bg.height; j++)
      for (let i = 0; i < bg.width; i++) {
        const x = i / this.sx - MAP.halfW, z = j / this.sz - MAP.halfH;
        const h = w.height(x, z);
        const solid = !w.grid.walkable(x, z);
        const v = solid ? 26 : 58 + Math.max(-12, Math.min(40, h * 7));
        const k = (j * bg.width + i) * 4;
        img.data[k] = v * 0.85;
        img.data[k + 1] = v * 0.95;
        img.data[k + 2] = v * 1.1;
        img.data[k + 3] = 235;
      }
    c.putImageData(img, 0, 0);
  }

  update(dt: number): void {
    this.acc += dt;
    if (this.acc < 0.066) return;
    this.acc = 0;
    const g = this.game, w = g.world, c = this.cx;
    const X = (x: number) => (x + MAP.halfW) * this.sx, Z = (z: number) => (z + MAP.halfH) * this.sz;
    c.clearRect(0, 0, this.cv.width, this.cv.height);
    if (this.bg) c.drawImage(this.bg, 0, 0);
    for (const p of w.points) {
      c.beginPath();
      c.arc(X(p.x), Z(p.z), p.radius * this.sx, 0, 6.28);
      c.fillStyle = p.owner === 0 ? 'rgba(79,227,255,.28)' : p.owner === 1 ? 'rgba(255,59,85,.28)' : 'rgba(200,210,220,.14)';
      c.fill();
      c.strokeStyle = p.owner === 0 ? '#4fe3ff' : p.owner === 1 ? '#ff3b55' : '#c9d2dc';
      c.lineWidth = p.contested && Math.floor(performance.now() / 250) % 2 ? 2.5 : 1.2;
      c.stroke();
      c.fillStyle = '#fff';
      c.font = 'bold 10px system-ui';
      c.textAlign = 'center';
      c.fillText(p.name[0], X(p.x), Z(p.z) + 3.5);
    }
    for (const s of w.structures) {
      c.fillStyle = s.team === 0 ? (s.done ? '#2fb4d6' : 'rgba(47,180,214,.5)') : '#c22a40';
      const r = Math.max(1.6, s.def.cells * this.sx);
      c.fillRect(X(s.x) - r, Z(s.z) - r, r * 2, r * 2);
    }
    for (const u of w.units) {
      if (!u.alive || u.spawnDelay > 0) continue;
      c.fillStyle = u.controlled ? '#ffc14a' : u.team === 0 ? (g.view.selected.has(u) ? '#ffffff' : '#7ff0ff') : '#ff5a6e';
      const r = u.def.infantry ? 1.7 : 2.8;
      c.beginPath();
      c.arc(X(u.x), Z(u.z), u.controlled ? 3.2 : r, 0, 6.28);
      c.fill();
    }
    // camera footprint
    c.strokeStyle = 'rgba(255,255,255,.75)';
    c.lineWidth = 1;
    if (g.mode === 'commander') {
      const pts = [[0, 0], [window.innerWidth, 0], [window.innerWidth, window.innerHeight], [0, window.innerHeight]]
        .map(([sx, sy]) => g.commander.ground(sx, sy)).filter(Boolean) as Array<{ x: number; z: number }>;
      if (pts.length === 4) {
        c.beginPath();
        pts.forEach((p, i) => (i ? c.lineTo(X(p.x), Z(p.z)) : c.moveTo(X(p.x), Z(p.z))));
        c.closePath();
        c.stroke();
      }
    } else if (g.direct.unit) {
      const u = g.direct.unit;
      c.beginPath();
      c.moveTo(X(u.x), Z(u.z));
      c.lineTo(X(u.x + Math.sin(u.aimYaw - 0.5) * 22), Z(u.z + Math.cos(u.aimYaw - 0.5) * 22));
      c.lineTo(X(u.x + Math.sin(u.aimYaw + 0.5) * 22), Z(u.z + Math.cos(u.aimYaw + 0.5) * 22));
      c.closePath();
      c.fillStyle = 'rgba(255,193,74,.25)';
      c.fill();
    }
  }
}
