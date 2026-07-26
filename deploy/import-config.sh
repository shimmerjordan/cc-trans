#!/usr/bin/env bash
# 把已有的 config.json(裸机/systemd 部署那份)导入 Docker 的数据卷,
# 好让容器复用同一套客户端令牌、管理员密码、参数下发规则。
#
#   ./deploy/import-config.sh                 # 源 = ./config.json,目标 = ./data/config.json
#   ./deploy/import-config.sh /path/to/config.json
#
# 为什么需要这一步:两种部署读的是【不同】的配置文件 ——
#   systemd/裸机:<仓库根>/config.json(WorkingDirectory 下的相对路径)
#   Docker      :/app/data/config.json(compose 里 CC_TRANS_CONFIG 指定,挂载到 ./data)
# 所以容器首启会自己生成一份全新的(新令牌 + 新随机管理员密码),老密码自然登不进去。
set -euo pipefail

SRC="${1:-config.json}"
DEST_DIR="${DEST_DIR:-data}"
DEST="$DEST_DIR/config.json"

[ -f "$SRC" ] || { echo "❌ 找不到源配置:$SRC"; exit 1; }

mkdir -p "$DEST_DIR"
if [ -f "$DEST" ]; then
  BAK="$DEST.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$DEST" "$BAK"
  echo "已备份容器现有配置 → $BAK"
fi

node -e '
const fs = require("fs");
const [src, dest] = process.argv.slice(1);
const c = JSON.parse(fs.readFileSync(src, "utf8"));

// 容器内的路径与监听:其余字段(令牌/密码/modelMap/overrides)原样保留
c.host = "0.0.0.0";
c.port = 8787;               // 容器内固定;宿主机端口由 compose 的 CC_TRANS_HOST_PORT 映射
c.dataDir = "/app/data";     // 指标/模型/日志都落在挂载卷里
// 凭证路径由 compose 的 CC_TRANS_OAUTH_CREDENTIALS 决定(env 优先级更高),这里留空免生歧义
c.oauthCredentialsPath = "";
if (c.logFile) delete c.logFile;   // 裸机的绝对路径在容器里无效;容器日志用 docker logs

fs.writeFileSync(dest, JSON.stringify(c, null, 2));
fs.chmodSync(dest, 0o600);

const n = (c.clientTokens || []).length;
console.log(`已导入 → ${dest}`);
console.log(`  客户端令牌 ${n} 个:` + (c.clientTokens || []).map((t) => t.name || "(未命名)").join("、"));
console.log(`  管理台:${c.adminEnabled ? "开启,沿用原密码" : "未开启"}`);
console.log(`  上游模式:${c.upstreamAuth}`);
' "$SRC" "$DEST"

echo ""
echo "接下来重启容器让它读到新配置:"
echo "  docker compose -f docker-compose.build.yml restart   # 源码构建部署"
echo "  docker compose restart                               # GHCR 镜像部署"
