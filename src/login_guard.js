// 登录尝试节流。管理台、用户端、统一入口三个登录接口共用这一份。
//
// 为什么必须有:三个登录接口此前都是"验一次密码就返回",对同一个账号可以
// 无限次高速试密码。scrypt 让单次爆破变慢(~60ms),但慢 60ms 不等于挡住了
// —— 并发 50 条连接照样是每秒近千次尝试。
//
// 借鉴 sub2api 的两点(它用 Redis 做同样的事):
//   1. 双键计数:按 IP 和按账号各记一份。只按 IP 挡不住分布式撞库,只按账号
//      挡不住"一个 IP 横扫所有账号"。
//   2. fail-close:限流器本身出问题时【拒绝】而不是放过。我们是纯内存实现,
//      不存在 Redis 断连,但"超出容量"这一类退化仍按拒绝处理。
//
// 与业务限流(limits.js)刻意分开:那个是保护上游额度,这个是保护凭证,
// 阈值、键、惩罚方式都不同,合到一起只会两边都别扭。

// 失败次数 → 锁定时长(阶梯)。前几次几乎无感,持续试才越来越贵。
const LADDER = [
  { after: 5, lockMs: 30 * 1000 },
  { after: 8, lockMs: 5 * 60 * 1000 },
  { after: 12, lockMs: 30 * 60 * 1000 },
];
const WINDOW_MS = 15 * 60 * 1000; // 失败计数的滑动窗口
const MAX_KEYS = 20000; // 内存上限:超了先清过期,还超就拒绝新键(fail-close)

function lockMsFor(fails) {
  let ms = 0;
  for (const step of LADDER) if (fails >= step.after) ms = step.lockMs;
  return ms;
}

export function createLoginGuard({ now = () => Date.now(), log = () => {} } = {}) {
  // key -> { fails, first, last, lockedUntil }
  const buckets = new Map();

  function sweep() {
    const t = now();
    for (const [k, b] of buckets) {
      // 锁还没到期的不能清 —— 清了等于把惩罚一起清了
      if (b.lockedUntil > t) continue;
      if (t - b.last > WINDOW_MS) buckets.delete(k);
    }
  }

  function bucket(key, create) {
    let b = buckets.get(key);
    if (b) {
      // 窗口内没有新失败 → 计数归零重新开始(锁定期内不重置)
      if (b.lockedUntil <= now() && now() - b.last > WINDOW_MS) {
        b.fails = 0;
        b.first = now();
      }
      return b;
    }
    if (!create) return null;
    if (buckets.size >= MAX_KEYS) {
      sweep();
      if (buckets.size >= MAX_KEYS) return null; // 容量耗尽,调用方按 fail-close 处理
    }
    b = { fails: 0, first: now(), last: now(), lockedUntil: 0 };
    buckets.set(key, b);
    return b;
  }

  // 登录前检查。keys 是这次尝试涉及的所有维度(ip、账号…),任一被锁就拒绝。
  function check(keys) {
    const t = now();
    for (const key of keys) {
      if (!key) continue;
      const b = buckets.get(key);
      if (b && b.lockedUntil > t) {
        return { ok: false, retryAfterSec: Math.ceil((b.lockedUntil - t) / 1000), key };
      }
    }
    return { ok: true };
  }

  // 失败后登记。返回本次是否触发了新的锁定(供调用方写审计日志)。
  function fail(keys, label = '') {
    const t = now();
    let locked = null;
    for (const key of keys) {
      if (!key) continue;
      const b = bucket(key, true);
      if (!b) {
        // 容量耗尽:宁可锁住也不放过(fail-close)
        return { locked: true, retryAfterSec: 60, exhausted: true };
      }
      b.fails++;
      b.last = t;
      const ms = lockMsFor(b.fails);
      if (ms) {
        const until = t + ms;
        if (until > b.lockedUntil) b.lockedUntil = until;
        if (!locked || b.lockedUntil > locked.until) locked = { until: b.lockedUntil, key, fails: b.fails };
      }
    }
    if (locked) {
      log(
        `[audit] 登录连续失败 ${locked.fails} 次,已锁定 ${Math.round((locked.until - t) / 1000)}s` +
          `(维度 ${locked.key}${label ? ` · ${label}` : ''})`,
      );
      return { locked: true, retryAfterSec: Math.ceil((locked.until - t) / 1000) };
    }
    return { locked: false, retryAfterSec: 0 };
  }

  // 成功后清账:这个 IP / 这个账号的失败记录都作废
  function succeed(keys) {
    for (const key of keys) if (key) buckets.delete(key);
  }

  return {
    check,
    fail,
    succeed,
    // 给测试与状态面板看
    size: () => buckets.size,
    peek: (key) => {
      const b = buckets.get(key);
      return b ? { ...b } : null;
    },
    reset: () => buckets.clear(),
  };
}

// 一次登录尝试涉及的维度。scope 区分管理台/用户端,免得两边的失败互相牵连。
export function loginKeys(scope, ip, username) {
  const name = String(username || '').trim().toLowerCase();
  return [`${scope}|ip|${ip || '-'}`, name ? `${scope}|user|${name}` : ''].filter(Boolean);
}
