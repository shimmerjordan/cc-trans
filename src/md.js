// Markdown → 安全 HTML + 代码高亮。零依赖,纯函数,可脱离浏览器单测。
//
// 安全基线(这是本项目唯一的注入面,模型输出是不可信内容):
//   1. 一切文本先 escapeHtml,再只生成【本文件自己认识的】标签
//   2. 绝不把输入里的标签/属性透传出去 —— 没有"白名单标签"这回事,只有白名单输出
//   3. 链接只允许 http/https/mailto,其余(javascript:、data:、vbscript:)一律降级为纯文本
//   4. 高亮先分词再转义,不对已转义的串做正则替换(否则会把 &lt; 这类实体切坏)
//
// 支持的语法子集:标题、粗/斜/删除线、行内码、围栏代码块、有序/无序列表(可嵌套)、
// 引用、表格、水平线、链接。够读技术回答,不追求 CommonMark 全兼容。

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
}

// 把已转义的串还原(用于校验 URL 的真实内容)。&amp; 必须最后处理。
function unescapeHtml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// 只允许安全协议。相对路径(不含 :)也放行。
function safeUrl(raw) {
  const u = String(raw || '').trim();
  if (!u) return null;
  // 合法 URL 里这些字符必须是百分号编码的。出现裸的就是在试图闭合属性/标签 —— 直接拒。
  if (/["'<>`\s]/.test(u)) return null;
  // 去掉可能用来绕过协议检查的控制字符
  const flat = u.replace(/[\u0000-\u001f]/g, '').toLowerCase();
  if (/^(javascript|data|vbscript|file|blob):/.test(flat)) return null;
  if (/^[a-z][a-z0-9+.-]*:/.test(flat) && !/^(https?|mailto):/.test(flat)) return null;
  return u;
}

// ── 代码高亮 ────────────────────────────────────────────────────────────
// 先分词、再逐 token 转义,这样不会破坏 HTML 实体。

const KEYWORDS = {
  js: 'const let var function return if else for while break continue new class extends super this typeof instanceof await async yield throw try catch finally switch case default delete in of do export import from as void null undefined true false',
  ts: 'const let var function return if else for while break continue new class extends super this typeof instanceof await async yield throw try catch finally switch case default delete in of do export import from as void null undefined true false interface type enum implements private public protected readonly namespace declare satisfies keyof infer',
  py: 'def class return if elif else for while break continue import from as with try except finally raise lambda yield await async global nonlocal pass del assert in is not and or None True False self match case',
  go: 'func package import return if else for range break continue switch case default type struct interface map chan go defer select var const nil true false make new len cap append copy panic recover string int int64 float64 bool byte rune error',
  rust: 'fn let mut const static struct enum impl trait for while loop if else match return break continue use pub mod crate self super where as dyn ref move unsafe async await Some None Ok Err Box Vec String str i32 i64 u32 u64 f64 bool usize',
  java: 'public private protected class interface extends implements return if else for while do break continue switch case default new this super try catch finally throw throws import package static final abstract synchronized volatile transient native void int long double float boolean char byte short String null true false var record sealed',
  sql: 'select from where group by order having limit offset insert into values update set delete create table alter drop index view join left right inner outer on as and or not null distinct count sum avg min max case when then else end union all primary key foreign references default constraint',
  bash: 'if then else elif fi for while do done case esac in function return export local readonly declare unset shift echo printf cd exit set trap source alias',
  css: 'important media supports keyframes from to and not only screen print',
  html: '',
  json: 'true false null',
};
KEYWORDS.javascript = KEYWORDS.js;
KEYWORDS.typescript = KEYWORDS.ts;
KEYWORDS.jsx = KEYWORDS.js;
KEYWORDS.tsx = KEYWORDS.ts;
KEYWORDS.python = KEYWORDS.py;
KEYWORDS.sh = KEYWORDS.bash;
KEYWORDS.shell = KEYWORDS.bash;
KEYWORDS.zsh = KEYWORDS.bash;
KEYWORDS.yaml = 'true false null yes no on off';
KEYWORDS.yml = KEYWORDS.yaml;

// 注释语法按语言分派(# 系 vs // 系)
function commentPattern(lang) {
  if (['py', 'python', 'bash', 'sh', 'shell', 'zsh', 'yaml', 'yml', 'toml', 'ini', 'conf'].includes(lang)) {
    return '#[^\\n]*';
  }
  if (['html', 'xml', 'svg', 'md', 'markdown'].includes(lang)) return '<!--[\\s\\S]*?-->';
  if (lang === 'sql') return '--[^\\n]*|/\\*[\\s\\S]*?\\*/';
  if (lang === 'css') return '/\\*[\\s\\S]*?\\*/';
  return '//[^\\n]*|/\\*[\\s\\S]*?\\*/';
}

const CLS = { com: 'hl-com', str: 'hl-str', num: 'hl-num', kw: 'hl-kw', fn: 'hl-fn', tag: 'hl-tag' };

export function highlight(code, lang = '') {
  const l = String(lang || '').toLowerCase();
  const src = String(code == null ? '' : code);
  if (!(l in KEYWORDS) && !['xml', 'svg', 'toml', 'ini', 'conf', 'diff', 'md', 'markdown'].includes(l)) {
    return escapeHtml(src); // 未知语言:纯等宽,不猜
  }
  const kws = (KEYWORDS[l] || '').split(/\s+/).filter(Boolean);
  const kwRe = kws.length ? `\\b(?:${kws.join('|')})\\b` : null;
  // 顺序即优先级:注释 > 字符串 > 数字 > 关键字 > 函数名/标签
  const parts = [
    `(?<com>${commentPattern(l)})`,
    `(?<str>"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)`,
    `(?<num>\\b(?:0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)`,
  ];
  if (kwRe) parts.push(`(?<kw>${kwRe})`);
  if (['html', 'xml', 'svg'].includes(l)) parts.push(`(?<tag>&lt;\\/?[a-zA-Z][\\w:-]*|<\\/?[a-zA-Z][\\w:-]*)`);
  else parts.push(`(?<fn>\\b[A-Za-z_$][\\w$]*(?=\\s*\\())`);

  const re = new RegExp(parts.join('|'), 'g');
  let out = '';
  let last = 0;
  for (const m of src.matchAll(re)) {
    out += escapeHtml(src.slice(last, m.index));
    const g = m.groups;
    const kind = g.com != null ? 'com' : g.str != null ? 'str' : g.num != null ? 'num' : g.kw != null ? 'kw' : g.tag != null ? 'tag' : 'fn';
    out += `<span class="${CLS[kind]}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  out += escapeHtml(src.slice(last));
  return out;
}

// ── 行内 ────────────────────────────────────────────────────────────────
// 用不可打印占位符暂存行内代码,避免它内部的 * _ [ ] 被当作标记。
// 输入里的 \u0000 已在 render 入口剥掉,所以占位符不会被伪造。
const PH = '\u0000';

function inline(text) {
  const codes = [];
  let s = String(text).replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, ticks, body) => {
    codes.push(body.trim());
    return `${PH}${codes.length - 1}${PH}`;
  });

  s = escapeHtml(s);

  // 链接:[text](url)。text 已转义;url 过协议白名单后再转义。
  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, url) => {
    // url 此刻是【转义后】的串:必须完整还原再校验,否则 &quot; 会被再转义成
    // &amp;quot;(虽然仍安全,但链接就坏了)
    const safe = safeUrl(unescapeHtml(url));
    if (!safe) return label; // 危险协议 → 只留文字,不生成链接
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
  });
  // 裸 URL 自动链接(避免吃掉已生成的 href="...")
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>"']+)/g, (m, pre, url) => {
    const safe = safeUrl(unescapeHtml(url));
    if (!safe) return m;
    return `${pre}<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(url)}</a>`;
  });

  s = s
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])__([^_\n]+)__/g, '$1<strong>$2</strong>')
    .replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // 回填行内代码(内容单独转义)
  s = s.replace(new RegExp(`${PH}(\\d+)${PH}`, 'g'), (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  return s;
}

// ── 块级 ────────────────────────────────────────────────────────────────

function isHr(line) {
  return /^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line);
}
function listMatch(line) {
  const m = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
  if (!m) return null;
  return { indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), text: m[3] };
}

// 表格:| a | b |  +  | --- | --- |
function tableAt(lines, i) {
  if (!/\|/.test(lines[i] || '')) return null;
  const sep = lines[i + 1] || '';
  if (!/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(sep)) return null;
  const cells = (row) =>
    row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const head = cells(lines[i]);
  const aligns = cells(sep).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : 'left'));
  const rows = [];
  let j = i + 2;
  while (j < lines.length && /\|/.test(lines[j]) && lines[j].trim()) {
    rows.push(cells(lines[j]));
    j++;
  }
  return { head, aligns, rows, next: j };
}

/**
 * 渲染 Markdown 为安全 HTML。
 * @param {string} md
 * @returns {string} HTML(只含本文件生成的标签)
 */
export function renderMarkdown(md) {
  // 剥控制字符:既防占位符伪造,也防用零宽/控制符藏东西
  const text = String(md == null ? '' : md).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let codeIndex = 0; // 代码块序号:前端据此把块关联到 artifact

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块(优先级最高:里面的一切都不按 markdown 解析)
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const len = fence[1].length;
      const lang = (fence[2] || '').toLowerCase();
      const buf = [];
      i++;
      while (i < lines.length) {
        const close = new RegExp(`^\\s{0,3}${marker === '`' ? '`' : '~'}{${len},}\\s*$`).test(lines[i]);
        if (close) {
          i++;
          break;
        }
        buf.push(lines[i]);
        i++;
      }
      const code = buf.join('\n');
      out.push(
        `<div class="code-block" data-lang="${escapeHtml(lang)}" data-code-index="${codeIndex++}">` +
          `<div class="code-head"><span class="code-lang">${escapeHtml(lang || 'text')}</span>` +
          `<button class="code-copy" type="button" data-copy>复制</button></div>` +
          `<pre><code>${highlight(code, lang)}</code></pre></div>`,
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    if (isHr(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    // 引用:收集连续 > 行后递归渲染
    if (/^\s{0,3}>/.test(line)) {
      const buf = [];
      while (i < lines.length && (/^\s{0,3}>/.test(lines[i]) || (buf.length && lines[i].trim()))) {
        buf.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    const tbl = tableAt(lines, i);
    if (tbl) {
      const th = tbl.head.map((c, k) => `<th style="text-align:${tbl.aligns[k] || 'left'}">${inline(c)}</th>`).join('');
      const body = tbl.rows
        .map((r) => `<tr>${r.map((c, k) => `<td style="text-align:${tbl.aligns[k] || 'left'}">${inline(c)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`);
      i = tbl.next;
      continue;
    }

    // 列表:按缩进建嵌套
    const lm = listMatch(line);
    if (lm) {
      const stack = []; // { indent, ordered }
      const html = [];
      while (i < lines.length) {
        const cur = listMatch(lines[i]);
        if (!cur) {
          // 允许列表项内的续行(缩进 ≥2 的普通文本)
          if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && stack.length) {
            html.push(' ' + inline(lines[i].trim()));
            i++;
            continue;
          }
          break;
        }
        while (stack.length && cur.indent < stack[stack.length - 1].indent) {
          html.push(`</li></${stack.pop().ordered ? 'ol' : 'ul'}>`);
        }
        if (!stack.length || cur.indent > stack[stack.length - 1].indent) {
          stack.push({ indent: cur.indent, ordered: cur.ordered });
          html.push(`<${cur.ordered ? 'ol' : 'ul'}><li>`);
        } else {
          html.push('</li><li>');
        }
        // 任务列表 [ ] / [x]
        const task = /^\[([ xX])\]\s+(.*)$/.exec(cur.text);
        if (task) {
          html.push(
            `<label class="md-task"><input type="checkbox" disabled ${task[1] !== ' ' ? 'checked' : ''} /> ${inline(task[2])}</label>`,
          );
        } else {
          html.push(inline(cur.text));
        }
        i++;
      }
      while (stack.length) html.push(`</li></${stack.pop().ordered ? 'ol' : 'ul'}>`);
      out.push(html.join(''));
      continue;
    }

    // 段落:吃到空行或下一个块级起点
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s{0,3}(`{3,}|~{3,})/.test(lines[i]) &&
      !/^\s{0,3}#{1,6}\s/.test(lines[i]) &&
      !/^\s{0,3}>/.test(lines[i]) &&
      !listMatch(lines[i]) &&
      !isHr(lines[i]) &&
      !tableAt(lines, i)
    ) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br />')}</p>`);
  }

  return out.join('\n');
}

// ── Artifacts ───────────────────────────────────────────────────────────
// 从消息里抽出"值得在侧栏打开"的产物。不建独立数据模型,实时从内容解析。

const PREVIEWABLE = new Set(['html', 'svg', 'xml']);
const ARTIFACT_MIN_LINES = 15;

/**
 * @param {string} md
 * @returns {Array<{index:number, lang:string, code:string, kind:'preview'|'code', title:string}>}
 */
export function extractArtifacts(md) {
  const text = String(md == null ? '' : md).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let idx = 0;
  while (i < lines.length) {
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(lines[i]);
    if (!fence) {
      i++;
      continue;
    }
    const marker = fence[1][0] === '`' ? '`' : '~';
    const len = fence[1].length;
    const lang = (fence[2] || '').toLowerCase();
    const buf = [];
    i++;
    while (i < lines.length && !new RegExp(`^\\s{0,3}${marker}{${len},}\\s*$`).test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    i++; // 跳过收尾围栏
    const code = buf.join('\n');
    const nLines = buf.length;
    const previewable = PREVIEWABLE.has(lang);
    if (previewable || nLines >= ARTIFACT_MIN_LINES) {
      out.push({
        index: idx,
        lang,
        code,
        kind: previewable ? 'preview' : 'code',
        title: guessTitle(code, lang, nLines),
      });
    }
    idx++;
  }
  return out;
}

function guessTitle(code, lang, nLines) {
  const m = /^\s*(?:\/\/|#|<!--)\s*(.{3,60}?)\s*(?:-->)?\s*$/m.exec(code.split('\n')[0] || '');
  if (m) return m[1];
  const t = /<title>([^<]{1,60})<\/title>/i.exec(code);
  if (t) return t[1].trim();
  return `${lang || 'code'} · ${nLines} 行`;
}
