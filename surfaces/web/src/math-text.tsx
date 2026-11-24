import type { MouseEvent } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import math from 'remark-math';
import renderMath from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { transformCitationsToMarkdown, type IndexedCitation } from './shell/inline-citations';
import { handleSpaNavigation } from './today-v2/shared';

const MK_CITE_PREFIX = '#mk-cite-';

export default function MathText({
  text,
  citations,
  onNavigate,
}: {
  text: string;
  citations?: ReadonlyMap<string, IndexedCitation> | undefined;
  onNavigate?: ((href: string) => void) | undefined;
}) {
  // Chat providers use both TeX and Markdown math delimiters. Leave code examples alone.
  const source = transformCitationsToMarkdown(text, citations)
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\\\[([\s\S]*?)\\\]/g, (_, value: string) => '\n\n$$\n' + value + '\n$$\n\n')
            .replace(/\\\(([^\n]*?)\\\)/g, (_, value: string) => '$' + value + '$'),
    )
    .join('');

  function urlTransform(url: string): string {
    if (url.startsWith(MK_CITE_PREFIX)) return url;
    return defaultUrlTransform(url);
  }

  function renderAnchor(props: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
    const href = typeof props.href === 'string' ? props.href : '';
    if (href.startsWith(MK_CITE_PREFIX)) {
      const id = href.slice(MK_CITE_PREFIX.length);
      const entry = citations?.get(id);
      if (!entry) return null;
      const title = `${entry.badge} · ${entry.label}`;
      const ariaLabel = `参考来源 ${entry.index}：${title}`;
      if (entry.href) {
        return (
          <a
            className="mk-cite-badge"
            href={entry.href}
            title={title}
            aria-label={ariaLabel}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => handleSpaNavigation(event, entry.href!, onNavigate)}
          >
            {entry.index}
          </a>
        );
      }
      return (
        <span className="mk-cite-badge mk-cite-badge--static" title={title} aria-label={ariaLabel}>
          {entry.index}
        </span>
      );
    }
    return <a {...props} />;
  }

  return (
    <Markdown
      skipHtml
      remarkPlugins={[math]}
      rehypePlugins={[[renderMath, { trust: false }]]}
      urlTransform={urlTransform}
      components={{ a: renderAnchor }}
    >
      {source}
    </Markdown>
  );
}
