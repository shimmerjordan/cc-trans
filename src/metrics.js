// 内存态指标采集:总量、按客户端聚合、最近请求环形缓冲、以及给实时日志用的订阅。
// 重启清零(历史仍在 journald)。

export function createMetrics(maxRecent = 500) {
  const startedAt = Date.now();
  let totalRequests = 0;
  let totalErrors = 0;
  const byClient = new Map(); // name -> 聚合
  const recent = []; // 环形缓冲
  const subscribers = new Set(); // 实时日志订阅回调
  let seq = 0;

  function isError(status) {
    return status === 0 || status >= 400;
  }

  function record(entry) {
    const e = { id: ++seq, ...entry };
    totalRequests++;
    if (isError(e.status)) totalErrors++;

    const name = e.client || '(unknown)';
    let c = byClient.get(name);
    if (!c) {
      c = { requests: 0, errors: 0, inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, lastSeen: 0, lastStatus: 0 };
      byClient.set(name, c);
    }
    c.requests++;
    if (isError(e.status)) c.errors++;
    const u = e.usage || {};
    c.inTokens += u.input || 0;
    c.outTokens += u.output || 0;
    c.cacheReadTokens += u.cacheRead || 0;
    c.cacheWriteTokens += u.cacheWrite || 0;
    c.lastSeen = e.ts;
    c.lastStatus = e.status;

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

  function subscribe(cb) {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  }

  function snapshot() {
    return {
      startedAt,
      uptimeMs: Date.now() - startedAt,
      totalRequests,
      totalErrors,
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
  }

  return { record, subscribe, snapshot, recentLogs, forget };
}
