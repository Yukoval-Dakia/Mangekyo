import { defineCommand, factId } from '@mangekyo/kernel';
import material from '@mangekyo/module-content/facts/material';
import { captureMaterial, intakePurpose } from '../intake-values.ts';

export default defineCommand({
  type: captureMaterial,
  destructive: false,
  schema: {
    parse(input: unknown) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('记录格式无效');
      const { id, data } = input as Record<string, unknown>;
      if (typeof id !== 'string' || !id.trim() || id.length > 4000) throw new Error('记录字段无效');
      return { id: factId(id), data: material.schema.parse(data) };
    },
  },
  write: (_ctx, { id, data }) => [
    { kind: 'create', id, factType: material.type, data, purpose: [intakePurpose] },
  ],
});
