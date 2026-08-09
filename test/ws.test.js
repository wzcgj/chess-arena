/**
 * 联网对战 WebSocket 验证：双客户端匹配 + 权威走子校验 + 状态广播
 * 运行：node test/ws.test.js  （需先启动 server/index.js）
 */
import { WebSocket } from 'ws';
import { registerUser, loginUser } from '../server/store.js';

const URL = 'ws://localhost:3000/ws';
let token;
try { registerUser('wsbot', 'wsbot123'); } catch { /* 已存在 */ }
token = loginUser('wsbot', 'wsbot123');

function client() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URL}?token=${token}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
function waitMsg(ws, type, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting: ' + type)), timeout);
    const h = (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === type) { clearTimeout(t); ws.off('message', h); resolve(m); }
    };
    ws.on('message', h);
  });
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name); fail++; }
}

async function main() {
  const c1 = await client();
  const c2 = await client();
  c1.send(JSON.stringify({ type: 'find' }));
  c2.send(JSON.stringify({ type: 'find' }));

  const [s1, s2] = await Promise.all([waitMsg(c1, 'match_start'), waitMsg(c2, 'match_start')]);
  check('双方收到 match_start', !!s1.roomId && !!s2.roomId);
  check('双方颜色相反', s1.color !== s2.color);

  const white = s1.color === 0 ? c1 : c2;
  const black = s1.color === 0 ? c2 : c1;

  // 白方走 e2-e4，双方都应收到 move
  const bothMove = Promise.all([waitMsg(c1, 'move'), waitMsg(c2, 'move')]);
  white.send(JSON.stringify({ type: 'move', from: 'e2', to: 'e4' }));
  const [m1, m2] = await bothMove;
  check('白方 e2-e4 被接受', m1.san === 'e4' && m2.san === 'e4');
  check('广播后轮到黑方', m1.turn === 1);

  // 白方再次走子（非其回合）应被拒
  const errP = waitMsg(white, 'error', 2000).then(() => true).catch(() => false);
  white.send(JSON.stringify({ type: 'move', from: 'e7', to: 'e5' }));
  check('非己方回合的走子被拒绝', await errP);

  // 黑方走非法着（兵 e7-e5 合法，测试一个非法：马 b8-a8 不存在）应收到 illegal
  const illP = waitMsg(black, 'illegal', 2000).then(() => true).catch(() => false);
  black.send(JSON.stringify({ type: 'move', from: 'b8', to: 'a8' }));
  check('非法着被服务器拒绝', await illP);

  // 黑方认输，双方收到 game_over
  const overP = Promise.all([waitMsg(c1, 'game_over'), waitMsg(c2, 'game_over')]);
  black.send(JSON.stringify({ type: 'resign' }));
  const [o1, o2] = await overP;
  check('认输后双方收到 game_over', o1.result === '1-0' && o2.result === '1-0');

  c1.close(); c2.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
