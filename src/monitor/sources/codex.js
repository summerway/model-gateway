// Codex source adapter; shared parsing stays in codex-local.js.
import { posix, win32 } from 'node:path';
import { collectCodex, validateCodexBatch } from '../codex-local.js';

export default {
  id: 'codex',
  path: 'codex-local',
  allowModel: () => true, // collectCodex already filters to official subscription sessions.
  defaultPaths: ({ platform, home }) => ({
    projectsDir: (platform === 'win32' ? win32 : posix).join(home, '.codex', 'sessions'),
  }),
  collect: ({ paths, state, now }) => collectCodex({ sessionDir: paths.projectsDir, state, now }),
  validateBatch: (body, { now, device }) => validateCodexBatch(body, now, device).map(({ ok, ...row }) => row),
};
