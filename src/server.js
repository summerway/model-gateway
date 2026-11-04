#!/usr/bin/env node
// server.js — model-gateway entrypoint.
// Loads config/ (dir from MODEL_GATEWAY_CONFIG_DIR or ./config), builds the
// catalog, starts HTTP + quota probe + window activator + model guard.

import http from 'node:http';
import { join, dirname } from 'node:path';

import { loadConfig, findConfigFile } from './config.js';
import { EventLog } from './events.js';
import { UsageLog } from './monitor/store.js';
import { PricingStore } from './monitor/pricing.js';
import { createRequestHandler } from './gateway/router.js';
import { createAuth } from './auth.js';
import { ConfigChanges } from './admin/config-changes.js';
import { CircuitBreaker } from './gateway/fallback/circuit.js';
import { QuotaProbe } from './ops/jobs/quota-probe.js';
import { WindowActivator, restoreAnchorsFromEvents } from './ops/jobs/window-activator.js';
import { ClaudeUsageSync } from './monitor/claude-usage-sync.js';
import { AgentEndpoints } from './monitor/agent-endpoints.js';
import { ModelInbox } from './ops/model-inbox.js';
import { ModelGuard } from './ops/jobs/model-guard.js';
import { CodexResetForecast } from './ops/jobs/codex-reset-forecast.js';
import { createProviderRegistry } from './gateway/providers/registry.js';
import { isDemo, installFetchGuard, seedDemo } from './demo.js';

const demo = isDemo(process.env);
const demoEvents = demo ? new EventLog(500) : null;
if (demo) installFetchGuard(demoEvents);

const configDir = process.env.MODEL_GATEWAY_CONFIG_DIR ?? (demo ? 'config/demo' : 'config');
const configPath = findConfigFile(configDir);
const config = loadConfig(configDir);

const catalog = { providers: config.providers };
const events = demoEvents ?? new EventLog(500);
const auth = createAuth(config, { events });
if (auth.mode === 'legacy') events.record('security_legacy_ip_trust', { hint: '配置 gateway.adminKeyRef 以启用 token 鉴权' });

// Claude 消费级订阅监控（只读）：伪 provider 仅注入额度探测 / 5h 窗口激活 /
// 用量同步与 dashboard 展示，不进 catalog.providers —— 路由与 /v1/chat/completions
// 寻址零改动（fallbackModelMap 为空，任何模型链都不会命中它）。monitor: true
// 标记监控位：models 仅作展示（卡片展开 + /v1/models routable:false），无调用链。
const monitorProviders = config.claude
  ? [{
      id: 'claude',
      type: 'claude',
      monitor: true,
      displayName: config.claude.displayName,
      badge: config.claude.badge,
      credentialFile: config.claude.credentialFile,
      models: [...(config.claude.models ?? [])],
      modelDefs: {},
      visionRouting: {},
      fallbackModelMap: {},
    }]
  : [];
const monitored = [...config.providers, ...monitorProviders];

// 用量统计：请求级记录（usage.jsonl，35 天保留）+ 定价（models.dev + config.pricing 覆盖）
const usageLog = new UsageLog(demo ? { file: null, dbFile: null } : {});
// pricing 快照落盘（与 model-guard/claude-sync 状态文件同目录约定）：
// 容器重启 + models.dev 瞬时故障不再清空名录（2026-10-30 事故根因之一）
const pricingCacheFile = process.env.MODEL_PRICING_CACHE_FILE
  ?? (process.env.EVENT_LOG_FILE ? join(dirname(process.env.EVENT_LOG_FILE), 'pricing-cache.json') : undefined);
const pricing = new PricingStore({ overrides: config.pricing, cacheFile: demo ? null : pricingCacheFile });
if (!demo) pricing.start();
const usageCleanupTimer = setInterval(() => usageLog.cleanup(), 24 * 60 * 60 * 1000);
usageCleanupTimer.unref();

// imageGeneration.model 无效名称守卫（models.dev 为名称/属性唯一权威）：
// 启动后校验一次 —— 未收录或非 image 型（如 2026-10 的 gpt-image-1.5 误配：
// 后端 403 两个月无感知）记 config_model_unknown 事件，卡片事件流可见。
pricing.ready.then(() => {
  const ig = config.imageGeneration;
  if (!ig || pricing.lastError) return; // 拉取失败不误报
  const type = pricing.typeFor(ig.model);
  if (type !== 'image') {
    events.record('config_model_unknown', {
      where: 'imageGeneration.model',
      model: ig.model,
      issue: type === null ? 'not in models.dev catalog' : `type is "${type}", expected "image"`,
      hint: 'https://models.dev — 统一以 models.dev 校验模型名与属性',
    });
    console.error(`[model-gateway] imageGeneration.model "${ig.model}" failed models.dev validation (${type === null ? 'unknown' : type})`);
  }
}).catch(() => {});

// codex-reset.com 全局重置预测（纯展示；未启用 → 不拉取，卡片不渲染预测区）
const forecast = demo || config.codexResetForecast?.enabled === false
  ? null
  : new CodexResetForecast(config.codexResetForecast ?? {}).start();

// 应用密钥页 Agent 映射：只读 skills 仓 distribution.json（未配置 → 空映射）
const agentEndpoints = new AgentEndpoints({
  file: config.agentEndpoints?.file ?? null,
  intervalMs: (config.agentEndpoints?.intervalSec ?? 600) * 1000,
});
if (!demo) agentEndpoints.start();

// codex providers（type:codex）→ 运行时实例（OAuth token 管理）
const registry = createProviderRegistry({
  secretsDir: join(configDir, 'secrets'),
  config,
});
if (demo) {
  // Display synthetic health without loading or fabricating OAuth credentials.
  registry.snapshot = () => Object.fromEntries(config.providers.filter(p => p.type === 'codex')
    .map(p => [p.id, { healthy: true, reason: null }]));
}

const quotaProbe = new QuotaProbe({
  providers: monitored,
  jobs: config.jobs,
  events,
  registry,
  // 百炼「API 按量付费」余额探测：config.embeddings 的可选 balance AK 配齐才生效
  embeddings: config.embeddings,
});
const activator = new WindowActivator({
  providers: monitored,
  jobs: config.jobs,
  quotaProbe,
  events,
  registry,
  notifyCfg: config.notify,
});
// 启动回放：从持久化 activation 事件重建 GLM/codex/claude 5h 锚点（监控接口有记账
// 延迟，且进程内锚点随重启丢失）。
if (!demo) restoreAnchorsFromEvents({ providers: monitored, quotaProbe, events });
// model-guard state 持久化路径：MODEL_GUARD_STATE_FILE 优先；否则落在 EVENT_LOG_FILE
// 同目录（生产 compose 已设 EVENT_LOG_FILE=/app/data/events.jsonl，data 是持久卷，
// 零 compose 改动即避开镜像层丢失）；都未设置则用 ModelGuard 默认（config 同目录）
const modelGuardStatePath = process.env.MODEL_GUARD_STATE_FILE
  ?? (process.env.EVENT_LOG_FILE ? join(dirname(process.env.EVENT_LOG_FILE), 'model-guard-state.json') : undefined);
const inbox = new ModelInbox({
  file: demo ? null : process.env.MODEL_INBOX_STATE_FILE ?? join(dirname(modelGuardStatePath ?? configPath), 'model-inbox.json'),
  configPath,
  events,
  notifyCfg: demo ? null : config.notify,
  publicUrl: config.modelInbox.publicUrl,
  onChange: () => reloadCatalog(),
  // 并集校验：models.dev 单一数据源，但 pricing 与 model-guard 各自拉 api.json，
  // pricing 副本可能滞后（24h 刷新）→ 候选已在 guard 巡检快照里即可审批（2026-10 修「目录尚未确认」误拒）
  validateModel: model => pricing.typeFor(model) !== null || modelGuard.catalogHas(model),
  metadataFor: model => model ? {
    cost: pricing.costFor(model),
    type: pricing.typeFor(model),
    modalities: pricing.modalitiesFor(model),
  } : null,
});
if (inbox.loadError) events.record('model_inbox_error',{stage:'load',message:'收件箱状态无法读取，管理操作已禁用；模型代理保持运行'});
const modelGuard = new ModelGuard({
  inbox,
  providers: config.providers,
  jobs: config.jobs,
  configPath,
  statePath: modelGuardStatePath,
  events,
  notifyCfg: config.notify,
  onChange: () => reloadCatalog(),
});

// Claude Code 会话用量同步：游标状态文件路径解析仿 model-guard 同目录约定
// （生产 EVENT_LOG_FILE=/app/data/events.jsonl → /app/data/claude-usage-sync-state.json）
const claudeSyncStatePath = process.env.CLAUDE_USAGE_SYNC_STATE_FILE
  ?? (process.env.EVENT_LOG_FILE ? join(dirname(process.env.EVENT_LOG_FILE), 'claude-usage-sync-state.json') : undefined);
const claudeUsageSync = !demo && config.claude
  ? new ClaudeUsageSync({
      sessionDir: config.claude.sessionDir,
      usageLog,
      stateFile: claudeSyncStatePath,
    }).start()
  : null;

function reloadCatalog() {
  try {
    const fresh = loadConfig(configDir);
    catalog.providers = fresh.providers;
    // ModelGuard 持有的旧数组引用同步刷新（catalog.providers 被重新赋值后旧引用
    // 会与实际目录脱钩，导致后续 runOnce 的 deployed 基线陈旧）
    modelGuard.providers = fresh.providers;
    console.log('[model-gateway] catalog reloaded (model-guard applied changes)');
    return true;
  } catch (e) {
    console.error(`[model-gateway] catalog reload failed: ${e.message}`);
    return false;
  }
}

// provider 熔断器（issue #3）：请求路径失败计数 + 冷却降级；state 惰性建，
// model-guard 热更新目录后新 provider 无需重建实例
const circuitBreaker = new CircuitBreaker({
  providers: config.providers,
  circuit: config.gateway.circuit,
  events,
});

const configChanges = new ConfigChanges({
  configPath, stateFile: inbox.file ?? join(dirname(configPath), 'model-inbox.json'),
  reloadCatalog, events, serial: fn => inbox.serial(fn),
});
const handler = createRequestHandler({
  configChanges,
  auth,
  config,
  catalog,
  events,
  circuitBreaker,
  quotaStore: {
    snapshot: () => quotaProbe.snapshot(),
    probeIds: () => [...quotaProbe.state.keys()],
    refresh: (id) => demo ? quotaProbe.snapshot()[id] : quotaProbe.refresh(id, { force: true }),
  },
  registry,
  // claude 激活执行器接口：snapshot 只读；claim/report 由真 CLI sidecar 驱动
  activatorStore: {
    snapshot: () => activator.snapshot(),
    claim: () => demo ? null : activator.claimClaudeActivation(),
    report: (claimId, outcome) => activator.reportClaudeResult(claimId, outcome),
  },
  // 🛡 装饰联动：model-guard 配置态（enabled/dryRun）进 /internal/dashboard features
  modelGuardStore: modelGuard,
  inboxStore: inbox,
  // codex-reset.com 重置预测（可选注入；enabled:false → null 不注入）
  forecastStore: forecast,
  usageLog,
  pricing,
  monitorProviders,
  agentEndpoints,
});
const server = http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((err) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err?.message ?? 'internal error' } }));
    } else {
      res.destroy();
    }
  });
});

server.listen(config.gateway.port, config.gateway.host, async () => {
  const addr = server.address();
  if (demo) {
    seedDemo({ usageLog, events, quotaProbe, activator, inbox, pricing, now: Date.now() });
    console.log('[model-gateway] DEMO MODE — synthetic data, external fetch disabled');
  }
  console.log(`[model-gateway] listening on ${config.gateway.host}:${addr.port} (config: ${configDir})`);
  console.log(`[model-gateway] providers: ${config.providers.map((p) => `${p.id}[${p.type}]`).join(', ')}`);
  if (!demo) {
    await registry.init(); // codex secrets 加载（缺失不致命，fallback 跳过）
    if (config.jobs.probe.enabled) quotaProbe.start();
    if (config.jobs.activate.enabled) activator.start();
    if (config.jobs.modelGuard.enabled) modelGuard.start();
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    quotaProbe.stop();
    activator.stop();
    modelGuard.stop();
    claudeUsageSync?.stop();
    forecast?.stop();
    pricing.stop();
    clearInterval(usageCleanupTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

