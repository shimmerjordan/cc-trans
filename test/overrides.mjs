// 参数下发/模型目录测试:mock 上游,验证按客户端的请求体改写、门禁前缀注入、新模型参数清洗、管理台 API。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const UPSTREAM_PORT = 9996;
const PROXY_PORT = 8790;
const TOK_A = 'cct-ov-full'; // 全量下发
const TOK_B = 'cct-ov-inject'; // 仅注入前缀
const TOK_C = 'cct-ov-none'; // 无下发(字节保真)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-trans-ov-'));
const CONFIG = path.join(TMP, 'config.json');
fs.writeFileSync(CONFIG, JSON.stringify({
  port: PROXY_PORT, host: '127.0.0.1',
  upstreamBaseUrl: `http://127.0.0.1:${UPSTREAM_PORT}`,
  upstreamApiKey: 'REAL-KEY',
  adminEnabled: true, adminUser: 'admin', adminPassword: 'secret123',
  clientTokens: [
    { token: TOK_A, name: 'full', overrides: { model: 'claude-opus-4-8', thinking: 'adaptive', effort: 'low', injectClaudeCodeSystem: true, stripUnsupported: true } },
    { token: TOK_B, name: 'inject', overrides: { injectClaudeCodeSystem: true } },
    { token: TOK_C, name: 'none' },
  ],
}, null, 2));

let lastBody = null;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    lastBody = Buffer.concat(chunks).toString('utf8');
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [
        { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
        { id: 'claude-opus-4-9', display_name: 'Claude Opus 4.9' }, // 目录外新模型
      ] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

const results = [];
const check = (name, cond, extra = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); };

async function main() {
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, r));
  const child = spawn('node', ['src/server.js'], { cwd: ROOT, env: { ...process.env, CC_TRANS_CONFIG: CONFIG }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logBuf = '';
  child.stdout.on('data', (d) => (logBuf += d));
  child.stderr.on('data', (d) => (logBuf += d));
  const base = `http://127.0.0.1:${PROXY_PORT}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

  const post = (token, body, p = '/v1/messages') => fetch(base + p, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  try {
    // 1) 全量下发:强制模型 + 清洗 + 注入 + thinking/effort
    await post(TOK_A, { model: 'claude-sonnet-4-5', max_tokens: 8, temperature: 0.7, top_p: 0.9, system: '自定义助手', messages: [{ role: 'user', content: 'hi' }] });
    let b = JSON.parse(lastBody);
    check('强制模型改写', b.model === 'claude-opus-4-8', b.model);
    check('temperature/top_p 被清洗', !('temperature' in b) && !('top_p' in b));
    check('thinking 下发 adaptive', b.thinking && b.thinking.type === 'adaptive');
    check('effort 下发 low', b.output_config && b.output_config.effort === 'low');
    // 门禁是块级精确匹配:字符串 system 注入后应变成 [精确前缀块, 原内容块]
    check('CC system 前缀注入(字符串→拆块)', Array.isArray(b.system)
      && b.system[0].text === "You are Claude Code, Anthropic's official CLI for Claude."
      && b.system[1].text === '自定义助手');

    // 2) system 为块数组时前缀作为首块注入
    await post(TOK_A, { model: 'claude-opus-4-8', max_tokens: 8, system: [{ type: 'text', text: '自定义' }], messages: [{ role: 'user', content: 'hi' }] });
    b = JSON.parse(lastBody);
    check('CC system 前缀注入(数组)', Array.isArray(b.system) && b.system[0].text.startsWith('You are Claude Code') && b.system[1].text === '自定义');

    // 3) 已带前缀 → 不重复注入
    await post(TOK_A, { model: 'claude-opus-4-8', max_tokens: 8, system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: 'user', content: 'hi' }] });
    b = JSON.parse(lastBody);
    check('已有前缀不重复注入', typeof b.system === 'string' && !b.system.slice(10).includes('You are Claude Code'));

    // 4) Haiku 免门禁:仅注入开关的令牌 + haiku 模型 → 不注入
    await post(TOK_B, { model: 'claude-haiku-4-5-20251001', max_tokens: 8, system: '自定义', messages: [{ role: 'user', content: 'hi' }] });
    b = JSON.parse(lastBody);
    check('Haiku 不注入前缀', b.system === '自定义');

    // 5) 无下发令牌:字节保真透传
    const raw = JSON.stringify({ model: 'claude-x', max_tokens: 8, temperature: 0.9, messages: [{ role: 'user', content: 'hi' }] });
    await fetch(base + '/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${TOK_C}`, 'content-type': 'application/json' }, body: raw });
    check('无下发时原样透传', lastBody === raw);

    // 6) 管理台:目录 / 上游模型拉取 / 在线改下发并持久化
    const login = await (await fetch(base + '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'secret123' }) })).json();
    const H = { authorization: 'Bearer ' + login.session, 'content-type': 'application/json' };
    const cat = await (await fetch(base + '/admin/api/models', { headers: H })).json();
    check('模型目录接口', Array.isArray(cat.catalog) && cat.catalog.some((m) => m.id === 'claude-opus-4-8') && !!cat.catalogVersion);
    const live = await (await fetch(base + '/admin/api/models/refresh', { method: 'POST', headers: H })).json();
    check('上游模型拉取+新模型识别', live.ok && live.live.length === 2 && live.live.find((m) => m.id === 'claude-opus-4-9' && !m.inCatalog));
    const clients = await (await fetch(base + '/admin/api/clients', { headers: H })).json();
    const noneTok = clients.tokens.find((t) => t.name === 'none');
    check('客户端列表带 overrides', clients.tokens.find((t) => t.name === 'full').overrides.effort === 'low');
    const setr = await (await fetch(base + '/admin/api/tokens/overrides', { method: 'POST', headers: H, body: JSON.stringify({ id: noneTok.id, overrides: { effort: 'high', model: 'claude-sonnet-5', thinking: 'bogus' } }) })).json();
    check('在线下发保存(非法值被丢弃)', setr.ok && setr.overrides.effort === 'high' && setr.overrides.model === 'claude-sonnet-5' && !('thinking' in setr.overrides));
    const cfgNow = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    check('下发持久化到 config.json', cfgNow.clientTokens.find((t) => t.name === 'none').overrides.effort === 'high');
    // 保存后立即生效
    await post(TOK_C, { model: 'claude-x', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
    b = JSON.parse(lastBody);
    check('下发立即生效', b.model === 'claude-sonnet-5' && b.output_config.effort === 'high');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r)); // 等指标落盘完成再清理临时目录
    upstream.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响测试结果 */ }
  }

  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} 通过`);
  if (fails) { console.log('\n--- 服务端日志 ---\n' + logBuf.split('\n').slice(-30).join('\n')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
