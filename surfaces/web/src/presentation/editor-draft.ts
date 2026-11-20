import type { Answer, ArtifactAction, ArtifactMount, Interaction } from '../../../shared/presentation/index.ts';

interface EditorDraft {
  answers: Record<string, Answer>;
  trace: ArtifactAction['trace'];
  pending: Map<string, Interaction>;
}

// A decoded mount object belongs to one session, turn, artifact revision and
// stateRev. Only that exact snapshot may resume its local editor.
export const editorDrafts = new WeakMap<ArtifactMount, EditorDraft>();
