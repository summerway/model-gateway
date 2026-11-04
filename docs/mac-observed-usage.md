# Mac 本地订阅用量采集（Codex + Claude Code）

跨平台采集与服务安装请见 [本地订阅用量采集](collect.md)。

采集器 `scripts/mac-usage-sync.js` 只读 `~/.codex/sessions/` 与 `~/.claude/projects/`，同步时间、模型、客户端类别和 Token 计数，记为 observed 用量（设备 `mac`）。Codex App/CLI 与 Claude Code 继续使用官方订阅直连，不需要更改它们的配置或登录凭据。

- Claude Code 只上报官方订阅模型（`claude-*`）：经网关跑的其他模型（如 `glm-5.3`）已由网关记为 served，再上报就是重复计数。
- 同一条 Claude 消息会分多行写入，后写的行 output 可能更完整；接收端按事件 id 幂等，并取各计数的最大值。

## 网关配置

在现有配置中加入：

```yaml
observedUsage:            # 旧名 codexUsage 仍然有效
  enabled: true
  apiKeyRef: env:USAGE_SYNC_KEY
modelInbox:
  publicUrl: https://gateway.example.com
```

将 `publicUrl` 替换为实际网关地址，供邮件生成 Inbox 链接。`USAGE_SYNC_KEY` 使用专用随机值，通过现有安全流程分别配置到网关运行环境和 Mac 的环境文件；它不应加入 `gateway.keys`，也不提供模型调用或管理权限。真实值不写入仓库或命令输出。

配置 `gateway.adminKeyRef` 启用 token 模式后，Mac 的 `USAGE_SYNC_KEY` 填 `observedUsage.devices[]` 对应 `keyRef` 引用的 token；推送不再要求私网 IP。设备名由网关按 token 绑定，覆盖采集器上传的 `device`；旧 `observedUsage.apiKeyRef` 仍可推送，设备名取上传值（默认 `mac`）。

发布时保留网关 `data/` 持久卷。Inbox 状态默认与 `MODEL_GUARD_STATE_FILE`/`EVENT_LOG_FILE` 所在目录相邻，可通过 `MODEL_INBOX_STATE_FILE` 指定。用量存储在 `USAGE_LOG_FILE` 同目录的 `usage.db`（可用 `USAGE_DB_FILE` 覆盖）。

legacy 模式的反向代理继续限制 `/internal/*` 的可信内网访问。token 模式的管理访问需 admin Bearer，登录看板的 cookie 只授权内部 GET 与 Inbox POST。Inbox 写请求还检查 Origin、页面 CSRF 令牌和预览令牌。

## Mac 环境文件

创建权限为 `600` 的文件，例如 `~/.config/model-gateway/usage-sync.env`。内容只需：

```text
MODEL_GATEWAY_URL=https://gateway.example.com
USAGE_SYNC_KEY=YOUR_DEDICATED_SYNC_KEY
```

以上 Key 是占位符，实际配置通过安全通道完成。环境文件按 `NAME=value` 读取，不执行 shell 内容；支持单/双引号包裹的值。可选覆盖：`CODEX_SESSION_DIR`、`CLAUDE_PROJECTS_DIR`、`USAGE_SYNC_STATE_DIR`、`USAGE_SYNC_DEVICE`（默认 `mac`）；旧变量名 `CODEX_USAGE_SYNC_KEY`、`CODEX_USAGE_STATE_FILE` 仍然有效。

使用 Node.js ≥22.13，从仓库执行一次受限批次：

```sh
node scripts/mac-usage-sync.js --env-file "$HOME/.config/model-gateway/usage-sync.env" --once
# 只同步其中一个来源：--sources=codex 或 --sources=claude-code
```

一次最多提交 500 条。首次历史较多时，常驻进程会以受限批次继续导入；正常扫描间隔约 5 分钟，错误后退避。日志只报告计数或错误，不打印上传正文、Key 或 OAuth 凭据。

## 常驻运行

`config/mac-usage-sync.plist.example` 提供 LaunchAgent 模板。将 Node 可执行文件、采集脚本和环境文件的三个占位路径替换为实际绝对路径，再安装到用户 `~/Library/LaunchAgents/local.model-gateway.usage-sync.plist` 并通过 `launchctl bootstrap` 加载。旧的 `scripts/codex-usage-sync.js` 保留为兼容入口（只同步 Codex）。

Node 路径使用实际安装位置，避免依赖 GUI 会话的 PATH。脚本内部会读取受限环境文件，plist 中只保存路径；不要在 plist 中嵌入 Key。停用时卸载这个 LaunchAgent，保留游标即可安全续传。

默认游标文件为 `~/.local/state/model-gateway/codex-usage.json` 与 `claude-usage.json`，两个来源互不影响。读取进度仅在网关完整确认后保存，重复传输由接收端去重；手动删除游标会重新扫描保留期内文件，但不会对已有同一计数重复计量。

## 页面验证与口径

- 看板「用量 › 来源」选择“Codex 本地订阅”查看合计，也可选择 App 或 CLI；无法可靠识别的历史保留“未识别”类别。Claude Code 订阅用量与 NAS 同步的记录同属 `claude-sub-sync` 来源，用设备（`nas` / `mac`）区分。
- 明细保留最近 90 天，与其他来源共享上限；日聚合长期保留。导入记录标记为 `kind: observed`、设备 `mac`。
- 订阅计数没有可靠 HTTP 请求数、耗时和成功状态，相应位置显示未提供；混合统计的请求数/成功率基于已有请求记录，不包含订阅计数。
- fork/子代理的继承片段按祖先会话归因，新产生的计数按自身会话归因；无法可靠解析祖先的继承片段跳过，避免多算。
- 推理输出不再次叠加到输出；缓存输入按网关统一口径拆分。
- 成本为 models.dev 价格折算的 API 等值估算，不能视为订阅实付或精确额度消耗。
- 页面打开、刷新和采集同步都不会发起模型生成请求。

## 排查

| 现象 | 检查 |
| --- | --- |
| HTTP 404 | 网关是否已发布新代码并启用 `observedUsage`（或旧名 `codexUsage`） |
| HTTP 401 | Mac 与网关专用 Key 是否一致，网关是否重建以加载环境变量 |
| HTTP 403 | Mac 是否经 LAN/WireGuard 访问，反向代理与内部来源限制是否匹配 |
| HTTP 400 | 会话格式、时间或计数不合法；检查客户端版本与系统时间，保留游标等待修复 |
| HTTP 503 | 用量持久化失败；接收端不会确认，采集器会保留游标重试 |
| 暂无新用量 | 先完成一段 Codex / Claude Code 应答并等待扫描；首次导入需要多个受限批次 |
| Inbox 提示状态文件异常 | 保留原文件，修复或恢复备份后重启；后台不会因此改配置，模型代理继续运行 |

本次仓库实现和本地合成验证不等于已经部署或安装；上线后应以页面出现预期来源和真实的新计数作为接入验收。
