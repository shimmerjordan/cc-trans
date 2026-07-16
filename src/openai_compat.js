// OpenAI 兼容端点:把 POST /v1/chat/completions(OpenAI 格式)翻译成 Anthropic /v1/messages,
// 转发到上游(复用订阅凭证/身份伪装/参数下发),再把响应翻译回 OpenAI 格式(含 SSE 流式)。
// 让 OpenAI 生态的客户端也能用你的 Claude 订阅。文本/图片/系统提示/常用参数/工具定义均支持;
// 流式工具调用为尽力而为。

import { applyOverrides, modelAllowed } from './models.js';

const DEFAULT_MAX_TOKENS = 4096;

// ── 请求:OpenAI → Anthropic ────────────────────────────────────────
export function openAiToAnthropic(o) {
  const out = { model: o.model, max_tokens: o.max_tokens || o.max_completion_tokens || DEFAULT_MAX_TOKENS };
  if (typeof o.temperature === 'number') out.temperature = o.temperature;
  if (typeof o.top_p === 'number') out.top_p = o.top_p;
  if (o.stop != null) out.stop_sequences = Array.isArray(o.stop) ? o.stop : [o.stop];
  if (o.stream) out.stream = true;

  const systemParts = [];
  const messages = [];
  for (const m of o.messages || []) {
    const role = m.role;
    if (role === 'system' || role === 'developer') {
      systemParts.push(typeof m.content === 'string' ? m.content : textOf(m.content));
      continue;
    }
    if (role === 'tool') {
      // OpenAI 工具结果 → Anthropic tool_result(挂在 user 消息里)
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : textOf(m.content) }],
      });
      continue;
    }
    if (role === 'assistant') {
      const blocks = [];
      const text = typeof m.content === 'string' ? m.content : textOf(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      }
      messages.push({ role: 'assistant', content: blocks.length ? blocks : text || '' });
      continue;
    }
    // user
    messages.push({ role: 'user', content: toAnthropicContent(m.content) });
  }
  if (systemParts.length) out.system = systemParts.filter(Boolean).join('\n\n');
  out.messages = messages;

  // 工具定义:OpenAI function → Anthropic tool
  if (Array.isArray(o.tools) && o.tools.length) {
    out.tools = o.tools
      .filter((t) => t.type === 'function' && t.function)
      .map((t) => ({ name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object' } }));
  }
  if (o.tool_choice === 'required') out.tool_choice = { type: 'any' };
  else if (o.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
  else if (o.tool_choice && o.tool_choice.type === 'function') out.tool_choice = { type: 'tool', name: o.tool_choice.function?.name };

  return { body: out, stream: !!o.stream };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p.type === 'text').map((p) => p.text).join('');
  return '';
}

function toAnthropicContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const blocks = [];
  for (const p of content) {
    if (p.type === 'text') blocks.push({ type: 'text', text: p.text });
    else if (p.type === 'image_url') {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url || '';
      const m = /^data:(.+?);base64,(.*)$/s.exec(url);
      if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      else if (url) blocks.push({ type: 'image', source: { type: 'url', url } });
    }
  }
  return blocks.length ? blocks : '';
}

const FINISH = { end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop', tool_use: 'tool_calls', refusal: 'content_filter', pause_turn: 'stop' };

// ── 响应(非流式):Anthropic → OpenAI ──────────────────────────────
export function anthropicToOpenAiJson(a, model, createdSec) {
  const textBlocks = (a.content || []).filter((b) => b.type === 'text').map((b) => b.text);
  const toolCalls = (a.content || [])
    .filter((b) => b.type === 'tool_use')
    .map((b, i) => ({ id: b.id || `call_${i}`, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
  const msg = { role: 'assistant', content: textBlocks.join('') || null };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  const u = a.usage || {};
  const promptTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  return {
    id: a.id || 'chatcmpl-cctrans',
    object: 'chat.completion',
    created: createdSec,
    model: a.model || model,
    choices: [{ index: 0, message: msg, finish_reason: FINISH[a.stop_reason] || 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: u.output_tokens || 0, total_tokens: promptTokens + (u.output_tokens || 0) },
  };
}

// ── 响应(流式):Anthropic SSE → OpenAI SSE ─────────────────────────
// feed(text) 返回要写给客户端的 OpenAI SSE 串(可能为空);flush() 返回收尾串(含 [DONE])。
export function makeSseTranslator(model, createdSec) {
  const id = 'chatcmpl-cctrans';
  let buf = '';
  let sentRole = false;
  let finish = 'stop';
  const toolIdx = new Map(); // anthropic content index -> openai tool_calls index
  let nextTool = 0;

  const chunk = (delta, finish_reason = null) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: createdSec, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

  function handleEvent(dataStr) {
    let ev;
    try { ev = JSON.parse(dataStr); } catch { return ''; }
    let out = '';
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      const oi = nextTool++;
      toolIdx.set(ev.index, oi);
      if (!sentRole) { out += chunk({ role: 'assistant' }); sentRole = true; }
      out += chunk({ tool_calls: [{ index: oi, id: ev.content_block.id, type: 'function', function: { name: ev.content_block.name, arguments: '' } }] });
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta') {
        if (!sentRole) { out += chunk({ role: 'assistant' }); sentRole = true; }
        out += chunk({ content: d.text });
      } else if (d.type === 'input_json_delta') {
        const oi = toolIdx.get(ev.index) ?? 0;
        out += chunk({ tool_calls: [{ index: oi, function: { arguments: d.partial_json || '' } }] });
      }
    } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
      finish = FINISH[ev.delta.stop_reason] || 'stop';
    }
    return out;
  }

  return {
    feed(text) {
      buf += text;
      let out = '';
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          const s = line.trimStart();
          if (s.startsWith('data:')) out += handleEvent(s.slice(5).trim());
        }
      }
      return out;
    },
    flush() {
      if (!sentRole) return chunk({ role: 'assistant' }) + chunk({}, finish) + 'data: [DONE]\n\n';
      return chunk({}, finish) + 'data: [DONE]\n\n';
    },
  };
}

// ── HTTP 处理入口 ───────────────────────────────────────────────────
// ctx: { readBody, upstreamBaseUrl, dispatcher, buildBaseHeaders(), applyUpstreamAuth, applyClaudeCodeSpoof,
//        overrides, log, clientName, sendError, sendJson, recordOpenAi(status, usage, model) }
export async function handleOpenAiCompat(req, res, ctx) {
  const started = Date.now();
  const createdSec = Math.floor(started / 1000);
  let openaiReq;
  try {
    openaiReq = JSON.parse((await ctx.readBody(req)).toString('utf8') || '{}');
  } catch {
    return ctx.sendError(res, 400, 'invalid_request_error', 'cc-trans: 请求体不是合法 JSON');
  }
  const { body: anthropicBody, stream } = openAiToAnthropic(openaiReq);
  applyOverrides(anthropicBody, ctx.overrides); // 复用参数下发(强制模型/thinking/effort/清洗/前缀)
  const effectiveModel = anthropicBody.model;

  // B 安全:模型白名单
  if (effectiveModel && !modelAllowed(ctx.allowedModels, effectiveModel)) {
    ctx.recordOpenAi(403, {}, effectiveModel);
    return ctx.sendError(res, 403, 'permission_error', `cc-trans: 令牌不允许使用模型 ${effectiveModel}`);
  }

  const upFetch = ctx.fetch || globalThis.fetch;
  const headers = ctx.buildBaseHeaders();
  headers['content-type'] = 'application/json';
  try {
    await ctx.applyUpstreamAuth(headers);
  } catch (err) {
    return ctx.sendError(res, 502, 'api_error', `cc-trans 上游凭证不可用: ${err.message}`);
  }
  ctx.applyClaudeCodeSpoof(headers, effectiveModel, ctx.overrides);

  const bodyBuf = Buffer.from(JSON.stringify(anthropicBody));
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });

  let upstreamRes;
  try {
    upstreamRes = await upFetch(ctx.upstreamBaseUrl + '/v1/messages', {
      method: 'POST', headers, body: bodyBuf, signal: abort.signal, dispatcher: ctx.dispatcher,
    });
  } catch (err) {
    if (abort.signal.aborted) return;
    ctx.log(`OpenAI兼容 502 上游不可达: ${err.message} [${ctx.clientName}]`);
    ctx.recordOpenAi(502, {}, effectiveModel);
    return ctx.sendError(res, 502, 'api_error', `cc-trans 无法连接上游: ${err.message}`);
  }

  // 非 2xx:把 Anthropic 错误体透传(OpenAI 客户端也能读 error.message)
  if (!upstreamRes.ok) {
    const text = await upstreamRes.text();
    ctx.log(`OpenAI兼容 ${upstreamRes.status} 上游返回错误 [${ctx.clientName}]`);
    ctx.recordOpenAi(upstreamRes.status, {}, effectiveModel);
    res.writeHead(upstreamRes.status, { 'content-type': 'application/json' });
    return res.end(text);
  }

  if (!stream) {
    const a = await upstreamRes.json();
    const openai = anthropicToOpenAiJson(a, effectiveModel, createdSec);
    ctx.recordOpenAi(upstreamRes.status, a.usage ? { input: a.usage.input_tokens, output: a.usage.output_tokens, cacheRead: a.usage.cache_read_input_tokens, cacheWrite: a.usage.cache_creation_input_tokens } : {}, effectiveModel);
    return ctx.sendJson(res, 200, openai);
  }

  // 流式:翻译 Anthropic SSE → OpenAI SSE
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.on('error', () => {});
  const tr = makeSseTranslator(effectiveModel, createdSec);
  const usage = {};
  try {
    for await (const chunk of upstreamRes.body) {
      const text = Buffer.from(chunk).toString('utf8');
      // 顺带嗅探 usage 用于统计
      const im = /"input_tokens"\s*:\s*(\d+)/.exec(text); if (im) usage.input = Number(im[1]);
      const om = /"output_tokens"\s*:\s*(\d+)/.exec(text); if (om) usage.output = Number(om[1]);
      const out = tr.feed(text);
      if (out) res.write(out);
    }
    res.write(tr.flush());
    res.end();
    ctx.recordOpenAi(200, usage, effectiveModel);
  } catch (err) {
    if (!abort.signal.aborted && !res.writableEnded) {
      try { res.write(`data: ${JSON.stringify({ error: { message: `cc-trans: 上游流中断(${err.message})` } })}\n\ndata: [DONE]\n\n`); res.end(); } catch { res.destroy(err); }
    }
    ctx.recordOpenAi(200, usage, effectiveModel);
  }
}
