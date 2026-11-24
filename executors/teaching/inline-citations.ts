export const inlineCitationUlidPattern = '[0-9A-HJKMNP-TV-Z]{26}';

const exactUlidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ulidTokenRegex = /(?<![0-9A-Za-z])[0-9A-HJKMNP-TV-Z]{26}(?![0-9A-Za-z])/g;
const citeTagRegex = /\[\[\s*cite\s*:([^\]]*)\]\]/gi;
const incompleteCiteSuffix = /\[(?:\[(?:\s*(?:c(?:i(?:t(?:e(?:\s*(?::[^\]\r\n]{0,64}\]?)?)?)?)?)?)?)?)?$/i;
const closingPunctuationOrLineBreak = /^[\r\n，。！？；：、,.!?;:）)》】\]」』]/;

export function collectAllowedCitationIds(source: string | undefined, target: Set<string>): void {
  if (!source) return;
  for (const match of source.matchAll(ulidTokenRegex)) {
    target.add(match[0]);
  }
}

export function stripIncompleteCiteSuffix(text: string): string {
  if (!text.includes('[')) return text;
  return text.replace(incompleteCiteSuffix, '');
}

function appendAfterStrippedCite(out: string, chunk: string): string {
  if (!chunk) return out.replace(/[ \t]+$/, '');
  const trimmedLeading = chunk.replace(/^[ \t]+/, '');
  if (!trimmedLeading || closingPunctuationOrLineBreak.test(trimmedLeading)) {
    return out.replace(/[ \t]+$/, '') + trimmedLeading;
  }
  if (!out || out.endsWith('\n') || out.endsWith('\r')) {
    return out + trimmedLeading;
  }
  if (/[ \t]$/.test(out) && /^[ \t]/.test(chunk)) {
    return out + trimmedLeading;
  }
  return out + chunk;
}

export function sanitizeInlineCitations(text: string, allowedIds: ReadonlySet<string>): string {
  if (!text.includes('[[')) return text;
  let out = '';
  let cursor = 0;
  let justStripped = false;
  let matchedAny = false;

  for (const match of text.matchAll(citeTagRegex)) {
    matchedAny = true;
    const index = match.index ?? 0;
    const between = text.slice(cursor, index);
    const id = (match[1] ?? '').trim();
    const valid = exactUlidRegex.test(id) && allowedIds.has(id);

    if (valid) {
      out = justStripped ? appendAfterStrippedCite(out, between) : out + between;
      out += `[[cite:${id}]]`;
      justStripped = false;
    } else {
      if (justStripped) {
        if (!/^[ \t]*$/.test(between)) {
          out = appendAfterStrippedCite(out, between);
        }
      } else {
        out += between;
      }
      justStripped = true;
    }
    cursor = index + match[0].length;
  }

  if (!matchedAny) return text;
  const tail = text.slice(cursor);
  return justStripped ? appendAfterStrippedCite(out, tail) : out + tail;
}
