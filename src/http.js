// http.js — gateway / ops / monitor 三层共用的 HTTP 小工具：读体、JSON/HTML 响应、
// 鉴权 key 提取、内网判定。

import { UpstreamError } from './gateway/fallback/engine.js';

/** 分层路由未命中哨兵：ops / monitor 路由函数返回它表示「不是本层的路径」。 */
export const NOT_HANDLED = Symbol('not-handled');

/** Extract gateway key from request headers. */
export function extractKey(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const xKey = req.headers['x-api-key'];
  return typeof xKey === 'string' ? xKey : undefined;
}

export function isInternalRequest(req) {
  if (req.mgAuthorized === true) return true;
  // /internal/* — allowed from loopback/private addresses only (default).
  const remote = req.socket.remoteAddress ?? '';
  return remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '127.0.0.1' ||
    remote.startsWith('::ffff:10.') || remote.startsWith('::ffff:192.168.') ||
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(remote) || remote.startsWith('10.') ||
    remote.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(remote);
}

/** Read the full request body (JSON endpoints only; size-capped). */
export function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new UpstreamError('request body too large', { status: 413, kind: 'client_error' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res, status, obj, extraHeaders = null) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...(extraHeaders ?? {}),
  });
  res.end(body);
}

export function sendHtml(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store', // 页面内联脚本/样式迭代频繁，避免浏览器停在旧版页
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}
