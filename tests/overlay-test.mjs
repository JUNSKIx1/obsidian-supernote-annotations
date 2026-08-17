#!/usr/bin/env node
/*
 * Unit tests for the cache key.
 *
 *   node tests/overlay-test.mjs
 *
 * The key is what decides whether a stamped PDF gets reused or rebuilt, and it
 * is deliberately content-derived so that moving a file does not invalidate it.
 * Both halves of that matter: same content must give the same key wherever the
 * files live, and either input changing must give a different one.
 */

import { hashBytes, cacheKey, cacheDir } from '../src/overlay.js';
import { reporter } from './helpers.mjs';

const { check, done } = reporter();

const bytes = (...n) => new Uint8Array(n);

console.log('\nhashBytes\n');

check(hashBytes(bytes(1, 2, 3)) === hashBytes(bytes(1, 2, 3)), 'is stable for the same bytes');
check(hashBytes(bytes(1, 2, 3)) !== hashBytes(bytes(1, 2, 4)), 'differs on a changed byte');
check(hashBytes(bytes(1, 2)) !== hashBytes(bytes(2, 1)), 'differs on reordered bytes');
check(hashBytes(bytes(1, 2, 3)).length === 8, 'is a fixed-width hex string');
check(/^[0-9a-f]{8}$/.test(hashBytes(bytes(0))), 'and nothing but hex');
check(/^[0-9a-f]{8}$/.test(hashBytes(bytes())), 'the empty case still produces one');

console.log('\ncacheKey\n');

// The point of the whole scheme: the key says nothing about where the files
// are, so a move or a rename leaves the cached PDF perfectly valid.
check(cacheKey(bytes(1, 2, 3), 4096) === cacheKey(bytes(1, 2, 3), 4096),
  'the same ink on the same PDF reuses the entry');
check(cacheKey(bytes(1, 2, 3), 4096) !== cacheKey(bytes(1, 2, 9), 4096),
  'new ink rebuilds');
check(cacheKey(bytes(1, 2, 3), 4096) !== cacheKey(bytes(1, 2, 3), 5000),
  'a different PDF underneath rebuilds');
check(/^[0-9a-f]{8}-\d+$/.test(cacheKey(bytes(1), 12)), 'is safe as a filename');

console.log('\ncacheDir\n');

check(cacheDir('.obsidian', 'supernote-annotations')
  === '.obsidian/plugins/supernote-annotations/annotated', 'sits inside the plugin folder');
// Vaults can and do rename their config folder.
check(cacheDir('.config-obsidian', 'x') === '.config-obsidian/plugins/x/annotated',
  'follows a renamed config folder');
check(!cacheDir('.obsidian', 'x').startsWith('/'), 'stays vault-relative');

done();
