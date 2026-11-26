import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { makeRendererSource, validTarget } from '../sidecars/guardian/cdp-overlay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDGET_PATH = join(HERE, '..', 'sidecars', 'guardian', 'overlay-widget.cjs');
const widgetSource = readFileSync(WIDGET_PATH, 'utf8');

test('overlay-widget.cjs uses no innerHTML/outerHTML/insertAdjacentHTML (Trusted Types safe)', () => {
  const codeWithoutComments = widgetSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(codeWithoutComments, /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|document\.write\b/);
});

test('makeRendererSource wraps widget with owner guard and validTarget filters loopback pages', () => {
  const code = makeRendererSource(widgetSource, 'owner-1', 123);
  assert.ok(code.includes('__agAntiAddictionBridge'));
  assert.ok(code.includes('owner-1'));

  assert.equal(
    validTarget({ type: 'page', url: 'https://127.0.0.1:51344/c/abc', webSocketDebuggerUrl: 'ws://127.0.0.1:51342/devtools/page/1' }, 51342),
    true,
  );
  assert.equal(
    validTarget({ type: 'iframe', url: 'plugin://anti-addiction--guardian/', webSocketDebuggerUrl: 'ws://127.0.0.1:51342/devtools/page/2' }, 51342),
    false,
  );
  assert.equal(
    validTarget({ type: 'page', url: 'data:text/html,hi', webSocketDebuggerUrl: 'ws://127.0.0.1:51342/devtools/page/3' }, 51342),
    false,
  );
  assert.equal(
    validTarget({ type: 'page', url: 'https://example.com', webSocketDebuggerUrl: 'ws://127.0.0.1:51342/devtools/page/4' }, 51342),
    false,
  );
});

test('overlay-widget renders exact Google Health System copy and handles confirm click', async () => {
  const require = createRequire(import.meta.url);
  const installOverlay = require(WIDGET_PATH);

  // Minimal DOM mock for testing overlay-widget in Node
  function makeNode(tag, ns = null) {
    const children = [];
    const attrs = new Map();
    const listeners = new Map();
    const node = {
      tagName: tag.toUpperCase(),
      namespaceURI: ns,
      children,
      dataset: {},
      style: { cssText: '' },
      className: '',
      id: '',
      textContent: '',
      open: false,
      isConnected: true,
      shadowRoot: null,
      parentNode: null,
      append(...items) {
        for (const item of items) {
          item.parentNode = this;
          children.push(item);
        }
      },
      remove() {
        this.isConnected = false;
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      attachShadow() {
        const root = makeNode('#shadow-root');
        this.shadowRoot = root;
        return root;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatch(type) {
        for (const fn of listeners.get(type) || []) fn({ type, preventDefault() {}, stopPropagation() {} });
      },
      focus() {},
      showModal() { this.open = true; },
      close() { this.open = false; },
      closest() { return null; },
      getClientRects() { return [{ width: 100, height: 24 }]; },
    };
    return node;
  }

  function findAll(root, pred, out = []) {
    if (pred(root)) out.push(root);
    for (const c of root.children || []) findAll(c, pred, out);
    if (root.shadowRoot) findAll(root.shadowRoot, pred, out);
    return out;
  }

  const docEl = makeNode('html');
  const dismissedPayloads = [];
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevLocation = globalThis.location;
  const prevMutationObserver = globalThis.MutationObserver;
  const prevGetComputedStyle = globalThis.getComputedStyle;

  globalThis.window = {
    __agAntiAddictionHost: {
      async getState() {
        return {
          enabled: true,
          modal: {
            isPreview: false,
            exhaustionKey: 'gemini:5h:2026-11-26T10:30:00.000Z',
            planLabel: 'Google AI Pro',
            modelLabel: 'Gemini 4 Carbon',
            theme: 'gemini',
            resetSource: '5h',
            resetAt: new Date(Date.now() + 3600_000).toISOString(),
            formattedResetDate: '2026年11月26日 18:30',
            serialId: 'AG20261126TEST01',
          },
        };
      },
      async dismiss(payload) {
        dismissedPayloads.push(payload);
      },
    },
  };
  globalThis.document = {
    documentElement: docEl,
    hidden: false,
    activeElement: null,
    createElement: tag => makeNode(tag),
    createElementNS: (ns, tag) => makeNode(tag, ns),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
  };
  globalThis.location = { pathname: '/c/00000000-0000-0000-0000-000000000001' };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });

  try {
    installOverlay();
    await new Promise(r => setTimeout(r, 20));

    const host = findAll(docEl, n => n.id === 'ag-anti-addiction-host')[0];
    assert.ok(host, 'host element created');

    const dialog = findAll(host, n => n.id === 'ag-anti-addiction-dialog')[0];
    assert.equal(dialog.open, true);

    const card = findAll(host, n => n.className === 'card')[0];
    assert.equal(card.dataset.theme, 'gemini');

    const texts = findAll(host, n => typeof n.textContent === 'string' && n.textContent.trim().length > 0).map(n => n.textContent);
    assert.ok(texts.includes('谷歌健康系统'));
    assert.ok(texts.includes('温馨提示'));
    assert.ok(texts.includes('尊敬的用户：'));
    assert.ok(texts.some(t => t.includes('《关于防止Google AI Pro用户沉迷Gemini 4 Carbon的通知》') && t.includes('由于您是Google AI Pro用户，当前已经达到氛围编码额度上限。下次可氛围编码的时间为：')));
    assert.ok(texts.includes('2026年11月26日 18:30'));
    assert.ok(texts.includes('请合理安排氛围编码时间，保证您的身心健康'));
    assert.ok(texts.includes('流水号：AG20261126TEST01'));

    const btn = findAll(host, n => n.className === 'confirm-btn')[0];
    assert.equal(btn.textContent, '确认');
    btn.dispatch('click');
    await new Promise(r => setTimeout(r, 10));

    assert.equal(dialog.open, false);
    assert.equal(dismissedPayloads.length, 1);
    assert.equal(dismissedPayloads[0].exhaustionKey, 'gemini:5h:2026-11-26T10:30:00.000Z');

    globalThis.window.__agAntiAddictionDispose?.();
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    globalThis.location = prevLocation;
    globalThis.MutationObserver = prevMutationObserver;
    globalThis.getComputedStyle = prevGetComputedStyle;
  }
});
