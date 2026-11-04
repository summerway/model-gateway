// notify.js — SMTP notifications via the watchtower notification-URL pattern.
// URL forms (parsed at runtime, credentials never persisted):
//   smtp://user:pass@host:port/?toAddr=a@b.c&from=c@d.e
//   smtps://... (implicit TLS)
//   watchtower/shoutrrr 实际形态（2026-09-25 实测 watchtower .env）：
//   smtp://user:pass@smtp.example.com:465/?fromaddress=x@x&toaddresses=y@y
//   &usestarttls=no&encryption=ImplicitTLS&usehtml=yes
//   —— 参数名大小写不敏感，收件人逗号列表取首个；encryption=ImplicitTLS
//   （含 ssl/tls 同义）时无论 scheme 一律隐式 TLS（465 明文握手必败）。
// POST-style bridge endpoints (e.g. gotify/slack webhook via smtp bridge) are
// out of MVP scope; plain smtp/smtps only.
//
// Body building uses libbasicauth-style headers; the SMTP dialog itself is a
// minimal client over node:net/tls — enough for internal relay usage. If the
// URL cannot be parsed or the scheme is unsupported, notify() resolves with
// {ok:false, skipped:true} instead of throwing: notifications are best-effort.

import net from 'node:net';
import tls from 'node:tls';

/** Parse a watchtower-style notification URL. Returns null when unusable. */
export function parseSmtpUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(':', '').toLowerCase();
  if (scheme !== 'smtp' && scheme !== 'smtps') return null;
  // shoutrrr 参数名大小写不敏感：统一小写后查表
  const q = new Map();
  for (const [k, v] of u.searchParams) q.set(k.toLowerCase(), v);
  const encryption = (q.get('encryption') ?? '').toLowerCase();
  const implicitTls = scheme === 'smtps' || ['implicittls', 'implicit', 'ssl', 'tls'].includes(encryption);
  if (q.get('usestarttls') === 'yes' || q.get('usestarttls') === 'true') {
    return null; // STARTTLS 升级未支持：明确拒配而不是明文裸连
  }
  const port = u.port ? Number(u.port) : implicitTls ? 465 : 25;
  // 收件人：shoutrrr 用 toaddresses（可逗号列表），兼容旧 toAddr/to；寄件人 fromaddress/from
  const toRaw = q.get('toaddresses') ?? q.get('toaddress') ?? q.get('toaddr') ?? q.get('to');
  return {
    scheme,
    implicitTls,
    host: u.hostname,
    port,
    user: u.username ? decodeURIComponent(u.username) : null,
    pass: u.password ? decodeURIComponent(u.password) : null,
    to: toRaw ? toRaw.split(',')[0].trim() : null,
    from: q.get('fromaddress') ?? q.get('from'),
  };
}

class SmtpDialog {
  constructor(socket) {
    this.socket = socket;
    this.queue = [];
    this.buffer = '';
    this.waiting = null;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this._failAll());
    socket.on('close', () => this._failAll());
  }
  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const waiting = this.queue.shift();
      if (waiting) {
        const code = parseInt(line.slice(0, 3), 10);
        waiting.res({ code, line });
      }
    }
  }
  _failAll() {
    while (this.queue.length) this.queue.shift().rej(new Error('smtp socket closed'));
    if (this.waiting) {
      this.waiting.rej(new Error('smtp socket closed'));
      this.waiting = null;
    }
  }
  /** Wait for the next SMTP reply line. */
  read() {
    return new Promise((res, rej) => this.queue.push({ res, rej }));
  }

  /** Read a full (possibly multiline) SMTP reply — drain `250-` continuation lines. */
  async readReply() {
    let line = await this.read();
    while (line.length >= 4 && line[3] === '-') line = await this.read();
    return line;
  }
  write(line) {
    this.socket.write(line + '\r\n');
  }
}

/**
 * Send a plain-text email. Best-effort: returns {ok, error?}, never throws.
 * @param {{smtpUrl:string, from?:string, to?:string}} cfg
 * @param {{subject:string, text:string}} message
 */
export async function sendMail({ smtpUrl, from, to }, { subject, text }) {
  const parsed = parseSmtpUrl(smtpUrl);
  if (!parsed || !parsed.host) return { ok: false, skipped: true, error: 'unusable smtp url' };
  const sender = from ?? parsed.from ?? 'model-gateway@localhost';
  const recipient = to ?? parsed.to;
  if (!recipient) return { ok: false, skipped: true, error: 'no recipient (set notify.to or ?toAddr=)' };

  const socket = parsed.implicitTls
    ? tls.connect({ host: parsed.host, port: parsed.port, rejectUnauthorized: false })
    : net.connect({ host: parsed.host, port: parsed.port });
  socket.setTimeout(15000, () => socket.destroy(new Error('smtp timeout')));

  const dialog = new SmtpDialog(socket);
  const fail = (e) => ({ ok: false, error: e?.message ?? String(e) });

  try {
    await onceOpen(socket);
    let reply = await dialog.readReply(); // banner
    if (reply.code >= 400) return fail(new Error(`smtp banner ${reply.line}`));
    // EHLO（非 HELO）：QQ 等服务端要求 AUTH 前先 EHLO，且应答多行已排干
    dialog.write('EHLO model-gateway');
    reply = await dialog.readReply();
    if (reply.code >= 400) return fail(new Error(`EHLO ${reply.line}`));
    if (parsed.user) {
      dialog.write('AUTH LOGIN');
      await dialog.read();
      dialog.write(Buffer.from(parsed.user).toString('base64'));
      await dialog.read();
      dialog.write(Buffer.from(parsed.pass ?? '').toString('base64'));
      reply = await dialog.read();
      if (reply.code >= 400) return fail(new Error(`AUTH ${reply.line}`));
    }
    dialog.write(`MAIL FROM:<${sender}>`);
    reply = await dialog.read();
    if (reply.code >= 400) return fail(new Error(`MAIL FROM ${reply.line}`));
    dialog.write(`RCPT TO:<${recipient}>`);
    reply = await dialog.read();
    if (reply.code >= 400) return fail(new Error(`RCPT ${reply.line}`));
    dialog.write('DATA');
    reply = await dialog.read();
    if (reply.code !== 354) return fail(new Error(`DATA ${reply.line}`));
    // 非 ASCII 主题 RFC 2047 B 编码（中文主题直达不依赖客户端容错）
    const subjectEnc = /[^\x00-\x7F]/.test(subject)
      ? `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
      : subject;
    const headers = [
      `From: ${sender}`,
      `To: ${recipient}`,
      `Subject: ${subjectEnc}`,
      `Content-Type: text/plain; charset=utf-8`,
      `Date: ${new Date().toUTCString()}`,
      '',
    ].join('\r\n');
    const bodyDot = text.replace(/\r?\n\./g, '\n..');
    dialog.write(headers + '\r\n' + bodyDot + '\r\n.');
    reply = await dialog.read();
    if (reply.code >= 400) return fail(new Error(`body ${reply.line}`));
    dialog.write('QUIT');
    socket.end();
    return { ok: true };
  } catch (e) {
    socket.destroy();
    return fail(e);
  }
}

function onceOpen(socket) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === 'open') return resolve();
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
}
