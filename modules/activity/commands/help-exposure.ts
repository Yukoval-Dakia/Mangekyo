import { defineCommand, type CommandContext } from '@mangekyo/kernel';
import {
  helpAppliesTo,
  helpExposure,
  helpExposureInput,
  helpExposureType,
  recordHelpExposureCommand,
  sameHelpTarget,
  type HelpExposureEvent,
  type HelpPresentation,
  type HelpRef,
} from '../help-exposure-values.ts';
import { storagePurpose } from '../library-values.ts';

function readPinned(ctx: CommandContext, ref: HelpRef) {
  return ctx.read.fact(ref.id, { mode: 'pinned', rev: ref.rev });
}

async function readHelp(ctx: CommandContext, ref: HelpRef) {
  const fact = await readPinned(ctx, ref);
  if (fact.type !== helpExposureType) throw new Error('帮助事件引用无效。');
  return helpExposure(fact.value);
}

async function verifyPresentation(ctx: CommandContext, presentation: HelpPresentation): Promise<void> {
  await readPinned(ctx, presentation.mount.issuance);
  await readPinned(ctx, presentation.content);
}

async function readDisplay(ctx: CommandContext, ref: HelpRef) {
  const event = await readHelp(ctx, ref);
  if (event.kind !== 'displayed') throw new Error('需要实际展示的帮助记录。');
  await verifyPresentation(ctx, event);
  return event;
}

async function verifyActionOrSubmission(ctx: CommandContext, ref: HelpRef): Promise<void> {
  if ((await readPinned(ctx, ref)).type === helpExposureType) {
    throw new Error('需要独立的实际操作或作答记录。');
  }
}

async function verifyReferences(ctx: CommandContext, data: HelpExposureEvent): Promise<void> {
  switch (data.kind) {
    case 'prepared':
    case 'offered':
    case 'opened':
    case 'displayed':
      await verifyPresentation(ctx, data);
      return;
    case 'used': {
      const display = await readDisplay(ctx, data.display);
      if (!helpAppliesTo(display, data.target)) throw new Error('使用的帮助不覆盖此作答。');
      await verifyActionOrSubmission(ctx, data.operation);
      return;
    }
    case 'assisted-completion': {
      const use = await readHelp(ctx, data.use);
      if (use.kind !== 'used' || !sameHelpTarget(use.target, data.answer.target)) {
        throw new Error('需要与此作答对应的实际使用记录。');
      }
      await readDisplay(ctx, use.display);
      await verifyActionOrSubmission(ctx, use.operation);
      await verifyActionOrSubmission(ctx, data.answer.submission);
      return;
    }
    case 'follow-up':
      await readDisplay(ctx, data.display);
      await verifyActionOrSubmission(ctx, data.answer.submission);
      return;
  }
}

export default defineCommand({
  type: recordHelpExposureCommand,
  destructive: false,
  schema: { parse: helpExposureInput },
  write: async (ctx, { id, data }) => {
    await verifyReferences(ctx, data);
    return [{ kind: 'create', id, factType: helpExposureType, data, purpose: [storagePurpose] }];
  },
});
