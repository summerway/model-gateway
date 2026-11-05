<p align="center">
  <img src="assets/readme/title.svg" width="100%" alt="model-gateway：自托管 LLM 网关。Claude Code、Codex 和你的应用经一个网关接入 GLM、Codex、DeepSeek 等渠道，某个渠道失败时沿 fallback 链接力到下一个。">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522.13-339933?logo=nodedotjs" alt="Node.js ≥22.13">
  <img src="https://img.shields.io/badge/runtime_dependencies-0-brightgreen" alt="零运行时依赖">
  <img src="https://img.shields.io/badge/OpenAI-compatible-2a78d6" alt="OpenAI 兼容">
  <img src="https://img.shields.io/badge/Anthropic-native_passthrough-8a6bbd" alt="Anthropic 原生透传">
  <img src="https://img.shields.io/badge/License-MIT-orange" alt="MIT">
</p>

给同时用好几家 AI 订阅和 API 的人：客户端只配一个地址、一把 key，网关按模型路由到各家渠道，某家限流或出错就沿你配置的顺序自动换下一家；用量、额度和模型升级都在一个看板里看。管理不做 UI，交给 AI 通过 Admin API 完成。

<p align="center">
  <img src="assets/readme/topo.webp" width="100%" alt="看板「链路拓扑」：左侧是 Mac、Linux、Windows 上的客户端和应用，中间是网关，右侧是 GLM Coding、DeepSeek、OpenRouter、Codex、Claude 渠道及其模型；虚线弧表示 fallback 接力。">
</p>

## 它做什么

- **一个入口**：OpenAI Chat Completions（`/v1/chat/completions`）、Responses（`/v1/responses`）、Anthropic Messages 原生透传（`/v1/messages`）、图像生成、文本向量。Claude Code 可以直接把网关设为 `ANTHROPIC_BASE_URL`。SSE 流式响应逐块透传。
- **自动接力**：同一个模型在多个渠道上声明时，按配置顺序组成 fallback 链；遇到网络错误、429、5xx 或额度用尽就切下一家，连续失败的渠道进入冷却。跨渠道接棒时可以改写模型名（`fallbackModelMap`）。
- **看得见额度**：GLM、Codex、Claude 订阅的 5 小时和每周额度、重置倒计时；5 小时窗口到点自动用一次最小请求续上。
- **用量一张图**：经网关的请求（served）和官方客户端直连的订阅用量（observed）分开记、不重复算，按来源、模型、渠道、设备拆开看，按 models.dev 价格折算成本。
- **模型升级建议**：定期对照 models.dev，发现新版本或疑似退役就放进 Inbox，由你决定添加、替换还是放弃；默认不会自动改配置。

<p align="center">
  <img src="assets/readme/quota.webp" width="100%" alt="订阅额度卡：GLM Coding 5 小时额度 93% 显示即将用尽，Codex 与 Claude 显示正常，各自带重置倒计时。">
</p>

## 快速开始

需要 Node.js ≥ 22.13，零运行时依赖：

```bash
npm install -g @maplesnow/model-gateway   # 命令名是 model-gateway；也可以不安装，直接 npx @maplesnow/model-gateway <命令>

model-gateway init          # 生成最小配置、随机网关 key 与 admin key、数据目录
# 编辑 ~/.config/model-gateway/.env，填入 OPENAI_API_KEY（或改成你自己的渠道）
model-gateway start         # 默认监听 127.0.0.1:8080
```

试一下：

```bash
source ~/.config/model-gateway/.env
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $MODEL_GATEWAY_KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-6-luna","messages":[{"role":"user","content":"hi"}]}'
```

看板在 `http://127.0.0.1:8080/`，中英文可切换。目录位置、Windows 路径和环境变量覆盖见 [docs/install.md](docs/install.md)。

### Docker

```bash
cp config/config.example.yaml config/config.yaml   # 按需修改；密钥只写 env:VAR 引用
docker build -t model-gateway .
docker run -d -p 8080:8080 --env-file .env \
  -v "$PWD/config:/app/config" -v model-gateway-data:/app/data \
  -e EVENT_LOG_FILE=/app/data/events.jsonl -e USAGE_DB_FILE=/app/data/usage.db model-gateway
```

`USAGE_DB_FILE` 是用量库；事件、定价缓存、模型守护状态跟随 `EVENT_LOG_FILE` 所在目录。两者都指向持久卷，重建容器不丢数据。`GET /health` 不需要鉴权，可用于健康检查。

## 配置

一份 YAML 或 JSON。完整示例和每个键的说明见 [config/config.example.yaml](config/config.example.yaml)，键名、类型以 [config/config.schema.json](config/config.schema.json) 为准。

- **密钥永不入库**：配置里只写 `apiKeyRef: env:VAR_NAME`，真实值放在运行环境的 `.env`。
- **改完先校验**：`model-gateway config check [path]`；加 `--models`（`npm run config:check -- <path> --models`）顺带检查模型名是否被 models.dev 收录。
- 加渠道、改链序、视觉路由、跨渠道改名等配方见 [docs/providers.md](docs/providers.md)；Codex（ChatGPT OAuth）接入见 [docs/codex.md](docs/codex.md)。

## 让 AI 管理网关

网关不做管理 UI。配置 `gateway.adminKeyRef` 后开启 Admin API（`/admin/v1`，[OpenAPI 契约](docs/openapi.json)）：先预览一个 JSON Patch，确认差异后再应用，配置原子写入并热加载渠道，失败自动恢复，可以回滚。字面量密钥会被拒绝。

把 [skills/model-gateway](skills/model-gateway/SKILL.md) 交给你的 agent，它就知道该怎么查用量、加渠道、调链序、处理模型建议；命令行入口是一个 curl 薄封装：

```bash
model-gateway api GET status
model-gateway api GET '/usage?range=7d&groupBy=model'
model-gateway api POST config/changes --data @change.json   # 返回 diff，确认后再 apply
```

Admin API 只能写 JSON 配置；YAML 配置先运行 `model-gateway config migrate` 转换（注释不会保留）。

<p align="center">
  <img src="assets/readme/sugg.webp" width="100%" alt="模型建议卡：Codex 渠道发现 GPT-6.1 Sol，与现有 GPT-6 Sol 对比输入能力、价格和上下文，提供「添加并保留旧版」「替换旧版」「放弃」三个按钮。">
</p>

## 采集订阅用量

Claude Code、Codex 用官方订阅直连时不经过网关。在每台机器上装一个只读采集器，把本地会话里的 token 计数推到网关，看板就能按设备汇总：

```bash
model-gateway collect install          # macOS launchd / Linux systemd 用户定时器 / Windows 计划任务，每 5 分钟一次
model-gateway collect install --print  # 只打印将要写入的文件和命令
```

采集器只读 token 计数，不上传对话内容和登录凭据；每台设备一把只能推送用量的 token，设备名由网关绑定。配置方法见 [docs/collect.md](docs/collect.md)；新增一种本地工具的来源见同一文档的「写一个新来源」。

<p align="center">
  <img src="assets/readme/usage.webp" width="100%" alt="用量总览：Token 总量 3.73 亿、总成本 $257、活跃 90 天、单日峰值 693 万、常用模型 GPT-6 Sol；一年的 Activity 热力图；来源占比与模型占比。">
</p>

## 鉴权

| 谁 | 凭据 | 能访问 |
|---|---|---|
| 应用和客户端 | `gateway.keys[]`，可按应用分配，用量按应用归因 | `/v1/*` |
| 管理者或 AI | `gateway.adminKeyRef` | `/admin/v1/*`、`/internal/*` |
| 采集设备 | `observedUsage.devices[].keyRef` | 只能推送用量 |
| 看板 | `dashboard.accessKeyRef`（可选，口令登录） | 页面与只读数据；token 模式下未配置口令时仅本机可访问 |

未配置 `adminKeyRef` 时网关保持旧行为：内部端点信任私网 IP，并在事件里提示升级。放到公网或反向代理后面之前，请先配置 admin key。

## 结构

单进程三层，目录一一对应：

- `src/gateway/`：数据面，路由、fallback 与熔断、视觉路由、原生透传，产生 served 用量。
- `src/ops/`：订阅运维，额度探测、窗口激活、模型守护与 Inbox。
- `src/monitor/`：用量观测，只读；observed 来源插件在 `src/monitor/sources/`。
- `src/admin/`：Admin API、OpenAPI 契约与配置事务。

用量存储是内置的 `node:sqlite`：明细保留 90 天，日聚合长期保留。

## 开发

```bash
npm test            # node:test 单元测试
npm run lint        # node --check 语法门禁
npm run demo        # 离线演示模式：合成数据，不访问外网
```

产品页（`site/`）的改动用 `npm run site:verify` 后 `npx wrangler@4 deploy` 发布到 Cloudflare Workers，流程见 [docs/site.md](docs/site.md)。

仓库约定见 [AGENTS.md](AGENTS.md)。

## License

[MIT](LICENSE)
