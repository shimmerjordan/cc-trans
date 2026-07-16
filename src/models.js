// Claude 模型目录与参数规则(内置,随 cc-trans 代码更新;管理台可从上游拉取实际列表比对)。
// 依据 2026-06 Anthropic API 参考:
//   - 新家族 (Opus 4.7/4.8、Sonnet 5、Fable 5) 已移除 temperature/top_p/top_k,传了直接 400
//   - thinking: 新家族只认 {type:"adaptive"}(Fable 5 不接受 disabled,只能省略);老模型用 enabled+budget_tokens
//   - effort: output_config.effort,4.6+ 支持(4.6 无 xhigh);Sonnet 4.5 / Haiku 4.5 不支持
//   - 订阅 OAuth 门禁: 非 Haiku 模型要求 system 以 "You are Claude Code" 开头,否则被上游拒(表现为脱敏的 400/429)

export const CATALOG_VERSION = '2026-07-12';

export const CC_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

// ── Claude Code 身份指纹(借鉴 claude-relay-service)──────────────────────
// 订阅 OAuth 门禁不只看 system 前缀,还看整套 Claude Code 客户端指纹:
// User-Agent(claude-cli/…)、x-app、anthropic-beta 四件套等。自研客户端缺这套指纹时
// 会更频繁触发脱敏 429/门禁。开启 spoofClaudeCode 后 cc-trans 补齐这套身份。
export const CLAUDE_CODE_UA = 'claude-cli/1.0.119 (external, cli)';
export const OAUTH_BETA = 'oauth-2025-04-20';
export const CLAUDE_CODE_BETA = 'claude-code-20250219';
export const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
export const TOOL_STREAMING_BETA = 'fine-grained-tool-streaming-2025-05-14';

// 依 claude-relay-service:非 Haiku 用四件套,Haiku 只用 oauth + thinking。
export function claudeCodeBetas(model) {
  if (isHaiku(model)) return [OAUTH_BETA, INTERLEAVED_THINKING_BETA];
  return [OAUTH_BETA, CLAUDE_CODE_BETA, INTERLEAVED_THINKING_BETA, TOOL_STREAMING_BETA];
}

// 返回一组要注入的 Claude Code 身份请求头(键为小写)。不含 authorization/anthropic-version(由凭证层加)。
export function claudeCodeIdentityHeaders() {
  return {
    'user-agent': CLAUDE_CODE_UA,
    'x-app': 'cli',
    'anthropic-dangerous-direct-browser-access': 'true',
    accept: 'application/json',
    'accept-encoding': 'identity', // 避免上游压缩在中转链路上出问题
  };
}

// tier: 排序用;latest: 该层级当前最新
export const CATALOG = [
  { id: 'claude-fable-5',    tier: 'Fable',  latest: true,  temperature: false, thinking: '常开(只能省略或 adaptive,disabled 会 400)', effort: 'low~max(含 xhigh)', note: '最强旗舰;需 30 天数据保留' },
  { id: 'claude-opus-4-8',   tier: 'Opus',   latest: true,  temperature: false, thinking: 'adaptive / disabled(省略=关)',              effort: 'low~max(含 xhigh)', note: '当前 Opus 旗舰' },
  { id: 'claude-opus-4-7',   tier: 'Opus',   latest: false, temperature: false, thinking: 'adaptive / disabled(省略=关)',              effort: 'low~max(含 xhigh)', note: '上一代 Opus' },
  { id: 'claude-opus-4-6',   tier: 'Opus',   latest: false, temperature: true,  thinking: 'adaptive(推荐)/ enabled+budget(弃用)',      effort: 'low~max(无 xhigh)', note: '' },
  { id: 'claude-sonnet-5',   tier: 'Sonnet', latest: true,  temperature: false, thinking: '省略=adaptive / disabled',                   effort: 'low~max(含 xhigh)', note: '当前 Sonnet 旗舰' },
  { id: 'claude-sonnet-4-6', tier: 'Sonnet', latest: false, temperature: true,  thinking: 'adaptive(推荐)/ enabled+budget(弃用)',      effort: 'low~max(无 xhigh)', note: '' },
  { id: 'claude-sonnet-4-5-20250929', tier: 'Sonnet', latest: false, temperature: true, thinking: 'enabled+budget_tokens',              effort: '不支持',            note: '旧款' },
  { id: 'claude-haiku-4-5-20251001',  tier: 'Haiku',  latest: true,  temperature: true, thinking: 'enabled+budget_tokens',              effort: '不支持',            note: '最快最省;订阅门禁豁免(免 CC system 前缀)' },
];

// 新家族 = 已移除 temperature/top_p/top_k、thinking 只认 adaptive 的模型
export function isNewFamily(model) {
  return /fable|mythos|opus-4-[78]|sonnet-5(?!\d)/.test(String(model || ''));
}

export function isFable(model) {
  return /fable|mythos/.test(String(model || ''));
}

export function isHaiku(model) {
  return /haiku/.test(String(model || ''));
}

// 对请求体应用客户端级参数下发。obj 为 /v1/messages 的 JSON body(原地修改),返回改动摘要数组。
// overrides: { model, thinking, effort, injectClaudeCodeSystem, stripUnsupported }
export function applyOverrides(obj, overrides) {
  const changes = [];
  const ov = overrides || {};

  // 1) 强制模型
  if (ov.model && obj.model !== ov.model) {
    changes.push(`model=${obj.model}→${ov.model}`);
    obj.model = ov.model;
  }
  const model = obj.model;

  // 2) thinking 覆盖(fable 不接受 disabled → 直接移除该字段)
  if (ov.thinking === 'adaptive') {
    obj.thinking = { type: 'adaptive' };
    changes.push('thinking=adaptive');
  } else if (ov.thinking === 'disabled') {
    if (isFable(model)) {
      if ('thinking' in obj) { delete obj.thinking; changes.push('-thinking(fable不认disabled)'); }
    } else {
      obj.thinking = { type: 'disabled' };
      changes.push('thinking=disabled');
    }
  }

  // 3) effort 注入
  if (ov.effort) {
    obj.output_config = { ...(obj.output_config || {}), effort: ov.effort };
    changes.push(`effort=${ov.effort}`);
  }

  // 4) 新家族参数清洗:剔除会被上游 400 的参数
  if (ov.stripUnsupported && isNewFamily(model)) {
    for (const k of ['temperature', 'top_p', 'top_k']) {
      if (k in obj) { delete obj[k]; changes.push(`-${k}`); }
    }
    if (obj.thinking && obj.thinking.type === 'enabled') {
      obj.thinking = { type: 'adaptive' };
      changes.push('thinking:enabled→adaptive');
    }
    if (isFable(model) && obj.thinking && obj.thinking.type === 'disabled') {
      delete obj.thinking;
      changes.push('-thinking(fable)');
    }
  }

  // 5) 订阅门禁:非 Haiku 模型注入 Claude Code system 前缀
  if (ov.injectClaudeCodeSystem && !isHaiku(model)) {
    if (ensureCcSystem(obj)) changes.push('+ccSystem');
  }

  return changes;
}

// 确保首个 system 块"精确等于" Claude Code 前缀;有改动返回 true。
// 实测(2026-07-12)门禁是块级精确匹配:前缀+自定义拼在同一字符串会被拒,
// 必须拆成 [前缀块, 自定义块] 且首块与前缀逐字相等。
function ensureCcSystem(obj) {
  const sys = obj.system;
  if (sys == null) {
    obj.system = CC_SYSTEM_PREFIX;
    return true;
  }
  if (typeof sys === 'string') {
    if (sys === CC_SYSTEM_PREFIX) return false;
    // 已带前缀但同串拼了别的内容 → 拆块;否则整串作为第二块
    const rest = sys.startsWith(CC_SYSTEM_PREFIX) ? sys.slice(CC_SYSTEM_PREFIX.length).replace(/^\s+/, '') : sys;
    obj.system = rest ? [{ type: 'text', text: CC_SYSTEM_PREFIX }, { type: 'text', text: rest }] : CC_SYSTEM_PREFIX;
    return true;
  }
  if (Array.isArray(sys)) {
    const first = sys[0];
    const t = first && first.type === 'text' ? String(first.text || '') : '';
    if (t === CC_SYSTEM_PREFIX) return false; // 真实 Claude Code 流量:首块本来就是精确前缀
    if (t.startsWith(CC_SYSTEM_PREFIX)) {
      const rest = t.slice(CC_SYSTEM_PREFIX.length).replace(/^\s+/, '');
      const blocks = [{ type: 'text', text: CC_SYSTEM_PREFIX }];
      if (rest) blocks.push({ ...first, text: rest });
      sys.splice(0, 1, ...blocks);
      return true;
    }
    sys.unshift({ type: 'text', text: CC_SYSTEM_PREFIX });
    return true;
  }
  return false;
}

// 归一化并校验 overrides(管理台写入前调用)
export function normalizeOverrides(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  // A 兼容性
  if (o.model && typeof o.model === 'string') out.model = o.model.trim();
  if (['adaptive', 'disabled'].includes(o.thinking)) out.thinking = o.thinking;
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(o.effort)) out.effort = o.effort;
  if (o.injectClaudeCodeSystem) out.injectClaudeCodeSystem = true;
  if (o.stripUnsupported) out.stripUnsupported = true;
  if (o.spoofClaudeCode) out.spoofClaudeCode = true;
  // B 安全:限流 / 并发 / 客户端限制 / 模型白名单
  const win = Number(o.rateLimitWindowSec);
  if (Number.isFinite(win) && win > 0) out.rateLimitWindowSec = Math.min(Math.floor(win), 86400);
  const rlr = Number(o.rateLimitRequests);
  if (Number.isFinite(rlr) && rlr > 0) out.rateLimitRequests = Math.floor(rlr);
  const cc = Number(o.concurrencyLimit);
  if (Number.isFinite(cc) && cc > 0) out.concurrencyLimit = Math.floor(cc);
  if (typeof o.allowedClient === 'string' && o.allowedClient.trim()) out.allowedClient = o.allowedClient.trim();
  if (Array.isArray(o.allowedModels)) {
    const list = o.allowedModels.map((m) => String(m || '').trim()).filter(Boolean);
    if (list.length) out.allowedModels = list;
  }
  return out;
}

// 客户端 UA 是否符合限制。allowedClient: "claude_code" 预设 | 任意正则串。空/无限制返回 true。
export function clientAllowed(allowedClient, userAgent) {
  if (!allowedClient) return true;
  const ua = String(userAgent || '');
  if (allowedClient === 'claude_code') return /^claude-cli\/[^\s]+/i.test(ua);
  try {
    return new RegExp(allowedClient, 'i').test(ua);
  } catch {
    return true; // 正则非法则不拦截,避免误锁死
  }
}

// 请求模型是否在白名单内。allowedModels 为空返回 true(不限制)。
export function modelAllowed(allowedModels, model) {
  if (!Array.isArray(allowedModels) || !allowedModels.length) return true;
  return allowedModels.includes(String(model || ''));
}
