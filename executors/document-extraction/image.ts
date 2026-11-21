import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type Crop = { left: number; top: number; width: number; height: number };
type Dimensions = { width: number; height: number };
type ImageRead =
  | { kind: 'unavailable' }
  | { kind: 'too_large' }
  | ({ kind: 'out_of_bounds' } & Dimensions)
  | ({ kind: 'available'; image?: { mediaType: 'image/png'; data: string } } & Dimensions);

export async function readDocumentImage(
  bytes: Buffer, mediaType: string, crop: Crop | undefined,
  { maxInputPixels, maxCropBytes }: { maxInputPixels: number; maxCropBytes: number },
): Promise<ImageRead> {
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') return { kind: 'unavailable' };
  const decoder = sharp(bytes, { limitInputPixels: maxInputPixels, failOn: 'warning' });
  const { format, width, height } = await decoder.metadata();
  if (format !== (mediaType === 'image/png' ? 'png' : 'jpeg') || !width || !height || width * height > maxInputPixels)
    return { kind: 'unavailable' };
  if (!crop) return { kind: 'available', width, height };
  if (crop.left > width - crop.width || crop.top > height - crop.height)
    return { kind: 'out_of_bounds', width, height };
  const output = await decoder.extract(crop).png().toBuffer();
  if (output.length > maxCropBytes) return { kind: 'too_large' };
  return { kind: 'available', width, height, image: { mediaType: 'image/png', data: output.toString('base64') } };
}

export type VisionImageNormalizeOptions = {
  readonly maxEdge?: number | undefined;
  readonly quality?: number | undefined;
  readonly maxInputPixels?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
};

export type NormalizedVisionImage = {
  readonly bytes: Buffer;
  readonly mediaType: 'image/jpeg';
  readonly base64: string;
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly originalWidth: number | null;
  readonly originalHeight: number | null;
  readonly originalOrientation: number | null;
  readonly rotatedByExif: boolean;
  readonly originalBytes: number;
};

const visionMaxEdgeDefault = 1600;
const visionMaxEdgeMin = 512;
const visionMaxEdgeMax = 2400;
const visionQualityDefault = 85;
const visionQualityMin = 50;
const visionQualityMax = 95;
const visionQualityRetry = 72;
const visionMaxInputPixelsDefault = 64_000_000;
const visionMaxOutputBytesDefault = 4 * 1024 * 1024;
const sipsTimeoutMs = 60_000;

function clampInteger(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error(`图像参数无效：${value}。`);
  return Math.min(max, Math.max(min, Math.round(value)));
}

function runSips(args: string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      '/usr/bin/sips',
      args,
      { timeout: sipsTimeoutMs, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error) {
          const detail = typeof stderr === 'string' && stderr.trim() ? `：${stderr.trim().slice(0, 200)}` : '';
          rejectPromise(new Error(`macOS sips 转码失败${detail}`));
        } else resolvePromise(typeof stdout === 'string' ? stdout : '');
      },
    );
  });
}

// sharp 对本机 HEIC/HEIF 等编码支持不全时，在 macOS 上用自带 sips 先转成 JPEG 再进 sharp。
// 临时文件一律放 os.tmpdir() 并用 fs.rm 清理，不走 shell rm。
async function transcodeToJpegWithSips(bytes: Buffer, maxInputPixels: number): Promise<Buffer | null> {
  if (process.platform !== 'darwin') return null;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'mangekyo-vision-'));
    const input = path.join(dir, 'input.bin');
    const output = path.join(dir, 'output.jpg');
    await writeFile(input, bytes);
    const props = await runSips(['-g', 'pixelWidth', '-g', 'pixelHeight', input]);
    const pw = Number(/pixelWidth:\s*(\d+)/.exec(props)?.[1]);
    const ph = Number(/pixelHeight:\s*(\d+)/.exec(props)?.[1]);
    if (Number.isFinite(pw) && Number.isFinite(ph) && pw > 0 && ph > 0 && pw * ph > maxInputPixels) {
      throw new Error('Input image exceeds pixel limit');
    }
    await runSips(['-s', 'format', 'jpeg', input, '--out', output]);
    const converted = await readFile(output);
    return converted.length > 0 ? converted : null;
  } catch (error) {
    if (error instanceof Error && /pixel limit/i.test(error.message)) throw error;
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function normalizeImageForVisionOcr(
  bytes: Buffer,
  options?: VisionImageNormalizeOptions,
): Promise<NormalizedVisionImage> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('图像内容为空或不是 Buffer。');
  const maxEdge = clampInteger(options?.maxEdge, visionMaxEdgeDefault, visionMaxEdgeMin, visionMaxEdgeMax);
  const maxInputPixels = clampInteger(options?.maxInputPixels, visionMaxInputPixelsDefault, 1, Number.MAX_SAFE_INTEGER);
  const maxOutputBytes = clampInteger(options?.maxOutputBytes, visionMaxOutputBytesDefault, 1, Number.MAX_SAFE_INTEGER);
  const qualityFirst = clampInteger(options?.quality, visionQualityDefault, visionQualityMin, visionQualityMax);

  let usedSips = false;
  let source = bytes;
  let originalWidth: number | null = null;
  let originalHeight: number | null = null;
  let originalOrientation: number | null = null;
  const readMeta = async (input: Buffer) =>
    sharp(input, { limitInputPixels: maxInputPixels, failOn: 'error' }).metadata();
  const isPixelLimitError = (error: unknown) =>
    error instanceof Error && /pixel limit/i.test(error.message);
  const convertWithSips = async (originalError: unknown, stageLabel: string) => {
    if (usedSips || isPixelLimitError(originalError)) {
      const message = originalError instanceof Error ? originalError.message : String(originalError);
      throw new Error(`${stageLabel}：${message}`);
    }
    usedSips = true;
    const converted = await transcodeToJpegWithSips(source, maxInputPixels);
    if (!converted) {
      const message = originalError instanceof Error ? originalError.message : String(originalError);
      throw new Error(`${stageLabel}（可能是不支持的编码或文件损坏）：${message}`);
    }
    source = converted;
    const meta = await readMeta(source).catch((retryError) => {
      const message = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(`sips 转码后仍无法读取图像：${message}`);
    });
    if (typeof meta.width === 'number' && typeof meta.height === 'number' && meta.width * meta.height > maxInputPixels) {
      throw new Error('图像像素数超过安全上限。');
    }
    originalWidth ??= typeof meta.width === 'number' ? meta.width : null;
    originalHeight ??= typeof meta.height === 'number' ? meta.height : null;
    originalOrientation ??= typeof meta.orientation === 'number' ? meta.orientation : null;
  };
  try {
    const meta = await readMeta(source);
    originalWidth = typeof meta.width === 'number' ? meta.width : null;
    originalHeight = typeof meta.height === 'number' ? meta.height : null;
    originalOrientation = typeof meta.orientation === 'number' ? meta.orientation : null;
    if (originalWidth !== null && originalHeight !== null && originalWidth * originalHeight > maxInputPixels) {
      throw new Error('Input image exceeds pixel limit');
    }
  } catch (error) {
    await convertWithSips(error, '无法读取图像');
  }

  const rotatedByExif =
    typeof originalOrientation === 'number' && originalOrientation >= 2 && originalOrientation <= 8;

  const encode = async (quality: number) =>
    sharp(source, { limitInputPixels: maxInputPixels, failOn: 'error' })
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

  let out;
  try {
    out = await encode(qualityFirst);
  } catch (error) {
    await convertWithSips(error, '图像解码失败');
    out = await encode(qualityFirst);
  }
  if (out.info.size > maxOutputBytes && qualityFirst > visionQualityRetry) {
    out = await encode(visionQualityRetry);
  }
  if (out.info.size > maxOutputBytes) {
    throw new Error(`压缩后的图像 ${(out.info.size / 1024).toFixed(0)}KB 仍超过上限 ${(maxOutputBytes / 1024).toFixed(0)}KB，请降低分辨率后重试。`);
  }
  if (!out.info.width || !out.info.height || out.info.width > maxEdge || out.info.height > maxEdge) {
    throw new Error(`压缩后的图像尺寸 ${out.info.width}×${out.info.height} 超出边长上限 ${maxEdge}。`);
  }

  const base64 = out.data.toString('base64');
  return {
    bytes: out.data,
    mediaType: 'image/jpeg',
    base64,
    dataUrl: `data:image/jpeg;base64,${base64}`,
    width: out.info.width,
    height: out.info.height,
    byteLength: out.info.size,
    originalWidth,
    originalHeight,
    originalOrientation,
    rotatedByExif,
    originalBytes: bytes.length,
  };
}
