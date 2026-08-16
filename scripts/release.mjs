#!/usr/bin/env node
/*
 * Cut a release.
 *
 *   npm run release 1.0.1
 *
 * Bumps manifest.json and versions.json, verifies the tree, runs lint and the
 * tests, then commits, tags and pushes. The tag push is what triggers
 * .github/workflows/release.yml, which builds the assets and leaves a DRAFT
 * release for you to add notes to and publish.
 *
 * Two rules this script exists to enforce, both of which will break a published
 * plugin if you get them wrong:
 *
 *   1. The tag must equal manifest.json's version EXACTLY, with no `v` prefix.
 *      GitHub's own release UI suggests `v1.0.1`; that advice does not apply
 *      here. Obsidian looks for a release tagged identically to the version
 *      string, and with a `v` it finds nothing.
 *   2. Obsidian accepts only x.y.z. No `-beta`, no `-rc.1`.
 *
 * And one rule it cannot enforce for you: publish the DRAFT the workflow
 * creates. Do not use "Draft a new release" in the GitHub UI — that makes a
 * second release on the same tag with no assets attached, which fails review
 * with "the release is missing the main.js file".
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'manifest.json');
const VERSIONS = path.join(ROOT, 'versions.json');

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

const version = process.argv[2];
if (!version) die('usage: npm run release <version>   e.g. npm run release 1.0.1');

// --- validate the version string ------------------------------------------

if (version.startsWith('v')) {
  die(`use "${version.slice(1)}", not "${version}".\n`
    + '  Obsidian requires the tag to equal manifest.json\'s version exactly.\n'
    + '  GitHub\'s "prefix with v" suggestion does not apply to Obsidian plugins.');
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  die(`"${version}" is not x.y.z. Obsidian accepts no pre-release suffixes.`);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const current = manifest.version;

const asNums = (v) => v.split('.').map(Number);
const isNewer = (a, b) => {
  const [x, y, z] = asNums(a);
  const [p, q, r] = asNums(b);
  return x > p || (x === p && (y > q || (y === q && z > r)));
};
if (!isNewer(version, current)) {
  die(`${version} is not newer than the current ${current}.`);
}

// --- validate the repository state ----------------------------------------

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') die(`on branch "${branch}" — release from main.`);

if (run('git', ['status', '--porcelain'])) {
  die('the working tree has uncommitted changes. Commit or stash them first.');
}

run('git', ['fetch', 'origin', 'main', '--tags']);
const local = run('git', ['rev-parse', 'main']);
const remote = run('git', ['rev-parse', 'origin/main']);
if (local !== remote) die('main and origin/main have diverged. Push or pull first.');

const tags = run('git', ['tag', '--list']).split('\n').filter(Boolean);
if (tags.includes(version)) {
  die(`tag ${version} already exists. Never move a published tag — pick the next version.`);
}

// --- verify before touching anything --------------------------------------

console.log(`\nreleasing ${current} → ${version}\n`);
console.log('running lint…');
run('npm', ['run', 'lint'], { stdio: 'inherit' });
console.log('running tests…');
run('npm', ['test'], { stdio: 'inherit' });

// --- bump ------------------------------------------------------------------

manifest.version = version;
fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

const versions = JSON.parse(fs.readFileSync(VERSIONS, 'utf8'));
versions[version] = manifest.minAppVersion;
fs.writeFileSync(VERSIONS, `${JSON.stringify(versions, null, 2)}\n`);

console.log(`\n  manifest.json  version → ${version}`);
console.log(`  versions.json  ${version} → minAppVersion ${manifest.minAppVersion}`);

// --- commit, tag, push -----------------------------------------------------

run('git', ['add', 'manifest.json', 'versions.json']);
run('git', ['commit', '-m', `Release ${version}`]);
run('git', ['tag', '-a', version, '-m', version]);
run('git', ['push', 'origin', 'main']);
run('git', ['push', 'origin', version]);

const repo = 'https://github.com/JUNSKIx1/obsidian-supernote-annotations';
console.log(`\n✓ pushed ${version}\n`);
console.log('The workflow is now building the release assets.');
console.log(`Open the DRAFT it creates, add notes, and press "Publish release":`);
console.log(`  ${repo}/releases\n`);
console.log('Do NOT use "Draft a new release" — that creates a second, empty');
console.log('release on the same tag and the review will reject it.\n');
