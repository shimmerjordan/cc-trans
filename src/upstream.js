// 上游连接层:连接池(E)+ 代理(F)。
//
// 默认(不配代理):直接用 Node 内置全局 fetch —— 其底层 undici 默认就复用 keepalive 连接池,
// 对同一上游主机自动连接复用,零依赖、零配置即有连接池收益。
//
// 配了 upstreamProxy 时:按需动态加载 undici(仅代理场景需要 `npm i undici`,核心默认仍零依赖)。
//   - http:// | https://  → undici ProxyAgent
//   - socks5:// | socks://  → undici Agent + 自实现的 SOCKS5 CONNECT 连接器(node:net,无需 socks 库)
// 加载失败或无代理时回落到全局 fetch。

import net from 'node:net';

function parseProxy(u) {
  try {
    const url = new URL(u);
    return {
      protocol: url.protocol.replace(':', '').toLowerCase(), // http/https/socks5/socks
      host: url.hostname,
      port: Number(url.port) || (url.protocol.startsWith('socks') ? 1080 : 8080),
      username: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || ''),
    };
  } catch {
    return null;
  }
}

// SOCKS5 CONNECT:建立到 proxy 的 TCP,协商(可选用户名密码认证),请求 CONNECT dstHost:dstPort,
// 成功后回调裸 socket(若上游是 https,undici 会在其上完成 TLS)。零依赖实现。
function socks5Connector(proxy) {
  return function connect(opts, callback) {
    const dstHost = opts.hostname || opts.host;
    const dstPort = opts.port || (opts.protocol === 'https:' ? 443 : 80);
    const sock = net.connect(proxy.port, proxy.host);
    let stage = 'greeting';
    sock.on('error', (e) => callback(e));
    sock.once('connect', () => {
      // 问候:VER=5,支持 无认证(0) + 用户名密码(2)
      const methods = proxy.username ? [0x00, 0x02] : [0x00];
      sock.write(Buffer.from([0x05, methods.length, ...methods]));
    });
    sock.on('data', function onData(data) {
      try {
        if (stage === 'greeting') {
          if (data[0] !== 0x05) throw new Error('SOCKS5 版本错误');
          const method = data[1];
          if (method === 0x02) {
            const u = Buffer.from(proxy.username, 'utf8');
            const p = Buffer.from(proxy.password, 'utf8');
            sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
            stage = 'auth';
          } else if (method === 0x00) {
            sendConnect();
          } else {
            throw new Error('SOCKS5 不支持的认证方式 ' + method);
          }
        } else if (stage === 'auth') {
          if (data[1] !== 0x00) throw new Error('SOCKS5 认证失败');
          sendConnect();
        } else if (stage === 'connect') {
          if (data[1] !== 0x00) throw new Error('SOCKS5 CONNECT 失败,code=' + data[1]);
          sock.removeListener('data', onData);
          callback(null, sock);
        }
      } catch (e) {
        sock.destroy();
        callback(e);
      }
    });
    function sendConnect() {
      const hostBuf = Buffer.from(dstHost, 'utf8');
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        Buffer.from([(dstPort >> 8) & 0xff, dstPort & 0xff]),
      ]);
      stage = 'connect';
      sock.write(req);
    }
  };
}

// 返回 { fetch, dispatcher, describe }。dispatcher 为 undefined 时用全局连接池。
export async function initUpstream(config, log = () => {}) {
  const proxyUrl = config.upstreamProxy;
  if (!proxyUrl) {
    return { fetch: globalThis.fetch, dispatcher: undefined, describe: '直连(Node 内置连接池,keepalive 复用)' };
  }
  const p = parseProxy(proxyUrl);
  if (!p) {
    log(`⚠️ upstreamProxy 解析失败,忽略代理,直连: ${proxyUrl}`);
    return { fetch: globalThis.fetch, dispatcher: undefined, describe: '直连(代理配置无效)' };
  }
  let undici;
  try {
    undici = await import('undici');
  } catch {
    log(`⚠️ 配置了代理但未安装 undici —— 代理不生效,已回落直连。启用代理请: npm i undici`);
    return { fetch: globalThis.fetch, dispatcher: undefined, describe: '直连(缺 undici,代理未启用)' };
  }
  try {
    if (p.protocol === 'http' || p.protocol === 'https') {
      const token = p.username ? 'Basic ' + Buffer.from(`${p.username}:${p.password}`).toString('base64') : undefined;
      const dispatcher = new undici.ProxyAgent({ uri: `${p.protocol}://${p.host}:${p.port}`, token });
      return { fetch: undici.fetch, dispatcher, describe: `HTTP代理 ${p.host}:${p.port}` };
    }
    if (p.protocol === 'socks5' || p.protocol === 'socks') {
      const dispatcher = new undici.Agent({ connect: socks5Connector(p) });
      return { fetch: undici.fetch, dispatcher, describe: `SOCKS5代理 ${p.host}:${p.port}` };
    }
    log(`⚠️ 不支持的代理协议 ${p.protocol},回落直连`);
    return { fetch: globalThis.fetch, dispatcher: undefined, describe: '直连(代理协议不支持)' };
  } catch (err) {
    log(`⚠️ 代理初始化失败,回落直连: ${err.message}`);
    return { fetch: globalThis.fetch, dispatcher: undefined, describe: '直连(代理初始化失败)' };
  }
}
