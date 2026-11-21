import type { Json, JsonObject } from '@mangekyo/kernel';
import { teachingEffectStep } from './effect-step.ts';
import type { TeachingDependencies, TeachingDispatch, TeachingModelStep } from './index.ts';
import { TeachingError } from './provider.ts';
import type { ProviderSettings } from './provider-settings.ts';
import { ChangedEvidence, UncertainEffect } from './turn-errors.ts';
import { validateStepDispatchRules, type GuardableTurn } from './turn-context.ts';
import type { TurnWitnessLedger } from './turn-witness.ts';

type McpGrant = { readonly id: string; readonly url: string; readonly allowedTools: string[] };

export type SelectedNotionPage = {
  selection: { id: string; selectionEpoch: string };
  pageId: string;
  watermark: string;
};

export function createTeachingModelEffect<TReadTx, TWriteTx extends TReadTx = TReadTx>(params: {
  purpose: string;
  learningV1: boolean;
  settings: ProviderSettings;
  submission: GuardableTurn;
  grants: readonly McpGrant[];
  ledger: Pick<
    TurnWitnessLedger,
    'notionWitnesses' | 'retention' | 'buildMemorySend' | 'buildStepBasis' | 'needsFreshEvidence'
  >;
  notionRecipientId: () => string | undefined;
  getJit: () => { receipt: Json } | undefined;
  getLearningMemoryContext: () => string | undefined;
  loadSelected: () => Promise<readonly SelectedNotionPage[]>;
  confirmPages: (pages: readonly SelectedNotionPage[]) => Promise<void>;
  validWorkInputs: (tx: TReadTx, use?: 'publish' | 'dispatch') => Promise<{ manifest: { inputs: readonly unknown[] }; pages: readonly SelectedNotionPage[] }>;
  bindSources: (tx: TWriteTx, manifest: { inputs: readonly unknown[] }) => Promise<void>;
  loadSettings: () => Promise<ProviderSettings>;
  jitCounterFor: (current: ProviderSettings) => { id: string; endpoint: string; model: string } | undefined;
  checkWorkspaceRoute: (current: ProviderSettings) => Promise<void>;
  checkProviderAccount: (tx: TWriteTx) => Promise<ProviderSettings | undefined>;
  runEffect: (
    request: { stepKey: string; label: string; input: JsonObject },
    execute: (requestId: string, checkDispatch: (tx: TWriteTx) => Promise<void>) => Promise<Json>,
    authorize: (tx: TWriteTx) => Promise<void>,
  ) => Promise<{ readonly kind: 'unknown'; readonly providerEffectId: string | null } | { readonly kind: 'done'; readonly result: Json }>;
  runDispatchTx: <T>(fn: (tx: TWriteTx) => Promise<T>) => Promise<T>;
  checkFreshEvidence: () => Promise<void>;
  isLifecycleError: (error: unknown) => boolean;
}): TeachingDependencies['runEffect'] {
  return async (step, invoke) => {
    const { ledger } = params;
    const selected = ledger.notionWitnesses.size ? await params.loadSelected() : [];
    const selectionReceipt = selected.map(({ selection, pageId, watermark }) => ({
      selectionId: selection.id,
      generation: selection.selectionEpoch,
      pageId,
      watermark,
      purpose: params.purpose,
      recipient: params.notionRecipientId()!,
    }));
    const memorySend = ledger.buildMemorySend({
      step,
      learningMemoryContext: params.getLearningMemoryContext(),
      purpose: params.purpose,
      providerId: params.settings.activeProviderId,
      protocol: params.settings.protocol,
      workspaceRevision: params.submission.workspaceRevision,
    });
    const authorize = async (tx: TReadTx, current?: ProviderSettings, use: 'publish' | 'dispatch' = 'publish') => {
      const { manifest, pages } = await params.validWorkInputs(tx, use);
      current ??= await params.loadSettings();
      const jit = params.getJit();
      validateStepDispatchRules({
        step,
        learningV1: params.learningV1,
        hasRetention: ledger.retention.size > 0,
        hasSelected: selected.length > 0,
        selectedUnchanged: JSON.stringify(selected) === JSON.stringify(pages),
        settings: params.settings,
        current,
        submission: params.submission,
        hasJit: Boolean(jit),
        jitCounter: step.jitContext ? params.jitCounterFor(current) : undefined,
        grants: params.grants,
      });
      if (params.submission.workspaceRevision) await params.checkWorkspaceRoute(current);
      return manifest;
    };
    let dispatchDenied: unknown;
    const jit = params.getJit();
    const needsFreshEvidence = ledger.needsFreshEvidence(Boolean(jit), Boolean(memorySend));
    const recorded = teachingEffectStep(
      step,
      invoke,
      ledger.buildStepBasis({
        step,
        jitReceipt: jit?.receipt,
        selectionReceipt,
        hasMemorySend: Boolean(memorySend),
      }),
      memorySend,
    );
    const effect = await params
      .runEffect(
        recorded.request,
        async (requestId, checkDispatch) => {
          const dispatch: TeachingDispatch = async send => {
            try {
              if (selected.length) await params.confirmPages(selected);
              const { response } = await params.runDispatchTx(async tx => {
                await checkDispatch(tx);
                const current = params.submission.accountRevision ? await params.checkProviderAccount(tx) : undefined;
                if (params.submission.accountRevision && !current) throw new ChangedEvidence();
                await authorize(tx, current, 'dispatch');
                const response = send();
                void response.catch(() => {});
                return { response };
              });
              return response;
            } catch (error) {
              if (error instanceof ChangedEvidence || error instanceof TeachingError || params.isLifecycleError(error)) {
                dispatchDenied = error;
              }
              throw error;
            }
          };
          return recorded.invoke(requestId, dispatch);
        },
        async tx => {
          const manifest = await authorize(tx);
          await params.bindSources(tx, manifest);
        },
      )
      .catch(error => {
        if (params.isLifecycleError(error)) throw new ChangedEvidence();
        throw error;
      });
    if (dispatchDenied) throw params.isLifecycleError(dispatchDenied) ? new ChangedEvidence() : dispatchDenied;
    if (selected.length) await params.confirmPages(selected);
    if (needsFreshEvidence) await params.checkFreshEvidence();
    if (effect.kind === 'unknown') throw new UncertainEffect(effect.providerEffectId);
    return recorded.reply(effect.result);
  };
}
