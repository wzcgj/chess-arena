// 联网对战端到端测试：真实 Chrome 开两个标签页，两个账号互相匹配对弈。
// 覆盖：注册/登录 → WS 连接 → 匹配 → 双向同步走子 → 认输 → 棋谱保存。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const URL_APP = process.env.APP_URL || 'http://localhost:3000';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9334;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ' → ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Browser {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.id = 0;
    this.waiting = new Map();
    this.ready = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && this.waiting.has(m.id)) {
        const { resolve, reject } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 30000);
    });
  }
  async newPage(url) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Page.navigate', { url });
    return page;
  }
  close() { try { this.ws.close(); } catch {} }
}

class Page {
  constructor(browser, sessionId) { this.b = browser; this.sid = sessionId; }
  send(method, params) { return this.b.send(method, params, this.sid); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }
  /** 通过页面内 UI 点击落子 */
  clickMove(from, to) {
    return this.eval(`(() => {
      const el = (s) => document.querySelector('#board .square[data-sq="' + s + '"]');
      const click = (s) => { const t = el(s); const r = t.getBoundingClientRect();
        const o = { bubbles: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2, pointerId: 1 };
        t.dispatchEvent(new PointerEvent('pointerdown', o));
        t.dispatchEvent(new PointerEvent('pointerup', o)); };
      click('${from}'); click('${to}');
      return true;
    })()`);
  }
  fen() { return this.eval(`document.querySelectorAll('#moveList li').length`); }
  moves() { return this.eval(`[...document.querySelectorAll('#moveList .mv')].map(x=>x.textContent).filter(Boolean).join(' ')`); }
}

async function waitFor(fn, ms = 15000, step = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

async function main() {
  console.log('\n\x1b[1m联网对战端到端测试（双标签页）\x1b[0m');
  const profile = mkdtempSync(join(tmpdir(), 'chess-online-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--remote-allow-origins=*', '--no-sandbox', '--disable-setuid-sandbox',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-component-extensions-with-background-pages', '--disable-background-networking',
    '--disable-gpu', '--window-size=1400,1000', 'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      version = await r.json(); break;
    } catch { await sleep(250); }
  }
  if (!version) { console.log('  ✗ Chrome 启动失败'); process.exit(1); }
  console.log(`  · ${version.Browser}\n`);

  const br = new Browser(version.webSocketDebuggerUrl);
  await br.ready;

  const stamp = Date.now().toString(36);
  const userA = `alice_${stamp}`;
  const userB = `bob_${stamp}`;

  const pA = await br.newPage(URL_APP);
  const pB = await br.newPage(URL_APP);
  await sleep(2500);

  // ---- 1. 两个页面各自注册并登录 ----
  const doLogin = async (p, u) => p.eval(`(async () => {
    const m = await import('/js/net.js');
    await m.account.register('${u}', 'pw12345');
    await m.account.login('${u}', 'pw12345');
    return m.account.user;
  })()`);
  const nameA = await doLogin(pA, userA);
  const nameB = await doLogin(pB, userB);
  ok('两个账号注册并登录成功', nameA === userA && nameB === userB, `${nameA} / ${nameB}`);

  // 刷新让页面读取登录态
  await pA.send('Page.navigate', { url: URL_APP });
  await pB.send('Page.navigate', { url: URL_APP });
  await sleep(2500);

  const loggedA = await pA.eval(`!document.getElementById('userChip').classList.contains('hidden')`);
  ok('登录态在界面上生效', loggedA, String(loggedA));

  // ---- 2. 切到联网模式并开始匹配 ----
  const goOnline = async (p) => {
    await p.eval(`document.querySelector('.mode-btn[data-mode="online"]').click()`);
    await sleep(600);
    await p.eval(`document.getElementById('findBtn').click()`);
  };
  await goOnline(pA);
  await sleep(400);
  await goOnline(pB);

  // ---- 3. 等待匹配成功 ----
  const matchedA = await waitFor(() => pA.eval(`!!(window.__dbg_matched ?? (document.getElementById('chatPanel') && !document.getElementById('chatPanel').classList.contains('hidden')))`), 15000);
  const matchedB = await waitFor(() => pB.eval(`!document.getElementById('chatPanel').classList.contains('hidden')`), 15000);
  ok('两个玩家匹配成功进入对局', !!matchedA && !!matchedB, `A=${matchedA} B=${matchedB}`);

  // ---- 4. 判定谁执白 ----
  const colorOf = (p) => p.eval(`(() => {
    const s = document.getElementById('statusBanner').textContent;
    const w = document.getElementById('clockWhite').classList.contains('active');
    return { status: s, whiteActive: w,
             interactive: !document.getElementById('board').classList.contains('disabled') };
  })()`);
  const cA = await colorOf(pA);
  const cB = await colorOf(pB);
  const whitePage = cA.interactive ? pA : pB;
  const blackPage = cA.interactive ? pB : pA;
  ok('恰好一方可以先走（白方）', cA.interactive !== cB.interactive,
    `A.interactive=${cA.interactive} B.interactive=${cB.interactive}`);

  // ---- 5. 白方走 e2-e4，双方同步 ----
  await whitePage.clickMove('e2', 'e4');
  const syncedBlack = await waitFor(async () => {
    const mv = await blackPage.moves();
    return mv.includes('e4') ? mv : null;
  }, 10000);
  ok('白方 e2-e4 同步到黑方页面', !!syncedBlack, syncedBlack || '(超时)');

  const blackCanMove = await waitFor(() => blackPage.eval(`!document.getElementById('board').classList.contains('disabled')`), 6000);
  ok('轮到黑方且可交互', !!blackCanMove);

  // ---- 6. 黑方走 e7-e5 ----
  await blackPage.clickMove('e7', 'e5');
  const syncedWhite = await waitFor(async () => {
    const mv = await whitePage.moves();
    return mv.includes('e5') ? mv : null;
  }, 10000);
  ok('黑方 e7-e5 同步到白方页面', !!syncedWhite, syncedWhite || '(超时)');

  // ---- 7. 聊天 ----
  await whitePage.eval(`(()=>{document.getElementById('chatInput').value='你好，手下留情'; document.getElementById('chatSend').click(); return true})()`);
  const chatGot = await waitFor(() => blackPage.eval(`document.getElementById('chatLog').textContent.includes('手下留情')`), 6000);
  ok('对局聊天送达对手', !!chatGot);

  // ---- 8. 白方认输 → 双方结束 ----
  await whitePage.eval(`window.confirm = () => true; document.getElementById('resignBtn').click(); true`);
  const overW = await waitFor(() => whitePage.eval(`!document.getElementById('overModal').classList.contains('hidden')`), 8000);
  const overB = await waitFor(() => blackPage.eval(`!document.getElementById('overModal').classList.contains('hidden')`), 8000);
  ok('认输后双方弹出结束对话框', !!overW && !!overB, `W=${overW} B=${overB}`);

  const resultText = await blackPage.eval(`document.getElementById('overResult').textContent`);
  ok('结束结果标注正确（黑方胜）', /0-1/.test(resultText), resultText);

  // ---- 9. 保存棋谱到账号 ----
  await blackPage.eval(`document.getElementById('overSave').click(); true`);
  await sleep(1200);
  const saved = await blackPage.eval(`(async () => {
    const m = await import('/js/net.js');
    const gs = await m.account.listGames();
    return gs.length ? { n: gs.length, pgn: gs[0].pgn, result: gs[0].result, mode: gs[0].mode, opp: gs[0].opponent } : null;
  })()`);
  ok('棋谱保存到玩家账号', !!saved && saved.n >= 1, JSON.stringify(saved));
  ok('保存的棋谱含实际着法', !!saved && /e4/.test(saved.pgn || ''), saved ? saved.pgn : '');
  ok('保存的棋谱标记为联网对局', !!saved && saved.mode === 'online', saved ? saved.mode : '');
  // 认输无法从局面推导，必须取自 game_over 事件
  ok('认输结果正确记入棋谱（0-1）', !!saved && saved.result === '0-1', saved ? saved.result : '');

  if (saved) console.log(`\n  \x1b[2m保存的棋谱：${saved.pgn}  [${saved.result}]  对手：${saved.opp}\x1b[0m\n`);

  br.close();
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  console.log(`\x1b[1m结果: ${pass} 通过, ${fail} 失败\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
