import { forTask } from './model-route';
import { createRoot } from 'react-dom/client';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, type Session, type Settings } from './api';
import { DemoClassroom } from './demo';
import { ClassroomPrint } from './classroom-print';
import { ClassroomStart } from './classroom-start';
import { ClassroomRoom } from './classroom';
import { Companion } from './companion';
import { SettingsDialog } from './settings';
import { StarterLesson, StarterPractice } from './starter';
import {WorkspaceLibrary, WorkspaceRecord} from './workspace-records';
import { Workbook } from './workbook';
import IssuedPapers from './issued-papers';
import { Organizer } from './organizer';
import { Intake } from './intake';
import { Mistakes } from './review';
import { QuestionBank } from './iqdb';
import {
  ReadState,
  Materials,
  SavedMaterial,
  Me,
  EditDialog,
  materialPath,
  useResource,
  type Workspace,
  type ChatLink,
} from './workspace';
import { Today } from './today';
import { AppShell, destinations } from './shell/AppShell';
import { IntakeSurface, TodaySurface } from './today-v2';
import type { Duration } from './today-pack';
import { WorkbookSurface, type CompanionCitation } from './workbook-v2';
import './styles/tokens.css';
import './styles.css';
import './shell.css';
import './learning.css';
import './styles/shell.css';

(() => {
  try {
    const stored = localStorage.getItem('mangekyo:theme');
    const dark = stored === 'dark' || (!stored && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    const theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#16211b' : '#eaf0e7';
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
})();

const PrintPaper = lazy(() => import('./print-paper'));
const StudioTextbooks = lazy(() => import('./textbook/StudioTextbooks'));

function readRoute() {
  return { pathname: location.pathname, search: location.search };
}

function resolveBreadcrumb(path: string, search: string): string[] {
  if (path === '/today' || path === '/plan') return ['今天'];
  if (path === '/companion') return ['同伴'];
  if (path === '/me') return ['我'];
  if (path === '/materials') {
    return new URLSearchParams(search).get('view') === 'iqdb' ? ['材料', '题库'] : ['材料'];
  }
  if (path === '/materials/workspace') return ['材料', '学习记录'];
  if (path.startsWith('/materials/records/')) return ['材料', '记录详情'];
  if (path === '/materials/riding') return ['材料', '示例讲义'];
  if (path.startsWith('/materials/saved/')) return ['材料', '已存材料'];
  if (path === '/textbooks') return ['材料', '教材'];
  if (path === '/textbooks/page') return ['材料', '教材编辑'];
  if (path === '/intake') return ['材料', '交入'];
  if (path === '/review') return ['材料', '错题回看'];
  if (path === '/notes') return ['材料', '笔记'];
  if (path === '/papers/issued') return ['材料', '已发试卷'];
  if (path === '/papers' || path.startsWith('/papers/')) return ['材料', '试卷'];
  if (path.startsWith('/practice/')) return ['材料', '练习'];
  if (path === '/classroom/first45') return ['材料', '示例课堂'];
  if (path === '/classroom' || path.startsWith('/classroom/')) return ['材料', '课堂'];
  return ['今天'];
}

function App() {
  const [routeState, setRouteState] = useState(readRoute);
  const [legacyError, setLegacyError] = useState(false);
  const navigate = useCallback((href: string, replace = false) => {
    const target = new URL(href, location.origin);
    const nextUrl = target.pathname + target.search + target.hash;
    if (replace) history.replaceState(null, '', nextUrl);
    else if (target.pathname !== location.pathname || target.search !== location.search || target.hash !== location.hash) {
      history.pushState(null, '', nextUrl);
    }
    setRouteState({ pathname: target.pathname, search: target.search });
    if (!target.hash) window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const handlePop = () => setRouteState(readRoute());
    window.addEventListener('popstate', handlePop);
    return () => window.removeEventListener('popstate', handlePop);
  }, []);

  const legacy = routeState.pathname === '/' ? new URLSearchParams(routeState.search).get('session') : null;

  useEffect(() => {
    if ((routeState.pathname === '/' && !legacy) || routeState.pathname === '/plan') {
      const suffix = routeState.search || '';
      history.replaceState(null, '', '/today' + suffix);
      setRouteState({ pathname: '/today', search: suffix });
    }
  }, [routeState.pathname, routeState.search, legacy]);

  const printPaperMatch = /^\/papers\/([0-9A-HJKMNP-TV-Z]{26})\/print$/.exec(routeState.pathname);
  const path = routeState.pathname === '/' || routeState.pathname === '/plan' ? '/today' : routeState.pathname;
  const routeKey = path + routeState.search;
  const active =
    ['/materials','/papers','/practice','/classroom','/intake','/notes','/review','/textbooks'].some(group => path === group || path.startsWith(group+'/'))
      ? '/materials'
      : path;
  const section = destinations.find((x) => x.path === active)?.text ?? '今天';
  const breadcrumb = resolveBreadcrumb(path, routeState.search);
  const [dialog, setDialog] = useState<'settings' | 'textbook-access' | 'material' | 'goal' | null>(null);
  const [textbookVersion, setTextbookVersion] = useState(0);
  const [notice, setNotice] = useState('');
  const opener = useRef<HTMLElement | null>(null);
  const catalogOnly = path === '/materials' && new URLSearchParams(routeState.search).get('view') === 'iqdb';
  const posttest = path === '/today' ? new URLSearchParams(routeState.search).get('posttest') : null;
  const paperDetail = /^\/papers\/[0-9A-HJKMNP-TV-Z]{26}$/.test(path);
  const [aiActivityRequest, setAiActivityRequest] = useState(0);
  const [companionCitation, setCompanionCitation] = useState<{ title: string; text: string; topic?: string; seq: number } | undefined>(undefined);
  const needsOverview = !printPaperMatch && !catalogOnly && posttest === null && !paperDetail;
  const library = useResource<Workspace>(needsOverview ? '/workspace' : null);
  const chats = useResource<ChatLink[]>(needsOverview ? '/conversations' : null);
  const settings = useResource<Settings>(!printPaperMatch && !catalogOnly && posttest === null ? '/settings' : null);
  useEffect(() => {
    document.title = (breadcrumb[breadcrumb.length - 1] ?? section) + ' · Mangekyō';
  }, [breadcrumb, section]);
  useEffect(() => {
    if (!legacy) return;
    setLegacyError(false);
    const c = new AbortController();
    api<Session>('/sessions/' + encodeURIComponent(legacy), { signal: c.signal })
      .then((s) => {
        if (c.signal.aborted) return;
        navigate(
          (['riding', 'companion'].includes(s.caseId) ? '/companion' : '/classroom/first45') +
            '?session=' +
            encodeURIComponent(s.id),
          true,
        );
      })
      .catch(() => {
        if (!c.signal.aborted) setLegacyError(true);
      });
    return () => c.abort();
  }, [legacy, navigate]);

  if (printPaperMatch?.[1]) {
    return (
      <Suspense fallback={<p role="status">正在打开打印卷…</p>}>
        <PrintPaper id={printPaperMatch[1]} />
      </Suspense>
    );
  }

  function open(kind: 'settings' | 'textbook-access' | 'material' | 'goal') {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setNotice('');
    setDialog(kind);
  }
  function citeToCompanion(citation: { title: string; text: string; topic?: string }) {
    setCompanionCitation({ ...citation, seq: Date.now() });
  }
  function citeWorkbookToCompanion(citation: CompanionCitation) {
    if (citation.kind === 'question') {
      citeToCompanion({ title: citation.title, text: citation.excerpt });
    } else {
      citeToCompanion({
        title: citation.title,
        text: `手写过程图附件 ${citation.originalId}（第 ${citation.rev} 版）`,
      });
    }
  }
  function close() {
    if (path === '/textbooks/page' && (dialog === 'textbook-access' || dialog === 'settings')) setTextbookVersion(n => n + 1);
    setDialog(null);
    opener.current?.focus();
  }
  let content;
  if (legacy)
    content = legacyError ? (
      <p>
        无法打开这次对话。<a href="/companion">返回同伴</a>
      </p>
    ) : (
      <p role="status">正在打开对话…</p>
    );
  else if (path === '/today') {
    if (posttest !== null) content = <Today key={routeKey} />;
    else {
      const params = new URLSearchParams(routeState.search);
      const modeParam = params.get('mode');
      const mode = modeParam === 'one-hand' || modeParam === 'voice' ? modeParam : 'any';
      const durationParam = params.get('duration');
      const duration: Duration | undefined =
        durationParam === '3min' || durationParam === '15min' || durationParam === '45min+' ? durationParam : undefined;
      content = (
        <TodaySurface
          key={routeKey}
          mode={mode}
          {...(duration ? { duration } : {})}
          emptyLibrary={library.data !== undefined && (library.data.materials ?? []).length === 0}
          noModel={Boolean(settings.error)}
          onNavigate={navigate}
          onOpenAiActivity={() => setAiActivityRequest(Date.now())}
          onCiteToCompanion={citeToCompanion}
        />
      );
    }
  }
  else if (catalogOnly) content = <QuestionBank />;
  else if (path === '/materials') content = <Materials library={library} capture={() => open('material')} />;
  else if (path === '/materials/workspace') content = <WorkspaceLibrary key={routeKey} />;
  else if (path.startsWith('/materials/records/')) content = <WorkspaceRecord id={path.split('/')[3]!} />;
  else if (path === '/textbooks' || path === '/textbooks/page') content = (
    <Suspense fallback={<p role="status">正在打开教材…</p>}>
      <StudioTextbooks key={textbookVersion} openAccess={() => open('textbook-access')} editor={path.endsWith('/page')} />
    </Suspense>
  );
  else if (path === '/intake') content = <IntakeSurface onNavigate={navigate} />;
  else if (path === '/review') content = <Mistakes />;
  else if (path === '/papers/issued') content = <IssuedPapers />;
  else if (path === '/papers' || path.startsWith('/papers/')) {
    const id = path.slice('/papers/'.length);
    if (id && id !== 'new' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
      content = <>
        <a className="text-button" href={'/papers/'+id+'/print'}>打开打印版</a>
        <WorkbookSurface
          key={routeKey}
          paperId={id}
          onCiteToCompanion={citeWorkbookToCompanion}
        />
      </>;
    } else {
      content = id === 'new' && !library.data ? <ReadState resource={library} /> : <>
        {id && id !== 'new' && <a className="text-button" href={'/papers/'+id+'/print'}>打开打印版</a>}
        <Workbook key={routeKey} modelSettings={settings} {...(id ? {id} : {})} materials={library.data?.materials ?? []} />
      </>;
    }
  }
  else if (path === '/notes') content = <Organizer key={routeKey} section="notes" materials={library.data?.materials ?? []} />;
  else if (path === '/materials/riding') content = <StarterLesson />;
  else if (path.startsWith('/materials/saved/'))
    content = <SavedMaterial library={library} id={path.slice('/materials/saved/'.length)} />;
  else if (path === '/practice/riding') content = <StarterPractice />;
  else if (path === '/classroom/first45')
    content = (
      <DemoClassroom
        key={routeKey}
        settings={settings.data && forTask(settings.data, 'diagnostic')}
        needsSetup={settings.error}
        openSettings={() => open('settings')}
      />
    );
  else if (path === '/classroom') content = <ClassroomStart key={routeKey} settings={settings.data} />;
  else if (/^\/classroom\/[0-9A-HJKMNP-TV-Z]{26}(?:\/print)?$/.test(path)) {
    const id = path.split('/')[2]!;
    const preview = path.endsWith('/print');
    content = <>{!preview && <div className="classroom-screen"><ClassroomRoom id={id} /></div>}<ClassroomPrint id={id} preview={preview} /></>;
  }
  else if (path === '/companion') content = <Companion key={routeKey} chats={chats} settings={settings.data} />;
  else if (path === '/me') content = <Me library={library} chats={chats} settings={settings.data && forTask(settings.data, 'companion')} editGoal={() => open('goal')} />;
  else content = <Today key={routeKey} />;
  return (
    <>
      <AppShell
        route={routeKey}
        active={active}
        breadcrumb={breadcrumb}
        settings={settings.data}
        chats={chats}
        materials={library.data?.materials ?? []}
        onNavigate={href => navigate(href)}
        onOpenSettings={() => open('settings')}
        aiActivityRequest={aiActivityRequest}
        companionCitation={companionCitation}
        onSavedMaterial={href => {
          library.reload();
          navigate(href);
        }}
      >
        {content}
        <p className="visually-hidden" role="status">
          {notice}
        </p>
      </AppShell>
      {(dialog === 'settings' || dialog === 'textbook-access') && (
        <SettingsDialog
          textbookAccess={dialog === 'textbook-access'}
          onClose={close}
          onSave={value => {
            settings.replace(value);
            setNotice('设置已保存。');
          }}
        />
      )}
      {(dialog === 'material' || dialog === 'goal') && (
        <EditDialog
          kind={dialog}
          currentGoal={library.data?.goal ?? ''}
          close={close}
          saved={(id) => {
            if (id) {
              close();
              library.reload();
              navigate(materialPath(id));
            } else {
              close();
              library.reload();
              setNotice('学习目标已保存。');
            }
          }}
        />
      )}
    </>
  );
}
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}

if (import.meta.env.PROD && 'serviceWorker' in navigator)
  void navigator.serviceWorker.register('/offline-shell.js').catch(() => {});
