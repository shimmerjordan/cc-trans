// 环路防护:用一个跳数头把「请求在 cc-trans 链路里绕圈」变成可检测的事。
//
// 为什么自环检测不够 —— upstream_auth.js 的自环检测只认得出「上游地址就是本机」
// 这一种形状,有两类环它抓不到:
//   1. **容器盲区**:容器里 os.networkInterfaces() 只有容器自己的地址(172.17.x.x),
//      settings.json 指向「宿主 IP:映射端口」时,它看不出那其实就是自己
//   2. **跨机器环**:A 的上游是 B,而 B 的上游又被配回了 A —— 单看任何一台都合法
// 两种情况下请求都会真的绕圈,每一跳都是一次完整的 HTTP 转发(连同请求体),
// 连接数与内存一起爆,而现场只看得到一串自己打给自己的请求。
// 跳数是唯一能兜住所有形状的办法:不需要知道拓扑,只需要知道走了几步。
//
// 客户端伪造这个头没有危害:填大了只会让自己的请求被拒。

export const HOPS_HEADER = 'x-cc-trans-hops';

// 请求已经走过的跳数。缺失 / 非数字 / 负数都当 0 —— 宁可少算,也别把正常请求拒掉。
export function readHops(headers) {
  if (!headers) return 0;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === HOPS_HEADER);
  if (!key) return 0;
  const n = Number.parseInt(String(headers[key]).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 1000); // 夹一下上界,别让伪造的天文数字流进算术
}

// 官方 API 不会把请求转回来,所以到官方那一跳没有环可防;而多带一个自定义头会削弱
// 身份伪装(spoofClaudeCode 的整个意义就是让上游看不出中间有代理)。
// 于是规则:上游是官方就【剥掉】这个头,否则递增带上 —— 自建链路里始终累加,
// 最后一跳自然清理干净,官方永远收不到它。
export function isOfficialUpstream(baseUrl) {
  try {
    return /(^|\.)anthropic\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false; // 地址解析不了就按"非官方"处理:带上头是安全的一侧
  }
}

// 在发往上游的请求头上落实跳数。headers 可能是从客户端原样复制来的,
// 所以先把任意大小写的旧值清干净,再决定要不要写新值。
export function applyHops(headers, incoming, baseUrl) {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === HOPS_HEADER) delete headers[k];
  }
  if (!isOfficialUpstream(baseUrl)) headers[HOPS_HEADER] = String(incoming + 1);
  return headers;
}

// 本机是第 incoming+1 跳。maxHops<=0 = 关闭防护(仍然递增头,链路里别人开着也能生效)。
export function hopsExceeded(incoming, maxHops) {
  const max = Number(maxHops);
  if (!Number.isFinite(max) || max <= 0) return false;
  return incoming + 1 > max;
}

export function loopMessage(incoming, maxHops) {
  return (
    `cc-trans: 检测到转发环路 —— 这个请求已经过 ${incoming} 跳 cc-trans,超过上限 ${maxHops}。` +
    `通常是上游被配回了链路里的某一台(常见于容器里 settings.json 指向「宿主 IP:映射端口」,` +
    `或两台机器互相把对方当上游)。请检查上游地址;确认拓扑本就需要更深的级联时,调大 maxHops。`
  );
}
