// Pure helpers extracted from runtime/studio/organizer.ts.
// All tx, handle, bus.mutate, snapshot reads stay in the runtime host;
// this module owns validation, error translation, and pure payload shaping.

export type RequestErrorCtor = new (status: number, message: string) => Error;

export function validateOrganizerInput<I, V>(E: RequestErrorCtor, parse: (i: I) => V, input: I): V {
  try { return parse(input); }
  catch (error) { throw new E(400, error instanceof Error ? error.message : '内容格式无效。'); }
}

export function translateOrganizerError(
  deps: { RequestError: RequestErrorCtor; isNotFound: (e: unknown) => boolean; isDenied: (e: unknown) => boolean },
  error: unknown,
): Error {
  const { RequestError: E, isNotFound, isDenied } = deps;
  if (error instanceof E) return error;
  if (isNotFound(error)) return new E(400, '链接的材料或要恢复的版本不存在。');
  if (isDenied(error)) return new E(403, '这份材料当前无法链接。');
  if (error instanceof Error) {
    if (error.message === 'Command ID already used with a different command identity')
      return new E(409, '同一个请求标识已经用于不同内容。');
    if (error.message.startsWith('Fact revision conflict: '))
      return new E(409, '这条记录已在别处更新。请刷新后再试。');
    if (error.message.startsWith('Fact does not exist: '))
      return new E(404, '这条记录不存在。');
    if (error.message.startsWith('Fact is retracted: '))
      return new E(409, '这条记录已经撤回。');
  }
  return error instanceof Error ? error : new Error('安排保存失败。');
}

export function parseOrganizerOpenKind(E: RequestErrorCtor, kind: string | null): 'pack' | 'material' | 'activity' {
  if (kind === 'pack' || kind === 'material') return kind;
  if (kind !== 'activity') throw new E(400, '活动类型无效。');
  return 'activity';
}

export function organizerMaterialOpenResult(id: string, rev: number) {
  return { kind: 'material' as const, id, rev, href: '/materials/saved/' + encodeURIComponent(id) };
}

export function organizerActivityOpenResult(id: string, rev: number) {
  return { kind: 'activity' as const, id, rev, href: '/papers/' + id };
}

export function organizerFrozenVersionNotFound(E: RequestErrorCtor, kind: 'material' | 'activity') {
  return new E(404, kind === 'material' ? '这份材料的冻结版本当前不可打开。' : '这份活动的冻结版本当前不可打开。');
}

export function organizerWriteNoRecord(E: RequestErrorCtor) { return new E(500, '这次写入没有返回记录。'); }
export function organizerSubmitConfirmationRequired(E: RequestErrorCtor) { return new E(400, '请确认保存本次学习记录。'); }
export function organizerTodayInputNotReady() { return new Error('今天的输入未就绪。'); }

export function buildOrganizerTodayDeriveInput<S extends object, D extends object, G, R, C>(args: {
  settings: S; duration: D; goal: G | null; rules: readonly R[]; candidates: readonly C[]; paused: boolean;
}): S & D & { goal?: G; rules: readonly R[]; candidates: readonly C[]; constraints: { budget_min: null; locks: never[]; deadlines: never[] } } {
  const { settings, duration, goal, rules, candidates, paused } = args;
  return {
    ...settings, ...duration,
    ...(goal ? { goal } : {}) as { goal?: G },
    rules,
    // Hold proactive practice suggestions while a care pause is active.
    candidates: paused ? [] : candidates,
    constraints: { budget_min: null, locks: [], deadlines: [] },
  };
}

export function buildOrganizerTodayResult<V extends object, C extends { id: string }, G, O>(args: {
  value: V; candidates: readonly C[]; shortlistedIds: readonly string[]; rules: unknown; goal: G | null;
  observedThrough: O; openedAt: string; paused: boolean;
}): V & { alternatives: C[]; rules: unknown; goal: G | null; observedThrough: O; openedAt: string; paused?: true } {
  const { value, candidates, shortlistedIds, rules, goal, observedThrough, openedAt, paused } = args;
  const alternatives = candidates.filter(c => shortlistedIds.includes(c.id));
  return { ...value, alternatives, rules, goal, observedThrough, openedAt, ...(paused ? { paused: true as const } : {}) as { paused?: true } };
}
