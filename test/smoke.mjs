// 冒烟测试:启动本地 mock 上游 + 真实 cc-trans 子进程,验证鉴权/密钥注入/转发/流式/用量。
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const UPSTREAM_PORT = 9999;
const PROXY_PORT = 8788;
const REAL_KEY = 'REAL-UPSTREAM-KEY';
const CLIENT_TOKEN = 'cct-test-client-token';

let lastSeenAuthOnUpstream = null;
let lastSeenBody = null;

// ── mock 上游 ───────────────────────────────────────────────
const upstream = http.createServer((req, res) => {
  lastSeenAuthOnUpstream = {
    apiKey: req.headers['x-api-key'] || null,
    authorization: req.headers['authorization'] || null,
    version: req.headers['anthropic-version'] || null,
  };
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    lastSeenBody = Buffer.concat(chunks).toString('utf8');
    // 上游应只收到真实密钥,绝不应是客户端令牌
    if (req.headers['x-api-key'] !== REAL_KEY) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'auth', message: 'bad key at upstream' } }));
      return;
    }
    // 返回一段 SSE 流,含 token 用量
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\n');
    res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":42,"cache_read_input_tokens":7}}}\n\n');
    res.write('event: message_delta\n');
    res.write('data: {"type":"message_delta","usage":{"output_tokens":13}}\n\n');
    res.write('event: message_stop\n');
    res.write('data: {"type":"message_stop"}\n\n');
    res.end();
  });
});

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

async function main() {
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, r));

  const child = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CC_TRANS_PORT: String(PROXY_PORT),
      CC_TRANS_HOST: '127.0.0.1',
      CC_TRANS_UPSTREAM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      CC_TRANS_UPSTREAM_API_KEY: REAL_KEY,
      CC_TRANS_CLIENT_TOKENS: CLIENT_TOKEN,
      CC_TRANS_CONFIG: '/nonexistent-on-purpose.json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d.toString()));
  child.stderr.on('data', (d) => (serverLog += d.toString()));

  const base = `http://127.0.0.1:${PROXY_PORT}`;
  // 等待启动
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    // 1) 健康检查无需令牌
    const h = await fetch(`${base}/health`);
    const hj = await h.json();
    check('健康检查 /health 返回 200 且 ok', h.status === 200 && hj.ok === true);

    // 2) 无令牌 → 401
    const noTok = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' });
    check('无令牌请求被拒 (401)', noTok.status === 401);

    // 3) 错误令牌 → 401
    const badTok = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
      body: '{}',
    });
    check('错误令牌被拒 (401)', badTok.status === 401);

    // 4) 正确令牌(Bearer)→ 转发成功 + 上游收到真实密钥(非客户端令牌)
    const reqBody = JSON.stringify({ model: 'claude-test', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    const ok = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CLIENT_TOKEN}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: reqBody,
    });
    const text = await ok.text();
    check('合法令牌转发成功 (200)', ok.status === 200, `status=${ok.status}`);
    check('上游收到的是真实密钥', lastSeenAuthOnUpstream?.apiKey === REAL_KEY, `got=${lastSeenAuthOnUpstream?.apiKey}`);
    check('客户端令牌未泄露到上游', lastSeenAuthOnUpstream?.authorization === null);
    check('anthropic-version 头被透传', lastSeenAuthOnUpstream?.version === '2023-06-01');
    check('请求体被原样转发', lastSeenBody === reqBody);
    check('SSE 流式响应回传完整', text.includes('message_start') && text.includes('message_stop'));

    // 5) x-api-key 形式的客户端令牌也应被接受
    const okXkey = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': CLIENT_TOKEN, 'content-type': 'application/json' },
      body: reqBody,
    });
    await okXkey.text();
    check('x-api-key 形式的客户端令牌被接受 (200)', okXkey.status === 200, `status=${okXkey.status}`);

    // 6) 服务端日志含用量嗅探 (in=42 out=13)
    await new Promise((r) => setTimeout(r, 200));
    check('日志含 token 用量嗅探', /in=42/.test(serverLog) && /out=13/.test(serverLog), 'see in=/out= in log');
  } finally {
    child.kill('SIGTERM');
    upstream.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('\n--- 服务端日志片段 ---\n' + serverLog.split('\n').slice(0, 40).join('\n'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
