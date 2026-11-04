# model-gateway 镜像 — Node 24 alpine（纯 stdlib 零 npm 依赖）
FROM node:24-alpine

WORKDIR /app

# 代码（config.yaml 与 secrets/ 由 compose 挂载覆盖，不打进镜像）
COPY package.json ./
COPY src/ ./src/
# 启动时读取的契约与 schema（Admin API openapi、observed 事件 schema、配置 schema）
COPY docs/openapi.json ./docs/openapi.json
COPY docs/schemas/ ./docs/schemas/
COPY config/config.schema.json ./config/config.schema.json

# config 目录必须有 example 供 findConfigFile 兜底；真实 config.yaml 运行时挂载
COPY config/config.example.yaml ./config/config.example.yaml

ENV NODE_ENV=production
EXPOSE 8080

# 非 root 运行
# 数据目录预建并归 node 所有：命名卷首次挂载时继承该属主
RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["node", "src/server.js"]
