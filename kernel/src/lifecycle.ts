import { lockLearner } from './db/learner.ts';
import type { Db, DbQuery, LearnerScope, ReadTransaction } from './db/types.ts';
import type { CommandId, FactId } from './declarations/ids.ts';
import type { Actor } from './commands/contracts.ts';

export async function migrateLifecycle(tx: DbQuery) {
  await tx.query(`CREATE TABLE tombstones (
    learner_id text NOT NULL REFERENCES learners(id), id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('fact','command')), generation bigint NOT NULL,
    PRIMARY KEY (learner_id,kind,id))`);
  await tx.query(`CREATE TABLE erasure_requests (
    learner_id text NOT NULL REFERENCES learners(id), request_id text NOT NULL, root_id text NOT NULL,
    expected_rev integer NOT NULL, generation bigint NOT NULL, object_removed boolean NOT NULL DEFAULT false,
    PRIMARY KEY (learner_id,request_id), UNIQUE (learner_id,root_id))`);
  // Already-running v7 processes also acquire the learner lock, but do not know about v8.
  await tx.query(`CREATE FUNCTION reject_erased_identity() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target text;
    BEGIN
      IF TG_TABLE_NAME='effects' THEN target := NEW.owner_id; ELSE target := NEW.id; END IF;
      IF EXISTS (SELECT FROM tombstones WHERE learner_id=NEW.learner_id AND kind=TG_ARGV[0]
                 AND id=target) THEN
        RAISE EXCEPTION 'Erased identity' USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $$`);
  for (const [table,kind] of [['facts','fact'], ['commands','command'], ['effects','fact']]) {
    await tx.query(`CREATE TRIGGER fence_erased_identity BEFORE INSERT OR UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION reject_erased_identity('${kind}')`);
  }
  await tx.query('UPDATE kernel_runtime_identity SET minimum_worker_schema=8');
}

export class LifecycleError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

export async function deletionState(tx: ReadTransaction) {
  const {rows} = await tx.query<{id: string; generation: string}>(
    `SELECT id,generation::text FROM tombstones WHERE learner_id=$1 AND kind='fact'
     ORDER BY tombstones.generation DESC,id`, [tx.learner]);
  return {watermark: rows[0]?.generation ?? '0', tombstones: rows};
}

export async function deletionWatermark(tx: ReadTransaction) {
  const {rows:[row]} = await tx.query<{watermark: string}>(
    'SELECT COALESCE(max(generation),0)::text AS watermark FROM erasure_requests WHERE learner_id=$1', [tx.learner]);
  return row!.watermark;
}

export async function assertDeletionWatermark(tx: ReadTransaction, expected: string) {
  if (await deletionWatermark(tx) !== expected) throw new LifecycleError(409, '删除状态已变化。请丢弃旧请求并同步设备。', 'deletion_watermark_stale');
}

export async function assertUnburned(tx: ReadTransaction, kind: 'command' | 'fact', ids: readonly string[]) {
  if (!ids.length) return;
  const {rows} = await tx.query('SELECT 1 FROM tombstones WHERE learner_id=$1 AND kind=$2 AND id=ANY($3::text[]) LIMIT 1',
    [tx.learner, kind, ids]);
  if (rows.length) throw new LifecycleError(410, '这项内容已永久删除。');
}

export type ErasureRequest = {
  actor: Actor; confirmed: boolean; requestId: CommandId; root: FactId; expectedRev: number;
};

// The trusted host resolves the owned aggregate and verifies its revision while the learner is locked.
export async function eraseOriginal(db: Db, scope: LearnerScope, request: ErasureRequest,
  resolve: (tx: ReadTransaction) => Promise<{ids: readonly FactId[]; commandTypes: readonly string[]}>,
  unlinkOriginal: () => Promise<void>) {
  if (request.actor !== 'learner' || request.confirmed !== true) throw new LifecycleError(403, '须由学习者明确确认永久删除。');
  const keys = [scope.learner, request.requestId, request.root] as const;
  const saved = await db.tx(scope, async tx => {
    await lockLearner(tx, tx.learner);
    const {rows:[prior]} = await tx.query<{root_id: string; request_id: string; expected_rev: number; generation: string; object_removed: boolean}>(
      'SELECT * FROM erasure_requests WHERE learner_id=$1 AND (request_id=$2 OR root_id=$3)', keys);
    if (prior) {
      if (prior.request_id !== request.requestId || prior.root_id !== request.root || prior.expected_rev !== request.expectedRev)
        throw new LifecycleError(409, '删除标识或材料版本与已有请求不符。');
      return prior;
    }
    const {ids,commandTypes} = await resolve(tx);
    if (!ids.includes(request.root)) throw new Error('Missing erasure root');
    return tx.withLearnerWrite(async tick => {
      await tx.insert('erasure_requests', {learner_id:tx.learner, request_id:request.requestId, root_id:request.root,
        expected_rev:request.expectedRev, generation:tick});
      await tx.query(`INSERT INTO tombstones SELECT $1,id,'fact',$3::bigint FROM unnest($2::text[]) AS id`,
        [tx.learner, ids, tick]);
      await tx.query(`INSERT INTO tombstones
        SELECT $1,c.id,'command',$3::bigint FROM commands c WHERE c.learner_id=$1 AND (
          EXISTS (SELECT 1 FROM fact_revs r WHERE r.learner_id=$1 AND r.fact_id=ANY($2) AND r.command_id=c.id)
          OR (c.type=ANY($4) AND (c.input #>> '{input,intakeId}'=ANY($2) OR c.input #>> '{input,materialId}'=ANY($2))))`,
        [tx.learner, ids, tick, commandTypes]);
      const commands = "SELECT id FROM tombstones WHERE learner_id=$1 AND kind='command' AND generation=$2";
      await tx.query(`DELETE FROM proposals WHERE learner_id=$1 AND command_id IN (${commands})`, [tx.learner,tick]);
      await tx.query(`DELETE FROM commands WHERE learner_id=$1 AND id IN (${commands})`, [tx.learner,tick]);
      await tx.query('DELETE FROM fact_revs WHERE learner_id=$1 AND fact_id=ANY($2)', [tx.learner,ids]);
      await tx.query('DELETE FROM facts WHERE learner_id=$1 AND id=ANY($2)', [tx.learner,ids]);
      await tx.query('DELETE FROM effects WHERE learner_id=$1 AND owner_id=ANY($2)', [tx.learner,ids]);
      await tx.query(`UPDATE work SET state='cancelled',generation=generation+1,execution_ref=NULL,gather=NULL,gather_manifest=NULL
        WHERE learner_id=$1 AND slot_key=ANY($2) AND family='derivation'`, [tx.learner,ids]);
      await tx.query("UPDATE slot_state SET pending='none',last_error=NULL,changed_tick=$3 WHERE learner_id=$1 AND slot_key=ANY($2)",
        [tx.learner,ids,tick]);
      return {generation:tick, object_removed:false};
    });
  });
  let removed = saved.object_removed;
  if (!removed) {
    try { await unlinkOriginal(); removed = true; } catch { /* retry the same request after storage recovery */ }
    if (removed) await db.tx(scope, tx => tx.withLearnerWrite(() => tx.query(
      'UPDATE erasure_requests SET object_removed=true WHERE learner_id=$1 AND request_id=$2', keys.slice(0,2))));
  }
  return {id:request.root, generation:saved.generation, blocked:true, original:removed ? 'removed' : 'pending',
    copies:'unverified', backups:'unverified', devices:'unverified'} as const;
}
