import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { platformPaths } from './paths.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BINDING = '__agAntiAddictionCallV1';

export function validTarget(target, port) {
  try {
    const page = new URL(target.url);
    const ws = new URL(target.webSocketDebuggerUrl);
    return (
      target.type === 'page'
      && ['http:', 'https:'].includes(page.protocol)
      && LOOPBACK.has(page.hostname)
      && ws.protocol === 'ws:'
      && LOOPBACK.has(ws.hostname)
      && Number(ws.port) === port
    );
  } catch {
    return false;
  }
}

function jsonGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 1048576) {
          reject(new Error('Discovery response too large'));
          req.destroy();
        }
      });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error('Renderer discovery unavailable');
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => {
      reject(new Error('Renderer discovery timeout'));
      req.destroy();
    });
    req.end();
  });
}

export async function discoverTargets(profile) {
  const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
  if (text.length > 1024) throw new Error('Invalid DevToolsActivePort file');
  const port = Number(text.split(/\r?\n/)[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid renderer port');
  const targets = await jsonGet(port, '/json/list');
  if (!Array.isArray(targets)) throw new Error('Invalid renderer discovery response');
  return targets.filter(target => validTarget(target, port));
}

export class CdpConnection {
  constructor(url, { WebSocketImpl = globalThis.WebSocket, timeout = 5000, onEvent = () => {}, onClose = () => {} } = {}) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.timeout = timeout;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
  }

  async open() {
    if (!this.WebSocketImpl) throw new Error('Node runtime lacks WebSocket support');
    this.ws = new this.WebSocketImpl(this.url);
    this.ws.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 2097152) return;
        const message = JSON.parse(event.data);
        if (message.id) {
          const item = this.pending.get(message.id);
          if (!item) return;
          this.pending.delete(message.id);
          clearTimeout(item.timer);
          if (message.error) item.reject(new Error(`Renderer command failed: ${message.error.code}`));
          else item.resolve(message.result || {});
        } else if (message.method) {
          this.onEvent(message);
        }
      } catch {}
    });
    this.ws.addEventListener('close', () => this.disconnect());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error('Renderer connection timeout'));
      }, this.timeout);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); this.close(); reject(new Error('Renderer connection failed')); }, { once: true });
    });
    return this;
  }

  command(method, params = {}) {
    if (this.closed || this.ws?.readyState !== 1) return Promise.reject(new Error('Renderer disconnected'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Renderer command timeout'));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  disconnect() {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Renderer disconnected'));
    }
    this.pending.clear();
    this.onClose();
  }

  close() {
    this.disconnect();
    this.ws?.close();
  }
}

function rendererBridge(binding) {
  if (window !== window.top) return;
  if (window.__agAntiAddictionBridge && window.__agAntiAddictionHost) return;
  window.__agAntiAddictionBridge?.dispose();
  const pending = new Map();
  let sequence = 0;
  const fallback = () => ({ enabled: false, modal: null, connection: 'offline' });
  const call = (type, input) => new Promise(resolve => {
    if (pending.size >= 8) {
      resolve(fallback());
      return;
    }
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(fallback());
    }, 12000);
    pending.set(id, { resolve, timer });
    try {
      window[binding](JSON.stringify({ id, type, input }));
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      resolve(fallback());
    }
  });
  const host = {
    getState: input => call('state', input),
    dismiss: input => call('dismiss', input),
  };
  window.__agAntiAddictionBridge = {
    binding,
    resolve(id, result) {
      const item = pending.get(id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(id);
      item.resolve(result);
    },
    reconnect() {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.resolve(fallback());
      }
      pending.clear();
    },
    dispose() {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.resolve(fallback());
      }
      pending.clear();
      delete window.__agAntiAddictionBridge;
      delete window.__agAntiAddictionHost;
    },
  };
  window.__agAntiAddictionHost = host;
}

export function makeRendererSource(widgetSource, owner = null, generation = 0) {
  const prefix = 'module.exports = ';
  const index = widgetSource.indexOf(prefix);
  if (index < 0) throw new Error('Widget source format invalid');
  const widgetFn = widgetSource.slice(index + prefix.length).trim().replace(/;$/, '');
  const version = createHash('sha256')
    .update(widgetSource + rendererBridge.toString() + JSON.stringify(owner))
    .digest('hex');
  const upgrade = `if(window.__agAntiAddictionVersion!==${JSON.stringify(version)}){window.__agAntiAddictionDispose?.();window.__agAntiAddictionBridge?.dispose();delete window.__agAntiAddictionHost;window.__agAntiAddictionVersion=${JSON.stringify(version)};}`;
  const binding = owner ? `${BINDING}_${owner.replaceAll('-', '')}` : BINDING;
  const rank = JSON.stringify([generation, owner || '']);
  const code = `${upgrade}window.__agAntiAddictionOwner=${JSON.stringify(owner)};window.__agAntiAddictionRank=${rank};(${rendererBridge.toString()})(${JSON.stringify(binding)});(${widgetFn})();`;
  return owner
    ? `if(!window.__agAntiAddictionRank||window.__agAntiAddictionRank[0]<${generation}||(window.__agAntiAddictionRank[0]===${generation}&&window.__agAntiAddictionRank[1]<=${JSON.stringify(owner)})){${code}}`
    : code;
}

export class OverlayInjector {
  constructor({
    monitor,
    settings,
    source,
    profile = platformPaths().profile,
    owner = null,
    owns = async () => true,
    enabled = async () => true,
    discover = discoverTargets,
    connect = (url, options) => new CdpConnection(url, options),
    interval = 3000,
  } = {}) {
    this.monitor = monitor;
    this.settings = settings;
    this.source = source;
    this.profile = profile;
    this.owner = owner;
    this.owns = owns;
    this.enabled = enabled;
    this.discover = discover;
    this.connect = connect;
    this.interval = interval;
    this.binding = owner ? `${BINDING}_${owner.replaceAll('-', '')}` : BINDING;
    this.sessions = new Map();
    this.running = false;
    this.stopping = false;
    this.busy = false;
    this.health = { state: 'waiting', message: '等待连接 Antigravity 窗口', windows: 0, checkedAt: null };
  }

  setHealth(state, message) {
    this.health = {
      state,
      message,
      windows: this.sessions.size,
      checkedAt: new Date().toISOString(),
    };
  }

  rendererGuard(expression) {
    return this.owner
      ? `if(window.__agAntiAddictionOwner===${JSON.stringify(this.owner)}){${expression}}`
      : expression;
  }

  async pushRefresh() {
    if (this.stopping || !await this.owns()) return;
    for (const connection of this.sessions.values()) {
      try {
        await connection.command('Runtime.evaluate', {
          expression: this.rendererGuard('window.__agAntiAddictionRefresh?.();'),
        });
      } catch {}
    }
  }

  async event(connection, message) {
    if (this.stopping || !await this.owns()) return;
    const p = message.params || {};
    if (message.method === 'Page.frameNavigated' && p.frame && !p.frame.parentId) {
      const replaced = connection.frameId !== p.frame.id;
      connection.frameId = p.frame.id;
      connection.contexts.clear();
      const trusted = p.frame.url === connection.origin || p.frame.url?.startsWith(`${connection.origin}/`);
      if (replaced && trusted) {
        for (const [id, ctx] of connection.contextCandidates) {
          if (ctx.frameId === connection.frameId && ctx.origin === connection.origin) connection.contexts.add(id);
        }
      }
      return;
    }
    if (message.method === 'Runtime.executionContextCreated') {
      if (p.context?.auxData?.isDefault) {
        connection.contextCandidates.set(p.context.id, {
          frameId: p.context.auxData.frameId,
          origin: p.context.origin,
        });
        if (connection.contextCandidates.size > 32) {
          connection.contextCandidates.delete(connection.contextCandidates.keys().next().value);
        }
        if (p.context.auxData.frameId === connection.frameId && p.context.origin === connection.origin) {
          connection.contexts.add(p.context.id);
        }
      }
      return;
    }
    if (message.method === 'Runtime.executionContextsCleared') {
      connection.contexts.clear();
      connection.contextCandidates.clear();
      return;
    }
    if (message.method === 'Runtime.executionContextDestroyed') {
      connection.contexts.delete(p.executionContextId);
      connection.contextCandidates.delete(p.executionContextId);
      return;
    }
    if (message.method !== 'Runtime.bindingCalled' || p.name !== this.binding || !connection.contexts.has(p.executionContextId)) {
      return;
    }
    if (typeof p.payload !== 'string' || p.payload.length > 4096 || connection.inflight >= 8) return;
    let input;
    try {
      input = JSON.parse(p.payload);
      if (!Number.isSafeInteger(input.id) || input.id < 1) return;
    } catch {
      return;
    }

    connection.inflight++;
    try {
      let result = {};
      if (input.type === 'state') {
        const payload = input.input && typeof input.input === 'object' ? input.input : {};
        const uiModel = typeof payload.uiModel === 'string' ? payload.uiModel.slice(0, 160) : '';
        const conversationId = GUID.test(payload.conversationId || '') ? payload.conversationId : null;
        const force = payload.force === true;
        result = await this.monitor.snapshot({ uiModel, conversationId, force });
      } else if (input.type === 'dismiss') {
        const payload = input.input && typeof input.input === 'object' ? input.input : {};
        if (payload.isPreview) {
          this.monitor.dismissPreview(typeof payload.previewId === 'string' ? payload.previewId : null);
        } else {
          await this.settings.dismiss({
            exhaustionKey: typeof payload.exhaustionKey === 'string' ? payload.exhaustionKey : null,
            errorId: typeof payload.errorId === 'string' ? payload.errorId : null,
          });
        }
        result = { ok: true };
      } else {
        return;
      }

      if (this.stopping || !await this.owns()) return;
      await connection.command('Runtime.evaluate', {
        expression: this.rendererGuard(`window.__agAntiAddictionBridge?.resolve(${input.id},${JSON.stringify(result)})`),
        contextId: p.executionContextId,
      });
    } catch {
      if (this.stopping || !await this.owns()) return;
      try {
        await connection.command('Runtime.evaluate', {
          expression: this.rendererGuard(`window.__agAntiAddictionBridge?.resolve(${input.id},${JSON.stringify({ enabled: false, modal: null })})`),
          contextId: p.executionContextId,
        });
      } catch {}
    } finally {
      connection.inflight--;
    }
  }

  async attach(target) {
    const connection = this.connect(target.webSocketDebuggerUrl, {
      onEvent: message => { void this.event(connection, message); },
    });
    connection.origin = new URL(target.url).origin;
    connection.contexts = new Set();
    connection.contextCandidates = new Map();
    connection.inflight = 0;

    try {
      await connection.open();
      if (this.stopping || !await this.owns()) throw new Error('Ownership changed');
      const frame = await connection.command('Page.getFrameTree');
      connection.frameId = frame.frameTree?.frame?.id;
      if (!connection.frameId) throw new Error('Main renderer frame unavailable');
      await connection.command('Page.enable');
      await connection.command('Runtime.enable');
      await connection.command('Runtime.addBinding', { name: this.binding });
      const guardedSource = `if(location.origin===${JSON.stringify(connection.origin)}){${this.source}}`;
      connection.guardedSource = guardedSource;
      connection.script = (await connection.command('Page.addScriptToEvaluateOnNewDocument', { source: guardedSource })).identifier;
      if (this.stopping || !await this.owns()) {
        await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.script });
        throw new Error('Ownership changed');
      }
      const res = await connection.command('Runtime.evaluate', { expression: guardedSource });
      if (res.exceptionDetails) throw new Error('Overlay script initialization failed');
      return connection;
    } catch (error) {
      try { if (connection.script) await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.script }); } catch {}
      try { if (this.owner) await connection.command('Runtime.removeBinding', { name: this.binding }); } catch {}
      connection.close();
      throw error;
    }
  }

  async tick() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      if (!await this.owns()) {
        await this.detachAll();
        return;
      }
      if (!await this.enabled()) {
        await this.detachAll();
        this.setHealth('disabled', '插件已暂停');
        return;
      }
      const targets = await this.discover(this.profile);
      const active = new Set(targets.map(t => t.webSocketDebuggerUrl));
      if (this.stopping || !await this.owns()) return;

      for (const [url, conn] of this.sessions) {
        if (!active.has(url) || conn.closed || conn.origin !== new URL(targets.find(t => t.webSocketDebuggerUrl === url).url).origin) {
          conn.close();
          this.sessions.delete(url);
        }
      }
      for (const target of targets) {
        if (!this.sessions.has(target.webSocketDebuggerUrl)) {
          this.sessions.set(target.webSocketDebuggerUrl, await this.attach(target));
        }
      }
      if (this.stopping || !await this.owns()) {
        await this.detachAll();
        return;
      }

      for (const [url, connection] of this.sessions) {
        try {
          if (!connection.contexts.size) {
            const frame = await connection.command('Page.getFrameTree');
            connection.frameId = frame.frameTree?.frame?.id;
            connection.contextCandidates.clear();
            await connection.command('Runtime.disable');
            await connection.command('Runtime.enable');
            await connection.command('Runtime.addBinding', { name: this.binding });
            await connection.command('Runtime.evaluate', {
              expression: this.rendererGuard('window.__agAntiAddictionBridge?.reconnect?.();'),
            });
          }
          const result = await connection.command('Runtime.evaluate', {
            returnByValue: true,
            expression: `({installed:Boolean(window.__agAntiAddictionInstalled),bridge:Boolean(window.__agAntiAddictionBridge&&window.__agAntiAddictionHost${this.owner ? `&&window.__agAntiAddictionBridge.binding===${JSON.stringify(this.binding)}` : ''})})`,
          });
          if (result.exceptionDetails) throw new Error('Renderer not ready');
          const status = result.result?.value;
          if (status && (!status.installed || !status.bridge)) {
            if (!await this.owns()) break;
            const recovery = await connection.command('Runtime.evaluate', { expression: connection.guardedSource });
            if (recovery.exceptionDetails) throw new Error('Recovery failed');
          }
        } catch {
          try { if (connection.script) await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.script }); } catch {}
          connection.close();
          this.sessions.delete(url);
        }
      }
      this.setHealth(
        this.sessions.size ? 'mounted' : 'waiting',
        this.sessions.size ? `已挂载到 ${this.sessions.size} 个 Antigravity 窗口` : '等待 Antigravity 主窗口就绪',
      );
    } catch {
      this.setHealth('reconnecting', '等待 Antigravity 调试端口就绪（正在自动重试）');
    } finally {
      this.busy = false;
    }
  }

  async detachAll() {
    for (const connection of this.sessions.values()) {
      try {
        if (await this.owns()) {
          await connection.command('Runtime.evaluate', {
            expression: this.rendererGuard('window.__agAntiAddictionDispose?.();window.__agAntiAddictionBridge?.dispose();delete window.__agAntiAddictionHost;'),
          });
        }
        if (connection.script) await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.script });
        if (this.owner || await this.owns()) await connection.command('Runtime.removeBinding', { name: this.binding });
      } catch {}
      connection.close();
    }
    this.sessions.clear();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.interval);
    this.timer.unref?.();
  }

  async stop() {
    this.running = false;
    this.stopping = true;
    clearInterval(this.timer);
    await this.detachAll();
  }
}
