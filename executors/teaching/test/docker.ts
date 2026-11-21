import { execFileSync } from 'node:child_process';

export function hasDockerImage(image: string, options: {timeout?: number} = {}): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore', ...options });
    return true;
  } catch {
    return false;
  }
}
