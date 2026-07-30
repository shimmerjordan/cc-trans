// 环路防护(跳数头)。自环检测只认得出"上游就是本机"这一种形状,抓不到两类环:
// 容器里看不见宿主 IP、以及两台机器互相把对方当上游。跳数能兜住所有形状。
//
// 这个套件里最有说服力的一节是 3:让假上游把请求【原样打回】cc-trans 自己,
// 造出一个真实的环,验证跳数会累加并在上限处断掉,而不是把连接耗尽。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readHops, applyHops, hopsExceeded, isOfficialUpstream, HOPS_HEADER } from '../src/hops.js';
import { freePorts } from './_ports.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hops-'));
const TOK = 'cct-hops-test';
const MAX_HOPS = 3;

// 端口全部动态分配,不写死 —— 见 _ports.mjs 里为什么(踩过:18791 被一台无关网关占着)
let UP; // 普通假上游
let LOOP_UP; // 会把请求打回 cc-trans 的假上游(制造真实环)
let PORT;
let PORT_OFF; // maxHops=0(防护关闭)的实例
let PORT_LOOP; // 上游被配成"会把请求打回自己"的实例

const results = [];
const ck = (n, c, e = '') => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? ' — ' + e : ''}`); };

const mkConfig = (file, port, upstreamPort, extra = {}) => fs.writeFileSync(file, JSON.stringify({
  port, host: '127.0.0.1',
  upstreamAuth: 'apiKey',
  upstreamApiKey: 'sk-test',
  upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
  clientTokens: [{ token: TOK, name: 'hops' }],
  maxHops: MAX_HOPS,
  ...extra,
}, null, 2));

const CFG = path.join(TMP, 'config.json');
const CFG_OFF = path.join(TMP, 'config-off.json');
const CFG_LOOP = path.join(TMP, 'config-loop.json');

// 普通假上游:记录收到的头
const seen = { headers: null, hits: 0, failNext: 0, failStatus: 529 };
const up = http.createServer((req, res) => {
  seen.headers = req.headers;
  seen.hits++;
  // 前 failNext 次故意回过载状态码,用来验证 cc-trans 会自己退避重试
  if (seen.failNext > 0) {
    seen.failNext--;
    const chunks0 = [];
    req.on('data', (c) => chunks0.push(c));
    req.on('end', () => {
      res.writeHead(seen.failStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    });
    return;
  }
  // 先注册再消费:先 resume() 再挂 'end' 有竞态,小请求体可能在挂监听前就读完了,
  // 那样这个 handler 永远不回响应,表现是整个测试静默挂死(踩过一次)
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});

// 环路假上游:把请求连同跳数头原样转回【发起它的那个实例】—— 等价于"上游被配回了自己"。
// 于是 PORT_LOOP → loopUp → PORT_LOOP → loopUp … 构成真闭环,每绕一圈 cc-trans 都会 +1,
// 到上限就该被断掉;断不掉的话这里会一直转到超时(或端口/内存耗尽)。
const loopState = { rounds: 0 };
const loopUp = http.createServer((req, res) => {
  loopState.rounds++;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const fwd = { 'content-type': 'application/json', authorization: `Bearer ${TOK}` };
    if (req.headers[HOPS_HEADER]) fwd[HOPS_HEADER] = req.headers[HOPS_HEADER];
    try {
      const r = await fetch(`http://127.0.0.1:${PORT_LOOP}/v1/messages`, { method: 'POST', headers: fwd, body });
      const text = await r.text();
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(text);
    } catch (err) {
      res.writeHead(599, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err.message) }));
    }
  });
});

function start(cfgFile) {
  const child = spawn('node', ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, CC_TRANS_CONFIG: cfgFile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  return { child, logs: () => logs, stop: async () => { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)); } };
}
const waitReady = async (base) => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + '/health')).ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

async function main() {
  // ── 0. 纯函数 ──────────────────────────────────────────────────────
  ck('0 读跳数: 缺失当 0', readHops({}) === 0);
  ck('0 读跳数: 正常值', readHops({ [HOPS_HEADER]: '2' }) === 2);
  ck('0 读跳数: 大小写无关', readHops({ 'X-CC-Trans-Hops': '3' }) === 3);
  ck('0 读跳数: 非数字当 0(宁可少算也别拒正常请求)', readHops({ [HOPS_HEADER]: 'abc' }) === 0);
  ck('0 读跳数: 负数当 0', readHops({ [HOPS_HEADER]: '-5' }) === 0);
  ck('0 读跳数: 天文数字被夹到上界', readHops({ [HOPS_HEADER]: '99999999' }) === 1000);

  ck('0 官方上游: api.anthropic.com', isOfficialUpstream('https://api.anthropic.com') === true);
  ck('0 官方上游: 子域也算', isOfficialUpstream('https://console.anthropic.com/v1') === true);
  ck('0 官方上游: 自建中转不算', isOfficialUpstream('http://172.20.0.5:8787') === false);
  // 别把 anthropic.com.evil.com 误判成官方(那会让它悄悄拿不到跳数头)
  ck('0 官方上游: 后缀伪装不算', isOfficialUpstream('https://api.anthropic.com.evil.example') === false);
  ck('0 官方上游: 地址解析不了按非官方(带头是安全的一侧)', isOfficialUpstream('not-a-url') === false);

  {
    const h = { 'X-CC-TRANS-HOPS': '7', other: 'keep' };
    applyHops(h, 7, 'http://127.0.0.1:9999');
    ck('0 落实跳数: 旧值(任意大小写)被清掉,只留一个', Object.keys(h).filter((k) => k.toLowerCase() === HOPS_HEADER).length === 1, JSON.stringify(h));
    ck('0 落实跳数: 值是 incoming+1', h[HOPS_HEADER] === '8', h[HOPS_HEADER]);
    ck('0 落实跳数: 其它头不动', h.other === 'keep');

    const h2 = { [HOPS_HEADER]: '2' };
    applyHops(h2, 2, 'https://api.anthropic.com');
    ck('0 官方上游: 头被剥干净(不削弱身份伪装)', !Object.keys(h2).some((k) => k.toLowerCase() === HOPS_HEADER), JSON.stringify(h2));
  }

  ck('0 超限: 第 MAX 跳放行', hopsExceeded(MAX_HOPS - 1, MAX_HOPS) === false);
  ck('0 超限: 第 MAX+1 跳拒绝', hopsExceeded(MAX_HOPS, MAX_HOPS) === true);
  ck('0 超限: maxHops=0 表示关闭', hopsExceeded(999, 0) === false);
  ck('0 超限: maxHops 非法也当关闭', hopsExceeded(999, undefined) === false);

  // ── 1/2/3 端到端 ───────────────────────────────────────────────────
  [UP, LOOP_UP, PORT, PORT_OFF, PORT_LOOP] = await freePorts(5);
  mkConfig(CFG, PORT, UP);
  mkConfig(CFG_OFF, PORT_OFF, UP, { maxHops: 0 });
  await new Promise((r) => up.listen(UP, '127.0.0.1', r));
  await new Promise((r) => loopUp.listen(LOOP_UP, '127.0.0.1', r));
  const base = `http://127.0.0.1:${PORT}`;
  const msg = (hdr = {}) => fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json', ...hdr },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });

  const srv = start(CFG);
  const srvOff = start(CFG_OFF);
  try {
    ck('1 服务启动', await waitReady(base));

    // ── 1. 正常请求:跳数递增后带给上游 ──
    const r1 = await msg();
    ck('1 无跳数头的请求正常转发', r1.status === 200, String(r1.status));
    ck('1 上游收到 hops=1', seen.headers[HOPS_HEADER] === '1', seen.headers[HOPS_HEADER]);

    await msg({ [HOPS_HEADER]: '1' });
    ck('1 客户端带 1 → 上游收到 2', seen.headers[HOPS_HEADER] === '2', seen.headers[HOPS_HEADER]);

    await msg({ [HOPS_HEADER]: 'garbage' });
    ck('1 非法值按 0 处理 → 上游收到 1', seen.headers[HOPS_HEADER] === '1', seen.headers[HOPS_HEADER]);

    // ── 2. 超限:508,且不再打上游 ──
    const hitsBefore = seen.hits;
    const rOver = await msg({ [HOPS_HEADER]: String(MAX_HOPS) });
    const bodyOver = await rOver.json();
    ck('2 超限返回 508(而不是 502 —— 502 会让客户端重试,重试只会让环转更快)', rOver.status === 508, String(rOver.status));
    ck('2 错误里点名"环路"并给出上限', /环路/.test(bodyOver.error.message) && bodyOver.error.message.includes(String(MAX_HOPS)), bodyOver.error.message.slice(0, 90));
    ck('2 错误里提示常见成因(容器/互指)', /宿主|互相/.test(bodyOver.error.message));
    ck('2 超限请求没有打到上游', seen.hits === hitsBefore, `hits ${hitsBefore} → ${seen.hits}`);
    ck('2 刚好在上限内仍放行', (await msg({ [HOPS_HEADER]: String(MAX_HOPS - 1) })).status === 200);

    // ── 6. 上游过载:cc-trans 自己退避重试,客户端不该看到 529 ──
    // 529 是官方明确说"临时、应当指数退避重试"的状态码。原样透传只是把重试的活
    // 推给客户端,而客户端重试一样会撞;更糟的是 Claude Code 会把它显示成
    // "Repeated 529 Overloaded errors",看不出是中转没做重试。
    {
      seen.failNext = 1; // 第一次 529,第二次正常
      const t0 = Date.now();
      const r = await msg();
      const waited = Date.now() - t0;
      ck('6 上游先 529:客户端最终拿到 200', r.status === 200, String(r.status));
      ck('6 确实重试了(上游被打了两次)', seen.hits >= 2, 'hits=' + seen.hits);
      ck('6 重试前有退避(不是立刻重打)', waited >= 900, waited + 'ms');

      seen.failNext = 99; // 一直 529 → 重试用尽后如实透传
      seen.hits = 0;
      const r2 = await msg();
      ck('6 一直 529:重试用尽后透传 529 给客户端', r2.status === 529, String(r2.status));
      ck('6 总尝试次数受 UPSTREAM_ATTEMPTS 约束(3 次)', seen.hits === 3, 'hits=' + seen.hits);
      seen.failNext = 0;

      // 503 同样重试(上游/链路里的另一台 cc-trans 暂时不可用)
      seen.failStatus = 503;
      seen.failNext = 1;
      seen.hits = 0;
      const r3 = await msg();
      ck('6 503 也会重试并最终成功', r3.status === 200 && seen.hits >= 2, `${r3.status} hits=${seen.hits}`);

      // 429 刻意【不】重试:那是配额用尽,重试无益且会让限流更凶
      seen.failStatus = 429;
      seen.failNext = 1;
      seen.hits = 0;
      const r4 = await msg();
      ck('6 429 不重试,直接透传', r4.status === 429 && seen.hits === 1, `${r4.status} hits=${seen.hits}`);
      seen.failStatus = 529;
      seen.failNext = 0;
    }

    // ── 3. 真实环路:假上游把请求打回自己,跳数必须收敛 ──
    // 未防护时这里会一直转到端口/内存耗尽;防护生效则在上限处断开并把 508 沿链路传回。
    {
      mkConfig(CFG_LOOP, PORT_LOOP, LOOP_UP);
      const loopSrv = start(CFG_LOOP);
      try {
        ck('3 环路实例启动', await waitReady(`http://127.0.0.1:${PORT_LOOP}`));
        loopState.rounds = 0;
        // 这个实例的上游是 loopUp,而 loopUp 又把请求转回这个实例本身 —— 真闭环。
        const rLoop = await Promise.race([
          fetch(`http://127.0.0.1:${PORT_LOOP}/v1/messages`, {
            method: 'POST',
            headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('环路没有收敛(10 秒未返回)')), 10000)),
        ]);
        const text = await rLoop.text();
        ck('3 真实环路会在有限步内返回(而不是转到资源耗尽)', true);
        ck('3 环路被识别: 响应里带上 508 / 环路字样', /508|环路/.test(text) || rLoop.status === 508, `${rLoop.status} ${text.slice(0, 120)}`);
        // 每绕一圈跳数 +1,上限 MAX_HOPS 时必须停;留一点余量容忍实现细节
        ck('3 绕圈次数被跳数限住', loopState.rounds > 0 && loopState.rounds <= MAX_HOPS + 1, 'rounds=' + loopState.rounds);
      } finally {
        await loopSrv.stop();
      }
    }

    // ── 4. maxHops=0:防护关闭,但仍然递增(链路里别人开着也能生效)──
    const baseOff = `http://127.0.0.1:${PORT_OFF}`;
    ck('4 关闭防护的实例启动', await waitReady(baseOff));
    const hOff = await (await fetch(baseOff + '/health')).json();
    ck('4 health 暴露 maxHops(探针可据此告警)', hOff.maxHops === 0, String(hOff.maxHops));
    const rOff = await fetch(baseOff + '/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json', [HOPS_HEADER]: '99' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    ck('4 关闭后超大跳数也放行', rOff.status === 200, String(rOff.status));
    ck('4 关闭后仍然递增跳数', seen.headers[HOPS_HEADER] === '100', seen.headers[HOPS_HEADER]);
    ck('4 关闭时启动横幅明确告警', /环路防护已关闭/.test(srvOff.logs()), srvOff.logs().split('\n').filter((l) => /环路/.test(l)).join(' | '));

    // ── 5. 客户端伪造的跳数头不会原样透给上游 ──
    // (值只被用来计数,发出去的永远是本机算出来的 incoming+1)
    await msg({ [HOPS_HEADER]: '2' });
    ck('5 上游看到的是本机算出的值,不是客户端原值', seen.headers[HOPS_HEADER] === '3', seen.headers[HOPS_HEADER]);
    ck('5 上游只收到一个跳数头', Object.keys(seen.headers).filter((k) => k.toLowerCase() === HOPS_HEADER).length === 1);
  } finally {
    await srv.stop();
    await srvOff.stop();
    up.close();
    loopUp.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
  }

  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} 通过`);
  if (fails) {
    console.log('\n--- 服务端日志尾部 ---\n' + srv.logs().split('\n').slice(-30).join('\n'));
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
