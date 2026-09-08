// 网页聊天的 HTTP 层。挂在用户端下(/u/api/chat/*),鉴权沿用 user.js 的 session。
//
// 关键设计一:聊天不另开一条上游通路,而是以【用户绑定的某台设备】的身份走内部转发
// (server.js 注入的 forward)。这样一次性继承:参数下发、限流/并发、成本估算、
// 日志与统计 —— 用户在「我的设备」看到的用量就包含他在网页聊天里花掉的部分。
//
// 推论:管理员给该设备设了强制模型时,聊天的模型选择会被覆盖。这是对的语义
// (策略优先于偏好),前端会把选择器锁掉并说明原因。
//
// 关键设计二(见 chat_runs.js):一个回合由服务端持有,SSE 只是订阅者。
// 断线不等于放弃 —— 断开只是"没人在看",宽限期内生成继续,重连能续上;
// 只有显式 /stop 才取消上游。落盘在 runner 的 finally 里做,与订阅者无关。

import { inferModelMeta, contextWindowOf } from './models.js';

const DEFAULT_MAX_TOKENS = 8192;
const MAX_INPUT_CHARS = 200_000; // 单条输入上限,防误粘贴整本书
const TITLE_FROM_CHARS = 40;
// 上游偶发过载/限流时的重试。只在【一个字都还没收到】时重试 —— 已经吐了半段再重发
// 会让用户看到两遍开头,那比直接报错更糟。
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
const RETRY_BASE_MS = 800;
// 会话总字数低于这个量时不打缓存断点:缓存写要 1.25 倍价,短对话打了是净亏。
const CACHE_MIN_CHARS = 2000;
// pause_turn 最多续几轮。有上限是因为它理论上能无限续下去,
// 而一轮联网研究烧的是真额度。
const MAX_PAUSE_CONTINUES = 4;

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

// 上传接口的 body 上限。它是【兜底】,不是业务上限 —— 业务上限只有一个权威,
// 就是 chat_store 里那几个 MAX_*。
//
// 所以这里要比"合法载荷的最大值"再宽出一截:body 装的是 base64(膨胀 4/3),
// 而稍微超一点的文件应该由 store 去回那句精确的「图片超过 5MB 上限」,
// 而不是被传输层拿一句笼统的"太大"截胡。留 2 倍余量,离谱的体积才由这里挡下,
// 省得把几十 MB 收完再拒。
//
// (这两个数以前是各写各的:body 卡在 12MiB,MAX_PDF_BYTES 写着 20MiB,
//  于是 9MiB 以上的 PDF 谁也传不上去,界面还写着"PDF ≤ 20MB"。)
function uploadBodyLimit(maxContentBytes) {
  return Math.ceil(maxContentBytes * 2 * 4 / 3) + 64 * 1024;
}
function uploadErr(err, what) {
  if (err && err.tooLarge) return `${what}太大,超过了上传上限`;
  return `请求体无法解析(${what}损坏?)`;
}

function readJson(req, limitBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let n = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      n += c.length;
      if (n > limitBytes) {
        // 【不能 destroy】。掐掉连接时响应还没写出去,浏览器那头 fetch 抛的是
        // TypeError 而不是一个能读的状态码 —— 前端于是连"文件太大"都说不出口,
        // 表现成"拖进去完全没反应"。所以这里只是停止收集并把剩下的数据排掉,
        // 让路由把 413 正正经经写回去。
        over = true;
        chunks = [];
        const err = new Error('请求体过大');
        err.tooLarge = true;
        err.limitBytes = limitBytes;
        reject(err);
        req.resume();   // 继续排空,否则连接会因为背压卡住
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;   // 已经 reject 过了,这会儿只是把剩下的数据排完
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
//
// cacheBreak=true 时在最后一个 block 上打 cache_control:下一回合的前缀
// (= 这一整段历史)就能命中缓存。多轮长对话里这是最省的一处,而且不改变语义。
// 把附件列表摊平成 { texts, pdfs, images, notes }。
//
// 压缩包是个【容器】,API 那边没有对应的 block 类型,所以它必须在这里散开成
// 三类普通附件。包里的条目在上传时已经各自落盘拿了 id,这里只是按 kind 分流。
// notes 是"没能展开的部分"的说明 —— 不写进去的话,模型会以为它看到了整个包。
function flattenFiles(files) {
  const out = { texts: [], pdfs: [], images: [], notes: [] };
  for (const f of files) {
    if (!f) continue;
    if (f.kind === 'archive') {
      const label = f.name || '压缩包';
      for (const e of Array.isArray(f.entries) ? f.entries : []) {
        if (!e || !e.id) continue;
        if (e.kind === 'text') out.texts.push({ id: e.id, name: `${label} → ${e.path}` });
        else if (e.kind === 'pdf') out.pdfs.push({ id: e.id, name: `${label} → ${e.path}` });
        else if (e.kind === 'image') out.images.push({ id: e.id });
      }
      const sk = (Array.isArray(f.skipped) ? f.skipped : []).map((x) => x && x.path).filter(Boolean);
      if (sk.length) {
        out.notes.push(`压缩包 ${label} 内另有 ${sk.length} 个文件未展开(非文本/图片/PDF,或超出上限):\n${sk.join('、')}`);
      }
      if (f.truncated) out.notes.push(`压缩包 ${label} 内容超出单次请求上限,只展开了其中一部分。`);
      continue;
    }
    if (f.kind === 'text') out.texts.push({ id: f.id, name: f.name });
    else if (f.kind === 'pdf') out.pdfs.push({ id: f.id, name: f.name });
  }
  return out;
}

export function toAnthropicMessages(messages, loadImage, { cacheBreak = false, loadFile = null } = {}) {
  const out = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (m.error) continue; // 失败的回复不进上下文
    let text = String(m.content || '');
    const imgs = Array.isArray(m.images) ? m.images : [];
    const files = Array.isArray(m.files) ? m.files : [];

    // 压缩包在这里【摊平】成三类普通附件。用的还是同一批 id 与同一个 loadFile ——
    // 所以下面的逻辑不需要认识"压缩包"这回事,也不需要一种新的存储格式。
    const flat = flattenFiles(files);

    // 文本类附件不进 block,而是内联进正文 —— 模型对"带文件名的围栏块"
    // 理解得最好,而且这样它能被提示缓存覆盖到(document block 不行)。
    if (m.role === 'user' && (flat.texts.length || flat.notes.length) && loadFile) {
      const parts = [];
      for (const f of flat.texts) {
        const got = loadFile(f.id);
        if (!got) continue;
        const body = got.buf.toString('utf8');
        parts.push(`附件 ${f.name}:\n\n\u0060\u0060\u0060\n${body}\n\u0060\u0060\u0060`);
      }
      // 没展开的东西也要说出来:模型至少该知道包里还有什么,
      // 否则它会以为自己看到的就是全部
      parts.push(...flat.notes);
      if (parts.length) text = parts.join('\n\n') + (text.trim() ? '\n\n' + text : '');
    }

    const pdfs = m.role === 'user' && loadFile ? flat.pdfs : [];
    const allImgs = m.role === 'user' ? [...imgs, ...flat.images] : imgs;

    if (m.role === 'user' && (allImgs.length || pdfs.length)) {
      const blocks = [];
      // 顺序有讲究:document / image 必须排在文字块【前面】,这是 API 的要求
      for (const f of pdfs) {
        const got = loadFile(f.id);
        if (!got) continue;
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: got.buf.toString('base64') },
          title: f.name || undefined,
        });
      }
      for (const im of allImgs) {
        const got = loadImage(im.id);
        if (!got) continue;
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: got.mime, data: got.buf.toString('base64') },
        });
      }
      blocks.push({ type: 'text', text: text || (pdfs.length ? '看看这份文档' : '看看这张图') });
      out.push({ role: 'user', content: blocks });
      continue;
    }
    if (!text.trim()) continue;
    out.push({ role: m.role, content: text });
  }
  if (cacheBreak && out.length) {
    const last = out[out.length - 1];
    // 字符串内容要先摊成 block 才挂得上 cache_control
    if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
    const blocks = last.content;
    if (Array.isArray(blocks) && blocks.length) {
      blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
    }
  }
  return out;
}

// ── 联网:服务端工具 ──────────────────────────────────────────────────
// 这两个工具跑在 Anthropic 那边,不需要本地的 agent 循环 —— 声明一下,
// 模型自己去搜、结果直接回到同一条流里。这也是它能在"没有工具执行环境"的
// 转发代理里实现联网的原因。
//
// 用【基础版】web_search_20250305 而不是新版 20260209:后者的动态过滤在底层
// 走 code execution,实测这条订阅通路上会撞 too_many_requests。基础版稳定,
// 而且照样带引用。
const WEB_SEARCH_TOOL = 'web_search_20250305';
const WEB_FETCH_TOOL = 'web_fetch_20260209';
// 普通联网 vs 深度研究,差别就是搜几轮、准不准抓网页、想多深
const SEARCH_MAX_USES = 5;
const RESEARCH_MAX_USES = 12;
const RESEARCH_FETCH_USES = 12;
const RESEARCH_SYSTEM = `You are doing focused research. Work in this order:

1. Decompose the question into the specific facts you actually need.
2. Search for each one. Prefer primary sources (official docs, the project's own repo, the vendor's own pages) over summaries and SEO blogspam.
3. When a search result looks authoritative but the snippet is thin, fetch the page instead of guessing from the snippet.
4. Cross-check anything that matters against a second independent source. Say so when sources disagree.
5. Answer with what you found. Cite as you go. State plainly what you could NOT establish rather than filling the gap with plausible-sounding text.

Do not stop at the first result that seems to answer the question.`;

// 这一轮要带哪些工具。返回 null = 不带(纯对话,请求体保持原样)。
export function buildTools(mode) {
  if (mode === 'research') {
    return [
      { type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: RESEARCH_MAX_USES },
      { type: WEB_FETCH_TOOL, name: 'web_fetch', max_uses: RESEARCH_FETCH_USES, citations: { enabled: true } },
    ];
  }
  if (mode === 'search') {
    return [{ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: SEARCH_MAX_USES }];
  }
  return null;
}

// 会话里的字符总量 —— 决定要不要打缓存断点,也用于上下文占用的兜底估算
function charsOf(messages) {
  let n = 0;
  for (const m of messages || []) n += String(m.content || '').length + String(m.thinking || '').length;
  return n;
}

// 上下文占用:优先用上游给过的真实 usage(最后一条 assistant 的 input+cacheRead),
// 没有就按 3.2 字符/token 粗估。前端那个百分比只要"够准到能提醒你该开新对话",
// 拿真实数字当分子已经远好过纯估算。
// windowOf 是可选的解析器:优先问它(它背后是模型库里从上游拿到的
// max_input_tokens),问不出来才退回 contextWindowOf 的按 id 推断。
// 推断那条路不能删 —— inherit 模式下上游可能是另一台 cc-trans 或第三方中转,
// /v1/models 只回 id 和 display_name,真值根本拿不到。
export function contextUsage(session, model, windowOf) {
  const id = model || (session && session.model) || '';
  const real = typeof windowOf === 'function' ? Number(windowOf(id)) || 0 : 0;
  const window = real > 0 ? real : contextWindowOf(id);
  const msgs = (session && session.messages) || [];
  let used = 0;
  let source = 'estimate';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const u = msgs[i].usage;
    if (msgs[i].role === 'assistant' && u && (u.input || u.cacheRead)) {
      used = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0);
      source = 'measured';
      break;
    }
  }
  if (!used) used = Math.round(charsOf(msgs) / 3.2);
  return { used, window, percent: window ? Math.min(100, (used / window) * 100) : 0, source };
}

// AI 生成标题的提示词。照搬 cc-haha 的思路:限定 3~7 词、句首大写、只回 JSON,
// 并明确"不要回答这段对话" —— 少了最后这句,模型经常直接开始聊天。
const TITLE_SYSTEM = `Generate a concise title (3-7 words) that captures the main topic or goal of this conversation. The title must be clear enough that the user recognizes the conversation in a list.

Return only JSON with a single "title" field. Do not answer, continue, or summarize the conversation itself.

Good: {"title": "Fix login button on mobile"}
Good: {"title": "解释 CAP 定理"}
Bad (too vague): {"title": "Some questions"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond"}`;

// 标题跟着【用户第一句话】的语言,而不是回复的语言 —— 同样照搬 cc-haha:
// 用户用中文问、模型用英文答的情况下,列表里出现英文标题是不对的。
function titleLanguage(text) {
  const s = String(text || '');
  if (/[一-鿿]/.test(s)) return 'Chinese (Simplified)';
  if (/[぀-ヿ]/.test(s)) return 'Japanese';
  if (/[가-힯]/.test(s)) return 'Korean';
  if (/[Ѐ-ӿ]/.test(s)) return 'Russian';
  return null;
}

function cleanTitle(raw) {
  let s = String(raw || '').trim();
  // 模型有时会用 ```json 包一层
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const brace = s.indexOf('{');
  if (brace >= 0) {
    try {
      const j = JSON.parse(s.slice(brace, s.lastIndexOf('}') + 1));
      if (j && typeof j.title === 'string') s = j.title;
    } catch {
      /* 不是 JSON 就当纯文本用 */
    }
  }
  s = s.replace(/^["'“”『「]+|["'“”』」]+$/g, '').replace(/\s+/g, ' ').trim();
  // 带 markdown 结构的一律不要(标题栏里出现 ## 或 | 只会难看)
  if (/[#*`|>\n]/.test(s)) return '';
  if (s.length > 60) return '';
  return s;
}

export function createChat({ store, modelStore, tokenAdmin, tokenIdOf, forward, runs, config, skills = () => [], clientIp = null, log = () => {} }) {
  const autoTitle = config.chatAutoTitle !== false;
  const promptCache = config.chatPromptCache !== false;
  const maxRetries = Number.isFinite(Number(config.chatMaxRetries)) ? Math.max(0, Number(config.chatMaxRetries)) : 2;

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

  function allModels() {
    // modelStore.list() 返回 { fetchedAt, fromUpstream, models },不是裸数组
    return ((modelStore.list ? modelStore.list() : null) || {}).models || [];
  }

  // 模型库知道真值就用真值(它是从上游 /v1/models 的 max_input_tokens 存下来的)
  const ctxWindowFor = (id) =>
    (modelStore && typeof modelStore.contextWindowFor === 'function' && modelStore.contextWindowFor(id)) || 0;

  function modelChoices() {
    return allModels().map((m) => {
      const meta = m.tier ? m : { ...m, ...inferModelMeta(m.id) };
      return {
        id: m.id,
        tier: meta.tier,
        latest: !!m.latest,
        // 前端据此决定 effort / thinking 选择器出不出现、给哪些值
        effort: meta.effort,
        thinking: meta.thinking,
        contextWindow: ctxWindowFor(m.id) || contextWindowOf(m.id),
        supportsEffort: !/不支持/.test(String(meta.effort || '')),
        thinkingDisabledOk: !/不接受 disabled|只能省略/.test(String(meta.thinking || '')),
      };
    });
  }

  // 生成标题用的便宜模型。挑 haiku;没有就退到列表里最后一个(通常是最小的那个)。
  function titleModel() {
    const list = allModels().map((m) => m.id);
    return list.find((id) => /haiku/i.test(id)) || list[list.length - 1] || '';
  }

  const keyOf = (me, sessionId) => `${me.name}/${sessionId}`;

  // 技能有两个来源:
  //   team = 管理员在 config.json 配的,全站共享
  //   mine = 用户自己建的,存在他自己的目录里(按用户隔离,见 chat_store.listSkills)
  // 同 id 时【我的优先】—— 自己建的东西不该被全局配置悄悄盖掉。
  function allSkills(me) {
    const team = skills().map((k) => ({ ...k, scope: 'team' }));
    const mine = store.listSkills(me.name).map((k) => ({ ...k, scope: 'mine' }));
    const byId = new Map();
    for (const k of team) byId.set(k.id, k);
    for (const k of mine) byId.set(k.id, k);
    return [...byId.values()];
  }
  // 下发给前端的视图:不含提示词本体(前端不需要,也没必要把它摊在网络上)
  const skillView = (k) => ({ id: k.id, name: k.name, desc: k.desc, scope: k.scope });

  // ── 标题:先用第一句话截断顶上(立刻有个能认的名字),再异步换成 AI 生成的 ──
  function fallbackTitle(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_FROM_CHARS) || '新对话';
  }

  async function generateTitle(me, dev, session, origin = null) {
    if (!autoTitle || !dev) return;
    const model = titleModel();
    if (!model) return;
    const firstUser = (session.messages || []).find((m) => m.role === 'user');
    const firstReply = (session.messages || []).find((m) => m.role === 'assistant' && m.content);
    if (!firstUser) return;
    const lang = titleLanguage(firstUser.content);
    const transcript = [
      `User: ${String(firstUser.content || '').slice(0, 1200)}`,
      firstReply ? `Assistant: ${String(firstReply.content || '').slice(0, 800)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const payload = {
      model,
      max_tokens: 120,
      stream: false,
      system: TITLE_SYSTEM + (lang ? `\n\nThe title must be in ${lang}. Keep product names, file names and code identifiers as-is.` : ''),
      messages: [{ role: 'user', content: `<conversation>\n${transcript}\n</conversation>` }],
    };
    let fwd;
    try {
      fwd = await forward({ tokenEntry: dev, payload, signal: undefined, origin });
    } catch (err) {
      log(`[chat] 标题生成转发失败(不影响对话): ${err.message}`);
      return;
    }
    if (fwd.error) return;
    try {
      const raw = await fwd.res.text();
      if (!fwd.res.ok) return;
      const j = JSON.parse(raw);
      const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      const title = cleanTitle(text);
      if (fwd.record) {
        fwd.record({
          status: 200,
          usage: {
            input: (j.usage && j.usage.input_tokens) || 0,
            output: (j.usage && j.usage.output_tokens) || 0,
            cacheRead: (j.usage && j.usage.cache_read_input_tokens) || 0,
            cacheWrite: (j.usage && j.usage.cache_creation_input_tokens) || 0,
          },
        });
      }
      if (!title) return;
      // 重新读一遍:生成期间用户可能已经手动改名了,别把他的改动盖掉
      const fresh = store.get(me.name, session.id);
      if (!fresh || fresh.titleLocked) return;
      fresh.title = title;
      fresh.titleFrom = 'ai';
      store.save(me.name, fresh);
      log(`[chat] 会话 ${session.id} 标题已生成: ${title}`);
    } catch {
      /* 解析不出来就保留截断标题 —— 标题失败绝不该影响对话 */
    } finally {
      if (fwd.release) fwd.release();
    }
  }

  async function handle(sub, req, res, me) {
    // ── 会话列表 / 新建 ──
    if (sub === '/sessions' && req.method === 'GET') {
      if (!store.enabled) return sendJson(res, 200, { sessions: [], persisted: false, live: [] });
      return sendJson(res, 200, {
        sessions: store.list(me.name),
        persisted: true,
        stats: store.stats(me.name),
        // 哪些会话此刻正在生成 —— 前端据此在列表里点亮,并允许接回去
        live: runs ? runs.liveFor(me.name) : [],
      });
    }
    if (sub === '/sessions' && req.method === 'POST') {
      const b = await readJson(req).catch(() => ({}));
      const r = store.create(me.name, { title: b.title || '', model: b.model || '' });
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    // ── 单会话读 / 改名 / 删除 / 清空 / 置顶 ──
    if (sub === '/session' && req.method === 'GET') {
      const u = new URL(req.url, 'http://localhost');
      const id = u.searchParams.get('id');
      const s = store.get(me.name, id);
      if (!s) return sendJson(res, 404, { error: '会话不存在' });
      return sendJson(res, 200, {
        session: s,
        // 正在生成中?带上序号,前端拿它去 /attach 续传
        live: runs ? runs.live(keyOf(me, s.id)) : null,
        context: contextUsage(s, s.model, ctxWindowFor),
      });
    }
    if (sub === '/session/rename' && req.method === 'POST') {
      const b = await readJson(req).catch(() => ({}));
      const r = store.rename(me.name, b.id, b.title);
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (sub === '/session/pin' && req.method === 'POST') {
      const b = await readJson(req).catch(() => ({}));
      const r = store.setPinned(me.name, b.id, !!b.pinned);
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (sub === '/session/remove' && req.method === 'POST') {
      const b = await readJson(req).catch(() => ({}));
      // 正在生成的会话被删掉:先把回合掐掉,否则 runner 会往一个已经不存在的
      // 会话里落盘,把索引里刚删掉的那行又写回来
      if (runs) runs.stop(keyOf(me, b.id));
      const r = store.remove(me.name, b.id);
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (sub === '/sessions/clear' && req.method === 'POST') {
      if (runs) for (const l of runs.liveFor(me.name)) runs.stop(keyOf(me, l.sessionId));
      return sendJson(res, 200, store.clear(me.name));
    }

    // ── 分叉:从某条消息处另起一个会话(cc-haha 的 fork)──
    // 用途是"这个回答走偏了,我想从上一步换个问法再试,但原来那条别丢"。
    if (sub === '/session/fork' && req.method === 'POST') {
      const b = await readJson(req).catch(() => ({}));
      const src = store.get(me.name, b.id);
      if (!src) return sendJson(res, 404, { error: '会话不存在' });
      const upto = Number.isFinite(Number(b.upto)) ? Math.max(0, Math.min(src.messages.length, Number(b.upto) + 1)) : src.messages.length;
      const created = store.create(me.name, { title: src.title ? `${src.title}(分叉)`.slice(0, 80) : '', model: src.model });
      if (!created.ok) return sendJson(res, 400, created);
      const forked = created.session;
      forked.messages = src.messages.slice(0, upto).map((m) => ({ ...m }));
      forked.titleLocked = true; // 标题是从原会话继承来的,别让 AI 再覆盖一次
      forked.forkedFrom = { id: src.id, at: upto };
      store.save(me.name, forked);
      log(`[chat] 用户 ${me.name} 从 ${src.id} 第 ${upto} 条分叉出 ${forked.id}`);
      return sendJson(res, 200, { ok: true, session: forked });
    }

    // ── 截断:编辑某条用户消息时,先把它及之后的都砍掉,再重新发 ──
    if (sub === '/session/truncate' && req.method === 'POST') {
      const b = await readJson(req).catch(() => ({}));
      const s = store.get(me.name, b.id);
      if (!s) return sendJson(res, 404, { error: '会话不存在' });
      const i = Number(b.index);
      if (!Number.isFinite(i) || i < 0 || i >= s.messages.length) return sendJson(res, 400, { error: '消息下标越界' });
      s.messages = s.messages.slice(0, i);
      store.save(me.name, s);
      return sendJson(res, 200, { ok: true, session: s });
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
        // 聊天页据此决定「刷新模型列表」这一项出不出现。默认关(见 users.js),
        // 因为它改写的是全局共享的模型库
        canRefreshModels: !!(me.perms && me.perms.refreshModels),
        maxImageBytes: store.MAX_IMAGE_BYTES,
        maxArchiveBytes: store.MAX_ARCHIVE_BYTES,
        maxPdfBytes: store.MAX_PDF_BYTES,
        maxTextBytes: store.MAX_TEXT_BYTES,
        maxInputChars: MAX_INPUT_CHARS,
        // 联网能力(服务端工具,不需要本地 agent 循环)
        webSearch: true,
        research: true,
        // 技能:团队(管理员配的)+ 我的(自己建的,按用户隔离)
        skills: allSkills(me).map(skillView),
        maxOwnSkills: store.MAX_USER_SKILLS,
        persisted: store.enabled,
        // 断线宽限期:前端要把这句话说给用户听("关掉页面也没关系,X 分钟内回来还能接上")
        disconnectGraceMs: runs ? runs.graceMs : 0,
        autoTitle,
        maxRetries,
      });
    }

    // ── 图片上传 / 读取 ──
    //
    // 上传这两条路的 body 上限必须【从内容上限推出来】,不能另写一个数:
    // body 里装的是 base64(膨胀 4/3)再套一层 JSON。以前 body 卡在 12MiB 而
    // MAX_PDF_BYTES 写着 20MiB,于是 9MiB 以上的 PDF 全都传不上去,
    // 界面却还写着"PDF ≤ 20MB"—— 两个上限对不上,谁也没发现。
    if (sub === '/image' && req.method === 'POST') {
      const b = await readJson(req, uploadBodyLimit(store.MAX_IMAGE_BYTES)).catch((e) => e);
      if (b instanceof Error) return sendJson(res, b.tooLarge ? 413 : 400, { error: uploadErr(b, '图片') });
      const r = store.putImage(me.name, { data: b.data, mime: b.mime });
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    // 通用附件:图片 / PDF / 文本(代码)。图片仍走 /image 保持旧路径可用。
    if (sub === '/file' && req.method === 'POST') {
      const b = await readJson(req, uploadBodyLimit(store.MAX_PDF_BYTES)).catch((e) => e);
      if (b instanceof Error) return sendJson(res, b.tooLarge ? 413 : 400, { error: uploadErr(b, '文件') });
      const r = store.putFile(me.name, { data: b.data, mime: b.mime, name: b.name });
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    // 把附件原样取回(前端给 PDF/文本附件一个"下载/查看"入口)
    if (sub === '/file' && req.method === 'GET') {
      const u = new URL(req.url, 'http://localhost');
      const got = store.getFile(me.name, u.searchParams.get('id'));
      if (!got) {
        res.writeHead(404);
        return res.end();
      }
      const name = String(u.searchParams.get('name') || 'file').replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(0, 80);
      res.writeHead(200, {
        'content-type': got.ext === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8',
        'content-length': got.buf.length,
        // 内容寻址 → 可长缓存;private 免得被共享缓存看到别人的文件
        'cache-control': 'private, max-age=31536000, immutable',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      return res.end(got.buf);
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

    // ── 我的技能:自建的预设提示词 ──
    // 用户名一律取服务端 session 推出来的 me.name,绝不采信请求里的任何用户标识 ——
    // 这条是跨用户隔离的硬边界,和会话、日志、附件同一个规矩。
    if (sub === '/skills' && req.method === 'GET') {
      return sendJson(res, 200, {
        mine: store.listSkills(me.name),
        team: skills().map((k) => ({ id: k.id, name: k.name, desc: k.desc })),
        max: store.MAX_USER_SKILLS,
        persisted: store.enabled,
      });
    }
    if (sub === '/skills' && req.method === 'POST') {
      if (!store.enabled) return sendJson(res, 400, { ok: false, error: '未启用数据目录,自建技能无法保存' });
      const b = await readJson(req).catch(() => ({}));
      const r = store.saveSkills(me.name, b.skills);
      if (r.ok) log(`[chat] 用户 ${me.name} 更新了自己的技能库(${r.skills.length} 个)`);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    // ── 手动重新生成标题 ──
    if (sub === '/title' && req.method === 'POST') {
      const b = await readJson(req).catch(() => ({}));
      const s = store.get(me.name, b.id);
      if (!s) return sendJson(res, 404, { error: '会话不存在' });
      const dev = pickDevice(me, b.deviceId);
      if (!dev) return sendJson(res, 403, { error: '没有可用设备' });
      s.titleLocked = false;
      store.save(me.name, s);
      await generateTitle(me, dev, s, originOf(req));
      const fresh = store.get(me.name, s.id);
      return sendJson(res, 200, { ok: true, title: fresh ? fresh.title : s.title });
    }

    // ── 发消息(启动回合并订阅)──
    if (sub === '/stream' && req.method === 'POST') {
      return handleStream(req, res, me);
    }

    // ── 接回一个还在跑的回合(刷新页面 / 换设备 / 断网重连)──
    if (sub === '/attach' && req.method === 'GET') {
      if (!runs) return sendJson(res, 404, { error: '不支持续传' });
      const u = new URL(req.url, 'http://localhost');
      const sid = u.searchParams.get('sessionId');
      const from = Math.max(0, Number(u.searchParams.get('from')) || 0);
      if (!sid) return sendJson(res, 400, { error: '缺少 sessionId' });
      return attachStream(req, res, me, sid, from);
    }

    // ── 显式停止:这才是"不要了"(断开连接不算)──
    if (sub === '/stop' && req.method === 'POST') {
      if (!runs) return sendJson(res, 404, { error: '不支持' });
      const b = await readJson(req).catch(() => ({}));
      const r = runs.stop(keyOf(me, b.sessionId));
      log(`[chat] 用户 ${me.name} ${r.ok ? '停止了' : '尝试停止(无进行中回合)'}会话 ${b.sessionId}`);
      return sendJson(res, r.ok ? 200 : 404, r);
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  // SSE 响应头 + 一个把事件写出去的 sink。attach 与 stream 共用同一套。
  function openSse(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // 反向代理有时要看到点东西才肯把头刷出去
    res.write(': ok\n\n');
    let ended = false;
    return {
      send: (ev) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      },
      end: () => {
        if (ended) return;
        ended = true;
        if (!res.writableEnded) res.end();
      },
    };
  }

  function attachStream(req, res, me, sessionId, from) {
    const sink = openSse(res);
    const sub = runs.subscribe(keyOf(me, sessionId), from, sink);
    if (!sub.ok) {
      // 回合已经结束:不是错误 —— 让前端重新拉一次会话即可
      sink.send({ t: 'gone', reason: sub.error });
      return sink.end();
    }
    if (!sub.live) return; // subscribe 已经补完并收尾
    // 客户端走了只是"没人看",不取消上游 —— 宽限期由 registry 管
    res.on('close', () => sub.unsubscribe());
  }

  // 从请求里取一份【值快照】。绝不能把 req 本身往下传:一个回合能活过它的 HTTP
  // 请求(断线保活的宽限期默认 5 分钟),那时 req.socket 早已销毁,
  // 再去读 remoteAddress 只会拿到脏值或直接抛。
  function originOf(req) {
    return {
      ip: (typeof clientIp === 'function' ? clientIp(req) : '') || '',
      // 标出是网页聊天:设备行上"最近来源"otherwise 分不清是 Claude Code 还是网页
      ua: `cc-trans-web-chat (${String((req && req.headers && req.headers['user-agent']) || '未知').slice(0, 160)})`,
    };
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
    // 附件(PDF / 文本)。只留 id / kind / name —— 内容在 media/ 里,按 id 取,
    // 绝不采信请求里传来的正文(那等于让客户端往上下文里塞任意内容)。
    const files = (Array.isArray(b.files) ? b.files.slice(0, 8) : [])
      .filter((f) => f && f.id && ['pdf', 'text'].includes(f.kind))
      .map((f) => ({ id: String(f.id), kind: f.kind, name: String(f.name || '').slice(0, 120) }));
    if (!b.regenerate && !text.trim() && !images.length && !files.length) return sendJson(res, 400, { error: '内容为空' });
    if (text.length > MAX_INPUT_CHARS) return sendJson(res, 400, { error: `单条输入超过 ${MAX_INPUT_CHARS} 字符` });

    // 会话:没给 id 就新建
    let session = b.sessionId ? store.get(me.name, b.sessionId) : null;
    if (!session) {
      const created = store.create(me.name, { model: b.model || '' });
      if (!created.ok) return sendJson(res, 400, created);
      session = created.session;
    }

    // 同一个会话已经在生成了:不排队、不并发,明确告诉前端去接那一条
    if (runs) {
      const already = runs.live(keyOf(me, session.id));
      if (already) {
        return sendJson(res, 409, {
          error: '这个对话正在生成中',
          live: already,
          sessionId: session.id,
        });
      }
    }

    const firstTurn = !(session.messages || []).some((m) => m.role === 'assistant' && m.content);

    // regenerate:丢掉最后一条 assistant 回复,重发上一轮 user 消息
    if (b.regenerate) {
      while (session.messages.length && session.messages[session.messages.length - 1].role === 'assistant') {
        session.messages.pop();
      }
      if (!session.messages.length) return sendJson(res, 400, { error: '没有可重新生成的内容' });
    } else {
      session.messages.push({ role: 'user', content: text, images, files, ts: Date.now() });
      if (!session.title) {
        session.title = fallbackTitle(text);
        session.titleFrom = 'excerpt';
      }
    }
    if (b.model) session.model = b.model;
    store.save(me.name, session);

    const model = b.model || session.model || '';
    if (!model) return sendJson(res, 400, { error: '请选择模型' });

    const useCache = promptCache && charsOf(session.messages) >= CACHE_MIN_CHARS;
    const payload = {
      model,
      max_tokens: Math.min(64000, Math.max(256, Number(b.maxTokens) || DEFAULT_MAX_TOKENS)),
      stream: true,
      messages: toAnthropicMessages(session.messages, (id) => store.getImage(me.name, id), {
        cacheBreak: useCache,
        loadFile: (id) => store.getFile(me.name, id),
      }),
    };

    // 联网 / 深度研究:挂服务端工具(见 buildTools)
    const mode = ['search', 'research'].includes(b.mode) ? b.mode : '';
    const tools = buildTools(mode);
    if (tools) payload.tools = tools;

    const sys = [];
    // 选中的"技能" = 一段预设提示词,拼进 system。多选按选择顺序拼。
    const wantSkills = Array.isArray(b.skills) ? b.skills.slice(0, 5).map(String) : [];
    const pool = allSkills(me);
    const skillHits = wantSkills.map((id) => pool.find((k) => k.id === id)).filter(Boolean);
    for (const k of skillHits) sys.push(k.prompt);
    if (mode === 'research') sys.push(RESEARCH_SYSTEM);
    if (b.system) sys.push(String(b.system).slice(0, 20000));
    if (sys.length) payload.system = sys.join('\n\n');

    // display:'summarized' 不是可选项 —— 不传的话,Opus 4.7 以后的模型
    // 默认 display:'omitted',thinking 块照发但文本是【空的】,界面上就是
    // 一个永远没内容的"思考过程"。要给人看就必须显式要摘要。
    if (b.thinking === 'disabled') payload.thinking = { type: 'disabled' };
    else payload.thinking = { type: 'adaptive', display: 'summarized' };
    // 深度研究默认往深了想,除非用户自己指定了档位
    const effort = b.effort || (mode === 'research' ? 'high' : '');
    if (effort) payload.output_config = { effort: String(effort) };

    // 来源快照:【必须在这里取】。req 还活着的时候把值抄下来,
    // 之后整个回合都只带着这份快照走(见 originOf 的说明)。
    const origin = originOf(req);

    // 没有 registry(理论上不会发生)时退回"连接即生命周期"的老路,别整块功能罢工
    if (!runs) return legacyStream(req, res, me, { session, dev, payload, origin });

    const started = runs.start({
      key: keyOf(me, session.id),
      principal: me.name,
      sessionId: session.id,
      model,
      deviceName: dev.name,
      runner: (api) => runTurn(api, { me, dev, session, payload, firstTurn, mode, origin }),
    });
    if (!started.ok) {
      if (started.busy) return sendJson(res, 409, { error: '这个对话正在生成中', live: runs.live(keyOf(me, session.id)) });
      return sendJson(res, 429, { error: started.error });
    }

    const sink = openSse(res);
    sink.send({ t: 'start', runId: started.run.id, sessionId: session.id, title: session.title, model, n: 0 });
    const sub = runs.subscribe(keyOf(me, session.id), 0, sink);
    if (sub.ok && sub.live) res.on('close', () => sub.unsubscribe());
  }

  // 一个回合的实际执行:发上游、翻译 SSE、落盘、记账。
  // 注意它【不认识 res】—— 所有输出都经 api.emit 广播,谁在听是 registry 的事。
  async function runTurn(api, { me, dev, session, payload, firstTurn, mode = '', origin = null }) {
    const t0 = Date.now();
    let full = '';
    let thinking = '';
    let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let failed = null;
    let lastStatus = 200;
    // 联网这一轮用过的东西,要跟着消息一起落盘(刷新页面还看得到"它查了什么")
    const sources = [];
    const citations = [];
    const queries = [];
    let pausedTurn = false;
    const toolBlocks = new Map(); // content block index -> 正在拼的 server_tool_use

    let continued = 0;
    for (let attempt = 0; ; attempt++) {
      let fwd;
      try {
        fwd = await forward({ tokenEntry: dev, payload, signal: api.signal, origin });
      } catch (err) {
        failed = '转发失败: ' + err.message;
        lastStatus = 502;
        break;
      }
      if (fwd.error) {
        const status = fwd.error.status || 502;
        // 配额/权限类拒绝重试没有意义,直接报出来
        if (RETRYABLE.has(status) && attempt < maxRetries) {
          const delay = RETRY_BASE_MS * 2 ** attempt;
          api.emit({ t: 'retry', attempt: attempt + 1, max: maxRetries, delayMs: delay, status, message: fwd.error.message });
          await sleep(delay, api.signal);
          if (api.signal.aborted) break;
          continue;
        }
        failed = fwd.error.message || '被拒绝';
        lastStatus = status;
        break;
      }

      const upstream = fwd.res;
      let gotAnything = false;
      try {
        if (!upstream.ok) {
          const errText = await upstream.text().catch(() => '');
          // 一个字都还没收到才重试 —— 否则用户会看到重复的开头
          if (RETRYABLE.has(upstream.status) && attempt < maxRetries) {
            const delay = RETRY_BASE_MS * 2 ** attempt;
            api.emit({
              t: 'retry',
              attempt: attempt + 1,
              max: maxRetries,
              delayMs: delay,
              status: upstream.status,
              message: errText.slice(0, 200),
            });
            // 被重试掉的那一次也要记账:它确实打到了上游、确实是个错误。
            // 不记的话「错误数」曲线上看不出上游正在抽风,而那恰恰是最该看见的事。
            // (并发额度不用在这儿放 —— continue 会先走下面的 finally,那里放了。)
            if (fwd.record) fwd.record({ status: upstream.status, usage });
            await sleep(delay, api.signal);
            if (api.signal.aborted) break;
            continue;
          }
          failed = `上游 ${upstream.status}: ${errText.slice(0, 400)}`;
          lastStatus = upstream.status;
          api.emit({ t: 'error', message: failed, status: upstream.status });
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
              if (ev.type === 'content_block_start') {
                const cb = ev.content_block || {};
                // 服务端工具:模型开始搜网了。查询词在随后的 input_json_delta 里逐字拼出来,
                // 所以这里只记住"这个块是一次搜索",内容后面收。
                if (cb.type === 'server_tool_use') {
                  toolBlocks.set(ev.index, { name: cb.name || 'tool', json: '' });
                  api.emit({ t: 'tool_start', name: cb.name || 'tool' });
                } else if (cb.type === 'web_search_tool_result' || cb.type === 'web_fetch_tool_result') {
                  // 服务端工具的错误【不抛异常】:HTTP 200,content 从结果【列表】变成一个错误
                  // 【对象】。成功是数组、失败是对象,必须先分支再索引。
                  const c = cb.content;
                  if (Array.isArray(c)) {
                    const hits = c
                      .filter((x) => x && (x.type === 'web_search_result' || x.url))
                      .map((x) => ({ title: String(x.title || x.url || '').slice(0, 200), url: String(x.url || '') }));
                    sources.push(...hits);
                    api.emit({ t: 'tool_result', kind: 'search', results: hits });
                  } else if (c && typeof c === 'object') {
                    if (c.type === 'web_fetch_result' || c.url) {
                      const one = { title: String(c.title || c.url || '').slice(0, 200), url: String(c.url || '') };
                      sources.push(one);
                      api.emit({ t: 'tool_result', kind: 'fetch', results: [one] });
                    } else {
                      api.emit({ t: 'tool_result', kind: 'error', error: String(c.error_code || '失败') });
                    }
                  }
                }
              } else if (ev.type === 'content_block_delta') {
                const d = ev.delta || {};
                if (d.type === 'text_delta' && d.text) {
                  full += d.text;
                  gotAnything = true;
                  api.setText(full);
                  api.emit({ t: 'delta', v: d.text });
                } else if (d.type === 'thinking_delta' && d.thinking) {
                  thinking += d.thinking;
                  gotAnything = true;
                  api.setThinking(thinking);
                  api.emit({ t: 'thinking', v: d.thinking });
                } else if (d.type === 'input_json_delta') {
                  // 搜索的查询词。攒齐再发,免得前端看到半个 JSON
                  const tb = toolBlocks.get(ev.index);
                  if (tb) tb.json += d.partial_json || '';
                } else if (d.type === 'citations_delta' && d.citation) {
                  const c = d.citation;
                  const cite = { title: String(c.title || '').slice(0, 200), url: String(c.url || '') };
                  if (cite.url) {
                    citations.push(cite);
                    api.emit({ t: 'citation', ...cite });
                  }
                }
              } else if (ev.type === 'content_block_stop') {
                const tb = toolBlocks.get(ev.index);
                if (tb) {
                  toolBlocks.delete(ev.index);
                  let q = '';
                  try {
                    q = String((JSON.parse(tb.json || '{}') || {}).query || '');
                  } catch {
                    /* 拼不出完整 JSON 就不显示查询词,不影响结果 */
                  }
                  if (q) {
                    queries.push(q);
                    api.emit({ t: 'tool_query', name: tb.name, query: q });
                  }
                }
              } else if (ev.type === 'message_start' && ev.message && ev.message.usage) {
                const u = ev.message.usage;
                usage.input = u.input_tokens || 0;
                usage.cacheRead = u.cache_read_input_tokens || 0;
                usage.cacheWrite = u.cache_creation_input_tokens || 0;
                api.setUsage(usage);
              } else if (ev.type === 'message_delta') {
                if (ev.usage) {
                  usage.output = ev.usage.output_tokens || usage.output;
                  api.setUsage(usage);
                }
                // pause_turn:服务端工具跑久了,上游先把这一段收尾。这【不是】结束 ——
                // 不续一轮的话,联网搜索经常只出半句话就停了。
                if (ev.delta && ev.delta.stop_reason === 'pause_turn') pausedTurn = true;
              } else if (ev.type === 'error') {
                failed = (ev.error && ev.error.message) || '上游返回错误';
                api.emit({ t: 'error', message: failed });
              }
            }
          }
        }
      } catch (err) {
        if (api.signal.aborted) {
          // 用户点了停止 / 或者宽限期到了没人回来 —— 已经生成的部分照样保留
          log(
            `[chat] 回合中断(${api.stoppedByUser() ? '用户停止' : '断线超时'}) user=${me.name} device=${dev.name} 已生成 ${full.length} 字`,
          );
        } else if (!gotAnything && attempt < maxRetries) {
          const delay = RETRY_BASE_MS * 2 ** attempt;
          api.emit({ t: 'retry', attempt: attempt + 1, max: maxRetries, delayMs: delay, status: null, message: err.message });
          if (fwd.record) fwd.record({ status: 502, usage });
          await sleep(delay, api.signal);
          if (api.signal.aborted) break;
          continue;
        } else {
          failed = err.message;
          lastStatus = 502;
          api.emit({ t: 'error', message: '流中断: ' + err.message });
        }
      } finally {
        if (fwd.release) fwd.release();
      }

      // 记账:落到所选设备名下,用户在「我的设备」和管理台都能看到这笔
      if (fwd.record) {
        fwd.record({ status: failed ? lastStatus : 200, usage });
      }

      // pause_turn:上游把这一段先收尾了,活还没干完。把已生成的内容当成
      // assistant 的一轮回填进 messages,然后再发一次,模型接着往下做。
      // 联网搜索很容易触发这个 —— 不续的话用户看到的就是半句话。
      if (pausedTurn && !failed && !api.signal.aborted && continued < MAX_PAUSE_CONTINUES) {
        pausedTurn = false;
        continued++;
        api.emit({ t: 'continuing', round: continued, max: MAX_PAUSE_CONTINUES });
        payload.messages = [
          ...payload.messages,
          { role: 'assistant', content: full || '(正在检索)' },
          { role: 'user', content: '继续。' },
        ];
        attempt = -1; // 续一轮不算重试,把重试预算还回去
        continue;
      }
      break;
    }

    const stopped = api.stoppedByUser();
    const droppedOut = api.abortedByDisconnect();

    // 持久化回复(哪怕被中断也把已生成的存下来,不然用户白等)。
    // 重新读一遍会话:回合跑的这段时间里用户可能改了标题、或者别处动过。
    //
    // 读不到 = 这一轮还在跑的时候用户把会话删了。这时【绝不能】拿内存里那份
    // 写回去:那会把刚删掉的会话连同索引一起复活,用户眼前的删除按钮等于失效。
    const fresh = store.get(me.name, session.id);
    if (!fresh) {
      log(`[chat] 会话 ${session.id} 在生成期间已被删除,丢弃这一轮的回复(user=${me.name})`);
      api.emit({ t: 'done', sessionId: session.id, gone: true, stopped: api.stoppedByUser(), ms: Date.now() - t0 });
      return;
    }
    if (full || thinking || failed) {
      fresh.messages.push({
        role: 'assistant',
        content: full,
        thinking: thinking || undefined,
        error: failed || undefined,
        stopped: stopped || undefined,
        // 断线超时和"我点了停止"要能分开:前者不是用户的选择,界面上说法不一样
        disconnected: droppedOut || undefined,
        model: payload.model,
        usage,
        ms: Date.now() - t0,
        ts: Date.now(),
        // 联网这一轮查了什么、引了谁,跟消息一起存 —— 刷新页面后还看得到
        mode: mode || undefined,
        queries: queries.length ? queries.slice(0, 40) : undefined,
        sources: sources.length ? dedupeByUrl(sources).slice(0, 40) : undefined,
        citations: citations.length ? dedupeByUrl(citations).slice(0, 40) : undefined,
      });
      store.save(me.name, fresh);
    }

    api.emit({ t: 'usage', ...usage });
    api.emit({
      t: 'done',
      sessionId: fresh.id,
      title: fresh.title,
      stopped,
      disconnected: droppedOut,
      ms: Date.now() - t0,
      context: contextUsage(fresh, payload.model, ctxWindowFor),
    });

    // 第一回合说完了才生成标题(有了回复,标题才有内容可依据)。
    // 放在 done 之后:标题慢一秒没人在意,回答慢一秒人人都在意。
    if (firstTurn && full && !fresh.titleLocked) {
      await generateTitle(me, dev, fresh, origin);
      const after = store.get(me.name, fresh.id);
      if (after && after.title !== fresh.title) api.emit({ t: 'title', title: after.title, sessionId: after.id });
    }
  }

  // 没有 registry 时的退化路径:连接断开即取消(改造前的语义)
  async function legacyStream(req, res, me, { session, dev, payload, origin = null }) {
    const sink = openSse(res);
    sink.send({ t: 'start', sessionId: session.id, title: session.title, model: payload.model });
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const api = {
      emit: (ev) => sink.send(ev),
      signal: ac.signal,
      setText: () => {},
      setThinking: () => {},
      setUsage: () => {},
      stoppedByUser: () => ac.signal.aborted,
      abortedByDisconnect: () => false,
    };
    try {
      await runTurn(api, { me, dev, session, payload, firstTurn: false, origin });
    } finally {
      sink.end();
    }
  }

  return { handle, contextUsage };
}

// 同一个 url 只留一条:一轮搜索里同一个页面常被多次命中/引用
function dedupeByUrl(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (!x || !x.url || seen.has(x.url)) continue;
    seen.add(x.url);
    out.push(x);
  }
  return out;
}

// 可被 abort 打断的等待。重试的退避不能是个死等 —— 用户点停止时要立刻响应。
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}
