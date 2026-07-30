// Claude 模型目录与参数规则(内置,随 cc-trans 代码更新;管理台可从上游拉取实际列表比对)。
//
// 以下每一条都是【实测】结论(2026-07-30,经真实订阅上游逐个打过),不是照文档抄的:
//   - 新家族 (Opus 4.7+/5+、Sonnet 5+、Fable) 已移除 temperature/top_p/top_k
//     → `temperature` is deprecated for this model.
//   - thinking: 新家族 adaptive / disabled / enabled+budget_tokens 都接受
//     (旧注释说"只认 adaptive"并不准确);Fable 不接受 disabled,只能省略
//   - effort: output_config.effort。Haiku / Sonnet 4.5 压根不认这个参数
//     → This model does not support the effort parameter.
//     4.6 认 low/medium/high/max 但【没有 xhigh】
//     → This model does not support effort level 'xhigh'. Supported levels: high, low, max, medium.
//   - **effort 与 thinking 相互约束**:新家族在 thinking 显式 disabled 时,effort 上限是 high
//     → output_config.effort 'xhigh' is not supported when thinking is disabled on this model.
//       Use effort 'high' or below, or enable thinking.
//     注意「省略 thinking」不触发这条,只有显式 {type:"disabled"} 才会 —— 这个组合
//     正是 Claude Code 某些内部请求(如 web 搜索那一跳)会发出来的,不清洗就直接 400。
//   - 订阅 OAuth 门禁: 非 Haiku 模型要求 system 以 "You are Claude Code" 开头,否则被上游拒(表现为脱敏的 400/429)

export const CATALOG_VERSION = '2026-07-30';

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

// ── 参数能力规则(按模型 id 推断,不写死模型清单)────────────────────────
// 模型清单本身来自「上游拉取 + 持久化」(见 model_store.js);这里只描述"什么样的 id
// 支持什么参数",这样上游出了新模型也能自动推断出正确规则,不用改代码。
// 规则自上而下匹配,第一条命中即用。

// effort 档位,由低到高。清洗时要比较大小,所以顺序本身是数据。
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const ALL_EFFORT = EFFORT_ORDER;
const NO_XHIGH = ['low', 'medium', 'high', 'max']; // 4.6 实测:Supported levels: high, low, max, medium

// 家族正则只写一份。曾经 isNewFamily 与规则表各写一遍,结果规则表已经认得 opus-5、
// 而 isNewFamily 还停在 opus-4-[78] —— 于是 opus-5 请求里的 temperature 没被清洗,
// 客户端直接吃 400。同源之后这种漂移不可能再发生。
const FABLE_RE = /fable|mythos/;
// Opus 4.7 及以后(4.7/4.8/4.9…)、Opus 5+、Sonnet 5 及以后
const OPUS_SONNET_NEW_RE = /opus-4-(?:[7-9]|\d{2,})|opus-[5-9]|sonnet-(?:[5-9]|\d{2,})(?!\d*-\d)/;
const NEW_FAMILY_RE = new RegExp(`${FABLE_RE.source}|${OPUS_SONNET_NEW_RE.source}`);

const CAPABILITY_RULES = [
  {
    re: FABLE_RE,
    tier: 'Fable',
    temperature: false,
    thinking: '常开(只能省略或 adaptive,disabled 会 400)',
    effortLevels: ALL_EFFORT,
    // thinking 恒非 disabled(disabled 会被清洗掉),所以没有这条额外上限
    effortCapNoThinking: null,
    note: '旗舰;需 30 天数据保留',
  },
  {
    re: OPUS_SONNET_NEW_RE,
    tier: null, // 由 tierOf 推断
    temperature: false,
    thinking: 'adaptive / disabled / enabled+budget 都接受(省略=关)',
    effortLevels: ALL_EFFORT,
    effortCapNoThinking: 'high', // 实测:显式 disabled 时 xhigh/max 会 400
    note: '',
  },
  {
    re: /opus-4-6|sonnet-4-6/,
    tier: null,
    temperature: true,
    thinking: 'adaptive(推荐)/ enabled+budget(弃用)',
    effortLevels: NO_XHIGH,
    effortCapNoThinking: null,
    note: '',
  },
  {
    re: /opus-4-5/,
    tier: 'Opus',
    temperature: true,
    thinking: 'adaptive / enabled+budget',
    effortLevels: ['low', 'medium', 'high'],
    effortCapNoThinking: null,
    note: '旧款',
  },
  {
    re: /haiku/,
    tier: 'Haiku',
    temperature: true,
    thinking: 'enabled+budget_tokens',
    effortLevels: [], // 空数组 = 明确不支持,传了会 400
    effortCapNoThinking: null,
    note: '最快最省;订阅门禁豁免(免 CC system 前缀)',
  },
  {
    re: /sonnet-4-5|sonnet-4(?!-)/,
    tier: 'Sonnet',
    temperature: true,
    thinking: 'enabled+budget_tokens',
    effortLevels: [],
    effortCapNoThinking: null,
    note: '旧款',
  },
];

// 兜底(完全不认识的 id):按最保守的老模型规则,并标记 unknown 让前端提示。
// effortLevels 用 null 而不是 []:null=不知道,清洗时【不动】它;[]=明确不支持,该删。
// 两者混同会让未知新模型的 effort 被误删,那是比 400 更难查的静默降级。
const FALLBACK_RULE = {
  tier: '其它',
  temperature: true,
  thinking: '未知(建议留空不传)',
  effortLevels: null,
  effortCapNoThinking: null,
  note: '未识别的模型,参数规则为保守推断',
  unknown: true,
};

// effort 能力的人类可读描述。由 effortLevels 生成而非手写 —— 手写那份注定和数据漂移。
function effortLabel(levels, capNoThinking) {
  if (levels === null) return '未知(建议留空不传)';
  if (!levels.length) return '不支持(传了会 400)';
  const s = levels.join(' / ');
  return capNoThinking ? `${s}(thinking 显式 disabled 时上限 ${capNoThinking})` : s;
}

function tierOf(id) {
  const s = String(id || '').toLowerCase();
  if (/fable|mythos/.test(s)) return 'Fable';
  if (/opus/.test(s)) return 'Opus';
  if (/sonnet/.test(s)) return 'Sonnet';
  if (/haiku/.test(s)) return 'Haiku';
  return '其它';
}

// 由模型 id 推断能力元数据。任何来源(上游拉取/手填)的模型都走这里,不依赖写死清单。
export function inferModelMeta(id) {
  const s = String(id || '').toLowerCase();
  for (const r of CAPABILITY_RULES) {
    if (r.re.test(s)) {
      return {
        tier: r.tier || tierOf(s),
        temperature: r.temperature,
        thinking: r.thinking,
        effortLevels: r.effortLevels,
        effortCapNoThinking: r.effortCapNoThinking,
        effort: effortLabel(r.effortLevels, r.effortCapNoThinking), // 给前端展示
        note: r.note,
        unknown: false,
      };
    }
  }
  return {
    ...FALLBACK_RULE,
    tier: tierOf(s),
    effort: effortLabel(FALLBACK_RULE.effortLevels, null),
  };
}

// 内置种子清单:仅在"还没从上游拉取过"时作为初始列表展示(可被上游结果整体替换)。
export const SEED_MODEL_IDS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

// 兼容旧调用:把种子清单渲染成带元数据的目录
export const CATALOG = SEED_MODEL_IDS.map((id) => ({ id, ...inferModelMeta(id), source: 'builtin' }));

// 新家族 = 已移除 temperature/top_p/top_k 的模型(Fable、Opus 4.7+/5+、Sonnet 5+)。
// 正则与 CAPABILITY_RULES 同源,见 NEW_FAMILY_RE 上方注释里那次漂移事故。
export function isNewFamily(model) {
  return NEW_FAMILY_RE.test(String(model || '').toLowerCase());
}

export function isFable(model) {
  return FABLE_RE.test(String(model || '').toLowerCase());
}

export function isHaiku(model) {
  return /haiku/.test(String(model || '').toLowerCase());
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

  // 4) 参数清洗:剔除/降级会被上游 400 的参数与组合
  if (ov.stripUnsupported) {
    // 4a) 新家族已移除 temperature 系
    if (isNewFamily(model)) {
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
    // 4b) effort。三种会 400 的情形,都在这里摆平。
    //     注意必须放在 thinking 改写【之后】—— 下面第三条要看 thinking 的最终形态。
    //     也适用于老模型(Haiku 压根不认 effort),所以不在 isNewFamily 分支里。
    applyEffortRules(obj, model, changes);
  }

  // 5) 订阅门禁:非 Haiku 模型注入 Claude Code system 前缀
  if (ov.injectClaudeCodeSystem && !isHaiku(model)) {
    if (ensureCcSystem(obj)) changes.push('+ccSystem');
  }

  return changes;
}

// output_config.effort 的三条清洗规则(全部有实测依据,见文件头)。原地修改 obj。
//
// 为什么是"降级"而不是"删掉":客户端显式写了 effort,说明它在意输出质量档位;
// 而 thinking 是它同样显式写的。两个显式意图撞上了官方约束时,降 effort 是损失最小
// 的一侧 —— 官方的报错自己也是这么建议的("Use effort 'high' or below")。
// 反过来删掉 thinking 会让一个明确要求"别思考"的请求开始思考,更慢更贵,意外更大。
function applyEffortRules(obj, model, changes) {
  const oc = obj.output_config;
  const effort = oc && oc.effort;
  if (!effort) return;
  const { effortLevels, effortCapNoThinking } = inferModelMeta(model);
  if (effortLevels === null) return; // 未知模型:不猜,原样透传

  // 一、该模型压根不认这个参数(Haiku / Sonnet 4.5)
  if (!effortLevels.length) {
    delete oc.effort;
    if (!Object.keys(oc).length) delete obj.output_config; // 不留空对象
    changes.push('-effort(该模型不支持)');
    return;
  }

  // 二、档位不在支持列表里(如给 4.6 传 xhigh:它只有 low/medium/high/max)
  if (!effortLevels.includes(effort)) {
    const to = capTo(effortLevels, effort);
    oc.effort = to;
    changes.push(`effort:${effort}→${to}(该模型无此档)`);
  }

  // 三、thinking 被【显式】禁用时的额外上限。省略 thinking 不受此限,只有
  //     {type:"disabled"} 才会触发 —— Claude Code 某些内部请求(web 搜索那一跳)
  //     正是这个组合,不降级就整条链路 400。
  //     刻意不在第二条之后 return:两条可能同时适用,漏掉任一条就还是 400。
  if (
    effortCapNoThinking &&
    obj.thinking && obj.thinking.type === 'disabled' &&
    EFFORT_ORDER.indexOf(oc.effort) > EFFORT_ORDER.indexOf(effortCapNoThinking)
  ) {
    const to = capTo(effortLevels, effortCapNoThinking);
    changes.push(`effort:${oc.effort}→${to}(thinking 已显式禁用)`);
    oc.effort = to;
  }
}

// 在 levels 里取【不超过 want】的最高档。
// 关键是"不超过":客户端要 xhigh 而模型只有 …/high/max 时,给它 max 等于擅自
// 加钱加时延(max 比 xhigh 更高),那不叫清洗叫越权 —— 该给 high。
// 万一所有可用档都比 want 高(现实中不存在),退成最低档,总之不越权。
function capTo(levels, want) {
  const wi = EFFORT_ORDER.indexOf(want);
  const sorted = [...levels].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  const lower = sorted.filter((l) => EFFORT_ORDER.indexOf(l) <= wi);
  return lower.length ? lower[lower.length - 1] : sorted[0];
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

// 全局默认下发:所有客户端默认开启 Claude Code 身份伪装 + system 前缀注入 + 新模型参数清洗,
// 这样任何客户端(含自研)接订阅都开箱即稳。单个客户端可在管理台显式关掉(存 false 覆盖默认)。
//
// 注意:伪装/注入是为「订阅 OAuth 门禁」服务的 —— apiKey 模式(官方密钥/第三方网关)下
// 往用户的 system 里塞 "You are Claude Code" 只会白改提示词、毫无收益,因此这两项默认值
// 仅在订阅模式生效(显式 true 仍然尊重)。参数清洗与鉴权方式无关,始终默认开(它只在
// 请求本来就会被上游 400 时才动手)。
export const DEFAULT_OVERRIDES = Object.freeze({
  injectClaudeCodeSystem: true,
  spoofClaudeCode: true,
  stripUnsupported: true,
});
const SUBSCRIPTION_ONLY_DEFAULTS = ['injectClaudeCodeSystem', 'spoofClaudeCode'];

// 把「全局默认」与「该客户端的显式设置」合并成实际生效的下发规则。
// 显式 false 会覆盖默认 true(三态语义:未设置=用默认,true/false=显式)。
export function effectiveOverrides(clientOverrides, { subscription = true } = {}) {
  const defaults = { ...DEFAULT_OVERRIDES };
  if (!subscription) for (const k of SUBSCRIPTION_ONLY_DEFAULTS) delete defaults[k];
  return { ...defaults, ...(clientOverrides || {}) };
}

// 归一化并校验 overrides(管理台写入前调用)。布尔开关保留显式 false,以便覆盖全局默认。
export function normalizeOverrides(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  // A 兼容性
  if (o.model && typeof o.model === 'string') out.model = o.model.trim();
  if (['adaptive', 'disabled'].includes(o.thinking)) out.thinking = o.thinking;
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(o.effort)) out.effort = o.effort;
  for (const k of ['injectClaudeCodeSystem', 'stripUnsupported', 'spoofClaudeCode']) {
    if (typeof o[k] === 'boolean') out[k] = o[k]; // 显式 true / false 都记录
  }
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
