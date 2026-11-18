export function memoryValue(value: unknown) {
  if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string' ||
      value.text.length > 800 || !value.text.isWellFormed() || value.text.includes('\0') ||
      !('endpoint' in value) || typeof value.endpoint !== 'string' || value.endpoint.length > 2000)
    throw new Error('同伴备忘内容无效。');
  const providerId = 'providerId' in value ? value.providerId : 'default';
  const protocol = 'protocol' in value ? value.protocol : 'openai';
  if (typeof providerId !== 'string' || !providerId || providerId.length > 100 ||
      (protocol !== 'openai' && protocol !== 'anthropic')) throw new Error('备忘模型配置无效。');
  return { text: value.text.trim(), endpoint: value.endpoint, providerId, protocol };
}
