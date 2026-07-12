import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code 订阅(Pro/Max/Team)的 OAuth 转发。
// 凭证来自服务器本机 `~/.claude/.credentials.json` 的 claudeAiOauth。
// 实测要点(已用真实订阅 token 验证):
//   - Authorization: Bearer <accessToken>(不能用 x-api-key)
//   - 必带 anthropic-beta: oauth-2025-04-20,否则上游不认订阅 token
//   - 非 Haiku 模型的请求 system 须以 "You are Claude Code..." 开头(远端 Claude Code 天然满足)

export const OAUTH_BETA_FLAG = 'oauth-2025-04-20';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // Claude Code 的公开 OAuth client_id
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const REFRESH_SKEW_MS = 5 * 60 * 1000; // 到期前 5 分钟就提前刷新

export function defaultCredentialsPath() {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

// 给 config 校验用:确认凭证文件存在且含 accessToken
export function inspectCredentials(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const j = JSON.parse(raw);
  const o = j.claudeAiOauth;
  if (!o || !o.accessToken) throw new Error('凭证文件缺少 claudeAiOauth.accessToken');
  return { expiresAt: o.expiresAt || 0, subscriptionType: o.subscriptionType, hasRefresh: !!o.refreshToken };
}

export function createOAuthProvider(credPath, logger = () => {}) {
  const file = credPath || defaultCredentialsPath();
  let refreshing = null; // 进程内刷新锁,避免并发重复刷新

  function read() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`读取订阅凭证失败 ${file}: ${err.message}(请在服务器上先 \`claude\` 登录)`);
    }
    const j = JSON.parse(raw);
    if (!j.claudeAiOauth || !j.claudeAiOauth.accessToken) {
      throw new Error(`凭证文件缺少 claudeAiOauth.accessToken: ${file}`);
    }
    return j;
  }

  // 原子写回:写临时文件 + rename,权限 0600,只改 token 三件套,其余字段原样保留
  function writeBack(j) {
    const tmp = `${file}.cc-trans.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  async function doRefresh(current) {
    const refreshToken = current.claudeAiOauth.refreshToken;
    if (!refreshToken) {
      throw new Error('凭证无 refreshToken,无法自动刷新,请在服务器上重新 `claude` 登录');
    }
    // 网络层瞬时失败重试(刷新失败会让客户端直接吃 502)
    let res = null;
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        res = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: CLIENT_ID,
          }),
        });
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
    if (!res) throw new Error(`刷新订阅 token 网络失败: ${lastErr.message}`);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`刷新订阅 token 失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`刷新返回非 JSON: ${text.slice(0, 120)}`);
    }
    if (!data.access_token) throw new Error('刷新返回里没有 access_token');

    // 刷新可能轮换 refresh_token;务必持久化返回值。写回前重读盘,避免覆盖 Claude Code 同时写入的其它字段。
    let latest;
    try {
      latest = read();
    } catch {
      latest = current;
    }
    latest.claudeAiOauth = {
      ...latest.claudeAiOauth,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || latest.claudeAiOauth.refreshToken,
      expiresAt: Date.now() + (data.expires_in || 28800) * 1000,
    };
    writeBack(latest);
    logger(`已刷新订阅 token,新到期 ${new Date(latest.claudeAiOauth.expiresAt).toISOString()}`);
    return latest;
  }

  // 返回一个当前有效的 access token,必要时刷新
  async function getAccessToken() {
    const j = read();
    const expiresAt = j.claudeAiOauth.expiresAt || 0;
    // 仍在有效期内(留出提前量)→ 直接用。这也天然吃到服务器自己 Claude Code 刚刷新的结果。
    if (Date.now() < expiresAt - REFRESH_SKEW_MS) {
      return j.claudeAiOauth.accessToken;
    }
    if (!refreshing) {
      refreshing = doRefresh(j).finally(() => {
        refreshing = null;
      });
    }
    const refreshed = await refreshing;
    return refreshed.claudeAiOauth.accessToken;
  }

  // 只读探查当前凭证状态(不刷新),供管理台展示
  function peek() {
    try {
      const j = read();
      return {
        expiresAt: j.claudeAiOauth.expiresAt || 0,
        subscriptionType: j.claudeAiOauth.subscriptionType,
        hasRefresh: !!j.claudeAiOauth.refreshToken,
      };
    } catch {
      return null;
    }
  }

  return { getAccessToken, peek, file, beta: OAUTH_BETA_FLAG };
}
