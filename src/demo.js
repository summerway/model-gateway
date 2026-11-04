// Offline fixtures for the real dashboard. No production state or jobs are changed here.
import { createHash } from 'node:crypto';
import { normalizeOverrides } from './monitor/pricing.js';

export function isDemo(env = process.env) {
  return env.MODEL_GATEWAY_DEMO === '1';
}

/** Guard every hop, including redirects from a loopback server. Returns a disposer. */
export function installFetchGuard(events) {
  const original = globalThis.fetch;
  const check = url => {
    const host = url.hostname;
    if (['http:', 'https:'].includes(url.protocol)
      && (host === 'localhost' || host === '[::1]' || /^127(?:\.\d+){3}$/.test(host))) return;
    events.record('demo_fetch_blocked', { url: url.href });
    throw new Error(`DEMO MODE: external fetch blocked (${url.origin})`);
  };
  globalThis.fetch = async (input, init) => {
    let request = new Request(input, init);
    for (let hop = 0; ; hop++) {
      check(new URL(request.url));
      const response = await original(request.clone(), { redirect: 'manual' });
      const location = response.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || !location || request.redirect === 'manual') return response;
      await response.body?.cancel();
      if (request.redirect === 'error' || hop >= 20) throw new TypeError('fetch redirect rejected');
      const next = new URL(location, request.url);
      check(next);
      const headers = new Headers(request.headers);
      if (next.origin !== new URL(request.url).origin) {
        for (const name of ['authorization', 'proxy-authorization', 'cookie']) headers.delete(name);
      }
      const toGet = ((response.status === 301 || response.status === 302) && request.method === 'POST')
        || (response.status === 303 && !['GET', 'HEAD'].includes(request.method));
      if (toGet) {
        for (const name of [...headers.keys()]) if (name.startsWith('content-')) headers.delete(name);
      }
      request = new Request(next, { method: toGet ? 'GET' : request.method, headers,
        body: toGet ? undefined : request.body, duplex: 'half', signal: request.signal, redirect: request.redirect });
    }
  };
  return () => { globalThis.fetch = original; };
}

// Small frozen models.dev sample (2026-11-04), $/M tokens. Demo never refreshes it.
const MODELS = {
  'glm-5.3': { name: 'GLM-5.3', input: 1.4, output: 4.4, cacheRead: 0.26 },
  'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', input: 1.74, output: 3.48 },
  'deepseek-flash': { name: 'DeepSeek V4.1 Flash 1017', input: 0.15, output: 0.6, cacheRead: 0.003 },
  'gpt-6-sol': { name: 'GPT-6 Sol', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'gpt-6.1-sol': { name: 'GPT-6.1 Sol', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'gpt-6-luna': { name: 'GPT-6 Luna', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { name: 'Claude Haiku 5.5', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export function seedDemo({ usageLog, events, quotaProbe, activator, inbox, pricing, now = Date.now() }) {
  const stamp = ms => new Date(ms).toISOString();
  pricing.overrides = normalizeOverrides(MODELS);
  pricing.names = new Map(Object.entries(MODELS).map(([id, m]) => [id, m.name]));
  let seed = 1010;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const clients = ['claude-code', 'codex-cli', 'openclaw', 'notebook', 'automation'];
  const devices = ['macbook', 'linux-box', 'windows-pc'];
  const routes = [
    ['glm-coding', 'glm-5.3'], ['deepseek', 'deepseek-v4-pro'], ['deepseek', 'deepseek-flash'],
    ['openrouter', 'gpt-6-luna'], ['codex', 'gpt-6-sol'], ['openrouter', 'gpt-6-sol'],
  ];
  let records = 0;
  for (let ago = 89; ago >= 0; ago--) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - ago);
    const weekend = [0, 6].includes(day.getDay());
    const count = Math.floor((weekend ? 28 : 100) * (0.7 + random() * 0.6));
    const duration = ago === 0 ? now - day.getTime() : 24 * 60 * 60 * 1000;
    for (let i = 0; i < count; i++) {
      const ts = stamp(day.getTime() + Math.floor(duration * (i + 1) / (count + 1)));
      const [providerId, model] = routes[Math.floor(random() * routes.length)];
      const failed = random() < 0.025;
      const fallback = !failed && random() < 0.055 && providerId === 'openrouter' && model === 'gpt-6-luna';
      usageLog.record({ ts, kind: 'served', path: '/v1/chat/completions',
        client: clients[i % clients.length], device: devices[i % devices.length],
        providerId, model: fallback ? 'glm-5.3' : model, upstreamModel: model,
        stream: random() < 0.85, status: failed ? 502 : 200, ok: !failed,
        latencyMs: Math.round(350 + random() * 3800), reported: !failed,
        usage: failed ? null : { input: Math.round(1200 + random() * 14000), output: Math.round(150 + random() * 2400),
          cacheRead: Math.round(random() * 28000), cacheWrite: 0 },
      });
      records++;
      if (i % 4 !== 0) continue;
      for (const [client, provider, observedModel, path] of [
        ['claude-code', 'claude', i % 8 ? 'claude-haiku-5-5' : 'claude-sonnet-5-5', 'claude-code'],
        ['codex', 'codex-local', i % 8 ? 'gpt-6-luna' : 'gpt-6-sol', 'codex-local'],
      ]) {
        usageLog.record({ ts, kind: 'observed', path, client, providerId: provider, model: observedModel,
          device: devices[(i / 4) % devices.length], eventId: `demo:${ago}:${i}:${client}`, reported: true,
          usage: { input: Math.round(2000 + random() * 18000), output: Math.round(500 + random() * 6000),
            cacheRead: Math.round(random() * 85000), cacheWrite: client === 'claude-code' ? Math.round(random() * 10000) : 0 },
        });
        records++;
      }
    }
  }

  const tier = (usedPercent, hours) => ({ usedPercent, resetMs: now + hours * 3600000, resetsAt: stamp(now + hours * 3600000) });
  for (const [id, st] of quotaProbe.state) {
    st.fetchedAt = now;
    st.expiresAt = now + 24 * 3600000;
    st.snapshot = { ok: true, stale: false, fetchedAt: stamp(now),
      ...(id === 'deepseek'
        ? { balance: { total: '268.50', granted: '18.50', toppedUp: '250.00', currency: 'CNY' }, isAvailable: true }
        : { level: id === 'claude' ? 'max' : 'pro', tiers: {
            fiveHour: tier(id === 'glm-coding' ? 93 : id === 'claude' ? 38 : 62, 3.5),
            weekly: tier(id === 'claude' ? 46 : 27, 92),
          } }),
    };
    if (!st.snapshot.tiers) continue;
    st.localAnchor = { resetMs: now + 3.5 * 3600000, resetsAt: stamp(now + 3.5 * 3600000) };
    activator.state.set(id, { lastResetHandledMs: now - 1.5 * 3600000,
      pendingReset: { ...st.localAnchor, src: 'demo' }, queuedReset: null,
      failures: 0, attempts: 0, nextAttemptAt: 0, activating: false });
  }

  const metadata = id => ({ cost: { input: MODELS[id].input, output: MODELS[id].output },
    modalities: { input: ['text', 'image'], output: ['text'] }, ctx: 1050000 });
  inbox.items = [{ id: createHash('sha256').update('demo:codex:upgrade:gpt-6.1-sol').digest('hex'),
    kind: 'upgrade', providerId: 'codex', family: 'gpt', old: 'gpt-6-sol', model: 'gpt-6.1-sol',
    info: metadata('gpt-6.1-sol'), oldinfo: metadata('gpt-6-sol'),
    reason: '发现同系列新版本，缓存读取价格更低', status: 'pending', read: false,
    firstSeen: stamp(now - 2 * 3600000), lastSeen: stamp(now),
  }];
  events.record('activation', { ts: stamp(now - 1.5 * 3600000), providerId: 'glm-coding', model: 'glm-5.3', ok: true });
  events.record('fallback', { ts: stamp(now - 12 * 60000), model: 'glm-5.3', from: 'glm-coding', to: 'openrouter', status: 429 });
  events.record('probe_error', { ts: stamp(now - 9 * 60000), providerId: 'deepseek', error: 'HTTP 503，稍后重试', failures: 1 });
  events.record('model_inbox_pending', { ts: stamp(now - 5 * 60000), providerId: 'codex', model: 'gpt-6.1-sol' });
  events.record('demo_seeded', { ts: stamp(now), records, days: 90 });
}
