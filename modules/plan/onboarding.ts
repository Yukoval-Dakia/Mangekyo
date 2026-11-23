import { planRule, warmupTimeZone, type Campaign, type PlanRule } from './rules.ts';
import { date as strictDate } from './validation.ts';

export const ONBOARDING_COMPANION_MEMO_MAX_LENGTH = 780;

export type OnboardingMode = 'llm' | 'offline_manual';

export type OnboardingQuickPrefs = {
  stage?: string;
  dailyMinutes?: number;
  campaign?: Campaign;
  teachingStyle?: string;
};

export type OnboardingInput = {
  profileText: string;
  currentDate: string;
  timeZone: string;
  quickPrefs?: OnboardingQuickPrefs;
  mode?: OnboardingMode;
};

export type OnboardingLearnerSummary = {
  headline: string;
  stage: string;
  regionOrSchool: string;
  selectedSubjects: string[];
  inferredPeriod: string;
  dailyMinutes: number;
  teachingStyle: string;
};

export type OnboardingCompletedExam = {
  subject: string;
  examName: string;
  status: 'completed' | 'upcoming' | 'exempt';
  confidence: 'high' | 'needs_confirm';
  reason: string;
};

export type OnboardingExamWeight = {
  topic: string;
  weight: number;
};

export type OnboardingUpcomingExam = {
  id: string;
  title: string;
  date: string;
  dateCertainty: 'exact' | 'estimated';
  scope: string[];
  weights: OnboardingExamWeight[];
  note: string;
};

export type OnboardingDailyWindow = {
  weekday: number | null;
  start: number;
  end: number;
  label: string;
};

export type OnboardingProgressTopic = {
  topic: string;
  stage: 'current' | 'preview';
};

export type OnboardingStudyPlan = {
  goalText: string;
  campaign: Campaign;
  dailyWindow: OnboardingDailyWindow;
  progressTopics: OnboardingProgressTopic[];
  companionMemo: string;
  preferenceNotes: string[];
};

export type OnboardingDiscipline = {
  key: string;
  title: string;
  learningScope: string;
  mastery: string;
  assessment: string[];
  boundaries: string[];
};

export type OnboardingConcept = {
  key: string;
  subject: string;
  title: string;
  summary: string;
  semesterTag: string;
  selected: boolean;
};

export type OnboardingEdge = {
  fromKey: string;
  toKey: string;
  kind: 'prereq_of' | 'related_to';
  rationale: string;
};

export type OnboardingStarterQuestion = {
  key: string;
  subject: string;
  title: string;
  prompt: string;
  answer: string;
  rubric: string;
  conceptKeys: string[];
  difficulty: 'foundation' | 'core' | 'stretch';
  selected: boolean;
};

export type OnboardingMeta = {
  generatedAt: string;
  currentDate: string;
  timeZone: string;
  source: OnboardingMode;
  model?: string;
  honestyNote: string;
};

export type OnboardingProposal = {
  learnerSummary: OnboardingLearnerSummary;
  examStatus: {
    completedExams: OnboardingCompletedExam[];
    upcomingExams: OnboardingUpcomingExam[];
  };
  studyPlan: OnboardingStudyPlan;
  disciplines: OnboardingDiscipline[];
  knowledgeGraph: {
    concepts: OnboardingConcept[];
    edges: OnboardingEdge[];
  };
  starterQuestions: OnboardingStarterQuestion[];
  meta: OnboardingMeta;
};

const CAMPAIGNS = ['steady', 'sprint', 'recovery'] as const;
const MODES = ['llm', 'offline_manual'] as const;
const EXAM_STATUSES = ['completed', 'upcoming', 'exempt'] as const;
const CONFIDENCES = ['high', 'needs_confirm'] as const;
const CERTAINTIES = ['exact', 'estimated'] as const;
const PROGRESS_STAGES = ['current', 'preview'] as const;
const EDGE_KINDS = ['prereq_of', 'related_to'] as const;
const DIFFICULTIES = ['foundation', 'core', 'stretch'] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pickOne<const T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function toSafeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const noNull = value.replaceAll('\0', '');
  const wellFormed = typeof noNull.toWellFormed === 'function' ? noNull.toWellFormed() : noNull;
  return wellFormed.trim();
}

function clipText(text: string, maxLength: number): string {
  if (maxLength <= 0 || !text) return '';
  if (text.length <= maxLength) return text;
  let end = maxLength;
  // Avoid splitting a UTF-16 surrogate pair so String.prototype.isWellFormed() always holds.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd();
}

function cleanText(value: unknown, maxLength: number): string {
  return clipText(toSafeText(value), maxLength);
}

function cleanStringList(value: unknown, maxItems: number, maxItemLength: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of asArray(value)) {
    const text = cleanText(item, maxItemLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function cleanKey(value: unknown, fallbackPrefix: string, index: number, used: Set<string>): string {
  const raw = toSafeText(value)
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  const base = raw || `${fallbackPrefix}-${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base.slice(0, 118)}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function safeTimeZone(value: unknown, fallback: string): string {
  for (const candidate of [value, fallback, 'UTC']) {
    try {
      return warmupTimeZone(candidate);
    } catch {
      // Try next fallback time zone.
    }
  }
  return 'UTC';
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseFlexibleDate(value: unknown): { date: string; repaired: boolean } | null {
  const raw = toSafeText(value);
  if (!raw) return null;
  try {
    return { date: strictDate(raw), repaired: false };
  } catch {
    // Fall through to permissive repair for common LLM formats.
  }
  const isoPrefix = raw.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?:[T\s].*)?$/);
  if (!isoPrefix) return null;
  const year = Number(isoPrefix[1]);
  const month = Number(isoPrefix[2]);
  if (!Number.isInteger(year) || year < 1970 || year > 2199 || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  const maxDay = daysInMonth(year, month);
  const rawDay = isoPrefix[3] ? Number(isoPrefix[3]) : 15;
  if (!Number.isInteger(rawDay) || rawDay < 1) return null;
  const day = Math.min(rawDay, maxDay);
  const formatted = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  try {
    return { date: strictDate(formatted), repaired: true };
  } catch {
    return null;
  }
}

function formatMinute(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.round(totalMinutes)));
  const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
  const mm = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function sanitizeDailyWindow(raw: unknown, dailyMinutes: number): OnboardingDailyWindow {
  const obj = asRecord(raw);
  const weekday =
    obj.weekday === null || obj.weekday === undefined
      ? null
      : clampInt(obj.weekday, 0, 6, 0);
  const start = clampInt(obj.start, 0, 1439, 19 * 60);
  const defaultEnd = Math.min(1440, Math.max(start + 1, start + dailyMinutes));
  const rawEnd = clampInt(obj.end, start + 1, 1440, defaultEnd);
  const end = rawEnd > start ? rawEnd : defaultEnd;
  const label = cleanText(obj.label, 120) || `${formatMinute(start)}–${formatMinute(end)}`;
  return { weekday, start, end, label };
}

/**
 * Normalize exam weights so they always satisfy `modules/plan/rules.ts` `planRule()` invariants:
 * - every `topic` is non-empty, unique, and present in `scope`
 * - every `weight` is an integer in `[0, 100]`
 * - `weights.reduce((sum, w) => sum + w.weight, 0) <= 100`
 */
export function sanitizeWeights(
  scope: readonly string[],
  weights: readonly { topic: string; weight: number }[],
): OnboardingExamWeight[] {
  const scopeSet = new Set(scope.map((item) => cleanText(item, 120)).filter(Boolean));
  if (!scopeSet.size || !Array.isArray(weights)) return [];

  const deduped: { topic: string; weight: number }[] = [];
  const seen = new Set<string>();
  for (const item of weights) {
    const rec = asRecord(item);
    const topic = cleanText(rec.topic, 120);
    if (!topic || !scopeSet.has(topic) || seen.has(topic)) continue;
    const rawWeight = typeof rec.weight === 'number' ? rec.weight : Number(rec.weight);
    if (!Number.isFinite(rawWeight) || rawWeight < 0) continue;
    seen.add(topic);
    deduped.push({ topic, weight: rawWeight });
  }
  if (!deduped.length) return [];

  const totalRaw = deduped.reduce((sum, item) => sum + item.weight, 0);
  if (totalRaw <= 100) {
    const rounded = deduped.map((item) => ({
      topic: item.topic,
      weight: Math.max(0, Math.min(100, Math.round(item.weight))),
    }));
    let over = rounded.reduce((sum, item) => sum + item.weight, 0) - 100;
    for (let i = rounded.length - 1; i >= 0 && over > 0; i -= 1) {
      const drop = Math.min(over, rounded[i]!.weight);
      rounded[i]!.weight -= drop;
      over -= drop;
    }
    return rounded;
  }

  const scaled = deduped.map((item, index) => {
    const exact = (item.weight * 100) / totalRaw;
    const floor = Math.floor(exact);
    return { index, topic: item.topic, weight: floor, remainder: exact - floor };
  });
  let leftover = 100 - scaled.reduce((sum, item) => sum + item.weight, 0);
  const byRemainder = [...scaled].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const entry of byRemainder) {
    if (leftover <= 0) break;
    entry.weight += 1;
    leftover -= 1;
  }
  return scaled.map(({ topic, weight }) => ({ topic, weight }));
}

export function parseOnboardingInput(
  raw: unknown,
  fallbackDate: string,
  fallbackTimeZone: string,
): OnboardingInput {
  const input = asRecord(raw);
  const profileText = cleanText(input.profileText, 2000);
  if (!profileText) throw new Error('请先用一句话介绍你的学习情况。');

  const parsedFallbackDate = parseFlexibleDate(fallbackDate);
  if (!parsedFallbackDate) throw new Error('默认日期格式无效，需为 YYYY-MM-DD。');
  const parsedInputDate = parseFlexibleDate(input.currentDate);
  const currentDate = parsedInputDate?.date ?? parsedFallbackDate.date;
  const timeZone = safeTimeZone(input.timeZone, fallbackTimeZone);

  const rawPrefs = asRecord(input.quickPrefs);
  const stage = cleanText(rawPrefs.stage, 120);
  const dailyMinutes =
    rawPrefs.dailyMinutes !== undefined && rawPrefs.dailyMinutes !== null && rawPrefs.dailyMinutes !== ''
      ? clampInt(rawPrefs.dailyMinutes, 10, 480, 45)
      : undefined;
  const campaign =
    typeof rawPrefs.campaign === 'string' && (CAMPAIGNS as readonly string[]).includes(rawPrefs.campaign)
      ? (rawPrefs.campaign as Campaign)
      : undefined;
  const teachingStyle = cleanText(rawPrefs.teachingStyle, 240);
  const quickPrefs: OnboardingQuickPrefs = {
    ...(stage ? { stage } : {}),
    ...(dailyMinutes !== undefined ? { dailyMinutes } : {}),
    ...(campaign ? { campaign } : {}),
    ...(teachingStyle ? { teachingStyle } : {}),
  };
  const mode =
    typeof input.mode === 'string' && (MODES as readonly string[]).includes(input.mode)
      ? (input.mode as OnboardingMode)
      : undefined;

  return {
    profileText,
    currentDate,
    timeZone,
    ...(Object.keys(quickPrefs).length ? { quickPrefs } : {}),
    ...(mode ? { mode } : {}),
  };
}

export function buildOnboardingCompanionMemo(proposal: OnboardingProposal): string {
  const s = proposal.learnerSummary;
  const parts: string[] = [];

  const identityBits = [
    cleanText(s.headline, 120),
    s.stage ? `阶段:${cleanText(s.stage, 48)}` : '',
    s.regionOrSchool ? `地区/学校:${cleanText(s.regionOrSchool, 64)}` : '',
    s.selectedSubjects.length ? `选科:${s.selectedSubjects.slice(0, 8).join('/')}` : '',
    s.inferredPeriod ? `周期:${cleanText(s.inferredPeriod, 64)}` : '',
  ].filter(Boolean);
  if (identityBits.length) parts.push(`画像：${identityBits.join('；')}`);

  const completed = proposal.examStatus.completedExams.slice(0, 8).map((exam) => {
    const tag = exam.status === 'exempt' ? '免考' : exam.status === 'upcoming' ? '待考' : '已考';
    const confirm = exam.confidence === 'needs_confirm' ? '(待确认)' : '';
    return `${exam.subject}-${exam.examName}[${tag}${confirm}]`;
  });
  if (completed.length) parts.push(`考试状态：${completed.join('、')}`);

  const upcoming = proposal.examStatus.upcomingExams.slice(0, 6).map((exam) => {
    const tag = exam.dateCertainty === 'exact' ? '' : '约';
    return `${tag}${exam.date} ${exam.title}`;
  });
  if (upcoming.length) parts.push(`待考节点：${upcoming.join('；')}`);

  const prefBits = [
    `每日${s.dailyMinutes}分钟(${proposal.studyPlan.dailyWindow.label})`,
    `节奏:${proposal.studyPlan.campaign}`,
    s.teachingStyle ? `偏好:${cleanText(s.teachingStyle, 80)}` : '',
    ...proposal.studyPlan.preferenceNotes.slice(0, 4).map((note) => cleanText(note, 60)),
  ].filter(Boolean);
  if (prefBits.length) parts.push(`学习习惯：${prefBits.join('；')}`);

  const goal = cleanText(proposal.studyPlan.goalText, 120);
  if (goal) parts.push(`当前目标：${goal}`);

  const memo = parts.join('\n').trim() || cleanText(s.headline, 120) || '冷启动初始学习画像';
  return clipText(memo, ONBOARDING_COMPANION_MEMO_MAX_LENGTH);
}

export function parseOnboardingProposal(raw: unknown): OnboardingProposal {
  const root = asRecord(raw);
  const rawSummary = asRecord(root.learnerSummary);
  const rawExamStatus = asRecord(root.examStatus);
  const rawStudyPlan = asRecord(root.studyPlan);
  const rawGraph = asRecord(root.knowledgeGraph);
  const rawMeta = asRecord(root.meta);

  const metaDate =
    parseFlexibleDate(rawMeta.currentDate)?.date ??
    parseFlexibleDate(rawMeta.generatedAt)?.date ??
    '1970-01-01';
  const rawGenerated = toSafeText(rawMeta.generatedAt);
  const generatedAt =
    rawGenerated && Number.isFinite(Date.parse(rawGenerated))
      ? new Date(rawGenerated).toISOString()
      : `${metaDate}T00:00:00.000Z`;
  const timeZone = safeTimeZone(rawMeta.timeZone, 'UTC');
  const source = pickOne(rawMeta.source, MODES, 'llm');
  const model = cleanText(rawMeta.model, 120);
  const honestyNote =
    cleanText(rawMeta.honestyNote, 500) ||
    (source === 'offline_manual'
      ? '离线基础方案仅保留你亲手填写的信息，未自动推断地区考期或题库。'
      : '以上为 AI 基于当前日期与简述生成的冷启动草案，考期与已考状态建议按实际核对后再确认生效。');

  const dailyMinutes = clampInt(rawSummary.dailyMinutes, 10, 480, 60);
  const headline = cleanText(rawSummary.headline, 200) || '学习冷启动配置';
  const learnerSummary: OnboardingLearnerSummary = {
    headline,
    stage: cleanText(rawSummary.stage, 120),
    regionOrSchool: cleanText(rawSummary.regionOrSchool, 160),
    selectedSubjects: cleanStringList(rawSummary.selectedSubjects, 16, 60),
    inferredPeriod: cleanText(rawSummary.inferredPeriod, 120),
    dailyMinutes,
    teachingStyle: cleanText(rawSummary.teachingStyle, 240),
  };

  const completedExams: OnboardingCompletedExam[] = [];
  for (const item of asArray(rawExamStatus.completedExams)) {
    const rec = asRecord(item);
    const subject = cleanText(rec.subject, 80);
    const examName = cleanText(rec.examName, 120);
    if (!subject && !examName) continue;
    completedExams.push({
      subject: subject || examName,
      examName: examName || subject,
      status: pickOne(rec.status, EXAM_STATUSES, 'completed'),
      confidence: pickOne(rec.confidence, CONFIDENCES, 'needs_confirm'),
      reason: cleanText(rec.reason, 300),
    });
    if (completedExams.length >= 24) break;
  }

  const upcomingExams: OnboardingUpcomingExam[] = [];
  const usedExamIds = new Set<string>();
  for (let i = 0; i < asArray(rawExamStatus.upcomingExams).length; i += 1) {
    const rec = asRecord(asArray(rawExamStatus.upcomingExams)[i]);
    const parsedDate = parseFlexibleDate(rec.date);
    if (!parsedDate) continue;
    const title = cleanText(rec.title, 160);
    const scope = cleanStringList(rec.scope, 24, 120);
    const effectiveScope = scope.length ? scope : title ? [title] : [];
    if (!effectiveScope.length) continue;
    const rawWeights = asArray(rec.weights).map((w) => {
      const wRec = asRecord(w);
      return { topic: cleanText(wRec.topic, 120), weight: Number(wRec.weight) };
    });
    upcomingExams.push({
      id: cleanKey(rec.id, 'exam', i, usedExamIds),
      title: title || effectiveScope[0]!,
      date: parsedDate.date,
      dateCertainty: parsedDate.repaired ? 'estimated' : pickOne(rec.dateCertainty, CERTAINTIES, 'estimated'),
      scope: effectiveScope,
      weights: sanitizeWeights(effectiveScope, rawWeights),
      note: cleanText(rec.note, 400),
    });
    if (upcomingExams.length >= 16) break;
  }

  const progressTopics: OnboardingProgressTopic[] = [];
  const seenTopics = new Set<string>();
  for (const item of asArray(rawStudyPlan.progressTopics)) {
    const rec = asRecord(item);
    const topic = cleanText(rec.topic, 120);
    if (!topic || seenTopics.has(topic)) continue;
    seenTopics.add(topic);
    progressTopics.push({
      topic,
      stage: pickOne(rec.stage, PROGRESS_STAGES, 'current'),
    });
    if (progressTopics.length >= 24) break;
  }

  const disciplines: OnboardingDiscipline[] = [];
  const usedDisciplineKeys = new Set<string>();
  for (let i = 0; i < asArray(root.disciplines).length; i += 1) {
    const rec = asRecord(asArray(root.disciplines)[i]);
    const title = cleanText(rec.title, 120);
    const learningScope = cleanText(rec.learningScope, 1000);
    if (!title && !learningScope) continue;
    const effectiveTitle = title || cleanText(rec.key, 120) || `学科 ${i + 1}`;
    const assessment = cleanStringList(rec.assessment, 8, 240);
    const boundaries = cleanStringList(rec.boundaries, 8, 240);
    disciplines.push({
      key: cleanKey(rec.key, 'discipline', i, usedDisciplineKeys),
      title: effectiveTitle,
      learningScope: learningScope || `${effectiveTitle}核心学习范围`,
      mastery: cleanText(rec.mastery, 1000) || '能够独立解释核心概念并完成基础变式题',
      assessment: assessment.length ? assessment : ['以独立作答与关键步骤解释为评估依据'],
      boundaries: boundaries.length ? boundaries : ['以实际独立完成证据为准，不凭提示通过判定掌握'],
    });
    if (disciplines.length >= 12) break;
  }

  const concepts: OnboardingConcept[] = [];
  const usedConceptKeys = new Set<string>();
  const rawConceptKeyMap = new Map<string, string>();
  for (let i = 0; i < asArray(rawGraph.concepts).length; i += 1) {
    const rec = asRecord(asArray(rawGraph.concepts)[i]);
    const title = cleanText(rec.title, 240);
    if (!title) continue;
    const rawKey = toSafeText(rec.key);
    const cleanedKey = cleanKey(rec.key, 'concept', i, usedConceptKeys);
    if (rawKey && !rawConceptKeyMap.has(rawKey)) rawConceptKeyMap.set(rawKey, cleanedKey);
    concepts.push({
      key: cleanedKey,
      subject: cleanText(rec.subject, 80) || learnerSummary.selectedSubjects[0] || '综合',
      title,
      summary: cleanText(rec.summary, 600),
      semesterTag: cleanText(rec.semesterTag, 80),
      selected: typeof rec.selected === 'boolean' ? rec.selected : true,
    });
    if (concepts.length >= 40) break;
  }

  const resolveConceptKey = (value: unknown): string | null => {
    const raw = toSafeText(value);
    if (!raw) return null;
    if (usedConceptKeys.has(raw)) return raw;
    return rawConceptKeyMap.get(raw) ?? null;
  };

  const edges: OnboardingEdge[] = [];
  const seenEdges = new Set<string>();
  for (const item of asArray(rawGraph.edges)) {
    const rec = asRecord(item);
    const fromKey = resolveConceptKey(rec.fromKey);
    const toKey = resolveConceptKey(rec.toKey);
    if (!fromKey || !toKey || fromKey === toKey) continue;
    const kind = pickOne(rec.kind, EDGE_KINDS, 'related_to');
    const edgeSig = `${fromKey}\0${toKey}\0${kind}`;
    if (seenEdges.has(edgeSig)) continue;
    seenEdges.add(edgeSig);
    edges.push({
      fromKey,
      toKey,
      kind,
      rationale: cleanText(rec.rationale, 400),
    });
    if (edges.length >= 80) break;
  }

  const starterQuestions: OnboardingStarterQuestion[] = [];
  const usedQuestionKeys = new Set<string>();
  for (let i = 0; i < asArray(root.starterQuestions).length; i += 1) {
    const rec = asRecord(asArray(root.starterQuestions)[i]);
    const title = cleanText(rec.title, 240);
    const prompt = cleanText(rec.prompt, 4000);
    if (!title && !prompt) continue;
    const conceptKeys: string[] = [];
    const seenCk = new Set<string>();
    for (const ck of asArray(rec.conceptKeys)) {
      const k = resolveConceptKey(ck);
      if (!k || seenCk.has(k)) continue;
      seenCk.add(k);
      conceptKeys.push(k);
    }
    starterQuestions.push({
      key: cleanKey(rec.key, 'question', i, usedQuestionKeys),
      subject: cleanText(rec.subject, 80) || learnerSummary.selectedSubjects[0] || '综合',
      title: title || clipText(prompt, 80),
      prompt: prompt || title,
      answer: cleanText(rec.answer, 2000),
      rubric: cleanText(rec.rubric, 1600),
      conceptKeys,
      difficulty: pickOne(rec.difficulty, DIFFICULTIES, 'foundation'),
      selected: typeof rec.selected === 'boolean' ? rec.selected : true,
    });
    if (starterQuestions.length >= 24) break;
  }

  const studyPlan: OnboardingStudyPlan = {
    goalText: cleanText(rawStudyPlan.goalText, 1000) || headline,
    campaign: pickOne(rawStudyPlan.campaign, CAMPAIGNS, 'steady'),
    dailyWindow: sanitizeDailyWindow(rawStudyPlan.dailyWindow, dailyMinutes),
    progressTopics,
    companionMemo: cleanText(rawStudyPlan.companionMemo, ONBOARDING_COMPANION_MEMO_MAX_LENGTH),
    preferenceNotes: cleanStringList(rawStudyPlan.preferenceNotes, 16, 200),
  };

  const proposal: OnboardingProposal = {
    learnerSummary,
    examStatus: { completedExams, upcomingExams },
    studyPlan,
    disciplines,
    knowledgeGraph: { concepts, edges },
    starterQuestions,
    meta: {
      generatedAt,
      currentDate: metaDate,
      timeZone,
      source,
      ...(model ? { model } : {}),
      honestyNote,
    },
  };

  if (!proposal.studyPlan.companionMemo) {
    proposal.studyPlan.companionMemo = buildOnboardingCompanionMemo(proposal);
  }
  return proposal;
}

/**
 * Offline / model-unavailable honest fallback:
 * strictly derived from what the learner explicitly provided — never fabricates
 * region/school exam calendars, subject templates, knowledge graphs, or questions.
 */
export function buildManualOnboardingProposal(input: OnboardingInput): OnboardingProposal {
  const currentDate = parseFlexibleDate(input.currentDate)?.date ?? '1970-01-01';
  const headline = clipText(toSafeText(input.profileText), 120) || '初始学习配置';
  const stage = cleanText(input.quickPrefs?.stage, 120);
  const dailyMinutes = clampInt(input.quickPrefs?.dailyMinutes, 10, 480, 45);
  const campaign = pickOne(input.quickPrefs?.campaign, CAMPAIGNS, 'steady');
  const teachingStyle = cleanText(input.quickPrefs?.teachingStyle, 240);
  const preferenceNotes = [
    ...(stage ? [`当前阶段：${stage}`] : []),
    ...(teachingStyle ? [`偏好风格：${teachingStyle}`] : []),
  ];

  const start = 19 * 60;
  const end = Math.min(1440, start + dailyMinutes);
  const proposal: OnboardingProposal = {
    learnerSummary: {
      headline,
      stage,
      regionOrSchool: '',
      selectedSubjects: [],
      inferredPeriod: `${currentDate}（待手动补充学期与考期）`,
      dailyMinutes,
      teachingStyle,
    },
    examStatus: {
      completedExams: [],
      upcomingExams: [],
    },
    studyPlan: {
      goalText: clipText(`围绕「${headline}」建立稳定的日常学习节奏`, 1000),
      campaign,
      dailyWindow: {
        weekday: null,
        start,
        end,
        label: `${formatMinute(start)}–${formatMinute(end)}`,
      },
      progressTopics: [],
      companionMemo: '',
      preferenceNotes,
    },
    disciplines: [],
    knowledgeGraph: {
      concepts: [],
      edges: [],
    },
    starterQuestions: [],
    meta: {
      generatedAt: `${currentDate}T00:00:00.000Z`,
      currentDate,
      timeZone: safeTimeZone(input.timeZone, 'UTC'),
      source: 'offline_manual',
      honestyNote:
        '当前为离线/无模型基础配置，仅按你亲手填写的描述生成最小学习目标与习惯；未自动推断地区考期、学科语境、知识点图谱或摸底题，配置模型后可重新生成或直接手动补充。',
    },
  };
  proposal.studyPlan.companionMemo = buildOnboardingCompanionMemo(proposal);
  return proposal;
}

/**
 * Map a validated `OnboardingProposal` into first-class `PlanRule` payloads
 * (`campaign` + `window` + `exam[]` + `progress[]`) guaranteed to pass `planRule()`.
 */
export function planRulePayloadsFromProposal(proposal: OnboardingProposal): PlanRule[] {
  const rules: PlanRule[] = [];

  rules.push(planRule({ kind: 'campaign', campaign: proposal.studyPlan.campaign }));

  const win = sanitizeDailyWindow(proposal.studyPlan.dailyWindow, proposal.learnerSummary.dailyMinutes);
  rules.push(planRule({ kind: 'window', weekday: win.weekday, start: win.start, end: win.end }));

  for (const exam of proposal.examStatus.upcomingExams) {
    const parsed = parseFlexibleDate(exam.date);
    if (!parsed) continue;
    const scope = cleanStringList(exam.scope, 24, 120);
    const effectiveScope = scope.length ? scope : cleanText(exam.title, 120) ? [cleanText(exam.title, 120)] : [];
    if (!effectiveScope.length) continue;
    const weights = sanitizeWeights(effectiveScope, exam.weights);
    rules.push(planRule({ kind: 'exam', date: parsed.date, scope: effectiveScope, weights }));
  }

  const seenTopics = new Set<string>();
  for (const item of proposal.studyPlan.progressTopics) {
    const topic = cleanText(item.topic, 120);
    if (!topic || seenTopics.has(topic)) continue;
    seenTopics.add(topic);
    rules.push(planRule({ kind: 'progress', topic, stage: pickOne(item.stage, PROGRESS_STAGES, 'current') }));
  }

  return rules;
}
