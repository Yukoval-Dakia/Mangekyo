import { test } from 'vitest';
import assert from 'node:assert/strict';
import { presentationCatalog, validateArtifact } from './index.ts';
import { titration, passage, rhythm } from './samples/examples.ts';

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
