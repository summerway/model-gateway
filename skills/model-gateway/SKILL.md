---
name: model-gateway
description: 通过 Admin API 查询和管理 model-gateway 网关。用于查用量、额度、渠道状态或事件；加 provider、加模型、调整 fallback 链序、加应用密钥；处理模型建议（Inbox）。
---

# model-gateway 管理

model-gateway 是一个薄 LLM 网关：客户端用一个地址和一把 key 接入，网关按模型把请求路由到多个上游，失败时沿 fallback 链接力。管理全部走 Admin API（`/admin/v1`），没有管理 UI；本 skill 就是管理界面。

## 心智模型

- **三层**：gateway 路由请求并产生 **served** 用量；ops 做订阅运维（额度探测、5 小时窗口激活、模型守护与 Inbox）；monitor 只读观测用量。
- **served 与 observed**：served 是经过网关的请求，有请求数、延迟、成功率；observed 是 Claude Code、Codex 官方订阅直连时由采集器事后导入的 token 计数，**没有**请求数和成功率。两者口径独立、不重复计数，回答用量问题时按 `kind` 分开说，observed 缺的指标说「未提供」，不要用 served 补。
- **fallback 链**：同一模型的链 = `providers` 列表里所有声明该模型的条目，按列表顺序。`fallbackModelMap` 让接棒方把请求模型改写成本渠道的模型名。
- **配置即代码**：配置文件是唯一真相。Admin API 用 JSON Patch 改它：预览、确认、应用，可以回滚。只有 `providers` 段热加载，其它段改完要重启进程。

## 连接

```bash
export MODEL_GATEWAY_URL=http://127.0.0.1:8080      # 网关地址
export MODEL_GATEWAY_ADMIN_KEY=...                  # admin key；npx init 生成在 <配置目录>/.env
model-gateway api GET status                        # 或 node scripts/api.js GET status
```

`model-gateway api <METHOD> <path> [--data @file|-|<json>]` 原样输出 JSON，非 2xx 退出码 1；path 不带前缀时补 `/admin/v1`。完整端点与错误码见 [references/api.md](references/api.md)。

先跑 `GET status`。返回 `403 admin_key_required` 说明网关在 legacy 模式（没配 `gateway.adminKeyRef`），Admin API 不可用：告诉用户在配置里加 `gateway.adminKeyRef: env:MODEL_GATEWAY_ADMIN_KEY` 并设置该变量、重启，然后停下。`status.writable` 为 false 或 `format` 为 `yaml` 时只能查不能改：写配置前先请用户运行 `npm run config:migrate` 并确认配置目录可写。

## 改配置的固定流程

每次改配置都走完这六步，顺序不变：

1. `GET status`：确认 token 模式、`format: json`、`writable: true`。
2. `GET config`：读当前生效配置，从实际内容定位 JSON Pointer（数组下标以读到的为准，不要凭记忆）。
3. `POST config/changes`，body `{"patch": [...], "reason": "<一句话说明>"}`。用 `test` op 钉住你依据的旧值，避免改错位置。
4. **把返回的 `diff`、`warnings`、`restartRequired` 原样给用户看，等用户明确同意。**
5. `POST config/changes/{changeId}/apply`。`409 config_changed` 表示预览之后文件被改过：回到第 2 步重做。
6. `GET events`，确认有 `admin_config_applied`；`restartRequired: true` 时提醒用户重启进程才生效；改了模型时再 `GET models` 看路由目录。

完成标准：用户确认过 diff，apply 返回 `ok: true`，events 里能看到这次变更。出问题时 `POST config/rollback` 回到这次变更之前（只能回滚本进程里最近一次 Admin API 变更）。

## 护栏

- 密钥只以 `env:VAR` 引用写进配置（`apiKeyRef`、`gateway.keys[].key` 等）；真实值由用户放进部署环境的 `.env`。字面量会被拒（`422 secret_literal_forbidden`）。需要新密钥时，告诉用户变量名和放在哪，让用户自己填。
- 每次写配置都经过预览和用户确认：先 `config/changes`，再 `apply`。
- 模型名以 models.dev 为准；不确定的模型名先问用户或请其运行 `npm run config:check -- <path> --models`。

## 配方

加 provider、加模型、调整链序、加应用密钥、查某个模型或设备的用量、处理 Inbox：见 [references/recipes.md](references/recipes.md)。每个配方给出 patch 形态和要检查的结果，字段语义与坑以 [docs/providers.md](../../docs/providers.md) 为准。
