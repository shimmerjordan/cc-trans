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
  refreshModels: '刷新模型列表(影响所有人)',
});
// refreshModels 是这里唯一默认【关】的权限:别的几个都只是"看自己的东西",
// 而刷新模型列表会改写全局共享的模型库 —— 所有人下次拿到的列表都跟着变。
// 这种全局写操作该由管理员显式授予,不该跟着"新建用户"默认带上。
export const DEFAULT_PERMS = Object.freeze({ chat: true, logs: true, cost: true, revealToken: true, refreshModels: false });

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

// 老配置里没有 passVersion(这个字段是后加的)。缺失一律视作 0,
// 于是"老会话 + 老用户"仍然对得上,而任何一次改密都会把它推到 1 以上。
export function passVersionOf(u) {
  const n = Number(u && u.passVersion);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 密码强度下限。服务端是唯一权威(前端那份只是提前告知),两处都用这个常量。
export const MIN_PASSWORD_LEN = 8;

// 给前端/管理台复用的强度评估。刻意不做"必须含大写+数字+符号"那套 ——
// 那只会把人赶向 Password1! 这类可预测的写法。长度是唯一真正线性提升难度的维度,
// 其余只做提示。
export function passwordIssues(pw) {
  const s = String(pw || '');
  const out = [];
  if (s.length < MIN_PASSWORD_LEN) out.push(`至少 ${MIN_PASSWORD_LEN} 位`);
  if (/^\d+$/.test(s)) out.push('不要只用数字');
  if (/^(.)\1*$/.test(s) && s.length) out.push('不要用重复的单个字符');
  return out;
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
      passChangedAt: u.passChangedAt || 0,
      // 凭证版本:登录会话记住签发时的值,改密码就 +1,旧会话下一个请求即失效。
      // 借鉴 sub2api 的 TokenVersion —— 那是"改了密码,别处还登着"这个老问题
      // 唯一靠得住的解法(挨个去翻 session Map 迟早漏掉一处)。
      passVersion: passVersionOf(u),
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
    const bad = passwordIssues(pw);
    if (bad.length) return { ok: false, error: '密码' + bad.join('、') };
    const u = {
      name: n,
      pass: hashPassword(pw),
      tokenIds: [...new Set(tokenIds.filter(Boolean).map(String))],
      disabled: false,
      createdAt: Date.now(),
      lastLoginAt: 0,
      passVersion: 1,
      passChangedAt: Date.now(),
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

  // 管理员设置某个用户的密码。keepSessions 只给"我知道自己在干什么"的场合留口子,
  // 默认是踢掉该用户所有在线会话 —— 管理员改别人密码的动机通常就是"这个号可能
  // 被别人拿到了",这时候把旧会话留着等于什么都没做。
  function setPassword(name, password, { keepSessions = false } = {}) {
    const u = find(name);
    if (!u) return { ok: false, error: '用户不存在' };
    const pw = String(password || '');
    const bad = passwordIssues(pw);
    if (bad.length) return { ok: false, error: '密码' + bad.join('、') };
    u.pass = hashPassword(pw);
    u.passChangedAt = Date.now();
    if (!keepSessions) u.passVersion = passVersionOf(u) + 1;
    save();
    log(`[audit] 管理员重置了用户 ${name} 的密码${keepSessions ? '(保留在线会话)' : '(其在线会话已全部失效)'}`);
    return { ok: true, user: publicOf(u) };
  }

  // 用户自助改密:必须验旧密码。改完 passVersion +1 —— 别处登着的同一个账号
  // 会当场掉线,这正是"我怀疑密码泄露了所以来改密码"想要的结果。
  function changePassword(name, oldPw, newPw) {
    const u = find(name);
    if (!u) return { ok: false, error: '用户不存在' };
    if (!verifyPassword(oldPw, u.pass)) return { ok: false, error: '当前密码不正确' };
    const bad = passwordIssues(newPw);
    if (bad.length) return { ok: false, error: '新密码' + bad.join('、') };
    if (verifyPassword(newPw, u.pass)) return { ok: false, error: '新密码与当前密码相同' };
    u.pass = hashPassword(newPw);
    u.passChangedAt = Date.now();
    u.passVersion = passVersionOf(u) + 1;
    save();
    log(`[audit] 用户 ${name} 修改了自己的密码(其它在线会话已失效)`);
    return { ok: true, user: publicOf(u) };
  }

  // 不改密码,只把该用户所有在线会话作废(「退出所有设备」)
  function revokeSessions(name) {
    const u = find(name);
    if (!u) return { ok: false, error: '用户不存在' };
    u.passVersion = passVersionOf(u) + 1;
    save();
    log(`[audit] 用户 ${name} 的所有登录会话已作废`);
    return { ok: true, user: publicOf(u) };
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
    // 显式传入才改;【生效后】等同全默认就删掉字段,配置文件保持干净。
    //
    // 比的是"合并到默认之上的结果",不是"传了几个键"。按键数比的话,
    // DEFAULT_PERMS 每加一个新权限,老调用方(只传旧的那几个键)就再也清不干净了 ——
    // 加 refreshModels 时就这么坏过一次。
    if (np) {
      const eff = { ...DEFAULT_PERMS, ...np };
      if (Object.keys(DEFAULT_PERMS).every((k) => eff[k] === DEFAULT_PERMS[k])) delete u.perms;
      else u.perms = np;
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

  // 只验凭证,不产生任何副作用(不动 lastLoginAt、不落盘)。
  // 用途:管理台登录失败时判断"这其实是个普通用户账号吗" —— 只有对方确实
  // 报出了这个账号的正确密码,才把"你该去用户端登录"这句话说出口。
  // 密码没对上就一律回落到通用错误,免得变成账号存在性探测器。
  function verifyCredentials(name, password) {
    const u = find(name);
    if (!u) return false;
    return verifyPassword(password, u.pass);
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
    revokeSessions,
    setTokens,
    setPerms,
    setQuota,
    ownerOfToken,
    setDisabled,
    forgetToken,
    authenticate,
    verifyCredentials,
    activeUser,
    canManage,
    count: () => users.length,
  };
}
