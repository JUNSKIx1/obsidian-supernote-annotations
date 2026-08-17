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

export { hashBytes, cacheKey, cacheDir };
