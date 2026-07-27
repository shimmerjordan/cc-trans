// 网页聊天的 HTTP 层。挂在用户端下(/u/api/chat/*),鉴权沿用 user.js 的 session。
//
// 关键设计:聊天不另开一条上游通路,而是以【用户绑定的某台设备】的身份走内部转发
// (server.js 注入的 forward)。这样一次性继承:参数下发、限流/并发、成本估算、
// 日志与统计 —— 用户在「我的设备」看到的用量就包含他在网页聊天里花掉的部分。
//
// 推论:管理员给该设备设了强制模型时,聊天的模型选择会被覆盖。这是对的语义
// (策略优先于偏好),前端会把选择器锁掉并说明原因。

import { inferModelMeta } from './models.js';

const DEFAULT_MAX_TOKENS = 8192;
const MAX_INPUT_CHARS = 200_000; // 单条输入上限,防误粘贴整本书
const TITLE_FROM_CHARS = 40;

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

function readJson(req, limitBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// 把会话消息转成 Anthropic messages。图片以 base64 image block 随行。
function toAnthropicMessages(messages, loadImage) {
  const out = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (m.error) continue; // 失败的回复不进上下文
    const text = String(m.content || '');
    const imgs = Array.isArray(m.images) ? m.images : [];
    if (m.role === 'user' && imgs.length) {
      const blocks = [];
      for (const im of imgs) {
        const got = loadImage(im.id);
        if (!got) continue;
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: got.mime, data: got.buf.toString('base64') },
        });
      }
      blocks.push({ type: 'text', text: text || '看看这张图' });
      out.push({ role: 'user', content: blocks });
      continue;
    }
    if (!text.trim()) continue;
    out.push({ role: m.role, content: text });
  }
  return out;
}

export function createChat({ store, modelStore, tokenAdmin, tokenIdOf, forward, config, log = () => {} }) {
  // 用户能用的设备(= 他绑定的令牌),聊天要选一台来记账
  function devicesOf(user) {
    const bound = new Set(user.tokenIds || []);
    return tokenAdmin
      .list()
      .map((t) => ({ ...t, id: tokenIdOf(t.token) }))
      .filter((t) => bound.has(t.id));
  }

  function pickDevice(user, wantId) {
    const devs = devicesOf(user);
    if (!devs.length) return null;
    if (wantId) {
      const hit = devs.find((d) => d.id === wantId);
      if (hit) return hit;
      return null; // 指定了但不属于自己 → 明确失败,不静默回落
    }
    return devs[0];
  }

  function modelChoices() {
    // modelStore.list() 返回 { fetchedAt, fromUpstream, models },不是裸数组
    const list = ((modelStore.list ? modelStore.list() : null) || {}).models || [];
    const models = list.map((m) => {
      const meta = m.tier ? m : { ...m, ...inferModelMeta(m.id) };
      return {
        id: m.id,
        tier: meta.tier,
        latest: !!m.latest,
        // 前端据此决定 effort / thinking 选择器出不出现、给哪些值
        effort: meta.effort,
        thinking: meta.thinking,
        supportsEffort: !/不支持/.test(String(meta.effort || '')),
        thinkingDisabledOk: !/不接受 disabled|只能省略/.test(String(meta.thinking || '')),
      };
    });
    return models;
  }

  async function handle(sub, req, res, me) {
    // ── 会话列表 / 新建 ──
    if (sub === '/sessions' && req.method === 'GET') {
      if (!store.enabled) return sendJson(res, 200, { sessions: [], persisted: false });
      return sendJson(res, 200, { sessions: store.list(me.name), persisted: true, stats: store.stats(me.name) });
    }
    if (sub === '/sessions' && req.method === 'POST') {
      const b = await readJson(req).catch(() => ({}));
      const r = store.create(me.name, { title: b.title || '', model: b.model || '' });
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    // ── 单会话读 / 改名 / 删除 / 清空 ──
    if (sub === '/session' && req.method === 'GET') {
      const u = new URL(req.url, 'http://localhost');
      const s = store.get(me.name, u.searchParams.get('id'));
      if (!s) return sendJson(res, 404, { error: '会话不存在' });
      return sendJson(res, 200, { session: s });
    }
    if (sub === '/session/rename' && req.method === 'POST') {
      const b = await readJson(req).catch(() => ({}));
      const r = store.rename(me.name, b.id, b.title);
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (sub === '/session/remove' && req.method === 'POST') {
      const b = await readJson(req).catch(() => ({}));
      const r = store.remove(me.name, b.id);
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (sub === '/sessions/clear' && req.method === 'POST') {
      return sendJson(res, 200, store.clear(me.name));
    }

    // ── 可选模型 + 我的设备 + 强制模型提示 ──
    if (sub === '/meta' && req.method === 'GET') {
      const devs = devicesOf(me).map((d) => ({
        id: d.id,
        name: d.name,
        forcedModel: (d.overrides && d.overrides.model) || '',
        forcedThinking: (d.overrides && d.overrides.thinking) || '',
        forcedEffort: (d.overrides && d.overrides.effort) || '',
      }));
      return sendJson(res, 200, {
        models: modelChoices(),
        devices: devs,
        defaultMaxTokens: DEFAULT_MAX_TOKENS,
        maxImageBytes: store.MAX_IMAGE_BYTES,
        persisted: store.enabled,
      });
    }

    // ── 图片上传 / 读取 ──
    if (sub === '/image' && req.method === 'POST') {
      const b = await readJson(req).catch(() => null);
      if (!b) return sendJson(res, 400, { error: '请求体无法解析(图片过大?)' });
      const r = store.putImage(me.name, { data: b.data, mime: b.mime });
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (sub === '/image' && req.method === 'GET') {
      const u = new URL(req.url, 'http://localhost');
      const got = store.getImage(me.name, u.searchParams.get('id'));
      if (!got) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        'content-type': got.mime,
        'content-length': got.buf.length,
        // 内容寻址 → 可长缓存;private 避免被共享缓存看到别人的图
        'cache-control': 'private, max-age=31536000, immutable',
      });
      return res.end(got.buf);
    }

    // ── 发消息(流式)──
    if (sub === '/stream' && req.method === 'POST') {
      return handleStream(req, res, me);
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  async function handleStream(req, res, me) {
    let b;
    try {
      b = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: '请求体无法解析: ' + err.message });
    }

    const dev = pickDevice(me, b.deviceId);
    if (!dev) return sendJson(res, 403, { error: '没有可用设备 —— 请让管理员给你的账号分配一个客户端令牌' });

    const text = String(b.text || '');
    const images = Array.isArray(b.images) ? b.images.slice(0, 8) : [];
    if (!text.trim() && !images.length) return sendJson(res, 400, { error: '内容为空' });
    if (text.length > MAX_INPUT_CHARS) return sendJson(res, 400, { error: `单条输入超过 ${MAX_INPUT_CHARS} 字符` });

    // 会话:没给 id 就新建
    let session = b.sessionId ? store.get(me.name, b.sessionId) : null;
    if (!session) {
      const created = store.create(me.name, { model: b.model || '' });
      if (!created.ok) return sendJson(res, 400, created);
      session = created.session;
    }

    // regenerate:丢掉最后一条 assistant 回复,重发上一轮 user 消息
    if (b.regenerate) {
      while (session.messages.length && session.messages[session.messages.length - 1].role === 'assistant') {
        session.messages.pop();
      }
    } else {
      session.messages.push({ role: 'user', content: text, images, ts: Date.now() });
      if (!session.title) {
        session.title = (text.replace(/\s+/g, ' ').trim().slice(0, TITLE_FROM_CHARS) || '新对话');
      }
    }
    if (b.model) session.model = b.model;
    store.save(me.name, session);

    const payload = {
      model: b.model || session.model || '',
      max_tokens: Math.min(64000, Math.max(256, Number(b.maxTokens) || DEFAULT_MAX_TOKENS)),
      stream: true,
      messages: toAnthropicMessages(session.messages, (id) => store.getImage(me.name, id)),
    };
    if (!payload.model) return sendJson(res, 400, { error: '请选择模型' });
    if (b.system) payload.system = String(b.system).slice(0, 20000);
    if (b.thinking === 'adaptive') payload.thinking = { type: 'adaptive' };
    else if (b.thinking === 'disabled') payload.thinking = { type: 'disabled' };
    if (b.effort) payload.output_config = { effort: String(b.effort) };

    // SSE 头先发:让浏览器立刻进入流式接收状态
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const emit = (obj) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    emit({ t: 'start', sessionId: session.id, title: session.title, model: payload.model });

    const ac = new AbortController();
    let clientGone = false;
    // 用户点「停止」= 断开这条 SSE。必须把上游也取消掉,否则后台还在烧额度。
    res.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        ac.abort();
      }
    });

    let fwd;
    try {
      fwd = await forward({ tokenEntry: dev, payload, signal: ac.signal, req });
    } catch (err) {
      emit({ t: 'error', message: '转发失败: ' + err.message });
      return res.end();
    }
    if (fwd.error) {
      emit({ t: 'error', message: fwd.error.message || '被拒绝', status: fwd.error.status });
      return res.end();
    }

    const upstream = fwd.res;
    let full = '';
    let thinking = '';
    let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let failed = null;

    try {
      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        failed = `上游 ${upstream.status}: ${errText.slice(0, 400)}`;
        emit({ t: 'error', message: failed, status: upstream.status });
      } else {
        // 解析上游 SSE,转成前端易消费的精简事件
        const reader = upstream.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let ev;
            try {
              ev = JSON.parse(raw);
            } catch {
              continue;
            }
            if (ev.type === 'content_block_delta') {
              const d = ev.delta || {};
              if (d.type === 'text_delta' && d.text) {
                full += d.text;
                emit({ t: 'delta', v: d.text });
              } else if (d.type === 'thinking_delta' && d.thinking) {
                thinking += d.thinking;
                emit({ t: 'thinking', v: d.thinking });
              }
            } else if (ev.type === 'message_start' && ev.message && ev.message.usage) {
              const u = ev.message.usage;
              usage.input = u.input_tokens || 0;
              usage.cacheRead = u.cache_read_input_tokens || 0;
              usage.cacheWrite = u.cache_creation_input_tokens || 0;
            } else if (ev.type === 'message_delta' && ev.usage) {
              usage.output = ev.usage.output_tokens || usage.output;
            } else if (ev.type === 'error') {
              failed = (ev.error && ev.error.message) || '上游返回错误';
              emit({ t: 'error', message: failed });
            }
          }
        }
      }
    } catch (err) {
      if (clientGone) {
        log(`聊天流被用户中断(user=${me.name} device=${dev.name})`);
      } else {
        failed = err.message;
        emit({ t: 'error', message: '流中断: ' + err.message });
      }
    } finally {
      if (fwd.release) fwd.release();
    }

    // 记账:落到所选设备名下,用户在「我的设备」和管理台都能看到这笔
    if (fwd.record) {
      fwd.record({
        status: failed ? 502 : 200,
        usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
      });
    }

    // 持久化回复(哪怕被中断也把已生成的存下来,不然用户白等)
    if (full || thinking || failed) {
      session.messages.push({
        role: 'assistant',
        content: full,
        thinking: thinking || undefined,
        error: failed || undefined,
        stopped: clientGone || undefined,
        model: payload.model,
        usage,
        ts: Date.now(),
      });
      store.save(me.name, session);
    }

    emit({ t: 'usage', ...usage });
    emit({ t: 'done', sessionId: session.id, title: session.title, stopped: clientGone });
    res.end();
  }

  return { handle };
}
