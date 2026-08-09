// 应用主控：模式切换、单机 AI 对战、联网对战、账号与棋谱。
import { WHITE, BLACK, typeOf, colorOf, PAWN, KNIGHT, BISHOP, ROOK, QUEEN } from './core/chess.js';
import { Board } from './board.js';
import { pieceSVG } from './pieces.js';
import { account, OnlineClient } from './net.js';

const $ = (id) => document.getElementById(id);

const LEVEL_LABEL = {
  novice: '初级', amateur: '中级', advanced: '高级', master: '大师级',
};
const LEVEL_TIME = {
  novice: 350, amateur: 700, advanced: 1400, master: 2600,
};

const state = {
  mode: 'single',          // 'single' | 'online'
  level: 'amateur',
  humanColor: WHITE,
  thinking: false,
  gameOver: false,
  saved: false,
  online: {
    color: null, opponent: null, roomId: null, matching: false, active: false,
  },
  startedAt: null,
  clock: { white: 0, black: 0, running: false, last: 0, timer: null },
};

// ---------- Worker ----------
let worker = null;
let workerSeq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker('js/engine-worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const { id } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (e.data.error) p.reject(new Error(e.data.error));
    else p.resolve(e.data);
  };
  worker.onerror = (err) => {
    for (const [, p] of pending) p.reject(new Error(err.message || 'worker error'));
    pending.clear();
  };
  return worker;
}
function askEngine(fen, level) {
  const id = ++workerSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, fen, level, maxTime: LEVEL_TIME[level] || 1000 });
  });
}

// ---------- 升变选择 ----------
function pickPromotion(color) {
  return new Promise((resolve) => {
    const modal = $('promoModal');
    const box = $('promoChoices');
    box.innerHTML = '';
    for (const [ch, type] of [['q', QUEEN], ['r', ROOK], ['b', BISHOP], ['n', KNIGHT]]) {
      const btn = document.createElement('button');
      btn.className = 'promo-btn';
      btn.innerHTML = pieceSVG(type, color);
      btn.onclick = () => { modal.classList.add('hidden'); resolve(ch); };
      box.appendChild(btn);
    }
    modal.classList.remove('hidden');
  });
}

// ---------- 棋盘 ----------
const board = new Board($('board'), {
  onMove: handleHumanMove,
  promotionPicker: pickPromotion,
});

// ---------- UI 辅助 ----------
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function setStatus(text, cls = '') {
  const b = $('statusBanner');
  b.textContent = text;
  b.className = 'status-banner' + (cls ? ' ' + cls : '');
}

function refreshStatus() {
  if (state.gameOver) return;
  const c = board.getChess();
  const turnName = c.turn === WHITE ? '白方' : '黑方';
  if (state.mode === 'online') {
    if (!state.online.active) { setStatus(state.online.matching ? '正在匹配对手…' : '点击「寻找对手」开始联网对战'); return; }
    const mine = c.turn === state.online.color;
    setStatus(mine ? `轮到你走（${turnName}）` : `等待对手（${turnName}）`, mine ? 'active' : '');
  } else {
    if (state.thinking) { setStatus(`电脑思考中…（${LEVEL_LABEL[state.level]}）`, 'thinking'); return; }
    const mine = c.turn === state.humanColor;
    setStatus(mine ? `轮到你走（${turnName}）` : `电脑走棋（${turnName}）`, mine ? 'active' : '');
  }
  if (c.inCheck()) setStatus(($('statusBanner').textContent) + ' · 将军！', 'check');
}

function renderMoves() {
  const list = $('moveList');
  const san = board.getChess().sanHistory;
  list.innerHTML = '';
  for (let i = 0; i < san.length; i += 2) {
    const li = document.createElement('li');
    const w = document.createElement('span');
    w.className = 'mv'; w.textContent = san[i] || '';
    const b = document.createElement('span');
    b.className = 'mv'; b.textContent = san[i + 1] || '';
    if (i + 2 >= san.length) (san[i + 1] ? b : w).classList.add('cur');
    li.append(w, b);
    list.appendChild(li);
  }
  list.scrollTop = list.scrollHeight;
}

function renderCaptured() {
  const c = board.getChess();
  const counts = { [WHITE]: {}, [BLACK]: {} };
  const START = { [PAWN]: 8, [KNIGHT]: 2, [BISHOP]: 2, [ROOK]: 2, [QUEEN]: 1 };
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const p = c.board[s];
    if (!p) continue;
    const col = colorOf(p), t = typeOf(p);
    counts[col][t] = (counts[col][t] || 0) + 1;
  }
  const VAL = { [PAWN]: 1, [KNIGHT]: 3, [BISHOP]: 3, [ROOK]: 5, [QUEEN]: 9 };
  const build = (victimColor, el) => {
    // victimColor 的棋子被吃掉 → 显示在对方一侧
    let diff = 0, html = '';
    for (const t of [QUEEN, ROOK, BISHOP, KNIGHT, PAWN]) {
      const lost = START[t] - (counts[victimColor][t] || 0);
      diff += lost * VAL[t];
      for (let i = 0; i < lost; i++) html += `<span class="cap-p">${pieceSVG(Number(t), victimColor)}</span>`;
    }
    el.innerHTML = html;
    return diff;
  };
  const lostWhite = build(WHITE, $('capturedWhite'));
  const lostBlack = build(BLACK, $('capturedBlack'));
  // 优势分展示
  const adv = lostBlack - lostWhite; // 白方净赚
  const tag = (el, n) => {
    if (n > 0) el.insertAdjacentHTML('beforeend', `<span class="cap-adv">+${n}</span>`);
  };
  tag($('capturedBlack'), adv > 0 ? adv : 0);
  tag($('capturedWhite'), adv < 0 ? -adv : 0);
}

// ---------- 思路面板 ----------
const escHtml = (s) => String(s == null ? '' : s)
  .replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
// 讲解文本里用 **粗体** 标注关键词，转成 <b>
const mdBold = (s) => escHtml(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

function renderCommentary(exp, meta = {}) {
  const box = $('commentary');
  if (!exp) { box.innerHTML = '<div class="think-empty">等待电脑走子…</div>'; return; }

  const tags = (exp.tags || []).map((t) => {
    const label = typeof t === 'string' ? t : t.label;
    const key = typeof t === 'string' ? '' : t.key;
    return `<span class="tag tag-${escHtml(key)}">${escHtml(label)}</span>`;
  }).join('');

  const points = (exp.points || []).map((p) => `<li>${mdBold(p)}</li>`).join('');
  const analysis = (Array.isArray(exp.analysis) ? exp.analysis : [exp.analysis])
    .filter(Boolean).map((l) => `<p class="c-text">${mdBold(l)}</p>`).join('');

  const alts = (exp.alternatives || []).map((a) => `
    <div class="alt">
      <div class="alt-row">
        <span class="alt-san">${escHtml(a.san)}</span>
        <span class="alt-score">${escHtml(a.score)}${a.diff > 0 ? ` <i>(-${escHtml(a.diff)})</i>` : ''}</span>
      </div>
      <div class="alt-why">${escHtml(a.why || '')}</div>
      ${a.pv ? `<div class="alt-pv">${escHtml(a.pv)}</div>` : ''}
    </div>`).join('');

  const sc = exp.score;
  const scoreHtml = sc
    ? (sc.mate != null
        ? `<b class="sc-mate">${sc.mate > 0 ? '' : '被'}${Math.abs(sc.mate)} 步杀</b>`
        : `<b>${escHtml(sc.text)}</b><span class="sc-judge">${escHtml(sc.judge)}</span>`)
    : '';

  const depth = meta.depth ?? exp.depth;
  const nodes = meta.nodes ?? exp.nodes;

  box.innerHTML = `
    <div class="c-head">
      <div class="c-move">${escHtml(meta.san || '')}</div>
      <div class="c-headline">${escHtml(exp.headline || '')}</div>
    </div>
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    <div class="c-metrics">
      ${scoreHtml ? `<div class="metric"><span>局面评估</span>${scoreHtml}</div>` : ''}
      ${exp.stageName ? `<div class="metric"><span>阶段</span><b>${escHtml(exp.stageName)}</b></div>` : ''}
      ${depth ? `<div class="metric"><span>搜索深度</span><b>${escHtml(depth)} 层</b></div>` : ''}
      ${nodes ? `<div class="metric"><span>计算节点</span><b>${Number(nodes).toLocaleString('zh-CN')}</b></div>` : ''}
      ${exp.timeMs ? `<div class="metric"><span>耗时</span><b>${(exp.timeMs / 1000).toFixed(2)}s</b></div>` : ''}
    </div>
    ${points ? `<div class="c-sec"><div class="c-sec-t">这一步的意图</div><ul class="c-points">${points}</ul></div>` : ''}
    ${analysis ? `<div class="c-sec"><div class="c-sec-t">它算到了什么</div>${analysis}</div>` : ''}
    ${exp.pvText ? `<div class="c-sec"><div class="c-sec-t">预计后续</div><div class="pv">${escHtml(exp.pvText)}</div></div>` : ''}
    ${alts ? `<div class="c-sec"><div class="c-sec-t">还考虑过</div>${alts}</div>` : ''}
    ${exp.deliberateWeakness ? `<div class="c-warn">这一步是电脑在当前难度下<b>故意保留的不精确</b>，实战中你可以尝试抓住它。</div>` : ''}
    ${exp.tip ? `<div class="c-tip"><b>给你的提示</b>${mdBold(exp.tip)}</div>` : ''}
  `;
  box.scrollTop = 0;
}

// ---------- 计时 ----------
function startClock() {
  stopClock();
  state.clock.last = Date.now();
  state.clock.running = true;
  state.clock.timer = setInterval(tickClock, 250);
}
function stopClock() {
  if (state.clock.timer) clearInterval(state.clock.timer);
  state.clock.timer = null;
  state.clock.running = false;
}
function tickClock() {
  const now = Date.now();
  const dt = (now - state.clock.last) / 1000;
  state.clock.last = now;
  const c = board.getChess();
  if (!state.gameOver) state.clock[c.turn === WHITE ? 'white' : 'black'] += dt;
  renderClocks();
}
function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function renderClocks() {
  const c = board.getChess();
  $('clockWhite').querySelector('.t').textContent = fmt(state.clock.white);
  $('clockBlack').querySelector('.t').textContent = fmt(state.clock.black);
  $('clockWhite').classList.toggle('active', !state.gameOver && c.turn === WHITE);
  $('clockBlack').classList.toggle('active', !state.gameOver && c.turn === BLACK);
}

// ---------- 对局流程 ----------
function afterAnyMove() {
  renderMoves();
  renderCaptured();
  renderClocks();
  const res = board.getChess().gameResult();
  if (res) { endGame(res.result, res.label); return true; }
  refreshStatus();
  return false;
}

function endGame(result, label) {
  state.gameOver = true;
  state.thinking = false;
  state.finalResult = result;   // 认输/超时等无法从局面推导，需记录
  state.finalLabel = label;
  stopClock();
  board.setInteractive(false);
  setStatus(`对局结束 · ${label}`, 'over');
  $('overTitle').textContent = '对局结束';
  $('overResult').innerHTML = `<div class="res-score">${result}</div><div class="res-label">${label}</div>`;
  $('overModal').classList.remove('hidden');
  $('overRematch').classList.toggle('hidden', state.mode !== 'online');
}

async function handleHumanMove({ from, to, promotion }) {
  if (state.mode === 'online') {
    // 本地已先行落子（乐观更新），同步给服务器
    online.move(from, to, promotion);
    board.setInteractive(false);
    if (afterAnyMove()) return;
    return;
  }
  if (afterAnyMove()) return;
  await computerTurn();
}

async function computerTurn() {
  if (state.gameOver || state.mode !== 'single') return;
  const c = board.getChess();
  if (c.turn === state.humanColor) return;
  state.thinking = true;
  board.setInteractive(false);
  refreshStatus();
  $('commentary').innerHTML = `<div class="think-loading"><span class="spinner"></span> 电脑正在推演（${LEVEL_LABEL[state.level]}）…</div>`;
  try {
    const r = await askEngine(c.fen(), state.level);
    if (state.gameOver) return;
    board.applyMove({ from: r.from, to: r.to, promotion: r.promotion });
    renderCommentary(r.exp, {
      san: r.san,
      depth: r.result && r.result.depth,
      nodes: r.result && r.result.nodes,
    });
    state.thinking = false;
    if (afterAnyMove()) return;
    board.setInteractive(true);
  } catch (err) {
    state.thinking = false;
    toast('引擎出错：' + err.message);
    board.setInteractive(true);
    refreshStatus();
  }
}

function newSingleGame() {
  state.gameOver = false;
  state.thinking = false;
  state.saved = false;
  state.finalResult = null; state.finalLabel = null;
  state.startedAt = Date.now();
  state.clock = { white: 0, black: 0, running: false, last: 0, timer: null };
  board.loadFen(undefined, { orientation: state.humanColor });
  board.setInteractive(true);
  $('commentary').innerHTML = '<div class="think-empty">每走一步，这里会展示电脑的<strong>思考过程</strong>：它为什么这样走、算到了什么、还有哪些备选方案。</div>';
  renderMoves(); renderCaptured(); renderClocks();
  startClock();
  refreshStatus();
  if (state.humanColor === BLACK) computerTurn();
}

// ---------- 联网对战 ----------
const online = new OnlineClient({
  handlers: {
    open: () => { if (state.online.matching) online.find(); },
    close: () => { if (state.mode === 'online' && state.online.active) toast('与服务器断开连接'); },
    auth_fail: () => { toast('请先登录再进行联网对战'); state.online.matching = false; updateOnlineUI(); },
    welcome: () => {},
    queued: () => { state.online.matching = true; updateOnlineUI(); refreshStatus(); },
    queue_cancelled: () => { state.online.matching = false; updateOnlineUI(); refreshStatus(); },
    match_start: (m) => {
      state.online = { color: m.color, opponent: m.opponent, roomId: m.roomId, matching: false, active: true };
      state.gameOver = false; state.saved = false;
      state.finalResult = null; state.finalLabel = null;
      state.startedAt = Date.now();
      state.clock = { white: 0, black: 0, running: false, last: 0, timer: null };
      board.loadFen(m.fen, { orientation: m.color });
      board.setInteractive(m.yourTurn);
      $('chatPanel').classList.remove('hidden');
      $('chatLog').innerHTML = '';
      $('commentary').innerHTML = `<div class="think-empty">联网对战中，对手：<strong>${m.opponent}</strong>。<br/>此模式不展示引擎思路，专注真人博弈。</div>`;
      renderMoves(); renderCaptured(); renderClocks();
      startClock();
      updateOnlineUI();
      refreshStatus();
      toast(`匹配成功！对手：${m.opponent}（你执${m.color === WHITE ? '白' : '黑'}）`);
    },
    move: (m) => {
      const c = board.getChess();
      // 自己的走子已在本地落过，无需重复
      if (m.mover === state.online.color) { board.setInteractive(false); refreshStatus(); return; }
      board.applyMove({ from: m.from, to: m.to, promotion: m.promotion });
      afterAnyMove();
      board.setInteractive(!state.gameOver && board.getChess().turn === state.online.color);
    },
    illegal: (m) => {
      toast('这步棋不合法，已回退');
      board.undoLast();
      renderMoves(); renderCaptured();
      board.setInteractive(true);
      refreshStatus();
    },
    error: (m) => toast(m.msg || '操作无效'),
    game_over: (m) => {
      state.online.active = false;
      endGame(m.result, m.reason || '对局结束');
    },
    draw_offer: () => {
      if (confirm('对手提议和棋，是否接受？')) online.acceptDraw();
      else online.declineDraw();
    },
    rematch_offer: () => {
      if (confirm('对手请求再战一局，是否同意？')) online.rematch();
    },
    chat: (m) => appendChat(m.from === state.online.color ? '我' : (state.online.opponent || '对手'), m.text),
    opponent_left: () => { toast('对手已离开'); state.online.active = false; },
  },
});

function appendChat(who, text) {
  const log = $('chatLog');
  const d = document.createElement('div');
  d.className = 'chat-msg';
  d.innerHTML = `<b>${who}</b>${String(text).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]))}`;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

function updateOnlineUI() {
  $('matchingTip').classList.toggle('hidden', !state.online.matching);
  $('findBtn').textContent = state.online.matching ? '取消匹配' : '寻找对手';
  $('findBtn').disabled = state.online.active;
}

// ---------- 模式切换 ----------
function switchMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('singleControls').classList.toggle('hidden', mode !== 'single');
  $('onlineControls').classList.toggle('hidden', mode !== 'online');
  $('chatPanel').classList.toggle('hidden', mode !== 'online' || !state.online.active);
  stopClock();
  if (mode === 'single') {
    if (state.online.active) { online.leave(); state.online.active = false; }
    newSingleGame();
  } else {
    state.gameOver = true;
    board.setInteractive(false);
    board.loadFen(undefined, { orientation: WHITE });
    renderMoves(); renderCaptured(); renderClocks();
    $('commentary').innerHTML = '<div class="think-empty">联网对战：点击「寻找对手」与真人玩家匹配。<br/>需要先登录账号。</div>';
    if (!account.token) toast('联网对战需要先登录');
    else online.connect();
    updateOnlineUI();
    refreshStatus();
  }
}

// ---------- 账号 ----------
function renderAccount() {
  const logged = !!account.token;
  $('userChip').classList.toggle('hidden', !logged);
  $('loginBtn').classList.toggle('hidden', logged);
  $('guestHint').classList.toggle('hidden', logged);
  $('gamesPanel').classList.toggle('hidden', !logged);
  if (logged) {
    $('userName').textContent = account.user || '玩家';
    loadGames();
  }
}

async function loadGames() {
  try {
    const games = await account.listGames();
    const box = $('gamesList');
    if (!games.length) { box.innerHTML = '<div class="empty-mini">还没有保存的棋谱</div>'; return; }
    box.innerHTML = games.map((g) => `
      <div class="game-item" data-id="${g.id}">
        <div class="gi-top"><span class="gi-res">${g.result || '*'}</span><span class="gi-opp">${escapeHtml(g.opponent || '')}</span></div>
        <div class="gi-meta">${new Date(g.createdAt).toLocaleString('zh-CN')} · ${g.mode === 'online' ? '联网' : '单机'}</div>
        <div class="gi-actions">
          <button class="btn tiny" data-act="replay">回放</button>
          <button class="btn tiny" data-act="pgn">导出PGN</button>
          <button class="btn tiny warn" data-act="del">删除</button>
        </div>
      </div>`).join('');
    box._games = games;
  } catch (e) { /* 未登录忽略 */ }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

async function saveCurrentGame() {
  if (!account.token) { toast('请先登录后再保存棋谱'); openAuth(); return; }
  const c = board.getChess();
  if (!c.sanHistory.length) { toast('还没有走子，无需保存'); return; }
  const res = c.gameResult();
  const opponent = state.mode === 'online'
    ? (state.online.opponent || '在线玩家')
    : `电脑 · ${LEVEL_LABEL[state.level]}`;
  try {
    await account.saveGame({
      opponent,
      mode: state.mode,
      result: state.finalResult || (res ? res.result : '*'),
      pgn: c.pgnMoves(),
      fen: c.fen(),
      moves: c.sanHistory.slice(),
      durationSec: Math.round((Date.now() - (state.startedAt || Date.now())) / 1000),
    });
    state.saved = true;
    toast('棋谱已保存到你的账号');
    loadGames();
  } catch (e) { toast('保存失败：' + e.message); }
}

function openAuth() { $('authModal').classList.remove('hidden'); $('authError').textContent = ''; }

// ---------- 回放 ----------
let replay = null;
function startReplay(game) {
  switchMode('single');
  state.gameOver = true;
  board.setInteractive(false);
  stopClock();
  board.loadFen(undefined, { orientation: WHITE });
  replay = { moves: game.moves || [], idx: 0 };
  $('commentary').innerHTML = `
    <div class="c-head"><div class="c-headline">棋谱回放 · ${escapeHtml(game.opponent || '')}</div></div>
    <div class="replay-ctrl">
      <button class="btn tiny" id="rpPrev">◀ 上一步</button>
      <span id="rpPos">0 / ${replay.moves.length}</span>
      <button class="btn tiny" id="rpNext">下一步 ▶</button>
      <button class="btn tiny" id="rpAuto">自动播放</button>
    </div>`;
  $('rpNext').onclick = () => stepReplay(1);
  $('rpPrev').onclick = () => stepReplay(-1);
  $('rpAuto').onclick = autoReplay;
  renderMoves(); renderCaptured();
  setStatus('棋谱回放模式');
}
function stepReplay(dir) {
  if (!replay) return;
  if (dir > 0 && replay.idx < replay.moves.length) {
    board.getChess().move(replay.moves[replay.idx]);
    replay.idx++;
  } else if (dir < 0 && replay.idx > 0) {
    board.getChess().undo();
    replay.idx--;
  }
  board.lastMove = null;
  board.legalCache = null;
  board.render();
  renderMoves(); renderCaptured();
  const pos = $('rpPos'); if (pos) pos.textContent = `${replay.idx} / ${replay.moves.length}`;
}
function autoReplay() {
  if (replay._timer) { clearInterval(replay._timer); replay._timer = null; return; }
  replay._timer = setInterval(() => {
    if (!replay || replay.idx >= replay.moves.length) { clearInterval(replay._timer); replay._timer = null; return; }
    stepReplay(1);
  }, 800);
}

// ---------- 事件绑定 ----------
$('modeNav').addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (btn) switchMode(btn.dataset.mode);
});

$('levelSelect').addEventListener('change', (e) => {
  state.level = e.target.value;
  toast(`电脑难度：${LEVEL_LABEL[state.level]}`);
});
$('sideSelect').addEventListener('change', (e) => {
  state.humanColor = e.target.value === 'black' ? BLACK : WHITE;
  newSingleGame();
});

$('newGameBtn').onclick = () => {
  if (state.mode === 'single') newSingleGame();
  else { if (state.online.active) online.leave(); state.online.active = false; switchMode('online'); }
};
$('flipBtn').onclick = () => board.flip();
$('undoBtn').onclick = () => {
  if (state.mode !== 'single') { toast('联网对战不支持悔棋'); return; }
  if (state.thinking) { toast('电脑思考中，请稍候'); return; }
  const c = board.getChess();
  // 撤销一整回合（电脑 + 自己）
  let n = 0;
  while (n < 2 && c.sanHistory.length > 0) { board.undoLast(); n++; if (c.turn === state.humanColor) break; }
  state.gameOver = false;
  board.setInteractive(true);
  $('overModal').classList.add('hidden');
  renderMoves(); renderCaptured();
  refreshStatus();
};
$('resignBtn').onclick = () => {
  if (state.gameOver) return;
  if (!confirm('确定认输吗？')) return;
  if (state.mode === 'online' && state.online.active) { online.resign(); return; }
  const loser = state.humanColor;
  endGame(loser === WHITE ? '0-1' : '1-0', '你认输了');
};
$('saveBtn').onclick = saveCurrentGame;
$('overSave').onclick = () => { saveCurrentGame(); $('overModal').classList.add('hidden'); };
$('overNew').onclick = () => { $('overModal').classList.add('hidden'); state.mode === 'single' ? newSingleGame() : switchMode('online'); };
$('overRematch').onclick = () => { online.rematch(); $('overModal').classList.add('hidden'); toast('已发送再战请求'); };

$('findBtn').onclick = () => {
  if (!account.token) { toast('联网对战需要先登录'); openAuth(); return; }
  online.connect();
  if (state.online.matching) { online.cancel(); state.online.matching = false; }
  else { state.online.matching = true; online.find(); }
  updateOnlineUI(); refreshStatus();
};

$('chatSend').onclick = () => {
  const v = $('chatInput').value.trim();
  if (!v) return;
  online.chat(v); appendChat('我', v); $('chatInput').value = '';
};
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('chatSend').click(); });

// 账号弹窗
$('loginBtn').onclick = openAuth;
$('logoutBtn').onclick = async () => { await account.logout(); renderAccount(); toast('已退出登录'); };
document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    const mode = t.dataset.auth;
    $('authTitle').textContent = mode === 'login' ? '登录' : '注册';
    $('authSubmit').textContent = mode === 'login' ? '登录' : '注册并登录';
    $('authError').textContent = '';
  };
});
$('authSubmit').onclick = async () => {
  const mode = document.querySelector('.tab.active').dataset.auth;
  const u = $('authUser').value.trim();
  const p = $('authPass').value;
  if (u.length < 2 || p.length < 4) { $('authError').textContent = '用户名至少2位，密码至少4位'; return; }
  try {
    if (mode === 'register') await account.register(u, p);
    await account.login(u, p);
    $('authModal').classList.add('hidden');
    $('authUser').value = ''; $('authPass').value = '';
    renderAccount();
    toast(`欢迎，${account.user}`);
    if (state.mode === 'online') online.connect();
  } catch (e) { $('authError').textContent = e.message; }
};

// 棋谱列表操作
$('gamesList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const item = btn.closest('.game-item');
  const id = item.dataset.id;
  const games = $('gamesList')._games || [];
  const game = games.find((g) => String(g.id) === String(id));
  if (!game) return;
  const act = btn.dataset.act;
  if (act === 'del') {
    if (!confirm('删除这份棋谱？')) return;
    await account.deleteGame(id); loadGames(); toast('已删除');
  } else if (act === 'pgn') {
    const pgn = `[Event "Chess Arena"]\n[Date "${new Date(game.createdAt).toISOString().slice(0, 10).replace(/-/g, '.')}"]\n[White "${game.mode === 'online' ? account.user : (state.humanColor === WHITE ? account.user : game.opponent)}"]\n[Black "${game.opponent}"]\n[Result "${game.result}"]\n\n${game.pgn} ${game.result}\n`;
    const blob = new Blob([pgn], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `game-${id}.pgn`;
    a.click();
    URL.revokeObjectURL(a.href);
  } else if (act === 'replay') {
    startReplay(game);
  }
});

// 关闭弹窗（点遮罩）
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('click', (e) => { if (e.target === m && m.id !== 'promoModal') m.classList.add('hidden'); });
});

// ---------- 启动 ----------
renderAccount();
switchMode('single');

// 调试句柄：便于自动化测试与问题排查（只读引用，不影响正常流程）
window.__chessArena = {
  state, board, account,
  /** 从任意 FEN 开始一局单机对战（测试/残局练习用） */
  setPosition(fen, { humanColor = WHITE } = {}) {
    state.mode = 'single';
    state.humanColor = humanColor;
    state.gameOver = false;
    state.thinking = false;
    state.finalResult = null; state.finalLabel = null;
    state.startedAt = Date.now();
    board.loadFen(fen, { orientation: humanColor });
    board.setInteractive(true);
    renderMoves(); renderCaptured(); renderClocks();
    refreshStatus();
  },
  refreshStatus, renderMoves, renderCaptured,
};
