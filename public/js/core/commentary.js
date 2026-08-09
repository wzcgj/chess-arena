/**
 * commentary.js — AI 落子思路解说生成器
 *
 * 把搜索引擎输出的冷冰冰数字（评分、主变例、节点数）翻译成
 * 人类棋手能理解的中文讲解：这步棋在做什么、为什么这么走、
 * 接下来会怎样、还考虑过哪些方案、玩家该注意什么。
 */
import {
  WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  SQ, algebraic, colorOf, typeOf, onBoard, rankOf, fileOf,
  FLAG_CAPTURE, FLAG_PROMOTION, FLAG_KSIDE, FLAG_QSIDE,
  moveFrom, moveTo, moveFlags,
} from './chess.js';
import { PIECE_VALUE, evaluate } from './evaluate.js';

export const PIECE_NAME = ['', '兵', '马', '象', '车', '后', '王'];
export const PIECE_NAME_FULL = ['', '兵', '马', '象', '车', '皇后', '国王'];
const COLOR_NAME = ['白方', '黑方'];

const CENTER = [SQ.d4, SQ.e4, SQ.d5, SQ.e5];
const BIG_CENTER = [
  SQ.c3, SQ.d3, SQ.e3, SQ.f3, SQ.c4, SQ.d4, SQ.e4, SQ.f4,
  SQ.c5, SQ.d5, SQ.e5, SQ.f5, SQ.c6, SQ.d6, SQ.e6, SQ.f6,
];

const KNIGHT_OFFSETS = [-18, -33, -31, -14, 18, 33, 31, 14];
const BISHOP_OFFSETS = [-17, -15, 17, 15];
const ROOK_OFFSETS = [-16, 1, 16, -1];
const KING_OFFSETS = [-17, -16, -15, 1, 17, 16, 15, -1];

// ── 基础分析工具 ─────────────────────────────────────────

/** 找出所有攻击 target 格的 byColor 方棋子 */
export function findAttackers(chess, target, byColor) {
  const b = chess.board;
  const res = [];
  // 兵
  const pawnFrom = byColor === WHITE ? [target + 17, target + 15] : [target - 17, target - 15];
  for (const s of pawnFrom) {
    if (onBoard(s) && b[s] && typeOf(b[s]) === PAWN && colorOf(b[s]) === byColor) res.push(s);
  }
  // 马
  for (const off of KNIGHT_OFFSETS) {
    const s = target + off;
    if (onBoard(s) && b[s] && typeOf(b[s]) === KNIGHT && colorOf(b[s]) === byColor) res.push(s);
  }
  // 王
  for (const off of KING_OFFSETS) {
    const s = target + off;
    if (onBoard(s) && b[s] && typeOf(b[s]) === KING && colorOf(b[s]) === byColor) res.push(s);
  }
  // 斜线
  for (const off of BISHOP_OFFSETS) {
    let s = target + off;
    while (onBoard(s)) {
      const p = b[s];
      if (p) {
        const t = typeOf(p);
        if (colorOf(p) === byColor && (t === BISHOP || t === QUEEN)) res.push(s);
        break;
      }
      s += off;
    }
  }
  // 直线
  for (const off of ROOK_OFFSETS) {
    let s = target + off;
    while (onBoard(s)) {
      const p = b[s];
      if (p) {
        const t = typeOf(p);
        if (colorOf(p) === byColor && (t === ROOK || t === QUEEN)) res.push(s);
        break;
      }
      s += off;
    }
  }
  return res;
}

/** 某格棋子是否"挂着"（被攻击且交换亏损） */
export function isHanging(chess, sq) {
  const p = chess.board[sq];
  if (!p) return false;
  const me = colorOf(p);
  const attackers = findAttackers(chess, sq, me ^ 1);
  if (!attackers.length) return false;
  const defenders = findAttackers(chess, sq, me);
  if (!defenders.length) return true;
  // 最低价值攻击者小于被攻击子 → 亏
  const minAtk = Math.min(...attackers.map((s) => PIECE_VALUE[typeOf(chess.board[s])]));
  return minAtk < PIECE_VALUE[typeOf(p)];
}

/** 该子从 sq 出发攻击到的所有敌方棋子 */
export function attackedTargets(chess, sq) {
  const p = chess.board[sq];
  if (!p) return [];
  const me = colorOf(p), them = me ^ 1;
  const t = typeOf(p);
  const out = [];
  const push = (s) => {
    const q = chess.board[s];
    if (q && colorOf(q) === them) out.push({ square: s, type: typeOf(q), value: PIECE_VALUE[typeOf(q)] });
  };
  if (t === PAWN) {
    const dirs = me === WHITE ? [sq - 17, sq - 15] : [sq + 17, sq + 15];
    for (const s of dirs) if (onBoard(s)) push(s);
  } else if (t === KNIGHT) {
    for (const off of KNIGHT_OFFSETS) if (onBoard(sq + off)) push(sq + off);
  } else if (t === KING) {
    for (const off of KING_OFFSETS) if (onBoard(sq + off)) push(sq + off);
  } else {
    const offsets = t === BISHOP ? BISHOP_OFFSETS : t === ROOK ? ROOK_OFFSETS : KING_OFFSETS;
    for (const off of offsets) {
      let s = sq + off;
      while (onBoard(s)) {
        if (chess.board[s]) { push(s); break; }
        s += off;
      }
    }
  }
  return out;
}

/** 检测捉双：该子同时攻击 2 个以上有价值且缺乏保护的目标 */
export function detectFork(chess, sq) {
  const targets = attackedTargets(chess, sq).filter((t) => {
    if (t.type === KING) return true;
    const attackerVal = PIECE_VALUE[typeOf(chess.board[sq])];
    if (t.value > attackerVal) return true;
    return !findAttackers(chess, t.square, colorOf(chess.board[t.square])).length;
  });
  return targets.length >= 2 ? targets : null;
}

/** 检测牵制/串击：沿滑行线，目标子后方还有更有价值的子 */
export function detectPin(chess, sq) {
  const p = chess.board[sq];
  if (!p) return null;
  const t = typeOf(p);
  if (t !== BISHOP && t !== ROOK && t !== QUEEN) return null;
  const me = colorOf(p), them = me ^ 1;
  const offsets = t === BISHOP ? BISHOP_OFFSETS : t === ROOK ? ROOK_OFFSETS : KING_OFFSETS;
  for (const off of offsets) {
    let s = sq + off;
    let first = -1;
    while (onBoard(s)) {
      const q = chess.board[s];
      if (q) {
        if (colorOf(q) !== them) break;
        if (first < 0) { first = s; }
        else {
          const frontVal = PIECE_VALUE[typeOf(chess.board[first])];
          const backVal = PIECE_VALUE[typeOf(q)];
          if (backVal > frontVal) {
            return {
              front: first, frontType: typeOf(chess.board[first]),
              back: s, backType: typeOf(q),
              absolute: typeOf(q) === KING,
            };
          }
          break;
        }
      }
      s += off;
    }
  }
  return null;
}

/** 统计底线未出动的轻子数量 */
function undevelopedCount(chess, color) {
  const backRank = color === WHITE ? 7 : 0;
  let n = 0;
  for (let f = 0; f < 8; f++) {
    const s = backRank * 16 + f;
    const p = chess.board[s];
    if (p && colorOf(p) === color && (typeOf(p) === KNIGHT || typeOf(p) === BISHOP)) n++;
  }
  return n;
}

/** 是否控制中心格 */
function controlsCenter(chess, sq) {
  const hit = attackedSquaresOf(chess, sq);
  return CENTER.filter((c) => hit.includes(c));
}

function attackedSquaresOf(chess, sq) {
  const p = chess.board[sq];
  if (!p) return [];
  const me = colorOf(p), t = typeOf(p);
  const out = [];
  if (t === PAWN) {
    const dirs = me === WHITE ? [sq - 17, sq - 15] : [sq + 17, sq + 15];
    for (const s of dirs) if (onBoard(s)) out.push(s);
  } else if (t === KNIGHT) {
    for (const off of KNIGHT_OFFSETS) if (onBoard(sq + off)) out.push(sq + off);
  } else if (t === KING) {
    for (const off of KING_OFFSETS) if (onBoard(sq + off)) out.push(sq + off);
  } else {
    const offsets = t === BISHOP ? BISHOP_OFFSETS : t === ROOK ? ROOK_OFFSETS : KING_OFFSETS;
    for (const off of offsets) {
      let s = sq + off;
      while (onBoard(s)) {
        out.push(s);
        if (chess.board[s]) break;
        s += off;
      }
    }
  }
  return out;
}

/** 该列是否为开放线（无兵）/半开放线 */
function fileStatus(chess, file, color) {
  let own = 0, opp = 0;
  for (let r = 0; r < 8; r++) {
    const p = chess.board[r * 16 + file];
    if (p && typeOf(p) === PAWN) (colorOf(p) === color ? own++ : opp++);
  }
  if (!own && !opp) return 'open';
  if (!own) return 'semi';
  return 'closed';
}

// ── 文本工具 ─────────────────────────────────────────────
const FILE_CN = { a: 'a', b: 'b', c: 'c', d: 'd', e: 'e', f: 'f', g: 'g', h: 'h' };

function scoreText(cp, forColor = WHITE) {
  const v = forColor === WHITE ? cp : -cp;
  const abs = Math.abs(v);
  const num = (v / 100).toFixed(2);
  const sign = v > 0 ? '+' : '';
  let judge;
  if (abs < 30) judge = '局面均衡';
  else if (abs < 90) judge = (v > 0 ? '白方' : '黑方') + '略占主动';
  else if (abs < 250) judge = (v > 0 ? '白方' : '黑方') + '优势明显';
  else if (abs < 600) judge = (v > 0 ? '白方' : '黑方') + '大占上风';
  else judge = (v > 0 ? '白方' : '黑方') + '胜势';
  return { num: sign + num, judge, raw: v };
}

function pvText(pvSans, startColor, startMoveNo) {
  if (!pvSans || !pvSans.length) return '';
  let out = '';
  let color = startColor;
  let no = startMoveNo;
  for (let i = 0; i < pvSans.length; i++) {
    if (color === WHITE) out += `${no}. `;
    else if (i === 0) out += `${no}... `;
    out += pvSans[i] + ' ';
    if (color === BLACK) no++;
    color ^= 1;
  }
  return out.trim();
}

// ── 主函数 ───────────────────────────────────────────────
/**
 * 生成一步棋的完整讲解
 * @param {Chess} before   走这步之前的局面
 * @param {object} detail  走法详情（chess.describeMove 的结果）
 * @param {object} result  搜索结果（Searcher.search 的返回值）
 * @param {Chess} after    走这步之后的局面
 */
export function explainMove(before, detail, result, after) {
  const me = detail.color;
  const them = me ^ 1;
  const myName = COLOR_NAME[me];
  const oppName = COLOR_NAME[them];
  const pieceName = PIECE_NAME[detail.pieceType];
  const tags = [];
  const points = [];   // 主要意图（按重要性排序）
  const evalBefore = result?.evalBefore || evaluate(before, true);
  const stage = evalBefore.stage;
  const stageName = { opening: '开局', middlegame: '中局', endgame: '残局' }[stage];

  const toSq = detail.toSq;
  const fromSq = detail.fromSq;
  const afterResult = after.gameResult();

  // ── 1. 终局类 ──────────────────────────────────────────
  if (afterResult?.reason === 'checkmate') {
    tags.push({ key: 'mate', label: '将杀', tone: 'critical' });
    points.push(`**${detail.san}** 直接将死对手，对局结束。`);
  } else if (afterResult?.reason === 'stalemate') {
    tags.push({ key: 'stalemate', label: '逼和', tone: 'warn' });
    points.push(`这步造成逼和 —— 对方无子可动却没有被将军，按规则判和。`);
  } else if (after.inCheck()) {
    tags.push({ key: 'check', label: '将军', tone: 'critical' });
    const kingSq = after.kings[them];
    const escapes = after.generateMoves().length;
    points.push(`**${detail.san}** 叫将，${oppName}国王被迫应对，目前只有 ${escapes} 种合法应法。`);
  }

  // ── 2. 吃子与兑换 ──────────────────────────────────────
  if (detail.isCapture) {
    const capName = PIECE_NAME[detail.captured];
    const capValue = PIECE_VALUE[detail.captured];
    const myValue = PIECE_VALUE[detail.pieceType];
    const recapture = findAttackers(after, toSq, them).length > 0;
    if (detail.isEnPassant) {
      tags.push({ key: 'ep', label: '吃过路兵', tone: 'accent' });
      points.push(`使用"吃过路兵"规则拿下 ${detail.to} 的兵 —— 这是国际象棋独有的规则：对方兵首次走两格越过我方兵的攻击格时，可以像它只走一格那样吃掉它，但机会仅限当下这一步。`);
    } else if (!recapture) {
      tags.push({ key: 'wincap', label: '净赚子力', tone: 'good' });
      points.push(`吃掉 ${detail.to} 的${capName}且对方无法回吃，${myName}净赚 ${(capValue / 100).toFixed(0)} 个兵的子力。`);
    } else if (capValue > myValue + 50) {
      tags.push({ key: 'wincap', label: '以小博大', tone: 'good' });
      points.push(`用${pieceName}换掉对方的${capName}（${(capValue / 100).toFixed(0)} 分换 ${(myValue / 100).toFixed(0)} 分），即使被回吃仍然占便宜。`);
    } else if (capValue < myValue - 50) {
      tags.push({ key: 'sac', label: '弃子', tone: 'critical' });
      points.push(`这是一步**弃子**：用${pieceName}换取对方的${capName}表面吃亏，但引擎算到后续能夺回更多补偿。`);
    } else {
      tags.push({ key: 'trade', label: '兑子', tone: 'neutral' });
      points.push(`在 ${detail.to} 兑掉对方的${capName}，简化局面。`);
    }
  }

  // ── 3. 升变 ────────────────────────────────────────────
  if (detail.isPromotion) {
    tags.push({ key: 'promo', label: '升变', tone: 'good' });
    points.push(`兵抵达底线升变为**${PIECE_NAME_FULL[detail.promotion]}** —— 这是残局中最有价值的转折点。`);
  }

  // ── 4. 王车易位 ────────────────────────────────────────
  if (detail.isCastle) {
    const side = detail.flags & FLAG_KSIDE ? '短易位（王翼）' : '长易位（后翼）';
    tags.push({ key: 'castle', label: '王车易位', tone: 'good' });
    points.push(`完成${side}：国王躲进兵阵后方获得安全，同时车被激活到中心线上。开局阶段尽早易位是最重要的原则之一。`);
  }

  // ── 5. 战术动机 ────────────────────────────────────────
  const fork = detectFork(after, toSq);
  if (fork && fork.length >= 2) {
    const names = fork.map((t) => `${detail.color === WHITE ? '' : ''}${algebraic(t.square)} 的${PIECE_NAME[t.type]}`).join(' 和 ');
    tags.push({ key: 'fork', label: '捉双', tone: 'critical' });
    points.push(`形成**捉双**：这个${pieceName}同时攻击 ${names}，对方无法两头兼顾。`);
  }

  const pin = detectPin(after, toSq);
  if (pin) {
    tags.push({ key: 'pin', label: pin.absolute ? '绝对牵制' : '串击', tone: 'critical' });
    if (pin.absolute) {
      points.push(`构成**绝对牵制**：${algebraic(pin.front)} 的${PIECE_NAME[pin.frontType]}被钉在国王前面动弹不得，一旦移开就会暴露王的位置。`);
    } else {
      points.push(`形成**串击**：${algebraic(pin.front)} 的${PIECE_NAME[pin.frontType]}身后是更值钱的${PIECE_NAME[pin.backType]}，对方挪子就要付出代价。`);
    }
  }

  // 新增威胁（走后攻击到的高价值目标）
  const newThreats = attackedTargets(after, toSq).filter((t) => {
    if (t.type === KING) return false;
    const defenders = findAttackers(after, t.square, them);
    const myVal = PIECE_VALUE[detail.isPromotion ? detail.promotion : detail.pieceType];
    return t.value > myVal || !defenders.length;
  });
  if (newThreats.length === 1 && !fork) {
    const t = newThreats[0];
    tags.push({ key: 'threat', label: '制造威胁', tone: 'accent' });
    points.push(`落子后立刻威胁 ${algebraic(t.square)} 的${PIECE_NAME[t.type]}，逼迫${oppName}分心处理。`);
  }

  // ── 6. 防守动机：走之前自己有子挂着吗 ─────────────────
  if (isHanging(before, fromSq) && !detail.isCapture) {
    tags.push({ key: 'save', label: '解救受攻子力', tone: 'accent' });
    points.push(`原本 ${detail.from} 的${pieceName}正被攻击且缺乏保护，这步把它转移到安全位置。`);
  }
  // 是否为应将
  if (before.inCheck()) {
    tags.push({ key: 'evade', label: '应将', tone: 'warn' });
    points.push(`${myName}正被将军，这步是引擎认为最好的解将方式。`);
  }

  // ── 7. 位置性意图 ──────────────────────────────────────
  if (points.length < 3) {
    // 发展子力
    const backRank = me === WHITE ? 7 : 0;
    if ((detail.pieceType === KNIGHT || detail.pieceType === BISHOP) && rankOf(fromSq) === backRank) {
      const left = undevelopedCount(after, me);
      tags.push({ key: 'develop', label: '出动子力', tone: 'good' });
      points.push(`把${pieceName}从底线调动到 ${detail.to} 投入战斗${left ? `，${myName}还有 ${left} 个轻子等待出动` : '，轻子已全部就位'}。`);
    }
    // 中心控制
    const centerHits = controlsCenter(after, toSq);
    if (centerHits.length) {
      const inCenter = CENTER.includes(toSq);
      tags.push({ key: 'center', label: '控制中心', tone: 'good' });
      points.push(
        inCenter
          ? `${pieceName}直接占据中心要点 ${detail.to}，中心子力活动范围最大，是全盘的制高点。`
          : `从 ${detail.to} 控制 ${centerHits.map(algebraic).join('、')} 等中心格 —— 争夺中心是开局的首要任务。`
      );
    }
    // 车占开放线 / 第七横线
    if (detail.pieceType === ROOK) {
      const st = fileStatus(after, fileOf(toSq), me);
      const seventh = me === WHITE ? 1 : 6;
      if (rankOf(toSq) === seventh) {
        tags.push({ key: 'rook7', label: '车入七路', tone: 'good' });
        points.push(`车侵入对方第 7 横线 —— 这里能横扫对方未动的兵，同时把敌王压制在底线。`);
      } else if (st === 'open') {
        tags.push({ key: 'openfile', label: '占据开放线', tone: 'good' });
        points.push(`车进驻无兵阻挡的 ${algebraic(toSq)[0]} 线，火力可以直达对方阵地。`);
      } else if (st === 'semi') {
        tags.push({ key: 'openfile', label: '半开放线', tone: 'accent' });
        points.push(`车站上半开放的 ${algebraic(toSq)[0]} 线，正对着对方的兵施加长期压力。`);
      }
    }
    // 兵推进
    if (detail.pieceType === PAWN && !detail.isCapture && !detail.isPromotion) {
      const advance = me === WHITE ? 6 - rankOf(toSq) : rankOf(toSq) - 1;
      if (BIG_CENTER.includes(toSq)) {
        tags.push({ key: 'space', label: '扩张空间', tone: 'good' });
        points.push(`兵推进到 ${detail.to} 抢占空间，把对方的子力压回己方半场。`);
      } else if (advance >= 4) {
        tags.push({ key: 'passer', label: '推进通路兵', tone: 'good' });
        points.push(`兵已推进到 ${detail.to}，距离升变只剩 ${7 - advance} 步 —— 残局中一个通路兵往往就是胜负手。`);
      }
    }
    // 马占前哨
    if (detail.pieceType === KNIGHT) {
      const inEnemyHalf = me === WHITE ? rankOf(toSq) <= 3 : rankOf(toSq) >= 4;
      const pawnAtk = me === WHITE ? [toSq - 17, toSq - 15] : [toSq + 17, toSq + 15];
      const safe = !pawnAtk.some((s) => onBoard(s) && after.board[s] && typeOf(after.board[s]) === PAWN && colorOf(after.board[s]) === them);
      if (inEnemyHalf && safe) {
        tags.push({ key: 'outpost', label: '建立前哨', tone: 'good' });
        points.push(`马跳到 ${detail.to} 建立**前哨**：深入对方阵地且不会被兵驱赶，这样的马往往比象更强。`);
      }
    }
    // 王的活跃（残局）
    if (detail.pieceType === KING && stage === 'endgame') {
      tags.push({ key: 'activeking', label: '王的活跃', tone: 'good' });
      points.push(`残局阶段国王本身就是强子，主动向中心/关键区域靠拢是正确的思路。`);
    }
  }

  if (!points.length) {
    tags.push({ key: 'improve', label: '改善位置', tone: 'neutral' });
    points.push(`把${pieceName}调整到 ${detail.to}，这是一步稳健的调整着，为后续计划做准备。`);
  }

  // ── 8. 形势与算路 ──────────────────────────────────────
  const sc = result ? scoreText(result.score * (me === WHITE ? 1 : -1), WHITE) : null;
  const evalAfter = evaluate(after, true);

  const lines = [];
  if (result?.fromBook) {
    lines.push(`这步出自**开局定式库**。${stageName}阶段沿用成熟的开局体系，可以少走弯路，把精力留给中局的较量。`);
  } else if (result) {
    const mateTxt = result.scoreType === 'mate'
      ? `已经算到 ${Math.abs(result.mateIn)} 回合内的**杀棋**`
      : `局面评估 ${sc.num}（${sc.judge}）`;
    lines.push(
      `引擎向前推演了 **${result.depth} 层**（关键变化最深 ${result.seldepth} 层），` +
      `检索 ${result.nodes.toLocaleString('zh-CN')} 个局面，用时 ${(result.timeMs / 1000).toFixed(1)} 秒，${mateTxt}。`
    );
  }

  // ── 9. 备选方案 ────────────────────────────────────────
  const alternatives = [];
  if (result?.candidates?.length > 1) {
    const best = result.candidates[0].score;
    for (const c of result.candidates.slice(0, 4)) {
      if (c.move === detail.move) continue;
      const diff = (best - c.score) / 100;
      let why;
      if (diff < 0.15) why = '几乎同样好，走成另一种风格的局面';
      else if (diff < 0.5) why = '稍逊一筹，但也完全可行';
      else if (diff < 1.5) why = '会让对方获得更舒服的局面';
      else why = '会明显吃亏，引擎已排除';
      alternatives.push({
        san: c.san,
        score: (c.score / 100).toFixed(2),
        diff: diff.toFixed(2),
        why,
        pv: c.pv.slice(0, 4).join(' '),
      });
      if (alternatives.length >= 3) break;
    }
  }

  // ── 10. 给玩家的提示 ───────────────────────────────────
  let tip = '';
  const oppBest = result?.pv?.[1];
  const myHanging = [];
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const p = after.board[s];
    if (p && colorOf(p) === them && typeOf(p) !== KING && isHanging(after, s)) {
      myHanging.push({ sq: s, type: typeOf(p) });
    }
  }
  myHanging.sort((a, b) => PIECE_VALUE[b.type] - PIECE_VALUE[a.type]);

  if (after.inCheck()) {
    tip = `你正在被将军，必须立刻解将：移动国王、吃掉将军的子，或用别的子挡在中间。`;
  } else if (myHanging.length) {
    const h = myHanging[0];
    tip = `注意：你在 ${algebraic(h.sq)} 的${PIECE_NAME[h.type]}目前缺乏保护，随时可能被吃。可以考虑挪走它、给它加保护，或者制造更大的反威胁。`;
  } else if (oppBest) {
    tip = `引擎预计你接下来会走 **${oppBest}**。如果你有别的想法，不妨先想清楚它能带来什么 —— 每步棋最好都服务于一个明确目的。`;
  } else if (stage === 'opening') {
    tip = `开局三原则：抢占中心、快速出动轻子、尽早王车易位。同一个子不要在开局重复走动。`;
  } else {
    tip = `落子前先检查对方上一步创造了什么威胁，再考虑自己的计划。`;
  }

  // ── 11. 组装标题 ───────────────────────────────────────
  const priority = ['mate', 'check', 'fork', 'pin', 'sac', 'promo', 'wincap', 'castle',
    'threat', 'trade', 'save', 'evade', 'rook7', 'outpost', 'openfile', 'center',
    'develop', 'space', 'passer', 'activeking', 'ep', 'improve', 'stalemate'];
  const sortedTags = [...tags].sort((a, b) => priority.indexOf(a.key) - priority.indexOf(b.key));
  const headline = sortedTags.slice(0, 2).map((t) => t.label).join(' · ') || '稳健调整';

  return {
    san: detail.san,
    headline,
    tags: sortedTags,
    points,
    analysis: lines,
    score: result ? {
      cp: result.score * (me === WHITE ? 1 : -1),
      text: sc?.num,
      judge: sc?.judge,
      mate: result.scoreType === 'mate' ? result.mateIn : null,
    } : null,
    pv: result?.pv || [],
    pvText: pvText(result?.pv || [], me, before.moveNumber),
    depth: result?.depth || 0,
    seldepth: result?.seldepth || 0,
    nodes: result?.nodes || 0,
    timeMs: result?.timeMs || 0,
    alternatives,
    tip,
    stage,
    stageName,
    evalBreakdown: {
      material: evalAfter.material,
      position: evalAfter.position,
      mobility: evalAfter.mobility,
      pawns: evalAfter.pawns,
      pieces: evalAfter.pieces,
      kingSafety: evalAfter.kingSafety,
    },
    deliberateWeakness: !!result?.deliberateWeakness,
    bestAlternative: result?.bestAlternative || null,
    fromBook: !!result?.fromBook,
  };
}

/** 对玩家刚走的一步做点评（用于"复盘提示"） */
export function reviewPlayerMove(before, detail, after, scoreBefore, scoreAfter) {
  // scoreBefore / scoreAfter 均为白方视角厘兵
  const me = detail.color;
  const loss = me === WHITE ? scoreBefore - scoreAfter : scoreAfter - scoreBefore;
  let grade, label, tone, text;
  if (loss <= 10) { grade = 'best'; label = '好棋'; tone = 'good'; text = '这步与引擎的首选一致，思路很正。'; }
  else if (loss <= 50) { grade = 'good'; label = '不错'; tone = 'good'; text = '合理的一步，局面没有实质损失。'; }
  else if (loss <= 120) { grade = 'inaccuracy'; label = '不够精确'; tone = 'neutral'; text = '有更好的选择，这步让优势略有流失。'; }
  else if (loss <= 300) { grade = 'mistake'; label = '失误'; tone = 'warn'; text = '这步明显让局面变差了，建议复盘时对照引擎的推荐。'; }
  else { grade = 'blunder'; label = '严重错误'; tone = 'critical'; text = '这步损失很大，很可能直接送掉子力或错过关键战术。'; }
  return { grade, label, tone, text, loss: Math.round(loss) };
}
