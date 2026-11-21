import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import '../shell.css';
import './memory-overview.css';
import { MemoryOverviewPanel } from './index';
import type { MemoryItemInput, MemoryOverviewResponse } from './types';

const available = new URLSearchParams(location.search).get('calibration') !== 'unknown';
if (new URLSearchParams(location.search).get('theme') === 'dark')
  document.body.setAttribute('data-theme', 'dark');
if (new URLSearchParams(location.search).get('theme') === 'dark')
  document.body.style.background = '#0d1410';

const overview: MemoryOverviewResponse = {
  asOf: '2026-11-21T09:20:00.000Z',
  categories: { preference: 3, claim: 2, state: 1, refusal: 1 },
  stickyDirectives: [
    {
      id: 'D1',
      rev: 2,
      kind: 'directive',
      text: '讲解新概念时先举一个生活里的例子。',
      sticky: true,
      basis: [
        { title: '同伴原话', occurredAt: '2026-11-19T14:02:00.000Z', excerpt: '我想先听例子，再看定义。' },
        { title: '学习偏好', occurredAt: '2026-11-18T09:12:00.000Z', excerpt: '抽象内容要先落到具体场景。' },
      ],
      actions: ['correct', 'undo'],
    },
  ],
  hypotheses: [
    {
      id: 'H1',
      rev: 1,
      kind: 'preference',
      summary: '你更偏向先理解结构，再记细节。',
      status: 'confirmed',
      basis: [{ title: '作答片段', occurredAt: '2026-11-20T11:30:00.000Z', excerpt: '我先把图画出来，再补步骤。' }],
      actions: ['correct', 'undo'],
    },
    {
      id: 'H2',
      rev: 3,
      kind: 'state',
      summary: '本周可能时间较紧，适合短练习。',
      status: 'tentative',
      basis: [],
      actions: ['correct', 'undo'],
    },
  ],
  calibration: available
    ? {
        status: 'available',
        totalReconciliations: 8,
        confirmed: 5,
        missed: 3,
        recent: [
          { key: 'r1', status: 'confirmed', conceptId: 'C-速度', occurredAt: '2026-11-21T08:10:00.000Z' },
          { key: 'r2', status: 'missed', conceptId: 'C-函数', occurredAt: '2026-11-20T17:44:00.000Z' },
        ],
      }
    : {
        status: 'unknown',
        totalReconciliations: 0,
        confirmed: 0,
        missed: 0,
        recent: [],
      },
};

async function updateItem(input: MemoryItemInput) {
  console.log('updateItem', input);
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function withdrawItem(input: MemoryItemInput) {
  console.log('withdrawItem', input);
  await new Promise((resolve) => setTimeout(resolve, 400));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main className="page-body">
      <MemoryOverviewPanel
        initialOverview={overview}
        onUpdateItem={updateItem}
        onWithdrawItem={withdrawItem}
      />
    </main>
  </StrictMode>,
);
