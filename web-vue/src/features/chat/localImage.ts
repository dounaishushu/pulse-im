import type { UploadAttachment } from "../../platform/contracts";

const maximumBytes = 10 * 1024 * 1024;
const maximumPixels = 64_000_000;
type Size = { width: number; height: number };
let imageWork: Promise<unknown> = Promise.resolve();

function validSize(width: number, height: number): Size {
  if (!width || !height || width > 65536 || height > 65536 || width * height > maximumPixels)
    throw Error("图片分辨率过大，请先压缩图片后重试。");
  return { width, height };
}

function swapsEXIFAxes(bytes: Uint8Array): boolean {
  if (bytes.length < 14 || String.fromCharCode(...bytes.slice(0, 6)) !== "Exif\0\0") return false;
  const tiff = new DataView(bytes.buffer, bytes.byteOffset + 6, bytes.length - 6);
  const order = tiff.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return false;
  const little = order === 0x4949;
  if (tiff.getUint16(2, little) !== 42) return false;
  const offset = tiff.getUint32(4, little);
  if (offset < 8 || offset + 2 > tiff.byteLength) return false;
  const count = tiff.getUint16(offset, little);
  for (let index = 0; index < Math.min(count, 256); index++) {
    const pos = offset + 2 + index * 12;
    if (pos + 12 > tiff.byteLength) return false;
    if (tiff.getUint16(pos, little) === 0x112 && tiff.getUint16(pos + 2, little) === 3 && tiff.getUint32(pos + 4, little) === 1) {
      const orientation = tiff.getUint16(pos + 8, little);
      return orientation >= 5 && orientation <= 8;
    }
  }
  return false;
}

// Read headers before decoding, including JPEGs with large EXIF/comment blocks.
async function imageSize(file: File, signal?: AbortSignal): Promise<Size | null> {
  signal?.throwIfAborted();
  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const view = new DataView(header.buffer);
  if (header.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((x, i) => header[i] === x))
    return validSize(view.getUint32(16), view.getUint32(20));
  if (header[0] === 0xff && header[1] === 0xd8) {
    let offset = 2;
    let swapped = false;
    let frame: Size | null = null;
    for (let segments = 0; segments < 1024 && offset + 9 <= file.size; segments++) {
      signal?.throwIfAborted();
      const bytes = new Uint8Array(await file.slice(offset, offset + 9).arrayBuffer());
      if (bytes[0] !== 0xff) return null;
      const marker = bytes[1]!;
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xda || marker === 0xd9)
        return frame && swapped ? validSize(frame.height, frame.width) : frame;
      const length = (bytes[2]! << 8) | bytes[3]!;
      if (length < 2 || offset + 2 + length > file.size) return null;
      if (marker === 0xe1) {
        const exif = new Uint8Array(await file.slice(offset + 4, offset + 2 + length).arrayBuffer());
        if (String.fromCharCode(...exif.slice(0, 6)) === "Exif\0\0") swapped = swapsEXIFAxes(exif);
      }
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) return null;
        const width = (bytes[7]! << 8) | bytes[8]!, height = (bytes[5]! << 8) | bytes[6]!;
        frame = validSize(width, height);
      }
      offset += 2 + length;
    }
    return null;
  }
  if (header.length >= 30 && String.fromCharCode(...header.slice(0, 4)) === "RIFF" && String.fromCharCode(...header.slice(8, 12)) === "WEBP") {
    const format = String.fromCharCode(...header.slice(12, 16));
    if (format === "VP8X")
      return validSize(1 + header[24]! + (header[25]! << 8) + (header[26]! << 16), 1 + header[27]! + (header[28]! << 8) + (header[29]! << 16));
    if (format === "VP8 " && header[23] === 0x9d && header[24] === 1 && header[25] === 0x2a)
      return validSize(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    if (format === "VP8L" && header[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return validSize(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
    }
  }
  if (header.length >= 10 && /^GIF8[79]a$/.test(String.fromCharCode(...header.slice(0, 6))))
    return validSize(view.getUint16(6, true), view.getUint16(8, true));
  return null;
}

function localRaster(file: UploadAttachment): file is File {
  return file instanceof File && file.size > 0 && file.size <= maximumBytes &&
    /\.(jpe?g|png|webp|gif)$/i.test(file.name);
}

function encode(file: File, size: Size, edge: number, mime: string, signal?: AbortSignal): Promise<Blob> {
  const task = imageWork.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    const ratio = Math.min(1, edge / Math.max(size.width, size.height));
    const bitmap = await createImageBitmap(file, {
      resizeWidth: Math.max(1, Math.round(size.width * ratio)),
      resizeHeight: Math.max(1, Math.round(size.height * ratio)),
      resizeQuality: "high",
    });
    const canvas = document.createElement("canvas");
    try {
      signal?.throwIfAborted();
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw Error("图片暂时无法处理，请重试。");
      context.drawImage(bitmap, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        value => value ? resolve(value) : reject(Error("图片暂时无法处理，请重试。")), mime, 0.9,
      ));
      signal?.throwIfAborted();
      return blob;
    } finally {
      bitmap.close();
      canvas.width = canvas.height = 0;
    }
  });
  imageWork = task.then(() => {}, () => {});
  return task;
}

export async function imageThumbnail(file: UploadAttachment, signal?: AbortSignal): Promise<Blob | null> {
  if (!localRaster(file)) return null;
  const size = await imageSize(file, signal);
  if (!size) return null;
  return encode(file, size, 192, "image/png", signal);
}

export async function prepareImageUpload(file: UploadAttachment, { signal }: { signal?: AbortSignal } = {}): Promise<UploadAttachment> {
  if (!localRaster(file) || /\.gif$/i.test(file.name)) return file;
  const size = await imageSize(file, signal);
  signal?.throwIfAborted();
  if (!size || (size.width <= 12000 && size.height <= 12000 && size.width * size.height <= 24_000_000)) return file;
  const mime = /\.jpe?g$/i.test(file.name) ? "image/jpeg" : /\.webp$/i.test(file.name) ? "image/webp" : "image/png";
  const blob = await encode(file, size, 2560, mime, signal);
  const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
  return new File([blob], file.name.replace(/\.[^.]+$/, "." + extension), { type: blob.type, lastModified: file.lastModified });
}
