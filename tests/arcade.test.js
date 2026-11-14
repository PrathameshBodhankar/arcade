// Run: node tests/arcade.test.js   (needs: npm i playwright)
const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
// Tiny static server so folder links like "snake/" resolve to index.html (as on GitHub Pages).
const http = require('http');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
let BASE = '';
const url = (p) => BASE + '/' + p;
const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const errors = [];
  const track = (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && errors.push(m.text())); return p; };

  // ---------------- Homepage ----------------
  const home = track(await browser.newPage({ viewport: { width: 1200, height: 900 } }));
  await home.goto(url('index.html'));
  const cards = await home.$$eval('.card', (els) => els.map((e) => ({ href: e.getAttribute('href'), game: e.dataset.game })));
  ok(cards.length === 5, 'homepage shows 5 game cards');
  ok(cards.some((c) => c.href === 'chess/'), 'Mate in One card links inside the arcade');
  ok(cards.some((c) => c.href === 'https://prathameshbodhankar.github.io/bolt-run/'), 'Bolt Run card links to the existing Bolt Run site');
  ok(cards.some((c) => c.href === 'snake/') && cards.some((c) => c.href === 'pinball/'), 'Snake and Pinball cards link inside the arcade');
  await home.evaluate(() => { localStorage.setItem('arcade.snake.hi', '120'); });
  await home.reload();
  ok(await home.$eval('[data-hi="arcade.snake.hi"]', (e) => e.textContent) === '00120', 'homepage shows saved best scores');
  await home.screenshot({ path: path.join(OUT, 'home.png') });
  await home.click('a[data-game="snake"]');
  await home.waitForURL(/\/snake\/$/);
  ok(await home.evaluate(() => !!window.__snake), 'clicking Snake opens the snake game');
  await home.click('a.back');
  await home.waitForLoadState();
  ok((await home.$$('.card')).length === 5, 'back button returns to the arcade');

  // ---------------- Snake ----------------
  const sn = track(await browser.newPage({ viewport: { width: 1000, height: 800 } }));
  await sn.goto(url('snake/index.html')); await sleep(200);
  await sn.keyboard.press('Space'); await sleep(50);
  ok(await sn.evaluate(() => __snake.game.state) === 'running', 'snake: space starts');
  const eat = await sn.evaluate(() => {
    const S = __snake, g = S.game;
    g.food = { x: g.snake[0].x + 1, y: g.snake[0].y }; S.tick();
    return { len: g.snake.length, score: g.score };
  });
  ok(eat.score === 10, 'snake: eating food scores');
  const grown = await sn.evaluate(() => { __snake.tick(); return __snake.game.snake.length; });
  ok(grown === 4, 'snake: grows after eating');
  ok(await sn.evaluate(() => { const g = __snake.game; g.queue = []; __snake.turn('left'); return g.queue.length === 0; }), 'snake: cannot reverse into itself');
  const wall = await sn.evaluate(() => { const S = __snake, g = S.game; g.dir = { x: 1, y: 0 }; g.queue = []; g.snake[0].x = S.N - 1; S.tick(); return g.state; });
  ok(wall === 'over', 'snake: hitting a wall ends the game');
  const self = await sn.evaluate(() => {
    const S = __snake, g = S.game; S.reset(); g.state = 'running';
    g.snake = [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 6 }, { x: 5, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 5 }];
    g.dir = { x: 0, y: 1 }; g.queue = []; S.tick(); return g.state;
  });
  ok(self === 'over', 'snake: biting yourself ends the game');
  ok(await sn.evaluate(() => { __snake.game.eaten = 100; return __snake.rate() === 16; }), 'snake: speed caps at max');

  // ---------------- Pinball ----------------
  const pb = track(await browser.newPage({ viewport: { width: 1000, height: 900 } }));
  await pb.goto(url('pinball/index.html')); await sleep(200);
  const phys = await pb.evaluate(() => {
    const P = __pinball, out = {};
    P.start(); P.game.charge = 0.5; P.launch();
    let entered = false;
    for (let i = 0; i < 240; i++) { P.update(P.STEP); if (P.ball.x < 340 && P.ball.y < 300) entered = true; }
    out.entered = entered;
    P.game.onPlunger = false; P.game.saveT = 0;
    P.flippers.forEach((f) => { f.held = false; f.a = 0.5; });
    Object.assign(P.ball, { x: 140, y: 585, vx: 0, vy: 0 });
    for (let i = 0; i < 3; i++) P.update(P.STEP);
    P.flippers[0].held = true; let best = 0;
    for (let i = 0; i < 20; i++) { P.update(P.STEP); best = Math.min(best, P.ball.vy); }
    out.flipVy = best;
    // stress: 3 simulated minutes with a tapping bot
    P.start(); P.game.ballNo = -1000;
    const hold = [0, 0]; let escapes = 0, still = 0, stuck = 0, launches = 0;
    for (let i = 0; i < 120 * 180; i++) {
      if (P.game.onPlunger) { P.game.charge = Math.random(); P.launch(); launches++; }
      const b = P.ball;
      for (const k of [0, 1]) {
        const near = b.y > 545 && (k === 0 ? b.x < 185 : b.x >= 185) && b.vy > -50;
        if (near && hold[k] <= -0.25) hold[k] = 0.12;
        hold[k] -= P.STEP; P.flippers[k].held = hold[k] > 0;
      }
      P.update(P.STEP);
      if (b.x < 10 || b.x > 390 || b.y < 20) escapes++;
      if (Math.hypot(b.vx, b.vy) < 5 && !P.game.onPlunger) { if (++still === 600) stuck++; } else still = 0;
    }
    Object.assign(out, { escapes, stuck, launches, score: P.game.score });
    // drain → next ball, then game over after 3
    P.start(); P.game.saveT = 0; P.game.onPlunger = false;
    Object.assign(P.ball, { x: 185, y: 740, vx: 0, vy: 100 }); P.update(P.STEP);
    out.afterDrain = P.game.ballNo;
    P.game.ballNo = 3; P.game.onPlunger = false; P.game.saveT = 0;
    Object.assign(P.ball, { x: 185, y: 740, vx: 0, vy: 100 }); P.update(P.STEP);
    out.end = P.game.state;
    // ball save
    P.game.overAt = -1e9; P.start(); P.launch(); P.game.saveT = 3;
    Object.assign(P.ball, { x: 185, y: 740, vx: 0, vy: 100 }); P.update(P.STEP);
    out.saved = P.game.ballNo === 1 && P.game.onPlunger;
    return out;
  });
  ok(phys.entered, 'pinball: launched ball reaches the playfield');
  ok(phys.flipVy < -800, `pinball: flipper whacks the ball up (vy ${Math.round(phys.flipVy)})`);
  ok(phys.escapes === 0, 'pinball: ball never escapes the table (3 min stress)');
  ok(phys.stuck === 0, 'pinball: ball never gets stuck');
  ok(phys.launches > 3 && phys.score > 0, 'pinball: balls drain and score accumulates');
  ok(phys.afterDrain === 2, 'pinball: draining serves the next ball');
  ok(phys.end === 'over', 'pinball: game over after the last ball');
  ok(phys.saved, 'pinball: ball save returns the ball');
  await pb.reload(); await sleep(200);
  await pb.keyboard.press('Space'); await pb.keyboard.down('Space'); await sleep(400); await pb.keyboard.up('Space'); await sleep(500);
  ok(await pb.evaluate(() => !__pinball.game.onPlunger), 'pinball: hold/release Space launches');
  await pb.keyboard.down('ArrowLeft'); await sleep(60);
  ok(await pb.evaluate(() => __pinball.flippers[0].a < 0), 'pinball: left arrow raises left flipper');
  await pb.screenshot({ path: path.join(OUT, 'pinball.png') });
  await pb.keyboard.up('ArrowLeft');

  // ---------------- iPhone ----------------
  for (const dev of ['iPhone 13', 'iPhone 13 landscape']) {
    const ctx = await browser.newContext({ ...devices[dev] });
    for (const page of ['index.html', 'snake/index.html', 'pinball/index.html']) {
      const m = track(await ctx.newPage());
      await m.goto(url(page)); await sleep(250);
      const fit = await m.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
      ok(fit.sw <= fit.iw, `${dev}: ${page} has no sideways scroll`);
      if (page !== 'index.html') {
        await m.tap('#stage'); await sleep(80);
        const st = await m.evaluate(() => (window.__snake || window.__pinball).game.state);
        ok(st === 'running', `${dev}: tap starts ${page}`);
        if (dev === 'iPhone 13') await m.screenshot({ path: path.join(OUT, page.split('/')[0] + '-iphone.png') });
      }
      await m.close();
    }
    await ctx.close();
  }
  // pinball multi-touch: left & right halves
  const ctxT = await browser.newContext({ ...devices['iPhone 13'] });
  const t = track(await ctxT.newPage());
  await t.goto(url('pinball/index.html')); await sleep(200);
  await t.evaluate(() => { __pinball.start(); __pinball.launch(); });
  const box = await t.locator('#stage').boundingBox();
  const cdp = await ctxT.newCDPSession(t);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 30, y: box.y + box.height - 60, id: 1 }, { x: box.x + box.width - 60, y: box.y + box.height - 60, id: 2 }] });
  await sleep(80);
  const both = await t.evaluate(() => __pinball.flippers.map((f) => f.held));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  ok(both[0] && both[1], 'pinball: two-finger touch holds both flippers');

  ok(errors.length === 0, 'no JavaScript errors ' + errors.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})();
