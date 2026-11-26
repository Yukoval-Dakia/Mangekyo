import { useEffect, useState } from 'react';
import { api, ApiError, remember, remembered, requestId } from '../api';
import type { CampaignMode, CampaignModeCardProps } from './types';

const LOCAL_OVERRIDE_KEY = 'campaign-mode-override';

export const CAMPAIGN_MODE_OPTIONS: readonly {
  readonly id: CampaignMode;
  readonly label: string;
  readonly tag: string;
  readonly description: string;
}[] = [
  {
    id: 'steady',
    label: '日常稳步',
    tag: '平时主节奏',
    description: '均衡巩固、新学与错因清账',
  },
  {
    id: 'sprint',
    label: '考前冲刺',
    tag: '考前 ≤ 7 天',
    description: '考前 ≤ 7 天聚焦高频错因、速查页与限时自测',
  },
  {
    id: 'decompress',
    label: '考后复盘减压',
    tag: '考后轻负荷',
    description: '轻负荷错题归因、暂停高压刷题',
  },
] as const;

type StoredPlanRule = {
  id: string;
  rev: number;
  data: {
    kind: string;
    campaign?: string;
    date?: string;
  };
};

type CampaignStatePayload = {
  phase?: unknown;
  source?: unknown;
  label?: unknown;
  description?: unknown;
  daysToExam?: unknown;
  daysSinceExam?: unknown;
  activeExamDate?: unknown;
};

type TodayCampaignResponse = {
  day?: string;
  campaign?: string | CampaignStatePayload;
  campaignState?: CampaignStatePayload;
  recommendedCampaign?: string;
  campaignReason?: string;
  daysToExam?: number | null;
  rules?: readonly StoredPlanRule[];
};

function asCampaignStatePayload(value: unknown): CampaignStatePayload | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as CampaignStatePayload)
    : null;
}

type LocalOverride = {
  mode: CampaignMode;
  updatedAt: string;
};

export function normalizeCampaignMode(value: unknown): CampaignMode | null {
  if (value === 'steady') return 'steady';
  if (value === 'sprint') return 'sprint';
  if (value === 'decompress' || value === 'recovery') return 'decompress';
  return null;
}

function campaignLabel(mode: CampaignMode): string {
  return CAMPAIGN_MODE_OPTIONS.find((item) => item.id === mode)?.label ?? '日常稳步';
}

function readLocalOverride(): LocalOverride | null {
  try {
    const raw = remembered(LOCAL_OVERRIDE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { mode?: unknown; updatedAt?: unknown } | null;
    const mode = normalizeCampaignMode(parsed?.mode);
    if (!mode) return null;
    return {
      mode,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return null;
  }
}

function saveLocalOverride(mode: CampaignMode | null): void {
  if (mode === null) {
    remember(LOCAL_OVERRIDE_KEY, null);
    return;
  }
  remember(LOCAL_OVERRIDE_KEY, JSON.stringify({ mode, updatedAt: new Date().toISOString() }));
}

function calendarDaysBetween(fromDay: string, toDay: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay)) return null;
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

function deriveFromExamRules(
  rules: readonly StoredPlanRule[],
  day: string | undefined,
): { recommended: CampaignMode; daysToExam: number | null; reason?: string } {
  const today =
    day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : new Date().toISOString().slice(0, 10);
  const examDates = rules
    .filter((rule) => rule?.data?.kind === 'exam' && typeof rule.data.date === 'string')
    .map((rule) => rule.data.date!)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));

  if (examDates.length === 0) {
    return { recommended: 'steady', daysToExam: null };
  }

  const upcoming = examDates.filter((d) => d >= today).sort((a, b) => a.localeCompare(b))[0];
  const recentPast = examDates.filter((d) => d < today).sort((a, b) => b.localeCompare(a))[0];

  if (upcoming) {
    const delta = calendarDaysBetween(today, upcoming);
    if (delta !== null && delta <= 7) {
      return {
        recommended: 'sprint',
        daysToExam: delta,
        reason: delta === 0 ? '今日有已登记的考试日程' : `距最近考试还有 ${delta} 天（≤ 7 天）`,
      };
    }
    if (recentPast) {
      const since = calendarDaysBetween(recentPast, today);
      if (since !== null && since > 0 && since <= 2) {
        return {
          recommended: 'decompress',
          daysToExam: -since,
          reason: `距上次考试结束仅 ${since} 天，建议先轻负荷复盘减压`,
        };
      }
    }
    return {
      recommended: 'steady',
      daysToExam: delta,
      ...(delta !== null ? { reason: `距下次考试还有 ${delta} 天，适合保持稳步积累` } : {}),
    };
  }

  if (recentPast) {
    const since = calendarDaysBetween(recentPast, today);
    if (since !== null && since > 0 && since <= 2) {
      return {
        recommended: 'decompress',
        daysToExam: -since,
        reason: `刚考完 ${since} 天，建议先轻负荷错题归因`,
      };
    }
  }

  return { recommended: 'steady', daysToExam: null };
}

export function CampaignModeCard({ recommendation, onCampaignChange }: CampaignModeCardProps) {
  const [localOverride, setLocalOverride] = useState<LocalOverride | null>(() => readLocalOverride());
  const [recommended, setRecommended] = useState<CampaignMode | null>(
    recommendation?.recommended ?? null,
  );
  const [recommendedReason, setRecommendedReason] = useState<string>(recommendation?.reason ?? '');
  const [daysToExam, setDaysToExam] = useState<number | null>(recommendation?.daysToExam ?? null);
  const [serverActive, setServerActive] = useState<CampaignMode | null>(
    recommendation?.active ?? null,
  );
  const [manualRule, setManualRule] = useState<StoredPlanRule | null>(null);
  const [loading, setLoading] = useState(!recommendation);
  const [saving, setSaving] = useState(false);
  const [syncNotice, setSyncNotice] = useState<{ tone: 'ok' | 'local' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (recommendation) {
      setRecommended(recommendation.recommended ?? null);
      setRecommendedReason(recommendation.reason ?? '');
      setDaysToExam(recommendation.daysToExam ?? null);
      setServerActive(recommendation.active ?? null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    async function load() {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setLoading(false);
        return;
      }
      try {
        const data = await api<TodayCampaignResponse>(
          `/today?timeZone=${encodeURIComponent(tz)}`,
          { signal: controller.signal, cache: 'no-store' },
        );
        if (controller.signal.aborted) return;

        const rules = Array.isArray(data?.rules) ? data.rules : [];
        const existingCampaignRule =
          [...rules].reverse().find((rule) => rule?.data?.kind === 'campaign') ?? null;
        setManualRule(existingCampaignRule);

        const statePayload =
          asCampaignStatePayload(data?.campaignState) ?? asCampaignStatePayload(data?.campaign);
        const activeFromServer = normalizeCampaignMode(statePayload?.phase ?? data?.campaign);
        setServerActive(activeFromServer);

        const derived = deriveFromExamRules(rules, data?.day);
        const explicitRecommended =
          normalizeCampaignMode(data?.recommendedCampaign) ??
          (statePayload && statePayload.source !== 'manual'
            ? normalizeCampaignMode(statePayload.phase)
            : null);
        const resolvedRecommended = explicitRecommended ?? derived.recommended;
        setRecommended(resolvedRecommended);

        const explicitDays =
          typeof data?.daysToExam === 'number' && Number.isFinite(data.daysToExam)
            ? data.daysToExam
            : typeof statePayload?.daysToExam === 'number' && Number.isFinite(statePayload.daysToExam)
              ? statePayload.daysToExam
              : derived.daysToExam;
        setDaysToExam(explicitDays);

        const explicitReason =
          typeof data?.campaignReason === 'string' && data.campaignReason.trim()
            ? data.campaignReason.trim()
            : typeof statePayload?.description === 'string' && statePayload.description.trim()
              ? statePayload.description.trim()
              : derived.reason ?? '';
        setRecommendedReason(explicitReason);
      } catch {
        // 离线或服务未就绪时保持本机视图偏好可用，绝不伪造后端建议。
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void load();
    return () => controller.abort();
  }, [recommendation]);

  const activeMode: CampaignMode =
    localOverride?.mode ?? serverActive ?? recommended ?? 'steady';
  const hasManualOverride =
    Boolean(localOverride) || Boolean(manualRule) || Boolean(recommendation?.manualOverride);

  async function refreshManualRule() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    try {
      const data = await api<TodayCampaignResponse>(
        `/today?timeZone=${encodeURIComponent(tz)}`,
        { cache: 'no-store' },
      );
      const rules = Array.isArray(data?.rules) ? data.rules : [];
      const existingCampaignRule =
        [...rules].reverse().find((rule) => rule?.data?.kind === 'campaign') ?? null;
      setManualRule(existingCampaignRule);
      const statePayload =
        asCampaignStatePayload(data?.campaignState) ?? asCampaignStatePayload(data?.campaign);
      const activeFromServer = normalizeCampaignMode(statePayload?.phase ?? data?.campaign);
      if (activeFromServer) setServerActive(activeFromServer);
    } catch {
      // 忽略刷新失败
    }
  }

  async function persistCampaignRule(mode: CampaignMode): Promise<'synced' | 'local'> {
    const commit = (wireCampaign: string) =>
      api('/today/rules', {
        method: 'POST',
        body: {
          requestId: requestId(),
          ...(manualRule ? { id: manualRule.id } : {}),
          expectedRev: manualRule?.rev ?? null,
          data: { kind: 'campaign', campaign: wireCampaign },
        },
      });

    try {
      await commit(mode);
      return 'synced';
    } catch (failure) {
      // 向后兼容：在域 3 后端将 recovery 升级为 decompress 之前，若 400 拒绝 decompress 则用 recovery 持久化同一减压态。
      if (mode === 'decompress' && failure instanceof ApiError && failure.status === 400) {
        try {
          await commit('recovery');
          return 'synced';
        } catch {
          return 'local';
        }
      }
      return 'local';
    }
  }

  async function selectMode(mode: CampaignMode) {
    if (saving) return;
    setSaving(true);
    saveLocalOverride(mode);
    setLocalOverride({ mode, updatedAt: new Date().toISOString() });
    onCampaignChange?.(mode);

    const status = await persistCampaignRule(mode);
    if (status === 'synced') {
      setServerActive(mode);
      await refreshManualRule();
      setSyncNotice({
        tone: 'ok',
        text: `已切换为「${campaignLabel(mode)}」并同步至计划引擎。`,
      });
    } else {
      setSyncNotice({
        tone: 'local',
        text: '已保存本机视图偏好，待同步至计划引擎。',
      });
    }
    setSaving(false);
  }

  async function resetToAutomatic() {
    if (saving) return;
    setSaving(true);
    saveLocalOverride(null);
    setLocalOverride(null);

    if (manualRule) {
      try {
        await api('/today/rules', {
          method: 'POST',
          body: {
            requestId: requestId(),
            id: manualRule.id,
            expectedRev: manualRule.rev,
            data: null,
          },
        });
        setManualRule(null);
        await refreshManualRule();
        const fallbackMode = recommended ?? 'steady';
        onCampaignChange?.(fallbackMode);
        setSyncNotice({
          tone: 'ok',
          text: `已恢复自动节奏（当前建议：${campaignLabel(fallbackMode)}）。`,
        });
      } catch {
        setSyncNotice({
          tone: 'local',
          text: '已清除本机覆盖偏好，待联机同步至计划引擎。',
        });
      }
    } else {
      const fallbackMode = recommended ?? 'steady';
      onCampaignChange?.(fallbackMode);
      setSyncNotice({
        tone: 'ok',
        text: `已恢复自动节奏（${campaignLabel(fallbackMode)}）。`,
      });
    }
    setSaving(false);
  }

  const recommendationLine = (() => {
    if (loading) return '正在读取当前计划节奏与考试日程…';
    if (recommended) {
      const label = campaignLabel(recommended);
      if (recommendedReason) return `系统建议：${label} · ${recommendedReason}`;
      if (typeof daysToExam === 'number' && daysToExam >= 0) {
        return `系统建议：${label} · 距最近考试还有 ${daysToExam} 天`;
      }
      return `系统建议：${label}`;
    }
    return '尚未连线计划引擎推荐；可先显式选择本机节奏偏好。';
  })();

  return (
    <section className="me-v2-card me-v2-campaign" aria-labelledby="me-v2-campaign-title">
      <div className="me-v2-card-head">
        <div>
          <h2 id="me-v2-campaign-title">宏观战役态</h2>
          <p className="me-v2-card-sub">
            按考试节点自动调节「今天」的选材强度，也可随时手动覆盖为当前需要的节奏。
          </p>
        </div>
        {hasManualOverride && (
          <button
            type="button"
            className="me-v2-tonal me-v2-campaign-reset"
            disabled={saving}
            onClick={() => void resetToAutomatic()}
          >
            恢复自动推荐
          </button>
        )}
      </div>

      <div className="me-v2-campaign-banner" role="status">
        <span className="me-v2-campaign-banner-copy">{recommendationLine}</span>
        {hasManualOverride && (
          <span className="me-v2-campaign-chip">已手动覆盖</span>
        )}
      </div>

      <div
        className="me-v2-campaign-grid"
        role="radiogroup"
        aria-label="选择宏观战役态"
      >
        {CAMPAIGN_MODE_OPTIONS.map((option) => {
          const selected = activeMode === option.id;
          const isRecommended = recommended === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={saving}
              className={`me-v2-campaign-option ${selected ? 'is-selected' : ''}`}
              onClick={() => void selectMode(option.id)}
            >
              <div className="me-v2-campaign-option-head">
                <strong>{option.label}</strong>
                <span className={`me-v2-campaign-tag ${isRecommended ? 'is-recommended' : ''}`}>
                  {isRecommended ? '系统推荐' : option.tag}
                </span>
              </div>
              <p>{option.description}</p>
            </button>
          );
        })}
      </div>

      {syncNotice && (
        <p
          role="status"
          className={`me-v2-campaign-notice is-${syncNotice.tone}`}
        >
          {syncNotice.text}
        </p>
      )}
    </section>
  );
}
