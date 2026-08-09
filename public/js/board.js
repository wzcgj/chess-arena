// 棋盘渲染与交互：点击/拖拽落子、合法点提示、升变选择、最后一步高亮。
import {
  Chess, SQ, WHITE, BLACK,
  colorOf, typeOf, moveFrom, moveTo, moveFlags, FLAG_PROMOTION, FLAG_CAPTURE,
} from './core/chess.js';
import { pieceSVG } from './pieces.js';

const FILES = 'abcdefgh';

export class Board {
  constructor(el, { onMove, promotionPicker }) {
    this.el = el;
    this.onMove = onMove;                 // ({from,to,promotion,detail}) => void
    this.promotionPicker = promotionPicker; // (color) => Promise<'q'|'r'|'b'|'n'>
    this.chess = new Chess();
    this.orientation = WHITE;
    this.interactive = false;
    this.selected = null;
    this.hints = new Map();               // sq -> 'move' | 'capture'
    this.lastMove = null;
    this.legalCache = null;              // 当前局面的合法走法
    this._bind();
    this.render();
  }

  // ---- 公开 API ----
  loadFen(fen, { orientation } = {}) {
    this.chess = new Chess(fen);
    if (orientation !== undefined) this.orientation = orientation;
    this.selected = null; this.hints.clear(); this.lastMove = null;
    this.legalCache = null;
    this.render();
  }
  getFen() { return this.chess.fen(); }
  getChess() { return this.chess; }
  setInteractive(v) { this.interactive = v; this.el.classList.toggle('disabled', !v); }
  setOrientation(color) { this.orientation = color; this.render(); }
  flip() { this.orientation = this.orientation === WHITE ? BLACK : WHITE; this.render(); }
  undoLast() {
    const m = this.chess.undo();
    if (m !== null) {
      this.lastMove = null;
      this.selected = null; this.hints.clear();
      this.legalCache = null;
      this.render();
    }
    return m;
  }
  /** 应用一步棋（人类/AI/联网通用），返回 detail */
  applyMove({ from, to, promotion }) {
    const detail = this.chess.move({ from, to, promotion: promotion || null });
    if (!detail) return null;
    this.lastMove = { from, to };
    this.selected = null; this.hints.clear();
    this.legalCache = null;   // 局面已变，必须重新生成合法走法
    this.render();
    return detail;
  }

  // ---- 内部 ----
  _legalMoves() {
    if (!this.legalCache) this.legalCache = this.chess.generateMoves();
    return this.legalCache;
  }
  _movesFrom(fromIdx) {
    return this._legalMoves().filter((m) => moveFrom(m) === fromIdx);
  }
  _displayToFR(row, col) {
    if (this.orientation === WHITE) return { file: col, rank: 7 - row };
    return { file: 7 - col, rank: row };
  }
  _select(from) {
    this.selected = from;
    this.hints.clear();
    for (const m of this._movesFrom(SQ[from])) {
      const toName = SQ_NAME[moveTo(m)];
      const cap = moveFlags(m) & FLAG_CAPTURE;
      this.hints.set(toName, cap ? 'capture' : 'move');
    }
    this.render();
  }
  _deselect() { this.selected = null; this.hints.clear(); this.render(); }

  async _execute(from, to) {
    const candidates = this._movesFrom(SQ[from]).filter((m) => moveTo(m) === SQ[to]);
    if (!candidates.length) { this._deselect(); return; }
    let promotion = null;
    if (moveFlags(candidates[0]) & FLAG_PROMOTION) {
      const color = this.chess.turn;
      promotion = await this.promotionPicker(color);
      if (!promotion) { this._deselect(); return; }   // 用户取消升变
    }
    const detail = this.applyMove({ from, to, promotion });
    if (detail && this.onMove) this.onMove({ from, to, promotion, detail });
  }

  _bind() {
    this.el.addEventListener('pointerdown', (e) => this._onDown(e));
    this.el.addEventListener('pointermove', (e) => this._onMove(e));
    this.el.addEventListener('pointerup', (e) => this._onUp(e));
    this.el.addEventListener('pointercancel', () => this._endDrag());
  }

  _onDown(e) {
    if (!this.interactive) return;
    const sqEl = e.target.closest('.square');
    if (!sqEl) return;
    const from = sqEl.dataset.sq;
    // 已选中且点到合法目标 → 直接走（点击落子）
    if (this.selected && this.hints.has(from)) {
      e.preventDefault();
      this._execute(this.selected, from);
      return;
    }
    const piece = this.chess.board[SQ[from]];
    if (piece && colorOf(piece) === this.chess.turn) {
      this._select(from);
      this._beginDrag(from, e);
    } else {
      this._deselect();
    }
  }
  _onMove(e) {
    if (!this._dragging) return;
    this._ghost.style.left = e.clientX + 'px';
    this._ghost.style.top = e.clientY + 'px';
  }
  _onUp(e) {
    if (!this._dragging) return;
    const target = this._squareAt(e.clientX, e.clientY);
    const from = this._dragFrom;
    this._endDrag();
    if (target && target !== from && this.hints.has(target)) {
      this._execute(from, target);
    } else if (!target || target === from) {
      // 原地松开：保持选中（即点击选择）
    } else {
      this._deselect();
    }
  }
  _beginDrag(from, e) {
    this._dragging = true;
    this._dragFrom = from;
    const piece = this.chess.board[SQ[from]];
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.innerHTML = pieceSVG(typeOf(piece), colorOf(piece));
    document.body.appendChild(ghost);
    this._ghost = ghost;
    ghost.style.left = e.clientX + 'px';
    ghost.style.top = e.clientY + 'px';
    try { this.el.setPointerCapture(e.pointerId); } catch {}
  }
  _endDrag() {
    this._dragging = false;
    this._dragFrom = null;
    if (this._ghost) { this._ghost.remove(); this._ghost = null; }
  }
  _squareAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const sq = el && el.closest('.square');
    return sq ? sq.dataset.sq : null;
  }

  render() {
    this.el.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'board-grid';

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const { file, rank } = this._displayToFR(row, col);
        const name = FILES[file] + (rank + 1);
        const idx = SQ[name];
        const sq = document.createElement('div');
        sq.className = 'square ' + ((file + rank) % 2 === 0 ? 'light' : 'dark');
        sq.dataset.sq = name;
        const piece = this.chess.board[idx];
        if (piece) {
          const d = document.createElement('div');
          d.className = 'piece';
          d.innerHTML = pieceSVG(typeOf(piece), colorOf(piece));
          sq.appendChild(d);
        }
        if (this.lastMove && (this.lastMove.from === name || this.lastMove.to === name)) {
          sq.classList.add('lastmove');
        }
        if (this.selected === name) sq.classList.add('sel');
        const hint = this.hints.get(name);
        if (hint) {
          const h = document.createElement('div');
          h.className = hint === 'capture' ? 'hint-ring' : 'hint-dot';
          sq.appendChild(h);
        }
        grid.appendChild(sq);
      }
    }

    // 代数记谱放到棋盘外圈：左侧行标 1-8、底部列标 a-h，不遮挡任何格子
    const rankGutter = document.createElement('div');
    rankGutter.className = 'coord-gutter coord-gutter-rank';
    for (let row = 0; row < 8; row++) {
      const { rank } = this._displayToFR(row, 0);
      const lab = document.createElement('div');
      lab.className = 'coord-label';
      lab.textContent = rank + 1;
      rankGutter.appendChild(lab);
    }
    const fileGutter = document.createElement('div');
    fileGutter.className = 'coord-gutter coord-gutter-file';
    for (let col = 0; col < 8; col++) {
      const { file } = this._displayToFR(0, col);
      const lab = document.createElement('div');
      lab.className = 'coord-label';
      lab.textContent = FILES[file];
      fileGutter.appendChild(lab);
    }

    this.el.appendChild(rankGutter);
    this.el.appendChild(grid);
    this.el.appendChild(fileGutter);
  }
}

// SQ 反查：索引 -> 名称
const SQ_NAME = (() => {
  const map = {};
  for (const [name, idx] of Object.entries(SQ)) map[idx] = name;
  return map;
})();
