import type { Json } from '@mangekyo/kernel';

export type MemoryIntent = 'tutoring' | 'planning' | 'execution' | 'history' | 'management';
const regionsByIntent = {
  tutoring: ['current_answer', 'preferences', 'claims', 'memory', 'course_knowledge', 'learner_model', 'verified_playbooks'],
  planning: ['goal', 'scheduled_tasks', 'preferences', 'claims', 'learner_model', 'todo', 'inventory'],
  execution: ['current_answer', 'todo', 'chronicle', 'verified_playbooks', 'experience'],
  management: ['claims'],
  history: ['current_answer', 'claims', 'memory', 'chronicle'],
} as const;
export type MemoryRegion = typeof regionsByIntent[MemoryIntent][number];
export type RegionPage = { region: MemoryRegion; start: number; basisDigest: string };
type Omission = { region: MemoryRegion; reason: 'unknown' | 'basis_stale' } |
  { region: MemoryRegion; reason: 'budget'; expand: RegionPage };
export type ContextBundle = { intent: MemoryIntent; data: Partial<Record<MemoryRegion, Json[]>>; omitted: Omission[] };
type RecallWitness = {id: string; rev: number};
export type SentWitness<W> = W & { fragment?: { itemId: string; slotId: 'answer'; end?: number } |
  { field: 'answer'; start: number; end: number } };
export type RecallItem<W> = { value: Json; sent: SentWitness<W>[]; basis?: W[]; expiresAt?: string };
export type RecallRegions<W> = Map<MemoryRegion, RecallItem<W>[]>;

type Digest = (text: string) => string;

function regionPage<W extends RecallWitness>(region: MemoryRegion, start: number, candidates: readonly RecallItem<W>[], digest: Digest): RegionPage {
  const basisDigest = digest(JSON.stringify(candidates.map(item => [item.sent, item.basis ?? []])));
  return { region, start, basisDigest };
}

function packBundle<W extends RecallWitness>(intent: MemoryIntent, regions: readonly MemoryRegion[], results: RecallRegions<W>, maxBytes: number, digest: Digest, page?: RegionPage) {
  const bundle: ContextBundle = { intent, data: {}, omitted: [] };
  const selected: RecallItem<W>[] = [];
  if (page && regionPage(page.region, page.start, results.get(page.region) ?? [], digest).basisDigest !== page.basisDigest) {
    bundle.omitted.push({ region: page.region, reason: 'basis_stale' });
    return { bundle, selected };
  }
  for (const region of regions) {
    const candidates = results.get(region) ?? [];
    const start = page?.start ?? 0;
    if (start >= candidates.length) bundle.omitted.push({ region, reason: 'unknown' });
    else bundle.omitted.push({ region, reason: 'budget', expand: regionPage(region, start, candidates, digest) });
  }
  for (const region of regions) {
    const candidates = results.get(region) ?? [];
    const items: Json[] = [];
    for (let index = page?.start ?? 0; index < candidates.length; index++) {
      const entry = candidates[index]!;
      const rest = bundle.omitted.filter(item => item.region !== region);
      if (index + 1 < candidates.length) rest.push({ region, reason: 'budget', expand: regionPage(region, index + 1, candidates, digest) });
      const data = { ...bundle.data, [region]: [...items, entry.value] };
      if (Buffer.byteLength(JSON.stringify({ ...bundle, data, omitted: rest })) > maxBytes) break;
      items.push(entry.value);
      bundle.data = data;
      bundle.omitted = rest;
      selected.push(entry);
    }
  }
  return { bundle, selected };
}

export function recallRegions(intent: MemoryIntent, maxBytes: number, expand?: RegionPage) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16_384) throw new Error('记忆预算须在 1–16 KiB。');
  const available: readonly MemoryRegion[] = regionsByIntent[intent];
  if (expand && (!available.includes(expand.region) || !Number.isSafeInteger(expand.start) || expand.start < 0 ||
      !/^[a-f0-9]{64}$/.test(expand.basisDigest)))
    throw new Error('记忆展开位置无效。');
  return expand ? [expand.region] : available;
}

export function recallPacket<W extends RecallWitness>(intent: MemoryIntent, regions: readonly MemoryRegion[],
  results: RecallRegions<W>, maxBytes: number, digest: Digest, page?: RegionPage) {
  const { bundle, selected } = packBundle(intent, regions, results, maxBytes, digest, page);
  const context = JSON.stringify(bundle);
  const sent = selected.flatMap(item => item.sent);
  const witnesses = (items: readonly RecallItem<W>[]) => [...new Map(items.flatMap(item =>
    [...(item.basis ?? []), ...item.sent].map(ref => [`${ref.id}:${ref.rev}`, ref] as const))).values()];
  const opened = witnesses([...results.values()].flat());
  const basis = witnesses(selected);
  const expiresAt = selected.flatMap(item => item.expiresAt ? [item.expiresAt] : []).sort()[0] ?? null;
  return { bundle, context, receipt: { digest: digest(context), opened, basis, sent, expiresAt } };
}
