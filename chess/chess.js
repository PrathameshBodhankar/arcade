/*
 * Mate in One — 1000 checkmate puzzles for the Arcade.
 *
 * Screens
 *   #/            level map (1000 levels in 10 tiers, stars, unlocks)
 *   #/level/N     puzzle N: the opponent's last move is animated, then you
 *                 find the single move that delivers checkmate.
 *
 * Rules are enforced by core.js (ChessCore). A move counts as correct if it
 * actually checkmates — the engine checks it — so there's no "magic answer".
 */
(() => {
  'use strict';

  const C = window.ChessCore;
  const PUZZLES = window.MATE_PUZZLES || [];
  const Sound = window.ArcadeSound;
  const TOTAL = PUZZLES.length;
  const TIERS = ['NOVICE', 'BEGINNER', 'APPRENTICE', 'CLUB', 'TOURNAMENT', 'EXPERT', 'CANDIDATE', 'MASTER', 'GRANDMASTER', 'LEGEND'];
  const tierIndex = (n) => Math.min(TIERS.length - 1, Math.floor((n - 1) / 100));

  // =================================================================
  // Progress (localStorage, defensive)
  // =================================================================
  const KEY = 'arcade.mate1';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };
  let prog = { max: 1, stars: {} };      // stars[n]: 1..3 solved, 0 = answer revealed
  try { const p = JSON.parse(store.get(KEY)); if (p && p.max) prog = { max: p.max, stars: p.stars || {} }; } catch (e) { /* fresh */ }
  const solvedCount = () => Object.values(prog.stars).filter((v) => v > 0).length;
  const starCount = () => Object.values(prog.stars).reduce((a, v) => a + Math.max(0, v), 0);
  function save() {
    store.set(KEY, JSON.stringify(prog));
    store.set('arcade.mate1.solved', String(solvedCount()));
  }

  // =================================================================
  // Pixel-art pieces (original 12×12 designs, rendered to SVG data URIs)
  // o outline · f fill · h highlight · s shade · e eye
  // =================================================================
  const MAPS = {
    p: ['................', '................', '................', '......oooo......', '.....ohffso.....', '.....offffo.....',
      '.....ohffso.....', '......oooo......', '.....oooooo.....', '......ohso......', '......ohso......', '.....ohffso.....',
      '....ohffffso....', '...oooooooooo...'],
    n: ['................', '.......o.o......', '......ofofo.....', '.....ohffffo....', '....ohfeffffo...', '...ohffffffffo..',
      '..ohfffffffffo..', '..offooofffffo..', '...oo..offfffo..', '......ohffffo...', '.....ohfffffo...', '....ohffffffso..',
      '...ohfffffffso..', '...oooooooooooo.'],
    b: ['................', '.......oo.......', '......ohfo......', '.....ohfffo.....', '....ohffoffo....', '....ohfoffso....',
      '....ohffffso....', '.....ohffso.....', '....oooooooo....', '......ohfo......', '......ohfo......', '.....ohffso.....',
      '...ohffffffso...', '...oooooooooo...'],
    r: ['................', '...oo..oo..oo...', '...oo..oo..oo...', '...ohffffffso...', '...oooooooooo...', '.....ohffso.....',
      '.....ohffso.....', '.....ohffso.....', '.....ohffso.....', '.....ohffso.....', '....oooooooo....', '....ohffffso....',
      '...ohffffffso...', '...oooooooooo...'],
    q: ['................', '...o...oo...o...', '..ofo.ohfo.ofo..', '...oo.ohfo.oo...', '...ohoohfoofo...', '...ohffffffso...',
      '....ohffffso....', '.....ohffso.....', '....oooooooo....', '.....ohffso.....', '.....ohffso.....', '....ohffffso....',
      '...ohffffffso...', '...oooooooooo...'],
    k: ['.......oo.......', '.....oohfoo.....', '.......oo.......', '...ooo.oo.ooo...', '..ohffoohfoffo..', '..ohfffffffffo..',
      '...ohffffffso...', '....ohffffso....', '....oooooooo....', '.....ohffso.....', '.....ohffso.....', '....ohffffso....',
      '...ohffffffso...', '...oooooooooo...'],
  };
  for (const k in MAPS) {           // pad to 16 rows; validate widths
    while (MAPS[k].length < 16) MAPS[k].push('................');
    MAPS[k].forEach((r, i) => { if (r.length !== 16) throw new Error(`piece ${k} row ${i} is ${r.length} wide`); });
  }
  const PAL = {
    w: { o: '#140f22', f: '#f4efe1', h: '#ffffff', s: '#c9bfa6', e: '#140f22' },
    b: { o: '#0b0814', f: '#3a3256', h: '#6c5f9e', s: '#221c38', e: '#ff5fa2' },
  };
  const IMG = {};
  function pieceImage(p) {
    if (IMG[p]) return IMG[p];
    const color = C.colorOf(p), map = MAPS[p.toLowerCase()], pal = PAL[color];
    let rects = '';
    map.forEach((row, y) => { [...row].forEach((ch, x) => { if (ch !== '.') rects += `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${pal[ch]}"/>`; }); });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${rects}</svg>`;
    return (IMG[p] = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
  }

  // =================================================================
  // DOM
  // =================================================================
  const $ = (id) => document.getElementById(id);
  const el = {
    map: $('mapView'), play: $('playView'), back: $('backBtn'), backTxt: $('backTxt'),
    solved: $('solvedCount'), stars: $('starCount'), bar: $('barFill'), cont: $('continueBtn'),
    tiers: $('tiers'), tierTitle: $('tierTitle'), grid: $('grid'),
    lvl: $('lvlLabel'), badge: $('tierBadge'), sideDot: $('sideDot'), promptText: $('promptText'),
    board: $('board'), promo: $('promo'), result: $('result'), resultTitle: $('resultTitle'),
    resultStars: $('resultStars'), resultMove: $('resultMove'), next: $('nextBtn'),
    feedback: $('feedback'), hint: $('hintBtn'), answer: $('answerBtn'), prev: $('prevBtn'), nextLvl: $('nextLvlBtn'),
  };
  Sound.bindButton($('muteBtn'));

  const sfx = {
    move() { Sound.tone(330, 0.05, { type: 'triangle', vol: 0.4 }); },
    capture() { Sound.noise(0.08, 0.4, 1200); Sound.tone(220, 0.06, { type: 'triangle', vol: 0.35 }); },
    select() { Sound.tone(880, 0.025, { vol: 0.12 }); },
    wrong() { Sound.tone(180, 0.25, { type: 'sawtooth', vol: 0.25, slide: 90 }); },
    hint() { Sound.tone(660, 0.07, { vol: 0.2 }); Sound.tone(990, 0.09, { vol: 0.2, delay: 0.07 }); },
    mate() { [523, 659, 784, 1047].forEach((f, i) => Sound.tone(f, i === 3 ? 0.3 : 0.1, { vol: 0.3, delay: i * 0.09 })); },
  };

  // =================================================================
  // Level map
  // =================================================================
  let page = 0;
  const firstOpenLevel = () => {
    for (let n = 1; n <= Math.min(prog.max, TOTAL); n++) if (!(prog.stars[n] > 0)) return n;
    return Math.min(prog.max, TOTAL);
  };

  function renderMap() {
    const solved = solvedCount();
    el.solved.textContent = `${solved} / ${TOTAL}`;
    el.stars.textContent = starCount();
    el.bar.style.width = (solved / TOTAL) * 100 + '%';
    const next = firstOpenLevel();
    el.cont.textContent = solved === TOTAL ? 'ALL 1000 SOLVED! ★' : `${solved ? 'CONTINUE' : 'PLAY'} · LEVEL ${next} ▸`;
    el.cont.onclick = () => go(next);

    el.tiers.innerHTML = '';
    TIERS.forEach((name, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tier';
      const from = i * 100 + 1, to = Math.min(TOTAL, from + 99);
      let done = true;
      for (let n = from; n <= to; n++) if (!(prog.stars[n] > 0)) { done = false; break; }
      if (done) b.classList.add('done');
      b.textContent = `${from}–${to}`;
      b.setAttribute('aria-current', String(i === page));
      b.onclick = () => { page = i; renderMap(); };
      el.tiers.appendChild(b);
    });
    const cur = el.tiers.children[page];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'center' });

    el.tierTitle.textContent = `${TIERS[page]} · LEVELS ${page * 100 + 1}–${Math.min(TOTAL, page * 100 + 100)}`;
    el.grid.innerHTML = '';
    for (let n = page * 100 + 1; n <= Math.min(TOTAL, page * 100 + 100); n++) {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'tile';
      t.setAttribute('role', 'listitem');
      const st = prog.stars[n];
      const locked = n > prog.max;
      if (locked) { t.classList.add('locked'); t.disabled = true; t.setAttribute('aria-label', `Level ${n}, locked`); }
      else if (st > 0) { t.classList.add('solved'); t.setAttribute('aria-label', `Level ${n}, ${st} stars`); }
      else if (st === 0) { t.classList.add('revealed'); t.setAttribute('aria-label', `Level ${n}, answer shown`); }
      else t.setAttribute('aria-label', `Level ${n}`);
      if (n === next && !locked && !(st > 0)) t.classList.add('current');
      t.innerHTML = `<span>${n}</span>${st > 0 ? `<span class="s">${'★'.repeat(st)}</span>` : ''}`;
      t.onclick = () => go(n);
      el.grid.appendChild(t);
    }
  }

  // =================================================================
  // Routing
  // =================================================================
  function go(n) { location.hash = n ? `#/level/${n}` : '#/'; }
  function route() {
    const m = location.hash.match(/^#\/level\/(\d+)/);
    let n = m ? parseInt(m[1], 10) : 0;
    if (n && (n < 1 || n > TOTAL || n > prog.max)) { n = 0; history.replaceState(null, '', '#/'); }
    if (n) {
      el.map.hidden = true; el.play.hidden = false;
      el.back.href = '#/'; el.back.setAttribute('aria-label', 'Back to levels'); el.backTxt.textContent = ' LEVELS';
      loadLevel(n);
    } else {
      el.play.hidden = true; el.map.hidden = false;
      el.back.href = '../'; el.back.setAttribute('aria-label', 'Back to Arcade'); el.backTxt.textContent = ' ARCADE';
      page = tierIndex(firstOpenLevel());
      if (game.lastPage != null) { page = game.lastPage; game.lastPage = null; }
      renderMap();
      window.scrollTo(0, 0);
    }
  }
  window.addEventListener('hashchange', route);

  // =================================================================
  // Puzzle state
  // =================================================================
  const game = {
    n: 0, pos: null, start: null, sol: '', player: 'w', flip: false,
    sel: -1, targets: [], last: [], hint: [], bad: -1, check: -1,
    mistakes: 0, hints: 0, locked: true, done: false, timer: 0, lastPage: null,
  };
  let squares = [];             // display cell → { el, sq }
  const pieceEls = new Map();   // board index → .pc element

  function buildBoard() {
    el.board.innerHTML = '';
    squares = [];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const f = game.flip ? 7 - col : col, r = game.flip ? row : 7 - row;
        const sq = (7 - r) * 8 + f;
        const d = document.createElement('div');
        d.className = 'sq' + ((f + r) % 2 === 0 ? ' dark' : '');
        d.setAttribute('role', 'gridcell');
        if (row === 7) d.insertAdjacentHTML('beforeend', `<span class="coord f">${'abcdefgh'[f]}</span>`);
        if (col === 0) d.insertAdjacentHTML('beforeend', `<span class="coord r">${r + 1}</span>`);
        el.board.appendChild(d);
        squares.push({ el: d, sq });
      }
    }
  }

  function placeOf(i) {
    const f = C.fileOf(i), r = C.rankOf(i);
    const col = game.flip ? 7 - f : f, row = game.flip ? r : 7 - r;
    return { left: col * 12.5 + '%', top: row * 12.5 + '%' };
  }

  function renderPieces() {
    for (const e of pieceEls.values()) e.remove();
    pieceEls.clear();
    game.pos.b.forEach((p, i) => {
      if (p === '.') return;
      const d = document.createElement('div');
      d.className = 'pc';
      d.style.backgroundImage = pieceImage(p);
      Object.assign(d.style, placeOf(i));
      el.board.appendChild(d);
      pieceEls.set(i, d);
    });
  }

  function paint() {
    for (const { el: d, sq } of squares) {
      d.classList.toggle('last', game.last.includes(sq));
      d.classList.toggle('sel', sq === game.sel);
      d.classList.toggle('hint', game.hint.includes(sq));
      d.classList.toggle('bad', sq === game.bad);
      d.classList.toggle('check', sq === game.check);
      const old = d.querySelector('.mv');
      if (old) old.remove();
      const t = game.targets.find((m) => m.to === sq);
      if (t) d.insertAdjacentHTML('beforeend', `<span class="mv${t.captured !== '.' || t.flag === 'ep' ? ' cap' : ''}"></span>`);
    }
    const label = game.pos ? `${game.player === 'w' ? 'White' : 'Black'} to move. Position: ${C.toFEN(game.pos).split(' ')[0]}` : '';
    el.board.setAttribute('aria-label', 'Chess board. ' + label);
  }

  function feedback(text, kind) {
    el.feedback.textContent = text || ' ';
    el.feedback.className = 'feedback' + (kind ? ' ' + kind : '');
  }

  function loadLevel(n) {
    clearTimeout(game.timer);
    const [fen, prev, sol] = PUZZLES[n - 1];
    const before = C.fromFEN(fen);
    const pm = C.findMove(before, prev);
    Object.assign(game, {
      n, sol, start: C.makeMove(before, pm), pos: before, sel: -1, targets: [], last: [], hint: [], bad: -1, check: -1,
      mistakes: 0, hints: 0, locked: true, done: false,
    });
    game.player = game.start.turn;
    game.flip = game.player === 'b';
    el.lvl.innerHTML = `LEVEL ${n}<small> / ${TOTAL}</small>`;
    el.badge.textContent = TIERS[tierIndex(n)];
    el.sideDot.className = 'dot' + (game.player === 'b' ? ' black' : '');
    el.promptText.textContent = `${game.player === 'w' ? 'White' : 'Black'} to move ·`;
    el.result.hidden = true;
    el.promo.hidden = true;
    el.answer.hidden = true;
    el.hint.disabled = false;
    el.prev.disabled = n <= 1;
    el.nextLvl.disabled = n >= TOTAL || n + 1 > prog.max;
    feedback('Watch the opponent’s move…', 'info');
    layout();
    buildBoard();
    renderPieces();
    paint();
    game.timer = setTimeout(() => {
      animate(pm, before, () => {
        game.pos = game.start;
        game.last = [pm.from, pm.to];
        game.locked = false;
        paint();
        feedback(prog.stars[n] > 0 ? `Solved before (${'★'.repeat(prog.stars[n])}) — play it again!` : 'Find the checkmate.', '');
      });
    }, 550);
  }

  // Slide the moving piece (and the castling rook), fade a captured piece.
  function animate(m, fromPos, done) {
    const mover = pieceEls.get(m.from);
    const capSq = m.flag === 'ep' ? m.to + (fromPos.turn === 'w' ? 8 : -8) : m.to;
    const victim = pieceEls.get(capSq);
    const isCap = !!victim && victim !== mover;
    if (isCap) victim.classList.add('gone');
    if (mover) {
      mover.classList.add('anim');
      Object.assign(mover.style, placeOf(m.to));
      if (m.promo) setTimeout(() => { mover.style.backgroundImage = pieceImage(m.promo); }, 120);
    }
    if (m.flag === 'castle') {
      const rk = { 62: [63, 61], 58: [56, 59], 6: [7, 5], 2: [0, 3] }[m.to];
      const rookEl = pieceEls.get(rk[0]);
      if (rookEl) { rookEl.classList.add('anim'); Object.assign(rookEl.style, placeOf(rk[1])); }
    }
    isCap ? sfx.capture() : sfx.move();
    setTimeout(() => {
      game.pos = C.makeMove(fromPos, m);
      renderPieces();
      done();
    }, 240);
  }

  // =================================================================
  // Input: tap-to-move and drag-and-drop (mouse, touch, pen)
  // =================================================================
  function squareAt(x, y) {
    const r = el.board.getBoundingClientRect();
    const col = Math.floor(((x - r.left) / r.width) * 8), row = Math.floor(((y - r.top) / r.height) * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return -1;
    return squares[row * 8 + col].sq;
  }

  function select(sq) {
    game.sel = sq;
    game.targets = sq < 0 ? [] : C.legalMoves(game.pos).filter((m) => m.from === sq);
    if (sq >= 0) sfx.select();
    paint();
  }

  let drag = null;
  el.board.addEventListener('pointerdown', (e) => {
    if (game.locked || game.done) return;
    e.preventDefault();
    Sound.init();
    const sq = squareAt(e.clientX, e.clientY);
    if (sq < 0) return;
    if (game.sel >= 0 && game.targets.some((m) => m.to === sq)) { tryMove(game.sel, sq); return; }
    const p = game.pos.b[sq];
    if (p !== '.' && C.colorOf(p) === game.player) {
      const already = game.sel === sq;
      select(sq);
      const pe = pieceEls.get(sq);
      drag = { sq, pe, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, already };
      try { el.board.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    } else select(-1);
  });
  el.board.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
    drag.moved = true;
    const r = el.board.getBoundingClientRect();
    const size = r.width / 8;
    drag.pe.classList.add('drag');
    drag.pe.style.left = (e.clientX - r.left - size / 2) + 'px';
    drag.pe.style.top = (e.clientY - r.top - size * 0.65) + 'px';
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.moved) { if (d.already) select(-1); return; }  // tap on selected piece again = deselect
    const sq = squareAt(e.clientX, e.clientY);
    if (sq >= 0 && game.targets.some((m) => m.to === sq)) tryMove(d.sq, sq, true);
    else { d.pe.classList.remove('drag'); Object.assign(d.pe.style, placeOf(d.sq)); }
  };
  el.board.addEventListener('pointerup', endDrag);
  el.board.addEventListener('pointercancel', endDrag);
  el.board.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  el.board.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  el.board.addEventListener('contextmenu', (e) => e.preventDefault());

  function tryMove(from, to, dropped) {
    const options = C.legalMoves(game.pos).filter((m) => m.from === from && m.to === to);
    if (!options.length) return;
    if (options.length > 1) { choosePromotion(options, dropped); return; }
    commit(options[0], dropped);
  }

  function choosePromotion(options, dropped) {
    game.locked = true;
    el.promo.innerHTML = '<p>PROMOTE TO</p><div class="choices"></div>';
    const box = el.promo.querySelector('.choices');
    for (const m of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.backgroundImage = pieceImage(m.promo);
      b.setAttribute('aria-label', { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[m.promo.toLowerCase()]);
      b.onclick = () => { el.promo.hidden = true; game.locked = false; commit(m, dropped); };
      box.appendChild(b);
    }
    el.promo.hidden = false;
  }

  function commit(m, dropped) {
    game.locked = true;
    const before = game.pos;
    const after = C.makeMove(before, m);
    const mate = C.inCheck(after) && C.legalMoves(after).length === 0;
    const moveSan = C.san(before, m);
    game.sel = -1; game.targets = [];
    paint();
    const finish = () => {
      game.last = [m.from, m.to];
      if (mate) win(m, moveSan, after); else miss(m, moveSan, after);
    };
    if (dropped) { // piece is already under the finger: place it instantly
      game.pos = after;
      renderPieces();
      (m.captured !== '.' || m.flag === 'ep') ? sfx.capture() : sfx.move();
      finish();
    } else animate(m, before, finish);
  }

  // =================================================================
  // Outcomes
  // =================================================================
  function win(m, moveSan, after) {
    game.done = true;
    game.hint = [];
    game.check = C.kingSquare(after, after.turn);
    paint();
    sfx.mate();
    const stars = game.mistakes === 0 && game.hints === 0 ? 3 : game.mistakes <= 1 && game.hints <= 1 ? 2 : 1;
    if (!(prog.stars[game.n] >= stars)) prog.stars[game.n] = stars;
    prog.max = Math.max(prog.max, Math.min(TOTAL, game.n + 1));
    save();
    feedback(`${moveSan} — checkmate!`, 'good');
    confetti();
    showResult('CHECKMATE!', stars, moveSan);
  }

  function miss(m, moveSan, after) {
    game.mistakes++;
    sfx.wrong();
    game.bad = m.to;
    paint();
    el.board.classList.remove('shake'); void el.board.offsetWidth; el.board.classList.add('shake');
    let why;
    if (!C.inCheck(after)) why = `${moveSan} isn’t even check.`;
    else {
      const replies = C.legalMoves(after);
      const k = replies.find((r) => r.piece.toLowerCase() === 'k');
      const cap = replies.find((r) => r.to === m.to);
      const r = k || cap || replies[0];
      why = `${moveSan} — but ${C.san(after, r, replies)} escapes.`;
    }
    feedback(`${why} Try again!`, 'bad');
    if (game.mistakes >= 3) el.answer.hidden = false;
    game.timer = setTimeout(() => {
      game.pos = game.start;
      game.bad = -1;
      game.last = [];
      renderPieces();
      paint();
      game.locked = false;
    }, 1300);
  }

  function showResult(title, stars, moveSan) {
    setTimeout(() => {
      el.resultTitle.textContent = title;
      el.resultStars.innerHTML = stars > 0
        ? [1, 2, 3].map((i) => `<span class="star${i <= stars ? ' on' : ''}">★</span>`).join('')
        : '';
      el.resultMove.textContent = stars > 0
        ? `${moveSan} · ${stars === 3 ? 'Perfect!' : stars === 2 ? 'Nice!' : 'Solved!'}`
        : `The mate was ${moveSan}`;
      el.next.textContent = game.n >= TOTAL ? 'BACK TO LEVELS ▸' : 'NEXT LEVEL ▸';
      el.result.hidden = false;
      el.next.focus({ preventScroll: true });
      el.nextLvl.disabled = game.n >= TOTAL;
    }, 650);
  }

  el.next.addEventListener('click', () => (game.n >= TOTAL ? go(0) : go(game.n + 1)));
  el.prev.addEventListener('click', () => { if (game.n > 1) go(game.n - 1); });
  el.nextLvl.addEventListener('click', () => { if (game.n < TOTAL && game.n + 1 <= prog.max) go(game.n + 1); });
  el.back.addEventListener('click', () => { if (!el.play.hidden) game.lastPage = tierIndex(game.n); });

  el.hint.addEventListener('click', () => {
    if (game.locked || game.done) return;
    Sound.init();
    const m = C.findMove(game.start, game.sol);
    game.hints++;
    sfx.hint();
    if (game.hints === 1) { game.hint = [m.from]; feedback('Hint: move this piece.', 'info'); }
    else { game.hint = [m.from, m.to]; feedback('Hint: …to the flashing square.', 'info'); el.hint.disabled = true; el.answer.hidden = false; }
    paint();
  });

  el.answer.addEventListener('click', () => {
    if (game.done) return;
    clearTimeout(game.timer);
    game.done = true; game.locked = true; game.bad = -1; game.hint = [];
    game.pos = game.start;
    renderPieces();
    const m = C.findMove(game.start, game.sol);
    const moveSan = C.san(game.start, m);
    animate(m, game.start, () => {
      game.last = [m.from, m.to];
      game.check = C.kingSquare(game.pos, game.pos.turn);
      paint();
      if (prog.stars[game.n] === undefined) prog.stars[game.n] = 0;
      prog.max = Math.max(prog.max, Math.min(TOTAL, game.n + 1));
      save();
      feedback(`The answer: ${moveSan}`, 'info');
      showResult('SOLUTION', 0, moveSan);
    });
  });

  window.addEventListener('keydown', (e) => {
    if (el.play.hidden) return;
    if (e.key === 'Escape') { game.lastPage = tierIndex(game.n); go(0); }
    else if ((e.key === 'Enter' || e.key === 'n' || e.key === 'N') && !el.result.hidden) { e.preventDefault(); el.next.click(); }
    else if (e.key === 'h' || e.key === 'H') el.hint.click();
    else if (e.key === 'ArrowLeft' && !el.prev.disabled) el.prev.click();
    else if (e.key === 'ArrowRight' && !el.nextLvl.disabled) el.nextLvl.click();
  });

  function confetti() {
    const wrap = el.board.parentElement;
    const colors = ['#f2a93b', '#5ff2e6', '#ff5fa2', '#7ee07a', '#ffe066'];
    for (let i = 0; i < 36; i++) {
      const c = document.createElement('span');
      c.className = 'confetti';
      c.style.left = Math.random() * 100 + '%';
      c.style.top = -10 + Math.random() * 30 + '%';
      c.style.background = colors[i % colors.length];
      c.style.setProperty('--dx', (Math.random() - 0.5) * 120 + 'px');
      c.style.animationDelay = Math.random() * 0.25 + 's';
      wrap.appendChild(c);
      setTimeout(() => c.remove(), 1600);
    }
  }

  // =================================================================
  // Layout: biggest square board that fits the screen
  // =================================================================
  function layout() {
    const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    const w = el.play.clientWidth || document.querySelector('.chess-app').clientWidth;
    const reserved = 240;
    const size = Math.floor(Math.max(260, Math.min(w - 8, 600, vh - reserved)) / 8) * 8;
    el.board.style.width = el.board.style.height = size + 'px';
  }
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', () => setTimeout(layout, 250));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);

  if (!TOTAL) { document.body.insertAdjacentHTML('beforeend', '<p style="text-align:center">Puzzles failed to load.</p>'); return; }
  route();

  // Test / debug hook
  window.__mate = {
    game, prog, go, PUZZLES, C, save,
    show(fen, flip) { game.pos = C.fromFEN(fen); game.flip = !!flip; game.last = []; game.locked = true; buildBoard(); renderPieces(); paint(); },
  };
})();
