#!/usr/bin/env node
/*
 * Runs every test in order, stopping at the first failure.
 *
 *   npm test
 *   SUPERNOTE_SAMPLES=~/Notes npm test
 *
 * Without SUPERNOTE_SAMPLES only the unit tests run; the three that need real
 * Supernote files skip themselves rather than fail.
 */

import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const suites = [
  'sidecar-test.mjs',
  'bundle-test.mjs',
  'pdf-test.mjs',
  'decoder-test.mjs',
];

for (const suite of suites) {
  console.log(`\n${'='.repeat(60)}\n${suite}\n${'='.repeat(60)}`);
  const r = spawnSync(process.execPath, [path.join(HERE, suite)], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n✗ ${suite} failed\n`);
    process.exit(r.status || 1);
  }
}

console.log('\n✓ all suites passed\n');
