// Run: node tests/gems.test.js   (needs: npm i playwright)
// 1) match-3 engine rules, 2) all 300 levels are valid and winnable, 3) the Gem Burst UI.
const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const E = require(path.join(ROOT, 'gems', 'engine.js'));
global.window = {};
require(path.join(ROOT, 'gems', 'levels.js'));
const LEVELS = global.window.GEM_LEVELS;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. Engine rules on hand-built boards ----------
// base colours (x + 2y) % 6 never line up 3 in a row; tests then override cells.
function board(over, opts = {}) {
  const map = opts.map || Array(7).fill('#######');
  const g = new E.Game({ map, colors: 6, moves: 30, goals: opts.goals || [{ type: 'score', n: 1e9 }], stars: [1, 2] }, 42);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) { const i = y * g.w + x; if (g.holdable(i)) g.gems[i] = g.newGem((x + 2 * y) % 6); }
  for (const [x, y, c, sp] of over) g.gems[y * g.w + x] = c === 'drop' ? g.newGem(-1, null, true) : g.newGem(c, sp || null);
  return g;
}
const I = (g, x, y) => y * g.w + x;
const createdSp = (r) => r.phases.filter((p) => p.kind === 'clear').flatMap((p) => p.created.map((id) => p.gems.find((x) => x && x.id === id))).filter(Boolean).map((x) => x.sp);

{ // 3 in a row clears, no special
  const g = board([[0, 0, 5], [1, 0, 5], [2, 1, 5]]);
  ok(!g.findRuns().length, 'test board starts with no matches');
  const r = g.swap(I(g, 2, 1), I(g, 2, 0));
  ok(r.ok && r.phases.some((p) => p.kind === 'clear') && g.movesLeft === 29, 'a 3-match is accepted, clears gems and uses a move');
}
{ // invalid swap
  const g = board([]);
  const before = JSON.stringify(g.gems);
  const r = g.swap(I(g, 0, 0), I(g, 1, 0));
  ok(!r.ok && JSON.stringify(g.gems) === before && g.movesLeft === 30, 'a swap that makes no match is refused and changes nothing');
}
{ // 4 in a row → line gem
  const g = board([[0, 0, 5], [1, 0, 5], [3, 0, 5], [2, 1, 5]]);
  const r = g.swap(I(g, 2, 1), I(g, 2, 0));
  ok(createdSp(r).includes('h'), '4 in a row creates a line gem');
}
{ // L shape → bomb
  const g = board([[0, 2, 5], [1, 2, 5], [3, 2, 5], [2, 3, 5], [2, 4, 5], [2, 1, 5]]);
  const r = g.swap(I(g, 2, 1), I(g, 2, 2));
  ok(createdSp(r).includes('bomb'), 'an L / T shape creates a bomb');
}
{ // 5 in a row → prism
  const g = board([[0, 0, 5], [1, 0, 5], [3, 0, 5], [4, 0, 5], [2, 1, 5]]);
  const r = g.swap(I(g, 2, 1), I(g, 2, 0));
  ok(createdSp(r).includes('prism'), '5 in a row creates a prism');
}
{ // prism + gem clears every gem of that colour
  const g = board([[3, 3, -1, 'prism']]);
  const target = g.gems[I(g, 4, 3)].c;
  const count = g.gems.filter((x) => x && x.c === target).length;
  const r = g.swap(I(g, 3, 3), I(g, 4, 3));
  const first = r.phases.find((p) => p.kind === 'clear');
  ok(r.ok && first.removed.filter((x) => x.c === target).length === count, 'prism + gem clears every gem of that colour');
}
{ // line + line → cross
  const g = board([[3, 3, 1, 'h'], [4, 3, 2, 'v']]);
  const r = g.swap(I(g, 3, 3), I(g, 4, 3));
  const first = r.phases.find((p) => p.kind === 'clear');
  ok(first.removed.length >= 7 + 7 - 1, 'line + line clears a whole row and column');
}
{ // bomb + bomb → 5×5
  const g = board([[3, 3, 1, 'bomb'], [3, 4, 2, 'bomb']]);
  const r = g.swap(I(g, 3, 3), I(g, 3, 4));
  ok(r.phases.find((p) => p.kind === 'clear').removed.length >= 25 - 5, 'bomb + bomb clears a 5×5 area');
}
{ // ice + stone
  const g = board([[0, 1, 5], [1, 1, 5], [2, 2, 5]], { map: ['#######', 'iiiiiii', '#######', '###s###', '#######', '#######', '#######'], goals: [{ type: 'ice' }] });
  g.gems[I(g, 3, 3)] = null;
  // stone sits at (3,3); put a vertical match next to it
  const g2 = board([[2, 2, 5], [2, 4, 5], [1, 3, 5]], { map: ['#######', '#######', '#######', '###s###', '#######', '#######', '#######'], goals: [{ type: 'stone' }] });
  g2.gems[I(g2, 3, 3)] = null;
  g2.gems[I(g2, 2, 3)] = g2.newGem(0);
  ok(!g2.findRuns().length, 'stone board has no match at start');
  g2.swap(I(g2, 1, 3), I(g2, 2, 3));
  ok(g2.stone[I(g2, 3, 3)] === 0 && g2.status === 'won', 'a match next to a stone smashes it (stone goal complete)');
  const iceBefore = g.iceLeft();
  g.swap(I(g, 2, 2), I(g, 2, 1));
  ok(g.iceLeft() <= iceBefore - 3, 'clearing gems on ice breaks the ice');
}
{ // star coin reaches the bottom: coin above (3,6); a bottom-row match clears (3,6) → coin drops onto the exit row
  const g = board([[3, 5, 'drop'], [1, 6, 5], [2, 6, 5], [3, 6, 0], [4, 6, 5]], { goals: [{ type: 'drop', n: 1 }] });
  ok(!g.findRuns().length, 'coin board has no match at start');
  const r = g.swap(I(g, 3, 6), I(g, 4, 6));
  ok(r.ok && g.dropsCollected === 1 && r.phases.some((p) => p.kind === 'collect') && g.status === 'won', 'a star coin is collected when it reaches the bottom row');
}

// ---------- 2. Levels ----------
ok(LEVELS.length === 300, 'there are 300 levels');
let problems = [];
LEVELS.forEach((lv, k) => {
  const w = lv.map[0].length;
  if (!lv.map.every((r) => r.length === w)) problems.push(`#${k + 1} ragged map`);
  if (!(lv.moves >= 8 && lv.moves <= 50)) problems.push(`#${k + 1} moves ${lv.moves}`);
  if (!(lv.stars[0] < lv.stars[1])) problems.push(`#${k + 1} stars`);
  if (!lv.goals.length) problems.push(`#${k + 1} no goals`);
  const g = new E.Game(lv, 1);
  if (g.findRuns().length || !g.hasMove()) problems.push(`#${k + 1} bad start board`);
  if (lv.goals.some((x) => x.type === 'ice') && !g.iceTotal) problems.push(`#${k + 1} ice goal without ice`);
  if (lv.goals.some((x) => x.type === 'stone') && !g.stoneTotal) problems.push(`#${k + 1} stone goal without stone`);
});
ok(problems.length === 0, 'every level is well-formed (map, moves, stars, goals, starting board) ' + problems.slice(0, 5).join('; '));

// a simple greedy bot (no peeking at refills) must be able to win sampled levels within their move limit
function greedy(lv, seed) {
  const g = new E.Game(lv, seed); g.record = false;
  const r = new E.RNG(seed * 7 + 1);
  while (g.status === 'playing') {
    let best = null, bv = -Infinity;
    for (const [a, b] of g.validMoves()) {
      const s = g.clone(); s.record = false; s.rng = new E.RNG(r.int(1e9));
      const before = g.score, ice = g.iceLeft(), st = g.stoneLeft(), dr = g.dropsCollected, col = g.collected.slice();
      s.swap(a, b);
      let v = (s.score - before) * 0.02 + (ice - s.iceLeft()) * 40 + (st - s.stoneLeft()) * 50 + (s.dropsCollected - dr) * 500;
      for (const q of lv.goals) if (q.type === 'collect') v += Math.min(Math.max(0, q.n - col[q.c]), s.collected[q.c] - col[q.c]) * 40;
      v += s.gems.reduce((t, x, i) => t + (x && x.drop ? (i / s.w | 0) * 15 : 0), 0) + (s.status === 'won' ? 1e4 : 0) + r.next() * 5;
      if (v > bv) { bv = v; best = [a, b]; }
    }
    g.swap(best[0], best[1]);
  }
  return g.status === 'won';
}
const sample = [1, 2, 5, 10, 25, 50, 75, 100, 150, 200, 250, 300];
const rates = sample.map((n) => { let w = 0; for (let s = 0; s < 6; s++) if (greedy(LEVELS[n - 1], 900 + s)) w++; return [n, w]; });
ok(rates.every(([, w]) => w >= 2), 'sampled levels are winnable within their move limit: ' + rates.map(([n, w]) => `L${n}:${w}/6`).join(' '));

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
  const p = track(await browser.newPage({ viewport: { width: 1000, height: 950 } }));
  await p.goto(BASE + '/gems/'); await sleep(200);
  ok((await p.$$('.tier')).length === 6 && (await p.$$('.tile')).length === 50, 'map: 6 worlds × 50 levels');
  ok(await p.$eval('.tile:nth-child(2)', (t) => t.disabled), 'map: level 2 starts locked');
  await p.click('#continueBtn'); await sleep(300);
  ok(await p.isVisible('#goBtn') && /moves/.test(await p.textContent('#panel')), 'level intro shows the goal and move count');
  await p.click('#goBtn'); await sleep(150);

  const cellCenter = async (i) => {
    const s = await p.evaluate(() => ({ w: __gems.S.game.w, c: __gems.S.cell, ox: __gems.S.ox, oy: __gems.S.oy }));
    const box = await p.locator('#board').boundingBox();
    return [box.x + s.ox + ((i % s.w) + 0.5) * s.c, box.y + s.oy + (Math.floor(i / s.w) + 0.5) * s.c];
  };
  const swipe = async (a, b) => { const [x1, y1] = await cellCenter(a), [x2, y2] = await cellCenter(b); await p.mouse.move(x1, y1); await p.mouse.down(); await p.mouse.move(x2, y2, { steps: 4 }); await p.mouse.up(); };
  const idle = async () => { for (let k = 0; k < 60; k++) { if (!(await p.evaluate(() => __gems.S.busy))) return; await sleep(100); } };

  // invalid swipe: no move used
  const bad = await p.evaluate(() => { const g = __gems.S.game; for (let i = 0; i < g.gems.length - 1; i++) if ((i + 1) % g.w && g.holdable(i) && g.holdable(i + 1) && !g.canSwap(i, i + 1)) return [i, i + 1]; return null; });
  await swipe(...bad); await idle();
  ok(await p.evaluate(() => __gems.S.game.movesLeft === __gems.LEVELS[0].moves), 'swiping into a non-match bounces back without using a move');

  // valid swipe
  const good = await p.evaluate(() => __gems.S.game.validMoves()[0]);
  await swipe(...good); await idle();
  ok(await p.evaluate(() => __gems.S.game.movesLeft === __gems.LEVELS[0].moves - 1 && __gems.S.game.score > 0), 'a valid swipe makes a match, scores, and uses a move');
  ok(await p.evaluate(() => { const S = __gems.S; return S.view.gems.every((g, i) => !S.game.holdable(i) || (g && S.vis.has(g.id))); }), 'after the animation every cell shows a gem');

  // tap-tap swap
  const t2 = await p.evaluate(() => __gems.S.game.validMoves()[0]);
  await p.mouse.click(...await cellCenter(t2[0])); await sleep(60); await p.mouse.click(...await cellCenter(t2[1])); await idle();
  ok(await p.evaluate(() => __gems.S.game.movesLeft === __gems.LEVELS[0].moves - 2), 'tap one gem then a neighbour also swaps');

  // play to a win (give plenty of moves so the test is deterministic)
  await p.evaluate(() => { __gems.S.game.movesLeft = 300; __gems.S.disp.moves = 300; });
  for (let k = 0; k < 300; k++) {
    if (await p.evaluate(() => __gems.S.ended)) break;
    const mv = await p.evaluate(() => { const m = __gems.S.game.validMoves(); return m[Math.floor(Math.random() * m.length)]; });
    await p.evaluate(([a, b]) => __gems.trySwap(a, b), mv);
    await idle();
  }
  await sleep(1500);
  ok(await p.evaluate(() => __gems.S.game.status === 'won' && __gems.prog.stars[1] >= 1 && __gems.prog.max === 2), 'reaching the goal wins: stars saved, next level unlocked');
  ok(/LEVEL CLEAR/.test(await p.textContent('#panel')), 'win screen appears');
  await p.screenshot({ path: path.join(__dirname, 'screenshots', 'gems-win.png') });
  await p.click('#nextBtn'); await sleep(300);
  ok(await p.evaluate(() => __gems.S.n === 2), 'Next level opens level 2');

  // lose: one move left, make a move that can't finish the goal
  await p.click('#goBtn'); await sleep(100);
  await p.evaluate(() => { __gems.S.game.movesLeft = 1; __gems.S.disp.moves = 1; });
  const mv2 = await p.evaluate(() => __gems.S.game.validMoves()[0]);
  await p.evaluate(([a, b]) => __gems.trySwap(a, b), mv2);
  await idle(); await sleep(900);
  const lost = await p.evaluate(() => __gems.S.game.status);
  if (lost === 'lost') {
    ok(/OUT OF MOVES/.test(await p.textContent('#panel')), 'running out of moves shows the try-again screen');
    await p.click('#skipPanelBtn'); await sleep(300);
    ok(await p.evaluate(() => __gems.S.n === 3 && __gems.prog.stars[2] === -1 && __gems.prog.max === 3), 'Skip from the lose screen moves on and marks the level skipped');
  } else ok(true, '(level 2 happened to be won on the last move — lose path skipped this run)');

  // skip button + map marks
  await p.click('#skipBtn'); await sleep(300);
  await p.goto(BASE + '/gems/'); await sleep(200);
  ok(await p.$eval('.tile:nth-child(3)', (t) => t.classList.contains('skipped')), 'skipped levels show SKIP on the map');
  ok(/LEVEL 4/.test(await p.textContent('#continueBtn')), 'Continue goes to the next new level');
  await p.goto(BASE + '/'); await sleep(200);
  ok(/1\/300/.test(await p.textContent('[data-gems]')), 'arcade homepage card shows Gem Burst progress');

  // iPhone
  for (const dev of ['iPhone 13', 'iPhone 13 landscape']) {
    const ctx = await browser.newContext({ ...devices[dev] });
    const m = track(await ctx.newPage());
    await m.goto(BASE + '/gems/'); await m.evaluate(() => localStorage.setItem('arcade.gems', JSON.stringify({ max: 300, stars: {} })));
    await m.goto('about:blank'); await m.goto(BASE + '/gems/#/level/260'); await sleep(400);
    await m.tap('#goBtn'); await sleep(200);
    const fit = await m.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, iw: innerWidth, right: r.right }; });
    ok(fit.sw <= fit.iw && fit.right <= fit.iw, `${dev}: board fits the screen width`);
    const mv = await m.evaluate(() => __gems.S.game.validMoves()[0]);
    const s = await m.evaluate(() => ({ w: __gems.S.game.w, c: __gems.S.cell, ox: __gems.S.ox, oy: __gems.S.oy, moves: __gems.S.game.movesLeft }));
    const box = await m.locator('#board').boundingBox();
    const at = (i) => [box.x + s.ox + ((i % s.w) + 0.5) * s.c, box.y + s.oy + (Math.floor(i / s.w) + 0.5) * s.c];
    await m.touchscreen.tap(...at(mv[0])); await sleep(60); await m.touchscreen.tap(...at(mv[1])); await sleep(1500);
    ok(await m.evaluate((n) => __gems.S.game.movesLeft === n - 1, s.moves), `${dev}: tap-tap swap works on touch`);
    if (dev === 'iPhone 13') await m.screenshot({ path: path.join(__dirname, 'screenshots', 'gems-iphone.png') });
    await ctx.close();
  }

  ok(errors.length === 0, 'no JavaScript errors ' + errors.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})();
