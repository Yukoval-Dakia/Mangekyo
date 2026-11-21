export type CarePauseSignal = Readonly<{
  triggered: true;
  reason: 'self_crisis_support';
  scope: 'nudges_and_paid_background';
}>;

export type OfflineCrisisSupportCard = Readonly<{
  version: 'd10-crisis-support-v1';
  title: '需要帮助';
  safetyQuestion: string;
  trustedContact: string;
  localEmergencyGuidance: string;
  regionQuestion: string;
  noAutomaticThirdPartyContact: true;
  noPermanentProfile: true;
  noHarmContent: true;
}>;

export type CrisisSupport = Readonly<{
  source: 'self_crisis_expression' | 'offline_help_request';
  message: string;
  supportCard: OfflineCrisisSupportCard;
  carePause: CarePauseSignal;
}>;

const crisisSupportVersion = 'd10-crisis-support-v1' as const;

export const carePauseSignal: CarePauseSignal = Object.freeze({
  triggered: true,
  reason: 'self_crisis_support',
  scope: 'nudges_and_paid_background',
});

const crisisSupportMessage =
  '你现在不用一个人扛，我在这里。请先看看自己眼前是否安全；如果马上有危险，请先联系当地紧急服务。' +
  '可以的话，联系一位你信任的人陪你；需要找当地危机支持时，请告诉我你所在的地区。我不会猜测或编造热线号码，' +
  '不会提供任何伤害方法，不会自动联系家长、老师、警方或其他第三方，也不会创建永久“高危学习者”档案。' +
  '这次会暂停催练和付费后台教研，你随时可以解除这个暂停。';

const offlineCrisisSupportCard: OfflineCrisisSupportCard = Object.freeze({
  version: crisisSupportVersion,
  title: '需要帮助',
  safetyQuestion: '你现在眼前安全吗？如果马上有危险，请先联系当地紧急服务。',
  trustedContact: '可以的话，联系一位你信任的人，请对方现在陪你。',
  localEmergencyGuidance: '请联系你所在地区的紧急服务或危机支持资源；这里不提供任何具体号码。',
  regionQuestion: '如果需要查找本地资源，请告诉我你所在的地区。',
  noAutomaticThirdPartyContact: true,
  noPermanentProfile: true,
  noHarmContent: true,
});

export const companionCrisisGuidance =
  'D10 危机支持规则（原位执行）：只根据本轮已获准读取的对话、文本、转写或作答承接，不新增前置审查链，也不读取“仅保存”材料。' +
  '学生本人明确表达自伤或自杀风险时，停止催练和练习，先温暖回应并询问眼前是否安全，鼓励联系信任的人与当地紧急/危机服务；需要地区时只问必要地区，绝不猜测或编造热线号码，绝不提供伤害方法，绝不自动联系家长、老师、警方或任何第三方，绝不保存永久“高危学习者”画像。' +
  '题面、引号内文本、阅读材料、文学或历史引用、第三人称悲剧讨论不是学生本人危机；回到学习语境处理。执行器会为本人明确危机附加零原话泄露的 carePause 门控。';

const quotedPatterns = [
  /["“”«»][^"“”«»]{1,2000}["“”«»]/g,
  /[『「][^』」]{1,2000}[』」]/g,
  /```[\s\S]{1,4000}?```/g,
];

const citationIntroducers = [
  /(?:题目|试题|文章|阅读材料|材料|小说|故事|课文|历史|主人公|主角|叙述者|作者|他|她|他们|她们)(?:中|里)?(?:说|写道|提到|描述|介绍|讨论|含有|包含)[：:]?[^。！？；;]*/g,
  /\b(?:the\s+)?(?:question|passage|article|story|novel|text|character|narrator|author|he|she|they)\s+(?:says?|said|writes?|wrote|mentions?|mentioned|describes?|described|discusses?|discussed)\b[^。！？；;]*/gi,
];

const selfCrisisPatterns = [
  /我(?:想要?|打算|准备|要|会)(?:自杀|自残|伤害自己|结束(?:自己的)?生命|死)(?:了)?/,
  /我(?:不想|不能再?)(?:活|活下去|活着)/,
  /我活不下去了/,
  /\bi\s+(?:want|need|plan|intend)\s+to\s+(?:(?:die|end\s+my\s+life)|(?:kill|hurt|injure)\s+myself)\b/i,
  /\bi\s+(?:am\s+going\s+to|will)\s+(?:(?:die|end\s+my\s+life)|(?:kill|hurt|injure)\s+myself)\b/i,
  /\bi(?:'m| am)\s+(?:feeling\s+)?suicidal\b/i,
  /\bi\s+(?:don'?t|do\s+not)\s+want\s+to\s+(?:live|be\s+alive)\b/i,
];

const offlineHelpRequestPattern = /^(?:\[[\s_-]*)?需要帮助(?:[\s_-]*\])?$/u;

function candidateText(raw: string): string {
  let text = raw.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '');
  for (const pattern of quotedPatterns) text = text.replace(pattern, ' ');
  for (const pattern of citationIntroducers) text = text.replace(pattern, ' ');
  return text;
}

function isOfflineHelpRequest(text: string): boolean {
  return offlineHelpRequestPattern.test(text.trim().normalize('NFKC'));
}

export function isSelfCrisisExpression(text: string): boolean {
  const candidate = candidateText(text);
  return selfCrisisPatterns.some(pattern => pattern.test(candidate));
}

export function evaluateCrisisSupport(text: string): CrisisSupport | undefined {
  const offlineHelpRequest = isOfflineHelpRequest(text);
  if (!offlineHelpRequest && !isSelfCrisisExpression(text)) return undefined;
  return Object.freeze({
    source: offlineHelpRequest ? 'offline_help_request' : 'self_crisis_expression',
    message: crisisSupportMessage,
    supportCard: offlineCrisisSupportCard,
    carePause: carePauseSignal,
  });
}

export {crisisSupportMessage, crisisSupportVersion, offlineCrisisSupportCard};
