#!/usr/bin/env node
/*
 * Unit tests for the sidecar builder.
 *
 *   node tests/sidecar-test.mjs
 *
 * Needs no sample files and no network — everything here runs against
 * hand-built fixtures. Sidecars are the only feature that writes markdown into
 * a user's vault, so they get the tightest tests in the repo.
 */

import {
  extractTags,
  collectText,
  indexPathFor,
  buildSidecar,
  extraFrontmatterLines,
  DEFAULT_FOLDER,
} from '../src/sidecar.js';
import { reporter } from './helpers.mjs';

const { check, done } = reporter();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\nextractTags\n');
check(eq(extractTags('a #uml b'), ['uml']), 'finds a simple tag');
check(eq(extractTags('#bb #aa'), ['aa', 'bb']), 'sorts tags');
check(eq(extractTags('#b'), []), 'ignores a single-character tag');
check(eq(extractTags('#dup text #dup'), ['dup']), 'de-duplicates');
check(eq(extractTags('#Prüfung #größe'), ['Prüfung', 'größe']), 'accepts non-ASCII letters');
check(eq(extractTags('#a/b #c-d #e_f'), ['a/b', 'c-d', 'e_f']), 'accepts / - _ inside a tag');
check(eq(extractTags('nope#notatag'), []), 'ignores # in the middle of a word');
check(eq(extractTags('#1'), []), 'ignores a one-character tag');
check(eq(extractTags('#12 ok'), ['12']), 'accepts a numeric tag of two characters');
check(eq(extractTags(''), []), 'empty text yields no tags');
check(eq(extractTags('line\n#tag'), ['tag']), 'a newline counts as whitespace');

console.log('\ncollectText\n');
const snOf = (...pages) => ({ pages });
check(collectText(snOf({ text: '' }, { text: '   ' })) === null,
  'all-blank pages yield null');
check(eq(collectText(snOf({ text: 'a' }, { text: '' })), ['a', '']),
  'keeps blank pages in place so page numbers stay right');
check(eq(collectText(snOf({ paragraphs: ['p1', 'p2'] })), ['p1\n\np2']),
  'joins paragraphs with a blank line');
check(eq(collectText(snOf({ paragraphs: [], text: 'fallback' })), ['fallback']),
  'falls back to text when paragraphs is empty');
check(eq(collectText(snOf({})), null),
  'a page with neither paragraphs nor text is blank');

console.log('\nindexPathFor\n');
check(indexPathFor('a/b.note', 'Idx') === 'Idx/a/b.md', 'mirrors the source path');
check(indexPathFor('a/b.pdf.mark', 'Idx') === 'Idx/a/b.md', 'strips .pdf.mark');
check(indexPathFor('a/b.note', '') === `${DEFAULT_FOLDER}/a/b.md`, 'empty folder falls back to the default');
check(indexPathFor('a/b.note', '/Idx/') === 'Idx/a/b.md', 'trims surrounding slashes');
check(indexPathFor('b.NOTE', 'Idx') === 'Idx/b.md', 'extension match is case-insensitive');

console.log('\nextraFrontmatterLines\n');
check(eq(extraFrontmatterLines('a: 1\n\n b: 2 '), ['a: 1', 'b: 2']), 'trims and drops blank lines');
check(eq(extraFrontmatterLines(''), []), 'empty string yields nothing');
check(eq(extraFrontmatterLines(undefined), []), 'undefined yields nothing');

console.log('\nbuildSidecar\n');
const sn = snOf({ text: 'page one #uml' }, { text: '' }, { text: 'page three' });
const pages = collectText(sn);
const md = buildSidecar(sn, 'Course/UML.note', 'Course/UML.pdf', pages, {});

check(md.startsWith('---\ntype: supernote-index\n'), 'opens with frontmatter');
check(md.includes('source: "Course/UML.note"'), 'records the source path');
check(md.includes('artifact: "Course/UML.pdf"'), 'records the artefact path');
check(md.includes('pages: 3'), 'records the page count');
check(md.includes('  - supernote'), 'always carries the supernote tag');
check(md.includes('  - uml'), 'carries a tag found in the handwriting');
check(md.includes('## Page 1'), 'writes a section for page 1');
check(!md.includes('## Page 2'), 'skips the blank page');
check(md.includes('## Page 3'), 'numbers later pages by position, not by order written');
check(md.includes('[[Course/UML.pdf|Open the PDF]]'), 'links to the artefact');

// The invariant that matters most: an empty checkbox here would be counted as a
// real open task by every task plugin there is.
check(!md.includes('- [ ]'), 'never emits a task checkbox');

const noArtefact = buildSidecar(sn, 'Course/UML.note', null, pages, {});
check(!noArtefact.includes('artifact:'), 'omits the artefact key when there is none');
check(!noArtefact.includes('|Open the PDF]]'), 'omits the link when there is no artefact');

const extra = buildSidecar(sn, 'a.note', null, pages, { extraFrontmatter: 'category: lectures\narea: x' });
check(extra.includes('category: lectures'), 'adds configured extra frontmatter');
check(extra.includes('area: x'), 'adds every configured line');
check(extra.indexOf('category: lectures') < extra.indexOf('source:'),
  'extra frontmatter stays inside the frontmatter block');
check(!buildSidecar(sn, 'a.note', null, pages, {}).includes('category:'),
  'adds nothing when extra frontmatter is unset');

done();
