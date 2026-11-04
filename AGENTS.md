# model-gateway — 仓库约定

薄 LLM 网关。Node.js ≥22.13（`node:sqlite` 免 flag 下限，2026-10-28 在 node:22.12/22.13/24-alpine 实测），**零运行时依赖**（node:http + 原生 fetch + node:sqlite），单容器部署（二阶段）。

## 定位与分层

核心是**多模型聚合**（统一接入、按模型路由、故障切换）。单进程内分三层，目录一一对应 `src/gateway/`、`src/ops/`、`src/monitor/`；共享部分（`config.js`、`events.js`、`http.js`、`yaml.js`、`dashboard/`）留在 `src/` 根。演进路线与决策依据见 `docs/plan/2026-10-28-positioning-roadmap.md`。依赖方向：gateway → monitor（写 served），ops → gateway/chain（看板展示链序）；monitor 不依赖 ops。

- **gateway**：数据面，`/v1/*` 路由、fallback 和熔断、视觉路由、原生 Anthropic 透传；产生 **served** 用量。
- **ops**：订阅运维（额度探测、5h 激活、Claude 哨兵、Codex OAuth、model-guard 和 Inbox）；会产生动作，额度会影响路由降级。
- **monitor**：用量观测，只读。served（经过网关）与 **observed**（事后从本地会话导入的订阅用量）用 `kind` 区分；不反向驱动路由或激活。
- **admin**（`src/admin/`）：`/admin/v1` 管理 API、OpenAPI 契约与配置事务。依赖方向 admin → ops/monitor/gateway，反向依赖禁止；gateway/router 只负责装配与转交请求。

新功能先判断归属哪一层，再动手。管理端采用配置即代码，不做 Web 管理 UI，Inbox 是唯一的人工确认入口。

## 命令

- `npm test` — 单元测试（node:test）
- `npm run lint` — `node --check` 语法门禁（无 eslint 配置，跳过风格 lint）
- `npm start` — 启动（需 `config/` 目录与 env key refs）
- `npm run config:check -- <path> [--models]` — 配置校验（schema 未知键 + validateConfig；`--models` 查 models.dev 收录）。增删改 provider / 模型前先读 `docs/providers.md`
- `model-gateway api <METHOD> <path>` — 调 Admin API 管理运行中的网关；流程、配方与护栏见 `skills/model-gateway/SKILL.md`

## 硬约束

- **任何真实 apiKey/密码不入库**：配置里只写 `apiKeyRef: env:VAR_NAME`，真实值运行时从 env 读；codex OAuth 凭据在 `config/secrets/codex.json`（gitignore 已覆盖）
- 配置示例进 `config/config.example.yaml`；真实 `config/config.yaml` 已被 .gitignore 排除
- 流式响应（SSE）必须透传，禁止整体缓冲
- 激活请求温和性（GLM/Codex）：单次最小请求，失败退避，绝不并发轰炸（model-guard 退役探测同理）
- model-guard 默认 `dryRun: true`；落地动作只改网关 config，动作记入 events.js
- **模型能力/价格/类型单一数据源 = models.dev api.json**：定价（PricingStore.costFor）与监控位模型输入能力（PricingStore.modalitiesFor）、模型类型（PricingStore.typeFor，如 image=按张计价）都从它取，24h 自动刷新、上游失败保留旧数据；不要在代码里硬编码模型能力清单，config 只作本地覆盖（`pricing:` / provider `modelDefs`）。字段形态：`models.<id>.cost`（$/Mtok，input/output/cache_read/cache_write）、`models.<id>.modalities.input|output`（能力数组，如 `['text','image','pdf']`）、`models.<id>.type`（模型类型，`chat`/`image`/…）
- **模型名称以 models.dev 为准**：config 里声明的模型名（如 `imageGeneration.model`）启动时用 typeFor 校验（非 image 型/未收录 → `config_model_unknown` 事件）；用量记录里的 `pricingMissing` 只上报「models.dev 未收录」的真异常 —— 尖括号伪 id（`<synthetic>`，Claude Code 合成消息，isPseudoModelId）剔除，`typeFor==="image"`（按张计价无 token 价格）不算缺定价
- **claude token 链不变式**：网关进程对 `.credentials.json` 只读（readClaudeCredentials），永不写回/刷新 —— OAuth 单次性 refresh 链由真 CLI（sidecar 执行器）轮换；窗口激活与 token 轮换共用 claim 通道（task: `activate` | `token-refresh`），门控在同一条单执行器状态机里
- **served/observed 不重复计数**：observed 只导入官方订阅模型（Claude Code 只收 `claude-*`，Codex 只收官方订阅会话）；经过网关的流量（例如 Claude Code 以网关为 `ANTHROPIC_BASE_URL` 跑 GLM）只由 served 记一次。规则在 `src/monitor/store.js` 的 `observedAllowed` 统一执行（MG5）。observed 没有请求数、延迟和成功率，页面上显示「未提供」，不要用 served 的口径补齐
- **observed 按 eventId 幂等取最大值**：同一事件再次到达只会把各计数抬到最大值（Claude Code 同一消息多行写入），日聚合补差值；采集端（NAS `claude-usage-sync`、Mac `scripts/mac-usage-sync.js`）共用 `src/monitor/claude-local.js` 解析，不要在采集端自建去重
- **用量存储 = node:sqlite**（`src/monitor/store.js`）：`usage_records` 明细保留 90 天；`usage_daily` 日聚合长期保留，写明细与 upsert 聚合同一事务，明细清理不动聚合；cost 不落盘（查询时按定价计算）。不要绕过 `UsageLog` 直接写库
- **codex-reset.com 预测纯展示**：`jobs/codex-reset-forecast.js` 低频拉取（默认 30min）+ 失败保旧标 stale，不参与路由/激活决策；卡片文案保持「预测/社区基线」口径并外链原站

## 风险实例表

| 风险场景 | 等级 | 处置要点 |
|---|---|---|
| fallback engine retriable 语义改动 | 中 | `retriable` 覆盖位影响链终止/推进决策；改动必须跑全量 codex-integration + fallback 测试 |
| model-guard 落地写 config | 中 | dryRun 默认 true；写后 loadConfig 重载失败会保留旧目录（reloadCatalog 有 catch）；YAML 文本替换只动 models 列表项 |
| 新配置键未进 validateConfig 白名单 | 中 | `jobs.activate.*` / 顶层新 section 必须同时改 config.js 校验、`config/config.schema.json`、example，否则被归一化静默丢弃（历史教训 2026-10）；`test/config-schema.test.js` 守顶层键一致 |
| claude 哨兵/激活状态机改动 | 中 | 单执行器 claim 通道（activate 与 token-refresh 共用）：门控顺序（额度抑制→在途→激活→哨兵）、退避独立、90s 锚点去重；改动必跑 window-activator-claude 全量测试 |

## 部署（二阶段）

源码在本仓库；部署物（compose + .env）放在仓库外的部署目录，发布 `docker compose up -d --build`。作者自己的部署路径记录在上级目录的 AGENTS.md。
