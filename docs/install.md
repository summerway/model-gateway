# 安装与快速开始（npm/npx）

零运行时依赖，唯一要求 **Node.js ≥ 22.13**（`node:sqlite` 免 flag 下限）。

## npx 一分钟起一个网关

```bash
npx @maplesnow/model-gateway init    # 生成最小配置 + 随机密钥，建好数据目录
npx @maplesnow/model-gateway start   # 启动（默认 127.0.0.1:8080）
```

`init` 之后编辑配置目录里的 `.env`，把 `OPENAI_API_KEY=` 填上（或换成你自己的 provider 配置，参考 `config/config.example.yaml` 与 `npm run config:check`），再 `start`。

全局安装后同样可用：`npm i -g @maplesnow/model-gateway && model-gateway start`（命令名是 `model-gateway`）。

## 文件放哪了

| | Linux / macOS | Windows |
|---|---|---|
| 配置 | `$XDG_CONFIG_HOME/model-gateway`（缺省 `~/.config/model-gateway`） | `%APPDATA%\model-gateway` |
| 数据 | `$XDG_DATA_HOME/model-gateway`（缺省 `~/.local/share/model-gateway`） | `%LOCALAPPDATA%\model-gateway` |

- 配置目录：`config.json`（init 生成的最小配置）、`.env`（密钥，权限 600）、`.env.example`。
- 数据目录：`events.jsonl`、`usage.jsonl`、`usage.db`、`model-inbox.json` 等运行时状态。

## 目录与数据文件覆盖

环境变量优先级高于上面的默认位置（`--config-dir` / `--data-dir` 参数再高于环境变量）：

```bash
MODEL_GATEWAY_CONFIG_DIR=/etc/model-gateway \
MODEL_GATEWAY_DATA_DIR=/var/lib/model-gateway \
model-gateway start
```

数据文件路径也可逐个覆盖：`EVENT_LOG_FILE`、`USAGE_LOG_FILE`、`USAGE_DB_FILE`、`MODEL_INBOX_STATE_FILE`（`start` 未显式设置时统一落到数据目录）。已存在的进程环境变量不会被 `.env` 覆盖。

## 子命令

- `model-gateway init [--config-dir D] [--data-dir D] [--force]`
- `model-gateway start [--config-dir D] [--data-dir D]`
- `model-gateway config check [path]` — 校验配置（缺省配置目录下的 `config.json`）
- `model-gateway --help`

容器部署（docker compose 二阶段构建）见仓库 README。
