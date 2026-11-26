import { randomUUID } from 'node:crypto';
import { AntigravityClient } from './client.mjs';
import { evaluateExhaustion, buildSerialId, formatResetDateTime, formatRemainingDuration, detectThemeForModel, normalizeModelName } from './quota.mjs';
import { isPluginDisabledInConfig } from './paths.mjs';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class QuotaMonitor {
  constructor({ client = new AntigravityClient(), settings, now = Date.now, isDisabled = () => isPluginDisabledInConfig('anti-addiction') } = {}) {
    this.client = client;
    this.settings = settings;
    this.now = now;
    this.startedAt = now();
    this.isDisabled = isDisabled;
    this.userStatus = null;
    this.quotaSummary = null;
    this.fetchedAt = 0;
    this.fetchPending = null;
    this.lastError = null;
    this.lastUiModel = '';
    this.lastConversationId = null;
    this.trajectoryModelCache = new Map();
    this.errorPollCache = new Map();
    this.preview = null;
  }

  async refreshQuota(force = false) {
    const now = this.now();
    if (!force && this.quotaSummary && now - this.fetchedAt < 12_000) return;
    if (this.fetchPending) return this.fetchPending;
    this.fetchPending = (async () => {
      try {
        const [userStatus, quotaSummary] = await Promise.all([
          this.client.call('GetUserStatus'),
          this.client.call('RetrieveUserQuotaSummary'),
        ]);
        this.userStatus = userStatus?.userStatus || userStatus || null;
        this.quotaSummary = quotaSummary || null;
        this.fetchedAt = this.now();
        this.lastError = null;
      } catch (error) {
        this.lastError = error?.message || '无法连接 Antigravity 本地接口';
      }
    })().finally(() => {
      this.fetchPending = null;
    });
    return this.fetchPending;
  }

  async resolveFallbackModel(conversationId) {
    try {
      if (conversationId && GUID.test(conversationId)) {
        const cached = this.trajectoryModelCache.get(conversationId);
        if (cached && this.now() - cached.at < 15_000) return cached.model;
        const meta = await this.client.call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: conversationId });
        const generators = meta?.generatorMetadata || [];
        const last = [...generators].reverse().find(g => g?.chatModel);
        const model = last?.chatModel?.modelDisplayName || last?.chatModel?.responseModel || last?.chatModel?.model || '';
        if (model) {
          this.trajectoryModelCache.set(conversationId, { model, at: this.now() });
          return model;
        }
      }
    } catch {}
    return '';
  }

  async detectLatestStopError(conversationId, force = false) {
    if (!conversationId || !GUID.test(conversationId)) return null;
    const now = this.now();
    const cached = this.errorPollCache.get(conversationId);
    if (!force && cached && now - cached.at < 1500) {
      return cached.error;
    }
    try {
      const summaries = await this.client.call('GetAllCascadeTrajectories');
      const summary = summaries?.trajectorySummaries?.[conversationId];
      const stepCount = Number(summary?.stepCount);
      if (!Number.isInteger(stepCount) || stepCount <= 0) {
        this.errorPollCache.set(conversationId, { at: now, error: null });
        return null;
      }
      const startIndex = Math.max(0, stepCount - 8);
      const res = await this.client.call('GetCascadeTrajectorySteps', {
        cascadeId: conversationId,
        startIndex,
        endIndex: stepCount,
      });
      const steps = Array.isArray(res?.steps) ? res.steps : [];
      let latestError = null;
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        if (step?.type !== 'CORTEX_STEP_TYPE_ERROR_MESSAGE') continue;
        const createdMs = Date.parse(step?.metadata?.createdAt || '');
        // Only treat errors occurring around/after sidecar startup as live stop events
        if (Number.isFinite(createdMs) && createdMs < this.startedAt - 10_000) break;
        const err = step?.errorMessage?.error || {};
        const stepIndex = step?.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? (startIndex + i);
        const errorId = err.errorId || `${conversationId}:${stepIndex}:${step?.metadata?.createdAt || ''}`;
        latestError = {
          errorId: String(errorId),
          createdAt: step?.metadata?.createdAt || new Date(now).toISOString(),
          userErrorMessage: err.userErrorMessage || '',
          errorCode: err.errorCode ?? null,
        };
        break;
      }
      this.errorPollCache.set(conversationId, { at: now, error: latestError });
      return latestError;
    } catch {
      return cached?.error || null;
    }
  }

  triggerPreview({ scenario = 'current', theme = null, model = null, resetSource = null } = {}) {
    const id = randomUUID();
    this.preview = {
      id,
      scenario,
      theme,
      model,
      resetSource,
      createdAt: this.now(),
    };
    return this.preview;
  }

  dismissPreview(previewId) {
    if (!this.preview) return;
    if (!previewId || this.preview.id === previewId) {
      this.preview = null;
    }
  }

  buildPreviewState(evaluation, settings) {
    if (!this.preview) return null;
    const now = this.now();
    if (now - this.preview.createdAt > 5 * 60 * 1000) {
      this.preview = null;
      return null;
    }

    const p = this.preview;
    let modelLabel = evaluation.modelLabel;
    let theme = evaluation.theme;
    let source = p.resetSource || evaluation.resetSource || '5h';
    let resetMs = evaluation.resetMs;

    if (p.scenario === 'gemini-5h') {
      modelLabel = normalizeModelName(p.model || 'Gemini 4 Carbon', { includeTier: settings.includeThinkingTier });
      theme = 'gemini';
      source = '5h';
      const geminiFive = evaluation.groups.find(g => /gemini/i.test(g.id))?.windows?.['5h'];
      resetMs = geminiFive?.resetAt ? Date.parse(geminiFive.resetAt) : now + 3 * 3600 * 1000 + 25 * 60 * 1000;
    } else if (p.scenario === 'gemini-weekly') {
      modelLabel = normalizeModelName(p.model || 'Gemini 4 Carbon', { includeTier: settings.includeThinkingTier });
      theme = 'gemini';
      source = 'weekly';
      const geminiWeek = evaluation.groups.find(g => /gemini/i.test(g.id))?.windows?.weekly;
      resetMs = geminiWeek?.resetAt ? Date.parse(geminiWeek.resetAt) : now + 4 * 86400 * 1000 + 18 * 3600 * 1000;
    } else if (p.scenario === 'claude-5h') {
      modelLabel = normalizeModelName(p.model || 'Claude Opus 5.5', { includeTier: settings.includeThinkingTier });
      theme = 'claude';
      source = '5h';
      const claudeFive = evaluation.groups.find(g => /3p|claude/i.test(g.id))?.windows?.['5h'];
      resetMs = claudeFive?.resetAt ? Date.parse(claudeFive.resetAt) : now + 4 * 3600 * 1000 + 12 * 60 * 1000;
    } else {
      if (p.model) modelLabel = normalizeModelName(p.model, { includeTier: settings.includeThinkingTier });
      theme = p.theme || detectThemeForModel(modelLabel, null, settings.themeMode);
      if (!Number.isFinite(resetMs)) {
        const candidate = source === 'weekly'
          ? evaluation.windows.weekly?.resetAt
          : evaluation.windows.fiveHour?.resetAt;
        resetMs = candidate ? Date.parse(candidate) : now + 3 * 3600 * 1000 + 15 * 60 * 1000;
      }
    }

    const remainingMs = Math.max(0, resetMs - now);
    return {
      isPreview: true,
      previewId: p.id,
      planLabel: evaluation.planLabel,
      modelLabel,
      theme,
      resetSource: source,
      resetAt: new Date(resetMs).toISOString(),
      formattedResetDate: formatResetDateTime(resetMs),
      formattedRemaining: formatRemainingDuration(remainingMs),
      serialId: buildSerialId(`preview:${p.id}`),
    };
  }

  async snapshot({ uiModel = '', conversationId = null, observedErrorId = null, force = false } = {}) {
    if (uiModel) this.lastUiModel = uiModel;
    if (conversationId) this.lastConversationId = conversationId;

    const settings = await this.settings.get();
    const disabledByPlugin = this.isDisabled();
    const active = settings.enabled && !disabledByPlugin;

    const targetConvo = conversationId || this.lastConversationId;
    const hasObservedError = typeof observedErrorId === 'string' && observedErrorId.trim().length > 0;

    await this.refreshQuota(force || hasObservedError);

    let activeModel = uiModel || this.lastUiModel;
    if (!activeModel && targetConvo) {
      activeModel = await this.resolveFallbackModel(targetConvo);
    }

    const evaluation = evaluateExhaustion({
      activeModel,
      userStatus: this.userStatus,
      quotaSummary: this.quotaSummary,
      settings,
      now: this.now(),
    });

    const backendStopError = (active && settings.triggerOnStopError !== false && targetConvo)
      ? await this.detectLatestStopError(targetConvo, force || hasObservedError)
      : null;

    const stopErrorId = backendStopError?.errorId || (hasObservedError ? observedErrorId.trim() : null);
    const stopErrorUndismissed = Boolean(
      active
      && settings.triggerOnStopError !== false
      && stopErrorId
      && !settings.dismissedErrorIds?.[stopErrorId],
    );

    const dismissed = Boolean(evaluation.exhaustionKey && settings.dismissedKeys?.[evaluation.exhaustionKey]);
    const previewModal = this.buildPreviewState(evaluation, settings);

    let modal = null;
    if (previewModal) {
      modal = previewModal;
    } else if (active && (stopErrorUndismissed || (evaluation.exhausted && !dismissed))) {
      modal = {
        isPreview: false,
        triggerReason: stopErrorUndismissed ? 'stop-error' : 'quota-exhausted',
        errorId: stopErrorUndismissed ? stopErrorId : null,
        exhaustionKey: evaluation.exhaustionKey,
        planLabel: evaluation.planLabel,
        modelLabel: evaluation.modelLabel,
        theme: evaluation.theme,
        resetSource: evaluation.effectiveResetSource,
        resetAt: evaluation.resetAt,
        formattedResetDate: evaluation.formattedResetDate,
        formattedRemaining: evaluation.formattedRemaining,
        serialId: stopErrorUndismissed
          ? stopErrorId
          : evaluation.serialId,
      };
    }

    return {
      enabled: active,
      settings,
      connection: this.quotaSummary ? 'live' : 'offline',
      error: this.lastError,
      fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
      evaluation,
      latestStopError: backendStopError,
      dismissed,
      modal,
    };
  }
}
