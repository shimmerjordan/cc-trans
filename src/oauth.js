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

// 当前用户的家目录。优先 /etc/passwd 的 pw_dir 而不是 $HOME:
// setuid 降权(deploy/drop-privs.mjs)、sudo、cron 都会留下一个属于别人的 HOME,
// 照着它找凭证会解析到 /root/.claude 这种根本不存在的地方。
// uid 不在 passwd 里时(容器设了任意 PUID)userInfo 会抛,那就退回 os.homedir()。
export function homeDir() {
  try {
    const h = os.userInfo().homedir;
    if (h) return h;
  } catch {
    /* 落到下面的兜底 */
  }
  return os.homedir();
}

export function defaultCredentialsPath() {
  return path.join(homeDir(), '.claude', '.credentials.json');
}

// 沿路径逐段找第一条断掉的软链接。~/.claude 常被链到别的盘,那块盘没挂上时
// realpath 只给一个 ENOENT,和「压根没登录过」长得一模一样 —— 得把话说清楚。
function findBrokenLink(file) {
  const abs = path.resolve(file);
  const parts = abs.split(path.sep).filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur += path.sep + p;
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return null; // 这一段本身就不存在 = 真缺文件,不是断链
    }
    if (st.isSymbolicLink()) {
      const target = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
      if (!fs.existsSync(target)) return { link: cur, target };
      cur = fs.realpathSync(cur); // 跟进去继续查后面的段
    }
  }
  return null;
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// 把 ~/.claude 下某个文件的路径解析成真实文件路径(穿透软链接:文件本身的、以及
// 路径中任何一层目录的)。读写都要先过这里 —— 见 writeCredentials 里为什么不能
// 直接对软链接路径动手。每次调用都重新解析:claude 重新登录可能换掉链接目标。
//
// label / bareHint 只影响报错措辞。订阅凭证(oauth 模式)与本机 settings.json
// (inherit 模式)踩的是同一批坑 —— ~/.claude 链到别的盘、容器挂载源被换掉、
// uid 与属主不一致 —— 所以两者共用这一套诊断,而不是各写一个 ENOENT。
export function resolveLocalFile(file, { label = '文件', bareHint = '' } = {}) {
  try {
    const real = fs.realpathSync(file);
    return { real, viaLink: real !== path.resolve(file) };
  } catch (err) {
    if (err.code === 'ENOENT') {
      const broken = findBrokenLink(file);
      if (broken) {
        throw fail(
          'EBROKENLINK',
          `${label}软链接已断: ${broken.link} → ${broken.target}(目标不存在)—— ` +
            `若目标在另一块盘/网络存储上,先确认它已挂载(systemd 可加 RequiresMountsFor=);` +
            `Docker 里还要注意软链接目标路径在容器内也得存在`,
        );
      }
      // 目录在、却是空的:容器里看不到「断链」,只看得到一个空挂载点。
      // 典型成因是宿主的 ~/.claude 在容器启动【之后】被换掉(比如改成了软链接),
      // bind mount 还绑着旧 inode。报「请先 claude 登录」会让人白折腾一遍登录。
      const dir = path.dirname(path.resolve(file));
      let empty = false;
      try {
        empty = fs.readdirSync(dir).length === 0;
      } catch {
        /* 目录也不在,那就是普通的 ENOENT */
      }
      if (empty) {
        throw fail(
          'EEMPTYDIR',
          `${label}目录是空的: ${dir} —— Docker 里多为挂载源在容器启动后被换过` +
            `(比如宿主 ~/.claude 改成了软链接),容器仍绑着旧的挂载点,` +
            `\`docker compose up -d --force-recreate\` 重建即可${bareHint ? ';' + bareHint : ''}`,
        );
      }
    }
    throw fail(err.code || 'EUNKNOWN', `读取${label}失败 ${file}: ${err.message}`);
  }
}

// 订阅凭证的解析(oauth 模式)。独立入口保留:调用点多,且它的报错是「没登录」语义。
export function resolveCredentialsFile(file) {
  return resolveLocalFile(file, { label: '订阅凭证', bareHint: '裸机上则确实是没登录过' });
}

// 给 config 校验用:确认凭证文件存在且含 accessToken
export function inspectCredentials(file) {
  const { real } = resolveCredentialsFile(file);
  const raw = fs.readFileSync(real, 'utf8');
  const j = JSON.parse(raw);
  const o = j.claudeAiOauth;
  if (!o || !o.accessToken) throw new Error('凭证文件缺少 claudeAiOauth.accessToken');
  return {
    expiresAt: o.expiresAt || 0,
    subscriptionType: o.subscriptionType,
    hasRefresh: !!o.refreshToken,
    real,
  };
}

// 原子写回:临时文件 + rename,权限 0600,调用方只改 token 三件套、其余字段原样保留。
// 两处都必须用 realpath 后的路径:
//   - rename 到软链接【路径】会把链接本身替换成普通文件,之后 cc-trans 与本机 claude
//     各写各的副本,token 悄悄分叉
//   - tmp 建在软链接所在目录时,若目标在另一个文件系统上,rename 直接 EXDEV 失败
export function writeCredentials(file, json) {
  const { real } = resolveCredentialsFile(file);
  const dir = path.dirname(real);
  const tmp = path.join(dir, `${path.basename(real)}.cc-trans.tmp.${process.pid}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(json, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, real);
  } catch (err) {
    try {
      fs.unlinkSync(tmp); // 别在人家 ~/.claude 里留垃圾
    } catch {
      /* tmp 可能压根没建起来 */
    }
    throw new Error(`写回订阅凭证失败 ${real}: ${err.message}`);
  }
  return real;
}

export function createOAuthProvider(credPath, logger = () => {}) {
  const file = credPath || defaultCredentialsPath();
  let refreshing = null; // 进程内刷新锁,避免并发重复刷新

  function read() {
    let raw;
    try {
      // 软链接在这里穿透(断链会带着诊断抛出来,不会被误当成「没登录」)
      raw = fs.readFileSync(resolveCredentialsFile(file).real, 'utf8');
    } catch (err) {
      const hint = err.code === 'EBROKENLINK' ? '' : '(请在服务器上先 `claude` 登录)';
      throw new Error(`${err.message}${hint}`);
    }
    const j = JSON.parse(raw);
    if (!j.claudeAiOauth || !j.claudeAiOauth.accessToken) {
      throw new Error(`凭证文件缺少 claudeAiOauth.accessToken: ${file}`);
    }
    return j;
  }

  const writeBack = (j) => writeCredentials(file, j);

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
