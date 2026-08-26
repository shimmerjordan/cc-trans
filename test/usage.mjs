// 「普通用户看用量」的验收:
//   1 有自己的配额 → 只给自己的额度(scope=user),【不带】账户整体额度
//   2 没有配额     → 给账户整体额度(scope=account,5 小时/7 天那些窗口)
//   3 金额跟着 perms.cost 走;但"额外用量额度用尽"这条告警不跟着走(它解释的是失败原因)
//   4 用户端不能强制刷新上游(force 被忽略),两边共用同一份缓存
//   5 usage 接口不可用时,从 anthropic-ratelimit-* 头回落(单位 0~1 → 0~100)
//   6 未登录拿不到任何东西
// 外加 subscription_usage.js 的纯函数单测(单位换算/金额指数/告警判定)。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePorts } from './_ports.mjs';
import { normalizeUsage, barsFromUsage, barsFromHeaders, spendAlertOf, toMs, WINDOW_LABELS } from '../src/subscription_usage.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [UP, PORT] = await freePorts(2);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-'));
const CFG = path.join(TMP, 'config.json');
const CREDS = path.join(TMP, 'creds.json');
const TOK_A = 'cct-usage-a';
const TOK_B = 'cct-usage-b';

fs.writeFileSync(CFG, JSON.stringify({
  port: PORT, host: '127.0.0.1',
  upstreamBaseUrl: `http://127.0.0.1:${UP}`,
  upstreamAuth: 'oauth',
  oauthCredentialsPath: CREDS,
  adminEnabled: true, adminUser: 'admin', adminPassword: 'secret123',
  dataDir: path.join(TMP, 'data'),
  // 关掉自动标题:它是【非流式】的第二次上游调用,会把聊天那一轮采到的限额头覆盖掉,
  // 让下面那条断言变成在跟标题请求赛跑(第一次就撞上了)
  chatAutoTitle: false,
  clientTokens: [{ token: TOK_A, name: 'dev-a' }, { token: TOK_B, name: 'dev-b' }],
}, null, 2));
fs.writeFileSync(CREDS, JSON.stringify({
  claudeAiOauth: { accessToken: 'sk-oat-x', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, subscriptionType: 'max' },
}));

// 与 admin2.mjs 同一份真实响应形状(2026-07-30 抓的),数值固定便于断言
const USAGE_FIXTURE = {
  five_hour: { utilization: 48.0, resets_at: '2026-07-30T09:59:59+00:00' },
  seven_day: { utilization: 44.0, resets_at: '2026-08-02T02:59:59+00:00' },
  seven_day_opus: null,
  extra_usage: {
    is_enabled: true, monthly_limit: 5000, used_credits: 5008.0, utilization: 100.0,
    currency: 'USD', decimal_places: 2, disabled_reason: null, spend_limit_reached: false,
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

let USAGE_MODE = 'fail'; // 先让 usage 接口挂掉,才测得到限额头回落(成功结果会被缓存 10 分钟)
let usageHits = 0;
const up = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if ((req.url || '').startsWith('/api/oauth/usage')) {
      usageHits++;
      if (USAGE_MODE !== 'ok') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'nope' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(USAGE_FIXTURE));
    }
    let j = null;
    try { j = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    // 网页聊天走 stream:true,普通转发走非流式 —— 两条路给【不同的百分比】,
    // 才能分辨出限额头到底是从哪条路上采到的(聊天那条不经过 handleProxy,曾经漏采)
    if (j && j.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'anthropic-ratelimit-unified-5h-utilization': '0.31',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
      });
      const send = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
      send({ type: 'message_start', message: { usage: { input_tokens: 40 } } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } });
      send({ type: 'message_delta', delta: {}, usage: { output_tokens: 3 } });
      send({ type: 'message_stop' });
      return res.end();
    }
    // 普通转发:带上限额头(注意是 0~1 的比例,不是百分比)
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-5h-utilization': '0.48',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
      'anthropic-ratelimit-unified-7d-utilization': '0.9',
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-overage-status': 'rejected',
      'anthropic-ratelimit-unified-overage-disabled-reason': 'spend_limit_reached',
    });
    res.end(JSON.stringify({ id: 'm1', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 500, output_tokens: 200 } }));
  });
});

const results = [];
const ck = (n, c, e = '') => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? ' — ' + e : ''}`); };

async function main() {
  // ── 纯函数单测(不需要服务) ──
  {
    const u = normalizeUsage(USAGE_FIXTURE);
    ck('单测 normalizeUsage 收下三条 limits', u.limits.length === 3, String(u.limits.length));
    ck('单测 金额指数:spend 用 exponent($50.08)', u.spend.used.amount === 50.08 && u.spend.limit.amount === 50, JSON.stringify(u.spend));
    ck('单测 金额指数:extra_usage 用 decimal_places(照抄 spend 会算错)', u.extraUsage.used.amount === 50.08, JSON.stringify(u.extraUsage.used));
    const bars = barsFromUsage(u);
    ck('单测 优先用 limits[](带模型细分)', bars.length === 3 && bars.some((b) => b.model === 'Fable'), JSON.stringify(bars.map((b) => b.label)));
    ck('单测 模型细分窗口的标签带上模型名', bars.some((b) => b.label === '7 天窗口 · Fable'), JSON.stringify(bars.map((b) => b.label)));
    ck('单测 当前生效的窗口被标出来', bars.find((b) => b.key === 'session').isActive === true);
    const wOnly = barsFromUsage({ limits: [], windows: u.windows });
    ck('单测 没有 limits[] 时退回顶层窗口', wOnly.length === 2 && wOnly[0].label === WINDOW_LABELS.five_hour, JSON.stringify(wOnly.map((b) => b.label)));
    ck('单测 额外用量额度不混进窗口条(它是金额)', !wOnly.some((b) => b.key === 'extra_usage'));
    const hb = barsFromHeaders({
      'anthropic-ratelimit-unified-5h-utilization': '0.48',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-overage-status': 'rejected',
    });
    ck('单测 限额头 0~1 → 0~100(混了会把 48% 显示成 0%)', hb.bars[0].percent === 48, JSON.stringify(hb.bars[0]));
    ck('单测 限额头 rejected → critical', hb.bars[0].severity === 'critical');
    ck('单测 额外用量额度被拒会被拎出来', hb.overageRejected === true);
    ck('单测 toMs 认 unix 秒 与 ISO 串', toMs(1753000000) === 1753000000000 && toMs('2026-07-30T09:59:59+00:00') === Date.parse('2026-07-30T09:59:59+00:00'));
    const al = spendAlertOf(USAGE_FIXTURE.spend, null);
    ck('单测 spend 100%/critical → 判定为已用尽', al.exhausted === true && al.percent === 100, JSON.stringify(al));
    ck('单测 告警里不含金额(没有 cost 权限的人也要能看到这条)', !('used' in al) && !('limit' in al), JSON.stringify(al));
    ck('单测 没有 spend/extra_usage 时不硬造告警', spendAlertOf(null, null) === null);
    // 真实账号实测:percent=0 + enabled=false + disabled_reason=out_of_credits。
    // 照着 percent 画一根 0% 的条会读成"还有余量",而事实是压根没有兜底额度。
    const noCredit = spendAlertOf({ percent: 0, severity: 'normal', enabled: false, disabledReason: 'out_of_credits' }, null);
    ck('单测 「没有兜底额度」与「还剩很多」区分得开', noCredit.enabled === false && noCredit.exhausted === false && noCredit.reason === 'out_of_credits', JSON.stringify(noCredit));
    ck('单测 有兜底额度时 enabled 为真', spendAlertOf(USAGE_FIXTURE.spend, null).enabled === true);
    // severity 缺失时按百分比推:官方偶尔不给
    const derived = barsFromUsage({ limits: [{ kind: 'session', percent: 96, severity: '', resets_at: null, scope: null, is_active: false }] });
    ck('单测 官方没给 severity 时按百分比推(96% → critical)', derived[0].severity === 'critical', derived[0].severity);
  }

  await new Promise((r) => up.listen(UP, r));
  const child = spawn('node', ['src/server.js'], { cwd: ROOT, env: { ...process.env, CC_TRANS_CONFIG: CFG }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', (d) => (logs += d)); child.stderr.on('data', (d) => (logs += d));
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

  try {
    const login = await (await fetch(base + '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'secret123' }) })).json();
    const H = { authorization: 'Bearer ' + login.session, 'content-type': 'application/json' };
    const post = (p, b) => fetch(base + '/admin' + p, { method: 'POST', headers: H, body: JSON.stringify(b) });

    // 建三个用户:有配额 / 无配额 / 无配额且无 cost 权限
    const ulist = await (await fetch(base + '/admin/api/users', { headers: H })).json();
    const idA = ulist.tokens.find((t) => t.name === 'dev-a').id;
    const idB = ulist.tokens.find((t) => t.name === 'dev-b').id;
    ck('前置 建有配额的用户', (await (await post('/api/users', { name: 'capped', password: 'pw-capped-1', tokenIds: [idA], quota: { window: 'month', tokens: 1000, costUsd: 0 } })).json()).ok === true);
    ck('前置 建无配额的用户', (await (await post('/api/users', { name: 'freeuser', password: 'pw-free-1', tokenIds: [idB] })).json()).ok === true);
    ck('前置 建无 cost 权限的用户', (await (await post('/api/users', { name: 'nocost', password: 'pw-nocost-1', tokenIds: [idB], perms: { cost: false } })).json()).ok === true);

    const asUser = async (name, pw) => {
      const r = await (await fetch(base + '/u/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: pw }) })).json();
      return { authorization: 'Bearer ' + r.session };
    };
    const HC = await asUser('capped', 'pw-capped-1');
    const HF = await asUser('freeuser', 'pw-free-1');
    const HN = await asUser('nocost', 'pw-nocost-1');
    const q = async (h) => (await fetch(base + '/u/api/quota', { headers: h })).json();

    // ── 6 未登录 ──
    const anon = await fetch(base + '/u/api/quota');
    ck('6 未登录拿不到用量', anon.status === 401, String(anon.status));

    // ── 5 usage 接口挂了 → 从限额头回落 ──
    // 先走一次【网页聊天】。它不经过 handleProxy,而限额头的采集原本只写在那里 ——
    // 漏掉的症状是:只用网页聊天的人永远看不到账户额度,页面还一点错都不报。
    const chatRes = await fetch(base + '/u/api/chat/stream', {
      method: 'POST', headers: { ...HF, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好', model: 'claude-opus-4-8' }),
    });
    await chatRes.text();
    const fbChat = await q(HF);
    ck('5 网页聊天这条路也采集限额头(0.31 → 31%)',
      fbChat.account.source === 'headers' && (fbChat.account.bars.find((b) => b.key === '5h') || {}).percent === 31,
      JSON.stringify(fbChat.account.bars));

    // 再跑一个直接转发的请求(不同的百分比,才分得清是从哪条路采到的)
    await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOK_B }, body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }) });
    const fb = await q(HF);
    ck('5 没有自己的配额 → 看账户整体额度', fb.scope === 'account', JSON.stringify(fb).slice(0, 200));
    ck('5 usage 接口不可用时回落到限额头', fb.account.available === true && fb.account.source === 'headers', JSON.stringify(fb.account).slice(0, 200));
    ck('5 限额头的比例被换算成百分比(0.48 → 48%)', (fb.account.bars.find((b) => b.key === '5h') || {}).percent === 48, JSON.stringify(fb.account.bars));
    ck('5 限额头 0.9 → 90% 且标成 warn', (fb.account.bars.find((b) => b.key === '7d') || {}).severity === 'warn', JSON.stringify(fb.account.bars));
    ck('5 窗口名被翻译过(不是 5h/7d 这种原始键)', fb.account.bars.every((b) => b.label && b.label !== b.key), JSON.stringify(fb.account.bars.map((b) => b.label)));
    ck('5 额外用量额度被拒 → 给出已用尽告警(529 真凶)', fb.account.alert && fb.account.alert.exhausted === true, JSON.stringify(fb.account.alert));
    ck('5 回落也带上取数时间', typeof fb.account.fetchedAt === 'number' && fb.account.fetchedAt > 0);

    // ── 1 有自己的配额 → 只看自己的 ──
    await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOK_A }, body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }) });
    const cp = await q(HC);
    ck('1 有配额 → scope=user', cp.scope === 'user', JSON.stringify(cp).slice(0, 200));
    ck('1 有配额时【不】下发账户整体额度(能看什么由服务端定)', cp.account === undefined, JSON.stringify(Object.keys(cp)));
    ck('1 已用量按自己名下令牌统计(in500+out200=700)', cp.mine.usedTokens === 700, String(cp.mine.usedTokens));
    ck('1 上限与窗口一起给出', cp.mine.tokens === 1000 && cp.mine.window === 'month' && cp.mine.windowLabel === '本月', JSON.stringify(cp.mine));
    ck('1 最紧的那一项算成百分比(700/1000=70%)', cp.mine.percent === 70, String(cp.mine.percent));
    ck('1 另一个用户的用量不算进来(dev-b 上那些不在里面)', cp.mine.deviceCount === 1 && cp.mine.usedTokens === 700);
    ck('1 自己的额度也给成 bars(与账户额度同一个形状,前端一套渲染)', cp.mine.bars.length === 1 && cp.mine.bars[0].kind === 'tokens' && cp.mine.bars[0].percent === 70, JSON.stringify(cp.mine.bars));

    // ── 2 usage 接口恢复 → 用它(比限额头细,带模型细分) ──
    USAGE_MODE = 'ok';
    const before = usageHits;
    const fb2 = await q(HF);
    ck('2 usage 接口可用时优先用它', fb2.account.source === 'oauth', JSON.stringify(fb2.account).slice(0, 160));
    ck('2 三条窗口都在(含模型细分)', fb2.account.bars.length === 3 && fb2.account.bars.some((b) => b.model === 'Fable'), JSON.stringify(fb2.account.bars.map((b) => b.label)));
    ck('2 百分比原样(接口给的是 0~100)', (fb2.account.bars.find((b) => b.key === 'session') || {}).percent === 48);
    ck('2 重置时间归一成毫秒时间戳', typeof fb2.account.bars[0].resetsAt === 'number' && fb2.account.bars[0].resetsAt > 1e12);
    ck('2 有 cost 权限 → 给出金额明细', fb2.account.spend && fb2.account.spend.used.amount === 50.08, JSON.stringify(fb2.account.spend));

    // ── 4 用户端不能强制刷新上游;缓存两边共用 ──
    const hitsAfterFirst = usageHits;
    ck('4 第一次取账户额度只问上游一次', hitsAfterFirst - before === 1, `${before} → ${hitsAfterFirst}`);
    await q(HF);
    await (await fetch(base + '/u/api/quota?force=1', { headers: HF })).json();
    ck('4 用户端重复取、甚至传 force=1,都不再问上游', usageHits === hitsAfterFirst, `hits=${usageHits}`);
    const adm = await (await fetch(base + '/admin/api/usage', { headers: H })).json();
    ck('4 管理台与用户端共用同一份缓存(上游仍是那一次)', usageHits === hitsAfterFirst && adm.available === true, `hits=${usageHits}`);
    await (await fetch(base + '/admin/api/usage?force=1', { headers: H })).json();
    ck('4 只有管理台的「刷新」能穿透缓存', usageHits === hitsAfterFirst + 1, `hits=${usageHits}`);

    // ── 3 金额跟着 perms.cost 走,告警不跟着走 ──
    const nc = await q(HN);
    ck('3 无 cost 权限:不下发金额明细', nc.account.spend === undefined && nc.account.extraUsage === undefined, JSON.stringify(Object.keys(nc.account)));
    ck('3 无 cost 权限:百分比照给(那是"还能不能发"的答案)', nc.account.bars.length === 3);
    ck('3 无 cost 权限:额外额度用尽的告警照给(它解释失败原因)', nc.account.alert && nc.account.alert.exhausted === true, JSON.stringify(nc.account.alert));
    ck('3 无 cost 权限:告警里没有金额', nc.account.alert && !('used' in nc.account.alert));
    const ncCap = await (await post('/api/users/quota', { name: 'nocost', quota: { window: 'day', tokens: 0, costUsd: 5 } })).json();
    ck('3 前置 给无 cost 权限的用户设一个金额配额', ncCap.ok === true, JSON.stringify(ncCap));
    const nc2 = await q(HN);
    ck('3 无 cost 权限:自己的金额上限也抹掉,但用量口径仍在', nc2.scope === 'user' && nc2.mine.costUsd === null && nc2.mine.usedCost === null, JSON.stringify(nc2.mine));
    // 只有金额配额 + 没有 cost 权限:金额抹掉了,但"还剩多少"必须仍然答得出来 ——
    // 否则这个人有一道限额却看不见它,撞上 429 时毫无预兆。
    ck('3 无 cost 权限:金额额度的百分比照给(比例不泄露金额)', nc2.mine.bars.length === 1 && nc2.mine.bars[0].kind === 'cost' && nc2.mine.bars[0].limit === null && typeof nc2.mine.bars[0].percent === 'number', JSON.stringify(nc2.mine.bars));

    // ── 管理员侧同名接口(聊天页两个入口共用一份渲染) ──
    const aq = await (await fetch(base + '/admin/api/quota', { headers: H })).json();
    ck('管理员 /admin/api/quota 同形状,scope=account', aq.scope === 'account' && aq.mine.unlimited === true && aq.account.available === true, JSON.stringify(aq).slice(0, 160));
    const aqAnon = await fetch(base + '/admin/api/quota');
    ck('管理员接口未登录同样拿不到', aqAnon.status === 401, String(aqAnon.status));
  } finally {
    child.kill('SIGTERM');
    up.close();
    await new Promise((r) => setTimeout(r, 200));
    if (results.includes(false)) console.log('\n--- server logs ---\n' + logs.slice(-3000));
  }

  const bad = results.filter((r) => !r).length;
  console.log(`\n${results.length - bad}/${results.length} 通过`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); up.close(); process.exit(1); });
