import { sendJson } from '../http.js';

export class AdminError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

export function sendError(res, error) {
  return sendJson(res, error.status ?? 500, {
    error: { code: error.code ?? 'internal_error', message: error.message, details: error.details ?? {} },
  }, { 'cache-control': 'no-store' });
}
