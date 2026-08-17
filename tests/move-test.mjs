#!/usr/bin/env node
/*
 * Tests the rename handler against a fake vault.
 *
 *   npm run build && node tests/move-test.mjs
 *
 * paths-test.mjs proves the group is computed correctly; this proves the plugin
 * acts on it correctly, which is a different thing. Three behaviours matter and
 * none is visible from stemOf alone:
 *
 *   - one drag moves the rest of the group and nothing else;
 *   - the echo does not recurse — every renameFile fires the same rename event
 *     we are inside, so a missing guard turns one drag into an avalanche;
 *   - an occupied target is never overwritten. These are somebody's notes.
 *
 * The fake fileManager below re-enters onRename after each move, exactly as
 * Obsidian does, so the guard is actually under test rather than assumed.
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

// schedule() reaches for window.setTimeout, which Node has no opinion about.
globalThis.window = { setTimeout: () => 0, clearTimeout: () => {} };

class TFile {}
class TFolder {}
const obsidianStub = {
  Plugin: class { constructor(app) { this.app = app; } },
  PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; } },
  Setting: class {},
  Notice: class { constructor(msg) { notices.push(msg); } },
  TFile,
  TFolder,
  normalizePath: (p) => String(p).replace(/\/+/g, '/'),
};

let notices = [];

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

const SETTINGS = { sidecarFolder: '_System/Index', annotatedSuffix: ' (annotated)' };

/**
 * A vault holding `paths`, whose fileManager echoes each rename back into the
 * plugin the way Obsidian's does.
 */
function setup(paths, settings = SETTINGS) {
  const files = new Map();
  const folders = new Set();
  const renames = [];
  notices = [];

  for (const p of paths) {
    const f = new TFile();
    f.path = p;
    f.extension = p.split('.').pop();
    f.name = p.split('/').pop();
    f.basename = f.name.slice(0, -(f.extension.length + 1));
    files.set(p, f);
    // Every ancestor directory exists, as it must for the file to.
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }

  const app = {
    vault: {
      getAbstractFileByPath(p) {
        if (files.has(p)) return files.get(p);
        if (folders.has(p)) {
          const d = new TFolder();
          d.path = p;
          return d;
        }
        return null;
      },
      async createFolder(p) { folders.add(p); },
    },
    fileManager: {
      async renameFile(file, to) {
        const from = file.path;
        if (file instanceof TFolder) {
          // Renaming a folder carries everything under it, as Obsidian's does.
          for (const [p, f] of [...files]) {
            if (!p.startsWith(`${from}/`)) continue;
            files.delete(p);
            f.path = `${to}${p.slice(from.length)}`;
            files.set(f.path, f);
          }
          folders.delete(from);
          folders.add(to);
        } else {
          files.delete(from);
          file.extension = to.split('.').pop();
          files.set(to, file);
        }
        file.path = to;
        renames.push(`${from} → ${to}`);
        await plugin.onRename(file, from);      // the echo Obsidian would fire
      },
    },
    metadataCache: { resolvedLinks: {} },
    workspace: { getLeavesOfType: () => [] },
  };

  const plugin = new PluginClass(app);
  plugin.settings = settings;
  plugin.moving = new Set();
  plugin.overlays = new Map();
  plugin.timers = new Map();
  plugin.queue = [];
  plugin.running = true;                        // never actually drain in a test

  /** Pretend the user dragged `from` to `to`. */
  const drag = async (from, to) => {
    const f = app.vault.getAbstractFileByPath(from);
    files.delete(from);
    f.path = to;
    files.set(to, f);
    const parts = to.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    await plugin.onRename(f, from);
  };

  return { plugin, drag, renames, files, folders, app };
}

const FULL = [
  'A/UML.note',
  'A/UML.pdf',
  'A/UML.pdf.mark',
  'A/UML (annotated).pdf',
  '_System/Index/A/UML.md',
];

console.log('\nthe group follows one drag\n');

{
  const { drag, renames, files } = setup(FULL);
  await drag('A/UML.pdf', 'B/UML.pdf');

  check(renames.length === 4, 'moves exactly the four companions', renames.join(' | '));
  check(files.has('B/UML.note'), 'the notebook followed');
  check(files.has('B/UML.pdf.mark'), 'the ink layer followed');
  check(files.has('B/UML (annotated).pdf'), 'the annotated copy followed');
  check(files.has('_System/Index/B/UML.md'), 'the sidecar followed into the mirrored path');
  check(![...files.keys()].some((p) => p.startsWith('A/')), 'nothing is left behind in A');
}

console.log('\nthe echo does not recurse\n');

{
  // Each renameFile re-enters onRename. Without the guard the second file's
  // event would rebuild the group and move everything again, and again.
  const { drag, renames } = setup(FULL);
  await drag('A/UML.pdf', 'B/UML.pdf');
  check(renames.length === 4, 'four moves, not sixteen', `${renames.length} renames`);
  check(new Set(renames).size === renames.length, 'no path is moved twice');
}

console.log('\nrenames, not just folder moves\n');

{
  // The case that is silently unrecoverable today: rename the PDF without its
  // .mark and the pairing in process() can never be made again.
  const { drag, renames, files } = setup(FULL);
  await drag('A/UML.pdf', 'A/UML v2.pdf');
  check(files.has('A/UML v2.pdf.mark'), 'the ink layer is renamed with the PDF');
  check(files.has('A/UML v2.note'), 'so is the notebook');
  check(files.has('A/UML v2 (annotated).pdf'), 'and the annotated copy keeps its suffix');
  check(files.has('_System/Index/A/UML v2.md'), 'and the sidecar');
  check(renames.length === 4, 'still four moves', renames.join(' | '));
}

console.log('\nthe sidecar leads as well as follows\n');

{
  const { drag, files } = setup(FULL);
  await drag('_System/Index/A/UML.md', '_System/Index/B/UML.md');
  check(files.has('B/UML.note'), 'dragging the sidecar moved the notebook');
  check(files.has('B/UML.pdf'), 'and the PDF');
  check(files.has('B/UML.pdf.mark'), 'and the ink layer');
}

console.log('\nnothing is overwritten\n');

{
  const { drag, renames, files } = setup([...FULL, 'B/UML.note']);
  await drag('A/UML.pdf', 'B/UML.pdf');
  check(files.get('B/UML.note') !== undefined, 'the occupant is still there');
  check(files.has('A/UML.note'), 'and the companion stayed put rather than clobbering it');
  check(!renames.some((r) => r.startsWith('A/UML.note')), 'no rename was attempted');
  check(notices.some((n) => /already exists/.test(n)), 'and the user is told', notices.join(' | '));
  check(renames.length === 3, 'the other three still moved', renames.join(' | '));
}

console.log('\nfiles that are none of our business\n');

{
  const { drag, renames } = setup([...FULL, 'A/Report.pdf']);
  await drag('A/Report.pdf', 'B/Report.pdf');
  check(renames.length === 0, 'an unrelated PDF drags nothing along', renames.join(' | '));
}

{
  const { plugin, renames } = setup(FULL);
  const f = plugin.app.vault.getAbstractFileByPath('A/UML.pdf');
  await plugin.onRename(f, 'A/UML.pdf');
  check(renames.length === 0, 'a rename that changes nothing does nothing');
}

console.log('\na partial group\n');

{
  // The common shape: an original PDF and its ink, no notebook, sidecars off.
  const { drag, renames, files } = setup(['A/Paper.pdf', 'A/Paper.pdf.mark']);
  await drag('A/Paper.pdf', 'B/Paper.pdf');
  check(renames.length === 1, 'only the file that exists is moved', renames.join(' | '));
  check(files.has('B/Paper.pdf.mark'), 'and it lands beside its PDF');
}

console.log('\nthe ink survives the move\n');

{
  // The stamped copy is keyed by the .mark's content, so a move changes only
  // which PDF it belongs to. If this dropped, the PDF would render plain until
  // the next scan got round to it.
  const { plugin, drag } = setup(FULL);
  plugin.overlays.set('A/UML.pdf', '.obsidian/plugins/x/annotated/deadbeef-99.pdf');
  await drag('A/UML.pdf', 'B/UML.pdf');
  check(plugin.overlays.get('B/UML.pdf') === '.obsidian/plugins/x/annotated/deadbeef-99.pdf',
    're-keyed to the new path, same cache entry');
  check(!plugin.overlays.has('A/UML.pdf'), 'and the old key is gone');
}

{
  // Taking the ink away has to leave the PDF plain, which is the whole reason
  // it is drawn at view time rather than written into the file.
  const { plugin, files } = setup(FULL);
  plugin.overlays.set('A/UML.pdf', '.obsidian/plugins/x/annotated/deadbeef-99.pdf');
  plugin.onDelete(files.get('A/UML.pdf.mark'));
  check(!plugin.overlays.has('A/UML.pdf'), 'deleting the .mark clears the overlay');
  check(notices.some((n) => /plain again/.test(n)), 'and says so', notices.join(' | '));
}

console.log('\nthe sidecar mirror when a folder moves\n');

{
  const { plugin, renames, files, app } = setup(FULL);
  const folder = app.vault.getAbstractFileByPath('A');
  folder.path = 'C';
  await plugin.onFolderRename('A', 'C');
  check(renames.length === 1, 'one move: the mirror branch', renames.join(' | '));
  check(files.has('_System/Index/C/UML.md'), 'the index branch followed the source folder');
}

{
  const { plugin, renames, files, app } = setup(FULL);
  const folder = app.vault.getAbstractFileByPath('_System/Index/A');
  folder.path = '_System/Index/C';
  await plugin.onFolderRename('_System/Index/A', '_System/Index/C');
  check(renames.length === 1, 'and the other way round', renames.join(' | '));
  check(files.has('C/UML.note'), 'the sources followed the index branch');
}

done();
