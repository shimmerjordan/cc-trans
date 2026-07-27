// 普通用户数据层:账号、密码(scrypt)、与客户端令牌的绑定关系。
// 纯数据 + 校验,不碰 HTTP —— 用户端(user.js)和管理台(admin.js)共用这一份,
// 越权判断才不会两边各写一套、各错一处。
//
// 为什么用户密码必须哈希、而令牌和 adminPassword 仍是明文:
// 令牌是本服务自己生成、只用于本服务,明文落盘的风险止于此;用户密码是人选的、
// 极可能和别处复用,明文会把风险外溢到 cc-trans 之外。两类秘密不该同等对待。

import crypto from 'node:crypto';

// scrypt 参数:N=16384 在普通机器上约 50~80ms,足够挡离线爆破又不拖登录
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 32;

export function hashPassword(plain, saltB64 = null) {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  try {
    const expect = Buffer.from(hashB64, 'base64');
    const got = crypto.scryptSync(String(plain), Buffer.from(saltB64, 'base64'), expect.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return expect.length === got.length && crypto.timingSafeEqual(expect, got);
  } catch {
    return false;
  }
}

// 与 admin.js 的 idOf 必须一致 —— 令牌的稳定标识,轮换令牌后 id 变化(绑定随之失效,
// 这正是期望语义:令牌都吊销了,绑定不该还在)
export function tokenIdOf(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

const NAME_RE = /^[a-zA-Z0-9._-]{2,32}$/;
// 管理员在聊天里用的内部主体名,不能被真实用户占用(会话目录 chats/__admin__/)
const RESERVED_NAMES = new Set(['__admin__', 'admin']);

// 可配置权限。跨用户隔离是【硬边界】(谁都只能看自己的),这里是在此之上
// 进一步收窄单个用户能看什么 —— 默认全开,保持与旧配置兼容。
export const PERMS = Object.freeze({
  chat: '网页聊天',
  logs: '查看自己的请求日志',
  cost: '查看成本金额',
  revealToken: '取回令牌明文',
});
export const DEFAULT_PERMS = Object.freeze({ chat: true, logs: true, cost: true, revealToken: true });

// 用户级配额:与该用户【名下所有令牌】共享一份额度,而不是每个令牌各一份。
// 口径是 token 数与花费金额(不是请求次数 —— 一次长对话和一次 hello 差几个数量级)。
// 0 = 不限制,这是默认值。
export const QUOTA_WINDOWS = Object.freeze({ day: '每天', month: '每月', total: '累计' });
export const DEFAULT_QUOTA = Object.freeze({ window: 'month', tokens: 0, costUsd: 0 });

export function effectiveQuota(user) {
  const q = (user && user.quota) || {};
  const window = QUOTA_WINDOWS[q.window] ? q.window : DEFAULT_QUOTA.window;
  const tokens = Number.isFinite(Number(q.tokens)) && Number(q.tokens) > 0 ? Math.floor(Number(q.tokens)) : 0;
  const costUsd = Number.isFinite(Number(q.costUsd)) && Number(q.costUsd) > 0 ? Number(q.costUsd) : 0;
  return { window, tokens, costUsd, unlimited: !tokens && !costUsd };
}

function normalizeQuota(input) {
  if (!input || typeof input !== 'object') return undefined;
  const q = effectiveQuota({ quota: input });
  if (q.unlimited) return undefined; // 不限就不写字段,配置保持干净
  return { window: q.window, tokens: q.tokens, costUsd: q.costUsd };
}

// 未设置 = 用默认(向后兼容:老配置里没有 perms 字段)
export function effectivePerms(user) {
  const p = (user && user.perms) || {};
  const out = {};
  for (const k of Object.keys(DEFAULT_PERMS)) out[k] = typeof p[k] === 'boolean' ? p[k] : DEFAULT_PERMS[k];
  return out;
}

function normalizePerms(input) {
  if (!input || typeof input !== 'object') return undefined;
  const out = {};
  for (const k of Object.keys(DEFAULT_PERMS)) {
    if (typeof input[k] === 'boolean') out[k] = input[k];
  }
  return Object.keys(out).length ? out : undefined;
}

export function createUserStore({ config, persist, reservedName = null, log = () => {} } = {}) {
  // config.users 是权威数据;这里保持同一个数组引用,persist 负责写回 config.json
  if (!Array.isArray(config.users)) config.users = [];
  const users = config.users;

  const find = (name) => users.find((u) => u.name === String(name || '').trim());
  const canManage = () => typeof persist === 'function';

  function save() {
    if (typeof persist === 'function') persist(users);
  }

  // 对外视图:绝不包含密码哈希
  function publicOf(u) {
    return {
      name: u.name,
      tokenIds: [...(u.tokenIds || [])],
      disabled: !!u.disabled,
      createdAt: u.createdAt || 0,
      lastLoginAt: u.lastLoginAt || 0,
      note: u.note || '',
      perms: effectivePerms(u),
      quota: effectiveQuota(u),
    };
  }

  function list() {
    return users.map(publicOf);
  }

  function create({ name, password, tokenIds = [], note = '', perms, quota }) {
    const n = String(name || '').trim();
    if (!NAME_RE.test(n)) return { ok: false, error: '用户名需 2~32 位,仅限字母数字与 . _ -' };
    if (RESERVED_NAMES.has(n.toLowerCase())) return { ok: false, error: `"${n}" 是保留名,请换一个` };
    // 管理台登录名可以被改成任意名字,所以这个禁用名是动态的(见 server.js reservedName)。
    // 和管理员同名 = "这个账号该去 /admin 还是 /u 登录"没有答案。
    if (reservedName) {
      const admin = String(reservedName() || '').toLowerCase();
      if (admin && admin === n.toLowerCase()) return { ok: false, error: `"${n}" 是管理台登录名,请换一个` };
    }
    if (find(n)) return { ok: false, error: '用户名已存在' };
    const pw = String(password || '');
    if (pw.length < 8) return { ok: false, error: '密码至少 8 位' };
    const u = {
      name: n,
      pass: hashPassword(pw),
      tokenIds: [...new Set(tokenIds.filter(Boolean).map(String))],
      disabled: false,
      createdAt: Date.now(),
      lastLoginAt: 0,
      note: String(note || '').slice(0, 200),
    };
    const np = normalizePerms(perms);
    if (np) u.perms = np;
    const nq = normalizeQuota(quota);
    if (nq) u.quota = nq;
    users.push(u);
    save();
    log(`已创建用户 ${n}(绑定 ${u.tokenIds.length} 个令牌)`);
    return { ok: true, user: publicOf(u) };
  }

  function remove(name) {
    const i = users.findIndex((u) => u.name === String(name || '').trim());
    if (i === -1) return { ok: false, error: '用户不存在' };
    users.splice(i, 1);
    save();
    log(`已删除用户 ${name}`);
    return { ok: true };
  }

  function setPassword(name, password) {
    const u = find(name);
    if (!u) return { ok: false, error: '用户不存在' };
    const pw = String(password || '');
    if (pw.length < 8) return { ok: false, error: '密码至少 8 位' };
    u.pass = hashPassword(pw);
    save();
    log(`已重置用户 ${name} 的密码`);
    return { ok: true };
  }

  // 用户自助改密:必须验旧密码
  function changePassword(name, oldPw, newPw) {
    const u = find(name);
    if (!u) return { ok: false, error: '用户不存在' };
    if (!verifyPassword(oldPw, u.pass)) return { ok: false, error: '当前密码不正确' };
    if (String(newPw || '').length < 8) return { ok: false, error: '新密码至少 8 位' };
    u.pass = hashPassword(newPw);
    save();
    log(`用户 ${name} 修改了自己的密码`);
    return { ok: true };
  }

  function setTokens(name, tokenIds) {
    const u = find(name);
    if (!u) return { ok: false, error: '用户不存在' };
    u.tokenIds = [...new Set((tokenIds || []).filter(Boolean).map(String))];
    save();
    log(`用户 ${name} 的令牌绑定已更新(${u.tokenIds.length} 个)`);
    return { ok: true, user: publicOf(u) };
  }

  function setPerms(name, perms) {
    const u = find(name);
    if (!u) return { ok: false, error: '用户不存在' };
    const np = normalizePerms(perms);
    // 显式传入才改;全默认时删掉字段,配置文件保持干净
    if (np && Object.keys(np).length === Object.keys(DEFAULT_PERMS).length &&
        Object.keys(DEFAULT_PERMS).every((k) => np[k] === DEFAULT_PERMS[k])) {
      delete u.perms;
    } else if (np) {
      u.perms = np;
    }
    save();
    log(`用户 ${name} 的权限已更新: ${JSON.stringify(effectivePerms(u))}`);
    return { ok: true, user: publicOf(u) };
  }

  function setQuota(name, quota) {
    const u = find(name);
    if (!u) return { ok: false, error: '用户不存在' };
    const nq = normalizeQuota(quota);
    if (nq) u.quota = nq;
    else delete u.quota; // 全 0 = 不限,删字段
    save();
    log(`用户 ${name} 的配额已更新: ${JSON.stringify(effectiveQuota(u))}`);
    return { ok: true, user: publicOf(u) };
  }

  // 令牌 → 归属用户的反查(转发层要按用户聚合配额)。
  // 一个令牌理论上可分给多个用户;取第一个未禁用的,保证行为可预期。
  function ownerOfToken(tokenId) {
    for (const u of users) {
      if (u.disabled) continue;
      if ((u.tokenIds || []).includes(tokenId)) return publicOf(u);
    }
    return null;
  }

  function setDisabled(name, disabled) {
    const u = find(name);
    if (!u) return { ok: false, error: '用户不存在' };
    u.disabled = !!disabled;
    save();
    log(`用户 ${name} 已${u.disabled ? '禁用' : '启用'}`);
    return { ok: true, user: publicOf(u) };
  }

  // 令牌被吊销后清理所有用户身上的悬空绑定
  function forgetToken(tokenId) {
    let touched = false;
    for (const u of users) {
      const before = (u.tokenIds || []).length;
      u.tokenIds = (u.tokenIds || []).filter((id) => id !== tokenId);
      if (u.tokenIds.length !== before) touched = true;
    }
    if (touched) save();
    return touched;
  }

  // 登录:返回 publicOf 或明确的失败原因。禁用用户不给过。
  function authenticate(name, password) {
    const u = find(name);
    // 用户不存在时也走一次哈希,避免用响应时间探测账号是否存在
    if (!u) {
      verifyPassword(password, hashPassword('dummy-for-timing'));
      return { ok: false, error: '账号或密码错误' };
    }
    if (!verifyPassword(password, u.pass)) return { ok: false, error: '账号或密码错误' };
    if (u.disabled) return { ok: false, error: '账号已被禁用' };
    u.lastLoginAt = Date.now();
    save();
    return { ok: true, user: publicOf(u) };
  }

  // 每个请求都要用:禁用/删除要立刻生效,不能只在登录时判一次
  function activeUser(name) {
    const u = find(name);
    if (!u || u.disabled) return null;
    return publicOf(u);
  }

  return {
    list,
    create,
    remove,
    setPassword,
    changePassword,
    setTokens,
    setPerms,
    setQuota,
    ownerOfToken,
    setDisabled,
    forgetToken,
    authenticate,
    activeUser,
    canManage,
    count: () => users.length,
  };
}
