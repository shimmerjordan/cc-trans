#!/usr/bin/env node
// 客户端自检:在【远端机器】上运行,验证它能否经 cc-trans 正常用到模型。
// 只依赖 Node ≥ 18,把本文件拷到远端直接 `node client.mjs` 即可。
//
// 用法(任选一种传参):
//   CC_TRANS_URL=http://服务器IP:8787 CC_TRANS_TOKEN=cct-你的令牌 node client.mjs
//   # 或者复用 Claude Code 的环境变量:
//   ANTHROPIC_BASE_URL=http://服务器IP:8787 ANTHROPIC_AUTH_TOKEN=cct-你的令牌 node client.mjs
//   # 可选:CC_TRANS_MODEL=claude-haiku-4-5-20251001 指定测试用的模型

const BASE = (process.env.CC_TRANS_URL || process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
const TOKEN =
  process.env.CC_TRANS_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.CC_TRANS_MODEL || 'claude-sonnet-4-5-20250929';
// 订阅(OAuth)模式下,非 Haiku 模型要求 system 以此开头,否则上游 400。
// 真实 Claude Code 本来就带它;这里测试也带上,对 apiKey 模式无害。
const CC_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

if (!BASE || !TOKEN) {
  console.error(
    '缺少参数。请设置:\n' +
      '  CC_TRANS_URL   (或 ANTHROPIC_BASE_URL)   例: http://192.168.1.10:8787\n' +
      '  CC_TRANS_TOKEN (或 ANTHROPIC_AUTH_TOKEN)  例: cct-xxxx\n' +
      '可选 CC_TRANS_MODEL 指定模型(默认 ' + MODEL + ')',
  );
  process.exit(2);
}

const results = [];
function pass(name, extra = '') {
  results.push(true);
  console.log(`✅ PASS  ${name}${extra ? '  — ' + extra : ''}`);
}
function fail(name, extra = '') {
  results.push(false);
  console.log(`❌ FAIL  ${name}${extra ? '  — ' + extra : ''}`);
}

const headers = (extra = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json',
  ...extra,
});

console.log(`\n目标代理: ${BASE}`);
console.log(`测试模型: ${MODEL}`);
console.log(`令牌:     ${TOKEN.slice(0, 6)}…${TOKEN.slice(-4)}\n`);

// ── 1) 连通性:健康检查(无需令牌)
async function testHealth() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) pass('1. 连通性 /health', `上游=${j.upstream} 客户端数=${j.clients}`);
    else fail('1. 连通性 /health', `status=${r.status}`);
  } catch (e) {
    fail('1. 连通性 /health', `连不上服务器: ${e.message}（检查 IP/端口/防火墙）`);
  }
}

// ── 2) 鉴权确实生效:错误令牌应被拒(401)
async function testAuthRejected() {
  try {
    const r = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { ...headers(), authorization: 'Bearer definitely-wrong-token' },
      body: JSON.stringify({ model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }),
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 401) pass('2. 鉴权生效:错误令牌被拒 (401)');
    else fail('2. 鉴权生效', `期望 401,实际 ${r.status}（代理可能没在校验令牌)`);
  } catch (e) {
    fail('2. 鉴权生效', e.message);
  }
}

// ── 3) 真实非流式请求:端到端拿到模型回复
async function testMessage() {
  try {
    const r = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 32,
        system: CC_SYSTEM,
        messages: [{ role: 'user', content: '只回复两个字:你好' }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status !== 200) {
      fail('3. 非流式对话', `status=${r.status} ${JSON.stringify(j).slice(0, 200)}`);
      return;
    }
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const u = j.usage || {};
    if (text) pass('3. 非流式对话', `回复="${text.trim().slice(0, 30)}" in=${u.input_tokens} out=${u.output_tokens}`);
    else fail('3. 非流式对话', `200 但无文本: ${JSON.stringify(j).slice(0, 200)}`);
  } catch (e) {
    fail('3. 非流式对话', e.message);
  }
}

// ── 4) 流式请求:SSE 分片确实在流动(Claude Code 实际用的就是这个)
async function testStream() {
  try {
    const r = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 32,
        stream: true,
        system: CC_SYSTEM,
        messages: [{ role: 'user', content: '从 1 数到 5,用空格分隔' }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (r.status !== 200 || !r.body) {
      fail('4. 流式对话 (SSE)', `status=${r.status}`);
      return;
    }
    const decoder = new TextDecoder();
    let buf = '';
    let sawStart = false;
    let sawStop = false;
    let chunks = 0;
    let text = '';
    for await (const part of r.body) {
      buf += decoder.decode(part, { stream: true });
      if (buf.includes('message_start')) sawStart = true;
      if (buf.includes('message_stop')) sawStop = true;
      chunks++;
      // 顺手抠出 text_delta 文本
      const m = buf.matchAll(/"type":"text_delta","text":"((?:[^"\\]|\\.)*)"/g);
      for (const x of m) {
        try { text += JSON.parse(`"${x[1]}"`); } catch {}
      }
    }
    if (sawStart && sawStop && chunks > 0)
      pass('4. 流式对话 (SSE)', `分片数=${chunks} 文本="${text.trim().slice(0, 30)}"`);
    else fail('4. 流式对话 (SSE)', `start=${sawStart} stop=${sawStop} chunks=${chunks}`);
  } catch (e) {
    fail('4. 流式对话 (SSE)', e.message);
  }
}

await testHealth();
await testAuthRejected();
await testMessage();
await testStream();

const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} 通过`);
if (ok === results.length) {
  console.log('🎉 客户端可以正常经 cc-trans 使用模型,直接配 Claude Code 即可。\n');
  process.exit(0);
} else {
  console.log('⚠️  有失败项,按上面的提示排查(常见:服务器没填真实密钥 / 令牌不在白名单 / 模型名上游不认 / 防火墙)。\n');
  process.exit(1);
}
