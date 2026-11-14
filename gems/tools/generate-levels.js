/*
 * Level generator for Gem Burst.
 *
 *   node tools/generate-levels.js [levels=300] [out=levels.js]
 *
 * 1. Design: each level gets a board shape, colour count, goal(s) and obstacles,
 *    following a progression (new goal types are introduced one at a time, boards
 *    get odd shapes, ice/stone get thicker, double goals appear later).
 * 2. Calibrate: a bot that plays like a casual player (best-looking move most of the time,
 *    any valid move ~1/3 of the time, and it can't see which gems will drop in next) plays the level many times with a huge move budget and
 *    we record how many moves it needed. The move limit is chosen so the bot wins
 *    a target share of games — ~97% on level 1 sliding to ~65% by level 300, with
 *    a harder "boss" every 10th level and an easier breather right after.
 *    Levels the bot can't finish reliably are redesigned easier.
 * 3. Stars: ★★ / ★★★ thresholds come from the bot's final scores (median / top 15%).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const E = require(path.join(__dirname, '..', 'engine.js'));

const RUNS = 36;          // bot games per calibration
const BUDGET = 90;        // move budget while calibrating
const CASUAL = 0.35;      // share of moves the bot plays without thinking (models a casual player)
// early levels are calibrated against an even more casual player so newcomers breeze through
const casualFor = (n) => (n <= 20 ? 0.6 : n <= 60 ? 0.6 - ((n - 20) / 40) * 0.25 : CASUAL);
const maxMovesFor = (n) => (n <= 60 ? 30 : 40);

// ---------------- board shapes ----------------
const SHAPES = {
  full: () => true,
  corners: (x, y, w, h) => !((x === 0 || x === w - 1) && (y === 0 || y === h - 1)),
  bigCorners: (x, y, w, h) => Math.min(x, w - 1 - x) + Math.min(y, h - 1 - y) >= 2 || (x > 0 && x < w - 1) && (y > 0 && y < h - 1) && Math.min(x, w - 1 - x) + Math.min(y, h - 1 - y) >= 1,
  hole: (x, y, w, h) => !(Math.abs(x - (w - 1) / 2) < 1 && Math.abs(y - (h - 1) / 2) < 1),
  twoHoles: (x, y, w, h) => !((x === 2 || x === w - 3) && (y === 3 || y === 4)),
  hourglass: (x, y, w, h) => !(y >= 3 && y <= h - 4 && (x < 2 || x > w - 3)),
  cross: (x, y, w, h) => !((x < 2 || x > w - 3) && (y < 2 || y > h - 3)),
  diamond: (x, y, w, h) => Math.abs(x - (w - 1) / 2) + Math.abs(y - (h - 1) / 2) <= Math.max(w, h) / 2 + 0.5,
  pillars: (x, y, w, h) => !((x === 2 || x === w - 3) && y >= 3 && y <= h - 4),
  notch: (x, y, w, h) => !(y < 2 && Math.abs(x - (w - 1) / 2) < 1),
  ushape: (x, y, w, h) => !(y < 3 && x >= 3 && x <= w - 4),
  zigzag: (x, y, w, h) => !((y === 2 && x < 3) || (y === h - 3 && x > w - 4)),
};
const SHAPE_ORDER = [
  ['full'], ['full', 'corners'], ['corners', 'hole', 'full'], ['hole', 'notch', 'twoHoles', 'corners'],
  ['twoHoles', 'pillars', 'notch', 'cross', 'hole'], ['cross', 'hourglass', 'ushape', 'pillars', 'diamond', 'zigzag'],
];

function rngFor(n, k) { return new E.RNG(n * 7349 + k * 104729 + 17); }
const pick = (r, arr) => arr[r.int(arr.length)];

// target bot win-rate for level n (1-based)
function targetWin(n) {
  let p = 0.97 - 0.32 * ((n - 1) / 299);
  if (n % 10 === 0) p -= 0.12;         // boss level
  if (n % 10 === 1 && n > 1) p += 0.05;  // breather
  return Math.max(0.45, Math.min(0.98, p));
}

function design(n, ease, single, forceType) {
  const r = rngFor(n, ease);
  const w = n <= 15 ? 7 : 8;
  const h = n <= 15 ? 8 : 9;
  const stage = Math.min(SHAPE_ORDER.length - 1, Math.floor(n / 30));
  const shapeName = n <= 3 ? 'full' : pick(r, SHAPE_ORDER[stage]);
  const shape = SHAPES[shapeName];
  const grid = [];
  for (let y = 0; y < h; y++) { const row = []; for (let x = 0; x < w; x++) row.push(shape(x, y, w, h) ? '#' : '.'); grid.push(row); }
  const colors = n <= 40 ? 5 : n % 7 === 3 ? 5 : 6;

  // goal schedule: introduce one type at a time, then mix
  const intro = ['score', 'score', 'score', 'collect', 'collect', 'score', 'collect', 'ice', 'ice', 'collect',
    'ice', 'score', 'stone', 'stone', 'collect', 'stone', 'ice', 'drop', 'drop', 'collect', 'drop', 'ice', 'stone', 'drop', 'collect'];
  // goal types come from their own random stream, so redesigning a level (ease > 0)
  // only makes the amounts easier — it never swaps the goal type
  const rt = rngFor(n, 0);
  const types = n <= intro.length ? [intro[n - 1]] : (() => {
    const all = ['score', 'collect', 'collect', 'ice', 'ice', 'stone', 'drop', 'drop'];
    const first = pick(rt, all);
    const twoGoalChance = n < 60 ? 0 : n < 150 ? 0.3 : 0.45;
    if (rt.next() < twoGoalChance) {
      let second; do { second = pick(rt, ['collect', 'ice', 'stone', 'drop']); } while (second === first);
      return [first, second];
    }
    return [first];
  })();
  if (single) types.length = 1;                         // fallback: keep just one goal
  if (forceType) types.splice(0, types.length, forceType);   // last resort: an always-tunable goal

  const scale = Math.pow(0.78, ease);                  // each redesign makes it easier
  const prog = Math.min(1, n / 300);
  const cells = [];
  grid.forEach((row, y) => row.forEach((ch, x) => { if (ch === '#') cells.push([x, y]); }));
  const mirror = (x) => w - 1 - x;
  const put = (x, y, ch) => { if (grid[y][x] === '#') grid[y][x] = ch; if (grid[y][mirror(x)] === '#') grid[y][mirror(x)] = ch; };

  const goals = [];
  for (const t of types) {
    if (t === 'score') goals.push({ type: 'score', n: Math.round((2500 + n * 70) * scale / 500) * 500 });
    if (t === 'collect') {
      const k = n < 40 ? 1 : n < 120 ? 1 + r.int(2) : 1 + r.int(3);
      const used = new Set();
      for (let j = 0; j < k; j++) {
        let c; do { c = r.int(colors); } while (used.has(c)); used.add(c);
        goals.push({ type: 'collect', c, n: Math.max(6, Math.round((12 + prog * 26) * scale / k * (k > 1 ? 1.4 : 1))) });
      }
    }
    if (t === 'ice') {
      const count = Math.max(4, Math.round((8 + prog * 26) * scale));
      const double = n > 70 && r.next() < 0.25 + prog * 0.4;
      // ice in a band or random symmetric spots
      const band = r.next() < 0.5;
      let placed = 0;
      for (let tries = 0; tries < 400 && placed < count; tries++) {
        const [x, y] = band ? [r.int(w), h - 1 - r.int(Math.max(2, Math.ceil(count / w) + 1))] : pick(r, cells);
        if (grid[y][x] !== '#') continue;
        put(x, y, double && r.next() < 0.6 ? 'I' : 'i');
        placed += x === mirror(x) ? 1 : 2;
      }
      goals.push({ type: 'ice' });
    }
    if (t === 'stone') {
      const count = Math.max(2, Math.round((4 + prog * 12) * scale));
      const double = n > 90 && r.next() < 0.3 + prog * 0.4;
      let placed = 0;
      for (let tries = 0; tries < 400 && placed < count; tries++) {
        const [x, y] = pick(r, cells);
        if (y < 1 || grid[y][x] !== '#') continue;
        put(x, y, double && r.next() < 0.5 ? 'S' : 's');
        placed += x === mirror(x) ? 1 : 2;
      }
      goals.push({ type: 'stone' });
    }
    if (t === 'drop') {
      const k = Math.max(1, Math.round((1 + prog * 3.2) * Math.min(1, scale + 0.2)));
      const tops = [];
      // coins start a couple of rows down so they don't take forever to bring home
      for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (grid[y][x] === '#') { const yy = Math.min(h - 3, y + 2); tops.push([x, grid[yy][x] === '#' ? yy : y]); break; }
      const starts = Math.min(2, k);
      for (let j = 0; j < starts; j++) { const [x, y] = tops[(r.int(tops.length) + j * 3) % tops.length]; grid[y][x] = 'd'; }
      goals.push({ type: 'drop', n: k });
    }
  }
  // later levels: a few stones as pure obstacles even when not a goal
  if (n > 45 && !types.includes('stone') && r.next() < 0.35 * scale) {
    for (let j = 0; j < 2; j++) { const [x, y] = pick(r, cells); if (y > 1 && grid[y][x] === '#') put(x, y, 's'); }
  }
  return { map: grid.map((row) => row.join('')), colors, goals, shape: shapeName };
}

// ---------------- greedy bot ----------------
function evalMove(g, a, b, r) {
  const sim = g.clone();
  sim.record = false;
  // The bot must NOT know which gems will drop in next (a person can't see that either):
  // give the simulation its own random refill stream.
  sim.rng = new E.RNG((r.next() * 2 ** 32) >>> 0);
  const before = { score: g.score, collected: g.collected.slice(), ice: g.iceLeft(), stone: g.stoneLeft(), drops: g.dropsCollected };
  const dropRows = (gm) => gm.gems.reduce((s, x, i) => s + (x && x.drop ? Math.floor(i / gm.w) : 0), 0);
  const rowsBefore = dropRows(g);
  sim.swap(a, b);
  let v = 0;
  for (const goal of g.lv.goals) {
    if (goal.type === 'score') v += (sim.score - before.score) * 0.05;
    if (goal.type === 'collect') { const left = Math.max(0, goal.n - before.collected[goal.c]); v += Math.min(left, sim.collected[goal.c] - before.collected[goal.c]) * 40; }
    if (goal.type === 'ice') v += (before.ice - sim.iceLeft()) * 40;
    if (goal.type === 'stone') v += (before.stone - sim.stoneLeft()) * 55;
    if (goal.type === 'drop') v += (sim.dropsCollected - before.drops) * 500 + (dropRows(sim) - rowsBefore) * 18;
  }
  v += (sim.score - before.score) * 0.01;
  v += sim.gems.filter((x) => x && x.sp).length * 6;
  if (sim.status === 'won') v += 10000;
  return v + r.next() * 8;
}

// Play with a fixed move budget, recording progress after every move.
function botPlay(level, seed, budget) {
  const g = new E.Game(Object.assign({}, level, { moves: budget }), seed);
  g.record = false;
  const r = new E.RNG(seed ^ 0x5bd1e995);
  const traj = [];
  while (g.status === 'playing') {
    const moves = g.validMoves();
    let best = null, bv = -Infinity;
    if (r.next() < (level.casual || CASUAL)) best = moves[r.int(moves.length)];      // casual-player moment: any valid move
    else for (const [a, b] of moves) { const v = evalMove(g, a, b, r); if (v > bv) { bv = v; best = [a, b]; } }
    g.swap(best[0], best[1]);
    traj.push({ score: g.score - g.bonus, collected: g.collected.slice(), ice: g.iceLeft(), stone: g.stoneLeft(), drops: g.dropsCollected, won: g.status === 'won' });
  }
  return { won: g.status === 'won', used: g.movesUsed, scoreAtWin: g.score - g.bonus, traj };
}

const quantile = (arr, q) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; };
const STRUCT = new Set(['ice', 'stone', 'drop']);

function desiredMoves(n) {
  const r = rngFor(n, 99);
  return Math.round(15 + 13 * Math.min(1, n / 300) + r.int(5) - 2);
}

function buildLevel(n) {
  return tryBuild(n, false) || tryBuild(n, true) || tryBuild(n, 'collect') || (() => { throw new Error('could not build level ' + n); })();
}

// relaxed = second chance for stubborn levels: allow longer levels and a slightly lower bot win rate
function tryBuild(n, relaxed) {
  const p = targetWin(n) - (relaxed ? 0.1 : 0);
  for (let ease = 0; ease < (relaxed ? 8 : 6); ease++) {
    const d = relaxed ? design(n, ease + 2, true, relaxed === 'collect' ? 'collect' : null) : design(n, ease);
    const scalar = d.goals.filter((g) => !STRUCT.has(g.type));
    const hasStruct = d.goals.some((g) => STRUCT.has(g.type));
    // 1) calibration runs: scalar goals made unreachable so games run the full budget
    const calib = Object.assign({}, d, { casual: casualFor(n), goals: d.goals.map((g) => (STRUCT.has(g.type) ? g : Object.assign({}, g, { n: 1e9 }))) });
    const budget = 60;
    const runs = [];
    for (let k = 0; k < RUNS; k++) runs.push(botPlay(calib, n * 1000 + k * 17 + ease * 7, budget));
    // move at which all structural goals were done (Infinity if never)
    const structDone = runs.map((g) => {
      if (!hasStruct) return 0;
      const ice = d.goals.some((x) => x.type === 'ice'), stone = d.goals.some((x) => x.type === 'stone');
      const dg = d.goals.find((x) => x.type === 'drop');
      const i = g.traj.findIndex((t) => (!ice || t.ice === 0) && (!stone || t.stone === 0) && (!dg || t.drops >= dg.n));
      return i < 0 ? Infinity : i + 1;
    });
    if (structDone.filter(isFinite).length < RUNS * (relaxed ? Math.max(0.7, p) : Math.max(0.85, p))) continue;     // too hard → redesign easier
    let moves = hasStruct ? Math.max(desiredMoves(n) - 4, quantile(structDone, scalar.length ? Math.sqrt(p) : p)) : desiredMoves(n);
    if (moves > maxMovesFor(n) + (relaxed ? 10 : 0)) continue;   // would be a slog → redesign easier
    moves = Math.max(10, moves);
    // 2) scale scalar targets so the bot meets everything by `moves` in ~p of games
    let goals = d.goals;
    if (scalar.length) {
      const ratio = runs.map((g, k) => {
        if (structDone[k] > moves) return 0;
        const t = g.traj[Math.min(moves, g.traj.length) - 1];
        return Math.min(...scalar.map((sg) => (sg.type === 'score' ? t.score : t.collected[sg.c]) / sg.n));
      });
      const f = quantile(ratio, 1 - p);
      if (!(f > 0)) continue;
      goals = d.goals.map((g) => {
        if (g.type === 'score') return { type: 'score', n: Math.max(1000, Math.floor(g.n * f / 250) * 250) };
        if (g.type === 'collect') return { type: 'collect', c: g.c, n: Math.max(5, Math.floor(g.n * f)) };
        return g;
      });
    }
    const level = { map: d.map, colors: d.colors, moves, goals, casual: casualFor(n) };
    // 3) verification runs with the final level → real win rate + star thresholds
    const ver = [];
    for (let k = 0; k < RUNS; k++) ver.push(botPlay(level, n * 7777 + k * 31 + ease, moves));
    const wins = ver.filter((x) => x.won);
    if (wins.length < RUNS * Math.min(0.9, p - 0.15)) continue;
    const finals = wins.map((x) => x.scoreAtWin + (moves - x.used) * E.SCORE.moveBonus);
    const round = (v) => Math.max(100, Math.round(v / 100) * 100);
    let s2 = round(quantile(finals, 0.5)), s3 = round(quantile(finals, 0.85));
    if (s3 <= s2) s3 = s2 + 500;
    return { n, map: d.map, colors: d.colors, moves, goals, stars: [s2, s3], shape: d.shape, ease: ease + (relaxed === 'collect' ? 20 : relaxed ? 10 : 0), botWin: +(wins.length / RUNS).toFixed(2), target: +p.toFixed(2) };
  }
  return null;
}

if (!isMainThread) {
  const out = [];
  for (const n of workerData.levels) { out.push(buildLevel(n)); parentPort.postMessage({ tick: n }); }
  parentPort.postMessage({ done: out });
} else {
  const COUNT = parseInt(process.argv[2] || '300', 10);
  const OUT = process.argv[3] || path.join(__dirname, '..', 'levels.js');
  const T = Math.max(1, os.cpus().length);
  const t0 = Date.now();
  const all = [];
  let finished = 0, ticks = 0;
  for (let w = 0; w < T; w++) {
    const levels = [];
    for (let n = 1 + w; n <= COUNT; n += T) levels.push(n);
    const worker = new Worker(__filename, { workerData: { levels } });
    worker.on('message', (m) => {
      if (m.tick && ++ticks % 25 === 0) console.log(`${ticks}/${COUNT} levels (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      if (m.done) { all.push(...m.done); if (++finished === T) write(); }
    });
    worker.on('error', (e) => { console.error(e); process.exit(1); });
  }
  function write() {
    all.sort((a, b) => a.n - b.n);
    const types = {};
    all.forEach((l) => l.goals.forEach((g) => { types[g.type] = (types[g.type] || 0) + 1; }));
    console.log('goal types', types, '| redesigned', all.filter((l) => l.ease > 0).length,
      '| avg moves', (all.reduce((a, l) => a + l.moves, 0) / all.length).toFixed(1),
      '| bot win first 10', all.slice(0, 10).map((l) => l.botWin).join(' '), '| last 10', all.slice(-10).map((l) => l.botWin).join(' '));
    const rows = all.map((l) => JSON.stringify({ map: l.map, colors: l.colors, moves: l.moves, goals: l.goals, stars: l.stars }));
    fs.writeFileSync(OUT,
      `/* ${all.length} Gem Burst levels, generated and bot-tested by tools/generate-levels.js. */\n` +
      'window.GEM_LEVELS = [\n' + rows.join(',\n') + '\n];\n');
    fs.writeFileSync(OUT.replace(/\.js$/, '.report.json'), JSON.stringify(all.map(({ n, shape, ease, botWin, target, moves, goals }) => ({ n, shape, ease, botWin, target, moves, goals: goals.map((g) => g.type).join('+') }))));
    console.log('wrote', OUT, `in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
