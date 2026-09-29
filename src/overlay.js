/*
 * Where the stamped PDF lives when there is only meant to be one PDF.
 *
 * The device stores your ink beside the PDF and draws the two together, which
 * is why its file browser shows one item. Doing the same in Obsidian means the
 * stamped copy must not be a file in the vault at all: this vault is the folder
 * your Supernote syncs with, and a PDF that comes back with ink already baked
 * into it gets the live .mark layer drawn on top of the bake — every stroke
 * twice, worse on every pass.
 *
 * So the stamped bytes go under the plugin's own folder in .obsidian instead.
 * Not a vault file: it never appears in the explorer, never syncs to the
 * device, cannot be linked, and vault.getFiles() cannot see it. The whole
 * folder is a cache and deleting it costs nothing but a rebuild.
 *
 * Keyed by the *content* of the .mark rather than by its path, which is what
 * makes the cache survive a move or a rename with no index to keep in step.
 */

/**
 * FNV-1a, 32 bit. Not a checksum for anything that matters — it names a cache
 * entry, and the cost of a collision is one stale overlay until the .mark
 * changes again. Chosen because it is nine lines and needs no crypto API,
 * which the mobile app does not reliably expose.
 */
function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The cache entry name for an ink layer stamped onto a particular PDF.
 *
 * The original's size is in the key so that replacing the PDF underneath an
 * unchanged .mark produces a different entry.
 *
 * ponytail: size, not a hash of the PDF. Re-hashing 18 MB on every pass to
 * catch an edit that kept the byte count identical is not worth it. Hash the
 * PDF too if that ever actually bites.
 */
function cacheKey(markBytes, pdfSize) {
  return `${hashBytes(markBytes)}-${pdfSize}`;
}

/** The cache folder, inside the plugin's own directory under .obsidian. */
function cacheDir(configDir, pluginId) {
  return `${configDir}/plugins/${pluginId}/annotated`;
}

/**
 * Written into the Subject of a placeholder PDF — the stand-in that occupies a
 * notebook's `.pdf` path until someone actually opens it.
 *
 * The marker lives *in the file* rather than in a list kept beside it, and that
 * is the whole point. A list has to survive moves, renames, deletions, a vault
 * copied to another machine and a `data.json` someone cleared out; get any of
 * those wrong and a placeholder is mistaken for a real conversion, which is
 * silent and permanent. A file that says what it is cannot drift.
 */
const PLACEHOLDER_MARK = 'supernote-placeholder';

/** Anything bigger than this had page images in it, so it is a real conversion. */
const PLACEHOLDER_MAX = 16384;

/** A string as PDF writes it inside <…>: UTF-16BE, two bytes a character, hex. */
function asPdfHex(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(4, '0');
  return out.toUpperCase();
}

/**
 * Is the PDF at `size` bytes a placeholder rather than a real conversion?
 *
 * `read` is called only when the size makes it plausible, so a real PDF is
 * never pulled off disk to answer this — pass a function, not the bytes.
 *
 * Both spellings are checked because a PDF string is not necessarily ASCII in
 * the file: pdf-lib writes the info dictionary as UTF-16BE hex, so the marker
 * appears as <FEFF00730075…>. Both needles are derived from the one constant,
 * so this cannot fall out of step with what placeholderPdf actually wrote — and
 * it keeps working if a future pdf-lib switches to literal strings.
 */
async function isPlaceholder(size, read) {
  if (!(size > 0) || size >= PLACEHOLDER_MAX) return false;
  const bytes = await read();
  if (!bytes) return false;

  const u8 = new Uint8Array(bytes);
  let text = '';
  for (let i = 0; i < u8.length; i++) text += String.fromCharCode(u8[i]);

  return text.includes(PLACEHOLDER_MARK) || text.toUpperCase().includes(asPdfHex(PLACEHOLDER_MARK));
}

export {
  hashBytes, cacheKey, cacheDir,
  isPlaceholder, asPdfHex, PLACEHOLDER_MARK, PLACEHOLDER_MAX,
};
