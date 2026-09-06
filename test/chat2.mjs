// 聊天机制测试(改造后新增的那些)。分两半:
//   前半是 chat_runs.js 的单元测试 —— 回合归服务端所有、断开只是取消订阅、
//   宽限期、按序号续传、快照回退、显式停止;
//   后半打一个可控的 mock 上游,端到端验:断线不丢回答、重连能接上、停止、
//   并发同一会话、分叉、改写截断、置顶、AI 标题、上下文占用、上游过载重试。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunRegistry } from '../src/chat_runs.js';
import { toAnthropicMessages, contextUsage } from '../src/chat.js';
import { freePorts } from './_ports.mjs';

const [PORT, UP_PORT] = await freePorts(2);
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

// 一个记录所有事件的假订阅者
function sink() {
  const got = [];
  let ended = false;
  return { got, send: (ev) => got.push(ev), end: () => (ended = true), isEnded: () => ended };
}

// ── 1. 回合归服务端所有 ──
{
  const runs = createRunRegistry({ graceMs: 60_000 });
  let release;
  const started = runs.start({
    key: 'u/s1',
    principal: 'u',
    sessionId: 's1',
    model: 'm',
    runner: async (api) => {
      api.emit({ t: 'delta', v: 'A' });
      api.setText('A');
      await new Promise((r) => (release = r));
      api.emit({ t: 'delta', v: 'B' });
      api.setText('AB');
      api.emit({ t: 'done' });
    },
  });
  ok('回合能启动', started.ok);
  await wait(10);

  const s1 = sink();
  const sub1 = runs.subscribe('u/s1', 0, s1);
  ok('订阅者拿到快照(不是从头重放)', sub1.ok && s1.got[0].t === 'snapshot' && s1.got[0].text === 'A', JSON.stringify(s1.got[0]));
  ok('快照带当前序号', typeof s1.got[0].n === 'number');
  ok('live() 报告有回合在跑', !!runs.live('u/s1'));

  // 订阅者走了 —— 生成不该停
  sub1.unsubscribe();
  release();
  await wait(20);
  ok('最后一个订阅者离开后回合照旧跑完', !runs.live('u/s1'));

  // 结束后短时间内还能把尾巴取回来
  const s2 = sink();
  const sub2 = runs.subscribe('u/s1', 0, s2);
  ok('结束后仍可取回内容', sub2.ok && s2.got[0].text === 'AB', JSON.stringify(s2.got[0]));
  ok('结束的回合不再挂订阅', sub2.live === false && s2.isEnded());
  runs.shutdown();
}

// ── 2. 按序号续传;序号太旧则退回快照 ──
{
  const runs = createRunRegistry({ graceMs: 60_000 });
  let go;
  runs.start({
    key: 'u/s2',
    principal: 'u',
    sessionId: 's2',
    runner: async (api) => {
      for (const ch of ['a', 'b', 'c']) {
        api.emit({ t: 'delta', v: ch });
      }
      await new Promise((r) => (go = r));
      api.emit({ t: 'delta', v: 'd' });
    },
  });
  await wait(10);
  const s = sink();
  const sub = runs.subscribe('u/s2', 2, s); // 我已经收到第 2 个事件了
  ok('带 from 续传:只补没收到的', sub.ok && s.got.length === 1 && s.got[0].t === 'delta' && s.got[0].v === 'c', JSON.stringify(s.got));
  go();
  await wait(20);
  ok('续传后继续收到新事件', s.got.some((e) => e.v === 'd'));
  runs.shutdown();
}

// ── 3. 宽限期到点才取消 ──
{
  const runs = createRunRegistry({ graceMs: 60 });
  let aborted = false;
  runs.start({
    key: 'u/s3',
    principal: 'u',
    sessionId: 's3',
    runner: async (api) => {
      api.signal.addEventListener('abort', () => (aborted = true));
      await new Promise((r) => setTimeout(r, 2000));
    },
  });
  await wait(10);
  const s = sink();
  const sub = runs.subscribe('u/s3', 0, s);
  sub.unsubscribe();
  await wait(20);
  ok('宽限期内不取消', !aborted);
  await wait(90);
  ok('宽限期到点后取消上游', aborted);
  runs.shutdown();
}

// ── 4. 宽限期内重连:计时器要被撤掉 ──
{
  const runs = createRunRegistry({ graceMs: 80 });
  let aborted = false;
  runs.start({
    key: 'u/s4',
    principal: 'u',
    sessionId: 's4',
    runner: async (api) => {
      api.signal.addEventListener('abort', () => (aborted = true));
      await new Promise((r) => setTimeout(r, 400));
    },
  });
  await wait(10);
  const a = sink();
  runs.subscribe('u/s4', 0, a).unsubscribe();
  await wait(40);
  const b = sink();
  runs.subscribe('u/s4', 0, b); // 回来了
  await wait(120);
  ok('宽限期内重连后不再取消', !aborted);
  runs.shutdown();
}

// ── 5. graceMs=0 = 旧语义(断开即取消)──
{
  const runs = createRunRegistry({ graceMs: 0 });
  let aborted = false;
  runs.start({
    key: 'u/s5',
    principal: 'u',
    sessionId: 's5',
    runner: async (api) => {
      api.signal.addEventListener('abort', () => (aborted = true));
      await new Promise((r) => setTimeout(r, 500));
    },
  });
  await wait(10);
  runs.subscribe('u/s5', 0, sink()).unsubscribe();
  await wait(20);
  ok('配 0 时断开立即取消(保留旧行为的开关)', aborted);
  runs.shutdown();
}

// ── 6. 显式停止 vs 断线,runner 能区分 ──
{
  const runs = createRunRegistry({ graceMs: 60_000 });
  let sawStop = null;
  runs.start({
    key: 'u/s6',
    principal: 'u',
    sessionId: 's6',
    runner: async (api) => {
      await new Promise((r) => api.signal.addEventListener('abort', r));
      sawStop = { byUser: api.stoppedByUser(), byDisconnect: api.abortedByDisconnect() };
    },
  });
  await wait(10);
  const r = runs.stop('u/s6');
  ok('stop() 成功', r.ok);
  await wait(20);
  ok('runner 知道这是用户点的停止', sawStop && sawStop.byUser === true && sawStop.byDisconnect === false, JSON.stringify(sawStop));
  ok('停完就没有活跃回合了', !runs.live('u/s6'));
  ok('对已结束的回合再 stop 会明确失败', !runs.stop('u/s6').ok);
  runs.shutdown();
}

// ── 7. 同一会话不并发 ──
{
  const runs = createRunRegistry({ graceMs: 60_000 });
  const mk = () =>
    runs.start({ key: 'u/s7', principal: 'u', sessionId: 's7', runner: () => new Promise((r) => setTimeout(r, 300)) });
  ok('第一次启动成功', mk().ok);
  const second = mk();
  ok('同一会话第二次启动被拒并给出在跑的那个', !second.ok && second.busy === true && !!second.run);
  runs.shutdown();
}

// ── 8. 每个用户的并发回合有上限 ──
{
  const runs = createRunRegistry({ graceMs: 60_000, maxPerPrincipal: 2 });
  const mk = (i) =>
    runs.start({ key: 'u/x' + i, principal: 'u', sessionId: 'x' + i, runner: () => new Promise((r) => setTimeout(r, 300)) });
  ok('第 1 个会话可开', mk(1).ok);
  ok('第 2 个会话可开', mk(2).ok);
  const third = mk(3);
  ok('超过上限被拒且给出原因', !third.ok && !third.busy && /不能超过/.test(third.error || ''), third.error);
  // 换个人不受影响 —— 上限是按人算的
  ok('别人不受这个人的上限影响', runs.start({ key: 'v/y', principal: 'v', sessionId: 'y', runner: () => wait(10) }).ok);
  runs.shutdown();
}

// ── 9. runner 抛异常也要收尾,不能把回合永远挂着 ──
{
  const runs = createRunRegistry({ graceMs: 60_000 });
  runs.start({ key: 'u/s9', principal: 'u', sessionId: 's9', runner: async () => { throw new Error('炸了'); } });
  await wait(30);
  ok('runner 抛异常后回合被标记结束', !runs.live('u/s9'));
  runs.shutdown();
}

// ── 10. 消息转换:缓存断点与图片 ──
{
  const msgs = [
    { role: 'user', content: '一' },
    { role: 'assistant', content: '二' },
    { role: 'user', content: '三' },
  ];
  const plain = toAnthropicMessages(msgs, () => null);
  ok('不打缓存断点时全是裸字符串', plain.every((m) => typeof m.content === 'string'));

  const cached = toAnthropicMessages(msgs, () => null, { cacheBreak: true });
  const last = cached[cached.length - 1];
  ok('打了断点的那条被摊成 block', Array.isArray(last.content));
  ok('断点落在最后一个 block 上', last.content[last.content.length - 1].cache_control.type === 'ephemeral');
  ok('前面的消息不带断点', typeof cached[0].content === 'string');

  // 失败的回复不进上下文 —— 否则模型会把报错当成自己说过的话
  const withErr = toAnthropicMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: '', error: '上游 500' }], () => null);
  ok('出错的回复不进上下文', withErr.length === 1 && withErr[0].role === 'user');

  // 图片:block 在前、文字在后
  const withImg = toAnthropicMessages(
    [{ role: 'user', content: '看图', images: [{ id: 'x.png' }] }],
    () => ({ mime: 'image/png', buf: Buffer.from([1, 2, 3]) }),
  );
  ok('图片转成 base64 image block', withImg[0].content[0].type === 'image' && withImg[0].content[0].source.type === 'base64');
  ok('文字跟在图片后面', withImg[0].content[1].type === 'text');
}

// ── 11. 上下文占用 ──
{
  const measured = contextUsage(
    { model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo', usage: { input: 1000, output: 200, cacheRead: 500 } }] },
    'claude-opus-4-8',
  );
  ok('有真实 usage 时用真实数字', measured.source === 'measured' && measured.used === 1700, JSON.stringify(measured));
  ok('200k 是默认窗口', measured.window === 200_000);
  ok('百分比算得对', Math.abs(measured.percent - 0.85) < 0.01, String(measured.percent));

  const est = contextUsage({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'x'.repeat(3200) }] }, 'claude-opus-4-8');
  ok('没有 usage 时退回字数估算', est.source === 'estimate' && est.used === 1000, JSON.stringify(est));

  const big = contextUsage({ model: 'claude-sonnet-5[1m]', messages: [] }, 'claude-sonnet-5[1m]');
  ok('[1m] 变体窗口是 1M', big.window === 1_000_000);
}

// ── 起 mock 上游 + 被测服务 ────────────────────────────────────────────
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat2-'));
const configFile = path.join(temp, 'config.json');
const TOKEN_A = 'cct-' + 'e'.repeat(32);

const seen = []; // 所有上游请求(用来检查请求体)
let flakyLeft = 0; // 还要回几次 529

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    let j = null;
    try { j = JSON.parse(body); } catch {}
    seen.push({ url: req.url, body: j });

    // 非流式请求 = 生成标题那一条。回一段 JSON,让标题功能真的走通。
    if (j && j.stream === false) {
      const payload = {
        id: 'msg_title',
        content: [{ type: 'text', text: '{"title": "关于缓存的讨论"}' }],
        usage: { input_tokens: 40, output_tokens: 9 },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(payload));
    }

    // 过载:前 flakyLeft 次回 529,之后正常 —— 用来验退避重试
    if (flakyLeft > 0) {
      flakyLeft--;
      res.writeHead(529, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: '过载了' } }));
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    send({ type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 5 } } });

    // 带了 web_search 工具就把服务端工具那一套块也发出来 —— 这些块的形状是
    // 从真实上游抓下来的(server_tool_use → 查询词走 input_json_delta →
    // web_search_tool_result 的 content 是【数组】→ citations_delta)
    const hasSearch = j && (j.tools || []).some((t) => String(t.type || '').startsWith('web_search'));
    if (hasSearch) {
      send({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'LRU 缓存"}' } });
      send({ type: 'content_block_stop', index: 0 });
      send({
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [
            { type: 'web_search_result', title: '维基百科 · 缓存算法', url: 'https://example.test/lru' },
            { type: 'web_search_result', title: '同一个页面又被命中一次', url: 'https://example.test/lru' },
            { type: 'web_search_result', title: '另一个来源', url: 'https://other.test/cache' },
          ],
        },
      });
      send({ type: 'content_block_stop', index: 1 });
      send({ type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', title: '维基百科 · 缓存算法', url: 'https://example.test/lru' } } });
    }
    // 声明了 web_search 但上游把 content 回成【错误对象】而不是数组 —— 服务端工具
    // 失败就是这个形状(HTTP 200,不抛异常),必须先分支再索引
    if (j && /搜索失败/.test(JSON.stringify(j.messages || []))) {
      send({ type: 'content_block_start', index: 5, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_9', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } } });
      send({ type: 'content_block_stop', index: 5 });
    }
    // 慢流:每段之间留够时间,好让测试在中途断开
    const slow = j && /slow/.test(String(j.model || ''));
    const chunks = slow ? ['第一段。', '第二段。', '第三段。', '第四段。'] : ['你好', '世界'];
    for (const c of chunks) {
      if (res.writableEnded) return;
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } });
      if (slow) await wait(160);
    }
    send({ type: 'message_delta', delta: {}, usage: { output_tokens: 12 } });
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
    clientTokens: [{ token: TOKEN_A, name: 'dev-a' }],
    adminEnabled: true,
    adminPassword: 'admin-pw-1234',
    dataDir: path.join(temp, 'data'),
    // 断线保活:给足时间,好让测试断开后再回来接
    chatDisconnectGraceMs: 30_000,
    chatMaxRetries: 2,
  }),
);

const child = spawn(process.execPath, [path.join(import.meta.dirname, '../src/server.js')], {
  env: { ...process.env, CC_TRANS_CONFIG: configFile },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
child.stdout.on('data', (d) => (srvLog += d));
child.stderr.on('data', (d) => (srvLog += d));

const J = { 'content-type': 'application/json' };
const bearer = (s) => ({ authorization: 'Bearer ' + s });
const post = (p, b, h = {}) => fetch(BASE + p, { method: 'POST', headers: { ...J, ...h }, body: JSON.stringify(b || {}) });
const get = (p, h = {}) => fetch(BASE + p, { headers: h });

async function readStream(body, onEvent) {
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
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim());
        evs.push(ev);
        if (onEvent) onEvent(ev, reader);
      } catch {}
    }
  }
  return evs;
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await get('/health')).ok) return true;
    } catch {}
    await wait(150);
  }
  return false;
}

try {
  ok('服务启动', await waitUp());
  const admin = await (await post('/admin/api/login', { username: 'admin', password: 'admin-pw-1234' })).json().then((d) => d.session);
  const clients = await (await get('/admin/api/clients', bearer(admin))).json();
  const devA = clients.tokens.find((t) => t.name === 'dev-a').id;
  await post('/admin/api/users', { name: 'kim', password: 'kim-pw-123456', tokenIds: [devA] }, bearer(admin));
  const S = await (await post('/u/api/login', { username: 'kim', password: 'kim-pw-123456' })).json().then((d) => d.session);
  ok('用户登录', !!S);

  // ── 12. meta 把断线宽限期告诉前端 ──
  {
    const m = await (await get('/u/api/chat/meta', bearer(S))).json();
    ok('meta 带断线宽限期', m.disconnectGraceMs === 30_000, String(m.disconnectGraceMs));
    ok('meta 带模型上下文窗口', (m.models || []).every((x) => x.contextWindow > 0));
    ok('meta 带自动标题开关与重试次数', m.autoTitle === true && m.maxRetries === 2);
  }

  // ── 13. 断线不丢回答(本次改造的核心)──
  let sidKeep = null;
  {
    const r = await post('/u/api/chat/stream', { text: '讲讲缓存', model: 'slow-model' }, bearer(S));
    ok('流开起来了', r.ok);
    // 读到第一段就把连接掐掉 —— 模拟"手机锁屏 / 刷新页面 / 地铁里断网"
    let sid = null;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let sawDelta = 0;
    while (sawDelta < 1) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const line of buf.split('\n\n')) {
        const l = line.split('\n').find((x) => x.startsWith('data:'));
        if (!l) continue;
        try {
          const ev = JSON.parse(l.slice(5).trim());
          if (ev.t === 'start') sid = ev.sessionId;
          if (ev.t === 'delta') sawDelta++;
        } catch {}
      }
    }
    sidKeep = sid;
    await reader.cancel(); // 客户端走了
    ok('拿到了会话 id 且已经开始输出', !!sid && sawDelta >= 1);

    // 服务端应当把这一轮跑完(mock 慢流总长约 640ms)
    await wait(1400);
    const d = await (await get('/u/api/chat/session?id=' + encodeURIComponent(sid), bearer(S))).json();
    const reply = (d.session.messages || []).find((m) => m.role === 'assistant');
    ok('断开后回答仍然被完整保存', !!reply && reply.content.includes('第四段。'), reply && reply.content);
    ok('没有被标成"用户点了停止"', !(reply && reply.stopped));
    ok('也没被标成断线超时(宽限期内跑完了)', !(reply && reply.disconnected));
    ok('用量照样记下来了', !!(reply && reply.usage && reply.usage.output));
    ok('这一轮已经结束(live 为空)', !d.live);
  }

  // ── 14. 重连接回正在跑的回合 ──
  {
    const r = await post('/u/api/chat/stream', { text: '再来一次', model: 'slow-model' }, bearer(S));
    let sid = null;
    let lastN = 0;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let n = 0;
    while (n < 1) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const line of buf.split('\n\n')) {
        const l = line.split('\n').find((x) => x.startsWith('data:'));
        if (!l) continue;
        try {
          const ev = JSON.parse(l.slice(5).trim());
          if (ev.t === 'start') sid = ev.sessionId;
          if (typeof ev.n === 'number') lastN = Math.max(lastN, ev.n);
          if (ev.t === 'delta') n++;
        } catch {}
      }
    }
    await reader.cancel();

    // 会话接口要如实报告"这条还在跑"
    const mid = await (await get('/u/api/chat/session?id=' + encodeURIComponent(sid), bearer(S))).json();
    ok('会话接口报告有回合在跑', !!mid.live && mid.live.seq >= lastN, JSON.stringify(mid.live));

    // 接回去,续读剩下的
    const at = await get(`/u/api/chat/attach?sessionId=${encodeURIComponent(sid)}&from=${lastN}`, bearer(S));
    ok('attach 接上了', at.ok);
    const evs = await readStream(at.body);
    const text = evs.filter((e) => e.t === 'delta').map((e) => e.v).join('');
    ok('续传拿到剩下的内容', text.includes('第四段。'), JSON.stringify(text));
    ok('续传里不重复已经收到的第一段', !text.includes('第一段。'), text);
    ok('续传以 done 收尾', evs.some((e) => e.t === 'done'));

    // from=0 要给快照(内容不缺,只是没有逐字动画)
    const at2 = await get(`/u/api/chat/attach?sessionId=${encodeURIComponent(sid)}&from=0`, bearer(S));
    const evs2 = await readStream(at2.body);
    ok('已结束的回合 attach 时明确说 gone 或补快照', evs2.length > 0 && ['snapshot', 'gone'].includes(evs2[0].t), JSON.stringify(evs2[0] && evs2[0].t));
  }

  // ── 15. 显式停止 ──
  {
    const r = await post('/u/api/chat/stream', { text: '停我', model: 'slow-model' }, bearer(S));
    let sid = null;
    const evs = [];
    // 边读边在拿到第一段后发停止
    const done = readStream(r.body, (ev) => {
      evs.push(ev);
      if (ev.t === 'start') sid = ev.sessionId;
      if (ev.t === 'delta' && sid && !stopped) {
        stopped = true;
        post('/u/api/chat/stop', { sessionId: sid }, bearer(S));
      }
    });
    let stopped = false;
    await done;
    const doneEv = evs.find((e) => e.t === 'done');
    ok('停止后流会收尾', !!doneEv);
    ok('done 里标明是用户停的', doneEv && doneEv.stopped === true, JSON.stringify(doneEv));

    const d = await (await get('/u/api/chat/session?id=' + encodeURIComponent(sid), bearer(S))).json();
    const reply = [...(d.session.messages || [])].reverse().find((m) => m.role === 'assistant');
    ok('已生成的部分仍然保留(不白等)', !!reply && reply.content.length > 0, reply && reply.content);
    ok('消息上标了"已停止"', !!(reply && reply.stopped));
    ok('停止后 live 为空', !d.live);
    // 没有进行中的回合时,stop 要明确失败而不是假装成功
    ok('对没有回合的会话 stop 返回 404', (await post('/u/api/chat/stop', { sessionId: sid }, bearer(S))).status === 404);
  }

  // ── 16. 同一会话并发发送:回 409 并给出可接回的 live ──
  {
    const r1 = await post('/u/api/chat/stream', { text: 'A', sessionId: sidKeep, model: 'slow-model' }, bearer(S));
    const reader = r1.body.getReader();
    await reader.read(); // 让它真的开起来
    const r2 = await post('/u/api/chat/stream', { text: 'B', sessionId: sidKeep, model: 'slow-model' }, bearer(S));
    ok('同一会话再发一条得到 409', r2.status === 409, `status=${r2.status}`);
    const d2 = await r2.json();
    ok('409 里带上可以接回去的 live 信息', !!d2.live && typeof d2.live.seq === 'number', JSON.stringify(d2.live));
    await post('/u/api/chat/stop', { sessionId: sidKeep }, bearer(S));
    await reader.cancel();
    await wait(200);
  }

  // ── 17. AI 生成标题 ──
  {
    const r = await post('/u/api/chat/stream', { text: '解释一下 HTTP 缓存', model: 'claude-x' }, bearer(S));
    const evs = await readStream(r.body);
    const sid = evs.find((e) => e.t === 'start').sessionId;
    // 标题在 done 之后生成,流关掉时它已经落盘了
    const list = await (await get('/u/api/chat/sessions', bearer(S))).json();
    const row = list.sessions.find((s) => s.id === sid);
    ok('标题被 AI 换成了简短标题', row && row.title === '关于缓存的讨论', row && row.title);
    ok('标记了标题来源是 ai', row && row.titleFrom === 'ai', row && row.titleFrom);
    ok('流里也推了一个 title 事件', evs.some((e) => e.t === 'title' && e.title === '关于缓存的讨论'));
    ok('生成标题走的是便宜模型', seen.some((s) => s.body && s.body.stream === false && /haiku/i.test(String(s.body.model || ''))), JSON.stringify(seen.filter((s) => s.body && s.body.stream === false).map((s) => s.body.model)));

    // 手改标题后要上锁 —— AI 不能把用户起的名字盖掉
    await post('/u/api/chat/session/rename', { id: sid, title: '我自己起的名字' }, bearer(S));
    const t2 = await post('/u/api/chat/title', { id: sid }, bearer(S));
    ok('手动触发重新生成标题可用', t2.ok);
    await post('/u/api/chat/session/rename', { id: sid, title: '锁住的名字' }, bearer(S));
    const r3 = await post('/u/api/chat/stream', { text: '继续', sessionId: sid, model: 'claude-x' }, bearer(S));
    await readStream(r3.body);
    const list3 = await (await get('/u/api/chat/sessions', bearer(S))).json();
    ok('手改过的标题不会被 AI 覆盖', list3.sessions.find((s) => s.id === sid).title === '锁住的名字');
    ok('rename 后来源标为 manual', list3.sessions.find((s) => s.id === sid).titleFrom === 'manual');
  }

  // ── 18. 上下文占用随对话增长 ──
  {
    const c = await (await post('/u/api/chat/sessions', { title: 'ctx' }, bearer(S))).json();
    const before = await (await get('/u/api/chat/session?id=' + c.session.id, bearer(S))).json();
    ok('空会话没有占用', !before.context.used);
    const r = await post('/u/api/chat/stream', { text: '你好', sessionId: c.session.id, model: 'claude-x' }, bearer(S));
    const evs = await readStream(r.body);
    const doneEv = evs.find((e) => e.t === 'done');
    ok('done 里带上下文占用', !!(doneEv && doneEv.context && doneEv.context.used > 0), JSON.stringify(doneEv && doneEv.context));
    ok('占用来自上游实际 usage', doneEv.context.source === 'measured', doneEv.context.source);
  }

  // ── 19. 分叉 ──
  let forkSrc = null;
  {
    const c = await (await post('/u/api/chat/sessions', { title: '原对话' }, bearer(S))).json();
    forkSrc = c.session.id;
    await readStream((await post('/u/api/chat/stream', { text: '第一问', sessionId: forkSrc, model: 'claude-x' }, bearer(S))).body);
    await readStream((await post('/u/api/chat/stream', { text: '第二问', sessionId: forkSrc, model: 'claude-x' }, bearer(S))).body);
    const full = await (await get('/u/api/chat/session?id=' + forkSrc, bearer(S))).json();
    ok('原对话有 4 条消息', full.session.messages.length === 4, String(full.session.messages.length));

    // 从第 2 条(下标 1,第一次回答)处分叉
    const f = await post('/u/api/chat/session/fork', { id: forkSrc, upto: 1 }, bearer(S));
    const fd = await f.json();
    ok('分叉成功', f.ok && fd.ok && !!fd.session);
    ok('分叉只带到指定位置', fd.session.messages.length === 2, String(fd.session.messages.length));
    ok('分叉记下了出处', fd.session.forkedFrom && fd.session.forkedFrom.id === forkSrc && fd.session.forkedFrom.at === 2, JSON.stringify(fd.session.forkedFrom));
    const after = await (await get('/u/api/chat/session?id=' + forkSrc, bearer(S))).json();
    ok('原对话没被改动', after.session.messages.length === 4);

    // 越权:分叉别人的会话
    const other = await (await post('/admin/api/users', { name: 'eve', password: 'eve-pw-123456', tokenIds: [devA] }, bearer(admin))).json();
    const se = await (await post('/u/api/login', { username: 'eve', password: 'eve-pw-123456' })).json().then((d) => d.session);
    ok('分叉别人的会话 404', (await post('/u/api/chat/session/fork', { id: forkSrc }, bearer(se))).status === 404);
    ok('截断别人的会话 404', (await post('/u/api/chat/session/truncate', { id: forkSrc, index: 0 }, bearer(se))).status === 404);
    ok('停止别人的会话不会成功', (await post('/u/api/chat/stop', { sessionId: forkSrc }, bearer(se))).status === 404);
    ok('接回别人的回合拿不到内容', (await readStream((await get('/u/api/chat/attach?sessionId=' + forkSrc, bearer(se))).body))[0].t === 'gone');
  }

  // ── 20. 改写提问 = 截断 + 重发 ──
  {
    const before = await (await get('/u/api/chat/session?id=' + forkSrc, bearer(S))).json();
    ok('截断前 4 条', before.session.messages.length === 4);
    const t = await post('/u/api/chat/session/truncate', { id: forkSrc, index: 2 }, bearer(S));
    ok('截断成功', t.ok);
    const mid = await (await get('/u/api/chat/session?id=' + forkSrc, bearer(S))).json();
    ok('截断到指定下标', mid.session.messages.length === 2, String(mid.session.messages.length));
    await readStream((await post('/u/api/chat/stream', { text: '改写后的第二问', sessionId: forkSrc, model: 'claude-x' }, bearer(S))).body);
    const after = await (await get('/u/api/chat/session?id=' + forkSrc, bearer(S))).json();
    ok('重发后又是 4 条', after.session.messages.length === 4);
    ok('第 3 条是改写后的内容', after.session.messages[2].content === '改写后的第二问', after.session.messages[2].content);
    // 下标越界要挡住
    ok('越界下标被拒', (await post('/u/api/chat/session/truncate', { id: forkSrc, index: 99 }, bearer(S))).status === 400);
    ok('负下标被拒', (await post('/u/api/chat/session/truncate', { id: forkSrc, index: -1 }, bearer(S))).status === 400);
  }

  // ── 21. 置顶与列表摘要 ──
  {
    const list = await (await get('/u/api/chat/sessions', bearer(S))).json();
    const oldest = list.sessions[list.sessions.length - 1];
    ok('列表带摘要(标题之外还要知道聊了什么)', list.sessions.some((s) => s.preview), JSON.stringify(list.sessions[0] && list.sessions[0].preview));
    const p = await post('/u/api/chat/session/pin', { id: oldest.id, pinned: true }, bearer(S));
    ok('置顶成功', p.ok);
    const l2 = await (await get('/u/api/chat/sessions', bearer(S))).json();
    ok('置顶的排到最前(压过时间序)', l2.sessions[0].id === oldest.id, l2.sessions[0].id);
    ok('置顶标记回读得到', l2.sessions[0].pinned === true);
    await post('/u/api/chat/session/pin', { id: oldest.id, pinned: false }, bearer(S));
    const l3 = await (await get('/u/api/chat/sessions', bearer(S))).json();
    // 置顶/取消置顶不是"说话",不该刷新 updatedAt —— 否则它会跳到列表最前,
    // 而列表顺序是这里唯一的导航方式(改名同理)
    ok('取消置顶后回到原来的时间序位置', l3.sessions[l3.sessions.length - 1].id === oldest.id, l3.sessions[l3.sessions.length - 1].id);
    ok('不存在的会话置顶失败', (await post('/u/api/chat/session/pin', { id: 'nopezzz', pinned: true }, bearer(S))).status === 400);

    // 改名同样不该改变排序
    const l4 = await (await get('/u/api/chat/sessions', bearer(S))).json();
    const tail = l4.sessions[l4.sessions.length - 1];
    await post('/u/api/chat/session/rename', { id: tail.id, title: '只是改个名字' }, bearer(S));
    const l5 = await (await get('/u/api/chat/sessions', bearer(S))).json();
    ok('改名不会把老对话顶到最前', l5.sessions[l5.sessions.length - 1].id === tail.id, l5.sessions[0].id);
    ok('改名本身生效了', l5.sessions[l5.sessions.length - 1].title === '只是改个名字');
  }

  // ── 22. 上游过载:退避重试并把过程告诉前端 ──
  {
    const errsBefore = await (await get('/u/api/me', bearer(S)))
      .json()
      .then((d) => (d.devices[0].stats || {}).errors || 0);
    flakyLeft = 2; // 前两次 529,第三次成功
    const r = await post('/u/api/chat/stream', { text: '重试测试', model: 'claude-x' }, bearer(S));
    const evs = await readStream(r.body);
    const retries = evs.filter((e) => e.t === 'retry');
    ok('过载时会重试而不是直接失败', retries.length === 2, `retry 次数=${retries.length}`);
    ok('重试事件带次数与状态码', retries[0].attempt === 1 && retries[0].max === 2 && retries[0].status === 529, JSON.stringify(retries[0]));
    ok('退避时间递增', retries[1].delayMs > retries[0].delayMs, `${retries[0].delayMs} → ${retries[1].delayMs}`);
    const text = evs.filter((e) => e.t === 'delta').map((e) => e.v).join('');
    ok('重试之后拿到了正常回复', text.includes('你好'), text);
    ok('内容没有因为重试而重复', (text.match(/你好/g) || []).length === 1, text);

    // 被重试掉的那两次也要进「错误数」:它们确实打到了上游、确实失败了。
    // 不记的话,管理台的错误曲线上看不出上游正在抽风,而那正是最该看见的事。
    const errsAfter = await (await get('/u/api/me', bearer(S)))
      .json()
      .then((d) => (d.devices[0].stats || {}).errors || 0);
    ok('被重试掉的失败也计入错误数', errsAfter - errsBefore === 2, `${errsBefore} → ${errsAfter}`);

    // 超过重试上限就如实报错
    flakyLeft = 5;
    const r2 = await post('/u/api/chat/stream', { text: '一直过载', model: 'claude-x' }, bearer(S));
    const evs2 = await readStream(r2.body);
    ok('重试用尽后如实报错', evs2.some((e) => e.t === 'error' && /529/.test(String(e.message || '') + String(e.status || ''))), JSON.stringify(evs2.filter((e) => e.t === 'error')));
    flakyLeft = 0;
  }

  // ── 23. 长对话才打缓存断点(短对话打了是净亏)──
  {
    const c = await (await post('/u/api/chat/sessions', { title: 'cache' }, bearer(S))).json();
    const short = seen.length;
    await readStream((await post('/u/api/chat/stream', { text: '短', sessionId: c.session.id, model: 'claude-x' }, bearer(S))).body);
    const shortReq = seen.slice(short).find((s) => s.body && s.body.stream === true);
    const hasCache = (b) => JSON.stringify(b.messages || []).includes('cache_control');
    ok('短对话不打缓存断点', shortReq && !hasCache(shortReq.body));

    const mark = seen.length;
    await readStream((await post('/u/api/chat/stream', { text: 'x'.repeat(2500), sessionId: c.session.id, model: 'claude-x' }, bearer(S))).body);
    const longReq = seen.slice(mark).find((s) => s.body && s.body.stream === true);
    ok('长对话打上缓存断点', longReq && hasCache(longReq.body));
  }

  // ── 24. 删除正在生成的会话:回合要先被掐掉 ──
  {
    const c = await (await post('/u/api/chat/sessions', { title: 'del-live' }, bearer(S))).json();
    const r = await post('/u/api/chat/stream', { text: '慢慢说', sessionId: c.session.id, model: 'slow-model' }, bearer(S));
    const reader = r.body.getReader();
    await reader.read();
    ok('删除成功', (await post('/u/api/chat/session/remove', { id: c.session.id }, bearer(S))).ok);
    await reader.cancel();
    await wait(900);
    const list = await (await get('/u/api/chat/sessions', bearer(S))).json();
    // 关键:被删的会话不能因为 runner 落盘又冒出来
    ok('被删的会话不会因为落盘又回来', !list.sessions.some((s) => s.id === c.session.id), JSON.stringify(list.sessions.map((s) => s.id)));
  }
  // ── 25. 附件:PDF → document block,文本 → 内联正文 ──
  {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);
    const up = await post('/u/api/chat/file', { data: pdf.toString('base64'), mime: 'application/pdf', name: '说明书.pdf' }, bearer(S));
    const d = await up.json();
    ok('PDF 上传成功', up.ok && d.ok && d.kind === 'pdf', JSON.stringify(d));
    ok('返回了原始文件名', d.name === '说明书.pdf');

    // 魔数不对的要挡掉:改个扩展名就传上来的二进制,进了 document block 只会白烧一次额度
    const fake = await post('/u/api/chat/file', { data: Buffer.from('not a pdf at all').toString('base64'), mime: 'application/pdf', name: 'x.pdf' }, bearer(S));
    ok('假 PDF 被魔数挡下', fake.status === 400 && /不是 PDF/.test((await fake.json()).error || ''));

    const txt = await post('/u/api/chat/file', { data: Buffer.from('const a = 1;\n').toString('base64'), mime: '', name: 'main.js' }, bearer(S));
    const td = await txt.json();
    ok('代码文件按文本收下', txt.ok && td.kind === 'text', JSON.stringify(td));

    // 二进制伪装成 .txt:内联进正文会变成一大片乱码
    const bin = await post('/u/api/chat/file', { data: Buffer.from([0x00, 0x01, 0xff, 0xfe]).toString('base64'), mime: 'text/plain', name: 'a.txt' }, bearer(S));
    ok('二进制伪装成文本被挡下', bin.status === 400 && /不是纯文本/.test((await bin.json()).error || ''));

    const zip = await post('/u/api/chat/file', { data: 'AAAA', mime: 'application/zip', name: 'a.zip' }, bearer(S));
    ok('不支持的类型明确拒绝', zip.status === 400 && /不支持/.test((await zip.json()).error || ''));

    // 「宣称的上限」必须真的能传上去。
    //
    // 这里曾经自相矛盾:readJson 把 HTTP body 卡在 12MiB,而 body 是 base64
    // (膨胀 4/3),于是真实文件超过约 9MiB 就爆 —— 可界面写的是「PDF ≤ 20MB」。
    // 更糟的是超限时服务端直接 req.destroy() 掐连接,不回状态码,
    // 浏览器那头 fetch 抛的是 TypeError 而不是一个能读的响应,
    // 前端于是【什么都不显示】。用户看到的就是"拖进去没反应"。
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(15 * 1024 * 1024, 0x20)]);
    let bigOk = false, bigNote = '';
    try {
      const bigUp = await post('/u/api/chat/file', { data: big.toString('base64'), mime: 'application/pdf', name: '大报告.pdf' }, bearer(S));
      const bigD = await bigUp.json().catch(() => ({}));
      bigOk = bigUp.ok && bigD.ok === true;
      bigNote = `status=${bigUp.status} ${JSON.stringify(bigD).slice(0, 120)}`;
    } catch (e) {
      // 连接被掐 → fetch 直接抛。这正是浏览器里"什么都没发生"的那一刻。
      bigNote = 'FETCH-THREW: ' + e.message;
    }
    ok('15MB 的 PDF(在宣称的 20MB 之内)能传上去', bigOk, bigNote);

    // 真超限的时候要给一个【读得到的】响应,而不是把连接掐了
    const over = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(21 * 1024 * 1024, 0x20)]);
    let overStatus = 0, overErr = '';
    try {
      const r = await post('/u/api/chat/file', { data: over.toString('base64'), mime: 'application/pdf', name: '太大.pdf' }, bearer(S));
      overStatus = r.status;
      overErr = ((await r.json().catch(() => ({}))).error) || '';
    } catch (e) {
      overErr = 'FETCH-THREW: ' + e.message;   // 连接被掐 → 前端没法讲清哪里错了
    }
    ok('超过上限时回一个能读的响应(不是掐连接)', overStatus >= 400 && overStatus < 500, `status=${overStatus} err=${overErr}`);
    ok('超限的报错说得清是文件太大', /太大|过大|上限|超过/.test(overErr), overErr);

    // 发一条带 PDF + 代码文件的消息,验请求体的块结构
    const mark = seen.length;
    const c = await (await post('/u/api/chat/sessions', { title: 'atts' }, bearer(S))).json();
    await readStream((await post('/u/api/chat/stream', {
      text: '看看这两个附件', sessionId: c.session.id, model: 'claude-x',
      files: [{ id: d.id, kind: 'pdf', name: d.name }, { id: td.id, kind: 'text', name: td.name }],
    }, bearer(S))).body);
    const req = seen.slice(mark).find((x) => x.body && x.body.stream === true);
    const blocks = req.body.messages[req.body.messages.length - 1].content;
    ok('PDF 走 document block', Array.isArray(blocks) && blocks.some((b) => b.type === 'document' && b.source.media_type === 'application/pdf'));
    // 顺序有讲究:document 必须排在文字块【前面】,这是 API 的要求
    ok('document 排在文字块前面', blocks.findIndex((b) => b.type === 'document') < blocks.findIndex((b) => b.type === 'text'));
    ok('PDF 带上了文件名', blocks.find((b) => b.type === 'document').title === '说明书.pdf');
    const textBlock = blocks.find((b) => b.type === 'text').text;
    ok('文本文件内联进了正文', textBlock.includes('main.js') && textBlock.includes('const a = 1;'));
    ok('内联的同时保留了用户原话', textBlock.includes('看看这两个附件'));
    // 取回附件 —— 必须在删会话【之前】测:删会话会触发引用清扫,文件真的会被删掉
    const back = await get('/u/api/chat/file?id=' + encodeURIComponent(td.id), bearer(S));
    ok('附件能取回', back.ok && (await back.text()).includes('const a = 1;'));
    const eveS = await (await post('/u/api/login', { username: 'eve', password: 'eve-pw-123456' })).json().then((x) => x.session);
    ok('别人取不到我的附件', (await get('/u/api/chat/file?id=' + encodeURIComponent(td.id), bearer(eveS))).status === 404);

    // 附件也要参与引用清扫,否则删了会话它们永远留在盘上
    const before = (await (await get('/u/api/chat/sessions', bearer(S))).json()).stats.mediaCount;
    await post('/u/api/chat/session/remove', { id: c.session.id }, bearer(S));
    const after = (await (await get('/u/api/chat/sessions', bearer(S))).json()).stats.mediaCount;
    ok('删会话后附件被清掉', after < before, `${before} → ${after}`);
  }

  // ── 26. 联网搜索:服务端工具 ──
  {
    const mark = seen.length;
    const c = await (await post('/u/api/chat/sessions', { title: 'search' }, bearer(S))).json();
    const evs = await readStream((await post('/u/api/chat/stream', {
      text: 'LRU 是什么', sessionId: c.session.id, model: 'claude-x', mode: 'search',
    }, bearer(S))).body);
    const req = seen.slice(mark).find((x) => x.body && x.body.stream === true);
    ok('请求里挂上了 web_search 工具', (req.body.tools || []).some((t) => t.type === 'web_search_20250305' && t.name === 'web_search'), JSON.stringify(req.body.tools));
    ok('给了检索次数上限', (req.body.tools || [])[0].max_uses > 0);
    // thinking.display 必须显式要摘要 —— 不传的话 Opus 4.7+ 的思考文本恒为空
    ok('thinking 显式要了摘要', req.body.thinking && req.body.thinking.display === 'summarized', JSON.stringify(req.body.thinking));

    ok('推了 tool_start', evs.some((e) => e.t === 'tool_start' && e.name === 'web_search'));
    const q = evs.find((e) => e.t === 'tool_query');
    ok('查询词被完整拼出来(跨多个 input_json_delta)', q && q.query === 'LRU 缓存', q && q.query);
    const tr = evs.find((e) => e.t === 'tool_result' && e.kind === 'search');
    ok('推了检索结果', tr && tr.results.length === 3);
    ok('推了引用', evs.some((e) => e.t === 'citation' && e.url === 'https://example.test/lru'));

    // 落盘:刷新页面后"它查了什么"还在
    const full = await (await get('/u/api/chat/session?id=' + c.session.id, bearer(S))).json();
    const reply = full.session.messages.find((m) => m.role === 'assistant');
    ok('检索过程跟消息一起落盘', reply.queries && reply.queries[0] === 'LRU 缓存');
    ok('来源按 url 去重', reply.sources.length === 2, JSON.stringify(reply.sources.map((x) => x.url)));
    ok('记下了这一轮是联网模式', reply.mode === 'search');
    ok('引用也落盘了', reply.citations && reply.citations.length === 1);
  }

  // ── 27. 深度研究:更多轮 + 抓原文 + 研究提示词 ──
  {
    const mark = seen.length;
    await readStream((await post('/u/api/chat/stream', { text: '研究一下', model: 'claude-x', mode: 'research' }, bearer(S))).body);
    const req = seen.slice(mark).find((x) => x.body && x.body.stream === true);
    const types = (req.body.tools || []).map((t) => t.type);
    ok('研究模式同时挂搜索与抓取', types.includes('web_search_20250305') && types.includes('web_fetch_20260209'), JSON.stringify(types));
    ok('研究模式的检索轮数更多', req.body.tools[0].max_uses > 5, String(req.body.tools[0].max_uses));
    ok('抓取开了引用', req.body.tools.find((t) => t.type === 'web_fetch_20260209').citations.enabled === true);
    ok('注入了研究提示词', /primary sources/.test(req.body.system || ''));
    ok('研究模式默认往深了想', req.body.output_config && req.body.output_config.effort === 'high', JSON.stringify(req.body.output_config));
  }

  // ── 28. 服务端工具失败:HTTP 200 + 错误【对象】,不是异常 ──
  {
    const evs = await readStream((await post('/u/api/chat/stream', { text: '搜索失败测试', model: 'claude-x', mode: 'search' }, bearer(S))).body);
    const err = evs.find((e) => e.t === 'tool_result' && e.kind === 'error');
    ok('工具失败被识别成错误而不是空结果', !!err && err.error === 'max_uses_exceeded', JSON.stringify(err));
    ok('工具失败不影响整轮完成', evs.some((e) => e.t === 'done'));
  }

  // ── 29. 不开模式时不挂任何工具(纯对话保持原样)──
  {
    const mark = seen.length;
    await readStream((await post('/u/api/chat/stream', { text: '就聊聊', model: 'claude-x' }, bearer(S))).body);
    const req = seen.slice(mark).find((x) => x.body && x.body.stream === true);
    ok('不开联网时请求里没有 tools', !req.body.tools);
    ok('也没有研究提示词', !req.body.system);
  }

  // ── 30. 技能 = 预设提示词,拼进 system ──
  {
    const sk = await post('/admin/api/skills', {
      skills: [
        { id: 'reviewer', name: '代码审阅', desc: '挑毛病', prompt: '你是一个严格的代码审阅者。' },
        { id: 'zh', name: '中文润色', prompt: '把回答润色成地道的简体中文。' },
      ],
    }, bearer(admin));
    ok('管理员可保存技能库', sk.ok, `status=${sk.status}`);
    const meta = await (await get('/u/api/chat/meta', bearer(S))).json();
    ok('meta 下发技能清单', (meta.skills || []).length === 2);
    ok('meta 不下发提示词本体(前端不需要)', !JSON.stringify(meta.skills).includes('严格的代码审阅者'));

    const mark = seen.length;
    await readStream((await post('/u/api/chat/stream', { text: '看看这段', model: 'claude-x', skills: ['reviewer', 'zh'] }, bearer(S))).body);
    const req = seen.slice(mark).find((x) => x.body && x.body.stream === true);
    ok('选中的技能按顺序拼进 system', /严格的代码审阅者[\s\S]*地道的简体中文/.test(req.body.system || ''), (req.body.system || '').slice(0, 90));

    // 不存在的 id 要静默忽略,不能把请求搞坏
    const m2 = seen.length;
    await readStream((await post('/u/api/chat/stream', { text: 'x', model: 'claude-x', skills: ['nope'] }, bearer(S))).body);
    ok('不存在的技能 id 被忽略', !seen.slice(m2).find((x) => x.body && x.body.stream === true).body.system);

    // 校验
    ok('技能 id 非法被拒', !(await post('/admin/api/skills', { skills: [{ id: 'a b', name: 'x', prompt: 'y' }] }, bearer(admin))).ok);
    ok('技能 id 重复被拒', !(await post('/admin/api/skills', { skills: [{ id: 'a', name: 'x', prompt: 'y' }, { id: 'a', name: 'z', prompt: 'w' }] }, bearer(admin))).ok);
    ok('缺提示词被拒', !(await post('/admin/api/skills', { skills: [{ id: 'a', name: 'x', prompt: '' }] }, bearer(admin))).ok);
    ok('技能库写回了 config.json', JSON.parse(fs.readFileSync(configFile, 'utf8')).skills.length === 2);
  }

  // ── 31. 用户自建技能:按用户隔离 ──
  {
    const evS = await (await post('/u/api/login', { username: 'eve', password: 'eve-pw-123456' })).json().then((x) => x.session);

    const mk = (who, list) => post('/u/api/chat/skills', { skills: list }, bearer(who));
    ok('用户可以自建技能', (await mk(S, [{ id: 'kim-own', name: '我的审阅', desc: '', prompt: 'KIM 专属提示词' }])).ok);
    ok('另一个用户也能建同名 id', (await mk(evS, [{ id: 'kim-own', name: 'Eve 的', desc: '', prompt: 'EVE 专属提示词' }])).ok);

    const kimList = await (await get('/u/api/chat/skills', bearer(S))).json();
    const eveList = await (await get('/u/api/chat/skills', bearer(evS))).json();
    ok('各自只看到自己的', kimList.mine.length === 1 && kimList.mine[0].prompt === 'KIM 专属提示词', JSON.stringify(kimList.mine.map((x) => x.name)));
    ok('同 id 不串台', eveList.mine[0].prompt === 'EVE 专属提示词', eveList.mine[0].prompt);
    // 团队技能(管理员配的)两个人都看得到
    ok('团队技能对所有人可见', kimList.team.length === 2 && eveList.team.length === 2);

    // meta 里合并后带 scope,前端据此分组
    const meta = await (await get('/u/api/chat/meta', bearer(S))).json();
    const mineInMeta = meta.skills.filter((k) => k.scope === 'mine');
    const teamInMeta = meta.skills.filter((k) => k.scope === 'team');
    ok('meta 区分了我的与团队', mineInMeta.length === 1 && teamInMeta.length === 2, JSON.stringify(meta.skills.map((k) => `${k.name}/${k.scope}`)));
    ok('meta 仍不下发提示词本体', !JSON.stringify(meta.skills).includes('KIM 专属'));

    // 用自己的技能发一轮:拼进 system 的必须是【我的】那份
    const mark = seen.length;
    await readStream((await post('/u/api/chat/stream', { text: 'x', model: 'claude-x', skills: ['kim-own'] }, bearer(S))).body);
    const req = seen.slice(mark).find((x) => x.body && x.body.stream === true);
    ok('自建技能拼进了 system', (req.body.system || '').includes('KIM 专属提示词'));
    ok('拼进去的不是别人那份', !(req.body.system || '').includes('EVE 专属提示词'));

    // 同 id 时我的盖过团队的 —— 自己建的东西不该被全局配置悄悄替换
    await mk(S, [{ id: 'reviewer', name: '我覆盖的审阅', desc: '', prompt: '这是我自己的审阅提示词' }]);
    const m2 = seen.length;
    await readStream((await post('/u/api/chat/stream', { text: 'x', model: 'claude-x', skills: ['reviewer'] }, bearer(S))).body);
    const req2 = seen.slice(m2).find((x) => x.body && x.body.stream === true);
    ok('同 id 时我的优先于团队的', (req2.body.system || '').includes('这是我自己的审阅提示词') && !(req2.body.system || '').includes('严格的代码审阅者'));

    // 校验与上限
    ok('自建技能 id 非法被拒', !(await mk(S, [{ id: 'a b', name: 'x', prompt: 'y' }])).ok);
    ok('自建技能缺提示词被拒', !(await mk(S, [{ id: 'a', name: 'x', prompt: '' }])).ok);
    ok('自建技能重复 id 被拒', !(await mk(S, [{ id: 'a', name: 'x', prompt: 'y' }, { id: 'a', name: 'z', prompt: 'w' }])).ok);
    const many = Array.from({ length: 21 }, (_, i) => ({ id: 'k' + i, name: 'n' + i, prompt: 'p' }));
    ok('超过自建上限被拒', !(await mk(S, many)).ok);

    // 未登录读不到
    ok('未登录读不到技能', (await get('/u/api/chat/skills')).status === 401);

    // 落在自己的目录里,不在别人那儿
    const kimDir = path.join(temp, 'data', 'chats', 'kim', 'skills.json');
    const eveDir = path.join(temp, 'data', 'chats', 'eve', 'skills.json');
    ok('技能存在各自的用户目录下', fs.existsSync(kimDir) && fs.existsSync(eveDir));
    ok('文件里就是自己那份', JSON.parse(fs.readFileSync(eveDir, 'utf8')).skills[0].prompt === 'EVE 专属提示词');

    // 删空
    ok('可以清空自己的技能', (await mk(S, [])).ok);
    ok('清空后 mine 为空、team 不受影响', await (async () => {
      const d = await (await get('/u/api/chat/skills', bearer(S))).json();
      return d.mine.length === 0 && d.team.length === 2;
    })());
  }

} catch (err) {
  fail++;
  console.log('FAIL  测试异常:', err.stack || err.message);
} finally {
  child.kill();
  upstream.close();
  await wait(200);
  try {
    fs.rmSync(temp, { recursive: true, force: true });
  } catch {}
}

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail) {
  console.log('\n--- 服务日志 ---\n' + srvLog.slice(-4000));
  process.exit(1);
}
