#!/bin/sh
# Docker 首次启动引导:如果挂载卷里还没有 config.json,就从模板生成一份、
# 自动生成一个客户端令牌、打开 Web 管理台,然后启动服务。
# 这样 `docker compose up -d` 开箱可用,不需要用户先手写配置。
set -e

CONFIG="${CC_TRANS_CONFIG:-/app/data/config.json}"
DATA_DIR="$(dirname "$CONFIG")"
mkdir -p "$DATA_DIR"

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
    c.dataDir = dataDir;           // 所有状态(指标/模型/日志)都落在挂载卷里
    c.host = "0.0.0.0";
    fs.writeFileSync(out, JSON.stringify(c, null, 2));
  ' /app/config.example.json "$CONFIG" "$TOKEN" "$DATA_DIR"

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

# 订阅模式提醒:凭证目录没挂进来时给出明确提示(而不是等第一个请求 502)
CRED="${CC_TRANS_OAUTH_CREDENTIALS:-$HOME/.claude/.credentials.json}"
if ! grep -q '"upstreamAuth"[[:space:]]*:[[:space:]]*"apiKey"' "$CONFIG" 2>/dev/null; then
  if [ ! -f "$CRED" ]; then
    echo "[entrypoint] ⚠️  订阅模式但没找到凭证:$CRED"
    echo "[entrypoint]     请把宿主机 ~/.claude 挂进容器(compose 已写好该挂载),并确保已在宿主机 \`claude\` 登录。"
    echo "[entrypoint]     或在管理台「设置 → 本地 AI 订阅」改用静态密钥模式。"
  fi
fi

exec node /app/src/server.js "$@"
