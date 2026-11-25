import type { AuthoringUiError } from './api.ts';

export function AuthoringFeedback({
  error,
  className,
  linkClassName,
  onNavigate,
}: {
  error: AuthoringUiError;
  className: string;
  linkClassName: string;
  onNavigate?: ((href: string) => void) | undefined;
}) {
  return (
    <div className={className} role="alert">
      <span>{error.message}</span>
      {error.actionHref && onNavigate ? (
        <button type="button" className={linkClassName} onClick={() => onNavigate(error.actionHref!)}>
          {error.actionLabel}
        </button>
      ) : error.actionHref ? (
        <a className={linkClassName} href={error.actionHref}>{error.actionLabel}</a>
      ) : null}
    </div>
  );
}
