// 真浏览器里跑一遍三个页面。
//
// 为什么值得有:这几个页面是【零构建】的单文件 HTML,没有类型检查也没有打包器
// 会替你发现 `el('foo')` 拿到 null、某个函数名写错、或者启动路径上抛一次异常 ——
// 那些错误的表现就是【整页白屏】,而单元测试和接口测试一个都看不见。
//
// 用 Chrome 的 CDP(--remote-debugging-port),不依赖 playwright/puppeteer:
// 这个仓库是零依赖的,测试也不该带进一个几百兆的浏览器驱动。
// 找不到 Chrome 就整体跳过(CI 上不该因为没装浏览器而变红)。
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { freePorts } from './_ports.mjs';

function findChrome() {
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'];
  for (const n of names) {
    try {
      const p = execSync(`command -v ${n}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (p) return p;
    } catch {}
  }
  return null;
}

const CHROME = findChrome();
if (!CHROME) {
  console.log('SKIP  没找到 Chrome/Chromium,跳过浏览器测试');
  process.exit(0);
}

const [PORT, UP_PORT, CDP_PORT] = await freePorts(3);
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 极简 CDP 客户端(WebSocket 手写帧,零依赖)──
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = Buffer.from(Math.random().toString(36)).toString('base64');
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
      },
    });
    req.on('upgrade', (res, socket) => resolve(socket));
    req.on('error', reject);
    req.end();
  });
}

function frame(payload) {
  const data = Buffer.from(payload, 'utf8');
  const mask = Buffer.from([1, 2, 3, 4]);
  let header;
  if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
  else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// 收帧:只需要处理服务端发来的(未掩码)文本帧
function makeReader(socket, onMessage) {
  let buf = Buffer.alloc(0);
  let frags = [];
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (opcode === 0x1 || opcode === 0x0) {
        frags.push(payload);
        if (fin) {
          const txt = Buffer.concat(frags).toString('utf8');
          frags = [];
          try { onMessage(JSON.parse(txt)); } catch {}
        }
      } else if (opcode === 0x8) socket.end();
    }
  });
}

async function cdp(wsUrl) {
  const socket = await wsConnect(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  makeReader(socket, (msg) => {
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) events.push(msg);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      socket.write(frame(JSON.stringify({ id: mid, method, params })));
      setTimeout(() => {
        if (pending.has(mid)) { pending.delete(mid); reject(new Error('CDP 超时: ' + method)); }
      }, 15000);
    });
  return { send, events, close: () => socket.end() };
}

// ── mock 上游 + 服务 ──
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ui-'));
const configFile = path.join(temp, 'config.json');
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let j = null;
    try { j = JSON.parse(body); } catch {}
    if (j && j.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ content: [{ type: 'text', text: '{"title":"浏览器里的一问一答"}' }], usage: { input_tokens: 9, output_tokens: 4 } }));
    }
    // 带上上游限额头:普通用户的「账户整体额度」在没有订阅 usage 接口时就靠这个回落。
    // 注意是 0~1 的【比例】(usage 接口给的才是 0~100)—— 单位混了会把 48% 画成 0%。
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'anthropic-ratelimit-unified-5h-utilization': '0.48',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 5400),
      'anthropic-ratelimit-unified-7d-utilization': '0.86',
      'anthropic-ratelimit-unified-status': 'allowed',
    });
    const send = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    // slow 模式:段与段之间留出时间,好让测试在【流还没结束时】去看 DOM。
    // 这一点很关键 —— 增量渲染坏掉的表现是"正文要等流结束才出现",
    // 而即时返回的 mock 里这个 bug 完全看不出来。
    // 按【消息内容】判定慢流,而不是按模型名:给 <select> 塞一个列表里没有的
    // 值只会让它的 value 变成空串,请求随即被服务端 400 挡掉(踩过一次)
    const slow = j && /慢慢讲/.test(JSON.stringify(j.messages || []));
    const gap = slow ? 500 : 0;
    (async () => {
      send({ type: 'message_start', message: { usage: { input_tokens: 30, cache_read_input_tokens: 2 } } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想一下这个问题' } });
      if (gap) await wait(gap);
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '# 标题\n\n这是**回答**。\n\n' } });
      if (gap) await wait(gap);
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '```html\n<h1>hi</h1>\n```\n' } });
      send({ type: 'message_delta', delta: {}, usage: { output_tokens: 25 } });
      send({ type: 'message_stop' });
      res.end();
    })();
  });
});
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

fs.writeFileSync(
  configFile,
  JSON.stringify({
    host: '127.0.0.1',
    port: PORT,
    upstreamAuth: 'apiKey',
    upstreamApiKey: 'sk-test',
    upstreamBaseUrl: `http://127.0.0.1:${UP_PORT}`,
    clientTokens: [{ token: 'cct-' + 'u'.repeat(32), name: 'dev-ui' }],
    adminEnabled: true,
    adminPassword: 'admin-pw-1234',
    dataDir: path.join(temp, 'data'),
  }),
);

const server = spawn(process.execPath, [path.join(import.meta.dirname, '../src/server.js')], {
  env: { ...process.env, CC_TRANS_CONFIG: configFile },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
server.stdout.on('data', (d) => (srvLog += d));
server.stderr.on('data', (d) => (srvLog += d));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ui-prof-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--window-size=1400,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let chromeLog = '';
chrome.stdout.on('data', (d) => (chromeLog += d));
chrome.stderr.on('data', (d) => (chromeLog += d));

async function waitFor(fn, tries = 80, gap = 150) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await wait(gap);
  }
  return null;
}

let client = null;
try {
  ok('服务启动', !!(await waitFor(async () => (await fetch(BASE + '/health')).ok)));

  const ver = await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json());
  ok('Chrome 调试端口就绪', !!(ver && ver.webSocketDebuggerUrl), ver && ver['Browser']);

  // 建一个页面目标
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  client = await cdp(target.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Log.enable');
  await client.send('Console.enable');

  // 页面上的任何未捕获异常都算失败:零构建页面里它等于白屏
  const pageErrors = [];
  const noteErrors = () => {
    for (const e of client.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails;
        pageErrors.push((d.exception && d.exception.description) || d.text);
      }
      if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        // 忽略 favicon 之类的网络噪音
        if (!/favicon|net::ERR_/.test(e.params.entry.text)) pageErrors.push(e.params.entry.text);
      }
    }
    client.events.length = 0;
  };

  const goto = async (url) => {
    await client.send('Page.navigate', { url });
    await waitFor(async () => {
      const r = await client.send('Runtime.evaluate', { expression: 'document.readyState' });
      return r.result.value === 'complete';
    });
    await wait(350);
  };
  const evalJs = async (expr) => {
    const r = await client.send('Runtime.evaluate', { expression: `(function(){${expr}})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
    return r.result.value;
  };

  // ── 统一登录页 ──
  await goto(BASE + '/');
  noteErrors();
  ok('登录页渲染出登录表单', await evalJs(`return !!document.getElementById('user') && !!document.getElementById('go')`));
  ok('登录页文案由服务端填好了', (await evalJs(`return document.getElementById('sub').textContent`)).length > 0);
  ok('登录页没有 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));

  // 真的点一次登录,走到管理台
  await evalJs(`
    document.getElementById('user').value = 'admin';
    document.getElementById('pw').value = 'admin-pw-1234';
    document.getElementById('go').click();
  `);
  const landed = await waitFor(async () => (await evalJs(`return location.pathname`)) === '/admin/overview');
  ok('统一入口登录后跳到管理台', !!landed, await evalJs(`return location.pathname`));
  await wait(700);
  noteErrors();
  ok('管理台加载后没有 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
  ok('管理台确实进了应用视图(不是登录页)', await evalJs(`return !document.getElementById('appView').hidden`));

  // ── 管理台:用户 tab + 设置密码对话框 ──
  await evalJs(`switchTab('users'); return 1`);
  await wait(600);
  noteErrors();
  ok('用户页渲染出表格', (await evalJs(`return document.querySelectorAll('#userRows tr').length`)) >= 1);

  // 建一个用户(走真实的对话框流程)
  await evalJs(`openUser(); return 1`);
  await wait(200);
  const genPw = await evalJs(`
    document.getElementById('uName').value = 'uitest';
    genPw();
    return document.getElementById('uPw').value;
  `);
  ok('创建用户对话框能随机生成密码', typeof genPw === 'string' && genPw.length >= 12, String(genPw && genPw.length));
  ok('随机生成后有强度提示', (await evalJs(`return document.getElementById('uPwGrade').textContent`)).length > 0);
  // 关键:手动输入也必须可用(这正是本次要补的缺口)
  await evalJs(`
    const i = document.getElementById('uPw');
    i.value = 'manual-chosen-pw';
    i.dispatchEvent(new Event('input'));
    return 1;
  `);
  ok('创建用户时可以手动输入密码', (await evalJs(`return document.getElementById('uPw').value`)) === 'manual-chosen-pw');
  // 把设备勾上 —— 没有设备的账号根本发不出消息(服务端会 403),
  // 后面聊天那一段就成了在验证一个报错气泡
  const ticked = await evalJs(`
    const boxes = [...document.querySelectorAll('#uTokens input[type=checkbox]')];
    boxes.forEach(b => (b.checked = true));
    return boxes.length;
  `);
  ok('创建用户时能勾选要分配的设备', ticked >= 1, `${ticked} 个可选`);
  await evalJs(`saveUser(); return 1`);
  await wait(700);
  noteErrors();
  const created = await evalJs(`return !!(LAST_USERS || []).find(u => u.name === 'uitest')`);
  ok('用手输的密码创建成功', created === true);
  await evalJs(`genDlg.close(); return 1`);

  // 设置密码对话框
  await evalJs(`openUserPw('uitest'); return 1`);
  await wait(250);
  ok('设置密码对话框打开', await evalJs(`return document.getElementById('pwDlg').open === true`));
  ok('标题点名是谁', (await evalJs(`return document.getElementById('pwDlgTitle').textContent`)).includes('uitest'));
  ok('默认不保留旧会话', (await evalJs(`return document.getElementById('pwKeep').checked`)) === false);
  const weak = await evalJs(`
    document.getElementById('pwNew').value = 'abc';
    gradeSetPw();
    saveUserPw();
    return document.getElementById('pwMsg2').textContent;
  `);
  ok('太短的密码在前端就被挡下', /至少/.test(weak), weak);
  await evalJs(`
    document.getElementById('pwNew').value = 'brand-new-password';
    document.getElementById('pwNew2').value = 'brand-new-password-typo';
    gradeSetPw();
    saveUserPw();
    return 1;
  `);
  ok('两次不一致被挡下', /不一致/.test(await evalJs(`return document.getElementById('pwMsg2').textContent`)));
  await evalJs(`
    document.getElementById('pwNew2').value = 'brand-new-password';
    saveUserPw();
    return 1;
  `);
  await wait(700);
  noteErrors();
  ok('一致后保存成功(对话框关闭)', (await evalJs(`return document.getElementById('pwDlg').open`)) === false);
  ok('保存后把密码摆出来给管理员抄', (await evalJs(`return document.getElementById('newToken').textContent`)).includes('brand-new-password'));
  await evalJs(`genDlg.close(); return 1`);
  ok('设置密码全程无 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));

  // 服务端真的接受了这个密码
  const loginNew = await fetch(BASE + '/u/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'uitest', password: 'brand-new-password' }),
  });
  ok('新密码可以真的登录', loginNew.ok, `status=${loginNew.status}`);

  // ── 管理台:公告 ──
  await evalJs(`switchTab('settings'); return 1`);
  await wait(600);
  noteErrors();
  await evalJs(`
    document.getElementById('annText').value = '浏览器测试写的公告';
    document.getElementById('annLevel').value = 'warn';
    saveAnnouncement();
    return 1;
  `);
  await wait(600);
  noteErrors();
  ok('公告保存无异常', pageErrors.length === 0, pageErrors.join(' | '));

  // ── 用户端 ──
  await goto(BASE + '/u');
  noteErrors();
  await evalJs(`
    document.getElementById('user').value = 'uitest';
    document.getElementById('pw').value = 'brand-new-password';
    doLogin();
    return 1;
  `);
  await wait(900);
  noteErrors();
  ok('用户端登录后进入应用视图', await evalJs(`return !document.getElementById('appView').hidden`));
  ok('用户端没有 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
  ok('用户端显示了公告', await evalJs(`return !document.getElementById('notice').hidden && document.getElementById('noticeText').textContent.includes('浏览器测试')`));
  await evalJs(`dismissNotice(); return 1`);
  ok('公告可以关掉', await evalJs(`return document.getElementById('notice').hidden === true`));
  await evalJs(`switchTab('account'); return 1`);
  await wait(400);
  noteErrors();
  ok('账号页列出了在线设备', (await evalJs(`return document.querySelectorAll('#sessList .sess-item').length`)) >= 1);
  await evalJs(`switchTab('devices'); return 1`);
  await wait(500);
  ok('用户端「账户整体额度」块有内容(还没转发过 → 说清为什么没有数据)',
    (await evalJs(`return document.getElementById('acctBox').textContent.trim().length`)) > 0,
    await evalJs(`return document.getElementById('acctBox').textContent.trim().slice(0, 60)`));
  ok('没有个人限额时不画一条空的个人配额条', (await evalJs(`return document.getElementById('quotaBox').textContent.trim().length`)) === 0);

  ok('标出了当前设备', await evalJs(`return !!document.querySelector('#sessList .sess-item.cur')`));

  // ── 聊天页:真的发一条消息 ──
  await goto(BASE + '/u/chat');
  await wait(700);
  noteErrors();
  ok('聊天页进入应用视图', await evalJs(`return !document.getElementById('app').hidden`));
  ok('聊天页没有启动期异常', pageErrors.length === 0, pageErrors.join(' | '));
  ok('模型下拉按档位分了组', (await evalJs(`return document.querySelectorAll('#model optgroup').length`)) >= 1);
  ok('偏好里写清了断线保活的行为', (await evalJs(`return document.getElementById('graceNote').textContent`)).includes('断线保活'));

  await evalJs(`
    const i = document.getElementById('input');
    i.value = '在浏览器里问一句';
    send();
    return 1;
  `);
  // 等回答落定(mock 是即时的,但要留出渲染 + 标题生成的时间)
  await waitFor(async () => (await evalJs(`return document.querySelectorAll('#msgs .msg.assistant').length`)) >= 1, 60, 200);
  await wait(1200);
  noteErrors();
  ok('收到并渲染了回复', (await evalJs(`return document.querySelectorAll('#msgs .msg.assistant').length`)) >= 1);
  // 断言"没有报错气泡":少了这一条,上面那句在回复其实是一条错误消息时也会通过
  const errBox = await evalJs(`
    const e = document.querySelector('#msgs .msg.assistant .err');
    return e ? e.textContent : '';
  `);
  ok('回复不是一条错误消息', !errBox, errBox);
  ok('Markdown 被渲染成了 HTML(不是纯文本)', await evalJs(`return !!document.querySelector('#msgs .msg.assistant .body h1') && !!document.querySelector('#msgs .msg.assistant .body strong')`));
  ok('代码块渲染出来了', await evalJs(`return !!document.querySelector('#msgs .code-block')`));
  ok('思考过程折叠成一行并带尾巴预览', await evalJs(`
    const d = document.querySelector('#msgs .think');
    return !!d && !d.open && d.querySelector('.tail').textContent.length > 0;
  `));
  ok('思考过程点开能看到全文', await evalJs(`
    const d = document.querySelector('#msgs .think');
    if (!d) return false;
    d.open = true;
    return d.querySelector('.tbody').textContent.includes('先想一下');
  `));
  ok('消息操作条渲染出来了(复制/分叉/重新生成)', (await evalJs(`return document.querySelectorAll('#msgs .msg.assistant .acts-row button').length`)) >= 2);
  ok('回复带上了时间戳', await evalJs(`return !!document.querySelector('#msgs .msg.assistant .acts-row .stamp')`));
  ok('上下文占用指示器出现了', await evalJs(`return !document.getElementById('ctxChip').hidden`));
  // 用量很小时报 token 数(「0.0%」既没信息量又像坏了),到 1% 以上才切百分比
  const ctxLabel = await evalJs(`return document.getElementById('ctxPct').textContent`);
  ok('低占用时显示 token 数而不是 0%', /tok$/.test(ctxLabel), ctxLabel);
  ok('Artifacts 按钮亮了(回复里有可预览的 HTML)', await evalJs(`return !document.getElementById('panelBtn').hidden`));
  ok('生成结束后状态行消失', await evalJs(`return !document.getElementById('turnStatus')`));
  ok('会话进了左栏列表', (await evalJs(`return document.querySelectorAll('#sessions .sess').length`)) >= 1);
  // ── 用量:普通用户没有个人限额时,看到的是【账户整体额度】 ──
  // 这条链路的每一段都曾经是坑:限额头单位(0~1 vs 0~100)、"打开了但没数据"、
  // 以及"服务端根本没下发"。所以断言一路压到【条形的实际宽度】。
  const stripUp = await waitFor(async () => (await evalJs(`return document.getElementById('usageStrip').hidden === false`)));
  ok('侧栏出现了用量条(一轮结束后自动刷新)', !!stripUp, await evalJs(`return document.getElementById('usageStrip').outerHTML.slice(0, 160)`));
  const stripTxt = await evalJs(`return document.getElementById('usageStripLabel').textContent + '|' + document.getElementById('usageStripPct').textContent`);
  ok('用量条报的是最紧的那个窗口(86% 的 7 天窗口)', /7 天窗口\|86%/.test(stripTxt), stripTxt);
  ok('接近上限时用量条变色(86% → warn)', await evalJs(`return document.getElementById('usageStripFill').className === 'warn'`),
    await evalJs(`return document.getElementById('usageStripFill').className`));
  ok('用量条的填充宽度真的是 86%', await evalJs(`
    const f = document.getElementById('usageStripFill'), t = document.getElementById('usageStripTrack');
    const r = f.getBoundingClientRect().width / t.getBoundingClientRect().width;
    return r > 0.8 && r < 0.92;
  `), await evalJs(`return document.getElementById('usageStripFill').style.width`));
  // 真点击,不是直接调函数 —— 上一轮的教训:inline onclick 加上冒泡期监听器,
  // "函数能跑"和"点了有反应"是两件事
  await evalJs(`document.getElementById('usageStrip').click(); return 1`);
  await wait(600);
  noteErrors();
  ok('点用量条打开了弹窗', await evalJs(`return document.getElementById('usageDlg').open === true`));
  ok('打开用量没有 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
  const uBody = await evalJs(`return document.getElementById('usageBody').textContent`);
  ok('弹窗里先说自己用了多少', /我的用量/.test(uBody) && /token/.test(uBody), uBody.slice(0, 80));
  ok('弹窗里给出账户整体额度(没设个人限额时的那道真墙)', /账户整体额度/.test(uBody), uBody.slice(0, 120));
  ok('两个窗口都画成了条', (await evalJs(`return document.querySelectorAll('#usageBody .ubar').length`)) === 2,
    String(await evalJs(`return document.querySelectorAll('#usageBody .ubar').length`)));
  ok('注明了数据来自上游限额头', /限额头/.test(await evalJs(`return document.getElementById('usageNote').textContent`)),
    await evalJs(`return document.getElementById('usageNote').textContent`));
  ok('弹窗里的条也没被裁掉(命中测试)', await evalJs(`
    const b = document.querySelector('#usageBody .ubar .tr');
    const r = b.getBoundingClientRect();
    if (r.width < 40) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === b || b.contains(hit) || hit.contains(b));
  `));
  // 严重度上色不能只查 class 名有没有加上,要查【真的渲染出颜色了没有】——
  // `var(--color-danger)` 这种没在 haha-tokens.css 里定义过的变量名,浏览器会
  // 把它当无效值忽略,`class="err"` 照样加得上、宽度也照样是对的,唯独颜色是空的,
  // 上面两条断言全部会通过而看不出问题。这正是这次真实踩到的坑。
  ok('critical 严重度的条真的画出了颜色(不是变量名打错导致的空块)', await evalJs(`
    const saved = USAGE;
    USAGE = { scope: 'account', mine: { admin: true, unlimited: true }, account: { available: true, source: 'oauth', fetchedAt: Date.now(), ttlMs: 600000,
      bars: [ { key: 'session', label: '会话窗口(5 小时)', percent: 97, resetsAt: Date.now() + 3600000, severity: 'critical', model: null, isActive: true, status: null } ] } };
    drawUsage();
    const i = document.querySelector('#usageBody .ubar .tr i');
    const bg = getComputedStyle(i).backgroundColor;
    USAGE = saved; drawUsage();
    return i.className === 'err' && bg !== '' && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
  `), await evalJs(`return getComputedStyle(document.querySelector('#usageBody .ubar .tr i')).backgroundColor`));
  // 有个人限额时的另一条分支:服务端此时不会下发 account,前端必须画自己的额度。
  // 这里直接喂一份 scope=user 的载荷 —— 接口层的判定由 test/usage.mjs 锁,
  // 这里锁的是"这条分支的 DOM 不会炸、金额被抹掉时仍然画得出百分比"。
  await evalJs(`
    USAGE = { scope: 'user', mine: { window: 'day', windowLabel: '今天', unlimited: false, usedTokens: 8200, requests: 12, usedCost: null, deviceCount: 2,
      bars: [ { key: 'tokens', kind: 'tokens', label: '今天 token 额度', percent: 82, used: 8200, limit: 10000, severity: 'warn' },
              { key: 'cost', kind: 'cost', label: '今天花费额度', percent: 97, used: null, limit: null, severity: 'critical' } ] } };
    drawUsage(); drawUsageStrip(); return 1;
  `);
  await wait(200);
  noteErrors();
  ok('有个人限额时画的是「我的额度」', /我的额度/.test(await evalJs(`return document.getElementById('usageBody').textContent`)));
  ok('个人额度两条都画出来了', (await evalJs(`return document.querySelectorAll('#usageBody .ubar').length`)) === 2);
  ok('token 额度显示了已用/上限', /8\.2k \/ 10\.0k/.test(await evalJs(`return document.getElementById('usageBody').textContent`)),
    await evalJs(`return document.getElementById('usageBody').textContent.slice(0, 200)`));
  ok('抹掉金额后仍然画得出百分比(97%)', /97%/.test(await evalJs(`return document.getElementById('usageBody').textContent`)));
  ok('抹掉金额后不留下 "null" 之类的字样', !/null|undefined|NaN/.test(await evalJs(`return document.getElementById('usageBody').textContent`)),
    await evalJs(`return document.getElementById('usageBody').textContent.slice(0, 200)`));
  ok('个人额度分支没有 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
  await evalJs(`usageDlg.close(); return 1`);


  ok('列表里带摘要第二行', await evalJs(`return !!document.querySelector('#sessions .sess .p')`));
  ok('AI 生成的标题显示在列表里', await evalJs(`
    return [...document.querySelectorAll('#sessions .sess .t')].some(e => e.textContent.includes('浏览器里的一问一答'));
  `));

  // Artifacts 面板
  await evalJs(`togglePanel(true); openArtifact(0); return 1`);
  await wait(300);
  noteErrors();
  ok('Artifacts 面板能打开并渲染 iframe', await evalJs(`return !!document.querySelector('#pBody iframe')`));
  ok('预览 iframe 是沙箱化的且不给 same-origin', await evalJs(`
    const s = document.querySelector('#pBody iframe').getAttribute('sandbox') || '';
    return s.includes('allow-scripts') && !s.includes('allow-same-origin');
  `));
  await evalJs(`togglePanel(false); return 1`);

  // 搜索 / 分叉 / 改写 —— 都是新加的交互
  await evalJs(`document.getElementById('find').value = '不可能匹配的字串'; drawSessions(); return 1`);
  ok('搜索没有结果时给出空态', (await evalJs(`return document.getElementById('sessions').textContent`)).includes('没有匹配'));
  await evalJs(`document.getElementById('find').value = ''; drawSessions(); return 1`);

  await evalJs(`startEdit(0); return 1`);
  await wait(150);
  ok('点「改写」把原文填回输入框', (await evalJs(`return document.getElementById('input').value`)) === '在浏览器里问一句');
  ok('改写时给出明确的提示条', await evalJs(`return !document.getElementById('editingBar').hidden`));
  await evalJs(`cancelEdit(); return 1`);
  ok('取消改写后提示条收起', await evalJs(`return document.getElementById('editingBar').hidden === true`));

  const before = await evalJs(`return document.querySelectorAll('#sessions .sess').length`);
  await evalJs(`forkAt(1); return 1`);
  await wait(900);
  noteErrors();
  ok('分叉后会话数 +1', (await evalJs(`return document.querySelectorAll('#sessions .sess').length`)) === before + 1, `${before} → ${await evalJs(`return document.querySelectorAll('#sessions .sess').length`)}`);

  // ── 流式增量渲染:必须在【流还没结束】时就能看到正文 ──
  // 这条是专门盯一类静默失效的:如果拿不到"最后一条 assistant 消息"的节点
  // (比如用 :last-of-type 被后面的状态行挤掉),增量渲染会什么都不做,
  // 正文要等流结束后整页重渲染才出现 —— 功能"看起来是好的",但流式效果没了。
  await evalJs(`newChat(); return 1`);
  await wait(300);
  await evalJs(`
    document.getElementById('input').value = '慢慢讲';
    send();
    return 1;
  `);
  // 等第一段文字到达(mock 在 500ms 后才发第二段,所以此刻流一定还开着)
  const midStream = await waitFor(async () => await evalJs(`
    const all = document.querySelectorAll('#msgs .msg.assistant');
    const last = all[all.length - 1];
    return !!(last && last.querySelector('.body') && last.querySelector('.body').textContent.includes('这是'));
  `), 40, 120);
  ok('流未结束时正文已经逐段出现(增量渲染生效)', !!midStream);
  ok('流进行中状态行在场', await evalJs(`return !!document.getElementById('turnStatus')`));
  ok('流进行中「停止」按钮可见', await evalJs(`return document.getElementById('stopBtn').hidden === false`));
  ok('流进行中思考块已经渲染出来', await evalJs(`
    const all = document.querySelectorAll('#msgs .msg.assistant');
    const last = all[all.length - 1];
    return !!(last && last.querySelector('.think'));
  `));
  // 等它自己跑完
  await waitFor(async () => !(await evalJs(`return !!document.getElementById('turnStatus')`)), 60, 200);
  await wait(600);
  noteErrors();
  ok('流结束后状态行收起、停止按钮隐藏', await evalJs(`return !document.getElementById('turnStatus') && document.getElementById('stopBtn').hidden === true`));
  ok('流式全程无 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));

  // ── cc-haha 的「纸 · 墨 · 印」外观 ──
  // 这一组盯的是"视觉体系还在不在":令牌一旦被换回旧的那套,下面每一条都会红。
  {
    // 自托管字体真的能取到(走 CDN 的话内网/离线环境就是字体不生效)
    const f = await fetch(BASE + '/fonts/inter-latin.woff2');
    ok('字体路由可用', f.ok && f.headers.get('content-type') === 'font/woff2', `${f.status} ${f.headers.get('content-type')}`);
    ok('字体带长缓存', /immutable/.test(f.headers.get('cache-control') || ''), f.headers.get('cache-control'));
    // 路径穿越要死在白名单上
    ok('字体路由挡住路径穿越', (await fetch(BASE + '/fonts/..%2f..%2fconfig.json')).status === 404);

    ok('正文用 Inter', (await evalJs(`return getComputedStyle(document.body).fontFamily`)).includes('Inter'));
    ok('会话标题走衬线(墨的那一半)', (await evalJs(`
      return getComputedStyle(document.getElementById('chatTitle')).fontFamily.toLowerCase();
    `)).includes('serif'));
    ok('代码用 JetBrains Mono', (await evalJs(`
      const c = document.querySelector('#msgs .code-block code');
      return c ? getComputedStyle(c).fontFamily : '';
    `)).includes('JetBrains'));

    // 主色是赤陶,不是原来那套靛蓝
    const brand = await evalJs(`return getComputedStyle(document.documentElement).getPropertyValue('--color-brand').trim()`);
    ok('主色是赤陶印', /#96442B/i.test(brand) || /#D07B52/i.test(brand), brand);

    // 六套主题都能切,且底色确实各不相同
    const grounds = {};
    for (const t of ['white', 'paper', 'warm-classic', 'celadon', 'dark', 'ink-blue']) {
      await evalJs(`applyTheme('${t}'); return 1`);
      grounds[t] = await evalJs(`return getComputedStyle(document.body).backgroundColor`);
    }
    ok('六套主题各有各的底色', new Set(Object.values(grounds)).size === 6, JSON.stringify(grounds));
    ok('暗色主题确实是暗的', await evalJs(`
      applyTheme('ink-blue');
      const m = getComputedStyle(document.body).backgroundColor.match(/\\d+/g).map(Number);
      return (m[0] + m[1] + m[2]) / 3 < 60;
    `));
    await evalJs(`applyTheme('white'); return 1`);

    // 主题弹层
    await evalJs(`toggleThemePop(); return 1`);
    ok('外观弹层列出 6 套 + 跟随系统', (await evalJs(`return document.querySelectorAll('#themePop button').length`)) === 7);
    ok('弹层里标出了当前这套', await evalJs(`return !!document.querySelector('#themePop button.on')`));
    await evalJs(`document.getElementById('themePop').hidden = true; return 1`);

    // 侧栏是浅色的(原来那版是深色导航条 —— 那是 cc-trans 自己的观感)
    ok('侧栏与正文同一族纸底', await evalJs(`
      const m = getComputedStyle(document.querySelector('aside')).backgroundColor.match(/\\d+/g).map(Number);
      return (m[0] + m[1] + m[2]) / 3 > 200;
    `));

    // 圆形发送键:空闲发送、生成中停止,两态互斥
    ok('发送键是圆的', await evalJs(`
      const b = document.getElementById('sendBtn');
      const r = parseFloat(getComputedStyle(b).borderRadius);
      return r > 100 || r >= parseFloat(getComputedStyle(b).width) / 2;
    `));
    ok('空闲时只出发送键', await evalJs(`
      return document.getElementById('sendBtn').hidden === false && document.getElementById('stopBtn').hidden === true;
    `));
    ok('模型/深度等控件收进了输入框内', await evalJs(`
      return !!document.querySelector('.drop .send-row select#model');
    `));
    ok('顶栏只剩标题与元信息(没有选择器)', await evalJs(`
      return document.querySelectorAll('.chat-head select').length === 0;
    `));
    // 用户消息是右对齐、随内容收缩的卡,不是撑满整列
    ok('用户消息右对齐且有宽度上限', await evalJs(`
      const c = document.querySelector('#msgs .msg.user .col');
      if (!c) return false;
      const max = getComputedStyle(c).maxWidth;
      return getComputedStyle(c.parentElement).justifyContent === 'flex-end' && max !== 'none';
    `));
    noteErrors();
    ok('外观切换全程无 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
  }

  // ── ＋ 菜单:文件 / 联网 / 研究 / 技能 ──
  {
    await evalJs(`togglePlus(); return 1`);
    await wait(200);
    ok('＋ 菜单能打开', await evalJs(`return document.getElementById('plusMenu').hidden === false`));
    const labels = await evalJs(`return [...document.querySelectorAll('#plusMenu .menu-item b')].map(e => e.textContent)`);
    ok('菜单里有「添加文件或图片」', labels.includes('添加文件或图片'), JSON.stringify(labels));
    ok('菜单里有「联网搜索」', labels.includes('联网搜索'));
    ok('菜单里有「深度研究」', labels.includes('深度研究'));
    ok('菜单里有「技能」', labels.includes('技能'));

    // 开联网 → 输入框里出现徽标
    await evalJs(`setMode('search'); return 1`);
    ok('开了联网后有徽标', (await evalJs(`return document.getElementById('modeChips').textContent`)).includes('联网搜索'));
    ok('联网与研究互斥式切换', await evalJs(`setMode('research'); return document.getElementById('modeChips').textContent.includes('深度研究') && !document.getElementById('modeChips').textContent.includes('联网搜索')`));
    ok('再点一次能关掉', await evalJs(`setMode('research'); return document.getElementById('modeChips').textContent.trim() === ''`));

    // 技能二级菜单(浮在右边的独立面板)
    await evalJs(`closeMenus(); togglePlus(); return 1`);
    await wait(150);
    await evalJs(`
      const row = [...document.querySelectorAll('#plusBody .menu-item')].find(e => e.textContent.includes('技能'));
      openSkillSub(row); return 1;
    `);
    await wait(150);
    const note = await evalJs(`
      const n = document.querySelector('#plusSub .menu-note');
      return n ? n.textContent : '';
    `);
    ok('技能页说清了它只是提示词', /预设提示词/.test(note) && /不会读你的文件/.test(note), note.slice(0, 60));
    ok('提供了自建入口', (await evalJs(`return document.getElementById('plusSub').textContent`)).includes('新建技能'));
    await evalJs(`closeMenus(); return 1`);
    noteErrors();
    ok('＋ 菜单无 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
  }
  // ── 附件:拖拽 与 粘贴 ──
  //
  // 为什么值得单独有一段:这两条路是【只有真浏览器能验】的 —— 接口测试打的是
  // /chat/image 与 /chat/file,它们一直是好的;坏的是页面上根本没有把文件交到
  // 那两个接口手里。表现就是"拖进去没反应",而所有既有测试全绿。
  //
  // 假文件字节过不了服务端的魔数嗅探(putImage → sniffMatches),
  // 所以这里必须用【真的】PNG / PDF 字节,否则拿回 400 会被误读成前端没接住。
  {
    const FIX = `
      const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      function b64bytes(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
      function mkPng(n) { return new File([b64bytes(PNG_B64)], n || 'a.png', { type: 'image/png' }); }
      function mkPdf(n) { return new File([new TextEncoder().encode('%PDF-1.4\\n1 0 obj<<>>endobj\\ntrailer<<>>\\n%%EOF\\n')], n || 'b.pdf', { type: 'application/pdf' }); }
      function mkTxt(n) { return new File([new TextEncoder().encode('hello from a dropped text file')], n || 'c.txt', { type: 'text/plain' }); }
      function dtOf(files) { const d = new DataTransfer(); for (const f of files) d.items.add(f); return d; }
      function reset() { clearPending(); }
      function fire(target, type, d) {
        const ev = type === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })
          : new DragEvent(type, { dataTransfer: d, bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
        return ev;
      }
    `;

    // 1) 拖到输入框上(唯一一直能用的落点)—— 回归保护
    const onComposer = await evalJs(`${FIX}
      return (async () => {      reset();
      fire(document.getElementById('drop'), 'drop', dtOf([mkPng()]));
      await new Promise(r => setTimeout(r, 800));
      return { imgs: doneImages().length, tiles: document.querySelectorAll('#pending .att-tile').length };})();
    `);
    ok('拖到输入框上能收下图片', onComposer.imgs === 1 && onComposer.tiles === 1, JSON.stringify(onComposer));

    // 2) 拖到消息区 —— 用户最可能的落点。整页都该是投放区。
    const onMsgs = await evalJs(`${FIX}
      return (async () => {      reset();
      const t = document.getElementById('msgs');
      const over = fire(t, 'dragover', dtOf([mkPng()]));
      fire(t, 'drop', dtOf([mkPng('d.png')]));
      await new Promise(r => setTimeout(r, 800));
      return { imgs: doneImages().length, overPrevented: over.defaultPrevented };})();
    `);
    ok('拖到消息区(不是输入框)也能收下', onMsgs.imgs === 1, JSON.stringify(onMsgs));
    // 这一条是"拖进去整个页面被那张图顶掉"的根因:没人 preventDefault,
    // 浏览器就按默认行为把标签页导航到那个文件,会话直接没了。
    ok('拖文件时 dragover 被拦下(否则浏览器会把标签页导航到文件)', onMsgs.overPrevented === true);

    // 3) 拖非文件(在输入框里拖选中的文字)不能被我们截胡 —— 那是浏览器原生功能
    ok('拖纯文本时不拦截,原生拖字仍然可用', await evalJs(`
      const d = new DataTransfer();
      d.setData('text/plain', '一段被拖动的文字');
      const ev = new DragEvent('dragover', { dataTransfer: d, bubbles: true, cancelable: true });
      document.getElementById('input').dispatchEvent(ev);
      return ev.defaultPrevented === false;
    `));

    // 4) 粘贴图片(焦点在输入框)—— 回归保护
    const pasteImg = await evalJs(`${FIX}
      return (async () => {      reset();
      const i = document.getElementById('input'); i.focus();
      fire(i, 'paste', dtOf([mkPng('p.png')]));
      await new Promise(r => setTimeout(r, 800));
      return doneImages().length;})();
    `);
    ok('在输入框里粘贴图片能收下', pasteImg === 1, String(pasteImg));

    // 5) 粘贴的是【文件】(从文件管理器复制的 PDF / 文本)—— 旧实现只认 image/*
    const pasteDoc = await evalJs(`${FIX}
      return (async () => {      reset();
      const i = document.getElementById('input'); i.focus();
      fire(i, 'paste', dtOf([mkPdf('p.pdf'), mkTxt('p.txt')]));
      await new Promise(r => setTimeout(r, 1000));
      return { files: doneFiles().length, names: doneFiles().map(f => f.name) };})();
    `);
    ok('粘贴 PDF / 文本文件也能收下', pasteDoc.files === 2, JSON.stringify(pasteDoc));

    // 6) 焦点不在输入框时粘贴 —— 旧实现把监听挂在 #input 上,点一下消息就失灵
    const pasteBlur = await evalJs(`${FIX}
      return (async () => {      reset();
      document.getElementById('input').blur();
      fire(document.body, 'paste', dtOf([mkPng('q.png')]));
      await new Promise(r => setTimeout(r, 800));
      return doneImages().length;})();
    `);
    ok('焦点不在输入框时粘贴也能收下', pasteBlur === 1, String(pasteBlur));

    // 7) 粘贴纯文字不能被拦 —— 否则输入框里 Ctrl+V 贴不进字
    ok('粘贴纯文字不拦截', await evalJs(`
      const d = new DataTransfer();
      d.setData('text/plain', '普通文字');
      const ev = new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true });
      document.getElementById('input').dispatchEvent(ev);
      return ev.defaultPrevented === false;
    `));

    // 8) 拖进来的时候要看得见 —— 没有提示的话,用户根本不知道能往哪儿放
    const hint = await evalJs(`${FIX}
      return (async () => {      const d = dtOf([mkPng()]);
      fire(document.body, 'dragenter', d);
      fire(document.body, 'dragover', d);
      await new Promise(r => setTimeout(r, 120));
      const o = document.getElementById('dropVeil');
      const shown = !!o && !o.hidden && getComputedStyle(o).display !== 'none';
      fire(document.body, 'dragleave', d);
      fire(document.body, 'drop', new DataTransfer());
      await new Promise(r => setTimeout(r, 200));
      const o2 = document.getElementById('dropVeil');
      // 只看 hidden 属性不够:.drop-veil 自带 display:grid,类选择器会盖过
      // UA 的 [hidden]{display:none}(页面顶上那条 !important 就是为这个加的)
      return { shown, hiddenAfter: !o2 || (o2.hidden && getComputedStyle(o2).display === 'none') };})();
    `);
    ok('拖动时整页给出投放提示', hint.shown === true, JSON.stringify(hint));
    ok('松手/离开后提示收起', hint.hiddenAfter === true, JSON.stringify(hint));

    // 9) 事件直接派发到 window 时 e.target 就是 window(不是 Node)——
    //    早期实现在这里对它调用 contains(),稳定抛 TypeError
    ok('dragover 派发到 window 上不炸', await evalJs(`
      const d = new DataTransfer();
      const f = new File([new Uint8Array([1, 2, 3])], 'w.bin', { type: 'application/octet-stream' });
      d.items.add(f);
      try {
        window.dispatchEvent(new DragEvent('dragover', { dataTransfer: d, bubbles: true, cancelable: true }));
        showVeil(false);
        return true;
      } catch (e) { return 'throw: ' + e.message; }
    `) === true);

    // 10) 上传失败必须【说话】。
    //
    // 这是"拖进去完全没反应"的那一半根因:addFile 里的 api() 没有 try/catch,
    // 网络层失败(连接被掐、超时、隧道断)时 fetch 抛 TypeError,异常从 async
    // 事件处理器里逃逸成 unhandled rejection —— 没有 toast、没有瓦片、什么都没有。
    // 这里用 CDP 把上传请求直接判死,验前端至少得给一句话。
    {
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*chat/file*', requestStage: 'Request' }] });
      client.events.length = 0;
      const started = evalJs(`
        return (async () => {
          const f = new File([new TextEncoder().encode('some text')], 'net-fail.txt', { type: 'text/plain' });
          try { await addFile(f); } catch (e) { window.__escaped = String((e && e.message) || e); }
          await new Promise(r => setTimeout(r, 400));
          const err = document.querySelector('#pending .att-tile.err');
          return { hasErrTile: !!err,
                   why: err ? (err.querySelector('.why') || {}).textContent || '' : '',
                   canRetry: !!(err && err.querySelector('.retry')),
                   escaped: window.__escaped || '' };
        })();
      `);
      // 等到请求被拦住,然后把它判死
      const paused = await waitFor(() => client.events.find((e) => e.method === 'Fetch.requestPaused'), 60, 100);
      if (paused) await client.send('Fetch.failRequest', { requestId: paused.params.requestId, errorReason: 'ConnectionAborted' });
      const r = await started.catch((e) => ({ toasts: [], tiles: -1, escaped: 'EVAL-THREW ' + e.message }));
      await client.send('Fetch.disable');
      // 报错就地留在瓦片上,比一条转瞬即逝的 toast 有用 —— 一次拖十个文件时尤其明显
      ok('上传被掐断时瓦片留在原地并标红(不是静默消失)', r.hasErrTile === true, JSON.stringify(r).slice(0, 200));
      ok('瓦片上写清了为什么失败', typeof r.why === 'string' && r.why.length > 0, r.why);
      ok('失败的瓦片可以重试', r.canRetry === true);
      ok('网络失败时异常不会逃逸出 addFile', r.escaped === '', r.escaped);
    }

    // 11) 本次改动的【核心契约】:瓦片在上传【完成之前】就已经在页面上。
    //
    // 证法是把上传请求在 CDP 层挂住不放行,在它还没返回的那一刻去看 DOM。
    // 如果只在请求结束后断言,那"传完才出现"和"立刻出现"两种实现都会通过 ——
    // 这正是之前漏掉这个问题的原因。
    {
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*chat/image*', requestStage: 'Request' }] });
      client.events.length = 0;
      const started = evalJs(`
        return (async () => {
          const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
          const s = atob(b64); const u = new Uint8Array(s.length);
          for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
          clearPending();
          addFile(new File([u], 'slow.png', { type: 'image/png' }));   // 【不 await】
          await new Promise(r => setTimeout(r, 300));
          const tile = document.querySelector('#pending .att-tile');
          return {
            上传中就有瓦片: !!tile,
            是图片预览: !!(tile && tile.querySelector('img')),
            预览是本地blob: !!(tile && tile.querySelector('img') && tile.querySelector('img').src.startsWith('blob:')),
            有进度遮罩: !!(tile && tile.querySelector('.veil')),
            有进度环: !!(tile && tile.querySelector('.veil .ring')),
            有百分比: /%/.test((tile && (tile.querySelector('.pct') || {}).textContent) || ''),
            这会儿还没传完: doneImages().length === 0,
            发送键被按住: document.getElementById('sendBtn').disabled === true,
          };
        })();
      `);
      const paused = await waitFor(() => client.events.find((e) => e.method === 'Fetch.requestPaused'), 60, 100);
      const mid = await started;
      ok('上传【进行中】瓦片就已经在了', mid.上传中就有瓦片 === true, JSON.stringify(mid));
      ok('图片预览用的是本地 blob(不等服务端回图)', mid.预览是本地blob === true, JSON.stringify(mid));
      ok('瓦片上有进度遮罩 + 进度环 + 百分比',
        mid.有进度遮罩 && mid.有进度环 && mid.有百分比, JSON.stringify(mid));
      ok('这一刻确实还没传完(证明不是"传完才出现")', mid.这会儿还没传完 === true, JSON.stringify(mid));
      ok('还在上传时发送键被按住', mid.发送键被按住 === true, JSON.stringify(mid));

      // 放行,应该翻成 done:遮罩撤掉、发送键恢复
      if (paused) await client.send('Fetch.continueRequest', { requestId: paused.params.requestId });
      const after = await waitFor(async () => {
        const v = await evalJs(`return (async () => ({ done: doneImages().length,
          veil: document.querySelectorAll('#pending .att-tile .veil').length,
          sendable: document.getElementById('sendBtn').disabled === false }))();`);
        return v && v.done === 1 ? v : null;
      }, 60, 150);
      await client.send('Fetch.disable');
      ok('放行后翻成已完成', !!after && after.done === 1, JSON.stringify(after));
      ok('传完后进度遮罩撤掉', !!after && after.veil === 0, JSON.stringify(after));
      ok('传完后发送键恢复', !!after && after.sendable === true, JSON.stringify(after));
    }

    // 12) 并发上传时按 uid 删除,不能按数组下标 —— 完成顺序不定会删错人
    ok('多个附件时删中间那个,删掉的是对的那个', await evalJs(`
      return (async () => {
        clearPending();
        const mk = (n) => new File([new TextEncoder().encode('x'.repeat(20))], n, { type: 'text/plain' });
        await addFile(mk('one.txt')); await addFile(mk('two.txt')); await addFile(mk('three.txt'));
        if (pending.length !== 3) return 'expected 3, got ' + pending.length;
        dropItem(pending[1].uid);
        const names = pending.map(p => p.name).join(',');
        return names === 'one.txt,three.txt' ? true : 'got ' + names;
      })();
    `) === true);

    // 收尾:别把附件留给后面的用例(pending 会被下一次 send() 带走)
    await evalJs(`clearPending(); return 1`);
    noteErrors();
    ok('拖拽 / 粘贴全程无 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
  }

  // ── 模型 / 深度:嵌套菜单(对齐 claude.ai 的形状)──
  {
    await evalJs(`toggleModelMenu(); return 1`);
    await wait(200);
    ok('模型菜单能打开', await evalJs(`return document.getElementById('modelMenu').hidden === false`));
    // 只查 hidden 抓不住"打开了但被祖先容器裁掉"这种情况(overflow-x:auto 的父级
    // 会把 absolute 弹层切成零可见)。所以做命中测试:菜单上那一点真的是菜单。
    ok('模型菜单真的看得见(没被滚动容器裁掉)', await evalJs(`
      const m = document.getElementById('modelMenu');
      const r = m.getBoundingClientRect();
      if (r.width < 100 || r.height < 40) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
      return !!(hit && m.contains(hit));
    `));
    ok('列出了模型', (await evalJs(`return document.querySelectorAll('#modelBody .menu-item').length`)) >= 2);
    ok('当前模型有勾', await evalJs(`return !!document.querySelector('#modelBody .menu-item.on .tick')`));
    const rows = await evalJs(`return [...document.querySelectorAll('#modelBody .menu-item b')].map(e => e.textContent)`);
    ok('底部有「深度」入口', rows.includes('深度'), JSON.stringify(rows.slice(-3)));

    // 进深度二级菜单
    await evalJs(`
      const row = [...document.querySelectorAll('#modelBody .menu-item')].find(e => e.textContent.includes('深度'));
      openEffortSub(row); return 1;
    `);
    await wait(150);
    const effs = await evalJs(`return [...document.querySelectorAll('#modelSub .menu-item b')].map(e => e.textContent)`);
    ok('深度五档齐全', ['低', '中', '高', '很高', '最大'].every((x) => effs.includes(x)), JSON.stringify(effs));
    ok('高标着「默认」', await evalJs(`return [...document.querySelectorAll('#modelSub .menu-item')].some(e => e.textContent.includes('高') && e.textContent.includes('默认'))`));
    ok('给了"更慢更耗额度"的说明', (await evalJs(`
      const n = document.querySelector('#modelSub .menu-note');
      return n ? n.textContent : '';
    `)).includes('更耗额度'));

    // 选一个深度,状态位与按钮都要跟上
    await evalJs(`pickEffort('max'); return 1`);
    ok('选了「最大」后状态位更新', (await evalJs(`return document.getElementById('effort').value`)) === 'max');
    ok('按钮上显示当前深度', (await evalJs(`return document.getElementById('mdlEffort').textContent`)).includes('最大'));
    ok('选完菜单自动关掉', await evalJs(`return document.getElementById('modelMenu').hidden === true`));
    await evalJs(`pickEffort('high'); return 1`);

    // 换模型
    await evalJs(`toggleModelMenu(); return 1`);
    await wait(150);
    const picked = await evalJs(`
      const items = [...document.querySelectorAll('#modelBody .menu-item')].filter(e => !e.classList.contains('on') && e.querySelector('b') && !['深度','更多模型','返回'].includes(e.querySelector('b').textContent));
      if (!items.length) return '';
      const name = items[0].querySelector('b').textContent;
      items[0].click();
      return name;
    `);
    if (picked) ok('点菜单能换模型', (await evalJs(`return document.getElementById('model').value`)) === picked, picked);
    else ok('点菜单能换模型(只有一个模型可选,跳过)', true);
    ok('原来的 select 仍是唯一状态位', await evalJs(`return document.getElementById('model').tagName === 'SELECT'`));
    noteErrors();
    ok('模型菜单无 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
  }

  // ── 真点击(不是直接调函数)──
  // 上面那些用 evalJs 直接调 drawModelMenu('effort') 之类的断言,验的是【渲染器】,
  // 不是【交互】。真实点击会走 document 上的"点外面就关掉"监听,而那条路径上
  // 一旦顺序不对,菜单就是打开一瞬间又被关掉 —— 直接调函数永远看不到。
  const clickInMenu = async (menuId, label) =>
    await evalJs(`
      const btns = [...document.querySelectorAll('#${menuId} .menu-item')];
      const b = btns.find((x) => x.textContent.includes(${JSON.stringify(label)}));
      if (!b) return 'no-button';
      b.click();
      return 'clicked';
    `);

  {
    // 深度子菜单:点「深度」这一行
    await evalJs(`closeMenus(); return 1`);
    await evalJs(`document.getElementById('mdlBtn').click(); return 1`);
    await wait(200);
    ok('点模型按钮能打开菜单', await evalJs(`return document.getElementById('modelMenu').hidden === false`));
    ok('找到「深度」这一行', (await clickInMenu('modelMenu', '深度')) === 'clicked');
    await wait(250);
    ok('点「深度」后菜单还开着', await evalJs(`return document.getElementById('modelMenu').hidden === false`));
    const effs = await evalJs(`return [...document.querySelectorAll('#modelSub .menu-item b')].map(e => e.textContent)`);
    ok('点「深度」真的进了子菜单', ['低', '中', '高', '很高', '最大'].every((x) => effs.includes(x)), JSON.stringify(effs));
    // 二级菜单是【浮在右边的独立面板】,不是把父菜单换页 —— 父菜单必须还在原处
    ok('父菜单还在(没被换页)', await evalJs(`
      return [...document.querySelectorAll('#modelBody .menu-item b')].some(e => e.textContent === '深度');
    `));
    ok('二级面板浮在父菜单右侧', await evalJs(`
      const m = document.getElementById('modelMenu').getBoundingClientRect();
      const sb = document.getElementById('modelSub').getBoundingClientRect();
      if (sb.width < 100) return false;
      // 没翻边时应当整体在父菜单右边;翻了边则在左边
      const flipped = document.getElementById('modelSub').classList.contains('flip');
      return flipped ? sb.right <= m.left + 2 : sb.left >= m.right - 2;
    `));
    // 竖直方向:要么和触发行对齐,要么是因为撞到视口底被上移了(面板高 245px、
    // 触发行又靠下时必然如此)。两种都对,所以断言"看起来是挂在父菜单旁边的":
    // 竖直区间与父菜单有重叠,且没跑出视口。
    ok('二级面板竖直上挨着父菜单', await evalJs(`
      const m = document.getElementById('modelMenu').getBoundingClientRect();
      const sb = document.getElementById('modelSub').getBoundingClientRect();
      const overlap = Math.min(m.bottom, sb.bottom) - Math.max(m.top, sb.top);
      return overlap > 60;
    `));
    ok('对齐触发行,或因撞底而上移', await evalJs(`
      const row = [...document.querySelectorAll('#modelBody .menu-item')].find(e => e.textContent.includes('深度'));
      const rr = row.getBoundingClientRect();
      const sb = document.getElementById('modelSub').getBoundingClientRect();
      return Math.abs(sb.top - rr.top) < 40 || sb.bottom >= window.innerHeight - 12;
    `));
    ok('触发行标成了展开态', await evalJs(`
      const row = [...document.querySelectorAll('#modelBody .menu-item')].find(e => e.textContent.includes('深度'));
      return row.classList.contains('open');
    `));
    ok('二级面板没被裁掉(命中测试)', await evalJs(`
      const sb = document.getElementById('modelSub');
      const r = sb.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
      return !!(hit && sb.contains(hit));
    `));
    ok('二级面板在视口内', await evalJs(`
      const r = document.getElementById('modelSub').getBoundingClientRect();
      return r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1;
    `));

    // 更多模型
    await evalJs(`closeMenus(); document.getElementById('mdlBtn').click(); return 1`);
    await wait(200);
    const more = await clickInMenu('modelMenu', '更多模型');
    if (more === 'clicked') {
      await wait(250);
      ok('点「更多模型」后菜单还开着', await evalJs(`return document.getElementById('modelMenu').hidden === false`));
      ok('点「更多模型」浮出了二级面板', await evalJs(`
        const sb = document.getElementById('modelSub');
        return sb.hidden === false && sb.querySelectorAll('.menu-item').length >= 2;
      `));
    } else {
      ok('点「更多模型」(模型不够多,没有这一项)', true);
    }

    // 技能子菜单
    await evalJs(`closeMenus(); document.getElementById('plusBtn').click(); return 1`);
    await wait(200);
    ok('点 ＋ 能打开菜单', await evalJs(`return document.getElementById('plusMenu').hidden === false`));
    ok('找到「技能」这一行', (await clickInMenu('plusMenu', '技能')) === 'clicked');
    await wait(250);
    ok('点「技能」后菜单还开着', await evalJs(`return document.getElementById('plusMenu').hidden === false`));
    ok('点「技能」浮出了二级面板', await evalJs(`return document.getElementById('plusSub').hidden === false`));
    ok('二级面板里有说明与新建入口', (await evalJs(`return document.getElementById('plusSub').textContent`)).includes('预设提示词')
      && (await evalJs(`return document.getElementById('plusSub').textContent`)).includes('新建技能'));
    ok('技能面板也浮在右边', await evalJs(`
      const m = document.getElementById('plusMenu').getBoundingClientRect();
      const sb = document.getElementById('plusSub').getBoundingClientRect();
      const flipped = document.getElementById('plusSub').classList.contains('flip');
      return flipped ? sb.right <= m.left + 2 : sb.left >= m.right - 2;
    `));
    ok('父菜单的「添加文件或图片」还在', (await evalJs(`return document.getElementById('plusBody').textContent`)).includes('添加文件或图片'));

    // 自建技能:真的走一遍对话框
    await evalJs(`newOwnSkill(); return 1`);
    await wait(200);
    ok('新建技能对话框能打开', await evalJs(`return document.getElementById('skillDlg').open === true`));
    ok('新建时不显示删除按钮', await evalJs(`return document.getElementById('skDel').hidden === true`));
    ok('空名字被挡下', await evalJs(`saveOwnSkill(); return document.getElementById('skErr').textContent.length > 0`));
    await evalJs(`
      document.getElementById('skName').value = '浏览器里建的技能';
      document.getElementById('skPrompt').value = '这是浏览器测试写进去的提示词。';
      saveOwnSkill(); return 1;
    `);
    await waitFor(async () => (await evalJs(`return document.getElementById('skillDlg').open`)) === false, 40, 150);
    ok('保存后对话框关闭', (await evalJs(`return document.getElementById('skillDlg').open`)) === false);
    await wait(500);
    ok('新技能出现在 META 里', await evalJs(`return (META.skills || []).some(k => k.name === '浏览器里建的技能' && k.scope === 'mine')`));
    // 中文名生成不出可读 id,要退回时间戳而不是空 id
    ok('中文名也能生成合法 id', await evalJs(`return (META.skills || []).some(k => k.name === '浏览器里建的技能' && /^[a-zA-Z0-9._-]+$/.test(k.id))`));
    noteErrors();
    ok('自建技能全程无 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));

    // 点菜单外面应该关掉
    await evalJs(`document.querySelector('.stream').click(); return 1`);
    await wait(200);
    ok('点菜单外面会关掉', await evalJs(`return document.getElementById('plusMenu').hidden === true && document.getElementById('modelMenu').hidden === true`));
    noteErrors();
    ok('真点击全程无 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
  }

  // 回合导航条:消息够多才出现,这里只验它不报错
  ok('全流程结束仍无 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));

  // 回到 /u:转发过之后,那一块该长出真正的条
  await goto(BASE + '/u/devices');
  await wait(1200);
  noteErrors();
  const acct = await evalJs(`return document.getElementById('acctBox').textContent`);
  ok('用户端「账户整体额度」在有数据后画出了条', (await evalJs(`return document.querySelectorAll('#acctBox .qtrack').length`)) === 2, String(await evalJs(`return document.querySelectorAll('#acctBox .qtrack').length`)));
  ok('用户端也标明了这是账户整体的额度', /账户整体额度/.test(acct) && /管理员没给你单独设限额/.test(acct), acct.slice(0, 120));
  ok('用户端窗口条带上了重置时间', /后重置/.test(acct), acct.slice(0, 200));
  ok('用户端账户额度块没有 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));


  // 回聊天页:下面的移动端用例都在那儿跑
  await goto(BASE + '/u/chat');
  await waitFor(async () => (await evalJs(`return document.getElementById('app').hidden === false`)));
  await wait(400);
  noteErrors();

  // 移动端视口下侧栏能开也能关(那条"打开后关不掉"的老坑)
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await wait(300);
  await evalJs(`toggleSide(true); return 1`);
  ok('手机视口下侧栏能打开', await evalJs(`return document.getElementById('side').classList.contains('open')`));
  ok('打开时遮罩在场(否则关不掉)', await evalJs(`return document.getElementById('sideScrim').hidden === false`));
  await evalJs(`toggleSide(false); return 1`);
  ok('侧栏能关回去', await evalJs(`return !document.getElementById('side').classList.contains('open')`));
  // 输入框那一行不能换行:换了行发送键会被挤到下一行最左边,又占地方又找不到
  // 窄屏放不下两列,二级面板要盖在父菜单原位上(而不是浮到屏幕外面去)
  {
    await evalJs(`closeMenus(); document.getElementById('plusBtn').click(); return 1`);
    await wait(250);
    await evalJs(`
      const row = [...document.querySelectorAll('#plusBody .menu-item')].find(e => e.textContent.includes('技能'));
      row.click(); return 1;
    `);
    await wait(300);
    ok('窄屏下二级面板打开了', await evalJs(`return document.getElementById('plusSub').hidden === false`));
    ok('窄屏下二级面板没跑出视口', await evalJs(`
      const r = document.getElementById('plusSub').getBoundingClientRect();
      return r.left >= -1 && r.right <= window.innerWidth + 1;
    `), await evalJs(`
      const r = document.getElementById('plusSub').getBoundingClientRect();
      return JSON.stringify([Math.round(r.left), Math.round(r.right), window.innerWidth]);
    `));
    ok('窄屏下二级面板盖在父菜单原位', await evalJs(`
      const m = document.getElementById('plusMenu').getBoundingClientRect();
      const sb = document.getElementById('plusSub').getBoundingClientRect();
      return Math.abs(sb.left - m.left) < 4 && Math.abs(sb.width - m.width) < 4;
    `));
    ok('窄屏下二级面板可点(命中测试)', await evalJs(`
      const sb = document.getElementById('plusSub');
      const r = sb.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 24);
      return !!(hit && sb.contains(hit));
    `));
    await evalJs(`closeMenus(); return 1`);
    noteErrors();
    ok('窄屏二级菜单无 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
  }

  ok('窄屏下输入框控件行不换行', (await evalJs(`
    return getComputedStyle(document.querySelector('.send-row')).flexWrap;
  `)) === 'nowrap');
  ok('窄屏下发送键仍在这一行的最右', await evalJs(`
    const row = document.querySelector('.send-row');
    const b = document.getElementById('sendBtn');
    const rb = row.getBoundingClientRect(), bb = b.getBoundingClientRect();
    // 同一行(垂直中心接近)且贴着右边缘
    return Math.abs((bb.top + bb.height / 2) - (rb.top + rb.height / 2)) < 8 && rb.right - bb.right < 4;
  `));
  ok('页面不横向溢出', await evalJs(`return document.documentElement.scrollWidth <= window.innerWidth + 1`),
    `scrollWidth=${await evalJs(`return document.documentElement.scrollWidth`)} vs ${await evalJs(`return window.innerWidth`)}`);
  noteErrors();
  ok('手机视口下无 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
  fail++;
  console.log('FAIL  测试异常:', err.stack || err.message);
} finally {
  try { if (client) client.close(); } catch {}
  chrome.kill();
  server.kill();
  upstream.close();
  await wait(300);
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail) {
  console.log('\n--- 服务日志 ---\n' + srvLog.slice(-2500));
  process.exit(1);
}
