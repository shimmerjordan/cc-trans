// 第二批管理台能力测试:
//   3 每个 tab 一个 URL(/admin/<tab> 返回单页)
//   4 设置里配置本地 AI 订阅(读/探测/保存并热应用)
//   6 日志分块持久化 + 分页 + 按时间段删除 + 存储概况
//   7 异常请求标注来源(IP / UA / 路径 / 多来源计数)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const UP = 19871;
const PORT = 18871;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-adm2-'));
const CFG = path.join(TMP, 'config.json');
const CREDS = path.join(TMP, 'creds.json');
const CREDS2 = path.join(TMP, 'creds-alt.json');
const TOK = 'cct-a2';

fs.writeFileSync(CFG, JSON.stringify({
  port: PORT, host: '127.0.0.1',
  upstreamBaseUrl: `http://127.0.0.1:${UP}`,
  upstreamAuth: 'oauth',
  oauthCredentialsPath: CREDS,
  adminEnabled: true, adminUser: 'admin', adminPassword: 'secret123',
  logRetentionDays: 14,
  clientTokens: [{ token: TOK, name: 'a2' }],
}, null, 2));
const mkCreds = (p, type) => fs.writeFileSync(p, JSON.stringify({
  claudeAiOauth: { accessToken: 'sk-oat-x', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, subscriptionType: type },
}));
mkCreds(CREDS, 'team');
mkCreds(CREDS2, 'max');

const up = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm1', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } }));
  });
});

const results = [];
const ck = (n, c, e = '') => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? ' — ' + e : ''}`); };

async function main() {
  await new Promise((r) => up.listen(UP, r));
  const child = spawn('node', ['src/server.js'], { cwd: ROOT, env: { ...process.env, CC_TRANS_CONFIG: CFG }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', (d) => (logs += d)); child.stderr.on('data', (d) => (logs += d));
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

  try {
    // ── 3 每个 tab 一个 URL ──
    for (const t of ['overview', 'clients', 'models', 'logs', 'settings']) {
      const r = await fetch(`${base}/admin/${t}`);
      const html = await r.text();
      ck(`3 tab URL /admin/${t} 返回单页`, r.status === 200 && html.includes('cc-trans 管理台') && html.includes('id="tab-' + t + '"'), String(r.status));
    }
    const r404 = await fetch(base + '/admin/nope');
    ck('3 非法 tab 路径不返回页面', r404.status === 404, String(r404.status));

    // 登录
    const login = await (await fetch(base + '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'secret123' }) })).json();
    const H = { authorization: 'Bearer ' + login.session, 'content-type': 'application/json' };

    // ── 4 本地 AI 订阅配置 ──
    let ups = await (await fetch(base + '/admin/api/upstream', { headers: H })).json();
    ck('4 读上游状态: 订阅模式 + 凭证正常', ups.upstreamAuth === 'oauth' && ups.credentials.ok && ups.credentials.subscriptionType === 'team', JSON.stringify(ups.credentials));
    ck('4 密钥只回掩码', !('upstreamApiKey' in ups) && ups.canManage === true);
    // 探测另一个凭证路径
    const probe = await (await fetch(base + '/admin/api/upstream/probe', { method: 'POST', headers: H, body: JSON.stringify({ path: CREDS2 }) })).json();
    ck('4 探测凭证路径', probe.ok && probe.subscriptionType === 'max', JSON.stringify(probe));
    const probeBad = await (await fetch(base + '/admin/api/upstream/probe', { method: 'POST', headers: H, body: JSON.stringify({ path: path.join(TMP, 'nope.json') }) })).json();
    ck('4 探测不存在的凭证报错', probeBad.ok === false && !!probeBad.error);
    // 切换凭证路径 → 热应用(不重启)
    const sw = await (await fetch(base + '/admin/api/upstream', { method: 'POST', headers: H, body: JSON.stringify({ oauthCredentialsPath: CREDS2 }) })).json();
    ck('4 保存凭证路径并热应用', sw.ok && sw.state.credentials.subscriptionType === 'max', JSON.stringify(sw.error || sw.state.credentials));
    ck('4 写回 config.json', JSON.parse(fs.readFileSync(CFG, 'utf8')).oauthCredentialsPath === CREDS2);
    // 切到 apiKey 模式(带密钥)→ 再切回订阅
    const toKey = await (await fetch(base + '/admin/api/upstream', { method: 'POST', headers: H, body: JSON.stringify({ upstreamAuth: 'apiKey', upstreamApiKey: 'sk-ant-test-key' }) })).json();
    ck('4 切换到 apiKey 模式', toKey.ok && toKey.state.upstreamAuth === 'apiKey' && toKey.state.hasApiKey === true, JSON.stringify(toKey.error || ''));
    const st1 = await (await fetch(base + '/admin/api/status', { headers: H })).json();
    ck('4 热应用后 status 反映新模式', st1.upstreamAuth === 'apiKey', st1.upstreamAuth);
    const badSwitch = await (await fetch(base + '/admin/api/upstream', { method: 'POST', headers: H, body: JSON.stringify({ upstreamAuth: 'oauth', oauthCredentialsPath: path.join(TMP, 'nope.json') }) })).json();
    ck('4 切订阅但凭证不可用 → 拒绝并保持原状', badSwitch.ok === false && !!badSwitch.error);
    const backOauth = await (await fetch(base + '/admin/api/upstream', { method: 'POST', headers: H, body: JSON.stringify({ upstreamAuth: 'oauth', oauthCredentialsPath: CREDS }) })).json();
    ck('4 切回订阅模式', backOauth.ok && backOauth.state.upstreamAuth === 'oauth' && backOauth.state.credentials.subscriptionType === 'team');

    // ── 7 异常请求标注来源 ──
    // 无令牌 + 错误令牌(带自定义 UA),应记为异常来源并带 IP/UA/路径
    await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'evil-scanner/9' }, body: '{}' });
    await fetch(base + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer cct-wrong', 'content-type': 'application/json', 'user-agent': 'evil-scanner/9' }, body: '{}' });
    // 带 X-Forwarded-For 的异常请求(验证反代场景取真实来源)
    await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'via-proxy/1', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, body: '{}' });
    const cl = await (await fetch(base + '/admin/api/clients', { headers: H })).json();
    const noTok = (cl.others || []).find((c) => c.name.includes('未携带令牌'));
    const badTok = (cl.others || []).find((c) => c.name.includes('令牌不匹配'));
    ck('7 异常来源被单列', !!noTok && !!badTok, JSON.stringify((cl.others || []).map((o) => o.name)));
    ck('7 标注来源 IP', !!(noTok.lastErrorIp || noTok.lastIp), JSON.stringify({ ip: noTok.lastErrorIp, ips: noTok.errorIps }));
    ck('7 标注 UA', /evil-scanner|via-proxy/.test(noTok.lastErrorUa || noTok.lastUa || ''), noTok.lastErrorUa);
    ck('7 标注请求路径', String(noTok.lastErrorPath || noTok.lastPath || '').includes('/v1/messages'), noTok.lastErrorPath);
    ck('7 X-Forwarded-For 取到真实来源', JSON.stringify(noTok.errorIps || {}).includes('203.0.113.9'), JSON.stringify(noTok.errorIps));
    ck('7 多来源 IP 计数', Object.keys(noTok.errorIps || {}).length >= 2, JSON.stringify(noTok.errorIps));

    // ── 6 日志分块持久化 + 分页 + 删除 ──
    // 打一批成功请求,凑出分页
    for (let i = 0; i < 12; i++) {
      await fetch(base + '/v1/messages', {
        method: 'POST', headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 8, messages: [{ role: 'user', content: 'q' + i }] }),
      });
    }
    await new Promise((r) => setTimeout(r, 300)); // 等落盘
    const logsDir = path.join(TMP, 'data', 'logs');
    ck('6 日志按 日期/小时 分块落盘', fs.existsSync(logsDir) && fs.readdirSync(logsDir).some((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), fs.existsSync(logsDir) ? fs.readdirSync(logsDir).join(',') : '(无目录)');
    const p1 = await (await fetch(base + '/admin/api/logs?limit=5&offset=0', { headers: H })).json();
    ck('6 分页第一页', p1.persisted === true && p1.logs.length === 5 && p1.total >= 15 && p1.hasMore === true, JSON.stringify({ n: p1.logs.length, total: p1.total }));
    const p2 = await (await fetch(base + '/admin/api/logs?limit=5&offset=5', { headers: H })).json();
    ck('6 分页第二页不重复', p2.logs.length === 5 && p2.logs[0].id !== p1.logs[0].id);
    ck('6 分页倒序(最新在前)', p1.logs[0].ts >= p1.logs[p1.logs.length - 1].ts);
    const perr = await (await fetch(base + '/admin/api/logs?errorsOnly=1&limit=50', { headers: H })).json();
    ck('6 仅异常过滤', perr.logs.length >= 3 && perr.logs.every((e) => e.status >= 400 || e.status === 0), String(perr.logs.length));
    const pq = await (await fetch(base + '/admin/api/logs?q=evil-scanner&limit=50', { headers: H })).json();
    ck('6 关键字搜索(命中 UA)', pq.logs.length >= 2 && pq.logs.every((e) => (e.ua || '').includes('evil-scanner')), String(pq.logs.length));
    const stats = await (await fetch(base + '/admin/api/logs/stats', { headers: H })).json();
    ck('6 存储概况', stats.enabled === true && stats.blocks >= 1 && stats.bytes > 0 && stats.retentionDays === 14, JSON.stringify({ b: stats.blocks, mb: stats.mb }));
    // 区间删除:删掉一个不含任何日志的历史区间 → 0 条
    const noop = await (await fetch(base + '/admin/api/logs/prune', { method: 'POST', headers: H, body: JSON.stringify({ from: 1, to: 2 }) })).json();
    ck('6 区间删除(空区间不误删)', noop.ok && noop.removedEntries === 0 && noop.stats.blocks >= 1, JSON.stringify(noop));
    // 全量删除:before=未来 → 全删
    const total0 = (await (await fetch(base + '/admin/api/logs?limit=1', { headers: H })).json()).total;
    const del = await (await fetch(base + '/admin/api/logs/prune', { method: 'POST', headers: H, body: JSON.stringify({ before: Date.now() + 60_000 }) })).json();
    ck('6 按时间删除生效', del.ok && del.removedEntries >= total0 && del.removedEntries > 0, JSON.stringify({ removed: del.removedEntries, was: total0 }));
    const after = await (await fetch(base + '/admin/api/logs?limit=5', { headers: H })).json();
    ck('6 删除后查询为空', after.logs.length === 0 && after.total === 0, JSON.stringify({ n: after.logs.length, t: after.total }));
    // 删除不影响累计统计
    const st2 = await (await fetch(base + '/admin/api/status', { headers: H })).json();
    ck('6 删日志不影响累计统计', st2.totalRequests >= 15, String(st2.totalRequests));
  } finally {
    child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)); up.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }

  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} 通过`);
  if (fails) { console.log('\n--- 服务端日志尾部 ---\n' + logs.split('\n').slice(-40).join('\n')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
