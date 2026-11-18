export function memoryValue(value: unknown) {
  if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string' ||
      value.text.length > 800 || !value.text.isWellFormed() || value.text.includes('\0') ||
      !('endpoint' in value) || typeof value.endpoint !== 'string' || value.endpoint.length > 2000)
    throw new Error('同伴备忘内容无效。');
  return { text: value.text.trim(), endpoint: value.endpoint };
}
