# Codex Provider 模块（GPT/Codex OAuth 收编）

网关持有 ChatGPT 账号 OAuth 凭据，客户端经网关使用 GPT 模型（gpt-6-sol / gpt-6-luna 等），
消除 pi / OpenClaw 各自持有 GPT 认证的现状。本模块为独立任务包产物，不依赖 router、
fallback、ops 任务的内部实现（数据面通过 `src/gateway/providers/codex/index.js` 的出口消费）。

## OAuth 流结论（与 codex CLI / pi openai-codex provider 同源）

| 项 | 值 |
|---|---|
| Token 端点 | `POST https://auth.openai.com/oauth/token` |
| 刷新参数 | `grant_type=refresh_token` + `refresh_token` + `client_id`（form-encoded） |
| client_id | `app_EMoamEEZ73f0CkXaXp7hrann`（codex CLI 公共客户端 id） |
| 刷新响应 | `access_token` / `refresh_token`（**每次轮换，必须持久化新值**）/ `id_token` / `expires_in`(秒) |
| accountId | access_token JWT 的 `"https://api.openai.com/auth".chatgpt_account_id` |
| 上游推理端点 | `POST https://chatgpt.com/backend-api/codex/responses`（responses API） |
| 上游请求头 | `Authorization: Bearer <access_token>`、`chatgpt-account-id: <accountId>`、`originator` |

首次登录（可选）：PKCE 浏览器流或 device-code 流（`https://auth.openai.com/codex/device`），
实现见 `oauth.js` 的 `loginWithDeviceCode`。NAS 场景通常直接从 pi 导入，无需重新登录。

## 凭据存储

- 位置：`config/secrets/codex.json`（gitignore 已覆盖，**绝不入库**），权限 600 / 目录 700
- 网关形态：`{ type:'oauth', access, refresh, idToken, expires(ms), accountId }`
- 兼容读取 codex CLI 形态（`tokens: { access_token, refresh_token, account_id }`）——无 expires 字段时视为已过期，首个请求自动触发刷新

## 迁移脚本（从 pi 导入）

```bash
# 探测 ~/.pi/agent/auth.json（$PI_AUTH_JSON > ~/.pi/agent > ~/.config/pi），写入 config/secrets/codex.json
scripts/import-from-pi.sh [目标目录] [源auth.json]

# 选项（作为任意位置参数）：
#   --force     覆盖已存在的目标
#   --if-stale  仅当源文件比目标新时覆盖
# 退出码：0 成功 / 1 源未找到 / 2 解析器缺失 / 3 无 openai-codex OAuth 块
```

脚本不发起任何网络请求；刷新留给网关运行时。

## 运行时行为

- **自动刷新**：过期前 5min 提前刷新；并发请求单飞（只发一次刷新）；刷新成功原子写回（tmp+rename，600）
- **401 自愈**：上游 401 时强制刷新一次重试
- **降级**：刷新连续失败 2 次、或 4xx 永久失败（invalid_grant 等）→ `provider.healthy() === false`（fallback 链据此跳过 codex）；10min 冷却后进入 probation 可自愈（账号额度类临时故障）
- **429 不标记 unhealthy**：账号级用量限额临时耗尽，跳过本请求即可，token 本身有效

## 模块 A 接入点

```js
import { createCodexProvider } from './providers/codex/index.js';

const codex = createCodexProvider({ secretsDir: 'config/secrets', models: ['gpt-6-sol', 'gpt-6-luna'] });
await codex.init();                       // 加载 secrets；缺失 → healthy()=false
codex.healthy();                          // fallback 链查询
codex.status();                           // { id, healthy, reason, expires, accountId, refreshFailures }
await codex.chatCompletions(body, ctx);   // /v1/chat/completions 形态（自动双向转换，支持流式）
await codex.responses(body, ctx);         // /v1/responses 形态（透传 responses API）
```

失败统一抛 `CodexProviderError`（`kind`: auth / rate_limited / upstream；`retryable` 标记）。

## 格式转换说明

- 请求方向：system/developer 消息聚合为 `instructions`；`max_tokens`→`max_output_tokens`；
  `reasoning_effort` 经模型 thinkingLevelMap 映射（off→none …）；`tools[].function` → responses 扁平 tool
- 响应方向：`output_text` part → `message.content`；`function_call` item → `tool_calls`；
  `usage.input/output_tokens` → `prompt/completion_tokens`；`incomplete(max_output_tokens)` → `finish_reason:'length'`
- 流式：`response.output_text.delta` → chat chunk delta；`response.output_item.done(function_call)` → tool_calls chunk；
  `response.completed` → 终 chunk（含 usage + finish_reason）+ `[DONE]`

## 测试

```bash
node --test 'test/codex-*.test.js'   # 45 个模块内测试（OAuth 刷新 mock、转换 fixture、脚本集成）
```

全部网络调用 mock（测试守卫：非 auth.openai.com 的外发请求直接抛错），绝不真打 OpenAI。
