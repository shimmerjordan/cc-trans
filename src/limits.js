// 按客户端(令牌)的限流与并发控制。纯内存态,进程重启清零 —— 契合 cc-trans 单进程零依赖定位。
// 借鉴 claude-relay-service 的 rateLimitWindow/rateLimitRequests/concurrencyLimit,但去掉 Redis。

export function createLimiter() {
  const hits = new Map(); // token -> number[](窗口内的请求时间戳,升序)
  const conc = new Map(); // token -> 当前并发数

  // 检查是否放行。放行时登记一次请求并占用一个并发额度,返回 release()。
  // 拒绝时返回 { ok:false, status, retryAfterSec, message },不占额度。
  function tryAcquire(token, overrides) {
    const ov = overrides || {};
    const now = Date.now();

    // ── 滑动窗口请求数 ──
    if (ov.rateLimitRequests > 0 && ov.rateLimitWindowSec > 0) {
      const winMs = ov.rateLimitWindowSec * 1000;
      let arr = hits.get(token);
      if (!arr) hits.set(token, (arr = []));
      // 剪掉过期时间戳
      const cutoff = now - winMs;
      while (arr.length && arr[0] <= cutoff) arr.shift();
      if (arr.length >= ov.rateLimitRequests) {
        const retryAfterSec = Math.max(1, Math.ceil((arr[0] + winMs - now) / 1000));
        return {
          ok: false,
          status: 429,
          retryAfterSec,
          message: `已达到请求频率限制(${ov.rateLimitRequests} 次 / ${ov.rateLimitWindowSec}s),请 ${retryAfterSec}s 后重试`,
        };
      }
    }

    // ── 并发上限 ──
    if (ov.concurrencyLimit > 0) {
      const cur = conc.get(token) || 0;
      if (cur >= ov.concurrencyLimit) {
        return {
          ok: false,
          status: 429,
          retryAfterSec: 1,
          message: `已达到并发上限(${ov.concurrencyLimit}),请稍后重试`,
        };
      }
    }

    // 放行:登记请求时间戳 + 占用并发额度
    if (ov.rateLimitRequests > 0 && ov.rateLimitWindowSec > 0) {
      hits.get(token).push(now);
    }
    let released = false;
    if (ov.concurrencyLimit > 0) {
      conc.set(token, (conc.get(token) || 0) + 1);
    }
    return {
      ok: true,
      release() {
        if (released) return;
        released = true;
        if (ov.concurrencyLimit > 0) {
          const c = (conc.get(token) || 1) - 1;
          if (c <= 0) conc.delete(token);
          else conc.set(token, c);
        }
      },
    };
  }

  // 令牌被吊销/删除时清理其计数
  function forget(token) {
    hits.delete(token);
    conc.delete(token);
  }

  // 定期清理空窗口,避免长期运行内存缓慢增长
  function sweep() {
    const now = Date.now();
    for (const [t, arr] of hits) {
      while (arr.length && arr[0] <= now - 86400_000) arr.shift();
      if (!arr.length) hits.delete(t);
    }
  }

  return { tryAcquire, forget, sweep };
}
