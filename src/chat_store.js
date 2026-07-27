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

// 这三个上限是【磁盘保护】,不是额度:超了删最旧的,不会拒绝请求,也不区分管理员
// (谁的对话都一样占盘)。默认值只是"自用服务的合理默认",可在 config.json 调,
// 0 = 不限(愿意自己盯着磁盘就随意)。
const DEFAULT_MAX_SESSIONS = 200; // 每用户会话上限,超了删最旧
const DEFAULT_MAX_MESSAGES = 500; // 每会话消息上限,超了删最早
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// 孤儿图片的宽限期:刚上传还没发送的图按引用判定就是孤儿,清扫必须绕开它们
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

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

  function list(user) {
    return loadIndex(user)
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
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

  function save(user, session) {
    const f = sessionFile(user, session && session.id);
    if (!f) return { ok: false, error: '非法会话 id' };
    // 消息超上限:丢最早的(保留完整的一问一答对不做特别处理,简单可预期);0 = 不限
    if (MAX_MESSAGES > 0 && Array.isArray(session.messages) && session.messages.length > MAX_MESSAGES) {
      session.messages = session.messages.slice(-MAX_MESSAGES);
    }
    session.updatedAt = Date.now();
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

  function rename(user, id, title) {
    const s = get(user, id);
    if (!s) return { ok: false, error: '会话不存在' };
    s.title = String(title || '').slice(0, 80);
    return save(user, s);
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
  function imageIdsOf(session) {
    const out = new Set();
    for (const m of (session && session.messages) || []) {
      for (const im of m.images || []) if (im && im.id) out.add(String(im.id));
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
    const ext = MIME_EXT[String(mime || '').toLowerCase()];
    if (!ext) return { ok: false, error: '只支持 PNG / JPEG / WebP / GIF' };
    let buf;
    try {
      buf = Buffer.from(String(data || ''), 'base64');
    } catch {
      return { ok: false, error: '图片数据无法解析' };
    }
    if (!buf.length) return { ok: false, error: '图片为空' };
    if (buf.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: `图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限` };
    }
    // 校验魔数:别人说是 png 不算,得真的是
    if (!sniffMatches(buf, ext)) return { ok: false, error: '文件内容与声明的图片类型不符' };
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
    const name = `${hash}.${ext}`;
    const file = path.join(md, name);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(md, { recursive: true });
      fs.writeFileSync(file, buf, { mode: 0o600 });
    }
    return { ok: true, id: name, mime: String(mime).toLowerCase(), bytes: buf.length };
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

  function sniffMatches(buf, ext) {
    const b = buf;
    if (ext === 'png') return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    if (ext === 'jpg') return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    if (ext === 'gif') return b.slice(0, 3).toString('ascii') === 'GIF';
    if (ext === 'webp') return b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP';
    return false;
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
    clear,
    putImage,
    getImage,
    stats,
    sweepOrphanMedia,
    listUsers,
    MAX_IMAGE_BYTES,
  };
}
