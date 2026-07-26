// 请求日志的分块持久化存储(零依赖)。
//
// 设计:按「本地日期 + 小时」分块写 JSONL —— data/logs/2026-07-16/14.jsonl。
//   - 追加写,不需要索引;查询按块倒序扫描,取够一页就停(不整表加载)。
//   - 分页:offset/limit(倒序,最新在前)+ 可选过滤(client / 最低状态码 / 仅错误 / 时间段)。
//   - 删除:按时间段删(整块能删则删文件,部分命中则重写该块)。
//   - 自动过期:超过 retentionDays 的日期目录整体删除,控制磁盘占用。
// 无 dir(纯 env 配置模式)时全部退化为 no-op,只保留内存态最近日志。

import fs from 'node:fs';
import path from 'node:path';

const p2 = (n) => String(n).padStart(2, '0');

export function dayOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
export function hourOf(ts) {
  return p2(new Date(ts).getHours());
}

export function createLogStore({ dir = null, retentionDays = 14, log = () => {} } = {}) {
  const enabled = !!dir;
  const handles = new Map(); // 'day/hour' -> fs.WriteStream(仅当前块常开)
  let pending = 0;

  function blockPath(ts) {
    return path.join(dir, dayOf(ts), `${hourOf(ts)}.jsonl`);
  }

  function streamFor(ts) {
    const key = `${dayOf(ts)}/${hourOf(ts)}`;
    let s = handles.get(key);
    if (s && !s.destroyed) return s;
    // 只保留最近一个块的句柄,切块时关掉旧的
    for (const [k, old] of handles) {
      try { old.end(); } catch { /* ignore */ }
      handles.delete(k);
    }
    const p = blockPath(ts);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    s = fs.createWriteStream(p, { flags: 'a' });
    s.on('error', (e) => log(`⚠️ 日志块写入失败 ${p}: ${e.message}`));
    handles.set(key, s);
    return s;
  }

  // 追加一条(异步、失败不影响主流程)
  function append(entry) {
    if (!enabled) return;
    try {
      const s = streamFor(entry.ts || Date.now());
      s.write(JSON.stringify(entry) + '\n');
      pending++;
    } catch (err) {
      log(`⚠️ 日志落盘失败: ${err.message}`);
    }
  }

  // 列出所有日期目录(升序)
  function days() {
    if (!enabled) return [];
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  // 某天的块文件(升序 00..23)
  function blocksOf(day) {
    try {
      return fs.readdirSync(path.join(dir, day))
        .filter((f) => /^\d{2}\.jsonl$/.test(f))
        .sort()
        .map((f) => ({ day, hour: f.slice(0, 2), file: path.join(dir, day, f) }));
    } catch {
      return [];
    }
  }

  // 全部块,倒序(最新在前)
  function allBlocksDesc() {
    const out = [];
    for (const d of days().reverse()) out.push(...blocksOf(d).reverse());
    return out;
  }

  function parseLines(file) {
    let txt;
    try {
      txt = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 跳过坏行(写入被截断等) */
      }
    }
    return out;
  }

  function matches(e, f) {
    if (!f) return true;
    if (f.from && e.ts < f.from) return false;
    if (f.to && e.ts > f.to) return false;
    if (f.client && e.client !== f.client) return false;
    if (f.errorsOnly && !(e.status === 0 || e.status >= 400)) return false;
    if (f.status && Number(e.status) !== Number(f.status)) return false;
    if (f.q) {
      const q = String(f.q).toLowerCase();
      const hay = `${e.path || ''} ${e.model || ''} ${e.client || ''} ${e.ip || ''} ${e.ua || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  // 分页查询(倒序)。返回 { logs, total, hasMore, scannedBlocks }
  // total 为"命中数"(需要扫全部块;为控制成本,只在 countTotal 时扫)
  function query({ offset = 0, limit = 100, countTotal = true, ...filter } = {}) {
    if (!enabled) return { logs: [], total: 0, hasMore: false, blocks: 0 };
    const blocks = allBlocksDesc();
    const logs = [];
    let seen = 0;
    let total = 0;
    let scanned = 0;
    for (const b of blocks) {
      // 时间段过滤:整块可以按 day 粗筛
      if (filter.from && `${b.day} ${b.hour}` < `${dayOf(filter.from)} ${hourOf(filter.from)}`) {
        if (!countTotal) break; // 倒序扫到早于 from 的块即可停
      }
      const rows = parseLines(b.file).reverse(); // 块内也倒序
      scanned++;
      for (const e of rows) {
        if (!matches(e, filter)) continue;
        total++;
        if (seen++ < offset) continue;
        if (logs.length < limit) logs.push(e);
        else if (!countTotal) return { logs, total: -1, hasMore: true, blocks: scanned };
      }
      if (!countTotal && logs.length >= limit) break;
    }
    return { logs, total, hasMore: offset + logs.length < total, blocks: scanned };
  }

  // 按时间段删除。before(删掉 < before 的)或 from+to(删区间)。返回 { removedEntries, removedBlocks }
  function prune({ before = null, from = null, to = null } = {}) {
    if (!enabled) return { removedEntries: 0, removedBlocks: 0 };
    let removedEntries = 0;
    let removedBlocks = 0;
    const inRange = (ts) => {
      if (before != null) return ts < before;
      if (from != null && to != null) return ts >= from && ts <= to;
      return false;
    };
    if (before == null && (from == null || to == null)) return { removedEntries: 0, removedBlocks: 0 };

    // 关掉所有句柄,避免删/改正在写的块
    for (const [k, s] of handles) {
      try { s.end(); } catch { /* ignore */ }
      handles.delete(k);
    }

    for (const d of days()) {
      for (const b of blocksOf(d)) {
        const rows = parseLines(b.file);
        if (!rows.length) continue;
        const keep = rows.filter((e) => !inRange(e.ts));
        if (keep.length === rows.length) continue;
        removedEntries += rows.length - keep.length;
        try {
          if (!keep.length) {
            fs.rmSync(b.file, { force: true });
            removedBlocks++;
          } else {
            const tmp = `${b.file}.tmp.${process.pid}`;
            fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join('\n') + '\n');
            fs.renameSync(tmp, b.file);
          }
        } catch (err) {
          log(`⚠️ 日志清理失败 ${b.file}: ${err.message}`);
        }
      }
      // 空目录清掉
      try {
        const left = fs.readdirSync(path.join(dir, d));
        if (!left.length) fs.rmdirSync(path.join(dir, d));
      } catch {
        /* ignore */
      }
    }
    return { removedEntries, removedBlocks };
  }

  // 自动过期:删掉早于 retentionDays 的整个日期目录
  function sweepRetention() {
    if (!enabled || !retentionDays) return { removedDays: [] };
    const cutoff = dayOf(Date.now() - retentionDays * 86400_000);
    const removedDays = [];
    for (const d of days()) {
      if (d < cutoff) {
        try {
          fs.rmSync(path.join(dir, d), { recursive: true, force: true });
          removedDays.push(d);
        } catch (err) {
          log(`⚠️ 过期日志清理失败 ${d}: ${err.message}`);
        }
      }
    }
    if (removedDays.length) log(`日志自动清理:已删除 ${removedDays.join(', ')}(保留 ${retentionDays} 天)`);
    return { removedDays };
  }

  // 存储概况(块数、条数估算、磁盘占用),供管理台展示
  function stats() {
    if (!enabled) return { enabled: false };
    let bytes = 0;
    let blocks = 0;
    const dayList = days();
    for (const d of dayList) {
      for (const b of blocksOf(d)) {
        blocks++;
        try { bytes += fs.statSync(b.file).size; } catch { /* ignore */ }
      }
    }
    return {
      enabled: true,
      dir,
      days: dayList.length,
      oldestDay: dayList[0] || null,
      newestDay: dayList[dayList.length - 1] || null,
      blocks,
      bytes,
      mb: Math.round((bytes / 1048576) * 100) / 100,
      retentionDays,
    };
  }

  function flush() {
    for (const [k, s] of handles) {
      try { s.end(); } catch { /* ignore */ }
      handles.delete(k);
    }
  }

  return { enabled, append, query, prune, sweepRetention, stats, flush };
}
