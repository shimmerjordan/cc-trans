import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCredentialsPath, inspectCredentials } from './oauth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8787,
  upstreamBaseUrl: 'https://api.anthropic.com',
  upstreamApiKey: '',
  upstreamAuthToken: '',
  oauthCredentialsPath: '',
  clientTokens: [],
  modelMap: {},
  logBody: false,
  adminEnabled: false,
  adminUser: 'admin',
  adminPassword: '',
};

function readConfigFile() {
  // 允许用 CC_TRANS_CONFIG 指定路径,否则用仓库根目录的 config.json
  const file = process.env.CC_TRANS_CONFIG || path.join(ROOT, 'config.json');
  if (!fs.existsSync(file)) return { __file: null };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...parsed, __file: file };
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

// 把 clientTokens 归一化成 [{ token, name }]
function normalizeTokens(list) {
  const out = [];
  for (const item of list || []) {
    if (!item) continue;
    if (typeof item === 'string') {
      const token = cleanToken(item);
      if (token) out.push({ token, name: 'client' });
    } else if (item.token) {
      const token = cleanToken(item.token);
      if (token) out.push({ token, name: item.name || 'client' });
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
    clientTokens: normalizeTokens(
      process.env.CC_TRANS_CLIENT_TOKENS
        ? splitList(process.env.CC_TRANS_CLIENT_TOKENS)
        : file.clientTokens || DEFAULTS.clientTokens,
    ),
    modelMap: file.modelMap || DEFAULTS.modelMap,
    logBody: parseBool(process.env.CC_TRANS_LOG_BODY) ?? file.logBody ?? DEFAULTS.logBody,
    adminEnabled: parseBool(process.env.CC_TRANS_ADMIN_ENABLED) ?? file.adminEnabled ?? DEFAULTS.adminEnabled,
    adminUser: process.env.CC_TRANS_ADMIN_USER || file.adminUser || DEFAULTS.adminUser,
    adminPassword: process.env.CC_TRANS_ADMIN_PASSWORD || file.adminPassword || DEFAULTS.adminPassword,
    __file: file.__file,
  };

  // 上游鉴权方式:显式 upstreamAuth 优先;否则有静态密钥就走 apiKey,否则默认走订阅 OAuth
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
  if (cfg.upstreamAuth === 'oauth') {
    // 订阅模式:校验本机 Claude Code 凭证可用
    if (!fs.existsSync(cfg.oauthCredentialsPath)) {
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
  } else if (!cfg.upstreamApiKey && !cfg.upstreamAuthToken) {
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
