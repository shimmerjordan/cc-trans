# cc-trans

Anthropic API 反向代理。让**其他电脑**上的 Claude Code 把请求发到**你这台服务器**,由服务器注入真实的模型凭证后转发到上游。

- **模型、凭证、上游地址** —— 全部在服务器(本机)这一侧,远端不接触。
- **工作目录、环境、文件** —— 全部在远端,因为 Claude Code 是跑在远端的,本机只做 HTTP 转发。
- **鉴权** —— 远端必须带一个你分发的访问令牌,校验通过才转发,并在转发时换成本机的真实凭证。
- **两种上游凭证**:
  - `oauth`(默认):转发本机 **Claude Code 订阅(Pro/Max/Team)登录态** —— 读 `~/.claude/.credentials.json`,自动用 `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20` 转发,token 过期自动刷新并写回。**这就是"用订阅、不用 API key"的模式。**
  - `apiKey`:用静态 `sk-ant-` 密钥(走官方或中转网关)。
- **Web 管理台**(`/admin`):账号密码登录,概览(流量折线图/客户端环形图)、客户端令牌在线生成与吊销、实时日志。详见下文「Web 管理台」。
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
| 想启用上游代理(HTTP/SOCKS5) | 预构建镜像不含 undici。改用源码构建:把 `docker-compose.build.yml` 里 `WITH_UNDICI` 改成 `"1"`,`docker compose -f docker-compose.build.yml up -d --build`,再到管理台「设置 → 上游代理」填地址。 |
| 源码构建时 Docker Hub 拉不动基础镜像 | 改 `docker-compose.build.yml` 里的 `NODE_IMAGE`(如 `docker.m.daocloud.io/library/node:22-alpine`)后重新 build。 |
| 端口冲突(8787 被占) | 不用改文件:`CC_TRANS_HOST_PORT=9787 docker compose up -d`。 |
| 想换成 systemd 裸机部署 | 见下方「一键安装」。 |

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
npm test        # 四套件共 89 项,全部打本地 mock 上游
```

| 套件 | 覆盖 |
| --- | --- |
| `test/smoke.mjs` | 鉴权、凭证注入、转发、SSE 流式、用量嗅探 |
| `test/overrides.mjs` | 参数下发、动态模型列表(上游拉取/持久化/规则推断) |
| `test/features.mjs` | CC 身份伪装(默认开 + 显式关)、限流/并发/UA/白名单、成本、OpenAI 兼容端点 |
| `test/admin2.mjs` | tab URL 路由、订阅配置热应用、日志分页与清理、异常来源标注 |

单跑某一套件:`node test/features.mjs`。

对着**真实服务**做端到端自检(会真的打上游、消耗额度):

```bash
CC_TRANS_URL=http://localhost:8787 CC_TRANS_TOKEN=cct-你的令牌 npm run test:client
```

## C. 本地 Docker 部署(和 GHCR 镜像等价)

从源码构建并跑起来:

```bash
docker compose -f docker-compose.build.yml up -d --build
docker compose -f docker-compose.build.yml logs -f      # 首启令牌 + 管理员密码在这
```

**本机已有 cc-trans 在跑(systemd 或另一个容器)时会撞 8787 端口**,换个宿主机端口即可:

```bash
CC_TRANS_HOST_PORT=18787 docker compose -f docker-compose.build.yml up -d --build
curl http://localhost:18787/health
```

Docker Hub 拉不动基础镜像时加镜像源:

```bash
docker compose -f docker-compose.build.yml build \
  --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine
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
| `upstreamAuth` | `oauth`=转发订阅登录态(默认);`apiKey`=用静态密钥。不填则:有静态密钥走 apiKey,否则 oauth。 |
| `upstreamBaseUrl` | 上游真实地址。官方填 `https://api.anthropic.com`;走中转/自建网关就填它的地址。 |
| `oauthCredentialsPath` | oauth 模式的凭证文件路径,默认 `~/.claude/.credentials.json`,一般不用改。 |
| `upstreamApiKey` | apiKey 模式用:真实密钥(走 `x-api-key`)。与 `upstreamAuthToken` 二选一。 |
| `upstreamAuthToken` | apiKey 模式用:真实密钥(走 `Authorization: Bearer`)。某些中转用这种。 |
| `clientTokens` | 分发给远端的访问令牌数组,`name` 仅用于日志区分设备。 |
| `modelMap` | 可选。把客户端请求的模型名重映射到上游模型。留空则原样转发。 |
| `port` / `host` | 监听端口(默认 8787)/ 网卡(默认 `0.0.0.0` 监听全部)。 |

**用订阅(oauth)模式,只需在服务器上先 `claude` 登录好**,config.json 里 `upstreamAuth` 保持 `oauth` 即可,无需任何密钥。

也可以全部用环境变量代替配置文件(env 优先级最高):

```
CC_TRANS_PORT, CC_TRANS_HOST, CC_TRANS_UPSTREAM_AUTH (oauth|apiKey),
CC_TRANS_UPSTREAM_BASE_URL, CC_TRANS_OAUTH_CREDENTIALS,
CC_TRANS_UPSTREAM_API_KEY, CC_TRANS_UPSTREAM_AUTH_TOKEN,
CC_TRANS_CLIENT_TOKENS (逗号分隔), CC_TRANS_CONFIG (指定配置文件路径)
```

### 订阅(OAuth)模式说明

- 代理在每次请求时读取凭证文件取 access token;**到期前 5 分钟自动用 refresh token 刷新**,并把新 token 原子写回 `~/.claude/.credentials.json`(与服务器自己的 Claude Code 共用同一份登录,互不打架)。
- 关键转发细节(已实测):`Authorization: Bearer <accessToken>` + `anthropic-beta: oauth-2025-04-20`,且**非 Haiku 模型要求请求 `system` 以 `You are Claude Code, ...` 开头** —— 真实 Claude Code 自带,故正常使用无感;但**裸 curl 测非 Haiku 模型且不带该 system 会被上游 400**(见测试一节)。
- ⚠️ **合规提醒**:订阅 OAuth 凭证官方主要面向 Claude Code 客户端本身;经第三方代理转发属灰区,Team 订阅还涉及组织条款。仅建议**自用**(自己的订阅、自己的机器),并务必保证代理私有(靠 clientTokens 鉴权 + 私网/穿透,别裸挂公网)。token 理论上有被限流/吊销风险。

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

**账号密码登录**:用户名取 `adminUser`(默认 `admin`)。`adminPassword` 留空时,**首次启动会自动生成一个随机密码,打印到控制台并写回 config.json**——从 `journalctl -u cc-trans` 里能看到那段醒目的初始密码框。登录后可在**「设置」**里改密码(改完写回 config.json)。会话 12 小时。

功能:

- **概览**:分「服务信息」「订阅用量」「流量统计」三节;订阅用量含 5 小时 / 7 天窗口的已用/剩余进度条(优先取与 Claude Code `/usage` 同源的订阅用量接口,取不到时回落到最近一次转发响应里的 `anthropic-ratelimit-*` 限额头);流量含总请求(累计)/今日请求/错误/成功率/**累计 token 消耗**(输入/输出/缓存读写),以及**折线图**(最近 30 分钟每分钟请求数)、**环形图**(请求按客户端分布)和**柱状图**(最近 14 天每日请求数)。
- **客户端**:每个令牌的请求数、错误数、输入/输出/缓存 token 累计、最近活跃;一键**生成新令牌**(明文只显示一次,自动写回 config.json)、**吊销令牌**(立即失效);每个客户端可单独**参数下发**(见下)。
- **模型/参数**:模型列表**不写死在代码里** —— 一键「从上游拉取并更新列表」即用订阅**实际可用的模型**替换列表并持久化到 `data/models.json`(重启保留),提示本次新增/移除了哪些;也可手动补/移除单个模型 id。各模型的 temperature/thinking/effort 规则由 **模型 id 自动推断**(上游出了新模型如 `claude-opus-4-9` 也能立刻识别到正确规则,无需改代码;完全不认识的 id 会标注「?规则推断」并按最保守规则处理)。附「可传入参数说明」。
- **参数下发(按客户端)**:请求转发前自动改写该客户端的 `/v1/messages` 请求体,支持:**强制模型**(把客户端请求的模型改写为指定模型)、**thinking 覆盖**(adaptive/disabled,Fable 5 自动降级为移除)、**effort 注入**(`output_config.effort`)、**注入 Claude Code system 前缀**(非 Haiku 模型过订阅门禁,已有前缀则不动)、**清洗新模型不支持的参数**(Opus 4.7+/Sonnet 5/Fable 5 上删除 temperature/top_p/top_k、`thinking:enabled`→`adaptive`,避免 400)。全部默认关闭(纯透传);对合规请求(真实 Claude Code)开启也是无操作;给自研客户端接订阅时建议开启后两项。改动写回 config.json 并立即生效,日志会打印每次改写摘要。
- **实时日志**:分块持久化 + **分页浏览**(倒序、关键字/仅异常过滤)+ **按时间段删除**(N 天前 / 时间区间 / 全部)+ 自动过期;第一页可实时追加(SSE)。每行带来源 IP/UA。
- **设置**:**本地 AI 订阅配置**(订阅 OAuth ↔ 静态密钥切换、凭证路径检测、上游地址、代理,保存即热应用)+ 修改管理台密码。
- **每个页面一个 URL**:`/admin/overview`、`/admin/clients`、`/admin/models`、`/admin/logs`、`/admin/settings`,可直达/刷新/收藏/前进后退。

设计与安全:
- 挂在同端口的 `/admin`,与 `/v1/*` 代理流量互不干扰;账号密码登录,与客户端令牌无关。
- 图表为纯内联 SVG 绘制,**无任何外部依赖/CDN**。
- 令牌明文只在**生成那一刻**返回一次,列表只显示掩码;吊销按令牌哈希 id 定位,明文不出服务端。
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

### 异常请求来源标注
未授权尝试(未携带令牌 / 令牌不匹配)会在「客户端」页的**异常来源**表里单列,并标注**来源 IP、User-Agent、最近请求路径**;多个来源 IP 会带计数(悬停看明细)。反代场景自动读 `X-Forwarded-For` / `X-Real-IP` 取真实来源。已配置客户端的「错误」数字也可悬停查看最近一次异常的状态码、时间与来源。

### 管理台 URL(每个页面一个地址)
`/admin/overview`、`/admin/clients`、`/admin/models`、`/admin/logs`、`/admin/settings` —— 可直接访问、刷新、收藏、前进/后退,标签页切换会同步地址栏。`/admin` 等价于概览。

### 设置里配置本地 AI 订阅
管理台「设置 → 本地 AI 订阅」可在线完成(**保存即热应用,不用重启**):

- 切换鉴权方式:**订阅 OAuth**(用本机 Claude 登录态)↔ **静态密钥**(官方 API Key / 第三方网关)
- 改订阅凭证文件路径,并可「检测」某路径是否可用(显示订阅类型、token 到期、能否自动刷新)
- 改上游地址、上游代理
- 切换到订阅模式前会先校验凭证可用,不可用则拒绝保存并保持原状(不会把服务改坏)

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
├── deploy/docker-entrypoint.sh  # 容器首启引导:自动生成 config.json + 客户端令牌 + 管理员密码
├── docker-compose.yml     # 主部署:从 GHCR 拉预构建镜像(下载这一个文件即可)
├── docker-compose.build.yml     # 备用:从源码本地构建(改代码 / 需要代理支持时)
├── install.sh             # 一键安装(引导配置 + systemd/docker)
├── config.example.json    # 配置模板
└── config.json            # 实际配置(.gitignore 忽略,含令牌/密钥)
```

## 注意

- **公网暴露**:默认监听 `0.0.0.0`。要让外网远端接入,自行套 HTTPS(Caddy/Nginx 反代)或内网穿透(ZeroTier/tailscale/frp),不要把裸 HTTP + 凭证直接挂公网。
- **凭证安全**:`config.json`(含客户端令牌)与 `~/.claude/.credentials.json`(订阅 token)都不会进版本库;`config.json` 已在 `.gitignore`。
- **吊销**:某个客户端令牌泄露时,从 `clientTokens` 删除对应项并重启服务即可。
- **合规**:订阅 OAuth 转发属灰区,仅自用;详见上文「订阅(OAuth)模式说明」。
