/**
 * chess.js — 国际象棋规则引擎（0x88 棋盘表示）
 * 纯 ES Module，前后端 / Worker 通用。
 *
 * 覆盖完整规则：走子生成、王车易位、吃过路兵、兵升变、
 * 将军 / 将死 / 逼和 / 50 回合 / 三次重复 / 子力不足和棋。
 */

// ── 基础常量 ─────────────────────────────────────────────
export const WHITE = 0;
export const BLACK = 1;

export const EMPTY = 0;
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const PIECE_CHARS = ['', 'p', 'n', 'b', 'r', 'q', 'k'];

/** 走法标志位 */
export const FLAG_NORMAL = 1;
export const FLAG_CAPTURE = 2;
export const FLAG_BIG_PAWN = 4;
export const FLAG_EP = 8;
export const FLAG_PROMOTION = 16;
export const FLAG_KSIDE = 32;
export const FLAG_QSIDE = 64;

/** 易位权限位 */
export const CASTLE_WK = 1;
export const CASTLE_WQ = 2;
export const CASTLE_BK = 4;
export const CASTLE_BQ = 8;

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// 0x88 方格索引：a8 = 0, h8 = 7, a1 = 112, h1 = 119
export const SQ = {};
(function buildSquareMap() {
  const files = 'abcdefgh';
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      SQ[files[f] + (8 - r)] = r * 16 + f;
    }
  }
})();

export const A8 = 0, H8 = 7, A1 = 112, H1 = 119;
export const E1 = SQ.e1, E8 = SQ.e8;

const PAWN_OFFSETS = [
  [-16, -32, -17, -15], // 白：前进 / 双步 / 左吃 / 右吃
  [16, 32, 17, 15],     // 黑
];

const PIECE_OFFSETS = [
  [], [],
  [-18, -33, -31, -14, 18, 33, 31, 14], // 马
  [-17, -15, 17, 15],                   // 象
  [-16, 1, 16, -1],                     // 车
  [-17, -16, -15, 1, 17, 16, 15, -1],   // 后
  [-17, -16, -15, 1, 17, 16, 15, -1],   // 王
];

const SLIDING = [false, false, false, true, true, true, false];

/** 局面阶段权重：24 = 全子力开局，0 = 纯兵残局 */
export const PHASE_WEIGHT = [0, 0, 1, 1, 2, 4, 0];
export const TOTAL_PHASE = 24;

// 易位时被移动的车
const ROOK_MOVES = [
  { // 白
    k: { from: H1, to: SQ.f1, flag: CASTLE_WK },
    q: { from: A1, to: SQ.d1, flag: CASTLE_WQ },
  },
  { // 黑
    k: { from: H8, to: SQ.f8, flag: CASTLE_BK },
    q: { from: A8, to: SQ.d8, flag: CASTLE_BQ },
  },
];

// 走一步后需要清除的易位权限
const CASTLE_MASK = new Int32Array(128).fill(15);
CASTLE_MASK[A1] = 15 & ~CASTLE_WQ;
CASTLE_MASK[E1] = 15 & ~(CASTLE_WK | CASTLE_WQ);
CASTLE_MASK[H1] = 15 & ~CASTLE_WK;
CASTLE_MASK[A8] = 15 & ~CASTLE_BQ;
CASTLE_MASK[E8] = 15 & ~(CASTLE_BK | CASTLE_BQ);
CASTLE_MASK[H8] = 15 & ~CASTLE_BK;

// ── 走法编码（27 位整数）────────────────────────────────
// from:0-6 | to:7-13 | flags:14-20 | captured:21-23 | promo:24-26
export const encodeMove = (from, to, flags, captured = 0, promo = 0) =>
  from | (to << 7) | (flags << 14) | (captured << 21) | (promo << 24);

export const moveFrom = (m) => m & 0x7f;
export const moveTo = (m) => (m >> 7) & 0x7f;
export const moveFlags = (m) => (m >> 14) & 0x7f;
export const moveCaptured = (m) => (m >> 21) & 7;
export const movePromo = (m) => (m >> 24) & 7;

// ── 坐标工具 ─────────────────────────────────────────────
export const rankOf = (sq) => sq >> 4;
export const fileOf = (sq) => sq & 15;
export const onBoard = (sq) => (sq & 0x88) === 0;
export const algebraic = (sq) => 'abcdefgh'[sq & 15] + (8 - (sq >> 4));
export const fromAlgebraic = (s) => SQ[s];
export const colorOf = (p) => p >> 3;
export const typeOf = (p) => p & 7;
export const makePiece = (color, type) => (color << 3) | type;
/** 0x88 → 0..63（用于 UI 网格） */
export const to64 = (sq) => (sq >> 4) * 8 + (sq & 15);
export const from64 = (i) => ((i / 8) | 0) * 16 + (i % 8);

// ── Zobrist 哈希 ─────────────────────────────────────────
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s >>> 0;
  };
}

const ZOB_PIECE = [];   // [piece(0..14)][sq] = [hi, lo]
const ZOB_CASTLE = [];  // [16]
const ZOB_EP = [];      // [8] 按列
let ZOB_SIDE = [0, 0];

(function initZobrist() {
  const rnd = makeRng(0x9e3779b9);
  for (let p = 0; p < 15; p++) {
    const arr = new Array(128);
    for (let s = 0; s < 128; s++) arr[s] = [rnd(), rnd()];
    ZOB_PIECE.push(arr);
  }
  for (let i = 0; i < 16; i++) ZOB_CASTLE.push([rnd(), rnd()]);
  for (let i = 0; i < 8; i++) ZOB_EP.push([rnd(), rnd()]);
  ZOB_SIDE = [rnd(), rnd()];
})();

// ── 引擎主体 ─────────────────────────────────────────────
export class Chess {
  constructor(fen = START_FEN) {
    this.board = new Int32Array(128);
    this.kings = [-1, -1];
    this.turn = WHITE;
    this.castling = 0;
    this.epSquare = -1;
    this.halfMoves = 0;
    this.moveNumber = 1;
    this.hashHi = 0;
    this.hashLo = 0;
    this.history = [];      // undo 栈
    this.hashHistory = [];  // 扁平化 [hi, lo, hi, lo …]，用于重复局面检测
    this.sanHistory = [];   // 供 PGN 使用
    this.load(fen);
  }

  clone() {
    const c = new Chess(this.fen());
    c.sanHistory = this.sanHistory.slice();
    return c;
  }

  // ── FEN ────────────────────────────────────────────────
  load(fen) {
    const parts = fen.trim().split(/\s+/);
    this.board.fill(0);
    this.kings = [-1, -1];
    this.history = [];
    this.hashHistory = [];
    this.sanHistory = [];

    let sq = 0;
    for (const ch of parts[0]) {
      if (ch === '/') { sq += 8; continue; }
      if (ch >= '1' && ch <= '8') { sq += parseInt(ch, 10); continue; }
      const color = ch === ch.toUpperCase() ? WHITE : BLACK;
      const type = PIECE_CHARS.indexOf(ch.toLowerCase());
      if (type <= 0) continue;
      const piece = makePiece(color, type);
      this.board[sq] = piece;
      if (type === KING) this.kings[color] = sq;
      sq++;
    }

    // 阶段权重（增量维护，供评估函数快速判断残局）
    this.phase = 0;
    for (let s2 = 0; s2 < 128; s2++) {
      if (s2 & 0x88) { s2 += 7; continue; }
      if (this.board[s2]) this.phase += PHASE_WEIGHT[typeOf(this.board[s2])];
    }

    this.turn = parts[1] === 'b' ? BLACK : WHITE;
    this.castling = 0;
    if (parts[2] && parts[2] !== '-') {
      if (parts[2].includes('K')) this.castling |= CASTLE_WK;
      if (parts[2].includes('Q')) this.castling |= CASTLE_WQ;
      if (parts[2].includes('k')) this.castling |= CASTLE_BK;
      if (parts[2].includes('q')) this.castling |= CASTLE_BQ;
    }
    this.epSquare = parts[3] && parts[3] !== '-' ? (SQ[parts[3]] ?? -1) : -1;
    this.halfMoves = parts[4] ? parseInt(parts[4], 10) : 0;
    this.moveNumber = parts[5] ? parseInt(parts[5], 10) : 1;
    this._computeHash();
    return this;
  }

  fen() {
    let out = '';
    let empty = 0;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = this.board[r * 16 + f];
        if (!p) { empty++; continue; }
        if (empty) { out += empty; empty = 0; }
        const ch = PIECE_CHARS[typeOf(p)];
        out += colorOf(p) === WHITE ? ch.toUpperCase() : ch;
      }
      if (empty) { out += empty; empty = 0; }
      if (r < 7) out += '/';
    }
    let castle = '';
    if (this.castling & CASTLE_WK) castle += 'K';
    if (this.castling & CASTLE_WQ) castle += 'Q';
    if (this.castling & CASTLE_BK) castle += 'k';
    if (this.castling & CASTLE_BQ) castle += 'q';
    return [
      out,
      this.turn === WHITE ? 'w' : 'b',
      castle || '-',
      this.epSquare >= 0 ? algebraic(this.epSquare) : '-',
      this.halfMoves,
      this.moveNumber,
    ].join(' ');
  }

  _computeHash() {
    let hi = 0, lo = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) continue;
      const p = this.board[s];
      if (p) { hi ^= ZOB_PIECE[p][s][0]; lo ^= ZOB_PIECE[p][s][1]; }
    }
    hi ^= ZOB_CASTLE[this.castling][0];
    lo ^= ZOB_CASTLE[this.castling][1];
    if (this.epSquare >= 0) {
      hi ^= ZOB_EP[fileOf(this.epSquare)][0];
      lo ^= ZOB_EP[fileOf(this.epSquare)][1];
    }
    if (this.turn === BLACK) { hi ^= ZOB_SIDE[0]; lo ^= ZOB_SIDE[1]; }
    this.hashHi = hi >>> 0;
    this.hashLo = lo >>> 0;
  }

  // ── 攻击判定 ───────────────────────────────────────────
  /** by 方是否攻击 target 格 */
  isAttacked(target, by) {
    // 兵
    const pawn = makePiece(by, PAWN);
    if (by === WHITE) {
      if (onBoard(target + 17) && this.board[target + 17] === pawn) return true;
      if (onBoard(target + 15) && this.board[target + 15] === pawn) return true;
    } else {
      if (onBoard(target - 17) && this.board[target - 17] === pawn) return true;
      if (onBoard(target - 15) && this.board[target - 15] === pawn) return true;
    }
    // 马
    const knight = makePiece(by, KNIGHT);
    for (const off of PIECE_OFFSETS[KNIGHT]) {
      const s = target + off;
      if (onBoard(s) && this.board[s] === knight) return true;
    }
    // 王
    const king = makePiece(by, KING);
    for (const off of PIECE_OFFSETS[KING]) {
      const s = target + off;
      if (onBoard(s) && this.board[s] === king) return true;
    }
    // 滑行子：象/后（斜）
    for (const off of PIECE_OFFSETS[BISHOP]) {
      let s = target + off;
      while (onBoard(s)) {
        const p = this.board[s];
        if (p) {
          if (colorOf(p) === by) {
            const t = typeOf(p);
            if (t === BISHOP || t === QUEEN) return true;
          }
          break;
        }
        s += off;
      }
    }
    // 滑行子：车/后（直）
    for (const off of PIECE_OFFSETS[ROOK]) {
      let s = target + off;
      while (onBoard(s)) {
        const p = this.board[s];
        if (p) {
          if (colorOf(p) === by) {
            const t = typeOf(p);
            if (t === ROOK || t === QUEEN) return true;
          }
          break;
        }
        s += off;
      }
    }
    return false;
  }

  inCheck(color = this.turn) {
    const k = this.kings[color];
    return k >= 0 && this.isAttacked(k, color ^ 1);
  }

  // ── 走法生成 ───────────────────────────────────────────
  /**
   * @param {object} opts
   *  - legal: 是否过滤自杀走法（默认 true）
   *  - square: 只生成某格的走法（0x88 索引）
   *  - capturesOnly: 只生成吃子 / 升变（静默搜索用）
   * @returns {number[]} 走法编码数组
   */
  generateMoves(opts = {}) {
    const { legal = true, square = -1, capturesOnly = false } = opts;
    const us = this.turn;
    const them = us ^ 1;
    const moves = [];

    const addPawn = (from, to, flags) => {
      if (rankOf(to) === (us === WHITE ? 0 : 7)) {
        const cap = flags & FLAG_CAPTURE ? typeOf(this.board[to]) : 0;
        for (const promo of [QUEEN, ROOK, BISHOP, KNIGHT]) {
          moves.push(encodeMove(from, to, flags | FLAG_PROMOTION, cap, promo));
        }
      } else {
        const cap = (flags & FLAG_CAPTURE) && !(flags & FLAG_EP) ? typeOf(this.board[to]) : (flags & FLAG_EP ? PAWN : 0);
        moves.push(encodeMove(from, to, flags, cap, 0));
      }
    };

    const first = square >= 0 ? square : 0;
    const last = square >= 0 ? square : 119;

    for (let from = first; from <= last; from++) {
      if (from & 0x88) { from += 7; continue; }
      const piece = this.board[from];
      if (!piece || colorOf(piece) !== us) continue;
      const type = typeOf(piece);

      if (type === PAWN) {
        const off = PAWN_OFFSETS[us];
        // 前进
        if (!capturesOnly) {
          const one = from + off[0];
          if (onBoard(one) && !this.board[one]) {
            addPawn(from, one, FLAG_NORMAL);
            const startRank = us === WHITE ? 6 : 1;
            const two = from + off[1];
            if (rankOf(from) === startRank && !this.board[two]) {
              moves.push(encodeMove(from, two, FLAG_BIG_PAWN));
            }
          }
        } else {
          // 静默搜索也要考虑升变推进
          const one = from + off[0];
          if (onBoard(one) && !this.board[one] && rankOf(one) === (us === WHITE ? 0 : 7)) {
            addPawn(from, one, FLAG_NORMAL);
          }
        }
        // 吃子
        for (let j = 2; j < 4; j++) {
          const to = from + off[j];
          if (!onBoard(to)) continue;
          const target = this.board[to];
          if (target && colorOf(target) === them) {
            addPawn(from, to, FLAG_NORMAL | FLAG_CAPTURE);
          } else if (to === this.epSquare) {
            moves.push(encodeMove(from, to, FLAG_EP | FLAG_CAPTURE, PAWN, 0));
          }
        }
      } else {
        const offsets = PIECE_OFFSETS[type];
        const slide = SLIDING[type];
        for (const off of offsets) {
          let to = from + off;
          while (onBoard(to)) {
            const target = this.board[to];
            if (!target) {
              if (!capturesOnly) moves.push(encodeMove(from, to, FLAG_NORMAL));
            } else {
              if (colorOf(target) === them) {
                moves.push(encodeMove(from, to, FLAG_NORMAL | FLAG_CAPTURE, typeOf(target), 0));
              }
              break;
            }
            if (!slide) break;
            to += off;
          }
        }
      }
    }

    // 王车易位
    if (!capturesOnly && (square === -1 || square === this.kings[us])) {
      const kingSq = this.kings[us];
      if (kingSq >= 0 && !this.isAttacked(kingSq, them)) {
        const rm = ROOK_MOVES[us];
        // 短易位
        if (this.castling & rm.k.flag) {
          const f1 = kingSq + 1, g1 = kingSq + 2;
          if (!this.board[f1] && !this.board[g1] &&
              !this.isAttacked(f1, them) && !this.isAttacked(g1, them)) {
            moves.push(encodeMove(kingSq, g1, FLAG_KSIDE));
          }
        }
        // 长易位
        if (this.castling & rm.q.flag) {
          const d1 = kingSq - 1, c1 = kingSq - 2, b1 = kingSq - 3;
          if (!this.board[d1] && !this.board[c1] && !this.board[b1] &&
              !this.isAttacked(d1, them) && !this.isAttacked(c1, them)) {
            moves.push(encodeMove(kingSq, c1, FLAG_QSIDE));
          }
        }
      }
    }

    if (!legal) return moves;

    const legalMoves = [];
    for (const m of moves) {
      this.makeMove(m);
      if (!this.isAttacked(this.kings[us], them)) legalMoves.push(m);
      this.undoMove();
    }
    return legalMoves;
  }

  // ── 执行 / 撤销 ────────────────────────────────────────
  makeMove(move) {
    const us = this.turn;
    const them = us ^ 1;
    const from = moveFrom(move);
    const to = moveTo(move);
    const flags = moveFlags(move);
    const piece = this.board[from];

    this.history.push({
      move,
      castling: this.castling,
      epSquare: this.epSquare,
      halfMoves: this.halfMoves,
      moveNumber: this.moveNumber,
      hashHi: this.hashHi,
      hashLo: this.hashLo,
      kingSq: this.kings[us],
      phase: this.phase,
      capturedPiece: flags & FLAG_EP ? makePiece(them, PAWN) : this.board[to],
    });

    this.hashHistory.push(this.hashHi, this.hashLo);

    if (this.board[to]) this.phase -= PHASE_WEIGHT[typeOf(this.board[to])];
    if (flags & FLAG_PROMOTION) this.phase += PHASE_WEIGHT[movePromo(move)];

    let hi = this.hashHi, lo = this.hashLo;
    const xorPiece = (p, s) => { hi ^= ZOB_PIECE[p][s][0]; lo ^= ZOB_PIECE[p][s][1]; };

    // 旧的易位权 / 吃过路兵位 退出哈希
    hi ^= ZOB_CASTLE[this.castling][0]; lo ^= ZOB_CASTLE[this.castling][1];
    if (this.epSquare >= 0) { hi ^= ZOB_EP[fileOf(this.epSquare)][0]; lo ^= ZOB_EP[fileOf(this.epSquare)][1]; }

    // 吃子
    if (flags & FLAG_EP) {
      const capSq = us === WHITE ? to + 16 : to - 16;
      xorPiece(this.board[capSq], capSq);
      this.board[capSq] = 0;
    } else if (this.board[to]) {
      xorPiece(this.board[to], to);
    }

    // 移动本子
    xorPiece(piece, from);
    this.board[to] = piece;
    this.board[from] = 0;

    // 升变
    if (flags & FLAG_PROMOTION) {
      const newPiece = makePiece(us, movePromo(move));
      this.board[to] = newPiece;
      xorPiece(newPiece, to);
    } else {
      xorPiece(piece, to);
    }

    // 王的位置 / 易位车
    if (typeOf(piece) === KING) {
      this.kings[us] = to;
      if (flags & FLAG_KSIDE) {
        const r = ROOK_MOVES[us].k;
        const rook = this.board[r.from];
        xorPiece(rook, r.from);
        this.board[r.to] = rook;
        this.board[r.from] = 0;
        xorPiece(rook, r.to);
      } else if (flags & FLAG_QSIDE) {
        const r = ROOK_MOVES[us].q;
        const rook = this.board[r.from];
        xorPiece(rook, r.from);
        this.board[r.to] = rook;
        this.board[r.from] = 0;
        xorPiece(rook, r.to);
      }
    }

    // 易位权更新
    this.castling &= CASTLE_MASK[from];
    this.castling &= CASTLE_MASK[to];
    hi ^= ZOB_CASTLE[this.castling][0]; lo ^= ZOB_CASTLE[this.castling][1];

    // 吃过路兵目标格
    if (flags & FLAG_BIG_PAWN) {
      this.epSquare = us === WHITE ? to + 16 : to - 16;
      hi ^= ZOB_EP[fileOf(this.epSquare)][0]; lo ^= ZOB_EP[fileOf(this.epSquare)][1];
    } else {
      this.epSquare = -1;
    }

    // 计数
    if (typeOf(piece) === PAWN || (flags & FLAG_CAPTURE)) this.halfMoves = 0;
    else this.halfMoves++;
    if (us === BLACK) this.moveNumber++;

    this.turn = them;
    hi ^= ZOB_SIDE[0]; lo ^= ZOB_SIDE[1];

    this.hashHi = hi >>> 0;
    this.hashLo = lo >>> 0;
  }

  undoMove() {
    const st = this.history.pop();
    if (!st) return null;
    this.hashHistory.length -= 2;
    const move = st.move;
    const from = moveFrom(move);
    const to = moveTo(move);
    const flags = moveFlags(move);

    this.turn ^= 1;
    const us = this.turn;
    const them = us ^ 1;

    let piece = this.board[to];
    if (flags & FLAG_PROMOTION) piece = makePiece(us, PAWN);

    this.board[from] = piece;
    this.board[to] = 0;

    if (typeOf(piece) === KING) {
      this.kings[us] = from;
      if (flags & FLAG_KSIDE) {
        const r = ROOK_MOVES[us].k;
        this.board[r.from] = this.board[r.to];
        this.board[r.to] = 0;
      } else if (flags & FLAG_QSIDE) {
        const r = ROOK_MOVES[us].q;
        this.board[r.from] = this.board[r.to];
        this.board[r.to] = 0;
      }
    }

    if (flags & FLAG_EP) {
      const capSq = us === WHITE ? to + 16 : to - 16;
      this.board[capSq] = makePiece(them, PAWN);
    } else if (st.capturedPiece) {
      this.board[to] = st.capturedPiece;
    }

    this.castling = st.castling;
    this.epSquare = st.epSquare;
    this.halfMoves = st.halfMoves;
    this.moveNumber = st.moveNumber;
    this.hashHi = st.hashHi;
    this.hashLo = st.hashLo;
    this.phase = st.phase;
    return move;
  }

  /** 空着（仅搜索使用）：交换行棋方并正确维护 Zobrist 哈希 */
  makeNullMove() {
    const st = {
      epSquare: this.epSquare,
      hashHi: this.hashHi,
      hashLo: this.hashLo,
      halfMoves: this.halfMoves,
    };
    let hi = this.hashHi, lo = this.hashLo;
    if (this.epSquare >= 0) {
      hi ^= ZOB_EP[fileOf(this.epSquare)][0];
      lo ^= ZOB_EP[fileOf(this.epSquare)][1];
      this.epSquare = -1;
    }
    hi ^= ZOB_SIDE[0]; lo ^= ZOB_SIDE[1];
    this.hashHistory.push(this.hashHi, this.hashLo);
    this.hashHi = hi >>> 0;
    this.hashLo = lo >>> 0;
    this.turn ^= 1;
    this.halfMoves = 0; // 空着后不可跨越回溯，避免误判重复
    return st;
  }

  undoNullMove(st) {
    this.hashHistory.length -= 2;
    this.turn ^= 1;
    this.epSquare = st.epSquare;
    this.hashHi = st.hashHi;
    this.hashLo = st.hashLo;
    this.halfMoves = st.halfMoves;
  }

  // ── 对局状态 ───────────────────────────────────────────
  isCheckmate() {
    return this.inCheck() && this.generateMoves().length === 0;
  }

  isStalemate() {
    return !this.inCheck() && this.generateMoves().length === 0;
  }

  /** 子力不足以将死 */
  isInsufficientMaterial() {
    const counts = {};
    const bishops = [];
    let total = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = this.board[s];
      if (!p) continue;
      const t = typeOf(p);
      counts[t] = (counts[t] || 0) + 1;
      if (t === BISHOP) bishops.push(((s >> 4) + (s & 15)) % 2);
      total++;
    }
    if (total === 2) return true;                                   // K vs K
    if (total === 3 && (counts[BISHOP] === 1 || counts[KNIGHT] === 1)) return true; // K+B / K+N
    if (total === counts[BISHOP] + 2 && bishops.length > 1) {       // 全部同色格象
      return bishops.every((c) => c === bishops[0]);
    }
    return false;
  }

  /**
   * 统计当前局面在历史中重复出现的次数（不含当前局面）。
   * 只回溯到最近一次不可逆着法（吃子 / 兵动），且仅比较同一方行棋的局面。
   */
  repetitionCount() {
    const hi = this.hashHi, lo = this.hashLo;
    const n = this.hashHistory.length;
    const maxPlies = Math.min(this.halfMoves, n >> 1);
    let count = 0;
    for (let i = 2; i <= maxPlies; i += 2) {
      const idx = n - (i << 1);
      if (idx < 0) break;
      if (this.hashHistory[idx] === hi && this.hashHistory[idx + 1] === lo) count++;
    }
    return count;
  }

  /** 三次重复局面（当前局面 + 历史中出现 2 次） */
  isThreefoldRepetition() {
    return this.repetitionCount() >= 2;
  }

  isDraw() {
    return this.halfMoves >= 100 || this.isStalemate() ||
      this.isInsufficientMaterial() || this.isThreefoldRepetition();
  }

  isGameOver() {
    return this.isCheckmate() || this.isDraw();
  }

  /** 返回结束原因；未结束返回 null */
  gameResult() {
    const moves = this.generateMoves();
    if (moves.length === 0) {
      if (this.inCheck()) {
        return {
          over: true,
          result: this.turn === WHITE ? '0-1' : '1-0',
          winner: this.turn ^ 1,
          reason: 'checkmate',
          label: this.turn === WHITE ? '黑方将杀，黑胜' : '白方将杀，白胜',
        };
      }
      return { over: true, result: '1/2-1/2', winner: null, reason: 'stalemate', label: '逼和（无子可动）— 和棋' };
    }
    if (this.halfMoves >= 100)
      return { over: true, result: '1/2-1/2', winner: null, reason: 'fifty', label: '50 回合规则 — 和棋' };
    if (this.isInsufficientMaterial())
      return { over: true, result: '1/2-1/2', winner: null, reason: 'material', label: '子力不足 — 和棋' };
    if (this.isThreefoldRepetition())
      return { over: true, result: '1/2-1/2', winner: null, reason: 'repetition', label: '三次重复局面 — 和棋' };
    return null;
  }

  // ── SAN 记谱 ───────────────────────────────────────────
  /** 生成标准代数记谱（须在走子之前调用） */
  toSan(move) {
    const from = moveFrom(move);
    const to = moveTo(move);
    const flags = moveFlags(move);
    const piece = this.board[from];
    const type = typeOf(piece);

    let san;
    if (flags & FLAG_KSIDE) san = 'O-O';
    else if (flags & FLAG_QSIDE) san = 'O-O-O';
    else {
      let out = '';
      if (type !== PAWN) {
        out += PIECE_CHARS[type].toUpperCase();
        // 消歧
        const others = this.generateMoves().filter((m) =>
          m !== move && moveTo(m) === to && typeOf(this.board[moveFrom(m)]) === type);
        if (others.length) {
          const sameFile = others.some((m) => fileOf(moveFrom(m)) === fileOf(from));
          const sameRank = others.some((m) => rankOf(moveFrom(m)) === rankOf(from));
          if (!sameFile) out += 'abcdefgh'[fileOf(from)];
          else if (!sameRank) out += String(8 - rankOf(from));
          else out += algebraic(from);
        }
      }
      if (flags & FLAG_CAPTURE) {
        if (type === PAWN) out += 'abcdefgh'[fileOf(from)];
        out += 'x';
      }
      out += algebraic(to);
      if (flags & FLAG_PROMOTION) out += '=' + PIECE_CHARS[movePromo(move)].toUpperCase();
      san = out;
    }

    this.makeMove(move);
    if (this.inCheck()) san += this.generateMoves().length === 0 ? '#' : '+';
    this.undoMove();
    return san;
  }

  /** 解析 SAN / UCI / {from,to,promotion} 为走法编码 */
  parseMove(input) {
    const moves = this.generateMoves();
    if (typeof input === 'number') return moves.includes(input) ? input : null;

    if (typeof input === 'object' && input) {
      const from = typeof input.from === 'string' ? SQ[input.from] : input.from;
      const to = typeof input.to === 'string' ? SQ[input.to] : input.to;
      const promo = input.promotion
        ? (typeof input.promotion === 'string' ? PIECE_CHARS.indexOf(input.promotion.toLowerCase()) : input.promotion)
        : 0;
      for (const m of moves) {
        if (moveFrom(m) !== from || moveTo(m) !== to) continue;
        if (moveFlags(m) & FLAG_PROMOTION) {
          if (promo && movePromo(m) !== promo) continue;
          if (!promo && movePromo(m) !== QUEEN) continue;
        }
        return m;
      }
      return null;
    }

    const str = String(input).trim();
    // UCI 形式 e2e4 / e7e8q
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(str)) {
      return this.parseMove({
        from: str.slice(0, 2).toLowerCase(),
        to: str.slice(2, 4).toLowerCase(),
        promotion: str[4],
      });
    }
    const clean = str.replace(/[+#?!]+$/, '');
    for (const m of moves) {
      const san = this.toSan(m);
      if (san === str || san.replace(/[+#]/g, '') === clean) return m;
    }
    return null;
  }

  /** 执行一步棋，返回详情对象；非法返回 null */
  move(input) {
    const m = this.parseMove(input);
    if (m === null) return null;
    const san = this.toSan(m);
    const detail = this.describeMove(m, san);
    this.makeMove(m);
    this.sanHistory.push(san);
    return detail;
  }

  describeMove(m, san = null) {
    const from = moveFrom(m);
    const to = moveTo(m);
    const flags = moveFlags(m);
    const piece = this.board[from];
    return {
      move: m,
      san: san ?? this.toSan(m),
      uci: algebraic(from) + algebraic(to) + (flags & FLAG_PROMOTION ? PIECE_CHARS[movePromo(m)] : ''),
      from: algebraic(from),
      to: algebraic(to),
      fromSq: from,
      toSq: to,
      color: colorOf(piece),
      pieceType: typeOf(piece),
      captured: moveCaptured(m) || 0,
      promotion: movePromo(m) || 0,
      flags,
      isCapture: !!(flags & FLAG_CAPTURE),
      isCastle: !!(flags & (FLAG_KSIDE | FLAG_QSIDE)),
      isEnPassant: !!(flags & FLAG_EP),
      isPromotion: !!(flags & FLAG_PROMOTION),
    };
  }

  undo() {
    const m = this.undoMove();
    if (m === null) return null;
    this.sanHistory.pop();
    return m;
  }

  /** 供 UI 使用的 64 格数组 */
  boardArray() {
    const out = new Array(64).fill(null);
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = this.board[s];
      if (p) out[to64(s)] = { color: colorOf(p), type: typeOf(p), square: algebraic(s) };
    }
    return out;
  }

  /** 双方已被吃掉的子力（按标准初始配置反推） */
  capturedPieces() {
    const initial = { [PAWN]: 8, [KNIGHT]: 2, [BISHOP]: 2, [ROOK]: 2, [QUEEN]: 1 };
    const alive = [{}, {}];
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = this.board[s];
      if (!p) continue;
      const c = colorOf(p), t = typeOf(p);
      alive[c][t] = (alive[c][t] || 0) + 1;
    }
    const res = [[], []];
    for (const c of [WHITE, BLACK]) {
      for (const t of [QUEEN, ROOK, BISHOP, KNIGHT, PAWN]) {
        const missing = (initial[t] || 0) - (alive[c][t] || 0);
        for (let i = 0; i < missing; i++) res[c].push(t);
      }
    }
    return res; // res[WHITE] = 白方损失的子
  }

  materialBalance() {
    const VAL = [0, 1, 3, 3, 5, 9, 0];
    let bal = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = this.board[s];
      if (!p) continue;
      bal += colorOf(p) === WHITE ? VAL[typeOf(p)] : -VAL[typeOf(p)];
    }
    return bal;
  }

  get(square) {
    const sq = typeof square === 'string' ? SQ[square] : square;
    const p = this.board[sq];
    return p ? { color: colorOf(p), type: typeOf(p) } : null;
  }

  /** 某格的合法目标格（UI 提示用） */
  movesFrom(square) {
    const sq = typeof square === 'string' ? SQ[square] : square;
    return this.generateMoves({ square: sq }).map((m) => ({
      to: algebraic(moveTo(m)),
      flags: moveFlags(m),
      promotion: movePromo(m),
      capture: !!(moveFlags(m) & FLAG_CAPTURE),
    }));
  }

  pgnMoves() {
    let out = '';
    for (let i = 0; i < this.sanHistory.length; i++) {
      if (i % 2 === 0) out += `${Math.floor(i / 2) + 1}. `;
      out += this.sanHistory[i] + ' ';
    }
    return out.trim();
  }
}

/** perft — 走法生成正确性验证 */
export function perft(chess, depth) {
  if (depth === 0) return 1;
  const moves = chess.generateMoves({ legal: false });
  let nodes = 0;
  const us = chess.turn;
  for (const m of moves) {
    chess.makeMove(m);
    if (!chess.isAttacked(chess.kings[us], us ^ 1)) nodes += perft(chess, depth - 1);
    chess.undoMove();
  }
  return nodes;
}
