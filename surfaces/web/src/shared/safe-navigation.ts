import type { MouseEvent } from 'react';

/**
 * Three-layer internal navigation guard:
 * 1. Single leading slash (rejects scheme-relative `//` and external URLs)
 * 2. Rejects `/api` endpoints
 * 3. Rejects control characters and backslashes
 */
export function isSafeInternalHref(href: string): boolean {
  if (!href.startsWith('/') || href.startsWith('//')) return false;
  if (/^\/api(?:\/|\?|#|$)/i.test(href)) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(href)) return false;
  return true;
}

export function safeInternalHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && isSafeInternalHref(trimmed) ? trimmed : undefined;
}

export function navigateHref(href: string, onNavigate?: (target: string) => void): void {
  if (onNavigate) onNavigate(href);
  else window.location.assign(href);
}

export function navigateInternalHref(href: string, onNavigate?: (target: string) => void): void {
  const safe = safeInternalHref(href);
  if (!safe) return;
  navigateHref(safe, onNavigate);
}

export function handleInternalLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  onNavigate?: (target: string) => void,
  requireSafe = true,
): void {
  const target = requireSafe ? safeInternalHref(href) : href;
  if (!target) {
    event.preventDefault();
    return;
  }
  if (!onNavigate) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  onNavigate(target);
}

export function createInternalLinkClickHandler(
  href: string,
  onNavigate?: (target: string) => void,
  requireSafe = true,
): (event: MouseEvent<HTMLAnchorElement>) => void {
  return (event) => handleInternalLinkClick(event, href, onNavigate, requireSafe);
}
