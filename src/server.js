#!/usr/bin/env node
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, cleanToken } from './config.js';
import { createOAuthProvider } from './oauth.js';
import { createMetrics } from './metrics.js';
import { createAdmin } from './admin.js';
import {
  applyOverrides,
  normalizeOverrides,
  clientAllowed,
  modelAllowed,
  claudeCodeBetas,
  claudeCodeIdentityHeaders,
} from './models.js';
import { createLimiter } from './limits.js';
import { initUpstream } from './upstream.js';
import { handleOpenAiCompat } from './openai_compat.js';
import { createFileLogger, dirSize } from './logger.js';

function generateClientToken() {
  return 'cct-' + crypto.randomBytes(24).toString('base64url');
}

// 版本号(供 /health 展示),读不到则 unknown
let PKG_VERSION = 'unknown';
try {
  PKG_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'unknown';
} catch {
  /* ignore */
}

// ── 子命令: 生成客户端令牌 ───────────────────────────────────────────
if (process.argv[2] === 'gen-token') {
  process.stdout.write(generateClientToken() + '\n');
  process.exit(0);
}

// ── 子命令: 自检某个令牌是否在白名单里 ──────────────────────────────
//    用法: node src/server.js check-token "<你正在客户端用的令牌>"
if (process.argv[2] === 'check-token') {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write('\n配置无法加载(服务器也启动不了):\n' + err.message + '\n');
    process.exit(1);
  }
  const input = cleanToken(process.argv[3] || '');
  const mask = (t) => (!t ? '(空)' : t.length <= 10 ? '***' : t.slice(0, 6) + '…' + t.slice(-4));
  process.stdout.write(`\n配置文件: ${cfg.__file || '(未用文件,走环境变量)'}\n`);
  process.stdout.write(`已配置的客户端令牌(${cfg.clientTokens.length} 个):\n`);
  for (const t of cfg.clientTokens) {
    process.stdout.write(`  - ${t.name}: ${mask(t.token)}  [长度 ${t.token.length}]\n`);
  }
  if (!input) {
    process.stdout.write('\n用法: node src/server.js check-token "<你正在客户端用的令牌>"\n');
    process.exit(2);
  }
  const hit = cfg.clientTokens.find((t) => t.token === input);
  process.stdout.write(`\n你输入的令牌: ${mask(input)}  [长度 ${input.length}]\n`);
  if (hit) {
    process.stdout.write(`✅ 匹配成功(设备名: ${hit.name})。鉴权失败应该不是令牌本身的问题——\n`);
    process.stdout.write(`   请确认:服务器在改完 config.json 后已【重启】,且客户端连的是这台服务器。\n\n`);
    process.exit(0);
  } else {
    process.stdout.write('❌ 不匹配。原因通常是:令牌有出入 / 改完 config.json 没重启 / 编辑的是 config.example.json。\n\n');
    process.exit(1);
  }
}

let config;
try {
  config = loadConfig();
} catch (err) {
  process.stderr.write('\n' + err.message + '\n\n');
  process.exit(1);
}

// 可选滚动文件日志(默认 null;配了 logFile 才启用)。必须在任何 log() 调用前初始化。
const fileLogger = createFileLogger({
  logFile: config.logFile,
  logMaxBytes: config.logMaxBytes,
  logMaxFiles: config.logMaxFiles,
});

// token -> 条目映射,用于鉴权/日志标识/参数下发;clientTokens 为可变的令牌清单(管理台增删改)
let clientTokens = config.clientTokens.map((t) => ({ token: t.token, name: t.name, overrides: t.overrides || {} }));
const tokenMap = new Map(clientTokens.map((t) => [t.token, t]));

// 订阅 OAuth provider(仅 oauth 模式启用)
const oauth = config.upstreamAuth === 'oauth' ? createOAuthProvider(config.oauthCredentialsPath, log) : null;

// 指标采集:有 config.json 时把累计/每日聚合持久化到旁边的 data/metrics.json(纯环境变量模式则内存态)
const metrics = createMetrics({
  persistFile: config.__file ? path.join(path.dirname(config.__file), 'data', 'metrics.json') : null,
  log,
});

// 按客户端限流/并发(内存态)
const limiter = createLimiter();
setInterval(() => limiter.sweep(), 300_000).unref();

// 上游连接层(连接池 + 可选代理)。默认直连用内置 fetch;配代理时按需加载 undici。
const upstream = await initUpstream(config, log);
const upstreamFetch = upstream.fetch;
const upstreamDispatcher = upstream.dispatcher;

// 原子地把若干字段写回 config.json(保留其它字段/注释)
function patchConfigFile(patch) {
  const file = config.__file;
  if (!file) throw new Error('无 config.json,无法持久化');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(j, patch);
  const tmp = `${file}.cc-trans.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function persistClientTokens() {
  patchConfigFile({
    clientTokens: clientTokens.map((t) => ({
      token: t.token,
      name: t.name,
      ...(t.overrides && Object.keys(t.overrides).length ? { overrides: t.overrides } : {}),
    })),
  });
}

// 定长防时序比较
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// 供管理台增删令牌的接口
const tokenAdmin = {
  canManage: () => !!config.__file,
  list: () => clientTokens.map((t) => ({ token: t.token, name: t.name, overrides: t.overrides || {} })),
  add: (name) => {
    const entry = { token: generateClientToken(), name: (name || 'client').trim() || 'client', overrides: {} };
    clientTokens.push(entry);
    tokenMap.set(entry.token, entry);
    persistClientTokens();
    return entry;
  },
  revoke: (token) => {
    const idx = clientTokens.findIndex((t) => t.token === token);
    if (idx === -1) return false;
    clientTokens.splice(idx, 1);
    tokenMap.delete(token);
    limiter.forget(token);
    persistClientTokens();
    return true;
  },
  // 按客户端下发参数(强制模型/thinking/effort/门禁前缀/参数清洗),写回 config.json 立即生效
  setOverrides: (token, overrides) => {
    const entry = clientTokens.find((t) => t.token === token);
    if (!entry) return null;
    entry.overrides = normalizeOverrides(overrides);
    persistClientTokens();
    return entry.overrides;
  },
};

// 管理台:adminEnabled 或设了 adminPassword 即启用;账号密码登录
const ADMIN_PREFIX = '/admin';
const adminOn = config.adminEnabled || !!config.adminPassword;
const adminUser = config.adminUser || 'admin';
let adminPassword = config.adminPassword;
let initialPasswordNotice = null;

if (adminOn && !adminPassword) {
  // 首次部署:生成随机初始密码,写回 config.json,并在控制台醒目打印一次
  adminPassword = 'adm-' + crypto.randomBytes(9).toString('base64url');
  initialPasswordNotice = adminPassword;
  try {
    if (config.__file) patchConfigFile({ adminPassword });
  } catch (err) {
    initialPasswordNotice = adminPassword + ' (⚠️ 未能写回 config.json,重启会重新生成: ' + err.message + ')';
  }
}

const adminCredentials = {
  user: adminUser,
  verify: (u, p) => u === adminUser && !!adminPassword && safeEqual(p, adminPassword),
  changePassword: (oldPw, newPw) => {
    if (!safeEqual(oldPw, adminPassword)) return { ok: false, error: '当前密码不正确' };
    if (!newPw || String(newPw).length < 6) return { ok: false, error: '新密码至少 6 位' };
    adminPassword = String(newPw);
    try {
      if (config.__file) patchConfigFile({ adminPassword });
    } catch (err) {
      return { ok: false, error: '写回 config.json 失败: ' + err.message };
    }
    log(`管理台密码已修改`);
    return { ok: true };
  },
};

const admin = adminOn
  ? createAdmin({ prefix: ADMIN_PREFIX, credentials: adminCredentials, config, oauth, metrics, tokenAdmin, maskToken, log })
  : null;

// 不向上游转发的请求头(逐跳头 + 客户端凭证,凭证由本机替换)
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'authorization',
  'x-api-key',
]);

// 浏览器/探针自动发起的资源请求:无需令牌,直接 204,不记日志/指标
const BROWSER_NOISE = new Set([
  '/favicon.ico',
  '/robots.txt',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
]);

// 不回传给客户端的响应头(fetch 已解压,长度/编码会失真)
const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

function extractClientToken(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.toLowerCase().startsWith('bearer ')) return { token: cleanToken(auth.slice(7)), via: 'authorization' };
  const apiKey = req.headers['x-api-key'];
  if (apiKey) return { token: cleanToken(apiKey), via: 'x-api-key' };
  return { token: null, via: 'none' };
}

function buildUpstreamHeaders(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  return headers;
}

// 把某个 anthropic-beta flag 合并进请求头(去重,大小写无关地复用已有的 key)
function ensureBeta(headers, flag) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'anthropic-beta');
  if (!key) {
    headers['anthropic-beta'] = flag;
    return;
  }
  const vals = String(headers[key]).split(',').map((s) => s.trim()).filter(Boolean);
  if (!vals.includes(flag)) vals.push(flag);
  headers[key] = vals.join(',');
}

// 注入本机真实上游凭证(订阅 OAuth 异步取 token;否则用静态密钥)
async function applyUpstreamAuth(headers) {
  if (oauth) {
    const accessToken = await oauth.getAccessToken();
    headers['authorization'] = `Bearer ${accessToken}`;
    ensureBeta(headers, oauth.beta); // 订阅 token 必带的 beta flag
  } else if (config.upstreamAuthToken) {
    headers['authorization'] = `Bearer ${config.upstreamAuthToken}`;
  } else if (config.upstreamApiKey) {
    headers['x-api-key'] = config.upstreamApiKey;
  }
}

// A 兼容性:开启 spoofClaudeCode 且为订阅 OAuth 时,把请求头补成完整 Claude Code 身份
//（UA/x-app/accept 等 + anthropic-beta 四件套),让自研客户端在上游看来像真 Claude Code。
function applyClaudeCodeSpoof(headers, effectiveModel, overrides) {
  if (!overrides || !overrides.spoofClaudeCode || !oauth) return [];
  const changes = [];
  const ident = claudeCodeIdentityHeaders();
  for (const [k, v] of Object.entries(ident)) {
    // 删掉客户端原有的同名头(任意大小写),再写入标准值
    for (const ek of Object.keys(headers)) if (ek.toLowerCase() === k) delete headers[ek];
    headers[k] = v;
  }
  for (const flag of claudeCodeBetas(effectiveModel)) ensureBeta(headers, flag);
  changes.push('spoofCC');
  return changes;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 请求体改写管道:全局 modelMap + 客户端参数下发(强制模型/thinking/effort/门禁前缀/新模型参数清洗)。
// 仅处理 /v1/messages* 的 JSON 体;无任何改写规则时原样透传(保持字节保真)。
function applyBodyTransforms(bodyBuffer, req, clientEntry) {
  const map = config.modelMap || {};
  const ov = (clientEntry && clientEntry.overrides) || {};
  const pathOnly = (req.url || '').split('?')[0];
  const ct = String(req.headers['content-type'] || '');
  // effectiveModel:实际发往上游的模型 id(供白名单/成本/身份 beta 判定);model:日志展示串。
  if (!pathOnly.startsWith('/v1/messages') || !ct.includes('application/json') || bodyBuffer.length === 0) {
    return { body: bodyBuffer, model: undefined, effectiveModel: undefined, changes: [] };
  }
  try {
    const obj = JSON.parse(bodyBuffer.toString('utf8'));
    const original = obj.model;
    const changes = [];
    if (original && map[original]) {
      obj.model = map[original];
      changes.push(`model=${original}→${obj.model}(modelMap)`);
    }
    changes.push(...applyOverrides(obj, ov));
    const effectiveModel = obj.model;
    if (!changes.length) return { body: bodyBuffer, model: original, effectiveModel, changes };
    const model = obj.model !== original ? `${original}→${obj.model}` : original;
    return { body: Buffer.from(JSON.stringify(obj)), model, effectiveModel, changes };
  } catch {
    return { body: bodyBuffer, model: undefined, effectiveModel: undefined, changes: [] };
  }
}

function sendJson(res, status, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': data.length,
  });
  res.end(data);
}

// Anthropic 风格的错误体,便于 Claude Code 展示
function sendError(res, status, type, message) {
  sendJson(res, status, { type: 'error', error: { type, message } });
}

// 从 SSE / JSON 响应文本里尽量抠出 token 用量(用于日志,非精确)
function makeUsageSniffer() {
  let buf = '';
  let input;
  let output;
  let cacheRead;
  let cacheWrite;
  const grab = (re, text) => {
    let m;
    let last;
    while ((m = re.exec(text)) !== null) last = Number(m[1]);
    return last;
  };
  return {
    feed(chunk) {
      buf += chunk;
      if (buf.length > 1_000_000) buf = buf.slice(-200_000); // 防止超长流吃内存
      const i = grab(/"input_tokens"\s*:\s*(\d+)/g, buf);
      const o = grab(/"output_tokens"\s*:\s*(\d+)/g, buf);
      const cr = grab(/"cache_read_input_tokens"\s*:\s*(\d+)/g, buf);
      const cw = grab(/"cache_creation_input_tokens"\s*:\s*(\d+)/g, buf);
      if (i !== undefined) input = i;
      if (o !== undefined) output = o;
      if (cr !== undefined) cacheRead = cr;
      if (cw !== undefined) cacheWrite = cw;
    },
    summary() {
      const parts = [];
      if (input !== undefined) parts.push(`in=${input}`);
      if (output !== undefined) parts.push(`out=${output}`);
      if (cacheRead) parts.push(`cacheR=${cacheRead}`);
      if (cacheWrite) parts.push(`cacheW=${cacheWrite}`);
      return parts.join(' ');
    },
    usage() {
      return { input, output, cacheRead, cacheWrite };
    },
  };
}

function ts() {
  return new Date().toISOString();
}

// 上游网络层瞬时故障的重试次数(仅在客户端尚未收到任何字节时重试,对客户端完全透明)
const UPSTREAM_ATTEMPTS = 3;

// SSE 静默保活:上游超过 SSE_KEEPALIVE_MS 没吐字节,就往客户端写一个 SSE 注释帧(客户端忽略),
// 保证每隔一段就有字节穿过 frp/NAT/中转的每一跳,不让空闲超时掐断长思考期间的连接。
// 用比阈值更短的轮询周期检查,避免"周期==阈值"导致刚好错过。
const SSE_KEEPALIVE_MS = 10_000;
const SSE_KEEPALIVE_POLL_MS = 2_500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function recordMetric(req, started, status, clientName, usage, model, effectiveModel) {
  metrics.record({
    ts: started,
    method: req.method,
    path: req.url,
    status,
    ms: Date.now() - started,
    model,
    costModel: effectiveModel || model, // 用实际发往上游的模型 id 算成本
    usage: usage || {},
    client: clientName,
  });
}

async function handleProxy(req, res, started) {
  // 管理台:自成一套鉴权,先于代理逻辑处理
  if (admin && req.url.startsWith(ADMIN_PREFIX)) {
    return admin.handle(req, res);
  }

  // 浏览器自动请求的资源(favicon 等):无需令牌,直接 204,不污染日志/指标
  if (req.method === 'GET' && BROWSER_NOISE.has(req.url.split('?')[0])) {
    res.writeHead(204);
    return res.end();
  }

  // 健康检查 / 根路径:GET 与 HEAD 都无需鉴权(HEAD 只回头,常见于本地/浏览器探活)
  const pathOnly = req.url.split('?')[0];
  if ((req.method === 'GET' || req.method === 'HEAD') && (pathOnly === '/' || pathOnly === '/health' || pathOnly === '/healthz')) {
    if (req.method === 'HEAD') {
      res.writeHead(200);
      return res.end();
    }
    return sendJson(res, 200, buildHealth());
  }

  // ── 鉴权 ──
  const { token, via } = extractClientToken(req);
  if (!token || !tokenMap.has(token)) {
    const reason = !token
      ? '请求未携带令牌(authorization/x-api-key 都没有)'
      : `令牌不在白名单 收到=${maskToken(token)} 来自=${via} 已配置=[${[...tokenMap.keys()].map(maskToken).join(', ')}]`;
    log(`${req.method} ${req.url} 401 鉴权失败:${reason}`);
    recordMetric(req, started, 401, token ? '(令牌不匹配)' : '(未携带令牌)');
    return sendError(res, 401, 'authentication_error', `cc-trans: 无效的客户端访问令牌(${!token ? '未携带令牌' : '令牌不匹配'})`);
  }
  const clientEntry = tokenMap.get(token);
  const clientName = clientEntry.name;
  const ov = clientEntry.overrides || {};

  // ── B 安全:客户端 UA 限制 ──
  if (ov.allowedClient && !clientAllowed(ov.allowedClient, req.headers['user-agent'])) {
    log(`${req.method} ${req.url} 403 客户端不被允许 UA=${maskToken(String(req.headers['user-agent'] || ''))} [${clientName}]`);
    recordMetric(req, started, 403, clientName);
    return sendError(res, 403, 'permission_error', `cc-trans: 该令牌限制了客户端类型,当前 User-Agent 不被允许`);
  }

  // ── D OpenAI 兼容端点:/v1/chat/completions(OpenAI 格式 → Anthropic)──
  if (req.method === 'POST' && (req.url.split('?')[0] === '/v1/chat/completions')) {
    const gate = limiter.tryAcquire(token, ov);
    if (!gate.ok) {
      recordMetric(req, started, gate.status, clientName);
      res.setHeader('retry-after', String(gate.retryAfterSec));
      return sendError(res, gate.status, 'rate_limit_error', `cc-trans: ${gate.message}`);
    }
    try {
      await handleOpenAiCompat(req, res, {
        readBody,
        fetch: upstreamFetch,
        upstreamBaseUrl: config.upstreamBaseUrl,
        dispatcher: upstreamDispatcher,
        buildBaseHeaders: () => buildUpstreamHeaders(req),
        applyUpstreamAuth,
        applyClaudeCodeSpoof,
        overrides: ov,
        allowedModels: ov.allowedModels,
        log,
        clientName,
        sendError,
        sendJson,
        recordOpenAi: (status, usage, em) => recordMetric(req, started, status, clientName, usage, em, em),
      });
    } finally {
      gate.release();
    }
    return;
  }

  const bodyBuffer = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const { body, model, effectiveModel, changes } = applyBodyTransforms(bodyBuffer, req, clientEntry);
  if (changes.length) log(`参数下发 [${clientName}]: ${changes.join(', ')}`);

  // ── B 安全:模型白名单(针对实际发往上游的模型)──
  if (effectiveModel && !modelAllowed(ov.allowedModels, effectiveModel)) {
    log(`${req.method} ${req.url} 403 模型不在白名单 model=${effectiveModel} 允许=[${ov.allowedModels.join(', ')}] [${clientName}]`);
    recordMetric(req, started, 403, clientName, {}, model);
    return sendError(res, 403, 'permission_error', `cc-trans: 令牌不允许使用模型 ${effectiveModel}`);
  }

  // ── B 安全:限流 / 并发(仅对转发请求计数;放行则占额度,finish 时释放)──
  const gate = limiter.tryAcquire(token, ov);
  if (!gate.ok) {
    log(`${req.method} ${req.url} ${gate.status} 限流:${gate.message} [${clientName}]`);
    recordMetric(req, started, gate.status, clientName, {}, model);
    res.setHeader('retry-after', String(gate.retryAfterSec));
    return sendError(res, gate.status, 'rate_limit_error', `cc-trans: ${gate.message}`);
  }
  const release = gate.release;

  const url = config.upstreamBaseUrl + req.url;
  const headers = buildUpstreamHeaders(req);
  try {
    await applyUpstreamAuth(headers);
  } catch (err) {
    release();
    log(`${req.method} ${req.url} 502 上游凭证错误: ${err.message} [${clientName}]`);
    recordMetric(req, started, 502, clientName, {}, model);
    return sendError(res, 502, 'api_error', `cc-trans 上游凭证不可用: ${err.message}`);
  }
  // ── A 兼容性:Claude Code 身份伪装 ──
  const spoof = applyClaudeCodeSpoof(headers, effectiveModel, ov);
  if (spoof.length) log(`身份伪装 [${clientName}]: ${spoof.join(', ')}`);

  // 客户端提前断开时中止上游请求;write 出错走 close 路径,不让 error 事件炸进程
  const abort = new AbortController();
  let clientGone = false;
  let clientGoneMs = 0;
  res.on('error', () => {});
  res.on('close', () => {
    if (!res.writableFinished) {
      clientGone = true;
      clientGoneMs = Date.now();
      abort.abort();
    }
  });

  const sniffer = makeUsageSniffer();
  let upstreamRes = null;
  let wroteHead = false; // 首字节到达才写响应头,首字节前上游中断可整体重试(对客户端透明)
  let sentBytes = false;
  let recorded = false;
  // ── 诊断计数:定位"断开"到底发生在链路哪一段、是不是空闲超时 ──
  let chunkCount = 0; // 回传给客户端的 chunk 数
  let bytesToClient = 0; // 回传字节数
  let firstByteMs = 0; // 首字节送出时刻(算 TTFB)
  let lastWriteMs = 0; // 最近一次成功送出字节的时刻
  let maxGapMs = 0; // 相邻两次送出字节的最大间隔(反映上游/链路的最长静默)
  let upstreamEnded = false; // 上游流是否已完整读完
  let keepAlives = 0; // 已补发的 SSE 保活帧数(在下方流循环里累加)

  // 断开/中断类收尾时附加的诊断串。断开距上次发送=大 → 空闲超时(链路掐死静默连接);小 → 硬重置/客户端主动断。
  const diag = () => {
    const p = [`chunks=${chunkCount}`, `bytes=${bytesToClient}`];
    if (firstByteMs) p.push(`ttfb=${firstByteMs - started}ms`);
    if (maxGapMs) p.push(`最大静默=${maxGapMs}ms`);
    if (clientGone && lastWriteMs) p.push(`断开距上次发送=${(clientGoneMs || Date.now()) - lastWriteMs}ms`);
    if (keepAlives) p.push(`保活帧=${keepAlives}`);
    p.push(`上游${upstreamEnded ? '已读完' : '未读完'}`);
    return p.join(' ');
  };

  const writeHeadOnce = () => {
    if (wroteHead) return;
    wroteHead = true;
    // 透传状态码与响应头(去掉会失真的头)
    const resHeaders = {};
    upstreamRes.headers.forEach((v, k) => {
      if (STRIP_RESPONSE_HEADERS.has(k)) return;
      resHeaders[k] = v;
    });
    res.writeHead(upstreamRes.status, resHeaders);
  };

  const finish = (note = '') => {
    if (recorded) return;
    recorded = true;
    release(); // 释放并发额度
    const status = upstreamRes ? upstreamRes.status : 0;
    const ms = Date.now() - started;
    const usage = sniffer.summary();
    log(
      `${req.method} ${req.url} ${status} ${ms}ms` +
        (model ? ` model=${model}` : '') +
        (usage ? ` ${usage}` : '') +
        (note ? ` ${note}` : '') +
        ` [${clientName}]`,
    );
    recordMetric(req, started, status, clientName, sniffer.usage(), model, effectiveModel);
  };

  for (let attempt = 1; attempt <= UPSTREAM_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await sleep(300 * (attempt - 1));
      if (clientGone) return finish(`(客户端已断开·首字节前 ${diag()})`);
      try {
        await applyUpstreamAuth(headers); // 订阅 token 可能刚轮换,重试前重新取
      } catch {
        /* 取不到就沿用上一次的头 */
      }
    }

    try {
      upstreamRes = await upstreamFetch(url, {
        method: req.method,
        headers,
        body: body.length ? body : undefined,
        signal: abort.signal,
        dispatcher: upstreamDispatcher,
      });
    } catch (err) {
      if (clientGone) return finish(`(客户端已断开·首字节前 ${diag()})`);
      if (attempt < UPSTREAM_ATTEMPTS) {
        log(`${req.method} ${req.url} 上游连接失败,重试 ${attempt}/${UPSTREAM_ATTEMPTS - 1}: ${err.message} [${clientName}]`);
        continue;
      }
      log(`${req.method} ${req.url} 502 上游不可达(已重试 ${UPSTREAM_ATTEMPTS - 1} 次): ${err.message} [${clientName}]`);
      recordMetric(req, started, 502, clientName, {}, model);
      return sendError(res, 502, 'api_error', `cc-trans 无法连接上游: ${err.message}`);
    }

    // 记录上游返回的订阅限额头(供管理台「订阅用量」展示)
    const rl = {};
    upstreamRes.headers.forEach((v, k) => {
      if (k.startsWith('anthropic-ratelimit-')) rl[k] = v;
    });
    if (Object.keys(rl).length) metrics.setRateLimit({ ts: Date.now(), headers: rl });

    if (!upstreamRes.body) {
      writeHeadOnce();
      res.end();
      return finish();
    }

    const isSSE = String(upstreamRes.headers.get('content-type') || '').includes('text/event-stream');
    // 保活定时器:仅 SSE、已开始回传、客户端在线时,静默期补注释帧
    const kaTimer = setInterval(() => {
      if (!isSSE || !wroteHead || clientGone || res.writableEnded || !res.writable) return;
      if (Date.now() - lastWriteMs < SSE_KEEPALIVE_MS) return;
      try {
        res.write(': keepalive\n\n');
        keepAlives++;
        lastWriteMs = Date.now();
      } catch {
        /* 写失败会走 close/error 路径 */
      }
    }, SSE_KEEPALIVE_POLL_MS);
    kaTimer.unref();
    try {
      for await (const chunk of upstreamRes.body) {
        if (clientGone) break;
        try {
          sniffer.feed(Buffer.from(chunk).toString('utf8'));
        } catch {
          /* 嗅探失败不影响转发 */
        }
        writeHeadOnce();
        sentBytes = true;
        chunkCount++;
        bytesToClient += chunk.length;
        const now = Date.now();
        if (!firstByteMs) firstByteMs = now;
        else if (lastWriteMs) maxGapMs = Math.max(maxGapMs, now - lastWriteMs);
        lastWriteMs = now;
        if (!res.write(chunk) && !clientGone) {
          // 背压:等客户端消费;客户端断开也要能醒来
          await new Promise((resolve) => {
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              resolve();
            };
            res.once('drain', done);
            res.once('close', done);
          });
        }
      }
      upstreamEnded = true;
      if (clientGone) return finish(`(客户端提前断开 ${diag()})`);
      writeHeadOnce();
      res.end();
      return finish();
    } catch (err) {
      if (clientGone || res.destroyed) return finish(`(客户端提前断开 ${diag()})`);
      if (!sentBytes && attempt < UPSTREAM_ATTEMPTS) {
        log(`${req.method} ${req.url} 上游响应在首字节前中断,重试 ${attempt}/${UPSTREAM_ATTEMPTS - 1}: ${err.message} [${clientName}]`);
        upstreamRes = null;
        continue;
      }
      if (!sentBytes) {
        log(`${req.method} ${req.url} 502 上游响应中断: ${err.message} [${clientName}]`);
        recordMetric(req, started, 502, clientName, {}, model);
        return sendError(res, 502, 'api_error', `cc-trans 上游响应中断: ${err.message}`);
      }
      if (isSSE) {
        // 已在回传 SSE:补一个合法的 error 事件并正常收尾,客户端能识别错误并自动重试,
        // 而不是收到裸 TCP 断连("Connection closed mid-response")
        log(`${req.method} ${req.url} 上游流中断,以 SSE error 事件收尾: ${err.message} [${clientName}]`);
        try {
          res.write(
            `event: error\ndata: ${JSON.stringify({
              type: 'error',
              error: { type: 'overloaded_error', message: `cc-trans: 上游流中断(${err.message}),请重试` },
            })}\n\n`,
          );
          res.end();
        } catch {
          res.destroy(err);
        }
        return finish(`(流中断 ${diag()})`);
      }
      log(`${req.method} ${req.url} 流错误(已回传部分数据,只能断开): ${err.message} [${clientName}]`);
      res.destroy(err);
      return finish(`(流中断 ${diag()})`);
    } finally {
      clearInterval(kaTimer);
    }
  }
}

function maskToken(t) {
  if (!t) return 'none';
  if (t.length <= 8) return '***';
  return t.slice(0, 6) + '…' + t.slice(-4);
}

// 健康检查详情(无需鉴权,不含敏感数据):存活 + 上游/凭证状态 + 内存 + 数据盘占用,供探针/运维用。
const HEALTH_STARTED = Date.now();
function buildHealth() {
  const h = {
    ok: true,
    service: 'cc-trans',
    version: PKG_VERSION,
    uptimeSec: Math.floor((Date.now() - HEALTH_STARTED) / 1000),
    upstream: config.upstreamBaseUrl,
    upstreamProxy: upstream.describe,
    upstreamAuth: config.upstreamAuth,
    clients: clientTokens.length,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
  };
  if (oauth) {
    try {
      const info = oauth.peek ? oauth.peek() : null;
      if (info) {
        h.oauth = {
          subscriptionType: info.subscriptionType || null,
          expiresInMin: info.expiresAt ? Math.round((info.expiresAt - Date.now()) / 60000) : null,
          hasRefresh: !!info.hasRefresh,
        };
        // token 读不到 / 无 refresh 视为降级(但仍存活,便于区分探针语义)
        if (!info.hasRefresh) h.ok = true;
      } else {
        h.oauth = { error: '凭证读取失败' };
      }
    } catch {
      h.oauth = { error: '凭证读取异常' };
    }
  }
  if (config.__file) {
    try {
      const d = dirSize(path.join(path.dirname(config.__file), 'data'));
      h.dataDir = { bytes: d.bytes, mb: Math.round((d.bytes / 1048576) * 100) / 100, files: d.files };
    } catch {
      /* ignore */
    }
  }
  return h;
}

function log(msg) {
  const line = `[${ts()}] ${msg}\n`;
  process.stdout.write(line);
  if (fileLogger) fileLogger.write(line);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  handleProxy(req, res, started).catch((err) => {
    log(`未捕获错误: ${err.stack || err.message}`);
    if (!res.headersSent) sendError(res, 500, 'api_error', `cc-trans 内部错误: ${err.message}`);
    else res.destroy(err);
  });
});

server.requestTimeout = 0; // 长连接 / 长流式不超时
server.headersTimeout = 0;
server.keepAliveTimeout = 0; // 不主动断开空闲 keep-alive 连接(Node 默认 5s,客户端复用连接时易撞上断连竞态)
server.on('connection', (socket) => {
  socket.setKeepAlive(true, 30_000); // TCP 层保活,防 NAT/隧道悄悄丢链
  socket.setNoDelay(true); // SSE 小块即时送出
});

server.listen(config.port, config.host, () => {
  printBanner();
});

function lanIps() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function printBanner() {
  let cred;
  if (config.upstreamAuth === 'oauth') {
    const info = config.oauthInfo || {};
    const left = info.expiresAt ? Math.round((info.expiresAt - Date.now()) / 60000) : null;
    cred = `订阅OAuth(${info.subscriptionType || '?'}, token${left == null ? '' : left > 0 ? `还有${left}分钟到期` : '已过期,首个请求会自动刷新'})`;
  } else {
    cred = config.upstreamAuthToken ? 'auth-token' : 'api-key';
  }
  log(`cc-trans 已启动`);
  log(`  监听:      ${config.host}:${config.port}`);
  log(`  上游:      ${config.upstreamBaseUrl} (凭证类型: ${cred})`);
  if (oauth) log(`  订阅凭证:  ${oauth.file}`);
  log(`  客户端令牌: ${clientTokens.map((t) => `${t.name}(${maskToken(t.token)})`).join(', ') || '(无)'}`);
  if (admin) {
    const ips = lanIps();
    const host = ips[0] || 'localhost';
    log(`  管理台:    http://${host}:${config.port}${ADMIN_PREFIX}  (账号 ${adminUser} 登录)`);
  } else {
    log(`  管理台:    未启用(在 config.json 设 adminEnabled:true 即可开启)`);
  }
  if (config.__file) log(`  配置文件:  ${config.__file}`);
  if (Object.keys(config.modelMap).length) {
    log(`  模型映射:  ${JSON.stringify(config.modelMap)}`);
  }
  const ips = lanIps();
  if (ips.length) {
    log(`  远端可用:  ${ips.map((ip) => `http://${ip}:${config.port}`).join('  ')}`);
  }
  log(`  远端配置:  ANTHROPIC_BASE_URL=http://<本机IP>:${config.port}  ANTHROPIC_AUTH_TOKEN=<你的客户端令牌>`);
  if (initialPasswordNotice) {
    log('');
    log('  ┌──────────────────────────────────────────────────────────┐');
    log(`  │  管理台初始账号: ${adminUser}`);
    log(`  │  管理台初始密码: ${initialPasswordNotice}`);
    log('  │  (登录后可在「设置」里修改;此密码已写入 config.json)');
    log('  └──────────────────────────────────────────────────────────┘');
    log('');
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`收到 ${sig},关闭中…`);
    metrics.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
