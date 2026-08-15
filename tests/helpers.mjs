/*
 * Shared bits for the test scripts.
 *
 * Tests that need real Supernote files read them from the directory named by
 * SUPERNOTE_SAMPLES. Nothing is committed to this repo: .note and .mark files
 * are somebody's handwriting, and a sample set that lives in git is a sample
 * set that leaks. Point the variable at any folder containing .note/.mark files
 * — a vault, a mounted device, a scratch directory:
 *
 *   SUPERNOTE_SAMPLES=~/Notes node tests/pdf-test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const SAMPLES = process.env.SUPERNOTE_SAMPLES || '';

export function requireSamples(what) {
  if (!SAMPLES) {
    console.log(`\n~ SUPERNOTE_SAMPLES is not set — skipping ${what}.`);
    console.log('  Set it to a folder containing .note/.mark files to run this test.\n');
    return false;
  }
  if (!fs.existsSync(SAMPLES)) {
    console.error(`\n✗ SUPERNOTE_SAMPLES points at ${SAMPLES}, which does not exist.\n`);
    process.exit(1);
  }
  return true;
}

/** Every .note/.mark under `dir`, skipping Obsidian's own folders. */
export function findSources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.obsidian' || e.name === '.trash' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findSources(p, out);
    else if (/\.(note|mark)$/.test(e.name)) out.push(p);
  }
  return out;
}

export function reporter() {
  const state = { pass: 0, fail: 0 };
  const check = (ok, msg, extra) => {
    if (ok) state.pass++; else state.fail++;
    console.log(`  ${ok ? '✓' : '✗'} ${msg}${!ok && extra ? ` — ${extra}` : ''}`);
  };
  const done = () => {
    console.log(`\n${state.pass} passed, ${state.fail} failed\n`);
    process.exit(state.fail ? 1 : 0);
  };
  return { check, done, state };
}
