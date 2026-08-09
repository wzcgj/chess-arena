/**
 * search.js — Alpha-Beta 搜索引擎
 * 迭代加深 + 主变例搜索(PVS) + 置换表 + 静默搜索
 * + 空着裁剪 + 迟走缩减(LMR) + 杀手/历史启发 + MVV-LVA
 */
import {
  Chess, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  FLAG_CAPTURE, FLAG_PROMOTION, FLAG_KSIDE, FLAG_QSIDE,
  moveFrom, moveTo, moveFlags, moveCaptured, movePromo,
  typeOf, colorOf, algebraic,
} from './chess.js';
import { evaluate, PIECE_VALUE, isEndgame } from './evaluate.js';

export const MATE_SCORE = 30000;
export const MATE_BOUND = MATE_SCORE - 1000;
export const INF = 32000;

// ── 难度档位 ─────────────────────────────────────────────
export const LEVELS = {
  novice: {
    key: 'novice', name: '初级', elo: '约 800',
    maxDepth: 2, maxTime: 500,
    topRange: 220,      // 从「最优分 - topRange」范围内随机选
    blunderRate: 0.22,  // 主动走出明显次优着的概率
    blunderRange: 500,
    useBook: true, bookDepth: 4,
    desc: '只看眼前一两步，容易漏掉战术，适合刚入门的棋手练手。',
  },
  amateur: {
    key: 'amateur', name: '中级', elo: '约 1300',
    maxDepth: 4, maxTime: 1200,
    topRange: 70, blunderRate: 0.07, blunderRange: 220,
    useBook: true, bookDepth: 8,
    desc: '能算清三四回合的兑子与简单战术，会抢占中心、及时易位。',
  },
  advanced: {
    key: 'advanced', name: '高级', elo: '约 1800',
    maxDepth: 7, maxTime: 2600,
    topRange: 18, blunderRate: 0.01, blunderRange: 90,
    useBook: true, bookDepth: 12,
    desc: '擅长中局战术组合与子力协调，很少送子，会主动制造弱点。',
  },
  master: {
    key: 'master', name: '大师级', elo: '约 2200+',
    maxDepth: 20, maxTime: 5000,
    topRange: 0, blunderRate: 0, blunderRange: 0,
    useBook: true, bookDepth: 16,
    desc: '深度计算长变化，兼顾局面与残局技术，几乎不会犯战术性错误。',
  },
};

// ── 置换表 ───────────────────────────────────────────────
const TT_BITS = 20;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;

const ttKeyHi = new Int32Array(TT_SIZE);
const ttKeyLo = new Int32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttFlag = new Int8Array(TT_SIZE);
const ttScore = new Int32Array(TT_SIZE);
const ttMove = new Int32Array(TT_SIZE);
let ttGeneration = 0;

export function clearTT() {
  ttKeyHi.fill(0); ttKeyLo.fill(0); ttDepth.fill(0);
  ttFlag.fill(0); ttScore.fill(0); ttMove.fill(0);
  ttGeneration = 0;
}

// ── 迷你开局库（常见主流开局，按 SAN 序列匹配）────────────
const OPENING_BOOK = [
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6'], // 西班牙
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4', 'exd4', 'cxd4', 'Bb4+'],           // 意大利
  ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4', 'Nf6', 'Nc3', 'Bb4'],                          // 苏格兰
  ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'Be2', 'e5'],               // 西西里·奈道夫
  ['e4', 'c5', 'Nf3', 'Nc6', 'd4', 'cxd4', 'Nxd4', 'g6', 'Nc3', 'Bg7'],                           // 西西里·龙式
  ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Bb4', 'e5', 'c5', 'a3', 'Bxc3+'],                              // 法兰西·温克尔
  ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5', 'Ng3', 'Bg6'],                           // 卡罗康
  ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3', 'O-O'],                              // 后翼弃兵
  ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'dxc4', 'a4', 'Bf5'],                             // 斯拉夫
  ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6', 'Nf3', 'O-O', 'Be2', 'e5'],                 // 王翼印度
  ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'e3', 'O-O', 'Bd3', 'd5'],                              // 尼姆佐印度
  ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'b6', 'g3', 'Ba6', 'b3', 'Bb7'],                               // 后翼印度
  ['c4', 'e5', 'Nc3', 'Nf6', 'Nf3', 'Nc6', 'g3', 'd5'],                                            // 英国式
  ['Nf3', 'd5', 'g3', 'Nf6', 'Bg2', 'e6', 'O-O', 'Be7', 'd4', 'O-O'],                              // 列蒂
  ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5', 'd4', 'Nf6'],                                         // 斯堪的纳维亚
  ['e4', 'Nf6', 'e5', 'Nd5', 'd4', 'd6', 'Nf3', 'g6'],                                             // 阿廖欣
  ['d4', 'd5', 'c4', 'dxc4', 'Nf3', 'Nf6', 'e3', 'e6', 'Bxc4', 'c5'],                              // 接受后翼弃兵
  ['e4', 'e5', 'Nf3', 'Nf6', 'Nxe5', 'd6', 'Nf3', 'Nxe4', 'd4', 'd5'],                             // 彼得罗夫
];

function bookMove(sanHistory, level) {
  if (!level.useBook || sanHistory.length >= level.bookDepth) return null;
  const cands = [];
  for (const line of OPENING_BOOK) {
    if (line.length <= sanHistory.length) continue;
    let ok = true;
    for (let i = 0; i < sanHistory.length; i++) {
      if (line[i] !== sanHistory[i]) { ok = false; break; }
    }
    if (ok) cands.push(line[sanHistory.length]);
  }
  if (!cands.length) return null;
  return cands[(Math.random() * cands.length) | 0];
}

// ── 搜索器 ───────────────────────────────────────────────
export class Searcher {
  constructor() {
    this.nodes = 0;
    this.qnodes = 0;
    this.startTime = 0;
    this.timeLimit = 0;
    this.stopped = false;
    this.killers = [];      // killers[ply] = [m1, m2]
    this.history = new Int32Array(128 * 128);
    this.pvTable = [];
    this.pvLength = new Int32Array(64);
    this.seldepth = 0;
    this.onInfo = null;
  }

  _resetTables() {
    this.killers = Array.from({ length: 64 }, () => [0, 0]);
    this.history.fill(0);
    this.pvTable = Array.from({ length: 64 }, () => new Int32Array(64));
    this.pvLength.fill(0);
  }

  _timeUp() {
    if (this.stopped) return true;
    if ((this.nodes & 1023) === 0 && Date.now() - this.startTime >= this.timeLimit) {
      this.stopped = true;
    }
    return this.stopped;
  }

  /**
   * 主入口
   * @param {Chess} chess 当前局面（不会被改变）
   * @param {object} opts { level, maxDepth, maxTime, multiPV, onInfo }
   */
  search(chess, opts = {}) {
    const level = typeof opts.level === 'string' ? LEVELS[opts.level] : (opts.level || LEVELS.advanced);
    const maxDepth = opts.maxDepth ?? level.maxDepth;
    const maxTime = opts.maxTime ?? level.maxTime;
    // 低难度需要更多候选来制造"人味"的随机性，深度浅代价也小
    const multiPV = opts.multiPV ?? (level.maxDepth <= 2 ? 10 : level.maxDepth <= 4 ? 7 : 5);
    this.onInfo = opts.onInfo || null;

    const pos = chess.clone();
    const t0 = Date.now();

    // 开局库（仅当棋谱记录与局面完全对应，即确实从初始局面走到此处）
    const plyCount = (pos.moveNumber - 1) * 2 + (pos.turn === BLACK ? 1 : 0);
    const historyMatches = (chess.sanHistory?.length || 0) === plyCount;
    const bm = (historyMatches && opts.useBook !== false) ? bookMove(chess.sanHistory || [], level) : null;
    if (bm) {
      const parsed = pos.parseMove(bm);
      if (parsed !== null) {
        const detail = pos.describeMove(parsed);
        return {
          bestMove: parsed,
          detail,
          score: 0,
          scoreType: 'book',
          depth: 0,
          seldepth: 0,
          nodes: 0,
          timeMs: Date.now() - t0,
          pv: [detail.san],
          candidates: [{ move: parsed, san: detail.san, score: 0, pv: [detail.san], detail }],
          fromBook: true,
          evalBefore: evaluate(pos, true),
          levelKey: level.key,
        };
      }
    }

    this.nodes = 0;
    this.qnodes = 0;
    this.seldepth = 0;
    this.stopped = false;
    this.startTime = t0;
    this.timeLimit = maxTime;
    this._resetTables();
    ttGeneration++;

    const rootMoves = pos.generateMoves();
    if (!rootMoves.length) return null;

    // 单一合法走法：直接返回
    if (rootMoves.length === 1) {
      const detail = pos.describeMove(rootMoves[0]);
      return {
        bestMove: rootMoves[0], detail, score: 0, scoreType: 'forced', depth: 0,
        seldepth: 0, nodes: 0, timeMs: Date.now() - t0, pv: [detail.san],
        candidates: [{ move: rootMoves[0], san: detail.san, score: 0, pv: [detail.san], detail }],
        forced: true, evalBefore: evaluate(pos, true), levelKey: level.key,
      };
    }

    let scored = rootMoves.map((m) => ({ move: m, score: -INF, pv: [], exact: false }));
    let completedDepth = 0;
    let lastFullResult = null;

    // fail-low 走法的分数只是上界，不能与精确分混排：精确分组在前，组内按分数降序
    const rank = (a, b) => (a.exact === b.exact ? b.score - a.score : (a.exact ? -1 : 1));

    for (let depth = 1; depth <= maxDepth; depth++) {
      const iterStart = Date.now();
      let alpha = -INF;
      const beta = INF;
      let best = -INF;
      const iterScored = [];
      let idx = 0;

      for (const entry of scored) {
        const m = entry.move;
        pos.makeMove(m);
        let score;
        let exact = true;
        // 前 multiPV 个用全窗口，保证候选分数精确（供思路讲解使用）
        if (idx < multiPV) {
          score = -this._negamax(pos, depth - 1, -INF, INF, 1, true);
        } else {
          score = -this._negamax(pos, depth - 1, -alpha - 1, -alpha, 1, true);
          if (score > alpha && !this.stopped) {
            score = -this._negamax(pos, depth - 1, -beta, -alpha, 1, true);
          } else {
            // fail-low：返回值只是上界，不能当精确分使用
            exact = false;
          }
        }
        const pv = this.stopped ? entry.pv : [m, ...this._extractPV(pos, depth - 1)];
        pos.undoMove();

        if (this.stopped) break;
        iterScored.push({ move: m, score, pv, exact });
        if (score > best) best = score;
        if (exact && score > alpha) alpha = score; // root 收紧窗口
        idx++;
      }

      if (this.stopped && iterScored.length < 2) break;

      if (iterScored.length) {
        // 未搜完的走法沿用上一轮分数，避免顺序抖动
        if (iterScored.length < scored.length) {
          const done = new Set(iterScored.map((e) => e.move));
          for (const e of scored) if (!done.has(e.move)) iterScored.push({ ...e, score: e.score - 1, exact: false });
        }
        iterScored.sort(rank);
        scored = iterScored;
        completedDepth = depth;
        lastFullResult = scored;

        if (this.onInfo) {
          this.onInfo({
            depth,
            seldepth: this.seldepth,
            score: scored[0].score,
            nodes: this.nodes,
            timeMs: Date.now() - t0,
            pv: this._pvToSan(chess, scored[0].pv),
            nps: Math.round(this.nodes / Math.max(1, Date.now() - t0) * 1000),
          });
        }
      }

      // 找到必胜杀棋则提前结束
      if (Math.abs(scored[0].score) > MATE_BOUND) break;
      if (this.stopped) break;
      // 时间预算不足以完成下一层
      const elapsed = Date.now() - t0;
      const iterMs = Date.now() - iterStart;
      if (elapsed + iterMs * 2.2 > maxTime && depth >= 2) break;
    }

    const finalList = lastFullResult || scored;
    // 只有精确分的走法才可用于展示与选点（fail-low 的分数是高估的上界）
    const exactList = finalList.filter((e) => e.exact);
    const pickList = exactList.length ? exactList : finalList;
    const chosen = this._pickByLevel(pickList, level);
    const detail = pos.describeMove(chosen.move);

    const candidates = pickList.slice(0, multiPV).map((e) => {
      const d = pos.describeMove(e.move);
      return { move: e.move, san: d.san, score: e.score, pv: this._pvToSan(chess, e.pv), detail: d };
    });

    return {
      bestMove: chosen.move,
      detail,
      score: chosen.score,
      scoreType: Math.abs(chosen.score) > MATE_BOUND ? 'mate' : 'cp',
      mateIn: Math.abs(chosen.score) > MATE_BOUND
        ? Math.ceil((MATE_SCORE - Math.abs(chosen.score)) / 2) * (chosen.score > 0 ? 1 : -1)
        : null,
      depth: completedDepth,
      seldepth: this.seldepth,
      nodes: this.nodes,
      timeMs: Date.now() - t0,
      nps: Math.round(this.nodes / Math.max(1, Date.now() - t0) * 1000),
      pv: this._pvToSan(chess, chosen.pv),
      candidates,
      bestAlternative: pickList[0].move !== chosen.move
        ? { san: pos.describeMove(pickList[0].move).san, score: pickList[0].score }
        : null,
      deliberateWeakness: pickList[0].move !== chosen.move,
      evalBefore: evaluate(pos, true),
      levelKey: level.key,
      fromBook: false,
    };
  }

  /** 按难度从候选中挑选（低难度故意不总选最优） */
  _pickByLevel(list, level) {
    if (!level.topRange || list.length === 1) return list[0];
    const best = list[0].score;
    // 必杀 / 濒临被杀时不放水
    if (Math.abs(best) > MATE_BOUND) return list[0];

    if (level.blunderRate > 0 && Math.random() < level.blunderRate) {
      const pool = list.filter((e) => best - e.score <= level.blunderRange);
      if (pool.length > 1) {
        // 偏向较差的一端，模拟人类失误
        const weak = pool.slice(Math.max(1, Math.floor(pool.length / 2)));
        return weak[(Math.random() * weak.length) | 0];
      }
    }
    const pool = list.filter((e) => best - e.score <= level.topRange);
    // 依分数做加权随机，分数越高概率越大
    const weights = pool.map((e) => Math.exp((e.score - best) / Math.max(20, level.topRange / 2)));
    const sum = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * sum;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return pool[i];
    }
    return pool[0];
  }

  _extractPV(pos, maxLen) {
    // 从置换表回溯主变例
    const pv = [];
    const undo = [];
    for (let i = 0; i < Math.max(0, maxLen) + 4 && i < 16; i++) {
      const idx = (pos.hashLo & TT_MASK) >>> 0;
      if (ttKeyHi[idx] !== (pos.hashHi | 0) || ttKeyLo[idx] !== (pos.hashLo | 0)) break;
      const m = ttMove[idx];
      if (!m) break;
      const legal = pos.generateMoves();
      if (!legal.includes(m)) break;
      pv.push(m);
      pos.makeMove(m);
      undo.push(true);
    }
    while (undo.pop()) pos.undoMove();
    return pv;
  }

  _pvToSan(chessOrig, movesArr) {
    if (!movesArr || !movesArr.length) return [];
    const c = chessOrig.clone();
    const out = [];
    for (const m of movesArr) {
      const legal = c.generateMoves();
      if (!legal.includes(m)) break;
      out.push(c.toSan(m));
      c.makeMove(m);
    }
    return out;
  }

  // ── 核心 negamax ──────────────────────────────────────
  _negamax(pos, depth, alpha, beta, ply, canNull) {
    if (this._timeUp()) return 0;
    this.nodes++;
    if (ply > this.seldepth) this.seldepth = ply;

    const inCheck = pos.inCheck();
    if (inCheck) depth++; // 将军延伸

    if (depth <= 0) return this._quiescence(pos, alpha, beta, ply);

    // 和棋检测（重复 / 50 回合）
    if (ply > 0 && (pos.halfMoves >= 100 || pos.repetitionCount() >= 1)) return 0;

    const alphaOrig = alpha;
    const ttIdx = (pos.hashLo & TT_MASK) >>> 0;
    let ttBest = 0;
    if (ttKeyHi[ttIdx] === (pos.hashHi | 0) && ttKeyLo[ttIdx] === (pos.hashLo | 0)) {
      ttBest = ttMove[ttIdx];
      if (ttDepth[ttIdx] >= depth) {
        let s = ttScore[ttIdx];
        if (s > MATE_BOUND) s -= ply;
        else if (s < -MATE_BOUND) s += ply;
        const f = ttFlag[ttIdx];
        if (f === TT_EXACT) return s;
        if (f === TT_LOWER && s > alpha) alpha = s;
        else if (f === TT_UPPER && s < beta) beta = s;
        if (alpha >= beta) return s;
      }
    }

    const staticEval = evaluate(pos) * (pos.turn === WHITE ? 1 : -1);

    // 无用剪枝（Reverse futility）
    if (!inCheck && depth <= 3 && Math.abs(beta) < MATE_BOUND) {
      if (staticEval - 120 * depth >= beta) return staticEval;
    }

    // 空着裁剪
    if (canNull && !inCheck && depth >= 3 && !isEndgame(pos) && staticEval >= beta) {
      const st = pos.makeNullMove();
      const R = 2 + ((depth / 4) | 0);
      const score = -this._negamax(pos, depth - 1 - R, -beta, -beta + 1, ply + 1, false);
      pos.undoNullMove(st);
      if (this.stopped) return 0;
      if (score >= beta) return beta;
    }

    const moves = pos.generateMoves();
    if (!moves.length) return inCheck ? -MATE_SCORE + ply : 0;

    this._orderMoves(pos, moves, ttBest, ply);

    let bestScore = -INF;
    let bestMove = 0;
    let moveCount = 0;

    for (const m of moves) {
      const isCapture = !!(moveFlags(m) & FLAG_CAPTURE);
      const isPromo = !!(moveFlags(m) & FLAG_PROMOTION);
      moveCount++;

      pos.makeMove(m);
      const givesCheck = pos.inCheck();

      let score;
      if (moveCount === 1) {
        score = -this._negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        // 迟走缩减
        let reduction = 0;
        if (depth >= 3 && moveCount > 3 && !isCapture && !isPromo && !inCheck && !givesCheck) {
          reduction = 1 + ((depth > 5 && moveCount > 6) ? 1 : 0);
        }
        score = -this._negamax(pos, depth - 1 - reduction, -alpha - 1, -alpha, ply + 1, true);
        if (score > alpha && reduction) {
          score = -this._negamax(pos, depth - 1, -alpha - 1, -alpha, ply + 1, true);
        }
        if (score > alpha && score < beta) {
          score = -this._negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
        }
      }
      pos.undoMove();

      if (this.stopped) return 0;

      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
      if (score > alpha) {
        alpha = score;
        if (alpha >= beta) {
          if (!isCapture) {
            const k = this.killers[ply];
            if (k[0] !== m) { k[1] = k[0]; k[0] = m; }
            this.history[(moveFrom(m) << 7) | moveTo(m)] += depth * depth;
          }
          break;
        }
      }
    }

    // 存置换表
    let storeScore = bestScore;
    if (storeScore > MATE_BOUND) storeScore += ply;
    else if (storeScore < -MATE_BOUND) storeScore -= ply;
    if (depth >= ttDepth[ttIdx] || ttKeyLo[ttIdx] !== (pos.hashLo | 0)) {
      ttKeyHi[ttIdx] = pos.hashHi | 0;
      ttKeyLo[ttIdx] = pos.hashLo | 0;
      ttDepth[ttIdx] = Math.min(127, depth);
      ttScore[ttIdx] = storeScore;
      ttMove[ttIdx] = bestMove;
      ttFlag[ttIdx] = bestScore <= alphaOrig ? TT_UPPER : bestScore >= beta ? TT_LOWER : TT_EXACT;
    }

    return bestScore;
  }

  // ── 静默搜索 ──────────────────────────────────────────
  _quiescence(pos, alpha, beta, ply) {
    if (this._timeUp()) return 0;
    this.nodes++;
    this.qnodes++;
    if (ply > this.seldepth) this.seldepth = ply;

    const standPat = evaluate(pos) * (pos.turn === WHITE ? 1 : -1);
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;
    if (ply > 40) return standPat;

    const moves = pos.generateMoves({ capturesOnly: true });
    this._orderMoves(pos, moves, 0, ply);

    for (const m of moves) {
      // Delta 剪枝
      const capVal = PIECE_VALUE[moveCaptured(m)] || 0;
      const promoVal = movePromo(m) ? PIECE_VALUE[movePromo(m)] - PIECE_VALUE[PAWN] : 0;
      if (standPat + capVal + promoVal + 200 < alpha) continue;
      // SEE 简易过滤：明显亏子的吃法跳过
      if (capVal && this._see(pos, m) < -50) continue;

      pos.makeMove(m);
      const score = -this._quiescence(pos, -beta, -alpha, ply + 1);
      pos.undoMove();
      if (this.stopped) return 0;
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  /** 静态交换评估（简化版） */
  _see(pos, move) {
    const to = moveTo(move);
    const from = moveFrom(move);
    const captured = moveCaptured(move);
    const attacker = typeOf(pos.board[from]);
    const gain = PIECE_VALUE[captured] - PIECE_VALUE[attacker];
    if (gain >= 0) return gain;
    // 目标格是否被对方保护
    pos.makeMove(move);
    const defended = pos.isAttacked(to, pos.turn);
    pos.undoMove();
    return defended ? gain : PIECE_VALUE[captured];
  }

  /** 走法排序：TT 走法 > 好的吃子(MVV-LVA) > 杀手 > 历史 > 差吃子 */
  _orderMoves(pos, moves, ttBest, ply) {
    const killers = this.killers[ply] || [0, 0];
    const scores = new Map();
    for (const m of moves) {
      let s = 0;
      if (m === ttBest) s = 1000000;
      else if (moveFlags(m) & FLAG_CAPTURE) {
        const victim = PIECE_VALUE[moveCaptured(m)] || 0;
        const aggressor = PIECE_VALUE[typeOf(pos.board[moveFrom(m)])] || 0;
        s = 500000 + victim * 10 - aggressor;
      } else if (moveFlags(m) & FLAG_PROMOTION) {
        s = 400000 + PIECE_VALUE[movePromo(m)];
      } else if (m === killers[0]) s = 300000;
      else if (m === killers[1]) s = 290000;
      else s = this.history[(moveFrom(m) << 7) | moveTo(m)];
      if (moveFlags(m) & (FLAG_KSIDE | FLAG_QSIDE)) s += 12000;
      scores.set(m, s);
    }
    moves.sort((a, b) => scores.get(b) - scores.get(a));
  }

}

/** 便捷函数：直接求一步棋 */
export function findBestMove(chess, levelKey = 'advanced', onInfo = null) {
  const s = new Searcher();
  return s.search(chess, { level: levelKey, onInfo });
}
