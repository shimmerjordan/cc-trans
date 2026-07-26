// 从 systemd/journald 的历史日志重建 data/metrics.json 与分块请求日志。
//
//   journalctl -u cc-trans --no-pager -o cat | node deploy/rebuild-metrics.mjs [--force] [--data-dir data]
//   node deploy/rebuild-metrics.mjs --file /path/to/saved.log
//
// 用途:裸机跑了一段时间后迁到 Docker(或 data/ 被误删),累计统计和请求日志
// 只剩 journald 里的文本行。这里把它们解析回结构化条目,喂给【线上同一套】
// createMetrics/createLogStore —— 聚合口径、成本估算、分块布局都与运行时一致,
// 不另写一份逻辑。
//
// 解析的行形如:
//   [2026-07-25T15:05:29.396Z] POST /v1/messages?beta=true 200 18917ms model=claude-opus-4-8 in=2 out=1131 cacheR=89979 cacheW=14278 [laptop]
//   [2026-07-14T15:02:41.825Z] POST /v1/messages?beta=true 0 125007ms model=claude-opus-4-8 (客户端已断开·…) [laptop]
// 历史日志里没有 IP/UA,所以「异常来源」的 IP/UA 列对这批数据是空的。

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createMetrics } from '../src/metrics.js';
import { createLogStore } from '../src/logstore.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const dataDir = path.resolve(val('--data-dir', 'data'));
const force = has('--force');
const srcFile = val('--file', null);
const metricsFile = path.join(dataDir, 'metrics.json');
const logsDir = path.join(dataDir, 'logs');

// 幂等保护:重复导入会把统计翻倍,所以已有数据时要显式 --force(会先备份)
const hasMetrics = fs.existsSync(metricsFile);
const hasLogs = fs.existsSync(logsDir) && fs.readdirSync(logsDir).length > 0;
if ((hasMetrics || hasLogs) && !force) {
  console.error('❌ 已存在指标/日志数据,重复导入会导致统计翻倍。');
  if (hasMetrics) console.error(`   ${metricsFile}`);
  if (hasLogs) console.error(`   ${logsDir}/`);
  console.error('   确认要重建就加 --force(会先备份现有数据)。');
  process.exit(1);
}
if (force) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  if (hasMetrics) {
    fs.renameSync(metricsFile, `${metricsFile}.bak-${stamp}`);
    console.log(`已备份 → ${path.basename(metricsFile)}.bak-${stamp}`);
  }
  if (hasLogs) {
    fs.renameSync(logsDir, `${logsDir}.bak-${stamp}`);
    console.log(`已备份 → logs.bak-${stamp}/`);
  }
}

// 保留期设得足够长,否则导入的历史块会被 sweepRetention 当过期数据清掉
const logStore = createLogStore({ dir: logsDir, retentionDays: 3650, log: () => {} });
const metrics = createMetrics({ persistFile: metricsFile, logStore, log: () => {} });

const LINE =
  /^\[(?<ts>\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s+(?<method>[A-Z]+)\s+(?<path>\S+)\s+(?<status>\d+)\s+(?<ms>\d+)ms(?<rest>.*)$/;
const num = (re, s) => {
  const m = s.match(re);
  return m ? Number(m[1]) : 0;
};

let scanned = 0;
let imported = 0;
let earliest = null;
let latest = null;
const perClient = new Map();

const input = srcFile ? fs.createReadStream(srcFile) : process.stdin;
const rl = readline.createInterface({ input, crlfDelay: Infinity });

for await (const line of rl) {
  scanned++;
  const m = LINE.exec(line);
  if (!m) continue;
  const g = m.groups;
  const rest = g.rest || '';

  // 只重建代理请求(管理台/健康检查等噪声不进统计,与运行时口径一致)
  if (!g.path.startsWith('/v1/')) continue;

  const ts = Date.parse(g.ts);
  if (!Number.isFinite(ts)) continue;

  const model = (rest.match(/\bmodel=(\S+)/) || [])[1] || null;
  const client = (rest.match(/\[([^\]]+)\]\s*$/) || [])[1] || null;

  metrics.record({
    ts,
    method: g.method,
    path: g.path,
    status: Number(g.status),
    ms: Number(g.ms),
    model,
    costModel: model,
    usage: {
      input: num(/\bin=(\d+)/, rest),
      output: num(/\bout=(\d+)/, rest),
      cacheRead: num(/\bcacheR=(\d+)/, rest),
      cacheWrite: num(/\bcacheW=(\d+)/, rest),
    },
    client,
    imported: true, // 标记来源,便于区分历史导入与实时记录
  });

  imported++;
  if (earliest == null || ts < earliest) earliest = ts;
  if (latest == null || ts > latest) latest = ts;
  perClient.set(client || '(unknown)', (perClient.get(client || '(unknown)') || 0) + 1);
}

metrics.flush();
logStore.flush();

// 累计起点改成最早那条请求的时间(否则概览会显示"统计自:脚本运行的这一刻")
if (earliest != null) {
  const j = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
  j.since = earliest;
  fs.writeFileSync(metricsFile, JSON.stringify(j), { mode: 0o600 });
}

const snap = metrics.snapshot();
const fmt = (ts) => (ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) : '—');
const spanDays = earliest ? Math.ceil((latest - earliest) / 86400000) : 0;

console.log(`扫描 ${scanned} 行,重建 ${imported} 条请求`);
console.log(`  时间跨度:${fmt(earliest)} → ${fmt(latest)}(${spanDays} 天,${snap.daily.length} 个日聚合)`);
console.log(`  累计:请求 ${snap.totals.requests} / 异常 ${snap.totals.errors}`);
console.log(
  `  token:in ${snap.totals.inTokens} · out ${snap.totals.outTokens} · ` +
    `cacheR ${snap.totals.cacheReadTokens} · cacheW ${snap.totals.cacheWriteTokens}`,
);
console.log(`  估算成本:$${(snap.totals.cost || 0).toFixed(2)}`);
for (const [name, n] of [...perClient.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  客户端 ${name}:${n} 条`);
}
console.log(`\n写入 ${metricsFile} 与 ${logsDir}/`);
if (spanDays > 14) {
  console.log(
    `⚠️  历史跨 ${spanDays} 天,但日志保留期默认 14 天 —— 容器启动后会清掉更早的块。\n` +
      `    想全留就把 config.json 的 logRetentionDays 调到 ${spanDays + 7} 以上。`,
  );
}
