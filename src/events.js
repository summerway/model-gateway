// events.js — event log for fallback switches, quota snapshots, activation.
// In-memory ring buffer (default 500 events). Also exposes live counters for
// /internal/quota. Optionally persisted to a JSONL file (env EVENT_LOG_FILE or
// constructor { file }) so a gateway restart keeps the history; the file is
// compacted on boot and every COMPACT_EVERY appends back to just the live
// ring, so append-only growth stays bounded.

import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const COMPACT_EVERY = 1000;

export class EventLog {
  constructor(max = 500, { file } = {}) {
    this.max = max;
    this.buf = [];
    this.file = file || process.env.EVENT_LOG_FILE || null;
    this._appends = 0;
    if (this.file) {
      try { mkdirSync(dirname(this.file), { recursive: true }); } catch { /* #flush 再试 */ }
      this.#load();
    }
  }

  /** Load the persisted tail into the ring and compact the file to match. */
  #load() {
    try {
      const events = [];
      let bad = 0;
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch { bad++; } // 半写行跳过，不拖垮整个历史
      }
      if (bad) console.error(`[events] skipped ${bad} corrupt line(s) in ${this.file}`);
      this.buf = events.slice(-this.max);
      this.#flush();
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[events] load failed: ${err.message}`);
    }
  }

  /** Rewrite the file with exactly the live ring (boot compaction + periodic). */
  #flush() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, this.buf.map((e) => JSON.stringify(e)).join('\n') + (this.buf.length ? '\n' : ''));
    } catch (err) {
      console.error(`[events] persist failed: ${err.message}`);
    }
  }

  /** Record an event. type: 'fallback' | 'activation' | 'probe_error' | ... */
  record(type, data = {}) {
    const event = {
      ts: new Date().toISOString(),
      type,
      ...data,
    };
    this.buf.push(event);
    if (this.buf.length > this.max) this.buf.splice(0, this.buf.length - this.max);
    if (this.file) {
      try {
        appendFileSync(this.file, JSON.stringify(event) + '\n');
      } catch (err) {
        console.error(`[events] append failed: ${err.message}`);
      }
      if (++this._appends >= COMPACT_EVERY) {
        this._appends = 0;
        this.#flush();
      }
    }
    return event;
  }

  /** Newest-first list, optional type filter. */
  list({ type, limit = 200 } = {}) {
    let out = this.buf;
    if (type) out = out.filter((e) => e.type === type);
    return out.slice(-limit).reverse();
  }

  get size() {
    return this.buf.length;
  }
}
