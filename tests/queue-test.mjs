#!/usr/bin/env node
/*
 * Tests the work queue against a fake plugin.
 *
 *   npm run build && node tests/queue-test.mjs
 *
 * The queue decides what gets decoded and when, which is the whole of the
 * plugin's performance behaviour. Four things matter:
 *
 *   - a scan must NOT decode. If `generate` leaks into ordinary passes, every
 *     launch converts the whole vault again and the deferral is undone;
 *   - the file you just opened jumps ahead of a scan of the vault, or you wait
 *     behind every other file before seeing your own;
 *   - a caller can await one specific path, which is what lets the loading
 *     badge know when to disappear;
 *   - work is still strictly serialised — that is the ~20 MB/page memory
 *     budget, and a priority path must not be allowed to break it.
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

globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
};

class TFile {}
class TFolder {}
const obsidianStub = {
  Plugin: class { constructor(app) { this.app = app; } },
  PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; } },
  Setting: class {},
  Notice: class {},
  TFile,
  TFolder,
  Vault: class {},
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

/** A plugin whose `process` just records what it was asked to do. */
function setup({ fail = null, delay = 0 } = {}) {
  const seen = [];
  const p = new PluginClass({ vault: {}, workspace: {} });
  p.settings = {};
  p.queue = [];
  p.running = false;
  p.timers = new Map();
  p.jobs = new Map();
  p.onDemand = new Set();
  p.current = null;
  p.status = null;
  p.setStatus = () => {};

  p.process = async (path) => {
    // Recorded at the moment of processing, so it reflects the real order and
    // the real generate flag rather than what was true at enqueue time.
    seen.push({ path, generate: p.onDemand.has(path), running: p.running });
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (fail === path) throw new Error(`boom: ${path}`);
  };

  return { plugin: p, seen };
}

/**
 * Wait for the queue to go idle.
 *
 * Deliberately not a fixed sleep: guessing a duration makes the test fail as a
 * liar the moment the work takes a millisecond longer than guessed, and the
 * first draft of this file did exactly that.
 */
async function settle(plugin, limit = 2000) {
  const until = Date.now() + limit;
  while ((plugin.running || plugin.queue.length) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2));
  }
  await new Promise((r) => setTimeout(r, 2));
}

console.log('\na scan does not decode\n');

{
  const { plugin, seen } = setup();
  plugin.enqueue('a.note');
  plugin.enqueue('b.mark');
  await settle(plugin);
  check(seen.length === 2, 'both were processed');
  check(seen.every((s) => s.generate === false),
    'neither was allowed to generate', JSON.stringify(seen));
}

{
  const { plugin, seen } = setup();
  plugin.enqueue('a.note', { generate: true });
  await settle(plugin);
  check(seen[0].generate === true, 'an explicit request may generate');
  check(plugin.onDemand.size === 0, 'and the flag is cleared afterwards');
}

console.log('\nthe file you opened jumps the queue\n');

{
  // Hold the queue with a slow first job so the rest really do queue up behind
  // it, which is the situation a priority insert exists for.
  const { plugin, seen } = setup({ delay: 10 });
  plugin.enqueue('first.note');
  plugin.enqueue('second.note');
  plugin.enqueue('third.note');
  plugin.enqueue('urgent.note', { front: true, generate: true });
  await settle(plugin);

  const order = seen.map((s) => s.path);
  check(order[0] === 'first.note', 'the job already running is never interrupted', order.join(' → '));
  check(order[1] === 'urgent.note', 'but the urgent one is next', order.join(' → '));
  check(order.length === 4, 'and nothing was dropped', order.join(' → '));
}

{
  // Already queued, then opened: it must move, not be added a second time.
  const { plugin, seen } = setup({ delay: 10 });
  plugin.enqueue('first.note');
  plugin.enqueue('later.note');
  plugin.enqueue('later.note', { front: true, generate: true });
  await settle(plugin);
  const order = seen.map((s) => s.path);
  check(order.length === 2, 'a re-prioritised path is not run twice', order.join(' → '));
  check(order[1] === 'later.note', 'it moved to the front', order.join(' → '));
  check(seen[1].generate === true, 'and it carries the generate flag');
}

{
  const { plugin, seen } = setup();
  plugin.enqueue('same.note');
  plugin.enqueue('same.note');
  await settle(plugin);
  check(seen.length === 1, 'a plain duplicate is ignored');
}

console.log('\nawaiting one specific file\n');

{
  const { plugin } = setup({ delay: 5 });
  let resolved = false;
  const done = plugin.enqueue('a.note', { generate: true }).then(() => { resolved = true; });
  check(resolved === false, 'the promise is still pending while it works');
  await done;
  check(resolved === true, 'and resolves once that path is processed');
}

{
  const { plugin } = setup({ fail: 'bad.note' });
  let message = null;
  await plugin.enqueue('bad.note', { generate: true }).catch((e) => { message = e.message; });
  check(message === 'boom: bad.note', 'a failure reaches the caller', String(message));
}

{
  // The badge must come down even when the conversion failed, so the rejection
  // has to arrive rather than hang.
  const { plugin } = setup({ fail: 'bad.note' });
  const settled = await Promise.race([
    plugin.enqueue('bad.note', { generate: true }).then(() => 'ok', () => 'rejected'),
    new Promise((r) => setTimeout(() => r('hung'), 200)),
  ]);
  check(settled === 'rejected', 'and never hangs', settled);
}

{
  const { plugin } = setup({ delay: 5 });
  const a = plugin.enqueue('shared.note');
  const b = plugin.enqueue('shared.note');
  check(a === b, 'two callers waiting on one path get the same promise');
  await a;
}

console.log('\nwork stays serialised\n');

{
  // If two jobs ever overlap, the ~20 MB/page decode budget is gone.
  const { plugin, seen } = setup({ delay: 5 });
  for (const p of ['a.note', 'b.note', 'c.note', 'd.note']) plugin.enqueue(p);
  await settle(plugin);
  check(seen.length === 4, 'all four ran', String(seen.length));
  check(plugin.running === false, 'and the queue is idle afterwards');
  check(plugin.queue.length === 0, 'with nothing left in it');
  check(plugin.jobs.size === 0, 'and no promises left dangling');
}

done();
