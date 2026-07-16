// 新增能力测试:A 身份伪装 / B 限流+并发+UA限制+模型白名单 / C 成本统计 / D OpenAI 兼容端点。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const UP = 19973;
const PORT = 18775;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-feat-'));
const CFG = path.join(TMP, 'config.json');

const TOK_SPOOF = 'cct-spoof';
const TOK_RL = 'cct-rl';
const TOK_CONC = 'cct-conc';
const TOK_UA = 'cct-ua';
const TOK_WL = 'cct-wl';
const TOK_OAI = 'cct-oai';
const TOK_PLAIN = 'cct-plain';

fs.writeFileSync(CFG, JSON.stringify({
  port: PORT, host: '127.0.0.1',
  upstreamBaseUrl: `http://127.0.0.1:${UP}`,
  // 用 oauth 模式以启用身份伪装;伪造一个凭证文件
  upstreamAuth: 'oauth',
  oauthCredentialsPath: path.join(TMP, 'creds.json'),
  adminEnabled: true, adminUser: 'admin', adminPassword: 'secret123',
  clientTokens: [
    { token: TOK_SPOOF, name: 'spoof', overrides: { spoofClaudeCode: true } },
    { token: TOK_RL, name: 'rl', overrides: { rateLimitRequests: 2, rateLimitWindowSec: 60 } },
    { token: TOK_CONC, name: 'conc', overrides: { concurrencyLimit: 1 } },
    { token: TOK_UA, name: 'ua', overrides: { allowedClient: 'claude_code' } },
    { token: TOK_WL, name: 'wl', overrides: { allowedModels: ['claude-haiku-4-5-20251001'] } },
    { token: TOK_OAI, name: 'oai' },
    { token: TOK_PLAIN, name: 'plain' },
  ],
}, null, 2));
fs.writeFileSync(path.join(TMP, 'creds.json'), JSON.stringify({
  claudeAiOauth: { accessToken: 'sk-oat-test', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, subscriptionType: 'team' },
}));

let lastHeaders = null;
let lastBody = null;
let inflight = 0;
let maxInflight = 0;
const up = http.createServer((req, res) => {
  lastHeaders = req.headers;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    lastBody = Buffer.concat(chunks).toString('utf8');
    const isStream = /"stream"\s*:\s*true/.test(lastBody);
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    // 并发测试:慢一点好观测重叠
    await new Promise((r) => setTimeout(r, 150));
    inflight--;
    if (isStream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10}}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n');
      res.write('event: message_stop\ndata: {}\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }));
    }
  });
});

const results = [];
const ck = (n, c, e = '') => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? ' — ' + e : ''}`); };

async function main() {
  await new Promise((r) => up.listen(UP, r));
  const child = spawn('node', ['src/server.js'], { cwd: ROOT, env: { ...process.env, CC_TRANS_CONFIG: CFG }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', (d) => (logs += d)); child.stderr.on('data', (d) => (logs += d));
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

  const msg = (tok, extra = {}, hdr = {}) => fetch(base + '/v1/messages', {
    method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...hdr },
    body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...extra }),
  });

  try {
    // A 身份伪装
    await msg(TOK_SPOOF);
    ck('A spoof: UA 被替换为 claude-cli', /^claude-cli\//.test(lastHeaders['user-agent'] || ''), lastHeaders['user-agent']);
    ck('A spoof: x-app=cli', lastHeaders['x-app'] === 'cli');
    ck('A spoof: anthropic-beta 含 claude-code-20250219 与 oauth', /claude-code-20250219/.test(lastHeaders['anthropic-beta'] || '') && /oauth-2025-04-20/.test(lastHeaders['anthropic-beta'] || ''), lastHeaders['anthropic-beta']);
    ck('A spoof: accept-encoding=identity', (lastHeaders['accept-encoding'] || '') === 'identity');

    // 无伪装的普通令牌:UA 保持客户端原样(不是 claude-cli)
    await msg(TOK_PLAIN, {}, { 'user-agent': 'my-app/1.0' });
    ck('普通令牌不改 UA', lastHeaders['user-agent'] === 'my-app/1.0', lastHeaders['user-agent']);

    // B 限流:第 3 次应 429
    const r1 = await msg(TOK_RL); const r2 = await msg(TOK_RL); const r3 = await msg(TOK_RL);
    ck('B 限流: 前两次 200', r1.status === 200 && r2.status === 200, `${r1.status},${r2.status}`);
    ck('B 限流: 第三次 429 + Retry-After', r3.status === 429 && !!r3.headers.get('retry-after'), `${r3.status} ra=${r3.headers.get('retry-after')}`);

    // B 并发:两个并发请求,limit=1,应有一个 429
    const [c1, c2] = await Promise.all([msg(TOK_CONC), msg(TOK_CONC)]);
    const codes = [c1.status, c2.status].sort();
    ck('B 并发: 一个 200 一个 429', codes[0] === 200 && codes[1] === 429, codes.join(','));

    // B UA 限制:非 claude-cli → 403;claude-cli → 放行
    const bad = await msg(TOK_UA, {}, { 'user-agent': 'curl/8' });
    const good = await msg(TOK_UA, {}, { 'user-agent': 'claude-cli/1.0.1 (x)' });
    ck('B UA限制: 非CC被403', bad.status === 403, String(bad.status));
    ck('B UA限制: CC放行', good.status === 200, String(good.status));

    // B 模型白名单:opus 被拒,haiku 放行
    const wlBad = await msg(TOK_WL, { model: 'claude-opus-4-8' });
    const wlGood = await msg(TOK_WL, { model: 'claude-haiku-4-5-20251001' });
    ck('B 白名单: 非白名单模型403', wlBad.status === 403, String(wlBad.status));
    ck('B 白名单: 白名单模型放行', wlGood.status === 200, String(wlGood.status));

    // D OpenAI 兼容:非流式
    const oaiRes = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${TOK_OAI}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: '你好' }] }),
    });
    const oai = await oaiRes.json();
    ck('D OpenAI非流式: 结构正确', oai.object === 'chat.completion' && oai.choices[0].message.content === 'pong' && oai.choices[0].finish_reason === 'stop', JSON.stringify(oai).slice(0, 120));
    ck('D OpenAI非流式: usage 映射', oai.usage.prompt_tokens === 10 && oai.usage.completion_tokens === 5);
    // 请求体已翻译:system 提到顶层
    const tb = JSON.parse(lastBody);
    ck('D 翻译: system 提到顶层', tb.system === '你是助手' && tb.messages[0].role === 'user');

    // D OpenAI 兼容:流式
    const stRes = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${TOK_OAI}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    let sse = ''; const rd = stRes.body.getReader(); const dec = new TextDecoder();
    while (true) { const { done, value } = await rd.read(); if (done) break; sse += dec.decode(value); }
    ck('D OpenAI流式: chunk 结构 + 内容 + [DONE]', /chat\.completion\.chunk/.test(sse) && /"content":"你好"/.test(sse) && /data: \[DONE\]/.test(sse), sse.slice(0, 160));
    ck('D OpenAI流式: finish_reason=stop', /"finish_reason":"stop"/.test(sse));

    // C 成本:管理台 status.totals.cost > 0(前面发了不少 opus 请求)
    const login = await (await fetch(base + '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'secret123' }) })).json();
    const st = await (await fetch(base + '/admin/api/status', { headers: { authorization: 'Bearer ' + login.session } })).json();
    ck('C 成本: totals.cost > 0', (st.totals.cost || 0) > 0, 'cost=' + st.totals.cost);
    const clients = await (await fetch(base + '/admin/api/clients', { headers: { authorization: 'Bearer ' + login.session } })).json();
    const oaiClient = clients.tokens.find((t) => t.name === 'oai');
    ck('C 成本: 客户端聚合含 cost', oaiClient.stats && (oaiClient.stats.cost || 0) > 0, 'cost=' + (oaiClient.stats && oaiClient.stats.cost));
  } finally {
    child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)); up.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }

  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} 通过`);
  if (fails) { console.log('\n--- 服务端日志尾部 ---\n' + logs.split('\n').slice(-40).join('\n')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
