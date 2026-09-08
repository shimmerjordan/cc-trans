// 压缩包读取:ZIP / tar / tar.gz / gz,零依赖(只用 node:zlib)。
//
// 为什么自己写而不是引个库:这个仓库是零依赖的,而 ZIP 的"读"这一半其实很小 ——
// 条目要么是 stored(method 0)要么是 raw deflate(method 8),后者 zlib 直接能解。
//
// 这个模块【只负责把字节取出来】。取出来的是文本、图片还是 PDF,由 chat_store
// 那边按内容判定 —— 那里已经有一套嗅探器,不该有第二套。
//
// 安全上有三条是必须的(解压是经典攻击面):
//   1. 炸弹:边解边拦(zlib 的 maxOutputLength),不能先解完再判断体积
//   2. 路径穿越:'../'、绝对路径、盘符一律清洗掉 —— 路径会进提示词
//   3. 嵌套包不递归:递归展开是炸弹最主要的放大路径
import zlib from 'node:zlib';

const DEFAULT_MAX_TOTAL = 32 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 2000;

const u16 = (b, o) => b.readUInt16LE(o);
const u32 = (b, o) => b.readUInt32LE(o);

// ── 格式识别 ────────────────────────────────────────────────
// 返回 { format, unsupported, office }:
//   format      能读的:'zip' | 'tar' | 'tgz' | 'gz'
//   unsupported 认得出是什么但读不了(需要外部库)
//   office      是 ZIP 但其实是 Office 文档 —— 按压缩包展开只会吐一堆 XML
export function detectArchive(buf, name = '') {
  const out = { format: null, unsupported: null, office: null };
  if (!buf || buf.length < 4) return out;
  const b = buf;

  if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) { out.unsupported = '7z'; return out; }
  if (b.slice(0, 4).toString('latin1') === 'Rar!') { out.unsupported = 'RAR'; return out; }
  if (b.slice(0, 3).toString('latin1') === 'BZh') { out.unsupported = 'BZIP2'; return out; }
  if (b[0] === 0xfd && b.slice(1, 4).toString('latin1') === '7zX') { out.unsupported = 'XZ'; return out; }

  // ZIP(Office / jar / apk 都以 ZIP 为容器)
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) {
    const office = officeKind(b, name);
    if (office) { out.office = office; return out; }
    out.format = 'zip';
    return out;
  }

  // gzip:里面可能是 tar,也可能就是单个文件。要解开才知道,
  // 但只解前 1KB 去看 tar 魔数,不整包解(那正是炸弹想要的)
  if (b[0] === 0x1f && b[1] === 0x8b) {
    out.format = looksLikeTarInGzip(b) ? 'tgz' : 'gz';
    return out;
  }

  if (isTar(b)) { out.format = 'tar'; return out; }
  return out;
}

function officeKind(buf, name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  const OFFICE = { docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint', odt: 'ODF', ods: 'ODF', odp: 'ODF' };
  if (OFFICE[ext]) return OFFICE[ext];
  // 没有扩展名可依时看内容:OOXML 一定有 [Content_Types].xml
  if (buf.includes(Buffer.from('[Content_Types].xml'))) return 'Office';
  if (buf.includes(Buffer.from('mimetypeapplication/vnd.oasis'))) return 'ODF';
  return null;
}

function isTar(b) {
  return b.length > 262 && b.slice(257, 262).toString('latin1') === 'ustar';
}

function looksLikeTarInGzip(b) {
  // 只想看开头 512 字节里有没有 tar 魔数,不能为此把整包解开(那正是炸弹想要的)。
  //
  // 关键技巧:截断【压缩侧】的输入,再用 Z_SYNC_FLUSH 收尾。maxOutputLength 在
  // 触发时会抛且【不回传已解出的部分】,所以拿它限制输出量是行不通的
  // (第一版就是这么写的,结果所有真实 tar.gz 都被认成单文件 gz)。
  try {
    const head = zlib.gunzipSync(b.slice(0, 8192), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    return isTar(head);
  } catch {
    return false;
  }
}

// ── 路径清洗 ────────────────────────────────────────────────
// 这些路径会进提示词,也可能被人拿去当文件名。'../' 与绝对路径必须在这里死掉。
export function safePath(raw) {
  let s = String(raw || '').replace(/\\/g, '/').trim();
  if (!s) return null;
  s = s.replace(/^([a-zA-Z]:)?\/+/, '');           // 去掉盘符与前导 /
  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }   // 上跳一律吃掉,不允许逃出根
    parts.push(seg);
  }
  if (!parts.length) return null;
  const out = parts.join('/');
  return out.length > 400 ? null : out;
}

// ── 主入口 ──────────────────────────────────────────────────
export function readArchive(buf, opts = {}) {
  const maxTotal = opts.maxTotalBytes || DEFAULT_MAX_TOTAL;
  const maxEntries = opts.maxEntries || DEFAULT_MAX_ENTRIES;
  const det = detectArchive(buf, opts.name || '');
  if (det.unsupported) return { ok: false, error: `${det.unsupported} 压缩包需要外部解压工具,暂不支持`, entries: [], skipped: [] };
  if (det.office) return { ok: false, error: `这是 ${det.office} 文档,不是压缩包`, entries: [], skipped: [] };
  if (!det.format) return { ok: false, error: '认不出这是什么压缩格式', entries: [], skipped: [] };

  const ctx = { entries: [], skipped: [], used: 0, truncated: false, maxTotal, maxEntries };
  try {
    if (det.format === 'zip') readZip(buf, ctx);
    else if (det.format === 'tar') readTar(buf, ctx);
    else if (det.format === 'tgz') readTar(gunzipCapped(buf, maxTotal, ctx), ctx);
    else if (det.format === 'gz') readSingleGz(buf, opts.name || '', ctx, maxTotal);
  } catch (err) {
    if (!ctx.entries.length) {
      return { ok: false, format: det.format, error: `解压失败:${err.message}`, entries: [], skipped: ctx.skipped, truncated: ctx.truncated };
    }
    ctx.truncated = true;   // 解出了一部分就用一部分,别整包丢掉
  }
  return { ok: true, format: det.format, entries: ctx.entries, skipped: ctx.skipped, truncated: ctx.truncated };
}

function gunzipCapped(buf, cap, ctx) {
  try {
    return zlib.gunzipSync(buf, { maxOutputLength: cap });
  } catch (e) {
    if (e && e.code === 'ERR_BUFFER_TOO_LARGE') {
      ctx.truncated = true;
      throw new Error('解压后体积超过上限(可能是压缩炸弹)');
    }
    throw e;
  }
}

function push(ctx, path, data) {
  if (ctx.entries.length >= ctx.maxEntries) { ctx.truncated = true; return false; }
  if (ctx.used + data.length > ctx.maxTotal) { ctx.truncated = true; return false; }
  ctx.used += data.length;
  ctx.entries.push({ path, data });
  return true;
}

// ── ZIP ─────────────────────────────────────────────────────
// 走中央目录(而不是顺着本地头往下扫):本地头里的 size 在流式打包时可能是 0,
// 真值只在中央目录/数据描述符里。ZIP 的规范入口本来就是中央目录。
function readZip(buf, ctx) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('找不到 ZIP 结尾记录(文件可能被截断)');
  let count = u16(buf, eocd + 10);
  let cdOff = u32(buf, eocd + 16);

  // ZIP64:字段被写成全 F 时真值在 ZIP64 结尾记录里
  if (cdOff === 0xffffffff || count === 0xffff) {
    const z64 = findZip64EOCD(buf, eocd);
    if (z64 >= 0) {
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdOff = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }

  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || u32(buf, p) !== 0x02014b50) break;
    const flag = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    let compSize = u32(buf, p + 20);
    let rawSize = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    let localOff = u32(buf, p + 42);
    const rawName = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const extra = buf.slice(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    if (compSize === 0xffffffff || rawSize === 0xffffffff || localOff === 0xffffffff) {
      const z = readZip64Extra(extra, { rawSize, compSize, localOff });
      rawSize = z.rawSize; compSize = z.compSize; localOff = z.localOff;
    }
    p += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith('/')) continue;                       // 目录
    const safe = safePath(rawName);
    if (!safe) { ctx.skipped.push({ path: rawName, why: '路径不安全,已跳过' }); continue; }
    if (flag & 0x1) { ctx.skipped.push({ path: safe, why: '条目已加密(需要密码),无法读取' }); continue; }

    // 本地头的长度字段可能与中央目录不同(extra 常常不一样),必须重读
    if (localOff + 30 > buf.length || u32(buf, localOff) !== 0x04034b50) {
      ctx.skipped.push({ path: safe, why: '本地头损坏' });
      continue;
    }
    const lNameLen = u16(buf, localOff + 26);
    const lExtraLen = u16(buf, localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + compSize);

    let data;
    try {
      if (method === 0) data = comp;
      else if (method === 8) data = zlib.inflateRawSync(comp, { maxOutputLength: remaining(ctx) });
      else { ctx.skipped.push({ path: safe, why: `压缩方式 ${method} 不支持` }); continue; }
    } catch (e) {
      if (e && e.code === 'ERR_BUFFER_TOO_LARGE') { ctx.truncated = true; break; }
      ctx.skipped.push({ path: safe, why: '解压失败(数据损坏?)' });
      continue;
    }
    if (!push(ctx, safe, data)) break;
  }
}

// 还能再解多少 —— 交给 zlib 当硬闸,炸弹在解的过程中就被打断
function remaining(ctx) {
  return Math.max(1, ctx.maxTotal - ctx.used);
}

function findEOCD(buf) {
  const sig = 0x06054b50;
  const from = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= from; i--) {
    if (u32(buf, i) === sig) return i;
  }
  return -1;
}
function findZip64EOCD(buf, eocd) {
  // ZIP64 定位记录就在 EOCD 前面 20 字节
  const loc = eocd - 20;
  if (loc < 0 || u32(buf, loc) !== 0x07064b50) return -1;
  const off = Number(buf.readBigUInt64LE(loc + 8));
  if (off < 0 || off + 56 > buf.length || u32(buf, off) !== 0x06064b50) return -1;
  return off;
}
function readZip64Extra(extra, cur) {
  let o = 0;
  const out = { ...cur };
  while (o + 4 <= extra.length) {
    const id = u16(extra, o);
    const size = u16(extra, o + 2);
    if (id === 0x0001) {
      let q = o + 4;
      if (cur.rawSize === 0xffffffff && q + 8 <= extra.length) { out.rawSize = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (cur.compSize === 0xffffffff && q + 8 <= extra.length) { out.compSize = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (cur.localOff === 0xffffffff && q + 8 <= extra.length) { out.localOff = Number(extra.readBigUInt64LE(q)); }
      break;
    }
    o += 4 + size;
  }
  return out;
}

// ── tar ─────────────────────────────────────────────────────
function readTar(buf, ctx) {
  let o = 0;
  let longName = null;
  while (o + 512 <= buf.length) {
    const head = buf.slice(o, o + 512);
    if (head.every((v) => v === 0)) break;                     // 结尾的空块
    const name = cstr(head.slice(0, 100));
    const prefix = cstr(head.slice(345, 500));
    const size = parseOctal(head.slice(124, 136));
    const type = String.fromCharCode(head[156] || 0x30);
    o += 512;
    const dataLen = Number.isFinite(size) && size >= 0 ? size : 0;
    const body = buf.slice(o, o + dataLen);
    o += Math.ceil(dataLen / 512) * 512;

    if (type === 'L') { longName = cstr(body); continue; }      // GNU 长文件名
    if (type === 'x' || type === 'g' || type === 'K') continue; // pax 头,跳过
    if (type === '5' || name.endsWith('/')) { longName = null; continue; }
    if (type !== '0' && type !== ' ' && type !== '7' && head[156] !== 0) { longName = null; continue; }

    const full = longName || (prefix ? `${prefix}/${name}` : name);
    longName = null;
    const safe = safePath(full);
    if (!safe) { ctx.skipped.push({ path: full, why: '路径不安全,已跳过' }); continue; }
    if (!push(ctx, safe, body)) break;
  }
}
function cstr(b) {
  const i = b.indexOf(0);
  return b.slice(0, i === -1 ? b.length : i).toString('utf8');
}
function parseOctal(b) {
  const s = cstr(b).trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

// ── 单文件 gz ───────────────────────────────────────────────
function readSingleGz(buf, name, ctx, cap) {
  const data = gunzipCapped(buf, cap, ctx);
  const inner = String(name || 'file.gz').replace(/\.gz$/i, '') || 'file';
  push(ctx, safePath(inner) || 'file', data);
}
