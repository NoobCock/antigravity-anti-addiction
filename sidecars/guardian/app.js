const $ = id => document.getElementById(id);

let latestState = null;
let previewScenario = 'current';

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  return res.json();
}

function pct(val) {
  return typeof val === 'number' && Number.isFinite(val) ? `${(val * 100).toFixed(1)}%` : '—';
}

function renderGroups(groups = []) {
  const container = $('groups-list');
  container.replaceChildren();
  if (!groups.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '暂未获取到额度分组信息，等待 Antigravity 本地接口就绪。';
    container.append(empty);
    return;
  }

  for (const g of groups) {
    const box = document.createElement('div');
    box.className = 'group-box';

    const top = document.createElement('div');
    top.className = 'group-top';
    const title = document.createElement('span');
    title.className = 'group-title';
    title.textContent = g.name || g.id;
    const tag = document.createElement('span');
    tag.className = 'muted';
    const isClaudeGroup = /3p|claude|gpt/i.test(`${g.id} ${g.name}`);
    tag.textContent = isClaudeGroup ? 'Claude 橙色主题' : 'Gemini RGB 主题';
    top.append(title, tag);
    box.append(top);

    for (const [key, label] of [['5h', '5 小时额度'], ['weekly', 'Weekly 每周额度']]) {
      const w = g.windows?.[key];
      const row = document.createElement('div');
      row.className = 'window-row';

      const meta = document.createElement('div');
      meta.className = 'window-meta';
      const left = document.createElement('span');
      left.textContent = `${label} · 剩余 ${pct(w?.remaining)}`;
      const right = document.createElement('strong');
      right.textContent = w?.formattedReset
        ? `${w.formattedReset}（${w.formattedRemaining || '—'}）`
        : '—';
      meta.append(left, right);

      const track = document.createElement('div');
      track.className = 'track';
      const fill = document.createElement('i');
      if (isClaudeGroup) fill.classList.add('claude');
      if (typeof w?.remaining === 'number' && w.remaining <= 1e-6) fill.classList.add('empty');
      fill.style.width = typeof w?.remaining === 'number' ? `${Math.max(0, Math.min(100, w.remaining * 100))}%` : '0%';
      track.append(fill);

      row.append(meta, track);
      box.append(row);
    }
    container.append(box);
  }
}

function renderInlinePreview(state) {
  const ev = state.evaluation;
  const activeModal = state.modal;
  const target = activeModal || {
    planLabel: ev?.planLabel || 'Google AI Pro',
    modelLabel: previewScenario === 'claude-5h'
      ? 'Claude Opus 5.5'
      : previewScenario.startsWith('gemini-')
        ? 'Gemini 4 Carbon'
        : (ev?.modelLabel || 'Gemini 4 Carbon'),
    theme: previewScenario === 'claude-5h'
      ? 'claude'
      : previewScenario.startsWith('gemini-')
        ? 'gemini'
        : (ev?.theme || 'gemini'),
    resetSource: previewScenario === 'gemini-weekly' ? 'weekly' : (ev?.resetSource || '5h'),
    formattedResetDate: ev?.formattedResetDate !== '待服务端同步'
      ? ev.formattedResetDate
      : (ev?.windows?.fiveHour?.formattedReset || '2026年11月26日 18:28'),
    formattedRemaining: ev?.formattedRemaining !== '未知'
      ? ev.formattedRemaining
      : (ev?.windows?.fiveHour?.formattedRemaining || '3小时25分钟'),
    serialId: ev?.serialId || 'AG202611261428PREVIEW001',
  };

  $('inline-preview-stage').dataset.theme = target.theme === 'claude' ? 'claude' : 'gemini';
  $('inline-theme-badge').textContent = target.theme === 'claude' ? 'Claude 橙色' : 'Gemini RGB';
  $('mini-message').textContent = `根据国家新闻出版署《关于防止${target.planLabel}用户沉迷${target.modelLabel}的通知》的相关要求，由于您是${target.planLabel}用户，当前已经达到氛围编码额度上限。下次可氛围编码的时间为：`;
  $('mini-date').textContent = target.formattedResetDate;
  $('mini-serial').textContent = `流水号：${target.serialId}`;
}

function render(state) {
  latestState = state;
  const ev = state.evaluation || {};
  $('plan-label').textContent = ev.planLabel || '—';
  $('model-label').textContent = ev.modelLabel || '—';
  $('quota-state').textContent = ev.exhausted
    ? `已耗尽（${ev.resetSource === 'weekly' ? 'Weekly 耗尽' : '5h 耗尽'}）`
    : '额度充足';
  $('overlay-state').textContent = state.overlay?.message || '等待连接';
  $('status-note').textContent = state.error
    ? `提示：${state.error}`
    : (state.dismissed ? '当前耗尽周期已点击确认关闭（切换其他耗尽模型或点击“清除记忆”可再次触发）。' : '');
  $('fetched-at').textContent = state.fetchedAt
    ? `更新于 ${new Date(state.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
    : '';

  if (state.settings) {
    $('toggle-enabled').checked = state.settings.enabled !== false;
    $('toggle-stop-error').checked = state.settings.triggerOnStopError !== false;
    $('select-theme').value = state.settings.themeMode || 'auto';
    $('toggle-tier').checked = state.settings.includeThinkingTier === true;
  }

  renderGroups(ev.groups || []);
  renderInlinePreview(state);
}

async function refresh(force = false) {
  try {
    const state = force ? await api('/api/refresh', 'POST', {}) : await api('/api/state', 'GET');
    render(state);
  } catch {}
}

$('refresh-btn').addEventListener('click', () => { void refresh(true); });

$('toggle-enabled').addEventListener('change', async e => {
  render(await api('/api/settings', 'POST', { enabled: e.target.checked }));
});

$('toggle-stop-error').addEventListener('change', async e => {
  render(await api('/api/settings', 'POST', { triggerOnStopError: e.target.checked }));
});

$('select-theme').addEventListener('change', async e => {
  render(await api('/api/settings', 'POST', { themeMode: e.target.value }));
});

$('toggle-tier').addEventListener('change', async e => {
  render(await api('/api/settings', 'POST', { includeThinkingTier: e.target.checked }));
});

$('clear-dismissed-btn').addEventListener('click', async () => {
  render(await api('/api/reset-dismissed', 'POST', {}));
});

for (const btn of document.querySelectorAll('[data-preview]')) {
  btn.addEventListener('click', async () => {
    previewScenario = btn.dataset.preview;
    render(await api('/api/preview', 'POST', { scenario: previewScenario }));
  });
}

void refresh(false);
setInterval(() => { void refresh(false); }, 3000);
