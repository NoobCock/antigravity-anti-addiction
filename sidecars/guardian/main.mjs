import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { platformPaths } from './paths.mjs';
import { loadSidecarSdk } from './sdk.mjs';
import { SettingsStore } from './settings.mjs';
import { SidecarOwner } from './owner.mjs';
import { QuotaMonitor } from './monitor.mjs';
import { OverlayInjector, makeRendererSource } from './cdp-overlay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const paths = platformPaths();
const settings = new SettingsStore({ file: paths.settings });
const ownership = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ? new SidecarOwner(paths.data) : null;
const monitor = new QuotaMonitor({ settings });

const widgetSource = readFileSync(join(HERE, 'overlay-widget.cjs'), 'utf8');
const rendererSource = makeRendererSource(widgetSource, ownership?.token || null, ownership?.startedAt || 0);

const injector = new OverlayInjector({
  monitor,
  settings,
  source: rendererSource,
  profile: paths.profile,
  owner: ownership?.token || null,
  owns: () => (ownership ? ownership.isOwner() : true),
  enabled: async () => {
    const s = await settings.get();
    return s.enabled && !monitor.isDisabled();
  },
});

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

async function statePayload(force = false) {
  const snap = await monitor.snapshot({ force });
  return {
    ...snap,
    overlay: injector.health,
  };
}

async function handleAction(action, body = {}) {
  if (action === 'settings') {
    const next = await settings.update(body);
    await injector.pushRefresh();
    return { ok: true, settings: next, ...(await statePayload(false)) };
  }
  if (action === 'preview') {
    const scenario = typeof body?.scenario === 'string' ? body.scenario : 'current';
    monitor.triggerPreview({
      scenario,
      theme: typeof body?.theme === 'string' ? body.theme : null,
      model: typeof body?.model === 'string' ? body.model : null,
      resetSource: typeof body?.resetSource === 'string' ? body.resetSource : null,
    });
    await injector.pushRefresh();
    return { ok: true, ...(await statePayload(false)) };
  }
  if (action === 'dismiss-preview') {
    monitor.dismissPreview(typeof body?.previewId === 'string' ? body.previewId : null);
    await injector.pushRefresh();
    return { ok: true, ...(await statePayload(false)) };
  }
  if (action === 'reset-dismissed') {
    await settings.clearDismissed();
    await injector.pushRefresh();
    return { ok: true, ...(await statePayload(true)) };
  }
  if (action === 'refresh') {
    const payload = await statePayload(true);
    await injector.pushRefresh();
    return { ok: true, ...payload };
  }
  throw new Error('Unknown action');
}

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const { SidecarApp, Response } = await loadSidecarSdk();
  if (!await ownership.claim()) process.exit(0);

  const app = new SidecarApp();
  for (const [path, [file, contentType]] of Object.entries(STATIC)) {
    app.api(path, () => new Response(readFileSync(join(HERE, file), 'utf8'), {
      contentType,
      headers: { 'Cache-Control': 'no-store' },
    }), 'GET');
  }
  app.api('/api/state', async data => statePayload(data?.force === true || data?.force === '1'), 'GET');
  app.api('/api/settings', async data => {
    try { return await handleAction('settings', data); }
    catch (e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 400, contentType: 'application/json' }); }
  }, 'POST');
  app.api('/api/preview', async data => {
    try { return await handleAction('preview', data); }
    catch (e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 400, contentType: 'application/json' }); }
  }, 'POST');
  app.api('/api/dismiss-preview', async data => {
    try { return await handleAction('dismiss-preview', data); }
    catch (e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 400, contentType: 'application/json' }); }
  }, 'POST');
  app.api('/api/reset-dismissed', async () => {
    try { return await handleAction('reset-dismissed'); }
    catch (e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 400, contentType: 'application/json' }); }
  }, 'POST');
  app.api('/api/refresh', async () => {
    try { return await handleAction('refresh'); }
    catch (e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 400, contentType: 'application/json' }); }
  }, 'POST');

  app.run();
  injector.start();
  void monitor.refreshQuota(true);

  const shutdown = async () => {
    clearInterval(codeWatchTimer);
    const exitTimer = setTimeout(() => process.exit(0), 2000);
    exitTimer.unref();
    await injector.stop();
    ownership.stop();
    process.exit(0);
  };
  // Automatically restart cleanly when plugin files on disk are upgraded
  const watchedFiles = ['main.mjs', 'quota.mjs', 'monitor.mjs', 'settings.mjs', 'cdp-overlay.mjs', 'overlay-widget.cjs'].map(f => join(HERE, f));
  const initialMtimes = new Map(watchedFiles.map(f => [f, (() => { try { return statSync(f).mtimeMs; } catch { return 0; } })()]));
  const codeWatchTimer = setInterval(() => {
    for (const file of watchedFiles) {
      try {
        if (statSync(file).mtimeMs !== initialMtimes.get(file)) {
          clearInterval(codeWatchTimer);
          setTimeout(() => { void shutdown(); }, 400);
          break;
        }
      } catch {}
    }
  }, 4000);
  codeWatchTimer.unref?.();

  ownership.watch(shutdown);
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => { void shutdown(); });
  }
} else {
  // Standalone local preview server
  const port = Number(process.env.AG_ANTI_ADDICTION_PORT || 17921);
  const server = createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const url = new URL(req.url, `http://${host}`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'Content-Type': type });
      res.end(readFileSync(join(HERE, file), 'utf8'));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(await statePayload(url.searchParams.get('force') === '1')));
      return;
    }

    if (req.method === 'POST' && ['/api/settings', '/api/preview', '/api/dismiss-preview', '/api/reset-dismissed', '/api/refresh'].includes(url.pathname)) {
      let body = '';
      try {
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 8192) throw new Error('Payload too large');
        }
        const parsed = body.trim() ? JSON.parse(body) : {};
        const action = url.pathname.slice(5);
        const result = await handleAction(action, parsed);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  injector.start();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Anti Addiction sidecar running at http://127.0.0.1:${port}`);
  });
}
