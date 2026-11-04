import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const code = readFileSync(new URL('../src/dashboard/topology.js', import.meta.url), 'utf8');
function build(data) {
  const context = {};
  runInNewContext(code, context);
  // Convert VM objects to this realm so strict equality compares values.
  return JSON.parse(JSON.stringify(context.MGTopology.build(data)));
}
const render = (data, helpers = {}) => {
  const context = {};
  runInNewContext(code, context);
  return context.MGTopology.html(data, helpers);
};
const channel = (id, models = ['shared-model'], monitor = false) => ({ id, name: id, models, monitor });
const edgeOf = (graph, a, b, type = 'call') => graph.edges.find((e) => e.a === a && e.b === b && e.type === type);

test('third device win-pc renders its own region with its device name', () => {
  const data = {
    providers: [channel('claude', ['claude-model'], true)],
    topology: { directConnections: ['mac', 'nas', 'win-pc'].map((device) => ({ app: 'claude-code', device, providerId: 'claude' })) },
  };
  const graph = build(data);
  assert.deepEqual(graph.nodes.filter((n) => n.type === 'source').map((n) => n.device).sort(), ['mac', 'nas', 'win-pc']);
  const html = render(data);
  assert.match(html, /class="tp-region tp-region-win-pc"/);
  assert.match(html, />win-pc<\/text>/);
});

test('topology keeps Mac and NAS instances separate and connects only the keyed instance to the gateway', () => {
  const graph = build({
    agents: [{ app: 'pi-agent', iconKind: 'pi', location: 'cloud' }],
    keys: [{ app: 'pi-agent' }],
    providers: [channel('glm'), channel('claude', ['claude-model'], true)],
    topology: { directConnections: [{ app: 'pi-agent', device: 'mac', providerId: 'claude' }] },
  });
  const sources = graph.nodes.filter((n) => n.type === 'source');
  assert.equal(sources.length, 2);
  const nas = sources.find((n) => n.device === 'nas');
  const mac = sources.find((n) => n.device === 'mac');
  assert.notEqual(nas.id, mac.id);
  assert.ok(edgeOf(graph, nas.id, 'gateway'));
  assert.ok(edgeOf(graph, mac.id, 'provider:claude'));
  assert.equal(edgeOf(graph, mac.id, 'gateway'), undefined);
  assert.equal(edgeOf(graph, nas.id, 'provider:claude'), undefined);
});

test('direct-only source needs no key and collection edges remain distinct from invocation edges', () => {
  const graph = build({
    keys: [], agents: [], providers: [channel('claude', ['claude-model'], true)],
    topology: {
      collectors: [{ id: 'mac-sync', label: 'Mac 用量采集' }],
      directConnections: [{ app: 'claude-code', device: 'mac', providerId: 'claude', collectorId: 'mac-sync' }],
    },
  });
  const source = graph.nodes.find((n) => n.type === 'source');
  const collector = graph.nodes.find((n) => n.type === 'collector');
  assert.equal(source.app, 'claude-code');
  assert.ok(edgeOf(graph, source.id, 'provider:claude'));
  assert.ok(edgeOf(graph, source.id, collector.id, 'collect'));
  assert.ok(graph.edges.some((e) => e.a === collector.id && e.type === 'collect'));
  assert.equal(edgeOf(graph, source.id, 'gateway'), undefined);
  assert.equal(edgeOf(graph, source.id, collector.id), undefined);
  assert.equal(graph.edges.some((e) => e.a === collector.id && e.type === 'call'), false);
});

test('direct simulation forks invocation and collection from the same source', () => {
  const graph = build({
    providers: [channel('claude', ['claude-model'], true)],
    topology: {
      collectors: [{ id: 'sync', label: '采集器' }],
      directConnections: [{ app: 'claude-code', device: 'nas', providerId: 'claude', collectorId: 'sync' }],
    },
  });
  const source = graph.nodes.find(n => n.type === 'source');
  const scene = graph.routes.find(r => r.nodes.includes(source.id));
  assert.equal(scene.branches.length, 2);
  const [invocation, collection] = scene.branches;
  assert.equal(invocation.nodes[0], source.id);
  assert.equal(collection.nodes[0], source.id);
  assert.equal(invocation.nodes.includes('gateway'), false);
  assert.equal(collection.nodes.at(-1), 'gateway');
  assert.ok(invocation.edges.every(id => graph.edges.find(e => e.id === id).type === 'call'));
  assert.ok(collection.edges.every(id => graph.edges.find(e => e.id === id).type === 'collect'));
});

test('abstract app group connects once and retains its individual app members', () => {
  const graph = build({
    keys: [{ app: 'kb-service' }, { app: 'karakeep' }, { app: 'unassigned' }],
    providers: [channel('glm')],
    topology: { appGroups: [{ id: 'knowledge', label: '知识应用', icon: 'knowledge', apps: ['kb-service', 'karakeep'] }] },
  });
  const group = graph.nodes.find((n) => n.type === 'group' && n.label === '知识应用');
  assert.deepEqual(group.members, ['kb-service', 'karakeep']);
  assert.equal(graph.edges.filter((e) => e.a === group.id && e.b === 'gateway').length, 1);
  // 未归类的 key 不再落「其他应用」：没有分组就不上拓扑。
  assert.equal(graph.nodes.filter((n) => n.type === 'group').length, 1);
  assert.equal(graph.nodes.some((n) => n.app === 'unassigned'), false);
  assert.equal(graph.nodes.some((n) => n.type === 'source' && ['kb-service', 'karakeep'].includes(n.app)), false);
});

test('identical model names in different channels remain distinct and each route ends at its own model', () => {
  const graph = build({ keys: [{ app: 'service' }], providers: [channel('primary'), channel('backup')], topology: { appGroups: [{ id: 'apps', label: '应用', icon: 'business', apps: ['service'] }] } });
  const models = graph.nodes.filter((n) => n.type === 'model');
  assert.equal(models.length, 2);
  assert.notEqual(models[0].id, models[1].id);
  for (const model of models) {
    const ownProvider = `provider:${model.providerId}`;
    assert.ok(edgeOf(graph, ownProvider, model.id));
    const incoming = graph.edges.filter((e) => e.b === model.id);
    assert.equal(incoming.length, 1);
    assert.equal(incoming[0].a, ownProvider);
    assert.ok(graph.routes.some((r) => r.nodes.at(-1) === model.id && r.nodes.at(-2) === ownProvider));
  }
});

test('direct Codex observed provider alias points to the existing Codex channel', () => {
  const graph = build({
    providers: [channel('codex', ['gpt-model'])],
    topology: { directConnections: [{ app: 'codex', device: 'mac', providerId: 'codex-local' }] },
  });
  const source = graph.nodes.find((n) => n.type === 'source');
  assert.ok(edgeOf(graph, source.id, 'provider:codex'));
  assert.equal(graph.nodes.some((n) => n.id === 'provider:codex-local'), false);
});

test('declared direct-only subscription remains visible without a separately configured monitoring channel', () => {
  const graph = build({
    providers: [],
    topology: {
      collectors: [{ id: 'sync', label: 'Mac 用量采集' }],
      directConnections: [{ app: 'claude-code', device: 'mac', providerId: 'claude', collectorId: 'sync' }],
    },
  });
  const source = graph.nodes.find((n) => n.type === 'source');
  const provider = graph.nodes.find((n) => n.type === 'provider');
  assert.ok(provider, 'a declared direct destination must not silently disappear');
  assert.ok(edgeOf(graph, source.id, provider.id));
  assert.equal(edgeOf(graph, 'gateway', provider.id), undefined, 'direct-only destination is not routable');
  assert.ok(graph.nodes.some((n) => n.type === 'collector'));
});

function motionApi() {
  const context = {};
  runInNewContext(code, context);
  return context.MGTopology;
}
const motionEdge = (id, a, b, length, start, end) => ({ id, a, b, length, start: { x: start, y: 0 }, end: { x: end, y: 0 } });

test('particle speed stays constant across long edges, node interiors and very short edges', () => {
  const { measureJourney, sampleJourney } = motionApi();
  const journey = measureJourney([
    motionEdge('one', 'source', 'gateway', 100, 0, 100),
    motionEdge('two', 'gateway', 'provider', 300, 140, 440),
    motionEdge('three', 'provider', 'model', 10, 440, 450),
  ]);
  // Includes a 40px transit through the gateway rather than teleporting ports.
  for (const elapsed of [900, 1001, 1100, 1399, 1401, 1450, 4399, 4401, 4467]) {
    const sample = sampleJourney(journey, 100, elapsed);
    assert.ok(Math.abs(sample.traveled - elapsed / 10) < 1e-8, `constant distance/time at ${elapsed}ms`);
  }
  assert.equal(sampleJourney(journey, 100, 1100).segment.kind, 'inside');
  assert.equal(sampleJourney(journey, 100, 1450).segment.id, 'two');
  assert.equal(sampleJourney(journey, 100, 4467).segment.id, 'three');
  const end = sampleJourney(journey, 100, 4500);
  assert.equal(end.done, true);
  assert.equal(end.traveled, 450);
  assert.deepEqual(Array.from(end.arrivals), ['gateway', 'provider', 'model']);
});

test('sampling a delayed frame preserves overshoot and records every crossed node', () => {
  const { measureJourney, sampleJourney } = motionApi();
  const journey = measureJourney([
    motionEdge('a', 'source', 'gateway', 200, 0, 200),
    motionEdge('b', 'gateway', 'provider', 5, 200, 205),
    motionEdge('c', 'provider', 'model', 100, 205, 305),
  ]);
  const before = sampleJourney(journey, 200, 990);
  const after = sampleJourney(journey, 200, 1040);
  assert.equal(before.segment.id, 'a');
  assert.equal(after.segment.id, 'c');
  assert.equal(after.distance, 3);
  assert.equal(after.traveled - before.traveled, 10);
  assert.deepEqual(Array.from(after.arrivals), ['gateway', 'provider']);
});

test('parallel direct and collection branches both advance at the same emission time', () => {
  const { measureScene, sampleJourney, measureJourney } = motionApi();
  const edges = new Map([
    ['direct', motionEdge('direct', 'source', 'official', 200, 0, 200)],
    ['collect', motionEdge('collect', 'source', 'collector', 50, 0, 50)],
    ['report', motionEdge('report', 'collector', 'gateway', 100, 50, 150)],
  ]);
  const route = { branches: [{ edges: ['direct'] }, { edges: ['collect', 'report'] }] };
  const [call, observed] = measureScene(route, edges);
  const firstCall = sampleJourney(call, 100, 200);
  const firstObserved = sampleJourney(observed, 100, 200);
  assert.equal(firstCall.distance, 20);
  assert.equal(firstObserved.distance, 20);
  assert.equal(firstCall.segment.id, 'direct');
  assert.equal(firstObserved.segment.id, 'collect');
  assert.equal(sampleJourney(observed, 100, 600).segment.id, 'report');
  assert.equal(sampleJourney(call, 100, 600).segment.id, 'direct');
  assert.throws(() => measureJourney([edges.get('direct'), edges.get('collect')]), /Parallel/,
    'flattening branches into a misleading sequential journey must fail');
});

test('three-ball application streams preserve send order with random spacing and scene speed', () => {
  const { makeParticles, measureJourney, sampleJourney } = motionApi();
  const journey = measureJourney([
    motionEdge('a', 'source', 'gateway', 250, 0, 250),
    motionEdge('b', 'gateway', 'model', 350, 280, 630),
  ]);
  for (const random of [() => 0, () => .5, () => 1]) {
    const particles = makeParticles(random);
    assert.equal(particles.length, 3);
    assert.equal(particles[0].delayMs, 0);
    assert.ok(particles[0].delayMs < particles[1].delayMs);
    assert.ok(particles[1].delayMs < particles[2].delayMs);
    assert.equal(new Set(Array.from(particles, p => p.speed)).size, 1);
    for (let elapsed = 0; elapsed < 5500; elapsed += 37) {
      const distances = Array.from(particles, p => elapsed < p.delayMs ? 0 : sampleJourney(journey, p.speed, elapsed - p.delayMs).traveled);
      assert.ok(distances[0] >= distances[1] && distances[1] >= distances[2], 'later emissions never overtake earlier ones');
    }
  }
  assert.notEqual(makeParticles(() => 0)[0].speed, makeParticles(() => 1)[0].speed);
});

test('Claude and Codex direct connections share one collector while preserving their own destinations', () => {
  const graph = build({
    providers: [channel('claude', ['claude-model'], true), channel('codex', ['gpt-model'], true)],
    topology: {
      collectors: [{ id: 'mac-sync', label: 'Mac 用量采集' }],
      directConnections: [
        { app: 'claude-code', device: 'mac', providerId: 'claude', collectorId: 'mac-sync' },
        { app: 'codex', device: 'mac', providerId: 'codex-local', collectorId: 'mac-sync' },
      ],
    },
  });
  assert.equal(graph.nodes.filter(n => n.type === 'collector').length, 1);
  for (const [app, provider] of [['claude-code', 'claude'], ['codex', 'codex']]) {
    const source = graph.nodes.find(n => n.app === app);
    const scene = graph.routes.find(r => r.nodes[0] === source.id);
    assert.equal(scene.branches[0].nodes[1], `provider:${provider}`);
    assert.equal(scene.branches[1].nodes[0], source.id);
    assert.equal(scene.branches[1].nodes[1], 'collector:mac-sync');
    assert.equal(scene.branches[1].nodes.at(-1), 'gateway');
  }
});

test('multi-provider fallback chains render as dashed arcs between model pills, never as routes', () => {
  const chain = [
    { providerId: 'glm-primary', provider: '智谱 1', model: 'glm-5.3-flash' },
    { providerId: 'glm-backup', provider: '智谱 2', model: 'glm-5.3-flash' },
    { providerId: 'deepseek', provider: 'DeepSeek', model: 'deepseek-flash' },
  ];
  const graph = build({
    keys: [{ app: 'pi-agent' }],
    providers: [
      { id: 'glm-primary', name: '智谱 1', models: [{ id: 'glm-5.3-flash', chain }] },
      { id: 'glm-backup', name: '智谱 2', models: [{ id: 'glm-5.3-flash', chain }] },
      { id: 'deepseek', name: 'DeepSeek', models: ['deepseek-flash'] },
    ],
  });
  const pill = (p, m) => JSON.stringify(['model', p, m]);
  const first = edgeOf(graph, pill('glm-primary', 'glm-5.3-flash'), pill('glm-backup', 'glm-5.3-flash'), 'fallback');
  const rewrite = edgeOf(graph, pill('glm-backup', 'glm-5.3-flash'), pill('deepseek', 'deepseek-flash'), 'fallback');
  assert.ok(first, 'primary → backup arc exists');
  assert.ok(rewrite, 'cross-model rewrite arc lands on the mapped pill');
  assert.equal(first.group, 'glm-5.3-flash');
  assert.match(rewrite.label, /改写为 deepseek-flash/);
  // Both endpoints know their fallback group so selection can light the chain.
  const node = graph.nodes.find((n) => n.id === pill('deepseek', 'deepseek-flash'));
  assert.deepEqual(node.fallbackOf, ['glm-5.3-flash']);
  // Fallback arcs are config illustration only — no simulated traffic rides them.
  assert.ok(graph.routes.every((r) => r.edges.every((id) => !id.includes('"fallback"'))));
});

test('routable monitor seat (dashscope embeddings) connects through the gateway; plain monitor does not', () => {
  const graph = build({
    keys: [{ app: 'kb-service' }],
    providers: [
      channel('glm'),
      { id: 'dashscope', name: '阿里云百炼', monitor: true, routable: true, models: ['text-embedding-v4'] },
      channel('claude', ['claude-opus-5-5'], true),
    ],
    topology: { appGroups: [{ id: 'knowledge', label: '知识', icon: 'knowledge', apps: ['kb-service'] }] },
  });
  assert.ok(edgeOf(graph, 'gateway', 'provider:dashscope'), 'embeddings seat gets a gateway edge');
  assert.ok(graph.routes.some(r => r.nodes.at(-1) === JSON.stringify(['model', 'dashscope', 'text-embedding-v4'])));
  assert.equal(edgeOf(graph, 'gateway', 'provider:claude'), undefined, 'claude monitor seat stays direct-only');
  assert.ok(graph.routes.every(r => !r.nodes.includes('provider:claude')));
});

test('default card copy stays Chinese', () => {
  const html = render({
    agents: [{ app: 'claude-code', iconKind: 'claudecode', location: 'local' }],
    keys: [{ app: 'claude-code' }],
    providers: [channel('glm')],
  });
  assert.ok(html.includes('链路拓扑'));
  assert.ok(html.includes('多源并发'));
  assert.ok(html.includes('模拟演示'));
});

test('helpers.labels overrides copy per key while untouched keys keep their defaults', () => {
  const html = render({
    agents: [{ app: 'claude-code', iconKind: 'claudecode', location: 'local' }],
    keys: [{ app: 'claude-code' }],
    providers: [channel('glm')],
  }, { labels: { title: 'Routing', modes: { multi: ['Concurrent', 'tip'] }, device: { mac: 'Laptop' } } });
  assert.ok(html.includes('Routing'));
  assert.ok(html.includes('Concurrent'));
  assert.ok(html.includes('Laptop'));
  assert.ok(!html.includes('链路拓扑'), 'overridden title replaces the default');
  assert.ok(html.includes('单源串行'), 'the untouched serial mode keeps its default copy');
});

test('chain members get per-chain coloring: pill, dots, arc marker and legend chips', () => {
  const html = render({
    keys: [{ app: 'kb-service' }],
    providers: [
      { id: 'glm-primary', name: '智谱 1', models: [{ id: 'glm-5.3', chain: [{ providerId: 'glm-primary', model: 'glm-5.3' }, { providerId: 'glm-backup', model: 'glm-5.3' }, { providerId: 'deepseek', model: 'deepseek-flash' }] }, { id: 'glm-5.3-flash', chain: [{ providerId: 'glm-primary', model: 'glm-5.3-flash' }, { providerId: 'glm-backup', model: 'glm-5.3-flash' }, { providerId: 'deepseek', model: 'deepseek-flash' }] }] },
      { id: 'glm-backup', name: '智谱 2', models: [{ id: 'glm-5.3', chain: [] }, { id: 'glm-5.3-flash', chain: [] }] },
      { id: 'deepseek', name: 'DeepSeek', models: ['deepseek-flash'] },
    ],
    topology: { appGroups: [{ id: 'knowledge', label: '知识', icon: 'knowledge', apps: ['kb-service'] }] },
  }, { model: m => m });
  // 两条链 → 两个图例芯片 + 两个专属色箭头 marker
  assert.equal((html.match(/class="tp-chain-chip"/g) ?? []).length, 2);
  assert.ok(html.includes('id="tp-fb-arrow-0"') && html.includes('id="tp-fb-arrow-1"'));
  // 两条链在 deepseek-flash 胶囊汇聚 → 双圆点；其余单链胶囊一个圆点
  const twoDots = html.match(/tp-chain-dots[^>]*><circle[^>]*><circle/);
  assert.ok(twoDots, 'a multi-chain pill carries two dots');
  // 弧线带链色变量
  assert.ok((html.match(/tp-fallback" style="--tp-chain:#/g) ?? []).length >= 3);
  // hover 说明标注链成员身份
  assert.ok(html.includes('fallback 链 '));
});

test('mount restores the scroll position saved by stop() across rerender (cleanup self-zeroing)', () => {
  // M1（PR #15 评审发现，移植）：render() 顺序 = stop()（旧 DOM 还在树上，此时
  // 保存滚动位置才有效）→ innerHTML 替换 → mount 首行旧 cleanup 二次执行 ——
  // 不自清零时旧闭包在脱离文档节点上重读 scrollLeft（恒 0）覆盖已保存值，
  // 移动端选节点/自动刷新后横滚跳回最左。detached 元素 scrollLeft 读数恒 0
  // 是浏览器语义，stub 忠实建模。突变验证：还原旧裸 cleanup() 形态 → 本测试红。
  const makeEl = () => ({
    _scrollLeft: 0, attached: true, dataset: {},
    get scrollLeft() { return this.attached ? this._scrollLeft : 0; },
    set scrollLeft(v) { this._scrollLeft = v; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  });
  const generation = () => {
    const card = makeEl(), scroll = makeEl(), svg = makeEl();
    card.querySelector = sel => ({ '.tp-scroll': scroll, '.tp-svg': svg }[sel] ?? null);
    const document = {
      querySelector: sel => (sel === '.tp-card' && card.attached ? card : null),
      querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
    };
    return { document, scroll, detach: () => { card.attached = scroll.attached = svg.attached = false; } };
  };
  const context = {
    document: null, // 每个 DOM 世代注入后由 mount 现场读取
    IntersectionObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout: () => 1, clearTimeout: () => {},
  };
  runInNewContext(code, context);
  const api = context.MGTopology;
  const data = {
    keys: [{ app: 'kb-service' }],
    providers: [channel('glm')],
    topology: { appGroups: [{ id: 'knowledge', label: '知识', icon: 'knowledge', apps: ['kb-service'] }] },
  };
  // 世代 1：首次 mount；rAF stub 不推进动画循环
  const gen1 = generation();
  context.document = gen1.document;
  api.mount(data, () => {});
  gen1.scroll.scrollLeft = 400; // 移动端用户横滚
  api.stop();
  gen1.detach();
  const gen2 = generation();
  context.document = gen2.document;
  api.mount(data, () => {});
  assert.equal(gen2.scroll.scrollLeft, 400, 'mount restores the scroll position saved by stop()');
  // 连续两次 rerender（选节点后再取消）位置同样保持
  gen2.scroll.scrollLeft = 400;
  api.stop();
  gen2.detach();
  const gen3 = generation();
  context.document = gen3.document;
  api.mount(data, () => {});
  assert.equal(gen3.scroll.scrollLeft, 400, 'second rerender keeps the scroll position too');
});
