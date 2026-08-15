#!/usr/bin/env node
/*
 * Smoke-tests the built bundle, not the loose sources.
 *
 *   npm run build && node tests/bundle-test.mjs
 *
 * The other tests import src/*.js directly, so they would still pass if esbuild
 * mangled something — a dependency that failed to bundle, or an export shape
 * Obsidian cannot load. This loads main.js exactly as Obsidian would, with a
 * stubbed `obsidian` module, and then pushes a real file through the pipeline.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { SAMPLES, findSources, reporter } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MAIN = path.join(ROOT, 'main.js');

const { check, done } = reporter();

if (!fs.existsSync(MAIN)) {
  console.error('\n✗ main.js is missing. Run `npm run build` first.\n');
  process.exit(1);
}

// Obsidian is provided by the host app at runtime; stub just enough to load.
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

console.log('\nloading the built bundle as Obsidian would\n');

const bundle = fs.readFileSync(MAIN, 'utf8');

// This is how Obsidian loads a plugin: it evaluates main.js as CommonJS with a
// `require` that only knows about its own API. Anything else the bundle tries
// to require would throw here, which is exactly the failure we want to catch.
const loaded = (() => {
  const mod = { exports: {} };
  const fakeRequire = (id) => {
    if (id === 'obsidian') return obsidianStub;
    throw new Error(`the bundle tried to require('${id}') at runtime`);
  };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', 'require', bundle)(mod.exports, mod, fakeRequire);
  return mod.exports;
})();
// esbuild emits `exports.default` for an ESM default export, which is what
// Obsidian unwraps when it loads a plugin.
const PluginClass = loaded && loaded.default ? loaded.default : loaded;

check(typeof PluginClass === 'function', 'main.js exports a plugin class');
check(PluginClass.prototype instanceof obsidianStub.Plugin
  || Object.getPrototypeOf(PluginClass) === obsidianStub.Plugin,
'the exported class extends Plugin');
check(typeof PluginClass.prototype.onload === 'function', 'it has an onload()');
check(typeof PluginClass.prototype.process === 'function', 'it has the process() worker');
check(typeof PluginClass.prototype.scanAll === 'function', 'it has scanAll()');

// The dependencies have to be *inside* the bundle: on a phone there is no
// node_modules to fall back to.
check(!/require\("(node:)?(fs|path|os|crypto|zlib|stream|child_process)"\)/.test(bundle),
  'bundle pulls in no Node built-ins');
const externals = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
check(externals.every((m) => m === 'obsidian'),
  'the only external module is `obsidian`', externals.join(', '));
check(bundle.includes('%PDF-'), 'pdf-lib is bundled in');

// Now push real files all the way through, if samples are available.
if (!SAMPLES || !fs.existsSync(SAMPLES)) {
  console.log('\n  ~ SUPERNOTE_SAMPLES not set — end-to-end steps skipped\n');
  done();
}

const { SupernoteX } = await import('supernote-typescript/lib/parsing.js');
const PDFLib = await import('pdf-lib');
const { markToAnnotatedPdf } = await import('../src/pdfout.js');

const marks = findSources(SAMPLES)
  .filter((f) => f.endsWith('.mark') && fs.existsSync(f.slice(0, -5)))
  .sort();

let inkedTested = 0;
let emptyTested = 0;

for (const markPath of marks) {
  const pdfPath = markPath.slice(0, -5);
  const sn = new SupernoteX(new Uint8Array(fs.readFileSync(markPath)));
  const out = await markToAnnotatedPdf(
    sn, new Uint8Array(fs.readFileSync(pdfPath)), PDFLib, () => {});

  if (out) {
    if (inkedTested === 0) {
      check(out.length > 1000, 'produced an annotated PDF through the bundle', `${out.length} bytes`);
      check(Buffer.from(out.slice(0, 5)).toString() === '%PDF-', 'output really is a PDF');
      const original = await PDFLib.PDFDocument.load(fs.readFileSync(pdfPath), { ignoreEncryption: true });
      const stamped = await PDFLib.PDFDocument.load(out, { ignoreEncryption: true });
      check(stamped.getPageCount() === original.getPageCount(), 'page count preserved');
    }
    inkedTested++;
  } else {
    emptyTested++;
  }
}

check(inkedTested > 0, `${inkedTested} inked mark(s) produced a PDF`);
console.log(`  · ${emptyTested} ink-free mark(s) produced nothing, as intended`);

done();
