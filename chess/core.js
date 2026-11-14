/*
 * ChessCore — a small, dependency-free chess rules engine.
 * Used by the Mate in One game (browser) and by the puzzle generator (Node).
 *
 * Board: array of 64 chars, index 0 = a8 … 63 = h1 (FEN order). '.' = empty.
 * Upper case = white, lower case = black.
 * Supports: legal move generation (incl. castling, en passant, promotion),
 * check / checkmate / stalemate detection, FEN in/out, SAN and UCI notation.
 */
(function (root) {
  'use strict';

  const FILES = 'abcdefgh';
  const fileOf = (i) => i & 7;
  const rankOf = (i) => 7 - (i >> 3);            // 0 = rank 1 … 7 = rank 8
  const sqIndex = (f, r) => (7 - r) * 8 + f;
  const sqName = (i) => FILES[fileOf(i)] + (rankOf(i) + 1);
  const parseSq = (s) => sqIndex(FILES.indexOf(s[0]), parseInt(s[1], 10) - 1);
  const isWhite = (p) => p !== '.' && p === p.toUpperCase();
  const colorOf = (p) => (p === '.' ? null : isWhite(p) ? 'w' : 'b');

  const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const ROOK = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const BISHOP = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

  function step(i, df, dr) {
    const f = fileOf(i) + df, r = rankOf(i) + dr;
    return f < 0 || f > 7 || r < 0 || r > 7 ? -1 : sqIndex(f, r);
  }

  // ---------------- FEN ----------------
  function fromFEN(fen) {
    const [placement, turn, castling, ep, half, full] = fen.trim().split(/\s+/);
    const b = [];
    for (const ch of placement.replace(/\//g, '')) {
      if (/\d/.test(ch)) for (let k = 0; k < +ch; k++) b.push('.');
      else b.push(ch);
    }
    if (b.length !== 64) throw new Error('Bad FEN: ' + fen);
    return {
      b,
      turn: turn || 'w',
      castling: castling && castling !== '-' ? castling : '',
      ep: ep && ep !== '-' ? parseSq(ep) : -1,
      half: parseInt(half || '0', 10),
      full: parseInt(full || '1', 10),
    };
  }

  function toFEN(s) {
    let out = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = s.b[r * 8 + f];
        if (p === '.') empty++;
        else { if (empty) { out += empty; empty = 0; } out += p; }
      }
      if (empty) out += empty;
      if (r < 7) out += '/';
    }
    return `${out} ${s.turn} ${s.castling || '-'} ${s.ep >= 0 ? sqName(s.ep) : '-'} ${s.half} ${s.full}`;
  }

  // ---------------- Attacks ----------------
  // Is square `sq` attacked by side `by` ('w' | 'b')?
  function attacked(s, sq, by) {
    const b = s.b;
    const own = (p) => p !== '.' && colorOf(p) === by;
    // pawns: a white pawn attacks diagonally upward, so look one rank *below* sq
    const pr = by === 'w' ? -1 : 1;
    for (const df of [-1, 1]) {
      const t = step(sq, df, pr);
      if (t >= 0 && b[t] === (by === 'w' ? 'P' : 'p')) return true;
    }
    for (const [df, dr] of KNIGHT) {
      const t = step(sq, df, dr);
      if (t >= 0 && b[t] === (by === 'w' ? 'N' : 'n')) return true;
    }
    for (const [df, dr] of KING) {
      const t = step(sq, df, dr);
      if (t >= 0 && b[t] === (by === 'w' ? 'K' : 'k')) return true;
    }
    const R = by === 'w' ? 'RQ' : 'rq', B = by === 'w' ? 'BQ' : 'bq';
    for (const [dirs, set] of [[ROOK, R], [BISHOP, B]]) {
      for (const [df, dr] of dirs) {
        let t = step(sq, df, dr);
        while (t >= 0) {
          const p = b[t];
          if (p !== '.') { if (own(p) && set.includes(p)) return true; break; }
          t = step(t, df, dr);
        }
      }
    }
    return false;
  }

  const kingSquare = (s, color) => s.b.indexOf(color === 'w' ? 'K' : 'k');
  const opp = (c) => (c === 'w' ? 'b' : 'w');
  function inCheck(s, color) {
    const c = color || s.turn;
    const k = kingSquare(s, c);
    return k >= 0 && attacked(s, k, opp(c));
  }

  // ---------------- Move generation ----------------
  function pseudoMoves(s) {
    const b = s.b, side = s.turn, moves = [];
    const mine = (p) => p !== '.' && colorOf(p) === side;
    const theirs = (p) => p !== '.' && colorOf(p) !== side;
    const add = (from, to, extra) => moves.push(Object.assign({ from, to, piece: b[from], captured: b[to] }, extra));

    for (let i = 0; i < 64; i++) {
      const p = b[i];
      if (!mine(p)) continue;
      const t = p.toLowerCase();
      if (t === 'p') {
        const dir = side === 'w' ? 1 : -1;
        const startRank = side === 'w' ? 1 : 6, lastRank = side === 'w' ? 7 : 0;
        const pushPawn = (from, to, extra) => {
          if (rankOf(to) === lastRank) for (const pr of 'qrbn') add(from, to, Object.assign({ promo: side === 'w' ? pr.toUpperCase() : pr }, extra));
          else add(from, to, extra);
        };
        const one = step(i, 0, dir);
        if (one >= 0 && b[one] === '.') {
          pushPawn(i, one);
          const two = step(i, 0, 2 * dir);
          if (rankOf(i) === startRank && b[two] === '.') add(i, two, { flag: 'double' });
        }
        for (const df of [-1, 1]) {
          const c = step(i, df, dir);
          if (c < 0) continue;
          if (theirs(b[c])) pushPawn(i, c);
          else if (c === s.ep) add(i, c, { flag: 'ep', captured: side === 'w' ? 'p' : 'P' });
        }
      } else if (t === 'n' || t === 'k') {
        for (const [df, dr] of t === 'n' ? KNIGHT : KING) {
          const c = step(i, df, dr);
          if (c >= 0 && !mine(b[c])) add(i, c);
        }
      } else {
        const dirs = t === 'r' ? ROOK : t === 'b' ? BISHOP : ROOK.concat(BISHOP);
        for (const [df, dr] of dirs) {
          let c = step(i, df, dr);
          while (c >= 0) {
            if (mine(b[c])) break;
            add(i, c);
            if (b[c] !== '.') break;
            c = step(c, df, dr);
          }
        }
      }
    }

    // Castling (king and rook on original squares; path empty; not through check)
    const enemy = opp(side);
    if (side === 'w' && b[60] === 'K') {
      if (s.castling.includes('K') && b[63] === 'R' && b[61] === '.' && b[62] === '.' &&
        !attacked(s, 60, enemy) && !attacked(s, 61, enemy) && !attacked(s, 62, enemy)) add(60, 62, { flag: 'castle' });
      if (s.castling.includes('Q') && b[56] === 'R' && b[59] === '.' && b[58] === '.' && b[57] === '.' &&
        !attacked(s, 60, enemy) && !attacked(s, 59, enemy) && !attacked(s, 58, enemy)) add(60, 58, { flag: 'castle' });
    }
    if (side === 'b' && b[4] === 'k') {
      if (s.castling.includes('k') && b[7] === 'r' && b[5] === '.' && b[6] === '.' &&
        !attacked(s, 4, enemy) && !attacked(s, 5, enemy) && !attacked(s, 6, enemy)) add(4, 6, { flag: 'castle' });
      if (s.castling.includes('q') && b[0] === 'r' && b[3] === '.' && b[2] === '.' && b[1] === '.' &&
        !attacked(s, 4, enemy) && !attacked(s, 3, enemy) && !attacked(s, 2, enemy)) add(4, 2, { flag: 'castle' });
    }
    return moves;
  }

  function makeMove(s, m) {
    const b = s.b.slice();
    const side = s.turn;
    b[m.to] = m.promo || b[m.from];
    b[m.from] = '.';
    if (m.flag === 'ep') b[m.to + (side === 'w' ? 8 : -8)] = '.';
    if (m.flag === 'castle') {
      if (m.to === 62) { b[61] = 'R'; b[63] = '.'; }
      if (m.to === 58) { b[59] = 'R'; b[56] = '.'; }
      if (m.to === 6) { b[5] = 'r'; b[7] = '.'; }
      if (m.to === 2) { b[3] = 'r'; b[0] = '.'; }
    }
    let castling = s.castling;
    const strip = (chars) => { for (const c of chars) castling = castling.replace(c, ''); };
    if (m.piece === 'K') strip('KQ');
    if (m.piece === 'k') strip('kq');
    for (const sq of [m.from, m.to]) {
      if (sq === 63) strip('K'); if (sq === 56) strip('Q');
      if (sq === 7) strip('k'); if (sq === 0) strip('q');
    }
    return {
      b,
      turn: opp(side),
      castling,
      ep: m.flag === 'double' ? (m.from + m.to) / 2 : -1,
      half: m.piece.toLowerCase() === 'p' || m.captured !== '.' ? 0 : s.half + 1,
      full: s.full + (side === 'b' ? 1 : 0),
    };
  }

  function legalMoves(s) {
    const side = s.turn;
    return pseudoMoves(s).filter((m) => !inCheck(makeMove(s, m), side));
  }

  const isCheckmate = (s) => inCheck(s) && legalMoves(s).length === 0;
  const isStalemate = (s) => !inCheck(s) && legalMoves(s).length === 0;

  // ---------------- Notation ----------------
  const uci = (m) => sqName(m.from) + sqName(m.to) + (m.promo ? m.promo.toLowerCase() : '');

  function findMove(s, uciStr) {
    return legalMoves(s).find((m) => uci(m) === uciStr) || null;
  }

  function san(s, m, legal) {
    const all = legal || legalMoves(s);
    let out;
    if (m.flag === 'castle') out = fileOf(m.to) === 6 ? 'O-O' : 'O-O-O';
    else {
      const t = m.piece.toUpperCase();
      const cap = m.captured !== '.' || m.flag === 'ep';
      if (t === 'P') {
        out = (cap ? FILES[fileOf(m.from)] + 'x' : '') + sqName(m.to) + (m.promo ? '=' + m.promo.toUpperCase() : '');
      } else {
        const rivals = all.filter((o) => o !== m && o.piece === m.piece && o.to === m.to && o.from !== m.from);
        let dis = '';
        if (rivals.length) {
          const sameFile = rivals.some((o) => fileOf(o.from) === fileOf(m.from));
          const sameRank = rivals.some((o) => rankOf(o.from) === rankOf(m.from));
          if (!sameFile) dis = FILES[fileOf(m.from)];
          else if (!sameRank) dis = String(rankOf(m.from) + 1);
          else dis = sqName(m.from);
        }
        out = t + dis + (cap ? 'x' : '') + sqName(m.to);
      }
    }
    const after = makeMove(s, m);
    if (inCheck(after)) out += legalMoves(after).length === 0 ? '#' : '+';
    return out;
  }

  // Count leaf nodes to a given depth (used to verify move generation).
  function perft(s, depth) {
    if (depth === 0) return 1;
    let n = 0;
    for (const m of legalMoves(s)) n += depth === 1 ? 1 : perft(makeMove(s, m), depth - 1);
    return n;
  }

  const ChessCore = {
    fromFEN, toFEN, legalMoves, makeMove, inCheck, isCheckmate, isStalemate, attacked,
    san, uci, findMove, perft, sqName, parseSq, fileOf, rankOf, colorOf, kingSquare,
    START: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ChessCore;
  else root.ChessCore = ChessCore;
})(typeof window !== 'undefined' ? window : globalThis);
