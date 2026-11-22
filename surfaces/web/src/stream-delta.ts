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
