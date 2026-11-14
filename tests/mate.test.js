// Run: node tests/mate.test.js   (needs: npm i playwright)
// Verifies every puzzle with the engine, then drives the Mate in One UI.
const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'chess', 'core.js'));
global.window = {};
require(path.join(ROOT, 'chess', 'puzzles.js'));
const PUZZLES = global.window.MATE_PUZZLES;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. Engine sanity (perft) ----------
const perft = [
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 3, 8902],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 3, 97862],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 4, 43238],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 3, 9467],
  ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', 3, 62379],
];
ok(perft.every(([f, d, n]) => C.perft(C.fromFEN(f), d) === n), 'engine: perft matches published counts (castling, en passant, promotion)');

// ---------- 2. Every puzzle ----------
ok(PUZZLES.length === 1000, 'there are exactly 1000 puzzles');
let bad = [];
const seen = new Set();
PUZZLES.forEach(([fen, prev, sol], i) => {
  try {
    const s0 = C.fromFEN(fen);
    const pm = C.findMove(s0, prev);
    if (!pm) throw new Error('opponent move illegal');
    const s1 = C.makeMove(s0, pm);
    if (C.inCheck(s1, s0.turn)) throw new Error('mover left in check');
    const mates = C.legalMoves(s1).filter((m) => C.isCheckmate(C.makeMove(s1, m)));
    if (mates.length !== 1) throw new Error(mates.length + ' mating moves');
    if (C.uci(mates[0]) !== sol) throw new Error('stored answer differs');
    const key = C.toFEN(s1).split(' ').slice(0, 4).join(' ');
    if (seen.has(key)) throw new Error('duplicate'); seen.add(key);
  } catch (e) { bad.push(`#${i + 1}: ${e.message}`); }
});
ok(bad.length === 0, 'every puzzle: legal, exactly one mating move, answer correct, no duplicates ' + bad.slice(0, 5).join('; '));
const whiteToMate = PUZZLES.filter(([fen]) => C.fromFEN(fen).turn === 'b').length;
ok(whiteToMate > 300 && whiteToMate < 700, `mix of White and Black to move (${whiteToMate} white / ${1000 - whiteToMate} black)`);

// ---------- 2b. Variety: levels mix piece types, no same piece twice in a row ----------
const pieceOf = ([fen, prev, sol]) => {
  const s0 = C.fromFEN(fen), s1 = C.makeMove(s0, C.findMove(s0, prev));
  const m = C.findMove(s1, sol);
  return m.piece.toLowerCase();
};
const pieces = PUZZLES.map(pieceOf);
let repeats = 0;
for (let i = 1; i < pieces.length; i++) if (pieces[i] === pieces[i - 1]) repeats++;
ok(repeats <= 10, `consecutive levels use different mating pieces (${repeats} repeats in 1000)`);
const kinds20 = new Set(pieces.slice(0, 20));
ok(kinds20.size >= 4, `first 20 levels mix ${kinds20.size} piece types: ${pieces.slice(0, 20).join('')}`);
let tiersOk = true;
for (let t = 0; t < 10; t++) {
  const tier = pieces.slice(t * 100, t * 100 + 100);
  const maxShare = Math.max(...['q', 'r', 'b', 'n', 'p', 'k'].map((k) => tier.filter((x) => x === k).length));
  if (maxShare > 45 || new Set(tier).size < 4) tiersOk = false;
}
ok(tiersOk, 'every tier of 100 mixes at least 4 piece types and no type dominates');

// ---------- 3. UI ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0].split('#')[0]));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const errors = [];
  const track = (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && errors.push(m.text())); return p; };

  const p = track(await browser.newPage({ viewport: { width: 1100, height: 950 } }));
  await p.goto(BASE + '/chess/');
  await sleep(200);
  ok((await p.$$('.tier')).length === 10 && (await p.$$('.tile')).length === 100, 'map: 10 tiers × 100 level tiles');
  ok(await p.$eval('.tile:nth-child(2)', (t) => t.disabled), 'map: level 2 starts locked');
  await p.click('#continueBtn');
  await sleep(1100);
  ok(await p.evaluate(() => __mate.game.n === 1 && !__mate.game.locked), 'continue opens level 1 after the opponent move plays');

  const centerOf = async (sq) => {
    const flip = await p.evaluate(() => __mate.game.flip);
    const box = await p.locator('#board').boundingBox();
    const f = sq & 7, r = 7 - (sq >> 3);
    const col = flip ? 7 - f : f, row = flip ? r : 7 - r;
    return [box.x + (col + 0.5) * box.width / 8, box.y + (row + 0.5) * box.height / 8];
  };
  const play = async (from, to) => { await p.mouse.click(...await centerOf(from)); await p.mouse.click(...await centerOf(to)); };
  const moves = () => p.evaluate(() => {
    const g = __mate.game, C = __mate.C;
    const sol = C.findMove(g.pos, g.sol);
    const wrong = C.legalMoves(g.pos).find((m) => C.uci(m) !== g.sol);
    return { sol: [sol.from, sol.to], wrong: [wrong.from, wrong.to] };
  });

  // perfect solve → 3 stars
  let mv = await moves();
  await play(...mv.sol);
  await sleep(1000);
  ok(await p.evaluate(() => __mate.prog.stars[1] === 3 && __mate.prog.max === 2), 'first-try solve gives ★★★ and unlocks level 2');
  ok(await p.isVisible('#result'), 'checkmate result screen appears');
  await p.click('#nextBtn');
  await sleep(1100);

  // wrong move, hint, then solve → fewer stars
  mv = await moves();
  await play(...mv.wrong);
  await sleep(400);
  const fb = await p.textContent('#feedback');
  ok(/Try again/.test(fb), 'wrong move explains why it fails: ' + fb.trim());
  await sleep(1200);
  ok(await p.evaluate(() => __mate.C.toFEN(__mate.game.pos) === __mate.C.toFEN(__mate.game.start) && !__mate.game.locked), 'wrong move is taken back');
  await p.click('#hintBtn');
  ok(await p.evaluate(() => __mate.game.hint.length === 1) && (await p.$$('.sq.hint')).length === 1, 'hint highlights the piece to move');
  await play(...mv.sol);
  await sleep(1000);
  ok(await p.evaluate(() => __mate.prog.stars[2] === 2), 'solve after 1 mistake + 1 hint gives ★★');

  // drag-and-drop + show answer
  await p.click('#nextBtn'); await sleep(1100);
  for (let i = 0; i < 3; i++) { mv = await moves(); await play(...mv.wrong); await sleep(1800); }
  ok(await p.isVisible('#answerBtn'), '"Show answer" appears after 3 misses');
  await p.click('#answerBtn'); await sleep(1000);
  ok(await p.evaluate(() => __mate.prog.stars[3] === 0 && __mate.prog.max === 4), 'showing the answer unlocks the next level without stars');
  await p.click('#nextBtn'); await sleep(1100);
  mv = await moves();
  const [x1, y1] = await centerOf(mv.sol[0]), [x2, y2] = await centerOf(mv.sol[1]);
  await p.mouse.move(x1, y1); await p.mouse.down(); await p.mouse.move(x2, y2, { steps: 8 }); await p.mouse.up();
  await sleep(900);
  ok(await p.evaluate(() => __mate.prog.stars[4] === 3), 'drag-and-drop solving works');
  await p.screenshot({ path: path.join(__dirname, 'screenshots', 'mate-desktop.png') });
  // skip: from level 5 straight to level 6, marked on the map, Continue doesn't pull back
  await p.click('#nextBtn'); await sleep(1100);
  ok(await p.evaluate(() => __mate.game.n === 5) && await p.isVisible('#skipBtn'), 'skip button is shown on an unsolved level');
  await p.click('#skipBtn'); await sleep(1100);
  ok(await p.evaluate(() => __mate.game.n === 6 && __mate.prog.stars[5] === -1 && __mate.prog.max === 6), 'skip unlocks and opens the next level, marks the level as skipped');
  await p.keyboard.press('s'); await sleep(1100);
  ok(await p.evaluate(() => __mate.game.n === 7 && __mate.prog.stars[6] === -1), 'the S key also skips');
  await p.goto(BASE + '/chess/'); await sleep(200);
  ok(await p.$eval('.tile:nth-child(5)', (t) => t.classList.contains('skipped') && /SKIP/.test(t.textContent)), 'skipped level shows SKIP on the map');
  ok(/LEVEL 7/.test(await p.textContent('#continueBtn')), 'Continue goes to the next new level, not back to skipped ones');
  await p.click('.tile:nth-child(5)'); await sleep(1100);
  mv = await moves();
  await play(...mv.sol); await sleep(1000);
  ok(await p.evaluate(() => __mate.prog.stars[5] === 3), 'solving a skipped level later replaces the SKIP mark with stars');
  ok(!(await p.isVisible('#skipBtn')), 'skip button hides once the level is solved');


  // progress persists & shows on homepage
  await p.goto(BASE + '/chess/'); await sleep(200);
  ok(await p.textContent('#solvedCount') === '4 / 1000', 'map shows solved count after reload');
  await p.goto(BASE + '/'); await sleep(200);
  ok(await p.textContent('[data-solved]') === '4/1000', 'arcade homepage card shows Mate in One progress');

  // direct link to a locked level falls back to the map
  await p.goto(BASE + '/chess/#/level/900'); await sleep(300);
  ok(await p.isVisible('#mapView'), 'locked levels cannot be opened by URL');

  // ---------- iPhone ----------
  for (const dev of ['iPhone 13', 'iPhone 13 landscape']) {
    const ctx = await browser.newContext({ ...devices[dev] });
    const m = track(await ctx.newPage());
    await m.goto(BASE + '/chess/#/level/1'); await sleep(1200);
    const fit = await m.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    ok(fit.sw <= fit.iw, `${dev}: no sideways scroll`);
    const row = await m.evaluate(() => { const r = document.querySelector('.actions').getBoundingClientRect(); return { right: r.right, iw: innerWidth, skip: !!document.getElementById('skipBtn').offsetWidth }; });
    ok(row.right <= row.iw && row.skip, `${dev}: hint / skip buttons fit on screen`);
    const box = await m.locator('#board').boundingBox();
    const sol = await m.evaluate(() => { const g = __mate.game, C = __mate.C, s = C.findMove(g.pos, g.sol); return [s.from, s.to, g.flip]; });
    const at = (sq) => { const f = sq & 7, r = 7 - (sq >> 3); const col = sol[2] ? 7 - f : f, row = sol[2] ? r : 7 - r; return [box.x + (col + 0.5) * box.width / 8, box.y + (row + 0.5) * box.height / 8]; };
    await m.touchscreen.tap(...at(sol[0])); await sleep(80); await m.touchscreen.tap(...at(sol[1])); await sleep(900);
    ok(await m.evaluate(() => __mate.game.done), `${dev}: tap-tap solves the puzzle`);
    if (dev === 'iPhone 13') await m.screenshot({ path: path.join(__dirname, 'screenshots', 'mate-iphone.png') });
    await ctx.close();
  }

  ok(errors.length === 0, 'no JavaScript errors ' + errors.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})();
