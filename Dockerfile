# cc-trans —— 零依赖 Anthropic 反代。镜像本身不装任何 npm 依赖(核心零依赖)。
# 如需启用上游代理(HTTP/SOCKS5),构建时加 --build-arg WITH_UNDICI=1 安装 undici。
# 基础镜像可覆盖:Docker Hub 拉不动时换镜像源,例如
#   docker compose build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}

WORKDIR /app

# 仅当需要代理支持时才装 undici(默认不装,保持零依赖)
ARG WITH_UNDICI=0
COPY package.json ./
RUN if [ "$WITH_UNDICI" = "1" ]; then npm install undici --no-save --omit=dev; fi

COPY src ./src
COPY config.example.json ./
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 以非 root 运行(node 镜像自带 uid 1000 的 node 用户);/app/data 为状态卷挂载点
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV CC_TRANS_HOST=0.0.0.0 \
    CC_TRANS_PORT=8787 \
    CC_TRANS_CONFIG=/app/data/config.json \
    CC_TRANS_OAUTH_CREDENTIALS=/home/node/.claude/.credentials.json

EXPOSE 8787
VOLUME ["/app/data"]

# 健康检查:命中 /health,失败即不健康(compose/k8s 可据此重启)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CC_TRANS_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
