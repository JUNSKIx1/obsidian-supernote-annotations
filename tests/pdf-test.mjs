#!/usr/bin/env node
/*
 * End-to-end check of the Supernote → PDF pipeline, outside Obsidian.
 *
 *   SUPERNOTE_SAMPLES=~/Notes node tests/pdf-test.mjs [outdir]
 *
 * Produces the real artefacts (.note → PDF, .mark → annotated copy) into a temp
 * directory — never beside the sources — and asserts the invariants that matter:
 *   - marks with no ink produce nothing
 *   - marks with ink produce a PDF with the same page count as the original
 *   - every source .note/.mark and original PDF is byte-identical afterwards
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';

import * as PDFLib from 'pdf-lib';
import { SupernoteX } from 'supernote-typescript/lib/parsing.js';

import { noteToPdf, markToAnnotatedPdf } from '../src/pdfout.js';
import { SAMPLES, requireSamples, findSources, reporter } from './helpers.mjs';

if (!requireSamples('the PDF pipeline test')) process.exit(0);

const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const { check, done, state } = reporter();

const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'sn-pdf-'));
fs.mkdirSync(outDir, { recursive: true });
const files = findSources(SAMPLES).sort();

const before = new Map();
for (const f of files) before.set(f, md5(f));
const pdfBefore = new Map();

console.log(`\nwriting artefacts to ${outDir}\n`);

for (const file of files) {
  const name = path.basename(file);
  const isMark = file.endsWith('.mark');
  let sn;
  try {
    sn = new SupernoteX(new Uint8Array(fs.readFileSync(file)));
  } catch (e) {
    check(false, `${name}: parse failed`, e.message);
    continue;
  }

  console.log(name);
  if (isMark) {
    const src = file.slice(0, -5);
    if (!fs.existsSync(src)) { console.log('   ~ original PDF missing, skipped'); continue; }
    if (!pdfBefore.has(src)) pdfBefore.set(src, md5(src));
    const original = fs.readFileSync(src);
    const bytes = await markToAnnotatedPdf(sn, original, PDFLib, (m) => console.log(`   ! ${m}`));
    if (!bytes) {
      check(true, 'no ink → nothing produced (expected)');
      continue;
    }
    const dest = path.join(outDir, `${path.basename(src).replace(/\.pdf$/i, '')} (annotated).pdf`);
    fs.writeFileSync(dest, bytes);
    const outDoc = await PDFLib.PDFDocument.load(fs.readFileSync(dest), { ignoreEncryption: true });
    const inDoc = await PDFLib.PDFDocument.load(original, { ignoreEncryption: true });
    check(outDoc.getPageCount() === inDoc.getPageCount(),
      `${outDoc.getPageCount()} pages (original has ${inDoc.getPageCount()})`);
    console.log(`     → ${path.basename(dest)}  ${(bytes.length / 1024).toFixed(0)} KB`);
  } else {
    const bytes = await noteToPdf(sn, PDFLib);
    if (!bytes) { check(true, 'blank note → nothing produced (expected)'); continue; }
    const dest = path.join(outDir, name.replace(/\.note$/i, '.pdf'));
    fs.writeFileSync(dest, bytes);
    const doc = await PDFLib.PDFDocument.load(fs.readFileSync(dest));
    check(doc.getPageCount() === sn.pages.length,
      `${doc.getPageCount()} pages (the note has ${sn.pages.length})`);
    console.log(`     → ${path.basename(dest)}  ${(bytes.length / 1024).toFixed(0)} KB`);
  }
}

console.log('\nsource files untouched?');
let touched = 0;
for (const [f, h] of before) if (md5(f) !== h) { console.log(`   ✗ MODIFIED ${f}`); touched++; }
for (const [f, h] of pdfBefore) if (md5(f) !== h) { console.log(`   ✗ MODIFIED ${f}`); touched++; }
check(touched === 0, `${before.size} .note/.mark and ${pdfBefore.size} PDFs unchanged`);

console.log(`\noutput: ${outDir}`);
if (!state.fail) fs.rmSync(outDir, { recursive: true, force: true });
done();
