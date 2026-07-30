// upstreamAuth: 'inherit' —— 从本机 Claude Code 的 settings.json 继承上游地址与令牌,
// 把这台 cc-trans 变成级联中转(外网机器只连得到本机,却想复用本机已配的那台中转)。
//
// 这个套件盯死四件最容易出错的事:
//   1. **真的注入了继承来的令牌** —— 而不是 config.json 里那个被忽略的静态密钥
//   2. **改文件不用重启** —— inherit 的全部价值就在这个跟随上;缓存做错就退化成快照
//   3. **自环必须拦在启动阶段** —— settings.json 指回自己会无限套娃,现场没人看得懂
//   4. **地址也跟着走** —— 只跟令牌不跟地址,换机器时会拿新令牌打旧地址
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { inspectInheritSettings, detectSelfLoop, defaultSettingsPath } from '../src/upstream_auth.js';
import { freePorts } from './_ports.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// 端口动态分配,不写死 —— 开发机上随时有别的服务占着某个"看起来没人用"的号,
// 撞上时测试实例只是静默 EADDRINUSE,而请求打到陌生服务、拿回莫名的 401,排查方向全跑偏
const [UP_A, UP_B, PORT] = await freePorts(3); // 假上游 A(扮演内网那台 cc-trans)/ 假上游 B(验证换地址也跟随)/ 本机代理
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-inherit-'));

// 「别的机器」的地址,用来断言非自环。默认取 RFC 5737 的文档保留段(TEST-NET-3),
// 它保证不会是任何真实主机 —— 写死一个真实内网 IP 有两个坏处:泄露拓扑,
// 而且哪天那个地址恰好绑在本机上,这条断言就会莫名其妙地失败。
// 需要拿真实拓扑验证时:CC_TRANS_TEST_PEER=10.0.0.5 node test/inherit.mjs
const PEER_HOST = process.env.CC_TRANS_TEST_PEER || '203.0.113.9';

const CFG = path.join(TMP, 'config.json');
const SETTINGS = path.join(TMP, 'settings.json');
const TOK = 'cct-for-remote-machine'; // 发给外网机器 C 的令牌
const UPSTREAM_TOK = 'cct-upstream-one'; // 本机 claude 连内网中转用的令牌
const UPSTREAM_TOK2 = 'cct-upstream-two-longer'; // 轮换后的

const results = [];
const ck = (n, c, e = '') => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? ' — ' + e : ''}`); };

const writeSettings = (env) => fs.writeFileSync(SETTINGS, JSON.stringify({ env, permissions: { allow: [] } }, null, 2));
const writeConfig = (extra = {}) => fs.writeFileSync(CFG, JSON.stringify({
  port: PORT, host: '127.0.0.1',
  upstreamAuth: 'inherit',
  inheritSettingsPath: SETTINGS,
  // 刻意留一个【错的】静态上游:inherit 必须完全忽略它。
  // 漏了这一条就会出现"看起来能跑,其实一直在用 config.json 里那个"的假通过。
  upstreamBaseUrl: 'http://127.0.0.1:9',
  upstreamApiKey: 'sk-should-never-be-used',
  adminEnabled: true, adminUser: 'admin', adminPassword: 'secret123',
  clientTokens: [{ token: TOK, name: 'remote-c' }],
  ...extra,
}, null, 2));

// 假上游:记录收到的鉴权头,回一个最小的 messages 响应
function makeUpstream(tag) {
  const state = { headers: null, hits: 0 };
  const srv = http.createServer((req, res) => {
    state.headers = req.headers;
    state.hits++;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_' + tag, model: 'claude-opus-4-8', content: [{ type: 'text', text: tag }],
        stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 },
      }));
    });
  });
  return { srv, state };
}
const A = makeUpstream('A');
const B = makeUpstream('B');

// 起一个 cc-trans 子进程,返回 { child, logs(), stop() }
function start(cfgFile = CFG) {
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((r) => A.srv.listen(UP_A, r));
  await new Promise((r) => B.srv.listen(UP_B, r));
  const base = `http://127.0.0.1:${PORT}`;
  const msg = () => fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });

  // ── 0. 纯函数:自环判定 ────────────────────────────────────────────
  // 端口相同 + 主机是本机的任意写法 = 自环。少认一种写法就等于漏一条自环路径。
  ck('0 自环: localhost 同端口', detectSelfLoop(`http://localhost:${PORT}`, PORT) === true);
  ck('0 自环: 127.0.0.1 同端口', detectSelfLoop(`http://127.0.0.1:${PORT}`, PORT) === true);
  ck('0 自环: 127.0.0.2 也算(整个 /8)', detectSelfLoop(`http://127.0.0.2:${PORT}`, PORT) === true);
  ck('0 自环: 0.0.0.0 同端口', detectSelfLoop(`http://0.0.0.0:${PORT}`, PORT) === true);
  ck('0 非自环: 同主机不同端口', detectSelfLoop(`http://127.0.0.1:${PORT + 1}`, PORT) === false);
  ck('0 非自环: 别的机器同端口', detectSelfLoop(`http://${PEER_HOST}:${PORT}`, PORT) === false, PEER_HOST);
  ck('0 非自环: 官方 API', detectSelfLoop('https://api.anthropic.com', PORT) === false);
  ck('0 默认来源路径在 ~/.claude 下', defaultSettingsPath().endsWith(path.join('.claude', 'settings.json')), defaultSettingsPath());

  // ── 1. 纯函数:三类来源错误各自可辨 ────────────────────────────────
  // 报错指错方向比不报还糟 —— 这几条就是为了不让人对着"没登录"白折腾。
  {
    const missing = inspectInheritSettings(path.join(TMP, 'nope', 'settings.json'), PORT);
    ck('1 文件不存在: ok=false 且 code=ENOENT', !missing.ok && missing.code === 'ENOENT', missing.code + ' ' + missing.error);

    const noEnvFile = path.join(TMP, 'no-env.json');
    fs.writeFileSync(noEnvFile, JSON.stringify({ permissions: {} }));
    const noEnv = inspectInheritSettings(noEnvFile, PORT);
    ck('1 缺 ANTHROPIC_BASE_URL: 点名这个字段', !noEnv.ok && /ANTHROPIC_BASE_URL/.test(noEnv.error), noEnv.error);
    ck('1 缺地址时提示改用 oauth/apiKey', /oauth|apiKey/.test(noEnv.error), noEnv.error);

    const noTokFile = path.join(TMP, 'no-token.json');
    fs.writeFileSync(noTokFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${UP_A}` } }));
    const noTok = inspectInheritSettings(noTokFile, PORT);
    ck('1 缺令牌: 点名两个字段名', !noTok.ok && /ANTHROPIC_AUTH_TOKEN/.test(noTok.error) && /ANTHROPIC_API_KEY/.test(noTok.error), noTok.error);

    const badJsonFile = path.join(TMP, 'bad.json');
    fs.writeFileSync(badJsonFile, '{ this is not json');
    const badJson = inspectInheritSettings(badJsonFile, PORT);
    ck('1 JSON 坏了: 说是 JSON 问题,不说"没配"', !badJson.ok && /JSON/.test(badJson.error), badJson.error);

    const loopFile = path.join(TMP, 'loop.json');
    fs.writeFileSync(loopFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`, ANTHROPIC_AUTH_TOKEN: 'x' } }));
    const loop = inspectInheritSettings(loopFile, PORT);
    ck('1 自环: 探测就能看出来', !loop.ok && /自环/.test(loop.error), loop.error);

    const relFile = path.join(TMP, 'rel.json');
    fs.writeFileSync(relFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'not-a-url', ANTHROPIC_AUTH_TOKEN: 'x' } }));
    const rel = inspectInheritSettings(relFile, PORT);
    ck('1 地址不是 http(s): 直接拒', !rel.ok && /http/.test(rel.error), rel.error);

    // 无读权限(root 无视权限位,那种环境下跳过)
    const denyFile = path.join(TMP, 'deny.json');
    fs.writeFileSync(denyFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${UP_A}`, ANTHROPIC_AUTH_TOKEN: 'x' } }));
    fs.chmodSync(denyFile, 0o000);
    const denied = inspectInheritSettings(denyFile, PORT);
    fs.chmodSync(denyFile, 0o600);
    if (process.getuid && process.getuid() === 0) {
      console.log('SKIP  1 无读权限(以 root 运行,权限位拦不住)');
    } else {
      // 关键是别把权限问题说成"JSON 不合法"——那会让人去查文件内容,方向就错了
      ck('1 无读权限: code=EACCES 且说的是权限', !denied.ok && denied.code === 'EACCES' && /权限/.test(denied.error), denied.code + ' ' + denied.error);
      ck('1 无读权限: 不说"JSON 不合法"', !denied.ok && !/JSON/.test(denied.error), denied.error);
    }

    // 软链接穿透:~/.claude 常被链到别的盘,inherit 也得穿过去(与订阅凭证同一套诊断)
    const realDir = path.join(TMP, 'realhome');
    fs.mkdirSync(realDir, { recursive: true });
    const realSettings = path.join(realDir, 'settings.json');
    fs.writeFileSync(realSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${UP_A}`, ANTHROPIC_AUTH_TOKEN: 'via-link' } }));
    const linkSettings = path.join(TMP, 'linked-settings.json');
    fs.symlinkSync(realSettings, linkSettings);
    const viaLink = inspectInheritSettings(linkSettings, PORT);
    ck('1 软链接: 能读且标出真实落点', viaLink.ok && viaLink.viaLink === true && viaLink.real === fs.realpathSync(realSettings), viaLink.real);

    const deadLink = path.join(TMP, 'dead-settings.json');
    fs.symlinkSync(path.join(TMP, 'never-mounted.json'), deadLink);
    const dead = inspectInheritSettings(deadLink, PORT);
    ck('1 死链: 说软链接断了,不说"没配过"', !dead.ok && dead.code === 'EBROKENLINK' && /软链接/.test(dead.error), dead.error);
  }

  // ── 2. 自环配置必须拦在启动阶段 ────────────────────────────────────
  {
    const loopSettings = path.join(TMP, 'loop-settings.json');
    fs.writeFileSync(loopSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`, ANTHROPIC_AUTH_TOKEN: 'x' } }));
    const loopCfg = path.join(TMP, 'loop-config.json');
    fs.writeFileSync(loopCfg, JSON.stringify({
      port: PORT, host: '127.0.0.1', upstreamAuth: 'inherit', inheritSettingsPath: loopSettings,
      clientTokens: [{ token: TOK, name: 'c' }],
    }, null, 2));
    const s = start(loopCfg);
    const code = await new Promise((r) => s.child.on('exit', r));
    ck('2 自环配置: 进程拒绝启动(退出码非 0)', code !== 0, 'exit=' + code);
    ck('2 自环配置: 错误里点名"自环"', /自环/.test(s.logs()), s.logs().split('\n').filter((l) => l.trim()).slice(-2).join(' | '));
    ck('2 自环配置: 并给出可执行的出路(改 apiKey)', /apiKey/.test(s.logs()));
  }

  // ── 3. 端到端:继承来的令牌与地址真的生效 ───────────────────────────
  writeSettings({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${UP_A}`, ANTHROPIC_AUTH_TOKEN: UPSTREAM_TOK });
  writeConfig();
  const srv = start();
  try {
    ck('3 服务启动', await waitReady(base));

    const r1 = await msg();
    ck('3 请求成功转发', r1.status === 200, String(r1.status));
    ck('3 上游 A 收到了请求', A.state.hits === 1, 'hits=' + A.state.hits);
    ck('3 注入的是继承来的令牌(Bearer)', A.state.headers.authorization === `Bearer ${UPSTREAM_TOK}`, A.state.headers.authorization);
    ck('3 客户端自己的令牌没有透给上游', !String(A.state.headers.authorization || '').includes(TOK));
    ck('3 config.json 里那个静态密钥被忽略', !A.state.headers['x-api-key'], A.state.headers['x-api-key'] || '(无)');
    // inherit 不是订阅模式:不该替客户端补 oauth 的 beta flag(过门禁是上游那一级的事)
    ck('3 不注入订阅 beta flag', !/oauth-2025-04-20/.test(A.state.headers['anthropic-beta'] || ''), A.state.headers['anthropic-beta'] || '(无)');

    const h = await (await fetch(base + '/health')).json();
    ck('3 health: upstreamAuth=inherit', h.upstreamAuth === 'inherit', h.upstreamAuth);
    ck('3 health: 上游是继承来的地址', h.upstream === `http://127.0.0.1:${UP_A}`, h.upstream);
    ck('3 health: 给出来源文件与令牌掩码', !!(h.inherit && h.inherit.file && h.inherit.tokenMask), JSON.stringify(h.inherit));
    ck('3 health: 掩码不泄露完整令牌', !JSON.stringify(h.inherit).includes(UPSTREAM_TOK), JSON.stringify(h.inherit));

    // ── 4. 改 settings.json:不重启就跟随(令牌 + 地址一起换) ──────────
    // mtime 精度有限,等一下再写,免得同毫秒 + 同大小骗过缓存
    await sleep(20);
    writeSettings({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${UP_B}`, ANTHROPIC_AUTH_TOKEN: UPSTREAM_TOK2 });
    const r2 = await msg();
    ck('4 换文件后仍转发成功', r2.status === 200, String(r2.status));
    ck('4 地址跟随: 这次打到了上游 B', B.state.hits === 1, 'B.hits=' + B.state.hits);
    ck('4 地址跟随: 上游 A 没有再收到', A.state.hits === 1, 'A.hits=' + A.state.hits);
    ck('4 令牌跟随: 用的是轮换后的', B.state.headers.authorization === `Bearer ${UPSTREAM_TOK2}`, B.state.headers.authorization);
    const h2 = await (await fetch(base + '/health')).json();
    ck('4 health 也跟着变', h2.upstream === `http://127.0.0.1:${UP_B}`, h2.upstream);

    // ── 5. ANTHROPIC_API_KEY 走 x-api-key ───────────────────────────
    await sleep(20);
    writeSettings({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${UP_A}`, ANTHROPIC_API_KEY: 'sk-ant-from-settings' });
    const r3 = await msg();
    ck('5 只有 API_KEY 时也能转发', r3.status === 200, String(r3.status));
    ck('5 注入的是 x-api-key', A.state.headers['x-api-key'] === 'sk-ant-from-settings', A.state.headers['x-api-key']);
    ck('5 不再带 authorization', !A.state.headers.authorization, A.state.headers.authorization || '(无)');

    // AUTH_TOKEN 与 API_KEY 同时存在时,AUTH_TOKEN 优先(与 Claude Code 自身一致)
    await sleep(20);
    writeSettings({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${UP_A}`, ANTHROPIC_AUTH_TOKEN: UPSTREAM_TOK, ANTHROPIC_API_KEY: 'sk-ignored' });
    await msg();
    ck('5 两者都有时 AUTH_TOKEN 优先', A.state.headers.authorization === `Bearer ${UPSTREAM_TOK}` && !A.state.headers['x-api-key'], `${A.state.headers.authorization} / ${A.state.headers['x-api-key'] || '(无 x-api-key)'}`);

    // ── 6. 来源文件坏掉:502 且说清原因,不是 500 ──────────────────────
    await sleep(20);
    fs.writeFileSync(SETTINGS, '{ broken json');
    const rBad = await msg();
    const bodyBad = await rBad.json();
    ck('6 来源坏了: 502 而不是 500', rBad.status === 502, String(rBad.status));
    ck('6 来源坏了: 错误说清是凭证问题', /上游凭证不可用/.test(JSON.stringify(bodyBad)), JSON.stringify(bodyBad).slice(0, 160));
    // 修回去就该自愈,不用重启
    await sleep(20);
    writeSettings({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${UP_A}`, ANTHROPIC_AUTH_TOKEN: UPSTREAM_TOK });
    ck('6 修回去自愈(无需重启)', (await msg()).status === 200);

    // ── 7. 管理台:切模式、状态展示、探测 ─────────────────────────────
    const H = { 'content-type': 'application/json' };
    const login = await (await fetch(base + '/admin/api/login', { method: 'POST', headers: H, body: JSON.stringify({ username: 'admin', password: 'secret123' }) })).json();
    const AH = { ...H, authorization: 'Bearer ' + login.session };

    const ups = await (await fetch(base + '/admin/api/upstream', { headers: AH })).json();
    ck('7 读状态: upstreamAuth=inherit', ups.upstreamAuth === 'inherit', ups.upstreamAuth);
    ck('7 读状态: inherit.ok 且给出上游与掩码', ups.inherit && ups.inherit.ok && ups.inherit.baseUrl === `http://127.0.0.1:${UP_A}` && !!ups.inherit.tokenMask, JSON.stringify(ups.inherit));
    ck('7 读状态: 不回明文令牌', !JSON.stringify(ups).includes(UPSTREAM_TOK), '(已检查整个响应体)');
    ck('7 读状态: 生效地址=继承值,声明值另给', ups.upstreamBaseUrl === `http://127.0.0.1:${UP_A}` && ups.configuredBaseUrl === 'http://127.0.0.1:9', `${ups.upstreamBaseUrl} / ${ups.configuredBaseUrl}`);
    ck('7 读状态: 给出默认来源路径供前端提示', !!ups.defaultSettingsPath, ups.defaultSettingsPath);

    const probeOk = await (await fetch(base + '/admin/api/upstream/probe', { method: 'POST', headers: AH, body: JSON.stringify({ kind: 'inherit', path: SETTINGS }) })).json();
    ck('7 探测: 合法来源 ok=true', probeOk.ok === true, JSON.stringify(probeOk).slice(0, 120));
    const probeBad = await (await fetch(base + '/admin/api/upstream/probe', { method: 'POST', headers: AH, body: JSON.stringify({ kind: 'inherit', path: path.join(TMP, 'loop.json') }) })).json();
    ck('7 探测: 自环来源被判不可用', probeBad.ok === false && /自环/.test(probeBad.error), probeBad.error);

    // 切到 inherit 但指向一个不可用的来源 → 必须拒绝且【保持原样】
    const badSwitch = await (await fetch(base + '/admin/api/upstream', { method: 'POST', headers: AH, body: JSON.stringify({ upstreamAuth: 'inherit', inheritSettingsPath: path.join(TMP, 'loop.json') }) })).json();
    ck('7 切换到不可用来源被拒', badSwitch.ok === false && /继承来源不可用/.test(badSwitch.error), badSwitch.error);
    ck('7 被拒后仍能正常转发', (await msg()).status === 200);

    // 切到 apiKey:上游地址要还原成 config.json 里声明的那个,不能留着继承值
    const toKey = await (await fetch(base + '/admin/api/upstream', { method: 'POST', headers: AH, body: JSON.stringify({ upstreamAuth: 'apiKey', upstreamAuthToken: 'sk-static-now' }) })).json();
    ck('7 切到 apiKey 成功', toKey.ok === true && toKey.state.upstreamAuth === 'apiKey', JSON.stringify(toKey.error || toKey.state.upstreamAuth));
    ck('7 切到 apiKey: 地址还原为声明值', toKey.state.upstreamBaseUrl === 'http://127.0.0.1:9', toKey.state.upstreamBaseUrl);

    // 再切回 inherit
    const backInherit = await (await fetch(base + '/admin/api/upstream', { method: 'POST', headers: AH, body: JSON.stringify({ upstreamAuth: 'inherit' }) })).json();
    ck('7 切回 inherit 成功', backInherit.ok === true && backInherit.state.upstreamAuth === 'inherit', JSON.stringify(backInherit.error || ''));
    ck('7 切回后地址又是继承值', backInherit.state.upstreamBaseUrl === `http://127.0.0.1:${UP_A}`, backInherit.state.upstreamBaseUrl);
    const hitsBefore = A.state.hits;
    await msg();
    ck('7 切回后转发仍走继承来的上游', A.state.hits === hitsBefore + 1 && A.state.headers.authorization === `Bearer ${UPSTREAM_TOK}`, A.state.headers.authorization);

    // 非法模式名不该被写进配置
    const badMode = await (await fetch(base + '/admin/api/upstream', { method: 'POST', headers: AH, body: JSON.stringify({ upstreamAuth: 'nonsense' }) })).json();
    ck('7 非法模式名被忽略(仍是 inherit)', badMode.ok === true && badMode.state.upstreamAuth === 'inherit', JSON.stringify(badMode.state && badMode.state.upstreamAuth));
  } finally {
    await srv.stop();
    A.srv.close();
    B.srv.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
  }

  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} 通过`);
  if (fails) {
    console.log('\n--- 服务端日志尾部 ---\n' + srv.logs().split('\n').slice(-40).join('\n'));
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
