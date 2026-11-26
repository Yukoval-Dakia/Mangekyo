import { Message } from '../message';
import { isUlid } from '../shared/safe-values';

export function CiteIcon() {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6.5C4 5.1 5.1 4 6.5 4h11C18.9 4 20 5.1 20 6.5v8c0 1.4-1.1 2.5-2.5 2.5H11l-4.5 3.5V17H6.5C5.1 17 4 15.9 4 14.5v-8Z" />
      <path d="M8.5 9h7" />
      <path d="M8.5 12.5h4.5" />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6v5h-5" />
      <path d="M20 11a8 8 0 0 0-15.5-3" />
      <path d="M4 18v-5h5" />
      <path d="M4 13a8 8 0 0 0 15.5 3" />
    </svg>
  );
}

export function ViewProvenanceLink({
  id,
  onNavigate,
}: {
  readonly id: string | undefined;
  readonly onNavigate?: ((href: string) => void) | undefined;
}) {
  if (!isUlid(id)) return null;
  const href = `/materials/records/${encodeURIComponent(id)}`;
  if (onNavigate) {
    return (
      <button type="button" className="mv2-btn mv2-btn-ghost mv2-btn-sm" onClick={() => onNavigate(href)}>
        查看溯源
      </button>
    );
  }
  return <a className="mv2-btn mv2-btn-ghost mv2-btn-sm" href={href}>查看溯源</a>;
}

export function PromptDisclosure({ prompt }: { readonly prompt: string | null | undefined }) {
  if (!prompt) return null;
  return (
    <details className="mv2-prompt-details">
      <summary>查看题面</summary>
      <div className="mv2-prompt-body">
        <Message text={prompt} />
      </div>
    </details>
  );
}
