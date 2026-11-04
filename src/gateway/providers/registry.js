/**
 * providers/registry.js — 目录中的 type:codex 条目 → 运行时 codex provider 实例。
 *
 * 职责：
 *  - 对每个 type:codex 的目录条目构造 createCodexProvider()（凭据从 secretsDir 加载）
 *  - init() 时挂到目录条目的 `.runtime`（router/fallback 经 provider.runtime 调用）
 *  - secrets 缺失不算致命：provider.healthy()=false，fallback 链自动跳过
 *  - /internal/providers 暴露各 codex provider 的 status()（token 健康度）
 */

import { createCodexProvider } from './codex/index.js';

/**
 * @param {object} opts
 * @param {string} opts.secretsDir - codex 凭据目录（含 codex.json）
 * @param {object} opts.config - 网关配置（providers 目录）
 * @param {Function} [opts.fetchImpl] - 测试注入（生产用全局 fetch）
 */
export function createProviderRegistry({ secretsDir, config, fetchImpl } = {}) {
  const entries = new Map(); // providerId -> codex provider instance
  for (const p of config.providers) {
    if (p.type !== 'codex') continue;
    if (entries.has(p.id)) continue; // config 已去重
    const provider = createCodexProvider({
      secretsDir,
      models: p.models,
      baseUrl: p.baseUrl ?? undefined,
      ...(p.originator ? { originator: p.originator } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    entries.set(p.id, provider);
  }

  return {
    /** 启动时加载全部 codex secrets（缺失不致命）。 */
    async init() {
      await Promise.allSettled([...entries.values()].map((c) => c.init()));
      for (const [id, c] of entries) {
        const st = c.status();
        console.log(`[model-gateway] codex provider ${id}: healthy=${st.healthy}${st.reason ? ` (${st.reason})` : ''}`);
      }
    },

    get(providerId) {
      return entries.get(providerId) ?? null;
    },

    /** /internal/providers 数据：codex token 健康度概览。 */
    snapshot() {
      const out = {};
      for (const [id, c] of entries) out[id] = c.status();
      return out;
    },
  };
}
