/**
 * What an uploaded image really is, read from its bytes (never from the name or the declared type).
 * Only PNG, JPEG and WebP are recognised; anything else, SVG included, is refused.
 */
export interface ImageInfo {
  type: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

export function imageInfo(b: Uint8Array): ImageInfo | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG: signature, then the IHDR chunk with width and height.
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52) {
    return { type: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG: walk the segments to a start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = view.getUint16(i + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { type: "image/jpeg", height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      i += 2 + length;
    }
    return null;
  }
  // WebP: RIFF....WEBP, then VP8 (lossy), VP8L (lossless) or VP8X (extended).
  if (b.length >= 30 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") {
    const chunk = String.fromCharCode(...b.subarray(12, 16));
    if (chunk === "VP8 ") return { type: "image/webp", width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
      const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
      return { type: "image/webp", width: w, height: h };
    }
  }
  return null;
}
