// store.js — 用量记录（node:sqlite）+ 查询聚合。monitor 层唯一的用量存储。
//
// 两张表（同一个 .db 文件，零 npm 依赖）：
//   usage_records — 逐条明细，保留 retentionDays（默认 90 天），超过 maxRecords 时淘汰最旧行；
//   usage_daily   — 日聚合（本地日期 × kind × client × provider × model × upstreamModel × device），
//                   长期保留，不随明细清理；热力图 / 长周期趋势读这张表。
// 写明细与 upsert 当日聚合在同一事务里。cost 不落盘——查询时按当前定价计算。
//
// kind：served = 经过网关的请求（有状态、延迟、成功率）；observed = 事后导入的订阅用量
// （Claude Code / Codex 本地会话，只有 token 计数，ok 恒为 null、不计请求数）。
// 去重规则（定位方案 2.1）：observed 的 Claude Code 只收 claude-* 模型——经网关跑 GLM 的
// 会话已由 served 记过一次，本地日志再导入就是重复计数。规则在 store 统一执行。
//
// 记录形态（record() 入参与 query() 明细出参一致）：
//   { ts, kind, device, path, client, providerId, model, upstreamModel, stream, status, ok,
//     latencyMs, usage:{input,output,cacheRead,cacheWrite}|null, reported, clientAbort?, ua?, eventId? }
//   client: 调用方归因（gateway.keys 的 app；共享 key 记 'shared'；归因上线前的历史行为 null → 未标记）；
//   ua: 仅 shared 行，User-Agent 最多 120 字符；clientAbort: 流终止标记前客户端主动断开（单列不计失败）。
//
// observed 按 eventId 幂等；同一 eventId 再次到达且各项计数更大（Claude Code 同一消息分多行写入、
// 后写的行 output 更完整）→ 原行各字段取最大值，日聚合按差值补齐。
//
// 迁移：首次打开且库为空时，若旧 usage.jsonl 存在则一次性导入，完成后改名为 .migrated（不删除）。

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { isCodexClient } from './codex-local.js';
import { sourceByPath } from './sources/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CAP_CHECK_EVERY = 500; // 每 N 次写入检查一次 maxRecords 上限

/** client 筛选哨兵：匹配「无 client 字段」的历史行（/usage 页「未标记」选项）。 */
export const UNMARKED_CLIENT = '__unmarked__';

/** 来源归一（与应用密钥页实体对齐）：订阅直连导入的来源并入同名 Agent——
 * claude-sub-sync → claude-code、codex-local-* → codex。只在写入归一，
 * 读侧（筛选/聚合/展示）全部自然对齐；渠道维度（providerId）不受影响。 */
export function normalizeClient(c) {
  if (c === 'claude-sub-sync') return 'claude-code';
  if (typeof c === 'string' && c.startsWith('codex-local')) return 'codex';
  return c;
}

/** 旧 JSONL / 旧调用方的 observed 判定：kind 'subscription'、claude 会话同步行。 */
function kindOf(entry) {
  if (entry.kind === 'observed' || entry.kind === 'subscription') return 'observed';
  if (entry.kind === 'served') return 'served';
  return entry.client === 'claude-sub-sync' || entry.path === 'claude-code' ? 'observed' : 'served';
}

/** observed 采集来源的默认设备：Claude Code 会话同步来自 NAS 挂载，Codex 本地来自 Mac 推送。 */
function defaultDevice(kind, entry) {
  if (kind === 'served') return 'gateway';
  if (entry.path === 'codex-local' || isCodexClient(entry.client)) return 'mac';
  return 'nas';
}

/** 去重规则由来源声明；未知历史 path 保持放行。 */
export function observedAllowed(rec) {
  if (rec.kind !== 'observed') return true;
  const source = sourceByPath(rec.path);
  return source ? source.allowModel(rec.model) : true;
}

const n = (v) => (Number.isFinite(v) ? v : 0);

/** 本地日期 YYYY-MM-DD（与 bucketStart 的本地时区口径一致）。 */
export function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_records (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL, ts_ms INTEGER NOT NULL,
  kind TEXT NOT NULL, device TEXT NOT NULL,
  path TEXT, client TEXT, provider_id TEXT, model TEXT, upstream_model TEXT,
  stream INTEGER NOT NULL DEFAULT 0, status INTEGER, ok INTEGER, latency_ms INTEGER,
  has_usage INTEGER NOT NULL DEFAULT 0, reported INTEGER NOT NULL DEFAULT 0,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  client_abort INTEGER NOT NULL DEFAULT 0, ua TEXT, event_id TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS usage_records_ts ON usage_records (ts_ms);
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL, kind TEXT NOT NULL, client TEXT NOT NULL, provider_id TEXT NOT NULL,
  model TEXT NOT NULL, upstream_model TEXT NOT NULL, device TEXT NOT NULL,
  records INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, client, provider_id, model, upstream_model, device)
);
`;

const COLS = 'ts, kind, device, path, client, provider_id, model, upstream_model, stream, status, ok, latency_ms, has_usage, reported, input, output, cache_read, cache_write, client_abort, ua, event_id';

export class UsageLog {
  /**
   * @param {object} [opts]
   * @param {string|null} [opts.file] 旧 JSONL 路径（只用于定位库文件与一次性迁移）；库默认同目录同名 .db
   * @param {string|null} [opts.dbFile] 显式库路径（缺省由 file 推导；两者都无 → 内存库）
   */
  constructor({
    file = process.env.USAGE_LOG_FILE ?? null,
    dbFile = process.env.USAGE_DB_FILE ?? null,
    maxRecords = 500_000,
    retentionDays = 90,
    now = Date.now,
  } = {}) {
    this.max = maxRecords;
    this.retentionMs = retentionDays * DAY_MS;
    this.now = now;
    this.file = file || null;
    this.dbFile = dbFile || (this.file ? this.file.replace(/\.jsonl$/, '') + '.db' : null);
    this.revision = 0;
    this._writes = 0;
    if (this.dbFile) mkdirSync(dirname(this.dbFile), { recursive: true });
    this.db = new DatabaseSync(this.dbFile ?? ':memory:');
    if (this.dbFile) this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.stmt = {
      insert: this.db.prepare(`INSERT OR IGNORE INTO usage_records (ts_ms, ${COLS}) VALUES (?, ${COLS.split(',').map(() => '?').join(', ')})`),
      daily: this.db.prepare(`INSERT INTO usage_daily (day, kind, client, provider_id, model, upstream_model, device, records, requests, input, output, cache_read, cache_write)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (day, kind, client, provider_id, model, upstream_model, device) DO UPDATE SET
          records = records + excluded.records, requests = requests + excluded.requests,
          input = input + excluded.input, output = output + excluded.output,
          cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write`),
      count: this.db.prepare('SELECT COUNT(*) AS c FROM usage_records'),
      byEvent: this.db.prepare('SELECT ts_ms, kind, device, client, provider_id, model, upstream_model, has_usage, reported, input, output, cache_read, cache_write FROM usage_records WHERE event_id = ?'),
      grow: this.db.prepare('UPDATE usage_records SET has_usage = 1, reported = 1, input = ?, output = ?, cache_read = ?, cache_write = ? WHERE event_id = ?'),
    };
    if (this.file) this.#migrateJsonl();
    this.cleanup();
  }

  /** 记录一条用量。entry 至少含 model；usage 为 null 表示未上报。
   *  返回新入库的记录；observed 不符合去重规则或 eventId 已存在（可能按更大计数补齐）→ null。 */
  record(entry) {
    const rec = this.#normalize(entry);
    if (!observedAllowed(rec)) return null;
    let inserted = false;
    this.#tx(() => { inserted = this.#insert(rec); });
    this.revision++;
    if (++this._writes >= CAP_CHECK_EVERY) { this._writes = 0; this.#enforceCap(); }
    return inserted ? rec : null;
  }

  /** 批量导入 observed 记录（按 eventId 幂等）。返回新入库条数。 */
  importObserved(entries) {
    const cutoff = this.now() - this.retentionMs;
    let added = 0;
    this.#tx(() => {
      for (const entry of entries) {
        const rec = this.#normalize({ ...entry, kind: 'observed' });
        if (Date.parse(rec.ts) < cutoff || !observedAllowed(rec)) continue;
        if (this.#insert(rec)) added++;
      }
    });
    if (added) { this.revision++; this.#enforceCap(); }
    return added;
  }

  /** 兼容旧名（/internal/usage/codex 接收端）。 */
  importSubscription(entries) { return this.importObserved(entries); }

  #normalize(entry) {
    const kind = kindOf(entry);
    const rec = {
      ts: entry.ts ?? new Date(this.now()).toISOString(),
      kind,
      device: typeof entry.device === 'string' && entry.device ? entry.device : defaultDevice(kind, entry),
      path: entry.path ?? null,
      client: normalizeClient(entry.client) ?? null,
      providerId: entry.providerId ?? null,
      model: entry.model,
      upstreamModel: entry.upstreamModel ?? entry.model,
      stream: entry.stream === true,
      status: kind === 'observed' ? null : entry.status ?? null,
      ok: kind === 'observed' ? null : entry.ok !== false,
      latencyMs: Number.isFinite(entry.latencyMs) ? Math.round(entry.latencyMs) : null,
      usage: entry.usage ?? null,
      reported: entry.reported === true,
    };
    if (entry.clientAbort === true) rec.clientAbort = true;
    if (rec.client === 'shared' && typeof entry.ua === 'string' && entry.ua) rec.ua = entry.ua.slice(0, 120);
    if (typeof entry.eventId === 'string' && entry.eventId) rec.eventId = entry.eventId;
    return rec;
  }

  /** 写一行明细并累加当日聚合；eventId 冲突（重复导入）→ 不写聚合，返回 false。 */
  #insert(rec) {
    const tsMs = Date.parse(rec.ts);
    if (!Number.isFinite(tsMs)) return false;
    const u = rec.usage && rec.reported ? rec.usage : null;
    const r = this.stmt.insert.run(
      tsMs, rec.ts, rec.kind, rec.device, rec.path, rec.client, rec.providerId, rec.model ?? null, rec.upstreamModel ?? null,
      rec.stream ? 1 : 0, rec.status, rec.ok == null ? null : rec.ok ? 1 : 0, rec.latencyMs,
      rec.usage ? 1 : 0, rec.reported ? 1 : 0,
      n(rec.usage?.input), n(rec.usage?.output), n(rec.usage?.cacheRead), n(rec.usage?.cacheWrite),
      rec.clientAbort ? 1 : 0, rec.ua ?? null, rec.eventId ?? null,
    );
    if (!r.changes) {
      if (rec.eventId && rec.kind === 'observed' && u) this.#growObserved(rec.eventId, u);
      return false;
    }
    this.stmt.daily.run(
      localDay(tsMs), rec.kind, rec.client ?? '', rec.providerId ?? '', rec.model ?? '', rec.upstreamModel ?? rec.model ?? '', rec.device,
      1, rec.kind === 'served' ? 1 : 0, n(u?.input), n(u?.output), n(u?.cacheRead), n(u?.cacheWrite),
    );
    return true;
  }

  /** 已有 observed 行再次到达：各计数取最大值，日聚合补差值（records/requests 不变）。 */
  #growObserved(eventId, u) {
    const old = this.stmt.byEvent.get(eventId);
    if (!old) return;
    const prev = old.has_usage && old.reported
      ? { input: Number(old.input), output: Number(old.output), cacheRead: Number(old.cache_read), cacheWrite: Number(old.cache_write) }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const next = Object.fromEntries(Object.keys(prev).map((k) => [k, Math.max(prev[k], n(u[k]))]));
    const delta = Object.fromEntries(Object.keys(prev).map((k) => [k, next[k] - prev[k]]));
    if (!Object.values(delta).some((v) => v > 0)) return;
    this.stmt.grow.run(next.input, next.output, next.cacheRead, next.cacheWrite, eventId);
    this.stmt.daily.run(
      localDay(Number(old.ts_ms)), old.kind, old.client ?? '', old.provider_id ?? '', old.model ?? '', old.upstream_model ?? old.model ?? '', old.device,
      0, 0, delta.input, delta.output, delta.cacheRead, delta.cacheWrite,
    );
    this.revision++;
  }

  #tx(fn) {
    this.db.exec('BEGIN');
    try { fn(); this.db.exec('COMMIT'); } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  /** 超出 maxRecords → 按时间淘汰最旧明细（日聚合不受影响）。 */
  #enforceCap() {
    const over = this.size - this.max;
    if (over <= 0) return;
    this.db.prepare('DELETE FROM usage_records WHERE id IN (SELECT id FROM usage_records ORDER BY ts_ms, id LIMIT ?)').run(over);
    this.revision++;
  }

  /** 旧 usage.jsonl → 库（仅库为空时，一次性）。去重规则同样生效，跳过数打日志。 */
  #migrateJsonl() {
    if (!existsSync(this.file) || this.size > 0) return;
    let text;
    try { text = readFileSync(this.file, 'utf8'); } catch (err) {
      console.error(`[usage] migrate read failed: ${err.message}`);
      return;
    }
    const cutoff = this.now() - this.retentionMs;
    let imported = 0, bad = 0, skipped = 0, expired = 0;
    this.#tx(() => {
      for (const line of text.split('\n')) {
        if (!line) continue;
        let raw;
        try { raw = JSON.parse(line); } catch { bad++; continue; }
        const rec = this.#normalize(raw);
        if (!observedAllowed(rec)) { skipped++; continue; }
        if (Date.parse(rec.ts) < cutoff) { expired++; continue; }
        if (this.#insert(rec)) imported++;
      }
    });
    this.#enforceCap();
    try { renameSync(this.file, `${this.file}.migrated`); } catch (err) {
      console.error(`[usage] migrate rename failed: ${err.message}`);
    }
    console.log(`[usage] migrated ${imported} record(s) from ${this.file} → ${this.dbFile}`
      + ` (observed non-claude skipped: ${skipped}, expired: ${expired}, corrupt: ${bad})`);
  }

  /** 按保留期清理明细（boot 时与每日定时调用）。返回删除条数。 */
  cleanup() {
    const cutoff = this.now() - this.retentionMs;
    const { changes } = this.db.prepare('DELETE FROM usage_records WHERE ts_ms < ?').run(cutoff);
    if (changes) this.revision++;
    return Number(changes);
  }

  /** 窗口内明细（按时间升序），转回记录形态。 */
  #rows(where, params) {
    return this.db.prepare(`SELECT ${COLS} FROM usage_records WHERE ${where} ORDER BY ts_ms, id`).all(...params).map(toRec);
  }

  /** client 筛选 SQL 片段（UNMARKED 哨兵 / codex-local 分组 / 精确值）。 */
  #clientClause(client, params) {
    if (!client) return '';
    if (client === UNMARKED_CLIENT) return " AND (client IS NULL OR client = '')";
    if (client === 'codex-local') return " AND client LIKE 'codex-local-%'";
    params.push(client);
    return ' AND client = ?';
  }

  /** provider 篮选 SQL 片段；支持数组（渠道归并口径，如 OpenAI = codex + codex-local）。 */
  #providerClause(provider, params) {
    if (!provider) return '';
    const ids = Array.isArray(provider) ? provider.filter(Boolean) : [provider];
    if (!ids.length) return '';
    if (ids.length === 1) { params.push(ids[0]); return ' AND provider_id = ?'; }
    params.push(...ids);
    return ` AND provider_id IN (${ids.map(() => '?').join(',')})`;
  }

  /**
   * 聚合查询。
   * @param {object} q — { provider, model, client, kind, status, from: Date, to: Date, unit: 'hour'|'day',
   *                      logLimit, priceOf: (rec) => number|null }
   *                    client 传 UNMARKED_CLIENT 哨兵 → 匹配无 client 的历史行；
   *                    kind 'served' | 'observed' → 只看一类；
   *                    status='abort' → 仅 logs 池过滤出客户端中断行（totals/buckets 口径不变）。
   * @returns { totals, buckets, logs, models } — buckets 含 from→to 全量空桶（图表连续轴）。
   */
  query(q = {}) {
    const { provider = null, model = null, client = null, kind = null, status = null } = q;
    const from = q.from instanceof Date ? q.from.getTime() : Date.parse(q.from);
    const to = q.to instanceof Date ? q.to.getTime() : Date.parse(q.to);
    const unit = q.unit === 'day' ? 'day' : 'hour';
    const logLimit = Number.isFinite(q.logLimit) ? q.logLimit : 50;
    const priceOf = typeof q.priceOf === 'function' ? q.priceOf : () => null;

    const params = [from, to];
    let where = 'ts_ms >= ? AND ts_ms < ?';
    where += this.#providerClause(provider, params);
    if (model) { where += ' AND model = ?'; params.push(model); }
    if (kind === 'served' || kind === 'observed') { where += ' AND kind = ?'; params.push(kind); }
    where += this.#clientClause(client, params);
    const recs = this.#rows(where, params);

    const totals = {
      requests: 0, ok: 0, failed: 0, clientAborts: 0, unreported: 0,
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, costKnown: 0,
    };
    const bucketMap = new Map(); // bucketStartTs → sums
    const models = new Set();
    for (const r of recs) {
      // observed 只有 token 计数：不计请求数、成功率；客户端中断单列，不计失败
      const observed = r.kind === 'observed';
      if (observed) totals.subscriptionRecords = (totals.subscriptionRecords ?? 0) + 1;
      else totals.requests++;
      if (!observed && r.ok) totals.ok++;
      else if (!observed && r.clientAbort === true) totals.clientAborts++;
      else if (!observed) totals.failed++;
      const u = r.usage;
      if (r.ok && (!u || !r.reported)) totals.unreported++; // 只描述成功请求里上游没报 usage 的部分
      if (u && r.reported) {
        totals.input += u.input;
        totals.output += u.output;
        totals.cacheRead += u.cacheRead;
        totals.cacheWrite += u.cacheWrite;
      }
      models.add(r.upstreamModel ?? r.model);
      const c = priceOf(r);
      if (typeof c === 'number') {
        totals.cost += c;
        totals.costKnown++;
      }
      const b = bucketStart(Date.parse(r.ts), unit);
      let agg = bucketMap.get(b);
      if (!agg) {
        agg = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        bucketMap.set(b, agg);
      }
      if (observed) agg.usageOnly = true;
      else agg.requests++;
      if (u && r.reported) {
        agg.input += u.input;
        agg.output += u.output;
        agg.cacheRead += u.cacheRead;
        agg.cacheWrite += u.cacheWrite;
      }
      if (typeof c === 'number') agg.cost += c;
    }
    totals.tokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
    totals.cost = round6(totals.cost);

    // 全量空桶补齐（from 到 to，含端点；查询窗口通常 1 天/7 天/30 天，桶数有界）
    const buckets = [];
    const step = unit === 'hour' ? 60 * 60 * 1000 : DAY_MS;
    for (let b = bucketStart(from, unit); b < to; b += step) {
      const agg = bucketMap.get(b) ?? { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      buckets.push({
        t: new Date(b).toISOString(),
        requests: agg.requests,
        ...(agg.usageOnly ? { usageOnly: true } : {}),
        input: agg.input,
        output: agg.output,
        cacheRead: agg.cacheRead,
        cacheWrite: agg.cacheWrite,
        cost: round6(agg.cost),
      });
    }

    // status=abort 只影响明细池（页面上「仅看中断」）：聚合口径与图表不变，徽标/汇总仍按全量算
    const logPool = status === 'abort' ? recs.filter((r) => r.clientAbort === true) : recs;
    const logs = logPool.slice(-logLimit).reverse().map((r) => ({ ...r, cost: priceOf(r) }));
    return { totals, buckets, logs, models: [...models] };
  }

  /**
   * 按调用方（client）聚合：/usage 页「来源分布」——每来源当日汇总 + 所选窗口累计(total)
   * + 全保留期累计(totalAll，筛选下拉稳定用) + 查询窗口内的请求/token 趋势桶。
   * 不受 client 筛选影响（返回全部来源）；provider/model 筛选照常生效。
   * @param {object} q — { provider, model, from: Date, to: Date, unit: 'hour'|'day' }
   * @returns { client, lastSeen, today:{requests,tokens}, total:{requests,tokens},
   *            totalAll:{requests,tokens}, buckets:[{t,requests,tokens}] }[]
   *          按 total.tokens 降序；历史空 client 行的 client 为 null。
   */
  queryClients(q = {}) {
    const { provider = null, model = null } = q;
    const from = q.from instanceof Date ? q.from.getTime() : Date.parse(q.from);
    const to = q.to instanceof Date ? q.to.getTime() : Date.parse(q.to);
    const unit = q.unit === 'day' ? 'day' : 'hour';
    const todayStart = bucketStart(this.now(), 'day');
    const cutoff = this.now() - this.retentionMs;

    const params = [];
    let filter = '';
    filter += this.#providerClause(provider, params);
    if (model) { filter += ' AND model = ?'; params.push(model); }
    const tokensExpr = 'CASE WHEN has_usage = 1 AND reported = 1 THEN input + output + cache_read + cache_write ELSE 0 END';
    const span = (since) => this.db.prepare(`SELECT client, SUM(kind = 'served') AS requests, SUM(${tokensExpr}) AS tokens,
        MAX(kind = 'observed') AS usageOnly, MAX(ts_ms) AS lastMs, ts
      FROM usage_records WHERE ts_ms >= ?${filter} GROUP BY client`).all(since, ...params);

    const byClient = new Map(); // client(null=未标记) → 汇总
    const entry = (client) => {
      const key = client || null;
      let c = byClient.get(key);
      if (!c) {
        c = { today: { requests: 0, tokens: 0 }, total: { requests: 0, tokens: 0 }, totalAll: { requests: 0, tokens: 0 }, lastSeen: null, buckets: new Map() };
        byClient.set(key, c);
      }
      return c;
    };
    for (const row of span(cutoff)) {
      const c = entry(row.client);
      c.totalAll.requests += Number(row.requests);
      c.totalAll.tokens += Number(row.tokens);
      c.lastSeen = row.ts; // SQLite：MAX() 聚合行的裸列取自同一行
      if (row.usageOnly) { c.totalAll.usageOnly = true; c.total.usageOnly = true; c.today.usageOnly = true; }
    }
    for (const row of span(todayStart)) {
      const c = entry(row.client);
      c.today.requests += Number(row.requests);
      c.today.tokens += Number(row.tokens);
    }
    const windowRows = this.db.prepare(`SELECT client, ts_ms, kind = 'served' AS request, ${tokensExpr} AS tokens
      FROM usage_records WHERE ts_ms >= ? AND ts_ms < ?${filter}`).all(from, to, ...params);
    for (const row of windowRows) {
      const c = entry(row.client);
      const request = Number(row.request), tokens = Number(row.tokens);
      c.total.requests += request;
      c.total.tokens += tokens;
      const b = bucketStart(Number(row.ts_ms), unit);
      let agg = c.buckets.get(b);
      if (!agg) { agg = { requests: 0, tokens: 0 }; c.buckets.set(b, agg); }
      agg.requests += request;
      if (!request) agg.usageOnly = true;
      agg.tokens += tokens;
    }

    // 全量空桶补齐（与 query() 同口径，图表连续轴）
    const step = unit === 'hour' ? 60 * 60 * 1000 : DAY_MS;
    const bucketTs = [];
    for (let b = bucketStart(from, unit); b < to; b += step) bucketTs.push(b);
    return [...byClient.entries()]
      .map(([client, c]) => ({
        client,
        lastSeen: c.lastSeen,
        today: c.today,
        total: c.total,
        totalAll: c.totalAll,
        buckets: bucketTs.map((b) => {
          const agg = c.buckets.get(b);
          return { t: new Date(b).toISOString(), requests: agg?.requests ?? 0, ...(c.totalAll.usageOnly ? { usageOnly: true } : {}), tokens: agg?.tokens ?? 0 };
        }),
      }))
      .sort((a, b) => b.total.tokens - a.total.tokens || b.total.requests - a.total.requests);
  }

  /**
   * 日聚合查询（长期保留，热力图 / 长周期趋势）。from/to 为本地日期 YYYY-MM-DD（含两端）。
   * @returns {{ day, kind, client, providerId, model, upstreamModel, device, records, requests,
   *            usage:{input,output,cacheRead,cacheWrite} }[]} 按 day 升序；空字符串维度还原为 null。
   */
  queryDaily({ from, to, kind = null, client = null, provider = null, model = null, device = null } = {}) {
    const params = [from, to];
    let where = 'day >= ? AND day <= ?';
    if (kind === 'served' || kind === 'observed') { where += ' AND kind = ?'; params.push(kind); }
    if (client === UNMARKED_CLIENT) where += " AND client = ''";
    else if (client === 'codex-local') where += " AND client LIKE 'codex-local-%'";
    else if (client) { where += ' AND client = ?'; params.push(client); }
    if (provider) where += this.#providerClause(provider, params);
    if (model) { where += ' AND model = ?'; params.push(model); }
    if (device) { where += ' AND device = ?'; params.push(device); }
    return this.db.prepare(`SELECT * FROM usage_daily WHERE ${where} ORDER BY day`).all(...params).map((r) => ({
      day: r.day, kind: r.kind, client: r.client || null, providerId: r.provider_id || null,
      model: r.model || null, upstreamModel: r.upstream_model || null, device: r.device,
      records: Number(r.records), requests: Number(r.requests),
      usage: { input: Number(r.input), output: Number(r.output), cacheRead: Number(r.cache_read), cacheWrite: Number(r.cache_write) },
    }));
  }

  /**
   * 采集设备状态：/internal/usage/devices 设备条 —— 每 device × kind 最近一条记录的时间
   * 与近 7 天记录数（usage_records，只读；明细保留期内可见）。
   * @returns {{ device, kind, lastSeen, records7d }[]} 按 lastSeen 降序；
   *          lastSeen 为最近一条记录的 ts（ISO 字符串）。
   */
  queryDevices() {
    return this.db.prepare(`SELECT device, kind, ts, MAX(ts_ms) AS lastMs, SUM(ts_ms >= ?) AS records7d
      FROM usage_records GROUP BY device, kind ORDER BY lastMs DESC`)
      .all(this.now() - 7 * DAY_MS)
      .map((r) => ({ device: r.device, kind: r.kind, lastSeen: r.ts, records7d: Number(r.records7d) }));
  }

  get size() {
    return Number(this.stmt.count.get().c);
  }

  /** 全部明细（时间升序）——诊断与测试用，生产查询走 query()/queryClients()。 */
  get buf() {
    return this.#rows('1 = 1', []);
  }

  close() {
    this.db.close();
  }
}

/** 库行 → 记录形态（与 record() 入参一致）。 */
function toRec(row) {
  const rec = {
    ts: row.ts,
    kind: row.kind,
    device: row.device,
    path: row.path,
    client: row.client,
    providerId: row.provider_id,
    model: row.model,
    upstreamModel: row.upstream_model,
    stream: row.stream === 1,
    status: row.status,
    ok: row.ok == null ? null : row.ok === 1,
    latencyMs: row.latency_ms,
    usage: row.has_usage ? { input: Number(row.input), output: Number(row.output), cacheRead: Number(row.cache_read), cacheWrite: Number(row.cache_write) } : null,
    reported: row.reported === 1,
  };
  if (row.client_abort) rec.clientAbort = true;
  if (row.ua) rec.ua = row.ua;
  if (row.event_id) rec.eventId = row.event_id;
  return rec;
}

/** 桶起点（本地时区）：hour → 整点；day → 当日 00:00。 */
export function bucketStart(ts, unit) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  if (unit === 'day') d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}
