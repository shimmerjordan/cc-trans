#!/bin/sh
# Docker 首次启动引导:修好挂载卷属主 → 没有 config.json 就从模板生成一份
# (含客户端令牌、开启管理台)→ 降权启动服务。
# 这样 `docker compose up -d` 开箱可用,不需要用户先手写配置或 chown 目录。
set -e

CONFIG="${CC_TRANS_CONFIG:-/app/data/config.json}"
DATA_DIR="$(dirname "$CONFIG")"
CRED="${CC_TRANS_OAUTH_CREDENTIALS:-/home/node/.claude/.credentials.json}"
SETTINGS="${CC_TRANS_INHERIT_SETTINGS:-/home/node/.claude/settings.json}"

# 配置里声明的上游鉴权方式(oauth / apiKey / inherit)。环境变量优先,与 config.js 同序。
# 拿它决定下面预检哪一种来源文件 —— 检错了只会给出误导性的提示。
upstream_auth() {
  if [ -n "$CC_TRANS_UPSTREAM_AUTH" ]; then
    echo "$CC_TRANS_UPSTREAM_AUTH"
    return
  fi
  sed -n 's/.*"upstreamAuth"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" 2>/dev/null | head -1
}

# ── 权限自适应 ───────────────────────────────────────────────────────────
# bind mount 的坑:宿主机 ./data 不存在时 Docker 会以 root:root 建目录,
# 容器内非 root 进程一写就 EACCES。所以以 root 入场、改好属主再降权。
# 目标 uid/gid 优先取挂进来的凭证目录属主(通常就是宿主机当前用户),
# 这样容器写出的文件在宿主机上也归你、且 OAuth 令牌刷新能写回去;
# 取不到就用镜像自带的 node(1000)。也可用 PUID/PGID 显式指定。
DROP=0
if [ "$(id -u)" = "0" ]; then
  CRED_DIR="$(dirname "$CRED")"
  if [ -z "$PUID" ] && [ -d "$CRED_DIR" ]; then
    PUID="$(stat -c %u "$CRED_DIR" 2>/dev/null || true)"
    PGID="$(stat -c %g "$CRED_DIR" 2>/dev/null || true)"
  fi
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"

  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u "$DATA_DIR" 2>/dev/null || true)" != "$PUID" ]; then
    echo "[entrypoint] 修正数据目录属主:$DATA_DIR → $PUID:$PGID"
    chown -R "$PUID:$PGID" "$DATA_DIR"
  fi

  if [ "$PUID" != "0" ]; then
    DROP=1
    export DROP_UID="$PUID" DROP_GID="$PGID"
    # 让 `~` 展开落到挂载点所在的家目录
    export HOME=/home/node
  else
    echo "[entrypoint] 目标用户是 root,不降权运行。"
  fi
else
  # 用户显式 --user / compose user: 指定了身份 —— 不动属主,只在不可写时明确报错
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  if [ ! -w "$DATA_DIR" ]; then
    echo "[entrypoint] ❌ 数据目录不可写:$DATA_DIR(当前 uid=$(id -u))"
    echo "[entrypoint]    你指定了运行身份,请在宿主机执行:chown -R $(id -u):$(id -g) ./data"
    exit 1
  fi
fi

# 老配置里可能写死了 dataDir=/app/data(旧版 entrypoint 干的)。这份 config.json
# 现在与裸机共用,容器路径留在里面会让裸机启动指向不存在的目录 —— 摘掉它。
# 容器自己走 CC_TRANS_DATA_DIR,行为不变。
if [ -f "$CONFIG" ]; then
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    try {
      const c = JSON.parse(fs.readFileSync(f, "utf8"));
      if (typeof c.dataDir === "string" && c.dataDir.startsWith("/app/")) {
        delete c.dataDir;
        fs.writeFileSync(f, JSON.stringify(c, null, 2));
        console.log("[entrypoint] 已从配置里移除容器专用的 dataDir(改由环境变量提供)");
      }
    } catch {}
  ' "$CONFIG" || true
fi

if [ ! -f "$CONFIG" ]; then
  echo "[entrypoint] 未发现 $CONFIG,首次启动 —— 自动生成配置…"
  TOKEN="$(node /app/src/server.js gen-token)"
  node -e '
    const fs = require("fs");
    const [tpl, out, token, dataDir] = process.argv.slice(1);
    const c = JSON.parse(fs.readFileSync(tpl, "utf8"));
    c.clientTokens = [{ token, name: "default" }];
    c.adminEnabled = true;
    c.adminPassword = "";          // 留空 → 首启随机生成并打印到日志
    c.host = "0.0.0.0";
    // 【不】把 dataDir 写进配置:那是容器内路径(/app/data),而这份 config.json
    // 现在由 Docker 与裸机/systemd 共用 —— 写进去,裸机读到就指向不存在的目录。
    // 容器自己用 CC_TRANS_DATA_DIR 环境变量指定(优先级高于文件)。
    fs.writeFileSync(out, JSON.stringify(c, null, 2));
  ' /app/config.example.json "$CONFIG" "$TOKEN" "$DATA_DIR"
  # 上面这步是 root 写的;管理台「设置」页要能改写它,属主得跟运行身份一致
  [ "$DROP" = "1" ] && chown "$DROP_UID:$DROP_GID" "$CONFIG"

  echo ""
  echo "  ┌────────────────────────────────────────────────────────────┐"
  echo "  │ cc-trans 首次启动:已生成客户端令牌(请立刻保存!)"
  echo "  │"
  echo "  │   $TOKEN"
  echo "  │"
  echo "  │ 远端用法: ANTHROPIC_BASE_URL=http://<你的服务器>:8787"
  echo "  │           ANTHROPIC_AUTH_TOKEN=$TOKEN"
  echo "  │"
  echo "  │ 管理台已开启(下面会打印随机管理员密码);配置文件:"
  echo "  │   $CONFIG"
  echo "  └────────────────────────────────────────────────────────────┘"
  echo ""
fi

# 来源文件预检:没挂进来时立刻给出明确提示(而不是等服务启动失败或第一个请求 502)。
# 按声明的鉴权方式检对应的那个文件 —— oauth 看凭证,inherit 看 settings.json。
AUTH="$(upstream_auth)"
case "$AUTH" in
  apiKey)
    : # 静态密钥不需要任何本机文件
    ;;
  inherit)
    if [ ! -f "$SETTINGS" ]; then
      echo "[entrypoint] ⚠️  继承(inherit)模式但没找到本机配置:$SETTINGS"
      echo "[entrypoint]     请把宿主机 ~/.claude 挂进容器(compose 已写好该挂载);"
      echo "[entrypoint]     该文件的 env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 就是要继承的上游。"
    elif ! grep -q 'ANTHROPIC_BASE_URL' "$SETTINGS" 2>/dev/null; then
      echo "[entrypoint] ⚠️  $SETTINGS 里没有 ANTHROPIC_BASE_URL —— 继承模式没有上游可用。"
      echo "[entrypoint]     本机 Claude Code 直连官方时用不了 inherit,请改用 oauth 或 apiKey 模式。"
    elif [ "$DROP" = "1" ] && [ ! -r "$SETTINGS" ]; then
      echo "[entrypoint] ⚠️  $SETTINGS 当前身份可能读不到(运行 uid=$DROP_UID)。"
    fi
    # 与 oauth 不同:inherit 只需要【读】,不写回,所以不校验属主是否一致
    ;;
  *)
    # 空值也走这里:config.js 在没有静态密钥时默认推断成 oauth
    if [ ! -f "$CRED" ]; then
      echo "[entrypoint] ⚠️  订阅模式但没找到凭证:$CRED"
      echo "[entrypoint]     请把宿主机 ~/.claude 挂进容器(compose 已写好该挂载),并确保已在宿主机 \`claude\` 登录。"
      echo "[entrypoint]     没有订阅就在管理台「设置 → 本地 AI 订阅」改用静态密钥;"
      echo "[entrypoint]     本机 Claude Code 已经指向另一台 cc-trans 的话,改用「继承本机配置」(inherit)最省事。"
    elif [ "$DROP" = "1" ] && [ "$(stat -c %u "$CRED" 2>/dev/null || echo "$DROP_UID")" != "$DROP_UID" ]; then
      # 注意:此刻还是 root,test -w/-r 恒真,只能比属主。
      # 凭证通常是 600/700,属主不对 → 降权后直接读不到 → 服务会启动失败,不是"以后才出问题"。
      echo "[entrypoint] ❌ 凭证文件属主($(stat -c %u "$CRED"))与运行身份($DROP_UID)不一致:$CRED"
      echo "[entrypoint]    凭证一般是 600 权限,属主不一致会导致【读不到 → 启动失败】。"
      echo "[entrypoint]    去掉 PUID/PGID 让它自动取属主,或设成 PUID=$(stat -c %u "$CRED") PGID=$(stat -c %g "$CRED")。"
    fi
    ;;
esac

if [ "$DROP" = "1" ]; then
  exec node /app/deploy/drop-privs.mjs /app/src/server.js "$@"
fi
exec node /app/src/server.js "$@"
