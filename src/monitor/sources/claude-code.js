// Claude Code source adapter; shared parsing stays in claude-local.js.
import { posix, win32 } from 'node:path';
import { collectClaude, validateClaudeBatch } from '../claude-local.js';

export default {
  id: 'claude-code',
  path: 'claude-code',
  allowModel: (model) => typeof model === 'string' && model.startsWith('claude-'),
  defaultPaths: ({ platform, home }) => ({
    projectsDir: (platform === 'win32' ? win32 : posix).join(home, '.claude', 'projects'),
  }),
  collect: ({ paths, state, now }) => collectClaude({ projectsDir: paths.projectsDir, state, now }),
  validateBatch: (body, { now, device }) => validateClaudeBatch(body, now, device),
};
