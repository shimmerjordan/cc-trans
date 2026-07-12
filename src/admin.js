import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CATALOG, CATALOG_VERSION } from './models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(__dirname, 'admin-ui.html');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 会话 12 小时

function sendJson(res, status, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

// 令牌的稳定标识(用于前端吊销时定位,明文不出服务端)
function idOf(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

export function createAdmin({ prefix, credentials, config, oauth, metrics, tokenAdmin, maskToken, log }) {
  const sessions = new Map(); // sessionToken -> expiresAt
  let ui = '';
  try {
    ui = fs.readFileSync(UI_FILE, 'utf8');
  } catch (err) {
    log(`⚠️ 管理台页面读取失败 ${UI_FILE}: ${err.message}`);
  }

  function newSession() {
    const t = crypto.randomBytes(24).toString('base64url');
    sessions.set(t, Date.now() + SESSION_TTL_MS);
    return t;
  }
  function checkSession(token) {
    const exp = sessions.get(token);
    if (!exp) return false;
    if (exp < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }
  function authed(req, u) {
    const h = req.headers['authorization'];
    let s = h && h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
    if (!s) s = u.searchParams.get('s');
    return s && checkSession(s);
  }

  function statusPayload() {
    let upstreamCred = config.upstreamAuth;
    let oauthExpiresInMin = null;
    if (oauth) {
      try {
        const info = oauth.peek ? oauth.peek() : null;
        if (info && info.expiresAt) oauthExpiresInMin = Math.round((info.expiresAt - Date.now()) / 60000);
      } catch {
        /* ignore */
      }
    }
    const snap = metrics.snapshot();
    return {
      service: 'cc-trans',
      upstreamAuth: config.upstreamAuth,
      upstreamBaseUrl: config.upstreamBaseUrl,
      subscriptionType: config.oauthInfo?.subscriptionType || null,
      oauthExpiresInMin,
      host: config.host,
      port: config.port,
      configFile: config.__file || null,
      canManageTokens: tokenAdmin.canManage(),
      startedAt: snap.startedAt,
      uptimeMs: snap.uptimeMs,
      since: snap.since,
      totalRequests: snap.totalRequests,
      totalErrors: snap.totalErrors,
      totals: snap.totals,
      daily: snap.daily,
      rateLimit: snap.rateLimit,
    };
  }

  // 订阅用量(与 Claude Code /usage 同源的 OAuth 接口),60s 缓存,失败时前端回落到限额头
  let usageCache = { ts: 0, data: null };
  async function fetchSubscriptionUsage() {
    if (!oauth) return { available: false, reason: '非订阅 OAuth 模式' };
    if (usageCache.data && Date.now() - usageCache.ts < 60_000) return usageCache.data;
    try {
      const token = await oauth.getAccessToken();
      const r = await fetch(config.upstreamBaseUrl + '/api/oauth/usage', {
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': oauth.beta },
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 120)}`);
      const j = JSON.parse(text);
      // 归一化:凡是带 utilization 的窗口都收进来(five_hour / seven_day / seven_day_opus …)
      const windows = [];
      for (const [k, v] of Object.entries(j)) {
        if (v && typeof v === 'object' && typeof v.utilization === 'number') {
          windows.push({ key: k, utilization: v.utilization, resetsAt: v.resets_at || null });
        }
      }
      const data = { available: true, fetchedAt: Date.now(), windows, raw: j };
      usageCache = { ts: Date.now(), data };
      return data;
    } catch (err) {
      return { available: false, reason: err.message };
    }
  }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const sub = u.pathname.slice(prefix.length) || '/';

    // 页面(无需登录,页面本身不含敏感数据;数据接口才鉴权)
    if ((sub === '/' || sub === '') && req.method === 'GET') {
      const body = Buffer.from(ui, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
      return res.end(body);
    }

    // 元信息(无需鉴权):供登录页显示默认用户名
    if (sub === '/api/meta' && req.method === 'GET') {
      return sendJson(res, 200, { service: 'cc-trans', user: credentials.user });
    }

    // 登录(账号 + 密码)
    if (sub === '/api/login' && req.method === 'POST') {
      const b = await readJson(req);
      if (!credentials.verify(b.username || '', b.password || '')) {
        log(`管理台登录失败(账号或密码错误)`);
        return sendJson(res, 401, { error: '账号或密码错误' });
      }
      log(`管理台登录成功`);
      return sendJson(res, 200, { session: newSession(), ttlMs: SESSION_TTL_MS });
    }

    // 以下接口都要登录
    if (sub.startsWith('/api/')) {
      if (!authed(req, u)) return sendJson(res, 401, { error: '未登录或会话过期' });
    } else {
      return sendJson(res, 404, { error: 'not found' });
    }

    if (sub === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, statusPayload());
    }

    if (sub === '/api/usage' && req.method === 'GET') {
      return sendJson(res, 200, await fetchSubscriptionUsage());
    }

    if (sub === '/api/password' && req.method === 'POST') {
      const b = await readJson(req);
      const r = credentials.changePassword(b.oldPassword || '', b.newPassword || '');
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (sub === '/api/clients' && req.method === 'GET') {
      const snap = metrics.snapshot();
      const statByName = new Map(snap.clients.map((c) => [c.name, c]));
      // 配置里的令牌:只暴露 掩码 + 稳定 id(明文永不出服务端)
      const tokens = tokenAdmin.list().map((t) => ({
        id: idOf(t.token),
        name: t.name,
        tokenMask: maskToken(t.token),
        overrides: t.overrides || {},
        stats: statByName.get(t.name) || null,
      }));
      const configuredNames = new Set(tokenAdmin.list().map((t) => t.name));
      const others = snap.clients.filter((c) => !configuredNames.has(c.name));
      return sendJson(res, 200, { canManage: tokenAdmin.canManage(), tokens, others });
    }

    if (sub === '/api/tokens' && req.method === 'POST') {
      if (!tokenAdmin.canManage()) return sendJson(res, 400, { error: '当前用环境变量配置令牌,无法在线增删;请改用 config.json' });
      const b = await readJson(req);
      const name = String(b.name || '').trim() || 'client';
      const entry = tokenAdmin.add(name);
      log(`管理台新增客户端令牌: ${name} (${maskToken(entry.token)})`);
      return sendJson(res, 200, { name: entry.name, token: entry.token }); // 明文只在创建时返回一次
    }

    if (sub === '/api/tokens/overrides' && req.method === 'POST') {
      if (!tokenAdmin.canManage()) return sendJson(res, 400, { error: '当前用环境变量配置令牌,无法在线修改;请改用 config.json' });
      const b = await readJson(req);
      const target = tokenAdmin.list().find((t) => idOf(t.token) === String(b.id || ''));
      if (!target) return sendJson(res, 404, { error: '未找到该令牌' });
      const saved = tokenAdmin.setOverrides(target.token, b.overrides || {});
      log(`管理台更新 ${target.name} 的参数下发: ${JSON.stringify(saved)}`);
      return sendJson(res, 200, { ok: true, overrides: saved });
    }

    // 模型目录(内置)+ 参数规则说明
    if (sub === '/api/models' && req.method === 'GET') {
      return sendJson(res, 200, { catalogVersion: CATALOG_VERSION, catalog: CATALOG });
    }

    // 从上游拉取实际可用模型列表(手动"检查更新");OAuth 订阅或静态密钥均尝试
    if (sub === '/api/models/refresh' && req.method === 'POST') {
      try {
        const headers = { 'anthropic-version': '2023-06-01' };
        if (oauth) {
          headers['authorization'] = `Bearer ${await oauth.getAccessToken()}`;
          headers['anthropic-beta'] = oauth.beta;
        } else if (config.upstreamAuthToken) {
          headers['authorization'] = `Bearer ${config.upstreamAuthToken}`;
        } else if (config.upstreamApiKey) {
          headers['x-api-key'] = config.upstreamApiKey;
        }
        const r = await fetch(config.upstreamBaseUrl + '/v1/models?limit=100', { headers });
        const text = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 160)}`);
        const j = JSON.parse(text);
        const known = new Set(CATALOG.map((m) => m.id));
        const live = (j.data || []).map((m) => ({
          id: m.id,
          displayName: m.display_name || m.id,
          inCatalog: known.has(m.id),
        }));
        return sendJson(res, 200, { ok: true, fetchedAt: Date.now(), live });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message });
      }
    }

    if (sub === '/api/tokens/revoke' && req.method === 'POST') {
      if (!tokenAdmin.canManage()) return sendJson(res, 400, { error: '当前用环境变量配置令牌,无法在线增删' });
      const b = await readJson(req);
      const target = tokenAdmin.list().find((t) => idOf(t.token) === String(b.id || ''));
      if (!target) return sendJson(res, 404, { ok: false, error: '未找到该令牌' });
      const ok = tokenAdmin.revoke(target.token);
      log(`管理台吊销令牌 ${target.name} (${maskToken(target.token)}): ${ok ? '成功' : '失败'}`);
      return sendJson(res, ok ? 200 : 404, { ok });
    }

    if (sub === '/api/logs' && req.method === 'GET') {
      const limit = Math.min(Number(u.searchParams.get('limit')) || 200, 500);
      return sendJson(res, 200, { logs: metrics.recentLogs(limit) });
    }

    if (sub === '/api/logs/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.on('error', () => {});
      res.write(': connected\n\n');
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
      const unsub = metrics.subscribe((entry) => {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      });
      req.on('close', () => {
        clearInterval(keepAlive);
        unsub();
      });
      return;
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  return { handle };
}
