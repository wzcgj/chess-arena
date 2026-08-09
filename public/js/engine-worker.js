// AI 引擎 Worker：在后台线程运行搜索 + 思路解说，避免阻塞界面。
import {
  Chess, SQ, moveFrom, moveTo, moveFlags, movePromo, FLAG_PROMOTION,
} from './core/chess.js';
import { Searcher } from './core/search.js';
import { explainMove } from './core/commentary.js';

const IDX_TO_SQ = {};
for (const [name, idx] of Object.entries(SQ)) IDX_TO_SQ[idx] = name;
const PROMO_CHAR = { 2: 'n', 3: 'b', 4: 'r', 5: 'q' };

self.onmessage = (e) => {
  const { id, fen, level, maxTime } = e.data;
  try {
    const c = new Chess(fen);
    const before = c.clone();
    const searcher = new Searcher();
    const r = searcher.search(c, { level, maxTime: maxTime || 1000 });
    if (!r || r.bestMove == null) {
      self.postMessage({ id, error: 'no_move' });
      return;
    }
    const detail = c.describeMove(r.bestMove);
    const from = IDX_TO_SQ[moveFrom(r.bestMove)];
    const to = IDX_TO_SQ[moveTo(r.bestMove)];
    let promotion = null;
    if (moveFlags(r.bestMove) & FLAG_PROMOTION) promotion = PROMO_CHAR[movePromo(r.bestMove)] || 'q';
    c.makeMove(r.bestMove);
    const after = c;
    const exp = explainMove(before, detail, r, after);
    self.postMessage({
      id, from, to, promotion, san: detail.san, detail, result: r, exp, fenAfter: c.fen(),
    });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.stack) || err) });
  }
};
