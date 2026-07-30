# cc-trans

Anthropic API 反向代理。让**其他电脑**上的 Claude Code 把请求发到**你这台服务器**,由服务器注入真实的模型凭证后转发到上游。

- **模型、凭证、上游地址** —— 全部在服务器(本机)这一侧,远端不接触。
- **工作目录、环境、文件** —— 全部在远端,因为 Claude Code 是跑在远端的,本机只做 HTTP 转发。
- **鉴权** —— 远端必须带一个你分发的访问令牌,校验通过才转发,并在转发时换成本机的真实凭证。
- **两种上游凭证**:
  - `oauth`(默认):转发本机 **Claude Code 订阅(Pro/Max/Team)登录态** —— 读 `~/.claude/.credentials.json`,自动用 `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20` 转发,token 过期自动刷新并写回。**这就是"用订阅、不用 API key"的模式。**
  - `apiKey`:用静态 `sk-ant-` 密钥(走官方或中转网关)。
- **Web 管理台**(`/admin`):账号密码登录,概览(流量折线图/客户端环形图)、客户端令牌在线生成与吊销、用户账号管理、实时日志。详见下文「Web 管理台」。
- **用户端**(`/u`):给使用者的界面 —— 用自己的账号登录,只看到分配给他的设备用量,并可**反复取回**该设备的令牌(每次回显留审计)。详见下文「用户端」。
- **零第三方依赖**:仅需 Node.js ≥ 18,含管理台图表(纯内联 SVG)在内均无外部依赖/CDN。
- **一条命令部署**:镜像自动发布到 GHCR,`docker compose up -d` 即用(多架构 amd64/arm64),首启自动生成配置与令牌。详见下文「快速部署」。

```
┌────────── 远端电脑 ──────────┐         ┌────────── 服务器(本机)────────────┐
│ Claude Code                  │  HTTP   │ cc-trans                            │   HTTPS
│ ANTHROPIC_BASE_URL → 本机    │ ──────▶ │ 校验客户端令牌 → 换上真实凭证 → 转发 │ ───────▶ Anthropic / 中转网关
│ ANTHROPIC_AUTH_TOKEN=客户端令牌│  SSE 流 │ (订阅 OAuth 自动刷新 + 流式回传 + 用量日志) │ ◀───────
└──────────────────────────────┘ ◀────── └─────────────────────────────────────┘
```

---

# 🚀 快速部署(Docker Compose + GHCR,推荐)

镜像由 GitHub Actions 在**打版本标签时**构建并发布到 **GHCR(GitHub Container Registry)**:`ghcr.io/shimmerjordan/cc-trans`。
部署只需**下载一个 compose 文件 + 一条命令**,不用 clone、不用本地构建。**首次启动自动生成配置、客户端令牌和管理员密码。**

支持 `linux/amd64` 与 `linux/arm64`(x86 服务器、树莓派、ARM 云主机、Apple Silicon 都能直接跑)。

### 前置条件

1. 装好 **Docker**(23+,自带 compose)。
2. **订阅模式必备**:在这台宿主机上用 Claude Code 登录过订阅 —— 即 `~/.claude/.credentials.json` 存在。
   ```bash
   claude   # 登录一次(Pro/Max/Team),之后 cc-trans 会转发这份登录态并自动刷新 token
   ls ~/.claude/.credentials.json   # 确认文件在
   ```
   > 没有订阅、想用官方 API Key / 第三方网关?也可以 —— 部署完到管理台「设置 → 本地 AI 订阅」切成静态密钥模式即可。

### 三步部署

```bash
mkdir -p ~/cc-trans && cd ~/cc-trans

# 1. 下载 compose 文件
curl -fsSL -O https://raw.githubusercontent.com/shimmerjordan/cc-trans/main/docker-compose.yml

# 2. 拉镜像并启动(镜像已预构建,秒级)
docker compose up -d

# 3. 看首启日志 —— 客户端令牌和管理员密码都在里面(请立刻保存)
docker compose logs
```

> 镜像是公开的,**不需要 `docker login`**。若提示 `denied`/`unauthorized`,说明包还是私有状态,见下方「维护者:首次发布后把包设为 Public」。

### 手动 pull(不用 compose 也行)

```bash
docker pull ghcr.io/shimmerjordan/cc-trans:latest

docker run -d --name cc-trans -p 8787:8787 \
  -v "$PWD/data:/app/data" \
  -v "$HOME/.claude:/home/node/.claude" \
  -e CC_TRANS_CONFIG=/app/data/config.json \
  -e CC_TRANS_OAUTH_CREDENTIALS=/home/node/.claude/.credentials.json \
  --restart unless-stopped \
  ghcr.io/shimmerjordan/cc-trans:latest
```

可用 tag:`latest`(最新正式版)、`0.2.0` / `0.2`(精确版本 / 次版本线)、`sha-<短提交号>`(精确到某次提交)。

### 从源码构建(改了代码 / 需要上游代理)

```bash
git clone https://github.com/shimmerjordan/cc-trans.git && cd cc-trans
docker compose -f docker-compose.build.yml up -d --build
```

### 首启日志里你会看到

```
  ┌────────────────────────────────────────────────────────────┐
  │ cc-trans 首次启动:已生成客户端令牌(请立刻保存!)
  │   cct-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx      ← 远端要用这个
  └────────────────────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────────────────┐
  │  管理台初始账号: admin
  │  管理台初始密码: adm-xxxxxxxxxxxx                          ← 登录管理台用这个
  └──────────────────────────────────────────────────────────┘
```

### 验证与使用

```bash
curl http://localhost:8787/health          # 期望 ok:true,并显示订阅类型/到期时间
```

打开管理台:**http://<你的服务器IP>:8787/admin**(账号 `admin` + 上面的随机密码,登录后可在「设置」里改)。

远端电脑接入:

```bash
export ANTHROPIC_BASE_URL="http://<你的服务器IP>:8787"
export ANTHROPIC_AUTH_TOKEN="cct-首启日志里的令牌"
claude          # 正常使用;工作目录/环境都在远端这台机器
```

### 常用运维命令

```bash
docker compose logs -f                       # 实时日志
docker compose restart                       # 重启
docker compose down                          # 停止
docker compose pull && docker compose up -d  # 升级到最新镜像(GHCR)
```

> 从源码构建的部署改用:`docker compose -f docker-compose.build.yml up -d --build`

### 数据与配置在哪

所有状态都在 **`./data`** 这一个目录里(compose 已挂载),删容器不丢:

| 文件 | 内容 |
| --- | --- |
| `data/config.json` | 配置(令牌、管理员密码、上游设置)—— 管理台里的改动都写在这 |
| `data/metrics.json` | 累计/每日/按客户端统计与成本 |
| `data/models.json` | 从上游拉取的模型列表 |
| `data/logs/<日期>/<小时>.jsonl` | 请求日志分块(可在管理台分页查看/按时间段删除,默认保留 14 天) |

### 部署常见问题

| 现象 | 处理 |
| --- | --- |
| `denied` / `unauthorized` 拉不到镜像 | GHCR 包还是私有。**维护者**按下一节把包设为 Public;或**使用者**先登录:`echo <你的GitHub PAT(read:packages)> \| docker login ghcr.io -u <你的GitHub用户名> --password-stdin` |
| 日志提示「订阅模式但没找到凭证」 | 宿主机没 `claude` 登录,或 `~/.claude` 没挂进容器。先 `claude` 登录;compose 默认挂载 `${HOME}/.claude`,用 root/其他用户跑时确认这个路径对。 |
| 想启用上游代理(HTTP/SOCKS5) | 预构建镜像不含 undici。改用源码构建并打开开关:`WITH_UNDICI=1 docker compose -f docker-compose.build.yml up -d --build`,再到管理台「设置 → 上游代理」填地址。 |
| 源码构建时基础镜像拉不动(`i/o timeout`) | 默认已走 daocloud 镜像源。该源也不通就换一家:`NODE_IMAGE=<别的源>/library/node:22-alpine docker compose -f docker-compose.build.yml up -d --build`。治本是给 Docker 配 `registry-mirrors`(见下方 C 节)。 |
| Docker 里用原来的管理员密码登不进 | 两种部署读的是不同的 config.json,容器首启新生成了一份。要复用原来的:`./deploy/import-config.sh` 后重启容器,见下方「从 systemd/裸机迁到 Docker」。 |
| 端口冲突(8787 被占) | 不用改文件:`CC_TRANS_HOST_PORT=9787 docker compose up -d`。 |
| `data` 目录权限 / `EACCES` | 容器会自己处理:以 root 入场把 `./data` 属主改成宿主机用户(取挂载的 `~/.claude` 属主,取不到用 1000),再降权到非 root 跑服务。宿主机 uid 不是 1000 且没挂 `~/.claude` 时,用 `PUID`/`PGID` 显式指定。 |
| 想换成 systemd 裸机部署 | 见下方「一键安装」。 |

> 上面这些环境变量都可以写进 compose 同目录的 **`.env`**(见 `.env.example`,`cp .env.example .env`),改一次永久生效,不必每次敲在命令前。

---

# 🧪 本地测试与部署

三种由轻到重的本地方式,按你要验证什么来选。

## A. 改代码 / 最快开发循环(纯 Node,不用 Docker)

```bash
git clone https://github.com/shimmerjordan/cc-trans.git && cd cc-trans

cp config.example.json config.json
node src/server.js gen-token          # 生成一个客户端令牌,填进 config.json 的 clientTokens
# 再把 config.json 里 "adminEnabled" 改成 true(管理台;密码首启自动生成并打印)

npm run dev                           # node --watch,改代码自动重启
```

```bash
curl http://localhost:8787/health     # 自检
open http://localhost:8787/admin      # 管理台(账号 admin + 日志里打印的随机密码)
```

> 订阅模式要求本机 `~/.claude/.credentials.json` 存在(先 `claude` 登录);没有订阅就把 `upstreamAuth` 改成 `apiKey` 并填 `upstreamApiKey`。

## B. 跑自动化测试(不需要真凭证、不碰你的订阅)

```bash
npm test        # 十一套件共 589 项,全部打本地 mock 上游
```

| 套件 | 覆盖 |
| --- | --- |
| `test/smoke.mjs` | 鉴权、凭证注入、转发、SSE 流式、用量嗅探 |
| `test/overrides.mjs` | 参数下发、动态模型列表(上游拉取/持久化/规则推断) |
| `test/features.mjs` | CC 身份伪装(默认开 + 显式关)、限流/并发/UA/白名单、成本、OpenAI 兼容端点 |
| `test/admin2.mjs` | tab URL 路由、订阅配置热应用、日志分页与清理、异常来源标注 |
| `test/chat.mjs` | 网页聊天:Markdown **注入向量**(22 个)、渲染与高亮、artifact 抽取、会话 CRUD 与**路径穿越**、图片魔数校验与去重、流式事件与 usage、记账落到设备、强制模型生效、会话/消息上限可配(0=不限) |
| `test/storage.mjs` | 存储统计与清理:`du` 不跟符号链接、**各类之和恒等于目录实测总量**、图片引用清扫(共享图不能误删)、孤儿宽限期、面板数量与真清理数量一致、只删轮转件、清理接口鉴权 |
| `test/users.mjs` | 用户体系:scrypt 哈希、账号 CRUD 与持久化、**越权边界**(两套 session 互不相认、数据/日志隔离、伪造参数无效、禁用即时生效)、令牌明文回显与审计、**权限收窄**(创建时/事后改)、保留名、管理员聊天隔离、重启后仍可登录 |
| `test/credentials.mjs` | 订阅凭证的路径解析与写回:软链接透明(目录链/文件链)、写回不吃掉软链接、跨设备 tmp 落点、**死链要说人话**(不能报成"没登录")、默认路径不受污染的 `HOME` 影响、写回失败不留垃圾 |
| `test/inherit.mjs` | 级联模式:**自环判定**(本机各种写法 × 端口)、来源文件三类错误各自可辨(权限/断链/缺字段,权限问题不能报成"JSON 不合法")、继承来的令牌与地址真的生效而 config.json 里的静态密钥被忽略、**改文件不重启即跟随**(令牌与地址一起换)、`API_KEY` 走 `x-api-key`、来源坏掉是 502 且修回去自愈、管理台切换与探测(切走时地址还原为声明值) |
| `test/hops.mjs` | 环路防护:跳数读取(缺失/非法/负数/天文数字)、官方上游剥头(含 `anthropic.com.evil` 后缀伪装不误判)、超限 508 且不打上游、**真实环路收敛**(假上游把请求打回自己,验证跳数累加并在上限处断开而不是耗尽资源)、`maxHops=0` 关闭后仍递增且横幅告警、客户端伪造值不会原样透给上游 |
| `test/params.mjs` | 请求体参数清洗:家族识别(**Opus 5 / 4.9 / Sonnet 6 等新 id 必须被认成新家族** —— 曾因两处正则漂移漏掉 opus-5,导致它的 temperature 没被清洗)、能力表自相一致、`temperature` 系清洗、effort 三条规则(模型不认该参数 / 无此档位则**降**不升 / **thinking 显式 disabled 时 xhigh·max 降到 high**)、Fable 的 thinking 特例、注入与清洗的先后顺序 |

单跑某一套件:`node test/features.mjs`。

监听端口全部由 [`test/_ports.mjs`](test/_ports.mjs) 动态分配,所以跑测试不会和机器上已有的服务抢端口 —— 包括你自己那个正在跑的 cc-trans。（写死端口撞上时的症状极具误导性:测试实例只是静默 `EADDRINUSE`,而请求打到了那个陌生服务、拿回一个莫名的 401。）

对着**真实服务**做端到端自检(会真的打上游、消耗额度):

```bash
CC_TRANS_URL=http://localhost:8787 CC_TRANS_TOKEN=cct-你的令牌 npm run test:client
```

## C. 本地 Docker 部署(和 GHCR 镜像等价)

开箱一条命令,**不需要 `.env`、不需要带任何环境变量**(基础镜像默认走 daocloud 镜像源,因为直连 Docker Hub 在国内经常 i/o timeout):

```bash
docker compose -f docker-compose.build.yml up -d --build
docker compose -f docker-compose.build.yml logs -f      # 首启令牌 + 管理员密码在这
curl http://localhost:8787/health
```

<details>
<summary>要改端口 / 换镜像源 / 开代理支持</summary>

三个可调项都能用环境变量覆盖,或写进 `.env`(`cp .env.example .env`,改一次永久生效):

```bash
CC_TRANS_HOST_PORT=18787 \
NODE_IMAGE=node:22-alpine \
WITH_UNDICI=1 \
  docker compose -f docker-compose.build.yml up -d --build
```

| 变量 | 默认 | 什么时候改 |
| --- | --- | --- |
| `CC_TRANS_HOST_PORT` | `8787` | 本机已有 cc-trans 在跑(systemd 或另一个容器)会撞端口 |
| `NODE_IMAGE` | `docker.m.daocloud.io/library/node:22-alpine` | 海外机器/网络通 → 用 `node:22-alpine`;镜像源挂了 → 换别家 |
| `WITH_UNDICI` | `0` | 要用上游 HTTP/SOCKS5 代理(装 undici) |

**根治镜像源问题(推荐,一次配好所有项目受益)**:给 Docker 守护进程配加速,之后 `NODE_IMAGE=node:22-alpine` 也能拉。

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{ "registry-mirrors": ["https://docker.m.daocloud.io"] }
EOF
sudo systemctl restart docker
docker pull node:22-alpine        # 验证
```

> 镜像源时好时坏,`docker manifest inspect` 对它们常常不准(有的不支持该 API),只有 `docker pull` 能判断是否可用。

</details>

### 从 systemd/裸机迁到 Docker(复用原来的令牌和密码)

**两种部署现在共用同一份配置**(`./data/config.json`),互相切换不丢设置:

| 部署方式 | 配置文件 | 状态目录 |
| --- | --- | --- |
| Docker | `./data/config.json`(容器内 `/app/data/config.json`) | `./data/`(容器内 `/app/data`,走 `CC_TRANS_DATA_DIR`) |
| systemd / 裸机 | 同一份 `./data/config.json` | 同一个 `./data/` |

解析顺序:`CC_TRANS_CONFIG` → `./data/config.json` → `<仓库根>/config.json`(仅向后兼容老装机)。两处都存在时用前者,并在启动日志里**明确告警**指出另一份被忽略了 —— 曾经这两份各自漂移过一次:一边有用户账号、日志保留 30 天,另一边都没有,同一个服务两种界面,而界面上看不出原因。

容器也**不再把 `dataDir` 写进配置文件**(那是容器内路径 `/app/data`,裸机读到会指向不存在的目录),改由 `CC_TRANS_DATA_DIR` 提供;老配置里遗留的这一项会在容器启动时自动摘掉。裸机若读到别处写进来的、不可写的 `dataDir`,启动时告警并退回默认目录,而不是等第一次落盘才崩。

> 历史上两者读不同的配置文件,容器首启会生成全新的一份(新令牌 + 新随机密码),导致"原来的管理员密码在容器里登不进去"。老装机(只有 `<仓库根>/config.json`)行为不变;想合并成一份,把它移到 `data/` 下即可。

要沿用原来那份,导入一次即可(会自动备份容器现有配置、改好容器内路径):

```bash
sudo systemctl stop cc-trans          # 先停裸机版,否则两个实例抢 8787 和同一个 data/
./deploy/import-config.sh             # 源 = ./config.json → ./data/config.json
docker compose -f docker-compose.build.yml restart
```

客户端令牌、每客户端的参数下发(`overrides`)、`modelMap`、管理员密码都原样保留;只有 `host`/`port`/`dataDir`/`oauthCredentialsPath` 会改成容器内的值。

> ⚠️ 两种部署的 `data/` 目录是**同一个**(裸机版 `dataDir` 默认就是 `config.json` 同级的 `data/`)。别让 systemd 版和容器同时跑 —— 指标和日志会互相覆盖。

#### 累计统计和请求日志丢了怎么办

`data/` 被误删、或从没持久化过(旧版本)时,只要 systemd 还在往 journald 写日志,就能**从 journald 反向重建**:

```bash
journalctl -u cc-trans --no-pager -o cat | node deploy/rebuild-metrics.mjs --force
docker compose -f docker-compose.build.yml restart
```

脚本解析历史请求行(时间/状态/耗时/模型/in/out/cacheR/cacheW/客户端),喂给**运行时同一套** `createMetrics`/`createLogStore` —— 聚合口径、成本估算、分块布局与线上完全一致,不是另写一份。输出示例:

```
扫描 10468 行,重建 3600 条请求
  时间跨度:2026-07-08 12:24 → 2026-07-26 01:30(18 天,19 个日聚合)
  累计:请求 3600 / 异常 44
  token:in 12896173 · out 5650130 · cacheR 262767654 · cacheW 49099959
  估算成本:$599.25
  客户端 laptop:3475 条 / xyz_local_agent:105 条 / yzt:20 条
```

几点注意:

- **幂等保护**:已有 `metrics.json` 或 `logs/` 时会拒绝执行(重复导入会让统计翻倍),加 `--force` 才继续,并自动备份成 `.bak-<时间戳>`。
- **历史日志里没有 IP/UA**(那时还没记),所以这批数据在「异常来源」里 IP/UA 列是空的,其余字段完整。
- **保留期**:导入跨度超过 `logRetentionDays`(默认 14 天)时,容器启动会把更早的块当过期清掉 —— 脚本会提示你该调到多少。
- 也可以喂文件:`node deploy/rebuild-metrics.mjs --file saved.log --force`。

**权限不用自己管**:`./data` 不存在时 Docker 会以 `root` 建目录,容器里的非 root 进程本会写不进去(`EACCES`)。entrypoint 以 root 入场先把属主改成宿主机用户(取挂载的 `~/.claude` 属主,取不到用 1000),再用 `deploy/drop-privs.mjs` 降权到非 root 跑服务 —— 所以 `data/` 下的文件在宿主机上直接可读可改。宿主机 uid 不是 1000 且没挂 `~/.claude` 时用 `PUID=<uid> PGID=<gid>` 指定。

```bash
docker exec cc-trans ps -o user,args | grep server.js   # 应显示 node(不是 root)
ls -ld data                                              # 属主应是你自己
```

## D. 验证「用户拿到的那份 compose」(镜像还没发布时)

默认 `docker-compose.yml` 是从 GHCR 拉镜像的,本地想先验证这份文件本身:先把本地构建的镜像**打成 GHCR 的名字**,再用 `--pull never` 阻止它去拉远端。

```bash
# 1. 本地构建,打成 GHCR 镜像名
docker build -t ghcr.io/shimmerjordan/cc-trans:latest .
#   (拉不动基础镜像时加 --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine)

# 2. 用用户那份 compose 起来,但不联网拉镜像
CC_TRANS_HOST_PORT=18787 docker compose up -d --pull never
docker compose logs
```

> 不加 `--pull never` 会因为 compose 里的 `pull_policy: always` 去 GHCR 拉,镜像未发布时报 `denied`。

验证完清理:

```bash
docker compose down
rm -rf data                                          # 清掉测试生成的配置/指标/日志
docker rmi ghcr.io/shimmerjordan/cc-trans:latest      # 删掉本地假镜像,避免以后遮住真镜像
```

## E. 发布新版本(打 Tag 触发)

镜像**只在打版本标签时**发布,平时推 `main` 不会动 `latest`:

```bash
# 1.(推荐)先把 package.json 版本号对齐,提交推送
npm version 0.2.0 --no-git-tag-version
git add -A && git commit -m "release: v0.2.0" && git push

# 2. 打标签触发发布
git tag v0.2.0
git push origin v0.2.0
```

产出的镜像 tag:`0.2.0`、`0.2`、`latest`、`sha-<短提交号>`。
预发布标签(如 `v0.3.0-rc.1`)只产出 `0.3.0-rc.1` + `sha-xxx`,**不会动 `latest`**。

只想验证流水线本身、不发正式版:Actions 页 → 该 workflow → **Run workflow**,只产出 `sha-<短提交号>` 标签,不影响 `latest`。

---

### 维护者:镜像发布与首次公开(一次性)

镜像由 [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) 发布 —— **打 `v*` 标签**触发(见上方「E. 发布新版本」),或在 Actions 页手动 **Run workflow**(只出 `sha-` 标签)。平时推 `main` 不发布镜像。用仓库自带的 `GITHUB_TOKEN` 推送,**不需要配任何 secret**。

⚠️ **GHCR 包首次推送时默认是私有的**(不继承仓库的 public 属性),必须手动公开一次,之后所有人才能免登录 pull:

1. 打开仓库主页 → 右侧栏 **Packages** → 点 `cc-trans`
2. 右下角 **Package settings**(⚙)
3. 拉到底部 **Danger Zone** → **Change visibility** → 选 **Public** → 输入包名确认

顺手建议:在同一页把包 **Link** 到本仓库(Connect repository),这样包页面会显示源码与 README。

发布结果可在 Actions 运行摘要里看到具体 tag;镜像地址:

```
ghcr.io/shimmerjordan/cc-trans:latest         # 最新正式版(打 v* 标签时更新)
ghcr.io/shimmerjordan/cc-trans:0.2.0          # 精确版本
ghcr.io/shimmerjordan/cc-trans:0.2            # 次版本线
ghcr.io/shimmerjordan/cc-trans:sha-abc1234    # 精确提交(手动 Run workflow 也会产出)
```

---

# 裸机部署(Node.js)

## 1. 安装

无第三方依赖,只需 Node.js ≥ 18(已在 Node 24 验证)。

```bash
cd cc-trans
```

## 2. 生成客户端令牌

给每台要接入的远端电脑生成一个令牌:

```bash
npm run gen-token
# 例: cct-Xk3...（每台设备一个,自己留好)
```

## 3. 配置服务器

复制示例配置并填写:

```bash
cp config.example.json config.json
```

`config.json`(已被 .gitignore 忽略,不会进版本库)关键字段:

| 字段 | 说明 |
| --- | --- |
| `upstreamAuth` | `oauth`=转发订阅登录态(默认);`apiKey`=用静态密钥;`inherit`=继承本机 Claude Code 已配的上游(级联,见下)。不填则:有静态密钥走 apiKey,否则 oauth —— `inherit` 必须显式写。 |
| `upstreamBaseUrl` | 上游真实地址。官方填 `https://api.anthropic.com`;走中转/自建网关就填它的地址。`inherit` 模式下此项被忽略。 |
| `oauthCredentialsPath` | oauth 模式的凭证文件路径,默认 `~/.claude/.credentials.json`,一般不用改。 |
| `inheritSettingsPath` | inherit 模式的来源文件,默认 `~/.claude/settings.json`,一般不用改。 |
| `upstreamApiKey` | apiKey 模式用:真实密钥(走 `x-api-key`)。与 `upstreamAuthToken` 二选一。 |
| `upstreamAuthToken` | apiKey 模式用:真实密钥(走 `Authorization: Bearer`)。某些中转用这种。 |
| `maxHops` | 环路防护:一个请求最多穿过几台 cc-trans(默认 4,`0`=关闭)。超限返回 508。 |
| `clientTokens` | 分发给远端的访问令牌数组,`name` 仅用于日志区分设备。 |
| `modelMap` | 可选。把客户端请求的模型名重映射到上游模型。留空则原样转发。 |
| `port` / `host` | 监听端口(默认 8787)/ 网卡(默认 `0.0.0.0` 监听全部)。 |

**用订阅(oauth)模式,只需在服务器上先 `claude` 登录好**,config.json 里 `upstreamAuth` 保持 `oauth` 即可,无需任何密钥。

也可以全部用环境变量代替配置文件(env 优先级最高):

```
CC_TRANS_PORT, CC_TRANS_HOST, CC_TRANS_UPSTREAM_AUTH (oauth|apiKey|inherit),
CC_TRANS_UPSTREAM_BASE_URL, CC_TRANS_OAUTH_CREDENTIALS, CC_TRANS_INHERIT_SETTINGS,
CC_TRANS_UPSTREAM_API_KEY, CC_TRANS_UPSTREAM_AUTH_TOKEN, CC_TRANS_MAX_HOPS,
CC_TRANS_CLIENT_TOKENS (逗号分隔), CC_TRANS_CONFIG (指定配置文件路径)
```

### 订阅(OAuth)模式说明

- 代理在每次请求时读取凭证文件取 access token;**到期前 5 分钟自动用 refresh token 刷新**,并把新 token 原子写回 `~/.claude/.credentials.json`(与服务器自己的 Claude Code 共用同一份登录,互不打架)。
- 关键转发细节(已实测):`Authorization: Bearer <accessToken>` + `anthropic-beta: oauth-2025-04-20`,且**非 Haiku 模型要求请求 `system` 以 `You are Claude Code, ...` 开头** —— 真实 Claude Code 自带,故正常使用无感;但**裸 curl 测非 Haiku 模型且不带该 system 会被上游 400**(见测试一节)。
- ⚠️ **合规提醒**:订阅 OAuth 凭证官方主要面向 Claude Code 客户端本身;经第三方代理转发属灰区,Team 订阅还涉及组织条款。仅建议**自用**(自己的订阅、自己的机器),并务必保证代理私有(靠 clientTokens 鉴权 + 私网/穿透,别裸挂公网)。token 理论上有被限流/吊销风险。

### 级联模式(inherit):复用本机已配的中转

**解决的问题**:内网机器 B 上跑着 cc-trans,本机 A 的 Claude Code 已经指向它;现在外网多了一台机器 C,它只连得到 A、连不到 B。想让 C 也用上那个中转,又不想把 B 的地址和令牌再抄一遍。

在 A 上也跑一个 cc-trans,`upstreamAuth` 设成 `inherit`,它就会从 A 自己的 `~/.claude/settings.json` 里读出 `env.ANTHROPIC_BASE_URL` 和 `env.ANTHROPIC_AUTH_TOKEN` 当上游:

```
C (Claude Code)  ──►  A (cc-trans, inherit)  ──►  B (cc-trans, oauth)  ──►  api.anthropic.com
   给 C 单发的令牌        读自己的 settings.json        注入订阅 token
                         得到 B 的地址与令牌
```

A 上只改一行配置,`settings.json` 一个字不用动(A 本机的 claude 继续直连 B):

```json
{ "upstreamAuth": "inherit" }
```

- **自动跟随**:B 换了令牌或换了地址,你改的是 A 的 `settings.json`(本机 claude 本来就要改),这边下一个请求就跟上,**不用重启、不用改第二处**。与 oauth 模式"跟着本机登录态走"是同一个思路。
- **C 有自己的身份**:给 C 单发一个 `clientToken`(`npm run gen-token`),就能在 A 的管理台单独限额、单独看日志、随时吊销 —— 这是它比"直接把 B 的端口用隧道透给 C"强的地方(那样 C 拿到的就是 B 的令牌,泄露等于 B 泄露)。
- `ANTHROPIC_API_KEY` 也认(注入 `x-api-key`);两个都有时 `ANTHROPIC_AUTH_TOKEN` 优先,与 Claude Code 自身的优先级一致。
- **禁止自环**:`settings.json` 里的地址不能指回这台 cc-trans 自己(`localhost`/`127.*`/本机 IP + 同端口),否则请求会在本进程里无限套娃。这种配置**启动时直接拒绝**并告诉你怎么改。所以想让 A 本机的 claude 也走本地 cc-trans 的话,得改用 `apiKey` 模式手填 B 的地址与令牌。自环检测抓不到的两类环由跳数防护兜住,见下。
- **两件事发生在上游那一级**:① 订阅门禁的伪装(`spoofClaudeCode` / 注入 CC 前缀)由 B 做 —— 若 C 上跑的是自研客户端而非真 Claude Code,请到 **B** 的管理台给「A 用的那个令牌」打开订阅兼容三项;② 订阅余量也只有 B 看得到,A 的管理台「订阅用量」会提示去 B 查。
- **用量会记两遍**:A 记一份(按 C 的令牌细分)、B 记一份(C 的请求在 B 上都归到「A 用的那个令牌」名下)。两级各自视角,不是重复计费。
- **别把管理台一起暴露**:A 若要对公网开放,只放行 `/v1/*`,`/admin` 与 `/u` 留在内网。
- **Docker 下开箱可用**:两份 compose 本来就把宿主机 `~/.claude` 整个挂进容器(oauth 模式需要),`settings.json` 就在里面,所以只需把 `upstreamAuth` 改成 `inherit`。与 oauth 不同的是它只需要**读**权限。

### 环路防护(跳数)

上面的自环检测只认得出「上游地址就是本机」这一种形状,有两类环它抓不到:

- **容器盲区**:容器里 `os.networkInterfaces()` 只有容器自己的地址(`172.17.x.x`),`settings.json` 指向「宿主 IP:映射端口」时,它看不出那其实就是自己
- **跨机器环**:A 的上游是 B,而 B 的上游又被配回了 A —— 单看任何一台都完全合法

两种情况下请求都会真的绕圈,每一跳都是一次完整的 HTTP 转发(连同请求体),连接数与内存一起爆,而现场只看得到一串自己打给自己的请求。所以转发时会带一个计数头:

```
x-cc-trans-hops: 1        # 每经过一台 cc-trans +1;超过 maxHops(默认 4)返回 508
```

- **508 而不是 502**:502 会让客户端重试,而重试只会让环转得更快。
- **官方 API 收不到这个头**:上游是 `*.anthropic.com` 时该头会被剥掉 —— 官方不会把请求转回来(没有环可防),而多带一个自定义头会削弱身份伪装。于是自建链路里始终累加,最后一跳自然清理干净。
- **客户端伪造无害**:值只被用来计数,发往上游的永远是本机算出的 `收到值+1`;填大了只会让自己的请求被拒。
- `/health` 会回 `maxHops`,探针可据此告警;设成 `0` 关闭防护时启动横幅会明确警告。
- 正常级联 1~2 跳。确实需要更深的多级中转时调大 `maxHops`,别关掉它。

## 4. 启动服务器

```bash
npm start
# 或开发热重载: npm run dev
```

启动后会打印监听地址、上游、令牌(掩码)、以及可供远端使用的本机局域网地址。

### 持久化 / 开机自启(systemd,推荐)

让服务常驻、开机自启、崩溃自动重启。以**普通用户**身份运行(脚本内部按需调用 sudo):

```bash
bash deploy/install-service.sh
```

脚本会自动探测当前 node 路径(兼容 nvm)、仓库目录与用户名,生成 `/etc/systemd/system/cc-trans.service` 并 `enable --now`,同时接管已占用 8787 的旧进程。常用命令:

```bash
journalctl -u cc-trans -f              # 实时日志(转发记录、用量、刷新都在这)
sudo systemctl restart cc-trans        # 重启(改了 config.json 后执行)
sudo systemctl status cc-trans         # 看状态
bash deploy/uninstall-service.sh       # 卸载
```

服务以你的账户运行,因此能读写 `~/.claude/.credentials.json`(订阅 token 自动刷新)。单元文件见 [deploy/cc-trans.service](deploy/cc-trans.service)。

> nvm 装的 node 路径带版本号;**升级 node 后** ExecStart 会失效,重跑 `install-service.sh` 即可(它会重新探测路径)。

## Web 管理台

在 config.json 里设 `adminEnabled: true` 开启,重启服务后访问:

```
http://<本机IP>:8787/admin
```

**账号密码登录**:用户名取 `adminUser`(默认 `admin`)。`adminPassword` 留空时,**首次启动会自动生成一个随机密码,打印到控制台并写回 config.json**——从 `journalctl -u cc-trans` 里能看到那段醒目的初始密码框。登录后可在**「设置 → 管理台账号」**或**「用户」页管理员那行的「编辑」**里改**登录名、备注和密码**(改登录名或密码要验当前密码,只想改一样就把另一样留空;改备注不用验——它不是凭证。改完写回 config.json,已登录的会话不受影响)。会话 12 小时。

登录名与「用户」页的普通账号**共用一个命名空间**、双向互斥:管理台登录名改不成已存在的普通用户名,普通用户也建不出与管理台登录名同名的账号——否则"这个名字该去 `/admin` 还是 `/u` 登录"就没有答案了。用环境变量(`CC_TRANS_ADMIN_USER`/`CC_TRANS_ADMIN_PASSWORD`)配置时无法在线改,表单会锁住并说明原因(改了也写不回文件,重启就丢)。

功能:

- **概览**:分「服务信息」「订阅用量」「流量统计」三节;订阅用量含 5 小时 / 7 天窗口的已用/剩余进度条(优先取与 Claude Code `/usage` 同源的订阅用量接口,取不到时回落到最近一次转发响应里的 `anthropic-ratelimit-*` 限额头);流量含总请求(累计)/今日请求/错误/成功率/**累计 token 消耗**(输入/输出/缓存读写),以及**折线图**(最近 30 分钟每分钟请求数)、**环形图**(请求按客户端分布)和**柱状图**(最近 14 天每日请求数)。
- **客户端**:每个令牌的请求数、错误数、输入/输出/缓存 token 累计、最近活跃;一键**生成新令牌**(明文只显示一次,自动写回 config.json)、**吊销令牌**(立即失效);每个客户端可单独**参数下发**(见下)。
- **用户**:创建普通用户账号并把**现有客户端令牌**分配给他(见下方「用户端」)。可重置密码、改绑设备、**配置权限**、禁用/删除。用户密码用 **scrypt 哈希**存储,管理员也看不到明文。「客户端」页也能反向看到每个令牌**归属哪个用户**。表格第一行是**管理员账号**。它是合成行(凭证在 `adminUser`/`adminPassword`,不在 `users` 数组里),但**渲染走和普通用户完全相同的一套单元格**——同样有备注、设备标签、创建时间、最近登录,点「编辑」弹出的对话框位置与字段也和「编辑用户」对齐。差别只有两处:

- **没有「禁用」和「删除」**:这行的凭证就是管理台的钥匙,删了没人进得来。
- **设备 / 权限 / 配额由管理员身份固定**(全部设备、全部权限、不受配额),在对话框里列为只读说明而不是点不动的控件。

可改的是**登录名、备注、密码**:改登录名或密码要验当前密码,改备注不用(备注不是凭证)。「设置 → 管理台账号」是同一组字段的第二个入口,两边打同一个接口。
- **聊天**:顶栏「💬 聊天」进 `/admin/chat` —— 管理员有全部功能,可选**任意一台设备记账**,且**不受该设备强制模型的限制**(那些 overrides 本来就是他自己配的,锁他只是让他绕路)。会话与普通用户完全隔离。
- **模型/参数**:模型列表**不写死在代码里** —— 一键「从上游拉取并更新列表」即用订阅**实际可用的模型**替换列表并持久化到 `data/models.json`(重启保留),提示本次新增/移除了哪些;也可手动补/移除单个模型 id。各模型的 temperature/thinking/effort 规则由 **模型 id 自动推断**(上游出了新模型如 `claude-opus-4-9` 也能立刻识别到正确规则,无需改代码;完全不认识的 id 会标注「?规则推断」并按最保守规则处理)。附「可传入参数说明」。
- **参数下发(按客户端)**:请求转发前自动改写该客户端的 `/v1/messages` 请求体,支持:**强制模型**(把客户端请求的模型改写为指定模型)、**thinking 覆盖**(adaptive/disabled,Fable 5 自动降级为移除)、**effort 注入**(`output_config.effort`)、**注入 Claude Code system 前缀**(非 Haiku 模型过订阅门禁,已有前缀则不动)、**清洗不支持的参数与组合**(新家族上删除 temperature/top_p/top_k、`thinking:enabled`→`adaptive`;并按模型逐档校正 `output_config.effort`:模型不认该参数就删掉、无此档位就降到不超过请求的最高档、**thinking 被显式 `disabled` 时把 xhigh/max 降到 high** —— 后者正是 Claude Code 内部请求(如 web 搜索那一跳)会撞的组合,不清洗就整条链路 400)。全部默认关闭(纯透传);对合规请求(真实 Claude Code)开启也是无操作;给自研客户端接订阅时建议开启后两项。改动写回 config.json 并立即生效,日志会打印每次改写摘要。
- **实时日志**:分块持久化 + **分页浏览**(倒序、关键字/仅异常过滤)+ **按时间段删除**(N 天前 / 时间区间 / 全部)+ 自动过期;第一页可实时追加(SSE)。每行带来源 IP/UA。
- **设置**:**本地 AI 订阅配置**(订阅 OAuth ↔ 静态密钥切换、凭证路径检测、上游地址、代理,保存即热应用)+ 修改管理台密码。
- **每个页面一个 URL**:`/admin/overview`、`/admin/clients`、`/admin/users`、`/admin/models`、`/admin/logs`、`/admin/settings`,可直达/刷新/收藏/前进后退。
- **深色模式**:跟随系统,右上角按钮可手动切「跟随系统 / 亮色 / 深色」。

设计与安全:
- 挂在同端口的 `/admin`,与 `/v1/*` 代理流量互不干扰;账号密码登录,与客户端令牌无关。
- 图表为纯内联 SVG 绘制,**无任何外部依赖/CDN**。
- 管理台里令牌明文只在**生成那一刻**返回一次,列表只显示掩码;吊销按令牌哈希 id 定位。
- **用户端可反复取回自己被分配的令牌明文**(见下节),这是刻意的产品决定:用户换设备时需要它。代价是"泄露一次即永久可读",所以做了三重约束——默认只显示掩码、必须显式点开、每次回显在服务日志留一条 `[audit]`(谁、哪个令牌、来源 IP、UA)。

---

## 用户端(`/u`)

给**使用者**的界面:他用自己的账号登录,只看到管理员分配给他的设备。

```
http://<本机IP>:8787/u
```

**怎么开通一个用户**:管理台 →「用户」→ 创建用户(可点「随机生成」密码)→ 勾选要分配的设备 → 创建。账号和初始密码会在对话框里显示一次(服务端只存哈希),发给对方即可。

用户能做什么:

- **我的设备**:每台设备一张卡 —— 请求数/异常/输入输出 token/估算成本/最近活跃,以及**可反复取回的令牌**(默认掩码,点「显示完整令牌」展开,「复制」直接复制明文)和可照抄的接入命令(`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`)。管理员给这台设备设了参数下发时,这里会只读地告诉他(比如"强制模型 claude-opus-4-8")。
- **我的请求**:只含自己设备的请求日志,分页 + 关键字/仅异常过滤。
- **账号**:自助改密码(要验旧密码)。
- **聊天**(`/u/chat`):见下节。

用户**不能**做:看别人的设备或日志、看全局统计、改参数下发、碰模型与上游设置。

### 网页聊天(`/u/chat`)

交互对标 claude.ai 的对话体验:左栏会话列表、中间对话流、右栏 Artifacts 面板。

| 能力 | 说明 |
| --- | --- |
| 多会话 | 新建/切换/重命名/删除。**会话存服务端**(`<dataDir>/chats/<user>/`),换浏览器还在,清缓存不丢 |
| 流式输出 | SSE 逐字出;点「停止」会**同时取消上游请求**,不让后台继续烧额度 |
| Markdown | 标题/粗斜/删除线/行内码/围栏代码块/嵌套列表/任务列表/引用/表格/链接,**自己实现**(`src/md.js`,零依赖、可单测) |
| 代码高亮 | 自写正则分词器,覆盖 js/ts/py/go/rust/java/sql/bash/json/css/html;每块带语言标签与复制 |
| 思考过程 | `thinking` 增量单独成流,折叠展示 |
| 图片 | 点选 / 拖入 / **直接粘贴**;按内容寻址存盘(同图去重),校验魔数而不只看声明的 mime |
| Artifacts | HTML/SVG 在 **`<iframe sandbox>`** 里预览(给 `allow-scripts` 但**绝不给 `allow-same-origin`** —— 两者同时给等于没有沙箱);长代码块进侧栏带高亮;支持预览/源码切换、复制、下载 |
| 模型与参数 | 随时切换模型 / thinking / effort。列表取自上游实际可用;**effort 只在支持的模型上出现**,thinking 选项按模型能力给(Fable 5 不接受 `disabled` 就摘掉该选项)。管理员给设备设了强制模型时,普通用户的选择器会锁定并说明,**管理员自己不受限** |
| 重新生成 | 丢掉最后一条回复重发上一轮 |

**用量走哪条账**:聊天以你绑定的某台设备的身份走内部转发,因此**继承该设备的参数下发、限流、成本与日志** —— 同一份额度、同一份账,在「我的设备」里能看到聊天花掉的部分。

推论:**管理员给该设备设了强制模型时,聊天的模型选择器会锁定并说明原因**。策略优先于偏好。

Markdown 渲染是本项目唯一的注入面(模型输出是不可信内容),所以基线是**先转义全部 HTML、再只生成自己认识的标签**,并有 22 个注入向量的测试盯着(`<script>`、`onerror`、`javascript:`/`data:` 链接、属性闭合、代码块内的 HTML……)。

**会话数与消息数上限是磁盘保护,不是额度**——两者容易混:

| | 管什么 | 超了怎样 | 管理员 |
| --- | --- | --- | --- |
| 配额(见下节) | 花钱 | **429 拒绝请求** | 不受限 |
| `chatMaxSessions` / `chatMaxMessages` | 磁盘 | **自动删掉最旧的**,不拒请求 | 一样受约束(谁的对话都占盘) |

默认每用户 200 个会话、每会话 500 条消息、单图 5MB。前两项可在 config.json 里调(`chatMaxSessions` / `chatMaxMessages`,或 env `CC_TRANS_CHAT_MAX_SESSIONS` / `CC_TRANS_CHAT_MAX_MESSAGES`),**填 0 = 不限**。左下角平时只显示已保存的对话条数,只有用到 80% 以上才把上限一起亮出来 —— 把 `0/200` 常驻在名字旁边太像额度徽标了。

### 配额(按 token / 花费,不按次数)

额度按**用户**算,与他名下**所有令牌共享一份** —— 不是每个令牌各一份。口径是 **token 数**与**花费金额**,而不是请求次数(一次长对话和一句 hello 差几个数量级,按次数限没有意义)。

| 项 | 说明 |
| --- | --- |
| 窗口 | 每天 / 每月 / 累计 |
| token 上限 | 输入 + 输出之和,**不含缓存读**(缓存读量级巨大又极便宜,拿它限额会让配额瞬间见底) |
| 花费上限 | 按模型定价估算的美元数(含缓存折算) |
| 默认 | **都不限制**。填 0 或留空即不限,配置文件里也不会留字段 |

超限时请求返回 **429**,消息里直接写明用了多少/上限多少。限流(频率)与配额(总量)是两层独立的闸:配额在更外层。

管理员在「用户」页能看到每个人的**已用 / 上限**进度条;用户自己在「我的设备」也能看到同一份数据。**未绑定到任何用户的令牌不受配额限制**(比如管理员自用的那些)。

### 权限管理

跨用户隔离是**硬边界**:任何用户都只能看到分配给自己的设备,看不到别人的统计、日志与令牌 —— 这不是配置项,是代码与测试保证的。

在此之上,管理员可以对**单个用户**进一步收窄(「用户」→ 编辑 → 权限):

| 权限 | 关掉后 |
| --- | --- |
| 网页聊天 | `/u/chat` 的 API 返回 403 |
| 查看自己的请求日志 | 「我的请求」返回 403 |
| 查看成本金额 | 用量仍可见,但**金额被抹成空**(他需要知道自己用了多少,不必知道折算多少钱) |
| 取回令牌明文 | 只能看掩码;尝试取明文会被拒并记 `[audit]` |

默认全开,老配置无需迁移。全部恢复默认时 `perms` 字段会从 config.json 里自动清掉,配置保持干净。

越权边界(有测试逐条盯着,见 `test/users.mjs` 与 `test/chat.mjs`):

| 规则 | 怎么保证 |
| --- | --- |
| 用户 session 打不开管理台 API | 两套 session 完全独立,`/admin` 与 `/u` 互不认证 |
| 管理员 session 也打不开用户端 API | 同上,反向也不认 |
| 只能看到自己绑定设备的数据 | 服务端按绑定关系过滤后才返回,不由前端筛 |
| 伪造 `?client=别人的设备` 无效 | 查询用的设备名由服务端从绑定关系推出,忽略请求里的该参数 |
| 禁用/删除用户立即生效 | 每个请求都回查用户状态,既有 session 当场失效 |
| 只能取自己绑定令牌的明文 | 取未绑定的返回 403,且这次尝试也会记 `[audit]` |
| 读不到别人的会话与图片 | 会话按用户分目录;用户名与会话 id 都过白名单校验,`../` 一类穿越在存储层就被挡掉 |
| 聊天不能借别人的额度 | 指定不属于自己的 `deviceId` 直接 403 |
| 管理员与用户的会话互不可见 | 管理员聊天用内部主体 `__admin__`,独立目录;该名与 `admin` 都是**保留名**,普通用户占不到 |
- 累计/每日/按客户端指标持久化在 `data/metrics.json`(已 .gitignore,20 秒落一次盘,重启不清零);最近请求明细为内存态,完整历史仍在 journald。
- 管理台暴露在监听地址上,靠账号密码守门。**仍建议只在私网/ZeroTier 内访问,不要裸挂公网**。

## 进阶能力(借鉴 claude-relay-service)

下列能力在 config.json 的 `clientTokens[].overrides` 或管理台「客户端 → 参数」里逐客户端配置,改完立即生效。

> **订阅兼容三项(身份伪装 / system 前缀注入 / 新模型参数清洗)对所有客户端默认开启** —— 让任意客户端(含自研)接订阅开箱即稳。想对某个客户端关掉,在管理台取消勾选即可(存为显式 `false` 覆盖默认)。其余能力(限流、白名单等)默认关闭。
> 其中前两项只在**订阅 OAuth** 模式下生效:apiKey 模式(官方密钥/第三方网关)往用户 `system` 里塞 "You are Claude Code" 只会白改提示词、毫无收益,因此自动跳过。

### 兼容性:Claude Code 身份伪装(`spoofClaudeCode`)
订阅 OAuth 门禁不只看 `system` 前缀,还看整套 Claude Code 客户端指纹。开启后 cc-trans 转发时把请求头补成完整 Claude Code 身份:`User-Agent: claude-cli/…`、`x-app: cli`、`accept-encoding: identity`,以及 `anthropic-beta` 四件套(`oauth-2025-04-20` + `claude-code-20250219` + `interleaved-thinking-2025-05-14` + `fine-grained-tool-streaming-2025-05-14`;Haiku 用精简集)。**已默认开启**(与 `injectClaudeCodeSystem` + `stripUnsupported` 一起),显著减少自研客户端走订阅时的脱敏 429/门禁。对真实 Claude Code 流量为无操作。

> 实测要点:门禁对 system 前缀是**块级精确匹配** —— 必须是 `[{前缀块}, {你的内容块}]` 两个独立块,把前缀和内容拼在同一个字符串里会被拒。cc-trans 的注入已按此实现。

### 安全:限流 / 并发 / 客户端限制 / 模型白名单(逐令牌)
- `rateLimitRequests` + `rateLimitWindowSec`:滑动窗口请求数上限,超限返回带 `Retry-After` 的 429。
- `concurrencyLimit`:同时处理的请求数上限,超限 429。
- `allowedClient`:`claude_code`(仅允许 `claude-cli/*`)或任意 User-Agent 正则,不匹配返回 403。
- `allowedModels`:模型白名单数组,请求(经改写后的)模型不在其中返回 403。

均为内存态,重启清零,零依赖。令牌泄露/滥用时可据此止血。

### 用量成本
内置 Claude 模型价格表,按实际模型 + token 用量估算 USD 成本(仅展示,非账单),在概览「估算成本」与客户端表「成本」列展示。

### OpenAI 兼容端点 `/v1/chat/completions`
让 OpenAI 生态的客户端也能用你的 Claude 订阅。cc-trans 把 OpenAI 请求翻译成 Anthropic `/v1/messages` 转发(复用订阅凭证 / 身份伪装 / 参数下发),再把响应翻译回 OpenAI 格式(含 SSE 流式)。支持文本、图片(`image_url`,含 data: base64)、`system`/`developer`、`temperature`/`top_p`/`stop`/`max_tokens`、`usage` 与 `finish_reason` 映射;工具定义与 `tool_calls` 基础支持。远端配置:
```
export OPENAI_BASE_URL="http://<服务器IP>:8787/v1"   # 视客户端而定,base 指到 /v1
export OPENAI_API_KEY="cct-你的客户端令牌"
# model 直接填 Claude 模型名,如 claude-opus-4-8
```

### 性能:上游连接池
默认直连即复用连接(Node 内置 fetch 底层 undici 自带 keepalive 连接池),零配置即有收益。

### 上游代理(HTTP / HTTPS / SOCKS5)
网络受限时让上游走代理:config.json 设 `upstreamProxy`(或 env `CC_TRANS_UPSTREAM_PROXY`),支持 `http://`、`https://`、`socks5://[user:pass@]host:port`。SOCKS5 握手为零依赖自实现。⚠️ **启用代理需 `npm i undici`**(核心默认零依赖;不装则自动回落直连并给出提示)。

### 健康检查
`GET /health`(或 `/healthz`,无需令牌)返回:存活、版本、运行时长、上游/代理/凭证状态、订阅 token 到期分钟、内存 RSS、数据目录占用。供 Docker/systemd/k8s 探针与运维用。

### 请求日志:分块存储 + 分页 + 按时间段删除
请求日志按 **日期/小时分块**持久化到 `<data>/logs/<日期>/<小时>.jsonl`(追加写,不建索引):

- **分页查询**:管理台「实时日志」页分页浏览(每页 100 条,倒序),支持按关键字(路径/模型/客户端/IP/UA)、仅异常(≥400)过滤;第一页仍可实时追加新请求(可关)。
- **按时间段删除**:「清理日志」支持三种方式 —— 删除早于 N 天前的 / 删除指定时间区间 / 清空全部。整块命中就删文件,部分命中则重写该块。删日志**不影响**累计统计数字。
- **自动过期**:超过 `logRetentionDays`(默认 14 天)的日期目录自动删除,启动时清一次、之后每 6 小时清一次,磁盘占用可控。
- 页脚实时显示存储概况(块数 / 天数 / MB / 保留天数)。

进程日志(stdout)另有一套:默认交给 journald / docker 轮转;需要独立文件日志时配 `logFile` + `logMaxBytes` + `logMaxFiles`(按大小轮转,只留 N 个)。指标文件 `metrics.json` 本身有界(每日聚合最多 62 天)。

### 存储占用与清理(概览页)
概览底部的「存储占用」把数据目录按类别拆开:请求日志 / 聊天图片 / 聊天会话 / 进程日志 / 配置备份 / 累计统计 / 模型目录 / 配置 / 其它,附分段占比条、文件数、磁盘剩余。

**各类之和恒等于数据目录的实测总量** —— 认不出来的一律进「其它」。对不上就说明有东西没被统计到,这条不变量有测试盯着。

只有"删了确实不影响服务"的类别才有清理按钮:

| 类别 | 清理动作 |
| --- | --- |
| 请求日志 | 跳到「实时日志」页已有的清理对话框(N 天前 / 时间区间 / 全部) |
| 聊天图片 | **只删孤儿**:没有任何会话引用、且已放置 1 小时以上的 |
| 聊天会话 | 清空全部用户的会话(连同配图) |
| 配置备份 | 删除 `config.json.bak-*` 快照,当前生效的配置不动 |
| 进程日志 | 只删已轮转的文件,正在写的那个不动 |

`metrics.json` / `models.json` / `config.json` / 「其它」**故意不给按钮**:前三个各只有几 KB,清空只丢历史、省不出空间;最后一个是认不出来的东西,不该配一键删。

两个实现要点:

- **图片是按内容寻址、多会话共享的**,所以删会话不能顺手删图。现在删单个会话 / 清空 / 超上限淘汰这三条路径都会回查引用,只清真正没人用的;`clear()` 因为一条会话不剩,直接端掉整个 media 目录。
- **孤儿判定有 1 小时宽限期**。用户在输入框贴了图还没发送时,那张图已经落盘但尚未被任何消息引用 —— 按引用判定它就是孤儿,这时清扫会让他一发送就报错。面板显示的可清理数量和真清理的数量走**同一段判定**(dryRun),否则两个数字迟早对不上。

扫盘要 stat 整个目录并读全部会话,比其它接口贵,所以**不进概览 5 秒一次的轮询** —— 只在进概览、点「刷新」、清理完成后拉取。

### 异常请求来源标注
未授权尝试(未携带令牌 / 令牌不匹配)会在「客户端」页的**异常来源**表里单列,并标注**来源 IP、User-Agent、最近请求路径**;多个来源 IP 会带计数(悬停看明细)。反代场景自动读 `X-Forwarded-For` / `X-Real-IP` 取真实来源。已配置客户端的「错误」数字也可悬停查看最近一次异常的状态码、时间与来源。

### 手机适配
三个页面(`/admin`、`/u`、聊天)共用 `src/ui-tokens.css` 里的一套响应式规则,不在各页复制:

- **排版密度按断点换一档**:桌面 11/12/13/14px 的阶梯在 390px 屏上读不动,`≤640px` 整条抬到 12/13/15/16px。仍是固定 px,不引入流体缩放(product register 的"固定 rem 而非 clamp"反对的是标题随视口连续缩放,不是反对换档)。
- **设置页在宽屏排成两列卡片**:原来卡片铺满 1800px 而每行控件被 `max-width:520px` 卡住,右边一千多像素是空的;单纯把卡片限窄只是把空白从卡片里挪到页面右侧,并没有解决。现在 `columns: 34rem 2` 让三张卡分两列(高矮不一的两张矮卡自动叠进同一列 —— 用 grid 会因行高对齐在矮卡下面留死白),卡内再分「说明在左 / 控件在右」。**卡内那个断点用 `@container` 而不是媒体查询**:同一个视口下卡片可能排成一列(很宽)也可能两列(较窄),按视口判断必然判错其中一种。
- **表单控件在手机上一律 16px**。这不是审美取舍:iOS Safari 聚焦 `font-size < 16px` 的输入框时会**整页放大且退出后不复位**,页面会当着用户的面跳一下。
- **触控目标按指针类型分档**:`pointer: coarse` 下按钮/选择框/输入框 44px、表格内小按钮 40px、勾选框 24px(带触摸屏的笔记本同样按不准 36px 的按钮,所以用指针类型而不是视口宽度判断)。
- **宽表格在窄屏翻成"一卡一条"**:客户端、用户、模型、存储四张表 `≤640px` 时隐掉表头,每个单元格用 `data-label` 自带列名(标签由 CSS 生成,不往 DOM 塞冗余节点)。**请求日志表不走这套** —— 它是密集等宽数据、靠上下扫读,翻成卡片会变成一屏一条反而更难用,那张表继续横向滚动。
- **覆盖层必须有退路**。聊天页侧栏在手机上是 `position: fixed` 覆盖层,而开关按钮在主区左上角、**正好被侧栏盖住** —— 只做"打开"就等于打开后关不掉(实测确认按钮被侧栏的品牌名遮住)。现在打开的同时备三条退路:点遮罩、点侧栏里的 ✕、按 Esc;同时锁住背景滚动,并在视口变宽时把手机态覆盖层收干净。Artifacts 面板同理(面板头会折行,保证 ✕ 不被挤出视口)。
- 刘海屏:侧栏与输入区用 `env(safe-area-inset-*)` 让开安全区。

### 管理台 URL(每个页面一个地址)
`/admin/overview`、`/admin/clients`、`/admin/models`、`/admin/logs`、`/admin/settings` —— 可直接访问、刷新、收藏、前进/后退,标签页切换会同步地址栏。`/admin` 等价于概览。

### 设置里配置本地 AI 订阅
管理台「设置 → 本地 AI 订阅」可在线完成(**保存即热应用,不用重启**):

- 切换鉴权方式:**订阅 OAuth**(用本机 Claude 登录态)↔ **静态密钥**(官方 API Key / 第三方网关)↔ **继承本机配置**(级联到另一台 cc-trans)
- 改订阅凭证文件路径,并可「检测」某路径是否可用(显示订阅类型、token 到期、能否自动刷新)
- 改继承来源文件路径,同样可「检测」(显示继承到的上游地址与令牌掩码,自环会被判为不可用)
- 改上游地址、上游代理(继承模式下上游地址由来源文件决定,输入框会置灰)
- 切换前会先校验目标模式可用(订阅要有凭证、静态密钥要有 key、继承要能解析出上游),不可用则拒绝保存并保持原状(不会把服务改坏)

密钥只以掩码回显,明文不出服务端;想清空已存密钥填 `__clear__` 保存。

## 一键安装

```bash
bash install.sh            # 引导生成 config.json(自动生成客户端令牌 + 开管理台)并装 systemd 服务
bash install.sh docker     # 同样引导,但用 docker compose 起服务
```

## 5. 远端电脑配置 Claude Code

在远端设置两个环境变量,指向你的服务器:

```bash
export ANTHROPIC_BASE_URL="http://<服务器IP>:8787"
export ANTHROPIC_AUTH_TOKEN="cct-你的客户端令牌"

claude   # 正常使用,工作目录/环境都是远端这台机器的
```

> Claude Code 会把令牌放到 `Authorization: Bearer`(用 `ANTHROPIC_AUTH_TOKEN` 时)或 `x-api-key`(用 `ANTHROPIC_API_KEY` 时),两种 cc-trans 都认。

## 客户端测试

有三层,从浅到深,**都在远端机器上做**(把 `<服务器IP>` 换成你的)。

### 第 0 层 · 连通性

```bash
curl http://<服务器IP>:8787/health
# 期望: {"ok":true,"service":"cc-trans","upstream":"...","clients":N}
```

连不上 → 检查 IP/端口、服务器是否在跑、防火墙(`sudo ufw allow 8787`)。

### 第 1 层 · 一条真实请求(curl)

```bash
curl http://<服务器IP>:8787/v1/messages \
  -H "Authorization: Bearer cct-你的客户端令牌" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5-20250929","max_tokens":16,
       "system":"You are Claude Code, Anthropic'\''s official CLI for Claude.",
       "messages":[{"role":"user","content":"ping"}]}'
# 期望: 返回带 content[].text 的 JSON
```

- 返回 `401` → 令牌不在服务器 `clientTokens` 白名单(或服务器没重启)。
- 返回 `502` → 服务器连不上上游 / 订阅凭证不可用(看服务端日志)。
- 返回 `400` 且 message 是 generic "Error" → **OAuth 订阅模式下,非 Haiku 模型必须带上面那行 `system`**(真实 Claude Code 自带,裸 curl 容易漏)。
- 返回 `429` → 订阅被限流,过会儿再试。

> 订阅(oauth)模式下别用裸 curl 测不带 `system` 的请求 —— 会被上游门禁挡。推荐直接用下面的自检脚本或真实 Claude Code。

### 第 2 层 · 一键自检脚本(推荐,只需 Node ≥ 18)

把 [test/client.mjs](test/client.mjs) 拷到远端,一条命令跑完连通性 / 鉴权 / 非流式 / 流式四项:

```bash
CC_TRANS_URL=http://<服务器IP>:8787 \
CC_TRANS_TOKEN=cct-你的客户端令牌 \
node client.mjs
# 已在仓库里则可直接: npm run test:client (先设置上面两个环境变量)
# 可选 CC_TRANS_MODEL=<模型名> 指定测试模型
```

它会逐项打印 ✅/❌ 并给出失败提示,全过即表示这台远端可以直接配 Claude Code。

### 第 3 层 · 真用 Claude Code

```bash
export ANTHROPIC_BASE_URL="http://<服务器IP>:8787"
export ANTHROPIC_AUTH_TOKEN="cct-你的客户端令牌"
claude
# 进去问一句话,能正常回复即贯通。工作目录/环境都是远端这台机器的。
```

> 自检脚本会自动复用 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`,所以设好这两个变量后直接 `node client.mjs` 也行。

### 服务端侧观察

每个请求服务端日志都会打印:状态码、耗时、模型、token 用量(`in/out/cacheR/cacheW`)、来源设备名。客户端测试时盯着服务端日志,能立刻看出请求有没有到、卡在哪一步。

### 本机自带的单测

```bash
npm test   # 三套件:smoke(鉴权/注入/转发/流式)+ overrides(参数下发/目录)+ features(身份伪装/限流/成本/OpenAI 兼容),全用 mock 上游,无需真实密钥
```

## 稳定性(针对 "Connection closed mid-response")

代理侧已内置这些兜底,减少远端 Claude Code 报 `API Error: Connection closed mid-response`:

- **首字节前自动重试**:上游连接失败或响应在第一个字节前中断时,代理自动重试(最多 2 次,退避 300/600ms),对客户端完全透明;响应头也是等到首字节到达才写回。
- **SSE 流中断优雅收尾**:上游流在回传中途断掉时,补发一个合法的 `event: error`(`overloaded_error`)并正常结束 HTTP 响应,客户端能识别错误并**自动重试**,而不是收到裸 TCP 断连。
- **keep-alive 不主动断**:关闭了 Node 默认 5 秒的空闲 keep-alive 超时(客户端复用连接时最容易撞上这个断连竞态),并开启 TCP 层保活(30s),防 NAT/ZeroTier/内网穿透静默丢链。
- **SSE 静默保活(治本)**:转发 SSE 时,上游超过 10 秒没吐字节(如模型长思考期间)就自动往客户端补一个 SSE 注释帧 `: keepalive`(客户端忽略),保证每 ~10s 必有字节穿过 frp/NAT/中转的每一跳,不让任一跳的空闲超时掐断连接——这是"Connection closed mid-response"在长思考场景下的根因解法,与用 xtcp/stcp/http 哪种隧道无关。日志的 `保活帧=N` 显示补发数量。
- **订阅 token 刷新带网络重试**,减少偶发 502。

若仍出现:看服务端日志里对应时刻的记录(`重试` / `流中断` / `502`),能区分是代理→上游的问题还是远端→代理的网络问题。

## 故障排查

服务端日志(`journalctl -u cc-trans -f` 或前台 stdout)是第一现场。常见症状:

| 现象 | 原因与处理 |
| --- | --- |
| `401 鉴权失败` | 客户端令牌不对或服务器没重启。日志会打印 `收到=… 已配置=…` 两个掩码,**对比开头几位**即可看出是否打错(如 `cct-` 漏成 `ct-`)。也可在服务器上 `node src/server.js check-token "<远端在用的令牌>"` 直接验证是否在白名单。 |
| `400` 且 message 是 generic `Error` | OAuth 订阅模式下,**非 Haiku 模型的请求必须带 `system: "You are Claude Code, ..."`**。真实 Claude Code 自带;裸 curl 漏掉就会这样。 |
| `429 rate_limit_error` | 订阅被限流,等一会儿再试。 |
| `502 上游凭证不可用` | OAuth 凭证读不到或刷新失败 → 在服务器上重新 `claude` 登录;或 refresh token 已失效。 |
| `502 上游不可达` | 服务器到 Anthropic/网关的网络不通(看 `upstreamBaseUrl`)。 |
| 远端 `curl /health` 连不上 | 网络层问题:IP/端口、防火墙(`sudo ufw allow 8787`)、或 ZeroTier/内网穿透没在同一网络。 |

**自检命令速查:**

```bash
node src/server.js gen-token                 # 生成一个客户端令牌
node src/server.js check-token "<令牌>"      # 验证某令牌是否在白名单
curl http://localhost:8787/health            # 本机健康检查(无需令牌)
journalctl -u cc-trans -f                    # 实时日志
npm test                                     # mock 上游单测(无需真实凭证)
```

## 项目结构

```
cc-trans/
├── src/
│   ├── server.js          # HTTP 代理主体:鉴权 → 访问控制/限流 → 参数下发/身份伪装 → 转发 → 流式回传 → 用量日志
│   │                      #   子命令: gen-token / check-token
│   ├── config.js          # 配置加载(config.json + 环境变量)与启动前校验
│   ├── oauth.js           # 订阅 OAuth:读凭证、自动刷新、原子写回
│   ├── models.js          # 模型目录 + 参数规则 + 客户端参数下发(强制模型/thinking/effort/清洗/CC身份)
│   ├── pricing.js         # 模型价格表 + 成本估算
│   ├── limits.js          # 内存态限流 / 并发控制
│   ├── openai_compat.js   # OpenAI /v1/chat/completions ↔ Anthropic 翻译(含 SSE 流式)
│   ├── upstream.js        # 上游连接层:连接池 + 可选代理(HTTP/HTTPS/SOCKS5)
│   ├── logger.js          # 可选滚动进程日志(自动轮转)+ 目录占用统计
│   ├── logstore.js        # 请求日志分块存储:按日期/小时分块 + 分页查询 + 按时间删除 + 自动过期
│   ├── model_store.js     # 模型列表持久化(上游拉取结果)+ 版本排序/latest 标记
│   ├── metrics.js         # 指标:累计/每日/按客户端聚合(持久化)+ 成本 + 实时订阅
│   ├── admin.js           # Web 管理台后端:登录鉴权 + API + 托管页面
│   └── admin-ui.html      # 管理台前端(单文件,原生 JS,零外部依赖)
├── deploy/
│   ├── cc-trans.service   # systemd 单元(参考)
│   ├── install-service.sh # 安装为系统服务(开机自启)
│   └── uninstall-service.sh
├── test/
│   ├── smoke.mjs          # mock 上游的端到端单测
│   ├── overrides.mjs      # 参数下发 / 动态模型列表测试
│   ├── features.mjs       # 身份伪装(默认开)/ 限流 / 成本 / OpenAI 兼容测试
│   ├── admin2.mjs         # tab URL 路由 / 订阅配置热应用 / 日志分页与清理 / 异常来源标注
│   └── client.mjs         # 客户端自检(npm run test:client)
├── .github/workflows/docker-publish.yml  # CI:打 v* 标签时构建多架构镜像并发布到 GHCR
├── Dockerfile             # 容器镜像(零依赖;WITH_UNDICI=1 才装 undici 供代理用;NODE_IMAGE 可换镜像源)
├── deploy/docker-entrypoint.sh  # 容器首启引导:修正卷属主 + 生成 config.json/令牌/管理员密码 + 降权启动
├── deploy/drop-privs.mjs  # 用 Node 自带 setuid/setgid 降权(免装 su-exec,保持零依赖)
├── deploy/import-config.sh      # 把裸机版 config.json 导入 Docker 卷(复用令牌/密码/参数下发)
├── deploy/rebuild-metrics.mjs   # 从 journald 历史日志反向重建 metrics.json + 分块日志
├── docker-compose.yml     # 主部署:从 GHCR 拉预构建镜像(下载这一个文件即可)
├── docker-compose.build.yml     # 备用:从源码本地构建(改代码 / 需要代理支持时)
├── .env.example           # compose 可选配置(端口 / 镜像源 / undici / PUID)
├── install.sh             # 一键安装(引导配置 + systemd/docker)
├── config.example.json    # 配置模板
└── config.json            # 实际配置(.gitignore 忽略,含令牌/密钥)
```

## 注意

- **公网暴露**:默认监听 `0.0.0.0`。要让外网远端接入,自行套 HTTPS(Caddy/Nginx 反代)或内网穿透(ZeroTier/tailscale/frp),不要把裸 HTTP + 凭证直接挂公网。
- **凭证安全**:`config.json`(含客户端令牌)与 `~/.claude/.credentials.json`(订阅 token)都不会进版本库;`config.json` 已在 `.gitignore`。
- **吊销**:某个客户端令牌泄露时,从 `clientTokens` 删除对应项并重启服务即可。
- **合规**:订阅 OAuth 转发属灰区,仅自用;详见上文「订阅(OAuth)模式说明」。
