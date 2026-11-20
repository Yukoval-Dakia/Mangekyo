import { fileURLToPath } from 'node:url';
import { loadModuleDirectory } from '../../../kernel/src/loader.ts';

export function loadStudioTestModule(name: string) {
  return loadModuleDirectory(fileURLToPath(new URL('../../../modules/' + name, import.meta.url)));
}
