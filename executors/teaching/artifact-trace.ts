const operation = '挂载交互作品';
const prefix = operation + ' · ';
const mounted = prefix + '已挂载';
const rejected = prefix + '未挂载';

export function artifactMountTrace(output: string): string {
  try {
    const receipt = JSON.parse(output);
    if (receipt?.ok === false || typeof receipt?.error === 'string' || receipt?.state === 'rejected') return rejected;
    if (receipt?.state === 'done') return mounted;
  } catch { /* A clipped past receipt can only identify the operation. */ }
  return operation;
}

export function projectArtifactMountTrace(entry: string): string {
  if (entry === '参数错误 · mount_artifact') return rejected;
  if (entry === mounted || entry === rejected || !entry.startsWith(prefix)) return entry;
  return artifactMountTrace(entry.slice(prefix.length));
}
