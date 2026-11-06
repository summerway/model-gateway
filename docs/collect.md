# 本地订阅用量采集

`model-gateway collect` 只读本机 Claude Code 和 Codex 的订阅用量，推送到网关的 `/internal/usage/observed`。需要 Node.js ≥22.13；常驻采集请先全局安装（`npm i -g @maplesnow/model-gateway`），不要从 npx 缓存安装服务。客户端继续使用官方订阅直连，无需修改登录凭据。

## 网关与设备 token

启用网关 token 模式（`gateway.adminKeyRef`），并为每台设备分配一个只用于同步用量的 token：

```yaml
observedUsage:
  enabled: true
  devices:
    - name: win-pc
      keyRef: env:WIN_PC_USAGE_SYNC_KEY
    - name: macbook-pro
      keyRef: env:MACBOOK_USAGE_SYNC_KEY
```

真实 token 只保存在网关运行环境和设备的环境文件中。网关按 token 绑定设备名，覆盖请求里的 `device`。同步 token 不授予模型调用或管理权限。旧的 `observedUsage.apiKeyRef` 仍兼容，设备名取采集器上传值；legacy 模式的 `/internal/*` 仍需可信内网访问。详见 [旧版采集接入说明](mac-observed-usage.md)。

运行 `model-gateway collect install` 会安装当前用户的定时任务，并在环境文件不存在时创建空模板、提示填写。打开模板，填入网关 URL 与该设备的同步 token：

```text
MODEL_GATEWAY_URL=https://gateway.example.com
USAGE_SYNC_KEY=YOUR_DEVICE_SYNC_TOKEN
USAGE_SYNC_DEVICE=win-pc
```

这里的 token 是占位符。Linux/macOS 环境文件必须为 `600` 权限（`chmod 600 <file>`）；Windows 跳过 POSIX 权限检查，应使用当前用户的文件访问权限保护它。文件只解析白名单 `NAME=value`，支持成对引号，不执行 shell。

默认环境文件是 `<configDir>/collect.env`：Linux/macOS 为 `$XDG_CONFIG_HOME/model-gateway/collect.env`（缺省 `~/.config/model-gateway/collect.env`），Windows 为 `%APPDATA%\model-gateway\collect.env`（缺省用户目录下 `AppData\Roaming`）。`MODEL_GATEWAY_CONFIG_DIR` 可覆盖配置目录，`--env-file` 可指定其他文件。

设备名优先级是 `--device NAME` > `USAGE_SYNC_DEVICE` > 主机名规范化值（小写，将特殊字符替换为 `-`，最长 32 位）；使用设备 token 时应与网关绑定名保持一致。

## 设备代理（device-agent）

同一个定时任务还可以兼任设备代理：每轮先跑前置钩子（例如拉取 skills 仓并收敛本机技能端点），再向网关上报设备心跳（硬件 UUID、主机名、型号、检测到的 agent、钩子结果），最后推送用量。网关据此在设备页显示在线状态（默认 15 分钟无心跳判离线），未注册的设备进入注册流程。环境文件可选键：

```text
# 未注册设备：只持共享入网 key（网关 observedUsage.enrollKeyRef），只能发心跳，不推用量
DEVICE_ENROLL_KEY=YOUR_ENROLL_KEY
# 每轮前置命令（sh -c 执行，超时 120 秒；失败不影响心跳与用量）
COLLECT_PRE_HOOK=cd ~/WorkSpace/Projects/skills && git pull --ff-only -q && python3 scripts/converge.py apply --self
# agent 检测规则来源：distribution.json v2 的 agents[*].detect
SKILLS_DISTRIBUTION=/Users/me/WorkSpace/Projects/skills/distribution.json
```

配置了以上任一键即启用心跳（`COLLECT_HEARTBEAT=0` 关闭，`=1` 强制开启）。注册确认后换发设备 token：把 `USAGE_SYNC_KEY` 改为设备 token，删除 `DEVICE_ENROLL_KEY`。硬件 UUID 读取失败时可设 `DEVICE_UUID`；`DEVICE_PLATFORM` 覆盖上报的平台（如 NAS 上设为 `nas`）。

## macOS

```sh
model-gateway collect install
# 填写 ~/.config/model-gateway/collect.env 后，先手动验证：
model-gateway collect --once
# 查看日志（设置了 XDG_STATE_HOME / USAGE_SYNC_STATE_DIR 时使用对应目录）：
tail -f ~/.local/state/model-gateway/collect.log
model-gateway collect uninstall
```

安装 `~/Library/LaunchAgents/local.model-gateway.collect.plist`，以当前用户 LaunchAgent 运行；登录时执行一次，此后默认每 5 分钟执行。日志写入 `<stateDir>/collect.log`。Node 和 CLI 使用安装时的绝对路径；更换 Node 安装位置后请卸载并重新安装采集服务。

## Linux

```sh
model-gateway collect install
# 填写环境文件后验证与查看日志：
model-gateway collect --once
journalctl --user -u model-gateway-collect.service -f
systemctl --user status model-gateway-collect.timer
model-gateway collect uninstall
```

安装 `~/.config/systemd/user/model-gateway-collect.service` 和 `.timer`，使用用户级 oneshot 服务；启动后 1 分钟首次执行，此后默认每 5 分钟执行。需要可用的 systemd 用户会话。若要求退出登录后继续采集，可由管理员配置该用户的 linger。

## Windows

在当前用户的 PowerShell 中执行：

```powershell
model-gateway collect install
# 编辑 $env:APPDATA\model-gateway\collect.env 后验证：
model-gateway collect --once
schtasks /Query /TN model-gateway-collect /V /FO LIST
model-gateway collect uninstall
```

使用任务计划程序，每 5 分钟执行一次。可在“任务计划程序库 → model-gateway-collect”查看最近运行结果；开启“启用所有任务历史记录”后可查看运行历史。需要检查采集计数或 HTTP 错误时，在 PowerShell 中手动运行 `model-gateway collect --once` 查看输出。

## 选项、游标与隐私

```sh
model-gateway collect --once --device laptop --sources=codex,claude-code
model-gateway collect install --interval 10 --env-file /absolute/path/collect.env
model-gateway collect install --print
model-gateway collect uninstall --print
```

`--print` 只打印文件内容和安装/卸载命令，不写文件、不执行服务命令。卸载会先停止定时任务再删除服务文件，保留环境文件、日志和游标。

默认会话目录是 `~/.claude/projects`、`~/.codex/sessions`（Windows 按本机路径规则拼接）。可用 `CLAUDE_PROJECTS_DIR`、`CODEX_SESSION_DIR` 覆盖。游标位于 `$XDG_STATE_HOME/model-gateway`（Linux/macOS 缺省 `~/.local/state/model-gateway`），Windows 为 `%LOCALAPPDATA%\model-gateway\state`（缺省用户目录下 `AppData\Local`）；`USAGE_SYNC_STATE_DIR` 优先覆盖。服务日志目录由安装时的状态目录确定。旧的 `CODEX_USAGE_SYNC_KEY` 和 `CODEX_USAGE_STATE_FILE` 仍兼容。

每个来源每批最多 500 条，`--once` 会连续提交，直到一轮所有来源都不足 500 条才退出；任一来源失败时仍尝试其他来源，然后以退出码 1 结束。无 `--once` 时为常驻循环，正常每 5 分钟扫描，满批后约 1 秒继续，失败按 30 秒至 30 分钟退避。读取进度只在网关完整确认后保存；重传由接收端按事件 id 幂等处理，同一 Claude 消息多行计数取最大值。

只读 token 计数、时间、模型和客户端类别，不上传对话正文和凭据。Claude Code 仅上报 `claude-*`，Codex 仅上报官方订阅会话；通过网关的流量由 served 记账，避免重复计量。observed 没有可靠请求数、耗时和成功率，页面显示“未提供”；成本只是按 API 定价折算的等值估算。页面刷新和采集同步不会发起模型生成请求。

已有 Mac LaunchAgent 可继续使用 `scripts/mac-usage-sync.js`：参数仍兼容，默认设备名保持 `mac`，只在显式传入 `--env-file` 时读取环境文件。迁移到新定时服务时先停用旧 LaunchAgent，保留原游标即可续传。

## 写一个新来源

在 `src/monitor/sources/<id>.js` 默认导出以下接口。现有 `claude-code.js`、`codex.js` 是对共享解析器的包装，可作参考。

```js
export default {
  id: 'tool-id',                         // 推送体的 source
  path: 'tool-local',                     // 入库 path，供去重规则查找
  allowModel: (model) => isOfficialSubscriptionModel(model),
  defaultPaths: ({ platform, home }) => ({ projectsDir: localSessionDir(platform, home) }),
  collect: ({ paths, state, now }) => ({ events, state: nextState }),
  validateBatch: (body, { now, device }) => rows,
};
```

`id` 和 `path` 各自必须唯一。必须声明 `allowModel`，只收该工具的官方订阅模型，避免将经网关、已由 served 记账的流量再次导入。采集阶段也应过滤非订阅会话。Claude Code 只允许 `claude-*`；Codex 已在共享采集器中过滤官方订阅会话，所以其 `allowModel` 保持全部放行。未知历史 path 仍可入库。

`collect` 只读取计数和归因字段，返回本轮事件与下一游标，不写游标；推送成功后才由共用推送器保存。路径按 `platform` 选择 Windows 或 POSIX 拼接规则。`validateBatch` 负责校验该来源的推送体与时间、计数，返回符合 [observed-event.json](schemas/observed-event.json) 的规范化记录；schema 描述的是校验后、入库前的记录，推送协议仍为 `{ source, device?, events }`，`events` 可使用来源自己的格式。接收端统一设置设备名后逐行检查 schema，任一行不合规就拒绝整批。

在 `src/monitor/sources/index.js` 导入模块并加入 `SOURCES` 的模块列表，采集端的 `--sources=`、默认来源列表和计划随之生效，接收端及 store 的去重检查也使用同一注册表。新来源的游标默认是状态目录下的 `<id>-usage.json`；现有 `codex-usage.json`、`claude-usage.json` 与环境变量覆盖保持兼容。

在 `test/observed-sources.test.js` 覆盖注册、官方订阅模型过滤、规范化记录与无效批次，来源解析也应覆盖自己的会话格式。运行 `npm run lint` 和 `npm run test`；现有 Claude、Codex、Mac 采集器和 usage 测试应全部通过。
