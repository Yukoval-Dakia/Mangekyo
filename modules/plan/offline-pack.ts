import type { PlanCandidate } from './today.ts';

// Revision is part of the activity identity. Keep each published revision readable.
const source = 'Mangekyō 原创阅读与推理包 v1';
const cards = [
  {
    id: 'reading',
    title: '读一条借阅规则',
    topic: '范围限定',
    kind: 'probe',
    prompt:
      '图书馆公告：“周三下午只接受还书。预约的书可以保留至周五。”小禾已预约一本书，周三下午可以做什么？',
    choices: ['领取预约书', '归还手中的书', '预约自动取消'],
    correct: 1,
    explanation: '预约保留期限和办理业务的时段是两个条件。周三下午只办理还书。',
  },
  {
    id: 'inference',
    title: '检查一次推断',
    topic: '条件推理',
    kind: 'counterexample',
    prompt: '规则是“下雨时操场会湿”。早晨看到湿操场，哪种观察能说明昨晚未必下雨？',
    choices: ['有人在夜里洒过水', '操场没有屋顶', '天气预报说可能下雨'],
    correct: 0,
    explanation: '洒水也能让操场变湿，同一个结果可以有不同的原因。',
  },
  {
    id: 'reflection',
    title: '复盘一段原答',
    topic: '失分定位',
    kind: 'recovery',
    prompt:
      '订正记录：“我预料计算可能失分，读图本来很有把握；实际漏读图例，算式正确。”下次先核对哪一步最贴合意外失分？',
    choices: ['重算全部算式', '核对图例与线型', '把所有章节重学'],
    correct: 1,
    explanation: '意外失分出现在图例识别。原答区分了预料内风险和实际失分。',
  },
] as const;

function resolve(id: string, rev: number) {
  const card = cards.find((card) => 'pack/' + card.id === id);
  if (rev !== 1 || !card) throw new Error('找不到此版本的内置活动。');
  return card;
}
export function openPack(id: string, rev: number) {
  const { title, prompt, choices } = resolve(id, rev);
  return { id, rev, source, title, prompt, choices: [...choices] };
}
export function checkPack(id: string, rev: number, choice: number) {
  const card = resolve(id, rev);
  if (!Number.isInteger(choice) || choice < 0 || choice >= card.choices.length)
    throw new Error('请选择一个有效答案。');
  const result = choice === card.correct ? 'correct' : 'incorrect';
  const record = {
    title: card.title,
    text: [source, id + '@' + rev, card.prompt, '我的选择：' + card.choices[choice], card.explanation].join(
      '\n',
    ),
  };
  return { id, rev, choice, result, explanation: card.explanation, record };
}
export function packCandidates(): PlanCandidate[] {
  return cards.map((card) => {
    const id = 'pack/' + card.id;
    return {
      id,
      title: card.title,
      topic: card.topic,
      kind: card.kind,
      minutes: 3,
      input: 'tap',
      open: { kind: 'pack', id, rev: 1 },
      durationBasis: '一段短文、一次点选和订正，内容包估时 3 分钟。',
      evidence: [id + '@1'],
      reason: '已备好原文和确定性检查，可直接开始。',
      delayImpact: '推迟后，这一项的自检结果仍未知。',
    };
  });
}
