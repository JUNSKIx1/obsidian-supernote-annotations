#!/usr/bin/env node
/*
 * Tests writeTextIfChanged against a fake vault.
 *
 *   npm run build && node tests/write-test.mjs
 *
 * This is the function that decides whether a sidecar gets rewritten. Two
 * behaviours matter and neither is visible from the sidecar builder alone:
 * an unchanged sidecar must not be touched (no spurious modify events, no
 * churn in a synced vault), and a changed one must be rewritten even though
 * the source .note has not moved — which is what makes editing the sidecar
 * folder or the extra frontmatter take effect.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { reporter } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'main.js');

const { check, done } = reporter();

if (!fs.existsSync(MAIN)) {
  console.error('\n✗ main.js is missing. Run `npm run build` first.\n');
  process.exit(1);
}

class TFile {}
class TFolder {}
const obsidianStub = {
  Plugin: class { constructor(app) { this.app = app; } },
  PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; } },
  Setting: class {},
  Notice: class {},
  TFile,
  TFolder,
  normalizePath: (p) => String(p).replace(/\/+/g, '/'),
};

const bundle = fs.readFileSync(MAIN, 'utf8');
const loaded = (() => {
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', 'require', bundle)(mod.exports, mod, (id) => {
    if (id === 'obsidian') return obsidianStub;
    throw new Error(`unexpected require('${id}')`);
  });
  return mod.exports;
})();
const PluginClass = loaded.default || loaded;

/** A vault that records what actually happened to it. */
function fakeVault(initial = {}) {
  const files = new Map();
  const folders = new Set();
  const log = [];

  for (const [p, content] of Object.entries(initial)) {
    const f = new TFile();
    f.path = p;
    files.set(p, { file: f, content });
  }

  return {
    log,
    files,
    folders,
    getAbstractFileByPath(p) {
      if (files.has(p)) return files.get(p).file;
      if (folders.has(p)) {
        const d = new TFolder();
        d.path = p;
        return d;
      }
      return null;
    },
    async read(file) {
      return files.get(file.path).content;
    },
    async process(file, fn) {
      const entry = files.get(file.path);
      entry.content = fn(entry.content);
      log.push(`process:${file.path}`);
    },
    async create(p, content) {
      const f = new TFile();
      f.path = p;
      files.set(p, { file: f, content });
      log.push(`create:${p}`);
    },
    async createFolder(p) {
      folders.add(p);
      log.push(`createFolder:${p}`);
    },
  };
}

const plugin = (vault) => {
  const p = new PluginClass({ vault });
  p.settings = {};
  return p;
};

console.log('\nwriteTextIfChanged\n');

// 1. A file that does not exist yet is created, with its folder.
{
  const vault = fakeVault();
  const p = plugin(vault);
  const wrote = await p.writeTextIfChanged('Index/Course/Note.md', 'hello');
  check(wrote === true, 'reports that it wrote');
  check(vault.log.includes('createFolder:Index/Course'), 'creates the missing folder');
  check(vault.log.includes('create:Index/Course/Note.md'), 'creates the file');
  check(vault.files.get('Index/Course/Note.md').content === 'hello', 'writes the content');
}

// 2. Identical content is left completely alone. This is what stops a rescan
//    churning every sidecar and, in a synced vault, re-uploading them.
{
  const vault = fakeVault({ 'Index/Note.md': 'same' });
  const p = plugin(vault);
  const wrote = await p.writeTextIfChanged('Index/Note.md', 'same');
  check(wrote === false, 'reports that it wrote nothing');
  check(vault.log.length === 0, 'touches the vault not at all', vault.log.join(', '));
}

// 3. Changed content is rewritten even though nothing about the source moved.
//    This is the actual fix: settings changes now take effect.
{
  const vault = fakeVault({ 'Index/Note.md': 'old body' });
  const p = plugin(vault);
  const wrote = await p.writeTextIfChanged('Index/Note.md', 'new body');
  check(wrote === true, 'rewrites when the content differs');
  check(vault.log.includes('process:Index/Note.md'), 'uses Vault.process, not modify');
  check(vault.files.get('Index/Note.md').content === 'new body', 'the new content lands');
  check(!vault.log.some((l) => l.startsWith('create:')), 'does not re-create an existing file');
}

// 4. A one-character difference still counts — e.g. one added frontmatter line.
{
  const vault = fakeVault({ 'Index/Note.md': '---\ntype: supernote-index\n---\n' });
  const p = plugin(vault);
  const wrote = await p.writeTextIfChanged(
    'Index/Note.md', '---\ntype: supernote-index\nos: studium\n---\n');
  check(wrote === true, 'notices an added frontmatter line');
}

// 5. Paths are normalised before anything is looked up or written.
{
  const vault = fakeVault({ 'Index/Note.md': 'same' });
  const p = plugin(vault);
  const wrote = await p.writeTextIfChanged('Index//Note.md', 'same');
  check(wrote === false, 'normalises the path before comparing', vault.log.join(', '));
}

// 6. A file at the vault root needs no folder created.
{
  const vault = fakeVault();
  const p = plugin(vault);
  await p.writeTextIfChanged('Note.md', 'body');
  check(!vault.log.some((l) => l.startsWith('createFolder:')), 'no folder for a root-level file');
  check(vault.files.has('Note.md'), 'still creates the file');
}

done();
