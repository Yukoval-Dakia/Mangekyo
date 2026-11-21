import type { Json } from '@mangekyo/kernel';
import { triagePromptBlock, triageSkillById } from './research-triage-cards.ts';
import { parseTriageResponse as parseResponse, TriageResponseError } from './research-triage-response.ts';
import { allowedTriageIds, type TriageSnapshot } from './research-triage-snapshot.ts';
export { TriageResponseError, type TriageAction, type TriageResponse } from './research-triage-response.ts';
export const parseTriageResponse = (raw: string, snapshot: TriageSnapshot) => parseResponse(raw, allowedTriageIds(snapshot), triageSkillById);

export const reviewGoal = '为一份正式错题作答准备复习单';
const reviewTemplate = 'review_submitted_attempt';
export const noop = { kind: 'noop' } as const;
export const reviewAction = (source: string) => ({ kind: 'emit_todo', template_id: reviewTemplate, source_fact_id: source });
type ReviewAction = ReturnType<typeof reviewAction>;

export function response(action: ReviewAction | typeof noop) {
  return { matched_skill: null, reason_brief: '按已启用的复习单菜单处理。',
    actions: [action], memo_table: [], next_recheck_hint: null };
}

export function coverage(visible: number, candidates: number, limit: number) {
  if (visible === 0) return candidates === 0 ? 'empty' : 'unavailable';
  return candidates > limit || visible < candidates ? 'partial' : 'available';
}

type LocalPrompt = {
  prefix: Omit<TriageSnapshot, 'events'>;
  events: Record<string, Json>;
  olderCandidate?: Json | undefined;
  settingsRevision: number;
  overview: unknown;
  retention: { state: string };
  recentWindow: number;
  todoCoverage: string;
  inventoryCoverage: string;
  foregroundCoverage: string;
  backgroundCoverage: string;
  action?: ReviewAction | undefined;
};

export function researchTriageRequest(input: LocalPrompt) {
  const { prefix, events, olderCandidate, settingsRevision, overview, retention, recentWindow, action } = input;
  const wakeSource = Object.values(events).map(event => (event as { kind: string }).kind).join(' ');
  return {
    stablePrefix: JSON.stringify({ ...prefix, settings_revision: settingsRevision,
      learning_overview: overview, retention,
      installed_template: { id: reviewTemplate, goal: reviewGoal, worker_profile: 'deterministic_compute',
        autonomy_tier: 1, budget_cap: 0 },
      coverage: { recent_attempts: recentWindow, recent_todos: recentWindow,
        todos: input.todoCoverage, inventory: input.inventoryCoverage,
        inventory_usage: 'unknown', retention: retention.state, preferences: 'unavailable', forecasts: 'unavailable',
        memos: 'unavailable', signals: 'unavailable', work: 'unavailable' } }),
    deltaSuffix: JSON.stringify({ events, older_candidate: olderCandidate, skills: triagePromptBlock(wakeSource),
      coverage: { foreground_digests: input.foregroundCoverage, background_digests: input.backgroundCoverage },
      menu: action ? [noop, action] : [noop], response_format: response(noop) }),
  };
}

function selectedAction(value: unknown, expected: ReviewAction | typeof noop) {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const [action] = value;
  return action !== null && typeof action === 'object' && !Array.isArray(action) &&
    Object.keys(action).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, field]) => action[key] === field);
}

export function researchDecision({ snapshot, action }: { snapshot: TriageSnapshot; action: ReviewAction | undefined }, raw?: string) {
  raw ??= JSON.stringify(response(action ?? noop));
  try {
    const envelope = JSON.parse(raw);
    const selected = action && selectedAction(envelope?.actions, action);
    // Check the one installed action, then use the shared parser for the rest of the envelope.
    const parsed = parseTriageResponse(selected ? JSON.stringify({ ...envelope, actions: [noop] }) : raw, snapshot);
    if (parsed.matchedSkill === null && parsed.memoTable.length === 0 && parsed.nextRecheckHint === null) {
      if (selected) return 'review';
      if (selectedAction(envelope?.actions, noop)) return 'noop';
    }
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TriageResponseError)) throw error;
  }
  return 'invalid_reply';
}
