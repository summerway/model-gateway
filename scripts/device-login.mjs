// device-login.mjs — ChatGPT Codex OAuth 设备码登录，一次性 mint 新凭据链。
//
// 用法:
//   node scripts/device-login.mjs [目标secrets目录]     # 默认 <repo>/config/secrets
//
// 场景：codex.json 的 refresh token 链失效（如只读挂载导致轮换未落盘 + 重启烧链，
// 401 refresh_token_reused），从 pi 导入也无法恢复时，用设备码流重新登录。
//
// 行为:
//   1. 向 OpenAI 设备码端点申请 user_code，打印验证 URL（浏览器登录目标
//      ChatGPT 账号后批准）
//   2. 轮询直到批准/超时，换 token
//   3. 写入 <secrets>/codex.json（网关原生形态，600；目录 700）
//
// 绝不打印 token 内容；退出码 0 成功 / 1 失败。写完后重启网关容器加载。

import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginWithDeviceCode } from '../src/gateway/providers/codex/oauth.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secretsDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repoRoot, 'config', 'secrets');
const target = path.join(secretsDir, 'codex.json');

// NAS 出口偶发 fetch failed/ECONNRESET：网络层错误（未拿到响应）短重试，
// 避免轮询中途夭折让已展示的设备码作废。HTTP 4xx/5xx 不重试（交给流程语义）。
async function retryingFetch(url, init) {
  const max = 5;
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (i >= max) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

try {
  const creds = await loginWithDeviceCode({
    fetchImpl: retryingFetch,
    onEvent: (e) => {
      if (e.type === 'device_code') {
        console.log('\n========================================');
        console.log('请在浏览器打开（登录目标 ChatGPT 账号）:');
        console.log(`  ${e.verificationUri}`);
        console.log('输入以下代码并批准:');
        console.log(`  ${e.userCode}`);
        console.log('========================================\n');
        console.log('等待批准中…');
      }
    },
  });

  const out = {
    type: 'oauth',
    access: creds.access,
    refresh: creds.refresh,
    idToken: creds.idToken ?? null,
    expires: creds.expires,
    accountId: creds.accountId ?? null,
  };
  mkdirSync(secretsDir, { recursive: true });
  try { chmodSync(secretsDir, 0o700); } catch { /* 已存在目录可能非属主，尽力 */ }
  writeFileSync(target, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(target, 0o600); } catch { /* umask 兜底 */ }
  console.log(`\n[device-login] 成功: ${target}`);
  console.log('[device-login] accountId:', out.accountId ?? '(JWT 无 claim，刷新时继承/探测)');
  console.log('[device-login] 重启网关容器后生效。');
} catch (err) {
  console.error(`[device-login] 失败: ${err?.message ?? err}`);
  process.exit(1);
}
