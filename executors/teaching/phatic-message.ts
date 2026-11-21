// A closed vocabulary of complete phrases, with no free-text arguments.
// An unspecified language or unfamiliar phrase provides no evidence about exposure.
const greetings = new Set([
  '你好', '您好', '嗨', '哈喽', '早安', '早上好', '中午好', '下午好', '晚上好', '晚安',
  '只打个招呼', '打个招呼', '跟你打个招呼', '好久不见',
  'hello', 'hello there', 'hi', 'hi there', 'hey', 'good morning', 'good afternoon', 'good evening',
  'just saying hello', 'nice to meet you', 'long time no see',
]);
const courtesies = new Set([
  '谢谢', '多谢', '不客气', '再见', '回头见', '稍后练习', '待会儿见',
  'thanks', 'thank you', 'you are welcome', "you're welcome", 'goodbye', 'bye', 'see you later',
  'have a good day', 'have a nice day', 'best wishes', 'take care',
]);
const wishes = new Set([
  '万事如意', '一切顺利', '心想事成', '身体健康', '天天开心', '学习顺利', '周末愉快', '新年快乐',
]);

export function isPhaticMessage(text: string) {
  if (text.length > 160) return false;
  const phrases = text.normalize('NFKC').trim().toLowerCase()
    .replace(/[’]/gu, "'").split(/[,.!?;、。\n]+/u).map(phrase => phrase.trim()).filter(Boolean);
  return phrases.length > 0 && phrases.every(phrase => greetings.has(phrase) || courtesies.has(phrase) ||
    wishes.has(phrase.replace(/^祝(?:你|您|大家)?/u, '')));
}
