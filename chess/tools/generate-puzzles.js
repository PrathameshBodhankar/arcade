/*
 * Puzzle generator for Mate in One.
 *
 *   node tools/generate-puzzles.js [games=6000] [out=puzzles.js]
 *   POOL_OUT=pool.json node tools/generate-puzzles.js 30000   (also saves all candidates)
 *   node tools/generate-puzzles.js pool.json                  (re-select from a saved pool)
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
  if (/\.json$/.test(process.argv[2] || '')) {           // reuse a saved candidate pool
    select(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
    return;
  }
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
    if (process.env.POOL_OUT) fs.writeFileSync(process.env.POOL_OUT, JSON.stringify(list));
    select(list);
  }
}

/* ---------------------------------------------------------------
 * Selection: 1000 puzzles, easy → hard, but VARIED.
 * Back-rank rook mates are by far the most common pattern in games,
 * so picking purely by difficulty gives "rook, rook, rook…". Instead:
 *  1. Group candidates by mating piece (queen, rook, bishop, knight, pawn, other).
 *  2. Each tier of 100 levels gets a quota per piece type; every type's own
 *     list is sorted by difficulty and spread across the 10 tiers, so each
 *     type also gets harder as you climb.
 *  3. Inside a tier, levels are ordered by difficulty but re-arranged so the
 *     same pattern (piece + "king on the edge" or not) never appears twice in a row.
 * --------------------------------------------------------------- */
function themeOf(p) {
  const s0 = C.fromFEN(p.fen);
  const s1 = C.makeMove(s0, C.findMove(s0, p.prev));
  const ksq = C.kingSquare(s1, s1.turn === 'w' ? 'b' : 'w');
  const kr = C.rankOf(ksq), kf = C.fileOf(ksq);
  const edge = kr === 0 || kr === 7 || kf === 0 || kf === 7;
  const t = p.f.type === 'k' || p.f.castle ? 'x' : p.f.type;
  return { piece: t, theme: t + (edge ? 'E' : 'M') + (p.f.capture ? 'c' : 'q') };
}

function select(list) {
  if (list.length < 1000) { console.error('Not enough puzzles — run with more games.'); process.exit(2); }
  const QUOTA = { q: 30, r: 26, b: 15, n: 15, p: 10, x: 4 };   // per 100 levels (sums to 100)
  const byType = {};
  for (const p of list) { Object.assign(p, themeOf(p)); (byType[p.piece] = byType[p.piece] || []).push(p); }
  for (const t in byType) byType[t].sort((a, b) => a.d - b.d);
  console.log('pool by mating piece', Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])));

  // How many of each type per tier we can actually afford.
  const per = {};
  let short = 0;
  for (const t of Object.keys(QUOTA)) {
    const have = (byType[t] || []).length;
    per[t] = Math.min(QUOTA[t], Math.floor(have / 10));
    short += QUOTA[t] - per[t];
  }
  // Fill any shortfall with queens/rooks/bishops, whichever has the most spare.
  while (short > 0) {
    const t = ['q', 'r', 'b', 'n'].sort((a, b) => ((byType[b] || []).length - per[b] * 10) - ((byType[a] || []).length - per[a] * 10))[0];
    per[t]++; short--;
  }
  console.log('per tier', per);

  const tiers = Array.from({ length: 10 }, () => []);
  for (const t of Object.keys(per)) {
    const arr = byType[t] || [];
    const need = per[t] * 10;
    // evenly spaced picks across this type's difficulty range, then dealt to tiers in order
    const picks = [];
    for (let i = 0; i < need; i++) picks.push(arr[Math.floor(i * (arr.length - 1) / Math.max(1, need - 1))]);
    const uniqPicks = [...new Set(picks)];
    let i = 0;
    for (let tier = 0; tier < 10; tier++) for (let k = 0; k < per[t]; k++) if (uniqPicks[i]) tiers[tier].push(uniqPicks[i++]);
  }

  // Order inside each tier: spread every piece type evenly through the 100 levels
  // (each type in its own easy → hard order), then make sure the same piece never
  // mates twice in a row and the same pattern doesn't repeat within 3 levels.
  const picked = [];
  for (const tier of tiers) {
    const groups = {};
    for (const p of tier) (groups[p.piece] = groups[p.piece] || []).push(p);
    const slotted = [];
    for (const g of Object.values(groups)) {
      g.sort((a, b) => a.d - b.d);
      g.forEach((p, k) => slotted.push({ p, slot: (k + 0.5) / g.length + p.d * 1e-6 }));
    }
    slotted.sort((a, b) => a.slot - b.slot);
    const seq = slotted.map((x) => x.p);
    for (let i = 0; i < seq.length; i++) {
      const prev = picked.concat(seq.slice(0, i)).slice(-3);
      const bad = (q) => (prev.length && q.piece === prev[prev.length - 1].piece) || prev.some((r) => r.theme === q.theme);
      if (!bad(seq[i])) continue;
      const j = seq.findIndex((q, k) => k > i && !bad(q));
      if (j > 0) { const [q] = seq.splice(j, 1); seq.splice(i, 0, q); }
    }
    picked.push(...seq);
  }
  if (picked.length !== 1000) throw new Error('picked ' + picked.length);

  // re-verify every puzzle with the engine
  for (const p of picked) {
    const s0 = C.fromFEN(p.fen);
    const s1 = C.makeMove(s0, C.findMove(s0, p.prev));
    const mates = C.legalMoves(s1).filter((m) => C.isCheckmate(C.makeMove(s1, m)));
    if (mates.length !== 1 || C.uci(mates[0]) !== p.sol) throw new Error('verification failed ' + p.fen);
  }
  const count = (arr, k) => arr.reduce((o, p) => ((o[p[k]] = (o[p[k]] || 0) + 1), o), {});
  console.log('levels 1-20 pieces:', picked.slice(0, 20).map((p) => p.piece).join(''));
  console.log('totals', count(picked, 'piece'), '| white to mate', picked.filter((p) => C.fromFEN(p.fen).turn === 'b').length);
  const rows = picked.map((p) => JSON.stringify([p.fen, p.prev, p.sol]));
  const OUT = process.argv[3] || path.join(__dirname, '..', 'puzzles.js');
  fs.writeFileSync(OUT,
    '/* 1000 original mate-in-1 puzzles, generated by tools/generate-puzzles.js.\n' +
    ' * Each entry: [FEN before the opponent\'s move, opponent move (UCI), mating move (UCI)].\n' +
    ' * 10 tiers of 100, easier → harder; each tier mixes queen, rook, bishop, knight and pawn mates.\n' +
    ' * Every puzzle has exactly one mating move. */\n' +
    'window.MATE_PUZZLES = [\n' + rows.join(',\n') + '\n];\n');
  console.log('wrote', OUT);
}
