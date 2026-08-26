// 登录入口测试。覆盖三件此前没有的事:
//   1. 统一登录入口(/ 与 /login):浏览器打开首页就能登,不必先知道该去 /admin 还是 /u
//   2. 走错门的提示:普通用户在 /admin 登、管理员在 /u 登,都要被指去对的那扇门
//      —— 而且只在密码【已经验过】的前提下才这么说,它不能变成账号存在性探测器
//   3. 登录节流:三个登录接口此前都能被无限次高速试密码
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePorts } from './_ports.mjs';
import { createLoginGuard, loginKeys } from '../src/login_guard.js';

const [PORT] = await freePorts(1);
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

// ── 1. 节流器本身(不起服务,纯单元)──
{
  let now = 1_000_000;
  const g = createLoginGuard({ now: () => now });
  const keys = loginKeys('admin', '1.2.3.4', 'root');

  ok('初始不被锁', g.check(keys).ok);
  for (let i = 0; i < 4; i++) g.fail(keys);
  ok('4 次失败还不锁(误输密码是常事)', g.check(keys).ok);
  const r5 = g.fail(keys);
  ok('第 5 次失败开始锁', r5.locked && r5.retryAfterSec > 0, `retryAfter=${r5.retryAfterSec}s`);
  ok('锁定期内直接拒绝', !g.check(keys).ok);

  now += 31_000;
  ok('30 秒后自动解锁', g.check(keys).ok);

  // 阶梯:继续试,惩罚要变重
  for (let i = 0; i < 3; i++) g.fail(keys);
  const r8 = g.check(keys);
  ok('累计 8 次后锁得更久', !r8.ok && r8.retryAfterSec > 60, `retryAfter=${r8.retryAfterSec}s`);

  // 成功一次就清账 —— 否则自己偶尔输错几次,之后一整天都在被惩罚
  g.succeed(keys);
  ok('登录成功后计数清零', g.check(keys).ok);

  // 两个维度各记一份:同一个 IP 换账号试,IP 那一份照样在涨
  const g2 = createLoginGuard({ now: () => now });
  for (let i = 0; i < 5; i++) g2.fail(loginKeys('admin', '9.9.9.9', 'user' + i));
  ok('同一 IP 横扫不同账号也会被锁', !g2.check(loginKeys('admin', '9.9.9.9', 'brand-new')).ok);
  ok('别的 IP 不受牵连', g2.check(loginKeys('admin', '8.8.8.8', 'user0')).ok);

  // scope 隔离:管理台的失败不该把用户端也锁上
  const g3 = createLoginGuard({ now: () => now });
  for (let i = 0; i < 6; i++) g3.fail(loginKeys('admin', '7.7.7.7', 'x'));
  ok('管理台被锁时用户端不受影响', g3.check(loginKeys('user', '7.7.7.7', 'x')).ok);
}

// ── 起服务 ──
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-login-'));
const configFile = path.join(temp, 'config.json');
fs.writeFileSync(
  configFile,
  JSON.stringify({
    host: '127.0.0.1',
    port: PORT,
    upstreamAuth: 'apiKey',
    upstreamApiKey: 'sk-test',
    upstreamBaseUrl: 'http://127.0.0.1:1',
    clientTokens: [{ token: 'cct-' + 'a'.repeat(32), name: 'dev-a' }],
    adminEnabled: true,
    adminUser: 'root',
    adminPassword: 'root-pw-12345',
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

const J = { 'content-type': 'application/json' };
const bearer = (s) => ({ authorization: 'Bearer ' + s });
const post = (p, b, h = {}) => fetch(BASE + p, { method: 'POST', headers: { ...J, ...h }, body: JSON.stringify(b || {}) });
const get = (p, h = {}) => fetch(BASE + p, { headers: h });

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await get('/health')).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

try {
  ok('服务启动', await waitUp());

  // ── 2. 根路径按 Accept 分流 ──
  // 已有的探活脚本 / docker healthcheck 打的就是 /,它们必须继续拿到 JSON。
  {
    const plain = await get('/');
    const pj = await plain.json().catch(() => null);
    ok('根路径对非浏览器仍是健康检查 JSON', plain.status === 200 && pj && pj.ok === true);

    const html = await get('/', { accept: 'text/html,application/xhtml+xml' });
    const body = await html.text();
    ok('浏览器打开根路径拿到登录页', html.status === 200 && body.includes('<!doctype html>') && body.includes('cc-trans'));
    ok('登录页含账号密码表单', body.includes('id="user"') && body.includes('id="pw"'));
    ok('登录页注入了设计令牌(与其它页共享一份)', body.includes('--accent'));

    const at = await get('/login');
    ok('/login 也返回登录页', at.status === 200 && (await at.text()).includes('id="form"'));

    ok('/health 始终是 JSON', (await (await get('/health', { accept: 'text/html' })).json()).ok === true);
  }

  // ── 3. 登录页启动元信息 ──
  {
    const d = await (await get('/api/login')).json();
    ok('meta 给出管理台登录名', d.adminUser === 'root', d.adminUser);
    ok('meta 给出两个门的地址', d.adminPortal === '/admin' && d.userPortal === '/u');
    ok('还没有普通用户时 hasUsers=false', d.hasUsers === false);
  }

  // ── 4. 统一入口登录 ──
  let adminSession = null;
  {
    const bad = await post('/api/login', { username: 'root', password: 'nope' });
    ok('密码错误 401', bad.status === 401);

    const r = await post('/api/login', { username: 'root', password: 'root-pw-12345' });
    const d = await r.json();
    adminSession = d.session;
    ok('管理员从统一入口登录成功', r.ok && !!d.session);
    ok('返回身份与落地页', d.role === 'admin' && d.home === '/admin/overview', JSON.stringify({ role: d.role, home: d.home }));
    ok('返回 sessionStorage 键名(前后端只在一处约定)', d.storeKey === 'cc-trans-admin');
    // 签出来的会话必须真能用在管理台上
    ok('统一入口签的会话在管理台有效', (await get('/admin/api/status', bearer(d.session))).ok);
    // 但它不该在用户端也能用 —— 两套 session 互不相认是这里最重要的边界
    ok('管理台会话在用户端无效', (await get('/u/api/me', bearer(d.session))).status === 401);
  }

  // 建两个普通用户
  const clients = await (await get('/admin/api/clients', bearer(adminSession))).json();
  const devId = clients.tokens[0].id;
  await post('/admin/api/users', { name: 'zoe', password: 'zoe-pw-123456', tokenIds: [devId] }, bearer(adminSession));
  await post('/admin/api/users', { name: 'ned', password: 'ned-pw-123456' }, bearer(adminSession));
  await post('/admin/api/users/disable', { name: 'ned', disabled: true }, bearer(adminSession));

  {
    ok('有用户后 hasUsers=true', (await (await get('/api/login')).json()).hasUsers === true);

    const r = await post('/api/login', { username: 'zoe', password: 'zoe-pw-123456' });
    const d = await r.json();
    ok('普通用户从统一入口登录成功', r.ok && d.role === 'user');
    ok('有聊天权限的用户直接落在聊天页', d.home === '/u/chat', d.home);
    ok('用户会话在用户端有效', (await get('/u/api/me', bearer(d.session))).ok);
    ok('用户会话在管理台无效', (await get('/admin/api/status', bearer(d.session))).status === 401);

    // 被禁用要照实说:回一句"账号或密码错误"会让人一直以为是自己记错了密码
    const dis = await post('/api/login', { username: 'ned', password: 'ned-pw-123456' });
    ok('被禁用的账号 403 且说明原因', dis.status === 403 && /禁用/.test((await dis.json()).error || ''));
  }

  // ── 5. 走错门的提示(本次要解决的第一个问题)──
  {
    // 普通用户拿自己的账号去管理台登
    const r = await post('/admin/api/login', { username: 'zoe', password: 'zoe-pw-123456' });
    const d = await r.json();
    ok('普通用户在管理台登录:不是笼统的"账号或密码错误"', r.status === 409, `status=${r.status}`);
    ok('明确告知这是普通用户账号', /普通用户账号/.test(d.error || ''), d.error);
    ok('并给出用户端地址', d.redirect === '/u' && d.role === 'user');
    ok('没有签发任何会话', !d.session);

    // 管理员拿管理台账号去用户端登
    const r2 = await post('/u/api/login', { username: 'root', password: 'root-pw-12345' });
    const d2 = await r2.json();
    ok('管理员在用户端登录:被指回管理台', r2.status === 409 && d2.redirect === '/admin', `status=${r2.status}`);
    ok('用户端也不会给管理员签会话', !d2.session);

    // 关键的安全性质:密码不对时【一律】回落到通用错误。
    // 否则这个提示就成了"这个用户名存在吗"的探测器。
    const probe = await post('/admin/api/login', { username: 'zoe', password: 'wrong-guess' });
    ok('密码不对时不泄露账号存在(仍是 401 通用错误)', probe.status === 401, `status=${probe.status}`);
    const pj = await probe.json();
    ok('通用错误里不含账号名', !String(pj.error || '').includes('zoe'), pj.error);
    ok('通用错误里不提用户端', !pj.redirect);
  }

  // ── 6. 公告 ──
  {
    const zoe = await (await post('/api/login', { username: 'zoe', password: 'zoe-pw-123456' })).json();
    ok('默认没有公告', (await (await get('/u/api/announcement', bearer(zoe.session))).json()).announcement === null);

    const set = await post('/admin/api/announcement', { text: '今晚 23:00 重启升级', level: 'warn' }, bearer(adminSession));
    ok('管理员可写公告', set.ok);
    const a = (await (await get('/u/api/announcement', bearer(zoe.session))).json()).announcement;
    ok('用户端读到公告', a && a.text === '今晚 23:00 重启升级' && a.level === 'warn', JSON.stringify(a));
    ok('公告带更新时间(前端据此判断"这条看过了")', a.updatedAt > 0);
    ok('/u/api/me 里也带公告', !!(await (await get('/u/api/me', bearer(zoe.session))).json()).announcement);
    ok('公告写回了 config.json', JSON.parse(fs.readFileSync(configFile, 'utf8')).announcement.text === '今晚 23:00 重启升级');

    const clear = await post('/admin/api/announcement', { text: '' }, bearer(adminSession));
    ok('清空公告', clear.ok && (await clear.json()).announcement === null);

    // 公告是登录后才可见的,不该变成匿名可读的信息面
    ok('未登录读不到公告', (await get('/u/api/announcement')).status === 401);
  }

  // ── 7. 「退出其它设备」 ──
  // 排在节流测试【之前】:节流会把本机 IP 这一维锁住,之后同一个 IP 上的正常
  // 登录也会被拒 —— 那恰恰是它该有的行为,所以爆破那一节必须放到最后。
  {
    const a = await (await post('/u/api/login', { username: 'zoe', password: 'zoe-pw-123456' })).json();
    const b = await (await post('/u/api/login', { username: 'zoe', password: 'zoe-pw-123456' })).json();
    ok('两台设备都在线', (await get('/u/api/me', bearer(a.session))).ok && (await get('/u/api/me', bearer(b.session))).ok);
    const rv = await post('/u/api/sessions/revoke', {}, bearer(b.session));
    ok('退出其它设备成功', rv.ok);
    ok('另一台掉线了', (await get('/u/api/me', bearer(a.session))).status === 401);
    ok('自己这台还在(否则等于把自己也踢了)', (await get('/u/api/me', bearer(b.session))).ok);

    // /u/api/me 要能看到当前有哪些会话
    const me = await (await get('/u/api/me', bearer(b.session))).json();
    ok('me 里列出在线会话', Array.isArray(me.sessions) && me.sessions.length === 1, JSON.stringify(me.sessions && me.sessions.length));
    ok('标出了哪一条是当前会话', me.sessions[0].current === true);
  }

  // ── 9. 管理台改密后其它会话失效、自己这条留着 ──
  {
    const s1 = await (await post('/admin/api/login', { username: 'root', password: 'root-pw-12345' })).json();
    const s2 = await (await post('/admin/api/login', { username: 'root', password: 'root-pw-12345' })).json();
    ok('两条管理台会话都可用', (await get('/admin/api/status', bearer(s1.session))).ok && (await get('/admin/api/status', bearer(s2.session))).ok);
    const ch = await post('/admin/api/account', { oldPassword: 'root-pw-12345', newPassword: 'root-pw-67890' }, bearer(s2.session));
    const cj = await ch.json();
    ok('改管理台密码成功', ch.ok && cj.passwordChanged, JSON.stringify(cj));
    ok('别处的管理台会话立即失效', (await get('/admin/api/status', bearer(s1.session))).status === 401);
    ok('发起改密的那条仍然可用', (await get('/admin/api/status', bearer(s2.session))).ok);
    ok('管理台弱密码被拒', !(await post('/admin/api/account', { oldPassword: 'root-pw-67890', newPassword: 'abc' }, bearer(s2.session))).ok);
    ok('管理台新旧密码相同被拒', !(await post('/admin/api/account', { oldPassword: 'root-pw-67890', newPassword: 'root-pw-67890' }, bearer(s2.session))).ok);
  }

  // ── 9. 端到端的登录节流 ──【必须放最后】
  // 它会把 admin|ip|127.0.0.1 这一维锁住:同一个 IP 上后续的管理台登录一律被拒。
  // 这不是副作用,这就是要的效果 —— 一个 IP 在猛试密码时,该 IP 就该被挡住。
  // 代价是本机上的正常登录也一起被挡,所以放在所有其它用例之后。
  {
    let sawLimit = null;
    for (let i = 0; i < 9 && !sawLimit; i++) {
      const r = await post('/admin/api/login', { username: 'bruteforce-target', password: 'guess-' + i });
      if (r.status === 429) sawLimit = { at: i + 1, body: await r.json() };
    }
    ok('连续试密码会被节流拦下', !!sawLimit, sawLimit ? `第 ${sawLimit.at} 次开始 429` : '试满 9 次都没被拦');
    ok('429 里带等待秒数', sawLimit && sawLimit.body.retryAfterSec > 0, sawLimit && String(sawLimit.body.retryAfterSec));
    ok('审计日志记下了锁定', /登录连续失败/.test(srvLog));
    // IP 维度确实生效:换个账号名也进不来
    const other = await post('/admin/api/login', { username: 'root', password: 'root-pw-67890' });
    ok('锁定期内同 IP 的正确密码也被拒(IP 维度生效)', other.status === 429, `status=${other.status}`);

    // 用户端有自己的 scope,不该被管理台的锁牵连
    const u = await post('/u/api/login', { username: 'zoe', password: 'zoe-pw-123456' });
    ok('管理台被锁不影响用户端登录', u.ok, `status=${u.status}`);
  }
} catch (err) {
  fail++;
  console.log('FAIL  测试异常:', err.stack || err.message);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 200));
  try {
    fs.rmSync(temp, { recursive: true, force: true });
  } catch {}
}

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail) {
  console.log('\n--- 服务日志 ---\n' + srvLog.slice(-3000));
  process.exit(1);
}
