// 可选的滚动文件日志(零依赖)。默认不启用 —— 交给 journald/docker 轮转;
// 需要独立文件日志(如 nohup 部署)时配 logFile,超过 maxBytes 自动轮转、只保留 maxFiles 个,控制磁盘占用。

import fs from 'node:fs';
import path from 'node:path';

export function createFileLogger({ logFile, logMaxBytes = 10 * 1024 * 1024, logMaxFiles = 5 } = {}) {
  if (!logFile) return null;
  let stream = null;
  let size = 0;

  function open() {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try {
      size = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    } catch {
      size = 0;
    }
    stream = fs.createWriteStream(logFile, { flags: 'a' });
    stream.on('error', () => {}); // 落盘失败不影响主流程
  }

  function rotate() {
    try {
      stream.end();
      // logFile -> logFile.1 -> logFile.2 ... 删掉最旧的
      const oldest = `${logFile}.${logMaxFiles - 1}`;
      if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
      for (let i = logMaxFiles - 2; i >= 1; i--) {
        const from = `${logFile}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${logFile}.${i + 1}`);
      }
      if (fs.existsSync(logFile)) fs.renameSync(logFile, `${logFile}.1`);
    } catch {
      /* 轮转失败就继续写原文件 */
    }
    open();
  }

  open();

  return {
    write(line) {
      if (!stream) return;
      const buf = Buffer.byteLength(line);
      if (size + buf > logMaxBytes) rotate();
      size += buf;
      stream.write(line);
    },
  };
}

// 递归统计目录字节数(用于磁盘占用上报,浅层即可)
export function dirSize(dir) {
  let total = 0;
  let files = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else {
          total += fs.statSync(p).size;
          files++;
        }
      } catch {
        /* 忽略单个文件错误 */
      }
    }
  };
  walk(dir);
  return { bytes: total, files };
}
