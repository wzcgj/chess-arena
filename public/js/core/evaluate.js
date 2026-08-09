/**
 * evaluate.js — 局面评估函数
 * 材料 + 子力位置表(中局/残局插值) + 兵结构 + 机动性 + 王安全 + 象对
 * 分值单位：厘兵（100 = 1 个兵）。正数对白有利。
 */
import {
  WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  colorOf, typeOf, onBoard, rankOf, fileOf, to64, TOTAL_PHASE,
} from './chess.js';

// 中局 / 残局材料价值
export const MG_VALUE = [0, 100, 320, 330, 500, 950, 0];
export const EG_VALUE = [0, 125, 300, 330, 545, 980, 0];
/** 通用估值（UI 展示、MVV-LVA 使用） */
export const PIECE_VALUE = [0, 100, 320, 330, 500, 950, 20000];

// 位置表：索引 0 = a8 … 63 = h1（白方视角）
const PST_PAWN_MG = [
   0,  0,  0,  0,  0,  0,  0,  0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
   5,  5, 10, 27, 27, 10,  5,  5,
   0,  0,  0, 25, 25,  0,  0,  0,
   5, -5,-10,  0,  0,-10, -5,  5,
   5, 10, 10,-25,-25, 10, 10,  5,
   0,  0,  0,  0,  0,  0,  0,  0,
];
const PST_PAWN_EG = [
   0,  0,  0,  0,  0,  0,  0,  0,
  90, 90, 90, 90, 90, 90, 90, 90,
  55, 55, 55, 55, 55, 55, 55, 55,
  30, 30, 30, 30, 30, 30, 30, 30,
  18, 18, 18, 18, 18, 18, 18, 18,
   8,  8,  8,  8,  8,  8,  8,  8,
   4,  4,  4,  4,  4,  4,  4,  4,
   0,  0,  0,  0,  0,  0,  0,  0,
];
const PST_KNIGHT = [
 -50,-40,-30,-30,-30,-30,-40,-50,
 -40,-20,  0,  0,  0,  0,-20,-40,
 -30,  0, 10, 15, 15, 10,  0,-30,
 -30,  5, 15, 20, 20, 15,  5,-30,
 -30,  0, 15, 20, 20, 15,  0,-30,
 -30,  5, 10, 15, 15, 10,  5,-30,
 -40,-20,  0,  5,  5,  0,-20,-40,
 -50,-40,-30,-30,-30,-30,-40,-50,
];
const PST_BISHOP = [
 -20,-10,-10,-10,-10,-10,-10,-20,
 -10,  0,  0,  0,  0,  0,  0,-10,
 -10,  0,  5, 10, 10,  5,  0,-10,
 -10,  5,  5, 10, 10,  5,  5,-10,
 -10,  0, 10, 10, 10, 10,  0,-10,
 -10, 10, 10, 10, 10, 10, 10,-10,
 -10,  5,  0,  0,  0,  0,  5,-10,
 -20,-10,-10,-10,-10,-10,-10,-20,
];
const PST_ROOK = [
   0,  0,  0,  0,  0,  0,  0,  0,
   5, 10, 10, 10, 10, 10, 10,  5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
   0,  0,  5, 10, 10,  5,  0,  0,
];
const PST_QUEEN = [
 -20,-10,-10, -5, -5,-10,-10,-20,
 -10,  0,  0,  0,  0,  0,  0,-10,
 -10,  0,  5,  5,  5,  5,  0,-10,
  -5,  0,  5,  5,  5,  5,  0, -5,
   0,  0,  5,  5,  5,  5,  0, -5,
 -10,  5,  5,  5,  5,  5,  0,-10,
 -10,  0,  5,  0,  0,  0,  0,-10,
 -20,-10,-10, -5, -5,-10,-10,-20,
];
const PST_KING_MG = [
 -30,-40,-40,-50,-50,-40,-40,-30,
 -30,-40,-40,-50,-50,-40,-40,-30,
 -30,-40,-40,-50,-50,-40,-40,-30,
 -30,-40,-40,-50,-50,-40,-40,-30,
 -20,-30,-30,-40,-40,-30,-30,-20,
 -10,-20,-20,-20,-20,-20,-20,-10,
  20, 20,  0,  0,  0,  0, 20, 20,
  20, 40, 20,  0,  0, 10, 40, 20,
];
const PST_KING_EG = [
 -50,-40,-30,-20,-20,-30,-40,-50,
 -30,-20,-10,  0,  0,-10,-20,-30,
 -30,-10, 20, 30, 30, 20,-10,-30,
 -30,-10, 30, 40, 40, 30,-10,-30,
 -30,-10, 30, 40, 40, 30,-10,-30,
 -30,-10, 20, 30, 30, 20,-10,-30,
 -30,-30,  0,  0,  0,  0,-30,-30,
 -50,-30,-30,-30,-30,-30,-30,-50,
];

const PST_MG = [null, PST_PAWN_MG, PST_KNIGHT, PST_BISHOP, PST_ROOK, PST_QUEEN, PST_KING_MG];
const PST_EG = [null, PST_PAWN_EG, PST_KNIGHT, PST_BISHOP, PST_ROOK, PST_QUEEN, PST_KING_EG];

/** 黑方镜像索引 */
const MIRROR = new Int32Array(64);
for (let i = 0; i < 64; i++) MIRROR[i] = (7 - ((i / 8) | 0)) * 8 + (i % 8);

// 结构性奖惩
const DOUBLED_PAWN = -18;
const ISOLATED_PAWN = -16;
const BACKWARD_PAWN = -10;
const PASSED_PAWN_BONUS = [0, 8, 16, 28, 48, 78, 120, 0]; // 按推进程度
const BISHOP_PAIR = 32;
const ROOK_OPEN_FILE = 22;
const ROOK_SEMI_OPEN = 11;
const ROOK_ON_7TH = 20;
const KNIGHT_OUTPOST = 14;
const KING_SHIELD_PAWN = 11;
const KING_OPEN_FILE_PENALTY = -22;
const TEMPO = 8;

const MOBILITY_WEIGHT = [0, 0, 4, 5, 3, 2, 0];

const KNIGHT_OFFSETS = [-18, -33, -31, -14, 18, 33, 31, 14];
const BISHOP_OFFSETS = [-17, -15, 17, 15];
const ROOK_OFFSETS = [-16, 1, 16, -1];
const KING_OFFSETS = [-17, -16, -15, 1, 17, 16, 15, -1];

/**
 * 主评估函数
 * @param {Chess} chess
 * @param {boolean} detailed 是否返回细分明细
 * @returns {number|object} 白方视角分数（厘兵）
 */
export function evaluate(chess, detailed = false) {
  const b = chess.board;

  const material = [0, 0];
  const mgPos = [0, 0];
  const egPos = [0, 0];
  const mobility = [0, 0];
  const pawnStruct = [0, 0];
  const pieceBonus = [0, 0];
  const kingSafety = [0, 0];
  const counts = [
    { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
    { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
  ];
  // 每列兵数与前沿 rank（O(1) 查询兵结构）
  const pawnFiles = [new Int32Array(8), new Int32Array(8)];
  const pawnMinRank = [new Int32Array(8).fill(8), new Int32Array(8).fill(8)]; // 最小 rank = 最靠上
  const pawnMaxRank = [new Int32Array(8).fill(-1), new Int32Array(8).fill(-1)];
  const pawnRanks = [[], []];

  // 第一遍：材料、PST、兵分布
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const p = b[s];
    if (!p) continue;
    const c = colorOf(p), t = typeOf(p);
    const idx = c === WHITE ? to64(s) : MIRROR[to64(s)];
    counts[c][t]++;
    material[c] += MG_VALUE[t];
    mgPos[c] += PST_MG[t][idx];
    egPos[c] += PST_EG[t][idx];
    if (t === PAWN) {
      const f = fileOf(s), r = rankOf(s);
      pawnFiles[c][f]++;
      if (r < pawnMinRank[c][f]) pawnMinRank[c][f] = r;
      if (r > pawnMaxRank[c][f]) pawnMaxRank[c][f] = r;
      pawnRanks[c].push(s);
    }
  }
  const phase = Math.min(chess.phase ?? TOTAL_PHASE, TOTAL_PHASE);
  const mgWeight = phase / TOTAL_PHASE;
  const egWeight = 1 - mgWeight;

  // 兵结构（全部 O(1) 判定）
  for (const c of [WHITE, BLACK]) {
    const them = c ^ 1;
    for (const s of pawnRanks[c]) {
      const f = fileOf(s), r = rankOf(s);
      // 叠兵
      if (pawnFiles[c][f] > 1) pawnStruct[c] += DOUBLED_PAWN / pawnFiles[c][f];
      // 孤兵
      const leftPawns = f > 0 ? pawnFiles[c][f - 1] : 0;
      const rightPawns = f < 7 ? pawnFiles[c][f + 1] : 0;
      if (!leftPawns && !rightPawns) pawnStruct[c] += ISOLATED_PAWN;
      // 通路兵：前方三列无敌兵阻挡
      let passed = true;
      for (let df = -1; df <= 1; df++) {
        const nf = f + df;
        if (nf < 0 || nf > 7) continue;
        if (c === WHITE) {
          if (pawnMinRank[them][nf] < r) { passed = false; break; }
        } else {
          if (pawnMaxRank[them][nf] > r) { passed = false; break; }
        }
      }
      if (passed) {
        const advance = c === WHITE ? 6 - r : r - 1;
        pawnStruct[c] += PASSED_PAWN_BONUS[Math.max(0, Math.min(7, advance + 1))];
      }
      // 落后兵：邻列同色兵全在其后方，且前进格被敌兵控制
      let backward = (leftPawns || rightPawns) ? true : false;
      if (backward) {
        for (let df = -1; df <= 1; df += 2) {
          const nf = f + df;
          if (nf < 0 || nf > 7 || !pawnFiles[c][nf]) continue;
          if (c === WHITE ? pawnMinRank[c][nf] <= r : pawnMaxRank[c][nf] >= r) { backward = false; break; }
        }
      }
      if (backward) {
        // 前进格是否被敌兵攻击
        const ahead = c === WHITE ? s - 16 : s + 16;
        const atk = c === WHITE ? [ahead - 17, ahead - 15] : [ahead + 17, ahead + 15];
        const stopped = atk.some((x) => onBoard(x) && b[x] && typeOf(b[x]) === PAWN && colorOf(b[x]) === them);
        if (stopped) pawnStruct[c] += BACKWARD_PAWN;
      }
    }
    // 象对
    if (counts[c][BISHOP] >= 2) pieceBonus[c] += BISHOP_PAIR;
  }

  // 第二遍：机动性、车/马定位、王安全
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const p = b[s];
    if (!p) continue;
    const c = colorOf(p), t = typeOf(p);
    const them = c ^ 1;

    if (t === KNIGHT) {
      let m = 0;
      for (const off of KNIGHT_OFFSETS) {
        const to = s + off;
        if (!onBoard(to)) continue;
        const q = b[to];
        if (!q || colorOf(q) !== c) m++;
      }
      mobility[c] += m * MOBILITY_WEIGHT[KNIGHT];
      // 前哨：位于对方半场且不被敌兵攻击
      const inEnemyHalf = c === WHITE ? rankOf(s) <= 3 : rankOf(s) >= 4;
      if (inEnemyHalf) {
        const atk = c === WHITE ? [s - 17, s - 15] : [s + 17, s + 15];
        const attackedByPawn = atk.some((x) => onBoard(x) && b[x] && typeOf(b[x]) === PAWN && colorOf(b[x]) === them);
        if (!attackedByPawn) pieceBonus[c] += KNIGHT_OUTPOST;
      }
    } else if (t === BISHOP || t === ROOK || t === QUEEN) {
      const offsets = t === BISHOP ? BISHOP_OFFSETS : t === ROOK ? ROOK_OFFSETS : KING_OFFSETS;
      let m = 0;
      for (const off of offsets) {
        let to = s + off;
        while (onBoard(to)) {
          const q = b[to];
          if (q) { if (colorOf(q) !== c) m++; break; }
          m++;
          to += off;
        }
      }
      mobility[c] += m * MOBILITY_WEIGHT[t];
      if (t === ROOK) {
        const f = fileOf(s);
        if (!pawnFiles[c][f]) {
          pieceBonus[c] += pawnFiles[them][f] ? ROOK_SEMI_OPEN : ROOK_OPEN_FILE;
        }
        const seventh = c === WHITE ? 1 : 6;
        if (rankOf(s) === seventh) pieceBonus[c] += ROOK_ON_7TH;
      }
    } else if (t === KING) {
      // 王前兵盾（仅中局有意义）
      const f = fileOf(s);
      let shield = 0;
      const dir = c === WHITE ? -16 : 16;
      for (let df = -1; df <= 1; df++) {
        const nf = f + df;
        if (nf < 0 || nf > 7) continue;
        const s1 = s + dir + df;
        if (onBoard(s1) && b[s1] && typeOf(b[s1]) === PAWN && colorOf(b[s1]) === c) shield++;
        else {
          const s2 = s + dir * 2 + df;
          if (onBoard(s2) && b[s2] && typeOf(b[s2]) === PAWN && colorOf(b[s2]) === c) shield++;
        }
      }
      kingSafety[c] += shield * KING_SHIELD_PAWN * mgWeight;
      if (!pawnFiles[c][f]) kingSafety[c] += KING_OPEN_FILE_PENALTY * mgWeight;
    }
  }

  // 残局材料修正（兵/车/后价值随阶段变化）
  let matEg = [0, 0];
  for (const c of [WHITE, BLACK]) {
    for (let t = PAWN; t <= QUEEN; t++) matEg[c] += counts[c][t] * EG_VALUE[t];
  }

  const side = (arr) => arr[WHITE] - arr[BLACK];
  const materialScore = (side(material) * mgWeight) + ((matEg[WHITE] - matEg[BLACK]) * egWeight);
  const positionScore = side(mgPos) * mgWeight + side(egPos) * egWeight;
  const mobilityScore = side(mobility);
  const pawnScore = side(pawnStruct);
  const pieceScore = side(pieceBonus);
  const kingScore = side(kingSafety);
  const tempo = chess.turn === WHITE ? TEMPO : -TEMPO;

  const total = Math.round(materialScore + positionScore + mobilityScore + pawnScore + pieceScore + kingScore + tempo);

  if (!detailed) return total;

  return {
    total,
    phase: mgWeight,
    stage: mgWeight > 0.75 ? 'opening' : mgWeight > 0.3 ? 'middlegame' : 'endgame',
    material: Math.round(materialScore),
    position: Math.round(positionScore),
    mobility: Math.round(mobilityScore),
    pawns: Math.round(pawnScore),
    pieces: Math.round(pieceScore),
    kingSafety: Math.round(kingScore),
    counts,
  };
}

/** 判断是否已进入残局（O(1)，读取增量维护的阶段值） */
export function isEndgame(chess) {
  return (chess.phase ?? TOTAL_PHASE) <= 8;
}
