// 数据目录的占用统计与清理。
//
// 两条原则:
//  1. **分类必须盖满整个 dataDir**,认不出来的归「其它」—— 各类之和对不上目录总量的话,
//     这个面板就没人敢信,还不如不做。
//  2. **只给"删了确实不影响服务"的东西配按钮**。metrics.json 才 8KB,给它一个
//     清空按钮除了丢历史没有任何收益,那不是清理,是脚枪。
//
// 目录布局的知识尽量留在各自的模块里(日志问 logStore、聊天问 chatStore),
// 这里只做汇总与派发。

import fs from 'node:fs';
import path from 'node:path';

// 递归统计大小与文件数。
// 用 lstat 且不进符号链接:跟进去既可能绕圈,也会把目录外的东西算进本目录。
export function du(target) {
  let bytes = 0;
  let files = 0;
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let ents = [];
      try {
        ents = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const e of ents) walk(path.join(p, e));
      return;
    }
    if (st.isFile()) {
      bytes += st.size;
      files++;
    }
  };
  walk(target);
  return { bytes, files };
}

// p 是否在 base 之下。用 relative 判,别用 startsWith —— `/data-old` 会被
// `/data` 的前缀匹配骗过去。
function isInside(base, p) {
  const rel = path.relative(path.resolve(base), path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function sizeOf(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

// 磁盘余量。statfsSync 是 Node 18.15+ 才有的,老版本上就当拿不到。
function diskOf(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize; // bavail:非特权用户真正能用的
    if (!Number.isFinite(total) || total <= 0) return null;
    return { total, free, used: total - free, usedPct: Math.round(((total - free) / total) * 100) };
  } catch {
    return null;
  }
}

export function createStorage({ dataDir, chatStore, logStore, configFile, logFile, log = () => {} } = {}) {
  const enabled = !!dataDir;

  const chatsDir = () => (dataDir ? path.join(dataDir, 'chats') : null);

  // 配置备份:import-config.sh / 迁移留下的 config.json.bak-YYYYMMDD-HHMMSS
  function backupFiles() {
    if (!dataDir) return [];
    // 认两个前缀:当前配置文件名,以及约定的 config.json
    // (import-config.sh 写的是 <目标>.bak-*,而目标在 Docker 里就叫 config.json;
    //  但配置文件可以改名/放在别处,只认其中一个都会漏)
    const bases = new Set(['config.json']);
    if (configFile) bases.add(path.basename(configFile));
    try {
      return fs
        .readdirSync(dataDir)
        .filter((n) => [...bases].some((b) => n.startsWith(b + '.bak-')))
        .map((n) => path.join(dataDir, n));
    } catch {
      return [];
    }
  }

  // 进程日志(logger.js 的滚动文件):当前文件 + .1 .2 … 轮转件
  function procLogFiles() {
    if (!logFile) return { current: [], rotated: [] };
    const dir = path.dirname(logFile);
    const base = path.basename(logFile);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return { current: [], rotated: [] };
    }
    const current = names.filter((n) => n === base).map((n) => path.join(dir, n));
    const rotated = names.filter((n) => n !== base && n.startsWith(base + '.')).map((n) => path.join(dir, n));
    return { current, rotated };
  }

  // 聊天:会话 JSON 与图片分开算 —— 它们的清理方式完全不同
  function chatBreakdown() {
    const cd = chatsDir();
    const out = { sessionBytes: 0, sessionFiles: 0, sessionCount: 0, mediaBytes: 0, mediaFiles: 0, users: [], orphanFiles: 0, orphanBytes: 0 };
    if (!cd || !fs.existsSync(cd)) return out;
    const users = chatStore && chatStore.listUsers ? chatStore.listUsers() : [];
    for (const u of users) {
      // 会话数按索引算,不按文件数 —— 空的 index.json 也是一个文件,
      // 拿文件数当判据会在"一个会话都没有"时给出一个点了没反应的清空按钮
      out.sessionCount += chatStore.list(u).length;
      const ud = path.join(cd, u);
      const md = path.join(ud, 'media');
      const all = du(ud);
      const media = fs.existsSync(md) ? du(md) : { bytes: 0, files: 0 };
      out.sessionBytes += all.bytes - media.bytes;
      out.sessionFiles += all.files - media.files;
      out.mediaBytes += media.bytes;
      out.mediaFiles += media.files;
      out.users.push({ name: u, bytes: all.bytes, files: all.files, mediaBytes: media.bytes, mediaFiles: media.files });
    }
    return out;
  }

  // 孤儿图片:没有任何会话引用、且已过宽限期的。
  // 走 chatStore 的 dryRun 清扫,不在这儿另写一套判定 —— 面板报的"可清理 N 张"
  // 必须和点下去真删的数量一致,两套判定迟早会分叉。
  // 要读全部会话,比 du 贵,所以只在需要展示"能省多少"时调用。
  function orphanScan() {
    const out = { files: 0, bytes: 0, pending: 0, byUser: [] };
    if (!chatStore || !chatStore.sweepOrphanMedia) return out;
    for (const u of chatStore.listUsers()) {
      const r = chatStore.sweepOrphanMedia(u, { dryRun: true });
      if (!r.ok) continue;
      if (r.removed) out.byUser.push({ name: u, files: r.removed, bytes: r.bytes });
      out.files += r.removed;
      out.bytes += r.bytes;
      out.pending += r.skippedRecent || 0;
    }
    return out;
  }

  function scan({ withOrphans = true } = {}) {
    if (!enabled) return { enabled: false };

    const logs = logStore && logStore.stats ? logStore.stats() : { enabled: false, bytes: 0, blocks: 0 };
    const chat = chatBreakdown();
    const orphans = withOrphans ? orphanScan() : { files: 0, bytes: 0, byUser: [] };
    const backups = backupFiles();
    const proc = procLogFiles();

    const metricsFile = path.join(dataDir, 'metrics.json');
    const modelsFile = path.join(dataDir, 'models.json');
    const cfgFile = configFile && path.dirname(configFile) === dataDir ? configFile : null;

    const backupBytes = backups.reduce((a, f) => a + sizeOf(f), 0);
    const procCurBytes = proc.current.reduce((a, f) => a + sizeOf(f), 0);
    const procRotBytes = proc.rotated.reduce((a, f) => a + sizeOf(f), 0);

    const cats = [
      {
        key: 'logs',
        name: '请求日志',
        desc: `按日期/小时分块${logs.days ? ` · ${logs.days} 天 / ${logs.blocks} 块` : ''}`,
        bytes: logs.bytes || 0,
        files: logs.blocks || 0,
        clean: logs.bytes ? 'dialog' : null, // 走「实时日志」页已有的清理对话框
        cleanLabel: '清理…',
        note: `保留 ${logs.retentionDays || 0} 天后自动过期`,
      },
      {
        key: 'chatMedia',
        name: '聊天图片',
        desc: `上传的图片,按内容寻址去重${orphans.files ? ` · 其中 ${orphans.files} 张已无人引用` : ''}`,
        bytes: chat.mediaBytes,
        files: chat.mediaFiles,
        clean: orphans.files ? 'orphans' : null,
        cleanLabel: `清理孤儿图片(${fmtShort(orphans.bytes)})`,
        confirm: `删除 ${orphans.files} 张没有任何会话引用、且已放置 1 小时以上的图片`,
        reclaimable: orphans.bytes,
        note: orphans.files
          ? '只删没有任何会话引用、且已放置 1 小时以上的'
          : orphans.pending
            ? `${orphans.pending} 张刚上传还没发送,过 1 小时后才会被算作孤儿`
            : '没有可回收的孤儿图片',
      },
      {
        key: 'chatSessions',
        name: '聊天会话',
        desc: chat.sessionCount ? `${chat.users.length} 个用户 · ${chat.sessionCount} 个会话` : '暂无会话',
        bytes: chat.sessionBytes,
        files: chat.sessionFiles,
        clean: chat.sessionCount ? 'all' : null,
        cleanLabel: '清空全部会话',
        confirm: '删除所有用户的全部聊天会话,连同这些会话里的配图',
        danger: true,
        note: '清空会连同这些会话的图片一起删掉',
      },
      {
        key: 'procLog',
        name: '进程日志',
        desc: logFile ? `${path.basename(logFile)}(当前 + ${proc.rotated.length} 个轮转件)` : '未启用文件日志(交给 journald / docker)',
        bytes: procCurBytes + procRotBytes,
        files: proc.current.length + proc.rotated.length,
        clean: proc.rotated.length ? 'rotated' : null,
        cleanLabel: `删除 ${proc.rotated.length} 个轮转件`,
        confirm: `删除 ${proc.rotated.length} 个已轮转的日志文件(当前正在写的那个不动)`,
        reclaimable: procRotBytes,
        note: '只删轮转件,当前正在写的那个不动',
      },
      {
        key: 'backups',
        name: '配置备份',
        desc: backups.length ? `${backups.length} 个 .bak-* 文件` : '无',
        bytes: backupBytes,
        files: backups.length,
        clean: backups.length ? 'all' : null,
        cleanLabel: '删除备份',
        confirm: `删除 ${backups.length} 个配置快照(当前生效的 config.json 不动)`,
        note: '迁移/导入配置时留下的快照',
      },
      {
        key: 'metrics',
        name: '累计统计',
        desc: 'metrics.json —— 概览上那些数字的来源',
        bytes: sizeOf(metricsFile),
        files: fs.existsSync(metricsFile) ? 1 : 0,
        clean: null,
        note: '几 KB 而已,清空只会丢历史、省不出空间,所以不提供按钮',
      },
      {
        key: 'models',
        name: '模型目录',
        desc: 'models.json —— 从上游拉取的可用模型',
        bytes: sizeOf(modelsFile),
        files: fs.existsSync(modelsFile) ? 1 : 0,
        clean: null,
        note: '随时可在「模型/参数」页重新拉取',
      },
      {
        key: 'config',
        name: '配置',
        desc: cfgFile ? path.basename(cfgFile) : '不在数据目录内',
        bytes: cfgFile ? sizeOf(cfgFile) : 0,
        files: cfgFile ? 1 : 0,
        clean: null,
        note: '令牌、账号、参数下发都在里面',
      },
    ];

    // 兜底:目录总量减去已归类的,剩下的就是「其它」。这一项存在的意义是让
    // 各类之和永远等于 du 的结果 —— 对不上就说明有东西没被看见。
    // 注意进程日志可能配在 dataDir 之外(那它就不该计入本目录的归类)。
    const total = du(dataDir);
    const procInside = !!(logFile && isInside(dataDir, logFile));
    const outside = new Set(procInside ? [] : ['procLog']);
    const classified = cats.reduce((a, c) => a + (outside.has(c.key) ? 0 : c.bytes), 0);
    const classifiedFiles = cats.reduce((a, c) => a + (outside.has(c.key) ? 0 : c.files), 0);
    cats.push({
      key: 'other',
      name: '其它',
      desc: '数据目录里未归类的文件',
      bytes: Math.max(0, total.bytes - classified),
      files: Math.max(0, total.files - classifiedFiles),
      clean: null,
      note: '认不出来的东西不给一键删按钮',
    });

    return {
      enabled: true,
      dataDir,
      totalBytes: total.bytes,
      totalFiles: total.files,
      reclaimableBytes: orphans.bytes + backupBytes + procRotBytes,
      disk: diskOf(dataDir),
      categories: cats,
      orphans,
    };
  }

  // 清理派发。返回释放的字节数 —— 用户点完得看见"省了多少",否则不知道有没有生效。
  function prune(key, mode) {
    if (!enabled) return { ok: false, error: '未启用数据目录' };
    const before = du(dataDir).bytes;

    if (key === 'chatMedia' && mode === 'orphans') {
      let removed = 0;
      const users = chatStore && chatStore.listUsers ? chatStore.listUsers() : [];
      for (const u of users) {
        const r = chatStore.sweepOrphanMedia(u);
        removed += (r && r.removed) || 0;
      }
      const freed = before - du(dataDir).bytes;
      log(`[storage] 清理孤儿图片:${removed} 张,释放 ${fmtShort(freed)}`);
      return { ok: true, removed, freed, message: `已删除 ${removed} 张无人引用的图片` };
    }

    if (key === 'chatSessions' && mode === 'all') {
      let removed = 0;
      const users = chatStore && chatStore.listUsers ? chatStore.listUsers() : [];
      for (const u of users) {
        removed += chatStore.list(u).length;
        chatStore.clear(u);
      }
      const freed = before - du(dataDir).bytes;
      log(`[storage] 清空全部聊天会话:${removed} 个,释放 ${fmtShort(freed)}`);
      return { ok: true, removed, freed, message: `已清空 ${removed} 个会话及其图片` };
    }

    if (key === 'backups' && mode === 'all') {
      let removed = 0;
      for (const f of backupFiles()) {
        try {
          fs.unlinkSync(f);
          removed++;
        } catch {
          /* ignore */
        }
      }
      const freed = before - du(dataDir).bytes;
      log(`[storage] 删除配置备份:${removed} 个,释放 ${fmtShort(freed)}`);
      return { ok: true, removed, freed, message: `已删除 ${removed} 个配置备份` };
    }

    if (key === 'procLog' && mode === 'rotated') {
      const { rotated } = procLogFiles();
      let removed = 0;
      let freed = 0;
      for (const f of rotated) {
        const s = sizeOf(f);
        try {
          fs.unlinkSync(f);
          removed++;
          freed += s;
        } catch {
          /* ignore */
        }
      }
      log(`[storage] 删除进程日志轮转件:${removed} 个,释放 ${fmtShort(freed)}`);
      return { ok: true, removed, freed, message: `已删除 ${removed} 个轮转日志文件` };
    }

    return { ok: false, error: `不支持的清理操作:${key}/${mode}` };
  }

  return { enabled, scan, prune, orphanScan };
}

// 服务端日志里用的短格式(前端有自己那份,这里不共享是为了不给 storage.js 引前端代码)
function fmtShort(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
