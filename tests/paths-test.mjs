#!/usr/bin/env node
/*
 * Unit tests for the file group.
 *
 *   node tests/paths-test.mjs
 *
 * This is what decides which files follow a move, so a wrong answer here either
 * drags an innocent file across the vault or leaves a group split in half. Pure
 * string surgery, no samples needed.
 *
 * Real vault paths carry emoji, ampersands, spaces and umlauts, and the
 * annotated suffix is free text a user typed — several of these cases exist
 * only because that text lands in a regex if you are careless.
 */

import { stemOf, groupPaths } from '../src/paths.js';
import { reporter } from './helpers.mjs';

const { check, done } = reporter();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const S = { sidecarFolder: '_System/Index', annotatedSuffix: ' (annotated)' };
const DIR = '🎓 Studium/4. Semester/Softwaremodeling & Architecture';

console.log('\nstemOf — the five roles\n');

check(stemOf(`${DIR}/UML.note`, S) === `${DIR}/UML`, 'the notebook');
check(stemOf(`${DIR}/UML.pdf`, S) === `${DIR}/UML`, 'the PDF');
check(stemOf(`${DIR}/UML.pdf.mark`, S) === `${DIR}/UML`, 'the ink layer');
check(stemOf(`${DIR}/UML (annotated).pdf`, S) === `${DIR}/UML`, 'the annotated copy');
check(stemOf(`_System/Index/${DIR}/UML.md`, S) === `${DIR}/UML`, 'the markdown sidecar');

console.log('\nstemOf — order of the strips\n');

// .pdf.mark must lose both extensions, not just the last one. Getting this
// wrong pairs a .mark with a group whose stem still ends in ".pdf".
check(stemOf('a/b.pdf.mark', S) === 'a/b', 'strips .pdf.mark whole, not just .mark');

// The suffix sits between the name and the extension, so it can only come off
// after .pdf has.
check(stemOf('a/Report (annotated).pdf', S) === 'a/Report', 'suffix comes off after the extension');
check(stemOf('a/Report (annotated).note', S) === 'a/Report (annotated)',
  'the suffix is a PDF thing only — a .note keeps it');

console.log('\nstemOf — what is not ours\n');

check(stemOf('a/notes.md', S) === null, 'a markdown file outside the sidecar folder');
check(stemOf('a/photo.png', S) === null, 'an unrelated extension');
check(stemOf('', S) === null, 'the empty path');
check(stemOf(null, S) === null, 'no path at all');
// Not a sidecar: the folder name is a prefix of the path but not a path segment.
check(stemOf('_System/IndexOther/UML.md', S) === null, 'a folder merely starting the same way');

console.log('\nstemOf — settings are free text\n');

// " (annotated)" is four regex metacharacters. endsWith, never a regex.
check(stemOf('a/b (annotated).pdf', { ...S, annotatedSuffix: ' (annotated)' }) === 'a/b',
  'parentheses in the suffix are literal');
check(stemOf('a/b.ink.pdf', { ...S, annotatedSuffix: '.ink' }) === 'a/b',
  'a dot in the suffix is literal too');
check(stemOf('a/b+x.pdf', { ...S, annotatedSuffix: '+x' }) === 'a/b',
  'and a plus');
check(stemOf('Supernote Index/a/b.md', { annotatedSuffix: ' (annotated)' }) === 'a/b',
  'falls back to the default sidecar folder');
check(stemOf('_System/Index/a/b.md', { ...S, sidecarFolder: '/_System/Index/' }) === 'a/b',
  'tolerates slashes around the configured folder');

console.log('\nstemOf — case\n');

// Obsidian will hand us whatever the filesystem has.
check(stemOf('a/b.NOTE', S) === 'a/b', 'uppercase .NOTE');
check(stemOf('a/b.PDF.Mark', S) === 'a/b', 'mixed-case .PDF.Mark');

console.log('\ngroupPaths\n');

check(eq(groupPaths('a/UML', S), [
  'a/UML.note',
  'a/UML.pdf',
  'a/UML.pdf.mark',
  'a/UML (annotated).pdf',
  '_System/Index/a/UML.md',
]), 'the five paths, in order');

console.log('\nround trip — every member recovers the same stem\n');

for (const p of groupPaths(`${DIR}/UML`, S)) {
  check(stemOf(p, S) === `${DIR}/UML`, `${p.split('/').pop()} → the stem it came from`);
}

// The point of the whole module: zip the old group against the new one and you
// have the moves, with no index and nothing stored between sessions.
{
  const from = groupPaths('Old/UML', S);
  const to = groupPaths('New/UML', S);
  check(from.length === to.length, 'old and new groups zip one to one');
  check(to[4] === '_System/Index/New/UML.md', 'the sidecar mirror follows the source path');
  check(from.every((p, i) => stemOf(p, S) === 'Old/UML' && stemOf(to[i], S) === 'New/UML'),
    'every pair differs only by the stem');
}

done();
