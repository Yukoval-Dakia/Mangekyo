// @ts-expect-error Domain packages must not depend on the kernel runtime package.
import type { Db } from '@mangekyo/kernel/db';

export const forbiddenDatabase: Db | undefined = undefined;
