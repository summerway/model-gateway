// Shared authentication for management routes, collectors and dashboard sessions.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleepDefault } from 'node:timers/promises';
import { resolveRef } from './config.js';
import { isInternalRequest, readBody, sendJson } from './http.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const SESSION_SECONDS = 2592000;
const digest = (value) => createHash('sha256').update(value).digest();
const equal = (expected, actual) => Boolean(expected && actual) && timingSafeEqual(digest(expected), digest(actual));
const pagePaths = new Set(['/', '/console', '/dashboard', '/usage', '/keys', '/inbox']);
const observedPaths = new Set(['/internal/usage/observed', '/internal/usage/codex']);
const safeNext = (value) => value?.startsWith('/') && !value.startsWith('//') && !/[\\\r\n]/.test(value) ? value : '/';
// 反代后面的真实来源：只有当直连方本身在内网（即可信反代）时才采信它写入的 X-Real-IP
const fromPrivateNetwork = (req) => {
  if (!isInternalRequest({ socket: req.socket, headers: {} })) return false;
  const real = req.headers['x-real-ip'];
  return typeof real !== 'string' || isInternalRequest({ socket: { remoteAddress: real.trim() }, headers: {} });
};
const escapeHtml = (value) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createAuth(config, { events, now = Date.now, sleep = sleepDefault } = {}) {
  const mode = config.gateway?.adminKeyRef ? 'token' : 'legacy';
  const accessKey = () => resolveRef(config.dashboard?.accessKeyRef);
  const sign = (key, exp) => createHmac('sha256', key).update(String(exp)).digest('hex');
  const hasSession = (req) => {
    const key = accessKey();
    if (!key) return false;
    const cookie = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('mg_session='));
    const match = cookie?.slice('mg_session='.length).match(/^(\d+)\.([a-f0-9]{64})$/);
    return Boolean(match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > now() && equal(sign(key, match[1]), match[2]));
  };
  const redirect = (res, status, location, headers = {}) => {
    res.writeHead(status, { location, 'cache-control': 'no-store', ...headers });
    res.end();
  };
  const form = (res, status, next, error = '') => {
    // MG24：common.css 已删除，登录页内联一小段样式（居中卡片，跟随 prefers-color-scheme）
    const style = `<style>
body{margin:0;font:14px/1.5 system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#f9f9f7;color:#171816}
main{max-width:360px;margin:12vh auto 0;padding:24px;background:#fcfcfb;border:1px solid rgba(11,11,11,.13);border-radius:10px}
h1{font-size:18px;margin:0 0 14px}
label{display:block;font-size:12px;color:#52514e;margin-bottom:6px}
input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid rgba(11,11,11,.25);border-radius:6px;font:inherit;background:#fff;color:inherit}
button{margin-top:12px;width:100%;padding:8px 10px;border:0;border-radius:6px;background:#2467b6;color:#fff;font:inherit;cursor:pointer}
p[role=alert]{min-height:1.2em;margin:10px 0 0;font-size:12px;color:#cc3131}
@media(prefers-color-scheme:dark){body{background:#101110;color:#f3f4ef}main{background:#1b1d1b;border-color:rgba(255,255,255,.15)}label{color:#c5c7bc}input{background:#101110;border-color:rgba(255,255,255,.3)}button{background:#83b8fb;color:#0d1626}}
</style>`;
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>输入访问口令</title>${style}<body><main><h1>输入访问口令</h1><form method="post" action="/login?next=${escapeHtml(encodeURIComponent(next))}"><label>输入访问口令 <input type="password" name="key" autocomplete="current-password" required></label><button type="submit">进入</button></form><p role="alert">${error}</p></main></body></html>`;
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(html) });
    res.end(html);
  };

  return { mode,
    gateInternal(req, path) {
      if (mode === 'legacy') return isInternalRequest(req) ? { ok: true } : { ok: false, status: 403, error: 'forbidden: internal only' };
      const header = req.headers.authorization;
      const actual = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
      if (equal(resolveRef(config.gateway.adminKeyRef), actual)) return { ok: true };
      const receiver = config.observedUsage ?? config.codexUsage;
      const device = receiver?.devices?.find((entry) => equal(resolveRef(entry.keyRef), actual));
      const collector = device || equal(resolveRef(receiver?.apiKeyRef), actual);
      if (collector && req.method === 'POST' && observedPaths.has(path)) return { ok: true, ...(device ? { device: device.name } : {}) };
      const inboxPost = req.method === 'POST' && (path === '/internal/inbox' || path.startsWith('/internal/inbox/'));
      if (hasSession(req)) {
        if (req.method === 'GET' || inboxPost) return { ok: true };
        return { ok: false, status: 403, error: 'forbidden' };
      }
      // 免登录看板：只读数据公开；Inbox 会改配置，只接受内网来源
      // 只作用于看板用的 /internal/*；Admin API 永远要 admin key
      if (config.dashboard?.public && !actual && path.startsWith('/internal/')) {
        // ?force= 会真打上游额度接口，同样只接受内网来源
        const forceProbe = path === '/internal/dashboard' && /[?&]force=/.test(req.url ?? '');
        if ((req.method === 'GET' && !forceProbe) || ((inboxPost || forceProbe) && fromPrivateNetwork(req))) return { ok: true };
      }
      return { ok: false, status: collector ? 403 : 401, error: collector ? 'forbidden' : 'unauthorized' };
    },
    gatePage(req, path) {
      if (!pagePaths.has(path)) return { ok: true };
      if (config.dashboard?.public) return { ok: true };
      if (config.dashboard?.accessKeyRef) return hasSession(req) ? { ok: true } : { redirect: `/login?next=${encodeURIComponent(req.url ?? path)}` };
      if (mode === 'legacy') return { ok: true };
      return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ? { ok: true } : { ok: false, status: 403 };
    },
    async handleAuthRoutes(req, res, path) {
      if (path === '/health' && req.method === 'GET') { sendJson(res, 200, { ok: true, version }); return true; }
      if (path === '/logout' && req.method === 'GET') {
        redirect(res, 303, '/login', { 'set-cookie': 'mg_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
        return true;
      }
      if (path !== '/login') return false;
      const next = safeNext(new URL(req.url, 'http://internal').searchParams.get('next'));
      if (req.method === 'GET') { form(res, 200, next); return true; }
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
      if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
        sendJson(res, 415, { error: 'expected application/x-www-form-urlencoded' }); return true;
      }
      const body = new URLSearchParams((await readBody(req, 8192)).toString());
      const key = accessKey();
      if (!equal(key, body.get('key'))) { await sleep(1000); form(res, 401, next, '口令不正确'); return true; }
      const exp = now() + SESSION_SECONDS * 1000;
      const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
      redirect(res, 303, next, { 'set-cookie': `mg_session=${exp}.${sign(key, exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}` });
      return true;
    },
  };
}
