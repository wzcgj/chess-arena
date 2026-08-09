/**
 * 联网对战：基于 WebSocket 的匹配 + 权威走子校验 + 状态广播。
 * 服务端用 chess.js 引擎校验每一步是否合法，并判定终局，保证两边一致。
 */
import { randomBytes } from 'crypto';
import {
  Chess, START_FEN, SQ, WHITE, BLACK,
  QUEEN, ROOK, BISHOP, KNIGHT, FLAG_PROMOTION,
  moveFrom, moveTo, moveFlags, movePromo,
} from '../public/js/core/chess.js';

const PROMO_MAP = { q: QUEEN, r: ROOK, b: BISHOP, n: KNIGHT };

const rooms = new Map();      // roomId -> room
const queue = [];             // 等待匹配的 ws 列表

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}
function sendTo(ws, obj) { send(ws, obj); }

function applyMoveFromSquares(chess, fromSq, toSq, promo) {
  const from = SQ[fromSq];
  const to = SQ[toSq];
  if (from === undefined || to === undefined) return null;
  const want = promo ? PROMO_MAP[promo] : 0;
  for (const m of chess.generateMoves()) {
    if (moveFrom(m) === from && moveTo(m) === to) {
      if (moveFlags(m) & FLAG_PROMOTION) {
        if (want && movePromo(m) === want) return m;
        if (!want) return m; // 客户端没指定则默认升后
      } else if (!want) {
        return m;
      }
    }
  }
  return null;
}

function tryMatch() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    if (a.readyState !== 1 || b.readyState !== 1) continue;
    createRoom(a, b);
  }
}

function createRoom(a, b) {
  const roomId = randomBytes(6).toString('hex');
  const aWhite = Math.random() < 0.5;
  const chess = new Chess();
  const room = {
    id: roomId,
    chess,
    players: {},
    drawOfferFrom: null,
    rematchWant: new Set(),
    over: false,
    startTime: Date.now(),
    moves: [],
  };
  rooms.set(roomId, room);

  a.meta.roomId = roomId; a.meta.color = aWhite ? WHITE : BLACK; a.meta.inRoom = true;
  b.meta.roomId = roomId; b.meta.color = aWhite ? BLACK : WHITE; b.meta.inRoom = true;
  room.players[aWhite ? 'white' : 'black'] = a;
  room.players[aWhite ? 'black' : 'white'] = b;

  send(a, {
    type: 'match_start', roomId, color: a.meta.color, opponent: b.meta.user.username,
    fen: chess.fen(), yourTurn: chess.turn === a.meta.color, start: true,
  });
  send(b, {
    type: 'match_start', roomId, color: b.meta.color, opponent: a.meta.user.username,
    fen: chess.fen(), yourTurn: chess.turn === b.meta.color, start: true,
  });
}

function opponentOf(room, ws) {
  return room.players.white === ws ? room.players.black : room.players.white;
}

function finishGame(room, { winner, reason }) {
  if (room.over) return;
  room.over = true;
  const res = room.chess.gameResult();
  const result = res ? res.result : (winner === null ? '1/2-1/2' : (winner === WHITE ? '1-0' : '0-1'));
  const movetext = room.chess.pgnMoves();
  const pgnText = `[Event "Online"]\n[Site "Chess Arena"]\n[Result "${result}"]\n\n${movetext} ${result}\n`;
  for (const side of ['white', 'black']) {
    const ws = room.players[side];
    if (ws) send(ws, {
      type: 'game_over', result,
      reason: res ? res.label : (reason || ''),
      winner, pgn: movetext, raw: pgnText, fen: room.chess.fen(),
    });
  }
}

function handleMove(ws, msg) {
  const room = rooms.get(ws.meta.roomId);
  if (!room || room.over) return;
  if (room.chess.turn !== ws.meta.color) { send(ws, { type: 'error', msg: '还没轮到你' }); return; }
  const m = applyMoveFromSquares(room.chess, msg.from, msg.to, msg.promotion || null);
  if (m === null) { send(ws, { type: 'illegal', from: msg.from, to: msg.to }); return; }
  const detail = room.chess.describeMove(m);
  room.chess.makeMove(m);
  room.chess.sanHistory.push(detail.san);  // 维护 SAN 历史，供 pgnMoves() 生成棋谱
  room.moves.push(detail.san);
  room.drawOfferFrom = null; // 走子后取消和棋提议

  const turn = room.chess.turn;
  const payload = {
    type: 'move', from: msg.from, to: msg.to, san: detail.san,
    fen: room.chess.fen(), mover: ws.meta.color, turn, moveNo: room.moves.length,
  };
  send(room.players.white, payload);
  send(room.players.black, payload);

  const res = room.chess.gameResult();
  if (res) {
    finishGame(room, { winner: res.winner, reason: res.label });
  }
}

export function setupPlay(wss, { authenticate }) {
  wss.on('connection', async (ws, req) => {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const token = params.get('token');
    const user = authenticate ? await authenticate(token) : null;
    if (!user) { send(ws, { type: 'auth_fail' }); try { ws.close(); } catch {} return; }
    ws.meta = { user, roomId: null, color: null, inRoom: false, queued: false };

    send(ws, { type: 'welcome', username: user.username });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      switch (msg.type) {
        case 'find': {
          if (ws.meta.inRoom) break;
          if (ws.meta.queued) break;
          ws.meta.queued = true;
          queue.push(ws);
          send(ws, { type: 'queued' });
          tryMatch();
          break;
        }
        case 'cancel': {
          ws.meta.queued = false;
          const i = queue.indexOf(ws);
          if (i >= 0) queue.splice(i, 1);
          send(ws, { type: 'queue_cancelled' });
          break;
        }
        case 'move': handleMove(ws, msg); break;
        case 'resign': {
          const room = rooms.get(ws.meta.roomId);
          if (!room || room.over) break;
          finishGame(room, { winner: room.chess.turn === WHITE ? BLACK : WHITE, reason: '对方认输' });
          break;
        }
        case 'draw_offer': {
          const room = rooms.get(ws.meta.roomId);
          if (!room || room.over) break;
          room.drawOfferFrom = ws.meta.color;
          send(opponentOf(room, ws), { type: 'draw_offer', from: ws.meta.color });
          break;
        }
        case 'draw_accept': {
          const room = rooms.get(ws.meta.roomId);
          if (!room || room.over) break;
          if (room.drawOfferFrom !== null && room.drawOfferFrom !== ws.meta.color) {
            finishGame(room, { winner: null, reason: '双方同意和棋' });
          }
          break;
        }
        case 'draw_decline': {
          const room = rooms.get(ws.meta.roomId);
          if (!room || room.over) break;
          room.drawOfferFrom = null;
          send(opponentOf(room, ws), { type: 'draw_declined' });
          break;
        }
        case 'rematch': {
          const room = rooms.get(ws.meta.roomId);
          if (!room) break;
          room.rematchWant.add(ws.meta.color);
          const opp = opponentOf(room, ws);
          if (room.rematchWant.has(opp.meta.color)) {
            // 双方都想要，重新开局
            const a = room.players.white, b = room.players.black;
            a.meta.inRoom = false; b.meta.inRoom = false;
            rooms.delete(room.id);
            createRoom(a, b);
          } else {
            send(opp, { type: 'rematch_offer', from: ws.meta.color });
          }
          break;
        }
        case 'chat': {
          const room = rooms.get(ws.meta.roomId);
          if (!room) break;
          send(opponentOf(room, ws), { type: 'chat', from: ws.meta.color, text: String(msg.text || '').slice(0, 400) });
          break;
        }
        case 'leave': {
          const room = rooms.get(ws.meta.roomId);
          if (room && !room.over) {
            send(opponentOf(room, ws), { type: 'opponent_left' });
          }
          break;
        }
        default: break;
      }
    });

    ws.on('close', () => {
      ws.meta.queued = false;
      const i = queue.indexOf(ws);
      if (i >= 0) queue.splice(i, 1);
      const room = rooms.get(ws.meta.roomId);
      if (room && !room.over) {
        send(opponentOf(room, ws), { type: 'opponent_left' });
        room.over = true;
      }
    });
  });
}
