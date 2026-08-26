# 第三方字体

聊天页(`/u/chat`、`/admin/chat`)的排版取自 cc-haha 的「纸 · 墨 · 印」设计体系,
这三套字体是该体系的组成部分。**均为 SIL Open Font License 1.1**,允许随软件一同分发。

这里只放了各家的 **latin 子集**(总计约 190KB)。中文字形不在其中 —— CJK 一套动辄
6MB,所以中文回落到系统字体(PingFang SC / 微软雅黑 / 宋体),这也正是 cc-haha
自己的做法,详见 `src/haha-tokens.css` 里 `--font-headline` 的注释。

| 文件 | 字体 | 上游 | 许可 |
| --- | --- | --- | --- |
| `inter-latin.woff2`、`inter-latin-ext.woff2` | Inter(可变字重 400–600) | https://github.com/rsms/inter | OFL 1.1 |
| `jetbrains-mono-latin.woff2` | JetBrains Mono(400) | https://github.com/JetBrains/JetBrainsMono | OFL 1.1 |
| `noto-serif-sc-latin.woff2` | Noto Serif SC(可变字重 600–900) | https://github.com/notofonts/noto-cjk | OFL 1.1 |

OFL 1.1 全文见各上游仓库。要点:可自由使用、修改、再分发(含商用),
**但不得单独售卖字体本身**,且衍生版本不得使用保留字体名称。

字体文件由 `src/server.js` 的 `/fonts/*.woff2` 路由提供,带一年不可变缓存
(文件名即内容标识,换字体就换文件名)。
