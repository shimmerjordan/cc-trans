// 订阅用量(=「账户整体额度」)的单一数据源:上游 /api/oauth/usage 的拉取、归一化、
// 缓存,以及"拿不到那个接口时从 anthropic-ratelimit-* 响应头推算"的回落。
//
// 为什么单独成文件:管理台和用户端都要看这份数据,而它背后是一次【上游网络调用】。
// 两边各写一份就会各带一份缓存,同一个 10 分钟窗口里把上游问两次 —— 而这个接口
// 本身就会因为问得太勤回 429。共用一个实例 = 共用一份缓存 = 上游只被问一次。
//
// 谁看得到什么由【调用方】给定,不由前端决定(见 accountView 的 includeMoney):
//   · 百分比 = "我现在还能不能发请求"的答案,每个用户都该看得到;
//   · 金额   = 账务信息,跟着 perms.cost 走。
// 前端只负责画,不负责挑 —— 挑什么能看必须落在服务端,否则一个 devtools 就绕过去了。

// 官方 limits[].kind → 中文标签
export const LIMIT_KIND_LABELS = {
  session: '会话窗口(5 小时)',
  weekly_all: '7 天窗口 · 全模型',
  weekly_scoped: '7 天窗口',
};

// 顶层窗口键 / 限额头里的窗口名 → 中文标签
export const WINDOW_LABELS = {
  five_hour: '5 小时窗口',
  seven_day: '7 天窗口(全模型)',
  seven_day_opus: '7 天窗口 · Opus',
  seven_day_sonnet: '7 天窗口 · Sonnet',
  seven_day_oauth_apps: '7 天窗口 · OAuth Apps',
  extra_usage: '额外用量额度',
  '5h': '5 小时窗口',
  '7d': '7 天窗口',
  overage: '额外用量额度',
};

const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

// 官方没给 severity 时按百分比推。阈值刻意比"满了才红"早 ——
// 用户要的是"我还剩多少",95% 才变色等于没提醒。
function severityOf(pct, given) {
  const s = String(given || '').toLowerCase();
  if (s === 'critical' || s === 'warn' || s === 'warning' || s === 'normal') return s === 'warning' ? 'warn' : s;
  if (pct >= 95) return 'critical';
  if (pct >= 80) return 'warn';
  return 'normal';
}

// 时间戳归一:官方两处格式不同 —— usage 接口给 ISO 串,限额头给 unix 秒(也见过 ISO)。
// 统一成毫秒,前端就只需要一套格式化。
export function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const s = String(v);
  const n = Number(s);
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// 金额:官方用 minor unit + 指数(5008 / 10^2 = $50.08)。两个对象的指数字段名还不一样,
// spend 用 exponent、extra_usage 用 decimal_places —— 照抄一套会把 $50 显示成 $5008。
function money(m, expKey = 'exponent') {
  if (!m || typeof m.amount_minor !== 'number') return null;
  const exp = Number(m[expKey]);
  return { amount: m.amount_minor / 10 ** (Number.isFinite(exp) ? exp : 2), currency: m.currency || 'USD' };
}

// 上游 /api/oauth/usage 的原始 JSON → 内部结构。三处数据源各有各的用处,都要收
// (形状取自 2026-07-30 的真实响应):
//   · limits[]  —— 最全的一处:含【模型细分】窗口(scope.model.display_name,如 "Fable")
//                  与官方自己给的 severity。顶层那些 seven_day_opus/seven_day_sonnet
//                  在实测账号上全是 null,细分数据其实只在这个数组里。
//   · 顶层带 utilization 的对象 —— 老结构(five_hour/seven_day/extra_usage),继续收着兜底。
//   · spend —— 额外用量额度(credits)的消费上限。**它满了会让主配额还有余量时也吃 529**,
//              最容易被忽略、却最要紧,所以单独拎出来给前端做醒目告警。
export function normalizeUsage(j) {
  const windows = [];
  for (const [k, v] of Object.entries(j || {})) {
    if (v && typeof v === 'object' && typeof v.utilization === 'number') {
      windows.push({ key: k, utilization: v.utilization, resetsAt: v.resets_at || null });
    }
  }
  const limits = (Array.isArray(j && j.limits) ? j.limits : []).map((l) => ({
    kind: l.kind || '',
    group: l.group || '',
    percent: Number(l.percent) || 0,
    severity: l.severity || 'normal',
    resetsAt: l.resets_at || null,
    isActive: !!l.is_active,
    // 模型细分窗口把模型名带出来。id 实测常为 null,display_name 才是 "Fable" 这种可读名
    model: l.scope && l.scope.model ? l.scope.model.display_name || l.scope.model.id || null : null,
    surface: l.scope ? l.scope.surface || null : null,
  }));
  const sp = j && j.spend;
  const spend = sp
    ? {
        used: money(sp.used),
        limit: money(sp.limit),
        percent: Number(sp.percent) || 0,
        severity: sp.severity || 'normal',
        enabled: !!sp.enabled,
        disabledReason: sp.disabled_reason || null,
      }
    : null;
  const eu = j && j.extra_usage;
  const extraUsage = eu
    ? {
        isEnabled: !!eu.is_enabled,
        utilization: Number(eu.utilization) || 0,
        // 这里的指数字段叫 decimal_places(不是 exponent),别照抄 spend 那套
        used: money({ amount_minor: eu.used_credits, currency: eu.currency, decimal_places: eu.decimal_places }, 'decimal_places'),
        limit: money({ amount_minor: eu.monthly_limit, currency: eu.currency, decimal_places: eu.decimal_places }, 'decimal_places'),
        spendLimitReached: !!eu.spend_limit_reached,
        disabledReason: eu.disabled_reason || null,
      }
    : null;
  return { windows, limits, spend, extraUsage };
}

// 归一化结果 → 可直接渲染的条目。优先 limits[](唯一带模型细分的一处),
// 没有它才退回顶层窗口。额外用量额度不进条目 —— 它是金额,由 spendAlertOf 单独说。
export function barsFromUsage(u) {
  const out = [];
  if (u && (u.limits || []).length) {
    for (const l of u.limits) {
      const base = LIMIT_KIND_LABELS[l.kind] || l.kind || '窗口';
      const pct = clampPct(l.percent);
      out.push({
        key: l.kind + (l.model ? ':' + l.model : ''),
        label: l.model ? `${base} · ${l.model}` : base,
        percent: pct,
        resetsAt: toMs(l.resetsAt),
        severity: severityOf(pct, l.severity),
        model: l.model || null,
        isActive: !!l.isActive,
        status: null,
      });
    }
    return out;
  }
  for (const w of (u && u.windows) || []) {
    if (w.key === 'extra_usage') continue;
    const pct = clampPct(w.utilization);
    out.push({
      key: w.key,
      label: WINDOW_LABELS[w.key] || w.key,
      percent: pct,
      resetsAt: toMs(w.resetsAt),
      severity: severityOf(pct),
      model: null,
      isActive: false,
      status: null,
    });
  }
  return out;
}

// 回落数据源:最近一次转发响应里的 anthropic-ratelimit-unified-* 头。
// 官方现在给的是 utilization(0~1 的【比例】)+ status,已经没有 limit/remaining 了 ——
// 老代码只认后者,于是头明明抓到了、面板却显示"暂无数据"(踩过)。
// 注意单位:头里是 0~1,usage 接口是 0~100 —— 混了就会把 48% 显示成 0%。
export function barsFromHeaders(headers) {
  const h = headers || {};
  const wins = {};
  for (const [k, v] of Object.entries(h)) {
    const m = String(k).toLowerCase().match(/^anthropic-ratelimit-unified-(.+?)-(utilization|status|reset)$/);
    if (m) (wins[m[1]] = wins[m[1]] || {})[m[2]] = v;
  }
  const bars = [];
  for (const [w, d] of Object.entries(wins)) {
    if (d.utilization === undefined) continue;
    const num = Number(d.utilization);
    if (!Number.isFinite(num)) continue;
    const pct = clampPct(num * 100);
    const rejected = String(d.status || '').toLowerCase() === 'rejected';
    bars.push({
      key: w,
      label: WINDOW_LABELS[w] || w,
      percent: pct,
      resetsAt: toMs(d.reset),
      severity: rejected ? 'critical' : severityOf(pct),
      model: null,
      isActive: false,
      status: d.status ? String(d.status) : null,
    });
  }
  const overageStatus = String(h['anthropic-ratelimit-unified-overage-status'] || '').toLowerCase();
  return {
    bars,
    status: h['anthropic-ratelimit-unified-status'] || null,
    overageRejected: overageStatus === 'rejected',
    overageReason: h['anthropic-ratelimit-unified-overage-disabled-reason'] || null,
  };
}

// 额外用量额度(credits)耗尽的告警。为什么值得单独一块:主配额还剩一半时它也能让
// 请求吃 529 —— 官方的 529 文案只说 "Overloaded",完全看不出是自己账户的消费上限满了。
// 这里【不带金额】,所以没有 cost 权限的用户也能收到这条(他需要知道为什么失败)。
export function spendAlertOf(spend, extraUsage) {
  const sp = spend || null;
  const eu = extraUsage || null;
  if (!sp && !eu) return null;
  const pct = clampPct(sp ? sp.percent : eu.utilization);
  const exhausted = pct >= 100 || (sp && sp.severity === 'critical') || (eu && eu.spendLimitReached);
  return {
    percent: pct,
    severity: severityOf(pct, sp ? sp.severity : null),
    exhausted: !!exhausted,
    reason: (sp && sp.disabledReason) || (eu && eu.disabledReason) || null,
    // 有没有这份兜底额度。实测真实账号会回 percent=0 + disabled_reason=out_of_credits,
    // 照着 percent 画一根 0% 的条会读成"还有余量",而事实是【压根没有】——
    // 主窗口用尽后不存在兜底,这两种状态必须分得开。
    enabled: sp ? !!sp.enabled : eu ? !!eu.isEnabled : false,
  };
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
// 上游这个接口偶尔会挂住。没有超时的话,用户端「用量」会一直转圈 ——
// 管理台旧代码就没设超时(那里是手动点刷新,还看得出来;用户端是自动拉的)。
const FETCH_TIMEOUT_MS = 8000;

export function createSubscriptionUsage({ config, getOauth, ttlMs = DEFAULT_TTL_MS, log = () => {} } = {}) {
  let cache = { ts: 0, data: null };
  let inflight = null; // 并发合并:三个页面同时打开时也只问上游一次

  async function fetchNow() {
    const oauth = typeof getOauth === 'function' ? getOauth() : null;
    if (!oauth) return { available: false, reason: '非订阅 OAuth 模式' };
    try {
      const token = await oauth.getAccessToken();
      const r = await fetch(config.upstreamBaseUrl + '/api/oauth/usage', {
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': oauth.beta },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 120)}`);
      const data = { available: true, fetchedAt: Date.now(), ...normalizeUsage(JSON.parse(text)) };
      cache = { ts: Date.now(), data };
      return data;
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? `上游 ${FETCH_TIMEOUT_MS / 1000}s 未响应` : err.message;
      log(`⚠️ 订阅用量拉取失败: ${reason}`);
      return { available: false, reason };
    }
  }

  // force 只给管理台的「刷新」按钮用。用户端永远不传 —— 否则每个用户刷新页面
  // 都能把上游问一次,这个接口自己就会 429。
  async function get(force = false) {
    if (!force && cache.data && Date.now() - cache.ts < ttlMs) return cache.data;
    if (inflight) return inflight;
    inflight = fetchNow().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  // 账户整体额度的对外视图。scope 由调用方判断(用户有自己的限额时不该走到这)。
  async function accountView({ rateLimit = null, includeMoney = false } = {}) {
    const u = await get(false);
    if (u.available) {
      const bars = barsFromUsage(u);
      const alert = spendAlertOf(u.spend, u.extraUsage);
      if (bars.length || alert) {
        return {
          available: true,
          source: 'oauth',
          fetchedAt: u.fetchedAt || cache.ts || null,
          ttlMs,
          bars,
          alert,
          ...(includeMoney ? { spend: u.spend, extraUsage: u.extraUsage } : {}),
        };
      }
    }
    // 回落:限额头。apiKey 模式下也有(官方 API 的标准限流头),所以这一步在
    // "非订阅模式"的说明之前 —— 有真数据就别说"看不到"。
    if (rateLimit && rateLimit.headers) {
      const h = barsFromHeaders(rateLimit.headers);
      if (h.bars.length || h.overageRejected) {
        return {
          available: true,
          source: 'headers',
          fetchedAt: rateLimit.ts || null,
          ttlMs: 0,
          bars: h.bars,
          alert: h.overageRejected ? { percent: 100, severity: 'critical', exhausted: true, reason: h.overageReason } : null,
          upstreamStatus: h.status || null,
        };
      }
    }
    const mode = config.upstreamAuth;
    const reason =
      mode === 'oauth'
        ? '暂无数据' + (u && u.reason ? `(${u.reason})` : '') + ' —— 有请求转发过后会自动从上游响应头取到。'
        : mode === 'inherit'
          ? '级联模式:订阅额度属于上游那台 cc-trans,这台看不到,也不该假装看得到。'
          : '当前不是订阅(OAuth)模式,没有订阅额度可看。';
    return { available: false, source: null, reason };
  }

  return { get, accountView, ttlMs, cachedAt: () => cache.ts || null };
}
