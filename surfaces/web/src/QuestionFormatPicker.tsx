import { useSyncExternalStore } from 'react';
import type { QuestionAuthorFormat } from './api.ts';
import './question-format-picker.css';

const STORAGE_KEY = 'mangekyo:question-format';
const VALID: readonly QuestionAuthorFormat[] = ['auto', 'text', 'interactive'];
const listeners = new Set<() => void>();

function read(): QuestionAuthorFormat {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return VALID.includes(stored as QuestionAuthorFormat) ? (stored as QuestionAuthorFormat) : 'auto';
  } catch {
    return 'auto';
  }
}

function write(next: QuestionAuthorFormat) {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 存储不可用时仅保留当前页面内的选择。
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 全站共享的 AI 出题题型偏好；任意入口切换后其余入口保持一致。 */
export function useQuestionFormat(): [QuestionAuthorFormat, (next: QuestionAuthorFormat) => void] {
  return [useSyncExternalStore(subscribe, read, () => 'auto' as const), write];
}

const OPTIONS: readonly { value: QuestionAuthorFormat; label: string; hint: string }[] = [
  { value: 'auto', label: '自动', hint: '由 AI 按题目内容决定作答形态' },
  { value: 'text', label: '标准文字', hint: '只出文字作答题' },
  { value: 'interactive', label: '交互画板（断句・滑块・节拍）', hint: '优先出可操作的画板题' },
];

export function QuestionFormatPicker({
  value,
  onChange,
  disabled,
  compact = false,
}: {
  value: QuestionAuthorFormat;
  onChange: (next: QuestionAuthorFormat) => void;
  disabled?: boolean | undefined;
  compact?: boolean | undefined;
}) {
  return (
    <div className={compact ? 'qfp qfp-compact' : 'qfp'} role="radiogroup" aria-label="AI 出题题型">
      {OPTIONS.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          title={option.hint}
          disabled={disabled === true}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
