// event-log.test.js — JSONL persistence: reload tail, ring cap, boot/periodic compaction.

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events.js';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'mgw-evlog-'));
  return { dir, file: join(dir, 'data', 'events.jsonl') };
}

test('no file option → memory only, nothing written', () => {
  const { dir } = tmpFile();
  const prev = process.env.EVENT_LOG_FILE;
  delete process.env.EVENT_LOG_FILE;
  try {
    const log = new EventLog(10);
    log.record('fallback', { from: 'a', to: 'b' });
    assert.equal(log.size, 1);
  } finally {
    if (prev !== undefined) process.env.EVENT_LOG_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('records survive a "restart" (new EventLog on same file)', () => {
  const { dir, file } = tmpFile();
  try {
    const a = new EventLog(500, { file });
    a.record('fallback', { from: 'glm-1', to: 'glm-2' });
    a.record('quota_restored', { providerId: 'glm-1' });

    const b = new EventLog(500, { file });
    assert.equal(b.size, 2);
    const list = b.list();
    assert.equal(list[0].type, 'quota_restored'); // newest first
    assert.equal(list[1].from, 'glm-1');

    // boot compaction rewrote the file to exactly the live ring
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ring cap applies across restarts and file stays bounded', () => {
  const { dir, file } = tmpFile();
  try {
    const a = new EventLog(5, { file });
    for (let i = 0; i < 9; i++) a.record('probe_error', { providerId: `p${i}` });
    assert.equal(a.size, 5);

    const b = new EventLog(5, { file });
    assert.equal(b.size, 5);
    assert.deepEqual(b.list().map((e) => e.providerId), ['p8', 'p7', 'p6', 'p5', 'p4']);
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('periodic compaction trims append-only growth', () => {
  const { dir, file } = tmpFile();
  try {
    const log = new EventLog(3, { file });
    const compactEvery = 1000;
    for (let i = 0; i < compactEvery + 5; i++) log.record('fallback', { to: `x${i}` });
    // 1005 appends → one compaction at 1000 → file holds ring(3) + 5 appended
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length <= 3 + 5 + 1, `file grew unbounded: ${lines.length}`);
    assert.equal(log.size, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt tail line is skipped without throwing', () => {
  const { dir, file } = tmpFile();
  try {
    const a = new EventLog(10, { file });
    a.record('fallback', { to: 'ok' });
    // 模拟半写：追加一段坏行 + 一行好数据
    appendFileSync(file, '{"ts":"2026-01-01T00:00:00Z","type":"probe_er\n');
    a.record('activation', { ok: true });

    const b = new EventLog(10, { file });
    assert.deepEqual(b.list().map((e) => e.type), ['activation', 'fallback']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
