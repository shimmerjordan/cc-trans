import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CATALOG, CATALOG_VERSION, DEFAULT_OVERRIDES } from './models.js';
import { applyHops } from './hops.js';
import { PERMS, DEFAULT_PERMS, QUOTA_WINDOWS, effectiveQuota } from './users.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(__dirname, 'admin-ui.html');
const TOKENS_FILE = path.join(__dirname, 'ui-tokens.css'); // 与用户端共享的设计令牌
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 会话 12 小时

// 每个 tab 对应一个 URL:这些路径都返回单页应用本体(前端据 pathname 选中对应 tab)
export const TABS = ['overview', 'clients', 'users', 'models', 'logs', 'settings'];
const TAB_PATHS = new Set(TABS.map((t) => '/' + t));

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

export function createAdmin({ prefix, credentials, config, getOauth, getUpstreamAuth, metrics, tokenAdmin, users, chat, chatUi, modelStore, logStore, storage, upstreamAdmin, maskToken, log }) {
  // provider 可被管理台热重建 —— 每次用时取当前实例,别缓存。
  // oauthNow() 只给订阅专属功能用(订阅用量面板);凡是"发一个上游请求"都该走
  // upstreamNow(),它对三种鉴权模式一视同仁。
  const oauthNow = () => (typeof getOauth === 'function' ? getOauth() : null);
  const upstreamNow = () => (typeof getUpstreamAuth === 'function' ? getUpstreamAuth() : null);
  const sessions = new Map(); // sessionToken -> expiresAt
  let ui = '';
  try {
    ui = fs.readFileSync(UI_FILE, 'utf8');
    // 设计令牌与用户端(/u)共享同一份文件,替换页面里的占位符 —— 不要在页面里
    // 再复制一份令牌,那是漂移的来源
    // 替换函数,不用替换串 —— 后者会把 CSS 里的 $& 之类当特殊模式
    ui = ui.replace('/*__TOKENS__*/', () => fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch (err) {
    log(`⚠️ 管理台页面读取失败 ${UI_FILE}: ${err.message}`);
  }

  // 管理员在「用户」页的那一行。字段刻意和 users.list() 的形状对齐,
  // 前端才能复用同一套单元格渲染;不同之处用 fixed* 标出来:
  // 设备/权限/配额由管理员身份固定决定,不是"没配"。
  function adminRow() {
    const tokens = tokenAdmin.list();
    return {
      name: credentials.user,
      isAdmin: true,
      note: credentials.note ? credentials.note() : '',
      createdAt: credentials.createdAt ? credentials.createdAt() : 0,
      // true = 这个日期是从 config.json 的文件时间推出来的近似值,不是真的注册时间
      createdApprox: credentials.createdApprox ? credentials.createdApprox() : false,
      lastLoginAt: credentials.lastLoginAt ? credentials.lastLoginAt() : 0,
      disabled: false,
      canManage: credentials.canManage ? credentials.canManage() : false,
      // 与普通用户同名的字段,值是"全部"
      tokens: tokens.map((t) => ({ id: idOf(t.token), name: t.name })),
      deviceCount: tokens.length,
      perms: Object.fromEntries(Object.keys(PERMS).map((k) => [k, true])),
      quota: { window: 'month', tokens: 0, costUsd: 0, unlimited: true },
      used: { tokens: 0, cost: 0, requests: 0 },
      fixed: {
        devices: '管理员始终拥有全部设备,不单独绑定',
        perms: '管理员固定拥有全部权限',
        quota: '管理员不受配额限制',
      },
    };
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
    let oauthExpiresInMin = null;
    const oauth = oauthNow();
    if (oauth) {
      try {
        const info = oauth.peek ? oauth.peek() : null;
        if (info && info.expiresAt) oauthExpiresInMin = Math.round((info.expiresAt - Date.now()) / 60000);
      } catch {
        /* ignore */
      }
    }
    const snap = metrics.snapshot();
    const up = upstreamNow();
    return {
      service: 'cc-trans',
      upstreamAuth: config.upstreamAuth,
      // 实际生效的地址:inherit 模式下是继承来的那个,不是 config.json 里写的
      upstreamBaseUrl: up ? up.baseUrl() : config.upstreamBaseUrl,
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

  // 订阅用量(与 Claude Code /usage 同源的 OAuth 接口),默认 10 分钟缓存(避免频繁调用被上游限流 429);
  // 前端「刷新」按钮传 force=1 可跳过缓存强制拉取。失败时前端回落到限额头。
  const USAGE_TTL_MS = 10 * 60 * 1000;
  let usageCache = { ts: 0, data: null };
  async function fetchSubscriptionUsage(force = false) {
    const oauth = oauthNow();
    if (!oauth) return { available: false, reason: '非订阅 OAuth 模式' };
    if (!force && usageCache.data && Date.now() - usageCache.ts < USAGE_TTL_MS) return usageCache.data;
    try {
      const token = await oauth.getAccessToken();
      const r = await fetch(config.upstreamBaseUrl + '/api/oauth/usage', {
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': oauth.beta },
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 120)}`);
      const j = JSON.parse(text);
      // 归一化。三处数据源各有各的用处,都要收(实测 2026-07-30 的真实响应):
      //   · limits[]  —— 最全的一处:含【模型细分】窗口(scope.model.display_name,如 "Fable")
      //                  与官方自己给的 severity。顶层那些 seven_day_opus/seven_day_sonnet
      //                  在实测账号上全是 null,细分数据其实只在这个数组里。
      //   · 顶层带 utilization 的对象 —— 老结构(five_hour/seven_day/extra_usage),继续收着兜底。
      //   · spend —— 额外用量额度(credits)的消费上限。**它满了会让主配额还有余量时也吃 529**,
      //              最容易被忽略、却最要紧,所以单独拎出来给前端做醒目告警。
      const windows = [];
      for (const [k, v] of Object.entries(j)) {
        if (v && typeof v === 'object' && typeof v.utilization === 'number') {
          windows.push({ key: k, utilization: v.utilization, resetsAt: v.resets_at || null });
        }
      }
      const limits = (Array.isArray(j.limits) ? j.limits : []).map((l) => ({
        kind: l.kind || '',
        group: l.group || '',
        percent: Number(l.percent) || 0,
        severity: l.severity || 'normal',
        resetsAt: l.resets_at || null,
        isActive: !!l.is_active,
        // 模型细分窗口把模型名带出来。id 实测常为 null,display_name 才是 "Fable" 这种可读名
        model: l.scope && l.scope.model ? l.scope.model.display_name || l.scope.model.id || null : null,
        surface: l.scope ? l.scope.surface || null : null,
      }));
      // 金额:官方用 minor unit + 指数(5008 / 10^2 = $50.08)。两个对象的指数字段名还不一样。
      const money = (m, expKey = 'exponent') => {
        if (!m || typeof m.amount_minor !== 'number') return null;
        const exp = Number(m[expKey]);
        return {
          amount: m.amount_minor / 10 ** (Number.isFinite(exp) ? exp : 2),
          currency: m.currency || 'USD',
        };
      };
      const sp = j.spend;
      const spend = sp ? {
        used: money(sp.used),
        limit: money(sp.limit),
        percent: Number(sp.percent) || 0,
        severity: sp.severity || 'normal',
        enabled: !!sp.enabled,
        disabledReason: sp.disabled_reason || null,
      } : null;
      const eu = j.extra_usage;
      const extraUsage = eu ? {
        isEnabled: !!eu.is_enabled,
        utilization: Number(eu.utilization) || 0,
        // 这里的指数字段叫 decimal_places(不是 exponent),别照抄 spend 那套
        used: money({ amount_minor: eu.used_credits, currency: eu.currency, decimal_places: eu.decimal_places }, 'decimal_places'),
        limit: money({ amount_minor: eu.monthly_limit, currency: eu.currency, decimal_places: eu.decimal_places }, 'decimal_places'),
        spendLimitReached: !!eu.spend_limit_reached,
        disabledReason: eu.disabled_reason || null,
      } : null;
      const data = { available: true, fetchedAt: Date.now(), windows, limits, spend, extraUsage };
      usageCache = { ts: Date.now(), data };
      return { ...data, cachedTtlMs: USAGE_TTL_MS };
    } catch (err) {
      return { available: false, reason: err.message };
    }
  }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const sub = u.pathname.slice(prefix.length) || '/';

    // 页面(无需登录,页面本身不含敏感数据;数据接口才鉴权)。
    // 每个 tab 一个 URL:/admin、/admin/overview、/admin/clients、/admin/models、/admin/logs、/admin/settings
    // 都返回同一份单页,前端按 pathname 决定初始 tab(刷新/收藏/后退都能保持)。
    if (req.method === 'GET' && (sub === '/' || sub === '' || TAB_PATHS.has(sub.replace(/\/+$/, '')))) {
      const body = Buffer.from(ui, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
      return res.end(body);
    }

    // 管理员聊天页(与 /u/chat 同一份 HTML,前端按路径推导 API 前缀)。
    // 管理员本就能看全部令牌,所以他的"可用设备"= 全部令牌。
    if (req.method === 'GET' && sub.replace(/\/+$/, '') === '/chat') {
      const body = Buffer.from(chatUi || '', 'utf8');
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

    // 管理员聊天:内部主体 __admin__,设备 = 全部令牌,权限全开。
    // 会话存在 chats/__admin__/,与普通用户目录互不相干(用户名是保留字,占不到)。
    if (sub.startsWith('/api/chat')) {
      if (!chat) return sendJson(res, 404, { error: '聊天未启用' });
      const me = {
        name: '__admin__',
        tokenIds: tokenAdmin.list().map((t) => idOf(t.token)),
        perms: { chat: true, logs: true, cost: true, revealToken: true },
        isAdmin: true,
      };
      return chat.handle(sub.slice('/api/chat'.length) || '/', req, res, me);
    }

    if (sub === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, statusPayload());
    }

    if (sub === '/api/usage' && req.method === 'GET') {
      const force = u.searchParams.get('force') === '1';
      const data = await fetchSubscriptionUsage(force);
      return sendJson(res, 200, { ...data, cachedAt: usageCache.ts || null });
    }

    // 本地 AI 订阅 / 上游凭证:读当前状态
    if (sub === '/api/upstream' && req.method === 'GET') {
      return sendJson(res, 200, upstreamAdmin ? upstreamAdmin.read() : { canManage: false });
    }

    // 探测某个来源文件是否可用(前端"检测"按钮)。kind: oauth=订阅凭证(默认)、
    // inherit=本机 Claude Code 配置 —— 两种文件格式不同,得按各自的解析器看。
    if (sub === '/api/upstream/probe' && req.method === 'POST') {
      const b = await readJson(req);
      return sendJson(res, 200, upstreamAdmin ? upstreamAdmin.probe(b.path, b.kind) : { ok: false, error: '不可用' });
    }

    // 保存并热应用上游设置(切换订阅/密钥、凭证路径、上游地址、代理)
    if (sub === '/api/upstream' && req.method === 'POST') {
      if (!upstreamAdmin) return sendJson(res, 400, { ok: false, error: '不可用' });
      const b = await readJson(req);
      const r = await upstreamAdmin.apply(b);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (sub === '/api/account' && req.method === 'GET') {
      // name 是与普通用户行对齐的字段名;user 是这个接口原有的叫法,留作别名
      const row = adminRow();
      return sendJson(res, 200, { ...row, user: row.name });
    }

    // 管理台账号:登录名 + 密码在一个接口里改(都是凭证,都验当前密码,任填其一)
    if (sub === '/api/account' && req.method === 'POST') {
      const b = await readJson(req);
      const r = credentials.changeAccount
        ? credentials.changeAccount({
            username: b.username,
            oldPassword: b.oldPassword || '',
            newPassword: b.newPassword || '',
            note: b.note,
          })
        : credentials.changePassword(b.oldPassword || '', b.newPassword || '');
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    // 老路径:只改密码。保留是因为它是已发布过的接口
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
        owners: users ? users.list().filter((u) => (u.tokenIds || []).includes(idOf(t.token))).map((u) => u.name) : [],
        name: t.name,
        tokenMask: maskToken(t.token),
        overrides: t.overrides || {},
        stats: statByName.get(t.name) || null,
      }));
      const configuredNames = new Set(tokenAdmin.list().map((t) => t.name));
      const others = snap.clients.filter((c) => !configuredNames.has(c.name));
      return sendJson(res, 200, {
        canManage: tokenAdmin.canManage(),
        tokens,
        others,
        // 全局默认下发(前端据此把"未设置"显示为默认开启)
        defaults: DEFAULT_OVERRIDES,
        subscriptionMode: !!oauthNow(),
      });
    }

    // ── 用户账号(普通用户登录用;数据层在 users.js,与用户端 /u 共用)──
    if (sub === '/api/users' && req.method === 'GET') {
      // 附上每个用户绑定令牌的名字,前端不用自己拼
      const byId = new Map(tokenAdmin.list().map((t) => [idOf(t.token), t]));
      const list = users.list().map((u) => {
        const names = (u.tokenIds || []).map((id) => (byId.get(id) ? byId.get(id).name : null)).filter(Boolean);
        return {
          ...u,
          tokens: (u.tokenIds || []).map((id) => ({
            id,
            name: byId.get(id) ? byId.get(id).name : null, // null = 令牌已被吊销
          })),
          // 该用户名下令牌在配额窗口内的已用量(共享一份额度)
          used: names.length ? metrics.usageFor(names, u.quota.window) : { tokens: 0, cost: 0, requests: 0 },
        };
      });
      return sendJson(res, 200, {
        canManage: users.canManage(),
        permMeta: PERMS,
        permDefaults: DEFAULT_PERMS,
        quotaWindows: QUOTA_WINDOWS,
        users: list,
        // 管理员不在 config.users 里(凭证是 adminUser/adminPassword),但必须出现在这张表上:
        // 否则"系统里有哪些账号"这个问题在唯一该回答它的地方缺了一行。
        // 字段与普通用户对齐,前端才能用同一套单元格渲染 —— 差别只在
        // 不可禁用/删除,以及设备/权限/配额由管理员身份固定决定。
        admin: adminRow(),
        // 可分配的令牌清单(掩码)
        tokens: tokenAdmin.list().map((t) => ({ id: idOf(t.token), name: t.name, tokenMask: maskToken(t.token) })),
      });
    }

    if (sub === '/api/users' && req.method === 'POST') {
      if (!users.canManage()) return sendJson(res, 400, { error: '当前用环境变量配置,无法在线管理用户;请改用 config.json' });
      const b = await readJson(req);
      const r = users.create({ name: b.name, password: b.password, tokenIds: b.tokenIds || [], note: b.note, perms: b.perms, quota: b.quota });
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (sub === '/api/users/password' && req.method === 'POST') {
      if (!users.canManage()) return sendJson(res, 400, { error: '无法在线管理用户' });
      const b = await readJson(req);
      const r = users.setPassword(b.name, b.password);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (sub === '/api/users/tokens' && req.method === 'POST') {
      if (!users.canManage()) return sendJson(res, 400, { error: '无法在线管理用户' });
      const b = await readJson(req);
      const r = users.setTokens(b.name, b.tokenIds || []);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (sub === '/api/users/quota' && req.method === 'POST') {
      if (!users.canManage()) return sendJson(res, 400, { error: '无法在线管理用户' });
      const b = await readJson(req);
      const r = users.setQuota(b.name, b.quota || {});
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (sub === '/api/users/perms' && req.method === 'POST') {
      if (!users.canManage()) return sendJson(res, 400, { error: '无法在线管理用户' });
      const b = await readJson(req);
      const r = users.setPerms(b.name, b.perms || {});
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (sub === '/api/users/disable' && req.method === 'POST') {
      if (!users.canManage()) return sendJson(res, 400, { error: '无法在线管理用户' });
      const b = await readJson(req);
      const r = users.setDisabled(b.name, !!b.disabled);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (sub === '/api/users/remove' && req.method === 'POST') {
      if (!users.canManage()) return sendJson(res, 400, { error: '无法在线管理用户' });
      const b = await readJson(req);
      const r = users.remove(b.name);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (sub === '/api/tokens' && req.method === 'POST') {
      if (!tokenAdmin.canManage()) return sendJson(res, 400, { error: '当前用环境变量配置令牌,无法在线增删;请改用 config.json' });
      const b = await readJson(req);
      const name = String(b.name || '').trim() || 'client';
      const entry = tokenAdmin.add(name);
      if (entry.error) return sendJson(res, 400, { error: entry.error });
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

    // 模型列表(来自上游拉取的持久化结果;未拉取过则内置种子)+ 按 id 推断的参数规则
    if (sub === '/api/models' && req.method === 'GET') {
      const l = modelStore.list();
      return sendJson(res, 200, { catalogVersion: CATALOG_VERSION, ...l, catalog: l.models });
    }

    // 从上游拉取实际可用模型列表 → 替换并持久化(手动"更新列表")
    if (sub === '/api/models/refresh' && req.method === 'POST') {
      try {
        const headers = { 'anthropic-version': '2023-06-01' };
        const up = upstreamNow();
        if (!up) throw new Error('上游鉴权未就绪');
        applyHops(headers, 0, up.baseUrl()); // 管理台自己发起,从 0 跳起算
        await up.apply(headers); // 三种模式统一(inherit 也能拉列表 —— 上游那台会自己去问官方)
        const r = await fetch(up.baseUrl() + '/v1/models?limit=100', { headers });
        const text = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 160)}`);
        const j = JSON.parse(text);
        const entries = (j.data || []).map((m) => ({ id: m.id, displayName: m.display_name || m.id }));
        if (!entries.length) throw new Error('上游返回空列表');
        const { models, added, removed } = modelStore.replaceFromUpstream(entries);
        log(`模型列表已从上游更新: 共 ${models.length} 个${added.length ? `,新增 ${added.join(', ')}` : ''}${removed.length ? `,移除 ${removed.join(', ')}` : ''}`);
        return sendJson(res, 200, { ok: true, fetchedAt: Date.now(), models, added, removed });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message });
      }
    }

    // 手动补一个模型(上游 /v1/models 不可用时的兜底)
    if (sub === '/api/models/add' && req.method === 'POST') {
      const b = await readJson(req);
      const r = modelStore.addManual(b.id);
      if (!r) return sendJson(res, 400, { error: '模型 id 不能为空' });
      log(`模型列表手动新增: ${b.id}`);
      return sendJson(res, 200, { ok: true, models: r.models, added: r.added });
    }

    // 从列表移除某个模型
    if (sub === '/api/models/remove' && req.method === 'POST') {
      const b = await readJson(req);
      const r = modelStore.remove(String(b.id || ''));
      if (!r) return sendJson(res, 404, { error: '列表中没有该模型' });
      log(`模型列表移除: ${b.id}`);
      return sendJson(res, 200, { ok: true, models: r.models });
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

    // 日志查询:有分块存储时走持久化分页;否则回落内存态最近日志
    if (sub === '/api/logs' && req.method === 'GET') {
      const q = u.searchParams;
      const limit = Math.min(Number(q.get('limit')) || 100, 500);
      const offset = Math.max(0, Number(q.get('offset')) || 0);
      if (!logStore || !logStore.enabled) {
        const all = metrics.recentLogs(500);
        const page = all.slice().reverse().slice(offset, offset + limit);
        return sendJson(res, 200, { logs: page, total: all.length, offset, limit, persisted: false });
      }
      const filter = {
        offset,
        limit,
        client: q.get('client') || undefined,
        status: q.get('status') || undefined,
        errorsOnly: q.get('errorsOnly') === '1',
        q: q.get('q') || undefined,
        from: q.get('from') ? Number(q.get('from')) : undefined,
        to: q.get('to') ? Number(q.get('to')) : undefined,
      };
      const r = logStore.query(filter);
      return sendJson(res, 200, { ...r, offset, limit, persisted: true, stats: logStore.stats() });
    }

    // 日志存储概况(块数/占用/保留天数)
    if (sub === '/api/logs/stats' && req.method === 'GET') {
      return sendJson(res, 200, logStore ? logStore.stats() : { enabled: false });
    }

    // 按时间段删除日志:{ before } 或 { from, to }(毫秒时间戳);也支持 days=N 删更早的
    if (sub === '/api/logs/prune' && req.method === 'POST') {
      if (!logStore || !logStore.enabled) return sendJson(res, 400, { error: '当前未启用日志分块存储(需 config.json 模式)' });
      const b = await readJson(req);
      let before = b.before != null ? Number(b.before) : null;
      if (before == null && b.days != null) before = Date.now() - Number(b.days) * 86400_000;
      const from = b.from != null ? Number(b.from) : null;
      const to = b.to != null ? Number(b.to) : null;
      if (before == null && (from == null || to == null)) {
        return sendJson(res, 400, { error: '需要 before / days,或 from + to' });
      }
      const r = logStore.prune({ before, from, to });
      log(`管理台清理日志: ${JSON.stringify({ before, from, to })} → 删除 ${r.removedEntries} 条 / ${r.removedBlocks} 块`);
      return sendJson(res, 200, { ok: true, ...r, stats: logStore.stats() });
    }

    // ── 存储占用与清理 ──
    // 扫盘比其它接口贵(要 stat 整个数据目录 + 读全部会话找孤儿图片),
    // 所以概览页 5 秒一次的轮询【不带】它,只在进页面/点刷新/清理完之后拉。
    if (sub === '/api/storage' && req.method === 'GET') {
      if (!storage || !storage.enabled) return sendJson(res, 200, { enabled: false });
      const withOrphans = u.searchParams.get('orphans') !== '0';
      return sendJson(res, 200, storage.scan({ withOrphans }));
    }

    if (sub === '/api/storage/prune' && req.method === 'POST') {
      if (!storage || !storage.enabled) return sendJson(res, 400, { error: '当前未启用数据目录' });
      const b = await readJson(req);
      const r = storage.prune(String(b.key || ''), String(b.mode || ''));
      if (!r.ok) return sendJson(res, 400, r);
      log(`管理台清理存储: ${b.key}/${b.mode} → ${r.message}`);
      return sendJson(res, 200, { ...r, storage: storage.scan() });
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
