#!/usr/bin/env node
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, cleanToken } from './config.js';
import { createOAuthProvider, defaultCredentialsPath, inspectCredentials } from './oauth.js';
import { createMetrics } from './metrics.js';
import { createAdmin } from './admin.js';
import {
  applyOverrides,
  normalizeOverrides,
  effectiveOverrides,
  clientAllowed,
  modelAllowed,
  claudeCodeBetas,
  claudeCodeIdentityHeaders,
} from './models.js';
import { createLimiter } from './limits.js';
import { initUpstream } from './upstream.js';
import { handleOpenAiCompat } from './openai_compat.js';
import { createFileLogger, dirSize } from './logger.js';
import { createModelStore } from './model_store.js';
import { createLogStore } from './logstore.js';
import { createStorage } from './storage.js';
import { createUserStore, tokenIdOf, effectiveQuota } from './users.js';
import { createChatStore } from './chat_store.js';
import { createChat } from './chat.js';
import { createUserPortal } from './user.js';

function generateClientToken() {
  return 'cct-' + crypto.randomBytes(24).toString('base64url');
}

// 版本号(供 /health 展示),读不到则 unknown
let PKG_VERSION = 'unknown';
try {
  PKG_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'unknown';
} catch {
  /* ignore */
}

// ── 子命令: 生成客户端令牌 ───────────────────────────────────────────
if (process.argv[2] === 'gen-token') {
  process.stdout.write(generateClientToken() + '\n');
  process.exit(0);
}

// ── 子命令: 自检某个令牌是否在白名单里 ──────────────────────────────
//    用法: node src/server.js check-token "<你正在客户端用的令牌>"
if (process.argv[2] === 'check-token') {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write('\n配置无法加载(服务器也启动不了):\n' + err.message + '\n');
    process.exit(1);
  }
  const input = cleanToken(process.argv[3] || '');
  const mask = (t) => (!t ? '(空)' : t.length <= 10 ? '***' : t.slice(0, 6) + '…' + t.slice(-4));
  process.stdout.write(`\n配置文件: ${cfg.__file || '(未用文件,走环境变量)'}\n`);
  process.stdout.write(`已配置的客户端令牌(${cfg.clientTokens.length} 个):\n`);
  for (const t of cfg.clientTokens) {
    process.stdout.write(`  - ${t.name}: ${mask(t.token)}  [长度 ${t.token.length}]\n`);
  }
  if (!input) {
    process.stdout.write('\n用法: node src/server.js check-token "<你正在客户端用的令牌>"\n');
    process.exit(2);
  }
  const hit = cfg.clientTokens.find((t) => t.token === input);
  process.stdout.write(`\n你输入的令牌: ${mask(input)}  [长度 ${input.length}]\n`);
  if (hit) {
    process.stdout.write(`✅ 匹配成功(设备名: ${hit.name})。鉴权失败应该不是令牌本身的问题——\n`);
    process.stdout.write(`   请确认:服务器在改完 config.json 后已【重启】,且客户端连的是这台服务器。\n\n`);
    process.exit(0);
  } else {
    process.stdout.write('❌ 不匹配。原因通常是:令牌有出入 / 改完 config.json 没重启 / 编辑的是 config.example.json。\n\n');
    process.exit(1);
  }
}

let config;
try {
  config = loadConfig();
} catch (err) {
  process.stderr.write('\n' + err.message + '\n\n');
  process.exit(1);
}

// 可选滚动文件日志(默认 null;配了 logFile 才启用)。必须在任何 log() 调用前初始化。
const fileLogger = createFileLogger({
  logFile: config.logFile,
  logMaxBytes: config.logMaxBytes,
  logMaxFiles: config.logMaxFiles,
});

// token -> 条目映射,用于鉴权/日志标识/参数下发;clientTokens 为可变的令牌清单(管理台增删改)
let clientTokens = config.clientTokens.map((t) => ({ token: t.token, name: t.name, overrides: t.overrides || {} }));
const tokenMap = new Map(clientTokens.map((t) => [t.token, t]));

// 订阅 OAuth provider(仅 oauth 模式启用)
// let:管理台「上游订阅」可在线切换鉴权方式/凭证路径并热重建,无需重启
let oauth = config.upstreamAuth === 'oauth' ? createOAuthProvider(config.oauthCredentialsPath, log) : null;

// 状态目录:显式 dataDir 优先(Docker 用 CC_TRANS_DATA_DIR 指到挂载卷),
// 纯环境变量配置模式(无 config.json)则为 null —— 全部退化为内存态。
//
// 没显式指定时的默认值要让两种布局落到【同一个目录】:
//   <仓库根>/config.json      (老装机)  → <仓库根>/data
//   <仓库根>/data/config.json (新默认/Docker) → <仓库根>/data  ← 就是它自己所在的目录
// 所以配置文件本来就躺在 data/ 里的时候,状态目录就是那个目录,不再往下套一层
// (否则会出现 data/data 这种嵌套,两种部署又各写一处)。
function defaultDataDir(configFile) {
  if (!configFile) return null;
  const dir = path.dirname(configFile);
  return path.basename(dir) === 'data' ? dir : path.join(dir, 'data');
}
// 目标目录能不能写:找到最近的【已存在】祖先看它的权限。
// 刻意【不】在启动时 mkdir 去试 —— `fs.mkdirSync(p, {recursive:true})` 对某些病态
// 路径会直接阻塞(实测 /proc 下递归创建卡死不返回),那会让整个服务起不来,
// 比"第一次落盘才报错"糟得多。existsSync/accessSync 都是毫秒级且不阻塞。
function dirWritable(p) {
  let cur = path.resolve(p);
  for (;;) {
    if (fs.existsSync(cur)) {
      try {
        fs.accessSync(cur, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    const up = path.dirname(cur);
    if (up === cur) return false; // 走到根了还不存在
    cur = up;
  }
}

let dataDir = config.dataDir ? path.resolve(config.dataDir) : defaultDataDir(config.__file);
// 配置里写死的 dataDir 可能来自另一种部署(例如容器路径 /app/data 被裸机读到)。
// 与其等第一次落盘才 EACCES,不如启动就说清并退回默认。
if (config.dataDir && dataDir && !dirWritable(dataDir)) {
  const fallback = defaultDataDir(config.__file);
  log(`⚠️ 配置里的 dataDir 不可写: ${dataDir}`);
  log(`   这通常是另一种部署方式写进配置的路径(如容器内 /app/data)。已退回 ${fallback || '内存态'}`);
  dataDir = fallback;
}

// 请求日志分块持久化(<dataDir>/logs/<日期>/<小时>.jsonl),支持分页查询/按时间段删除/自动过期
const logStore = createLogStore({
  dir: dataDir ? path.join(dataDir, 'logs') : null,
  retentionDays: config.logRetentionDays,
  log,
});
if (logStore.enabled) {
  logStore.sweepRetention();
  setInterval(() => logStore.sweepRetention(), 6 * 3600_000).unref(); // 每 6 小时清一次过期块
}

// 指标采集:有 config.json 时把累计/每日聚合持久化到旁边的 data/metrics.json(纯环境变量模式则内存态)
const metrics = createMetrics({
  persistFile: dataDir ? path.join(dataDir, 'metrics.json') : null,
  logStore,
  log,
});

// 模型列表存储:上游拉取结果持久化到 <dataDir>/models.json(列表不写死在代码里)
const modelStore = createModelStore({ persistFile: dataDir ? path.join(dataDir, 'models.json') : null, log });

// 按客户端限流/并发(内存态)
const limiter = createLimiter();
setInterval(() => limiter.sweep(), 300_000).unref();

// 上游连接层(连接池 + 可选代理)。默认直连用内置 fetch;配代理时按需加载 undici。
// let:管理台改代理后可热重建。
let upstream = await initUpstream(config, log);
let upstreamFetch = upstream.fetch;
let upstreamDispatcher = upstream.dispatcher;

// 原子地把若干字段写回 config.json(保留其它字段/注释)
function patchConfigFile(patch) {
  const file = config.__file;
  if (!file) throw new Error('无 config.json,无法持久化');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(j, patch);
  const tmp = `${file}.cc-trans.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function persistClientTokens() {
  patchConfigFile({
    clientTokens: clientTokens.map((t) => ({
      token: t.token,
      name: t.name,
      ...(t.overrides && Object.keys(t.overrides).length ? { overrides: t.overrides } : {}),
    })),
  });
}

// ── 上游订阅/凭证的在线配置(管理台「设置 → 本地 AI 订阅」)────────────────
// 支持:切换鉴权方式(订阅 OAuth / 静态密钥)、改凭证文件路径、上游地址、代理。
// 保存后写回 config.json 并【热应用】(重建 OAuth provider 与连接层),无需重启。
const upstreamAdmin = {
  canManage: () => !!config.__file,
  // 当前状态(密钥只回掩码,明文不出服务端)
  read() {
    const out = {
      upstreamAuth: config.upstreamAuth,
      upstreamBaseUrl: config.upstreamBaseUrl,
      oauthCredentialsPath: config.oauthCredentialsPath,
      upstreamProxy: config.upstreamProxy || '',
      hasApiKey: !!config.upstreamApiKey,
      hasAuthToken: !!config.upstreamAuthToken,
      apiKeyMask: config.upstreamApiKey ? maskToken(config.upstreamApiKey) : '',
      authTokenMask: config.upstreamAuthToken ? maskToken(config.upstreamAuthToken) : '',
      proxyDescribe: upstream.describe,
      canManage: !!config.__file,
      defaultCredentialsPath: defaultCredentialsPath(),
    };
    // 订阅凭证探测:文件在不在、订阅类型、到期、能否自动刷新
    out.credentials = inspectLocalCredentials(config.oauthCredentialsPath);
    return out;
  },
  // 探测任意路径的凭证(前端"检测"按钮用)
  probe(p) {
    return inspectLocalCredentials(p || config.oauthCredentialsPath);
  },
  async apply(patch) {
    if (!config.__file) return { ok: false, error: '当前用环境变量配置,无法在线修改;请改用 config.json' };
    const next = {};
    if (patch.upstreamAuth === 'oauth' || patch.upstreamAuth === 'apiKey') next.upstreamAuth = patch.upstreamAuth;
    if (typeof patch.upstreamBaseUrl === 'string' && patch.upstreamBaseUrl.trim()) {
      next.upstreamBaseUrl = patch.upstreamBaseUrl.trim().replace(/\/+$/, '');
    }
    if (typeof patch.oauthCredentialsPath === 'string') next.oauthCredentialsPath = patch.oauthCredentialsPath.trim();
    if (typeof patch.upstreamProxy === 'string') next.upstreamProxy = patch.upstreamProxy.trim();
    // 密钥:留空=不改;传 "__clear__"=清空
    for (const [k, field] of [['upstreamApiKey', 'upstreamApiKey'], ['upstreamAuthToken', 'upstreamAuthToken']]) {
      if (typeof patch[k] === 'string' && patch[k] !== '') {
        next[field] = patch[k] === '__clear__' ? '' : cleanToken(patch[k]);
      }
    }

    const targetAuth = next.upstreamAuth || config.upstreamAuth;
    const targetCredPath = next.oauthCredentialsPath ?? config.oauthCredentialsPath;
    const targetKey = next.upstreamApiKey ?? config.upstreamApiKey;
    const targetToken = next.upstreamAuthToken ?? config.upstreamAuthToken;

    // 生效前校验:订阅模式要有可用凭证;apiKey 模式要有密钥
    if (targetAuth === 'oauth') {
      const info = inspectLocalCredentials(targetCredPath || defaultCredentialsPath());
      if (!info.ok) return { ok: false, error: `订阅凭证不可用:${info.error}(请先在本机 \`claude\` 登录,或改用 apiKey 模式)` };
    } else if (!targetKey && !targetToken) {
      return { ok: false, error: 'apiKey 模式需要填 upstreamApiKey 或 upstreamAuthToken 之一' };
    }

    // 写回 config.json(只写用户显式改动的字段)
    try {
      patchConfigFile(next);
    } catch (err) {
      return { ok: false, error: '写回 config.json 失败: ' + err.message };
    }
    // 热应用到运行时
    Object.assign(config, next);
    if (next.oauthCredentialsPath === '') config.oauthCredentialsPath = defaultCredentialsPath();
    const proxyChanged = 'upstreamProxy' in next;
    oauth = config.upstreamAuth === 'oauth' ? createOAuthProvider(config.oauthCredentialsPath, log) : null;
    if (proxyChanged) {
      upstream = await initUpstream(config, log);
      upstreamFetch = upstream.fetch;
      upstreamDispatcher = upstream.dispatcher;
    }
    log(`管理台更新上游设置: ${JSON.stringify({ ...next, upstreamApiKey: next.upstreamApiKey ? '(已改)' : undefined, upstreamAuthToken: next.upstreamAuthToken ? '(已改)' : undefined })} → 已热应用`);
    return { ok: true, state: upstreamAdmin.read() };
  },
};

// 读取并体检某个订阅凭证文件(不抛异常)
function inspectLocalCredentials(p) {
  const file = p || defaultCredentialsPath();
  try {
    const info = inspectCredentials(file);
    const left = info.expiresAt ? Math.round((info.expiresAt - Date.now()) / 60000) : null;
    return {
      ok: true,
      file,
      // 经软链接时把真实落点也报出来(~/.claude 常被链到别的盘),排查不用再 ssh 上去 readlink
      realFile: info.real && info.real !== path.resolve(file) ? info.real : '',
      subscriptionType: info.subscriptionType || null,
      expiresInMin: left,
      expired: left != null && left <= 0,
      hasRefresh: !!info.hasRefresh,
    };
  } catch (err) {
    return { ok: false, file, error: err.message };
  }
}

// 定长防时序比较
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// 供管理台增删令牌的接口
const tokenAdmin = {
  canManage: () => !!config.__file,
  list: () => clientTokens.map((t) => ({ token: t.token, name: t.name, overrides: t.overrides || {} })),
  add: (name) => {
    const clean = (name || 'client').trim() || 'client';
    // metrics 与 logStore 都以令牌名为聚合键,同名会把两台设备的数据混在一起
    if (clientTokens.some((t) => t.name === clean)) return { error: `设备名 "${clean}" 已存在,请换一个` };
    const entry = { token: generateClientToken(), name: clean, overrides: {} };
    clientTokens.push(entry);
    tokenMap.set(entry.token, entry);
    persistClientTokens();
    return entry;
  },
  revoke: (token) => {
    const idx = clientTokens.findIndex((t) => t.token === token);
    if (idx === -1) return false;
    clientTokens.splice(idx, 1);
    tokenMap.delete(token);
    limiter.forget(token);
    persistClientTokens();
    // 令牌没了,用户身上的绑定也不该留着。
    // 出错要吼出来:这里曾经因为漏 import 而静默失败,留下能查到已吊销令牌的悬空绑定。
    try {
      users.forgetToken(tokenIdOf(token));
    } catch (err) {
      log(`⚠️ 清理用户令牌绑定失败(可能留下悬空绑定): ${err.message}`);
    }
    return true;
  },
  // 按客户端下发参数(强制模型/thinking/effort/门禁前缀/参数清洗),写回 config.json 立即生效
  setOverrides: (token, overrides) => {
    const entry = clientTokens.find((t) => t.token === token);
    if (!entry) return null;
    entry.overrides = normalizeOverrides(overrides);
    persistClientTokens();
    return entry.overrides;
  },
};

// 管理台:adminEnabled 或设了 adminPassword 即启用;账号密码登录
const ADMIN_PREFIX = '/admin';
const adminOn = config.adminEnabled || !!config.adminPassword;
// 登录名和密码都可以在线改,所以两个都是 let;对外一律经 adminCredentials 读,
// 别把 adminUser 的值拷进别的常量里(改名后会读到旧值)。
let adminUser = config.adminUser || 'admin';
let adminPassword = config.adminPassword;
let adminNote = config.adminNote || '';
let adminCreatedAt = Number(config.adminCreatedAt) || 0;
let adminLastLoginAt = 0; // 只记在内存:登录一次就写一次 config.json 太吵
let initialPasswordNotice = null;

if (adminOn && !adminPassword) {
  // 首次部署:生成随机初始密码,写回 config.json,并在控制台醒目打印一次
  adminPassword = 'adm-' + crypto.randomBytes(9).toString('base64url');
  adminCreatedAt = Date.now();
  initialPasswordNotice = adminPassword;
  try {
    if (config.__file) patchConfigFile({ adminPassword, adminCreatedAt });
  } catch (err) {
    initialPasswordNotice = adminPassword + ' (⚠️ 未能写回 config.json,重启会重新生成: ' + err.message + ')';
  }
}

// 老配置里没有 adminCreatedAt(这个字段是后加的)。与其在界面上摆一个「—」,
// 不如用 config.json 的创建时间兜底 —— 管理台账号本来就是随它一起出现的。
// 【不写回】:写回就变成了"精确值",而它其实只是个近似。保持推导 + 打上
// approx 标记,界面上说清来源 —— 不标来源的近似值就是在骗人。
let adminCreatedApprox = false;
if (adminOn && !adminCreatedAt && config.__file) {
  try {
    const st = fs.statSync(config.__file);
    adminCreatedAt = Math.round(st.birthtimeMs || st.mtimeMs || 0);
    adminCreatedApprox = !!adminCreatedAt;
  } catch {
    /* 拿不到就算了,界面上显示「—」 */
  }
}

// 登录名字符集与普通用户一致 —— 两边同一个命名空间(不允许重名),规则不该两套
const ADMIN_NAME_RE = /^[a-zA-Z0-9._-]{2,32}$/;

const adminCredentials = {
  // getter:改名后所有读取点(登录页默认名、用户列表里的管理员行、日志)自动跟上
  get user() {
    return adminUser;
  },
  lastLoginAt: () => adminLastLoginAt,
  note: () => adminNote,
  createdAt: () => adminCreatedAt,
  createdApprox: () => adminCreatedApprox,
  // 环境变量配置时不能在线改 —— 改了也写不回,重启就丢
  canManage: () => !!config.__file,
  verify: (u, p) => {
    const ok = u === adminUser && !!adminPassword && safeEqual(p, adminPassword);
    if (ok) adminLastLoginAt = Date.now();
    return ok;
  },
  // 登录名、密码、备注都在这一个接口里改,任填其一。
  // 只有【凭证类】改动(登录名 / 密码)才验当前密码 —— 备注不是凭证,
  // 为了改一行备注去输密码只会让人烦。
  changeAccount: ({ username, oldPassword, newPassword, note } = {}) => {
    if (!config.__file) {
      return { ok: false, error: '当前用环境变量配置管理台账号,无法在线修改;请改用 config.json' };
    }
    const wantsCredential = !!String(username || '').trim() || !!String(newPassword || '');
    if (wantsCredential && !safeEqual(String(oldPassword || ''), adminPassword)) {
      return { ok: false, error: '当前密码不正确' };
    }

    const patch = {};
    if (note !== undefined) {
      const n = String(note || '').slice(0, 200);
      if (n !== adminNote) patch.adminNote = n;
    }
    const wantName = String(username || '').trim();
    if (wantName && wantName !== adminUser) {
      if (!ADMIN_NAME_RE.test(wantName)) return { ok: false, error: '登录名需 2~32 位,仅限字母数字与 . _ -' };
      if (wantName.toLowerCase() === '__admin__') return { ok: false, error: '"__admin__" 是内部保留名,请换一个' };
      // 与普通用户同名会让"这个名字该去哪登录"变得没有答案,直接挡掉
      if (users.list().some((u) => u.name.toLowerCase() === wantName.toLowerCase())) {
        return { ok: false, error: `已有同名普通用户 "${wantName}",请换一个登录名` };
      }
      patch.adminUser = wantName;
    }
    const wantPw = String(newPassword || '');
    if (wantPw) {
      if (wantPw.length < 6) return { ok: false, error: '新密码至少 6 位' };
      patch.adminPassword = wantPw;
    }
    if (!Object.keys(patch).length) return { ok: false, error: '没有要修改的内容' };

    // 先落盘再改内存:写失败时进程里的凭证和文件不会对不上
    try {
      patchConfigFile(patch);
    } catch (err) {
      return { ok: false, error: '写回 config.json 失败: ' + err.message };
    }
    if (patch.adminUser) {
      log(`管理台登录名已修改: ${adminUser} → ${patch.adminUser}`);
      adminUser = patch.adminUser;
    }
    if (patch.adminPassword) {
      adminPassword = patch.adminPassword;
      log(`管理台密码已修改`);
    }
    if (patch.adminNote !== undefined) {
      adminNote = patch.adminNote;
      log(`管理台账号备注已修改`);
    }
    return {
      ok: true,
      user: adminUser,
      note: adminNote,
      renamed: !!patch.adminUser,
      passwordChanged: !!patch.adminPassword,
      noteChanged: patch.adminNote !== undefined,
    };
  },
  changePassword: (oldPw, newPw) => adminCredentials.changeAccount({ oldPassword: oldPw, newPassword: newPw }),
};

// 普通用户账号(与客户端令牌绑定)。数据层被管理台和用户端共用,
// 越权判断只写一处。
const users = createUserStore({
  config,
  persist: config.__file ? (list) => patchConfigFile({ users: list }) : null,
  // 管理员改名后,新名字也要立刻变成普通用户的禁用名(双向互斥,只写这一处)
  reservedName: () => adminCredentials.user,
  log,
});

// 网页聊天:会话存服务端(<dataDir>/chats/<user>/),换浏览器还在
const chatStore = createChatStore({
  dir: dataDir ? path.join(dataDir, 'chats') : null,
  maxSessions: config.chatMaxSessions,
  maxMessages: config.chatMaxMessages,
  log,
});

// 聊天页在用户端与管理台共用同一份 HTML(前端按 location 推导 API 前缀),
// 所以这里读一次给两边用 —— 注入用替换【函数】,替换串会把 $& 当特殊模式。
function readChatUi() {
  try {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const mdSrc = fs.readFileSync(path.join(dir, 'md.js'), 'utf8').replace(/^export /gm, '');
    return fs
      .readFileSync(path.join(dir, 'chat-ui.html'), 'utf8')
      .replace('/*__TOKENS__*/', () => fs.readFileSync(path.join(dir, 'ui-tokens.css'), 'utf8'))
      .replace('/*__MD__*/', () => mdSrc);
  } catch (err) {
    log(`⚠️ 聊天页读取失败: ${err.message}`);
    return '';
  }
}
const chat = adminOn
  ? createChat({ store: chatStore, modelStore, tokenAdmin, tokenIdOf, forward: chatForward, config, log })
  : null;

// 数据目录的占用统计与清理(概览页「存储占用」)。必须在 createAdmin 之前声明 ——
// const 有 TDZ,放后面会在启动时直接崩(这坑踩过一次了)。
const storage = createStorage({
  dataDir,
  chatStore,
  logStore,
  configFile: config.__file || null,
  logFile: config.logFile || null,
  log,
});

const admin = adminOn
  ? createAdmin({
      prefix: ADMIN_PREFIX,
      credentials: adminCredentials,
      config,
      getOauth: () => oauth, // 取当前实例(管理台可热切换订阅/密钥模式)
      metrics,
      tokenAdmin,
      users,
      chat, // 管理员也能用网页聊天(管理员本就有全部权限)
      chatUi: readChatUi(),
      modelStore,
      logStore,
      storage,
      upstreamAdmin,
      maskToken,
      log,
    })
  : null;

// ── 用户级配额 ───────────────────────────────────────────────────────────
// 额度按【用户】算,与他名下所有令牌共享一份 —— 不是每个令牌各一份。
// 口径是 token 数与花费金额,而不是请求次数(一次长对话和一句 hello 差几个数量级)。
// 未绑定到任何用户的令牌(如管理员自用)不受限。
function quotaCheck(tokenEntry) {
  const owner = users.ownerOfToken(tokenIdOf(tokenEntry.token));
  if (!owner) return null; // 没有归属用户 → 不限
  const q = effectiveQuota(owner);
  if (q.unlimited) return null;
  // 该用户名下所有令牌的名字(配额是共享的)
  const names = clientTokens.filter((t) => (owner.tokenIds || []).includes(tokenIdOf(t.token))).map((t) => t.name);
  const used = metrics.usageFor(names, q.window);
  const label = { day: '今天', month: '本月', total: '累计' }[q.window] || q.window;
  if (q.tokens && used.tokens >= q.tokens) {
    return { status: 429, message: `用户 ${owner.name} ${label} token 配额已用尽(${used.tokens}/${q.tokens})`, retryAfterSec: q.window === 'day' ? 3600 : 3600 };
  }
  if (q.costUsd && used.cost >= q.costUsd) {
    return { status: 429, message: `用户 ${owner.name} ${label} 花费配额已用尽($${used.cost.toFixed(2)}/$${q.costUsd.toFixed(2)})`, retryAfterSec: 3600 };
  }
  return null;
}

// ── 网页聊天用的内部转发 ─────────────────────────────────────────────────
// 聊天不另开上游通路,而是以【用户绑定的那台设备】的身份走这里,从而继承参数下发、
// 限流/并发、成本估算与日志统计 —— 同一份额度、同一份账。
// 与 handleProxy 的区别只在于:入口是一个 JS 对象而不是 HTTP 请求,出口是 Response
// 而不是直接写 res(SSE 的翻译交给 chat.js)。规则本身完全复用同一批函数。
async function chatForward({ tokenEntry, payload, signal, req }) {
  const ov = effectiveOverrides(tokenEntry.overrides, { subscription: !!oauth });
  const started = Date.now();
  const clientName = tokenEntry.name;

  // 伪造一个最小 req 给复用的改写/记账函数(它们只读 url 与 headers)
  const fakeReq = {
    method: 'POST',
    url: '/v1/messages',
    headers: {
      'content-type': 'application/json',
      'user-agent': String((req && req.headers['user-agent']) || 'cc-trans-web-chat'),
      ...(req && req.headers['x-forwarded-for'] ? { 'x-forwarded-for': req.headers['x-forwarded-for'] } : {}),
      ...(req && req.socket ? {} : {}),
    },
    socket: req ? req.socket : undefined,
  };

  const t = applyBodyTransforms(Buffer.from(JSON.stringify(payload), 'utf8'), fakeReq, ov);
  const effectiveModel = t.effectiveModel || payload.model;

  if (effectiveModel && !modelAllowed(ov.allowedModels, effectiveModel)) {
    recordMetric(fakeReq, started, 403, clientName, {}, payload.model, effectiveModel);
    return { error: { status: 403, message: `令牌不允许使用模型 ${effectiveModel}` } };
  }

  const overQuota = quotaCheck(tokenEntry);
  if (overQuota) {
    recordMetric(fakeReq, started, overQuota.status, clientName, {}, payload.model, effectiveModel);
    log(`[chat] 配额拒绝: ${overQuota.message} [${clientName}]`);
    return { error: overQuota };
  }

  const gate = limiter.tryAcquire(tokenEntry.token, ov);
  if (!gate.ok) {
    recordMetric(fakeReq, started, gate.status, clientName, {}, payload.model, effectiveModel);
    return { error: { status: gate.status, message: gate.message, retryAfterSec: gate.retryAfterSec } };
  }

  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', accept: 'text/event-stream' };
  try {
    await applyUpstreamAuth(headers);
  } catch (err) {
    gate.release();
    recordMetric(fakeReq, started, 502, clientName, {}, payload.model, effectiveModel);
    return { error: { status: 502, message: '上游凭证不可用: ' + err.message } };
  }
  applyClaudeCodeSpoof(headers, effectiveModel, ov);

  let res;
  try {
    res = await upstreamFetch(config.upstreamBaseUrl + '/v1/messages', {
      method: 'POST',
      headers,
      body: t.body,
      signal,
      ...(upstreamDispatcher ? { dispatcher: upstreamDispatcher } : {}),
    });
  } catch (err) {
    gate.release();
    recordMetric(fakeReq, started, 502, clientName, {}, payload.model, effectiveModel);
    return { error: { status: 502, message: '连接上游失败: ' + err.message } };
  }

  return {
    res,
    release: gate.release,
    effectiveModel,
    // chat.js 拿到完整 usage 后回调,把这次聊天记进该设备的账
    record: ({ status, usage }) => {
      recordMetric(fakeReq, started, status, clientName, usage, payload.model, effectiveModel);
      log(`[chat] POST /v1/messages ${status} ${Date.now() - started}ms model=${effectiveModel} in=${usage.input || 0} out=${usage.output || 0} [${clientName}]`);
    },
  };
}

// 用户端(/u):普通用户看自己被分配的设备 + 网页聊天。独立前缀 + 独立 session,
// 与管理台互不认证 —— 越权是这块最大的风险,物理隔离比条件判断可靠。
const USER_PREFIX = '/u';
const userPortal = adminOn
  ? createUserPortal({
      prefix: USER_PREFIX,
      users,
      metrics,
      logStore,
      tokenAdmin,
      maskToken,
      clientIp,
      chat,
      config,
      log,
    })
  : null;

// 不向上游转发的请求头(逐跳头 + 客户端凭证,凭证由本机替换)
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'authorization',
  'x-api-key',
]);

// 浏览器/探针自动发起的资源请求:无需令牌,直接 204,不记日志/指标
const BROWSER_NOISE = new Set([
  '/favicon.ico',
  '/robots.txt',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
]);

// 不回传给客户端的响应头(fetch 已解压,长度/编码会失真)
const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

function extractClientToken(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.toLowerCase().startsWith('bearer ')) return { token: cleanToken(auth.slice(7)), via: 'authorization' };
  const apiKey = req.headers['x-api-key'];
  if (apiKey) return { token: cleanToken(apiKey), via: 'x-api-key' };
  return { token: null, via: 'none' };
}

function buildUpstreamHeaders(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  return headers;
}

// 把某个 anthropic-beta flag 合并进请求头(去重,大小写无关地复用已有的 key)
function ensureBeta(headers, flag) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'anthropic-beta');
  if (!key) {
    headers['anthropic-beta'] = flag;
    return;
  }
  const vals = String(headers[key]).split(',').map((s) => s.trim()).filter(Boolean);
  if (!vals.includes(flag)) vals.push(flag);
  headers[key] = vals.join(',');
}

// 注入本机真实上游凭证(订阅 OAuth 异步取 token;否则用静态密钥)
async function applyUpstreamAuth(headers) {
  if (oauth) {
    const accessToken = await oauth.getAccessToken();
    headers['authorization'] = `Bearer ${accessToken}`;
    ensureBeta(headers, oauth.beta); // 订阅 token 必带的 beta flag
  } else if (config.upstreamAuthToken) {
    headers['authorization'] = `Bearer ${config.upstreamAuthToken}`;
  } else if (config.upstreamApiKey) {
    headers['x-api-key'] = config.upstreamApiKey;
  }
}

// A 兼容性:开启 spoofClaudeCode 且为订阅 OAuth 时,把请求头补成完整 Claude Code 身份
//（UA/x-app/accept 等 + anthropic-beta 四件套),让自研客户端在上游看来像真 Claude Code。
function applyClaudeCodeSpoof(headers, effectiveModel, overrides) {
  if (!overrides || !overrides.spoofClaudeCode || !oauth) return [];
  const changes = [];
  const ident = claudeCodeIdentityHeaders();
  for (const [k, v] of Object.entries(ident)) {
    // 删掉客户端原有的同名头(任意大小写),再写入标准值
    for (const ek of Object.keys(headers)) if (ek.toLowerCase() === k) delete headers[ek];
    headers[k] = v;
  }
  for (const flag of claudeCodeBetas(effectiveModel)) ensureBeta(headers, flag);
  changes.push('spoofCC');
  return changes;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 请求体改写管道:全局 modelMap + 客户端参数下发(强制模型/thinking/effort/门禁前缀/新模型参数清洗)。
// 仅处理 /v1/messages* 的 JSON 体;无任何改写规则时原样透传(保持字节保真)。
function applyBodyTransforms(bodyBuffer, req, ov) {
  const map = config.modelMap || {};
  ov = ov || {};
  const pathOnly = (req.url || '').split('?')[0];
  const ct = String(req.headers['content-type'] || '');
  // effectiveModel:实际发往上游的模型 id(供白名单/成本/身份 beta 判定);model:日志展示串。
  if (!pathOnly.startsWith('/v1/messages') || !ct.includes('application/json') || bodyBuffer.length === 0) {
    return { body: bodyBuffer, model: undefined, effectiveModel: undefined, changes: [] };
  }
  try {
    const obj = JSON.parse(bodyBuffer.toString('utf8'));
    const original = obj.model;
    const changes = [];
    if (original && map[original]) {
      obj.model = map[original];
      changes.push(`model=${original}→${obj.model}(modelMap)`);
    }
    changes.push(...applyOverrides(obj, ov));
    const effectiveModel = obj.model;
    if (!changes.length) return { body: bodyBuffer, model: original, effectiveModel, changes };
    const model = obj.model !== original ? `${original}→${obj.model}` : original;
    return { body: Buffer.from(JSON.stringify(obj)), model, effectiveModel, changes };
  } catch {
    return { body: bodyBuffer, model: undefined, effectiveModel: undefined, changes: [] };
  }
}

function sendJson(res, status, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': data.length,
  });
  res.end(data);
}

// Anthropic 风格的错误体,便于 Claude Code 展示
function sendError(res, status, type, message) {
  sendJson(res, status, { type: 'error', error: { type, message } });
}

// 从 SSE / JSON 响应文本里尽量抠出 token 用量(用于日志,非精确)
function makeUsageSniffer() {
  let buf = '';
  let input;
  let output;
  let cacheRead;
  let cacheWrite;
  const grab = (re, text) => {
    let m;
    let last;
    while ((m = re.exec(text)) !== null) last = Number(m[1]);
    return last;
  };
  return {
    feed(chunk) {
      buf += chunk;
      if (buf.length > 1_000_000) buf = buf.slice(-200_000); // 防止超长流吃内存
      const i = grab(/"input_tokens"\s*:\s*(\d+)/g, buf);
      const o = grab(/"output_tokens"\s*:\s*(\d+)/g, buf);
      const cr = grab(/"cache_read_input_tokens"\s*:\s*(\d+)/g, buf);
      const cw = grab(/"cache_creation_input_tokens"\s*:\s*(\d+)/g, buf);
      if (i !== undefined) input = i;
      if (o !== undefined) output = o;
      if (cr !== undefined) cacheRead = cr;
      if (cw !== undefined) cacheWrite = cw;
    },
    summary() {
      const parts = [];
      if (input !== undefined) parts.push(`in=${input}`);
      if (output !== undefined) parts.push(`out=${output}`);
      if (cacheRead) parts.push(`cacheR=${cacheRead}`);
      if (cacheWrite) parts.push(`cacheW=${cacheWrite}`);
      return parts.join(' ');
    },
    usage() {
      return { input, output, cacheRead, cacheWrite };
    },
  };
}

function ts() {
  return new Date().toISOString();
}

// 上游网络层瞬时故障的重试次数(仅在客户端尚未收到任何字节时重试,对客户端完全透明)
const UPSTREAM_ATTEMPTS = 3;

// SSE 静默保活:上游超过 SSE_KEEPALIVE_MS 没吐字节,就往客户端写一个 SSE 注释帧(客户端忽略),
// 保证每隔一段就有字节穿过 frp/NAT/中转的每一跳,不让空闲超时掐断长思考期间的连接。
// 用比阈值更短的轮询周期检查,避免"周期==阈值"导致刚好错过。
const SSE_KEEPALIVE_MS = 10_000;
const SSE_KEEPALIVE_POLL_MS = 2_500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 取来源 IP:优先反代头(X-Forwarded-For 首个),否则 socket 远端地址。用于标注异常请求来源。
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();
  const raw = req.socket?.remoteAddress || '';
  return raw.replace(/^::ffff:/, ''); // IPv4-mapped IPv6 归一
}

function recordMetric(req, started, status, clientName, usage, model, effectiveModel) {
  metrics.record({
    ts: started,
    method: req.method,
    path: req.url,
    status,
    ms: Date.now() - started,
    model,
    costModel: effectiveModel || model, // 用实际发往上游的模型 id 算成本
    usage: usage || {},
    client: clientName,
    ip: clientIp(req),
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
  });
}

// 前缀匹配要精确到分隔符,否则 /usage 这类路径会被 /u 误吞
function underPrefix(url, prefix) {
  return url === prefix || url.startsWith(prefix + '/') || url.startsWith(prefix + '?');
}

async function handleProxy(req, res, started) {
  // 管理台:自成一套鉴权,先于代理逻辑处理
  if (admin && req.url.startsWith(ADMIN_PREFIX)) {
    return admin.handle(req, res);
  }

  // 用户端:同样自成一套鉴权(与管理台的 session 互不相认)
  if (userPortal && underPrefix(req.url.split('?')[0], USER_PREFIX)) {
    return userPortal.handle(req, res);
  }

  // 浏览器自动请求的资源(favicon 等):无需令牌,直接 204,不污染日志/指标
  if (req.method === 'GET' && BROWSER_NOISE.has(req.url.split('?')[0])) {
    res.writeHead(204);
    return res.end();
  }

  // 健康检查 / 根路径:GET 与 HEAD 都无需鉴权(HEAD 只回头,常见于本地/浏览器探活)
  const pathOnly = req.url.split('?')[0];
  if ((req.method === 'GET' || req.method === 'HEAD') && (pathOnly === '/' || pathOnly === '/health' || pathOnly === '/healthz')) {
    if (req.method === 'HEAD') {
      res.writeHead(200);
      return res.end();
    }
    return sendJson(res, 200, buildHealth());
  }

  // ── 鉴权 ──
  const { token, via } = extractClientToken(req);
  if (!token || !tokenMap.has(token)) {
    const reason = !token
      ? '请求未携带令牌(authorization/x-api-key 都没有)'
      : `令牌不在白名单 收到=${maskToken(token)} 来自=${via} 已配置=[${[...tokenMap.keys()].map(maskToken).join(', ')}]`;
    log(`${req.method} ${req.url} 401 鉴权失败:${reason}`);
    recordMetric(req, started, 401, token ? '(令牌不匹配)' : '(未携带令牌)');
    return sendError(res, 401, 'authentication_error', `cc-trans: 无效的客户端访问令牌(${!token ? '未携带令牌' : '令牌不匹配'})`);
  }
  const clientEntry = tokenMap.get(token);
  const clientName = clientEntry.name;
  // 全局默认(CC 伪装/注入/清洗默认开,伪装与注入仅订阅模式)+ 该客户端显式设置(可显式关闭)
  const ov = effectiveOverrides(clientEntry.overrides, { subscription: !!oauth });

  // ── B 安全:客户端 UA 限制 ──
  if (ov.allowedClient && !clientAllowed(ov.allowedClient, req.headers['user-agent'])) {
    log(`${req.method} ${req.url} 403 客户端不被允许 UA=${maskToken(String(req.headers['user-agent'] || ''))} [${clientName}]`);
    recordMetric(req, started, 403, clientName);
    return sendError(res, 403, 'permission_error', `cc-trans: 该令牌限制了客户端类型,当前 User-Agent 不被允许`);
  }

  // ── D OpenAI 兼容端点:/v1/chat/completions(OpenAI 格式 → Anthropic)──
  if (req.method === 'POST' && (req.url.split('?')[0] === '/v1/chat/completions')) {
    const gate = limiter.tryAcquire(token, ov);
    if (!gate.ok) {
      recordMetric(req, started, gate.status, clientName);
      res.setHeader('retry-after', String(gate.retryAfterSec));
      return sendError(res, gate.status, 'rate_limit_error', `cc-trans: ${gate.message}`);
    }
    try {
      await handleOpenAiCompat(req, res, {
        readBody,
        fetch: upstreamFetch,
        upstreamBaseUrl: config.upstreamBaseUrl,
        dispatcher: upstreamDispatcher,
        buildBaseHeaders: () => buildUpstreamHeaders(req),
        applyUpstreamAuth,
        applyClaudeCodeSpoof,
        overrides: ov,
        allowedModels: ov.allowedModels,
        log,
        clientName,
        sendError,
        sendJson,
        recordOpenAi: (status, usage, em) => recordMetric(req, started, status, clientName, usage, em, em),
      });
    } finally {
      gate.release();
    }
    return;
  }

  const bodyBuffer = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const { body, model, effectiveModel, changes } = applyBodyTransforms(bodyBuffer, req, ov);
  if (changes.length) log(`参数下发 [${clientName}]: ${changes.join(', ')}`);

  // ── B 安全:模型白名单(针对实际发往上游的模型)──
  if (effectiveModel && !modelAllowed(ov.allowedModels, effectiveModel)) {
    log(`${req.method} ${req.url} 403 模型不在白名单 model=${effectiveModel} 允许=[${ov.allowedModels.join(', ')}] [${clientName}]`);
    recordMetric(req, started, 403, clientName, {}, model);
    return sendError(res, 403, 'permission_error', `cc-trans: 令牌不允许使用模型 ${effectiveModel}`);
  }

  // ── 用户级配额(比限流更外层:限流管频率,配额管总量)──
  const overQuota = quotaCheck(clientEntry);
  if (overQuota) {
    log(`${req.method} ${req.url} ${overQuota.status} 配额: ${overQuota.message} [${clientName}]`);
    recordMetric(req, started, overQuota.status, clientName, {}, model, effectiveModel);
    res.setHeader('retry-after', String(overQuota.retryAfterSec));
    return sendError(res, overQuota.status, 'rate_limit_error', `cc-trans: ${overQuota.message}`);
  }

  // ── B 安全:限流 / 并发(仅对转发请求计数;放行则占额度,finish 时释放)──
  const gate = limiter.tryAcquire(token, ov);
  if (!gate.ok) {
    log(`${req.method} ${req.url} ${gate.status} 限流:${gate.message} [${clientName}]`);
    recordMetric(req, started, gate.status, clientName, {}, model);
    res.setHeader('retry-after', String(gate.retryAfterSec));
    return sendError(res, gate.status, 'rate_limit_error', `cc-trans: ${gate.message}`);
  }
  const release = gate.release;

  const url = config.upstreamBaseUrl + req.url;
  const headers = buildUpstreamHeaders(req);
  try {
    await applyUpstreamAuth(headers);
  } catch (err) {
    release();
    log(`${req.method} ${req.url} 502 上游凭证错误: ${err.message} [${clientName}]`);
    recordMetric(req, started, 502, clientName, {}, model);
    return sendError(res, 502, 'api_error', `cc-trans 上游凭证不可用: ${err.message}`);
  }
  // ── A 兼容性:Claude Code 身份伪装 ──
  const spoof = applyClaudeCodeSpoof(headers, effectiveModel, ov);
  if (spoof.length) log(`身份伪装 [${clientName}]: ${spoof.join(', ')}`);

  // 客户端提前断开时中止上游请求;write 出错走 close 路径,不让 error 事件炸进程
  const abort = new AbortController();
  let clientGone = false;
  let clientGoneMs = 0;
  res.on('error', () => {});
  res.on('close', () => {
    if (!res.writableFinished) {
      clientGone = true;
      clientGoneMs = Date.now();
      abort.abort();
    }
  });

  const sniffer = makeUsageSniffer();
  let upstreamRes = null;
  let wroteHead = false; // 首字节到达才写响应头,首字节前上游中断可整体重试(对客户端透明)
  let sentBytes = false;
  let recorded = false;
  // ── 诊断计数:定位"断开"到底发生在链路哪一段、是不是空闲超时 ──
  let chunkCount = 0; // 回传给客户端的 chunk 数
  let bytesToClient = 0; // 回传字节数
  let firstByteMs = 0; // 首字节送出时刻(算 TTFB)
  let lastWriteMs = 0; // 最近一次成功送出字节的时刻
  let maxGapMs = 0; // 相邻两次送出字节的最大间隔(反映上游/链路的最长静默)
  let upstreamEnded = false; // 上游流是否已完整读完
  let keepAlives = 0; // 已补发的 SSE 保活帧数(在下方流循环里累加)

  // 断开/中断类收尾时附加的诊断串。断开距上次发送=大 → 空闲超时(链路掐死静默连接);小 → 硬重置/客户端主动断。
  const diag = () => {
    const p = [`chunks=${chunkCount}`, `bytes=${bytesToClient}`];
    if (firstByteMs) p.push(`ttfb=${firstByteMs - started}ms`);
    if (maxGapMs) p.push(`最大静默=${maxGapMs}ms`);
    if (clientGone && lastWriteMs) p.push(`断开距上次发送=${(clientGoneMs || Date.now()) - lastWriteMs}ms`);
    if (keepAlives) p.push(`保活帧=${keepAlives}`);
    p.push(`上游${upstreamEnded ? '已读完' : '未读完'}`);
    return p.join(' ');
  };

  const writeHeadOnce = () => {
    if (wroteHead) return;
    wroteHead = true;
    // 透传状态码与响应头(去掉会失真的头)
    const resHeaders = {};
    upstreamRes.headers.forEach((v, k) => {
      if (STRIP_RESPONSE_HEADERS.has(k)) return;
      resHeaders[k] = v;
    });
    res.writeHead(upstreamRes.status, resHeaders);
  };

  const finish = (note = '') => {
    if (recorded) return;
    recorded = true;
    release(); // 释放并发额度
    const status = upstreamRes ? upstreamRes.status : 0;
    const ms = Date.now() - started;
    const usage = sniffer.summary();
    log(
      `${req.method} ${req.url} ${status} ${ms}ms` +
        (model ? ` model=${model}` : '') +
        (usage ? ` ${usage}` : '') +
        (note ? ` ${note}` : '') +
        ` [${clientName}]`,
    );
    recordMetric(req, started, status, clientName, sniffer.usage(), model, effectiveModel);
  };

  for (let attempt = 1; attempt <= UPSTREAM_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await sleep(300 * (attempt - 1));
      if (clientGone) return finish(`(客户端已断开·首字节前 ${diag()})`);
      try {
        await applyUpstreamAuth(headers); // 订阅 token 可能刚轮换,重试前重新取
      } catch {
        /* 取不到就沿用上一次的头 */
      }
    }

    try {
      upstreamRes = await upstreamFetch(url, {
        method: req.method,
        headers,
        body: body.length ? body : undefined,
        signal: abort.signal,
        dispatcher: upstreamDispatcher,
      });
    } catch (err) {
      if (clientGone) return finish(`(客户端已断开·首字节前 ${diag()})`);
      if (attempt < UPSTREAM_ATTEMPTS) {
        log(`${req.method} ${req.url} 上游连接失败,重试 ${attempt}/${UPSTREAM_ATTEMPTS - 1}: ${err.message} [${clientName}]`);
        continue;
      }
      log(`${req.method} ${req.url} 502 上游不可达(已重试 ${UPSTREAM_ATTEMPTS - 1} 次): ${err.message} [${clientName}]`);
      recordMetric(req, started, 502, clientName, {}, model);
      return sendError(res, 502, 'api_error', `cc-trans 无法连接上游: ${err.message}`);
    }

    // 记录上游返回的订阅限额头(供管理台「订阅用量」展示)
    const rl = {};
    upstreamRes.headers.forEach((v, k) => {
      if (k.startsWith('anthropic-ratelimit-')) rl[k] = v;
    });
    if (Object.keys(rl).length) metrics.setRateLimit({ ts: Date.now(), headers: rl });

    if (!upstreamRes.body) {
      writeHeadOnce();
      res.end();
      return finish();
    }

    const isSSE = String(upstreamRes.headers.get('content-type') || '').includes('text/event-stream');
    // 保活定时器:仅 SSE、已开始回传、客户端在线时,静默期补注释帧
    const kaTimer = setInterval(() => {
      if (!isSSE || !wroteHead || clientGone || res.writableEnded || !res.writable) return;
      if (Date.now() - lastWriteMs < SSE_KEEPALIVE_MS) return;
      try {
        res.write(': keepalive\n\n');
        keepAlives++;
        lastWriteMs = Date.now();
      } catch {
        /* 写失败会走 close/error 路径 */
      }
    }, SSE_KEEPALIVE_POLL_MS);
    kaTimer.unref();
    try {
      for await (const chunk of upstreamRes.body) {
        if (clientGone) break;
        try {
          sniffer.feed(Buffer.from(chunk).toString('utf8'));
        } catch {
          /* 嗅探失败不影响转发 */
        }
        writeHeadOnce();
        sentBytes = true;
        chunkCount++;
        bytesToClient += chunk.length;
        const now = Date.now();
        if (!firstByteMs) firstByteMs = now;
        else if (lastWriteMs) maxGapMs = Math.max(maxGapMs, now - lastWriteMs);
        lastWriteMs = now;
        if (!res.write(chunk) && !clientGone) {
          // 背压:等客户端消费;客户端断开也要能醒来
          await new Promise((resolve) => {
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              resolve();
            };
            res.once('drain', done);
            res.once('close', done);
          });
        }
      }
      upstreamEnded = true;
      if (clientGone) return finish(`(客户端提前断开 ${diag()})`);
      writeHeadOnce();
      res.end();
      return finish();
    } catch (err) {
      if (clientGone || res.destroyed) return finish(`(客户端提前断开 ${diag()})`);
      if (!sentBytes && attempt < UPSTREAM_ATTEMPTS) {
        log(`${req.method} ${req.url} 上游响应在首字节前中断,重试 ${attempt}/${UPSTREAM_ATTEMPTS - 1}: ${err.message} [${clientName}]`);
        upstreamRes = null;
        continue;
      }
      if (!sentBytes) {
        log(`${req.method} ${req.url} 502 上游响应中断: ${err.message} [${clientName}]`);
        recordMetric(req, started, 502, clientName, {}, model);
        return sendError(res, 502, 'api_error', `cc-trans 上游响应中断: ${err.message}`);
      }
      if (isSSE) {
        // 已在回传 SSE:补一个合法的 error 事件并正常收尾,客户端能识别错误并自动重试,
        // 而不是收到裸 TCP 断连("Connection closed mid-response")
        log(`${req.method} ${req.url} 上游流中断,以 SSE error 事件收尾: ${err.message} [${clientName}]`);
        try {
          res.write(
            `event: error\ndata: ${JSON.stringify({
              type: 'error',
              error: { type: 'overloaded_error', message: `cc-trans: 上游流中断(${err.message}),请重试` },
            })}\n\n`,
          );
          res.end();
        } catch {
          res.destroy(err);
        }
        return finish(`(流中断 ${diag()})`);
      }
      log(`${req.method} ${req.url} 流错误(已回传部分数据,只能断开): ${err.message} [${clientName}]`);
      res.destroy(err);
      return finish(`(流中断 ${diag()})`);
    } finally {
      clearInterval(kaTimer);
    }
  }
}

function maskToken(t) {
  if (!t) return 'none';
  if (t.length <= 8) return '***';
  return t.slice(0, 6) + '…' + t.slice(-4);
}

// 健康检查详情(无需鉴权,不含敏感数据):存活 + 上游/凭证状态 + 内存 + 数据盘占用,供探针/运维用。
const HEALTH_STARTED = Date.now();
function buildHealth() {
  const h = {
    ok: true,
    service: 'cc-trans',
    version: PKG_VERSION,
    uptimeSec: Math.floor((Date.now() - HEALTH_STARTED) / 1000),
    upstream: config.upstreamBaseUrl,
    upstreamProxy: upstream.describe,
    upstreamAuth: config.upstreamAuth,
    clients: clientTokens.length,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
  };
  if (oauth) {
    try {
      const info = oauth.peek ? oauth.peek() : null;
      if (info) {
        h.oauth = {
          subscriptionType: info.subscriptionType || null,
          expiresInMin: info.expiresAt ? Math.round((info.expiresAt - Date.now()) / 60000) : null,
          hasRefresh: !!info.hasRefresh,
        };
        // token 读不到 / 无 refresh 视为降级(但仍存活,便于区分探针语义)
        if (!info.hasRefresh) h.ok = true;
      } else {
        h.oauth = { error: '凭证读取失败' };
      }
    } catch {
      h.oauth = { error: '凭证读取异常' };
    }
  }
  if (dataDir) {
    try {
      const d = dirSize(dataDir);
      h.dataDir = { bytes: d.bytes, mb: Math.round((d.bytes / 1048576) * 100) / 100, files: d.files };
    } catch {
      /* ignore */
    }
  }
  return h;
}

function log(msg) {
  const line = `[${ts()}] ${msg}\n`;
  process.stdout.write(line);
  if (fileLogger) fileLogger.write(line);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  handleProxy(req, res, started).catch((err) => {
    log(`未捕获错误: ${err.stack || err.message}`);
    if (!res.headersSent) sendError(res, 500, 'api_error', `cc-trans 内部错误: ${err.message}`);
    else res.destroy(err);
  });
});

server.requestTimeout = 0; // 长连接 / 长流式不超时
server.headersTimeout = 0;
server.keepAliveTimeout = 0; // 不主动断开空闲 keep-alive 连接(Node 默认 5s,客户端复用连接时易撞上断连竞态)
server.on('connection', (socket) => {
  socket.setKeepAlive(true, 30_000); // TCP 层保活,防 NAT/隧道悄悄丢链
  socket.setNoDelay(true); // SSE 小块即时送出
});

server.listen(config.port, config.host, () => {
  printBanner();
});

function lanIps() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function printBanner() {
  let cred;
  if (config.upstreamAuth === 'oauth') {
    const info = config.oauthInfo || {};
    const left = info.expiresAt ? Math.round((info.expiresAt - Date.now()) / 60000) : null;
    cred = `订阅OAuth(${info.subscriptionType || '?'}, token${left == null ? '' : left > 0 ? `还有${left}分钟到期` : '已过期,首个请求会自动刷新'})`;
  } else {
    cred = config.upstreamAuthToken ? 'auth-token' : 'api-key';
  }
  log(`cc-trans 已启动`);
  log(`  监听:      ${config.host}:${config.port}`);
  log(`  上游:      ${config.upstreamBaseUrl} (凭证类型: ${cred})`);
  if (oauth) log(`  订阅凭证:  ${oauth.file}`);
  log(`  客户端令牌: ${clientTokens.map((t) => `${t.name}(${maskToken(t.token)})`).join(', ') || '(无)'}`);
  if (admin) {
    const ips = lanIps();
    const host = ips[0] || 'localhost';
    log(`  管理台:    http://${host}:${config.port}${ADMIN_PREFIX}  (账号 ${adminUser} 登录)`);
    log(`  用户端:    http://${host}:${config.port}${USER_PREFIX}  (${users.count()} 个用户账号${users.count() ? '' : ',在管理台「用户」页创建'})`);
  } else {
    log(`  管理台:    未启用(在 config.json 设 adminEnabled:true 即可开启)`);
  }
  if (config.__file) log(`  配置文件:  ${config.__file}`);
  // 两处都有 config.json = 同一份数据配了两份配置,迟早漂移成"同一个服务两种界面"。
  // 静默择一最坏:用户看到的是界面不一致,却查不到原因。
  if (config.__shadowed) {
    log(`  ⚠️ 另有一份被忽略的配置: ${config.__shadowed}`);
    log(`     两份配置指向同一个数据目录会各自漂移(用户/保留天数等),确认无用后删掉它。`);
  }
  if (Object.keys(config.modelMap).length) {
    log(`  模型映射:  ${JSON.stringify(config.modelMap)}`);
  }
  const ips = lanIps();
  if (ips.length) {
    log(`  远端可用:  ${ips.map((ip) => `http://${ip}:${config.port}`).join('  ')}`);
  }
  log(`  远端配置:  ANTHROPIC_BASE_URL=http://<本机IP>:${config.port}  ANTHROPIC_AUTH_TOKEN=<你的客户端令牌>`);
  if (initialPasswordNotice) {
    log('');
    log('  ┌──────────────────────────────────────────────────────────┐');
    log(`  │  管理台初始账号: ${adminUser}`);
    log(`  │  管理台初始密码: ${initialPasswordNotice}`);
    log('  │  (登录后可在「设置」里修改;此密码已写入 config.json)');
    log('  └──────────────────────────────────────────────────────────┘');
    log('');
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`收到 ${sig},关闭中…`);
    metrics.flush();
    logStore.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
