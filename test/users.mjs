// 用户体系测试。重点全在【越权】上:这个功能的真实风险不是功能不通,
// 而是用户看到了不该看的东西,所以每一条边界都要有测试盯着。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { hashPassword, verifyPassword, tokenIdOf } from '../src/users.js';

const PORT = 19974;
const UP_PORT = 19978;
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-users-'));
const configFile = path.join(temp, 'config.json');
const TOKEN_A = 'cct-' + 'a'.repeat(32);
const TOKEN_B = 'cct-' + 'b'.repeat(32);
const ID_A = tokenIdOf(TOKEN_A);
const ID_B = tokenIdOf(TOKEN_B);

// mock 上游:返回带 usage 的响应,这样配额才有真实用量可以超
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const wantStream = /"stream"\s*:\s*true/.test(body);
    if (wantStream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ type: 'message_start', message: { usage: { input_tokens: 100 } } });
      send({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } });
      send({ type: 'message_delta', usage: { output_tokens: 50 } });
      send({ type: 'message_stop' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'message', role: 'assistant', model: 'claude-x',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    }));
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
      { token: TOKEN_A, name: 'alice-laptop' },
      { token: TOKEN_B, name: 'bob-server' },
    ],
    adminEnabled: true,
    adminPassword: 'admin-pw-123',
    adminUser: 'admin',
    dataDir: path.join(temp, 'data'),
  }),
);

// ── 纯函数:密码哈希 ──
{
  const h = hashPassword('correct horse battery');
  ok('密码不以明文存储', !h.includes('correct horse battery') && h.startsWith('scrypt$'));
  ok('正确密码校验通过', verifyPassword('correct horse battery', h));
  ok('错误密码校验失败', !verifyPassword('correct horse batter', h));
  ok('哈希加盐(同一密码两次不同)', hashPassword('x') !== hashPassword('x'));
  ok('损坏的哈希不通过', !verifyPassword('x', 'garbage'));
  ok('令牌 id 稳定且与 admin.js 一致', ID_A === tokenIdOf(TOKEN_A) && ID_A.length === 12);
}

const child = spawn(process.execPath, [path.join(import.meta.dirname, '../src/server.js')], {
  env: { ...process.env, CC_TRANS_CONFIG: configFile },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d));
child.stderr.on('data', (d) => (serverLog += d));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const J = { 'content-type': 'application/json' };
const post = (p, body, headers = {}) => fetch(BASE + p, { method: 'POST', headers: { ...J, ...headers }, body: JSON.stringify(body || {}) });
const get = (p, headers = {}) => fetch(BASE + p, { headers });
const bearer = (s) => ({ authorization: 'Bearer ' + s });

try {
  ok('服务启动', await waitUp());

  // 管理员登录
  const adminSession = await (await post('/admin/api/login', { username: 'admin', password: 'admin-pw-123' })).json().then((d) => d.session);
  ok('管理员登录拿到 session', !!adminSession);

  // ── 创建用户 ──
  {
    const r = await post('/admin/api/users', { name: 'alice', password: 'alice-pw-12345', tokenIds: [ID_A] }, bearer(adminSession));
    const d = await r.json();
    ok('创建用户 alice', r.ok && d.ok, JSON.stringify(d.user || d));

    const dup = await post('/admin/api/users', { name: 'alice', password: 'other-pw-12345' }, bearer(adminSession));
    ok('重名用户被拒', dup.status === 400);

    const shortPw = await post('/admin/api/users', { name: 'bob', password: 'short' }, bearer(adminSession));
    ok('过短密码被拒', shortPw.status === 400);

    const badName = await post('/admin/api/users', { name: 'a b', password: 'valid-pw-12345' }, bearer(adminSession));
    ok('非法用户名被拒', badName.status === 400);

    await post('/admin/api/users', { name: 'bob', password: 'bob-pw-123456', tokenIds: [ID_B] }, bearer(adminSession));
  }

  // ── 持久化:密码哈希落到 config.json,且不含明文 ──
  {
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const alice = (saved.users || []).find((u) => u.name === 'alice');
    ok('用户已写回 config.json', !!alice);
    ok('config.json 里没有密码明文', !JSON.stringify(saved).includes('alice-pw-12345'));
    ok('存的是 scrypt 哈希', !!alice && alice.pass.startsWith('scrypt$'));
    ok('绑定关系已保存', !!alice && alice.tokenIds.includes(ID_A));
  }

  // ── 用户端登录 ──
  let aliceSession = null;
  {
    const bad = await post('/u/api/login', { username: 'alice', password: 'wrong' });
    ok('错密码登录失败', bad.status === 401);
    const nobody = await post('/u/api/login', { username: 'nobody', password: 'whatever12345' });
    ok('不存在的账号登录失败', nobody.status === 401);
    const r = await post('/u/api/login', { username: 'alice', password: 'alice-pw-12345' });
    const d = await r.json();
    aliceSession = d.session;
    ok('用户登录成功', r.ok && !!aliceSession);
  }

  // ── 越权:两套 session 互不相认 ──
  {
    const r1 = await get('/admin/api/clients', bearer(aliceSession));
    ok('用户 session 不能访问管理台 API', r1.status === 401);
    const r2 = await get('/u/api/me', bearer(adminSession));
    ok('管理员 session 不能访问用户端 API', r2.status === 401);
    const r3 = await get('/u/api/me');
    ok('无 session 访问用户端 API 401', r3.status === 401);
  }

  // ── 数据隔离:只看到自己绑定的设备 ──
  {
    const d = await (await get('/u/api/me', bearer(aliceSession))).json();
    ok('只返回自己的设备', d.devices.length === 1 && d.devices[0].name === 'alice-laptop', `${d.devices.length} 台`);
    ok('设备列表默认只给掩码', d.devices[0].tokenMask.includes('…') && !JSON.stringify(d.devices).includes(TOKEN_A));
    ok('看不到 bob 的设备', !JSON.stringify(d.devices).includes('bob-server'));
  }

  // ── 令牌明文:自己的可取,别人的 403 ──
  {
    const mine = await post('/u/api/token', { id: ID_A }, bearer(aliceSession));
    const d = await mine.json();
    ok('可取回自己绑定令牌的明文', mine.ok && d.token === TOKEN_A);

    const theirs = await post('/u/api/token', { id: ID_B }, bearer(aliceSession));
    ok('取别人的令牌被拒 403', theirs.status === 403);

    const bogus = await post('/u/api/token', { id: 'deadbeefcafe' }, bearer(aliceSession));
    ok('取不存在的令牌被拒 403', bogus.status === 403);

    ok('明文回显有审计日志', serverLog.includes('[audit]') && serverLog.includes('alice'));
    ok('越权尝试也有审计日志', serverLog.includes('试图查看未绑定令牌'));
  }

  // ── 日志隔离:伪造 client 参数无效 ──
  {
    // 先造两条日志:一条 alice 的、一条 bob 的
    for (const [tok, model] of [[TOKEN_A, 'claude-a'], [TOKEN_B, 'claude-b']]) {
      await fetch(BASE + '/v1/messages', {
        method: 'POST',
        headers: { ...J, authorization: 'Bearer ' + tok },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 300));
    const d = await (await get('/u/api/logs?limit=50', bearer(aliceSession))).json();
    const names = new Set((d.logs || []).map((e) => e.client));
    ok('日志只含自己的设备', !names.has('bob-server'), `见到: ${[...names].join(',') || '(空)'}`);

    // 伪造 client 参数:服务端必须忽略
    const forged = await (await get('/u/api/logs?limit=50&client=bob-server', bearer(aliceSession))).json();
    const fNames = new Set((forged.logs || []).map((e) => e.client));
    ok('伪造 client 参数被忽略', !fNames.has('bob-server'), `见到: ${[...fNames].join(',') || '(空)'}`);
  }

  // ── 自助改密 ──
  {
    const wrong = await post('/u/api/password', { oldPassword: 'nope', newPassword: 'new-pw-123456' }, bearer(aliceSession));
    ok('改密要验旧密码', wrong.status === 400);
    const r = await post('/u/api/password', { oldPassword: 'alice-pw-12345', newPassword: 'new-pw-123456' }, bearer(aliceSession));
    ok('改密成功', r.ok);
    const relogin = await post('/u/api/login', { username: 'alice', password: 'new-pw-123456' });
    ok('新密码可登录', relogin.ok);
    const oldPw = await post('/u/api/login', { username: 'alice', password: 'alice-pw-12345' });
    ok('旧密码失效', oldPw.status === 401);
  }

  // ── 禁用:既有 session 立即失效(不是等下次登录) ──
  {
    const s = await (await post('/u/api/login', { username: 'bob', password: 'bob-pw-123456' })).json().then((d) => d.session);
    ok('bob 登录成功', !!s);
    ok('禁用前可访问', (await get('/u/api/me', bearer(s))).ok);
    await post('/admin/api/users/disable', { name: 'bob', disabled: true }, bearer(adminSession));
    ok('禁用后既有 session 立即失效', (await get('/u/api/me', bearer(s))).status === 401);
    const login = await post('/u/api/login', { username: 'bob', password: 'bob-pw-123456' });
    ok('禁用的账号不能登录', login.status === 401);
    await post('/admin/api/users/disable', { name: 'bob', disabled: false }, bearer(adminSession));
    ok('启用后可再次登录', (await post('/u/api/login', { username: 'bob', password: 'bob-pw-123456' })).ok);
  }

  // ── 管理员重置密码 / 改绑 / 删除 ──
  {
    const r = await post('/admin/api/users/password', { name: 'alice', password: 'reset-pw-1234' }, bearer(adminSession));
    ok('管理员重置密码', r.ok);
    ok('重置后新密码可登录', (await post('/u/api/login', { username: 'alice', password: 'reset-pw-1234' })).ok);

    await post('/admin/api/users/tokens', { name: 'alice', tokenIds: [ID_A, ID_B] }, bearer(adminSession));
    const s = await (await post('/u/api/login', { username: 'alice', password: 'reset-pw-1234' })).json().then((d) => d.session);
    const d = await (await get('/u/api/me', bearer(s))).json();
    ok('改绑后能看到两台设备', d.devices.length === 2, `${d.devices.length} 台`);

    const del = await post('/admin/api/users/remove', { name: 'bob' }, bearer(adminSession));
    ok('删除用户', del.ok);
    const list = await (await get('/admin/api/users', bearer(adminSession))).json();
    ok('删除后列表不含该用户', !list.users.some((u) => u.name === 'bob'));
  }

  // ── 令牌重名被拒(metrics/logStore 按名聚合,重名会串数据) ──
  {
    const dup = await post('/admin/api/tokens', { name: 'alice-laptop' }, bearer(adminSession));
    ok('同名客户端令牌被拒', dup.status === 400);
    const fresh = await post('/admin/api/tokens', { name: 'fresh-device' }, bearer(adminSession));
    ok('不同名可创建', fresh.ok);
  }

  // ── 吊销令牌后清理用户身上的悬空绑定 ──
  {
    const clients = await (await get('/admin/api/clients', bearer(adminSession))).json();
    const target = clients.tokens.find((t) => t.name === 'bob-server');
    ok('找到待吊销令牌', !!target);
    await post('/admin/api/tokens/revoke', { id: target.id }, bearer(adminSession));
    const list = await (await get('/admin/api/users', bearer(adminSession))).json();
    const alice = list.users.find((u) => u.name === 'alice');
    ok('吊销令牌后用户绑定被清理', !alice.tokenIds.includes(ID_B), JSON.stringify(alice.tokenIds));
  }

  // ── 用户端页面与 tab URL ──
  {
    for (const p of ['/u', '/u/devices', '/u/logs', '/u/account']) {
      const r = await get(p);
      ok(`页面 ${p} 返回单页`, r.status === 200 && (await r.text()).includes('cc-trans'));
    }
    const notFound = await get('/u/api/nope', bearer(aliceSession));
    ok('未知用户端 API 404', notFound.status === 404);
  }

  // ── 权限模块:关掉某项后对应功能不可用 ──
  {
    const list0 = await (await get('/admin/api/users', bearer(adminSession))).json();
    ok('用户列表带权限元信息', !!list0.permMeta && !!list0.permDefaults, Object.keys(list0.permMeta || {}).join(','));
    const alice0 = list0.users.find((u) => u.name === 'alice');
    ok('默认权限全开', alice0.perms.chat && alice0.perms.logs && alice0.perms.cost && alice0.perms.revealToken);

    // 创建时就带权限(这条曾漏测:users.create 收了 perms,但 admin 端点没往下传)
    const cr = await post('/admin/api/users', {
      name: 'limited', password: 'limited-pw-123', tokenIds: [ID_A],
      perms: { chat: false, logs: false, cost: true, revealToken: true },
    }, bearer(adminSession));
    const crd = await cr.json();
    ok('创建时带的权限生效', cr.ok && crd.user.perms.chat === false && crd.user.perms.logs === false && crd.user.perms.cost === true,
       JSON.stringify(crd.user && crd.user.perms));
    const lsAfter = await (await get('/admin/api/users', bearer(adminSession))).json();
    ok('列表里能看到被关的权限', lsAfter.users.find((u) => u.name === 'limited').perms.chat === false);
    const ls = await (await post('/u/api/login', { username: 'limited', password: 'limited-pw-123' })).json().then((d) => d.session);
    ok('创建时关掉的 chat 立即生效', (await get('/u/api/chat/sessions', bearer(ls))).status === 403);
    await post('/admin/api/users/remove', { name: 'limited' }, bearer(adminSession));

    // 关掉 alice 的日志与令牌回显
    const r = await post('/admin/api/users/perms', { name: 'alice', perms: { chat: false, logs: false, cost: false, revealToken: false } }, bearer(adminSession));
    ok('管理员改权限', r.ok);

    const s = await (await post('/u/api/login', { username: 'alice', password: 'reset-pw-1234' })).json().then((d) => d.session);
    ok('权限收窄后仍能登录', !!s);
    ok('无 logs 权限 → 日志 403', (await get('/u/api/logs', bearer(s))).status === 403);
    const tokRes = await post('/u/api/token', { id: ID_A }, bearer(s));
    ok('无 revealToken 权限 → 取明文 403', tokRes.status === 403, (await tokRes.json()).error);
    ok('无 chat 权限 → 聊天 API 403', (await get('/u/api/chat/sessions', bearer(s))).status === 403);
    const me = await (await get('/u/api/me', bearer(s))).json();
    ok('无 cost 权限 → 金额被抹掉但用量可见', me.total.cost === null && typeof me.total.requests === 'number', JSON.stringify({ cost: me.total.cost, req: me.total.requests }));
    ok('设备仍可见(隔离与权限是两件事)', me.devices.length >= 1);

    // 权限持久化 + 恢复
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    ok('权限写回 config.json', saved.users.find((u) => u.name === 'alice').perms.chat === false);
    await post('/admin/api/users/perms', { name: 'alice', perms: { chat: true, logs: true, cost: true, revealToken: true } }, bearer(adminSession));
    const back = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    ok('恢复全默认后字段被清掉(配置保持干净)', !('perms' in back.users.find((u) => u.name === 'alice')));
    ok('恢复后日志可看', (await get('/u/api/logs', bearer(s))).ok);
  }

  // ── 用户级配额:按 token/花费,与名下所有令牌共享 ──
  {
    const meta = await (await get('/admin/api/users', bearer(adminSession))).json();
    ok('下发配额窗口选项', !!meta.quotaWindows && !!meta.quotaWindows.month, Object.keys(meta.quotaWindows || {}).join(','));
    ok('默认不限额', meta.users.find((u) => u.name === 'alice').quota.unlimited);

    // alice 名下有两个令牌(前面改绑过 ID_A + ID_B 但 ID_B 已吊销,这里重新绑)
    await post('/admin/api/users/tokens', { name: 'alice', tokenIds: [ID_A] }, bearer(adminSession));

    // 先打两次请求造出真实用量(mock 上游每次 in=100 out=50 → tokens=150)
    for (let i = 0; i < 2; i++) {
      await fetch(BASE + '/v1/messages', {
        method: 'POST',
        headers: { ...J, authorization: 'Bearer ' + TOKEN_A },
        body: JSON.stringify({ model: 'claude-x', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
      }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 200));
    const beforeQ = await (await get('/admin/api/users', bearer(adminSession))).json();
    const usedNow = beforeQ.users.find((u) => u.name === 'alice').used;
    ok('已用量被记录(有真实 token 数)', usedNow.tokens >= 300, JSON.stringify({ tokens: usedNow.tokens }));

    // 设一个低于已用量的配额:必然超
    const setQ = await post('/admin/api/users/quota', { name: 'alice', quota: { window: 'total', tokens: 100, costUsd: 0 } }, bearer(adminSession));
    ok('设置配额', setQ.ok);
    const after = await (await get('/admin/api/users', bearer(adminSession))).json();
    const aq = after.users.find((u) => u.name === 'alice');
    ok('配额已生效且非不限', !aq.quota.unlimited && aq.quota.tokens === 100);
    ok('列表带该用户已用量', typeof aq.used.tokens === 'number', JSON.stringify(aq.used));

    // 用该令牌打转发 → 应被配额拒绝(429),而不是限流
    const r = await fetch(BASE + '/v1/messages', {
      method: 'POST',
      headers: { ...J, authorization: 'Bearer ' + TOKEN_A },
      body: JSON.stringify({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    ok('超配额的请求被拒 429', r.status === 429, `status=${r.status}`);
    const body = await r.json().catch(() => ({}));
    ok('拒绝原因说明是配额而非限流', /配额/.test(JSON.stringify(body)), JSON.stringify(body).slice(0, 120));

    // 聊天路径同样被拦
    const s = await (await post('/u/api/login', { username: 'alice', password: 'reset-pw-1234' })).json().then((d) => d.session);
    const cr = await post('/u/api/chat/stream', { text: 'hi', model: 'claude-x' }, bearer(s));
    const txt = await cr.text();
    ok('聊天也被配额拦住', /配额/.test(txt), txt.slice(0, 140));

    // 用户端能看到自己的配额与已用
    const me = await (await get('/u/api/me', bearer(s))).json();
    ok('用户端能看到配额', me.quota && me.quota.tokens === 100 && me.quota.unlimited === false, JSON.stringify(me.quota));
    ok('用户端能看到已用量', typeof me.quota.usedTokens === 'number');

    // 花费配额:先用一个【在价格表里】的模型打一次,否则 costOf 返回 0(claude-x 匹配不到定价)
    await post('/admin/api/users/quota', { name: 'alice', quota: { window: 'total', tokens: 0, costUsd: 0 } }, bearer(adminSession));
    await fetch(BASE + '/v1/messages', {
      method: 'POST',
      headers: { ...J, authorization: 'Bearer ' + TOKEN_A },
      body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    const costNow = (await (await get('/admin/api/users', bearer(adminSession))).json()).users.find((u) => u.name === 'alice').used.cost;
    ok('花费被记录(模型在价格表里才有成本)', costNow > 0, `$${costNow}`);
    await post('/admin/api/users/quota', { name: 'alice', quota: { window: 'total', tokens: 0, costUsd: costNow / 2 } }, bearer(adminSession));
    const r2 = await fetch(BASE + '/v1/messages', {
      method: 'POST',
      headers: { ...J, authorization: 'Bearer ' + TOKEN_A },
      body: JSON.stringify({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    ok('超花费配额也被拒', r2.status === 429, `status=${r2.status}`);

    // 归零 = 恢复不限,且字段从配置里清掉
    await post('/admin/api/users/quota', { name: 'alice', quota: { window: 'month', tokens: 0, costUsd: 0 } }, bearer(adminSession));
    const savedCfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    ok('归零后 quota 字段被清掉', !('quota' in savedCfg.users.find((u) => u.name === 'alice')));
    const r3 = await fetch(BASE + '/v1/messages', {
      method: 'POST',
      headers: { ...J, authorization: 'Bearer ' + TOKEN_A },
      body: JSON.stringify({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    ok('恢复不限后不再被配额拦', r3.ok, `status=${r3.status}`);

    // 未绑定任何用户的令牌不受配额影响(管理员自用)
    const fresh = await (await post('/admin/api/tokens', { name: 'unowned-dev' }, bearer(adminSession))).json();
    const r4 = await fetch(BASE + '/v1/messages', {
      method: 'POST',
      headers: { ...J, authorization: 'Bearer ' + fresh.token },
      body: JSON.stringify({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    ok('无归属用户的令牌不受配额限制', r4.ok, `status=${r4.status}`);
  }

  // ── 保留名不能被占用 ──
  {
    for (const n of ['__admin__', 'admin', 'ADMIN']) {
      const r = await post('/admin/api/users', { name: n, password: 'whatever-12345' }, bearer(adminSession));
      ok(`保留名 ${n} 被拒`, r.status === 400, (await r.json()).error);
    }
  }

  // ── 管理员也能用聊天(全部设备 + 全部权限)──
  {
    const meta = await (await get('/admin/api/chat/meta', bearer(adminSession))).json();
    const allTokens = (await (await get('/admin/api/clients', bearer(adminSession))).json()).tokens;
    ok('管理员聊天可用全部设备', meta.devices.length === allTokens.length, `${meta.devices.length}/${allTokens.length}`);
    const c = await (await post('/admin/api/chat/sessions', { title: 'admin 的对话' }, bearer(adminSession))).json();
    ok('管理员能建会话', c.ok);
    const page = await get('/admin/chat');
    ok('管理员聊天页可访问', page.status === 200 && (await page.text()).includes('IS_ADMIN'));
    // 普通用户 session 打不开管理员的聊天 API
    const us = await (await post('/u/api/login', { username: 'alice', password: 'reset-pw-1234' })).json().then((d) => d.session);
    ok('用户 session 不能用管理员聊天 API', (await get('/admin/api/chat/sessions', bearer(us))).status === 401);
    // 管理员会话与用户会话互不可见
    const uSess = await (await get('/u/api/chat/sessions', bearer(us))).json();
    ok('管理员的会话不出现在用户列表里', !(uSess.sessions || []).some((x) => x.title === 'admin 的对话'));
  }

  // ── 令牌归属(反向入口)──
  {
    const cl = await (await get('/admin/api/clients', bearer(adminSession))).json();
    const t = cl.tokens.find((x) => x.name === 'alice-laptop');
    ok('客户端列表显示归属用户', Array.isArray(t.owners) && t.owners.includes('alice'), JSON.stringify(t.owners));
    const unowned = cl.tokens.find((x) => x.name === 'fresh-device');
    ok('未分配的令牌 owners 为空', unowned && unowned.owners.length === 0);
  }

  // ── 管理台账号:登录名可改 + 管理员出现在用户列表且不可删除 ──
  // 这块的风险是"改到一半":名字改了密码没改、或者内存改了文件没改,
  // 两种都会让管理员把自己关在门外,所以每一步都要验登录能不能进。
  {
    const clients = await (await get('/admin/api/clients', bearer(adminSession))).json();
    const ul = await (await get('/admin/api/users', bearer(adminSession))).json();
    ok('用户列表带管理员行', !!ul.admin && ul.admin.name === 'admin' && ul.admin.isAdmin === true, JSON.stringify(ul.admin));
    ok('管理员行不混进普通用户数组', !(ul.users || []).some((u) => u.name === 'admin'));
    ok('管理员行标注可在线改', ul.admin.canManage === true);
    ok('管理员行设备数 = 全部令牌数', ul.admin.deviceCount === clients.tokens.length, `${ul.admin.deviceCount}/${clients.tokens.length}`);
    ok('管理员行有最近登录时间', ul.admin.lastLoginAt > 0);

    const acc = await (await get('/admin/api/account', bearer(adminSession))).json();
    ok('GET /api/account 返回当前登录名', acc.user === 'admin' && acc.canManage === true, JSON.stringify(acc));
    ok('GET /api/account 需要登录', (await get('/admin/api/account')).status === 401);

    // 管理员不可删除 / 不可禁用(凭证不在 config.users 里,这两个接口碰不到它)
    ok('删除管理员失败', (await post('/admin/api/users/remove', { name: 'admin' }, bearer(adminSession))).status === 400);
    ok('禁用管理员失败', (await post('/admin/api/users/disable', { name: 'admin', disabled: true }, bearer(adminSession))).status === 400);
    ok('管理员仍能登录(没被上面两步搞坏)', (await post('/admin/api/login', { username: 'admin', password: 'admin-pw-123' })).ok);

    const bad = [
      ['当前密码不对', { username: 'root2', oldPassword: 'nope' }],
      ['登录名含空格', { username: 'ro ot', oldPassword: 'admin-pw-123' }],
      ['登录名太短', { username: 'a', oldPassword: 'admin-pw-123' }],
      ['内部保留名 __admin__', { username: '__admin__', oldPassword: 'admin-pw-123' }],
      ['与普通用户重名', { username: 'alice', oldPassword: 'admin-pw-123' }],
      ['与普通用户重名(大小写)', { username: 'ALICE', oldPassword: 'admin-pw-123' }],
      ['什么都没填', { username: 'admin', oldPassword: 'admin-pw-123' }],
      ['新密码太短', { username: '', oldPassword: 'admin-pw-123', newPassword: '12345' }],
    ];
    for (const [label, body] of bad) {
      const r = await post('/admin/api/account', body, bearer(adminSession));
      ok(`改账号被拒:${label}`, r.status === 400, (await r.json()).error);
    }
    ok('被拒后登录名没变', (await (await get('/admin/api/account', bearer(adminSession))).json()).user === 'admin');
    ok('被拒后原密码仍能登录', (await post('/admin/api/login', { username: 'admin', password: 'admin-pw-123' })).ok);

    // 只改登录名
    const d1 = await (await post('/admin/api/account', { username: 'root2', oldPassword: 'admin-pw-123' }, bearer(adminSession))).json();
    ok('只改登录名成功', d1.ok && d1.user === 'root2' && d1.renamed === true && !d1.passwordChanged, JSON.stringify(d1));
    ok('旧登录名不能再登录', (await post('/admin/api/login', { username: 'admin', password: 'admin-pw-123' })).status === 401);
    ok('新登录名 + 原密码可登录', (await post('/admin/api/login', { username: 'root2', password: 'admin-pw-123' })).ok);
    ok('改名写回 config.json', JSON.parse(fs.readFileSync(configFile, 'utf8')).adminUser === 'root2');
    ok('改名后旧 session 仍有效', (await get('/admin/api/account', bearer(adminSession))).ok);
    ok('用户列表里的管理员名跟着改', (await (await get('/admin/api/users', bearer(adminSession))).json()).admin.name === 'root2');
    ok('登录页默认名跟着改', (await (await get('/admin/api/meta')).json()).user === 'root2');

    // 双向互斥:管理台登录名改了,新名字立刻成为普通用户的禁用名
    const dup = await post('/admin/api/users', { name: 'root2', password: 'whatever-12345' }, bearer(adminSession));
    ok('普通用户不能占用管理台登录名', dup.status === 400, (await dup.json()).error);
    const dupCase = await post('/admin/api/users', { name: 'ROOT2', password: 'whatever-12345' }, bearer(adminSession));
    ok('大小写变体也占不到', dupCase.status === 400, (await dupCase.json()).error);

    // 名字 + 密码一起改
    const d2 = await (await post('/admin/api/account', { username: 'root3', oldPassword: 'admin-pw-123', newPassword: 'admin-pw-456' }, bearer(adminSession))).json();
    ok('登录名与密码可一起改', d2.ok && d2.renamed && d2.passwordChanged, JSON.stringify(d2));
    ok('新名 + 新密码可登录', (await post('/admin/api/login', { username: 'root3', password: 'admin-pw-456' })).ok);
    ok('旧密码已失效', (await post('/admin/api/login', { username: 'root3', password: 'admin-pw-123' })).status === 401);

    // 老 /api/password 路径只改密码,不该动到登录名
    const r3 = await post('/admin/api/password', { oldPassword: 'admin-pw-456', newPassword: 'admin-pw-789' }, bearer(adminSession));
    ok('老 /api/password 仍可只改密码', r3.ok, `status=${r3.status}`);
    ok('只改密码不影响登录名', (await (await get('/admin/api/account', bearer(adminSession))).json()).user === 'root3');
    ok('改完用新密码能登录', (await post('/admin/api/login', { username: 'root3', password: 'admin-pw-789' })).ok);
  }

  // ── /u 前缀不吞其它路径 ──
  {
    const r = await get('/usage');
    ok('/usage 不被 /u 前缀吞掉', r.status !== 200 || !(await r.text()).includes('<!doctype html>'), `status=${r.status}`);
  }
} finally {
  child.kill();
  await new Promise((r) => child.on('exit', r));
  upstream.close();
}

// ── 重启后用户仍能登录 ──
// 单独重启一个进程来验证:光"写回了 config.json"不够,loadConfig 还得把 users
// 读回来。曾经就是漏了这一步 —— 同进程内测试全绿,重启后所有人登录不上。
{
  const child2 = spawn(process.execPath, [path.join(import.meta.dirname, '../src/server.js')], {
    env: { ...process.env, CC_TRANS_CONFIG: configFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    ok('二次启动成功', await waitUp());
    const r = await post('/u/api/login', { username: 'alice', password: 'reset-pw-1234' });
    ok('重启后用户仍能登录(users 被 loadConfig 读回)', r.ok, `status=${r.status}`);
    const s = await r.json().then((d) => d.session).catch(() => null);
    if (s) {
      const me = await (await get('/u/api/me', bearer(s))).json();
      ok('重启后绑定关系仍在', (me.devices || []).length >= 1, `${(me.devices || []).length} 台`);
    } else {
      ok('重启后绑定关系仍在', false, '登录失败,无法检查');
    }
    // 改过的管理台登录名必须活过重启 —— 只改内存不写文件的话,这里会 401
    const a = await post('/admin/api/login', { username: 'root3', password: 'admin-pw-789' });
    ok('重启后管理台新登录名仍可登录', a.ok, `status=${a.status}`);
    ok('重启后旧登录名仍无效', (await post('/admin/api/login', { username: 'admin', password: 'admin-pw-789' })).status === 401);
  } finally {
    child2.kill();
    await new Promise((r) => child2.on('exit', r));
  }
}

{
  try {
    fs.rmSync(temp, { recursive: true, force: true });
  } catch {}
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
