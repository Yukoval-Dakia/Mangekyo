import { defineCommand } from '@mangekyo/kernel';
import { creation, object, offlinePackRecord, studyRecord, studyRecordType, submitOfflinePack } from '../values.ts';

export default defineCommand({
  type: submitOfflinePack,
  destructive: true,
  schema: creation(input => {
    const raw = object(input);
    if (raw.consent !== 'teaching') throw new Error('请确认保存本次学习记录。');
    return { ...studyRecord(raw.record), offlinePack: offlinePackRecord(raw.pack) };
  }),
  write: (_ctx, { id, data }) => [{
    kind: 'create', id, factType: studyRecordType,
    data: { ...data, submittedAt: new Date().toISOString() },
    purpose: ['storage', 'teaching'],
  }],
});
