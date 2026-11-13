/*
 * Pixel Serpent — grid snake for the Arcade.
 * Vanilla JS + Canvas 2D.
 *
 * Model: the board is an N×N grid. The snake moves one cell per "tick";
 * ticks speed up as it eats. Rendering interpolates between the previous
 * and current tick so movement is smooth at any frame rate.
 */
(() => {
  'use strict';

  const N = 20;                       // grid size (cells)
  const START_RATE = 7;               // moves per second
  const MAX_RATE = 16;
  const RATE_PER_FOOD = 0.3;
  const GEM_EVERY = 5;                // a bonus gem after every 5 foods
  const GEM_LIFE = 6;                 // seconds
  const HI_KEY = 'arcade.snake.hi';

  const Sound = window.ArcadeSound;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* ignore */ } },
  };

  const DIRS = {
    up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
  };

  // ---------- DOM ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const stage = document.getElementById('stage');
  const ui = {
    score: document.getElementById('score'),
    hi: document.getElementById('hi'),
    overlay: document.getElementById('overlay'),
    title: document.getElementById('ovTitle'),
    sub: document.getElementById('ovSub'),
    badge: document.getElementById('ovBadge'),
    pause: document.getElementById('pauseBtn'),
    mute: document.getElementById('muteBtn'),
    dpad: document.getElementById('dpad'),
  };

  // ---------- State ----------
  const game = {
    state: 'ready',                   // ready | running | paused | over
    snake: [],                        // head first: [{x,y}, ...]
    prev: [],                         // snapshot from the previous tick (for interpolation)
    dir: DIRS.right,
    queue: [],                        // buffered turns (max 2) so quick double-turns work
    grow: 0,
    food: null,
    gem: null,                        // { x, y, life }
    eaten: 0,
    score: 0,
    hi: parseInt(store.get(HI_KEY, '0'), 10) || 0,
    acc: 0,
    time: 0,
    overAt: 0,
    flash: 0,
  };
  const particles = [];

  const rate = () => Math.min(MAX_RATE, START_RATE + game.eaten * RATE_PER_FOOD);
  const pad = (n) => String(n).padStart(4, '0');
  const same = (a, b) => a.x === b.x && a.y === b.y;

  function freeCell() {
    const taken = new Set(game.snake.map((s) => s.y * N + s.x));
    if (game.food) taken.add(game.food.y * N + game.food.x);
    if (game.gem) taken.add(game.gem.y * N + game.gem.x);
    const free = [];
    for (let i = 0; i < N * N; i++) if (!taken.has(i)) free.push(i);
    if (!free.length) return null;
    const i = free[(Math.random() * free.length) | 0];
    return { x: i % N, y: (i / N) | 0 };
  }

  function reset() {
    const y = (N / 2) | 0;
    game.snake = [{ x: 6, y }, { x: 5, y }, { x: 4, y }];
    game.prev = game.snake.map((s) => ({ ...s }));
    game.dir = DIRS.right;
    game.queue = [];
    game.grow = 0;
    game.eaten = 0;
    game.score = 0;
    game.acc = 0;
    game.gem = null;
    game.food = null;
    game.food = freeCell();
    particles.length = 0;
    updateHud();
  }

  // ---------- Input ----------
  function turn(name) {
    const d = DIRS[name];
    if (!d) return;
    if (game.state === 'ready' || game.state === 'over') { if (!tryStart()) return; }
    if (game.state !== 'running') return;
    const last = game.queue.length ? game.queue[game.queue.length - 1] : game.dir;
    if (d === last || (d.x === -last.x && d.y === -last.y)) return; // no 180° reversals
    if (game.queue.length < 2) game.queue.push(d);
  }

  function tryStart() {
    Sound.init();
    if (game.state === 'over' && performance.now() - game.overAt < 400) return false;
    if (game.state === 'ready' || game.state === 'over') { reset(); game.state = 'running'; hideOverlay(); }
    return true;
  }

  const KEYMAP = {
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  };
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLButtonElement && (e.code === 'Space' || e.code === 'Enter')) return;
    if (KEYMAP[e.code]) { e.preventDefault(); turn(KEYMAP[e.code]); }
    else if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      if (game.state === 'paused') resume(); else if (game.state !== 'running') tryStart();
    }
    else if (e.code === 'KeyP' || e.code === 'Escape') togglePause();
    else if (e.code === 'KeyM') ui.mute.click();
  });

  // Swipe anywhere on the board: each 22px of travel = one turn, so you can chain swipes without lifting.
  let swipe = null;
  stage.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    Sound.init();
    if (game.state === 'paused') { resume(); return; }
    if (game.state !== 'running') { tryStart(); }
    swipe = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 22) return;
    turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
    swipe.x = e.clientX; swipe.y = e.clientY;
  });
  const endSwipe = () => { swipe = null; };
  window.addEventListener('pointerup', endSwipe);
  window.addEventListener('pointercancel', endSwipe);
  stage.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  stage.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  // D-pad (phones). pointerdown for instant response.
  ui.dpad.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('button[data-dir]');
    if (!b) return;
    e.preventDefault();
    Sound.init();
    if (game.state === 'paused') resume();
    turn(b.dataset.dir);
    b.classList.add('on');
    setTimeout(() => b.classList.remove('on'), 120);
  });
  ui.dpad.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

  Sound.bindButton(ui.mute);
  ui.pause.addEventListener('click', () => { togglePause(); ui.pause.blur(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  window.addEventListener('blur', pause);

  // ---------- Flow ----------
  function showOverlay(title, sub, badge) {
    ui.title.textContent = title;
    ui.sub.innerHTML = sub;
    ui.badge.hidden = !badge;
    ui.overlay.classList.remove('hidden');
  }
  const hideOverlay = () => ui.overlay.classList.add('hidden');

  function pause() {
    if (game.state !== 'running') return;
    game.state = 'paused';
    showOverlay('PAUSED', 'Press <kbd>P</kbd> or tap to resume');
  }
  function resume() {
    if (game.state !== 'paused') return;
    game.state = 'running';
    hideOverlay();
  }
  function togglePause() { if (game.state === 'running') pause(); else resume(); }

  function gameOver() {
    game.state = 'over';
    game.overAt = performance.now();
    game.flash = 0.4;
    Sound.noise(0.25, 0.5);
    Sound.tone(300, 0.45, { type: 'sawtooth', vol: 0.3, slide: 60 });
    const best = game.score > game.hi;
    if (best) { game.hi = game.score; store.set(HI_KEY, game.hi); }
    updateHud();
    const h = game.snake[0];
    burst(h.x + 0.5, h.y + 0.5, 20, '#ff6a5c');
    showOverlay('GAME OVER', `Length ${game.snake.length} · Score ${game.score}<br>Press <kbd>Space</kbd> or tap to play again`, best);
  }

  function updateHud() {
    ui.score.textContent = 'SCORE ' + pad(game.score);
    ui.hi.textContent = 'HI ' + pad(game.hi);
  }

  // ---------- Simulation ----------
  function tick() {
    game.prev = game.snake.map((s) => ({ ...s }));
    if (game.queue.length) game.dir = game.queue.shift();
    const head = game.snake[0];
    const next = { x: head.x + game.dir.x, y: head.y + game.dir.y };

    if (next.x < 0 || next.y < 0 || next.x >= N || next.y >= N) { gameOver(); return; }
    // The tail moves out of the way this tick unless we're growing.
    const body = game.grow > 0 ? game.snake : game.snake.slice(0, -1);
    if (body.some((s) => same(s, next))) { gameOver(); return; }

    game.snake.unshift(next);
    if (game.grow > 0) game.grow--; else game.snake.pop();

    if (game.food && same(next, game.food)) {
      game.grow += 1;
      game.eaten += 1;
      game.score += 10;
      Sound.tone(660, 0.06, { vol: 0.3 }); Sound.tone(990, 0.08, { vol: 0.25, delay: 0.05 });
      burst(next.x + 0.5, next.y + 0.5, 10, '#ff5f6e');
      game.food = freeCell();
      if (game.eaten % GEM_EVERY === 0 && !game.gem) {
        const c = freeCell();
        if (c) game.gem = { ...c, life: GEM_LIFE };
      }
    }
    if (game.gem && same(next, game.gem)) {
      const bonus = 20 + Math.ceil(game.gem.life * 10);  // faster = more points
      game.score += bonus;
      game.grow += 2;
      Sound.tone(880, 0.07, { vol: 0.3 }); Sound.tone(1320, 0.07, { vol: 0.3, delay: 0.06 }); Sound.tone(1760, 0.12, { vol: 0.3, delay: 0.12 });
      burst(next.x + 0.5, next.y + 0.5, 18, '#5ff2e6');
      game.gem = null;
    }
    if (!game.food && !game.gem) { // board full — you win
      game.score += 1000;
      gameOver();
      ui.title.textContent = 'YOU WIN!';
    }
    updateHud();
  }

  function update(dt) {
    game.time += dt;
    if (game.gem) { game.gem.life -= dt; if (game.gem.life <= 0) game.gem = null; }
    game.acc += dt;
    const step = 1 / rate();
    while (game.acc >= step && game.state === 'running') { game.acc -= step; tick(); }
  }

  function burst(cx, cy, n, color) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 6;
      particles.push({ x: cx, y: cy, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5 + Math.random() * 0.3, color });
    }
  }

  // ---------- Rendering ----------
  let size = 400, dpr = 1;
  const lerp = (a, b, t) => a + (b - a) * t;

  function render() {
    const c = size / N;                         // css px per cell
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // board
    ctx.fillStyle = '#10131f';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#161c2e';
    for (let y = 0; y < N; y++) for (let x = (y & 1); x < N; x += 2) ctx.fillRect(x * c, y * c, c, c);

    const alpha = game.state === 'running' ? Math.min(1, game.acc * rate()) : 1;
    const pos = (i) => {
      const cur = game.snake[i];
      const p = game.prev[i] || game.prev[game.prev.length - 1] || cur;
      return { x: lerp(p.x, cur.x, alpha), y: lerp(p.y, cur.y, alpha) };
    };

    // food (pixel apple, gentle bob)
    if (game.food) {
      const bob = Math.sin(game.time * 5) * c * 0.06;
      const fx = game.food.x * c, fy = game.food.y * c + bob, u = c / 8;
      ctx.fillStyle = '#ff5f6e'; ctx.fillRect(fx + u, fy + 2 * u, 6 * u, 5 * u); ctx.fillRect(fx + 2 * u, fy + u, 4 * u, 7 * u);
      ctx.fillStyle = '#ffb3ba'; ctx.fillRect(fx + 2 * u, fy + 3 * u, u, 2 * u);
      ctx.fillStyle = '#7ee07a'; ctx.fillRect(fx + 4 * u, fy, 2 * u, u);
    }

    // gem (blinks when about to vanish) + life bar
    if (game.gem && (game.gem.life > 1.5 || ((game.time * 8) | 0) % 2)) {
      const gx = game.gem.x * c + c / 2, gy = game.gem.y * c + c / 2, r = c * (0.38 + Math.sin(game.time * 8) * 0.05);
      ctx.fillStyle = '#5ff2e6';
      ctx.beginPath(); ctx.moveTo(gx, gy - r); ctx.lineTo(gx + r, gy); ctx.lineTo(gx, gy + r); ctx.lineTo(gx - r, gy); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#e6fffd'; ctx.fillRect(gx - r * 0.3, gy - r * 0.5, r * 0.3, r * 0.3);
      ctx.fillStyle = 'rgba(95,242,230,0.6)';
      ctx.fillRect(game.gem.x * c, game.gem.y * c + c - 3, c * (game.gem.life / GEM_LIFE), 3);
    }

    // snake: body tail→neck (each segment bridged toward the one in front), then the head on top
    const L = game.snake.length;
    const inset = c * 0.08;
    const box = (a, b) => ctx.fillRect(Math.min(a.x, b.x) * c + inset, Math.min(a.y, b.y) * c + inset,
      Math.abs(a.x - b.x) * c + c - inset * 2, Math.abs(a.y - b.y) * c + c - inset * 2);
    for (let i = L - 1; i >= 1; i--) {
      const t = i / Math.max(1, L - 1);
      ctx.fillStyle = `hsl(${lerp(115, 150, t)}, 65%, ${lerp(55, 36, t)}%)`;
      box(pos(i), pos(i - 1));
    }
    if (L) { const h = pos(0); ctx.fillStyle = '#b6f5a8'; box(h, h); }
    // head details: eyes look where we're going
    if (L) {
      const h = pos(0), d = game.dir;
      const cx = h.x * c + c / 2, cy = h.y * c + c / 2, e = c * 0.12;
      const ox = d.x * c * 0.18, oy = d.y * c * 0.18, sx = -d.y * c * 0.2, sy = d.x * c * 0.2;
      ctx.fillStyle = game.state === 'over' ? '#ff4d4d' : '#10131f';
      ctx.fillRect(cx + ox + sx - e / 2, cy + oy + sy - e / 2, e, e);
      ctx.fillRect(cx + ox - sx - e / 2, cy + oy - sy - e / 2, e, e);
      if (game.state === 'running' && ((game.time * 3) | 0) % 5 === 0) { // tongue flick
        ctx.fillStyle = '#ff5f6e';
        ctx.fillRect(cx + d.x * c * 0.5 - (d.y ? 1 : 0), cy + d.y * c * 0.5 - (d.x ? 1 : 0), d.x ? c * 0.25 : 2, d.y ? c * 0.25 : 2);
      }
    }

    // particles
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x * c - 2, p.y * c - 2, 4, 4);
    }
    ctx.globalAlpha = 1;

    if (game.flash > 0) {
      ctx.fillStyle = `rgba(255,80,80,${game.flash * 0.6})`;
      ctx.fillRect(0, 0, size, size);
    }
  }

  // ---------- Layout ----------
  function layout() {
    const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    const reserved = coarse ? 340 : 170;      // header + hud + (d-pad on phones)
    const w = stage.parentElement.clientWidth;
    size = Math.floor(Math.max(200, Math.min(w - 6, 560, vh - reserved)) / N) * N; // whole cells = crisp grid
    stage.style.width = stage.style.height = size + 6 + 'px';
    canvas.style.width = canvas.style.height = size + 'px';
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = canvas.height = Math.round(size * dpr);
    render();
  }
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', () => setTimeout(layout, 250));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);

  // ---------- Loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (game.state === 'running') update(dt); else if (game.state !== 'paused') game.time += dt;
    if (game.state !== 'paused') {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92;
        if (p.life <= 0) particles.splice(i, 1);
      }
      game.flash = Math.max(0, game.flash - dt);
    }
    render();
    requestAnimationFrame(frame);
  }

  reset();
  layout();
  requestAnimationFrame(frame);

  window.__snake = { game, N, tick, turn, tryStart, reset, rate };
})();
