// Self-contained main-world Anti Addiction modal overlay.
// Uses pure DOM APIs (zero innerHTML) for strict Trusted Types compatibility.
module.exports = function installAntiAddictionOverlay() {
  if (window.__agAntiAddictionInstalled) return;
  const host = () => window.__agAntiAddictionHost;
  if (!document.documentElement) {
    document.addEventListener('DOMContentLoaded', installAntiAddictionOverlay, { once: true });
    return;
  }
  if (!host()) return;

  window.__agAntiAddictionInstalled = true;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HOST_ID = 'ag-anti-addiction-host';
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  let disposed = false;
  let hostEl = null;
  let shadow = null;
  let dialog = null;
  let wrap = null;
  let card = null;
  let titleEl = null;
  let bodyEl = null;
  let dateEl = null;
  let healthTipEl = null;
  let confirmBtn = null;
  let serialEl = null;

  let currentModal = null;
  let lastModelKey = '';
  let lastConvoKey = '';
  let lastFetchAt = 0;
  let inflight = false;
  let debounceTimer = null;
  let seenDomErrorIds = new Set();
  let pendingObservedErrorId = null;
  let domBaselineReady = false;

  function el(tag, className, textContent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent !== undefined) node.textContent = textContent;
    return node;
  }

  function svgEl(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      node.setAttribute(k, String(v));
    }
    return node;
  }

  function buildShieldLogoSvg() {
    const svg = svgEl('svg', { viewBox: '0 0 36 36', fill: 'none', 'aria-hidden': 'true', class: 'brand-icon' });
    svg.append(
      svgEl('path', {
        d: 'M18 3L31 8V17.4C31 25.3 25.4 31.3 18 33.5C10.6 31.3 5 25.3 5 17.4V8L18 3Z',
        stroke: 'rgba(255,255,255,0.94)',
        'stroke-width': '2.2',
        'stroke-linejoin': 'round',
        fill: 'rgba(255,255,255,0.08)',
      }),
      svgEl('path', {
        d: 'M18 11.2C14.1 11.2 11 14.3 11 18.2C11 22.1 14.1 25.2 18 25.2C21.5 25.2 24.1 22.9 24.5 19.6H18V17.1H26.9C27.1 17.8 27.2 18.5 27.2 19.2C27.2 24.4 23.3 27.9 18 27.9C12.6 27.9 8.3 23.6 8.3 18.2C8.3 12.8 12.6 8.5 18 8.5C20.5 8.5 22.8 9.4 24.5 11.1L22.5 13C21.3 11.9 19.8 11.2 18 11.2Z',
        fill: 'rgba(255,255,255,0.95)',
      }),
    );
    return svg;
  }

  function buildBannerWatermarkSvg() {
    const svg = svgEl('svg', { viewBox: '0 0 120 120', fill: 'none', 'aria-hidden': 'true', class: 'banner-watermark' });
    svg.append(
      svgEl('path', {
        d: 'M60 12L104 29V61C104 87.5 85 107.6 60 115C35 107.6 16 87.5 16 61V29L60 12Z',
        stroke: '#ffffff',
        'stroke-width': '8',
      }),
      svgEl('path', {
        d: 'M60 36C46.7 36 36 46.7 36 60C36 73.3 46.7 84 60 84C71.8 84 80.8 76.2 82.4 65H60V56.5H90.5C91.1 58.8 91.4 61.1 91.4 63.5C91.4 81.3 78.2 93.5 60 93.5C41.5 93.5 26.5 78.5 26.5 60C26.5 41.5 41.5 26.5 60 26.5C68.8 26.5 76.6 29.8 82.4 35.3L75.4 42.2C71.4 38.4 66 36 60 36Z',
        fill: '#ffffff',
      }),
    );
    return svg;
  }

  function ensureDom() {
    if (hostEl?.isConnected && shadow && dialog) return;
    hostEl?.remove();
    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.style.cssText = 'position:fixed;inset:0;width:0;height:0;z-index:2147483640;pointer-events:none;';
    shadow = hostEl.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      * { box-sizing: border-box; }
      dialog#ag-anti-addiction-dialog {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        max-width: none;
        max-height: none;
        margin: 0;
        padding: 24px;
        border: 0;
        background: transparent;
        display: none;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
        overflow: auto;
      }
      dialog#ag-anti-addiction-dialog[open] {
        display: flex;
      }
      dialog#ag-anti-addiction-dialog::backdrop {
        background: rgba(6, 11, 20, 0.78);
        backdrop-filter: blur(16px) saturate(110%);
        -webkit-backdrop-filter: blur(16px) saturate(110%);
        animation: ag-aa-fade 220ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
      }
      .wrap {
        width: min(760px, calc(100vw - 48px));
        display: flex;
        flex-direction: column;
        align-items: stretch;
        animation: ag-aa-pop 260ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
      }
      .brand-bar {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 0 0 13px 4px;
        color: rgba(255, 255, 255, 0.95);
        user-select: none;
      }
      .brand-icon {
        width: 30px;
        height: 30px;
        flex: none;
        filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.45));
      }
      .brand-title {
        font-size: 20px;
        font-weight: 500;
        letter-spacing: 0.6px;
        text-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
      }
      .card {
        width: 100%;
        background: #ffffff;
        border-radius: 14px;
        overflow: hidden;
        box-shadow: 0 28px 72px rgba(0, 0, 0, 0.56), 0 0 0 1px rgba(255, 255, 255, 0.1);
        color: #2b313b;
      }
      .banner {
        position: relative;
        height: 54px;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        user-select: none;
      }
      .card[data-theme="gemini"] .banner {
        background: linear-gradient(100deg, #2563EB 0%, #4F6BFF 30%, #8B5CF6 64%, #D96570 100%);
      }
      .card[data-theme="claude"] .banner {
        background: linear-gradient(100deg, #C85028 0%, #D97757 48%, #F09349 100%);
      }
      .banner::before {
        content: "";
        position: absolute;
        inset: 0;
        background: radial-gradient(circle at 20% 20%, rgba(255, 255, 255, 0.16), transparent 55%);
        pointer-events: none;
      }
      .banner-title {
        position: relative;
        z-index: 1;
        color: #ffffff;
        font-size: 20px;
        font-weight: 600;
        letter-spacing: 1.2px;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
      }
      .banner-watermark {
        position: absolute;
        right: 14px;
        top: -12px;
        width: 96px;
        height: 96px;
        opacity: 0.14;
        pointer-events: none;
      }
      .body {
        padding: 32px 48px 34px;
        background: #ffffff;
      }
      .salutation {
        margin: 0 0 10px 0;
        font-size: 16px;
        font-weight: 700;
        color: #1f2329;
      }
      .message {
        margin: 0;
        font-size: 15.5px;
        line-height: 1.8;
        color: #2f3540;
      }
      .reset-box {
        margin: 22px 0 8px;
        text-align: center;
      }
      .reset-date {
        font-size: 22px;
        font-weight: 600;
        letter-spacing: 0.4px;
        font-variant-numeric: tabular-nums;
        display: inline-block;
      }
      .card[data-theme="gemini"] .reset-date {
        color: #4F6BFF;
        background: linear-gradient(95deg, #2563EB 0%, #6D5DF6 52%, #D96570 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      .card[data-theme="claude"] .reset-date {
        color: #D97757;
        background: linear-gradient(95deg, #C85028 0%, #D97757 50%, #EB8D43 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      .reset-countdown {
        margin: 6px 0 0;
        font-size: 12.5px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
      }
      .card[data-theme="gemini"] .reset-countdown {
        color: #5b6bd5;
      }
      .card[data-theme="claude"] .reset-countdown {
        color: #c96843;
      }
      .health-tip {
        margin: 5px 0 0;
        font-size: 13px;
        color: #8c95a3;
        text-align: center;
      }
      .actions {
        margin-top: 24px;
        display: flex;
        justify-content: center;
      }
      .confirm-btn {
        min-width: 176px;
        height: 44px;
        padding: 0 42px;
        border: 0;
        border-radius: 999px;
        color: #ffffff;
        font: inherit;
        font-size: 15px;
        font-weight: 500;
        letter-spacing: 1px;
        cursor: pointer;
        transition: transform 140ms cubic-bezier(0.22, 1, 0.36, 1), filter 140ms ease, box-shadow 140ms ease;
      }
      .card[data-theme="gemini"] .confirm-btn {
        background: linear-gradient(100deg, #3B82F6 0%, #6C63FF 52%, #D96570 100%);
        box-shadow: 0 8px 22px rgba(79, 107, 255, 0.36);
      }
      .card[data-theme="claude"] .confirm-btn {
        background: linear-gradient(100deg, #C85028 0%, #D97757 50%, #EE944B 100%);
        box-shadow: 0 8px 22px rgba(217, 119, 87, 0.36);
      }
      .confirm-btn:hover {
        filter: brightness(1.06);
        transform: translateY(-1px);
      }
      .confirm-btn:active {
        transform: scale(0.97);
      }
      .confirm-btn:focus-visible {
        outline: 2px solid #ffffff;
        outline-offset: 2px;
      }
      .serial-footer {
        margin-top: 15px;
        text-align: center;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.48);
        letter-spacing: 0.4px;
        font-variant-numeric: tabular-nums;
        user-select: text;
      }
      @media (max-width: 600px) {
        .body { padding: 24px 22px 26px; }
        .brand-title { font-size: 17px; }
        .reset-date { font-size: 19px; }
      }
      @keyframes ag-aa-fade {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes ag-aa-pop {
        from { opacity: 0; transform: translateY(10px) scale(0.97); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @media (prefers-reduced-motion: reduce) {
        dialog#ag-anti-addiction-dialog::backdrop, .wrap { animation: none; }
        .confirm-btn { transition: none; }
      }
    `;

    dialog = document.createElement('dialog');
    dialog.id = 'ag-anti-addiction-dialog';
    dialog.setAttribute('aria-labelledby', 'ag-aa-banner-title');

    wrap = el('div', 'wrap');

    const brandBar = el('div', 'brand-bar');
    brandBar.append(buildShieldLogoSvg(), el('span', 'brand-title', '谷歌健康系统'));

    card = el('div', 'card');
    card.dataset.theme = 'gemini';

    const banner = el('div', 'banner');
    titleEl = el('span', 'banner-title', '温馨提示');
    titleEl.id = 'ag-aa-banner-title';
    banner.append(titleEl, buildBannerWatermarkSvg());

    const body = el('div', 'body');
    const salutation = el('p', 'salutation', '尊敬的用户：');
    bodyEl = el('p', 'message');

    const resetBox = el('div', 'reset-box');
    dateEl = el('div', 'reset-date');
    healthTipEl = el('p', 'health-tip', '请合理安排氛围编码时间，保证您的身心健康');
    resetBox.append(dateEl, healthTipEl);

    const actions = el('div', 'actions');
    confirmBtn = el('button', 'confirm-btn', '确认');
    confirmBtn.type = 'button';
    actions.append(confirmBtn);

    body.append(salutation, bodyEl, resetBox, actions);
    card.append(banner, body);

    serialEl = el('div', 'serial-footer');
    wrap.append(brandBar, card, serialEl);
    dialog.append(wrap);

    shadow.append(style, dialog);
    document.documentElement.append(hostEl);

    for (const evt of ['pointerdown', 'mousedown', 'click']) {
      shadow.addEventListener(evt, e => e.stopPropagation());
    }

    confirmBtn.addEventListener('click', () => {
      void dismissModal();
    });

    dialog.addEventListener('cancel', e => {
      e.preventDefault();
      void dismissModal();
    });
  }

  function showModal(modal) {
    ensureDom();
    currentModal = modal;
    card.dataset.theme = modal.theme === 'claude' ? 'claude' : 'gemini';
    bodyEl.textContent = `根据国家新闻出版署《关于防止${modal.planLabel}用户沉迷${modal.modelLabel}的通知》的相关要求，由于您是${modal.planLabel}用户，当前已经达到氛围编码额度上限。下次可氛围编码的时间为：`;
    dateEl.textContent = modal.formattedResetDate || '待服务端同步';
    serialEl.textContent = `流水号：${modal.serialId || 'AG000000'}`;

    if (!dialog.open) {
      dialog.showModal();
      confirmBtn?.focus({ preventScroll: true });
    }
  }

  function hideModal() {
    currentModal = null;
    if (dialog?.open) {
      dialog.close();
    }
  }

  async function dismissModal() {
    const closing = currentModal;
    hideModal();
    if (!closing) return;
    try {
      await host()?.dismiss({
        isPreview: Boolean(closing.isPreview),
        previewId: closing.previewId || null,
        exhaustionKey: closing.exhaustionKey || null,
        errorId: closing.errorId || null,
      });
    } catch {}
  }

  function scanDomErrorIds() {
    const found = [];
    const rootNode = document.querySelector('[data-testid="conversation-view"]') || document.body || document.documentElement;
    if (!rootNode) return found;
    const text = rootNode.innerText || rootNode.textContent || '';
    const re = /Error ID:\s*([0-9a-f-]{8,}(?:-\d+)*)/gi;
    for (let match; (match = re.exec(text));) {
      if (match[1]) found.push(match[1]);
    }
    return found;
  }

  function detectNewDomError() {
    const ids = scanDomErrorIds();
    if (!domBaselineReady) {
      domBaselineReady = true;
      for (const id of ids) seenDomErrorIds.add(id);
      return null;
    }
    let newest = null;
    for (const id of ids) {
      if (!seenDomErrorIds.has(id)) {
        seenDomErrorIds.add(id);
        newest = id;
      }
    }
    return newest;
  }

  function detectActiveUiModel() {
    const visible = element => element?.isConnected
      && !element.closest('[hidden],[inert]')
      && element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== 'hidden';

    const selectors = [
      '[data-testid="model-selector-trigger"]',
      'button[role="combobox"][aria-haspopup]',
      'button[aria-label^="Select model"]',
    ];

    const candidates = [];
    for (const sel of selectors) {
      for (const elNode of document.querySelectorAll(sel)) {
        if (visible(elNode) && !candidates.includes(elNode)) candidates.push(elNode);
      }
      if (candidates.length) break;
    }
    if (!candidates.length) return '';

    const activeEl = document.activeElement;
    const focused = candidates.find(btn => {
      const box = btn.closest('[data-testid="agent-input-box"],[id="antigravity.agentSidePanelInputBox"]');
      return box && activeEl && box.contains(activeEl);
    });
    const primary = focused || candidates.find(btn => !btn.closest('[data-pane-unfocused],[data-side-panel-composer]')) || candidates[0];
    const label = primary.getAttribute('aria-label') || '';
    const text = (primary.textContent || '').trim();
    if (text) return text;
    return label.replace(/^Select model[:\s]*/i, '').trim();
  }

  function detectConversationId() {
    const pathMatch = location.pathname.match(/\/c\/([0-9a-f-]{36})/i)?.[1];
    if (pathMatch && GUID.test(pathMatch)) return pathMatch;
    const active = document.activeElement?.closest?.('[data-cascade-id]');
    const activeId = active?.getAttribute?.('data-cascade-id');
    if (activeId && GUID.test(activeId)) return activeId;
    const view = document.querySelector('[data-testid="conversation-view"][data-cascade-id]');
    const viewId = view?.getAttribute?.('data-cascade-id');
    return viewId && GUID.test(viewId) ? viewId : null;
  }

  async function sync(force = false, observedErrorId = null) {
    if (observedErrorId) pendingObservedErrorId = observedErrorId;
    if (disposed || inflight) return;
    inflight = true;
    lastFetchAt = Date.now();
    try {
      const uiModel = detectActiveUiModel();
      const conversationId = detectConversationId();
      if ((conversationId || '') !== lastConvoKey) {
        domBaselineReady = false;
        seenDomErrorIds = new Set();
        detectNewDomError();
      }
      lastModelKey = uiModel;
      lastConvoKey = conversationId || '';
      const errToSend = pendingObservedErrorId;
      pendingObservedErrorId = null;
      const state = await host()?.getState({
        uiModel,
        conversationId,
        observedErrorId: errToSend,
        force: force || Boolean(errToSend),
      });
      if (disposed || !state) return;
      if (state.modal) {
        showModal(state.modal);
      } else {
        hideModal();
      }
    } catch {
      // Next poll recovers cleanly
    } finally {
      inflight = false;
      if (pendingObservedErrorId && !disposed) {
        queueMicrotask(() => { void sync(true); });
      }
    }
  }

  function scheduleSync(delayMs = 200, observedErrorId = null) {
    if (observedErrorId) pendingObservedErrorId = observedErrorId;
    if (disposed) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void sync(Boolean(pendingObservedErrorId));
    }, delayMs);
  }

  const observer = new MutationObserver(records => {
    if (disposed) return;
    if (hostEl && records.every(r => r.target === hostEl || hostEl.contains(r.target))) return;
    const newErr = detectNewDomError();
    if (newErr) {
      scheduleSync(120, newErr);
      return;
    }
    const currentModel = detectActiveUiModel();
    const currentConvo = detectConversationId() || '';
    if (currentModel !== lastModelKey || currentConvo !== lastConvoKey) {
      scheduleSync(180);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'data-cascade-id'],
  });

  const pollTimer = setInterval(() => {
    if (disposed) return;
    const newErr = detectNewDomError();
    const currentModel = detectActiveUiModel();
    const currentConvo = detectConversationId() || '';
    const due = Date.now() - lastFetchAt > (document.hidden ? 10000 : 2500);
    if (newErr || currentModel !== lastModelKey || currentConvo !== lastConvoKey || due) {
      void sync(Boolean(newErr), newErr);
    }
  }, 1000);

  window.__agAntiAddictionRefresh = () => {
    void sync(true);
  };

  window.__agAntiAddictionDispose = () => {
    disposed = true;
    clearInterval(pollTimer);
    clearTimeout(debounceTimer);
    observer.disconnect();
    hideModal();
    hostEl?.remove();
    hostEl = null;
    shadow = null;
    dialog = null;
    window.__agAntiAddictionInstalled = false;
    delete window.__agAntiAddictionRefresh;
    delete window.__agAntiAddictionDispose;
  };

  void sync(true);
};
