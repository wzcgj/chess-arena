/**
 * 服务入口：
 *  - Express 提供静态前端（public/）与 REST API（账号 / 棋谱）
 *  - WebSocket（/ws）提供联网对战（匹配 + 权威走子校验 + 状态广播）
 */
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import express from 'express';
import { WebSocketServer } from 'ws';
import {
  registerUser, loginUser, getUserByToken, logoutToken,
  saveGame, listGames, getGame, deleteGame, initStore,
} from './store.js';
import { setupPlay } from './play.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '2mb' }));

// 静态前端
app.use(express.static(PUBLIC_DIR));

// ---- 鉴权中间件 ----
async function auth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  try {
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: '未登录或登录已失效' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: '未登录或登录已失效' });
  }
}

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, code, msg) => res.status(code).json({ ok: false, error: msg });

// ---- REST API ----
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    await registerUser(username, password);
    ok(res, {});
  } catch (e) { fail(res, 400, e.message); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const token = await loginUser(username, password);
    ok(res, { token, username });
  } catch (e) { fail(res, 401, e.message); }
});

app.post('/api/logout', auth, async (req, res) => {
  const token = req.headers.authorization.slice(7);
  await logoutToken(token);
  ok(res, {});
});

app.get('/api/me', auth, (req, res) => ok(res, { username: req.user.username }));

app.get('/api/games', auth, async (req, res) => {
  try {
    ok(res, { games: await listGames(req.user.username) });
  } catch (e) { fail(res, 500, e.message); }
});

app.post('/api/games', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const game = await saveGame({ username: req.user.username, ...body });
    ok(res, { game });
  } catch (e) { fail(res, 400, e.message); }
});

app.get('/api/games/:id', auth, async (req, res) => {
  try {
    const g = await getGame(req.params.id, req.user.username);
    if (!g) return fail(res, 404, '棋谱不存在');
    ok(res, { game: g });
  } catch (e) { fail(res, 500, e.message); }
});

app.delete('/api/games/:id', auth, async (req, res) => {
  try {
    const removed = await deleteGame(req.params.id, req.user.username);
    if (!removed) return fail(res, 404, '棋谱不存在');
    ok(res, {});
  } catch (e) { fail(res, 500, e.message); }
});

// 兜底：前端路由（SPA）回退到 index.html
app.get('*', (req, res) => {
  const idx = join(PUBLIC_DIR, 'index.html');
  if (existsSync(idx)) res.sendFile(idx);
  else res.status(404).send('前端未构建');
});

// ---- 启动 HTTP + WebSocket ----
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
setupPlay(wss, { authenticate: getUserByToken });

server.listen(PORT, async () => {
  console.log(`♟  国际象棋平台已启动： http://localhost:${PORT}`);
  console.log(`   WebSocket 对战端点： ws://localhost:${PORT}/ws`);
  await initStore();
});

export { app, server };
