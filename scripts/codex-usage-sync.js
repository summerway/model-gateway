#!/usr/bin/env node
// 兼容入口：已泛化为 scripts/mac-usage-sync.js（Codex + Claude Code）。未指定 --sources 时只同步 Codex，
// 保持旧 LaunchAgent 行为不变；新安装请直接使用 mac-usage-sync.js。
if (!process.argv.some((a) => a.startsWith('--sources='))) process.argv.push('--sources=codex');
await import('./mac-usage-sync.js');
