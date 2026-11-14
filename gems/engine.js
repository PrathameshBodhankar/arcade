/*
 * GemEngine — match-3 rules for Gem Burst. No DOM; runs in the browser and in Node
 * (the level generator's bots play levels with it).
 *
 * Level format
 *   map:    array of strings, one char per cell
 *           '.' no cell   '#' normal   'i'/'I' ice (1/2 layers)   's'/'S' stone (1/2 hits)
 *           'd' starts with a star-drop on it
 *   colors: number of gem colours (4–6)
 *   moves:  move limit
 *   goals:  [{type:'score', n} | {type:'collect', c, n} | {type:'ice'} | {type:'stone'} | {type:'drop', n}]
 *   stars:  [score for ★★, score for ★★★]  (★ = goals met)
 *
 * Special gems
 *   4 in a row          → line gem  ('h' clears its row, 'v' its column)
 *   L / T shape (5+)    → bomb      (clears 3×3)
 *   5 in a row          → prism     (swap with a gem: clears every gem of that colour)
 *   special + special   → combined blast (cross, 3-wide cross, 5×5, colour→specials, whole board)
 *
 * Every move returns a list of "phases" (swap, clear, fall, collect, shuffle) with board
 * snapshots, so the UI can animate exactly what happened.
 */
(function (root) {
  'use strict';

  function RNG(seed) { this.s = (seed >>> 0) || 1; }
  RNG.prototype.next = function () {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  RNG.prototype.int = function (n) { return Math.floor(this.next() * n); };
  RNG.prototype.clone = function () { const r = new RNG(1); r.s = this.s; return r; };

  const SCORE = { gem: 20, blastGem: 30, ice: 50, stone: 100, special: 100, drop: 1000, moveBonus: 250 };

  class Game {
    constructor(level, seed) {
      this.lv = level;
      const rows = level.map;
      this.h = rows.length;
      this.w = rows[0].length;
      const N = this.w * this.h;
      this.cell = new Uint8Array(N);
      this.ice = new Uint8Array(N);
      this.stone = new Uint8Array(N);
      this.exit = new Uint8Array(N);
      this.gems = new Array(N).fill(null);
      this.rng = new RNG(seed == null ? (Math.random() * 2 ** 32) >>> 0 : seed);
      this.nextId = 1;
      this.colors = level.colors;
      this.score = 0;
      this.bonus = 0;
      this.movesLeft = level.moves;
      this.movesUsed = 0;
      this.collected = new Array(6).fill(0);
      this.dropsCollected = 0;
      this.status = 'playing';
      this.record = true;           // set false in simulations to skip snapshots
      const dropStarts = [];
      for (let y = 0; y < this.h; y++) {
        for (let x = 0; x < this.w; x++) {
          const ch = rows[y][x], i = y * this.w + x;
          if (ch === '.') continue;
          this.cell[i] = 1;
          if (ch === 'i') this.ice[i] = 1;
          if (ch === 'I') this.ice[i] = 2;
          if (ch === 's') this.stone[i] = 1;
          if (ch === 'S') this.stone[i] = 2;
          if (ch === 'd') dropStarts.push(i);
        }
      }
      for (let x = 0; x < this.w; x++) {
        for (let y = this.h - 1; y >= 0; y--) { const i = y * this.w + x; if (this.cell[i]) { this.exit[i] = 1; break; } }
      }
      this.iceTotal = this.ice.reduce((a, v) => a + v, 0);
      this.stoneTotal = this.stone.reduce((a, v) => a + v, 0);
      this.fillInitial(dropStarts);
    }

    // ---------------- helpers ----------------
    xy(i) { return [i % this.w, (i / this.w) | 0]; }
    at(x, y) { return x < 0 || y < 0 || x >= this.w || y >= this.h ? -1 : y * this.w + x; }
    holdable(i) { return i >= 0 && this.cell[i] === 1 && this.stone[i] === 0; }
    newGem(c, sp, drop) { return { id: this.nextId++, c, sp: sp || null, drop: !!drop }; }
    colorOf(i) { const g = this.gems[i]; return g && !g.drop && g.sp !== 'prism' ? g.c : -1; }
    adjacent(a, b) {
      const [ax, ay] = this.xy(a), [bx, by] = this.xy(b);
      return Math.abs(ax - bx) + Math.abs(ay - by) === 1;
    }
    snapshot() { return this.record ? { gems: this.gems.slice(), ice: this.ice.slice(), stone: this.stone.slice(), score: this.score } : null; }

    clone() {
      const g = Object.create(Game.prototype);
      Object.assign(g, this);
      g.ice = this.ice.slice(); g.stone = this.stone.slice(); g.gems = this.gems.slice();
      g.rng = this.rng.clone(); g.collected = this.collected.slice();
      return g;
    }

    fillInitial(dropStarts) {
      for (let y = 0; y < this.h; y++) {
        for (let x = 0; x < this.w; x++) {
          const i = this.at(x, y);
          if (!this.holdable(i)) continue;
          if (dropStarts.includes(i)) { this.gems[i] = this.newGem(-1, null, true); continue; }
          let c, tries = 0;
          do {
            c = this.rng.int(this.colors);
            tries++;
          } while (tries < 20 && (
            (this.colorOf(this.at(x - 1, y)) === c && this.colorOf(this.at(x - 2, y)) === c) ||
            (this.colorOf(this.at(x, y - 1)) === c && this.colorOf(this.at(x, y - 2)) === c)));
          this.gems[i] = this.newGem(c);
        }
      }
      if (this.findRuns().length || !this.hasMove()) this.shuffle(true);
    }

    // ---------------- matching ----------------
    findRuns() {
      const runs = [], { w, h } = this;
      for (let y = 0; y < h; y++) {
        let x = 0;
        while (x < w) {
          const c = this.colorOf(y * w + x);
          if (c < 0) { x++; continue; }
          let e = x + 1;
          while (e < w && this.colorOf(y * w + e) === c) e++;
          if (e - x >= 3) { const cells = []; for (let k = x; k < e; k++) cells.push(y * w + k); runs.push({ dir: 'h', c, cells }); }
          x = e;
        }
      }
      for (let x = 0; x < w; x++) {
        let y = 0;
        while (y < h) {
          const c = this.colorOf(y * w + x);
          if (c < 0) { y++; continue; }
          let e = y + 1;
          while (e < h && this.colorOf(e * w + x) === c) e++;
          if (e - y >= 3) { const cells = []; for (let k = y; k < e; k++) cells.push(k * w + x); runs.push({ dir: 'v', c, cells }); }
          y = e;
        }
      }
      return runs;
    }

    findGroups() {
      const runs = this.findRuns();
      if (!runs.length) return [];
      const parent = runs.map((_, i) => i);
      const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
      const owner = new Map();
      runs.forEach((r, ri) => r.cells.forEach((c) => {
        if (owner.has(c)) parent[find(owner.get(c))] = find(ri); else owner.set(c, ri);
      }));
      const groups = new Map();
      runs.forEach((r, ri) => {
        const root = find(ri);
        if (!groups.has(root)) groups.set(root, { c: r.c, runs: [], cells: new Set() });
        const g = groups.get(root);
        g.runs.push(r);
        r.cells.forEach((c) => g.cells.add(c));
      });
      return [...groups.values()];
    }

    matchAt(i) {
      const c = this.colorOf(i);
      if (c < 0) return false;
      const [x, y] = this.xy(i);
      let n = 1;
      for (let k = x - 1; k >= 0 && this.colorOf(this.at(k, y)) === c; k--) n++;
      for (let k = x + 1; k < this.w && this.colorOf(this.at(k, y)) === c; k++) n++;
      if (n >= 3) return true;
      n = 1;
      for (let k = y - 1; k >= 0 && this.colorOf(this.at(x, k)) === c; k--) n++;
      for (let k = y + 1; k < this.h && this.colorOf(this.at(x, k)) === c; k++) n++;
      return n >= 3;
    }

    // Which special (if any) a matched group creates, and where.
    specialFor(g, prefer) {
      const longest = g.runs.reduce((a, r) => (r.cells.length > a.cells.length ? r : a));
      const hasH = g.runs.some((r) => r.dir === 'h'), hasV = g.runs.some((r) => r.dir === 'v');
      let sp = null;
      if (longest.cells.length >= 5) sp = 'prism';
      else if (hasH && hasV && g.cells.size >= 5) sp = 'bomb';
      else if (longest.cells.length === 4) sp = longest.dir;          // 'h' or 'v'
      if (!sp) return null;
      let pos = (prefer || []).find((p) => g.cells.has(p));
      if (pos == null) {
        if (sp === 'bomb') {
          const counts = new Map();
          g.runs.forEach((r) => r.cells.forEach((c) => counts.set(c, (counts.get(c) || 0) + 1)));
          pos = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        } else pos = longest.cells[longest.cells.length >> 1];
      }
      return { i: pos, c: sp === 'prism' ? -1 : g.c, sp };
    }

    // ---------------- blasts ----------------
    lineCells(i, dir) {
      const [x, y] = this.xy(i), out = [];
      if (dir === 'h') for (let k = 0; k < this.w; k++) { const j = this.at(k, y); if (this.cell[j]) out.push(j); }
      else for (let k = 0; k < this.h; k++) { const j = this.at(x, k); if (this.cell[j]) out.push(j); }
      return out;
    }
    squareCells(i, r) {
      const [x, y] = this.xy(i), out = [];
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const j = this.at(x + dx, y + dy); if (j >= 0 && this.cell[j]) out.push(j); }
      return out;
    }
    commonestColor() {
      const n = new Array(6).fill(0);
      this.gems.forEach((g) => { if (g && !g.drop && g.sp !== 'prism') n[g.c]++; });
      let best = 0;
      for (let c = 1; c < 6; c++) if (n[c] > n[best]) best = c;
      return best;
    }

    // Grow `clear` by triggering every special gem inside it (chain reactions).
    expand(clear, effects, triggered) {
      const queue = [...clear];
      while (queue.length) {
        const i = queue.pop();
        const g = this.gems[i];
        if (!g || !g.sp || g.drop || triggered.has(g.id)) continue;
        triggered.add(g.id);
        let cells;
        if (g.sp === 'h' || g.sp === 'v') { cells = this.lineCells(i, g.sp); effects.push({ type: 'line', i, dir: g.sp }); }
        else if (g.sp === 'bomb') { cells = this.squareCells(i, 1); effects.push({ type: 'bomb', i, r: 1 }); }
        else {
          const c = this.commonestColor();
          cells = [];
          this.gems.forEach((o, j) => { if (o && !o.drop && o.sp !== 'prism' && o.c === c) cells.push(j); });
          effects.push({ type: 'prism', i, cells: cells.slice() });
        }
        for (const j of cells) if (!clear.has(j)) { clear.add(j); queue.push(j); }
      }
    }

    // Special-gem swap combos (called after the two gems have swapped places).
    comboBlast(a, b) {
      const A = this.gems[b], B = this.gems[a];       // A = the gem the player moved (now at b)
      const cells = new Set([a, b]), effects = [], triggered = new Set([A.id, B.id]);
      const prismA = A.sp === 'prism', prismB = B.sp === 'prism';
      if (prismA && prismB) {
        this.gems.forEach((g, j) => { if (this.cell[j]) cells.add(j); });
        effects.push({ type: 'prism', i: b, cells: [...cells] });
      } else if (prismA || prismB) {
        const other = prismA ? B : A, c = other.c;
        const targets = [];
        this.gems.forEach((g, j) => { if (g && !g.drop && g.sp !== 'prism' && g.c === c) targets.push(j); });
        if (other.sp) {
          // turn every gem of that colour into the same kind of special, then set them all off
          for (const j of targets) {
            const old = this.gems[j];
            if (!old.sp) {
              const sp = other.sp === 'bomb' ? 'bomb' : (this.rng.next() < 0.5 ? 'h' : 'v');
              this.gems[j] = { id: old.id, c: old.c, sp, drop: false };
            }
          }
          triggered.delete(other.id);
        }
        targets.forEach((j) => cells.add(j));
        effects.push({ type: 'prism', i: prismA ? b : a, cells: targets.slice() });
      } else {
        const lines = [A, B].filter((g) => g.sp === 'h' || g.sp === 'v').length;
        const bombs = [A, B].filter((g) => g.sp === 'bomb').length;
        if (lines === 2) {
          this.lineCells(b, 'h').forEach((j) => cells.add(j));
          this.lineCells(b, 'v').forEach((j) => cells.add(j));
          effects.push({ type: 'line', i: b, dir: 'h' }, { type: 'line', i: b, dir: 'v' });
        } else if (lines === 1 && bombs === 1) {
          const [x, y] = this.xy(b);
          for (let d = -1; d <= 1; d++) {
            const r = this.at(x, y + d), c = this.at(x + d, y);
            if (r >= 0) { this.lineCells(r, 'h').forEach((j) => cells.add(j)); effects.push({ type: 'line', i: r, dir: 'h' }); }
            if (c >= 0) { this.lineCells(c, 'v').forEach((j) => cells.add(j)); effects.push({ type: 'line', i: c, dir: 'v' }); }
          }
        } else {
          this.squareCells(b, 2).forEach((j) => cells.add(j));
          effects.push({ type: 'bomb', i: b, r: 2 });
        }
      }
      return { cells, effects, triggered };
    }

    // ---------------- moves ----------------
    isSpecialPair(A, B) {
      return !A.drop && !B.drop && (A.sp === 'prism' || B.sp === 'prism' || (A.sp && B.sp));
    }

    // Is swapping a and b a legal move? (doesn't change the board)
    canSwap(a, b) {
      if (!this.adjacent(a, b) || !this.holdable(a) || !this.holdable(b)) return false;
      const A = this.gems[a], B = this.gems[b];
      if (!A || !B) return false;
      if (this.isSpecialPair(A, B)) return true;
      this.gems[a] = B; this.gems[b] = A;
      const ok = this.matchAt(a) || this.matchAt(b);
      this.gems[a] = A; this.gems[b] = B;
      return ok;
    }

    validMoves() {
      const out = [];
      for (let i = 0; i < this.gems.length; i++) {
        if (!this.holdable(i) || !this.gems[i]) continue;
        const [x, y] = this.xy(i);
        for (const j of [this.at(x + 1, y), this.at(x, y + 1)]) if (j >= 0 && this.canSwap(i, j)) out.push([i, j]);
      }
      return out;
    }

    hasMove() {
      for (let i = 0; i < this.gems.length; i++) {
        if (!this.holdable(i) || !this.gems[i]) continue;
        const [x, y] = this.xy(i);
        for (const j of [this.at(x + 1, y), this.at(x, y + 1)]) if (j >= 0 && this.canSwap(i, j)) return true;
      }
      return false;
    }

    swap(a, b) {
      if (this.status !== 'playing') return { ok: false };
      if (!this.adjacent(a, b) || !this.holdable(a) || !this.holdable(b)) return { ok: false };
      const A = this.gems[a], B = this.gems[b];
      if (!A || !B) return { ok: false };
      const special = this.isSpecialPair(A, B);
      this.gems[a] = B; this.gems[b] = A;
      if (!special && !this.matchAt(a) && !this.matchAt(b)) {
        this.gems[a] = A; this.gems[b] = B;
        return { ok: false, reason: 'no-match' };
      }
      this.movesLeft--;
      this.movesUsed++;
      const phases = [];
      if (this.record) phases.push(Object.assign({ kind: 'swap', a, b }, this.snapshot()));
      const first = special ? this.comboBlast(a, b) : null;
      this.resolve(first, [b, a], phases);
      this.updateStatus(phases);
      return { ok: true, phases };
    }

    // ---------------- cascade loop ----------------
    resolve(first, prefer, phases) {
      let cascade = 0, pending = first;
      for (let guard = 0; guard < 200; guard++) {
        const groups = pending ? [] : this.findGroups();
        if (!pending && !groups.length) break;
        cascade++;
        const clear = new Set(), matchCells = new Set(), effects = [], creates = [];
        const triggered = pending ? pending.triggered : new Set();
        if (pending) { pending.cells.forEach((c) => clear.add(c)); effects.push(...pending.effects); pending = null; }
        for (const g of groups) {
          g.cells.forEach((c) => { clear.add(c); matchCells.add(c); });
          const s = this.specialFor(g, cascade === 1 ? prefer : null);
          if (s) creates.push(s);
        }
        this.expand(clear, effects, triggered);

        const removed = [];
        const hitStones = new Set();
        for (const i of clear) {
          if (!this.cell[i]) continue;
          if (this.stone[i] > 0) { if (!hitStones.has(i)) { hitStones.add(i); this.stone[i]--; this.score += SCORE.stone; } continue; }
          const g = this.gems[i];
          if (!g || g.drop) continue;
          removed.push({ id: g.id, i, c: g.c, sp: g.sp });
          if (g.c >= 0 && g.sp !== 'prism') this.collected[g.c]++;
          this.score += matchCells.has(i) ? SCORE.gem * cascade : SCORE.blastGem;
          this.gems[i] = null;
          if (this.ice[i] > 0) { this.ice[i]--; this.score += SCORE.ice; }
        }
        for (const i of matchCells) {
          const [x, y] = this.xy(i);
          for (const n of [this.at(x + 1, y), this.at(x - 1, y), this.at(x, y + 1), this.at(x, y - 1)]) {
            if (n >= 0 && this.stone[n] > 0 && !hitStones.has(n)) { hitStones.add(n); this.stone[n]--; this.score += SCORE.stone; }
          }
        }
        const created = [];
        for (const s of creates) {
          if (this.gems[s.i]) continue;            // cell got refilled by another creation
          const g = this.newGem(s.c, s.sp);
          this.gems[s.i] = g;
          created.push(g.id);
          this.score += SCORE.special;
        }
        if (this.record) phases.push(Object.assign({ kind: 'clear', removed, effects, created, cascade, stonesHit: [...hitStones] }, this.snapshot()));
        this.settle(phases);
      }
      if (!this.hasMove()) {
        this.shuffle(false);
        if (this.record) phases.push(Object.assign({ kind: 'shuffle' }, this.snapshot()));
      }
    }

    // gravity + refill, then collect star-drops that reached the bottom; repeat until stable
    settle(phases) {
      for (let guard = 0; guard < 50; guard++) {
        const fall = this.gravity();
        if (this.record && (fall.moves.length || fall.spawns.length)) phases.push(Object.assign({ kind: 'fall' }, fall, this.snapshot()));
        const got = [];
        for (let i = 0; i < this.gems.length; i++) {
          const g = this.gems[i];
          if (g && g.drop && this.exit[i]) { got.push({ id: g.id, i }); this.gems[i] = null; this.dropsCollected++; this.score += SCORE.drop; }
        }
        if (!got.length) return;
        if (this.record) phases.push(Object.assign({ kind: 'collect', got }, this.snapshot()));
      }
    }

    dropGoal() { const g = this.lv.goals.find((x) => x.type === 'drop'); return g ? g.n : 0; }

    gravity() {
      const moves = [], spawns = [], { w, h } = this;
      const need = this.dropGoal();
      let onBoard = need ? this.gems.filter((g) => g && g.drop).length : 0;
      for (let x = 0; x < w; x++) {
        let y = 0;
        while (y < h) {
          if (!this.holdable(this.at(x, y))) { y++; continue; }
          let y1 = y;
          while (y1 + 1 < h && this.holdable(this.at(x, y1 + 1))) y1++;
          // segment y..y1: pack gems down
          let write = y1;
          for (let r = y1; r >= y; r--) {
            const i = this.at(x, r), g = this.gems[i];
            if (!g) continue;
            if (r !== write) { const t = this.at(x, write); this.gems[t] = g; this.gems[i] = null; moves.push({ id: g.id, from: i, to: t }); }
            write--;
          }
          const empty = write - y + 1;
          for (let k = 0; k < empty; k++) {
            const r = write - k, t = this.at(x, r);
            let g;
            if (need && onBoard < 2 && this.dropsCollected + onBoard < need && this.rng.next() < 0.18) { g = this.newGem(-1, null, true); onBoard++; }
            else g = this.newGem(this.rng.int(this.colors));
            this.gems[t] = g;
            spawns.push({ id: g.id, to: t, from: y - 1 - k });   // from = virtual row above the segment
          }
          y = y1 + 1;
        }
      }
      return { moves, spawns };
    }

    // Rearrange ordinary gems so there is no match and at least one move.
    shuffle(initial) {
      const pos = [];
      for (let i = 0; i < this.gems.length; i++) {
        const g = this.gems[i];
        if (this.holdable(i) && g && !g.drop && !g.sp) pos.push(i);
      }
      const objs = pos.map((i) => this.gems[i]);
      for (let tries = 0; tries < 300; tries++) {
        for (let k = objs.length - 1; k > 0; k--) { const j = this.rng.int(k + 1); [objs[k], objs[j]] = [objs[j], objs[k]]; }
        pos.forEach((i, k) => { this.gems[i] = objs[k]; });
        if (!this.findRuns().length && this.hasMove()) return;
        if (tries > 150) for (const i of pos) this.gems[i] = this.newGem(this.rng.int(this.colors));  // recolour as last resort
      }
    }

    // ---------------- goals ----------------
    iceLeft() { return this.ice.reduce((a, v) => a + v, 0); }
    stoneLeft() { return this.stone.reduce((a, v) => a + v, 0); }
    goalProgress(g) {
      switch (g.type) {
        case 'score': return { done: Math.min(this.score, g.n), total: g.n };
        case 'collect': return { done: Math.min(this.collected[g.c], g.n), total: g.n };
        case 'ice': return { done: this.iceTotal - this.iceLeft(), total: this.iceTotal };
        case 'stone': return { done: this.stoneTotal - this.stoneLeft(), total: this.stoneTotal };
        case 'drop': return { done: Math.min(this.dropsCollected, g.n), total: g.n };
        default: return { done: 0, total: 1 };
      }
    }
    goalsMet() { return this.lv.goals.every((g) => { const p = this.goalProgress(g); return p.done >= p.total; }); }

    updateStatus(phases) {
      if (this.goalsMet()) {
        this.status = 'won';
        this.bonus = this.movesLeft * SCORE.moveBonus;
        this.score += this.bonus;
        if (this.record && phases) phases.push({ kind: 'won', bonus: this.bonus, score: this.score });
      } else if (this.movesLeft <= 0) {
        this.status = 'lost';
        if (this.record && phases) phases.push({ kind: 'lost' });
      }
    }

    stars() {
      if (this.status !== 'won') return 0;
      const [s2, s3] = this.lv.stars || [Infinity, Infinity];
      return this.score >= s3 ? 3 : this.score >= s2 ? 2 : 1;
    }
  }

  const GemEngine = { Game, RNG, SCORE };
  if (typeof module !== 'undefined' && module.exports) module.exports = GemEngine;
  else root.GemEngine = GemEngine;
})(typeof window !== 'undefined' ? window : globalThis);
