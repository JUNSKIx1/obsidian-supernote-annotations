#!/usr/bin/env node
/*
 * Unit tests for stamping ink onto a page with /Rotate.
 *
 *   node tests/rotate-test.mjs
 *
 * Slides are often portrait pages rotated to landscape. The ink is placed in
 * the displayed space but drawn in the unrotated one; get the mapping wrong and
 * the handwriting comes out sideways. No samples needed.
 */

import { unrotate } from '../src/pdfout.js';
import { reporter } from './helpers.mjs';

const { check, done } = reporter();
const W = 595, H = 842;
const close = (a, b) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

// Where the unrotated origin shows up once the viewer applies /Rotate (clockwise).
const origin = { 0: [0, 0], 90: [0, W], 180: [W, H], 270: [H, 0] };

for (const r of [0, 90, 180, 270]) {
  const at = unrotate(origin[r][0], origin[r][1], r, W, H);
  check(close(at, { x: 0, y: 0 }), `/Rotate ${r}: unrotated origin lands where the viewer shows it`);

  // An image anchored at unrotate(x, y) and rotated CCW by r must have its
  // right and top edges land where the displayed rectangle says.
  const x = 100, y = 50, w = 40, h = 20;
  const a = unrotate(x, y, r, W, H);
  const rad = (r * Math.PI) / 180, c = Math.round(Math.cos(rad)), s = Math.round(Math.sin(rad));
  const right = { x: a.x + w * c, y: a.y + w * s };
  const top = { x: a.x - h * s, y: a.y + h * c };
  check(close(right, unrotate(x + w, y, r, W, H)), `/Rotate ${r}: image width runs along the displayed x-axis`);
  check(close(top, unrotate(x, y + h, r, W, H)), `/Rotate ${r}: image height runs along the displayed y-axis`);
}

done();
