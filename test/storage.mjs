// 存储统计与清理。两个重点:
//   1. **统计的自洽性** —— 各类之和必须恒等于目录实测总量,否则这个面板不可信
//   2. **删对东西** —— 图片按内容寻址、多会话共享,删会话时不能把别人还在用的图删掉
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { du, createStorage } from '../src/storage.js';
import { createChatStore } from '../src/chat_store.js';
import { createLogStore } from '../src/logstore.js';

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

// 一张真 PNG(魔数要过 chat_store 的校验),内容不同则 hash 不同
function png(tag) {
  const base = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082',
    'hex',
  );
  return Buffer.concat([base, Buffer.from(tag)]); // 尾部塞点料,换个内容换个 hash
}
const b64 = (buf) => buf.toString('base64');

// 把文件的 mtime 调老,越过孤儿清扫的宽限期(刚上传的图不该被当孤儿删掉)
function age(file, hours = 2) {
  const t = new Date(Date.now() - hours * 3600_000);
  fs.utimesSync(file, t, t);
}
function ageAll(dir, hours = 2) {
  for (const n of fs.readdirSync(dir)) age(path.join(dir, n), hours);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sto-'));

// ── du:递归统计,且不跟符号链接 ──
{
  const d = path.join(tmp, 'du');
  fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(d, 'f1'), 'x'.repeat(100));
  fs.writeFileSync(path.join(d, 'a', 'f2'), 'y'.repeat(50));
  fs.writeFileSync(path.join(d, 'a', 'b', 'f3'), 'z'.repeat(25));
  const r = du(d);
  ok('du 递归统计大小', r.bytes === 175, `${r.bytes}`);
  ok('du 递归统计文件数', r.files === 3, `${r.files}`);

  // 自指的符号链接:跟进去就是死循环
  try {
    fs.symlinkSync(d, path.join(d, 'loop'));
    const r2 = du(d);
    ok('符号链接不被跟进(不死循环、不重复计数)', r2.bytes === 175 && r2.files === 3, `${r2.bytes}/${r2.files}`);
  } catch {
    ok('符号链接不被跟进(不死循环、不重复计数)', true, '本平台建不了 symlink,跳过');
  }
  ok('不存在的路径返回 0', du(path.join(tmp, 'nope')).bytes === 0);
}

// ── 图片引用清扫:删会话不能误删别人还在用的图 ──
{
  const dir = path.join(tmp, 'chats1');
  const cs = createChatStore({ dir });
  const shared = b64(png('shared'));
  const solo = b64(png('solo'));
  const idShared = cs.putImage('u1', { data: shared, mime: 'image/png' }).id;
  const idSolo = cs.putImage('u1', { data: solo, mime: 'image/png' }).id;
  ok('同内容图片去重成同一个 id', cs.putImage('u1', { data: shared, mime: 'image/png' }).id === idShared);

  const a = cs.create('u1', { title: 'A' }).session;
  const b = cs.create('u1', { title: 'B' }).session;
  cs.save('u1', { ...cs.get('u1', a.id), messages: [{ role: 'user', content: 'x', images: [{ id: idShared }, { id: idSolo }] }] });
  cs.save('u1', { ...cs.get('u1', b.id), messages: [{ role: 'user', content: 'y', images: [{ id: idShared }] }] });

  const md = path.join(dir, 'u1', 'media');
  ok('两张图都在盘上', fs.readdirSync(md).length === 2, fs.readdirSync(md).join(','));

  cs.remove('u1', a.id);
  const left = fs.readdirSync(md);
  ok('删会话后,它独占的图被清掉', !left.includes(idSolo), left.join(','));
  ok('删会话后,别的会话还在用的图必须留着', left.includes(idShared), left.join(','));

  cs.remove('u1', b.id);
  ok('最后一个引用者也删掉后,共享图才被清', fs.readdirSync(md).length === 0);
}

// ── clear:一条会话不剩,整个 media 目录端掉 ──
{
  const dir = path.join(tmp, 'chats2');
  const cs = createChatStore({ dir });
  const s = cs.create('u1', { title: 'A' }).session;
  const id = cs.putImage('u1', { data: b64(png('c2')), mime: 'image/png' }).id;
  cs.save('u1', { ...cs.get('u1', s.id), messages: [{ role: 'user', content: 'x', images: [{ id }] }] });
  cs.clear('u1');
  ok('clear 后会话为空', cs.list('u1').length === 0);
  ok('clear 后图片目录也没了', !fs.existsSync(path.join(dir, 'u1', 'media')));
}

// ── 超上限淘汰也要清扫图片 ──
{
  const dir = path.join(tmp, 'chats3');
  const cs = createChatStore({ dir, maxSessions: 2 });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const s = cs.create('u1', { title: 't' + i }).session;
    const im = cs.putImage('u1', { data: b64(png('evict' + i)), mime: 'image/png' }).id;
    ids.push(im);
    cs.save('u1', { ...cs.get('u1', s.id), messages: [{ role: 'user', content: 'x', images: [{ id: im }] }] });
    await new Promise((r) => setTimeout(r, 3)); // 岔开 updatedAt,淘汰顺序才确定
  }
  const left = fs.readdirSync(path.join(dir, 'u1', 'media'));
  ok('淘汰最旧会话时连它的图一起清', left.length === 2 && !left.includes(ids[0]), left.join(','));
}

// ── 孤儿清扫:历史遗留(引用清扫是后加的)──
{
  const dir = path.join(tmp, 'chats4');
  const cs = createChatStore({ dir });
  const s = cs.create('u1', { title: 'A' }).session;
  const used = cs.putImage('u1', { data: b64(png('used')), mime: 'image/png' }).id;
  const orphan1 = cs.putImage('u1', { data: b64(png('orph1')), mime: 'image/png' }).id;
  const orphan2 = cs.putImage('u1', { data: b64(png('orph2')), mime: 'image/png' }).id;
  cs.save('u1', { ...cs.get('u1', s.id), messages: [{ role: 'user', content: 'x', images: [{ id: used }] }] });
  const md4 = path.join(dir, 'u1', 'media');

  // 宽限期:刚上传还没发送的图,按引用判定是孤儿,但绝不能删
  const fresh = cs.sweepOrphanMedia('u1');
  ok('宽限期内的孤儿不被删', fresh.removed === 0 && fresh.skippedRecent === 2, JSON.stringify(fresh));
  ok('宽限期内文件确实还在', fs.readdirSync(md4).length === 3);

  ageAll(md4); // 越过宽限期
  const dry = cs.sweepOrphanMedia('u1', { dryRun: true });
  ok('dryRun 只数不删', dry.removed === 2 && fs.readdirSync(md4).length === 3, JSON.stringify(dry));

  const r = cs.sweepOrphanMedia('u1');
  ok('孤儿清扫扫描了全部文件', r.scanned === 3, `${r.scanned}`);
  ok('孤儿清扫删掉 2 张', r.removed === 2, `${r.removed}`);
  ok('dryRun 的数量与真删一致', dry.removed === r.removed && dry.bytes === r.bytes);
  ok('孤儿清扫释放了字节数', r.bytes > 0, `${r.bytes}`);
  const left = fs.readdirSync(md4);
  ok('在用的图没被误删', left.length === 1 && left[0] === used, left.join(','));
  void orphan1;
  void orphan2;
  ok('再扫一次是空操作', cs.sweepOrphanMedia('u1').removed === 0);
  ok('非法用户名被拒', cs.sweepOrphanMedia('../etc').ok === false);
  ok('listUsers 列出聊天用户', cs.listUsers().includes('u1'), cs.listUsers().join(','));
}

// ── scan:各类之和恒等于目录实测总量 ──
const dataDir = path.join(tmp, 'data');
{
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'metrics.json'), JSON.stringify({ a: 1 }));
  fs.writeFileSync(path.join(dataDir, 'models.json'), JSON.stringify({ models: [] }));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: 1 }));
  fs.writeFileSync(path.join(dataDir, 'config.json.bak-20260101-000000'), 'old1');
  fs.writeFileSync(path.join(dataDir, 'config.json.bak-20260102-000000'), 'old2');
  fs.writeFileSync(path.join(dataDir, '奇怪的文件.dat'), 'x'.repeat(999)); // 归「其它」

  const logDir = path.join(dataDir, 'logs');
  const logStore = createLogStore({ dir: logDir, retentionDays: 14 });
  logStore.append({ ts: Date.now(), status: 200, path: '/v1/messages', client: 'a' });
  logStore.flush(); // 内部是 stream.end(),异步 —— 不等一下 stat 出来还是 0 字节
  await new Promise((r) => setTimeout(r, 80));

  const chatStore = createChatStore({ dir: path.join(dataDir, 'chats') });
  const s = chatStore.create('u1', { title: 'A' }).session;
  const used = chatStore.putImage('u1', { data: b64(png('scan-used')), mime: 'image/png' }).id;
  chatStore.putImage('u1', { data: b64(png('scan-orph')), mime: 'image/png' });
  chatStore.save('u1', { ...chatStore.get('u1', s.id), messages: [{ role: 'user', content: 'x', images: [{ id: used }] }] });
  ageAll(path.join(dataDir, 'chats', 'u1', 'media')); // 越过宽限期,面板才会把它算作可清理

  // 进程日志放在 dataDir 【之外】:不能算进本目录的归类
  const outDir = path.join(tmp, 'proclog');
  fs.mkdirSync(outDir, { recursive: true });
  const logFile = path.join(outDir, 'cc.log');
  fs.writeFileSync(logFile, 'current');
  fs.writeFileSync(logFile + '.1', 'rot1');
  fs.writeFileSync(logFile + '.2', 'rot2');

  const st = createStorage({ dataDir, chatStore, logStore, configFile: path.join(dataDir, 'config.json'), logFile });
  const scan = st.scan();
  const inside = scan.categories.filter((c) => c.key !== 'procLog');
  const sum = inside.reduce((a, c) => a + c.bytes, 0);
  const real = du(dataDir);
  ok('各类之和 = 数据目录实测总量', sum === real.bytes, `${sum} vs ${real.bytes}`);
  ok('文件数也对得上', inside.reduce((a, c) => a + c.files, 0) === real.files);
  ok('totalBytes 就是实测值', scan.totalBytes === real.bytes);

  const by = Object.fromEntries(scan.categories.map((c) => [c.key, c]));
  ok('认出配置备份 2 个', by.backups.files === 2, `${by.backups.files}`);
  ok('认出未归类文件进「其它」', by.other.bytes === 999, `${by.other.bytes}`);
  ok('认出请求日志', by.logs.bytes > 0);
  ok('聊天图片与会话分开算', by.chatMedia.files === 2 && by.chatSessions.files > 0, `media=${by.chatMedia.files} sess=${by.chatSessions.files}`);
  ok('数出孤儿图片', scan.orphans.files === 1, `${scan.orphans.files}`);
  ok('面板报的可清理数 = 真清理数(同一段判定)', scan.orphans.files === chatStore.sweepOrphanMedia('u1', { dryRun: true }).removed);
  ok('metrics/models/config 不给清理按钮', !by.metrics.clean && !by.models.clean && !by.config.clean);
  ok('「其它」不给清理按钮', !by.other.clean);
  ok('可回收 = 孤儿 + 备份 + 轮转件', scan.reclaimableBytes === scan.orphans.bytes + by.backups.bytes + 8, `${scan.reclaimableBytes}`);

  // 进程日志在 dataDir 外:算它自己的,但不并进目录总量
  ok('进程日志统计到 3 个文件', by.procLog.files === 3, `${by.procLog.files}`);
  ok('目录外的进程日志不进「其它」', by.other.bytes === 999);

  // ── 清理 ──
  const r1 = st.prune('chatMedia', 'orphans');
  ok('清理孤儿图片', r1.ok && r1.removed === 1, JSON.stringify(r1));
  ok('清理后释放字节 > 0', r1.freed > 0, `${r1.freed}`);
  ok('在用的图还在', fs.existsSync(path.join(dataDir, 'chats', 'u1', 'media', used)));

  const r2 = st.prune('backups', 'all');
  ok('清理配置备份', r2.ok && r2.removed === 2, JSON.stringify(r2));
  ok('config.json 本体没被误删', fs.existsSync(path.join(dataDir, 'config.json')));

  const r3 = st.prune('procLog', 'rotated');
  ok('只删轮转件', r3.ok && r3.removed === 2, JSON.stringify(r3));
  ok('当前正在写的日志文件保留', fs.existsSync(logFile) && !fs.existsSync(logFile + '.1'));

  const r4 = st.prune('chatSessions', 'all');
  ok('清空全部会话', r4.ok && r4.removed === 1, JSON.stringify(r4));
  ok('清空会话后图片目录也没了', !fs.existsSync(path.join(dataDir, 'chats', 'u1', 'media')));

  // 一个会话都没有时,不该再给「清空全部会话」按钮(空的 index.json 也是一个文件,
  // 按文件数判会给出一个点了没反应的按钮)
  const noSess = st.scan().categories.find((c) => c.key === 'chatSessions');
  ok('无会话时不给清空按钮', !noSess.clean && noSess.files > 0, `files=${noSess.files} clean=${noSess.clean}`);

  ok('不认识的清理操作被拒', st.prune('metrics', 'all').ok === false);
  ok('不认识的模式被拒', st.prune('backups', 'nuke').ok === false);

  const after = st.scan();
  ok('清理后统计仍自洽', after.categories.filter((c) => c.key !== 'procLog').reduce((a, c) => a + c.bytes, 0) === du(dataDir).bytes);
  ok('清理后没有可回收项了', after.reclaimableBytes === 0, `${after.reclaimableBytes}`);
}

// ── 前缀陷阱:/data-old 不能被当成 /data 的子目录 ──
{
  const base = path.join(tmp, 'pfx');
  const sibling = path.join(tmp, 'pfx-old');
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(base, 'config.json'), '{}');
  fs.writeFileSync(path.join(sibling, 'cc.log'), 'x'.repeat(500));
  const st = createStorage({
    dataDir: base,
    chatStore: createChatStore({ dir: path.join(base, 'chats') }),
    logStore: createLogStore({ dir: path.join(base, 'logs') }),
    configFile: path.join(base, 'config.json'),
    logFile: path.join(sibling, 'cc.log'),
  });
  const s = st.scan();
  const by = Object.fromEntries(s.categories.map((c) => [c.key, c]));
  ok('同前缀的兄弟目录不算作数据目录内', by.other.bytes === 0, `other=${by.other.bytes} total=${s.totalBytes}`);
}

// ── 配置文件改了名,遗留的 config.json.bak-* 也得认出来 ──
{
  const base = path.join(tmp, 'renamed');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'my-conf.json'), '{}');
  fs.writeFileSync(path.join(base, 'my-conf.json.bak-20260101-000000'), 'a');
  fs.writeFileSync(path.join(base, 'config.json.bak-20250101-000000'), 'b'); // 老布局留下的
  const st = createStorage({
    dataDir: base,
    chatStore: createChatStore({ dir: path.join(base, 'chats') }),
    logStore: createLogStore({ dir: path.join(base, 'logs') }),
    configFile: path.join(base, 'my-conf.json'),
  });
  const by = Object.fromEntries(st.scan().categories.map((c) => [c.key, c]));
  ok('两种前缀的备份都认', by.backups.files === 2, `${by.backups.files}`);
  ok('配置本体不算备份', by.config.files === 1);
}

// ── 未启用数据目录时不炸 ──
{
  const st = createStorage({ dataDir: null });
  ok('无数据目录时 enabled=false', st.enabled === false);
  ok('无数据目录时 scan 不抛', st.scan().enabled === false);
  ok('无数据目录时 prune 返回错误', st.prune('backups', 'all').ok === false);
}

// ── HTTP:要登录才能看和清 ──
{
  const PORT = 19981;
  const BASE = `http://127.0.0.1:${PORT}`;
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sto-srv-'));
  const cfg = path.join(cfgDir, 'config.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      host: '127.0.0.1',
      port: PORT,
      upstreamAuth: 'apiKey',
      upstreamApiKey: 'sk-test',
      adminEnabled: true,
      adminPassword: 'sto-pw-123',
      dataDir: path.join(cfgDir, 'data'),
      clientTokens: [{ token: 'cct-' + 'e'.repeat(32), name: 'dev' }],
    }),
  );
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '../src/server.js')], {
    env: { ...process.env, CC_TRANS_CONFIG: cfg },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  child.stdout.on('data', (d) => (srvLog += d));
  child.stderr.on('data', (d) => (srvLog += d));
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        up = (await fetch(BASE + '/health')).ok;
      } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 150));
    }
    ok('服务启动', up, up ? '' : srvLog.slice(-400));

    ok('未登录看不到存储信息', (await fetch(BASE + '/admin/api/storage')).status === 401);
    ok('未登录不能清理', (await fetch(BASE + '/admin/api/storage/prune', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"key":"backups","mode":"all"}',
    })).status === 401);

    const s = await (await fetch(BASE + '/admin/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'sto-pw-123' }),
    })).json().then((d) => d.session);
    const auth = { authorization: 'Bearer ' + s };
    const d = await (await fetch(BASE + '/admin/api/storage', { headers: auth })).json();
    ok('登录后拿到存储统计', d.enabled === true && Array.isArray(d.categories), JSON.stringify(d).slice(0, 120));
    ok('统计自洽(经 HTTP)', d.categories.reduce((a, c) => a + c.bytes, 0) === d.totalBytes, `${d.totalBytes}`);
    ok('带上磁盘余量', !d.disk || (d.disk.free > 0 && d.disk.total > 0));

    const bad = await fetch(BASE + '/admin/api/storage/prune', {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: '{"key":"metrics","mode":"all"}',
    });
    ok('清 metrics 的请求被拒(接口层也不放行)', bad.status === 400);
  } finally {
    child.kill();
    await new Promise((r) => child.on('exit', r));
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
}

// ── 状态目录的默认位置:两种部署必须落到【同一个目录】 ──
// systemd/裸机历史上配置在 <仓库根>/config.json、Docker 在 <dataDir>/config.json,
// 而 dataDir 默认都是"配置同级的 data/"。两者共用同一个数据目录却各自一份配置,
// 就会漂移成"同一个服务两种界面"(真发生过:一边没有用户账号、日志保留天数也不同)。
// 所以配置本来就躺在 data/ 里时,状态目录就是那个目录 —— 不能再往下套一层 data/data。
{
  const cases = [
    { name: '配置在 data/ 里 → 状态目录就是它自己(不套 data/data)', sub: 'data', expect: (base) => path.join(base, 'data') },
    { name: '配置在上层目录 → 状态目录是同级的 data/', sub: '', expect: (base) => path.join(base, 'data') },
  ];
  for (const c of cases) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dd-'));
    const dir = c.sub ? path.join(base, c.sub) : base;
    fs.mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, 'config.json');
    const port = 19983 + cases.indexOf(c);
    fs.writeFileSync(cfg, JSON.stringify({
      host: '127.0.0.1', port, upstreamAuth: 'apiKey', upstreamApiKey: 'sk-test',
      adminEnabled: true, adminPassword: 'dd-pw-1234',
      clientTokens: [{ token: 'cct-' + 'f'.repeat(32), name: 'dev' }],
    }));
    const ch = spawn(process.execPath, [path.join(import.meta.dirname, '../src/server.js')], {
      env: { ...process.env, CC_TRANS_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let lg = '';
    ch.stdout.on('data', (d) => (lg += d));
    ch.stderr.on('data', (d) => (lg += d));
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch {}
        if (!up) await new Promise((r) => setTimeout(r, 150));
      }
      const want = c.expect(base);
      // 问服务自己解析成了哪个目录 —— metrics.json 是 20s 定时落盘的,
      // 启动后立刻查文件必然还不存在
      const sess = await (await fetch(`http://127.0.0.1:${port}/admin/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'dd-pw-1234' }),
      })).json().then((d) => d.session).catch(() => null);
      const got = sess
        ? await (await fetch(`http://127.0.0.1:${port}/admin/api/storage`, { headers: { authorization: 'Bearer ' + sess } })).json().then((d) => d.dataDir).catch(() => null)
        : null;
      ok(c.name, up && got === want, `解析到 ${got}(期望 ${want})`);
    } finally {
      ch.kill();
      await new Promise((r) => ch.on('exit', r));
      fs.rmSync(base, { recursive: true, force: true });
    }
  }

  // 配置里写死了另一种部署的路径(例如容器内 /app/data):要退回默认并说清原因,
  // 而不是等到第一次落盘才 EACCES 崩掉
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dd-bad-'));
    const cfg = path.join(base, 'config.json');
    const port = 19986;
    fs.writeFileSync(cfg, JSON.stringify({
      host: '127.0.0.1', port, upstreamAuth: 'apiKey', upstreamApiKey: 'sk-test',
      dataDir: '/app/data', // 真实场景:容器路径被裸机读到(宿主机上 /app 不存在且建不了)
      adminEnabled: true, adminPassword: 'dd-pw-1234',
      clientTokens: [{ token: 'cct-' + 'g'.repeat(32), name: 'dev' }],
    }));
    const ch = spawn(process.execPath, [path.join(import.meta.dirname, '../src/server.js')], {
      env: { ...process.env, CC_TRANS_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let lg = '';
    ch.stdout.on('data', (d) => (lg += d));
    ch.stderr.on('data', (d) => (lg += d));
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch {}
        if (!up) await new Promise((r) => setTimeout(r, 150));
      }
      ok('不可写的 dataDir 不会让服务起不来', up, lg.slice(-300));
      ok('并且明确告警说明退回到哪', /dataDir 不可写/.test(lg) && /已退回/.test(lg), (lg.split('\n').find((l) => l.includes('不可写')) || '').trim());
      const sess = await (await fetch(`http://127.0.0.1:${port}/admin/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'dd-pw-1234' }),
      })).json().then((d) => d.session).catch(() => null);
      const got = sess
        ? await (await fetch(`http://127.0.0.1:${port}/admin/api/storage`, { headers: { authorization: 'Bearer ' + sess } })).json().then((d) => d.dataDir).catch(() => null)
        : null;
      ok('状态目录退回到配置同级的 data/', got === path.join(base, 'data'), `解析到 ${got}`);
    } finally {
      ch.kill();
      await new Promise((r) => ch.on('exit', r));
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
