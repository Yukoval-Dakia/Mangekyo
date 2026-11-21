import { FactNotFoundError, type DerivationId, type FactRef, type FactReadOptions, type ReadContext, type Tick } from '@mangekyo/kernel';
import { AssetBasisError, assetType, checkQuestionTeachingSources, questionAsset, type AssetReadContext } from './asset.ts';
import { jsonObject, sameEffectInput } from './question-effects.ts';
import { openQuestionMetaDraft, questionKey, questionMetaType, readQuestionState, validateQuestionMetaReferences } from './question-state.ts';

export type QuestionHintAccess = Pick<AssetReadContext, 'learner'> & {
  /** Both readers bind the same transaction, purpose and actual recipient. The slot reader serves only
   * the current effective outcome with a revalidated manifest and recipient-specific grants. */
  readonly read: Pick<ReadContext, 'fact' | 'slot'>;
  readonly purpose: string;
  readonly recipient: string;
  readonly isUnavailable: (error: unknown) => boolean;
  /** The host checks an answer permit for this issuance/item under the same transaction. */
  readonly authorizeSolution?: (scope: {
    readonly question: QuestionHintInput['question'];
    readonly purpose: string;
    readonly recipient: string;
  }) => boolean | Promise<boolean>;
};

const steps = {
  1: { kind: 'hint_l1', order: 1 },
  2: { kind: 'hint_l2', order: 2 },
} as const;

export type QuestionHintInput = {
  readonly question: FactRef & { readonly accessEpoch: Tick };
  readonly level: 1 | 2 | 3;
  readonly reveal?: 'worked-example' | 'solution';
  readonly expectedDerivationId?: DerivationId;
};

class QuestionHintUnavailable extends Error {}

/**
 * Use the frozen question from the authorized issuance in a fresh snapshot (or locked
 * publication transaction). On confirmation and replay, the host verifies its original
 * issuance, item, level, purpose and recipient, and supplies the original derivation ID.
 * Keep the witness server-side and project only the selected text and level.
 */
export async function readQuestionHintLevel(access: QuestionHintAccess, { question, level, reveal, expectedDerivationId }: QuestionHintInput) {
  if ((level !== 1 && level !== 2 && level !== 3) || question.learner !== access.learner ||
      typeof access.recipient !== 'string' || !access.recipient.trim() ||
      typeof access.purpose !== 'string' || !access.purpose.trim()) return undefined;
  if (level === 3 ? reveal !== 'worked-example' && reveal !== 'solution' : reveal !== undefined) return undefined;

  const snapshots = new Map<string, ReturnType<AssetReadContext['read']['fact']>>();
  const read: AssetReadContext['read'] = {
    async fact(id, options) {
      const pinned = options.mode === 'pinned';
      const key = JSON.stringify([id, options.mode, pinned ? options.rev : null]);
      const request: FactReadOptions = pinned ? { ...options, requirePurpose: 'teaching' } : options;
      const pending = snapshots.get(key) ?? access.read.fact(id, request);
      snapshots.set(key, pending);
      const fact = await pending;
      if (fact.ref.learner !== access.learner || fact.ref.id !== id || (pinned && fact.ref.rev !== options.rev) ||
          (!fact.purpose.includes('all') && !(fact.purpose.includes('teaching') && fact.purpose.includes(access.purpose))))
        throw new QuestionHintUnavailable();
      return fact;
    },
  };

  try {
    const frozen = await read.fact(question.id, { mode: 'pinned', rev: question.rev });
    if (frozen.type !== assetType || frozen.accessEpoch !== question.accessEpoch) return undefined;
    const { state } = await readQuestionState(read, question.id);
    if (state.arithmeticPractice || state.restrictions.some(({ scope }) =>
      scope === 'all' || scope === 'teaching' || scope === access.purpose)) return undefined;

    const { draft } = await openQuestionMetaDraft(read, question);
    const ladder = draft.append_metadata?.hint_ladder;
    if (!draft.sticky || !ladder) return undefined;
    validateQuestionMetaReferences(draft);
    await checkQuestionTeachingSources(read, questionAsset(frozen.value));
    await checkQuestionTeachingSources(read, { basis: draft.basis });

    const slot = { learner: access.learner, type: questionMetaType, key: questionKey(question) };
    const overlay = await access.read.slot(slot, { mode: 'following' });
    if (!overlay?.id || !sameEffectInput(slot, overlay.slot) || overlay.outcome?.kind !== 'value' ||
        (expectedDerivationId !== undefined && overlay.id !== expectedDerivationId)) return undefined;
    const value = overlay.outcome.value;
    if (!jsonObject(value) || value.sticky !== true || !value.hint_ladder || !sameEffectInput(value.hint_ladder, {
      ...ladder, verification: 'learner-reviewed',
    }) || !value.basis || !sameEffectInput(value.basis, draft.basis)) return undefined;
    const scope = { question: { ...frozen.ref, accessEpoch: frozen.accessEpoch }, purpose: access.purpose, recipient: access.recipient };
    const witness = { ...scope, overlay: { slot, derivationId: overlay.id } };
    if (level !== 3) return { level, text: ladder[`l${level}`], step: steps[level], witness };
    if (reveal === 'worked-example' && ladder.worked_example) {
      return { level, text: ladder.worked_example, step: { kind: reveal, order: 3 } as const, witness };
    }
    if (reveal === 'solution' && await access.authorizeSolution?.(scope) === true) {
      return { level, text: ladder.l3, step: { kind: reveal, order: 3 } as const, witness };
    }
    return undefined;
  } catch (error) {
    if (error instanceof FactNotFoundError || error instanceof AssetBasisError ||
        error instanceof QuestionHintUnavailable || access.isUnavailable(error)) return undefined;
    throw error;
  }
}
