import { openNotionReadTransport } from '@mangekyo/executor-document-extraction/notion';
import { NotionTemporaryFailure, notionVersion } from '../../modules/capture/notion-api.ts';
import { RequestError } from './sessions.ts';

export function notionConnection() {
  const local = process.env.MANGEKYO_NOTION_TEST_ORIGIN;
  if (local && !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(local)) throw new Error('Invalid local Notion test origin');
  const origin = local || 'https://api.notion.com';
  const token = local ? 'isolated-notion-fixture' : process.env.MANGEKYO_NOTION_TOKEN;
  return openNotionReadTransport(origin, token, notionVersion,
    (status, message) => status === 502 ? new NotionTemporaryFailure(status) : new RequestError(status, message));
}
