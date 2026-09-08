// 压缩包读取器的测试。
//
// 样本一律用系统的 zip / tar / gzip 现造 —— 不用自己写的打包器去喂自己的解包器,
// 那种往返测试会让"两边共享同一个理解错误"完全隐形。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { detectArchive, readArchive } from '../src/archive.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-arc-'));
const src = path.join(tmp, 'proj');
fs.mkdirSync(path.join(src, 'src'), { recursive: true });
fs.mkdirSync(path.join(src, 'img'), { recursive: true });
fs.writeFileSync(path.join(src, 'README.md'), '# 项目说明\n\n这是一个测试项目。\n');
fs.writeFileSync(path.join(src, 'src', 'app.js'), 'const a = 1;\nexport default a;\n');
fs.writeFileSync(path.join(src, 'img', 'logo.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
fs.writeFileSync(path.join(src, 'manual.pdf'), Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]));
const zipPath = path.join(tmp, 'proj.zip');
execFileSync('zip', ['-q', '-r', zipPath, 'proj'], { cwd: tmp });
const zipBuf = fs.readFileSync(zipPath);

// ── 1. 识别格式 ──
{
  ok('认得 ZIP', detectArchive(zipBuf, 'proj.zip').format === 'zip');
  const tgz = path.join(tmp, 'proj.tgz');
  execFileSync('tar', ['-czf', tgz, 'proj'], { cwd: tmp });
  ok('认得 tar.gz', detectArchive(fs.readFileSync(tgz), 'proj.tgz').format === 'tgz');
  const tar = path.join(tmp, 'proj.tar');
  execFileSync('tar', ['-cf', tar, 'proj'], { cwd: tmp });
  ok('认得 tar', detectArchive(fs.readFileSync(tar), 'proj.tar').format === 'tar');
  const gz = path.join(tmp, 'one.txt.gz');
  fs.writeFileSync(path.join(tmp, 'one.txt'), 'just one file\n');
  execFileSync('gzip', ['-kf', path.join(tmp, 'one.txt')]);
  ok('认得单文件 gz', detectArchive(fs.readFileSync(gz), 'one.txt.gz').format === 'gz');

  // 7z / RAR 认得出是什么，但明确不支持
  const sevenz = Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), Buffer.alloc(64)]);
  ok('7z 认得出但标为不支持', detectArchive(sevenz, 'a.7z').unsupported === '7z',
    JSON.stringify(detectArchive(sevenz, 'a.7z')));
  const rar = Buffer.concat([Buffer.from('Rar!\x1a\x07\x00'), Buffer.alloc(64)]);
  ok('RAR 认得出但标为不支持', detectArchive(rar, 'a.rar').unsupported === 'RAR');

  // Office 文档本质是 ZIP，但按压缩包展开只会吐一堆 XML 垃圾 —— 必须排除
  const docx = path.join(tmp, 'a.docx');
  fs.mkdirSync(path.join(tmp, 'off'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'off', '[Content_Types].xml'), '<?xml version="1.0"?><Types/>');
  execFileSync('zip', ['-q', '-r', docx, '.'], { cwd: path.join(tmp, 'off') });
  const dd = detectArchive(fs.readFileSync(docx), 'a.docx');
  ok('docx 不当成压缩包展开', dd.format === null && !!dd.office, JSON.stringify(dd));
}

// ── 2. 真的读出内容 ──
{
  const r = readArchive(zipBuf, {});
  ok('ZIP 读取成功', r.ok === true, r.error || '');
  const byPath = Object.fromEntries(r.entries.map((e) => [e.path, e]));
  ok('读到 README.md', !!byPath['proj/README.md'], Object.keys(byPath).join(','));
  ok('README 内容正确', byPath['proj/README.md'] &&
    byPath['proj/README.md'].data.toString('utf8').includes('这是一个测试项目'));
  ok('读到 src/app.js', !!byPath['proj/src/app.js']);
  ok('读到二进制 PNG 且字节完好', !!byPath['proj/img/logo.png'] &&
    byPath['proj/img/logo.png'].data[0] === 0x89 && byPath['proj/img/logo.png'].data[1] === 0x50);
  ok('读到 PDF', !!byPath['proj/manual.pdf'] &&
    byPath['proj/manual.pdf'].data.slice(0, 5).toString() === '%PDF-');
  ok('目录本身不算条目', !r.entries.some((e) => e.path.endsWith('/')));

  const tgzBuf = fs.readFileSync(path.join(tmp, 'proj.tgz'));
  const t = readArchive(tgzBuf, {});
  ok('tar.gz 读取成功', t.ok === true, t.error || '');
  const tByPath = Object.fromEntries(t.entries.map((e) => [e.path, e]));
  ok('tar.gz 里也读到 README', !!tByPath['proj/README.md'] &&
    tByPath['proj/README.md'].data.toString('utf8').includes('这是一个测试项目'));
  ok('tar.gz 里读到嵌套路径', !!tByPath['proj/src/app.js']);
}

// ── 3. 安全:炸弹 ──
{
  // 10MB 的全 A 压成 ~10KB。不设防的话它会在内存里胀回 10MB;
  // 真实炸弹能到 TB 级。必须【边解边拦】,不能先解完再判断。
  const bomb = Buffer.alloc(10 * 1024 * 1024, 0x41);
  const zipBomb = path.join(tmp, 'bomb.zip');
  fs.writeFileSync(path.join(tmp, 'bomb.bin'), bomb);
  execFileSync('zip', ['-q', '-j', zipBomb, path.join(tmp, 'bomb.bin')]);
  const r = readArchive(fs.readFileSync(zipBomb), { maxTotalBytes: 512 * 1024 });
  ok('炸弹被拦下(没有解满)', r.ok === false || r.truncated === true, JSON.stringify({ ok: r.ok, tr: r.truncated, err: r.error }));
  const got = (r.entries || []).reduce((n, e) => n + e.data.length, 0);
  ok('拦下后产出没有超过预算', got <= 512 * 1024, String(got));
}

// ── 4. 安全:路径穿越 ──
{
  // 系统的 zip 会自己剥掉 ../，造不出恶意样本，所以这里手搓一个 ZIP。
  // 被测的是【读取器的路径处理】，不是 zip 的打包逻辑，手搓样本是恰当的。
  function makeZip(entries) {
    const locals = [], central = [];
    let off = 0;
    for (const [name, body] of entries) {
      const n = Buffer.from(name, 'utf8'), d = Buffer.from(body);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0, 8);                    // method 0 = stored
      lh.writeUInt32LE(0, 14);                   // crc（读取器不校验）
      lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22);
      lh.writeUInt16LE(n.length, 26); lh.writeUInt16LE(0, 28);
      locals.push(lh, n, d);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0, 10);
      ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24);
      ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
      central.push(ch, n);
      off += 30 + n.length + d.length;
    }
    const localBuf = Buffer.concat(locals), centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
    return Buffer.concat([localBuf, centralBuf, eocd]);
  }

  const evil = makeZip([
    ['../../../etc/passwd', 'pwned'],
    ['/absolute/root.txt', 'abs'],
    ['C:\\Windows\\sys.ini', 'win'],
    ['ok/normal.txt', 'fine'],
    ['deep/../../../escape.txt', 'esc'],
  ]);
  const r = readArchive(evil, {});
  ok('恶意 ZIP 仍能读出正常条目', r.ok === true && r.entries.length > 0, JSON.stringify(r.entries.map((e) => e.path)));
  // 判据是【逃不出根】：不能有 .. 段、不能是绝对路径、不能带盘符
  const escapes = r.entries.filter((e) => {
    const segs = e.path.split('/');
    return segs.includes('..') || e.path.startsWith('/') || /^[a-zA-Z]:/.test(e.path);
  });
  ok('没有任何条目能逃出根目录', escapes.length === 0, JSON.stringify(escapes.map((e) => e.path)));
  ok('正常条目原样保留', r.entries.some((e) => e.path === 'ok/normal.txt'), JSON.stringify(r.entries.map((e) => e.path)));
  ok('穿越路径被拍平而不是整包失败', r.entries.some((e) => e.path === 'etc/passwd'), JSON.stringify(r.entries.map((e) => e.path)));
}

// ── 5. 加密条目要说清楚，而不是当成坏文件 ──
{
  const enc = path.join(tmp, 'enc.zip');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'top secret\n');
  try {
    execFileSync('zip', ['-q', '-j', '-P', 'pw123', enc, path.join(tmp, 'secret.txt')]);
    const r = readArchive(fs.readFileSync(enc), {});
    const why = (r.skipped || []).map((s) => s.why).join(' ');
    ok('加密条目被标为「加密」而不是损坏', /加密|密码/.test(why), JSON.stringify(r.skipped));
  } catch {
    console.log('SKIP  zip 不支持 -P，跳过加密用例');
  }
}

// ── 6. 嵌套压缩包只列出、不递归展开(递归是炸弹的主要放大路径)──
{
  const outer = path.join(tmp, 'outer.zip');
  execFileSync('zip', ['-q', '-j', outer, zipPath]);
  const r = readArchive(fs.readFileSync(outer), {});
  const inner = (r.entries || []).find((e) => e.path.endsWith('.zip'));
  ok('嵌套包作为一个条目原样返回', !!inner, JSON.stringify((r.entries || []).map((e) => e.path)));
  ok('没有把嵌套包的内容也摊平进来', !(r.entries || []).some((e) => e.path.includes('README')));
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
