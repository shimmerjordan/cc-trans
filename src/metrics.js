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

export function createMetrics({ maxRecent = 500, persistFile = null, logStore = null, log = () => {} } = {}) {
  const startedAt = Date.now();
  let since = startedAt; // 累计统计起点(持久化后跨重启)
  let totals = { requests: 0, errors: 0, inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
  const byClient = new Map(); // name -> 聚合
  const daily = new Map(); // 'YYYY-MM-DD' -> { requests, errors, inTokens, outTokens, cacheReadTokens, cacheWriteTokens }
  // client -> 'YYYY-MM-DD' -> 聚合。用户级配额要按"某几个令牌 + 某个时间窗口"算,
  // 全局 daily 和累计 byClient 都答不了这个问题,所以需要这个交叉维度。
  const byClientDaily = new Map();
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
        for (const [c, days] of Object.entries(j.byClientDaily || {})) byClientDaily.set(c, new Map(Object.entries(days)));
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
          byClientDaily: Object.fromEntries([...byClientDaily].map(([c, days]) => [c, Object.fromEntries(days)])),
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
    // 交叉维度(客户端 × 日期),供用户级配额按窗口聚合
    let cd = byClientDaily.get(name);
    if (!cd) byClientDaily.set(name, (cd = new Map()));
    let cdd = cd.get(day);
    if (!cdd) {
      cdd = { requests: 0, errors: 0, inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
      cd.set(day, cdd);
      // 与 daily 同样的保留期,避免无限增长
      while (cd.size > MAX_DAILY_DAYS) cd.delete([...cd.keys()].sort()[0]);
    }
    bumpAggregate(cdd, e, u);
    c.lastSeen = e.ts;
    c.lastStatus = e.status;
    // 来源标注(异常请求排查用):记录最近一次的来源 IP / UA / 路径
    if (e.ip) c.lastIp = e.ip;
    if (e.ua) c.lastUa = e.ua;
    if (e.path) c.lastPath = e.path;
    if (isError(e.status)) {
      c.lastErrorAt = e.ts;
      c.lastErrorStatus = e.status;
      if (e.ip) c.lastErrorIp = e.ip;
      if (e.ua) c.lastErrorUa = e.ua;
      if (e.path) c.lastErrorPath = e.path;
      // 来源 IP 计数(便于看清异常请求集中来自谁)
      if (e.ip) {
        c.errorIps = c.errorIps || {};
        c.errorIps[e.ip] = (c.errorIps[e.ip] || 0) + 1;
        // 控制体积:只留 top 10
        const keys = Object.keys(c.errorIps);
        if (keys.length > 10) {
          const sorted = keys.sort((a, b) => c.errorIps[b] - c.errorIps[a]).slice(0, 10);
          const trimmed = {};
          for (const k of sorted) trimmed[k] = c.errorIps[k];
          c.errorIps = trimmed;
        }
      }
    }

    dirty = true;

    recent.push(e);
    if (recent.length > maxRecent) recent.shift();
    if (logStore) logStore.append(e); // 分块持久化(供分页查询/按时间删除)

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

  // 用户级配额用:把若干客户端在指定窗口内的用量加起来。
  // window: 'day'(今天) | 'month'(本月) | 'total'(累计)
  // tokens 口径 = 输入 + 输出,【不含缓存读】—— 缓存读量级巨大又极便宜,
  // 拿它限额会让配额瞬间见底,失去意义;成本口径则包含缓存(已按价折算)。
  function usageFor(clientNames, window = 'month') {
    const names = Array.isArray(clientNames) ? clientNames : [clientNames];
    const out = { requests: 0, inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
    const add = (a) => {
      if (!a) return;
      out.requests += a.requests || 0;
      out.inTokens += a.inTokens || 0;
      out.outTokens += a.outTokens || 0;
      out.cacheReadTokens += a.cacheReadTokens || 0;
      out.cacheWriteTokens += a.cacheWriteTokens || 0;
      out.cost += a.cost || 0;
    };
    if (window === 'total') {
      for (const n of names) add(byClient.get(n));
    } else {
      const today = dayKey(Date.now());
      const prefix = window === 'day' ? today : today.slice(0, 7); // 'YYYY-MM-DD' / 'YYYY-MM'
      for (const n of names) {
        const cd = byClientDaily.get(n);
        if (!cd) continue;
        for (const [d, agg] of cd) if (d.startsWith(prefix)) add(agg);
      }
    }
    out.tokens = out.inTokens + out.outTokens; // 配额判定口径
    return out;
  }

  function recentLogs(limit = 200) {
    return recent.slice(-limit);
  }

  // 某个客户端名被吊销/删除后,把它的聚合也清掉(可选)
  function forget(name) {
    byClient.delete(name);
    byClientDaily.delete(name);
    dirty = true;
  }

  // 进程退出前强制落盘
  function flush() {
    save();
  }

  return { record, setRateLimit, subscribe, snapshot, recentLogs, usageFor, forget, flush };
}
