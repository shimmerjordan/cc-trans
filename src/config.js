import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCredentialsPath, inspectCredentials, resolveCredentialsFile } from './oauth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 上游鉴权的合法取值。管理台的写入白名单也用这一份 —— 两处各写一遍迟早漂移。
export const UPSTREAM_AUTH_MODES = new Set(['oauth', 'apiKey', 'inherit']);

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8787,
  upstreamBaseUrl: 'https://api.anthropic.com',
  upstreamApiKey: '',
  upstreamAuthToken: '',
  oauthCredentialsPath: '',
  inheritSettingsPath: '', // inherit 模式:本机 Claude Code 配置。留空=~/.claude/settings.json
  clientTokens: [],
  users: [], // 普通用户账号(管理台创建;密码为 scrypt 哈希,见 users.js)
  modelMap: {},
  upstreamProxy: '', // 上游代理:http://、https://、socks5://(留空=直连)
  // 一个请求最多穿过几台 cc-trans(环路防护,见 hops.js)。正常级联 1~2 跳,
  // 留 4 是给多级中转的余量;0 = 关闭防护。
  maxHops: 4,
  dataDir: '', // 状态目录(指标/模型列表/日志块)。留空=config.json 同级的 data/;Docker 里指到挂载卷
  logBody: false,
  logFile: '', // 可选:把日志同时写到文件并自动轮转(留空=只 stdout,交给 journald/docker 轮转)
  logMaxBytes: 10 * 1024 * 1024, // 单个日志文件上限,超过就轮转
  logMaxFiles: 5, // 保留的轮转文件数(超出删最旧,控制磁盘占用)
  logRetentionDays: 14, // 请求日志分块(data/logs)保留天数,超过自动删除(0=不自动删)
  // 网页聊天的磁盘保护(不是额度:超了删最旧的,不拒绝请求,也不区分管理员)。0=不限
  chatMaxSessions: 200, // 每用户会话数上限
  chatMaxMessages: 500, // 每会话消息数上限
  adminEnabled: false,
  adminUser: 'admin',
  adminPassword: '',
  adminNote: '', // 管理台账号的备注,和普通用户的 note 一个意思
  adminCreatedAt: 0, // 首次生成管理台凭证的时间;老配置没有,启动时补一次
};

// 配置文件的解析顺序。
//
// 为什么要有顺序:Docker 用 `<dataDir>/config.json`(卷里,状态集中一处),裸机/systemd
// 历史上用 `<仓库根>/config.json`,而两种部署的 dataDir 默认都落在 `<仓库根>/data`。
// 结果是【同一份数据配了两份配置】,各自漂移 —— 实测过一次:裸机那份没有用户账号、
// 日志保留是默认 14 天,Docker 那份有用户、保留 30 天,同一个服务两种界面。
//
// 所以默认优先 data/config.json:两种部署方式落到同一份配置上,来回切不丢设置。
// 仓库根的那份仅作向后兼容(老装机只有它),并且在两份都存在时【明确告警】。
export function resolveConfigPath() {
  if (process.env.CC_TRANS_CONFIG) {
    return { file: process.env.CC_TRANS_CONFIG, explicit: true, shadowed: null };
  }
  const inData = path.join(ROOT, 'data', 'config.json');
  const inRoot = path.join(ROOT, 'config.json');
  const hasData = fs.existsSync(inData);
  const hasRoot = fs.existsSync(inRoot);
  if (hasData) return { file: inData, explicit: false, shadowed: hasRoot ? inRoot : null };
  if (hasRoot) return { file: inRoot, explicit: false, shadowed: null };
  // 都没有:新装机建在 data/ 里,和 Docker 一致
  return { file: inData, explicit: false, shadowed: null, fresh: true };
}

function readConfigFile() {
  const { file, shadowed } = resolveConfigPath();
  if (!fs.existsSync(file)) return { __file: null, __shadowed: shadowed || null };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...parsed, __file: file, __shadowed: shadowed || null };
  } catch (err) {
    throw new Error(`读取配置文件失败 ${file}: ${err.message}`);
  }
}

function splitList(v) {
  if (!v) return [];
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// 清洗令牌:去首尾空白/换行,并剥掉成对的引号(常见于 .env 里误带引号)
export function cleanToken(t) {
  if (t == null) return '';
  let s = String(t).trim();
  while (
    s.length >= 2 &&
    ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

// 把 clientTokens 归一化成 [{ token, name, overrides }]
function normalizeTokens(list) {
  const out = [];
  for (const item of list || []) {
    if (!item) continue;
    if (typeof item === 'string') {
      const token = cleanToken(item);
      if (token) out.push({ token, name: 'client', overrides: {} });
    } else if (item.token) {
      const token = cleanToken(item.token);
      if (token) out.push({ token, name: item.name || 'client', overrides: item.overrides && typeof item.overrides === 'object' ? item.overrides : {} });
    }
  }
  return out;
}

export function loadConfig() {
  const file = readConfigFile();

  const cfg = {
    host: process.env.CC_TRANS_HOST || file.host || DEFAULTS.host,
    port: Number(process.env.CC_TRANS_PORT || file.port || DEFAULTS.port),
    upstreamBaseUrl: (
      process.env.CC_TRANS_UPSTREAM_BASE_URL ||
      file.upstreamBaseUrl ||
      DEFAULTS.upstreamBaseUrl
    ).replace(/\/+$/, ''),
    upstreamApiKey:
      process.env.CC_TRANS_UPSTREAM_API_KEY || file.upstreamApiKey || DEFAULTS.upstreamApiKey,
    upstreamAuthToken:
      process.env.CC_TRANS_UPSTREAM_AUTH_TOKEN ||
      file.upstreamAuthToken ||
      DEFAULTS.upstreamAuthToken,
    oauthCredentialsPath:
      process.env.CC_TRANS_OAUTH_CREDENTIALS ||
      file.oauthCredentialsPath ||
      defaultCredentialsPath(),
    // inherit 模式的来源文件。留空不在这里兜默认值 —— 默认路径要按【运行用户】解析,
    // 交给 upstream_auth.js 的 defaultSettingsPath() 统一负责(与 oauth 的凭证路径同理)
    inheritSettingsPath:
      process.env.CC_TRANS_INHERIT_SETTINGS || file.inheritSettingsPath || DEFAULTS.inheritSettingsPath,
    clientTokens: normalizeTokens(
      process.env.CC_TRANS_CLIENT_TOKENS
        ? splitList(process.env.CC_TRANS_CLIENT_TOKENS)
        : file.clientTokens || DEFAULTS.clientTokens,
    ),
    // 用户账号只从文件读(没有环境变量入口:哈希串塞环境变量不现实)。
    // 漏了这一行会导致重启后用户全部登录不上 —— 曾经就是这样。
    users: Array.isArray(file.users) ? file.users : DEFAULTS.users,
    modelMap: file.modelMap || DEFAULTS.modelMap,
    upstreamProxy: process.env.CC_TRANS_UPSTREAM_PROXY || file.upstreamProxy || DEFAULTS.upstreamProxy,
    // ?? 而不是 ||:显式写 0(关闭防护)必须留住
    maxHops: Number(process.env.CC_TRANS_MAX_HOPS ?? file.maxHops ?? DEFAULTS.maxHops),
    dataDir: process.env.CC_TRANS_DATA_DIR || file.dataDir || DEFAULTS.dataDir,
    logBody: parseBool(process.env.CC_TRANS_LOG_BODY) ?? file.logBody ?? DEFAULTS.logBody,
    logFile: process.env.CC_TRANS_LOG_FILE || file.logFile || DEFAULTS.logFile,
    logMaxBytes: Number(process.env.CC_TRANS_LOG_MAX_BYTES || file.logMaxBytes || DEFAULTS.logMaxBytes),
    logMaxFiles: Number(process.env.CC_TRANS_LOG_MAX_FILES || file.logMaxFiles || DEFAULTS.logMaxFiles),
    logRetentionDays: Number(
      process.env.CC_TRANS_LOG_RETENTION_DAYS ?? file.logRetentionDays ?? DEFAULTS.logRetentionDays,
    ),
    // 用 ?? 而不是 ||:显式写 0(不限)必须留住,`||` 会把它当假值换回 200
    chatMaxSessions: Number(
      process.env.CC_TRANS_CHAT_MAX_SESSIONS ?? file.chatMaxSessions ?? DEFAULTS.chatMaxSessions,
    ),
    chatMaxMessages: Number(
      process.env.CC_TRANS_CHAT_MAX_MESSAGES ?? file.chatMaxMessages ?? DEFAULTS.chatMaxMessages,
    ),
    adminEnabled: parseBool(process.env.CC_TRANS_ADMIN_ENABLED) ?? file.adminEnabled ?? DEFAULTS.adminEnabled,
    adminUser: process.env.CC_TRANS_ADMIN_USER || file.adminUser || DEFAULTS.adminUser,
    adminPassword: process.env.CC_TRANS_ADMIN_PASSWORD || file.adminPassword || DEFAULTS.adminPassword,
    adminNote: file.adminNote || DEFAULTS.adminNote,
    adminCreatedAt: Number(file.adminCreatedAt) || DEFAULTS.adminCreatedAt,
    __file: file.__file,
    __shadowed: file.__shadowed || null, // 另一处也有 config.json,启动时要告警
  };

  // 上游鉴权方式:显式 upstreamAuth 优先;否则有静态密钥就走 apiKey,否则默认走订阅 OAuth。
  //
  // inherit 只认【显式声明】,永不推断 —— 「本机 settings.json 里有 ANTHROPIC_BASE_URL」
  // 这件事太常见(任何用过中转的机器都有),据此静默把上游改掉是灾难级的意外。
  const explicit = process.env.CC_TRANS_UPSTREAM_AUTH || file.upstreamAuth;
  const hasStatic = !!(cfg.upstreamApiKey || cfg.upstreamAuthToken);
  cfg.upstreamAuth = explicit || (hasStatic ? 'apiKey' : 'oauth');

  validate(cfg);
  return cfg;
}

function parseBool(v) {
  if (v === undefined) return undefined;
  return v === '1' || String(v).toLowerCase() === 'true';
}

function validate(cfg) {
  const problems = [];
  if (!UPSTREAM_AUTH_MODES.has(cfg.upstreamAuth)) {
    problems.push(
      `upstreamAuth 只能是 ${[...UPSTREAM_AUTH_MODES].join(' / ')} 之一,收到 "${cfg.upstreamAuth}" —— ` +
        `拼错时会被当成静态密钥处理,那比直接报错难查得多`,
    );
  }
  // inherit 模式的校验(来源文件可读 / 有地址与令牌 / 不是自环)放在 upstream_auth.js
  // 建 provider 时做:自环判定要用到监听端口与本机地址,而且 check-token 子命令
  // 得能在上游不可用时照样跑 —— 它只查令牌,不该被上游拖死。
  if (cfg.upstreamAuth === 'oauth') {
    // 订阅模式:校验本机 Claude Code 凭证可用。三种失败要分开报,报错指错方向比不报还糟:
    //   「断链」   —— ~/.claude 链到别的盘而那块盘没挂上(realpath 只给 ENOENT,和没登录同形)
    //   「读不了」 —— 运行用户 uid 与 ~/.claude 属主不一致(容器 PUID 设错、systemd 换了用户)
    //   「不存在」 —— 真没登录过
    let credErr = null;
    let credReal = cfg.oauthCredentialsPath;
    try {
      credReal = resolveCredentialsFile(cfg.oauthCredentialsPath).real;
      fs.accessSync(credReal, fs.constants.R_OK);
    } catch (err) {
      credErr = err;
    }
    if (credErr && (credErr.code === 'EBROKENLINK' || credErr.code === 'EEMPTYDIR')) {
      problems.push(credErr.message);
    } else if (credErr && (credErr.code === 'EACCES' || credErr.code === 'EPERM')) {
      const uid = process.getuid ? process.getuid() : '?';
      const via = credReal !== cfg.oauthCredentialsPath ? `(软链接实际指向 ${credReal})` : '';
      problems.push(
        `OAuth 凭证文件读不了(当前 uid=${uid},权限不足): ${cfg.oauthCredentialsPath}${via} —— ` +
          `Docker 里用 PUID/PGID 对齐宿主机 ~/.claude 的属主;裸机部署请让服务运行用户能读该文件`,
      );
    } else if (credErr) {
      problems.push(
        `OAuth 订阅模式但找不到凭证文件: ${cfg.oauthCredentialsPath} —— 请先在服务器上 \`claude\` 登录订阅`,
      );
    } else {
      try {
        const info = inspectCredentials(cfg.oauthCredentialsPath);
        cfg.oauthInfo = info;
        if (!info.hasRefresh) {
          problems.push('凭证缺少 refreshToken,token 过期后无法自动刷新,请重新 `claude` 登录');
        }
      } catch (err) {
        problems.push(`OAuth 凭证文件无法解析: ${err.message}`);
      }
    }
  } else if (cfg.upstreamAuth === 'apiKey' && !cfg.upstreamApiKey && !cfg.upstreamAuthToken) {
    problems.push('apiKey 模式但未配置上游凭证:需要 upstreamApiKey 或 upstreamAuthToken 之一');
  }
  if (cfg.clientTokens.length === 0) {
    problems.push('未配置 clientTokens:至少需要一个客户端访问令牌(用 `npm run gen-token` 生成)');
  }
  if (!Number.isInteger(cfg.port) || cfg.port <= 0) {
    problems.push(`端口非法: ${cfg.port}`);
  }
  if (problems.length) {
    const hint =
      '\n请在仓库根目录创建 config.json(参考 config.example.json),或设置对应环境变量。';
    throw new Error('配置无效:\n  - ' + problems.join('\n  - ') + hint);
  }
}
