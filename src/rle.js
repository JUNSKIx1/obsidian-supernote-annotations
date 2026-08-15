/*
 * RATTA_RLE decoder — the Supernote's ink encoding.
 *
 * Written by hand rather than pulled from a library, so the plugin carries no
 * image dependency and runs unchanged on a phone. The wire format (palette
 * bytes, the 0x80 length-extension scheme, the 0xff special-length marker and
 * the tail-run rule) follows the documented behaviour of jya-dev/supernote-tool,
 * which is also the reference this is tested against — see
 * tests/decoder-test.js.
 *
 * Output is always straight RGBA bytes; nothing here knows about PDFs, canvases
 * or Obsidian, which is what makes it testable in plain Node.
 */

const SPECIAL_LENGTH_MARKER = 0xff;
const SPECIAL_LENGTH = 0x4000;
const SPECIAL_LENGTH_FOR_BLANK = 0x400;

// Encoded palette byte → RGBA. `background` is transparent, which is what makes
// a decoded MARK layer usable directly as an overlay.
// Note the deliberate swap: CSS 'gray' (128) is darker than CSS 'darkgray' (169),
// so darkGray maps to 128 and gray to 169 to keep darkGray < gray in lightness.
const PALETTE = {
  0x61: [0, 0, 0, 255],        // black
  0x62: [0, 0, 0, 0],          // background — transparent
  0x63: [128, 128, 128, 255],  // darkGray
  0x64: [169, 169, 169, 255],  // gray
  0x65: [255, 255, 255, 255],  // white
  0x66: [0, 0, 0, 255],        // markerBlack
  0x67: [128, 128, 128, 255],  // markerDarkGray
  0x68: [169, 169, 169, 255],  // markerGray
  0x9d: [128, 128, 128, 255],  // darkGrayX2
  0xc9: [169, 169, 169, 255],  // grayX2
  0x9e: [128, 128, 128, 255],  // markerDarkGrayX2
  0xca: [169, 169, 169, 255],  // markerGrayX2
};

const LITTLE_ENDIAN = (() => {
  const bytes = new Uint8Array(4);
  new Uint32Array(bytes.buffer)[0] = 1;
  return bytes[0] === 1;
})();

function pack(r, g, b, a) {
  return LITTLE_ENDIAN
    ? (((a << 24) | (b << 16) | (g << 8) | r) >>> 0)
    : (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
}

const PACKED = (() => {
  const t = {};
  for (const [k, v] of Object.entries(PALETTE)) t[Number(k)] = pack(v[0], v[1], v[2], v[3]);
  return t;
})();
const PACKED_UNKNOWN = pack(0, 0, 0, 0);

/**
 * The tail run carries no explicit length; pick the largest power-of-two
 * multiple that still fits in the remaining pixels.
 */
function adjustTailLength(tailLength, written, expected) {
  const gap = expected - written;
  for (let i = 7; i >= 0; i--) {
    const length = ((tailLength & 0x7f) + 1) << i;
    if (length <= gap) return length;
  }
  return 0;
}

/**
 * Walks the encoded (colour, length) run pairs, calling fill(cursor, colour, length)
 * for each and threading the returned cursor onward. Returns the final cursor.
 */
function walkRuns(buffer, totalPixels, allBlank, fill) {
  let cursor = 0;
  let holder = null;
  let waiting = [];

  for (let index = 1; index < buffer.length; index += 2) {
    const colour = buffer[index - 1];
    let length = buffer[index];
    let pushed = false;

    if (holder !== null) {
      const prevColour = holder[0];
      let prevLength = holder[1];
      holder = null;
      if (colour === prevColour) {
        // Same colour continues: combine the held high bits with this length.
        length = 1 + length + (((prevLength & 0x7f) + 1) << 7);
        waiting.push([colour, length]);
        pushed = true;
      } else {
        prevLength = ((prevLength & 0x7f) + 1) << 7;
        waiting.push([prevColour, prevLength]);
      }
    }

    if (!pushed) {
      if (length === SPECIAL_LENGTH_MARKER) {
        waiting.push([colour, allBlank ? SPECIAL_LENGTH_FOR_BLANK : SPECIAL_LENGTH]);
      } else if ((length & 0x80) !== 0) {
        holder = [colour, length];   // high bit set → length continues in the next pair
      } else {
        waiting.push([colour, length + 1]);
      }
    }

    for (const run of waiting) cursor = fill(cursor, run[0], run[1]);
    waiting = [];
  }

  if (holder !== null) {
    const length = adjustTailLength(holder[1], cursor, totalPixels);
    if (length > 0) cursor = fill(cursor, holder[0], length);
  }
  return cursor;
}

/**
 * Decode one RLE layer bitmap to RGBA bytes.
 * Throws when the decoded run lengths do not add up to width*height, which is
 * the signal that the file was read mid-write or is a format we don't know.
 */
function decodeLayer(buffer, width, height, allBlank) {
  const totalPixels = width * height;
  const out = new Uint8Array(totalPixels * 4);
  const pixels = new Uint32Array(out.buffer);

  const cursor = walkRuns(buffer, totalPixels, !!allBlank, (at, colour, length) => {
    const packed = PACKED[colour] !== undefined ? PACKED[colour] : PACKED_UNKNOWN;
    const end = Math.min(at + length, pixels.length);
    if (end > at) pixels.fill(packed, at, end);
    return at + length;
  });

  if (cursor !== totalPixels) {
    throw new Error(`RLE length mismatch: decoded ${cursor} of ${totalPixels} pixels`);
  }
  return out;
}

/** Draw `src` RGBA over `dst` RGBA in place (source-over, both premultiplied-free). */
function compositeOver(dst, src) {
  const d32 = new Uint32Array(dst.buffer);
  const s32 = new Uint32Array(src.buffer);
  for (let i = 0; i < s32.length; i++) {
    const s = s32[i];
    if (s === 0) continue;                       // fully transparent → nothing to draw
    const p = i * 4;
    const sa = src[p + 3];
    if (sa === 255) { d32[i] = s; continue; }    // opaque → straight copy
    const da = dst[p + 3];
    const outA = sa + (da * (255 - sa)) / 255;
    if (outA === 0) { d32[i] = 0; continue; }
    for (let c = 0; c < 3; c++) {
      dst[p + c] = (src[p + c] * sa + dst[p + c] * da * (255 - sa) / 255) / outA;
    }
    dst[p + 3] = outA;
  }
}

/**
 * Decode a whole page.
 *
 * includeBackground=false (the default, and what `.mark` overlays need) keeps
 * only the ink layers, so the result can be stamped straight onto a PDF.
 * includeBackground=true also draws BGLAYER, which is what a `.note` page wants.
 *
 * Returns { data, width, height, opaque, bbox } where bbox is
 * [x0, y0, x1, y1] exclusive of the far edge, or null when nothing was drawn.
 */
function decodePage(page, width, height, includeBackground) {
  const seq = Array.isArray(page.LAYERSEQ) ? page.LAYERSEQ : String(page.LAYERSEQ || '').split(',');
  // A user-uploaded page template is stored as a PNG, not as RLE, so it can't
  // go through this decoder at all.
  const templateIsPng = String(page.PAGESTYLE || '').startsWith('user_');

  const layers = [];
  for (const name of seq) {
    const layer = page[name];
    if (!layer || !layer.bitmapBuffer || !layer.bitmapBuffer.length) continue;
    if (layer.LAYERNAME === 'BGLAYER' && (!includeBackground || templateIsPng)) continue;
    layers.push(layer);
  }

  const out = new Uint8Array(width * height * 4);
  // LAYERSEQ runs front-to-back, so draw it in reverse: background first.
  for (let i = layers.length - 1; i >= 0; i--) {
    let decoded;
    try {
      decoded = decodeLayer(layers[i].bitmapBuffer, width, height, false);
    } catch {
      // One unreadable layer must not lose the others.
      continue;
    }
    compositeOver(out, decoded);
  }

  return Object.assign({ data: out, width, height }, measure(out, width, height));
}

/** Opaque-pixel count and ink bounding box, used for "is this blank?" and for tests. */
function measure(rgba, width, height) {
  let opaque = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (rgba[(row + x) * 4 + 3] === 0) continue;
      opaque++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { opaque, bbox: maxX < 0 ? null : [minX, minY, maxX + 1, maxY + 1] };
}

export { decodeLayer, decodePage, compositeOver, measure, PALETTE };
