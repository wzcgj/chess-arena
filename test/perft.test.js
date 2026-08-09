/**
 * perft 测试 —— 用国际公认的基准局面校验走法生成的正确性。
 * 运行：node test/perft.test.js
 */
import { Chess, perft, START_FEN } from '../public/js/core/chess.js';

const CASES = [
  { name: '初始局面', fen: START_FEN, expect: [20, 400, 8902, 197281] },
  { name: 'Kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', expect: [48, 2039, 97862, 4085603] },
  { name: '残局(吃过路兵)', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', expect: [14, 191, 2812, 43238, 674624] },
  { name: '升变局面', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', expect: [6, 264, 9467, 422333] },
  { name: '复杂中局', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', expect: [44, 1486, 62379, 2103487] },
  { name: 'Steven Edwards', fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', expect: [46, 2079, 89890] },
];

let pass = 0, fail = 0;
console.log('\n═══ 国际象棋引擎 perft 校验 ═══\n');

for (const c of CASES) {
  for (let d = 1; d <= c.expect.length; d++) {
    const chess = new Chess(c.fen);
    const t0 = Date.now();
    const got = perft(chess, d);
    const ms = Date.now() - t0;
    const ok = got === c.expect[d - 1];
    if (ok) pass++; else fail++;
    const nps = ms > 0 ? Math.round(got / ms / 1000) : '∞';
    console.log(
      `${ok ? '  ✓' : '  ✗'} ${c.name.padEnd(14, '　')} depth ${d}: ${String(got).padStart(9)} ` +
      `(期望 ${String(c.expect[d - 1]).padStart(9)})  ${String(ms).padStart(5)}ms  ${nps}k nps`
    );
  }
}

// FEN 往返一致性
const roundTrip = ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', START_FEN];
for (const f of roundTrip) {
  const ok = new Chess(f).fen() === f;
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ✓' : '  ✗'} FEN 往返一致性: ${f.slice(0, 30)}…`);
}

// SAN 解析闭环
{
  const c = new Chess();
  const seq = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7'];
  let ok = true;
  for (const s of seq) if (!c.move(s)) { ok = false; break; }
  ok = ok && c.sanHistory.join(' ') === seq.join(' ');
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ✓' : '  ✗'} SAN 解析（西班牙开局 10 手）`);
}

// 将杀识别（学者杀）
{
  const c = new Chess();
  ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'].forEach((m) => c.move(m));
  const ok = c.isCheckmate() && c.gameResult()?.reason === 'checkmate';
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ✓' : '  ✗'} 将杀识别（学者杀）`);
}

// 逼和识别
{
  const c = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  const ok = c.isStalemate() && c.gameResult()?.reason === 'stalemate';
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ✓' : '  ✗'} 逼和识别`);
}

// 三次重复
{
  const c = new Chess();
  ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8'].forEach((m) => c.move(m));
  const ok = c.isThreefoldRepetition();
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ✓' : '  ✗'} 三次重复局面识别`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
