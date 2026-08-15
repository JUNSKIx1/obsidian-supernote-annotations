#!/usr/bin/env node
/*
 * Verifies the hand-written RATTA_RLE decoder against supernote-tool.
 *
 *   SUPERNOTE_SAMPLES=~/Notes node tests/decoder-test.mjs
 *
 * supernote-tool (the mature Python reference) is treated as ground truth. For
 * every .note/.mark page we assert the JS decoder agrees on:
 *   - canvas size            exactly
 *   - ink bounding box       within BBOX_TOL px
 *   - blank vs. not-blank    exactly   ← this decides whether a file gets output
 *   - opaque pixel count     within PIXEL_TOL_PCT
 *
 * The pixel-count tolerance exists because the Python tool antialiases
 * (ANTIALIASING_CONVERT=2) and we do not, so edge pixels differ slightly. The
 * bounding box does not have that excuse and is held tight — an off-by-one in a
 * run length shows up there as skewed handwriting long before it is visible.
 *
 * Requires: supernote-tool on PATH, python3 with Pillow. Writes only to a temp
 * directory; the samples are read-only here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

import { SupernoteX } from 'supernote-typescript/lib/parsing.js';
import { decodePage } from '../src/rle.js';
import { SAMPLES, requireSamples, findSources } from './helpers.mjs';

if (!requireSamples('the decoder test')) process.exit(0);

for (const [cmd, args] of [['supernote-tool', ['--help']], ['python3', ['-c', 'import PIL']]]) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
  } catch {
    console.log(`\n~ ${cmd} is unavailable — skipping the decoder test.`);
    console.log('  It needs supernote-tool on PATH and python3 with Pillow.\n');
    process.exit(0);
  }
}

const BBOX_TOL = 2;
const PIXEL_TOL_PCT = 0.5;

/** Ground truth for one file: [{size,bbox,opaque,core}] per page, via supernote-tool + Pillow. */
function reference(file, tmp) {
  const stem = path.join(tmp, 'ref');
  for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f));
  try {
    execFileSync('supernote-tool',
      ['convert', '-t', 'png', '-a', '--exclude-background', file, `${stem}.png`],
      { stdio: 'ignore' });
  } catch { return null; }
  const py = `
import glob, re, json
from PIL import Image
out = []
fs = sorted(glob.glob(${JSON.stringify(stem)} + "*.png"),
            key=lambda s: int(re.search(r'_(\\d+)\\.png$', s).group(1)) if re.search(r'_(\\d+)\\.png$', s) else 0)
for f in fs:
    im = Image.open(f).convert("RGBA")
    a = im.getchannel("A")
    bb = a.getbbox()
    cols = im.getcolors(maxcolors=1<<20) or []
    opaque = sum(c for c, col in cols if col[3] > 0)
    # supernote-tool antialiases: besides the palette colours it emits a fringe
    # of intermediate greys, all at full alpha. Count only the true palette
    # values (black 0x00, darkGray 0x9d=157, gray 0xc9=201, white 0xfe=254),
    # which is what an unsmoothed decoder is expected to reproduce exactly.
    CORE = {0, 157, 201, 254, 255}
    core = sum(c for c, col in cols
               if col[3] == 255 and col[0] == col[1] == col[2] and col[0] in CORE)
    out.append({"size": list(im.size), "bbox": list(bb) if bb else None,
                "opaque": opaque, "core": core})
print(json.dumps(out))
`;
  return JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' }));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-decode-'));
const files = findSources(SAMPLES).sort();
let pass = 0, fail = 0, skipped = 0;
const failures = [];

console.log(`\nComparing ${files.length} Supernote files against supernote-tool\n`);

for (const file of files) {
  const name = path.relative(SAMPLES, file);
  const ref = reference(file, tmp);
  if (!ref) { console.log(`  ~ ${name} — supernote-tool could not read it, skipped`); skipped++; continue; }

  let sn;
  try {
    sn = new SupernoteX(new Uint8Array(fs.readFileSync(file)));
  } catch (e) {
    console.log(`  ✗ ${name} — parse failed: ${e.message}`); fail++; failures.push(name); continue;
  }

  const problems = [];
  if (sn.pages.length !== ref.length) {
    problems.push(`page count ${sn.pages.length} vs reference ${ref.length}`);
  }
  const n = Math.min(sn.pages.length, ref.length);
  for (let i = 0; i < n; i++) {
    let got;
    try {
      got = decodePage(sn.pages[i], sn.pageWidth, sn.pageHeight, false);
    } catch (e) { problems.push(`p${i}: decode threw ${e.message}`); continue; }
    const want = ref[i];

    if (got.width !== want.size[0] || got.height !== want.size[1]) {
      problems.push(`p${i}: size ${got.width}x${got.height} vs ${want.size.join('x')}`);
    }
    const gotBlank = got.bbox === null, wantBlank = want.bbox === null;
    if (gotBlank !== wantBlank) {
      problems.push(`p${i}: blank=${gotBlank} vs reference blank=${wantBlank}`);
    } else if (!gotBlank) {
      const drift = got.bbox.map((v, k) => Math.abs(v - want.bbox[k]));
      if (Math.max(...drift) > BBOX_TOL) {
        problems.push(`p${i}: bbox [${got.bbox}] vs [${want.bbox}] (drift ${Math.max(...drift)}px)`);
      }
      // Compare against the reference's palette-colour pixels only; its
      // antialiasing fringe is a rendering choice, not a decoding difference.
      const diff = Math.abs(got.opaque - want.core) / Math.max(1, want.core) * 100;
      if (diff > PIXEL_TOL_PCT) {
        problems.push(`p${i}: ${got.opaque} px vs reference ${want.core} palette px`
          + ` (${diff.toFixed(2)}% off; reference total incl. antialiasing ${want.opaque})`);
      }
    }
  }

  if (problems.length) {
    console.log(`  ✗ ${name}`);
    for (const p of problems.slice(0, 6)) console.log(`      ${p}`);
    if (problems.length > 6) console.log(`      … and ${problems.length - 6} more`);
    fail++; failures.push(name);
  } else {
    const inked = ref.filter((r) => r.bbox).length;
    console.log(`  ✓ ${name}  (${ref.length} page(s), ${inked} inked)`);
    pass++;
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} files matched, ${fail} failed, ${skipped} skipped\n`);
if (fail) { console.log('failed:', failures.join(', ')); process.exit(1); }
