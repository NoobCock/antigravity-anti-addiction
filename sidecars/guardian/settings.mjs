import { readFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { platformPaths } from './paths.mjs';

const VALID_THEMES = new Set(['auto', 'gemini', 'claude']);
const VALID_REPROMPT = new Set(['once-per-window', 'on-model-switch']);
const MAX_DISMISSED_ERRORS = 80;

export const DEFAULT_SETTINGS = Object.freeze({
  schema: 1,
  enabled: true,
  triggerOnStopError: true,
  themeMode: 'auto',
  includeThinkingTier: false,
  repromptMode: 'once-per-window',
  dismissedKeys: {},
  dismissedErrorIds: {},
});

function sanitizeDismissed(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key || key.length > 160) continue;
    const parts = key.split(':');
    const iso = parts.slice(2).join(':');
    const resetMs = Date.parse(iso);
    if (Number.isFinite(resetMs) && resetMs + 60_000 < now) continue;
    const atMs = Date.parse(String(value || ''));
    out[key] = Number.isFinite(atMs) ? new Date(atMs).toISOString() : new Date(now).toISOString();
  }
  return out;
}

function sanitizeDismissedErrors(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = [];
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key || key.length > 200) continue;
    const atMs = Date.parse(String(value || ''));
    const validMs = Number.isFinite(atMs) ? atMs : now;
    if (now - validMs > 24 * 3600 * 1000) continue;
    entries.push([key, new Date(validMs).toISOString(), validMs]);
  }
  entries.sort((a, b) => b[2] - a[2]);
  return Object.fromEntries(entries.slice(0, MAX_DISMISSED_ERRORS).map(([k, v]) => [k, v]));
}

export class SettingsStore {
  constructor({ file = platformPaths().settings, now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.queue = Promise.resolve();
    this.cached = null;
  }

  async get() {
    await this.queue;
    if (this.cached) return this.cached;
    this.cached = await this.#readFresh();
    return this.cached;
  }

  async update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Invalid settings payload');
    }
    const operation = this.queue.then(async () => {
      const current = await this.#readFresh();
      const now = this.now();
      const next = {
        schema: 1,
        enabled: Object.hasOwn(patch, 'enabled') ? Boolean(patch.enabled) : current.enabled,
        triggerOnStopError: Object.hasOwn(patch, 'triggerOnStopError')
          ? Boolean(patch.triggerOnStopError)
          : current.triggerOnStopError,
        themeMode: Object.hasOwn(patch, 'themeMode')
          ? (VALID_THEMES.has(patch.themeMode) ? patch.themeMode : current.themeMode)
          : current.themeMode,
        includeThinkingTier: Object.hasOwn(patch, 'includeThinkingTier')
          ? Boolean(patch.includeThinkingTier)
          : current.includeThinkingTier,
        repromptMode: Object.hasOwn(patch, 'repromptMode')
          ? (VALID_REPROMPT.has(patch.repromptMode) ? patch.repromptMode : current.repromptMode)
          : current.repromptMode,
        dismissedKeys: sanitizeDismissed(
          Object.hasOwn(patch, 'dismissedKeys') ? patch.dismissedKeys : current.dismissedKeys,
          now,
        ),
        dismissedErrorIds: sanitizeDismissedErrors(
          Object.hasOwn(patch, 'dismissedErrorIds') ? patch.dismissedErrorIds : current.dismissedErrorIds,
          now,
        ),
      };
      await this.#writeAtomic(next);
      this.cached = next;
      return next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async dismiss({ exhaustionKey = null, errorId = null } = {}) {
    // Backwards compatibility if a string is passed directly
    if (typeof arguments[0] === 'string') {
      exhaustionKey = arguments[0];
      errorId = null;
    }
    const current = await this.get();
    const stamp = new Date(this.now()).toISOString();
    const patch = {};
    if (typeof exhaustionKey === 'string' && exhaustionKey.trim()) {
      patch.dismissedKeys = { ...current.dismissedKeys, [exhaustionKey]: stamp };
    }
    if (typeof errorId === 'string' && errorId.trim()) {
      patch.dismissedErrorIds = { ...current.dismissedErrorIds, [errorId]: stamp };
    }
    if (!Object.keys(patch).length) return current;
    return this.update(patch);
  }

  async clearDismissed() {
    return this.update({ dismissedKeys: {}, dismissedErrorIds: {} });
  }

  async #readFresh() {
    try {
      const now = this.now();
      const raw = JSON.parse((await readFile(this.file, 'utf8')).replace(/^\uFEFF/, ''));
      return {
        schema: 1,
        enabled: raw.enabled !== false,
        triggerOnStopError: raw.triggerOnStopError !== false,
        themeMode: VALID_THEMES.has(raw.themeMode) ? raw.themeMode : 'auto',
        includeThinkingTier: raw.includeThinkingTier === true,
        repromptMode: VALID_REPROMPT.has(raw.repromptMode) ? raw.repromptMode : 'once-per-window',
        dismissedKeys: sanitizeDismissed(raw.dismissedKeys, now),
        dismissedErrorIds: sanitizeDismissedErrors(raw.dismissedErrorIds, now),
      };
    } catch {
      return { ...DEFAULT_SETTINGS, dismissedKeys: {}, dismissedErrorIds: {} };
    }
  }

  async #writeAtomic(data) {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.file);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
