// 测试用的空闲端口分配。
//
// 为什么不写死端口:开发机上随时可能有别的服务正巧占着某个"看起来没人用"的端口
// (实测 18791 被一台无关网关占着)。撞上时症状极具误导性 —— 测试实例只是静默
// EADDRINUSE,而测试请求打到了那个陌生服务,拿回一个莫名的 401/404,
// 让人以为是鉴权或路由写错了。写死端口还会让两个套件悄悄共用同一个号
// (storage.mjs 与 inherit.mjs 都曾用 19981),只因串行跑才没出事。
import net from 'node:net';

// 一次拿 n 个互不相同的空闲端口。
//
// 必须【先全部占上、拿到号、再一起释放】:如果逐个 listen→close,内核完全可以把
// 刚释放的号再分配给下一次调用,于是两个"不同"的端口拿到同一个值,
// 表现又是一个莫名的 EADDRINUSE。
export async function freePorts(n) {
  const servers = await Promise.all(
    Array.from({ length: n }, () => new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => resolve(s));
    })),
  );
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

export async function freePort() {
  return (await freePorts(1))[0];
}
