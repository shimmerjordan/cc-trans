// 模型列表存储:列表来源是「从上游 /v1/models 拉取」,拉取结果持久化到 data/models.json,
// 重启后仍在列表里。能力规则由 models.js 的 inferModelMeta 按 id 推断(所以新模型自动有规则)。
// 未拉取过时用内置种子清单兜底展示。

import fs from 'node:fs';
import path from 'node:path';
import { SEED_MODEL_IDS, inferModelMeta } from './models.js';

// 版本序:用于标出每个 tier 的「最新」。把 id 里的数字段拼成可比较的元组。
function versionKey(id) {
  const nums = String(id).match(/\d+/g) || [];
  // 日期后缀(8 位)不参与"版本大小"比较,只作为次级序
  const main = nums.filter((n) => n.length < 8).map(Number);
  const dated = nums.filter((n) => n.length >= 8).map(Number);
  return [main, dated];
}
function cmpVersion(a, b) {
  const [am, ad] = versionKey(a);
  const [bm, bd] = versionKey(b);
  for (let i = 0; i < Math.max(am.length, bm.length); i++) {
    const x = am[i] ?? -1;
    const y = bm[i] ?? -1;
    if (x !== y) return x - y;
  }
  const x = ad[0] ?? -1;
  const y = bd[0] ?? -1;
  return x - y;
}

// 给同 tier 内版本最高者打 latest
function markLatest(models) {
  const best = new Map(); // tier -> model
  for (const m of models) {
        const cur = best.get(m.tier);
    if (!cur || cmpVersion(m.id, cur.id) > 0) best.set(m.tier, m);
  }
  const latestIds = new Set([...best.values()].map((m) => m.id));
  for (const m of models) m.latest = latestIds.has(m.id);
  return models;
}

const TIER_ORDER = { Fable: 0, Opus: 1, Sonnet: 2, Haiku: 3, 其它: 4 };

function sortModels(models) {
  return models.sort((a, b) => {
    const t = (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9);
    if (t !== 0) return t;
    return cmpVersion(b.id, a.id); // 同层级新版在前
  });
}

// 由 id 列表构造带元数据的模型条目
function build(entries, source) {
  return entries.map((e) => {
    const id = typeof e === 'string' ? e : e.id;
    const displayName = (typeof e === 'object' && (e.displayName || e.display_name)) || id;
    return { id, displayName, source, ...inferModelMeta(id) };
  });
}

export function createModelStore({ persistFile = null, log = () => {} } = {}) {
  let state = null; // { fetchedAt, models: [] } —— null 表示还没拉取过

  if (persistFile) {
    try {
      if (fs.existsSync(persistFile)) {
        const j = JSON.parse(fs.readFileSync(persistFile, 'utf8'));
        if (Array.isArray(j.models) && j.models.length) {
          // 元数据用当前代码的规则重算(规则升级后旧盘数据也能跟上)
          state = {
            fetchedAt: j.fetchedAt || null,
            models: sortModels(markLatest(build(j.models, 'upstream'))),
          };
        }
      }
    } catch (err) {
      log(`⚠️ 模型列表读取失败(忽略,用内置种子): ${err.message}`);
    }
  }

  function save() {
    if (!persistFile || !state) return;
    try {
      fs.mkdirSync(path.dirname(persistFile), { recursive: true });
      const tmp = `${persistFile}.tmp.${process.pid}`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          version: 1,
          fetchedAt: state.fetchedAt,
          models: state.models.map((m) => ({ id: m.id, displayName: m.displayName })),
        }, null, 2),
        { mode: 0o600 },
      );
      fs.renameSync(tmp, persistFile);
    } catch (err) {
      log(`⚠️ 模型列表落盘失败: ${err.message}`);
    }
  }

  // 当前列表:拉取过就用持久化的,否则用内置种子
  function list() {
    if (state) return { fetchedAt: state.fetchedAt, fromUpstream: true, models: state.models };
    return { fetchedAt: null, fromUpstream: false, models: sortModels(markLatest(build(SEED_MODEL_IDS, 'builtin'))) };
  }

  // 用上游拉取结果整体替换列表并落盘。返回 { models, added, removed }
  function replaceFromUpstream(liveEntries) {
    const before = new Set((state ? state.models : build(SEED_MODEL_IDS, 'builtin')).map((m) => m.id));
    const models = sortModels(markLatest(build(liveEntries, 'upstream')));
    const after = new Set(models.map((m) => m.id));
    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));
    state = { fetchedAt: Date.now(), models };
    save();
    return { models, added, removed };
  }

  // 手动补一个模型(上游 /v1/models 不可用时的兜底入口)
  function addManual(id) {
    const clean = String(id || '').trim();
    if (!clean) return null;
    const cur = state ? state.models : build(SEED_MODEL_IDS, 'builtin');
    if (cur.some((m) => m.id === clean)) return { models: cur, added: [] };
    const models = sortModels(markLatest([...cur, ...build([clean], 'manual')]));
    state = { fetchedAt: state ? state.fetchedAt : null, models };
    save();
    return { models, added: [clean] };
  }

  function remove(id) {
    const cur = state ? state.models : build(SEED_MODEL_IDS, 'builtin');
    const models = cur.filter((m) => m.id !== id);
    if (models.length === cur.length) return null;
    state = { fetchedAt: state ? state.fetchedAt : null, models: sortModels(markLatest(models)) };
    save();
    return { models: state.models };
  }

  return { list, replaceFromUpstream, addManual, remove };
}
