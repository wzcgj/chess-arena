// 账号（REST）与联网对战（WebSocket）客户端。

const TOKEN_KEY = 'ca_token';
const USER_KEY = 'ca_user';

async function req(path, { method = 'GET', body } = {}) {
  const token = account.token;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
  return data;
}

export const account = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: localStorage.getItem(USER_KEY) || null,
  setSession(token, user) {
    this.token = token; this.user = user;
    if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
    if (user) localStorage.setItem(USER_KEY, user); else localStorage.removeItem(USER_KEY);
  },
  async register(username, password) {
    const d = await req('/api/register', { method: 'POST', body: { username, password } });
    return d.ok;
  },
  async login(username, password) {
    const d = await req('/api/login', { method: 'POST', body: { username, password } });
    this.setSession(d.token, d.username);
    return d;
  },
  async logout() {
    try { await req('/api/logout', { method: 'POST' }); } catch {}
    this.setSession(null, null);
  },
  async listGames() {
    const d = await req('/api/games');
    return d.games || [];
  },
  async saveGame(payload) {
    const d = await req('/api/games', { method: 'POST', body: payload });
    return d.game;
  },
  async deleteGame(id) {
    return req('/api/games/' + id, { method: 'DELETE' });
  },
};

export class OnlineClient {
  constructor({ handlers }) {
    this.handlers = handlers || {};
    this.ws = null;
    this.connected = false;
  }
  connect() {
    if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === 0)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(account.token || '')}`);
    this.ws = ws;
    ws.onopen = () => { this.connected = true; this._emit('open'); };
    ws.onclose = () => { this.connected = false; this._emit('close'); };
    ws.onerror = () => { this._emit('error'); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      this._emit(m.type, m);
    };
  }
  _emit(type, m) { const h = this.handlers[type]; if (h) h(m || {}); }
  _send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  find() { this._send({ type: 'find' }); }
  cancel() { this._send({ type: 'cancel' }); }
  move(from, to, promotion) { this._send({ type: 'move', from, to, promotion: promotion || null }); }
  resign() { this._send({ type: 'resign' }); }
  offerDraw() { this._send({ type: 'draw_offer' }); }
  acceptDraw() { this._send({ type: 'draw_accept' }); }
  declineDraw() { this._send({ type: 'draw_decline' }); }
  rematch() { this._send({ type: 'rematch' }); }
  chat(text) { this._send({ type: 'chat', text }); }
  leave() { this._send({ type: 'leave' }); }
  close() { if (this.ws) this.ws.close(); }
}
