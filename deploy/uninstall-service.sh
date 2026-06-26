#!/usr/bin/env bash
# 卸载 cc-trans systemd 服务。普通用户身份运行(内部用 sudo)。
set -euo pipefail
echo "停止并禁用 cc-trans 服务(需要 sudo 密码)"
sudo systemctl disable --now cc-trans 2>/dev/null || true
sudo rm -f /etc/systemd/system/cc-trans.service
sudo systemctl daemon-reload
echo "✅ 已卸载。仓库与 config.json 未动。"
