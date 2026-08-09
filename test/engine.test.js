/**
 * 搜索引擎能力测试：战术题 + 各难度耗时
 * 运行：node test/engine.test.js
 */
import { Chess } from '../public/js/core/chess.js';
import { Searcher, LEVELS, clearTT } from '../public/js/core/search.js';

const TACTICS = [
  { name: '底线一步杀', fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', best: ['Ra8#'], mate: 1 },
  { name: '吃车底线杀', fen: '3r2k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', best: ['Rxd8#'], mate: 1 },
  { name: '单后逼杀（两步）', fen: '6k1/8/6K1/8/8/8/8/6Q1 w - - 0 1', mateOnly: 2 },
  { name: '车王配合杀（三步）', fen: '7k/8/6K1/8/8/8/8/7R w - - 0 1', mateOnly: 1 },
  { name: '直线吃后', fen: '3q1rk1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', best: ['Rxd8'] },
  { name: '黑方傻瓜杀', fen: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2', best: ['Qh4#'], mate: 1 },
  { name: '开局应选中心兵', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', best: ['e4', 'd4', 'Nf3', 'c4', 'e3', 'g3', 'Nc3'] },
];

console.log('\n═══ 搜索引擎测试 ═══\n');
let pass = 0, fail = 0;

console.log('【战术题 · 大师级】');
for (const t of TACTICS) {
  clearTT();
  const c = new Chess(t.fen);
  const s = new Searcher();
  const r = s.search(c, { level: 'master', maxTime: 2500, maxDepth: 8 });
  if (!r) { fail++; console.log(`  ✗ ${t.name} → 无合法着法（局面已终结）`); continue; }
  let ok;
  if (t.mateOnly) {
    ok = r.scoreType === 'mate' && r.mateIn > 0 && r.mateIn <= t.mateOnly;
  } else {
    ok = t.best.includes(r.detail.san) || t.best.includes(r.detail.san.replace(/[+#]$/, ''));
    if (t.mate) ok = ok && r.scoreType === 'mate' && Math.abs(r.mateIn) === t.mate;
  }
  ok ? pass++ : fail++;
  const sc = r.scoreType === 'mate' ? `#${r.mateIn}` : (r.score / 100).toFixed(2);
  console.log(`${ok ? '  ✓' : '  ✗'} ${t.name.padEnd(16, '　')} → ${r.detail.san.padEnd(7)} 评分 ${String(sc).padStart(7)}  深度 ${String(r.depth).padStart(2)}  ${String(r.nodes).padStart(8)} 节点  ${r.timeMs}ms`);
  if (!ok) console.log(`      期望之一：${t.best.join(' / ')}，主变例：${r.pv.join(' ')}`);
}

console.log('\n【各难度开局首手表现】');
for (const key of Object.keys(LEVELS)) {
  clearTT();
  const c = new Chess();
  // 跳过开局库，测真实搜索
  const s = new Searcher();
  const r = s.search(c, { level: { ...LEVELS[key], useBook: false } });
  console.log(`  · ${LEVELS[key].name.padEnd(4, '　')} 深度 ${String(r.depth).padStart(2)}  ${String(r.nodes).padStart(9)} 节点  ${String(r.timeMs).padStart(5)}ms  ${String(r.nps).padStart(8)} nps  → ${r.detail.san}  主变例: ${r.pv.slice(0, 6).join(' ')}`);
  pass++;
}

console.log('\n【中局深度测试 · 大师级】');
{
  clearTT();
  const c = new Chess('r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
  const s = new Searcher();
  const infos = [];
  const r = s.search(c, { level: 'master', maxTime: 4000, onInfo: (i) => infos.push(i) });
  console.log(`  意大利开局局面 → ${r.detail.san}  评分 ${(r.score / 100).toFixed(2)}  深度 ${r.depth}/${r.seldepth}  ${r.nodes} 节点  ${r.timeMs}ms`);
  console.log(`  主变例：${r.pv.join(' ')}`);
  console.log(`  候选着法：${r.candidates.map((x) => `${x.san}(${(x.score / 100).toFixed(2)})`).join('  ')}`);
  console.log(`  迭代信息回调次数：${infos.length}`);
  const ok = r.depth >= 6 && r.candidates.length >= 3;
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ✓' : '  ✗'} 深度与候选着法数量达标`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
