import { readDocumentImage } from '@mangekyo/executor-document-extraction/image';
import { learningToolError } from '../../executors/teaching/tool-error.ts';
import type { ImageCrop, StudyImage } from '../../executors/teaching/workspace-tools.ts';
import type { Db, FactSnapshot, ReadTransaction } from '../../kernel/src/index.ts';
import { materialType } from '../../modules/activity/library-values.ts';
import { parseLearningReference, type SourceRefV1 } from '../../modules/activity/source-values.ts';
import { intakeFactType, type IntakeOriginal } from '../../modules/capture/intake-values.ts';
import { openIntakeObjects } from './intake-objects.ts';
import { intakeTextOf } from './reading.ts';
import { resolveSource, type SourceTrack, type WorkspaceSourceRecipient } from './source-read.ts';
import { unreadable } from './workspace-open.ts';
export type IntakeImage = { sourceRef: SourceRefV1; title: string; crop?: ImageCrop; original: Pick<IntakeOriginal, 'size' | 'sha256' | 'mediaType'> };
export async function planIntakeImage(tx: ReadTransaction, input: string, crop: ImageCrop | undefined,
  access: { known: (id: string) => boolean; maySend: WorkspaceSourceRecipient; track: SourceTrack }) {
  const ref = parseLearningReference(input);
  if (!ref || (typeof ref !== 'string' && (ref.fact.type !== materialType || ref.anchor.kind !== 'whole')))
    return learningToolError('invalid_args', 'refs', '请使用交入材料 id 或其整份 sourceRef。');
  const id = typeof ref === 'string' ? ref : ref.fact.id, witnesses: FactSnapshot[] = [];
  const source = await resolveSource(tx, ref, { recipient: 'workspace', maySend: access.maySend, track: f => witnesses.push(f) });
  if (!source) return unreadable(tx, id, access.known(id), access.maySend);
  const { sourceRef, title } = source, document = witnesses.find(f => f.type === intakeFactType && f.ref.id === sourceRef.textFact?.id);
  if (sourceRef.fact.type !== materialType || !document) return learningToolError('image_unavailable', 'refs', '请使用带 PNG 或 JPEG 原件的交入材料。');
  const { mediaType, size, sha256 } = intakeTextOf(document).original;
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') return learningToolError('image_unavailable', 'refs', '原图裁剪目前支持 PNG 和 JPEG。');
  witnesses.forEach(w => access.track(w, 'pinned'));
  return { sourceRef, title, original: { mediaType, size, sha256 }, ...(crop && { crop }) } satisfies IntakeImage;
}
const imageLimits = { maxInputPixels: 16_000_000, maxCropBytes: 1100 * 1024 };
export async function cropIntakeImage(db: Db, { sourceRef, title, original, crop }: IntakeImage): Promise<{ value: unknown; image?: StudyImage }> {
  const unavailable = () => ({ value: learningToolError('image_unavailable', 'refs', '无法读取这份 PNG 或 JPEG 原件，原图上限为 1600 万像素。') });
  try {
    const decoded = await readDocumentImage(await openIntakeObjects(db).read(sourceRef.fact.id, original), original.mediaType, crop, imageLimits);
    if (decoded.kind === 'unavailable') return unavailable();
    if (decoded.kind === 'too_large') return { value: learningToolError('image_unavailable', 'crop', '裁剪图超过大小上限，请缩小区域。') };
    const { width, height } = decoded;
    if (decoded.kind === 'out_of_bounds') return { value: learningToolError('invalid_args', 'crop', `裁剪区域须完全位于 ${width} × ${height} 像素的原图内。`,
      { tool: 'open_learning', args: { refs: JSON.stringify(sourceRef), part: 'image_crop' }, why: '先确认原图尺寸再选择区域。' }) };
    const item = { id: sourceRef.fact.id, rev: sourceRef.fact.rev, title, sourceRef, part: { kind: 'image_crop', ...(crop && { crop }) },
      width, height, content: crop ? '所选区域见本次工具结果配套的图像。' : '请用原件编码像素坐标选择要读取的矩形区域。' };
    return { value: { ok: true, items: [item] }, ...(decoded.image ? { image: decoded.image } : {}) };
  } catch { return unavailable(); }
}
