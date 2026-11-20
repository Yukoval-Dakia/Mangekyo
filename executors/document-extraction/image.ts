import sharp from 'sharp';

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
