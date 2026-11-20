import { LifecycleError } from '../../kernel/src/lifecycle.ts';

export function submittedWatermark(input: unknown): string {
  const raw = input && typeof input === 'object' && 'deletionWatermark' in input ? input.deletionWatermark : undefined;
  if (raw === undefined) return '0';
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(raw)) throw new LifecycleError(400,'删除水位无效。');
  return raw;
}
