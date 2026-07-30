// 上游鉴权的统一抽象。三种模式共用一个接口,所有注入点只认这个接口。
//
// 为什么要有这一层:凭证注入的 if/else 阶梯曾在三处各写一遍 —— 主转发
// (server.js)、管理台拉模型列表、订阅用量 —— 加一种模式就得三处同步改,
// 漏掉一处的症状是「转发正常但管理台刷新模型列表 401」,极难定位。
//
//   oauth   订阅登录态:读本机 ~/.claude/.credentials.json,到期自动刷新(见 oauth.js)
//   apiKey  静态密钥:官方 API Key(x-api-key)或第三方网关的 token(Bearer)
//   inherit 继承本机 Claude Code 配置:从 ~/.claude/settings.json 的 env 段读出
//           ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN,把自己变成级联中转 ——
//           本机 claude 连的是哪台 cc-trans,这台就往那台转。对方换令牌/换地址,
//           改的是同一份 settings.json,这边下一个请求自动跟上,不用抄第二遍。
//
// 接口约定(两条,别打破):
//   apply()   是权威校验点,读不到/配错了就【抛】—— 三个调用点都已把它翻译成
//             502 + 明确文案。
//   baseUrl() 永不抛,失败时回落到上一次已知的地址 —— 它只负责给地址,报错是
//             apply() 的职责。两者都抛会让同一个错在一次请求里报两遍。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOAuthProvider, homeDir, resolveLocalFile } from './oauth.js';
import { cleanToken } from './config.js';

const SETTINGS_LABEL = '本机 Claude Code 配置';

export function defaultSettingsPath() {
  return path.join(homeDir(), '.claude', 'settings.json');
}

function mask(t) {
  if (!t) return 'none';
  if (t.length <= 8) return '***';
  return t.slice(0, 6) + '…' + t.slice(-4);
}

// 带 code 的错误:调用方(管理台/测试)靠 code 区分是权限、断链还是压根没配
function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// 本机所有地址(含回环)。自环检测要认全:127.0.0.1 和内网 IP 都是"自己"。
function localAddresses() {
  const out = new Set(['localhost', '0.0.0.0', '::', '::1']);
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) out.add(String(ni.address).toLowerCase());
  }
  return out;
}

// settings.json 的 ANTHROPIC_BASE_URL 指回 cc-trans 自己 = 每个请求都会在本进程里
// 无限套娃(转给自己 → 再读同一份 settings.json → 再转给自己)。表现是连接数与内存
// 一起爆掉,日志里只看得到一串自己打给自己的请求 —— 没人能从那个现场看懂发生了什么,
// 所以必须在配置阶段就拦住。
export function detectSelfLoop(baseUrl, selfPort) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    return false; // 地址本身非法,交给上层报"不是合法 URL"
  }
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  if (port !== Number(selfPort)) return false;
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6 字面量
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^127\./.test(host)) return true; // 整个 127.0.0.0/8
  return localAddresses().has(host);
}

// 读 ~/.claude/settings.json,解析出上游三元组。按 mtime+size 缓存:热路径上每个
// 请求都会走到这里,不重复解析 JSON;而用文件时间而非定时 TTL,是为了「改完文件
// 下一个请求就生效」—— inherit 的全部价值就在这个跟随上,让人等一个 TTL 就没意义了。
function createInheritSource({ file, selfPort, log }) {
  let cache = null; // { key: 'mtimeMs:size', value }

  function load() {
    const { real, viaLink } = resolveLocalFile(file, {
      label: SETTINGS_LABEL,
      bareHint: '裸机上则是这台机器还没建过 ~/.claude/settings.json',
    });
    const st = fs.statSync(real);
    const key = `${st.mtimeMs}:${st.size}`;
    if (cache && cache.key === key) return cache.value;

    // 读盘与解析【分开报】。合在一起时权限不足会被说成"JSON 不合法",人就去查
    // 文件内容了 —— 而真正的原因是运行用户读不了它(容器 PUID 设错、systemd 换了用户)。
    let raw;
    try {
      raw = fs.readFileSync(real, 'utf8');
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        const uid = process.getuid ? process.getuid() : '?';
        throw fail(
          err.code,
          `${SETTINGS_LABEL}读不了(当前 uid=${uid},权限不足): ${real} —— Docker 里用 PUID/PGID ` +
            `对齐宿主机 ~/.claude 的属主;裸机部署请让服务运行用户能读该文件`,
        );
      }
      throw fail(err.code || 'EUNKNOWN', `读取${SETTINGS_LABEL}失败 ${real}: ${err.message}`);
    }
    let j;
    try {
      j = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${SETTINGS_LABEL}不是合法 JSON ${real}: ${err.message}`);
    }
    const env = (j && typeof j.env === 'object' && j.env) || {};
    const baseUrl = String(env.ANTHROPIC_BASE_URL || '')
      .trim()
      .replace(/\/+$/, '');
    const authToken = cleanToken(env.ANTHROPIC_AUTH_TOKEN);
    const apiKey = cleanToken(env.ANTHROPIC_API_KEY);

    if (!baseUrl) {
      throw new Error(
        `${SETTINGS_LABEL}里没有 env.ANTHROPIC_BASE_URL: ${real} —— inherit 模式的前提是` +
          `本机 Claude Code 已经指向某个上游(通常是内网另一台 cc-trans);` +
          `本机直连官方的话请改用 oauth(转发订阅)或 apiKey(静态密钥)模式`,
      );
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error(`${SETTINGS_LABEL}的 ANTHROPIC_BASE_URL 不是 http(s) 地址: ${baseUrl}(${real})`);
    }
    if (!authToken && !apiKey) {
      throw new Error(
        `${SETTINGS_LABEL}里 env.ANTHROPIC_AUTH_TOKEN 和 ANTHROPIC_API_KEY 都是空的: ${real} —— ` +
          `本机 claude 连上游用的令牌就是这台要转发的凭证,少了它转发无从鉴权`,
      );
    }
    if (detectSelfLoop(baseUrl, selfPort)) {
      throw new Error(
        `${SETTINGS_LABEL}的 ANTHROPIC_BASE_URL 指回了 cc-trans 自己(${baseUrl},本机端口 ${selfPort})` +
          ` —— 会无限自环。inherit 模式要求本机 claude 直连【真正的】上游(另一台机器的 ` +
          `cc-trans,或官方 API);若想让本机 claude 也走本地 cc-trans,请改用 apiKey 模式` +
          `手填上游地址与令牌`,
      );
    }

    const value = {
      baseUrl,
      via: authToken ? 'auth-token' : 'api-key',
      token: authToken || apiKey,
      file,
      real,
      viaLink,
    };
    // 上游被"别处的一个文件"改掉了,日志里得留下痕迹 —— 否则「什么时候换的上游」无从追查。
    // mtime 没变就命中缓存直接返回了,这里不会刷屏。
    if (cache) {
      if (cache.value.baseUrl !== value.baseUrl) {
        log(`inherit: 上游地址跟随 ${real} 变更 ${cache.value.baseUrl} → ${value.baseUrl}`);
      } else if (cache.value.token !== value.token) {
        log(`inherit: 上游令牌跟随 ${real} 变更(${mask(cache.value.token)} → ${mask(value.token)})`);
      }
    }
    cache = { key, value };
    return value;
  }

  return { load, lastKnown: () => (cache ? cache.value : null) };
}

// 只读探查某个 settings.json 能不能用(管理台"检测"按钮 / 切换模式前的校验)。不抛。
export function inspectInheritSettings(file, selfPort) {
  const f = file || defaultSettingsPath();
  try {
    const src = createInheritSource({ file: f, selfPort, log: () => {} });
    const v = src.load();
    return {
      ok: true,
      file: f,
      real: v.real,
      viaLink: v.viaLink,
      baseUrl: v.baseUrl,
      via: v.via,
      tokenMask: mask(v.token),
    };
  } catch (err) {
    return { ok: false, file: f, error: err.message, code: err.code || null };
  }
}

export function createUpstreamAuth({ config, log = () => {} }) {
  const kind = config.upstreamAuth;

  if (kind === 'inherit') {
    const file = config.inheritSettingsPath || defaultSettingsPath();
    const src = createInheritSource({ file, selfPort: config.port, log });
    // 启动时先探一次:配置错了要在启动阶段一次说清,而不是等第一个请求吃 502。
    // 抛出的错由调用方(server.js)打印后退出,与其它配置错误同样的待遇。
    const first = src.load();
    config.upstreamBaseUrl = first.baseUrl;

    const current = () => {
      const v = src.load();
      // 展示类代码(/health、banner、管理台 status)直接读 config.upstreamBaseUrl,
      // 同步一份过去,它们就不必知道 inherit 这回事。内存字段,不写盘。
      config.upstreamBaseUrl = v.baseUrl;
      return v;
    };

    return {
      kind,
      isSubscription: false,
      oauth: null,
      baseUrl() {
        try {
          return current().baseUrl;
        } catch {
          // 永不抛:回落到上次已知地址(再不行才是 config 里那个被忽略的值)。
          const last = src.lastKnown();
          return (last && last.baseUrl) || config.upstreamBaseUrl;
        }
      },
      async apply(headers) {
        const v = current();
        if (v.via === 'auth-token') headers['authorization'] = `Bearer ${v.token}`;
        else headers['x-api-key'] = v.token;
      },
      peek() {
        return { kind, ...inspectInheritSettings(file, config.port) };
      },
    };
  }

  if (kind === 'oauth') {
    const oauth = createOAuthProvider(config.oauthCredentialsPath, log);
    return {
      kind,
      isSubscription: true,
      oauth,
      baseUrl: () => config.upstreamBaseUrl,
      async apply(headers) {
        const accessToken = await oauth.getAccessToken();
        headers['authorization'] = `Bearer ${accessToken}`;
        ensureBeta(headers, oauth.beta); // 订阅 token 必带的 beta flag
      },
      peek() {
        const info = oauth.peek();
        return {
          kind,
          ok: !!info,
          file: oauth.file,
          baseUrl: config.upstreamBaseUrl,
          error: info ? null : '凭证读取失败',
          subscriptionType: info ? info.subscriptionType || null : null,
          expiresAt: info ? info.expiresAt || 0 : 0,
          hasRefresh: info ? !!info.hasRefresh : false,
        };
      },
    };
  }

  // apiKey:authToken 优先(第三方网关多用 Bearer),否则 x-api-key(官方)
  return {
    kind: 'apiKey',
    isSubscription: false,
    oauth: null,
    baseUrl: () => config.upstreamBaseUrl,
    async apply(headers) {
      if (config.upstreamAuthToken) headers['authorization'] = `Bearer ${config.upstreamAuthToken}`;
      else if (config.upstreamApiKey) headers['x-api-key'] = config.upstreamApiKey;
    },
    peek() {
      const t = config.upstreamAuthToken || config.upstreamApiKey;
      return {
        kind: 'apiKey',
        ok: !!t,
        baseUrl: config.upstreamBaseUrl,
        error: t ? null : '未配置上游密钥',
        via: config.upstreamAuthToken ? 'auth-token' : 'api-key',
        tokenMask: mask(t),
      };
    },
  };
}

// 把某个 anthropic-beta flag 合并进请求头(去重,大小写无关地复用已有的 key)。
// 与 server.js 里同名函数同源 —— 那边处理客户端原有的头,这边只在 oauth 注入时用。
function ensureBeta(headers, flag) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'anthropic-beta');
  if (!key) {
    headers['anthropic-beta'] = flag;
    return;
  }
  const vals = String(headers[key])
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!vals.includes(flag)) vals.push(flag);
  headers[key] = vals.join(',');
}
