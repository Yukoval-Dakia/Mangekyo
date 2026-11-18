export async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export function responseTooLarge(response: Response, limit: number): boolean {
  const header = response.headers.get('content-length');
  if (header === null) return false;
  const length = Number(header);
  return Number.isFinite(length) && length > limit;
}

export async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (responseTooLarge(response, limit)) {
    await cancelBody(response);
    throw new Error('Response exceeds the byte limit');
  }
  if (!response.body) throw new Error('Response has no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('Response exceeds the byte limit');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
