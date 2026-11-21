import { describe, expect, it } from 'vitest';
import { isPhaticMessage } from './phatic-message.ts';

describe('closed phatic exchanges', () => {
  it.each([
    '只打个招呼',
    '你好，稍后练习。',
    '祝你万事如意！',
    '晚上好，祝您一切顺利。',
    'Good morning! Have a nice day.',
  ])('recognizes complete greetings and courtesy phrases in %j', text => {
    expect(isPhaticMessage(text)).toBe(true);
  });

  it.each([
    'Berapa hasil dari dua puluh dikali sepuluh?',
    'Hasilnya adalah dua ratus.',
    '你好，计算结果是十四。',
    'Hello! The product is forty two.',
    '祝你万事如意！1120994590877500',
    'See you later https://example.test/answer',
    '你好 <answer>九</answer>',
    '',
  ])('keeps unrecognized content unclassified in %j', text => {
    expect(isPhaticMessage(text)).toBe(false);
  });
});
