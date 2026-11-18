import { forTask } from './model-route';
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import { api, type Session, type Settings } from './api';
import { DemoClassroom } from './demo';
import { Companion } from './companion';
import { Icon, Mark, type IconName } from './icons';
import { SettingsDialog } from './settings';
import { StarterLesson, StarterPractice } from './starter';
import { Workbook } from './workbook';
import { Organizer } from './organizer';
import { Intake } from './intake';
import { Mistakes, PrintPaper } from './review';
import {
  ReadState,
  Today,
  Materials,
  SavedMaterial,
  Me,
  EditDialog,
  materialPath,
  useResource,
  type Workspace,
  type ChatLink,
} from './workspace';
import './styles.css';
import './shell.css';
import './learning.css';

const destinations: { path: string; text: string; icon: IconName }[] = [
  { path: '/today', text: '今天', icon: 'today' },
  { path: '/materials', text: '材料', icon: 'book' },
  { path: '/companion', text: '同伴', icon: 'chat' },
  { path: '/me', text: '我', icon: 'person' },
];

function App() {
  const legacy = location.pathname === '/' ? new URLSearchParams(location.search).get('session') : null;
  const [legacyError, setLegacyError] = useState(false);
  const path = location.pathname === '/' ? '/today' : location.pathname;
  const active =
    ['/materials','/papers','/practice','/classroom','/intake','/notes','/review'].some(group => path === group || path.startsWith(group+'/'))
      ? '/materials'
      : path === '/plan' ? '/today' : path;
  const section = destinations.find((x) => x.path === active)?.text ?? '今天';
  const [dialog, setDialog] = useState<'settings' | 'material' | 'goal' | null>(null);
  const [notice, setNotice] = useState('');
  const opener = useRef<HTMLElement | null>(null);
  const library = useResource<Workspace>('/workspace');
  const chats = useResource<ChatLink[]>('/conversations');
  const settings = useResource<Settings>('/settings');
  useEffect(() => {
    document.title = section + ' · Mangekyō';
  }, [section]);
  useEffect(() => {
    if (!legacy) return;
    const c = new AbortController();
    api<Session>('/sessions/' + encodeURIComponent(legacy), { signal: c.signal })
      .then((s) => {
        if (c.signal.aborted) return;
        location.replace(
          (['riding', 'companion'].includes(s.caseId) ? '/companion' : '/classroom/first45') +
            '?session=' +
            encodeURIComponent(s.id),
        );
      })
      .catch(() => {
        if (!c.signal.aborted) setLegacyError(true);
      });
    return () => c.abort();
  }, [legacy]);
  function open(kind: 'settings' | 'material' | 'goal') {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setNotice('');
    setDialog(kind);
  }
  function close() {
    setDialog(null);
    opener.current?.focus();
  }
  const browse = (cls: string) => (
    <nav className={cls} aria-label="主导航">
      {destinations.map((d) => (
        <a key={d.path} href={d.path} aria-current={active === d.path ? 'page' : undefined}>
          <Icon name={d.icon} />
          <span>{d.text}</span>
        </a>
      ))}
    </nav>
  );
  let content;
  if (legacy)
    content = legacyError ? (
      <p>
        无法打开这次对话。<a href="/companion">返回同伴</a>
      </p>
    ) : (
      <p role="status">正在打开对话…</p>
    );
  else if (path === '/today') content = <Today library={library} chats={chats} />;
  else if (path === '/materials') content = <Materials library={library} capture={() => open('material')} />;
  else if (path === '/intake') content = <Intake />;
  else if (path === '/review') content = <Mistakes />;
  else if (/^\/papers\/[0-9A-HJKMNP-TV-Z]{26}\/print$/.test(path)) content = <PrintPaper id={path.split('/')[2]!} />;
  else if (path === '/papers' || path.startsWith('/papers/')) {
    const id = path.slice('/papers/'.length);
    content = id === 'new' && !library.data ? <ReadState resource={library} /> : <>
      {id && id !== 'new' && <a className="text-button" href={'/papers/'+id+'/print'}>打开打印版</a>}
      <Workbook modelSettings={settings} {...(id ? {id} : {})} materials={library.data?.materials ?? []} />
    </>;
  }
  else if (path === '/plan' || path === '/notes') content = <Organizer section={path === '/plan' ? 'plan' : 'notes'} materials={library.data?.materials ?? []} />;
  else if (path === '/materials/riding') content = <StarterLesson />;
  else if (path.startsWith('/materials/saved/'))
    content = <SavedMaterial library={library} id={path.slice('/materials/saved/'.length)} />;
  else if (path === '/practice/riding') content = <StarterPractice />;
  else if (path === '/classroom/first45')
    content = (
      <DemoClassroom
        settings={settings.data && forTask(settings.data, 'diagnostic')}
        needsSetup={settings.error}
        openSettings={() => open('settings')}
      />
    );
  else if (path === '/companion') content = <Companion chats={chats} settings={settings.data} />;
  else if (path === '/me') content = <Me library={library} chats={chats} settings={settings.data && forTask(settings.data, 'companion')} editGoal={() => open('goal')} />;
  return (
    <div className="product-shell">
      <a className="skip-content" href="#main-content">
        跳到正文
      </a>
      <aside className="side-rail">
        <a className="brand" href="/today" aria-label="Mangekyō 首页">
          <Mark /> Mangekyō
        </a>
        <button className="capture-button" onClick={() => open('material')}>
          <Icon name="plus" />
          交入材料
        </button>
        {browse('desktop-nav')}
        <button className="nav-settings" onClick={() => open('settings')}>
          <Icon name="settings" /> 模型设置
        </button>
      </aside>
      <div className="shell-body">
        <header className="mobile-top">
          <a className="brand" href="/today">
            <Mark /> Mangekyō
          </a>
          <div>
            <button className="icon-button" aria-label="交入材料" onClick={() => open('material')}>
              <Icon name="plus" />
            </button>
            <button className="icon-button" aria-label="模型设置" onClick={() => open('settings')}>
              <Icon name="settings" />
            </button>
          </div>
        </header>
        <main id="main-content" className="page-body">
          {content}
          <p className="visually-hidden" role="status">
            {notice}
          </p>
        </main>
      </div>
      {browse('mobile-nav')}
      {dialog === 'settings' && (
        <SettingsDialog
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
            if (id) location.assign(materialPath(id));
            else {
              close();
              library.reload();
              setNotice('学习目标已保存。');
            }
          }}
        />
      )}
    </div>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
