// Registry of observed subscription usage sources.
import codex from './codex.js';
import claudeCode from './claude-code.js';

export const SOURCES = new Map([codex, claudeCode].map((source) => [source.id, source]));

export const sourceById = (id) => SOURCES.get(id);
export const sourceByPath = (path) => [...SOURCES.values()].find((source) => source.path === path);
