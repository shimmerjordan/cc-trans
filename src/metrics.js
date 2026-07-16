// 指标采集:累计/每日聚合/按客户端聚合(轻量持久化,跨重启保留)+ 最近请求环形缓冲(内存态)。
// 持久化文件由调用方指定(通常 data/metrics.json);无文件路径时退化为纯内存态(如冒烟测试)。

import fs from 'node:fs';
import path from 'node:path';
import { costOf } from './pricing.js';

const MAX_DAILY_DAYS = 62; // 每日聚合最多保留天数
const SAVE_INTERVAL_MS = 20_000;

// 本地时区的 YYYY-MM-DD
export function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function createMetrics({ maxRecent = 500, persistFile = null, log = () => {} } = {}) {
  const startedAt = Date.now();
  let since = startedAt; // 累计统计起点(持久化后跨重启)
  let totals = { requests: 0, errors: 0, inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
  const byClient = new Map(); // name -> 聚合
  const daily = new Map(); // 'YYYY-MM-DD' -> { requests, errors, inTokens, outTokens, cacheReadTokens, cacheWriteTokens }
  const recent = []; // 环形缓冲(内存态,重启清零)
  const subscribers = new Set(); // 实时日志订阅回调
  let seq = 0;
  let rateLimit = null; // 最近一次上游响应里的 anthropic-ratelimit-* 头 { ts, headers }
  let dirty = false;

  // ── 持久化:启动时加载 ──
  if (persistFile) {
    try {
      if (fs.existsSync(persistFile)) {
        const j = JSON.parse(fs.readFileSync(persistFile, 'utf8'));
        if (j.totals) totals = { ...totals, ...j.totals };
        if (j.since) since = j.since;
        for (const [k, v] of Object.entries(j.daily || {})) daily.set(k, v);
        for (const [k, v] of Object.entries(j.byClient || {})) byClient.set(k, v);
        if (j.rateLimit) rateLimit = j.rateLimit;
      }
    } catch (err) {
      log(`⚠️ 指标持久化文件读取失败(忽略,重新累计): ${err.message}`);
    }
  }

  function save() {
    if (!persistFile || !dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(persistFile), { recursive: true });
      const tmp = `${persistFile}.tmp.${process.pid}`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          version: 1,
          since,
          totals,
          daily: Object.fromEntries(daily),
          byClient: Object.fromEntries(byClient),
          rateLimit,
        }),
        { mode: 0o600 },
      );
      fs.renameSync(tmp, persistFile);
    } catch (err) {
      dirty = true;
      log(`⚠️ 指标落盘失败: ${err.message}`);
    }
  }
  if (persistFile) setInterval(save, SAVE_INTERVAL_MS).unref();

  function isError(status) {
    return status === 0 || status >= 400;
  }

  function bumpAggregate(agg, e, u) {
    agg.requests++;
    if (isError(e.status)) agg.errors++;
    agg.inTokens += u.input || 0;
    agg.outTokens += u.output || 0;
    agg.cacheReadTokens += u.cacheRead || 0;
    agg.cacheWriteTokens += u.cacheWrite || 0;
    if (e.cost) agg.cost = (agg.cost || 0) + e.cost;
  }

  function record(entry) {
    const e = { id: ++seq, ...entry };
    const u = e.usage || {};
    // C 成本:按实际模型 + 用量估算 USD(仅展示,非账单)
    e.cost = costOf(e.costModel || e.model, u);

    bumpAggregate(totals, e, u);

    // 每日聚合
    const day = dayKey(e.ts);
    let d = daily.get(day);
    if (!d) {
      d = { requests: 0, errors: 0, inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
      daily.set(day, d);
      // 修剪最旧的天
      while (daily.size > MAX_DAILY_DAYS) {
        const oldest = [...daily.keys()].sort()[0];
        daily.delete(oldest);
      }
    }
    bumpAggregate(d, e, u);

    // 按客户端聚合
    const name = e.client || '(unknown)';
    let c = byClient.get(name);
    if (!c) {
      c = { requests: 0, errors: 0, inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, lastSeen: 0, lastStatus: 0 };
      byClient.set(name, c);
    }
    bumpAggregate(c, e, u);
    c.lastSeen = e.ts;
    c.lastStatus = e.status;

    dirty = true;

    recent.push(e);
    if (recent.length > maxRecent) recent.shift();

    for (const cb of subscribers) {
      try {
        cb(e);
      } catch {
        /* 单个订阅出错不影响其它 */
      }
    }
    return e;
  }

  // 上游订阅限额头快照(每次转发后更新)
  function setRateLimit(info) {
    rateLimit = info;
    dirty = true;
  }

  function subscribe(cb) {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  }

  function snapshot() {
    return {
      startedAt,
      uptimeMs: Date.now() - startedAt,
      since,
      totalRequests: totals.requests,
      totalErrors: totals.errors,
      totals: { ...totals },
      daily: [...daily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, d]) => ({ date, ...d })),
      rateLimit,
      subscribers: subscribers.size,
      clients: [...byClient.entries()].map(([name, c]) => ({ name, ...c })),
    };
  }

  function recentLogs(limit = 200) {
    return recent.slice(-limit);
  }

  // 某个客户端名被吊销/删除后,把它的聚合也清掉(可选)
  function forget(name) {
    byClient.delete(name);
    dirty = true;
  }

  // 进程退出前强制落盘
  function flush() {
    save();
  }

  return { record, setRateLimit, subscribe, snapshot, recentLogs, forget, flush };
}
