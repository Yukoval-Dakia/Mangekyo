import type { CommandHooks } from '../../kernel/src/index.ts';
import { createPropagationHooks, type SlotPropagationPolicy } from '../../kernel/src/derivations/propagation.ts';

export function createStudioCommandHooks({
  policies = [],
  afterFactsChanged,
}: {
  /** Register policies only for declared slots with a dispatcher in this runtime. */
  readonly policies?: readonly SlotPropagationPolicy[];
  readonly afterFactsChanged?: CommandHooks['onFactsChanged'];
} = {}): ReturnType<typeof createPropagationHooks> {
  // Sessions and workbook assessments still schedule through their own paths.
  const propagation = createPropagationHooks(policies);
  return {
    ...propagation,
    async onFactsChanged(tx, tick, changes) {
      await propagation.onFactsChanged(tx, tick, changes);
      await afterFactsChanged?.(tx, tick, changes);
    },
  };
}
