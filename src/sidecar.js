/*
 * Text sidecars.
 *
 * A .note or a generated PDF is opaque to Obsidian: it cannot be searched, it
 * has no tags and it never shows up in the graph. The sidecar is a small
 * markdown twin carrying the recognised handwriting, so search and the tag pane
 * can see it while the file explorer beside your real notes still shows only
 * the PDF.
 *
 * Produces nothing when the device never ran recognition — which is the case
 * for most files until you switch it on. That is a device setting, not a bug
 * here.
 */

const DEFAULT_FOLDER = 'Supernote Index';

/** #tags written by hand on the page, recovered from the recognised text. */
function extractTags(text) {
  const found = new Set();
  const re = /(^|\s)#([\p{L}\p{N}][\p{L}\p{N}_\-/]{1,40})/gu;
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[2]);
  return [...found].sort();
}

/**
 * One page's recognised text.
 *
 * `paragraphs` is preferred over `text` because it reflows lines that wrapped
 * on the device, so a sentence comes back as a sentence. The parser returns it
 * as a *string*, but an array is accepted too: this is the one place the plugin
 * touches that shape, and being wrong about it crashes the whole page.
 */
function pageText(page) {
  const raw = page.paragraphs;
  // `[]` is truthy, so `paragraphs || text` would swallow the fallback.
  const fromParagraphs = Array.isArray(raw) ? raw.join('\n\n') : String(raw ?? '');
  const chosen = fromParagraphs.trim() ? fromParagraphs : String(page.text ?? '');
  return chosen.trim();
}

/** Recognised text per page, or null when there is none worth writing. */
function collectText(sn) {
  const pages = [];
  let any = false;
  for (let i = 0; i < sn.pages.length; i++) {
    const text = pageText(sn.pages[i]);
    if (text) any = true;
    pages.push(text);
  }
  return any ? pages : null;
}

/**
 * Where the sidecar for `sourcePath` lives: the same relative path, under the
 * configured folder, as markdown.
 */
function indexPathFor(sourcePath, folder) {
  const dir = String(folder || DEFAULT_FOLDER).replace(/^\/+|\/+$/g, '') || DEFAULT_FOLDER;
  const noExt = sourcePath.replace(/\.(note|mark)$/i, '').replace(/\.pdf$/i, '');
  return `${dir}/${noExt}.md`;
}

/**
 * Extra frontmatter lines the user configured, e.g. `category: lectures`.
 * Free text on purpose: every vault labels things differently, and guessing a
 * taxonomy for someone else is worse than letting them type one.
 */
function extraFrontmatterLines(extra) {
  return String(extra || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Build the sidecar markdown.
 *
 * Deliberately contains no `- [ ]`: an empty checkbox would be counted as a
 * real open task by every task plugin there is, and this file is an index, not
 * a to-do list.
 */
function buildSidecar(sn, sourcePath, artefactPath, pagesText, options) {
  const opts = options || {};
  const tags = extractTags(pagesText.join('\n'));
  const front = [
    '---',
    'type: supernote-index',
    ...extraFrontmatterLines(opts.extraFrontmatter),
    `source: "${sourcePath}"`,
    artefactPath ? `artifact: "${artefactPath}"` : null,
    `pages: ${sn.pages.length}`,
    'tags:',
    '  - supernote',
    ...tags.map((t) => `  - ${t}`),
    '---',
    '',
  ].filter((l) => l !== null);

  const body = [
    `# ${sourcePath.split('/').pop()}`,
    '',
    '> Generated automatically from the handwriting recognition on your Supernote.',
    '> This file exists to make the handwriting searchable — do not edit it, it gets overwritten.',
    '',
    artefactPath ? `[[${artefactPath}|Open the PDF]]` : '',
    '',
  ];

  pagesText.forEach((t, i) => {
    if (!t) return;
    body.push(`## Page ${i + 1}`, '', t, '');
  });

  return front.join('\n') + body.join('\n');
}

export {
  extractTags,
  pageText,
  collectText,
  indexPathFor,
  buildSidecar,
  extraFrontmatterLines,
  DEFAULT_FOLDER,
};
