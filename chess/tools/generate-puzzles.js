/*
 * Puzzle generator for Mate in One.
 *
 *   node tools/generate-puzzles.js [games=6000] [out=puzzles.js]
 *
 * How it works
 *  1. Two simple bots play each other from the normal starting position.
 *     Each bot greedily likes captures, safe development and checks, avoids
 *     hanging pieces (most of the time) and occasionally blunders — so the
 *     positions look like real club games, not random piece soup.
 *  2. Whenever the side to move has a checkmate available, that position is a
 *     candidate. We keep it only if there is EXACTLY ONE mating move (one
 *     clear answer), the game is past the opening, and there are enough
 *     legal moves to make it a real search.
 *  3. Every candidate gets a difficulty score (how many "decoy" checks exist,
 *     quiet/discovered/under-promotion/castling/en-passant mates, etc.).
 *  4. We pick 1000 positions spread evenly from easiest to hardest.
 *
 * Output: puzzles.js → window.MATE_PUZZLES = [[fenBefore, opponentMove, solution], ...]
 * The game shows `fenBefore`, animates the opponent's (blundering) move, then
 * asks the player to find the mate.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const C = require(path.join(__dirname, '..', 'core.js'));

const VAL = { p: 1, n: 3, b: 3.2, r: 5, q: 9, k: 0 };
const val = (p) => VAL[p.toLowerCase()];

// Small mulberry32 PRNG so runs are reproducible per seed.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function centrality(i) {
  const f = C.fileOf(i), r = C.rankOf(i);
  return 3.5 - Math.max(Math.abs(f - 3.5), Math.abs(r - 3.5));
}

// Value of the cheapest piece of side `by` attacking square `sq`.
// Trick: hide every other piece type of that side (as neutral blockers 'x') and reuse attacked().
function cheapestAttacker(s, sq, by) {
  for (const t of ['p', 'n', 'b', 'r', 'q', 'k']) {
    const keep = by === 'w' ? t.toUpperCase() : t;
    const b = s.b.map((p, i) => (i !== sq && C.colorOf(p) === by && p !== keep ? 'x' : p));
    if (C.attacked({ b, turn: s.turn, castling: '', ep: -1 }, sq, by)) return VAL[t];
  }
  return 9;
}

function scoreMove(s, m, rand) {
  const after = C.makeMove(s, m);
  const me = s.turn, them = after.turn;
  let sc = 0;
  if (m.captured !== '.') sc += val(m.captured);
  if (m.promo) sc += val(m.promo) - 1;
  if (m.flag === 'castle') sc += 0.6;
  const t = m.piece.toLowerCase();
  if (t !== 'k' && t !== 'q') sc += (centrality(m.to) - centrality(m.from)) * 0.12;
  if (t === 'p') sc += 0.05;
  if (C.inCheck(after)) sc += 0.35;
  // One-ply threat check: what's the best capture the opponent gets after this move?
  // (gain = victim value, minus our recapture if the square is defended)
  let threat = 0;
  for (let i = 0; i < 64; i++) {
    const v = after.b[i];
    if (v === '.' || C.colorOf(v) !== me || v.toLowerCase() === 'k') continue;
    if (!C.attacked(after, i, them)) continue;
    const victim = val(v);
    const gain = C.attacked(after, i, me) ? Math.max(0, victim - cheapestAttacker(after, i, them)) : victim;
    if (gain > threat) threat = gain;
  }
  sc -= threat * 0.9;
  return sc + (rand() - 0.5) * 0.9;
}

function mateMoves(s, legal) {
  const out = [];
  for (const m of legal) {
    const a = C.makeMove(s, m);
    if (C.inCheck(a) && C.legalMoves(a).length === 0) out.push(m);
  }
  return out;
}

function features(s, m, legal) {
  const after = C.makeMove(s, m);
  const checks = legal.filter((x) => C.inCheck(C.makeMove(s, x))).length;
  const kSq = C.kingSquare(after, after.turn);
  // Does the moved piece itself attack the king? If not → discovered mate.
  const solo = { b: Array(64).fill('.'), turn: after.turn, castling: '', ep: -1, half: 0, full: 1 };
  solo.b[m.to] = after.b[m.to]; solo.b[kSq] = after.b[kSq];
  // keep blockers so sliding pieces are tested on the real board
  const movedAttacks = (() => {
    const b2 = after.b.slice();
    for (let i = 0; i < 64; i++) if (i !== m.to && i !== kSq && C.colorOf(b2[i]) === s.turn) b2[i] = '.';
    // re-add blockers of the defending side (they block lines)
    return C.attacked({ b: b2, turn: after.turn, castling: '', ep: -1 }, kSq, s.turn);
  })();
  const discovered = !movedAttacks;
  const b3 = after.b.slice(); b3[m.to] = '.';
  const otherAttacks = C.attacked({ b: b3, turn: after.turn, castling: '', ep: -1 }, kSq, s.turn);
  const double = movedAttacks && otherAttacks;
  const pieces = s.b.filter((p) => p !== '.').length;
  const t = (m.promo || m.piece).toLowerCase();
  return {
    checks, legal: legal.length, discovered, double, pieces,
    capture: m.captured !== '.' || m.flag === 'ep',
    promo: !!m.promo, under: !!m.promo && m.promo.toLowerCase() !== 'q',
    castle: m.flag === 'castle', ep: m.flag === 'ep',
    type: t, inCheck: C.inCheck(s),
    sacrifice: C.attacked(after, m.to, after.turn) && !m.flag,
  };
}

function difficulty(f) {
  let d = 0;
  d += (f.checks - 1) * 1.15;          // decoy checks to reject
  d += f.legal * 0.035;
  d += f.pieces * 0.04;
  if (f.discovered) d += 2.6;
  if (f.double) d += 0.8;
  if (f.under) d += 3.2; else if (f.promo) d += 0.8;
  if (f.castle) d += 3.5;
  if (f.ep) d += 3.5;
  if (f.type === 'n') d += 0.7;
  if (f.type === 'p') d += 0.9;
  if (f.type === 'k') d += 2.5;
  if (!f.capture) d += 0.5;
  if (f.inCheck) d += 0.9;
  if (f.sacrifice) d += 0.6;
  return +d.toFixed(3);
}

function playGame(seed) {
  const rand = rng(seed);
  let s = C.fromFEN(C.START);
  const hist = [];          // [fen, uci] of each move played
  const seen = new Map();
  for (let ply = 0; ply < 220; ply++) {
    const legal = C.legalMoves(s);
    if (!legal.length) return null;
    const mates = mateMoves(s, legal);
    if (mates.length) {
      if (mates.length !== 1 || ply < 14 || legal.length < 8 || !hist.length) return null;
      // Keep realistic, game-like material: the mating side may not be crushing already.
      let lead = 0, pieces = 0;
      for (const p of s.b) { if (p === '.') continue; pieces++; lead += (C.colorOf(p) === s.turn ? 1 : -1) * val(p); }
      if (lead < -6 || lead > 8 || pieces < 7) return null;
      const m = mates[0];
      const f = features(s, m, legal);
      const [prevFen, prevUci] = hist[hist.length - 1];
      return { fen: prevFen, prev: prevUci, sol: C.uci(m), key: C.toFEN(s).split(' ').slice(0, 4).join(' '), f, d: difficulty(f) };
    }
    // insufficient material / repetition guards
    const pieces = s.b.filter((p) => p !== '.' && p.toLowerCase() !== 'k').length;
    if (pieces === 0) return null;
    const key = s.b.join('') + s.turn;
    seen.set(key, (seen.get(key) || 0) + 1);
    if (seen.get(key) >= 3) return null;

    let m;
    if (rand() < 0.035) m = legal[Math.floor(rand() * legal.length)];        // occasional blunder
    else {
      let best = -1e9;
      for (const x of legal) { const v = scoreMove(s, x, rand); if (v > best) { best = v; m = x; } }
    }
    hist.push([C.toFEN(s), C.uci(m)]);
    s = C.makeMove(s, m);
  }
  return null;
}

if (!isMainThread) {
  const { start, count } = workerData;
  const out = [];
  for (let g = start; g < start + count; g++) {
    const r = playGame(g * 7919 + 13);
    if (r) out.push(r);
    if ((g - start) % 200 === 0) parentPort.postMessage({ progress: g - start });
  }
  parentPort.postMessage({ done: out });
} else {
  const GAMES = parseInt(process.argv[2] || '6000', 10);
  const OUT = process.argv[3] || path.join(__dirname, '..', 'puzzles.js');
  const THREADS = Math.max(1, require('os').cpus().length);
  const per = Math.ceil(GAMES / THREADS);
  const t0 = Date.now();
  let finished = 0;
  const all = [];
  for (let w = 0; w < THREADS; w++) {
    const worker = new Worker(__filename, { workerData: { start: w * per, count: per } });
    worker.on('message', (msg) => {
      if (msg.done) {
        all.push(...msg.done);
        if (++finished === THREADS) finish();
      }
    });
    worker.on('error', (e) => { console.error(e); process.exit(1); });
  }

  function finish() {
    // de-duplicate positions
    const uniq = new Map();
    for (const p of all) if (!uniq.has(p.key)) uniq.set(p.key, p);
    const list = [...uniq.values()].sort((a, b) => a.d - b.d);
    console.log(`games ${GAMES}, candidates ${all.length}, unique ${list.length}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (list.length < 1000) { console.error('Not enough puzzles — run with more games.'); process.exit(2); }
    // pick 1000 evenly across the difficulty range
    const picked = [];
    for (let i = 0; i < 1000; i++) picked.push(list[Math.floor(i * (list.length - 1) / 999)]);
    // re-verify every puzzle with the engine
    for (const p of picked) {
      const s0 = C.fromFEN(p.fen);
      const pm = C.findMove(s0, p.prev);
      const s1 = C.makeMove(s0, pm);
      const mates = C.legalMoves(s1).filter((m) => C.isCheckmate(C.makeMove(s1, m)));
      if (mates.length !== 1 || C.uci(mates[0]) !== p.sol) throw new Error('verification failed ' + p.fen);
    }
    const stat = (k) => picked.filter((p) => p.f[k]).length;
    console.log('white to mate', picked.filter((p) => C.fromFEN(p.fen).turn === 'b').length,
      '| discovered', stat('discovered'), '| promo', stat('promo'), '| under', stat('under'),
      '| castle', stat('castle'), '| ep', stat('ep'), '| knight', picked.filter((p) => p.f.type === 'n').length,
      '| difficulty', picked[0].d, '→', picked[999].d);
    const rows = picked.map((p) => JSON.stringify([p.fen, p.prev, p.sol]));
    fs.writeFileSync(OUT,
      '/* 1000 original mate-in-1 puzzles, generated by tools/generate-puzzles.js.\n' +
      ' * Each entry: [FEN before the opponent\'s move, opponent move (UCI), mating move (UCI)].\n' +
      ' * Ordered from easiest to hardest. Every puzzle has exactly one mating move. */\n' +
      'window.MATE_PUZZLES = [\n' + rows.join(',\n') + '\n];\n');
    console.log('wrote', OUT);
  }
}
