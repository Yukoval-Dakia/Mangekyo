import { parseTriageResponse as parseResponse } from '../../../modules/companion/research-triage-response.ts';
import { triageSkillById } from './skills.ts';
import { allowedTriageIds, type TriageSnapshot } from './snapshot.ts';

export { TriageResponseError } from '../../../modules/companion/research-triage-response.ts';
export type { TriageAction, TriageResponse } from '../../../modules/companion/research-triage-response.ts';

export function parseTriageResponse(raw: string, snapshot: TriageSnapshot) {
  return parseResponse(raw, allowedTriageIds(snapshot), triageSkillById);
}
