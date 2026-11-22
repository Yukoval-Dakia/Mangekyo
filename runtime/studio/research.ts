import { createResearchHost, researchReadSnapshot, researchSettingInput } from '../../modules/companion/research-host-support.ts';
import { eligibleBasis, executeWorksheet, modelReviewSpec, worksheetView } from '../research/worksheet.ts';
import { grantHooks, workerCap, workerOffer } from '../research/worker-dispatch.ts';
import { workerConsent } from '../../modules/companion/worker-consent.ts';
import type { WorkerTariff } from '../../executors/teaching/research-worker.ts';
import type { Client } from '@temporalio/client';
import { startOrWakeCoordinator } from '../../executors/temporal/src/index.ts';
import type { AdvanceCoordinator } from '../../executors/temporal/src/worker.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { consumePricedEffect, effectBudgetUsage } from '../../kernel/src/work/effects.ts';
import { lockLearner, withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import {
  acknowledgeStartedWork, cancelWork, failWork, finishWork, readWork, type WorkRef,
} from '../../kernel/src/work/index.ts';
import {
  cancelResearchTodos, checkTodoTriggers, emitTodo, enqueueWork,
  readTodo, recordTodoEvent, saveFactWatermark, todoSlot, type TodoSpec,
} from '../../kernel/src/work/todos.ts';
import { workspaceEntryType } from '../../modules/activity/workspace-values.ts';
import { workbookCorrectionType } from '../../modules/activity/workbook-correction.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { setWorkbookResearchUse, workbookAttempt, workbookAttemptType, workbookPaperType } from '../../modules/activity/workbook-values.ts';
import {
  allowRetentionReview, configureResearch,
  researchPurpose, researchScoutBudget, researchSettingsType, retentionReviewPermission, retentionReviewPermissionType,
} from '../../modules/companion/research.ts';
import { stableId, studioLearner } from './identity.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { readMissedPosttest } from './learner-radar.ts';
import { newResearchWatermark } from './research-foreground.ts';
import {
  activeRetentionReview, comparisonAttempts, independentScoutSource, readWorksheet, researchReader,
  currentResearchSettings as settings, settingsId, retentionReviewPermissionId, whenAvailable, workbookSource,
} from './research-sources.ts';
import {
  preparePaidResearchTriage, prepareResearchTriage, researchDecision, scoutEffectIdentity,
} from './research-triage-host.ts';
import { sampleResearchScout, ScoutAuthorizationChanged, type ResearchScoutHost } from './research-scout.ts';
import { discoverUnderstandingTodos, eligibleExtraction, openUnderstandingExtraction, paidExtractionRecipient, type UnderstandingTransport } from './research-understanding.ts';
import { activityEvidenceTypes, turnEvidenceType } from '../../modules/companion/activity-evidence.ts';
import { extractorProfile } from '../../modules/companion/understanding.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { correctionRetestDeriver, eligibleCorrectionRetest, executeCorrectionRetest, registerCorrectionRetest, type CorrectionRetestAuthority } from './research-correction.ts';

const scope = { learner: studioLearner };
const wakeSlot = 'companion.researchWake';
const wake = { slotType: wakeSlot, slotKey: settingsId, deriver: 'studio/research-wake-v1' };
const idleRecheckMs = 60_000;

async function updateSettings<T>(action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error && /Fact revision conflict|Fact already exists|Command ID already used/.test(error.message))
      throw new RequestError(409, '教研设置或原作用途已更新，请重新核对。');
    throw error;
  }
}

const researchHostDeps = {
  scope, wake, idleRecheckMs, eligibleBasis, executeWorksheet, modelReviewSpec, worksheetView, workerOffer,
  grantHooks, startOrWakeCoordinator, effectBudgetUsage, createCommandHandler, consumePricedEffect,
  researchSettingsType, workbookCorrectionType, storagePurpose, setWorkbookResearchUse, settingsId,
  retentionReviewPermissionType, researchPurpose, workbookAttempt, workbookPaperType, workspaceEntryType,
  activityEvidenceTypes, turnEvidenceType, newResearchWatermark, comparisonAttempts, activeRetentionReview,
  researchReader, retentionReviewPermissionId, readWorksheet, whenAvailable, extractorProfile,
  openUnderstandingExtraction, eligibleExtraction, discoverUnderstandingTodos, eligibleCorrectionRetest,
  registerCorrectionRetest, correctionRetestDeriver, executeCorrectionRetest, prepareResearchTriage,
  preparePaidResearchTriage, researchDecision, scoutEffectIdentity, sampleResearchScout,
  ScoutAuthorizationChanged, independentScoutSource, checkTodoTriggers, emitTodo, recordTodoEvent,
  enqueueWork, cancelResearchTodos, saveFactWatermark, readWork, acknowledgeStartedWork, finishWork,
  cancelWork, failWork, settings, createStudioCommandHooks, workbookAttemptType, workbookSource, lockLearner,
  workerCap, paidExtractionRecipient, clientRequest, RequestError, workerConsent, researchScoutBudget,
  updateSettings, configureResearch, commandId, stableId, readMissedPosttest, retentionReviewPermission,
  withinLearnerTransaction, wakeSlot, todoSlot, allowRetentionReview,
};

export function openResearch(db: any, activity: any, companion: any, scoutHost?: any, understandingTransport?: any,
  correctionAuthority?: any, tariff?: any, carePause?: {paused: (tx: ReadTransaction, now?: number) => Promise<boolean>}) {
  return createResearchHost(researchHostDeps).openResearch(db, activity, companion, scoutHost, understandingTransport,
    correctionAuthority, tariff, carePause);
}
