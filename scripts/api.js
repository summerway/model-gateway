#!/usr/bin/env node
// api.js — Admin API 的 curl 薄封装（MG15）：`model-gateway api <METHOD> <path> [--data @file|-|<json>]`。
// path 不以 /admin/ 或 /internal/ 开头时补 /admin/v1 前缀。连接信息只从 env 读：
// MODEL_GATEWAY_URL（缺省 http://127.0.0.1:8080）、MODEL_GATEWAY_ADMIN_KEY。
// stdout 原样输出响应体；非 2xx 或网络失败退出码 1。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const USAGE = '用法：model-gateway api <GET|POST|…> <path> [--data @file|-|<json>]';

/** 解析参数为请求描述；参数非法时抛错（message 即提示）。 */
export function buildRequest(argv, { env = process.env, readFile = (f) => readFileSync(f, 'utf8'), stdin = () => readFileSync(0, 'utf8') } = {}) {
  const [rawMethod, rawPath, ...rest] = argv;
  const method = rawMethod?.toUpperCase();
  if (!METHODS.includes(method) || !rawPath) throw new Error(USAGE);
  const path = rawPath.startsWith('/admin/') || rawPath.startsWith('/internal/') || rawPath === '/health'
    ? rawPath : `/admin/v1${rawPath.startsWith('/') ? '' : '/'}${rawPath}`;
  let body;
  const at = rest.indexOf('--data');
  if (at !== -1) {
    const value = rest[at + 1];
    if (value === undefined) throw new Error('--data 需要一个参数：@file、- 或 JSON 字符串');
    body = value === '-' ? stdin() : value.startsWith('@') ? readFile(value.slice(1)) : value;
    try { JSON.parse(body); } catch { throw new Error('--data 不是合法 JSON'); }
  }
  const base = env.MODEL_GATEWAY_URL || 'http://127.0.0.1:8080';
  const headers = { accept: 'application/json' };
  if (env.MODEL_GATEWAY_ADMIN_KEY) headers.authorization = `Bearer ${env.MODEL_GATEWAY_ADMIN_KEY}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return { url: new URL(path, base).href, method, headers, body };
}

/** 发请求并输出响应体；返回退出码。 */
export async function runApi(argv, { env = process.env, fetchFn = fetch, out = process.stdout, err = process.stderr, ...io } = {}) {
  let request;
  try { request = buildRequest(argv, { env, ...io }); }
  catch (error) { err.write(`${error.message}\n`); return 2; }
  try {
    const res = await fetchFn(request.url, { method: request.method, headers: request.headers, body: request.body });
    const text = await res.text();
    out.write(text.endsWith('\n') ? text : `${text}\n`);
    return res.ok ? 0 : 1;
  } catch (error) {
    err.write(`请求失败：${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runApi(process.argv.slice(2));
}
