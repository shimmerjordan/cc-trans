// 从上游拉取模型列表并更新模型库。
//
// 抽出来是因为它现在有【两个入口】:管理台的「从上游拉取」,以及聊天页里
// 有 refreshModels 权限的普通用户。同一段逻辑复制两份的话,以后改上游拉取
// (换 limit、多取一个字段、换错误措辞)一定会漏掉其中一处。
//
// 它改写的是【全局共享】的模型库 —— 谁刷新,所有人下次拿到的就是新列表。
// 所以调用方必须先做权限判断,这里只管拉和写。
import { applyHops } from './hops.js';

export function createModelRefresher({ getUpstreamAuth, modelStore, log = () => {} }) {
  // 每次都取【当前】实例:管理台能热切换鉴权模式,缓存住就会拿着已经废弃的那个
  const upstreamNow = () => (typeof getUpstreamAuth === 'function' ? getUpstreamAuth() : null);

  // who 只进日志,用来分辨是管理台还是哪个用户点的
  async function refresh(who = '管理台') {
    try {
      const headers = { 'anthropic-version': '2023-06-01' };
      const up = upstreamNow();
      if (!up) throw new Error('上游鉴权未就绪');
      applyHops(headers, 0, up.baseUrl()); // 本机自己发起,从 0 跳起算
      await up.apply(headers); // 三种模式统一(inherit 也能拉列表 —— 上游那台会自己去问官方)
      const r = await fetch(up.baseUrl() + '/v1/models?limit=100', { headers });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 160)}`);
      const j = JSON.parse(text);
      // max_input_tokens 是上游对每个模型真实上下文上限的说法。丢掉它的话,
      // 聊天页那个"已用 x%"只能拿按 id 猜的 200k 当分母。
      const entries = (j.data || []).map((m) => ({
        id: m.id,
        displayName: m.display_name || m.id,
        maxInputTokens: m.max_input_tokens,
        maxOutputTokens: m.max_tokens,
      }));
      if (!entries.length) throw new Error('上游返回空列表');
      const { models, added, removed } = modelStore.replaceFromUpstream(entries);
      log(
        `模型列表已从上游更新(${who}): 共 ${models.length} 个` +
          `${added.length ? `,新增 ${added.join(', ')}` : ''}${removed.length ? `,移除 ${removed.join(', ')}` : ''}`,
      );
      return { ok: true, fetchedAt: Date.now(), models, added, removed };
    } catch (err) {
      // 这里【不抛】:拉取失败是常态(上游抽风、令牌过期),调用方一律回 200 带 ok:false,
      // 前端好把原因原样显示出来
      return { ok: false, error: err.message };
    }
  }

  return { refresh };
}
