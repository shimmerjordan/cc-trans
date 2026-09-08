// 网页聊天的持久化:会话在服务端,不在 localStorage —— "我的对话跟着账号走",
// 换浏览器还在,清缓存也不丢。
//
// 布局:
//   <dataDir>/chats/<user>/index.json          会话索引(标题/时间/条数)
//   <dataDir>/chats/<user>/<sessionId>.json    单个会话的完整消息
//   <dataDir>/chats/<user>/media/<sha256>.<ext> 上传的图片(按内容寻址,天然去重)
//
// 用户名会进路径,所以每一处都必须过 safeSeg():'../' 这类穿越要在这里死掉,
// 不能指望上层记得校验。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { detectArchive, readArchive } from './archive.js';

// 这三个上限是【磁盘保护】,不是额度:超了删最旧的,不会拒绝请求,也不区分管理员
// (谁的对话都一样占盘)。默认值只是"自用服务的合理默认",可在 config.json 调,
// 0 = 不限(愿意自己盯着磁盘就随意)。
const DEFAULT_MAX_SESSIONS = 200; // 每用户会话上限,超了删最旧
const DEFAULT_MAX_MESSAGES = 500; // 每会话消息上限,超了删最早
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// PDF 走 document block 直接进上下文。上游整个请求上限 32MB(base64 后会胀 ~33%),
// 所以原文卡在 20MB —— 再大就不是"附一份文档"而是该先切分了。
const MAX_PDF_BYTES = 20 * 1024 * 1024;
// 文本类文件是内联进消息正文的,受 token 而不是磁盘约束。1MB 已经约 25 万 token,
// 远超任何模型的窗口,再大只会让请求直接被拒。
const MAX_TEXT_BYTES = 1024 * 1024;
// 压缩包本身的上限。解出来的【总量】另有上限:上游整个请求卡在 32MB,
// 所以展开后能带走多少由 MAX_ARCHIVE_EXPAND 说了算,而不是这个数。
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_EXPAND = 24 * 1024 * 1024;
// 孤儿图片的宽限期:刚上传还没发送的图按引用判定就是孤儿,清扫必须绕开它们
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;
// 模型只认这四种(Anthropic Messages API 的 image block 就这四个 media_type),
// 所以能收下的图片种类由它决定,不是由我们想支持什么决定。
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

// 从【内容】认图片格式。返回 ext,认不出来返回 null。
//
// 这是权威,声明的 mime 不是:浏览器的 file.type 是按扩展名给的,一张 JPEG
// 改名成 .png,file.type 就是 image/png。这不是攻击,是日常(截图工具、
// 相册转存、微信导出都会这样)。以前拿声明去【核对】内容、对不上就拒,
// 于是用户传一张看得见的图却被告知"类型不符",完全不知道该怎么办。
// 改成拿内容去【识别】类型:认得出来就收,并按真实类型存。
export function sniffImageExt(buf) {
  const b = buf;
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

// 认得出是【什么】但模型收不了的图片格式。单独认出来,是为了能给一句
// 说得清怎么办的话("HEIC 请先转成 JPEG"),而不是笼统的"不支持"。
export function sniffUnsupportedImage(buf) {
  const b = buf;
  if (!b || b.length < 12) return null;
  if (b.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = b.slice(8, 12).toString('ascii');
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'AVIF';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('hevc') || brand.startsWith('mif1')) return 'HEIC';
  }
  if (b[0] === 0x42 && b[1] === 0x4d) return 'BMP';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00)) return 'TIFF';
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'ICO';
  return null;
}

// 非图片附件。三类走三条完全不同的路,所以类型判定必须在存的时候就定下来:
//   image → image block(base64)
//   pdf   → document block(base64),放在文字块【前面】,这是 API 要求的顺序
//   text  → 不进 block,发送时内联进消息正文(带文件名的围栏代码块)
const PDF_MIME = 'application/pdf';
// 文本类:按【扩展名】认,不认 mime。浏览器给 .ts / .py / .go 的 mime 五花八门
// (video/mp2t、text/x-python、空串都见过),扩展名反而是稳定的那个。
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'ini', 'env',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h',
  'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'html', 'css', 'scss', 'xml', 'svg',
  'vue', 'svelte', 'dart', 'lua', 'r', 'jl', 'diff', 'patch', 'gitignore', 'dockerfile', 'makefile',
]);

function extOf(name) {
  const s = String(name || '').toLowerCase();
  // Dockerfile / Makefile 这类没有扩展名的,用整个文件名当扩展名去比
  const base = s.split('/').pop().split('\\').pop();
  if (!base.includes('.')) return base;
  return base.split('.').pop();
}

// 这个附件属于哪一类。返回 null = 不支持。
export function kindOf(mime, name) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (MIME_EXT[m]) return 'image';
  if (m === PDF_MIME || extOf(name) === 'pdf') return 'pdf';
  if (TEXT_EXT.has(extOf(name))) return 'text';
  // mime 说自己是纯文本、扩展名又不认识时仍然按文本收(比如没有扩展名的配置文件)
  if (m.startsWith('text/')) return 'text';
  return null;
}

// "不支持这种文件"太笼统 —— 用户不知道是格式问题还是坏了。能认出来是什么的,
// 就说出来,并说清该怎么办。
const ARCHIVE_SIGS = [
  { name: 'ZIP', test: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },
  { name: 'GZIP', test: (b) => b[0] === 0x1f && b[1] === 0x8b },
  { name: 'RAR', test: (b) => b.slice(0, 4).toString('ascii') === 'Rar!' },
  { name: '7z', test: (b) => b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf },
  { name: 'BZIP2', test: (b) => b.slice(0, 3).toString('ascii') === 'BZh' },
  { name: 'XZ', test: (b) => b[0] === 0xfd && b.slice(1, 4).toString('ascii') === '7zX' },
  { name: 'TAR', test: (b) => b.length > 262 && b.slice(257, 262).toString('ascii') === 'ustar' },
];
export function describeUnsupported(buf, name, mime) {
  const who = String(name || mime || '这个文件');
  const badImg = sniffUnsupportedImage(buf);
  if (badImg) return `${badImg} 格式模型读不了,请先转成 JPEG 或 PNG 再传`;
  const arc = ARCHIVE_SIGS.find((a) => a.test(buf));
  if (arc) return `${arc.name} 压缩包暂不支持,请解压后把里面的文件传进来`;
  return `不支持这种文件(${who})—— 可传图片(PNG/JPEG/WebP/GIF)、PDF,或文本/代码文件`;
}

// 包里一个条目到底是什么。和上传单个文件同一条规则:【内容说了算】。
export function classifyEntry(buf) {
  if (!buf || !buf.length) return null;
  if (sniffImageExt(buf)) return 'image';
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  // 文本的判据是"能无损往返 UTF-8 且不含 NUL" —— 二进制混进正文只会变成
  // 一大片乱码,白烧一次额度才发现
  const text = buf.toString('utf8');
  if (Buffer.from(text, 'utf8').length === buf.length && !text.includes('\u0000')) return 'text';
  return null;
}

// 只允许安全的单段路径片段。这是防路径穿越的唯一关口。
function safeSeg(s) {
  const v = String(s == null ? '' : s);
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(v)) return null;
  if (v === '.' || v === '..') return null;
  return v;
}

export function newSessionId() {
  return crypto.randomBytes(9).toString('base64url'); // 12 字符,URL 安全
}

// 上限值归一:非法/缺省用默认,显式 0(或负数)= 不限
function capOf(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return n > 0 ? Math.floor(n) : 0;
}

export function createChatStore({ dir, maxSessions, maxMessages, log = () => {} } = {}) {
  const enabled = !!dir;
  const MAX_SESSIONS = capOf(maxSessions, DEFAULT_MAX_SESSIONS);
  const MAX_MESSAGES = capOf(maxMessages, DEFAULT_MAX_MESSAGES);

  function userDir(user) {
    const seg = safeSeg(user);
    if (!seg || !enabled) return null;
    return path.join(dir, seg);
  }
  function sessionFile(user, id) {
    const ud = userDir(user);
    const sid = safeSeg(id);
    if (!ud || !sid) return null;
    return path.join(ud, sid + '.json');
  }
  function indexFile(user) {
    const ud = userDir(user);
    return ud ? path.join(ud, 'index.json') : null;
  }
  function mediaDir(user) {
    const ud = userDir(user);
    return ud ? path.join(ud, 'media') : null;
  }

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }
  function writeJsonAtomic(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // ── 索引 ──
  function loadIndex(user) {
    const f = indexFile(user);
    if (!f) return [];
    const j = readJson(f, { sessions: [] });
    return Array.isArray(j.sessions) ? j.sessions : [];
  }
  function saveIndex(user, sessions) {
    const f = indexFile(user);
    if (!f) return;
    writeJsonAtomic(f, { version: 1, sessions });
  }

  // 置顶的排前面,其余按最近更新。置顶是"我还要回来看这条"的显式标记,
  // 它必须压过时间序 —— 否则聊几句别的就被挤下去了,等于没置顶。
  function list(user) {
    return loadIndex(user)
      .slice()
      .sort((a, b) => {
        if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
  }

  function create(user, { title = '', model = '' } = {}) {
    if (!enabled) return { ok: false, error: '未启用数据目录,无法保存会话' };
    const ud = userDir(user);
    if (!ud) return { ok: false, error: '非法用户名' };
    const id = newSessionId();
    const now = Date.now();
    const session = { id, title: String(title || '').slice(0, 80), model, createdAt: now, updatedAt: now, messages: [] };
    const f = sessionFile(user, id);
    writeJsonAtomic(f, session);
    const idx = loadIndex(user);
    idx.push({ id, title: session.title, createdAt: now, updatedAt: now, messages: 0, model });
    // 超上限:删最旧的会话文件与索引项(MAX_SESSIONS=0 表示不限,循环直接不进)
    idx.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const doomed = new Set();
    while (MAX_SESSIONS > 0 && idx.length > MAX_SESSIONS) {
      const drop = idx.pop();
      const df = sessionFile(user, drop.id);
      if (df) {
        for (const im of imageIdsOf(get(user, drop.id))) doomed.add(im);
        try {
          fs.unlinkSync(df);
        } catch {
          /* 文件可能已不在 */
        }
      }
      log(`会话超上限,已删除最旧会话 ${drop.id}(user=${user})`);
    }
    saveIndex(user, idx);
    // 索引写回后再清扫:referencedImages 是照着索引读的,顺序反了会误判仍在引用
    if (doomed.size) dropUnreferenced(user, doomed);
    return { ok: true, session };
  }

  function get(user, id) {
    const f = sessionFile(user, id);
    if (!f || !fs.existsSync(f)) return null;
    const s = readJson(f, null);
    if (!s || s.id !== safeSeg(id)) return null;
    return s;
  }

  // touch=false:只落盘,不动 updatedAt。
  // updatedAt 的语义是【最后说话的时间】,不是"最后被碰过的时间" —— 改名或置顶
  // 也去刷新它,会让一个三周前的对话因为改了个标题就跳到列表的「今天」里,
  // 而排序恰恰是列表唯一的导航方式。
  function save(user, session, { touch = true } = {}) {
    const f = sessionFile(user, session && session.id);
    if (!f) return { ok: false, error: '非法会话 id' };
    // 消息超上限:丢最早的(保留完整的一问一答对不做特别处理,简单可预期);0 = 不限
    if (MAX_MESSAGES > 0 && Array.isArray(session.messages) && session.messages.length > MAX_MESSAGES) {
      session.messages = session.messages.slice(-MAX_MESSAGES);
    }
    if (touch || !session.updatedAt) session.updatedAt = Date.now();
    writeJsonAtomic(f, session);
    const idx = loadIndex(user);
    const row = idx.find((x) => x.id === session.id);
    const meta = {
      id: session.id,
      title: session.title || '',
      createdAt: session.createdAt || session.updatedAt,
      updatedAt: session.updatedAt,
      messages: (session.messages || []).length,
      model: session.model || '',
      pinned: !!session.pinned,
      // 'excerpt' = 第一句话截断,'ai' = 模型生成,'manual' = 用户手改。
      // 前端据此决定要不要显示「重新生成标题」,也让 AI 不去覆盖手改的标题。
      titleFrom: session.titleFrom || '',
      // 摘要:列表里第二行显示最后说了什么,不用把整个会话读进来
      preview: previewOf(session),
    };
    if (row) Object.assign(row, meta);
    else idx.push(meta);
    saveIndex(user, idx);
    return { ok: true };
  }

  function remove(user, id) {
    const f = sessionFile(user, id);
    if (!f) return { ok: false, error: '非法会话 id' };
    // 先记下这个会话引用了哪些图片,删完再看还有没有别人引用 —— 图片是按内容寻址、
    // 多个会话可能共享同一张,不能跟着会话无脑删。
    const doomed = imageIdsOf(get(user, id));
    try {
      fs.unlinkSync(f);
    } catch {
      /* 已经不在也算成功 */
    }
    saveIndex(user, loadIndex(user).filter((x) => x.id !== safeSeg(id)));
    if (doomed.size) dropUnreferenced(user, doomed);
    return { ok: true };
  }

  // 手改的标题打上 manual + titleLocked:AI 生成的那一路必须绕开它,
  // 不然用户刚起好的名字过两秒被模型改掉,这种"自己会动的界面"最劝退。
  function rename(user, id, title) {
    const s = get(user, id);
    if (!s) return { ok: false, error: '会话不存在' };
    s.title = String(title || '').slice(0, 80);
    s.titleFrom = 'manual';
    s.titleLocked = true;
    return save(user, s, { touch: false });
  }

  function setPinned(user, id, pinned) {
    const s = get(user, id);
    if (!s) return { ok: false, error: '会话不存在' };
    s.pinned = !!pinned;
    return save(user, s, { touch: false });
  }

  // 列表第二行的摘要。取最后一条有正文的消息 —— 「你刚才聊到哪儿了」比
  // 「这个会话开头是什么」更有用。markdown 记号在这一行只是噪音,剥掉。
  function previewOf(session) {
    const msgs = (session && session.messages) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const raw = String(msgs[i].content || '');
      if (!raw.trim()) continue;
      const flat = raw
        .replace(/```[\s\S]*?```/g, ' [代码] ')
        .replace(/!\[[^\]]*]\([^)]*\)/g, ' [图片] ')
        .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
        .replace(/[`*_>#~|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!flat) continue;
      const who = msgs[i].role === 'assistant' ? '' : '你:';
      return (who + flat).slice(0, 120);
    }
    return '';
  }

  function clear(user) {
    const ud = userDir(user);
    if (!ud) return { ok: false, error: '非法用户名' };
    for (const row of loadIndex(user)) {
      const f = sessionFile(user, row.id);
      if (f) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
    }
    saveIndex(user, []);
    // 一条会话都不剩了,整个 media 目录必然全是孤儿,直接端掉(比逐个比对便宜)
    const md = mediaDir(user);
    if (md) {
      try {
        fs.rmSync(md, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return { ok: true };
  }

  // ── 图片的引用清扫 ──
  // 图片按内容寻址存在 media/,消息里只存文件名。会话删了图片不会自动消失,
  // 所以每个删会话的入口都得回头看一眼:这张图还有别人引用吗?
  // 附件的引用清扫。images 与 files 共用 media/ 这一个目录,所以两边都要数进来 ——
  // 只数 images 的话,PDF/文本附件会在删掉会话之后永远留在盘上。
  function imageIdsOf(session) {
    const out = new Set();
    for (const m of (session && session.messages) || []) {
      for (const im of m.images || []) if (im && im.id) out.add(String(im.id));
      for (const f of m.files || []) if (f && f.id) out.add(String(f.id));
    }
    return out;
  }

  // 列出该用户所有会话仍在引用的图片名
  function referencedImages(user) {
    const ref = new Set();
    for (const row of loadIndex(user)) {
      for (const id of imageIdsOf(get(user, row.id))) ref.add(id);
    }
    return ref;
  }

  // 删掉 candidates 里已经没人引用的图片
  function dropUnreferenced(user, candidates) {
    const md = mediaDir(user);
    if (!md) return { removed: 0, bytes: 0 };
    const ref = referencedImages(user);
    let removed = 0;
    let bytes = 0;
    for (const id of candidates) {
      if (ref.has(id)) continue;
      const seg = safeSeg(id);
      if (!seg) continue;
      const f = path.join(md, seg);
      try {
        bytes += fs.statSync(f).size;
        fs.unlinkSync(f);
        removed++;
      } catch {
        /* 已经不在 */
      }
    }
    return { removed, bytes };
  }

  // 全量清扫:把 media/ 里所有没被任何会话引用的图片删掉。
  // 用于清理历史遗留(引用清扫是后加的,之前删会话留下的孤儿还在盘上)。
  //
  // 宽限期不是保守起见,是必需的:用户在输入框贴了图、还没点发送时,那张图
  // 【已经落盘但尚未被任何消息引用】—— 按引用判定它就是孤儿。这时清扫会把它删掉,
  // 用户一发送就报错。所以只动"躺了足够久"的。
  // dryRun 给统计面板用:面板显示的可清理数量必须和真清理的数量一致,
  // 所以两边走同一段判定,而不是各写一套。
  function sweepOrphanMedia(user, { dryRun = false, minAgeMs = ORPHAN_GRACE_MS } = {}) {
    const md = mediaDir(user);
    if (!md) return { ok: false, error: '非法用户名', scanned: 0, removed: 0, bytes: 0, skippedRecent: 0 };
    let names = [];
    try {
      names = fs.readdirSync(md);
    } catch {
      return { ok: true, scanned: 0, removed: 0, bytes: 0, skippedRecent: 0 }; // 目录还不存在
    }
    const cutoff = Date.now() - Math.max(0, minAgeMs);
    const ref = referencedImages(user);
    let removed = 0;
    let bytes = 0;
    let skippedRecent = 0;
    for (const n of names) {
      if (ref.has(n)) continue;
      const seg = safeSeg(n);
      if (!seg) continue;
      const f = path.join(md, seg);
      let st;
      try {
        st = fs.statSync(f);
      } catch {
        continue;
      }
      if (st.mtimeMs > cutoff) {
        skippedRecent++; // 可能是正在编辑、还没发送的那张
        continue;
      }
      if (!dryRun) {
        try {
          fs.unlinkSync(f);
        } catch {
          continue;
        }
      }
      removed++;
      bytes += st.size;
    }
    return { ok: true, scanned: names.length, removed, bytes, skippedRecent };
  }

  // 数据目录下有哪些用户的聊天数据(storage.js 汇总用;目录结构归本模块管)
  function listUsers() {
    if (!enabled) return [];
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && safeSeg(e.name))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  // ── 图片 ──
  // 按内容寻址:同一张图重复上传只占一份。
  function putImage(user, { data, mime }) {
    const md = mediaDir(user);
    if (!md) return { ok: false, error: '非法用户名或未启用数据目录' };
    let buf;
    try {
      buf = Buffer.from(String(data || ''), 'base64');
    } catch {
      return { ok: false, error: '图片数据无法解析' };
    }
    if (!buf.length) return { ok: false, error: '图片为空' };
    // 体积先判:比嗅探便宜,而且"太大了"永远比"认不出格式"更贴近用户要做的事
    if (buf.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: `图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限` };
    }
    // 类型由【内容】说了算 —— 声明的 mime 只在内容认不出来时用来措辞
    const ext = sniffImageExt(buf);
    if (!ext) {
      const named = sniffUnsupportedImage(buf);
      if (named) {
        return { ok: false, error: `${named} 格式模型读不了,请先转成 JPEG 或 PNG 再传` };
      }
      return {
        ok: false,
        error: MIME_EXT[String(mime || '').toLowerCase()]
          ? '这个文件不是能识别的图片(内容已损坏?)—— 支持 PNG / JPEG / WebP / GIF'
          : '只支持 PNG / JPEG / WebP / GIF',
      };
    }
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
    const name = `${hash}.${ext}`;
    const file = path.join(md, name);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(md, { recursive: true });
      fs.writeFileSync(file, buf, { mode: 0o600 });
    }
    // 回真实类型,不是声明的:它会原样进 API 的 image block media_type,
    // 存错了等于让上游去拒
    return { ok: true, id: name, mime: EXT_MIME[ext], bytes: buf.length };
  }

  // ── 用户自己的技能(预设提示词)────────────────────────────────
  // 存在 <dataDir>/chats/<user>/skills.json —— 跟会话同一个按用户分的目录,
  // 于是【隔离是目录级的】:路径由 safeSeg(user) 推出,读写都进不了别人的目录。
  // 管理员那份(config.skills)是全站共享的"团队技能",两者在界面上分开列。
  const MAX_USER_SKILLS = 20;
  function skillsFile(user) {
    const ud = userDir(user);
    return ud ? path.join(ud, 'skills.json') : null;
  }
  function listSkills(user) {
    const f = skillsFile(user);
    if (!f) return [];
    const j = readJson(f, { skills: [] });
    return Array.isArray(j.skills) ? j.skills : [];
  }
  // 整份覆盖写。校验放在这里而不是 HTTP 层:将来多一个入口也走同一道关。
  function saveSkills(user, list) {
    const f = skillsFile(user);
    if (!f) return { ok: false, error: '非法用户名或未启用数据目录' };
    if (!Array.isArray(list)) return { ok: false, error: '格式不对' };
    if (list.length > MAX_USER_SKILLS) return { ok: false, error: `自己的技能最多 ${MAX_USER_SKILLS} 个` };
    const seen = new Set();
    const clean = [];
    for (const k of list) {
      const id = String((k && k.id) || '').trim().slice(0, 40);
      const name = String((k && k.name) || '').trim().slice(0, 60);
      const prompt = String((k && k.prompt) || '').trim().slice(0, 20000);
      if (!id || !name || !prompt) return { ok: false, error: '每个技能都要有 id、名称和提示词' };
      if (!/^[a-zA-Z0-9._-]{1,40}$/.test(id)) return { ok: false, error: `id "${id}" 只能用字母数字与 . _ -` };
      if (seen.has(id)) return { ok: false, error: `id "${id}" 重复了` };
      seen.add(id);
      clean.push({ id, name, desc: String((k && k.desc) || '').trim().slice(0, 200), prompt });
    }
    writeJsonAtomic(f, { version: 1, skills: clean });
    return { ok: true, skills: clean };
  }

  // ── 压缩包 ────────────────────────────────────────────────
  //
  // 思路:【不引入新的存储格式】。包里每个条目按现有方式内容寻址落盘、各拿一个 id,
  // 条目清单直接跟着消息记录走(消息本来就是 JSON)。于是发送时
  // toAnthropicMessages 用的还是同一个 loadFile/loadImage,不需要认识"清单文件"。
  function putArchive(user, { buf, name, format }) {
    const md = mediaDir(user);
    if (!md) return { ok: false, error: '非法用户名或未启用数据目录' };
    if (buf.length > MAX_ARCHIVE_BYTES) {
      return { ok: false, error: `压缩包超过 ${Math.round(MAX_ARCHIVE_BYTES / 1048576)}MB 上限` };
    }
    const r = readArchive(buf, { name, maxTotalBytes: MAX_ARCHIVE_EXPAND });
    if (!r.ok) return { ok: false, error: r.error };

    fs.mkdirSync(md, { recursive: true });
    const entries = [];
    const skipped = [...(r.skipped || [])];
    for (const e of r.entries) {
      const kind = classifyEntry(e.data);
      if (!kind) { skipped.push({ path: e.path, why: '不是文本/图片/PDF,未展开' }); continue; }
      // 单条目也受各自类型的上限约束 —— 包里塞一个 50MB 的 PDF 同样送不进上游
      const cap = kind === 'image' ? MAX_IMAGE_BYTES : kind === 'pdf' ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
      if (e.data.length > cap) { skipped.push({ path: e.path, why: `超过 ${Math.round(cap / 1048576) || 1}MB 上限,未展开` }); continue; }
      const ext = kind === 'image' ? sniffImageExt(e.data) : kind === 'pdf' ? 'pdf' : 'txt';
      const id = writeMedia(md, e.data, ext);
      entries.push({ path: e.path, kind, id, bytes: e.data.length });
    }
    if (!entries.length && !skipped.length) return { ok: false, error: '这个压缩包是空的' };

    // 原包也存一份,「下载」还能拿回原文件
    const selfExt = format === 'zip' ? 'zip' : format === 'tgz' ? 'tgz' : format === 'gz' ? 'gz' : 'tar';
    const id = writeMedia(md, buf, selfExt);
    const clean = String(name || '').split(/[\\/]/).pop().slice(0, 120) || '压缩包';
    return {
      ok: true, id, kind: 'archive', name: clean,
      mime: 'application/zip', bytes: buf.length,
      format, entries, skipped, truncated: !!r.truncated,
    };
  }

  // 内容寻址写盘。三处(图片/文件/压缩包条目)共用,免得哈希与命名规则各写一遍。
  function writeMedia(md, buf, ext) {
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
    const id = `${hash}.${ext}`;
    const file = path.join(md, id);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf, { mode: 0o600 });
    return id;
  }

  // 通用附件入口。图片仍走 putImage(保持旧路径可用),PDF 与文本走这里。
  // 三类共用同一个内容寻址的 media/ 目录,但发送时走三条不同的路 —— 见 kindOf()。
  function putFile(user, { data, mime, name }) {
    const md = mediaDir(user);
    if (!md) return { ok: false, error: '非法用户名或未启用数据目录' };
    let buf;
    try {
      buf = Buffer.from(String(data || ''), 'base64');
    } catch {
      return { ok: false, error: '文件数据无法解析' };
    }
    if (!buf.length) return { ok: false, error: '文件是空的' };

    // 压缩包先认:它是个容器,里面的东西才是要送进对话的内容
    const det = detectArchive(buf, name);
    if (det.format) return putArchive(user, { buf, name, format: det.format });
    if (det.unsupported) {
      return { ok: false, error: `${det.unsupported} 压缩包需要外部解压工具,暂不支持 —— 请解压后把里面的文件传进来` };
    }
    // Office 文档不走压缩包这条路(它确实是 ZIP,但展开只会吐一堆 XML),
    // 落到下面按普通文件处理,由 kindOf 去判 —— 认不出来就照常报"不支持"

    let kind = kindOf(mime, name);
    // 名字和 mime 都看不出来时,问内容 —— 没扩展名的照片、被改过名的截图
    // 都走这条路(同一条"内容是权威"的规则)
    if (!kind && sniffImageExt(buf)) kind = 'image';
    if (!kind) return { ok: false, error: describeUnsupported(buf, name, mime) };
    if (kind === 'image') return putImage(user, { data, mime });

    const clean = String(name || '').split(/[\\/]/).pop().slice(0, 120) || '未命名';
    if (kind === 'pdf') {
      if (buf.length > MAX_PDF_BYTES) {
        return { ok: false, error: `PDF 超过 ${Math.round(MAX_PDF_BYTES / 1048576)}MB 上限` };
      }
      // 校验魔数:声明是 PDF 不算,得真的是(和图片同一个道理)
      if (buf.slice(0, 5).toString('latin1') !== '%PDF-') {
        return { ok: false, error: '文件内容不是 PDF' };
      }
    } else {
      if (buf.length > MAX_TEXT_BYTES) {
        return { ok: false, error: `文本文件超过 ${Math.round(MAX_TEXT_BYTES / 1024)}KB 上限` };
      }
      // 必须是合法 UTF-8。二进制文件改个扩展名就传上来的话,内联进正文
      // 会变成一大片乱码,白烧一次额度才发现。
      const text = buf.toString('utf8');
      if (Buffer.from(text, 'utf8').length !== buf.length || text.includes('\u0000')) {
        return { ok: false, error: '这个文件不是纯文本(可能是二进制)' };
      }
    }

    const ext = kind === 'pdf' ? 'pdf' : 'txt';
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
    const id = `${hash}.${ext}`;
    const file = path.join(md, id);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(md, { recursive: true });
      fs.writeFileSync(file, buf, { mode: 0o600 });
    }
    return { ok: true, id, kind, name: clean, mime: kind === 'pdf' ? PDF_MIME : 'text/plain', bytes: buf.length };
  }

  // 读回一个附件的原始字节(发送时要转 base64 或取文本)
  function getFile(user, id) {
    const md = mediaDir(user);
    const seg = safeSeg(id);
    if (!md || !seg) return null;
    const file = path.join(md, seg);
    if (!fs.existsSync(file)) return null;
    try {
      return { buf: fs.readFileSync(file), ext: seg.split('.').pop() };
    } catch {
      return null;
    }
  }

  function getImage(user, id) {
    const md = mediaDir(user);
    const seg = safeSeg(id);
    if (!md || !seg) return null;
    const file = path.join(md, seg);
    if (!fs.existsSync(file)) return null;
    const ext = seg.split('.').pop();
    const mime = Object.keys(MIME_EXT).find((k) => MIME_EXT[k] === ext) || 'application/octet-stream';
    try {
      return { buf: fs.readFileSync(file), mime };
    } catch {
      return null;
    }
  }


  function stats(user) {
    const idx = loadIndex(user);
    const md = mediaDir(user);
    let mediaCount = 0;
    let mediaBytes = 0;
    try {
      for (const f of fs.readdirSync(md)) {
        const st = fs.statSync(path.join(md, f));
        mediaCount++;
        mediaBytes += st.size;
      }
    } catch {
      /* 目录还不存在 */
    }
    return {
      sessions: idx.length,
      maxSessions: MAX_SESSIONS,
      maxMessages: MAX_MESSAGES,
      mediaCount,
      mediaBytes,
      maxImageBytes: MAX_IMAGE_BYTES,
    };
  }

  return {
    enabled,
    list,
    create,
    get,
    save,
    remove,
    rename,
    setPinned,
    clear,
    listSkills,
    saveSkills,
    MAX_USER_SKILLS,
    putImage,
    putFile,
    getFile,
    getImage,
    stats,
    sweepOrphanMedia,
    listUsers,
    MAX_IMAGE_BYTES,
    MAX_ARCHIVE_BYTES,
    MAX_PDF_BYTES,
    MAX_TEXT_BYTES,
  };
}
