// Claude 模型价格表(USD / 1M tokens),用于把 token 用量换算成 $ 成本。
// 数据来自 Anthropic 公开定价(2026-07);缓存写按 1.25×(5m)近似、缓存读按 0.1× 输入价。
// 只用于展示估算,非账单;订阅模式下并不真按量计费,成本仅供了解相对消耗。

// 每个条目:[输入价, 输出价]。缓存读=输入价×0.1,缓存写=输入价×1.25。
const PRICES = [
  [/fable-5|mythos-5/, 10, 50],
  [/opus-4-(8|7|6|5)/, 5, 25],
  [/opus-4/, 15, 75],
  [/sonnet-5/, 3, 15],
  [/sonnet-4-6/, 3, 15],
  [/sonnet-4-5/, 3, 15],
  [/sonnet-4/, 3, 15],
  [/sonnet/, 3, 15],
  [/haiku-4-5/, 1, 5],
  [/haiku-3-5/, 0.8, 4],
  [/haiku/, 0.25, 1.25],
  [/opus/, 15, 75],
];

// 返回 [输入价, 输出价] USD/1M;未知模型返回 null。
export function priceFor(model) {
  const m = String(model || '').toLowerCase();
  for (const [re, inp, out] of PRICES) if (re.test(m)) return [inp, out];
  return null;
}

// 由 usage {input, output, cacheRead, cacheWrite} + 模型算出 USD 成本;未知模型或无用量返回 0。
export function costOf(model, usage) {
  const p = priceFor(model);
  if (!p) return 0;
  const [inp, out] = p;
  const u = usage || {};
  const cost =
    ((u.input || 0) * inp +
      (u.output || 0) * out +
      (u.cacheRead || 0) * inp * 0.1 +
      (u.cacheWrite || 0) * inp * 1.25) /
    1_000_000;
  return cost;
}

export function fmtUsd(n) {
  n = n || 0;
  if (n === 0) return '$0';
  if (n < 0.01) return '$' + n.toFixed(4);
  if (n < 1) return '$' + n.toFixed(3);
  if (n < 100) return '$' + n.toFixed(2);
  return '$' + Math.round(n).toLocaleString();
}
