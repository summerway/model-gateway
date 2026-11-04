import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import http from 'node:http';
import { createRequestHandler } from '../src/gateway/router.js';

const code = readFileSync(new URL('../src/dashboard/i18n.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/dashboard/console.html', import.meta.url), 'utf8');
const main = html.split('<script>').at(-1).split('</script>')[0];
function load(extra = {}) {
  const context = { URLSearchParams, navigator: { language: 'zh-CN' }, ...extra };
  runInNewContext(code, context);
  return context.MGI18n;
}

const literal = /\bt\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g;
const stripComments = (source) => source
  .replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g, '')
  .replace(/(?<!:)\/\/[^\n]*/g, '');

test('every console translation has English copy and every dictionary entry is used', () => {
  const used = new Set([...stripComments(html).matchAll(literal)].map((m) => runInNewContext(m[1])));
  const { EN } = load();
  for (const key of used) {
    assert.ok(Object.hasOwn(EN, key), `Missing translation: ${key}`);
    assert.ok(EN[key].length, `Empty translation: ${key}`);
    const placeholders = (s) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
    assert.deepEqual(placeholders(EN[key]), placeholders(key), `Variables: ${key}`);
  }
  assert.deepEqual(Object.keys(EN).filter((key) => !used.has(key)), []);
});

test('console has no Chinese copy outside t(), except preserved Chinese number suffixes', () => {
  let source = stripComments(html).replace(/console\.\w+\([^;\n]*\);?/g, '');
  source = source.replace(literal, 't(');
  // Planner decision: these exact suffixes preserve three distinct legacy formats.
  const allowed = ["' 万'", "' 亿'"];
  for (const token of allowed) source = source.replaceAll(token, '');
  assert.doesNotMatch(source, /[\u3400-\u9fff]/u);
});

test('language priority is query, stored preference, then browser language', () => {
  const localStorage = { getItem: () => 'zh' };
  assert.equal(load({ location: { search: '?lang=en' }, localStorage }).lang, 'en');
  assert.equal(load({ location: { search: '?lang=zh' }, localStorage: { getItem: () => 'en' } }).lang, 'zh');
  assert.equal(load({ localStorage, navigator: { language: 'en-US' } }).lang, 'zh');
  assert.equal(load({ navigator: { language: 'zh-TW' } }).lang, 'zh');
  assert.equal(load({ navigator: { language: 'fr-FR' } }).lang, 'en');
  assert.equal(load({ location: { search: '?lang=fr' }, localStorage: { getItem: () => 'bad' }, navigator: { language: 'en' } }).lang, 'en');
  assert.equal(load({ localStorage: { getItem() { throw Error('blocked'); } } }).lang, 'zh');
});

test('switching persists preferences, updates html lang and notifies subscribers', () => {
  const calls = [], saved = [], document = { documentElement: {} };
  const api = load({ document, localStorage: { getItem: () => null, setItem: (...args) => saved.push(args) } });
  assert.equal(document.documentElement.lang, 'zh');
  const off = api.onLang((lang) => calls.push(lang));
  api.setLang('en');
  assert.equal(api.lang, 'en');
  assert.equal(document.documentElement.lang, 'en');
  assert.deepEqual(saved, [['mg-lang', 'en']]);
  assert.deepEqual(calls, ['en']);
  api.setLang('en'); api.setLang('xx');
  assert.deepEqual(calls, ['en']);
  off(); api.setLang('zh');
  assert.deepEqual(calls, ['en']);
  const blocked = load({ localStorage: { getItem() { throw Error(); }, setItem() { throw Error(); } } });
  assert.doesNotThrow(() => blocked.setLang('en'));
  assert.equal(blocked.lang, 'en');
});

test('translation interpolates variables without changing brands or unknown copy', () => {
  const api = load();
  assert.equal(api.t('{n} 分钟前', { n: 3 }), '3 分钟前');
  api.setLang('en');
  assert.equal(api.t('概览'), 'Overview');
  assert.equal(api.t('{n} 分钟前', { n: 3 }), '3 min ago');
  assert.equal(api.t('Claude / Codex / GLM'), 'Claude / Codex / GLM');
  assert.equal(api.t('{n} 分钟前'), '{n} min ago');
});

test('compact numbers and dates use the selected locale', () => {
  const api = load();
  const d = new Date(2026, 10, 4, 14, 5);
  assert.equal(api.fmtDate(d), '11月4日');
  assert.equal(api.fmtDate(d, 'datetime'), '11月4日 14:05');
  assert.equal(api.fmtDate(d, 'month'), '11月');
  api.setLang('en');
  assert.equal(api.fmtCompact(12345), '12.3K');
  assert.equal(api.fmtCompact(123456789), '123.5M');
  assert.equal(api.fmtDate(d), 'Nov 4');
  assert.equal(api.fmtDate(d, 'datetime'), 'Nov 4, 14:05');
  assert.equal(api.fmtDate(d, 'month'), 'Nov');
});

function definitions(api = load()) {
  const context = { MGI18n: api, location: { hash: '#usage-channels' }, matchMedia: () => ({ matches: false }),
    document: { querySelector: () => null, addEventListener() {} },
  };
  const defs = main.slice(0, main.indexOf("document.addEventListener('change'"));
  runInNewContext(defs, context);
  return { api, evaluate: (code) => runInNewContext(code, context) };
}

test('all three number functions preserve their original Chinese outputs', () => {
  const { api, evaluate } = definitions();
  // fmtSrc is local to drawUSource; evaluate its actual source declaration.
  const src = main.match(/const fmtSrc =[^\n]+/)[0];
  evaluate(src);
  for (const [name, expected] of [
    ['fmtTok', ['1.2 万', '1.23 亿']],
    ['uWan', ['1.2 万', '12345.7 万']],
    ['fmtSrc', ['1.23 万', '1.23 亿']],
  ]) {
    assert.deepEqual(Array.from(evaluate(`[${name}(12345), ${name}(123456789)]`)), expected);
  }
  api.setLang('en');
  for (const name of ['fmtTok', 'uWan', 'fmtSrc']) {
    assert.deepEqual(Array.from(evaluate(`[${name}(12345), ${name}(123456789)]`)), ['12.3K', '123.5M']);
  }
});

test('populated channel usage renders English labels and preserves observed-only unavailable metrics', () => {
  const { api, evaluate } = definitions();
  api.setLang('en');
  evaluate(`for (const update of labelUpdates) update();
    S = { providers: [], features: {} };
    U.data = { totals: { tokens: 12345, input: 10000, output: 2345, cacheRead: 0, cacheWrite: 0,
      requests: 0, ok: 0, cost: 0, costKnown: 0, subscriptionRecords: 1 },
      clients: [], buckets: [], filters: { providers: [], clients: [], models: [] } };
    state.kind = 'observed';`);
  const result = evaluate('viewChannels()');
  assert.match(result, /Usage trends/);
  assert.match(result, /Source usage/);
  assert.match(result, /Direct subscription/);
  assert.match(result, /Total requests/);
  assert.match(result, /Only tokens are provided/);
  assert.doesNotMatch(result, /[\u3400-\u9fff]/u);
  assert.match(result, /class="u-mid num">—<\/span>/);
  api.setLang('zh');
  evaluate('for (const update of labelUpdates) update();');
  assert.match(evaluate('viewChannels()'), /使用趋势/);
});

test('the language button rerenders the active view, labels and topology without navigation', () => {
  const nodes = new Map(), calls = [];
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      textContent: '', innerHTML: '', style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {} }, attributes: {}, handlers: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(type, handler) { this.handlers[type] = handler; },
    });
    return nodes.get(selector);
  };
  const document = { documentElement: { dataset: {} },
    querySelector: (selector) => selector === '.modal-bg' ? null : node(selector),
    querySelectorAll: () => [], addEventListener() {},
  };
  const context = { URLSearchParams, navigator: { language: 'zh' }, document,
    location: { hash: '#overview', search: '' },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    addEventListener() {}, requestAnimationFrame() {},
    MGTopology: {
      stop: () => calls.push('stop'),
      html: (_data, helpers) => { calls.push(helpers.labels?.title ?? 'zh'); return '<div class="tp-card"></div>'; },
      mount: () => calls.push('mount'),
    },
  };
  runInNewContext(code, context);
  runInNewContext(main.slice(0, main.indexOf('(async () => {')), context);
  runInNewContext(`S = { generatedAt: new Date().toISOString(), providers: [], events: [],
    today: { totals: { requests: 0, ok: 0, cost: 0 } }, dayClient: [] };
    state.srcPeriod = 7; pending = 2; render();`, context);
  assert.match(node('#nav1').innerHTML, /概览/);
  calls.length = 0;
  node('#language').handlers.click();
  assert.equal(context.MGI18n.lang, 'en');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(document.title, 'Model Gateway Console');
  assert.match(node('#nav1').innerHTML, /Overview/);
  assert.match(node('#nav1').innerHTML, /2 pending/);
  assert.match(node('#main').innerHTML, /Gateway today/);
  assert.deepEqual(calls, ['stop', 'Routing', 'mount']);
  assert.equal(node('#theme').title, 'Theme: system (click to change)');
  assert.equal(node('#auto-btn').textContent, 'Auto 60s');
  assert.equal(runInNewContext('state.srcPeriod', context), 7);
  assert.equal(context.location.hash, '#overview');
  calls.length = 0;
  node('#language').handlers.click();
  assert.match(node('#nav1').innerHTML, /概览/);
  assert.deepEqual(calls, ['stop', 'zh', 'mount']);
  assert.equal(node('#theme').title, '主题：跟随系统（点击切换）');
});

test('i18n is served from the dashboard asset allowlist with JavaScript headers', async (t) => {
  const server = http.createServer(createRequestHandler({ config: { gateway: { keys: [] } }, catalog: { providers: [] } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/dashboard/assets/i18n.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/javascript/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await response.text(), code);
});
