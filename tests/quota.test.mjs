import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolvePlanLabel,
  normalizeModelName,
  detectThemeForModel,
  evaluateExhaustion,
  formatResetDateTime,
  formatRemainingDuration,
} from '../sidecars/guardian/quota.mjs';
import { SettingsStore } from '../sidecars/guardian/settings.mjs';
import { QuotaMonitor } from '../sidecars/guardian/monitor.mjs';

const sampleSummary = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen',
        buckets: [
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: '2026-12-01T01:00:00Z' },
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0, resetTime: '2026-11-26T10:30:00Z' },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
        buckets: [
          { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0, resetTime: '2026-12-03T05:28:00Z' },
          { bucketId: '3p-5h', window: '5h', remainingFraction: 0, resetTime: '2026-11-26T10:28:00Z' },
        ],
      },
    ],
  },
};

test('resolvePlanLabel prioritizes userTier (e.g. Ultra) over legacy planStatus.planInfo (Pro)', () => {
  assert.equal(
    resolvePlanLabel({
      userTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' },
      planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } },
    }),
    'Google AI Ultra',
  );
  assert.equal(
    resolvePlanLabel({
      userTier: { id: 'g1-ultra-tier' },
      planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } },
    }),
    'Google AI Ultra',
  );
  assert.equal(resolvePlanLabel({ planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } } }), 'Google AI Pro');
  assert.equal(resolvePlanLabel({ planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO_ULTIMATE', planName: 'Ultra' } } }), 'Google AI Ultra');
  assert.equal(resolvePlanLabel({ planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_FREE', planName: 'Free' } } }), 'Google AI Free');
  assert.equal(resolvePlanLabel({ planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_TEAMS', planName: 'Teams' } } }), 'Google AI Teams');
  assert.equal(resolvePlanLabel({ planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_ENTERPRISE_SAAS' } } }), 'Google AI Enterprise');
  assert.equal(resolvePlanLabel({ planStatus: { planInfo: { planName: 'Plus' } } }), 'Google AI Plus');
  assert.equal(resolvePlanLabel(null), 'Google AI');
});

test('normalizeModelName and detectThemeForModel handle Gemini and Claude variants', () => {
  assert.equal(normalizeModelName('Gemini 4 Carbon (High)'), 'Gemini 4 Carbon');
  assert.equal(normalizeModelName('Gemini 4 Carbon High'), 'Gemini 4 Carbon');
  assert.equal(normalizeModelName('Gemini 4 Neon (XHigh)'), 'Gemini 4 Neon');
  assert.equal(normalizeModelName('Gemini 4 Carbon (High)', { includeTier: true }), 'Gemini 4 Carbon (High)');
  assert.equal(normalizeModelName('Claude Opus 5.5 (Medium)'), 'Claude Opus 5.5');
  assert.equal(normalizeModelName('Claude Opus 5.5 Medium'), 'Claude Opus 5.5');
  assert.equal(normalizeModelName('Gemini 3.8 Flash Low'), 'Gemini 3.8 Flash');

  assert.equal(detectThemeForModel('Gemini 4 Carbon (High)', null, 'auto'), 'gemini');
  assert.equal(detectThemeForModel('Claude Opus 5.5 (High)', null, 'auto'), 'claude');
  assert.equal(detectThemeForModel('Gemini 4 Carbon', null, 'claude'), 'claude');
  assert.equal(detectThemeForModel('Claude Opus 5.5', null, 'gemini'), 'gemini');
});

test('evaluateExhaustion uses 5h reset when weekly still has quota, and weekly reset when weekly is exhausted', () => {
  const now = Date.parse('2026-11-26T06:30:00Z');
  const userStatus = { planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } } };

  // Case 1: Gemini 5h = 0, Weekly = 0.4 -> should use 5h reset
  const geminiEval = evaluateExhaustion({
    activeModel: 'Gemini 4 Carbon (High)',
    userStatus,
    quotaSummary: sampleSummary,
    now,
  });
  assert.equal(geminiEval.planLabel, 'Google AI Pro');
  assert.equal(geminiEval.modelLabel, 'Gemini 4 Carbon');
  assert.equal(geminiEval.theme, 'gemini');
  assert.equal(geminiEval.exhausted, true);
  assert.equal(geminiEval.resetSource, '5h');
  assert.equal(geminiEval.resetAt, '2026-11-26T10:30:00.000Z');
  assert.equal(geminiEval.formattedRemaining, '4小时');

  // Case 2: Claude 5h = 0, Weekly = 0 -> should use weekly reset
  const claudeEval = evaluateExhaustion({
    activeModel: 'Claude Opus 5.5 (Medium)',
    userStatus,
    quotaSummary: sampleSummary,
    now,
  });
  assert.equal(claudeEval.modelLabel, 'Claude Opus 5.5');
  assert.equal(claudeEval.theme, 'claude');
  assert.equal(claudeEval.exhausted, true);
  assert.equal(claudeEval.resetSource, 'weekly');
  assert.equal(claudeEval.resetAt, '2026-12-03T05:28:00.000Z');
  assert.equal(claudeEval.formattedRemaining, '6天22小时');
});

test('evaluateExhaustion returns exhausted=false when both 5h and weekly have quota', () => {
  const now = Date.parse('2026-11-26T06:30:00Z');
  const healthySummary = {
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini 4 Hydrogen',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.2, resetTime: '2026-12-01T01:00:00Z' },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: '2026-11-26T10:30:00Z' },
          ],
        },
      ],
    },
  };
  const res = evaluateExhaustion({
    activeModel: 'Gemini 4 Hydrogen (High)',
    userStatus: { planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } } },
    quotaSummary: healthySummary,
    now,
  });
  assert.equal(res.exhausted, false);
  assert.equal(res.resetSource, null);
});

test('formatResetDateTime and formatRemainingDuration format cleanly', () => {
  const formatted = formatResetDateTime('2026-11-26T10:28:00Z');
  assert.match(formatted, /^\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}$/);
  assert.equal(formatRemainingDuration(0), '即将重置');
  assert.equal(formatRemainingDuration(30 * 1000), '1分钟');
  assert.equal(formatRemainingDuration((4 * 3600 + 12 * 60) * 1000), '4小时12分钟');
});

test('QuotaMonitor persists dismissals and handles previews', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-aa-test-'));
  try {
    let fakeNow = Date.parse('2026-11-26T06:30:00Z');
    const settings = new SettingsStore({ file: join(dir, 'settings.json'), now: () => fakeNow });
    const mockClient = {
      async call(method) {
        if (method === 'GetUserStatus') {
          return { userStatus: { planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } } } };
        }
        if (method === 'RetrieveUserQuotaSummary') return sampleSummary;
        return {};
      },
    };
    const monitor = new QuotaMonitor({
      client: mockClient,
      settings,
      now: () => fakeNow,
      isDisabled: () => false,
    });

    const s1 = await monitor.snapshot({ uiModel: 'Gemini 4 Carbon (High)' });
    assert.ok(s1.modal);
    assert.equal(s1.modal.theme, 'gemini');
    assert.equal(s1.modal.modelLabel, 'Gemini 4 Carbon');

    // Dismissing hides modal for the same exhaustion key
    await settings.dismiss(s1.modal.exhaustionKey);
    const s2 = await monitor.snapshot({ uiModel: 'Gemini 4 Carbon (High)' });
    assert.equal(s2.modal, null);
    assert.equal(s2.dismissed, true);

    // Switching to another exhausted group (Claude) triggers its own modal
    const s3 = await monitor.snapshot({ uiModel: 'Claude Opus 5.5 (Low)' });
    assert.ok(s3.modal);
    assert.equal(s3.modal.theme, 'claude');
    assert.equal(s3.modal.resetSource, 'weekly');

    // Preview overrides dismissed state temporarily
    const prev = monitor.triggerPreview({ scenario: 'gemini-5h' });
    const s4 = await monitor.snapshot({ uiModel: 'Gemini 4 Carbon (High)' });
    assert.ok(s4.modal?.isPreview);
    assert.equal(s4.modal.previewId, prev.id);

    monitor.dismissPreview(prev.id);
    const s5 = await monitor.snapshot({ uiModel: 'Gemini 4 Carbon (High)' });
    assert.equal(s5.modal, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('QuotaMonitor re-triggers modal on every new stop error even after window dismissal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-aa-err-'));
  try {
    let fakeNow = Date.parse('2026-11-26T06:34:00Z');
    const convoId = 'a5579aed-50d3-43ea-90b1-c870e743ddf6';
    const settings = new SettingsStore({ file: join(dir, 'settings.json'), now: () => fakeNow });
    let errorId = null;

    const mockClient = {
      async call(method) {
        if (method === 'GetUserStatus') {
          return {
            userStatus: {
              userTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' },
              planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } },
            },
          };
        }
        if (method === 'RetrieveUserQuotaSummary') return sampleSummary;
        if (method === 'GetAllCascadeTrajectories') {
          return { trajectorySummaries: { [convoId]: { stepCount: 150 } } };
        }
        if (method === 'GetCascadeTrajectorySteps') {
          return {
            steps: errorId
              ? [{
                  type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
                  metadata: { createdAt: new Date(fakeNow).toISOString() },
                  errorMessage: { error: { errorId, userErrorMessage: 'Your AI credits balance is too low to continue.' } },
                }]
              : [],
          };
        }
        return {};
      },
    };

    const monitor = new QuotaMonitor({
      client: mockClient,
      settings,
      now: () => fakeNow,
      isDisabled: () => false,
    });

    // Initial exhaustion modal shows Google AI Ultra
    const s1 = await monitor.snapshot({ uiModel: 'Gemini 4 Carbon (High)', conversationId: convoId });
    assert.equal(s1.modal.planLabel, 'Google AI Ultra');
    await settings.dismiss({ exhaustionKey: s1.modal.exhaustionKey });

    // Confirming suppresses normal poll
    const s2 = await monitor.snapshot({ uiModel: 'Gemini 4 Carbon (High)', conversationId: convoId });
    assert.equal(s2.modal, null);

    // First stop error arrives -> modal pops up again!
    fakeNow += 3000;
    errorId = '38ca8acd-b8f9-4416-afc9-f82f39a03f04-145-2008';
    const s3 = await monitor.snapshot({ uiModel: 'Claude Opus 5.5 Medium', conversationId: convoId, force: true });
    assert.ok(s3.modal);
    assert.equal(s3.modal.triggerReason, 'stop-error');
    assert.equal(s3.modal.errorId, errorId);
    assert.equal(s3.modal.serialId, errorId);
    assert.equal(s3.modal.modelLabel, 'Claude Opus 5.5');
    assert.equal(s3.modal.planLabel, 'Google AI Ultra');

    // Dismiss first stop error
    await settings.dismiss({ exhaustionKey: s3.modal.exhaustionKey, errorId: s3.modal.errorId });
    const s4 = await monitor.snapshot({ uiModel: 'Gemini 4 Carbon (High)', conversationId: convoId });
    assert.equal(s4.modal, null);

    // Second stop error arrives -> modal pops up AGAIN!
    fakeNow += 3000;
    errorId = '38ca8acd-b8f9-4416-afc9-f82f39a03f04-147-2008';
    const s5 = await monitor.snapshot({ uiModel: 'Gemini 4 Carbon (High)', conversationId: convoId, force: true });
    assert.ok(s5.modal);
    assert.equal(s5.modal.triggerReason, 'stop-error');
    assert.equal(s5.modal.errorId, errorId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
