import { api, ApiError, remember, remembered } from './api';

export interface ClassroomStep {
  id: string;
  title: string;
  kind?: string;
  status: 'pending' | 'active' | 'presented' | 'skipped';
  turnId?: string;
}

export interface Classroom {
  id: string;
  rev: number;
  topic: string;
  minutes: number;
  status: 'active' | 'finished' | 'archived';
  generation?: 'pending' | 'ready' | 'failed';
  adjustmentFailed?: true;
  carePause?: true;
  sessionId: string;
  steps: ClassroomStep[];
  activeStepId: string | null;
  studyMethodPlan?: {
    steps?: readonly { stepId?: string; title?: string; kind?: string }[];
  };
}

export const roomPath = (id: string) => '/classroom/' + encodeURIComponent(id);
export const roomApi = (id: string) => '/classrooms/' + encodeURIComponent(id);
const recentKey = 'recent-classrooms';
const roomId = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function recentRooms(): string[] {
  try {
    const ids: unknown = JSON.parse(remembered(recentKey) ?? '[]');
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && roomId.test(id)) : [];
  } catch {
    return [];
  }
}

export function rememberRoom(id: string) {
  remember(recentKey, JSON.stringify([id, ...recentRooms().filter(other => other !== id)].slice(0, 12)));
}

export type ClassroomWrite = { path: string; body: {requestId: string} & Record<string, unknown> };
export async function writeRoom(operation: ClassroomWrite) {
  return api<Classroom>(operation.path, {method: 'POST', body: operation.body});
}

export function rejected(error: unknown) {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}
