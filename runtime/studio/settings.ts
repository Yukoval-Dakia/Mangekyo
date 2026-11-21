import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, DbTransaction } from '../../kernel/src/db/types.ts';
import { studioLearner } from './identity.ts';
import type { ModelTask } from '../../executors/teaching/model-routes.ts';
import { readJsonConfig, writeJsonConfig } from '../../executors/teaching/local-config.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  completeReplacement, defaultStored as defaultProviderSettings, flatten, mergeSettings, normalizeSaved,
  providerAccount, publicSettings, type ProviderAccount, type ProviderSettings,
} from '../../executors/teaching/provider-settings.ts';
export { providerAccount, publicSettings } from '../../executors/teaching/provider-settings.ts';
export type { ProviderAccount, ProviderProfile, ProviderProtocol, ProviderSettings, McpServer } from '../../executors/teaching/provider-settings.ts';

const defaultStored = () => defaultProviderSettings(process.env.MANGEKYO_LLM_BASE_URL, process.env.MANGEKYO_LLM_API_KEY);

function settingsFile() {
  return process.env.MANGEKYO_SETTINGS_FILE || join(homedir(), '.config', 'mangekyo', 'provider.json');
}

function environmentExaApiKey() {
  return process.env.MANGEKYO_EXA_API_KEY || process.env.EXA_API_KEY || '';
}

const readStored = () => readJsonConfig(settingsFile(), defaultStored, normalizeSaved);

export async function loadSettings(task?: ModelTask): Promise<ProviderSettings> {
  return flatten(await readStored(), task, environmentExaApiKey());
}

let updating: Promise<unknown> = Promise.resolve();
export function saveSettings(input: Record<string, unknown>) {
  const update = updating.then(async () => {
    const prior = await readStored().catch((error) => {
      if (!completeReplacement(input)) throw error;
      return defaultStored();
    });
    const next = mergeSettings(prior, input);
    await writeJsonConfig(settingsFile(), { version: 2, ...next });
    return publicSettings(flatten(next, undefined, environmentExaApiKey()));
  });
  updating = update.catch(() => {});
  return update;
}

export function saveLearnerSettings(db: Db, input: Record<string, unknown>) {
  return db.tx({learner: studioLearner}, async tx => {
    await lockLearner(tx, tx.learner);
    return saveSettings(input);
  });
}

/** Bind a fresh explicitly authorized send to the current account, including legacy settings. */
export async function freezeProviderAccount(tx: DbTransaction, task?: ModelTask) {
  await lockLearner(tx, tx.learner);
  let settings = await loadSettings(task);
  if (settings.providers.some(provider => !provider.credentialRevision)) {
    await saveSettings({});
    settings = await loadSettings(task);
  }
  return {settings, account: providerAccount(settings)!};
}

/** Returns the exact settings to use while the caller still holds the learner lock. */
export async function checkProviderAccount(tx: DbTransaction, expected: ProviderAccount, task?: ModelTask) {
  await lockLearner(tx, tx.learner);
  const settings = await loadSettings(task);
  const current = providerAccount(settings);
  if (current?.providerId === expected.providerId && current.accountRevision === expected.accountRevision) return settings;
  return undefined;
}
