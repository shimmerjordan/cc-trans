#!/usr/bin/env bash
# cc-trans 一键安装。用法:
#   bash install.sh            # 引导生成 config.json(如缺)+ 安装 systemd 服务(开机自启)
#   bash install.sh systemd    # 同上,显式指定 systemd
#   bash install.sh docker     # 生成 config.json(如缺)+ docker compose 起服务
# 以【普通用户】运行(systemd 分支内部按需 sudo)。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-systemd}"
cd "$REPO"

command -v node >/dev/null 2>&1 || { echo "❌ 未找到 node,请先安装 Node.js ≥ 18"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "❌ Node 版本过低($(node -v)),需要 ≥ 18"; exit 1; }

# ── 1. 引导 config.json ──
# 新装机一律建在 data/config.json:systemd 与 Docker 共用同一份配置。
# (历史上 systemd 用仓库根的 config.json、Docker 用 data/ 里的那份,而 dataDir 默认
#  都落在 data/ —— 同一份数据两份配置,各自漂移成"同一个服务两种界面"。)
mkdir -p data
if [ -f config.json ]; then
  echo "→ 沿用仓库根的 config.json(老布局)。"
  echo "   提示:把它移到 data/config.json 可与 Docker 部署共用同一份配置。"
elif [ -f data/config.json ]; then
  echo "→ 已存在 data/config.json,沿用。"
else
  echo "→ 未发现配置,从示例生成 data/config.json…"
  cp config.example.json data/config.json
  TOKEN="$(node src/server.js gen-token)"
  # 用 node 安全改写 JSON:写入一个客户端令牌 + 开启管理台
  node -e '
    const fs=require("fs");
    const f="data/config.json";
    const c=JSON.parse(fs.readFileSync(f,"utf8"));
    c.clientTokens=[{token:process.argv[1],name:"default"}];
    c.adminEnabled=true;
    fs.writeFileSync(f,JSON.stringify(c,null,2));
  ' "$TOKEN"
  echo "✅ 已生成 data/config.json"
  echo "   客户端令牌(远端填到 ANTHROPIC_AUTH_TOKEN,请妥善保存):"
  echo "     $TOKEN"
  echo "   管理台已开启(首次启动会在日志打印随机管理员密码)。"
  echo "   订阅模式:请确保本机已 \`claude\` 登录(~/.claude/.credentials.json 存在)。"
  echo
fi

case "$MODE" in
  systemd)
    echo "→ 安装 systemd 服务(开机自启 + 崩溃重启)…"
    bash deploy/install-service.sh
    ;;
  docker)
    command -v docker >/dev/null 2>&1 || { echo "❌ 未找到 docker"; exit 1; }
    echo "→ docker compose 构建并启动(restart=unless-stopped 即开机自启)…"
    mkdir -p data
    docker compose up -d --build
    echo
    echo "完成。常用命令:"
    echo "  查看日志:   docker compose logs -f"
    echo "  重启:       docker compose restart"
    echo "  停止:       docker compose down"
    echo "  健康检查:   curl http://localhost:8787/health"
    ;;
  *)
    echo "❌ 未知模式: $MODE(可选 systemd | docker)"; exit 1;;
esac
