/**
 * 账号 + 棋谱存储。
 *  - 配置了 SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 时，使用 Supabase(Postgres) 持久化（云端部署）。
 *  - 否则降级为本地 JSON 文件（data/users.json, data/games.json），方便本地开发。
 * 对外接口保持不变（均为 async），server/index.js 与 server/play.js 仅需在调用处 await。
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const USERS_FILE = join(DATA_DIR, 'users.json');
const GAMES_FILE = join(DATA_DIR, 'games.json');

// ---------- Supabase 开关 ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const USE_DB = Boolean(SUPABASE_URL && SUPABASE_KEY);

let supabase = null;
if (USE_DB) {
  const { createClient } = await import('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  console.log('♟  存储后端：Supabase (Postgres)');
} else {
  console.log('♟  存储后端：本地 JSON 文件（未配置 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）');
}

// 启动自检：确认 Supabase 表存在
export async function initStore() {
  if (!USE_DB) return;
  try {
    const { error } = await supabase.from('users').select('username', { count: 'exact', head: true });
    if (error && /relation .* does not exist/i.test(error.message)) {
      console.warn('\n⚠️  未找到 Supabase 表，请在 Supabase 控制台 SQL Editor 运行仓库内 supabase/schema.sql 完成初始化。\n');
    } else if (error) {
      console.warn('\n⚠️  Supabase 连接异常：', error.message, '\n');
    } else {
      console.log('♟  Supabase 表检测正常');
    }
  } catch (e) {
    console.warn('\n⚠️  Supabase 初始化检查失败：', e.message, '\n');
  }
}

// ---------- 密码哈希 ----------
function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

// ---------- JSON 降级实现 ----------
function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}
function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  ensureDir();
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function jsonUsers() {
  return readJson(USERS_FILE, { users: [], tokens: {} });
}
function jsonGames() {
  return readJson(GAMES_FILE, { games: [] });
}

// ---------- 账号 ----------
export async function registerUser(username, password) {
  username = (username || '').trim();
  if (username.length < 2) throw new Error('用户名至少 2 个字符');
  if (password.length < 4) throw new Error('密码至少 4 个字符');

  if (USE_DB) {
    const { data: exist } = await supabase.from('users').select('username').eq('username', username).maybeSingle();
    if (exist) throw new Error('用户名已存在');
    const salt = randomBytes(16).toString('hex');
    const { error } = await supabase.from('users').insert({
      username, salt, hash: hashPassword(password, salt), created_at: Date.now(),
    });
    if (error) throw new Error('注册失败：' + error.message);
    return username;
  }

  const db = jsonUsers();
  if (db.users.some((u) => u.username === username)) throw new Error('用户名已存在');
  const salt = randomBytes(16).toString('hex');
  db.users.push({ username, salt, hash: hashPassword(password, salt), createdAt: Date.now() });
  writeJson(USERS_FILE, db);
  return username;
}

export async function loginUser(username, password) {
  if (USE_DB) {
    const { data: user } = await supabase.from('users').select('username, salt, hash').eq('username', username).maybeSingle();
    if (!user) throw new Error('用户名或密码错误');
    const candidate = scryptSync(password, user.salt, 64);
    const expected = Buffer.from(user.hash, 'hex');
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      throw new Error('用户名或密码错误');
    }
    const token = randomBytes(24).toString('hex');
    const { error } = await supabase.from('tokens').insert({ token, username });
    if (error) throw new Error('登录失败：' + error.message);
    return token;
  }

  const db = jsonUsers();
  const user = db.users.find((u) => u.username === username);
  if (!user) throw new Error('用户名或密码错误');
  const candidate = scryptSync(password, user.salt, 64);
  const expected = Buffer.from(user.hash, 'hex');
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    throw new Error('用户名或密码错误');
  }
  const token = randomBytes(24).toString('hex');
  db.tokens[token] = username;
  writeJson(USERS_FILE, db);
  return token;
}

export async function getUserByToken(token) {
  if (!token) return null;
  if (USE_DB) {
    try {
      const { data } = await supabase.from('tokens').select('username').eq('token', token).maybeSingle();
      return data ? { username: data.username } : null;
    } catch (e) {
      console.warn('⚠️  token 校验异常：', e.message);
      return null;
    }
  }
  const db = jsonUsers();
  const username = db.tokens[token];
  return username ? { username } : null;
}

export async function logoutToken(token) {
  if (USE_DB) {
    await supabase.from('tokens').delete().eq('token', token);
    return;
  }
  const db = jsonUsers();
  if (db.tokens[token]) {
    delete db.tokens[token];
    writeJson(USERS_FILE, db);
  }
}

// ---------- 棋谱 ----------
function mapGame(r) {
  return {
    id: r.id,
    username: r.username,
    opponent: r.opponent,
    mode: r.mode,
    result: r.result,
    pgn: r.pgn,
    fen: r.fen,
    moves: r.moves || [],
    durationSec: r.duration_sec,
    raw: r.raw,
    createdAt: r.created_at,
  };
}

export async function saveGame({ username, opponent, mode, result, pgn, fen, moves, durationSec, raw }) {
  if (!username) throw new Error('未登录，无法保存棋谱');
  const id = randomBytes(8).toString('hex');
  const game = {
    id,
    username,
    opponent: opponent || '—',
    mode: mode || 'single',
    result: result || '*',
    pgn: pgn || '',
    fen: fen || '',
    moves: Array.isArray(moves) ? moves : [],
    duration_sec: durationSec || 0,
    raw: raw || '',
    created_at: Date.now(),
  };

  if (USE_DB) {
    const { error } = await supabase.from('games').insert(game);
    if (error) throw new Error('保存棋谱失败：' + error.message);
    return mapGame(game);
  }

  const db = jsonGames();
  const record = { ...mapGame(game) };
  db.games.unshift(record);
  writeJson(GAMES_FILE, db);
  return record;
}

export async function listGames(username) {
  if (USE_DB) {
    const { data, error } = await supabase
      .from('games').select('*').eq('username', username).order('created_at', { ascending: false });
    if (error) throw new Error('读取棋谱失败：' + error.message);
    return (data || []).map(mapGame);
  }
  return jsonGames().games
    .filter((g) => g.username === username)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getGame(id, username) {
  if (USE_DB) {
    const { data } = await supabase.from('games').select('*').eq('id', id).eq('username', username).maybeSingle();
    return data ? mapGame(data) : null;
  }
  return jsonGames().games.find((g) => g.id === id && g.username === username) || null;
}

export async function deleteGame(id, username) {
  if (USE_DB) {
    const { error, count } = await supabase.from('games').delete({ count: 'exact' }).eq('id', id).eq('username', username);
    if (error) throw new Error('删除棋谱失败：' + error.message);
    return (count || 0) > 0;
  }
  const db = jsonGames();
  const idx = db.games.findIndex((g) => g.id === id && g.username === username);
  if (idx >= 0) {
    db.games.splice(idx, 1);
    writeJson(GAMES_FILE, db);
    return true;
  }
  return false;
}
