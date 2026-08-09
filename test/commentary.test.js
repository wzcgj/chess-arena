/**
 * 思路解说生成测试：模拟一盘对局，打印每步 AI 讲解
 * 运行：node test/commentary.test.js
 */
import { Chess } from '../public/js/core/chess.js';
import { Searcher, clearTT } from '../public/js/core/search.js';
import { explainMove } from '../public/js/core/commentary.js';

const c = new Chess();
const searcher = new Searcher();
const level = 'advanced';

console.log('\n═══ AI 思路解说演示（引擎自对弈 12 回合）═══\n');

for (let i = 0; i < 24; i++) {
  clearTT();
  const before = c.clone();
  before.sanHistory = c.sanHistory.slice();
  const r = searcher.search(c, { level, maxTime: 900 });
  if (!r) break;
  const detail = c.describeMove(r.bestMove);
  c.makeMove(r.bestMove);
  c.sanHistory.push(detail.san);
  const exp = explainMove(before, detail, r, c);

  const no = Math.floor(i / 2) + 1;
  const prefix = detail.color === 0 ? `${no}.` : `${no}...`;
  console.log(`── ${prefix} ${detail.san}  【${exp.headline}】 ${exp.tags.map((t) => '#' + t.label).join(' ')}`);
  exp.points.forEach((p) => console.log('   ' + p.replace(/\*\*/g, '')));
  exp.analysis.forEach((p) => console.log('   ' + p.replace(/\*\*/g, '')));
  if (exp.pvText) console.log('   预计续着：' + exp.pvText);
  if (exp.alternatives.length) {
    console.log('   也考虑过：' + exp.alternatives.map((a) => `${a.san}(${a.score}，${a.why})`).join('；'));
  }
  console.log('   给玩家：' + exp.tip.replace(/\*\*/g, ''));
  console.log();

  if (c.gameResult()) { console.log('对局结束：' + c.gameResult().label); break; }
}

console.log('最终棋谱：', c.pgnMoves());
console.log('FEN：', c.fen());
