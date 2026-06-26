#!/usr/bin/env bash
# 安装 cc-trans 为 systemd 系统服务(开机自启 + 崩溃自动重启)。
# 以【普通用户】身份运行本脚本(不要加 sudo);脚本只在写 /etc 和 enable 时内部调用 sudo。
#   bash deploy/install-service.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(readlink -f "$(command -v node)" 2>/dev/null || true)"
RUN_USER="$(id -un)"
UNIT=/etc/systemd/system/cc-trans.service

echo "仓库目录: $REPO"
echo "node:     ${NODE:-未找到}"
echo "运行用户: $RUN_USER"
echo

[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "❌ 找不到 node 可执行文件,先确保当前 shell 里 node 可用"; exit 1; }
[ -f "$REPO/src/server.js" ] || { echo "❌ $REPO/src/server.js 不存在"; exit 1; }
[ -f "$REPO/config.json" ] || echo "⚠️  未发现 $REPO/config.json,服务会因缺少配置而无法启动,请先配置好。"

echo "将写入 systemd 单元: $UNIT(需要 sudo 密码)"
sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=cc-trans — Anthropic API 反向代理(把本机订阅转发给远端 Claude Code)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$REPO
ExecStart=$NODE $REPO/src/server.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cc-trans
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

echo "→ 释放可能占用 8787 的旧进程(非 systemd 启动的)…"
OLD_PID="$(ss -tlnp 2>/dev/null | grep -oP ':8787\b.*pid=\K[0-9]+' | head -1 || true)"
if [ -n "${OLD_PID:-}" ]; then
  echo "  发现占用 8787 的进程 pid=$OLD_PID,尝试结束"
  kill "$OLD_PID" 2>/dev/null || true
  sleep 1
fi

echo "→ 重载 systemd 并启用开机自启 + 立即启动"
sudo systemctl daemon-reload
sudo systemctl enable --now cc-trans

sleep 1
echo
echo "==== 服务状态 ===="
systemctl --no-pager --full status cc-trans | head -16 || true
echo
echo "完成。常用命令:"
echo "  查看日志:   journalctl -u cc-trans -f"
echo "  重启:       sudo systemctl restart cc-trans"
echo "  停止/禁用:  sudo systemctl disable --now cc-trans"
echo "  健康检查:   curl http://localhost:8787/health"
