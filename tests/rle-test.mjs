#!/usr/bin/env node
/*
 * Unit test for the colour mapping in the RLE decoder.
 *
 *   node tests/rle-test.mjs
 *
 * A picture inserted on the device is stored as grey levels outside the ink
 * palette. Those must come out as opaque grey, not vanish. No samples needed.
 */

import { decodeLayer } from '../src/rle.js';
import { reporter } from './helpers.mjs';

const { check, done } = reporter();
const px = (out, i) => Array.from(out.subarray(i * 4, i * 4 + 4)).join(',');

console.log('\ndecodeLayer — colour codes\n');

// (colour, length-1) pairs: 2 px of picture grey 0xb5, 1 px background, 1 px black.
const out = decodeLayer(new Uint8Array([0xb5, 1, 0x62, 0, 0x61, 0]), 4, 1, false);
check(px(out, 0) === '181,181,181,255', 'an inserted picture pixel is opaque grey', px(out, 0));
check(px(out, 1) === '181,181,181,255', 'and its run length holds', px(out, 1));
check(px(out, 2) === '0,0,0,0', 'background stays transparent', px(out, 2));
check(px(out, 3) === '0,0,0,255', 'black ink is still black', px(out, 3));

done();
