// 网页聊天测试。两个重点:
//   1. Markdown 渲染的注入面(模型输出是不可信内容)
//   2. 会话的越权与路径穿越
// 流式部分打一个 mock 上游,验证事件序列、usage 汇总、强制模型、记账落到设备名下。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderMarkdown, highlight, extractArtifacts, escapeHtml } from '../src/md.js';
import { createChatStore } from '../src/chat_store.js';

const PORT = 19975;
const UP_PORT = 19976;
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

// 判定"是否产生了可执行的东西",而不是"文本里是否含关键字"——
// 后者会把 &lt;script&gt; 这种已转义的安全输出误判成泄漏。
function dangerous(html) {
  return (
    /<\s*(script|iframe|object|embed|style|link|meta|base|form|svg|math)\b/i.test(html) ||
    /<[^>]+\son[a-z]+\s*=/i.test(html) ||
    /(href|src)\s*=\s*["']?\s*(javascript|data|vbscript):/i.test(html)
  );
}

// ── 1. Markdown 安全 ──
{
  const vectors = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="//evil.test"></iframe>',
    '<style>body{display:none}</style>',
    '<svg onload=alert(1)>',
    '[x](javascript:alert(1))',
    '[x](JAVASCRIPT:alert(1))',
    '[x](java\tscript:alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '[x]("onmouseover="alert(1))',
    "[x]('onclick='alert(1))",
    '[x](https://ok.test" onmouseover="alert(1))',
    '`<script>a</script>`',
    '```\n<script>a</script>\n```',
    '# <b>x</b>',
    '> <script>a</script>',
    '| <script>a</script> | b |\n| --- | --- |\n| c | d |',
    '- <img src=x onerror=alert(1)>',
    '**<script>a</script>**',
    'text\n\n<form action=x><input name=y></form>',
    '<base href="//evil.test">',
    '<!--[if IE]><script>a</script><![endif]-->',
  ];
  let leaks = 0;
  for (const v of vectors) {
    const html = renderMarkdown(v);
    if (dangerous(html)) {
      leaks++;
      console.log(`      ↳ 泄漏输入: ${JSON.stringify(v)} → ${JSON.stringify(html.slice(0, 120))}`);
    }
  }
  ok(`Markdown 注入向量全部无害化(${vectors.length} 个)`, leaks === 0, leaks ? `${leaks} 个泄漏` : '');

  // 高亮同样不能成为注入通道
  const hl = highlight('const a = "<script>alert(1)</script>";', 'js');
  ok('高亮输出不含可执行标签', !dangerous(hl) && hl.includes('&lt;script&gt;'));

  // 安全链接要照常工作
  const good = renderMarkdown('[ok](https://example.com/a?b=1&c=2)');
  ok('正常 http 链接保留', /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2"/.test(good), good.slice(0, 80));
  ok('链接带 noopener', /rel="noopener noreferrer nofollow"/.test(good));
}

// ── 2. 渲染正确性 ──
{
  ok('标题', renderMarkdown('## 标题').includes('<h2>标题</h2>'));
  ok('粗体与斜体', renderMarkdown('**b** *i*').includes('<strong>b</strong> <em>i</em>'));
  ok('删除线', renderMarkdown('~~x~~').includes('<del>x</del>'));
  ok('行内代码', renderMarkdown('用 `npm test` 跑').includes('<code>npm test</code>'));
  ok('行内代码里的星号不被解析', renderMarkdown('`a*b*c`').includes('<code>a*b*c</code>'));
  ok('嵌套列表', renderMarkdown('- a\n  - b\n- c').includes('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>'));
  ok('有序列表', renderMarkdown('1. a\n2. b').includes('<ol><li>a</li><li>b</li></ol>'));
  ok('任务列表', renderMarkdown('- [x] 完成').includes('checked'));
  ok('引用', renderMarkdown('> 引用').includes('<blockquote>'));
  ok('水平线', renderMarkdown('---').includes('<hr />'));
  const tbl = renderMarkdown('| a | b |\n| --- | ---: |\n| 1 | 2 |');
  ok('表格', tbl.includes('<table class="md-table">') && tbl.includes('text-align:right'));
  const code = renderMarkdown('```js\nconst a = 1;\n```');
  ok('代码块带语言与复制按钮', code.includes('data-lang="js"') && code.includes('data-copy'));
  ok('代码块内的 markdown 不被解析', renderMarkdown('```\n**not bold**\n```').includes('**not bold**'));
  ok('代码块高亮生效', code.includes('hl-kw'));
  ok('未知语言不高亮但转义', renderMarkdown('```wat\n<x>\n```').includes('&lt;x&gt;'));
  ok('段落内换行变 br', renderMarkdown('a\nb').includes('a<br />b'));
}

// ── 3. Artifacts 抽取 ──
{
  const a1 = extractArtifacts('前言\n```html\n<h1>hi</h1>\n```\n后记');
  ok('html 代码块成为可预览 artifact', a1.length === 1 && a1[0].kind === 'preview' && a1[0].lang === 'html');
  const short = extractArtifacts('```js\nconst a=1;\n```');
  ok('短代码块不成为 artifact', short.length === 0);
  const long = extractArtifacts('```js\n' + Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') + '\n```');
  ok('长代码块成为 code artifact', long.length === 1 && long[0].kind === 'code');
  const two = extractArtifacts('```js\nx\n```\n```html\n<b>y</b>\n```');
  ok('artifact 的 index 对应代码块序号', two.length === 1 && two[0].index === 1, JSON.stringify(two.map((a) => a.index)));
  const titled = extractArtifacts('```html\n<title>我的页面</title>\n```');
  ok('从 <title> 猜标题', titled[0].title === '我的页面', titled[0].title);
}

// ── 4. 会话/消息上限:磁盘保护,可配置,0 = 不限 ──
// 这不是额度(不拒请求、不区分管理员),但它长得像额度,所以行为必须可预期:
// 超限只删最旧的、配 0 就真的不删、非法值退回默认。
{
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cap-'));
  const mk = (opts) => createChatStore({ dir: path.join(capDir, Math.random().toString(36).slice(2)), ...opts });

  // 会话数上限
  {
    const s = mk({ maxSessions: 3 });
    for (let i = 0; i < 4; i++) {
      s.create('u', { title: 't' + i });
      // 淘汰按 updatedAt 排序,同一毫秒内创建会打平、淘汰谁就成了任意的
      // (save 还会无条件把 updatedAt 盖成 Date.now(),塞不进假时间)。
      // 真实使用不会在 1ms 内建两个会话,这里岔开时间以断言"删的是最旧那个"。
      await new Promise((r) => setTimeout(r, 3));
    }
    const left = s.list('u').map((x) => x.title);
    ok('会话超上限时只保留上限个数', left.length === 3, `剩 ${left.length}: ${left.join(',')}`);
    ok('被删掉的是最旧那个', !left.includes('t0'), left.join(','));
    ok('最新的还在', left.includes('t3'), left.join(','));
    ok('stats 报出配置的会话上限', s.stats('u').maxSessions === 3);
  }

  // 0 = 不限
  {
    const s = mk({ maxSessions: 0 });
    for (let i = 0; i < 5; i++) s.create('u', { title: 't' + i });
    ok('会话上限配 0 时不删任何会话', s.list('u').length === 5, `${s.list('u').length} 个`);
    ok('stats 里 0 原样报出(不被换成默认值)', s.stats('u').maxSessions === 0);
  }

  // 消息数上限
  {
    const s = mk({ maxMessages: 2 });
    const id = s.create('u', { title: 'm' }).session.id;
    s.save('u', { ...s.get('u', id), messages: [1, 2, 3, 4, 5].map((n) => ({ role: 'user', content: 'c' + n })) });
    const msgs = s.get('u', id).messages;
    ok('消息超上限时裁到上限', msgs.length === 2, `${msgs.length} 条`);
    ok('裁掉的是最早的', msgs[0].content === 'c4' && msgs[1].content === 'c5', JSON.stringify(msgs.map((m) => m.content)));
  }
  {
    const s = mk({ maxMessages: 0 });
    const id = s.create('u', { title: 'm' }).session.id;
    s.save('u', { ...s.get('u', id), messages: Array.from({ length: 7 }, (_, i) => ({ role: 'user', content: 'c' + i })) });
    ok('消息上限配 0 时一条不裁', s.get('u', id).messages.length === 7);
  }

  // 缺省与非法值
  {
    const d = mk({}).stats('u');
    ok('不传上限时用默认 200/500', d.maxSessions === 200 && d.maxMessages === 500, JSON.stringify(d));
    const bad = mk({ maxSessions: 'abc', maxMessages: NaN }).stats('u');
    ok('非法上限退回默认', bad.maxSessions === 200 && bad.maxMessages === 500, JSON.stringify(bad));
  }
  fs.rmSync(capDir, { recursive: true, force: true });
}

// ── 起 mock 上游 + 被测服务 ──
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-'));
const configFile = path.join(temp, 'config.json');
const TOKEN_A = 'cct-' + 'c'.repeat(32);
const TOKEN_B = 'cct-' + 'd'.repeat(32);

let lastUpstream = null; // 记录 mock 收到的最后一个请求,用于验证强制模型等
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    lastUpstream = { url: req.url, headers: req.headers, body: (() => { try { return JSON.parse(body); } catch { return null; } })() };
    if (lastUpstream.body && lastUpstream.body.model === 'boom') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'mock 拒绝' } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    send({ type: 'message_start', message: { usage: { input_tokens: 11, cache_read_input_tokens: 3 } } });
    send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一下…' } });
    send({ type: 'content_block_start', index: 1, content_block: { type: 'text' } });
    send({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } });
    send({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '世界\n```html\n<h1>hi</h1>\n```' } });
    send({ type: 'message_delta', delta: {}, usage: { output_tokens: 7 } });
    send({ type: 'message_stop' });
    res.end();
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
    clientTokens: [
      { token: TOKEN_A, name: 'dev-a' },
      { token: TOKEN_B, name: 'dev-b', overrides: { model: 'claude-forced-1' } },
    ],
    adminEnabled: true,
    adminPassword: 'admin-pw-123',
    // 故意配 0(不限)+ 一个非默认值:验证 config → chatStore 的接线,
    // 尤其是 0 不能被 `||` 当假值换回 200
    chatMaxSessions: 0,
    chatMaxMessages: 6,
    dataDir: path.join(temp, 'data'),
  }),
);

const child = spawn(process.execPath, [path.join(import.meta.dirname, '../src/server.js')], {
  env: { ...process.env, CC_TRANS_CONFIG: configFile },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
child.stdout.on('data', (d) => (srvLog += d));
child.stderr.on('data', (d) => (srvLog += d));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + '/health')).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const J = { 'content-type': 'application/json' };
const bearer = (s) => ({ authorization: 'Bearer ' + s });
const post = (p, b, h = {}) => fetch(BASE + p, { method: 'POST', headers: { ...J, ...h }, body: JSON.stringify(b || {}) });
const get = (p, h = {}) => fetch(BASE + p, { headers: h });

// 读一条 SSE 流,返回解析后的事件数组
async function readStream(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const evs = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (line) {
        try {
          evs.push(JSON.parse(line.slice(5).trim()));
        } catch {}
      }
    }
  }
  return evs;
}

// 1x1 PNG
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');

try {
  ok('服务启动', await waitUp());
  const admin = await (await post('/admin/api/login', { username: 'admin', password: 'admin-pw-123' })).json().then((d) => d.session);

  // 两个用户:alice 绑 dev-a,bob 绑有强制模型的 dev-b
  const clients = await (await get('/admin/api/clients', bearer(admin))).json();
  const idA = clients.tokens.find((t) => t.name === 'dev-a').id;
  const idB = clients.tokens.find((t) => t.name === 'dev-b').id;
  await post('/admin/api/users', { name: 'alice', password: 'alice-pw-1234', tokenIds: [idA] }, bearer(admin));
  await post('/admin/api/users', { name: 'bob', password: 'bob-pw-123456', tokenIds: [idB] }, bearer(admin));
  const sa = await (await post('/u/api/login', { username: 'alice', password: 'alice-pw-1234' })).json().then((d) => d.session);
  const sb = await (await post('/u/api/login', { username: 'bob', password: 'bob-pw-123456' })).json().then((d) => d.session);
  ok('两个用户登录成功', !!sa && !!sb);

  // ── 页面与 meta ──
  {
    const r = await get('/u/chat');
    const html = await r.text();
    ok('聊天页可访问', r.status === 200 && html.includes('给 Claude 发消息'));
    ok('聊天页内联了渲染器(零构建)', html.includes('function renderMarkdown') && !html.includes('export function renderMarkdown'));
    const meta = await (await get('/u/api/chat/meta', bearer(sa))).json();
    ok('meta 返回我的设备', meta.devices.length === 1 && meta.devices[0].name === 'dev-a');
    ok('meta 不含别人的设备', !JSON.stringify(meta.devices).includes('dev-b'));
    const metaB = await (await get('/u/api/chat/meta', bearer(sb))).json();
    ok('强制模型在 meta 里暴露给前端锁定用', metaB.devices[0].forcedModel === 'claude-forced-1');
  }

  // ── 会话 CRUD ──
  let sid = null;
  {
    const c = await (await post('/u/api/chat/sessions', { title: '第一个' }, bearer(sa))).json();
    sid = c.session.id;
    ok('创建会话', c.ok && !!sid);
    const list = await (await get('/u/api/chat/sessions', bearer(sa))).json();
    ok('会话出现在列表', list.sessions.some((s) => s.id === sid));
    // config.json 里的上限要真的传到 store(0 不能被当假值吞掉)
    ok('会话上限来自 config(0=不限)', list.stats.maxSessions === 0, JSON.stringify(list.stats));
    ok('消息上限来自 config', list.stats.maxMessages === 6, JSON.stringify(list.stats));
    await post('/u/api/chat/session/rename', { id: sid, title: '改名了' }, bearer(sa));
    const l2 = await (await get('/u/api/chat/sessions', bearer(sa))).json();
    ok('改名生效', l2.sessions.find((s) => s.id === sid).title === '改名了');
  }

  // ── 越权与路径穿越 ──
  {
    const r = await get('/u/api/chat/session?id=' + encodeURIComponent(sid), bearer(sb));
    ok('别人的会话读不到', r.status === 404, `status=${r.status}`);
    for (const evil of ['../alice/' + sid, '..%2Falice%2F' + sid, '../../config', 'a/../../b']) {
      const rr = await get('/u/api/chat/session?id=' + encodeURIComponent(evil), bearer(sb));
      ok(`路径穿越被拒(${evil.slice(0, 18)})`, rr.status === 404, `status=${rr.status}`);
    }
    const noAuth = await get('/u/api/chat/sessions');
    ok('未登录访问聊天 API 401', noAuth.status === 401);
    const adminTry = await get('/u/api/chat/sessions', bearer(admin));
    ok('管理员 session 不能用聊天 API', adminTry.status === 401);
  }

  // ── 图片 ──
  {
    const r = await post('/u/api/chat/image', { data: PNG.toString('base64'), mime: 'image/png' }, bearer(sa));
    const d = await r.json();
    ok('上传 PNG 成功', r.ok && d.ok && /\.png$/.test(d.id), d.id);
    const again = await (await post('/u/api/chat/image', { data: PNG.toString('base64'), mime: 'image/png' }, bearer(sa))).json();
    ok('同内容图片去重(同一 id)', again.id === d.id);

    const fake = await post('/u/api/chat/image', { data: Buffer.from('not an image').toString('base64'), mime: 'image/png' }, bearer(sa));
    ok('内容与声明类型不符被拒', fake.status === 400, (await fake.json()).error);
    const badMime = await post('/u/api/chat/image', { data: PNG.toString('base64'), mime: 'application/pdf' }, bearer(sa));
    ok('非图片类型被拒', badMime.status === 400);
    const huge = await post('/u/api/chat/image', { data: Buffer.alloc(6 * 1024 * 1024).toString('base64'), mime: 'image/png' }, bearer(sa));
    ok('超限图片被拒', huge.status === 400);

    const img = await get(`/u/api/chat/image?id=${encodeURIComponent(d.id)}`, bearer(sa));
    ok('能取回自己的图片', img.status === 200 && img.headers.get('content-type') === 'image/png');
    const otherImg = await get(`/u/api/chat/image?id=${encodeURIComponent(d.id)}`, bearer(sb));
    ok('取不到别人的图片', otherImg.status === 404);
  }

  // ── 流式发送 ──
  {
    const r = await post('/u/api/chat/stream', { sessionId: sid, text: '你好', model: 'claude-test-1' }, bearer(sa));
    ok('流式响应是 SSE', r.headers.get('content-type').includes('text/event-stream'));
    const evs = await readStream(r.body);
    const types = evs.map((e) => e.t);
    ok('事件序列含 start/delta/usage/done', types.includes('start') && types.includes('delta') && types.includes('usage') && types.includes('done'), types.join(','));
    const text = evs.filter((e) => e.t === 'delta').map((e) => e.v).join('');
    ok('文本增量拼接正确', text.startsWith('你好世界'), JSON.stringify(text.slice(0, 20)));
    ok('思考增量单独成事件', evs.some((e) => e.t === 'thinking' && e.v.includes('想一下')));
    const usage = evs.find((e) => e.t === 'usage');
    ok('usage 汇总正确', usage.input === 11 && usage.output === 7 && usage.cacheRead === 3, JSON.stringify(usage));

    const s = await (await get('/u/api/chat/session?id=' + sid, bearer(sa))).json();
    const msgs = s.session.messages;
    ok('会话已持久化用户与回复', msgs.length === 2 && msgs[0].role === 'user' && msgs[1].role === 'assistant');
    ok('回复内容落盘', msgs[1].content.includes('你好世界'));
    ok('思考过程落盘', (msgs[1].thinking || '').includes('想一下'));
    ok('标题自动取自首条消息', s.session.title === '改名了' || s.session.title === '你好');
    ok('回复里的 html 块能抽成 artifact', extractArtifacts(msgs[1].content).length === 1);
  }

  // ── 记账落到所选设备 ──
  {
    const me = await (await get('/u/api/me', bearer(sa))).json();
    const dev = me.devices.find((d) => d.name === 'dev-a');
    ok('聊天用量记在设备名下', dev.stats && dev.stats.requests >= 1, JSON.stringify(dev.stats && { r: dev.stats.requests, out: dev.stats.outTokens }));
    ok('输出 token 计入', dev.stats.outTokens >= 7, String(dev.stats.outTokens));
    const logs = await (await get('/u/api/logs?limit=10', bearer(sa))).json();
    ok('聊天请求出现在我的日志里', (logs.logs || []).some((e) => e.client === 'dev-a'));
  }

  // ── 强制模型:管理员策略优先于用户选择 ──
  {
    lastUpstream = null;
    const r = await post('/u/api/chat/stream', { text: '嗨', model: 'claude-user-picked' }, bearer(sb));
    await readStream(r.body);
    ok('上游收到的是被强制的模型', lastUpstream && lastUpstream.body.model === 'claude-forced-1', lastUpstream && lastUpstream.body.model);
  }

  // ── 上游报错要如实回传 ──
  {
    const r = await post('/u/api/chat/stream', { text: 'x', model: 'boom' }, bearer(sa));
    const evs = await readStream(r.body);
    const err = evs.find((e) => e.t === 'error');
    ok('上游 400 转成 error 事件', !!err && /上游 400/.test(err.message), err && err.message.slice(0, 60));
  }

  // ── 没有设备的用户不能发 ──
  {
    await post('/admin/api/users', { name: 'nodev', password: 'nodev-pw-1234', tokenIds: [] }, bearer(admin));
    const s = await (await post('/u/api/login', { username: 'nodev', password: 'nodev-pw-1234' })).json().then((d) => d.session);
    const r = await post('/u/api/chat/stream', { text: 'x', model: 'claude-test-1' }, bearer(s));
    ok('无设备用户发消息被拒 403', r.status === 403, `status=${r.status}`);
  }

  // ── 指定别人的设备也不行 ──
  {
    const r = await post('/u/api/chat/stream', { text: 'x', model: 'claude-test-1', deviceId: idB }, bearer(sa));
    ok('指定别人的设备被拒', r.status === 403, `status=${r.status}`);
  }

  // ── 删除会话 ──
  {
    await post('/u/api/chat/session/remove', { id: sid }, bearer(sa));
    const r = await get('/u/api/chat/session?id=' + sid, bearer(sa));
    ok('删除后读不到', r.status === 404);
  }
} finally {
  child.kill();
  await new Promise((r) => child.on('exit', r));
  upstream.close();
}

// ── 重启后会话仍在 ──
{
  const child2 = spawn(process.execPath, [path.join(import.meta.dirname, '../src/server.js')], {
    env: { ...process.env, CC_TRANS_CONFIG: configFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    ok('二次启动成功', await waitUp());
    const s = await (await post('/u/api/login', { username: 'alice', password: 'alice-pw-1234' })).json().then((d) => d.session);
    const list = await (await get('/u/api/chat/sessions', bearer(s))).json();
    ok('重启后会话列表仍在', Array.isArray(list.sessions) && list.sessions.length >= 1, `${(list.sessions || []).length} 个`);
  } finally {
    child2.kill();
    await new Promise((r) => child2.on('exit', r));
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {}
  }
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
