import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';

export const intakeSwiftTimeoutMs = 120_000;
type DocumentKind = 'pdf' | 'image' | 'text';

function failure(method: 'pdfkit' | 'vision' | 'utf8', text: string) {
  return {
    status: 'failed' as const,
    method,
    text: '',
    error: text,
    warnings: [],
    pages: null,
    truncated: false,
    characterCount: 0,
  };
}

function failedFromSwift(kind: 'pdf' | 'image', message: string) {
  return failure(kind === 'pdf' ? 'pdfkit' : 'vision', message);
}

async function runSwift(args: string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.env.MANGEKYO_SWIFT?.trim() || 'swift',
      args,
      {
        timeout: intakeSwiftTimeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (error) rejectPromise(error);
        else resolvePromise({ stdout, stderr });
      },
    );
  });
}

export async function extractLocalDocument(kind: DocumentKind, storedPath: string, bytes: Buffer, textLimit: number) {
  if (kind === 'text') {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      let text = decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded;
      text = text.replace(/\r\n?/g, '\n');
      if (text.includes('\u0000')) throw new Error('文本包含无效控制字符。');
      if (!text.trim()) throw new Error('这个文本文件没有可读内容。');
      let truncated = false;
      if (text.length > textLimit) {
        text = text.slice(0, textLimit);
        truncated = true;
      }
      return {
        status: 'ok' as const,
        method: 'utf8' as const,
        text,
        error: null,
        warnings: truncated ? ['文本超过本地抽取上限，已保存前 200 万字。'] : [],
        pages: null,
        truncated,
        characterCount: text.length,
      };
    } catch (error) {
      return failure('utf8', error instanceof Error ? error.message : '文本抽取失败。');
    }
  }
  if (platform() !== 'darwin') {
    return failedFromSwift(kind, '当前系统只支持 UTF-8 文本原样读取；原件已保存。');
  }
  const script = fileURLToPath(new URL('./extract-document.swift', import.meta.url));
  try {
    const { stdout } = await runSwift([script, kind, storedPath]);
    const result = JSON.parse(stdout) as Record<string, unknown>;
    if (result.ok !== true) {
      return failedFromSwift(kind, typeof result.error === 'string' && result.error ? result.error : '本地文字抽取失败。');
    }
    try {
      return intakeExtractionFromSwift(result, kind);
    } catch (error) {
      return failedFromSwift(kind, error instanceof Error ? error.message : '本地文字抽取结果无效。');
    }
  } catch (error) {
    if (error instanceof Error && (('killed' in error && error.killed === true) || ('code' in error && error.code === 'ETIMEDOUT'))) {
      return failedFromSwift(kind, '本地文字抽取超时（120 秒）；原件已保存。');
    }
    return failedFromSwift(kind, '本地文字抽取失败。');
  }
}

function intakeExtractionFromSwift(result: Record<string, unknown>, kind: Exclude<DocumentKind, 'text'>) {
  const text = typeof result.text === 'string' ? result.text : '';
  if (!text.trim()) throw new Error('本地抽取没有得到可读文字。');
  const warnings = Array.isArray(result.warnings) ? result.warnings.filter((item) => typeof item === 'string').slice(0, 8) : [];
  return {
    status: (warnings.length > 0 || result.truncated === true ? 'partial' : 'ok') as 'ok' | 'partial',
    method: typeof result.method === 'string' ? (result.method as 'pdfkit' | 'vision' | 'pdfkit+vision') : kind === 'pdf' ? 'pdfkit' : 'vision',
    text,
    error: null,
    warnings,
    pages: typeof result.pages === 'number' && Number.isSafeInteger(result.pages) ? result.pages : null,
    truncated: result.truncated === true,
    characterCount: text.length,
  };
}
