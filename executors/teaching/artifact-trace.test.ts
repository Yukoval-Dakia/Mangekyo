import {expect, it} from 'vitest';
import {projectArtifactMountTrace} from './artifact-trace.ts';

it.each([
  ['挂载交互作品 · {"ok":false,"field":"any","message":"private","next":{"tool":"mount_artifact"}}', '挂载交互作品 · 未挂载'],
  ['挂载交互作品 · {"error":"old receipt"}', '挂载交互作品 · 未挂载'],
  ['挂载交互作品 · {"state":"done","mountId":"private"}', '挂载交互作品 · 已挂载'],
  ['挂载交互作品 · {"state":"rejected","commandId":"private"}', '挂载交互作品 · 未挂载'],
  ['挂载交互作品 · {"ok":false,"message":"clipped', '挂载交互作品'],
  ['参数错误 · mount_artifact', '挂载交互作品 · 未挂载'],
  ['读取学情雷达', '读取学情雷达'],
])('projects mount receipts by operation and public state', (raw, expected) => {
  expect(projectArtifactMountTrace(raw)).toBe(expected);
  expect(projectArtifactMountTrace(expected)).toBe(expected);
});
