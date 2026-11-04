# 配方

每个改配置的配方都套在 SKILL.md 的六步流程里：先 `GET config` 定位，再预览、给用户看 diff、apply、查 events。下面只写每个配方的 patch 和要检查的结果。字段语义、provider type 的选择与坑见 `docs/providers.md`。

patch 写成文件再提交，便于给用户看：

```bash
model-gateway api POST config/changes --data @change.json
```

## 加一个 OpenAI 兼容 provider

```json
{"reason": "接入 DeepSeek", "patch": [
  {"op": "add", "path": "/providers/-", "value": {
    "id": "deepseek", "type": "openai", "displayName": "DeepSeek",
    "baseUrl": "https://api.deepseek.com/chat/completions",
    "apiKeyRef": "env:DEEPSEEK_API_KEY",
    "models": ["deepseek-flash"]
  }}
]}
```

- `baseUrl` 以 `/chat/completions` 结尾。追加到末尾 = 在共享模型的链上排最后；要排前面就用具体下标代替 `-`。
- 告诉用户在部署环境的 `.env` 里加 `DEEPSEEK_API_KEY`，然后重启（新 env 变量要重启才能读到）。
- 检查：`GET models` 里出现新模型，`providers` 有对应渠道。

## 给 provider 加模型

```json
{"reason": "glm-primary 加 glm-5.3-flash", "patch": [
  {"op": "test", "path": "/providers/0/id", "value": "glm-primary"},
  {"op": "add", "path": "/providers/0/models/-", "value": "glm-5.3-flash"}
]}
```

- 下标以 `GET config` 读到的为准，`test` op 钉住 provider id。
- 需要声明输入能力时写对象形态 `{"id": "...", "modalities": ["text", "image"]}`。
- `restartRequired` 为 false，apply 后 `GET models` 立即可见。

## 调整 fallback 链序

链序 = 声明该模型的 provider 在 `providers` 里的先后。把下标 2 的 provider 挪到最前：

```json
{"reason": "DeepSeek 提到首位", "patch": [
  {"op": "test", "path": "/providers/2/id", "value": "deepseek"},
  {"op": "move", "from": "/providers/2", "path": "/providers/0"}
]}
```

- 预览的 `diff` 按下标逐字段对比，挪动会显示成两个位置上一串字段互换；给用户看时概括为「X 从第 3 位挪到第 1 位」，并附原始 diff。
- 挪 provider 会影响它声明的**所有**模型。只想改一个模型的接棒目标时，改接棒方的 `fallbackModelMap`（见 `docs/providers.md`）。
- 检查：`GET providers` 里该模型的链顺序。

## 加应用密钥

```json
{"reason": "给笔记应用发一把 key", "patch": [
  {"op": "add", "path": "/gateway/keys/-", "value": {"key": "env:GATEWAY_KEY_NOTEBOOK", "app": "notebook", "note": "笔记应用 .env：网关 API key"}}
]}
```

- `app` 是小写 slug，会出现在用量的来源维度里。
- `restartRequired` 为 true。告诉用户：在 `.env` 设 `GATEWAY_KEY_NOTEBOOK=<随机值>`（如 `openssl rand -hex 24`），重启网关，再把同一个值填进应用配置。

## 查某个模型或设备的用量

```bash
model-gateway api GET '/usage?range=30d&groupBy=day&model=glm-5.3'
model-gateway api GET '/usage?range=7d&groupBy=kind,model&device=mac'
model-gateway api GET '/usage?range=today&groupBy=client'
```

- 汇报时把 served 和 observed 分开，observed 没有请求数和成功率，写「未提供」。
- 成本是按 models.dev 定价折算的 API 等值成本，不是订阅实付。

## 处理 Inbox（模型建议）

1. `GET inbox`，把每条待办的渠道、当前模型、候选模型、理由、价格对比讲给用户。
2. 用户选定后：`POST inbox/<id>/add`（新增并保留旧版）、`replace`（替换）、`remove`（确认移除退役模型）或 `dismiss`（放弃）。
3. 检查：`GET events` 有 `model_inbox_applied`；要撤销用 `POST inbox/rollback`。
