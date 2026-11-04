# Provider 配置（给 agent 的操作手册）

管理端 = `config.yaml`。键名、类型、默认值以 `config/config.schema.json` 为准（每个键带 `description`）；语义规则以 `src/config.js` `validateConfig` 为准。本文只记录 schema 表达不了的约定和坑。网关在运行、要通过 Admin API 改配置时，流程与 JSON Patch 写法见 `skills/model-gateway/`；字段语义仍以本文为准。

## 每次改动的固定流程

1. 改 `config.yaml`。所有密钥只写 `env:VAR` 引用，真实值放部署目录 `.env`。示例同步写进 `config/config.example.yaml`。
2. `npm run config:check -- <path>`：schema（含**未知键**——`validateConfig` 会静默丢弃它们）+ `validateConfig`。
3. 声明了新模型名时再加 `--models`：models.dev 未收录只告警，但要确认是拼写错误还是 models.dev 确实没有。
4. 发布：部署目录 `docker compose up -d --build`（配置变更需重启进程才生效）。

完成标准：第 2 步输出「通过」，且第 3 步的每条告警都有结论。

## 选 provider type

| 场景 | type | 要点 |
|---|---|---|
| 任意 OpenAI 兼容 API（DeepSeek 等） | `openai` | `baseUrl` 必须以 `/chat/completions` 结尾；网关自动注入 `stream_options.include_usage` |
| 智谱 Coding Plan | `glm` | 自动获得额度探测与 5h 窗口激活；Claude Code 要走它就加 `anthropicBaseUrl` |
| ChatGPT 订阅（GPT / Codex 模型） | `codex` | 不填 `baseUrl` / `apiKeyRef`；凭据在 `config/secrets/codex.json`（`scripts/import-from-pi.sh` 导入，见 `docs/codex.md`） |
| Claude 订阅 | 不是 provider | 用顶层 `claude:` 段：只读监控 + 激活 + 用量同步，不可路由 |

## 配方

**加一个 OpenAI 兼容 provider**：`providers` 追加条目（`id`、`type: openai`、`baseUrl`、`apiKeyRef: env:XXX_API_KEY`、`models`），`.env` 增加同名变量。它在列表里的位置决定它在共享模型上的 fallback 次序。

**加模型**：在提供方的 `models` 里加。需要声明输入能力时用对象形态 `{ id, modalities: [text, image] }`；能力与价格的真实来源是 models.dev，config 只做本地覆盖。

**调整 fallback 顺序**：同一模型的链 = `providers` 列表里所有声明该模型的条目，按列表顺序。改顺序就是移动 provider 条目；只想影响一个模型时，用 `fallbackModelMap` 而不是挪整个 provider。

**跨渠道接棒改名**：在接棒方写 `fallbackModelMap: { 请求模型: 本渠道模型 }`，目标必须在本渠道 `models` 里。也可以把旧模型名映射到本渠道的新名字（`validateConfig` 允许源模型就是本渠道已有模型）。

**纯文本模型收到图片**：在该模型上加 `visionRouting: { strategy: reroute, target: <视觉模型> }`；target 必须在某个 provider 上声明 `image` 模态。编码代理（长工具循环）加 `uncertain: consumed`。同一模型在多个 provider 上声明的规则必须完全一致。

**让 Claude Code 经网关用某个模型**：该模型链上至少一个 provider 要有 `anthropicBaseUrl`（不含 `/v1/messages`）。没有原生渠道时 `/v1/messages` 直接返回 400——格式转换已移除，不要指望它兜底。

## 新增顶层配置段时

同一个改动里必须同时改三处：`validateConfig` 白名单、`config/config.schema.json`、`config.example.yaml`。漏了白名单，配置会被静默丢弃（2026-10 的历史事故）；漏了 schema，`config:check` 会把合法的键报成未知键。`test/config-schema.test.js` 会检查 schema 与 `validateConfig` 输出的顶层键是否一致。
