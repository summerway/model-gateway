import { readFileSync } from 'node:fs';
import { readBody, sendJson } from '../http.js';
import { rangeToWindow } from '../monitor/internal-routes.js';
import { InboxError } from '../ops/model-inbox.js';
import { AdminError, sendError } from './errors.js';
import { redactConfig } from './config-changes.js';

export const ROUTES = [
  ...['status', 'providers', 'models', 'quota', 'usage', 'devices', 'events', 'inbox', 'config', 'openapi.json'].map(p => ({ method: 'GET', path: `/${p}` })),
  ...['usage/observed', 'config/changes', 'config/changes/{id}/apply', 'config/rollback', 'reload', 'inbox/{id}/{action}', 'inbox/rollback'].map(p => ({ method: 'POST', path: `/${p}` })),
];
const spec = JSON.parse(readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8'));
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

/** Reuse existing JSON handlers without duplicating aggregation or import validation. */
async function internal(handler, req, url, path) {
  let status, headers, body;
  const res = {
    writeHead(code, values) { status = code; headers = values; },
    end(value) { body = JSON.parse(String(value)); },
  };
  await handler(req, res, url, path);
  if (!status) throw new AdminError(404, 'not_found', 'Resource not found');
  if (status >= 400) throw new AdminError(status, status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'request_failed', typeof body.error === 'string' ? body.error : 'Request failed');
  return { status, headers, body };
}

export function createAdminRoutes({ auth, config, catalog, configChanges, opsRoute, monitorRoute, models, inbox }) {
  return async function adminRoute(req, res, url, path) {
    const resource = path.slice('/admin/v1'.length);
    try {
      if (resource === '/openapi.json' && req.method === 'GET') return sendJson(res, 200, spec);
      const observed = resource === '/usage/observed' && req.method === 'POST';
      if (auth.mode !== 'token' && !observed) throw new AdminError(403, 'admin_key_required', 'Admin API requires an admin key', { hint: '配置 gateway.adminKeyRef 后启用 Admin API' });
      // gateInternal remains the single credential verifier; Admin never accepts dashboard cookies.
      const gateReq = Object.create(req);
      gateReq.headers = { ...req.headers, cookie: undefined };
      const gate = auth.gateInternal(gateReq, observed ? '/internal/usage/observed' : '/admin/v1');
      if (!gate.ok) throw new AdminError(gate.status, gate.status === 401 ? 'unauthorized' : 'forbidden', gate.error);
      if (auth.mode === 'token') req.mgAuthorized = true;
      req.mgDevice = gate.device;
      const get = req.method === 'GET';
      const post = req.method === 'POST';
      const reply = value => sendJson(res, 200, value, { 'cache-control': 'no-store' });
      if (get && resource === '/status') return reply({ version, uptime: process.uptime(), mode: auth.mode, ...configChanges.metadata() });
      if (get && resource === '/config') return reply({ config: redactConfig({ ...config, providers: catalog.providers }), ...configChanges.metadata() });
      if (get && resource === '/models') return reply(models());
      const readPaths = { '/providers': '/internal/dashboard', '/quota': '/internal/quota', '/events': '/internal/events', '/inbox': '/internal/inbox' };
      if (get && readPaths[resource]) {
        const copy = new URL(url);
        // Read-only admin resources never trigger the dashboard's force-probe path.
        copy.searchParams.delete('force');
        const result = await internal(opsRoute, req, copy, readPaths[resource]);
        return reply(resource === '/providers' ? { providers: result.body.providers } : result.body);
      }
      // MG27：注册设备 ⨝ 在场（含硬件 UUID、检测路径、converge 结果，供 skills-admin 拉取做注册发现）
      if (get && resource === '/devices') {
        req.mgDeviceDetail = true;
        const result = await internal(monitorRoute, req, new URL(url), '/internal/devices');
        return reply(result.body);
      }
      if ((get && resource === '/usage') || observed) {
        const copy = new URL(url);
        const daily = get && Boolean(copy.searchParams.get('groupBy'));
        const device = get && Boolean(copy.searchParams.get('device'));
        if ((daily || device) && copy.searchParams.has('range')) {
          const { from, to } = rangeToWindow(copy.searchParams.get('range'));
          const day = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          if (!copy.searchParams.has('from')) copy.searchParams.set('from', day(from));
          if (!copy.searchParams.has('to')) copy.searchParams.set('to', day(copy.searchParams.get('range') === 'yday' ? new Date(to.getTime() - 1) : to));
        }
        // The legacy summary does not filter device; use its daily aggregation when requested.
        const target = observed ? '/internal/usage/observed' : daily || device ? '/internal/usage/daily' : '/internal/usage';
        const result = await internal(monitorRoute, req, copy, target);
        return reply(result.body);
      }
      if (post && resource === '/config/changes') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new AdminError(415, 'unsupported_media_type', 'Expected application/json');
        let body;
        try { body = JSON.parse(await readBody(req, 512 * 1024)); }
        catch { throw new AdminError(400, 'patch_invalid', 'Invalid JSON body'); }
        return reply(configChanges.preview(body));
      }
      const apply = resource.match(/^\/config\/changes\/([^/]+)\/apply$/);
      if (post && apply) return reply(await configChanges.apply(apply[1]));
      if (post && resource === '/config/rollback') return reply(await configChanges.rollback());
      if (post && resource === '/reload') return reply(await configChanges.reload());
      const action = resource.match(/^\/inbox\/([^/]+)\/(add|replace|remove|dismiss)$/);
      if (post && (action || resource === '/inbox/rollback')) {
        if (!inbox || inbox.loadError) throw new AdminError(503, 'inbox_error', 'Inbox is unavailable');
        if (!action) return reply(await inbox.rollback());
        const preview = await inbox.preview(action[1], action[2]);
        return reply(await inbox.apply(preview.token));
      }
      throw new AdminError(404, 'not_found', 'Admin route not found');
    } catch (error) {
      if (error instanceof InboxError) error = new AdminError(error.status, 'inbox_error', error.message);
      return sendError(res, error instanceof AdminError ? error : new AdminError(500, 'internal_error', 'Admin operation failed'));
    }
  };
}
