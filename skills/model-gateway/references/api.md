# Admin API 摘要

契约全文：`GET /admin/v1/openapi.json`（不需要鉴权），仓库内为 `docs/openapi.json`。本页只列 agent 最常用的信息。

## 鉴权

- `Authorization: Bearer <MODEL_GATEWAY_ADMIN_KEY>`，只在 token 模式（配置了 `gateway.adminKeyRef`）下可用。
- 例外：`openapi.json` 公开；`POST usage/observed` 接受采集设备 token。

## 端点

| 方法 | path（相对 `/admin/v1`） | 用途 |
|---|---|---|
| GET | `status` | 版本、运行时长、鉴权模式、配置文件路径、`format`、`writable` |
| GET | `config` | 生效配置（`*Ref` 保留 `env:` 引用，字面量 key 显示 `***`） |
| GET | `providers` | 各渠道快照：模型、链、健康、额度、运行状态 |
| GET | `models` | 路由目录（含 `routable: false` 的 Claude 展示位） |
| GET | `quota` | 缓存的额度快照，不触发真实探测 |
| GET | `usage` | 用量；带 `groupBy` 或 `device` 时返回日聚合行 |
| GET | `events` | 最近事件；`?type=&limit=` |
| GET | `inbox` | 模型建议待办、渠道标签、可回滚项 |
| POST | `config/changes` | 预览 patch：`{patch, reason}` → `{changeId, diff, warnings, restartRequired, expiresAt}`，15 分钟内有效 |
| POST | `config/changes/{id}/apply` | 应用预览：校验文件 hash → 备份 → 原子写 → 热加载 providers |
| POST | `config/rollback` | 回滚本进程最近一次 Admin API 变更 |
| POST | `reload` | 只重载 providers |
| POST | `inbox/{id}/{action}` | 处理一条建议，action ∈ `add` / `replace` / `remove` / `dismiss` |
| POST | `inbox/rollback` | 回滚最近一次 Inbox 落地 |
| POST | `usage/observed` | 采集器推送订阅用量（agent 一般用不到） |

## usage 查询参数

`range`（`today`、`yday`、`7d`、`30d`、`90d` 等，与看板一致）、`from` / `to`（`YYYY-MM-DD`）、`groupBy`（逗号分隔：`day`、`kind`、`client`、`provider`、`model`、`device`）、`kind`（`served` / `observed`）、`device`、`client`、`provider`、`model`。

- `provider=codex` 同时包含经网关的 `codex` 与订阅直连的 `codex-local`。
- observed 的 Codex 行 client 是 `codex`，Claude Code 行 client 是 `claude-code` 一类 Agent 名；不确定时先 `groupBy=client` 看实际值。

## 错误

统一形态：`{"error": {"code": "...", "message": "...", "details": {}}}`。

| code | 含义与处理 |
|---|---|
| `admin_key_required` | legacy 模式，Admin API 未启用：请用户配置 `gateway.adminKeyRef` |
| `unauthorized` / `forbidden` | key 缺失、错误，或用了设备 token |
| `config_readonly` | 配置是 YAML：请用户运行 `npm run config:migrate` |
| `config_changed` | 预览后文件被改过：重新读 config、重新预览 |
| `config_invalid` | patch 结果过不了 `validateConfig`：读 message 修 patch |
| `secret_literal_forbidden` | patch 里出现非 `env:` 的密钥：改成 `env:VAR` |
| `patch_invalid` / `patch_test_failed` | patch 语法错，或 `test` op 与当前值不符：重新读 config |
| `change_not_found` | changeId 过期或不存在：重新预览 |
| `reload_failed` | 热加载失败，网关已尝试恢复旧文件：查 events 并告诉用户 |
| `inbox_error` | Inbox 动作被拒，message 说明原因（如候选已变化） |
