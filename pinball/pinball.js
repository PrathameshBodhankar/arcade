/*
 * Comet Pinball — a small physics pinball table for the Arcade.
 * Vanilla JS + Canvas 2D, no engine.
 *
 * Physics model
 *  - The table is a 400×700 logical space; gravity pulls "down the table".
 *  - Everything solid is a capsule (line segment + radius) or a circle.
 *    Ball-vs-capsule: find the closest point on the segment, push the ball
 *    out along the normal, reflect the velocity relative to the surface.
 *  - Flippers are moving capsules: the surface velocity at the contact
 *    point (ω × r) is added, which is what "whacks" the ball.
 *  - Fixed 120 Hz step split into 4 sub-steps so a fast ball never moves
 *    more than ~3 px per sub-step (no tunnelling through thin walls).
 */
(() => {
  'use strict';

  const W = 400, H = 700;
  const BALL_R = 8;
  const GRAVITY = 900;
  const MAX_SPEED = 1500;
  const STEP = 1 / 120, SUB = 4;
  const HI_KEY = 'arcade.pinball.hi';
  const BALLS_PER_GAME = 3;
  const BALL_SAVE = 6;               // seconds of ball save after each launch

  const Sound = window.ArcadeSound;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* ignore */ } },
  };

  // ===================================================================
  // Table geometry
  // ===================================================================
  const walls = [];                  // { a:{x,y}, b:{x,y}, r, e (restitution), kind, ... }
  const seg = (ax, ay, bx, by, extra) => walls.push(Object.assign({ a: { x: ax, y: ay }, b: { x: bx, y: by }, r: 2, e: 0.45 }, extra || {}));

  // Top arch (semicircle) from the left wall over to the right outer wall.
  {
    const cx = 200, cy = 210, R = 180, n = 28;
    for (let i = 0; i < n; i++) {
      const t0 = Math.PI + (i / n) * Math.PI, t1 = Math.PI + ((i + 1) / n) * Math.PI;
      seg(cx + R * Math.cos(t0), cy + R * Math.sin(t0), cx + R * Math.cos(t1), cy + R * Math.sin(t1), { kind: 'arch' });
    }
  }
  seg(20, 210, 20, 500);             // left wall
  seg(20, 500, 112, 590);            // left inlane slope → ends at the flipper pivot (no pocket)
  seg(380, 210, 380, 700);           // right outer wall (plunger lane)
  seg(350, 700, 350, 265);           // plunger lane inner wall / field right wall
  seg(350, 500, 258, 590);           // right inlane slope → ends at the flipper pivot
  seg(350, 672, 380, 672, { kind: 'plungerFloor', e: 0 });

  // Rollover lane posts at the top.
  for (const x of [118, 163, 208, 253]) seg(x, 92, x, 126, { r: 3, kind: 'post' });

  // Slingshots (triangles above the inlanes). The long inner face kicks.
  function sling(A, B, C, nx, ny, side) {
    seg(A.x, A.y, B.x, B.y, { kind: 'slingBack' });
    seg(B.x, B.y, C.x, C.y, { kind: 'slingBack' });
    seg(A.x, A.y, C.x, C.y, { kind: 'sling', n: { x: nx, y: ny }, side, hit: 0 });
  }
  {
    const len = Math.hypot(110, 40);
    sling({ x: 52, y: 430 }, { x: 52, y: 500 }, { x: 92, y: 540 }, 110 / len, -40 / len, 'L');
    sling({ x: 318, y: 430 }, { x: 318, y: 500 }, { x: 278, y: 540 }, -110 / len, -40 / len, 'R');
  }

  // Stand-up targets on the left wall.
  const targets = [300, 345, 390].map((y) => ({ y, lit: false, hit: 0 }));
  for (const t of targets) { seg(22, t.y - 14, 22, t.y + 14, { kind: 'target', ref: t, r: 4 }); }

  const bumpers = [
    { x: 125, y: 235, r: 22, color: '#ff5fa2', hit: 0 },
    { x: 245, y: 235, r: 22, color: '#f2a93b', hit: 0 },
    { x: 185, y: 320, r: 22, color: '#7b5cff', hit: 0 },
  ];

  const rollovers = [140.5, 185.5, 230.5].map((x) => ({ x, y: 110, lit: false, inside: false }));

  // Flippers. s = +1 (left) / -1 (right). Angle a: rest +0.5 rad (down), up -0.45 rad.
  const FL_LEN = 62, FL_R = 8, A_REST = 0.5, A_UP = -0.45, W_UP = 22, W_DOWN = 14;
  const flippers = [
    { s: 1, px: 112, py: 590, a: A_REST, w: 0, held: false },
    { s: -1, px: 258, py: 590, a: A_REST, w: 0, held: false },
  ];
  const tipOf = (f) => ({ x: f.px + f.s * FL_LEN * Math.cos(f.a), y: f.py + FL_LEN * Math.sin(f.a) });

  // ===================================================================
  // State
  // ===================================================================
  const ball = { x: 365, y: 672 - BALL_R, vx: 0, vy: 0, active: false };
  const game = {
    state: 'ready',          // ready | running | paused | over
    score: 0,
    hi: parseInt(store.get(HI_KEY, '0'), 10) || 0,
    ballNo: 1,
    mult: 1,
    saveT: 0,                // ball-save time remaining
    charge: 0,               // plunger 0..1
    charging: false,
    onPlunger: true,
    stillT: 0,
    msg: '', msgT: 0,
    time: 0,
    overAt: 0,
  };
  const particles = [];

  const onPlungerZone = () => ball.x > 352 && ball.y > 600;

  function serveBall() {
    ball.x = 365; ball.y = 672 - BALL_R - 0.5; ball.vx = 0; ball.vy = 0; ball.active = true;
    game.onPlunger = true; game.charge = 0; game.charging = false; game.stillT = 0;
  }

  function resetGame() {
    game.score = 0; game.ballNo = 1; game.mult = 1; game.saveT = 0;
    rollovers.forEach((r) => { r.lit = false; r.inside = false; });
    targets.forEach((t) => { t.lit = false; });
    serveBall();
    updateHud();
  }

  function addScore(n) { game.score += n * game.mult; updateHud(); }
  function flash(msg, t) { game.msg = msg; game.msgT = t || 1.6; }

  // ===================================================================
  // Collision helpers
  // ===================================================================
  function closestOnSeg(px, py, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((px - a.x) * abx + (py - a.y) * aby) / (abx * abx + aby * aby)));
    return { x: a.x + abx * t, y: a.y + aby * t };
  }

  // Resolve ball vs capsule. vs = surface velocity at contact. Returns normal speed of impact (>0) or 0.
  function collideCapsule(a, b, r, e, vsx, vsy) {
    const p = closestOnSeg(ball.x, ball.y, a, b);
    let dx = ball.x - p.x, dy = ball.y - p.y;
    const d = Math.hypot(dx, dy), min = BALL_R + r;
    if (d >= min || d === 0) return 0;
    const nx = dx / d, ny = dy / d;
    ball.x = p.x + nx * min; ball.y = p.y + ny * min;
    const rvx = ball.vx - vsx, rvy = ball.vy - vsy;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return 0.0001;
    ball.vx = vsx + rvx - (1 + e) * vn * nx;
    ball.vy = vsy + rvy - (1 + e) * vn * ny;
    return -vn;
  }

  function collideCircle(c) {
    const dx = ball.x - c.x, dy = ball.y - c.y;
    const d = Math.hypot(dx, dy), min = BALL_R + c.r;
    if (d >= min || d === 0) return false;
    const nx = dx / d, ny = dy / d;
    ball.x = c.x + nx * min; ball.y = c.y + ny * min;
    const vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0) { ball.vx -= 2 * vn * nx; ball.vy -= 2 * vn * ny; }
    // active bumper: kick outward
    ball.vx += nx * 380; ball.vy += ny * 380;
    return true;
  }

  // ===================================================================
  // Simulation
  // ===================================================================
  function substep(dt) {
    // Flippers
    for (const f of flippers) {
      const target = f.held ? A_UP : A_REST;
      const speed = f.held ? W_UP : W_DOWN;
      const prev = f.a;
      if (f.a > target) f.a = Math.max(target, f.a - speed * dt);
      else if (f.a < target) f.a = Math.min(target, f.a + speed * dt);
      f.w = (f.a - prev) / dt;
    }

    if (!ball.active) return;

    // Plunger: ball sits still on the plunger until released.
    if (game.onPlunger) {
      ball.x = 365; ball.y = 672 - BALL_R - 0.5 + game.charge * 18; ball.vx = 0; ball.vy = 0;
      return;
    }

    ball.vy += GRAVITY * dt;
    const sp = Math.hypot(ball.vx, ball.vy);
    if (sp > MAX_SPEED) { ball.vx *= MAX_SPEED / sp; ball.vy *= MAX_SPEED / sp; }
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Static walls
    for (const w of walls) {
      const hit = collideCapsule(w.a, w.b, w.r, w.e, 0, 0);
      if (!hit) continue;
      if (w.kind === 'sling' && hit > 60 && w.hit <= 0) {
        ball.vx += w.n.x * 420; ball.vy += w.n.y * 420;
        w.hit = 0.15;
        addScore(50);
        Sound.tone(520, 0.06, { vol: 0.3, slide: 300 });
        burst(ball.x, ball.y, 6, '#ff5fa2');
      } else if (w.kind === 'target' && hit > 40 && w.ref.hit <= 0) {
        const t = w.ref;
        t.hit = 0.3;
        if (!t.lit) { t.lit = true; addScore(200); Sound.tone(740, 0.08, { vol: 0.3 }); }
        if (targets.every((x) => x.lit)) {
          addScore(1500);
          flash('COMET TARGETS +1500');
          targets.forEach((x) => { x.lit = false; });
          Sound.tone(523, 0.1, { vol: 0.3 }); Sound.tone(659, 0.1, { vol: 0.3, delay: 0.1 }); Sound.tone(784, 0.16, { vol: 0.3, delay: 0.2 });
        }
      } else if (w.kind === 'plungerFloor' && Math.hypot(ball.vx, ball.vy) < 60) {
        game.onPlunger = true; game.charge = 0;      // rolled back into the lane
      }
    }

    // Bumpers
    for (const b of bumpers) {
      if (collideCircle(b)) {
        if (b.hit <= 0) { addScore(100); Sound.tone(220 + Math.random() * 60, 0.09, { type: 'triangle', vol: 0.5, slide: 520 }); }
        b.hit = 0.12;
        burst(ball.x, ball.y, 8, b.color);
      }
    }

    // Flippers (moving capsules)
    for (const f of flippers) {
      const a = { x: f.px, y: f.py }, b = tipOf(f);
      const p = closestOnSeg(ball.x, ball.y, a, b);
      const rx = p.x - f.px, ry = p.y - f.py;
      // surface velocity = s·ω·perp(r), perp(x,y) = (-y, x)
      const vsx = f.s * f.w * -ry, vsy = f.s * f.w * rx;
      const hit = collideCapsule(a, b, FL_R, 0.25, vsx, vsy);
      if (hit > 250 && Math.abs(f.w) > 1) Sound.tone(160, 0.04, { type: 'square', vol: 0.25 });
    }

    // Rollover sensors (no collision)
    for (const r of rollovers) {
      const inside = Math.hypot(ball.x - r.x, ball.y - r.y) < 12;
      if (inside && !r.inside && !r.lit) {
        r.lit = true; addScore(250); Sound.tone(980, 0.07, { vol: 0.25 });
        if (rollovers.every((x) => x.lit)) {
          game.mult = Math.min(5, game.mult + 1);
          addScore(1000);
          flash(`MULTIPLIER ×${game.mult}`);
          rollovers.forEach((x) => { x.lit = false; });
          Sound.tone(660, 0.1, { vol: 0.3 }); Sound.tone(880, 0.1, { vol: 0.3, delay: 0.1 }); Sound.tone(1320, 0.2, { vol: 0.3, delay: 0.2 });
          updateHud();
        }
      }
      r.inside = inside;
    }

    // Final speed clamp (bumper/sling kicks can add speed after the first clamp).
    const sp2 = Math.hypot(ball.vx, ball.vy);
    if (sp2 > MAX_SPEED) { ball.vx *= MAX_SPEED / sp2; ball.vy *= MAX_SPEED / sp2; }
  }

  function update(dt) {
    game.time += dt;
    if (game.charging && game.onPlunger) game.charge = Math.min(1, game.charge + dt * 1.1);
    for (let i = 0; i < SUB; i++) substep(dt / SUB);

    for (const b of bumpers) b.hit = Math.max(0, b.hit - dt);
    for (const w of walls) if (w.kind === 'sling') w.hit = Math.max(0, w.hit - dt);
    for (const t of targets) t.hit = Math.max(0, t.hit - dt);
    if (game.saveT > 0 && !game.onPlunger) game.saveT -= dt;
    if (game.msgT > 0) game.msgT -= dt;

    // Unstick: a ball resting somewhere odd (not on a flipper/plunger) gets a nudge.
    if (!game.onPlunger && Math.hypot(ball.vx, ball.vy) < 8) {
      game.stillT += dt;
      // (skip while a flipper is held — that's the player cradling the ball)
      if (game.stillT > 2.5 && !flippers.some((f) => f.held)) {
        ball.vy -= 300; ball.vx += (Math.random() - 0.5) * 200; game.stillT = 0;
      }
    } else game.stillT = 0;

    // Drain
    if (ball.y > H + 20) {
      if (game.saveT > 0) {
        flash('BALL SAVED!');
        Sound.tone(880, 0.1, { vol: 0.3 }); Sound.tone(660, 0.12, { vol: 0.3, delay: 0.1 });
        serveBall();
        game.saveT = 0;
        return;
      }
      Sound.tone(392, 0.18, { type: 'triangle', vol: 0.4 }); Sound.tone(262, 0.35, { type: 'triangle', vol: 0.4, delay: 0.18 });
      if (game.ballNo >= BALLS_PER_GAME) { gameOver(); return; }
      game.ballNo++;
      game.mult = 1;
      flash(`BALL ${game.ballNo}`);
      serveBall();
      updateHud();
    }
  }

  function launch() {
    if (!game.onPlunger) return;
    const power = 1000 + 600 * game.charge;
    game.onPlunger = false;
    game.charging = false;
    ball.vy = -power;
    ball.vx = 0;
    ball.y = 672 - BALL_R - 1;
    game.charge = 0;
    if (game.saveT <= 0) game.saveT = BALL_SAVE;
    Sound.noise(0.18, 0.35, 900);
    Sound.tone(200, 0.2, { type: 'sawtooth', vol: 0.2, slide: 600 });
  }

  // ===================================================================
  // Flow
  // ===================================================================
  const ui = {
    score: document.getElementById('score'),
    hi: document.getElementById('hi'),
    balls: document.getElementById('balls'),
    mult: document.getElementById('mult'),
    overlay: document.getElementById('overlay'),
    title: document.getElementById('ovTitle'),
    sub: document.getElementById('ovSub'),
    badge: document.getElementById('ovBadge'),
    pause: document.getElementById('pauseBtn'),
    mute: document.getElementById('muteBtn'),
  };
  const pad6 = (n) => String(n).padStart(6, '0');
  function updateHud() {
    ui.score.textContent = pad6(game.score);
    ui.hi.textContent = 'HI ' + pad6(Math.max(game.hi, 0));
    ui.balls.textContent = `BALL ${game.ballNo}/${BALLS_PER_GAME}`;
    ui.mult.textContent = '×' + game.mult;
  }

  function showOverlay(title, sub, badge) {
    ui.title.textContent = title; ui.sub.innerHTML = sub; ui.badge.hidden = !badge;
    ui.overlay.classList.remove('hidden');
  }
  const hideOverlay = () => ui.overlay.classList.add('hidden');

  function start() {
    Sound.init();
    if (game.state === 'over' && performance.now() - game.overAt < 600) return false;
    resetGame();
    game.state = 'running';
    hideOverlay();
    flash('HOLD & RELEASE TO LAUNCH', 2.5);
    return true;
  }
  function pause() { if (game.state === 'running') { game.state = 'paused'; flippers.forEach((f) => { f.held = false; }); showOverlay('PAUSED', 'Press <kbd>P</kbd> or tap to resume'); } }
  function resume() { if (game.state === 'paused') { game.state = 'running'; hideOverlay(); } }
  const togglePause = () => (game.state === 'running' ? pause() : resume());

  function gameOver() {
    game.state = 'over';
    game.overAt = performance.now();
    ball.active = false;
    const best = game.score > game.hi;
    if (best) { game.hi = game.score; store.set(HI_KEY, game.hi); }
    updateHud();
    showOverlay('GAME OVER', `Score ${game.score}<br>Press <kbd>Space</kbd> or tap to play again`, best);
  }

  // ===================================================================
  // Input
  // ===================================================================
  const keys = { L: new Set(['ArrowLeft', 'KeyZ', 'ShiftLeft']), R: new Set(['ArrowRight', 'Slash', 'ShiftRight']), P: new Set(['Space', 'ArrowDown', 'Enter']) };
  const flip = (i, on) => {
    const f = flippers[i];
    if (on && !f.held) Sound.tone(120, 0.05, { type: 'square', vol: 0.22, slide: 90 });
    f.held = on;
  };

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLButtonElement && (e.code === 'Space' || e.code === 'Enter')) return;
    const code = e.code;
    if (keys.L.has(code) || keys.R.has(code) || keys.P.has(code)) e.preventDefault();
    if (e.repeat) return;
    if (game.state === 'ready' || game.state === 'over') { if (keys.P.has(code) || keys.L.has(code) || keys.R.has(code)) start(); return; }
    if (game.state === 'paused') { if (keys.P.has(code)) resume(); else if (code === 'KeyP' || code === 'Escape') resume(); return; }
    if (keys.L.has(code)) flip(0, true);
    else if (keys.R.has(code)) flip(1, true);
    else if (keys.P.has(code)) { if (game.onPlunger) game.charging = true; }
    else if (code === 'KeyP' || code === 'Escape') togglePause();
    else if (code === 'KeyM') ui.mute.click();
  });
  window.addEventListener('keyup', (e) => {
    if (keys.L.has(e.code)) flip(0, false);
    else if (keys.R.has(e.code)) flip(1, false);
    else if (keys.P.has(e.code) && game.charging) launch();
  });

  // Touch / mouse: left half = left flipper, right half = right flipper (multi-touch).
  // While the ball sits on the plunger, any touch charges and releasing launches.
  const stage = document.getElementById('stage');
  const pointers = new Map();     // pointerId -> 'L' | 'R' | 'P'
  function syncFlippersFromPointers() {
    const v = [...pointers.values()];
    flip(0, v.includes('L'));
    flip(1, v.includes('R'));
  }
  stage.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    Sound.init();
    if (game.state === 'ready' || game.state === 'over') { start(); return; }
    if (game.state === 'paused') { resume(); return; }
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (game.onPlunger) { pointers.set(e.pointerId, 'P'); game.charging = true; return; }
    const r = stage.getBoundingClientRect();
    pointers.set(e.pointerId, e.clientX - r.left < r.width / 2 ? 'L' : 'R');
    syncFlippersFromPointers();
  });
  const release = (e) => {
    const kind = pointers.get(e.pointerId);
    if (!kind) return;
    pointers.delete(e.pointerId);
    if (kind === 'P' && game.charging) launch();
    syncFlippersFromPointers();
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  stage.addEventListener('lostpointercapture', release);
  stage.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  stage.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  Sound.bindButton(ui.mute);
  ui.pause.addEventListener('click', () => { togglePause(); ui.pause.blur(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  window.addEventListener('blur', pause);

  // ===================================================================
  // Rendering
  // ===================================================================
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  let scale = 1;

  function burst(x, y, n, color) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 160;
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.3 + Math.random() * 0.3, color });
    }
  }

  const stars = Array.from({ length: 60 }, (_, i) => ({ x: (i * 97.3) % W, y: (i * 151.7) % H, s: (i % 3) + 1 }));

  function line(a, b, color, width) {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  function render() {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // backdrop
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#191238'); g.addColorStop(1, '#0b0817');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    for (const s of stars) {
      ctx.fillStyle = `rgba(255,240,200,${0.25 + 0.25 * Math.sin(game.time * 2 + s.x)})`;
      ctx.fillRect(s.x, s.y, s.s, s.s);
    }
    // playfield art: comet streak + title
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#5ff2e6';
    ctx.beginPath(); ctx.moveTo(90, 470); ctx.lineTo(260, 390); ctx.lineTo(270, 402); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(268, 394, 12, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#f4efe1';
    ctx.font = '900 30px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('COMET', 185, 440);
    ctx.restore();

    // lane guide arrows
    ctx.fillStyle = 'rgba(95,242,230,0.25)';
    for (let i = 0; i < 4; i++) { const y = 600 - i * 40; ctx.beginPath(); ctx.moveTo(365, y - 10); ctx.lineTo(373, y); ctx.lineTo(357, y); ctx.fill(); }

    // walls: soft glow pass then core line
    for (const w of walls) {
      if (w.kind === 'sling' || w.kind === 'slingBack' || w.kind === 'target') continue;
      line(w.a, w.b, 'rgba(95,242,230,0.18)', w.r * 2 + 8);
    }
    for (const w of walls) {
      if (w.kind === 'sling' || w.kind === 'slingBack' || w.kind === 'target') continue;
      line(w.a, w.b, w.kind === 'post' ? '#f4efe1' : '#5ff2e6', w.r * 2 + 1);
    }

    // slingshots
    for (const w of walls) {
      if (w.kind !== 'sling') continue;
      const A = w.a, C = w.b, B = { x: A.x, y: A.y + 70 };
      ctx.fillStyle = w.hit > 0 ? '#ffd1e6' : 'rgba(255,95,162,0.35)';
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.lineTo(C.x, C.y); ctx.closePath(); ctx.fill();
      line(A, C, w.hit > 0 ? '#fff' : '#ff5fa2', 5);
      line(A, B, '#ff5fa2', 3); line(B, C, '#ff5fa2', 3);
    }

    // targets
    for (const t of targets) {
      ctx.fillStyle = t.lit ? '#ffe066' : '#5a4a1a';
      if (t.hit > 0) ctx.fillStyle = '#fff';
      ctx.fillRect(18, t.y - 14, 9, 28);
      ctx.strokeStyle = '#1d1b2e'; ctx.lineWidth = 1; ctx.strokeRect(18, t.y - 14, 9, 28);
    }

    // rollover lights
    rollovers.forEach((r, i) => {
      ctx.fillStyle = r.lit ? '#ffe066' : 'rgba(255,224,102,0.18)';
      ctx.beginPath(); ctx.arc(r.x, r.y, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = r.lit ? '#1d1b2e' : 'rgba(255,224,102,0.5)';
      ctx.font = '900 9px "Courier New", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('ABC'[i], r.x, r.y + 0.5);
    });

    // bumpers
    for (const b of bumpers) {
      const k = b.hit > 0 ? 1 + b.hit * 1.5 : 1;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.arc(b.x + 3, b.y + 4, b.r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = b.hit > 0 ? '#ffffff' : b.color;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r * k, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#f4efe1'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r * k - 1.5, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#1d1b2e';
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.42, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = b.color;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.22, 0, Math.PI * 2); ctx.fill();
    }

    // plunger + spring
    {
      const top = 672 + game.charge * 18;
      ctx.strokeStyle = '#9aa3b5'; ctx.lineWidth = 2;
      ctx.beginPath();
      const coils = 6, y0 = top + 4, y1 = 698;
      for (let i = 0; i <= coils * 2; i++) {
        const y = y0 + (y1 - y0) * (i / (coils * 2));
        const x = i % 2 ? 358 : 372;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = '#f2a93b'; ctx.fillRect(353, top - 1, 24, 6);
      if (game.onPlunger && ball.active) {
        ctx.fillStyle = 'rgba(242,169,59,0.25)'; ctx.fillRect(386 - 2, 560, 8, 100);
        ctx.fillStyle = '#f2a93b'; ctx.fillRect(386 - 2, 660 - 100 * game.charge, 8, 100 * game.charge);
      }
    }

    // flippers
    for (const f of flippers) {
      const a = { x: f.px, y: f.py }, b = tipOf(f);
      line(a, b, 'rgba(0,0,0,0.4)', FL_R * 2 + 4);
      line(a, b, '#f4efe1', FL_R * 2);
      line(a, b, f.held ? '#5ff2e6' : '#f2a93b', FL_R * 2 - 7);
      ctx.fillStyle = '#1d1b2e';
      ctx.beginPath(); ctx.arc(f.px, f.py, 3, 0, Math.PI * 2); ctx.fill();
    }

    // ball-save indicator
    if (game.saveT > 0 && game.state === 'running') {
      ctx.fillStyle = ((game.time * 6) | 0) % 2 ? '#7ee07a' : 'rgba(126,224,122,0.3)';
      ctx.font = '900 11px "Courier New", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('BALL SAVE', 185, 664);
    }

    // ball
    if (ball.active) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.arc(ball.x + 3, ball.y + 4, BALL_R, 0, Math.PI * 2); ctx.fill();
      const bg = ctx.createRadialGradient(ball.x - 3, ball.y - 3, 1, ball.x, ball.y, BALL_R);
      bg.addColorStop(0, '#ffffff'); bg.addColorStop(0.5, '#c9d1e0'); bg.addColorStop(1, '#5d667a');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2); ctx.fill();
    }

    // particles
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 3));
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;

    // message banner
    if (game.msgT > 0 && game.state === 'running') {
      ctx.globalAlpha = Math.min(1, game.msgT * 2);
      ctx.fillStyle = 'rgba(14,11,29,0.8)';
      ctx.fillRect(40, 500, 290, 30);
      ctx.fillStyle = '#ffe066';
      ctx.font = '900 14px "Courier New", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(game.msg, 185, 515);
      ctx.globalAlpha = 1;
    }
  }

  // ===================================================================
  // Layout & loop
  // ===================================================================
  function layout() {
    const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    const avail = stage.parentElement.clientWidth;
    const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    let cssH = Math.max(320, vh - (coarse ? 130 : 150));
    let cssW = cssH * W / H;
    if (cssW > avail - 6) { cssW = avail - 6; cssH = cssW * H / W; }
    stage.style.width = cssW + 6 + 'px';
    stage.style.height = cssH + 6 + 'px';
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    scale = canvas.width / W;
    render();
  }
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', () => setTimeout(layout, 250));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);

  let last = performance.now(), acc = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (game.state === 'running') {
      acc += dt;
      while (acc >= STEP) { update(STEP); acc -= STEP; if (game.state !== 'running') { acc = 0; break; } }
    } else if (game.state !== 'paused') {
      game.time += dt;
      // attract mode: flippers idle-wiggle on the title screen
      flippers.forEach((f, i) => { f.held = game.state === 'ready' && ((game.time * 1.5 + i * 0.5) % 3) < 0.25; });
      for (let i = 0; i < SUB; i++) substep(dt / SUB);
    }
    if (game.state !== 'paused') {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.life <= 0) particles.splice(i, 1);
      }
    }
    render();
    requestAnimationFrame(frame);
  }

  serveBall();
  ball.active = true;
  updateHud();
  layout();
  requestAnimationFrame(frame);

  // Test / debug hook
  window.__pinball = { game, ball, flippers, bumpers, rollovers, targets, walls, update, launch, start, STEP, tipOf };
})();
