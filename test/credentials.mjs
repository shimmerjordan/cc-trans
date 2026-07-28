// 订阅凭证的路径解析与写回。三个重点:
//   1. **软链接要透明** —— ~/.claude 常被链到别的盘(/data 等),读写都得落到真实文件上
//   2. **写回不能吃掉软链接** —— rename 到软链接路径会把链接本身替换成普通文件,
//      从此 cc-trans 和本机 claude 各写各的,token 分叉;跨设备时还会直接 EXDEV 报错
//   3. **死链要说人话** —— 目标盘没挂上时报「请先 claude 登录」会把人带偏
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  homeDir,
  defaultCredentialsPath,
  resolveCredentialsFile,
  writeCredentials,
  inspectCredentials,
} from '../src/oauth.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const creds = (token = 'sk-ant-oat01-aaa', extra = {}) => ({
  claudeAiOauth: {
    accessToken: token,
    refreshToken: 'sk-ant-ort01-bbb',
    expiresAt: Date.now() + 3600_000,
    subscriptionType: 'max',
    ...extra,
  },
  // 非 token 字段:写回必须原样留着(claude 自己会用)
  otherField: 'keep-me',
});

const write = (f, j) => fs.writeFileSync(f, JSON.stringify(j, null, 2));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
// 目录里有没有残留的 .cc-trans.tmp.*
const tmpLeft = (dir) => fs.readdirSync(dir).filter((n) => n.includes('cc-trans.tmp'));
function grab(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cred-'));

// ── 1. 普通文件:没有软链接时行为不变 ───────────────────────────────
{
  const dir = path.join(tmp, 'plain');
  fs.mkdirSync(dir);
  const f = path.join(dir, '.credentials.json');
  write(f, creds());

  const r = resolveCredentialsFile(f);
  ok('1 普通文件解析到自身', r.real === fs.realpathSync(f), r.real);
  ok('1 普通文件 viaLink=false', r.viaLink === false);
  ok('1 inspect 正常', inspectCredentials(f).subscriptionType === 'max');
}

// ── 2. 目录软链接(~/.claude → /data/...,当前部署形态)────────────────
{
  const real = path.join(tmp, 'realhome', '.claude');
  fs.mkdirSync(real, { recursive: true });
  const link = path.join(tmp, 'linkhome-claude');
  fs.symlinkSync(real, link);
  const f = path.join(link, '.credentials.json');
  write(f, creds());

  const r = resolveCredentialsFile(f);
  ok('2 目录软链解析到真实路径', r.real === path.join(fs.realpathSync(real), '.credentials.json'), r.real);
  ok('2 目录软链 viaLink=true', r.viaLink === true);
  ok('2 经软链能读', inspectCredentials(f).hasRefresh === true);

  // 写回:必须落到真实目录,链接目录本身仍是链接
  writeCredentials(f, creds('sk-ant-oat01-new'));
  ok('2 写回落到真实文件', readJson(path.join(real, '.credentials.json')).claudeAiOauth.accessToken === 'sk-ant-oat01-new');
  ok('2 链接目录仍是软链', fs.lstatSync(link).isSymbolicLink());
  ok('2 无残留 tmp', tmpLeft(real).length === 0, tmpLeft(real).join(','));
}

// ── 3. 文件本身是软链接:写回后链接必须还在 ─────────────────────────
{
  const dir = path.join(tmp, 'filelink');
  const store = path.join(tmp, 'filelink-store');
  fs.mkdirSync(dir);
  fs.mkdirSync(store);
  const target = path.join(store, 'real-creds.json');
  write(target, creds());
  const f = path.join(dir, '.credentials.json');
  fs.symlinkSync(target, f);

  const r = resolveCredentialsFile(f);
  ok('3 文件软链解析到目标', r.real === fs.realpathSync(target), r.real);

  writeCredentials(f, creds('sk-ant-oat01-rotated'));
  ok('3 写回后仍是软链接', fs.lstatSync(f).isSymbolicLink());
  ok('3 目标内容已更新', readJson(target).claudeAiOauth.accessToken === 'sk-ant-oat01-rotated');
  ok('3 非 token 字段保留', readJson(target).otherField === 'keep-me');
  ok('3 tmp 建在目标目录且已清理', tmpLeft(store).length === 0 && tmpLeft(dir).length === 0);
  ok('3 权限 0600', (fs.statSync(target).mode & 0o777) === 0o600, (fs.statSync(target).mode & 0o777).toString(8));
}

// ── 4. 目录死链(/data 还没挂上):必须说是软链接断了,不能说「没登录」──
{
  const link = path.join(tmp, 'dead-dir-link');
  const missing = path.join(tmp, 'never-mounted');
  fs.symlinkSync(missing, link);
  const f = path.join(link, '.credentials.json');

  const err = grab(() => resolveCredentialsFile(f));
  ok('4 目录死链抛错', !!err);
  ok('4 code=EBROKENLINK', err && err.code === 'EBROKENLINK', err && err.code);
  ok('4 报错点名软链接', err && err.message.includes('软链接'), err && err.message);
  ok('4 报错含链接与目标路径', err && err.message.includes(link) && err.message.includes(missing), err && err.message);

  const err2 = grab(() => inspectCredentials(f));
  ok('4 inspect 也走同一诊断', err2 && err2.message.includes('软链接'), err2 && err2.message);
}

// ── 5. 文件死链 ────────────────────────────────────────────────────
{
  const dir = path.join(tmp, 'dead-file');
  fs.mkdirSync(dir);
  const f = path.join(dir, '.credentials.json');
  const missing = path.join(tmp, 'gone-creds.json');
  fs.symlinkSync(missing, f);

  const err = grab(() => resolveCredentialsFile(f));
  ok('5 文件死链 code=EBROKENLINK', err && err.code === 'EBROKENLINK', err && err.code);
  ok('5 报错含目标路径', err && err.message.includes(missing), err && err.message);
}

// ── 6. 真的没有这个文件:保持原来的「没登录」语义 ───────────────────
{
  const f = path.join(tmp, 'nothing-here', '.credentials.json');
  const err = grab(() => resolveCredentialsFile(f));
  ok('6 缺文件 code=ENOENT', err && err.code === 'ENOENT', err && err.code);
  ok('6 缺文件不提软链接', err && !err.message.includes('软链接'), err && err.message);
}

// ── 6b. 目录在但是空的:Docker 里挂载源被换掉后的样子 ────────────────
// 容器内看不到软链接,只看到一个空挂载点 —— 报「没登录」会让人白折腾一遍。
{
  const dir = path.join(tmp, 'empty-mount');
  fs.mkdirSync(dir);
  const err = grab(() => resolveCredentialsFile(path.join(dir, '.credentials.json')));
  ok('6b 空目录 code=EEMPTYDIR', err && err.code === 'EEMPTYDIR', err && err.code);
  ok('6b 提示重建容器', err && err.message.includes('force-recreate'), err && err.message);
}

// ── 7. 默认路径不受 HOME 环境变量污染 ──────────────────────────────
// setuid 降权、sudo、cron 都会留下一个错的 HOME;凭证要按当前 uid 的 passwd 项找。
{
  const saved = process.env.HOME;
  process.env.HOME = '/nonexistent-home-for-test';
  const expected = os.userInfo().homedir;
  ok('7 homeDir 忽略污染的 HOME', homeDir() === expected, `${homeDir()} vs ${expected}`);
  ok(
    '7 默认路径按当前用户解析',
    defaultCredentialsPath() === path.join(expected, '.claude', '.credentials.json'),
    defaultCredentialsPath(),
  );
  process.env.HOME = saved;
}

// ── 8. 写回失败不留垃圾 ────────────────────────────────────────────
{
  const dir = path.join(tmp, 'readonly-target');
  fs.mkdirSync(dir);
  const f = path.join(dir, '.credentials.json');
  write(f, creds());
  fs.chmodSync(dir, 0o500); // 目录不可写 → 建 tmp 就失败

  const err = grab(() => writeCredentials(f, creds('nope')));
  const skip = process.getuid && process.getuid() === 0; // root 无视目录权限
  fs.chmodSync(dir, 0o700);
  if (skip) {
    console.log('SKIP  8 写回失败清理(以 root 运行,写权限拦不住)');
  } else {
    ok('8 写回失败会抛错', !!err);
    ok('8 失败后无残留 tmp', tmpLeft(dir).length === 0, tmpLeft(dir).join(','));
    ok('8 原文件未被破坏', readJson(f).claudeAiOauth.accessToken === 'sk-ant-oat01-aaa');
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
