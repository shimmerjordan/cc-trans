#!/usr/bin/env node
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { loadConfig, cleanToken } from './config.js';
import { createOAuthProvider } from './oauth.js';

// ── 子命令: 生成客户端令牌 ───────────────────────────────────────────
if (process.argv[2] === 'gen-token') {
  const tok = 'cct-' + crypto.randomBytes(24).toString('base64url');
  process.stdout.write(tok + '\n');
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

// token -> name 映射,用于鉴权与日志标识
const tokenMap = new Map(config.clientTokens.map((t) => [t.token, t.name]));

// 订阅 OAuth provider(仅 oauth 模式启用)
const oauth = config.upstreamAuth === 'oauth' ? createOAuthProvider(config.oauthCredentialsPath, log) : null;

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 仅当配置了 modelMap 且为 JSON 体时,改写 body 里的 model 字段
function applyModelMap(bodyBuffer, req) {
  const map = config.modelMap;
  if (!map || Object.keys(map).length === 0) return { body: bodyBuffer, model: undefined };
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json') || bodyBuffer.length === 0) {
    return { body: bodyBuffer, model: undefined };
  }
  try {
    const obj = JSON.parse(bodyBuffer.toString('utf8'));
    const original = obj.model;
    if (original && map[original]) {
      obj.model = map[original];
      return { body: Buffer.from(JSON.stringify(obj)), model: `${original}→${obj.model}` };
    }
    return { body: bodyBuffer, model: original };
  } catch {
    return { body: bodyBuffer, model: undefined };
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
  };
}

function ts() {
  return new Date().toISOString();
}

async function handleProxy(req, res, started) {
  // 健康检查 / 根路径:无需鉴权
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return sendJson(res, 200, {
      ok: true,
      service: 'cc-trans',
      upstream: config.upstreamBaseUrl,
      clients: config.clientTokens.length,
    });
  }

  // ── 鉴权 ──
  const { token, via } = extractClientToken(req);
  if (!token || !tokenMap.has(token)) {
    const reason = !token
      ? '请求未携带令牌(authorization/x-api-key 都没有)'
      : `令牌不在白名单 收到=${maskToken(token)} 来自=${via} 已配置=[${[...tokenMap.keys()].map(maskToken).join(', ')}]`;
    log(`${req.method} ${req.url} 401 鉴权失败:${reason}`);
    return sendError(res, 401, 'authentication_error', `cc-trans: 无效的客户端访问令牌(${!token ? '未携带令牌' : '令牌不匹配'})`);
  }
  const clientName = tokenMap.get(token);

  const bodyBuffer = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const { body, model } = applyModelMap(bodyBuffer, req);

  const url = config.upstreamBaseUrl + req.url;
  const headers = buildUpstreamHeaders(req);
  try {
    await applyUpstreamAuth(headers);
  } catch (err) {
    log(`${req.method} ${req.url} 502 上游凭证错误: ${err.message} [${clientName}]`);
    return sendError(res, 502, 'api_error', `cc-trans 上游凭证不可用: ${err.message}`);
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(url, {
      method: req.method,
      headers,
      body: body.length ? body : undefined,
    });
  } catch (err) {
    log(`${req.method} ${req.url} 502 上游不可达: ${err.message} [${clientName}]`);
    return sendError(res, 502, 'api_error', `cc-trans 无法连接上游: ${err.message}`);
  }

  // 透传状态码与响应头(去掉会失真的头)
  const resHeaders = {};
  upstreamRes.headers.forEach((v, k) => {
    if (STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) return;
    resHeaders[k] = v;
  });
  res.writeHead(upstreamRes.status, resHeaders);

  const sniffer = makeUsageSniffer();
  const finish = () => {
    const ms = Date.now() - started;
    const usage = sniffer.summary();
    log(
      `${req.method} ${req.url} ${upstreamRes.status} ${ms}ms` +
        (model ? ` model=${model}` : '') +
        (usage ? ` ${usage}` : '') +
        ` [${clientName}]`,
    );
  };

  if (!upstreamRes.body) {
    res.end();
    return finish();
  }

  const nodeStream = Readable.fromWeb(upstreamRes.body);
  nodeStream.on('data', (chunk) => {
    try {
      sniffer.feed(chunk.toString('utf8'));
    } catch {
      /* 嗅探失败不影响转发 */
    }
  });
  nodeStream.on('error', (err) => {
    log(`${req.method} ${req.url} 流错误: ${err.message} [${clientName}]`);
    res.destroy(err);
  });
  res.on('close', () => nodeStream.destroy());
  nodeStream.pipe(res);
  res.on('finish', finish);
}

function maskToken(t) {
  if (!t) return 'none';
  if (t.length <= 8) return '***';
  return t.slice(0, 6) + '…' + t.slice(-4);
}

function log(msg) {
  process.stdout.write(`[${ts()}] ${msg}\n`);
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
  log(`  客户端令牌: ${config.clientTokens.map((t) => `${t.name}(${maskToken(t.token)})`).join(', ')}`);
  if (config.__file) log(`  配置文件:  ${config.__file}`);
  if (Object.keys(config.modelMap).length) {
    log(`  模型映射:  ${JSON.stringify(config.modelMap)}`);
  }
  const ips = lanIps();
  if (ips.length) {
    log(`  远端可用:  ${ips.map((ip) => `http://${ip}:${config.port}`).join('  ')}`);
  }
  log(`  远端配置:  ANTHROPIC_BASE_URL=http://<本机IP>:${config.port}  ANTHROPIC_AUTH_TOKEN=<你的客户端令牌>`);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`收到 ${sig},关闭中…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
