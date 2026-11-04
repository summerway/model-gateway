#!/usr/bin/env node
// Compatibility entry point: preserve the existing Mac LaunchAgent device name.
import { runCollect } from '../src/collect/index.js';

try {
  process.exitCode = await runCollect({
    argv: process.argv.slice(2), defaultDevice: 'mac', requireEnvFile: false,
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
