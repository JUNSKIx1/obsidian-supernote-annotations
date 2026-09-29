#!/usr/bin/env node
/*
 * Tests the placeholder stand-in and its marker.
 *
 *   node tests/placeholder-test.mjs
 *
 * A notebook's PDF exists from the moment the notebook does, but until someone
 * opens it the file is a one-page stand-in. Everything downstream turns on
 * telling the two apart, and both ways of being wrong are bad:
 *
 *   - a real conversion mistaken for a stand-in gets converted again on every
 *     single open, which is the cost this whole design exists to avoid;
 *   - a stand-in mistaken for a real conversion is never replaced, so the pages
 *     never appear and nothing says why.
 *
 * The marker lives inside the PDF rather than in a list beside it, so this also
 * pins the encoding: pdf-lib writes strings as UTF-16BE hex, and it compresses
 * the info dictionary unless told not to. Either would hide the marker.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as PDFLib from 'pdf-lib';

import { placeholderPdf, noteToPdf } from '../src/pdfout.js';
import { isPlaceholder, asPdfHex, PLACEHOLDER_MARK, PLACEHOLDER_MAX } from '../src/overlay.js';
import { SAMPLES, findSources, reporter } from './helpers.mjs';

const { check, done } = reporter();

const sn = (pages) => ({ pages: new Array(pages), pageWidth: 1404, pageHeight: 1872 });
const make = (name, pages = 3) => placeholderPdf(sn(pages), name, PDFLib, PLACEHOLDER_MARK);
const seen = (bytes) => isPlaceholder(bytes.length, async () => bytes);

console.log('\nthe stand-in\n');

const holder = await make('Lecture Notes');
check(holder.length > 0, 'is a PDF');
check(String.fromCharCode(...holder.slice(0, 5)) === '%PDF-', 'with a PDF header');
check(holder.length < PLACEHOLDER_MAX, `is under the size gate (${holder.length} B)`);
check(await seen(holder), 'and recognises itself');

{
  // The marker must survive pdf-lib's own choices about how to write strings.
  const text = Buffer.from(holder).toString('latin1');
  check(text.includes(PLACEHOLDER_MARK) || text.toUpperCase().includes(asPdfHex(PLACEHOLDER_MARK)),
    'the marker is findable without parsing the PDF');
  check(!text.includes('ObjStm'),
    'and is not buried in a compressed object stream');
}

console.log('\ntelling it from the real thing\n');

check(await isPlaceholder(0, async () => holder) === false, 'a zero-byte file is not one');
check(await isPlaceholder(900000, () => { throw new Error('read'); }) === false,
  'a large file is ruled out on size alone, without being read');

{
  // An ordinary small PDF that is nobody's stand-in.
  const doc = await PDFLib.PDFDocument.create();
  doc.addPage([300, 300]);
  const plain = await doc.save({ useObjectStreams: false });
  check(plain.length < PLACEHOLDER_MAX, 'a plain small PDF is inside the size gate');
  check(await seen(plain) === false, 'but is not mistaken for a stand-in');
}

console.log('\nawkward names\n');

{
  const long = 'A ludicrously long notebook name that would otherwise run clean off the page edge';
  const wide = await make(long);
  check(await seen(wide), 'a very long name still produces a valid stand-in');
  check(wide.length < PLACEHOLDER_MAX, 'and stays under the size gate');
}

{
  // Real vault paths carry these, and a crash here would block the whole scan.
  const odd = await make('🎓 Übungsklausur & Co. — Teil 2');
  check(await seen(odd), 'emoji, umlauts and an ampersand are fine');
}

check(await seen(await make('Empty', 0)), 'a notebook with no pages still gets one');
check(await seen(await make('One', 1)), 'and so does a single-page one');

console.log('\nagainst a real conversion\n');

if (!SAMPLES) {
  console.log('~ SUPERNOTE_SAMPLES is not set — skipping the real-conversion check.');
} else {
  const { SupernoteX } = await import('supernote-typescript/lib/parsing.js');
  const notes = findSources(SAMPLES).filter((p) => p.endsWith('.note')).slice(0, 4);
  let checked = 0;
  for (const p of notes) {
    const real = await noteToPdf(new SupernoteX(new Uint8Array(fs.readFileSync(p))), PDFLib);
    if (!real) continue;                       // every page blank
    checked++;
    check(await seen(real) === false,
      `a real conversion is not mistaken for a stand-in — ${path.basename(p)} (${real.length} B)`);
  }
  check(checked > 0, `checked ${checked} real conversion(s)`);
}

done();
