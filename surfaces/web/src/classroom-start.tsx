import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, requestId, type Settings } from './api';
import { recordFromQuery, recordLabel } from './current-record';
import { chatRoute } from './model-route';
import { PageTitle } from './workspace';
import { recentRooms, rejected, rememberRoom, roomPath, roomApi, writeRoom, type Classroom, type ClassroomWrite } from './classroom-contract';
import {
  builtInStudyMethodTemplates,
  loadSelectedStudyMethodTemplateId,
  loadStoredStudyMethodTemplates,
  saveSelectedStudyMethodTemplateId,
  STUDY_METHOD_STEP_META,
  StudyMethodTemplateDrawer,
  type StudyMethodTemplate,
} from './StudyMethodTemplateDrawer';

export function ClassroomStart({ settings }: {settings?: Settings | undefined}) {
  const query = new URLSearchParams(location.search);
  const currentObject = recordFromQuery(query);
  const [topic, setTopic] = useState('');
  const [minutes, setMinutes] = useState('');
  const [pending, setPending] = useState<ClassroomWrite>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [methodTemplates, setMethodTemplates] = useState<readonly StudyMethodTemplate[]>(() =>
    loadStoredStudyMethodTemplates(),
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(() =>
    loadSelectedStudyMethodTemplateId(),
  );
  const [methodDrawerOpen, setMethodDrawerOpen] = useState(false);
  const sending = useRef(false);
  const from = query.get('from');
  const [seed, setSeed] = useState<'loading' | 'ready' | 'failed'>(from ? 'loading' : 'ready');
  const selectedTemplate = useMemo(
    () =>
      methodTemplates.find((item) => item.templateId === selectedTemplateId) ??
      methodTemplates[0] ??
      builtInStudyMethodTemplates[0]!,
    [methodTemplates, selectedTemplateId],
  );
  useEffect(() => {
    if (!from) return;
    const controller = new AbortController();
    void api<Classroom>(roomApi(from), {signal: controller.signal}).then(prior => {
      if (prior.id !== from || prior.carePause) throw new Error();
      if (controller.signal.aborted) return;
      setTopic(prior.topic);
      setMinutes(String(prior.minutes));
      setSeed('ready');
    }).catch(() => {if (!controller.signal.aborted) setSeed('failed');});
    return () => controller.abort();
  }, [from]);
  const route = settings && chatRoute(settings, 'companion');
  const blocked = !route || (currentObject && !route.accountRevision);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || blocked || !topic.trim()) return;
    sending.current = true;
    setBusy(true);
    setError('');
    const baseBody = {
      requestId: requestId(), topic: topic.trim(), ...(minutes && {minutes: Number(minutes)}),
      ...(currentObject && {currentObject}), route,
    };
    const operation = pending ?? {
      path: '/classrooms',
      body: {
        ...baseBody,
        studyMethodTemplateId: selectedTemplate.templateId,
        studyMethodTemplateVersion: selectedTemplate.version,
      },
    };
    setPending(operation);
    try {
      let room: Classroom;
      try {
        room = await writeRoom(operation);
      } catch (firstFailure) {
        // 若现行后端严格拒绝未知模板字段，则静默降级为纯基础字段重发，绝不阻断开课。
        if (
          !pending &&
          firstFailure instanceof ApiError &&
          firstFailure.status === 400 &&
          'studyMethodTemplateId' in operation.body
        ) {
          const fallbackOperation: ClassroomWrite = { path: '/classrooms', body: baseBody };
          setPending(fallbackOperation);
          room = await writeRoom(fallbackOperation);
        } else {
          throw firstFailure;
        }
      }
      rememberRoom(room.id);
      location.assign(roomPath(room.id));
    } catch (failure) {
      if (rejected(failure)) setPending(undefined);
      setError(failure instanceof ApiError ? failure.message : '尚未收到开课回执，可重发同一请求。');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const rooms = recentRooms();
  if (seed !== 'ready') return <><PageTitle title="学习课堂" /><p role="status">{seed === 'loading' ? '正在读取原课堂…' : '当前无法读取原课堂主题。'}</p><a href="/classroom">自行填写主题</a></>;
  if (query.has('record') && !currentObject) return <><PageTitle title="学习课堂" /><p role="alert">记录链接缺少有效版本，请从原记录重新进入。</p><a href="/classroom">按主题开课</a></>;
  return <>
    <PageTitle title="学习课堂" />
    <form className="reading-paper classroom-form" onSubmit={submit}>
      <label className="field classroom-field">这节课想学什么？<textarea required maxLength={300} value={topic} disabled={!!pending} onChange={event => setTopic(event.target.value)} rows={4} placeholder="写下你想搞懂的知识点、卡住的一道题，或直接贴上题干…" /></label>
      <div className="classroom-minutes">
        <label className="field classroom-field">可用时间（分钟，可选）<input type="number" min="5" max="90" step="1" value={minutes} disabled={!!pending} onChange={event => setMinutes(event.target.value)} placeholder="例如 20" /></label>
        <div className="classroom-quick" role="group" aria-label="快捷时长">
          {[10,20,30].map(value => <button key={value} type="button" className="classroom-pill" data-active={minutes === String(value)} disabled={!!pending} onClick={() => setMinutes(String(value))}>{value} 分钟</button>)}
        </div>
      </div>
      <div className="classroom-method-card" aria-label="当前已选学法模板">
        <div className="classroom-method-head">
          <div className="classroom-method-title-wrap">
            <span className="classroom-method-kicker">本次课堂学法模板</span>
            <strong className="classroom-method-name">
              {selectedTemplate.name}
              <span className="smt-version-pill">v{selectedTemplate.version}</span>
            </strong>
          </div>
          <button
            type="button"
            className="classroom-pill"
            disabled={!!pending}
            aria-haspopup="dialog"
            aria-expanded={methodDrawerOpen}
            onClick={() => setMethodDrawerOpen(true)}
          >
            选择 / 共创学法模板
          </button>
        </div>
        <div className="smt-step-chain">
          {selectedTemplate.steps.map((step, idx) => (
            <span key={step.stepId} className="smt-chain-pill">
              {idx + 1}. {STUDY_METHOD_STEP_META[step.kind].label}
            </span>
          ))}
        </div>
      </div>
      {currentObject && <p>随课使用的记录：{recordLabel(currentObject)}　<a href="/classroom">解除关联</a></p>}
      {route && <p className="classroom-route">本次教学账户 · {route.model}</p>}
      {blocked && <p role="status">请检查学习设置中的教学账户后刷新。</p>}
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status" className="classroom-form-wait">正在为你开课；首次生成课堂通常需要一到两分钟，请勿重复提交。</p>}
      <button className="primary-button" disabled={busy || !!blocked || !topic.trim()}>{busy ? '正在开课…' : pending ? '重发开课请求' : '开始上课'}</button>
    </form>
    <StudyMethodTemplateDrawer
      open={methodDrawerOpen}
      templates={methodTemplates}
      selectedTemplateId={selectedTemplate.templateId}
      onSelectTemplate={(template) => {
        setSelectedTemplateId(template.templateId);
        saveSelectedStudyMethodTemplateId(template.templateId);
      }}
      onTemplatesChange={(nextTemplates) => setMethodTemplates(nextTemplates)}
      onClose={() => setMethodDrawerOpen(false)}
    />
    {!!rooms.length && <section className="surface-section"><h2>本机打开过的课堂</h2><ul>{rooms.map(id => <li key={id}><a href={roomPath(id)}>打开课堂 · {id.slice(-8)}</a></li>)}</ul></section>}
  </>;
}
