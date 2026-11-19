// Example authors build ordinary data; only the JSON result reaches a renderer.
import type { Artifact, Drawing, ViewNode } from './catalog.ts';

const volumes = Array.from({ length: 41 }, (_, ml) => ml);
const source = 'volume';
const path = (points: number[][]) => points.map(([x, y]) => ({ x: x!, y: y! }));
const labels = (id: string, x: number, y: number, text: string): Drawing => ({
  kind: 'label',
  id,
  x,
  y,
  text,
});
const line = (id: string, points: number[][]): Drawing => ({
  kind: 'line',
  id,
  points: path(points),
  stroke: 'ink',
});
const objects: Drawing[] = [
  line('support', [
    [72, 171],
    [72, 18],
  ]),
  line('base', [
    [44, 171],
    [101, 171],
  ]),
  line('clamp', [
    [72, 46],
    [126, 46],
  ]),
  {
    kind: 'rect',
    id: 'burette',
    x: 119,
    y: 12,
    width: 14,
    height: 85,
    fill: 'paper',
    stroke: 'ink',
  },
  {
    kind: 'rect',
    id: 'meniscus',
    x: 121,
    y: { source, values: volumes.map((v) => 18 + v * 1.5) },
    width: 10,
    height: { source, values: volumes.map((v) => 77 - v * 1.5) },
    fill: 'liquid',
    stroke: 'none',
  },
  ...[0, 1, 2, 3, 4].map((i) =>
    line('tick-' + i, [
      [127, 20 + i * 15],
      [133, 20 + i * 15],
    ]),
  ),
  line('tip', [
    [119, 97],
    [126, 108],
    [126, 116],
  ]),
  {
    kind: 'polygon',
    id: 'flask',
    points: path([
      [117, 122],
      [135, 122],
      [135, 133],
      [155, 163],
      [153, 168],
      [99, 168],
      [97, 163],
      [117, 133],
    ]),
    fill: 'paper',
    stroke: 'ink',
  },
  {
    kind: 'polygon',
    id: 'solution',
    points: path([
      [106, 152],
      [146, 152],
      [153, 163],
      [151, 166],
      [101, 166],
      [99, 163],
    ]),
    fill: 'liquid',
    stroke: 'none',
  },
  labels('tube-name', 153, 35, '滴定管'),
  labels('flask-name', 170, 154, '锥形瓶'),
  { kind: 'reading', id: 'reading', source, x: 153, y: 56 },
  { kind: 'stepTarget', id: 'valve', label: '开阀加入下一份', source, x: 126, y: 101 },
];
const ph = volumes.map((v) => {
  const excess = (0.1 * (20 - v)) / (20 + v);
  return Number(
    (excess === 0 ? 7 : excess > 0 ? -Math.log10(excess) : 14 + Math.log10(-excess)).toFixed(2),
  );
});
export const titration: Artifact = {
  version: 1,
  id: 'acid-base',
  revision: 'r1',
  title: '寻找滴定终点',
  fallback: '在 20 mL 盐酸中逐步加入等浓度的氢氧化钠。记录 pH 跃变时加入的体积，并解释判断依据。',
  sections: [
    {
      id: 'method',
      title: '实验步骤',
      layout: 'stack',
      nodes: [
        {
          kind: 'steps',
          id: 'procedure',
          items: ['量取 20 mL 盐酸', '逐次加入等浓度 NaOH', '观察 pH 跃变并记录'],
        },
      ],
    },
    {
      id: 'bench',
      title: '滴定台',
      layout: 'columns',
      nodes: [
        {
          kind: 'scene',
          id: 'apparatus',
          label: '玻璃器材',
          description: '25 °C，酸碱浓度均为 0.10 mol/L。每次开阀，向下方锥形瓶加入 1 mL。',
          width: 264,
          height: 184,
          objects,
        },
        { kind: 'curve', id: 'curve', label: '体积与酸碱度', unit: 'pH', source, values: ph },
      ],
    },
    {
      id: 'record',
      title: '观察记录',
      layout: 'stack',
      nodes: [
        {
          kind: 'range',
          id: source,
          label: '已加入 NaOH',
          unit: 'mL',
          values: volumes,
          initial: 0,
        },
        { kind: 'note', id: 'inference', label: '哪个体积附近变化最快？写下读数和依据。' },
        {
          kind: 'action',
          id: 'keep-reading',
          label: '记录本次观察',
          intent: 'explore',
          inputs: ['volume', 'inference'],
        },
      ],
    },
  ],
};
const quote = '知之者不如好之者好之者不如乐之者';
export const passage: Artifact = {
  version: 1,
  id: 'analects',
  revision: 'r1',
  title: '为《论语》断句',
  fallback: quote + '。选择要停顿的字后位置。',
  sections: [
    {
      id: 'reading',
      title: '雍也篇',
      layout: 'stack',
      nodes: [
        {
          kind: 'text',
          id: 'instruction',
          text: '读一遍原文，点字在其后标出停顿。再点同一字可撤销。',
        },
        {
          kind: 'selection',
          id: 'pauses',
          layout: 'passage',
          label: '原文与断点',
          items: Array.from(quote.slice(0, -1), (label, i) => ({ id: 'gap-' + (i + 1), label })),
          tail: '者。',
          selected: [],
        },
        {
          kind: 'action',
          id: 'send-pauses',
          label: '提交断句',
          inputs: ['pauses'],
          intent: 'submit',
        },
      ],
    },
  ],
};
const beats = (id: string, label: string): ViewNode => ({
  kind: 'selection',
  layout: 'beats',
  id,
  label,
  items: Array.from({ length: 8 }, (_, i) => ({ id: id + '-' + (i + 1), label: String(i + 1) })),
  tail: '',
  selected: [],
});
export const rhythm: Artifact = {
  version: 1,
  id: 'duet',
  revision: 'r1',
  title: '写一小节双声部节奏',
  fallback: '四拍，每拍两格。大鼓和小鼓各敲三次，只在第一格同时响。分别记下两组落点。',
  sections: [
    {
      id: 'score',
      title: '四拍 · 八格',
      layout: 'stack',
      nodes: [
        {
          kind: 'text',
          id: 'instruction',
          text: '大鼓和小鼓各敲三次，只在第一格同时响。点亮落点，再试听这一小节。',
        },
        beats('bass', '大鼓'),
        beats('snare', '小鼓'),
        { kind: 'listen', id: 'play', label: '试听这一小节', lanes: ['bass', 'snare'], bpm: 96 },
        {
          kind: 'action',
          id: 'send-score',
          label: '提交两组落点',
          inputs: ['bass', 'snare'],
          intent: 'submit',
        },
      ],
    },
  ],
};
