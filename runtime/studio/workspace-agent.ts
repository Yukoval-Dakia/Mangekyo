import { type NotionRecipient } from './notion.ts';
import {
  commandId, factId, isFactUnavailable, isJson, isKernelErrorKind,
  type Db, type Json, type Manifest, type ReadTransaction, type Revision,
} from '../../kernel/src/index.ts';
import {canonicalJsonString} from '../../kernel/src/commands/canonical.ts';
import {recordLocalRead} from '../../kernel/src/work/effects.ts';
import {TeachingError} from '../../executors/teaching/provider.ts';
import type {PreparedPythonAttempts} from '../../executors/teaching/study-agent.ts';
import {
  observationToolInput, parseOpenLearningArgs, presentationTool, validateWorkspaceToolArgs,
  workspaceStoredReceipt, workspaceWriteResult, type ReceiveStudyImage, type WorkspaceWriteReceipt,
} from '../../executors/teaching/workspace-tools.ts';
import type {SourceTrack} from './source-read.ts';
import {workspaceSearch, workspaceRead, workspaceAssessmentBasis, type WorkspaceAssessmentBasis} from './workspace-read.ts';
import {openLearningBatch} from './workspace-open.ts';
import {learningToolError} from '../../executors/teaching/tool-error.ts';
import {readLearnerRadar, readRetentionBasis, verifyRetentionBases, type RetentionBasis} from './learner-radar.ts';
import {parseLearningReference, sourceReference, sourceRefV1, type SourceRefV1} from '../../modules/activity/source-values.ts';
import {posttestSubmissionType} from '../../modules/activity/retention-posttest.ts';
import {workbookAttemptType, workbookPaperType, WorkbookSourceMismatch} from '../../modules/activity/workbook-values.ts';
import {organizerNoteType} from '../../modules/activity/organizer-values.ts';
import {
  WorkspaceInputError, workspaceAttemptTypes, workspaceEntry, workspaceEntryType,
  workspaceInput, workspaceProofKey, type WorkspaceEntryBasis, type WorkspaceWitness,
} from '../../modules/activity/workspace-values.ts';
export {workspaceInput, workspaceProofKey, type WorkspaceWitness};
import {purpose, stableId, studioHost, studioLearner, studioModule, toWitness, ulidExact} from './identity.ts';
import {createStudioCommandHooks} from './command-hooks.ts';
import {readPythonAttempts} from './python-attempts.ts';
import {cropIntakeImage, planIntakeImage, type IntakeImage} from './intake-image.ts';
import {presentationCatalog} from '../../surfaces/shared/presentation/index.ts';
import {mountArtifact} from './presentation-store.ts';
import type { ReadArtifactAssessmentWitness } from './artifact-assessment.ts';
import type { OpenedCurrentLearningObject } from './current-learning-object.ts';
import {textbookPageType} from '../../modules/content/textbook-page.ts';
import {openedAnswerCitations} from '../../modules/companion/belief.ts';
import {openObjectiveActivity} from './belief-evidence.ts';
import type {ActivityCitation} from '../../modules/companion/understanding.ts';
import {openWorkspaceQuestion, type DraftWitness} from './workspace-question.ts';
import {openWorkspaceTextbook} from './workspace-textbook.ts';
import {openWorkspaceRelation, type OpenedRelationSource} from './workspace-relation.ts';
import { projectReadReceipts, reopenWorkspaceBasis } from './workspace-receipts.ts';
const artifactTool = presentationTool(presentationCatalog.schema, presentationCatalog.bindings);
type Seen = {id: string; title: string; text: string; workspace: true};
const toolError = (code: Parameters<typeof learningToolError>[0], field: string | undefined, message: string,
  next?: Parameters<typeof learningToolError>[3]) => JSON.stringify(learningToolError(code, field, message, next));
type WorkspaceToolsOptions = {
  db: Db; turn: string; narrowSaves?: true; draftBasis?(): DraftWitness[];
  authorize: (tx: ReadTransaction) => Promise<void>; maySend: NotionRecipient;
  track: (input: WorkspaceWitness, checkAtDispatch?: true) => void;
  trackAssessment?: (basis: WorkspaceAssessmentBasis) => void;
  trackRetention?: (basis: RetentionBasis) => void; trackDiagnosis?: () => void;
  beliefTools?: boolean; presentationManifest?: (tx: ReadTransaction) => Promise<Manifest>;
  readArtifactAssessmentWitness?: ReadArtifactAssessmentWitness | undefined;
  prior: WorkspaceWitness[]; learningBasis?(): readonly WorkspaceWitness[];
  pageBasis?: readonly WorkspaceWitness[]; jitBasis?: readonly WorkspaceWitness[];
  currentObject?: OpenedCurrentLearningObject | undefined;
};
export function openWorkspaceTools(options: WorkspaceToolsOptions) {
  const { db, turn, currentObject, narrowSaves } = options, host = studioHost(db);
  let publishedFormalArtifact = false;
  const sources = new Map(options.prior.map(w => [w.id, w]));
  const jitBasis = [...(options.jitBasis ?? []), ...options.prior.filter(w => w.jitBasis)];
  const overviewBasis = new Map<string, WorkspaceWitness>();
  const writeBasis = new Map(options.prior.filter(w => w.writeBasis).map(w => [`${w.id}:${w.rev}`, w]));
  const retainForWrites = (w: WorkspaceWitness) => writeBasis.set(`${w.id}:${w.rev}`, { ...w, writeBasis: true });
  const opened = new Map<string, Seen>(), openedAnswers = new Map<string, WorkspaceWitness>();
  const beliefEvidence = new Map<string, ReturnType<typeof openedAnswerCitations>[number]>();
  const produced = new Map<string, number>(), receipts = new Map<string, WorkspaceWriteReceipt>();
  const saveQuestion = options.draftBasis && openWorkspaceQuestion(db, turn, options.maySend, options.authorize, options.draftBasis,
    (receipt, command) => receipts.set(command, { ...receipt, title: receipt.title || '题目草稿' }));
  const pageSources = new Map<string, WorkspaceWitness>(), pageOpened = new Map<string, WorkspaceWitness>();
  const relationOpened = new Map<string, OpenedRelationSource>();
  const rememberRelationOpen = (ref: SourceRefV1, witness: WorkspaceWitness) => {
    if (ref.anchor.kind !== 'whole') return;
    const key = `${witness.id}:${witness.rev}`;
    relationOpened.delete(key); relationOpened.set(key, { ref, witness });
  };
  const saveRelation = openWorkspaceRelation({ db, turn, opened: relationOpened, authorize: options.authorize, maySend: options.maySend,
    modelBasis: () => [...jitBasis, ...(options.learningBasis?.() ?? [])], saved(key, receipt) { receipts.set(key, receipt); } });
  const rememberPageSource = (w: WorkspaceWitness) => pageSources.set(`${w.id}:${w.rev}`, w);
  const rememberPageOpen = (w: WorkspaceWitness) => pageOpened.set(`${w.id}:${w.rev}`, w);
  const admitSource = (w: WorkspaceWitness) => { sources.set(w.id, w); if (w.type === workspaceEntryType) retainForWrites(w); };
  for (const w of [...(options.pageBasis ?? []), ...options.prior]) rememberPageSource(w);
  const savePage = openWorkspaceTextbook({
    db, turn, authorize: options.authorize, maySend: options.maySend, opened: pageOpened,
    basis() {
      for (const witness of options.learningBasis?.() ?? []) rememberPageSource(witness);
      for (const witness of pageSources.values()) options.track(witness, true);
      return [...pageSources.values()];
    },
    ...(currentObject?.root.type === textbookPageType ? { currentPage: currentObject.root } : {}),
    saved(receipt, witness) {
      receipts.set(receipt.page?.status === 'saved' ? receipt.page.undo_token : receipt.page!.proposalId, receipt);
      if (witness) rememberPageOpen(witness);
    },
  });
  if (currentObject && options.jitBasis === undefined) {
    const { view, root, basis, openedAnswer } = currentObject;
    for (const witness of basis) { options.track(witness, true); rememberPageSource(witness); }
    rememberPageOpen(root); rememberRelationOpen(view.sourceRef, root); admitSource(root);
    opened.set(root.id, { id: root.id, workspace: true, title: view.title, text: view.content });
    if (openedAnswer) openedAnswers.set(root.id, root);
  }
  async function read(name: string, args: Record<string, unknown>, step: number, priorRead?: Promise<unknown>, receiveImage?: ReceiveStudyImage) {
    const pythonAttempts = name === 'python_attempts';
    if (!isJson(args)) return toolError('invalid_args', 'args', '请将查询字段放在一个 JSON 对象里。');
    const raw = await recordLocalRead(db, { learner: studioLearner, ownerKind: 'session', ownerId: turn,
      stepKey: String(step), label: 'local:' + name, input: args }, async tx => {
      const witnesses = new Map<string, WorkspaceWitness>();
      const track: SourceTrack = (fact, mode) => {
        if (!(mode === 'pinned' && witnesses.has(`${fact.ref.id}:${fact.ref.rev}`)))
          witnesses.set(`${fact.ref.id}:${fact.ref.rev}`, toWitness(fact, mode));
      };
      const assessmentBasis: WorkspaceAssessmentBasis[] = [], retentionBasis: RetentionBasis[] = [];
      const trackAssessment = options.trackAssessment ? (basis: WorkspaceAssessmentBasis) => assessmentBasis.push(basis) : undefined;
      const maySend = options.maySend, known = (id: string) => sources.has(id);
      let text: string, intakeImage: IntakeImage | undefined, todoBasis: Awaited<ReturnType<typeof readLearnerRadar>>['todoBasis'];
      if (name === 'open_learning') {
        const parsed = parseOpenLearningArgs(args), access = { known, maySend, track, trackAssessment };
        if ('ok' in parsed) text = JSON.stringify(parsed);
        else if (parsed.part.kind === 'image_crop') {
          const plan = await planIntakeImage(tx, parsed.refs[0]!, parsed.part.crop, access);
          if ('ok' in plan) text = JSON.stringify(plan); else { intakeImage = plan; text = JSON.stringify({ ok: true }); }
        } else text = JSON.stringify(await openLearningBatch(tx, { ...parsed, part: parsed.part },
          { ...access, currentObject: currentObject?.view }, async (id, itemTrack) => {
            const ref = parseLearningReference(id);
            if (options.beliefTools && ref && typeof ref !== 'string' && ref.fact.type === posttestSubmissionType &&
                ref.anchor.kind === 'answer-slot' && ref.anchor.slotId === 'answer' && !ref.anchor.path?.length) {
              const source = await openObjectiveActivity(tx, ref.fact.id, purpose, maySend), itemId = ref.anchor.itemId;
              const fragment = source?.ref.rev === ref.fact.rev ? source.fragments.find(item => item.anchor === itemId) : undefined;
              if (source && fragment) {
                itemTrack(source.fact, 'following');
                return JSON.stringify({ id: source.ref.id, rev: source.ref.rev, title: '后测原答',
                  content: fragment.text.slice(0, 600).toWellFormed(), sourceRef: sourceReference(source.fact, ref.anchor) });
              }
            }
            return workspaceRead(tx, { id }, itemTrack, maySend, parsed.part.kind === 'assessment' ? trackAssessment : undefined);
          }));
      } else if (name === 'read_workspace') text = await workspaceRead(tx, args, track, maySend, trackAssessment);
      else if (name === 'read_learner_radar') {
        const radar = await readLearnerRadar(tx, args, maySend, track, options.trackRetention ? b => retentionBasis.push(b) : undefined);
        text = JSON.stringify(radar.view); todoBasis = radar.todoBasis;
      } else if (pythonAttempts) text = JSON.stringify(await readPythonAttempts(tx, args, { known, maySend, track }));
      else text = await workspaceSearch(tx, args, track, maySend);
      return JSON.stringify({ text, witnesses: [...witnesses.values()], assessmentBasis, intakeImage, todoBasis, sourceProjection: 1,
        ...(pythonAttempts && { pythonAttemptsProjection: 1 }), ...(name === 'read_workspace' && { workbookProjection: 1 }),
        ...(name === 'read_learner_radar' && { retentionBasis }) });
    }, options.authorize);
    if (priorRead) await priorRead;
    const { text: storedText, witnesses, assessmentBasis = [], workbookProjection, sourceProjection, pythonAttemptsProjection,
      todoBasis, retentionBasis = [], intakeImage } = JSON.parse(raw) as {
      text: string; witnesses: WorkspaceWitness[]; assessmentBasis?: WorkspaceAssessmentBasis[]; workbookProjection?: number;
      sourceProjection?: number; pythonAttemptsProjection?: number; retentionBasis?: RetentionBasis[];
      intakeImage?: IntakeImage; todoBasis?: { source: { id: string } };
    };
    let text = storedText, value = JSON.parse(text);
    const legacyWorkbookRead = name === 'read_workspace' && workbookProjection !== 1 && value.sourceRef?.anchor.kind === 'whole' &&
      [workbookPaperType, workbookAttemptType].includes(value.sourceRef.fact.type);
    const storedItems: typeof value[] = name === 'open_learning' ? value.items ?? [] : [value];
    if (sourceProjection !== 1 && (name === 'read_workspace' || name === 'open_learning') && storedItems.some(item => {
      const ref = sourceRefV1(item.sourceRef);
      return ref?.fact.type === organizerNoteType && ref.anchor.kind === 'whole';
    })) throw new TeachingError('evidence_scope', '笔记读取规则已变化，请重新发送。');
    const current = await host.snapshot(async tx => {
      if (legacyWorkbookRead || (pythonAttempts && pythonAttemptsProjection !== 1)) return false;
      const maySend = options.maySend;
      let bankWitnesses: WorkspaceWitness[] = [], derivedSource = false;
      try { ({ bankWitnesses, derivedSource } = await reopenWorkspaceBasis(host, tx, witnesses, maySend)); }
      catch (error) { if (isFactUnavailable(error) || error instanceof WorkbookSourceMismatch) return false; throw error; }
      if (derivedSource && sourceProjection !== 1) throw new TeachingError('evidence_scope', '观察的题源须重新核对，请重新发送。');
      if ((assessmentBasis.length && !options.trackAssessment) || (retentionBasis.length && !options.trackRetention)) return false;
      for (const basis of assessmentBasis) {
        const actual = await workspaceAssessmentBasis(tx, basis.slot, maySend);
        if (!actual || canonicalJsonString(actual) !== canonicalJsonString(basis)) return false;
      }
      if (!await verifyRetentionBases(tx, retentionBasis, maySend)) return false;
      const directOpen = name === 'open_learning' || (name === 'read_workspace' && value.sourceRef);
      for (const w of witnesses) options.track(w,
        w.id === todoBasis?.source.id || pythonAttempts || derivedSource || intakeImage || directOpen ? true : undefined);
      for (const w of bankWitnesses) options.track(w, true);
      for (const basis of assessmentBasis) options.trackAssessment?.(basis);
      for (const basis of retentionBasis) options.trackRetention?.(basis);
      await options.authorize(tx);
      return true;
    });
    if (!current) {
      if (retentionBasis.length) throw new TeachingError('evidence_scope', '保持依据已变化，本轮结果无法使用。');
      if (assessmentBasis.length || legacyWorkbookRead) throw new TeachingError('evidence_scope', '作答依据已变化，本轮结果无法使用。');
      if (pythonAttempts) throw new TeachingError('evidence_scope', '计算所选的依据已变化，请重新发送。');
      const open = name === 'open_learning';
      return toolError('basis_stale', open ? 'refs' : undefined, open ? '读取依据在打开后已变化。' : '读取依据已变化，请重新查询。',
        { tool: name, args, why: open ? '重新读取当前获准的版本。' : '按当前用途重新读取。' });
    }
    if (intakeImage) {
      if (intakeImage.crop && !receiveImage) return toolError('image_unavailable', 'part', '当前调用入口不接收原图裁剪。');
      // Replay the pixel read from the verified original. The journal holds only its pinned basis.
      const result = await cropIntakeImage(db, intakeImage);
      value = result.value; text = JSON.stringify(value);
      if (result.image) {
        receiveImage?.(result.image);
        for (const w of witnesses) { retainForWrites(w); rememberPageSource(w); rememberPageOpen(w); }
      }
      if (value.ok) for (const w of witnesses) { overviewBasis.set(w.id, w); rememberPageSource(w); }
    } else for (const w of witnesses) rememberPageSource(w);
    if (pythonAttempts) {
      if (value.ok !== true) return text;
      for (const w of witnesses) {
        admitSource(w);
        if (!opened.has(w.id)) opened.set(w.id, { id: w.id, workspace: true,
          title: w.type === workbookAttemptType ? '已提交作答' : '学习依据', text: '本轮 Python 统计所用的记录。' });
      }
      return JSON.stringify({ ...value, witnesses });
    }
    projectReadReceipts(name, args, value, witnesses, todoBasis?.source.id, {
      admit: admitSource, overview: w => overviewBasis.set(w.id, w), diagnose: () => options.trackDiagnosis?.(),
      open: item => opened.set(item.id, { ...item, workspace: true }), openPage: rememberPageOpen,
      openRelation: rememberRelationOpen, openAnswer: w => openedAnswers.set(w.id, w),
    });
    const values: typeof value[] = name === 'open_learning' ? value.items ?? [] : [value];
    if (options.beliefTools && (name === 'open_learning' || name === 'read_workspace')) {
      const citations = await host.snapshot(async tx => {
        await options.authorize(tx);
        const entries = [];
        for (const item of values) {
          const ref = sourceRefV1(item.sourceRef);
          if (!ref || item.ok === false || (ref.anchor.kind !== 'whole' && ref.anchor.kind !== 'answer-slot') ||
              (typeof item.content !== 'string' && typeof item.content !== 'number')) continue;
          const source = await openObjectiveActivity(tx, ref.fact.id, purpose, options.maySend);
          if (source?.ref.rev === ref.fact.rev &&
              witnesses.some(w => w.id === source.ref.id && w.rev === source.ref.rev && w.epoch === source.ref.accessEpoch))
            entries.push(...openedAnswerCitations(source, source.ref, String(item.content),
              ref.anchor.kind === 'answer-slot' ? ref.anchor.itemId : undefined));
        }
        return entries;
      });
      if (citations.length) {
        for (const citation of citations) beliefEvidence.set(`${citation.id}:${citation.anchor}`, citation);
        return JSON.stringify({ ...value, belief_evidence: citations });
      }
    }
    return text;
  }
  async function save(args: Record<string, unknown>, step: number, observation?: WorkspaceWitness[]) {
    if (!isJson(args)) return toolError('invalid_args', 'args', '请将保存字段放在一个 JSON 对象里。');
    const { id: target, rev: expected, ...fields } = args;
    if (target !== undefined && (typeof target !== 'string' || !ulidExact.test(target)))
      return toolError('invalid_args', 'id', '新建省略 id。修改时使用已打开记录的 id。');
    const id = typeof target === 'string' ? target : stableId('workspace-entry', turn, String(step));
    const rev = target ? Math.max(produced.get(id) ?? 0, sources.get(id)?.rev ?? 0) || undefined : undefined;
    const reopen = { tool: 'open_learning', args: { refs: id }, why: '读取当前获准版本。' };
    if (target && !rev) return toolError('evidence_not_opened', 'id', '先打开要修改的记录。', reopen);
    if (expected !== undefined && expected !== rev) return toolError('version_conflict', 'rev', 'rev 与本轮读到的版本不符。', reopen);
    let entry: Record<string, unknown> = fields, previousBasis: readonly WorkspaceEntryBasis[] = [];
    if (rev) {
      const original = await host.snapshot(tx => host.readOrNull(tx, purpose, factId(id), { mode: 'pinned', rev: rev as Revision }));
      if (!original) return toolError('access_revoked', 'id', '要修改的记录当前不可读。');
      if (original.type !== workspaceEntryType) return toolError('invalid_args', 'id', (workspaceAttemptTypes.includes(original.type)
        ? '要补充作答，请先用 read_workspace 打开原答，再新建 kind="annotation" 的批注。'
        : '要整理这份材料，请新建 kind="page" 的教材页。') + ' 省略 id，把原记录的 id 放入 links。');
      const { basis, ...savedFields } = workspaceEntry(original.value);
      previousBasis = basis; entry = { ...savedFields, ...fields };
    }
    const witnesses = observation ? new Map(observation.map(w => [w.id, w])) : new Map(sources);
    for (const link of Array.isArray(entry.links) ? entry.links : []) if (typeof link === 'string' && produced.has(link)) {
      const own = await host.snapshot(tx => host.read(tx, purpose).fact(factId(link), { mode: 'pinned', rev: produced.get(link) as Revision }));
      witnesses.set(link, toWitness(own));
    }
    const changesEvidence = !rev || Object.hasOwn(fields, 'body') || Object.hasOwn(fields, 'links');
    if (changesEvidence && (entry.kind === 'observation' || entry.kind === 'annotation') &&
        !(Array.isArray(entry.links) && entry.links.some(link => typeof link === 'string' && (options.jitBasis !== undefined
          ? openedAnswers.has(link) : opened.has(link) && workspaceAttemptTypes.includes(sources.get(link)?.type ?? '')))))
      return toolError('evidence_not_opened', 'links', '先打开原始作答，再把其 id 放入 links。');
    // Fields retained by a patch still depend on the sources of the previous revision; a write can also reuse
    // the images and derived records included in its context.
    const basisById = new Map<string, { id: string; rev: number; epoch: string }>(previousBasis.map(w => [w.id, w]));
    for (const w of witnesses.values()) if (w.id !== id && !basisById.has(w.id)) basisById.set(w.id, { id: w.id, rev: w.rev, epoch: w.epoch });
    for (const { id: sourceId, rev: sRev, epoch } of [...(currentObject?.basis ?? []), ...writeBasis.values(), ...jitBasis]) {
      if (sourceId === id) continue;
      const previous = basisById.get(sourceId);
      if (previous && (previous.rev !== sRev || previous.epoch !== epoch))
        return toolError('basis_stale', 'evidence_refs', '本轮关联的依据已有其他版本，请重新打开后再保存。');
      basisById.set(sourceId, { id: sourceId, rev: sRev, epoch });
    }
    const handle = host.commandHandler([await studioModule('activity')],
      createStudioCommandHooks({ afterFactsChanged: tx => options.authorize(tx) }));
    const key = commandId(stableId('workspace-command', turn, String(step)));
    // Readiness is checked again while holding the command transaction's learner lock.
    await host.snapshot(options.authorize);
    try {
      const receipt = await handle({ learner: studioLearner, actor: 'companion', purpose, id: key, type: 'activity.saveWorkspaceEntry',
        input: { id, ...(rev !== undefined && { expectedRev: rev }), entry: entry as Json, basis: [...basisById.values()] } });
      const written = receipt.wrote[0];
      if (written) {
        produced.set(written.id, written.rev);
        receipts.set(written.id, workspaceStoredReceipt(written, entry, key, Boolean(observation)));
      }
      return JSON.stringify(workspaceWriteResult(receipt.state, key, written, Boolean(observation)));
    } catch (error) {
      if (error instanceof TeachingError) throw error;
      // Return domain validation feedback to the model; never return SQL/transport details.
      if (isFactUnavailable(error)) return toolError('access_revoked', observation ? 'evidence_refs' : 'links', '写入所需的依据当前不可读。');
      if (error instanceof WorkspaceInputError)
        return toolError(error.message.includes('来源版本') ? 'basis_stale' : 'invalid_args', observation ? 'evidence_refs' : undefined,
          error.message, observation && { tool: 'open_learning', args: { refs: observation.map(w => w.id) }, why: '重新核对作答和版本。' });
      if (isKernelErrorKind(error, 'revision_conflict')) return toolError('version_conflict', 'rev', '条目已更新。读取当前版本后重试。', reopen);
      if (error instanceof Error && error.message === 'Only an unedited companion draft can be revised')
        return toolError('invalid_args', 'id', '该记录由学习者保留。可省略 id 新建条目，再用 links 关联。');
      throw error;
    }
  }
  async function recordObservation(args: Record<string, unknown>, step: number) {
    const input = observationToolInput(args, value => Boolean(parseLearningReference(value)));
    if ('ok' in input) return JSON.stringify(input);
    const evidence = new Map<string, WorkspaceWitness>();
    for (const rawRef of input.refs) {
      const ref = parseLearningReference(rawRef)!, id = typeof ref === 'string' ? ref : ref.fact.id, w = openedAnswers.get(id);
      if (!w || (typeof ref !== 'string' && (w.rev !== ref.fact.rev || w.type !== ref.fact.type)))
        return toolError('evidence_not_opened', 'evidence_refs', '请先打开这份原答。',
          { tool: 'open_learning', args: { refs: id }, why: '用本轮实际读到的原答支持观察。' });
      evidence.set(id, w);
    }
    return save({ kind: 'observation', title: input.title, body: input.text, links: [...evidence.keys()] }, step, [...evidence.values()]);
  }
  async function execute(name: string, args: Record<string, unknown>, step: number, priorRead?: Promise<unknown>, receiveImage?: ReceiveStudyImage) {
    if (name === 'mount_artifact' && options.presentationManifest) {
      if (Object.keys(args).some(key => !['view', 'predictionPrompt', 'sentenceBreaks'].includes(key)))
        return toolError('invalid_args', 'args', '仅支持 view、predictionPrompt 和 sentenceBreaks。');
      const result = await mountArtifact(db, turn, step, args, async tx => {
        await options.authorize(tx);
        return options.presentationManifest!(tx);
      }, options.readArtifactAssessmentWitness);
      if (args.sentenceBreaks !== undefined && 'state' in result && result.state === 'done') publishedFormalArtifact = true;
      return JSON.stringify(result);
    }
    if (narrowSaves && (name === 'save_workspace' || name === 'save_relation'))
      return toolError('tool_unavailable', 'name', '请按本轮目录选择保存工具。');
    if (narrowSaves && name === 'save_question' && saveQuestion) return JSON.stringify(await saveQuestion(args, step));
    const invalid = validateWorkspaceToolArgs(narrowSaves && name === 'save_edge' ? 'save_relation' : name, args);
    if (invalid) return JSON.stringify(invalid);
    if (name === 'record_observation') return recordObservation(args, step);
    if (name === 'save_page') return JSON.stringify(await savePage(args, step));
    if (name === (narrowSaves ? 'save_edge' : 'save_relation')) return JSON.stringify(await saveRelation(args, step));
    return name === 'save_workspace' ? save(args, step) : read(name, args, step, priorRead, receiveImage);
  }
  return {
    ...(narrowSaves && { narrowSaves }), ...(options.presentationManifest && { presentationTool: artifactTool }),
    execute: (name: string, args: Record<string, unknown>, step: number, receiveImage?: ReceiveStudyImage) =>
      execute(name, args, step, undefined, receiveImage),
    preparePythonAttempts: async (args: Record<string, unknown>, step: number): Promise<PreparedPythonAttempts> =>
      JSON.parse(await read('python_attempts', args, step)),
    executeRead: execute, saveQuestion,
    openedBeliefEvidence({ id, rev, accessEpoch, anchor, excerpt }: ActivityCitation) {
      const hit = beliefEvidence.get(`${id}:${anchor}`);
      return hit?.rev === rev && hit.accessEpoch === accessEpoch && excerpt !== undefined && hit.excerpt.includes(excerpt);
    },
    knows: (id: string) => sources.has(id), publishedFormalArtifact: () => publishedFormalArtifact,
    reads: () => [...opened.values()], writes: () => [...receipts.values()],
    basis() {
      const basis = new Map([...options.prior, ...sources.values(), ...overviewBasis.values()].map(w => [workspaceProofKey(w), w]));
      for (const w of [...(options.learningBasis?.() ?? []), ...writeBasis.values()]) basis.set(workspaceProofKey(w), w);
      for (const w of jitBasis) basis.set(workspaceProofKey(w), { ...w, writeBasis: true, jitBasis: true });
      return [...basis.values()];
    },
  };
}
