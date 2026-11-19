import { test } from 'vitest';
import assert from 'node:assert/strict';
import { operationLocks, presentationCatalog, validateArtifact } from './index.ts';

const artifact = {
  version: 1, id: 'experiment', revision: 'r1', title: '操作实验', fallback: '记录加入的体积。',
  sections: [{ id: 'bench', title: '实验台', layout: 'stack', nodes: [
    { kind: 'range', id: 'volume', label: '已加入', unit: 'mL', values: [0, 1, 2], initial: 0 },
    { kind: 'scene', id: 'apparatus', label: '器材', description: '开阀后读数。', width: 220, height: 180,
      objects: [{ kind: 'stepTarget', id: 'valve', label: '开阀', source: 'volume', x: 80, y: 60 }] },
    { kind: 'action', id: 'record', label: '记录读数', intent: 'explore', inputs: ['volume'] },
  ] }],
  interaction: {
    version: 1, logic: { id: 'experiment-phase', revision: 'r1' },
    inputs: [{ id: 'phase', values: ['predict', 'experiment'] }],
    operations: [{ target: 'volume', input: 'phase', equals: 'experiment', unavailable: '先提交预测。' }],
  },
};

test('the generated experiment and its catalog survive JSON round trips', () => {
  const view = JSON.parse(JSON.stringify(artifact));
  assert.deepEqual(validateArtifact(view), { ok: true, view });
  assert.deepEqual(JSON.parse(JSON.stringify(presentationCatalog.schema)), presentationCatalog.schema);
});

test('the host unlocks the same experiment after accepting the prediction', () => {
  const mount = { mountId: 'activity', stateRev: 2 };
  const state = {
    version: 1, ...mount, artifactId: artifact.id, revision: artifact.revision,
    logic: artifact.interaction.logic, inputs: { phase: 'experiment' },
  };
  assert.equal(operationLocks(artifact, mount).has('volume'), true);
  assert.equal(operationLocks(artifact, mount, { ...state, stateRev: 1 }).has('volume'), true);
  assert.equal(operationLocks(artifact, mount, state).has('volume'), false);
});

test('malformed and oversized drawings are rejected before rendering', () => {
  const invalid = structuredClone(artifact);
  invalid.sections[0].nodes[1].objects[0].onClick = 'run()';
  assert.equal(validateArtifact(invalid).ok, false);
  const oversized = structuredClone(artifact);
  const scene = oversized.sections[0].nodes[1];
  oversized.sections[0].nodes.push(...Array.from({ length: 8 }, (_, index) => ({
    ...scene, id: 'scene-' + index,
    objects: Array.from({ length: 65 }, (_, object) => ({
      kind: 'label', id: 'label-' + index + '-' + object, x: 1, y: 1, text: '刻度',
    })),
  })));
  assert.match(validateArtifact(oversized).error, /objects budget/);
});
