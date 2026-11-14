/*
 * Gem Burst — UI for the match-3 engine (engine.js) and the 300 levels (levels.js).
 *
 *   #/            world map (6 worlds × 50 levels, stars, unlocks, skip marks)
 *   #/level/N     play level N
 *
 * The engine resolves a whole move instantly and returns "phases" (swap, clear,
 * fall, collect, shuffle, won/lost) with board snapshots; this file animates
 * those phases one after another on a canvas.
 */
(() => {
  'use strict';

  const { Game } = window.GemEngine;
  const LEVELS = window.GEM_LEVELS || [];
  const TOTAL = LEVELS.length;
  const Sound = window.ArcadeSound;
  const WORLDS = ['QUARTZ CAVE', 'AMBER WOODS', 'TOPAZ DUNES', 'EMERALD FALLS', 'SAPPHIRE SEA', 'AMETHYST PEAK'];
  const PER_WORLD = 50;
  const worldOf = (n) => Math.min(WORLDS.length - 1, Math.floor((n - 1) / PER_WORLD));

  // =================================================================
  // Progress
  // =================================================================
  const KEY = 'arcade.gems';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };
  let prog = { max: 1, stars: {}, best: {} };          // stars[n]: 1..3 cleared, -1 skipped
  try { const p = JSON.parse(store.get(KEY)); if (p && p.max) prog = { max: p.max, stars: p.stars || {}, best: p.best || {} }; } catch (e) { /* fresh */ }
  const clearedCount = () => Object.values(prog.stars).filter((v) => v > 0).length;
  const starCount = () => Object.values(prog.stars).reduce((a, v) => a + Math.max(0, v), 0);
  function save() {
    store.set(KEY, JSON.stringify(prog));
    store.set('arcade.gems.cleared', String(clearedCount()));
  }

  // =================================================================
  // Pixel art (generated from shapes so every gem colour also has its own shape)
  // =================================================================
  const GEM_PAL = [
    ['#4a0a1a', '#b8203d', '#ff4d6a', '#ffb3c1'],   // ruby (octagon)
    ['#5a2a05', '#c96a12', '#ff9f2e', '#ffd59a'],   // amber (round)
    ['#4a3d05', '#c9a512', '#ffe14d', '#fff6b3'],   // topaz (triangle)
    ['#0a3d1d', '#1f9e52', '#4de38a', '#b8ffd4'],   // emerald (hexagon)
    ['#0a2250', '#1f5fc9', '#4d9bff', '#c2deff'],   // sapphire (diamond)
    ['#2f0a4a', '#8a2fc9', '#c26bff', '#ecc9ff'],   // amethyst (drop)
  ];
  const GEM_NAMES = ['ruby', 'amber', 'topaz', 'emerald', 'sapphire', 'amethyst'];
  const SHAPES = [
    (dx, dy) => Math.abs(dx) <= 5 && Math.abs(dy) <= 5 && Math.abs(dx) + Math.abs(dy) <= 7.2,
    (dx, dy) => dx * dx + dy * dy <= 5.4 * 5.4,
    (dx, dy) => dy >= -5.2 && dy <= 5 && Math.abs(dx) <= (dy + 5.6) * 0.56,
    (dx, dy) => Math.abs(dx) <= 4.8 && Math.abs(dy) <= 5.6 - Math.abs(dx) * 0.55,
    (dx, dy) => Math.abs(dx) * 0.9 + Math.abs(dy) <= 5.8,
    (dx, dy) => (dy > -0.6 && dx * dx + (dy - 0.8) * (dy - 0.8) <= 4.9 * 4.9) || (dy <= -0.6 && Math.abs(dx) <= (dy + 6.2) * 0.85),
  ];
  const SIZE = 12;

  function sprite(shape, pal, extra) {
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const g = c.getContext('2d');
    const inside = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE && shape(x + 0.5 - SIZE / 2, y + 0.5 - SIZE / 2);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (!inside(x, y)) continue;
        const edge = !inside(x + 1, y) || !inside(x - 1, y) || !inside(x, y + 1) || !inside(x, y - 1);
        const d = x + y;
        g.fillStyle = edge ? pal[0] : d < 9 ? pal[3] : d > 14 ? pal[1] : pal[2];
        g.fillRect(x, y, 1, 1);
      }
    }
    g.fillStyle = '#ffffff';
    g.fillRect(3, 3, 1, 1); g.fillRect(4, 3, 1, 1); g.fillRect(3, 4, 1, 1);
    if (extra) extra(g);
    return c;
  }
  const GEM_SPRITES = GEM_PAL.map((pal, i) => sprite(SHAPES[i], pal));
  const DROP_SPRITE = sprite(SHAPES[1], ['#5a3a05', '#c98a12', '#ffc83d', '#fff0b3'], (g) => {
    g.fillStyle = '#7a4a05';
    [[5, 3], [6, 3], [3, 5], [4, 5], [5, 5], [6, 5], [7, 5], [8, 5], [4, 6], [5, 6], [6, 6], [7, 6], [4, 7], [7, 7], [5, 4], [6, 4]].forEach(([x, y]) => g.fillRect(x, y, 1, 1));
  });
  const PRISM_SPRITE = sprite(SHAPES[1], ['#1d1b2e', '#c9c2e6', '#f4efe1', '#ffffff']);

  // =================================================================
  // DOM
  // =================================================================
  const $ = (id) => document.getElementById(id);
  const el = {
    map: $('mapView'), play: $('playView'), back: $('backBtn'), backTxt: $('backTxt'),
    cleared: $('clearedCount'), stars: $('starCount'), bar: $('barFill'), cont: $('continueBtn'),
    tiers: $('tiers'), tierTitle: $('tierTitle'), grid: $('grid'),
    lvl: $('lvlLabel'), goals: $('goals'), moves: $('movesLeft'), scoreFill: $('scoreFill'), mark2: $('mark2'), mark3: $('mark3'),
    scoreText: $('scoreText'), cascadeText: $('cascadeText'),
    stage: $('stage'), canvas: $('board'), panel: $('panel'),
    prev: $('prevBtn'), retry: $('retryBtn'), skip: $('skipBtn'), nextLvl: $('nextLvlBtn'),
  };
  const ctx = el.canvas.getContext('2d');
  Sound.bindButton($('muteBtn'));

  const sfx = {
    swap() { Sound.tone(420, 0.05, { type: 'triangle', vol: 0.25, slide: 520 }); },
    bad() { Sound.tone(200, 0.12, { type: 'square', vol: 0.18, slide: 140 }); },
    pop(cascade) { const f = 520 * Math.pow(1.122, Math.min(cascade - 1, 10)); Sound.tone(f, 0.09, { vol: 0.22 }); Sound.tone(f * 1.5, 0.08, { vol: 0.14, delay: 0.04 }); },
    special() { Sound.tone(880, 0.08, { vol: 0.2 }); Sound.tone(1320, 0.12, { vol: 0.18, delay: 0.06 }); },
    line() { Sound.noise(0.18, 0.3, 3200); Sound.tone(1200, 0.2, { type: 'sawtooth', vol: 0.12, slide: 300 }); },
    bomb() { Sound.noise(0.3, 0.55, 900); Sound.tone(120, 0.3, { type: 'triangle', vol: 0.4, slide: 50 }); },
    prism() { [660, 880, 1100, 1320, 1760].forEach((f, i) => Sound.tone(f, 0.08, { vol: 0.16, delay: i * 0.035 })); },
    collect() { Sound.tone(784, 0.1, { vol: 0.25 }); Sound.tone(1175, 0.18, { vol: 0.25, delay: 0.09 }); },
    win() { [523, 659, 784, 1047, 1319].forEach((f, i) => Sound.tone(f, i === 4 ? 0.35 : 0.12, { vol: 0.25, delay: i * 0.1 })); },
    lose() { [392, 330, 262].forEach((f, i) => Sound.tone(f, 0.22, { type: 'triangle', vol: 0.3, delay: i * 0.16 })); },
    tick() { Sound.tone(1400, 0.03, { vol: 0.12 }); },
  };

  // =================================================================
  // Map
  // =================================================================
  let page = 0;
  const firstOpenLevel = () => {
    const top = Math.min(prog.max, TOTAL);
    for (let n = 1; n <= top; n++) if (prog.stars[n] === undefined) return n;
    for (let n = 1; n <= top; n++) if (!(prog.stars[n] > 0)) return n;
    return top;
  };

  function renderMap() {
    const cleared = clearedCount();
    el.cleared.textContent = `${cleared} / ${TOTAL}`;
    el.stars.textContent = starCount();
    el.stars.nextElementSibling.textContent = ` / ${TOTAL * 3}`;
    el.bar.style.width = (cleared / TOTAL) * 100 + '%';
    const next = firstOpenLevel();
    el.cont.textContent = cleared === TOTAL ? `ALL ${TOTAL} CLEARED! ★` : `${cleared ? 'CONTINUE' : 'PLAY'} · LEVEL ${next} ▸`;
    el.cont.onclick = () => go(next);

    el.tiers.innerHTML = '';
    const worlds = Math.ceil(TOTAL / PER_WORLD);
    for (let i = 0; i < worlds; i++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tier';
      const from = i * PER_WORLD + 1, to = Math.min(TOTAL, from + PER_WORLD - 1);
      let done = true;
      for (let n = from; n <= to; n++) if (!(prog.stars[n] > 0)) { done = false; break; }
      if (done) b.classList.add('done');
      b.textContent = `${from}–${to}`;
      b.setAttribute('aria-current', String(i === page));
      b.onclick = () => { page = i; renderMap(); };
      el.tiers.appendChild(b);
    }
    const cur = el.tiers.children[page];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
    el.tierTitle.textContent = `${WORLDS[page]} · LEVELS ${page * PER_WORLD + 1}–${Math.min(TOTAL, page * PER_WORLD + PER_WORLD)}`;

    el.grid.innerHTML = '';
    for (let n = page * PER_WORLD + 1; n <= Math.min(TOTAL, page * PER_WORLD + PER_WORLD); n++) {
      const t = document.createElement('button');
      t.type = 'button'; t.className = 'tile'; t.setAttribute('role', 'listitem');
      const st = prog.stars[n], locked = n > prog.max;
      if (locked) { t.classList.add('locked'); t.disabled = true; t.setAttribute('aria-label', `Level ${n}, locked`); }
      else if (st > 0) { t.classList.add('won'); t.setAttribute('aria-label', `Level ${n}, ${st} stars`); }
      else if (st === -1) { t.classList.add('skipped'); t.setAttribute('aria-label', `Level ${n}, skipped`); }
      else t.setAttribute('aria-label', `Level ${n}`);
      if (n === next && !locked && !(st > 0)) t.classList.add('current');
      t.innerHTML = `<span>${n}</span>${st > 0 ? `<span class="s">${'★'.repeat(st)}</span>` : st === -1 ? '<span class="s">SKIP</span>' : ''}`;
      t.onclick = () => go(n);
      el.grid.appendChild(t);
    }
  }

  // =================================================================
  // Routing
  // =================================================================
  function go(n) { location.hash = n ? `#/level/${n}` : '#/'; }
  let lastPage = null;
  function route() {
    const m = location.hash.match(/^#\/level\/(\d+)/);
    let n = m ? parseInt(m[1], 10) : 0;
    if (n && (n < 1 || n > TOTAL || n > prog.max)) { n = 0; history.replaceState(null, '', '#/'); }
    if (n) {
      el.map.hidden = true; el.play.hidden = false;
      el.back.href = '#/'; el.back.setAttribute('aria-label', 'Back to levels'); el.backTxt.textContent = ' LEVELS';
      startLevel(n);
    } else {
      stopLevel();
      el.play.hidden = true; el.map.hidden = false;
      el.back.href = '../'; el.back.setAttribute('aria-label', 'Back to Arcade'); el.backTxt.textContent = ' ARCADE';
      page = lastPage != null ? lastPage : worldOf(firstOpenLevel());
      lastPage = null;
      renderMap();
      window.scrollTo(0, 0);
    }
  }
  window.addEventListener('hashchange', route);
  el.back.addEventListener('click', () => { if (!el.play.hidden && S.n) lastPage = worldOf(S.n); });

  // =================================================================
  // Level state + visuals
  // =================================================================
  const S = {
    n: 0, game: null, busy: false, ended: false,
    view: null,                 // { gems, ice, stone } currently shown
    vis: new Map(),             // gem id → { gem, x, y, s, a, dx, dy }
    sel: -1, hintPair: null, idleAt: 0,
    disp: null,                 // displayed goal progress
    fx: [], parts: [], texts: [],
    cell: 40, ox: 0, oy: 0, dpr: 1, time: 0,
  };

  function stopLevel() { S.game = null; S.busy = false; el.panel.hidden = true; }

  function startLevel(n) {
    S.n = n;
    const lv = LEVELS[n - 1];
    S.game = new Game(lv);
    S.busy = false; S.ended = false; S.sel = -1; S.hintPair = null; S.idleAt = performance.now();
    S.fx = []; S.parts = []; S.texts = [];
    S.vis.clear();
    S.view = { gems: S.game.gems.slice(), ice: S.game.ice.slice(), stone: S.game.stone.slice() };
    S.view.gems.forEach((g, i) => { if (g) S.vis.set(g.id, visFor(g, i)); });
    S.disp = { collected: S.game.collected.slice(), ice: S.game.iceLeft(), stone: S.game.stoneLeft(), drops: 0, score: 0, moves: lv.moves };
    el.lvl.innerHTML = `LEVEL ${n}<small> / ${TOTAL}</small>`;
    el.prev.disabled = n <= 1;
    el.nextLvl.disabled = n >= TOTAL || n + 1 > prog.max;
    el.skip.hidden = false;
    el.skip.textContent = n >= TOTAL ? 'SKIP ▸ MAP' : 'SKIP ▸';
    el.cascadeText.textContent = '';
    const [s2, s3] = lv.stars;
    el.mark2.style.left = Math.min(96, (s2 / s3) * 92) + '%';
    el.mark3.style.left = '96%';
    buildGoals();
    updateHud();
    layout();
    showIntro();
  }

  function visFor(g, i) {
    const x = i % S.game.w, y = (i / S.game.w) | 0;
    return { gem: g, x, y, s: 1, a: 1 };
  }

  // ---------- goals HUD ----------
  function goalIcon(goal) {
    const c = document.createElement('canvas');
    c.width = c.height = 12;
    c.className = 'ic';
    const g = c.getContext('2d');
    if (goal.type === 'collect') g.drawImage(GEM_SPRITES[goal.c], 0, 0);
    else if (goal.type === 'drop') g.drawImage(DROP_SPRITE, 0, 0);
    else if (goal.type === 'ice') { g.fillStyle = '#9fe0ff'; g.fillRect(1, 1, 10, 10); g.fillStyle = '#ffffff'; g.fillRect(2, 2, 3, 1); g.fillRect(2, 3, 1, 2); g.fillStyle = '#4aa8d8'; g.fillRect(1, 10, 10, 1); g.fillRect(10, 1, 1, 10); }
    else if (goal.type === 'stone') { g.fillStyle = '#1d1b2e'; g.fillRect(0, 0, 12, 12); g.fillStyle = '#7d7a8c'; g.fillRect(1, 1, 10, 10); g.fillStyle = '#a9a5b8'; g.fillRect(1, 1, 10, 2); g.fillStyle = '#4d4a5c'; g.fillRect(1, 9, 10, 2); }
    else { g.fillStyle = '#f2a93b'; g.font = 'bold 11px monospace'; g.fillText('★', 0, 10); }
    return c;
  }
  function goalText(goal, d) {
    switch (goal.type) {
      case 'score': return `${Math.min(d.score, goal.n).toLocaleString()}/${goal.n.toLocaleString()}`;
      case 'collect': return String(Math.max(0, goal.n - d.collected[goal.c]));
      case 'ice': return String(d.ice);
      case 'stone': return String(d.stone);
      case 'drop': return String(Math.max(0, goal.n - d.drops));
      default: return '';
    }
  }
  function goalDone(goal, d) {
    switch (goal.type) {
      case 'score': return d.score >= goal.n;
      case 'collect': return d.collected[goal.c] >= goal.n;
      case 'ice': return d.ice === 0;
      case 'stone': return d.stone === 0;
      case 'drop': return d.drops >= goal.n;
      default: return false;
    }
  }
  function describeGoal(goal) {
    switch (goal.type) {
      case 'score': return `Score ${goal.n.toLocaleString()} points`;
      case 'collect': return `Collect ${goal.n} ${GEM_NAMES[goal.c]}s`;
      case 'ice': return `Break all the ice (${S.game.iceTotal})`;
      case 'stone': return `Smash all the stone (${S.game.stoneTotal})`;
      case 'drop': return `Bring ${goal.n} star coin${goal.n > 1 ? 's' : ''} to the bottom`;
      default: return '';
    }
  }
  function buildGoals() {
    el.goals.innerHTML = '';
    S.game.lv.goals.forEach((goal, k) => {
      const chip = document.createElement('span');
      chip.className = 'goal';
      chip.dataset.k = k;
      chip.title = describeGoal(goal);
      chip.appendChild(goalIcon(goal));
      const n = document.createElement('span');
      n.className = 'n';
      chip.appendChild(n);
      el.goals.appendChild(chip);
    });
  }
  function updateHud(bump) {
    const d = S.disp, lv = S.game.lv;
    lv.goals.forEach((goal, k) => {
      const chip = el.goals.children[k];
      const n = chip.querySelector('.n');
      const txt = goalText(goal, d);
      if (n.textContent !== txt && bump) { chip.classList.remove('bump'); void chip.offsetWidth; chip.classList.add('bump'); }
      n.textContent = txt;
      chip.classList.toggle('done', goalDone(goal, d));
    });
    el.moves.textContent = d.moves;
    el.moves.parentElement.classList.toggle('low', d.moves <= 3 && !S.ended);
    const [s2, s3] = lv.stars;
    el.scoreFill.style.width = Math.min(100, (d.score / s3) * 100) + '%';
    el.mark2.classList.toggle('on', d.score >= s2);
    el.mark3.classList.toggle('on', d.score >= s3);
    el.scoreText.textContent = d.score.toLocaleString();
  }

  // ---------- panels ----------
  function panel(html, onTap) {
    el.panel.innerHTML = html;
    el.panel.hidden = false;
    el.panel.onclick = onTap || null;
  }
  function hidePanel() { el.panel.hidden = true; el.panel.onclick = null; }

  function showIntro() {
    const lv = S.game.lv;
    const list = lv.goals.map((goal) => `<span class="goal" data-goal="${goal.type}"><span class="ic-slot"></span>${describeGoal(goal)}</span>`).join('');
    panel(`<p class="title">LEVEL ${S.n}</p><p class="sub muted">${WORLDS[worldOf(S.n)]}</p>
      <div class="goal-list">${list}</div>
      <p class="sub">in <b>${lv.moves}</b> moves</p>
      <button class="cta" type="button" id="goBtn">PLAY ▸</button>`);
    el.panel.querySelectorAll('.ic-slot').forEach((slot, k) => slot.replaceWith(goalIcon(lv.goals[k])));
    S.busy = true;
    const start = () => { Sound.init(); hidePanel(); S.busy = false; S.idleAt = performance.now(); };
    $('goBtn').onclick = (e) => { e.stopPropagation(); start(); };
    el.panel.onclick = start;
  }

  // =================================================================
  // Animation helpers
  // =================================================================
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function tween(ms, fn) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms);
        fn(t);
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }
  const ease = (t) => 1 - (1 - t) * (1 - t);
  const easeIn = (t) => t * t;

  function cellXY(i) { return [i % S.game.w, (i / S.game.w) | 0]; }

  function burst(i, color, n) {
    const [x, y] = cellXY(i);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 4;
      S.parts.push({ x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5, life: 0.5 + Math.random() * 0.3, color });
    }
  }
  function floatText(i, text, color) { const [x, y] = cellXY(i); S.texts.push({ x: x + 0.5, y: y + 0.5, text, color, life: 0.9 }); }

  // Make the visible gem set match a board snapshot (new ids appear in place).
  function syncVis(gems) {
    const seen = new Set();
    gems.forEach((g, i) => {
      if (!g) return;
      seen.add(g.id);
      const v = S.vis.get(g.id);
      if (!v) S.vis.set(g.id, visFor(g, i));
      else v.gem = g;
    });
    for (const id of [...S.vis.keys()]) if (!seen.has(id)) S.vis.delete(id);
  }

  // =================================================================
  // Phase player
  // =================================================================
  async function playPhases(phases) {
    for (const p of phases) {
      if (!S.game) return;
      if (p.kind === 'swap') {
        const A = S.view.gems[p.a], B = S.view.gems[p.b];
        const va = A && S.vis.get(A.id), vb = B && S.vis.get(B.id);
        const [ax, ay] = cellXY(p.a), [bx, by] = cellXY(p.b);
        sfx.swap();
        await tween(140, (t) => {
          const e = ease(t);
          if (va) { va.x = ax + (bx - ax) * e; va.y = ay + (by - ay) * e; }
          if (vb) { vb.x = bx + (ax - bx) * e; vb.y = by + (ay - by) * e; }
        });
        S.view.gems = p.gems;
      } else if (p.kind === 'clear') {
        // effects
        const now = performance.now();
        let loud = null;
        for (const f of p.effects) {
          S.fx.push(Object.assign({ t0: now, dur: f.type === 'prism' ? 450 : 320 }, f));
          loud = loud || f.type;
        }
        if (loud === 'prism') sfx.prism(); else if (loud === 'bomb') sfx.bomb(); else if (loud === 'line') sfx.line();
        sfx.pop(p.cascade);
        if (p.created.length) sfx.special();
        if (p.cascade >= 3) el.cascadeText.textContent = p.cascade >= 6 ? `INCREDIBLE ×${p.cascade}!` : p.cascade >= 4 ? `AMAZING ×${p.cascade}!` : `COMBO ×${p.cascade}`;
        // pop removed gems
        const popping = p.removed.map((r) => S.vis.get(r.id)).filter(Boolean);
        p.removed.forEach((r) => { if (r.c >= 0) S.disp.collected[r.c]++; burst(r.i, r.c >= 0 ? GEM_PAL[r.c][2] : '#ffffff', 5); });
        if (p.removed.length) {
          const mid = p.removed[p.removed.length >> 1].i;
          floatText(mid, '+' + (p.score - S.disp.score), '#ffe066');
        }
        S.view.ice = p.ice; S.view.stone = p.stone;
        (p.stonesHit || []).forEach((i) => burst(i, '#a9a5b8', 6));
        S.disp.ice = p.ice.reduce((a, v) => a + v, 0);
        S.disp.stone = p.stone.reduce((a, v) => a + v, 0);
        S.disp.score = p.score;
        updateHud(true);
        await tween(170, (t) => { popping.forEach((v) => { v.s = 1 + 0.25 * Math.sin(t * Math.PI) - t * 0.9; v.a = 1 - t; }); });
        p.removed.forEach((r) => S.vis.delete(r.id));
        S.view.gems = p.gems;
        syncVis(p.gems);
        p.created.forEach((id) => { const v = S.vis.get(id); if (v) v.s = 0.2; });
        await tween(120, (t) => { p.created.forEach((id) => { const v = S.vis.get(id); if (v) v.s = 0.2 + 0.8 * ease(t) + Math.sin(t * Math.PI) * 0.2; }); });
      } else if (p.kind === 'fall') {
        const w = S.game.w;
        const tracks = [];
        for (const m of p.moves) { const v = S.vis.get(m.id); if (v) tracks.push({ v, x: m.to % w, y0: (m.from / w) | 0, y1: (m.to / w) | 0 }); }
        for (const s of p.spawns) {
          const g = p.gems[s.to];
          const v = visFor(g, s.to);
          v.y = s.from;
          S.vis.set(g.id, v);
          tracks.push({ v, x: s.to % w, y0: s.from, y1: (s.to / w) | 0 });
        }
        const maxDist = tracks.reduce((a, t) => Math.max(a, t.y1 - t.y0), 1);
        await tween(90 + maxDist * 55, (t) => {
          for (const tr of tracks) {
            const dist = tr.y1 - tr.y0;
            const local = Math.min(1, t * maxDist / Math.max(1, dist));
            tr.v.x = tr.x;
            tr.v.y = tr.y0 + dist * easeIn(local);
          }
        });
        tracks.forEach((tr) => { tr.v.y = tr.y1; });
        S.view.gems = p.gems;
        syncVis(p.gems);
      } else if (p.kind === 'collect') {
        sfx.collect();
        p.got.forEach((g) => { burst(g.i, '#ffc83d', 14); floatText(g.i, '+1000', '#ffc83d'); });
        await tween(260, (t) => { p.got.forEach((g) => { const v = S.vis.get(g.id); if (v) { v.y += 0.04; v.a = 1 - t; v.s = 1 + t * 0.4; } }); });
        p.got.forEach((g) => S.vis.delete(g.id));
        S.disp.drops += p.got.length;
        S.disp.score = p.score;
        S.view.gems = p.gems;
        updateHud(true);
      } else if (p.kind === 'shuffle') {
        el.cascadeText.textContent = 'NO MOVES — SHUFFLE!';
        const tracks = [];
        p.gems.forEach((g, i) => { if (g) { const v = S.vis.get(g.id); if (v) { const [x, y] = cellXY(i); tracks.push({ v, x0: v.x, y0: v.y, x1: x, y1: y }); } } });
        await tween(380, (t) => { const e = ease(t); tracks.forEach((tr) => { tr.v.x = tr.x0 + (tr.x1 - tr.x0) * e; tr.v.y = tr.y0 + (tr.y1 - tr.y0) * e; }); });
        S.view.gems = p.gems;
        syncVis(p.gems);
      } else if (p.kind === 'won') {
        await finishWin(p);
      } else if (p.kind === 'lost') {
        await finishLose();
      }
    }
  }

  // =================================================================
  // Moves
  // =================================================================
  async function trySwap(a, b) {
    if (S.busy || !S.game || S.game.status !== 'playing') return;
    S.sel = -1; S.hintPair = null;
    S.idleAt = performance.now();
    const g = S.game;
    if (!g.canSwap(a, b)) {
      // swap there and back
      if (!g.holdable(a) || !g.holdable(b) || !g.gems[a] || !g.gems[b]) return;
      S.busy = true;
      const va = S.vis.get(g.gems[a].id), vb = S.vis.get(g.gems[b].id);
      const [ax, ay] = cellXY(a), [bx, by] = cellXY(b);
      sfx.bad();
      await tween(220, (t) => {
        const e = Math.sin(t * Math.PI) * 0.45;
        va.x = ax + (bx - ax) * e; va.y = ay + (by - ay) * e;
        vb.x = bx + (ax - bx) * e; vb.y = by + (ay - by) * e;
      });
      S.busy = false;
      return;
    }
    S.busy = true;
    el.cascadeText.textContent = '';
    const r = g.swap(a, b);
    S.disp.moves = g.movesLeft;
    updateHud();
    await playPhases(r.phases);
    if (S.game === g) {
      S.busy = S.ended;
      S.idleAt = performance.now();
      if (!S.ended) setTimeout(() => { if (!S.busy) el.cascadeText.textContent = ''; }, 900);
    }
  }

  async function finishWin(p) {
    S.ended = true;
    const g = S.game;
    // count the leftover-moves bonus
    const movesLeft = g.movesLeft;
    if (movesLeft > 0) {
      el.cascadeText.textContent = `BONUS +${p.bonus.toLocaleString()}`;
      for (let k = 0; k < movesLeft; k++) {
        S.disp.moves--;
        S.disp.score += window.GemEngine.SCORE.moveBonus;
        updateHud();
        sfx.tick();
        const cells = [];
        g.gems.forEach((x, i) => { if (x) cells.push(i); });
        const i = cells[(Math.random() * cells.length) | 0];
        burst(i, '#ffe066', 8);
        await wait(Math.max(40, 160 - movesLeft * 6));
      }
    }
    S.disp.score = g.score;
    updateHud();
    const stars = g.stars();
    const prev = prog.stars[S.n];
    if (!(prev >= stars)) prog.stars[S.n] = stars;
    prog.best[S.n] = Math.max(prog.best[S.n] || 0, g.score);
    prog.max = Math.max(prog.max, Math.min(TOTAL, S.n + 1));
    save();
    sfx.win();
    el.skip.hidden = true;
    el.nextLvl.disabled = S.n >= TOTAL;
    await wait(300);
    const starHtml = [1, 2, 3].map((k) => `<span class="star${k <= stars ? ' on' : ''}">★</span>`).join('');
    panel(`<p class="title">LEVEL CLEAR!</p><p class="stars">${starHtml}</p>
      <p class="sub">Score ${g.score.toLocaleString()}${prog.best[S.n] === g.score && prev ? ' · NEW BEST' : ''}</p>
      <div class="row"><button class="cta alt" type="button" id="againBtn">↻ AGAIN</button>
      <button class="cta" type="button" id="nextBtn">${S.n >= TOTAL ? 'MAP ▸' : 'NEXT LEVEL ▸'}</button></div>`);
    $('nextBtn').onclick = () => (S.n >= TOTAL ? go(0) : go(S.n + 1));
    $('againBtn').onclick = () => startLevel(S.n);
    $('nextBtn').focus({ preventScroll: true });
  }

  async function finishLose() {
    S.ended = true;
    sfx.lose();
    await wait(350);
    const lv = S.game.lv;
    const list = lv.goals.map((goal) => `<span class="goal${goalDone(goal, S.disp) ? ' done' : ''}"><span class="ic-slot"></span><span class="n">${goalText(goal, S.disp)}</span>&nbsp;left</span>`).join('');
    panel(`<p class="title bad">OUT OF MOVES</p><div class="goal-list">${list}</div>
      <div class="row"><button class="cta" type="button" id="tryBtn">↻ TRY AGAIN</button>
      <button class="cta alt" type="button" id="skipPanelBtn">SKIP ▸</button></div>`);
    el.panel.querySelectorAll('.ic-slot').forEach((slot, k) => slot.replaceWith(goalIcon(lv.goals[k])));
    $('tryBtn').onclick = () => startLevel(S.n);
    $('skipPanelBtn').onclick = () => skip();
    $('tryBtn').focus({ preventScroll: true });
  }

  function skip() {
    if (!S.n) return;
    if (prog.stars[S.n] === undefined) prog.stars[S.n] = -1;
    prog.max = Math.max(prog.max, Math.min(TOTAL, S.n + 1));
    save();
    Sound.tone(520, 0.06, { vol: 0.2, slide: 780 });
    if (S.n >= TOTAL) { lastPage = worldOf(S.n); go(0); } else go(S.n + 1);
  }

  el.retry.addEventListener('click', () => { if (S.n) { Sound.init(); startLevel(S.n); } });
  el.skip.addEventListener('click', () => { Sound.init(); skip(); });
  el.prev.addEventListener('click', () => { if (S.n > 1) go(S.n - 1); });
  el.nextLvl.addEventListener('click', () => { if (S.n < TOTAL && S.n + 1 <= prog.max) go(S.n + 1); });

  // =================================================================
  // Input: swipe a gem, or tap one then a neighbour
  // =================================================================
  function cellAt(clientX, clientY) {
    const r = el.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - r.left - S.ox) / S.cell), y = Math.floor((clientY - r.top - S.oy) / S.cell);
    if (!S.game || x < 0 || y < 0 || x >= S.game.w || y >= S.game.h) return -1;
    return y * S.game.w + x;
  }
  let drag = null;
  el.canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    Sound.init();
    if (S.busy || !S.game || S.game.status !== 'playing') return;
    const i = cellAt(e.clientX, e.clientY);
    if (i < 0 || !S.game.holdable(i)) { S.sel = -1; return; }
    S.idleAt = performance.now(); S.hintPair = null;
    if (S.sel >= 0 && S.sel !== i && S.game.adjacent(S.sel, i)) { const a = S.sel; S.sel = -1; trySwap(a, i); return; }
    drag = { i, x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
    try { el.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  el.canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id || drag.moved) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < S.cell * 0.35) return;
    drag.moved = true;
    const [x, y] = cellXY(drag.i);
    const nx = Math.abs(dx) > Math.abs(dy) ? x + Math.sign(dx) : x, ny = Math.abs(dx) > Math.abs(dy) ? y : y + Math.sign(dy);
    if (nx < 0 || ny < 0 || nx >= S.game.w || ny >= S.game.h) return;
    S.sel = -1;
    trySwap(drag.i, ny * S.game.w + nx);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) S.sel = S.sel === drag.i ? -1 : drag.i;   // tap = select / deselect
    drag = null;
  };
  el.canvas.addEventListener('pointerup', endDrag);
  el.canvas.addEventListener('pointercancel', endDrag);
  el.canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  el.canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  el.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (el.play.hidden) return;
    if (e.key === 'Escape') { lastPage = worldOf(S.n); go(0); }
    else if ((e.key === 'r' || e.key === 'R') && !S.busy) startLevel(S.n);
    else if ((e.key === 'Enter' || e.key === ' ') && !el.panel.hidden) { const b = el.panel.querySelector('.cta'); if (b) { e.preventDefault(); b.click(); } }
  });

  // =================================================================
  // Rendering
  // =================================================================
  function layout() {
    if (!S.game) return;
    const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    const availW = el.play.clientWidth || document.querySelector('.gems-app').clientWidth;
    const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    const reserved = coarse ? 250 : 270;
    const { w, h } = S.game;
    S.cell = Math.max(26, Math.floor(Math.min((availW - 16) / w, (vh - reserved) / h, 64)));
    const cssW = S.cell * w + 12, cssH = S.cell * h + 12;
    S.ox = 6; S.oy = 6;
    S.dpr = Math.min(window.devicePixelRatio || 1, 3);
    el.stage.style.width = cssW + 6 + 'px';
    el.stage.style.height = cssH + 6 + 'px';
    el.canvas.style.width = cssW + 'px';
    el.canvas.style.height = cssH + 'px';
    el.canvas.width = Math.round(cssW * S.dpr);
    el.canvas.height = Math.round(cssH * S.dpr);
  }
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', () => setTimeout(layout, 250));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);

  function drawSprite(img, cx, cy, size) {
    ctx.drawImage(img, Math.round(cx - size / 2), Math.round(cy - size / 2), Math.round(size), Math.round(size));
  }

  function drawGem(v, now) {
    const g = v.gem, c = S.cell;
    const cx = S.ox + (v.x + 0.5) * c, cy = S.oy + (v.y + 0.5) * c;
    if (v.y < -0.5) return;                       // still above the board
    let size = c * 0.86 * v.s;
    if (size <= 0.5 || v.a <= 0.02) return;
    ctx.globalAlpha = Math.max(0, Math.min(1, v.a));
    if (g.drop) drawSprite(DROP_SPRITE, cx, cy + Math.sin(now / 250 + v.x) * c * 0.03, size);
    else if (g.sp === 'prism') {
      drawSprite(PRISM_SPRITE, cx, cy, size);
      for (let k = 0; k < 6; k++) {
        const a = now / 400 + (k * Math.PI) / 3;
        ctx.fillStyle = GEM_PAL[k][2];
        const px = Math.round(size / 12);
        ctx.fillRect(Math.round(cx + Math.cos(a) * size * 0.28 - px), Math.round(cy + Math.sin(a) * size * 0.28 - px), px * 2, px * 2);
      }
    } else {
      if (g.sp === 'bomb') {
        const pulse = 1 + Math.sin(now / 160) * 0.06;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath(); ctx.arc(cx, cy, size * 0.56 * pulse, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = GEM_PAL[g.c][3]; ctx.lineWidth = Math.max(2, c * 0.06);
        ctx.beginPath(); ctx.arc(cx, cy, size * 0.5 * pulse, 0, Math.PI * 2); ctx.stroke();
        size *= 0.78;
      }
      drawSprite(GEM_SPRITES[g.c], cx, cy, size);
      if (g.sp === 'h' || g.sp === 'v') {
        const px = Math.max(2, Math.round(size / 12));
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        for (let k = -1; k <= 1; k++) {
          if (g.sp === 'h') ctx.fillRect(Math.round(cx - size * 0.38), Math.round(cy + k * size * 0.2 - px / 2), Math.round(size * 0.76), px);
          else ctx.fillRect(Math.round(cx + k * size * 0.2 - px / 2), Math.round(cy - size * 0.38), px, Math.round(size * 0.76));
        }
        const wob = Math.sin(now / 150) * c * 0.04;
        ctx.fillStyle = '#ffffff';
        if (g.sp === 'h') { tri(cx - c * 0.47 - wob, cy, -1, 0, c); tri(cx + c * 0.47 + wob, cy, 1, 0, c); }
        else { tri(cx, cy - c * 0.47 - wob, 0, -1, c); tri(cx, cy + c * 0.47 + wob, 0, 1, c); }
      }
    }
    ctx.globalAlpha = 1;
  }
  function tri(x, y, dx, dy, c) {
    const s = c * 0.09;
    ctx.beginPath();
    if (dx) { ctx.moveTo(x + dx * s, y); ctx.lineTo(x - dx * s, y - s); ctx.lineTo(x - dx * s, y + s); }
    else { ctx.moveTo(x, y + dy * s); ctx.lineTo(x - s, y - dy * s); ctx.lineTo(x + s, y - dy * s); }
    ctx.closePath(); ctx.fill();
  }

  function render(now) {
    S.time = now;
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const W = el.canvas.width / S.dpr, H = el.canvas.height / S.dpr;
    ctx.fillStyle = '#120f22';
    ctx.fillRect(0, 0, W, H);
    if (!S.game || !S.view) return;
    const g = S.game, c = S.cell;

    // cells
    for (let i = 0; i < g.cell.length; i++) {
      if (!g.cell[i]) continue;
      const [x, y] = cellXY(i);
      const px = S.ox + x * c, py = S.oy + y * c;
      ctx.fillStyle = (x + y) % 2 ? '#211d3a' : '#1b1830';
      ctx.fillRect(px, py, c, c);
      if (g.exit[i] && g.lv.goals.some((q) => q.type === 'drop')) {
        ctx.fillStyle = 'rgba(255,200,61,0.35)';
        ctx.fillRect(px + c * 0.3, py + c - 4, c * 0.4, 3);
      }
    }
    // ice (under gems)
    for (let i = 0; i < g.cell.length; i++) {
      const ice = S.view.ice[i];
      if (!ice) continue;
      const [x, y] = cellXY(i);
      const px = S.ox + x * c, py = S.oy + y * c;
      ctx.fillStyle = ice > 1 ? 'rgba(140,210,255,0.62)' : 'rgba(160,225,255,0.38)';
      ctx.fillRect(px + 1, py + 1, c - 2, c - 2);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      const u = Math.max(2, Math.round(c / 14));
      ctx.fillRect(px + u * 2, py + u * 2, u * 3, u); ctx.fillRect(px + u * 2, py + u * 3, u, u * 2);
      if (ice > 1) { ctx.fillRect(px + c - u * 5, py + c - u * 3, u * 3, u); ctx.fillRect(px + c - u * 3, py + c - u * 5, u, u * 2); }
    }
    // gems
    for (const v of S.vis.values()) drawGem(v, now);
    // stones
    for (let i = 0; i < g.cell.length; i++) {
      const st = S.view.stone[i];
      if (!st) continue;
      const [x, y] = cellXY(i);
      const px = S.ox + x * c + 1, py = S.oy + y * c + 1, s = c - 2, u = Math.max(2, Math.round(c / 12));
      ctx.fillStyle = '#1d1b2e'; ctx.fillRect(px, py, s, s);
      ctx.fillStyle = st > 1 ? '#5d5a6c' : '#7d7a8c'; ctx.fillRect(px + u, py + u, s - u * 2, s - u * 2);
      ctx.fillStyle = st > 1 ? '#8a86a0' : '#a9a5b8'; ctx.fillRect(px + u, py + u, s - u * 2, u * 2);
      ctx.fillStyle = st > 1 ? '#3d3a4c' : '#4d4a5c'; ctx.fillRect(px + u, py + s - u * 3, s - u * 2, u * 2);
      if (st > 1) { ctx.fillStyle = '#c9c5d8'; [[0.3, 0.45], [0.7, 0.45], [0.5, 0.65]].forEach(([fx, fy]) => ctx.fillRect(px + s * fx - u / 2, py + s * fy - u / 2, u, u)); }
    }
    // selection + hint
    if (S.sel >= 0) {
      const [x, y] = cellXY(S.sel);
      ctx.strokeStyle = '#5ff2e6'; ctx.lineWidth = 3;
      ctx.strokeRect(S.ox + x * c + 2, S.oy + y * c + 2, c - 4, c - 4);
    }
    if (!S.busy && S.game.status === 'playing' && now - S.idleAt > 6000) {
      if (!S.hintPair) { const mv = S.game.validMoves(); S.hintPair = mv[(Math.random() * mv.length) | 0] || null; }
      if (S.hintPair && Math.floor(now / 350) % 2) {
        ctx.strokeStyle = 'rgba(255,224,102,0.9)'; ctx.lineWidth = 3;
        S.hintPair.forEach((i) => { const [x, y] = cellXY(i); ctx.strokeRect(S.ox + x * c + 3, S.oy + y * c + 3, c - 6, c - 6); });
      }
    }
    // effects
    S.fx = S.fx.filter((f) => now - f.t0 < f.dur);
    for (const f of S.fx) {
      const t = (now - f.t0) / f.dur;
      const [x, y] = cellXY(f.i);
      const cx = S.ox + (x + 0.5) * c, cy = S.oy + (y + 0.5) * c;
      ctx.globalAlpha = 1 - t;
      if (f.type === 'line') {
        ctx.fillStyle = '#ffffff';
        const th = c * (0.5 - t * 0.4);
        if (f.dir === 'h') ctx.fillRect(S.ox, cy - th / 2, g.w * c, th); else ctx.fillRect(cx - th / 2, S.oy, th, g.h * c);
      } else if (f.type === 'bomb') {
        ctx.strokeStyle = '#ffe066'; ctx.lineWidth = c * 0.25 * (1 - t) + 2;
        ctx.beginPath(); ctx.arc(cx, cy, c * (f.r + 0.5) * (0.4 + t), 0, Math.PI * 2); ctx.stroke();
      } else if (f.type === 'prism') {
        ctx.strokeStyle = GEM_PAL[Math.floor(now / 60) % 6][3]; ctx.lineWidth = 3;
        ctx.beginPath();
        for (const j of f.cells.slice(0, 60)) { const [tx, ty] = cellXY(j); ctx.moveTo(cx, cy); ctx.lineTo(S.ox + (tx + 0.5) * c, S.oy + (ty + 0.5) * c); }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // particles
    const dt = 1 / 60;
    S.parts = S.parts.filter((p) => (p.life -= dt) > 0);
    for (const p of S.parts) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 9 * dt;
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.fillStyle = p.color;
      const s = Math.max(2, c / 10);
      ctx.fillRect(S.ox + p.x * c - s / 2, S.oy + p.y * c - s / 2, s, s);
    }
    // floating score texts
    S.texts = S.texts.filter((t) => (t.life -= dt) > 0);
    ctx.font = `900 ${Math.max(12, c * 0.32)}px "Courier New", monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const t of S.texts) {
      t.y -= dt * 0.8;
      ctx.globalAlpha = Math.min(1, t.life * 2);
      ctx.fillStyle = '#000'; ctx.fillText(t.text, S.ox + t.x * c + 2, S.oy + t.y * c + 2);
      ctx.fillStyle = t.color; ctx.fillText(t.text, S.ox + t.x * c, S.oy + t.y * c);
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) { render(now); requestAnimationFrame(frame); }

  if (!TOTAL) { document.body.insertAdjacentHTML('beforeend', '<p style="text-align:center">Levels failed to load.</p>'); return; }
  route();
  requestAnimationFrame(frame);

  // Test / debug hook
  window.__gems = { S, prog, go, LEVELS, trySwap, skip, startLevel, save };
})();
