// 用户端(/u):普通用户登录后看自己被分配的设备用量、取回令牌明文、看自己的请求日志。
//
// 为什么不塞进 admin.js:这两套的权限边界完全不同,而越权是这个功能最大的风险。
// 两份独立的 session Map + 独立的前缀,比在同一个 handler 里靠 if (role==='admin')
// 判断可靠得多 —— 漏一个分支就是越权。
//
// 边界铁律(实现时逐条对应):
//   1. 用户能看到什么,由服务端从 user.tokenIds 推出,绝不采信请求里传来的令牌/客户端名
//   2. 每个请求都重新校验用户是否仍存在且未禁用(禁用要立刻生效)
//   3. 令牌明文只在显式请求时回显,且必须是自己绑定的,每次留审计

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tokenIdOf, effectiveQuota } from './users.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const UI_FILE = path.join(__dirname, 'user-ui.html');
const CHAT_UI_FILE = path.join(__dirname, 'chat-ui.html');
const MD_FILE = path.join(__dirname, 'md.js');
const TOKENS_FILE = path.join(__dirname, 'ui-tokens.css');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// 用户端的 tab ←→ URL(与管理台同样的做法:每个 tab 一个可收藏的地址)
export const USER_TABS = ['chat', 'devices', 'logs', 'account'];
const TAB_PATHS = new Set(USER_TABS.map((t) => '/' + t));

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

export function createUserPortal({ prefix = '/u', users, metrics, logStore, tokenAdmin, maskToken, clientIp, chat, config, log = () => {} }) {
  let ui = '';
  let chatUi = '';
  try {
    // md.js 只在前端用,但要保持它是可单测的 ESM 文件,所以内联时把 export 去掉
    // (函数声明进 <script> 作用域即可)。这样"渲染器可单测"和"零构建步骤"两者都保住。
    const mdSrc = fs.readFileSync(MD_FILE, 'utf8').replace(/^export /gm, '');
    chatUi = fs
      .readFileSync(CHAT_UI_FILE, 'utf8')
      // 用替换【函数】而不是替换串:替换串里的 $& / $` / $' 是特殊模式,
      // 被注入的 JS/CSS 里出现这些字符就会把内容篡改掉(曾导致整页被重复插入 3 次)
      .replace('/*__TOKENS__*/', () => fs.readFileSync(TOKENS_FILE, 'utf8'))
      .replace('/*__MD__*/', () => mdSrc);
  } catch (err) {
    log(`⚠️ 聊天页读取失败: ${err.message}`);
  }
  try {
    ui = fs.readFileSync(UI_FILE, 'utf8');
    // 设计令牌两个页面共享一份,避免各自漂移(这正是布局改造要根治的那类问题)
    const tokens = fs.readFileSync(TOKENS_FILE, 'utf8');
    ui = ui.replace('/*__TOKENS__*/', () => tokens);
  } catch (err) {
    log(`⚠️ 用户端页面读取失败: ${err.message}`);
  }

  const sessions = new Map(); // sessionToken -> { exp, user }

  function newSession(name) {
    const t = crypto.randomBytes(24).toString('base64url');
    sessions.set(t, { exp: Date.now() + SESSION_TTL_MS, user: name });
    return t;
  }

  // 每次都回查用户状态:删号/禁用/改绑要立刻生效,不能只信登录那一刻的判断
  function sessionUser(req, u) {
    const h = req.headers['authorization'];
    let s = h && h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
    if (!s && u) s = u.searchParams.get('s');
    if (!s) return null;
    const rec = sessions.get(s);
    if (!rec) return null;
    if (rec.exp < Date.now()) {
      sessions.delete(s);
      return null;
    }
    const live = users.activeUser(rec.user);
    if (!live) {
      sessions.delete(s); // 用户已被禁用/删除 → 会话立即作废
      return null;
    }
    return live;
  }

  // 该用户绑定的令牌(服务端推导,不采信任何客户端输入)
  function tokensOf(user) {
    const bound = new Set(user.tokenIds || []);
    return tokenAdmin
      .list()
      .map((t) => ({ ...t, id: tokenIdOf(t.token) }))
      .filter((t) => bound.has(t.id));
  }

  function statsByName() {
    const snap = metrics.snapshot();
    const m = new Map();
    for (const c of snap.clients || []) m.set(c.name, c);
    return m;
  }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const sub = u.pathname.slice(prefix.length) || '/';

    // 聊天是三栏布局的独立页面,不跟其它 tab 共用单页。
    // 页面本身不含数据,权限在 API 层挡(前端会显示服务端返回的原因)。
    if (req.method === 'GET' && sub.replace(/\/+$/, '') === '/chat') {
      const body = Buffer.from(chatUi, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
      return res.end(body);
    }

    // 页面:每个 tab 一个 URL,都返回同一份单页
    if (req.method === 'GET' && (sub === '/' || sub === '' || TAB_PATHS.has(sub.replace(/\/+$/, '')))) {
      const body = Buffer.from(ui, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
      return res.end(body);
    }

    if (sub === '/api/login' && req.method === 'POST') {
      const b = await readJson(req);
      const r = users.authenticate(b.username, b.password);
      if (!r.ok) {
        log(`用户端登录失败(${String(b.username || '').slice(0, 32)}): ${r.error} · ip=${clientIp(req)}`);
        return sendJson(res, 401, { error: r.error });
      }
      log(`用户端登录成功: ${r.user.name} · ip=${clientIp(req)}`);
      return sendJson(res, 200, { session: newSession(r.user.name), ttlMs: SESSION_TTL_MS, user: r.user });
    }

    if (sub === '/api/logout' && req.method === 'POST') {
      const h = req.headers['authorization'];
      const s = h && h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
      if (s) sessions.delete(s);
      return sendJson(res, 200, { ok: true });
    }

    // 以下都要登录
    if (!sub.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    const me = sessionUser(req, u);
    if (!me) return sendJson(res, 401, { error: '未登录或会话过期' });

    // 我的设备 + 用量(只含绑定令牌;掩码,不给明文)
    if (sub === '/api/me' && req.method === 'GET') {
      const stats = statsByName();
      const devices = tokensOf(me).map((t) => ({
        id: t.id,
        name: t.name,
        tokenMask: maskToken(t.token),
        overrides: t.overrides || {},
        stats: stats.get(t.name) || null,
      }));
      const total = devices.reduce(
        (acc, d) => {
          const s = d.stats || {};
          acc.requests += s.requests || 0;
          acc.errors += s.errors || 0;
          acc.inTokens += s.inTokens || 0;
          acc.outTokens += s.outTokens || 0;
          acc.cacheReadTokens += s.cacheReadTokens || 0;
          acc.cacheWriteTokens += s.cacheWriteTokens || 0;
          acc.cost += s.cost || 0;
          return acc;
        },
        { requests: 0, errors: 0, inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
      );
      // cost 权限关掉时抹掉金额(用量本身仍可见 —— 他需要知道自己用了多少)
      if (!me.perms.cost) {
        for (const d of devices) if (d.stats) d.stats = { ...d.stats, cost: null };
        total.cost = null;
      }
      // 配额:与名下所有设备共享一份。给出已用/上限,让用户自己看得到。
      const q = effectiveQuota(me);
      const names = tokensOf(me).map((t) => t.name);
      const used = names.length ? metrics.usageFor(names, q.window) : { tokens: 0, cost: 0, requests: 0 };
      const quota = {
        window: q.window,
        tokens: q.tokens,
        costUsd: me.perms.cost ? q.costUsd : null, // 无 cost 权限就别回显金额上限
        unlimited: q.unlimited,
        usedTokens: used.tokens,
        usedCost: me.perms.cost ? used.cost : null,
      };
      return sendJson(res, 200, {
        user: me,
        devices,
        total,
        quota,
        // 接入信息:用户要在新设备上配置时照抄
        baseUrlHint: `http://<本服务地址>:${config.port}`,
      });
    }

    // 令牌明文回显 —— 只能取自己绑定的,每次留审计
    if (sub === '/api/token' && req.method === 'POST') {
      if (!me.perms.revealToken) {
        log(`[audit] 用户 ${me.name} 无 revealToken 权限,取令牌明文被拒 · ip=${clientIp(req)}`);
        return sendJson(res, 403, { error: '管理员已关闭你的「取回令牌明文」权限' });
      }
      const b = await readJson(req);
      const want = String(b.id || '');
      const hit = tokensOf(me).find((t) => t.id === want);
      if (!hit) {
        log(`[audit] 用户 ${me.name} 试图查看未绑定令牌 id=${want} —— 已拒绝 · ip=${clientIp(req)}`);
        return sendJson(res, 403, { error: '该令牌未分配给你' });
      }
      log(`[audit] 用户 ${me.name} 查看了令牌 ${hit.name}(${maskToken(hit.token)}) 的明文 · ip=${clientIp(req)} · ua=${String(req.headers['user-agent'] || '').slice(0, 120)}`);
      return sendJson(res, 200, { id: hit.id, name: hit.name, token: hit.token });
    }

    // 我的请求日志:client 一律由服务端从绑定关系推出,忽略请求里的任何 client 参数
    if (sub === '/api/logs' && req.method === 'GET') {
      if (!me.perms.logs) return sendJson(res, 403, { error: '管理员已关闭你的「查看请求日志」权限' });
      const names = tokensOf(me).map((t) => t.name);
      if (!names.length) return sendJson(res, 200, { logs: [], total: 0, hasMore: false });
      const limit = Math.min(200, Math.max(1, Number(u.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
      const filter = {
        offset,
        limit,
        client: names, // 数组:一次查完自己所有令牌
        errorsOnly: u.searchParams.get('errorsOnly') === '1',
      };
      const q = u.searchParams.get('q');
      if (q) filter.q = q;
      if (logStore.enabled) {
        const r = logStore.query(filter);
        return sendJson(res, 200, { logs: r.logs, total: r.total, hasMore: r.hasMore, persisted: true });
      }
      // 未启用分块存储:退化到内存最近记录
      const mem = metrics.recentLogs(500).filter((e) => names.includes(e.client));
      const page = mem.slice().reverse().slice(offset, offset + limit);
      return sendJson(res, 200, { logs: page, total: mem.length, hasMore: offset + limit < mem.length, persisted: false });
    }

    // 聊天:鉴权已在上面做完,这里只转交(路径前缀剥掉 /api/chat)
    if (sub.startsWith('/api/chat')) {
      if (!chat) return sendJson(res, 404, { error: '聊天未启用' });
      if (!me.perms.chat) return sendJson(res, 403, { error: '管理员已关闭你的「网页聊天」权限' });
      return chat.handle(sub.slice('/api/chat'.length) || '/', req, res, me);
    }

    // 自助改密(要验旧密码)
    if (sub === '/api/password' && req.method === 'POST') {
      const b = await readJson(req);
      const r = users.changePassword(me.name, b.oldPassword, b.newPassword);
      if (!r.ok) return sendJson(res, 400, r);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  return { handle, prefix, sessionCount: () => sessions.size };
}
