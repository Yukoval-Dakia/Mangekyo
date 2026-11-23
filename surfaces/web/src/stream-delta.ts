export type LiveToolStep = {
  id: string;
  name: string;
  label: string;
  summary?: string;
  status: "running" | "done" | "error";
  durationMs?: number;
};

export type ActivityEvent =
  | { turnId: string; kind: "thinking"; delta: string }
  | { turnId: string; kind: "tool"; step: LiveToolStep };

export type DeltaEventChunk = {
  turnId: string;
  seq: number;
  delta: string;
};

export type DeltaState = {
  turnId: string;
  lastSeq: number;
  text: string;
};

export function parseActivityEvent(data: string): ActivityEvent | undefined {
  let value: unknown;
  try { value = JSON.parse(data); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.turnId !== "string" || !record.turnId) return undefined;
  if (record.kind === "thinking" && typeof record.delta === "string" && record.delta) {
    return { turnId: record.turnId, kind: "thinking", delta: record.delta };
  }
  if (record.kind === "tool" && record.step && typeof record.step === "object" && !Array.isArray(record.step)) {
    const s = record.step as Record<string, unknown>;
    if (typeof s.id !== "string" || !s.id || typeof s.name !== "string" || !s.name ||
        typeof s.label !== "string" || !s.label ||
        (s.status !== "running" && s.status !== "done" && s.status !== "error")) return undefined;
    const step: LiveToolStep = {
      id: s.id, name: s.name, label: s.label, status: s.status,
      ...(typeof s.summary === "string" && s.summary ? { summary: s.summary } : {}),
      ...(typeof s.durationMs === "number" && Number.isFinite(s.durationMs) && s.durationMs >= 0 ? { durationMs: s.durationMs } : {}),
    };
    return { turnId: record.turnId, kind: "tool", step };
  }
  return undefined;
}

export function upsertToolStep(steps: readonly LiveToolStep[], next: LiveToolStep): readonly LiveToolStep[] {
  const index = steps.findIndex(item => item.id === next.id);
  if (index === -1) return [...steps, next];
  const prev = steps[index]!;
  const merged: LiveToolStep = {
    ...prev,
    ...next,
    ...(next.summary !== undefined ? { summary: next.summary } : prev.summary !== undefined ? { summary: prev.summary } : {}),
  };
  return [...steps.slice(0, index), merged, ...steps.slice(index + 1)];
}

export function parseDeltaEvent(data: string): DeltaEventChunk | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { turnId, seq, delta } = value as Record<string, unknown>;
  if (typeof turnId !== "string" || !turnId ||
      typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 ||
      typeof delta !== "string") return undefined;
  return { turnId, seq, delta };
}

export function applyDeltaChunk(
  state: DeltaState | undefined,
  chunk: DeltaEventChunk,
  activeTurnId: string | undefined,
): DeltaState | undefined {
  if (chunk.turnId !== activeTurnId) return state;
  if (state?.turnId === chunk.turnId) {
    if (chunk.seq <= state.lastSeq) return state;
    return { turnId: chunk.turnId, lastSeq: chunk.seq, text: state.text + chunk.delta };
  }
  return { turnId: chunk.turnId, lastSeq: chunk.seq, text: chunk.delta };
}

export function reconcileProgressText(
  state: DeltaState | undefined,
  progressText: string | undefined,
): string | undefined {
  if (progressText === undefined) return state ? state.text : undefined;
  if (!state) return progressText;
  return progressText.length > state.text.length ? progressText : state.text;
}

export function progressDeltaState(turnId: string, message: string | undefined): DeltaState | undefined {
  return message === undefined ? undefined : { turnId, lastSeq: -1, text: message };
}

function outsideCode(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .filter((part, index) => index % 2 === 0)
    .join("");
}

export function stabilizeStreamingText(text: string): string {
  if (((text.match(/```/g) ?? []).length) % 2 === 1) return `${text}\n\`\`\``;
  const dollars = (outsideCode(text).match(/\$/g) ?? []).length;
  return dollars % 2 === 1 ? `${text}$` : text;
}
