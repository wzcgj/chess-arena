// 浏览器端到端冒烟测试：直接通过 CDP 驱动 Chrome，无需 puppeteer。
// 验证：页面加载无报错 → 棋盘渲染 → 人类走子 → AI 回应 → 思路面板生成 → 棋谱/吃子更新。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const URL_APP = process.env.APP_URL || 'http://localhost:3000';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ' → ' + extra : ''}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

// 注意：新版 Chrome 会拒绝 page 级 WS 直连，必须走 browser 级端点 + flat session。
class CDP {
  constructor(browserWsUrl) {
    this.ws = new WebSocket(browserWsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.id = 0;
    this.sessionId = null;
    this.waiting = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}, useSession = true) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (useSession && this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 30000);
    });
  }
  /** 附加到页面 target，取得 flat sessionId */
  async attach(targetId) {
    const r = await this.send('Target.attachToTarget', { targetId, flatten: true }, false);
    this.sessionId = r.sessionId;
    return r.sessionId;
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  console.log('\n\x1b[1m浏览器端到端测试\x1b[0m');

  const profile = mkdtempSync(join(tmpdir(), 'chess-cdp-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--remote-allow-origins=*',
    // 注意：本机环境下不加 --no-sandbox 时 Target.attachToTarget 会静默挂起
    '--no-sandbox', '--disable-setuid-sandbox',
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-component-extensions-with-background-pages',
    '--disable-background-networking',
    '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1400,1000',
    'about:blank',
  ], { stdio: 'ignore' });

  // 等待 CDP 就绪
  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await getJSON('/json/version'); break; } catch { await sleep(250); }
  }
  if (!version) { console.log('  ✗ 无法启动 Chrome'); process.exit(1); }
  console.log(`  · ${version.Browser}\n`);

  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready;

  // 找到 about:blank 页面 target 并附加
  let pageTarget = null;
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets', {}, false);
    pageTarget = targetInfos.find((t) => t.type === 'page');
    if (pageTarget) break;
    await sleep(250);
  }
  if (!pageTarget) { console.log('  ✗ 找不到可调试的页面'); process.exit(1); }
  await cdp.attach(pageTarget.targetId);

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  await cdp.send('Page.navigate', { url: URL_APP });

  // 等待应用启动（模块加载 + Worker 初始化）
  await sleep(3000);

  // ---- 1. 无 JS 报错 ----
  const errs = cdp.events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text);
  const logErrs = cdp.events
    .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
    .map((e) => `${e.params.entry.text} @${e.params.entry.url || ''}`);
  const allErrs = [...errs, ...logErrs];
  ok('页面加载无 JavaScript 报错', allErrs.length === 0, allErrs.slice(0, 3).join(' | '));

  // ---- 2. 棋盘渲染 ----
  const squares = await cdp.eval(`document.querySelectorAll('#board .square').length`);
  ok('棋盘渲染 64 格', squares === 64, `实际 ${squares}`);
  const pieces = await cdp.eval(`document.querySelectorAll('#board .piece').length`);
  ok('初始棋子 32 个', pieces === 32, `实际 ${pieces}`);

  // ---- 3. 难度选项 ----
  const levels = await cdp.eval(`[...document.querySelectorAll('#levelSelect option')].map(o=>o.value).join(',')`);
  ok('四档难度可选', levels === 'novice,amateur,advanced,master', levels);

  // ---- 4. 人类走子（点击 e2 → e4）----
  await cdp.eval(`
    (() => {
      const el = (sq) => document.querySelector('#board .square[data-sq="' + sq + '"]');
      const click = (sq) => {
        const t = el(sq);
        const r = t.getBoundingClientRect();
        const opt = { bubbles: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2, pointerId: 1 };
        t.dispatchEvent(new PointerEvent('pointerdown', opt));
        t.dispatchEvent(new PointerEvent('pointerup', opt));
      };
      click('e2'); click('e4');
      return true;
    })()
  `);
  await sleep(300);
  const afterHuman = await cdp.eval(`document.querySelectorAll('#moveList li').length`);
  ok('人类走子 e2-e4 生效', afterHuman >= 1, `棋谱行数 ${afterHuman}`);

  // ---- 5. 等待 AI 回应 ----
  let aiSan = '';
  for (let i = 0; i < 40; i++) {
    aiSan = await cdp.eval(`(document.querySelector('#moveList li .mv:nth-child(2)')||{}).textContent||''`);
    if (aiSan) break;
    await sleep(500);
  }
  ok('AI 在 Worker 中完成思考并落子', !!aiSan, `AI 走子: ${aiSan || '(超时)'}`);

  // ---- 6. 思路面板 ----
  const cm = await cdp.eval(`(() => {
    const b = document.getElementById('commentary');
    return {
      hasHead: !!b.querySelector('.c-headline'),
      headline: (b.querySelector('.c-headline')||{}).textContent||'',
      move: (b.querySelector('.c-move')||{}).textContent||'',
      tags: [...b.querySelectorAll('.tag')].map(t=>t.textContent),
      metrics: [...b.querySelectorAll('.metric')].map(m=>m.textContent.trim()),
      points: [...b.querySelectorAll('.c-points li')].map(t=>t.textContent),
      analysis: [...b.querySelectorAll('.c-text')].map(t=>t.textContent),
      pv: (b.querySelector('.pv')||{}).textContent||'',
      alts: [...b.querySelectorAll('.alt-san')].map(t=>t.textContent),
      tip: (b.querySelector('.c-tip')||{}).textContent||'',
      raw: b.textContent.length,
    };
  })()`);
  ok('思路面板生成标题', cm.hasHead && cm.headline.length > 0, cm.headline);
  ok('思路面板显示走子记号', cm.move.length > 0, cm.move);
  ok('思路面板含评估指标', cm.metrics.length >= 2, cm.metrics.join(' / '));
  ok('思路面板含意图说明', cm.points.length > 0 || cm.analysis.length > 0,
    `points=${cm.points.length} analysis=${cm.analysis.length}`);
  ok('思路面板含主变例', cm.pv.length > 0, cm.pv.slice(0, 60));

  console.log('\n  \x1b[2m── 思路面板实际输出 ──\x1b[0m');
  console.log(`  走子: ${cm.move}   ${cm.headline}`);
  if (cm.tags.length) console.log(`  标签: ${cm.tags.join(' / ')}`);
  if (cm.metrics.length) console.log(`  指标: ${cm.metrics.join('  |  ')}`);
  cm.points.slice(0, 2).forEach((p) => console.log(`  意图: ${p}`));
  cm.analysis.slice(0, 1).forEach((p) => console.log(`  算路: ${p.slice(0, 110)}…`));
  if (cm.pv) console.log(`  变例: ${cm.pv.slice(0, 80)}`);
  if (cm.alts.length) console.log(`  备选: ${cm.alts.join(', ')}`);
  if (cm.tip) console.log(`  提示: ${cm.tip.slice(0, 90)}`);
  console.log('');

  // ---- 7. 交互控件 ----
  const flipBefore = await cdp.eval(`document.querySelector('#board .square').dataset.sq`);
  await cdp.eval(`document.getElementById('flipBtn').click()`);
  await sleep(200);
  const flipAfter = await cdp.eval(`document.querySelector('#board .square').dataset.sq`);
  ok('翻转棋盘生效', flipBefore !== flipAfter, `${flipBefore} → ${flipAfter}`);

  await cdp.eval(`document.getElementById('flipBtn').click()`);
  await sleep(150);

  // ---- 8. 吃子统计区存在 ----
  const capOk = await cdp.eval(`!!document.getElementById('capturedWhite') && !!document.getElementById('capturedBlack')`);
  ok('吃子统计区渲染', capOk);

  // ---- 9. 切换到联网模式 ----
  await cdp.eval(`document.querySelector('.mode-btn[data-mode="online"]').click()`);
  await sleep(400);
  const onlineUI = await cdp.eval(`({
    onlineShown: !document.getElementById('onlineControls').classList.contains('hidden'),
    singleHidden: document.getElementById('singleControls').classList.contains('hidden'),
  })`);
  ok('切换联网模式 UI 正确', onlineUI.onlineShown && onlineUI.singleHidden, JSON.stringify(onlineUI));

  // ---- 10. 切回单机并开新局 ----
  await cdp.eval(`document.querySelector('.mode-btn[data-mode="single"]').click()`);
  await sleep(600);
  const restarted = await cdp.eval(`document.querySelectorAll('#board .piece').length`);
  ok('切回单机重开新局', restarted === 32, `棋子 ${restarted}`);

  // ---- 11. 运行期新增报错检查 ----
  const errs2 = cdp.events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text);
  ok('交互过程无新增异常', errs2.length === errs.length,
    errs2.slice(errs.length).join(' | ').slice(0, 200));

  cdp.close();
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}

  console.log(`\n\x1b[1m结果: ${pass} 通过, ${fail} 失败\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
