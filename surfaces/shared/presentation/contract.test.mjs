import { test } from 'vitest';
import assert from 'node:assert/strict';
import { presentationCatalog, validateArtifact, operationLocks } from './index.ts';
import { titration, passage, rhythm, predictionLab } from './samples/examples.ts';

test('all three JSON definitions use the published v1 catalog', () => {
  for (const v of [titration, passage, rhythm]) {
    const raw = JSON.parse(JSON.stringify(v));
    assert.deepEqual(validateArtifact(raw), { ok: true, view: raw });
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify(presentationCatalog.schema)),
    presentationCatalog.schema,
  );
});
test('reject unsupported versions, duplicate object IDs, dangling bindings and extra executable properties', () => {
  const changes = [
    (v) => (v.version = 2),
    (v) => (v.sections[1].nodes[0].objects[0].id = 'volume'),
    (v) => (v.sections[1].nodes[0].objects.find((o) => o.id === 'meniscus').y.source = 'missing'),
    (v) => v.sections[1].nodes[1].values.pop(),
    (v) => (v.sections[2].nodes[0].initial = 0.5),
    (v) => (v.sections[2].nodes[0].values[3] = NaN),
    (v) => (v.sections[2].nodes[2].intent = 'grade'),
    (v) => (v.sections[2].nodes[2].inputs = ['curve']),
    (v) => (v.sections[1].nodes[0].objects[0].onClick = 'console.log(1)'),
    (v) => (v.sections[1].nodes[0].objects[0].stroke = 'url(https://example.org)'),
    (v) =>
      v.sections[0].nodes.push({
        kind: 'asset',
        id: 'asset',
        label: 'audio',
        assetId: 'https://example.org/song',
        media: 'audio',
      }),
  ];
  for (const change of changes) {
    const v = structuredClone(titration);
    change(v);
    assert.equal(validateArtifact(v).ok, false, String(change));
  }
});
test('new content with different identifiers resolves without a subject discriminator', () => {
  const v = structuredClone(rhythm);
  v.id = 'counterpoint';
  v.sections[0].nodes[1].id = 'wood';
  v.sections[0].nodes[3].lanes[0] = 'wood';
  v.sections[0].nodes[4].inputs[0] = 'wood';
  assert.equal(validateArtifact(v).ok, true);
  v.sections[0].nodes[2].items.pop();
  assert.equal(validateArtifact(v).ok, false);
});

test('aggregate budgets cover cross-scene paths, repeated media, and the entire input', () => {
  const section = (nodes) => ({
    ...titration,
    sections: [{ id: 'page', title: '图版', layout: 'stack', nodes }],
  });
  const scene = titration.sections[1].nodes[0];
  const figures = (count, points) =>
    section(
      Array.from({ length: 8 }, (_, s) => ({
        ...scene,
        id: 'scene-' + s,
        objects: Array.from({ length: count }, (_, o) => ({
          id: 'path-' + s + '-' + o,
          kind: 'line',
          stroke: 'ink',
          points: Array.from({ length: points }, () => ({ x: 1, y: 1 })),
        })),
      })),
    );
  assert.equal(validateArtifact(figures(64, 2)).ok, true);
  assert.match(validateArtifact(figures(65, 2)).error, /objects budget/);
  assert.equal(validateArtifact(figures(8, 64)).ok, true);
  assert.match(validateArtifact(figures(8, 65)).error, /points budget/);
  const assets = (n) =>
    section(
      Array.from({ length: n }, (_, i) => ({
        kind: 'asset',
        id: 'slot-' + i,
        assetId: 'photo',
        media: 'image',
        label: '照片',
      })),
    );
  assert.equal(validateArtifact(assets(4)).ok, true);
  assert.match(validateArtifact(assets(5)).error, /assets budget/);
  assert.equal(
    validateArtifact({
      ...titration,
      sections: Array(12).fill({
        id: 'x',
        nodes: Array(32).fill({ ...scene, objects: Array(96).fill(scene.objects[0]) }),
      }),
    }).ok,
    false,
  );
});

test('host-driven gates require declared targets, state domains and a matching host projection', () => {
  assert.equal(validateArtifact(predictionLab).ok, true);
  const mount = { mountId: 'm', stateRev: 2 },
    spec = predictionLab.interaction;
  const state = {
    version: 1,
    ...mount,
    artifactId: predictionLab.id,
    revision: predictionLab.revision,
    logic: spec.logic,
    inputs: { phase: 'experiment' },
  };
  const locked = (s) => operationLocks(predictionLab, mount, s).has('volume');
  assert.equal(locked(state), false);
  for (const s of [
    undefined,
    { ...state, stateRev: 1 },
    { ...state, mountId: 'other' },
    { ...state, logic: { ...state.logic, revision: 'r0' } },
    { ...state, inputs: { phase: 'unknown' } },
    { ...state, inputs: { phase: 'predict' } },
  ])
    assert.equal(locked(s), true);
  for (const edit of [
    (v) => (v.interaction.logic.script = 'code'),
    (v) => (v.interaction.version = 2),
    (v) => (v.interaction.operations[0].equals = 'unknown'),
    (v) => (v.interaction.operations[0].target = 'estimate'),
    (v) => (v.sections.at(-1).nodes[0].target = 'estimate'),
  ]) {
    const bad = structuredClone(predictionLab);
    edit(bad);
    assert.equal(validateArtifact(bad).ok, false);
  }
});
