// 以 root 入场修好挂载卷属主后,用它降权再拉起真正的入口。
// 为什么不用 su-exec/gosu:那要 apk 联网安装,而本项目坚持零外部依赖 ——
// Node 自带 setgid/setuid,足够干这件事。
//
//   DROP_UID=1000 DROP_GID=1000 node drop-privs.mjs /app/src/server.js [args...]
const uid = Number(process.env.DROP_UID);
const gid = Number(process.env.DROP_GID);
const entry = process.argv[2];

if (!entry) {
  console.error('[drop-privs] 缺少入口参数');
  process.exit(2);
}

if (process.getuid?.() === 0 && Number.isInteger(uid) && uid > 0) {
  try {
    // 顺序要紧:先丢掉附加组和 gid,再丢 uid(反过来就没权限改组了)
    try {
      process.setgroups?.([gid]);
    } catch {
      /* 内核/平台不支持时忽略,不影响主降权 */
    }
    process.setgid(gid);
    process.setuid(uid);
  } catch (err) {
    console.error(`[drop-privs] 降权到 ${uid}:${gid} 失败,继续以 root 运行:${err.message}`);
  }
}

// 入口自己读 process.argv,把 argv[2] 起的参数原样留给它
process.argv.splice(1, 2, entry);
const { pathToFileURL } = await import('node:url');
await import(pathToFileURL(entry).href);
