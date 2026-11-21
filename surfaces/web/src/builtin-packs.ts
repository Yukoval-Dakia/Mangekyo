export type BuiltinPackKind = 'lesson' | 'practice';

export type BuiltinPack = {
  id: string;
  kind: BuiltinPackKind;
  title: string;
  detail: string;
  minutes: number;
  legacy?: string;
};

export const builtinPacks: readonly BuiltinPack[] = [
  {
    id: 'riding',
    kind: 'lesson',
    title: '同一趟骑行，两块码表',
    detail: '起步讲义 · 速度与时间，不依赖模型即可直接阅读',
    minutes: 5,
    legacy: '/materials/riding',
  },
  {
    id: 'riding',
    kind: 'practice',
    title: '骑行与平均速度',
    detail: '独立短练 · 确定性即时反馈，随时反复作答',
    minutes: 3,
    legacy: '/practice/riding',
  },
];

export const defaultLessonPack = builtinPacks.find(pack => pack.kind === 'lesson');
export const defaultPracticePack = builtinPacks.find(pack => pack.kind === 'practice');

export type BuiltinClassroom = {
  id: string;
  title: string;
  description: string;
  legacyPath?: string;
};

export const builtinClassrooms: readonly BuiltinClassroom[] = [
  {
    id: 'first45',
    title: '同一个 45，两份学习史',
    description: '内置课堂主题 · 两份合成旧作',
    legacyPath: '/classroom/first45',
  },
];

export function builtinPackPath(pack: Pick<BuiltinPack, 'id' | 'kind'>) {
  const params = new URLSearchParams({ pack: pack.id, kind: pack.kind });
  return `/materials?${params}`;
}

export function builtinClassroomPath(classroom: Pick<BuiltinClassroom, 'id'>) {
  return `/classroom/${encodeURIComponent(classroom.id)}`;
}

export function builtinCompanionPath(pack: Pick<BuiltinPack, 'id' | 'kind'>) {
  return `/companion?context=${encodeURIComponent(pack.id)}&kind=${pack.kind}`;
}

export function findBuiltinPack(id: string, kind?: BuiltinPackKind | null) {
  return builtinPacks.find(pack => pack.id === id && (!kind || pack.kind === kind));
}

export function findBuiltinPackByLegacy(path: string) {
  return builtinPacks.find(pack => pack.legacy === path);
}

export function builtinPackFromRoute(path: string, search: string): BuiltinPack | undefined {
  const legacy = findBuiltinPackByLegacy(path);
  if (legacy) return legacy;
  if (path === '/materials') {
    const params = new URLSearchParams(search);
    const id = params.get('pack');
    if (!id) return undefined;
    const kind = params.get('kind');
    return findBuiltinPack(id, kind === 'practice' || kind === 'lesson' ? kind : null);
  }
  return undefined;
}

export function builtinClassroomFromRoute(path: string, search: string): BuiltinClassroom | undefined {
  const legacy = builtinClassrooms.find(classroom => classroom.legacyPath === path);
  if (legacy) return legacy;
  if (path !== '/classroom') {
    const match = /^\/classroom\/([a-z][a-z0-9-]*)$/.exec(path);
    return match?.[1] ? builtinClassrooms.find(classroom => classroom.id === match[1]) : undefined;
  }
  const topic = new URLSearchParams(search).get('topic');
  return builtinClassrooms.find(classroom => classroom.id === topic);
}

export function paperPracticePath(paperId: string) {
  const pack = findBuiltinPack(paperId, 'practice');
  return pack ? builtinPackPath(pack) : `/papers/${encodeURIComponent(paperId)}`;
}
