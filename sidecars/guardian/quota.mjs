import { createHash } from 'node:crypto';

const THINKING_SUFFIX_RE = /(?:\s*\((?:Minimal|Min|Low|Medium|High|XHigh|Extra\s*High|Max|Thinking)\)|\s+(?:Minimal|Min|Low|Medium|High|XHigh|Extra\s*High|Max|Thinking))\s*$/i;

export function resolvePlanLabel(userStatus) {
  const userTier = userStatus?.userTier;
  const tierName = String(userTier?.name || '').trim();
  const tierId = String(userTier?.id || '').trim().toLowerCase();

  if (tierName) {
    return /^google/i.test(tierName) ? tierName : `Google AI ${tierName}`;
  }
  if (tierId) {
    if (tierId.includes('ultra')) return 'Google AI Ultra';
    if (tierId.includes('pro')) return 'Google AI Pro';
    if (tierId.includes('free')) return 'Google AI Free';
    if (tierId.includes('team')) return 'Google AI Teams';
    if (tierId.includes('enterprise')) return 'Google AI Enterprise';
  }

  const info = userStatus?.planStatus?.planInfo;
  const tier = String(info?.teamsTier || '').trim().toUpperCase();
  const planName = String(info?.planName || '').trim();

  if (tier === 'TEAMS_TIER_PRO_ULTIMATE' || /\bultra\b/i.test(planName)) {
    return 'Google AI Ultra';
  }
  if (tier === 'TEAMS_TIER_PRO' || /^pro$/i.test(planName)) {
    return 'Google AI Pro';
  }
  if (tier === 'TEAMS_TIER_FREE' || /^free$/i.test(planName)) {
    return 'Google AI Free';
  }
  if (tier === 'TEAMS_TIER_TEAMS' || /^teams?$/i.test(planName)) {
    return 'Google AI Teams';
  }
  if (tier.includes('ENTERPRISE') || /enterprise/i.test(planName)) {
    return 'Google AI Enterprise';
  }
  if (tier === 'TEAMS_TIER_HYBRID') {
    return 'Google AI Hybrid';
  }
  if (planName) {
    return /^google/i.test(planName) ? planName : `Google AI ${planName}`;
  }
  return 'Google AI';
}

export function normalizeModelName(rawModel, { includeTier = false } = {}) {
  const raw = String(rawModel || '').trim();
  if (!raw) return '';
  if (includeTier) return raw;
  return raw.replace(THINKING_SUFFIX_RE, '').trim() || raw;
}

export function detectThemeForModel(modelName, group, themePreference = 'auto') {
  if (themePreference === 'gemini' || themePreference === 'claude') {
    return themePreference;
  }
  const text = String(modelName || '');
  if (/claude|anthropic|opus|sonnet|haiku/i.test(text)) return 'claude';
  if (/gemini|orchestrator/i.test(text)) return 'gemini';
  const groupHint = `${group?.id || ''} ${group?.name || ''}`;
  if (/claude|3p/i.test(groupHint) && !/gemini/i.test(text)) return 'claude';
  return 'gemini';
}

export function parseQuotaGroups(response, now = Date.now()) {
  const root = response?.response || response || {};
  const groups = root.groups?.length
    ? root.groups
    : root.buckets?.length
      ? [{ displayName: '账户额度', buckets: root.buckets }]
      : [];

  return groups.map((group, index) => ({
    id: group.buckets?.[0]?.bucketId?.replace(/-(5h|weekly)$/, '') || `group-${index}`,
    name: group.displayName || `额度组 ${index + 1}`,
    description: group.description || '',
    windows: Object.fromEntries(
      ['5h', 'weekly'].map(windowName => {
        const bucket = (group.buckets || []).find(
          b => b.window === windowName || b.bucketId?.endsWith(`-${windowName}`),
        );
        if (!bucket) {
          return [windowName, { available: false, reason: '未返回此额度窗口' }];
        }
        const fraction = Number(bucket.remainingFraction);
        const remaining = bucket.remainingFraction !== undefined && Number.isFinite(fraction)
          ? Math.max(0, Math.min(1, fraction))
          : null;
        const resetMs = Date.parse(bucket.resetTime);
        return [
          windowName,
          {
            available: true,
            id: bucket.bucketId || `${windowName}`,
            remaining,
            resetAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
            expired: Number.isFinite(resetMs) && resetMs <= now,
            disabled: bucket.disabled === true,
            description: bucket.description || '',
          },
        ];
      }),
    ),
  }));
}

export function matchQuotaGroup(activeModel, groups = []) {
  if (!Array.isArray(groups) || !groups.length) return null;
  const clean = normalizeModelName(activeModel, { includeTier: false }).toLowerCase();
  if (clean) {
    for (const group of groups) {
      const desc = String(group.description || '');
      const match = desc.match(/models within this group:\s*(.+)$/i);
      if (!match) continue;
      const names = match[1].split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
      if (names.some(name => name === clean || clean.includes(name) || name.includes(clean))) {
        return group;
      }
    }
    if (/gemini|orchestrator/i.test(clean)) {
      const gemini = groups.find(g => /gemini/i.test(g.id) || /gemini/i.test(g.name));
      if (gemini) return gemini;
    }
    if (/claude|gpt|opus|sonnet|haiku|o1|o3|openai|anthropic/i.test(clean)) {
      const thirdParty = groups.find(g => /3p|claude|gpt/i.test(g.id) || /claude|gpt/i.test(g.name));
      if (thirdParty) return thirdParty;
    }
  }
  return groups[0];
}

export function formatResetDateTime(isoOrMs) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(ms)) return '待服务端同步';
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatRemainingDuration(ms) {
  if (!Number.isFinite(ms)) return '未知';
  if (ms <= 0) return '即将重置';
  const totalMinutes = Math.ceil(ms / 60000);
  if (totalMinutes < 1) return '不足1分钟';
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (days === 0 && minutes > 0) parts.push(`${minutes}分钟`);
  return parts.join('') || '不足1分钟';
}

export function buildSerialId(seed = '') {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const hash = createHash('sha256')
    .update(`${seed}:${stamp}`)
    .digest('hex')
    .toUpperCase()
    .slice(0, 14);
  return `AG${stamp}${hash}`;
}

function findClientModelConfig(userStatus, activeModel) {
  const configs = userStatus?.cascadeModelConfigData?.clientModelConfigs;
  if (!Array.isArray(configs) || !configs.length) return null;
  const raw = String(activeModel || '').trim().toLowerCase();
  const clean = normalizeModelName(activeModel, { includeTier: false }).toLowerCase();
  return (
    configs.find(c => String(c.label || '').trim().toLowerCase() === raw)
    || configs.find(c => normalizeModelName(c.label, { includeTier: false }).toLowerCase() === clean)
    || configs.find(c => String(c.modelId || '').trim().toLowerCase() === raw)
    || null
  );
}

export function evaluateExhaustion({
  activeModel = '',
  userStatus = null,
  quotaSummary = null,
  settings = {},
  now = Date.now(),
} = {}) {
  const planLabel = resolvePlanLabel(userStatus);
  const groups = parseQuotaGroups(quotaSummary, now);
  const rawModelLabel = String(activeModel || '').trim()
    || String(userStatus?.cascadeModelConfigData?.clientModelConfigs?.[0]?.label || '').trim()
    || 'Antigravity AI';
  const modelLabel = normalizeModelName(rawModelLabel, {
    includeTier: settings.includeThinkingTier === true,
  });

  const group = matchQuotaGroup(rawModelLabel, groups);
  const theme = detectThemeForModel(rawModelLabel, group, settings.themeMode || 'auto');

  const five = group?.windows?.['5h'] || { available: false };
  const week = group?.windows?.weekly || { available: false };

  const isZero = windowObj =>
    Boolean(windowObj?.available)
    && !windowObj.disabled
    && typeof windowObj.remaining === 'number'
    && windowObj.remaining <= 1e-6;

  const hasQuota = windowObj =>
    Boolean(windowObj?.available)
    && !windowObj.disabled
    && typeof windowObj.remaining === 'number'
    && windowObj.remaining > 1e-6;

  const fiveExhausted = isZero(five);
  const weekExhausted = isZero(week);

  let exhausted = false;
  let resetSource = null;
  let resetAt = null;

  if (weekExhausted) {
    exhausted = true;
    resetSource = 'weekly';
    resetAt = week.resetAt || five.resetAt || null;
  } else if (fiveExhausted) {
    exhausted = true;
    resetSource = hasQuota(week) || !week.available ? '5h' : 'weekly';
    resetAt = resetSource === '5h' ? (five.resetAt || null) : (week.resetAt || null);
  } else if (!group) {
    const modelCfg = findClientModelConfig(userStatus, rawModelLabel);
    const frac = Number(modelCfg?.quotaInfo?.remainingFraction);
    if (modelCfg?.quotaInfo && Number.isFinite(frac) && frac <= 1e-6) {
      exhausted = true;
      resetSource = '5h';
      const ms = Date.parse(modelCfg.quotaInfo.resetTime);
      resetAt = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
  }

  // Fallback reset estimate for stop-error triggered popups when quota isn't strictly 0
  const fallbackResetSource = resetSource || (hasQuota(week) || !week.available ? '5h' : 'weekly');
  const fallbackResetAt = resetAt || (fallbackResetSource === 'weekly' ? (week.resetAt || five.resetAt || null) : (five.resetAt || week.resetAt || null));

  const effectiveResetAt = resetAt || fallbackResetAt;
  const resetMs = effectiveResetAt ? Date.parse(effectiveResetAt) : NaN;
  const remainingMs = Number.isFinite(resetMs) ? Math.max(0, resetMs - now) : null;
  const formattedResetDate = Number.isFinite(resetMs) ? formatResetDateTime(resetMs) : '待服务端同步';
  const formattedRemaining = remainingMs !== null ? formatRemainingDuration(remainingMs) : '未知';
  const exhaustionKey = exhausted
    ? `${group?.id || 'model'}:${resetSource || 'unknown'}:${resetAt || 'pending'}`
    : null;

  const fiveMs = five.resetAt ? Date.parse(five.resetAt) : NaN;
  const weekMs = week.resetAt ? Date.parse(week.resetAt) : NaN;

  return {
    planLabel,
    modelLabel,
    rawModelLabel,
    groupId: group?.id || null,
    groupName: group?.name || null,
    theme,
    exhausted,
    resetSource,
    effectiveResetSource: resetSource || fallbackResetSource,
    resetAt: effectiveResetAt,
    resetMs: Number.isFinite(resetMs) ? resetMs : null,
    remainingMs,
    formattedResetDate,
    formattedRemaining,
    exhaustionKey,
    serialId: buildSerialId(`${planLabel}:${modelLabel}:${exhaustionKey || 'preview'}`),
    windows: {
      fiveHour: {
        ...five,
        formattedReset: Number.isFinite(fiveMs) ? formatResetDateTime(fiveMs) : null,
        formattedRemaining: Number.isFinite(fiveMs) ? formatRemainingDuration(Math.max(0, fiveMs - now)) : null,
      },
      weekly: {
        ...week,
        formattedReset: Number.isFinite(weekMs) ? formatResetDateTime(weekMs) : null,
        formattedRemaining: Number.isFinite(weekMs) ? formatRemainingDuration(Math.max(0, weekMs - now)) : null,
      },
    },
    groups: groups.map(g => ({
      id: g.id,
      name: g.name,
      description: g.description,
      windows: Object.fromEntries(
        Object.entries(g.windows).map(([k, w]) => {
          const wMs = w.resetAt ? Date.parse(w.resetAt) : NaN;
          return [
            k,
            {
              ...w,
              formattedReset: Number.isFinite(wMs) ? formatResetDateTime(wMs) : null,
              formattedRemaining: Number.isFinite(wMs) ? formatRemainingDuration(Math.max(0, wMs - now)) : null,
            },
          ];
        }),
      ),
    })),
  };
}
