import Markdown from 'react-markdown';
import math from 'remark-math';
import renderMath from 'rehype-katex';
import 'katex/dist/katex.min.css';

export default function MathText({ text }: { text: string }) {
  // Chat providers use both TeX and Markdown math delimiters. Leave code examples alone.
  const source = text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\\\[([\s\S]*?)\\\]/g, (_, value: string) => '\n\n$$\n' + value + '\n$$\n\n')
            .replace(/\\\(([^\n]*?)\\\)/g, (_, value: string) => '$' + value + '$'),
    )
    .join('');
  return (
    <Markdown skipHtml remarkPlugins={[math]} rehypePlugins={[[renderMath, { trust: false }]]}>
      {source}
    </Markdown>
  );
}
