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

```
┌────────── 远端电脑 ──────────┐         ┌────────── 服务器(本机)────────────┐
│ Claude Code                  │  HTTP   │ cc-trans                            │   HTTPS
│ ANTHROPIC_BASE_URL → 本机    │ ──────▶ │ 校验客户端令牌 → 换上真实凭证 → 转发 │ ───────▶ Anthropic / 中转网关
│ ANTHROPIC_AUTH_TOKEN=客户端令牌│  SSE 流 │ (订阅 OAuth 自动刷新 + 流式回传 + 用量日志) │ ◀───────
└──────────────────────────────┘ ◀────── └─────────────────────────────────────┘
```

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
- **客户端**:每个令牌的请求数、错误数、输入/输出/缓存 token 累计、最近活跃;一键**生成新令牌**(明文只显示一次,自动写回 config.json)、**吊销令牌**(立即失效)。
- **实时日志**:SSE 实时推送每条请求(方法/路径/状态/耗时/模型/用量/客户端),含 401、429 等异常。
- **设置**:修改管理台密码。

设计与安全:
- 挂在同端口的 `/admin`,与 `/v1/*` 代理流量互不干扰;账号密码登录,与客户端令牌无关。
- 图表为纯内联 SVG 绘制,**无任何外部依赖/CDN**。
- 令牌明文只在**生成那一刻**返回一次,列表只显示掩码;吊销按令牌哈希 id 定位,明文不出服务端。
- 累计/每日/按客户端指标持久化在 `data/metrics.json`(已 .gitignore,20 秒落一次盘,重启不清零);最近请求明细为内存态,完整历史仍在 journald。
- 管理台暴露在监听地址上,靠账号密码守门。**仍建议只在私网/ZeroTier 内访问,不要裸挂公网**。

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
npm test   # 用本地 mock 上游验证鉴权/密钥注入/转发/流式,无需真实密钥
```

## 稳定性(针对 "Connection closed mid-response")

代理侧已内置这些兜底,减少远端 Claude Code 报 `API Error: Connection closed mid-response`:

- **首字节前自动重试**:上游连接失败或响应在第一个字节前中断时,代理自动重试(最多 2 次,退避 300/600ms),对客户端完全透明;响应头也是等到首字节到达才写回。
- **SSE 流中断优雅收尾**:上游流在回传中途断掉时,补发一个合法的 `event: error`(`overloaded_error`)并正常结束 HTTP 响应,客户端能识别错误并**自动重试**,而不是收到裸 TCP 断连。
- **keep-alive 不主动断**:关闭了 Node 默认 5 秒的空闲 keep-alive 超时(客户端复用连接时最容易撞上这个断连竞态),并开启 TCP 层保活(30s),防 NAT/ZeroTier/内网穿透静默丢链。
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
│   ├── server.js          # HTTP 代理主体:鉴权 → 注入上游凭证 → 转发 → 流式回传 → 用量日志
│   │                      #   子命令: gen-token / check-token
│   ├── config.js          # 配置加载(config.json + 环境变量)与启动前校验
│   ├── oauth.js           # 订阅 OAuth:读凭证、自动刷新、原子写回
│   ├── metrics.js         # 内存态指标:按客户端聚合 + 最近请求 + 实时订阅
│   ├── admin.js           # Web 管理台后端:登录鉴权 + API + 托管页面
│   └── admin-ui.html      # 管理台前端(单文件,原生 JS,零外部依赖)
├── deploy/
│   ├── cc-trans.service   # systemd 单元(参考)
│   ├── install-service.sh # 安装为系统服务(开机自启)
│   └── uninstall-service.sh
├── test/
│   ├── smoke.mjs          # mock 上游的端到端单测(npm test)
│   └── client.mjs         # 客户端自检(npm run test:client)
├── config.example.json    # 配置模板
└── config.json            # 实际配置(.gitignore 忽略,含令牌/密钥)
```

## 注意

- **公网暴露**:默认监听 `0.0.0.0`。要让外网远端接入,自行套 HTTPS(Caddy/Nginx 反代)或内网穿透(ZeroTier/tailscale/frp),不要把裸 HTTP + 凭证直接挂公网。
- **凭证安全**:`config.json`(含客户端令牌)与 `~/.claude/.credentials.json`(订阅 token)都不会进版本库;`config.json` 已在 `.gitignore`。
- **吊销**:某个客户端令牌泄露时,从 `clientTokens` 删除对应项并重启服务即可。
- **合规**:订阅 OAuth 转发属灰区,仅自用;详见上文「订阅(OAuth)模式说明」。
