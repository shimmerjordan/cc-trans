// 请求体参数清洗:哪些参数/组合会被上游 400,cc-trans 该怎么摆平。
//
// 这里每条断言背后都有一次真实上游的实测(见 src/models.js 文件头记录的原始报错)。
// 之所以用纯函数测而不是端到端:规则本身是纯函数,端到端只会把同一件事测得更慢,
// 而边界(每个模型 × 每个档位 × thinking 三态)在这里才铺得开。
//
// 最该盯住的是「两处正则漂移」那类 bug:CAPABILITY_RULES 已经认得 Opus 5,
// 而 isNewFamily 还停在 opus-4-[78],于是 opus-5 的 temperature 没被清洗、
// 客户端直接吃 400。所以下面对每个家族都同时断言"识别"与"清洗结果"。
import {
  applyOverrides,
  effectiveOverrides,
  normalizeOverrides,
  DEFAULT_OVERRIDES,
  inferModelMeta,
  isNewFamily,
  isFable,
  isHaiku,
  EFFORT_ORDER,
  CATALOG_VERSION,
  SEED_MODEL_IDS,
} from '../src/models.js';

const results = [];
const ck = (n, c, e = '') => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? ' — ' + e : ''}`); };

const STRIP = { stripUnsupported: true };
// 跑一遍清洗,回一个便于断言的摘要
function run(model, body, ov = STRIP) {
  const obj = { model, max_tokens: 8, messages: [{ role: 'user', content: 'x' }], ...body };
  const changes = applyOverrides(obj, ov);
  return {
    effort: obj.output_config ? obj.output_config.effort : undefined,
    hasOutputConfig: 'output_config' in obj,
    thinking: obj.thinking ? obj.thinking.type : undefined,
    hasThinking: 'thinking' in obj,
    temp: 'temperature' in obj,
    topP: 'top_p' in obj,
    changes,
    obj,
  };
}

// ── 1. 家族识别 ────────────────────────────────────────────────────────
// 新家族判定错了,后面所有清洗都会跟着错(且是静默的)。
{
  const NEW = ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-4-9', 'claude-opus-5',
               'claude-opus-5[1m]', 'claude-opus-6', 'claude-sonnet-5', 'claude-sonnet-6',
               'claude-fable-5', 'claude-mythos-1'];
  const OLD = ['claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5',
               'claude-sonnet-4', 'claude-haiku-4-5-20251001'];
  for (const id of NEW) ck(`1 新家族: ${id}`, isNewFamily(id) === true);
  for (const id of OLD) ck(`1 老模型: ${id}`, isNewFamily(id) === false);
  // 大小写不该影响判定(上游 id 一向小写,但客户端可能瞎传)
  ck('1 大写也认得', isNewFamily('CLAUDE-OPUS-5') === true);
  ck('1 Fable 判定', isFable('claude-fable-5') && isFable('claude-mythos-1') && !isFable('claude-opus-5'));
  ck('1 Haiku 判定', isHaiku('claude-haiku-4-5-20251001') && !isHaiku('claude-opus-5'));
}

// ── 2. 能力表内部一致 ──────────────────────────────────────────────────
// 手写的档位表容易和"thinking 禁用时的上限"对不上,那种矛盾在运行时表现为
// 降级到一个该模型并不支持的档位 —— 还是 400,而且更难查。
{
  const ids = [...SEED_MODEL_IDS, 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-brandnew-9'];
  let allOk = true;
  for (const id of ids) {
    const m = inferModelMeta(id);
    if (m.effortLevels === null) continue; // 未知模型
    for (const l of m.effortLevels) {
      if (!EFFORT_ORDER.includes(l)) { allOk = false; console.log(`  ${id} 有非法档位 ${l}`); }
    }
    if (m.effortCapNoThinking && !m.effortLevels.includes(m.effortCapNoThinking)) {
      allOk = false;
      console.log(`  ${id} 的 no-thinking 上限 ${m.effortCapNoThinking} 不在支持档位里`);
    }
  }
  ck('2 档位表与上限自相一致', allOk);
  ck('2 未知模型的档位是 null(不是空数组)', inferModelMeta('claude-brandnew-9').effortLevels === null);
  ck('2 Haiku 的档位是空数组(明确不支持)', Array.isArray(inferModelMeta('claude-haiku-4-5-20251001').effortLevels) && inferModelMeta('claude-haiku-4-5-20251001').effortLevels.length === 0);
  // 展示串由数据生成,不手写 —— 手写那份注定和数据漂移
  ck('2 effort 展示串含全部档位', inferModelMeta('claude-opus-5').effort.includes('xhigh'));
  ck('2 effort 展示串点明 thinking 上限', /thinking/.test(inferModelMeta('claude-opus-5').effort), inferModelMeta('claude-opus-5').effort);
  ck('2 Haiku 展示串说明会 400', /400/.test(inferModelMeta('claude-haiku-4-5-20251001').effort), inferModelMeta('claude-haiku-4-5-20251001').effort);
  ck('2 目录版本已随规则更新', CATALOG_VERSION >= '2026-07-30', CATALOG_VERSION);
}

// ── 3. temperature 系清洗(新家族已移除)──────────────────────────────
{
  const r = run('claude-opus-5', { temperature: 0.7, top_p: 0.9, top_k: 5 });
  ck('3 opus-5 清掉 temperature/top_p/top_k', !r.temp && !r.topP && !('top_k' in r.obj), r.changes.join(','));
  const old = run('claude-opus-4-6', { temperature: 0.7 });
  ck('3 老模型保留 temperature', old.temp === true);
  const off = run('claude-opus-5', { temperature: 0.7 }, { stripUnsupported: false });
  ck('3 关掉清洗就原样透传(哪怕会 400)', off.temp === true);
}

// ── 4. effort 规则一:模型压根不认这个参数 ─────────────────────────────
{
  const r = run('claude-haiku-4-5-20251001', { output_config: { effort: 'high' } });
  ck('4 Haiku 的 effort 被删掉', r.effort === undefined, r.changes.join(','));
  ck('4 空掉的 output_config 也一并删除(不留空对象)', r.hasOutputConfig === false);
  const keep = run('claude-haiku-4-5-20251001', { output_config: { effort: 'high', something_else: 1 } });
  ck('4 output_config 里还有别的字段则保留该对象', keep.hasOutputConfig === true && keep.effort === undefined && keep.obj.output_config.something_else === 1);
  const s45 = run('claude-sonnet-4-5', { output_config: { effort: 'low' } });
  ck('4 Sonnet 4.5 同样不认 effort', s45.effort === undefined);
}

// ── 5. effort 规则二:档位不在该模型的支持列表里 ───────────────────────
// 关键是"降"而不是"升":4.6 有 max 没 xhigh,要 xhigh 时给 max 等于擅自加钱加时延。
{
  const r = run('claude-opus-4-6', { output_config: { effort: 'xhigh' } });
  ck('5 4.6 的 xhigh 降到 high(不是 max)', r.effort === 'high', r.changes.join(','));
  const s46 = run('claude-sonnet-4-6', { output_config: { effort: 'xhigh' } });
  ck('5 sonnet-4-6 同理', s46.effort === 'high', s46.effort);
  const ok46 = run('claude-opus-4-6', { output_config: { effort: 'max' } });
  ck('5 4.6 的 max 是合法档位,不该动', ok46.effort === 'max' && ok46.changes.length === 0);
  const o45 = run('claude-opus-4-5', { output_config: { effort: 'max' } });
  ck('5 4.5 只到 high', o45.effort === 'high', o45.changes.join(','));
  const unknown = run('claude-brandnew-9', { output_config: { effort: 'xhigh' } });
  ck('5 未知模型不猜、原样透传', unknown.effort === 'xhigh' && unknown.changes.length === 0);
}

// ── 6. effort 规则三:thinking 显式禁用时的额外上限 ────────────────────
// 这就是「web 搜索突然不能用了」的真身。
{
  const bad = run('claude-opus-5', { output_config: { effort: 'xhigh' }, thinking: { type: 'disabled' } });
  ck('6 xhigh + 显式 disabled → 降到 high', bad.effort === 'high', bad.changes.join(','));
  ck('6 降级理由写进 changes(日志里能查)', bad.changes.some((c) => /thinking/.test(c)), bad.changes.join(','));
  ck('6 客户端的 thinking 意图被保留(没被偷偷打开)', bad.thinking === 'disabled');

  const maxBad = run('claude-opus-5', { output_config: { effort: 'max' }, thinking: { type: 'disabled' } });
  ck('6 max + 显式 disabled → 也降到 high', maxBad.effort === 'high');

  // 省略 thinking 不触发这条 —— 实测省略是合法的,误降就是白丢档位
  const omitted = run('claude-opus-5', { output_config: { effort: 'xhigh' } });
  ck('6 省略 thinking 时 xhigh 不该被动', omitted.effort === 'xhigh' && omitted.changes.length === 0);

  const adaptive = run('claude-opus-5', { output_config: { effort: 'xhigh' }, thinking: { type: 'adaptive' } });
  ck('6 adaptive 时 xhigh 不该被动', adaptive.effort === 'xhigh' && adaptive.changes.length === 0);

  const enabled = run('claude-opus-5', { output_config: { effort: 'xhigh' }, thinking: { type: 'enabled', budget_tokens: 1024 } });
  ck('6 enabled 被规范成 adaptive,effort 保持 xhigh', enabled.thinking === 'adaptive' && enabled.effort === 'xhigh', enabled.changes.join(','));

  const low = run('claude-opus-5', { output_config: { effort: 'high' }, thinking: { type: 'disabled' } });
  ck('6 上限内(high)不该被动', low.effort === 'high' && low.changes.length === 0);

  // 老模型没有这条约束
  const old46 = run('claude-opus-4-6', { output_config: { effort: 'max' }, thinking: { type: 'disabled' } });
  ck('6 4.6 无此约束,max + disabled 不动', old46.effort === 'max' && old46.changes.length === 0);
}

// ── 7. Fable 的 thinking 特例 ─────────────────────────────────────────
{
  const r = run('claude-fable-5', { thinking: { type: 'disabled' } });
  ck('7 Fable 的 disabled 被摘掉(它不接受)', r.hasThinking === false, r.changes.join(','));
  const withEffort = run('claude-fable-5', { output_config: { effort: 'xhigh' }, thinking: { type: 'disabled' } });
  ck('7 摘掉 thinking 后 effort 不再受上限约束', withEffort.effort === 'xhigh' && withEffort.hasThinking === false, withEffort.changes.join(','));
}

// ── 8. 下发注入与清洗的先后顺序 ───────────────────────────────────────
// override 注入的 effort 也必须被后面的清洗看到 —— 否则管理台配一个 xhigh
// 就能让所有 thinking-disabled 的请求 400,而且看不出是自己配出来的。
{
  const r = run('claude-opus-5', { thinking: { type: 'disabled' } }, { stripUnsupported: true, effort: 'xhigh' });
  ck('8 注入的 xhigh 也会被降级', r.effort === 'high', r.changes.join(','));
  const r2 = run('claude-haiku-4-5-20251001', {}, { stripUnsupported: true, effort: 'high' });
  ck('8 给 Haiku 注入 effort 会被清掉', r2.effort === undefined, r2.changes.join(','));
  // override 强制模型后,清洗要按【新】模型的规则走
  const r3 = run('claude-opus-4-6', { temperature: 0.5 }, { stripUnsupported: true, model: 'claude-opus-5' });
  ck('8 强制换模型后按新模型清洗', r3.temp === false && r3.obj.model === 'claude-opus-5', r3.changes.join(','));
}

// ── 9. thinking:必须尊重客户端的原生设置 ──────────────────────────────
// VSCode / Claude CLI 里那个思考开关是用户的显式意图。中转把它改掉,用户看到的
// 现象是"开关坏了"且毫无提示 —— 这种静默夺权比少个功能糟得多。
{
  const AUTO = { stripUnsupported: true, thinking: 'auto' };
  ck('9 全局默认就是 auto', DEFAULT_OVERRIDES.thinking === 'auto', String(DEFAULT_OVERRIDES.thinking));
  ck('9 effectiveOverrides 会带上 auto', effectiveOverrides({}).thinking === 'auto');
  ck('9 normalizeOverrides 接受 auto', normalizeOverrides({ thinking: 'auto' }).thinking === 'auto');
  ck('9 normalizeOverrides 拒绝乱值', normalizeOverrides({ thinking: 'nonsense' }).thinking === undefined);

  // 客户端传了什么就是什么
  const keepDisabled = run('claude-opus-5', { thinking: { type: 'disabled' } }, AUTO);
  ck('9 auto: 客户端的 disabled 被原样保留', keepDisabled.thinking === 'disabled', keepDisabled.changes.join(','));
  const keepAdaptive = run('claude-opus-5', { thinking: { type: 'adaptive' } }, AUTO);
  ck('9 auto: 客户端的 adaptive 被原样保留', keepAdaptive.thinking === 'adaptive');

  // 只在客户端没传时补,而且要看模型支不支持
  const fill = run('claude-opus-5', {}, AUTO);
  ck('9 auto: 未传 + 支持 → 补 adaptive', fill.thinking === 'adaptive', fill.changes.join(','));
  ck('9 auto: 补的时候写进 changes(日志可查)', fill.changes.some((c) => /未指定/.test(c)));
  for (const id of ['claude-haiku-4-5-20251001', 'claude-opus-4-5', 'claude-sonnet-4-5']) {
    const r = run(id, {}, AUTO);
    // 实测这些模型会 400 `adaptive thinking is not supported on this model`,
    // 无条件补就是把一个修复变成新 bug
    ck(`9 auto: 未传 + ${id} 不支持 adaptive → 不补`, r.hasThinking === false, JSON.stringify(r.changes));
  }
  const unknown = run('claude-brandnew-9', {}, AUTO);
  ck('9 auto: 未知模型保守不补', unknown.hasThinking === false);
  const o46 = run('claude-opus-4-6', {}, AUTO);
  ck('9 auto: 4.6 支持 → 补', o46.thinking === 'adaptive');

  // 强制档位仍然能覆盖客户端(管理员显式选了才覆盖)
  const forceA = run('claude-opus-5', { thinking: { type: 'disabled' } }, { stripUnsupported: true, thinking: 'adaptive' });
  ck('9 强制 adaptive 覆盖客户端的 disabled', forceA.thinking === 'adaptive', forceA.changes.join(','));
  const forceD = run('claude-opus-5', { thinking: { type: 'adaptive' } }, { stripUnsupported: true, thinking: 'disabled' });
  ck('9 强制 disabled 覆盖客户端的 adaptive', forceD.thinking === 'disabled', forceD.changes.join(','));
  const forceDFable = run('claude-fable-5', { thinking: { type: 'adaptive' } }, { stripUnsupported: true, thinking: 'disabled' });
  ck('9 强制 disabled 在 Fable 上改为移除', forceDFable.hasThinking === false, forceDFable.changes.join(','));

  // 与 effort 规则协同:保留 disabled 的同时把 xhigh 降下来
  const combo = run('claude-opus-5', { thinking: { type: 'disabled' }, output_config: { effort: 'xhigh' } }, AUTO);
  ck('9 auto + 客户端 disabled + xhigh → 保 disabled、降 effort', combo.thinking === 'disabled' && combo.effort === 'high', combo.changes.join(','));
  // 补了 adaptive 之后,xhigh 就不该被降(adaptive 下它是合法的)
  const combo2 = run('claude-opus-5', { output_config: { effort: 'xhigh' } }, AUTO);
  ck('9 auto 补 adaptive 后 xhigh 保持不动', combo2.thinking === 'adaptive' && combo2.effort === 'xhigh', combo2.changes.join(','));

  // adaptive 支持矩阵:逐个锁住实测结论(2026-07-30 真实上游打过)。
  // 不用"描述串里有没有 adaptive 这个词"来对账 —— 不支持的那几条描述恰好写着
  // 「不支持 adaptive」,关键词匹配会把它判成支持,那种断言只会自欺。
  const ADAPTIVE_EXPECT = {
    'claude-fable-5': true,
    'claude-opus-5': true,
    'claude-opus-4-8': true,
    'claude-sonnet-5': true,
    'claude-opus-4-6': true,
    'claude-sonnet-4-6': true,
    'claude-opus-4-5': false,
    'claude-sonnet-4-5': false,
    'claude-sonnet-4': false,
    'claude-haiku-4-5-20251001': false,
    'claude-brandnew-9': false, // 未知模型:保守
  };
  let matrixOk = true;
  for (const [id, want] of Object.entries(ADAPTIVE_EXPECT)) {
    const got = inferModelMeta(id).thinkingAdaptive;
    if (got !== want) { matrixOk = false; console.log(`  ${id}: thinkingAdaptive=${got},实测应为 ${want}`); }
  }
  ck('9 adaptive 支持矩阵与实测一致', matrixOk);
}

const fails = results.filter((x) => !x).length;
console.log(`\n${results.length - fails}/${results.length} 通过`);
process.exit(fails ? 1 : 0);
