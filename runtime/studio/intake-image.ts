import sharp from 'sharp';
import type {ImageCrop, StudyImage} from '../../executors/teaching/workspace-tools.ts';
import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import type {FactSnapshot} from '../../kernel/src/declarations/types.ts';
import {intakeFactType, type IntakeOriginal} from '../../modules/activity/intake-values.ts';
import {materialType} from '../../modules/activity/library-values.ts';
import type {SourceRefV1} from '../../modules/activity/source-values.ts';
import {readIntakeOriginalBytes} from './intake.ts';
import {intakeTextOf} from './reading.ts';
import {resolveSource, type SourceTrack, type WorkspaceSourceRecipient} from './source-read.ts';
import {learningToolError, parseLearningReference, unreadable} from './workspace-open.ts';

export type IntakeImage = {
  sourceRef: SourceRefV1;
  title: string;
  original: Pick<IntakeOriginal, 'size' | 'sha256' | 'mediaType'>;
  crop?: ImageCrop;
};

export async function planIntakeImage(tx: ReadTransaction, input: string, crop: ImageCrop | undefined, access: {
  known: (id: string) => boolean;
  maySend: WorkspaceSourceRecipient;
  track: SourceTrack;
}) {
  const ref = parseLearningReference(input);
  if (!ref || (typeof ref !== 'string' && (ref.fact.type !== materialType || ref.anchor.kind !== 'whole')))
    return learningToolError('invalid_args','refs','请使用交入材料 id 或其整份 sourceRef。');
  const id = typeof ref === 'string' ? ref : ref.fact.id;
  const witnesses: FactSnapshot[] = [];
  const source = await resolveSource(tx, ref, {recipient:'workspace', maySend:access.maySend, track: fact => witnesses.push(fact)});
  if (!source) return unreadable(tx,id,access.known(id),access.maySend);
  const {sourceRef, title} = source;
  const document = witnesses.find(fact => fact.type === intakeFactType && fact.ref.id === sourceRef.textFact?.id);
  if (sourceRef.fact.type !== materialType || !document)
    return learningToolError('image_unavailable','refs','请使用带 PNG 或 JPEG 原件的交入材料。');
  const {mediaType, size, sha256} = intakeTextOf(document).original;
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg')
    return learningToolError('image_unavailable','refs','原图裁剪目前支持 PNG 和 JPEG。');
  for (const witness of witnesses) access.track(witness, 'pinned');
  return {sourceRef, title, original:{mediaType,size,sha256}, ...(crop && {crop})} satisfies IntakeImage;
}

const maxInputPixels = 16_000_000;
const maxCropBytes = 1100 * 1024;

export async function cropIntakeImage({sourceRef, title, original, crop}: IntakeImage) {
  const unavailable = () => learningToolError('image_unavailable','refs','无法读取这份 PNG 或 JPEG 原件，原图上限为 1600 万像素。');
  try {
    const bytes = await readIntakeOriginalBytes(sourceRef.fact.id, original);
    const decoder = sharp(bytes, {limitInputPixels:maxInputPixels, failOn:'warning'});
    const {format, width, height} = await decoder.metadata();
    if (format !== (original.mediaType === 'image/png' ? 'png' : 'jpeg') || !width || !height || width * height > maxInputPixels)
      return {value:unavailable()};
    if (crop && (crop.left > width - crop.width || crop.top > height - crop.height))
      return {value:learningToolError('invalid_args','crop',`裁剪区域须完全位于 ${width} × ${height} 像素的原图内。`,{
        tool:'open_learning', args:{refs:JSON.stringify(sourceRef),part:'image_crop'}, why:'先确认原图尺寸再选择区域。',
      })};
    const item = {id:sourceRef.fact.id, rev:sourceRef.fact.rev, title, sourceRef,
      part:{kind:'image_crop', ...(crop && {crop})}, width, height,
      content:crop ? '所选区域见本次工具结果配套的图像。' : '请用原件编码像素坐标选择要读取的矩形区域。'};
    const value = {ok:true, items:[item]};
    if (!crop) return {value};
    const output = await decoder.extract(crop).png().toBuffer();
    if (output.length > maxCropBytes) return {value:learningToolError('image_unavailable','crop','裁剪图超过大小上限，请缩小区域。')};
    const image: StudyImage = {mediaType:'image/png', data:output.toString('base64')};
    return {value, image};
  } catch {
    return {value:unavailable()};
  }
}
