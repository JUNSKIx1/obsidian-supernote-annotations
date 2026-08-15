/*
 * RGBA → PNG, with no image library.
 *
 * pdf-lib can only embed PNG or JPEG, so decoded ink has to become PNG bytes.
 * Compression uses the platform's CompressionStream (Chromium on the desktop,
 * WebKit on iOS 16.4+), which every target here has and which keeps this file
 * dependency-free. An uncompressed PNG is not an option: one 1920×2560 page is
 * ~19 MB raw, and a ten-page overlay would be ~200 MB.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  dv.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream is unavailable — PDF generation needs a Chromium-based desktop app or iOS 16.4 or later');
  }
  // 'deflate' is the zlib-wrapped form (RFC 1950), which is exactly what PNG's
  // IDAT expects — 'deflate-raw' would produce an unreadable file.
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const parts = [];
  const reader = cs.readable.getReader();
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * Encode RGBA bytes as a PNG.
 * Colour type 6 (RGBA), 8-bit, filter 0 on every scanline — deflate handles the
 * long transparent runs well enough that a smarter filter is not worth it here.
 */
async function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: truecolour with alpha
  // 10..12 = compression 0, filter 0, interlace 0

  const idat = await deflate(raw);
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * Crop RGBA to a box. Overlays are mostly empty space; cropping to the ink
 * bounds before encoding is the difference between a 20 MB page and a 200 KB one.
 */
function crop(rgba, width, box) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * width + x0) * 4;
    out.set(rgba.subarray(from, from + w * 4), y * w * 4);
  }
  return { data: out, width: w, height: h };
}

/** Paint RGBA onto opaque white — a note page should look like paper, not glass. */
function flattenToWhite(rgba) {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    out[i] = rgba[i] * a + 255 * (1 - a);
    out[i + 1] = rgba[i + 1] * a + 255 * (1 - a);
    out[i + 2] = rgba[i + 2] * a + 255 * (1 - a);
    out[i + 3] = 255;
  }
  return out;
}

/**
 * Where an ink canvas of `canvasW`×`canvasH` sits on a PDF page of `pageW`×`pageH`.
 *
 * The device shows the page fitted to its screen with the aspect ratio preserved
 * and the remainder as bars, and stores ink in screen coordinates. So the page
 * occupies a centred sub-rectangle of the canvas, and mapping back means
 * scaling by that fitted size — not stretching the whole canvas onto the page,
 * which would misplace every stroke.
 *
 * Measured, not assumed: A4 on the 1920×2560 screen gives 54 px bars, and the
 * handwriting then lands on the printed rule lines. Re-test before changing it.
 */
function placement(canvasW, canvasH, pageW, pageH) {
  const scale = Math.min(canvasW / pageW, canvasH / pageH);
  const fittedW = pageW * scale;
  const fittedH = pageH * scale;
  return {
    offsetX: (canvasW - fittedW) / 2,
    offsetY: (canvasH - fittedH) / 2,
    fittedW,
    fittedH,
    scale,
  };
}

export { encodePng, crop, flattenToWhite, placement, crc32 };
