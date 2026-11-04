// serve.js — 控制台页面与打包静态资源（三层共用的展示入口）。
// 只服务打包内资源，从不解析用户路径；页面 HTML 每进程读一次缓存。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { sendHtml } from '../http.js';

const CONSOLE_HTML_PATH = fileURLToPath(new URL('./console.html', import.meta.url));
const FAVICON_PATH = fileURLToPath(new URL('./favicon.png', import.meta.url));
const DASHBOARD_ASSETS = new Map([
  ['/dashboard/assets/i18n.js', { file: fileURLToPath(new URL('./i18n.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  ['/dashboard/assets/topology.js', { file: fileURLToPath(new URL('./topology.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  ['/dashboard/assets/topology.css', { file: fileURLToPath(new URL('./topology.css', import.meta.url)), type: 'text/css; charset=utf-8' }],
]);
for (const name of ['gateway', 'collector', 'knowledge', 'automation', 'business']) {
  DASHBOARD_ASSETS.set(`/dashboard/assets/topology/${name}.png`, { file: fileURLToPath(new URL(`./topology-assets/${name}.png`, import.meta.url)), type: 'image/png' });
}
let consoleHtmlCache = null;
let faviconCache = null;
const etagCache = new Map();
/** 内容指纹 ETag（首次读取时计算并缓存）。配合 ?v= 版本号双保险：
 *  页面 HTML 是 no-store 永远新鲜，引用的 assets 带内容指纹 query，
 *  手机浏览器（iOS Safari 启发式缓存/无校验器旧条目）不可能停留在旧 JS/CSS。 */
const etagOf = file => {
  let etag = etagCache.get(file);
  if (!etag) {
    etag = '"' + createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 10) + '"';
    etagCache.set(file, etag);
  }
  return etag;
};
/** HTML 里的 /dashboard/assets/*.js|css 引用注入 ?v=<指纹>，改文件必换 URL。 */
const withAssetVersions = html => html.replace(
  /\/dashboard\/assets\/(topology)\.(js|css)(?!\?)/g,
  (m, name, ext) => `${m}?v=${etagOf(DASHBOARD_ASSETS.get(`/dashboard/assets/${name}.${ext}`).file).slice(1, -1)}`,
);

/** Read (and cache) the new console page — one file read per process lifetime. */
function getConsoleHtml() {
  if (consoleHtmlCache === null) {
    consoleHtmlCache = withAssetVersions(readFileSync(CONSOLE_HTML_PATH, 'utf8'));
  }
  return consoleHtmlCache;
}

/** Read (and cache) the favicon PNG — one file read per process lifetime. */
function getFavicon() {
  if (faviconCache === null) {
    faviconCache = readFileSync(FAVICON_PATH);
  }
  return faviconCache;
}

/** GET 页面/静态资源：命中则写响应并返回 true。 */
export function servePage(req, res, path) {
  if (req.method !== 'GET') return false;
  if (DASHBOARD_ASSETS.has(path)) {
    const { file, type } = DASHBOARD_ASSETS.get(path);
    const etag = etagOf(file);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache' });
      res.end();
      return true;
    }
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-cache', etag, 'x-content-type-options': 'nosniff' });
    res.end(body);
    return true;
  }
  // v0.5：新版控制台（console.html）成为默认页；旧版 index.html 退出路由，
  // /console 与旧别名 /dashboard 永久重定向到 /（书签/外链平滑过渡）
  if (path === '/') { sendHtml(res, getConsoleHtml()); return true; }
  if (path === '/console' || path === '/dashboard') {
    res.writeHead(301, { location: '/' });
    res.end();
    return true;
  }
  // MG24：旧独立页下线，301 到看板对应 hash 视图（查询串一律丢弃）
  const LEGACY_PAGE_REDIRECTS = { '/usage': '/#usage-summary', '/keys': '/#gateway-keys', '/inbox': '/#gateway-suggestions' };
  if (path in LEGACY_PAGE_REDIRECTS) {
    res.writeHead(301, { location: LEGACY_PAGE_REDIRECTS[path], 'cache-control': 'no-cache' });
    res.end();
    return true;
  }
  if (path === '/favicon.png') {
    const buf = getFavicon();
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length });
    res.end(buf);
    return true;
  }
  return false;
}
