export const pythonAttemptsLimit = 8;
const maxRevision = 2_147_483_647;
const factIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const learningId = {type:'string', pattern:factIdPattern.source};
export const pythonAttemptSelection = {
  type: 'object', required: ['refs'], additionalProperties: false,
  description: `选择最多 ${pythonAttemptsLimit} 份已提交的试卷或受控后测作答，可跨卷。仅统计指定卷时传 paper_id（后测用冻结卷 ID）。用 import mangekyo as mk 和 mk.attempts() 读取 id、paper_id、submitted_at、results（question_id、result），有记录时附浏览器估算用时 effective_duration_ms 和正式得分 formal_score。activity_kind 为 controlled_posttest 时，独立性请另查后测对账。待评和自评不算判对。只 print 所需统计。`,
  properties: {
    paper_id: learningId,
    refs: {type:'array', minItems:1, maxItems:pythonAttemptsLimit, items:{
      type:'object', required:['id'], additionalProperties:false, properties:{
        id: learningId, rev: {type:'integer', minimum:1, maximum:maxRevision},
      },
    }},
  },
};

function isSourceFactId(id: unknown): id is string {
  return typeof id === 'string' && factIdPattern.test(id);
}

type AttemptRef = {id: string; rev?: number};

function attemptRef(input: unknown): AttemptRef | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const {id, rev, ...other} = input as Record<string, unknown>;
  if (Object.keys(other).length || !isSourceFactId(id)) return;
  if (rev === undefined) return {id};
  if (typeof rev === 'number' && Number.isSafeInteger(rev) && rev >= 1 && rev <= maxRevision) return {id, rev};
  return undefined;
}

export function parsePythonAttemptSelection(args: Record<string, unknown>) {
  const {paper_id, refs, ...other} = args;
  if (Object.keys(other).length || (paper_id !== undefined && !isSourceFactId(paper_id)) ||
      !Array.isArray(refs) || !refs.length ||
      refs.length > pythonAttemptsLimit) return;
  const seen = new Set<string>();
  const attempts: AttemptRef[] = [];
  for (const input of refs) {
    const ref = attemptRef(input);
    if (!ref || seen.has(ref.id)) return;
    seen.add(ref.id);
    attempts.push(ref);
  }
  return {paperId: paper_id, attempts};
}
