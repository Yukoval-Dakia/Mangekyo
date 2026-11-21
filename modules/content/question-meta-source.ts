import { AssetBasisError, assetType, parseAsset, parseTextbookReference, questionPrompt,
  type AssetBasis, type AssetReadContext, type AssetReference } from './asset.ts';
import { fields, record } from './parse.ts';
import { projectPublicCaptureMaterial } from './question-public-capture.ts';

function sourceReference(learner: AssetReadContext['learner'], ref: string, basis: readonly AssetBasis[]) {
  // Legacy bare question IDs identify the designated prompt of a single witnessed revision.
  const bare = basis.filter(source => source.id === ref && source.type === assetType);
  if (bare.length === 1) return { witness: bare[0]! };
  let reference: AssetReference;
  try {
    const wire = record(JSON.parse(ref));
    fields(wire, 'v', 'fact', 'anchor');
    if (wire.v !== 1) return undefined;
    const fact = record(wire.fact);
    fields(fact, 'id', 'rev', 'type');
    reference = parseTextbookReference({ fact: { learner, id: fact.id, rev: fact.rev }, type: fact.type, anchor: wire.anchor });
  } catch {
    return undefined;
  }
  const { fact, type, anchor } = reference;
  if (anchor.kind !== 'block') return undefined;
  const witness = basis.find(source => source.id === fact.id && source.rev === fact.rev && source.type === type);
  return witness && { witness, anchor };
}

/** Reopen the authorized source and return the fixed public block reference. */
export async function pinQuestionHintSource(
  { learner, read }: AssetReadContext, ref: string, basis: readonly AssetBasis[],
) {
  const unavailable = () => new AssetBasisError('微提示来源缺少获准的固定公开锚点。');
  const source = sourceReference(learner, ref, basis);
  if (!source) throw unavailable();
  const { witness: { id, rev, type, epoch }, anchor } = source;
  const fact = await read.fact(id, { mode: 'pinned', rev, requirePurpose: 'teaching' });
  if (fact.ref.learner !== learner || fact.ref.id !== id || fact.ref.rev !== rev ||
      fact.type !== type || fact.accessEpoch !== epoch || !fact.purpose.some(use => use === 'teaching' || use === 'all'))
    throw unavailable();
  let blockId: string | undefined;
  if (fact.type === assetType) {
    const asset = parseAsset(fact.value);
    if (asset.kind === 'question' && (!anchor || anchor.blockId === asset.promptBlockId) && questionPrompt(asset).trim())
      blockId = asset.promptBlockId;
  }
  if (fact.type === 'capture.source' && anchor && projectPublicCaptureMaterial(fact.value, anchor)) blockId = anchor.blockId;
  if (!blockId) throw unavailable();
  return JSON.stringify({ v: 1, fact: { id, rev, type }, anchor: { kind: 'block', blockId } });
}
