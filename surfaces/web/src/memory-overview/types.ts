export type MemoryCategoryKey = 'preference' | 'claim' | 'state' | 'refusal';

export type MemoryOverviewResponse = {
  asOf: string;
  categories: {
    preference: number;
    claim: number;
    state: number;
    refusal: number;
  };
  stickyDirectives: readonly {
    id: string;
    rev: number;
    kind: string;
    text: string;
    sticky: true;
    basis: readonly unknown[];
    actions: readonly string[];
  }[];
  hypotheses: readonly {
    id: string;
    rev: number;
    kind: string;
    summary: string;
    status: string;
    basis: readonly unknown[];
    actions: readonly string[];
  }[];
  calibration: {
    status: 'available' | 'unknown';
    totalReconciliations: number;
    confirmed: number;
    missed: number;
    recent: readonly { key: string; status: string; conceptId: string | null; occurredAt: string }[];
  };
};

export type MemoryItem =
  | (MemoryOverviewResponse['stickyDirectives'][number] & { section: 'directive' })
  | (MemoryOverviewResponse['hypotheses'][number] & { section: 'hypothesis' });

export type MemoryItemInput = {
  item: MemoryItem;
  text?: string;
  accessEpoch?: string;
  undoToken?: string;
};

export type MemoryOverviewState =
  | { status: 'loading' }
  | { status: 'ready'; data: MemoryOverviewResponse }
  | { status: 'error'; message: string; code: 'not-found' | 'network' | 'parse' };

export type MemoryOverviewHandlers = {
  onUpdateItem?: (input: MemoryItemInput) => Promise<void>;
  onWithdrawItem?: (input: MemoryItemInput) => Promise<void>;
};

export type MemoryOverviewPanelProps = MemoryOverviewHandlers & {
  fetchJson?: (path: string) => Promise<MemoryOverviewResponse>;
  initialOverview?: MemoryOverviewResponse;
};
