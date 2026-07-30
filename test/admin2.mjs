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
import { freePorts } from './_ports.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// 端口动态分配,不写死 —— 开发机上随时有别的服务占着某个"看起来没人用"的号,
// 撞上时测试实例只是静默 EADDRINUSE,而请求打到陌生服务、拿回莫名的 401,排查方向全跑偏
const [UP, PORT] = await freePorts(2); // 假上游 / 代理
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

// 订阅用量的【真实响应结构】(2026-07-30 从官方抓的形状,数值改成固定值便于断言)。
// 关键点:模型细分用量藏在 limits[].scope.model.display_name 里,而顶层那些
// seven_day_opus/seven_day_sonnet 实测全是 null —— 照着顶层键找细分会一无所获。
const USAGE_FIXTURE = {
  five_hour: { utilization: 48.0, resets_at: '2026-07-30T09:59:59+00:00' },
  seven_day: { utilization: 44.0, resets_at: '2026-08-02T02:59:59+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: {
    is_enabled: true, monthly_limit: 5000, used_credits: 5008.0, utilization: 100.0,
    currency: 'USD', decimal_places: 2, disabled_reason: null, user_disabled: false,
    spend_limit_reached: false, credits_ever_enabled: true,
  },
  limits: [
    { kind: 'session', group: 'session', percent: 48, severity: 'normal', resets_at: '2026-07-30T09:59:59+00:00', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 44, severity: 'normal', resets_at: '2026-08-02T02:59:59+00:00', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 13, severity: 'normal', resets_at: '2026-08-02T03:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
  spend: {
    used: { amount_minor: 5008, currency: 'USD', exponent: 2 },
    limit: { amount_minor: 5000, currency: 'USD', exponent: 2 },
    percent: 100, severity: 'critical', enabled: true, disabled_reason: null,
  },
};
const up = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if ((req.url || '').startsWith('/api/oauth/usage')) return res.end(JSON.stringify(USAGE_FIXTURE));
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

    // ── 6 订阅用量归一化 ──
    // 面板曾经因为解析的是【过时字段】(limit/remaining,官方早就换成 utilization/status)
    // 而永远显示"暂无数据" —— 头明明抓到了、数据就躺在 metrics 里。所以这里连
    // "字段名对不对"一起锁住,而不只是"接口通不通"。
    const usage = await (await fetch(base + '/admin/api/usage?force=1', { headers: H })).json();
    ck('6 用量接口可用', usage.available === true, JSON.stringify(usage.reason || ''));
    ck('6 顶层窗口被收下(five_hour/seven_day/extra_usage)', (usage.windows || []).length === 3, String((usage.windows || []).length));
    ck('6 limits 三条都在', (usage.limits || []).length === 3, String((usage.limits || []).length));
    const scoped = (usage.limits || []).find((l) => l.kind === 'weekly_scoped');
    ck('6 **模型细分用量带出模型名**', !!scoped && scoped.model === 'Fable', JSON.stringify(scoped || null));
    ck('6 模型细分的百分比正确', !!scoped && scoped.percent === 13, scoped && String(scoped.percent));
    const sess = (usage.limits || []).find((l) => l.kind === 'session');
    ck('6 当前生效的窗口被标出来', !!sess && sess.isActive === true);
    ck('6 severity 原样带出(前端按它上色,比按百分比猜准)', !!sess && sess.severity === 'normal');
    // 金额:官方用 minor unit + 指数,5008/10^2 = $50.08。算错会把 $50 显示成 $5008
    ck('6 spend 金额换算正确($50.08 / $50.00)', usage.spend && usage.spend.used.amount === 50.08 && usage.spend.limit.amount === 50, JSON.stringify(usage.spend));
    ck('6 spend 的 critical 被带出(529 真凶)', usage.spend && usage.spend.percent === 100 && usage.spend.severity === 'critical');
    // extra_usage 的指数字段叫 decimal_places(不是 exponent),照抄 spend 那套会算错
    ck('6 extraUsage 金额也换算正确', usage.extraUsage && usage.extraUsage.used.amount === 50.08 && usage.extraUsage.limit.amount === 50, JSON.stringify(usage.extraUsage));
    ck('6 extraUsage 利用率 100%', usage.extraUsage && usage.extraUsage.utilization === 100);

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
