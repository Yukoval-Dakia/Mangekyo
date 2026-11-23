import type {
  OnboardingCompletedExam,
  OnboardingProposal,
  OnboardingQuickPrefs,
  OnboardingUpcomingExam,
} from '../api';

export type OnboardingStep = 'intro' | 'generating' | 'review' | 'done';

export type DraftCompletedExam = OnboardingCompletedExam & { localId: string };

export type DraftUpcomingExam = OnboardingUpcomingExam & { localId: string };

export type DraftProposal = Omit<OnboardingProposal, 'examStatus'> & {
  examStatus: {
    completedExams: DraftCompletedExam[];
    upcomingExams: DraftUpcomingExam[];
  };
};

export type QuickPrefDraft = {
  dailyMinutes?: number | undefined;
  campaign?: 'steady' | 'sprint' | 'recovery' | undefined;
  teachingStyle?: string | undefined;
};

export function toQuickPrefs(draft: QuickPrefDraft): OnboardingQuickPrefs | undefined {
  const prefs: OnboardingQuickPrefs = {};
  if (typeof draft.dailyMinutes === 'number') prefs.dailyMinutes = draft.dailyMinutes;
  if (draft.campaign) prefs.campaign = draft.campaign;
  if (draft.teachingStyle) prefs.teachingStyle = draft.teachingStyle;
  return Object.keys(prefs).length > 0 ? prefs : undefined;
}

export function toDraftProposal(proposal: OnboardingProposal, makeId: () => string): DraftProposal {
  return {
    ...proposal,
    learnerSummary: { ...proposal.learnerSummary },
    examStatus: {
      completedExams: proposal.examStatus.completedExams.map(item => ({ ...item, localId: makeId() })),
      upcomingExams: proposal.examStatus.upcomingExams.map(item => ({
        ...item,
        localId: makeId(),
        scope: [...item.scope],
        weights: item.weights.map(weight => ({ ...weight })),
      })),
    },
    studyPlan: {
      ...proposal.studyPlan,
      dailyWindow: { ...proposal.studyPlan.dailyWindow },
      progressTopics: proposal.studyPlan.progressTopics.map(topic => ({ ...topic })),
      preferenceNotes: [...proposal.studyPlan.preferenceNotes],
    },
    disciplines: proposal.disciplines.map(discipline => ({
      ...discipline,
      assessment: [...discipline.assessment],
      boundaries: [...discipline.boundaries],
    })),
    knowledgeGraph: {
      concepts: proposal.knowledgeGraph.concepts.map(concept => ({ ...concept })),
      edges: proposal.knowledgeGraph.edges.map(edge => ({ ...edge })),
    },
    starterQuestions: proposal.starterQuestions.map(question => ({
      ...question,
      conceptKeys: [...question.conceptKeys],
    })),
    meta: { ...proposal.meta },
  };
}

export function fromDraftProposal(draft: DraftProposal): OnboardingProposal {
  return {
    ...draft,
    examStatus: {
      completedExams: draft.examStatus.completedExams.map(({ localId: _localId, ...item }) => item),
      upcomingExams: draft.examStatus.upcomingExams.map(({ localId: _localId, ...item }) => item),
    },
  };
}

export function minutesToTime(minutes: number | null | undefined): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return '';
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  const hour = Math.floor(clamped / 60).toString().padStart(2, '0');
  const minute = (clamped % 60).toString().padStart(2, '0');
  return `${hour}:${minute}`;
}

export function timeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function countSelectedEdges(draft: DraftProposal): number {
  const selected = new Set(
    draft.knowledgeGraph.concepts.filter(concept => concept.selected).map(concept => concept.key),
  );
  return draft.knowledgeGraph.edges.filter(
    edge => selected.has(edge.fromKey) && selected.has(edge.toKey),
  ).length;
}

export function applySummary(draft: DraftProposal): string {
  const parts: string[] = ['1 项目标'];
  const examCount = draft.examStatus.upcomingExams.length;
  if (examCount > 0) parts.push(`${examCount} 场考试`);
  const disciplineCount = draft.disciplines.length;
  if (disciplineCount > 0) parts.push(`${disciplineCount} 个学科`);
  const conceptCount = draft.knowledgeGraph.concepts.filter(concept => concept.selected).length;
  if (conceptCount > 0) parts.push(`${conceptCount} 个知识点`);
  const edgeCount = countSelectedEdges(draft);
  if (edgeCount > 0) parts.push(`${edgeCount} 条关系`);
  const questionCount = draft.starterQuestions.filter(question => question.selected).length;
  if (questionCount > 0) parts.push(`${questionCount} 道摸底题`);
  return parts.join(' · ');
}
