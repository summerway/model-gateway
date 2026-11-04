// Zero-dependency site smoke check over the Chrome DevTools Protocol (Node >= 22
// native WebSocket). Opens the page via file:// at desktop (1440) and phone (390)
// widths in light and dark, and asserts: no horizontal scroll, required selectors
// present and non-empty, and no console/JS errors. External font hosts are exempt.
//
// Usage: node scripts/check-site.mjs [--html site/index.html] [--require "#a,.b"] [--shots <dir>]
// Chrome is located via $CHROME_PATH, falling back to the macOS default; without
// Chrome it prints "SKIP: chrome not found" and exits 0.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const htmlPath = option('--html', 'site/index.html');
const requiredSelectors = option('--require', '').split(',').map(s => s.trim()).filter(Boolean);
const shotsDir = option('--shots', '');

const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(chromePath)) {
  console.log('SKIP: chrome not found');
  process.exit(0);
}

const pageUrl = `file://${resolve(htmlPath)}`;
const wait = ms => new Promise(done => setTimeout(done, ms));
// Font CDNs are external decoration; a failed stylesheet/font request is not a page bug.
const FONT_HOSTS = /fonts\.(googleapis|gstatic)\.com/;
const failures = [];
let chrome = null;
let ws = null;
let userDataDir = null;

const freePort = () => new Promise((done, fail) => {
  const server = createServer();
  server.on('error', fail);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});

try {
  const port = await freePort();
  userDataDir = mkdtempSync(join(tmpdir(), 'mg-site-check-'));
  chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let attempt = 0; attempt < 60 && !target; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(t => t.type === 'page');
    } catch { await wait(200); }
  }
  if (!target) throw new Error('chrome debugging endpoint never came up');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((open, fail) => {
    ws.addEventListener('open', open, { once: true });
    ws.addEventListener('error', () => fail(new Error('websocket to chrome failed')), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails;
      pageErrors.push(detail.exception?.description ?? detail.text ?? 'unknown exception');
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      pageErrors.push(message.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      const entry = message.params.entry;
      pageErrors.push(`${entry.text}${entry.url ? ` ${entry.url}` : ''}`);
    }
  });
  const send = (method, params = {}) => new Promise((done, fail) => {
    const id = ++nextId;
    pending.set(id, message => (message.error
      ? fail(new Error(`${method}: ${message.error.message}`))
      : done(message.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  const expression = `(() => {
    const problems = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) {
      problems.push('horizontal scroll: scrollWidth ' + doc.scrollWidth + ' > clientWidth ' + doc.clientWidth);
    }
    for (const selector of ${JSON.stringify(requiredSelectors)}) {
      let element = null;
      try { element = document.querySelector(selector); } catch { problems.push('invalid selector: ' + selector); continue; }
      if (!element) { problems.push('missing selector: ' + selector); continue; }
      if (!(element.children.length > 0 || (element.textContent || '').trim() !== '')) {
        problems.push('selector present but empty: ' + selector);
      }
    }
    return problems;
  })()`;

  for (const width of [1440, 390]) {
    for (const theme of ['light', 'dark']) {
      const combo = `${width}/${theme}`;
      pageErrors.length = 0;
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await send('Page.navigate', { url: pageUrl });
      // Poll instead of a fixed sleep: on a cold profile the Google Fonts
      // stylesheet can block deferred scripts past a few seconds.
      let evaluated;
      for (const deadline = Date.now() + 10000; ;) {
        await wait(500);
        evaluated = await send('Runtime.evaluate', { expression, returnByValue: true });
        if (evaluated.exceptionDetails || !(evaluated.result.value ?? []).length || Date.now() > deadline) break;
      }
      if (evaluated.exceptionDetails) {
        failures.push(`${combo}: check expression threw: ${evaluated.exceptionDetails.text}`);
      } else {
        for (const problem of evaluated.result.value ?? []) failures.push(`${combo}: ${problem}`);
      }
      for (const text of [...new Set(pageErrors.map(t => t.trim()).filter(t => t && !FONT_HOSTS.test(t)))].slice(0, 5)) {
        failures.push(`${combo}: console error: ${text}`);
      }
      if (shotsDir) {
        mkdirSync(shotsDir, { recursive: true });
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        writeFileSync(join(shotsDir, `${width}-${theme}.png`), Buffer.from(shot.data, 'base64'));
      }
    }
  }
} catch (error) {
  failures.push(String(error?.message ?? error));
} finally {
  try { ws?.close(); } catch { /* already closed */ }
  try { chrome?.kill(); } catch { /* already dead */ }
  if (chrome) {
    // Chrome flushes its profile asynchronously after SIGTERM; removing the
    // user-data-dir too early fails with ENOTEMPTY. Cap the wait either way.
    await new Promise(done => {
      const timer = setTimeout(done, 2000);
      chrome.once('exit', () => { clearTimeout(timer); done(); });
    });
  }
  if (userDataDir) {
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      console.error(`WARN: could not remove temp dir ${userDataDir}`);
    }
  }
}

if (failures.length) {
  console.error(failures.map(f => `FAIL: ${f}`).join('\n'));
  process.exit(1);
}
console.log('OK');
