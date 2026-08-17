/*
 * The file group.
 *
 * Nothing here is stored anywhere. A document is up to five files that share
 * one *stem* — the vault-relative path with every role marker stripped off:
 *
 *   <stem>.note                    the notebook, from the device
 *   <stem>.pdf                     converted from the notebook, or your original
 *   <stem>.pdf.mark                the ink layer, from the device
 *   <stem><annotatedSuffix>.pdf    the copy carrying the ink
 *   <sidecarFolder>/<stem>.md      the searchable markdown twin
 *
 * `stemOf` recovers the stem from any one of them and `groupPaths` rebuilds the
 * rest, which is what lets the group move as a unit without an index to keep in
 * step. The same string surgery that pairs a .mark with its PDF in main.js, run
 * in reverse.
 *
 * Nothing is classified. An unrelated Report.pdf yields the stem "Report",
 * whose four companions simply do not exist, so the caller finds nothing to
 * move. Deciding whether a given .pdf is generated, original or annotated would
 * be more code and more ways to be wrong.
 */

import { indexPathFor, DEFAULT_FOLDER } from './sidecar.js';

/** The sidecar folder as a clean prefix, with no leading or trailing slashes. */
function sidecarDir(folder) {
  return String(folder || DEFAULT_FOLDER).replace(/^\/+|\/+$/g, '') || DEFAULT_FOLDER;
}

/**
 * The stem shared by every file in `path`'s group, or null when the path is
 * none of our business.
 *
 * The order of these tests is the whole correctness of it: `.pdf.mark` has to
 * be stripped before `.pdf`, and the annotated suffix only after the extension
 * is off, because the suffix sits between the name and the extension.
 */
function stemOf(path, settings) {
  const p = String(path || '');
  const opts = settings || {};

  if (/\.pdf\.mark$/i.test(p)) return p.replace(/\.pdf\.mark$/i, '');
  if (/\.note$/i.test(p)) return p.replace(/\.note$/i, '');

  const dir = sidecarDir(opts.sidecarFolder);
  if (p.startsWith(`${dir}/`) && /\.md$/i.test(p)) {
    return p.slice(dir.length + 1).replace(/\.md$/i, '');
  }

  if (/\.pdf$/i.test(p)) {
    const base = p.replace(/\.pdf$/i, '');
    const suffix = opts.annotatedSuffix || '';
    // endsWith, not a regex: the suffix is free text a user typed into a
    // settings field, and " (annotated)" is four regex metacharacters.
    if (suffix && base.endsWith(suffix)) return base.slice(0, -suffix.length);
    return base;
  }

  return null;
}

/**
 * Every path the group could occupy, in a fixed order so two calls can be
 * zipped together to build a move. Paths are returned whether or not the files
 * exist — existence is the caller's problem.
 */
function groupPaths(stem, settings) {
  const opts = settings || {};
  const suffix = opts.annotatedSuffix || '';
  return [
    `${stem}.note`,
    `${stem}.pdf`,
    `${stem}.pdf.mark`,
    `${stem}${suffix}.pdf`,
    indexPathFor(`${stem}.note`, opts.sidecarFolder),
  ];
}

export { stemOf, groupPaths, sidecarDir };
