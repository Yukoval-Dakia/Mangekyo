import type {
  CalcArtifactBindingWire,
  CalcBindingsFreezeVerificationWire,
} from '@mangekyo/kernel';
import { isRecord, readNumber, readSafeInt, readTrimmed } from '../shared/safe-values';
import './artifact.css';

export type CalcMediaKind = CalcArtifactBindingWire['mediaKind'];

export type CalcBindingFreezeStatus = CalcBindingsFreezeVerificationWire['status'];

export type CalcSeriesSummary = NonNullable<CalcArtifactBindingWire['seriesSummary']>;

export type CalcArtifactBinding = CalcArtifactBindingWire & {
  readonly status?: CalcBindingFreezeStatus;
  readonly driftStatus?: CalcBindingFreezeStatus;
  readonly sourceLabel?: string;
};

export type CalcBindingFreezeEntry = CalcBindingsFreezeVerificationWire['entries'][number];

export type CalcBindingsFreezeVerification = CalcBindingsFreezeVerificationWire;

const HANDLE_PATTERN = /^@calc_[a-zA-Z0-9_-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const CALC_MEDIA_KIND_LABELS: Readonly<Record<CalcMediaKind, string>> = {
  table_json: '计算数据表',
  series_json: '数值序列',
  svg_plot: '矢量图像',
  png_plot: '位图图表',
};

const VALID_MEDIA_KINDS = new Set<CalcMediaKind>(['table_json', 'series_json', 'svg_plot', 'png_plot']);

function normalizeStatus(raw: unknown): CalcBindingFreezeStatus | undefined {
  if (raw === 'exact' || raw === 'fresh') return 'exact';
  if (raw === 'drifted_keep_frozen') return 'drifted_keep_frozen';
  if (raw === 'missing_keep_frozen') return 'missing_keep_frozen';
  return undefined;
}

export function mediaKindLabel(kind: string): string {
  if (Object.hasOwn(CALC_MEDIA_KIND_LABELS, kind)) {
    return CALC_MEDIA_KIND_LABELS[kind as CalcMediaKind];
  }
  return '计算产物';
}

export function normalizeCalcBinding(raw: unknown): CalcArtifactBinding | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.handle !== 'string' || !HANDLE_PATTERN.test(raw.handle)) return null;
  const artifactRev = readSafeInt(raw.artifactRev, 1);
  if (artifactRev === undefined) return null;
  if (typeof raw.outputSha256 !== 'string' || !SHA256_PATTERN.test(raw.outputSha256)) return null;

  const mediaKind: CalcMediaKind =
    typeof raw.mediaKind === 'string' && VALID_MEDIA_KINDS.has(raw.mediaKind as CalcMediaKind)
      ? (raw.mediaKind as CalcMediaKind)
      : 'table_json';
  const status = normalizeStatus(raw.status) ?? normalizeStatus(raw.driftStatus);
  const seriesRaw = isRecord(raw.seriesSummary) ? raw.seriesSummary : null;
  const pointCount = readNumber(seriesRaw?.pointCount);
  const unit = readTrimmed(seriesRaw?.unit);
  const xLabel = readTrimmed(seriesRaw?.xLabel);
  const yLabel = readTrimmed(seriesRaw?.yLabel);
  const seriesSummary: CalcSeriesSummary | undefined =
    pointCount !== undefined
      ? {
          pointCount: Math.max(0, Math.round(pointCount)),
          ...(unit ? { unit } : {}),
          ...(xLabel ? { xLabel } : {}),
          ...(yLabel ? { yLabel } : {}),
        }
      : undefined;
  const sourceLabel = readTrimmed(raw.sourceLabel);

  return {
    handle: raw.handle,
    artifactId: readTrimmed(raw.artifactId) ?? raw.handle,
    artifactRev,
    outputSha256: raw.outputSha256,
    producer: 'python_calculation_sandbox',
    mediaKind,
    frozenAtIso: typeof raw.frozenAtIso === 'string' ? raw.frozenAtIso : '',
    ...(seriesSummary ? { seriesSummary } : {}),
    ...(status ? { status } : {}),
    ...(sourceLabel ? { sourceLabel } : {}),
  };
}

export function normalizeCalcVerification(raw: unknown): CalcBindingsFreezeVerification | null {
  if (!isRecord(raw)) return null;
  const topStatus = normalizeStatus(raw.status);
  if (!topStatus || !Array.isArray(raw.entries)) return null;
  const entries: CalcBindingFreezeEntry[] = [];
  for (const item of raw.entries) {
    if (!isRecord(item)) continue;
    const entryStatus = normalizeStatus(item.status);
    if (
      typeof item.handle !== 'string' ||
      typeof item.artifactId !== 'string' ||
      typeof item.frozenRev !== 'number' ||
      typeof item.frozenSha256 !== 'string' ||
      !SHA256_PATTERN.test(item.frozenSha256) ||
      (item.currentSha256 !== undefined && (typeof item.currentSha256 !== 'string' || !SHA256_PATTERN.test(item.currentSha256))) ||
      !entryStatus
    ) {
      continue;
    }
    entries.push({
      handle: item.handle,
      artifactId: item.artifactId,
      frozenRev: item.frozenRev,
      frozenSha256: item.frozenSha256,
      ...(typeof item.currentRev === 'number' ? { currentRev: item.currentRev } : {}),
      ...(typeof item.currentSha256 === 'string' ? { currentSha256: item.currentSha256 } : {}),
      status: entryStatus,
      reason: typeof item.reason === 'string' ? item.reason : '',
    });
  }
  return {
    status: topStatus,
    preservedFrozen: true,
    entries,
  };
}

export function extractCalcBindingsFromUnknown(input: unknown): {
  readonly bindings: readonly CalcArtifactBinding[];
  readonly verification?: CalcBindingsFreezeVerification;
} | null {
  if (!isRecord(input)) return null;
  const collected: CalcArtifactBinding[] = [];
  const rawList = input.calcBindings;
  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      const normalized = normalizeCalcBinding(item);
      if (normalized) collected.push(normalized);
    }
  }
  if (input.calcBinding !== undefined) {
    const single = normalizeCalcBinding(input.calcBinding);
    if (single && !collected.some((b) => b.handle === single.handle && b.artifactRev === single.artifactRev)) {
      collected.push(single);
    }
  }
  const verification =
    normalizeCalcVerification(input.calcVerification) ??
    normalizeCalcVerification(input.calcFreezeVerification) ??
    normalizeCalcVerification(input.freezeVerification) ??
    undefined;

  if (collected.length === 0 && !verification) return null;
  return {
    bindings: collected,
    ...(verification ? { verification } : {}),
  };
}

function resolveStatus(
  binding: CalcArtifactBinding,
  verificationEntry?: CalcBindingFreezeEntry,
): CalcBindingFreezeStatus {
  return (
    verificationEntry?.status ??
    normalizeStatus(binding.status) ??
    normalizeStatus(binding.driftStatus) ??
    'exact'
  );
}

function statusMeta(status: CalcBindingFreezeStatus): {
  readonly tag: string;
  readonly tone: 'exact' | 'drifted' | 'missing';
} {
  if (status === 'drifted_keep_frozen') {
    return { tag: '源已更新 · 冻结不变', tone: 'drifted' };
  }
  if (status === 'missing_keep_frozen') {
    return { tag: '原产物缺失 · 冻结不变', tone: 'missing' };
  }
  return { tag: '已冻结', tone: 'exact' };
}

export function CalcBindingBadge({
  binding,
  verificationEntry,
  showDriftNotice = true,
}: {
  readonly binding: CalcArtifactBinding;
  readonly verificationEntry?: CalcBindingFreezeEntry | undefined;
  readonly showDriftNotice?: boolean | undefined;
}) {
  const status = resolveStatus(binding, verificationEntry);
  const meta = statusMeta(status);
  const shortHash = binding.outputSha256.slice(0, 8);
  const kindText = mediaKindLabel(binding.mediaKind);

  return (
    <div className="calc-binding-unit">
      <span
        className={`calc-binding-badge is-${meta.tone}`}
        title={`冻结出处 ${binding.handle} · v${binding.artifactRev} · SHA-256 ${binding.outputSha256}`}
      >
        <code className="calc-binding-handle">{binding.handle}</code>
        <span className="calc-binding-sep" aria-hidden="true">·</span>
        <span className="calc-binding-rev">v{binding.artifactRev}</span>
        <span className="calc-binding-sep" aria-hidden="true">·</span>
        <code className="calc-binding-hash">{shortHash}</code>
        <span className="calc-binding-kind">{kindText}</span>
        {binding.seriesSummary && (
          <span className="calc-binding-series">
            {binding.seriesSummary.pointCount} 点
            {binding.seriesSummary.unit ? ` ${binding.seriesSummary.unit}` : ''}
          </span>
        )}
        {binding.sourceLabel && <span className="calc-binding-source">{binding.sourceLabel}</span>}
        <span className={`calc-binding-state is-${meta.tone}`}>{meta.tag}</span>
      </span>

      {showDriftNotice && status !== 'exact' && (
        <CalcDriftNotice
          status={status}
          handle={binding.handle}
          frozenRev={verificationEntry?.frozenRev ?? binding.artifactRev}
          currentRev={verificationEntry?.currentRev}
          reason={verificationEntry?.reason}
        />
      )}
    </div>
  );
}

function CalcDriftNotice({
  status,
  handle,
  frozenRev,
  currentRev,
  reason,
}: {
  readonly status: 'drifted_keep_frozen' | 'missing_keep_frozen';
  readonly handle?: string | undefined;
  readonly frozenRev?: number | undefined;
  readonly currentRev?: number | undefined;
  readonly reason?: string | undefined;
}) {
  const isMissing = status === 'missing_keep_frozen';
  const headline = isMissing
    ? '原计算产物已缺失 · 历史版本已冻结，绝不追改旧课堂/对话'
    : '上游计算已更新 · 历史版本已冻结，绝不追改旧课堂/对话';

  const versionDetail =
    !isMissing && frozenRev !== undefined && currentRev !== undefined && currentRev !== frozenRev
      ? `（冻结于 v${frozenRev}，当前最新 v${currentRev}）`
      : frozenRev !== undefined
        ? `（保持冻结于 v${frozenRev}）`
        : '';

  return (
    <p className={`calc-drift-notice ${isMissing ? 'is-missing' : 'is-drifted'}`} role="note">
      <strong>{headline}</strong>
      {handle && (
        <span className="calc-drift-detail">
          {' '}
          <code>{handle}</code>
          {versionDetail}
        </span>
      )}
      {reason && reason.trim() && <span className="calc-drift-reason"> · {reason.trim()}</span>}
    </p>
  );
}

export function CalcBindingStrip({
  binding,
  bindings,
  verification,
  label = '冻结计算产物引用',
}: {
  readonly binding?: CalcArtifactBinding | null | undefined;
  readonly bindings?: readonly CalcArtifactBinding[] | null | undefined;
  readonly verification?: CalcBindingsFreezeVerification | null | undefined;
  readonly label?: string | undefined;
}) {
  const list: CalcArtifactBinding[] = [];
  if (bindings) {
    for (const item of bindings) list.push(item);
  }
  if (binding && !list.some((item) => item.handle === binding.handle && item.artifactRev === binding.artifactRev)) {
    list.push(binding);
  }

  const entryByHandle = new Map<string, CalcBindingFreezeEntry>();
  for (const entry of verification?.entries ?? []) {
    entryByHandle.set(entry.handle, entry);
  }

  if (list.length === 0 && (!verification || verification.status === 'exact')) {
    return null;
  }

  const driftedItems: {
    readonly key: string;
    readonly status: 'drifted_keep_frozen' | 'missing_keep_frozen';
    readonly handle?: string;
    readonly frozenRev?: number;
    readonly currentRev?: number;
    readonly reason?: string;
  }[] = [];

  const seenDriftedHandles = new Set<string>();
  for (const item of list) {
    const entry = entryByHandle.get(item.handle);
    const status = resolveStatus(item, entry);
    if (status === 'drifted_keep_frozen' || status === 'missing_keep_frozen') {
      seenDriftedHandles.add(item.handle);
      driftedItems.push({
        key: `${item.handle}:${item.artifactRev}`,
        status,
        handle: item.handle,
        frozenRev: entry?.frozenRev ?? item.artifactRev,
        ...(entry?.currentRev !== undefined ? { currentRev: entry.currentRev } : {}),
        ...(entry?.reason ? { reason: entry.reason } : {}),
      });
    }
  }

  if (verification) {
    for (let idx = 0; idx < verification.entries.length; idx += 1) {
      const entry = verification.entries[idx]!;
      if (entry.status !== 'drifted_keep_frozen' && entry.status !== 'missing_keep_frozen') continue;
      if (seenDriftedHandles.has(entry.handle)) continue;
      seenDriftedHandles.add(entry.handle);
      driftedItems.push({
        key: `verify:${entry.handle}:${entry.frozenRev}:${idx}`,
        status: entry.status,
        handle: entry.handle,
        frozenRev: entry.frozenRev,
        ...(entry.currentRev !== undefined ? { currentRev: entry.currentRev } : {}),
        ...(entry.reason ? { reason: entry.reason } : {}),
      });
    }
  }

  if (driftedItems.length === 0 && verification && verification.status !== 'exact') {
    driftedItems.push({
      key: 'verification',
      status: verification.status,
    });
  }

  return (
    <div className="calc-binding-strip" role="region" aria-label={label}>
      {list.length > 0 && (
        <div className="calc-binding-row">
          {list.map((item) => (
            <CalcBindingBadge
              key={`${item.handle}:${item.artifactId}:${item.artifactRev}`}
              binding={item}
              verificationEntry={entryByHandle.get(item.handle)}
              showDriftNotice={false}
            />
          ))}
        </div>
      )}
      {driftedItems.length > 0 && (
        <div className="calc-drift-stack">
          {driftedItems.map((item) => (
            <CalcDriftNotice
              key={item.key}
              status={item.status}
              handle={item.handle}
              frozenRev={item.frozenRev}
              currentRev={item.currentRev}
              reason={item.reason}
            />
          ))}
        </div>
      )}
    </div>
  );
}
