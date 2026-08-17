/*
 * Supernote Annotations — the Obsidian side.
 *
 * Watches the vault for .note and .mark files that your sync drops in, and
 * turns them into readable artefacts. No daemon, no host binaries: everything
 * runs in-process, which is also why it works on a phone.
 *
 * Invariants worth keeping if you touch this:
 *   - .note, .mark and original PDFs are opened read-only. Always.
 *   - Generated files are separate artefacts and safe to delete; they are
 *     rebuilt on the next run.
 *   - Work is serialised. Decoding a 16-page note allocates ~20 MB per page,
 *     and two at once on a phone is how you get killed by the OS.
 *   - A sync client writes files in place, so a create event can fire while the
 *     file is still half-written. Nothing is parsed until its size holds still.
 */

import { Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder, Vault, normalizePath } from 'obsidian';
import * as PDFLib from 'pdf-lib';
// Deep import on purpose: the package's index pulls in image-js, sql.js and
// fontkit, none of which this plugin needs. parsing.js imports only format.js,
// so this keeps the bundle small and free of Node built-ins. The version is
// pinned exactly in package.json because deep paths are not a public API.
import { SupernoteX } from 'supernote-typescript/lib/parsing.js';

import { noteToPdf, markToAnnotatedPdf } from './pdfout.js';
import { collectText, indexPathFor, buildSidecar, DEFAULT_FOLDER } from './sidecar.js';
import { stemOf, groupPaths, sidecarDir } from './paths.js';
import { cacheKey, cacheDir } from './overlay.js';

const LOG = '[supernote-annotations]';

const DEFAULTS = {
  convertNotes: true,
  convertMarks: true,
  // One PDF rather than two: the ink is drawn into the PDF as Obsidian opens
  // it, and nothing is written beside it. Turn this off to get the separate
  // "(annotated)" file back.
  overlayInPlace: true,
  // Off by default: this is the only feature that writes markdown into your
  // vault, so it should be something you switch on knowingly.
  writeSidecars: false,
  sidecarFolder: DEFAULT_FOLDER,
  extraFrontmatter: '',
  annotatedSuffix: ' (annotated)',
  debounceMs: 1500,
};

const isSource = (file) => file instanceof TFile && (file.extension === 'note' || file.extension === 'mark');

export default class SupernoteAnnotationsPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.queue = [];
    this.running = false;
    this.timers = new Map();
    // Paths we are in the middle of moving ourselves. Every renameFile below
    // fires the same rename event we are handling, so without this the first
    // move would recurse through the rest of the group.
    this.moving = new Set();
    // PDF path → the stamped copy in the cache. The only thing that makes a
    // PDF render with ink; empty means every PDF renders exactly as it is on
    // disk, which is also the state after this plugin is disabled.
    this.overlays = new Map();
    this.installOverlayHook();

    this.status = this.addStatusBarItem();
    this.setStatus('');

    for (const evt of ['create', 'modify']) {
      this.registerEvent(this.app.vault.on(evt, (file) => {
        if (isSource(file)) this.schedule(file.path);
      }));
    }

    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.onRename(file, oldPath).catch((e) => console.error(LOG, 'rename', oldPath, e));
    }));

    this.registerEvent(this.app.vault.on('delete', (file) => this.onDelete(file)));

    this.addCommand({
      id: 'scan-all',
      name: 'Scan all files',
      callback: () => this.scanAll(true),
    });

    this.addSettingTab(new SupernoteAnnotationsSettingTab(this.app, this));

    // One catch-up pass for anything that arrived while Obsidian was closed.
    this.app.workspace.onLayoutReady(() => this.scanAll(false));
  }

  onunload() {
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  setStatus(text) {
    if (this.status) this.status.setText(text);
  }

  /** Debounce per path: a burst of writes from a sync client becomes one job. */
  schedule(path) {
    if (this.timers.has(path)) window.clearTimeout(this.timers.get(path));
    this.timers.set(path, window.setTimeout(() => {
      this.timers.delete(path);
      this.enqueue(path);
    }, this.settings.debounceMs));
  }

  enqueue(path) {
    if (!this.queue.includes(path)) this.queue.push(path);
    this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const path = this.queue.shift();
        this.setStatus(`Supernote: ${this.queue.length + 1} queued`);
        try {
          await this.process(path);
        } catch (e) {
          console.error(LOG, path, e);
          new Notice(`Supernote: ${path.split('/').pop()} — ${e.message}`);
        }
      }
    } finally {
      this.running = false;
      this.setStatus('');
    }

    // Only after a full pass is `overlays` a complete picture of the vault, and
    // only then is it safe to delete what nothing points at.
    if (this.sweepPending) {
      this.sweepPending = false;
      await this.sweepCache().catch((e) => console.warn(LOG, 'cache sweep', e));
    }
  }

  async scanAll(loud) {
    const files = this.app.vault.getFiles().filter(isSource);
    this.sweepPending = true;
    for (const f of files) this.enqueue(f.path);
    if (loud) new Notice(`Supernote: ${files.length} file(s) queued.`);
  }

  /**
   * Make a PDF render with its ink without changing the PDF.
   *
   * Obsidian's PDF view hands PDF.js a URL rather than bytes, and the markdown
   * embed goes through the same viewer, so redirecting that one URL covers both
   * with nothing to keep in sync between them. Everything here is public API:
   * Vault.getResourcePath is exported, and the adapter's takes a plain path, so
   * the stamped copy can be served straight off disk — no bytes held in memory,
   * whatever the size of the PDF.
   *
   * ponytail: a plain prototype patch with no wrapper detection. If a second
   * plugin patches the same method after us, unloading restores over the top of
   * theirs. monkey-around solves it properly and is a dependency this does not
   * need yet.
   */
  installOverlayHook() {
    const proto = Vault?.prototype;
    const usable = typeof proto?.getResourcePath === 'function'
      && typeof this.app.vault.adapter?.getResourcePath === 'function';
    if (!usable) {
      // An Obsidian this old or this new is allowed to exist. Degrade to the
      // separate file rather than to a viewer that shows nothing.
      console.warn(LOG, 'no usable getResourcePath — keeping the separate annotated PDF');
      this.settings.overlayInPlace = false;
      this.overlayUnavailable = true;
      return;
    }

    // Captured by reference, not copied: both are mutated in place for the
    // lifetime of the plugin, and `this` inside the replacement has to stay the
    // Vault it was called on.
    const { overlays, settings } = this;
    const original = proto.getResourcePath;
    proto.getResourcePath = function (file) {
      const cached = settings.overlayInPlace && file && overlays.get(file.path);
      return cached ? this.adapter.getResourcePath(normalizePath(cached)) : original.call(this, file);
    };
    this.register(() => { proto.getResourcePath = original; });
  }

  /** Where stamped copies live. Inside .obsidian, so outside the vault proper. */
  cacheDir() {
    return cacheDir(this.app.vault.configDir, this.manifest.id);
  }

  /**
   * Point `pdfPath` at a stamped copy, and redraw anything already showing it.
   *
   * Only redraws on an actual change: reprocessing an unchanged pair is the
   * common case on every startup, and rebuilding the view for it would make
   * opening a PDF flicker for no reason.
   */
  setOverlay(pdfPath, cachePath) {
    if (this.overlays.get(pdfPath) === cachePath) return;
    if (cachePath) this.overlays.set(pdfPath, cachePath);
    else this.overlays.delete(pdfPath);
    this.refreshViews(pdfPath);
  }

  /** Rebuild any open PDF view of `path` so it picks up the new URL. */
  refreshViews(path) {
    for (const leaf of this.app.workspace.getLeavesOfType('pdf')) {
      if (leaf.view?.file?.path === path) leaf.setViewState(leaf.getViewState());
    }
  }

  /**
   * Delete cache entries nothing points at any more — the .mark was deleted,
   * or rewritten, and its old stamped copy can be 18 MB of nothing.
   *
   * Only ever runs after a full scan, when `overlays` is known to describe
   * every pair in the vault. Running it at any other time would delete entries
   * that simply have not been rebuilt yet.
   */
  async sweepCache() {
    const dir = normalizePath(this.cacheDir());
    if (!(await this.app.vault.adapter.exists(dir))) return;
    const live = new Set([...this.overlays.values()].map((p) => normalizePath(p)));
    const { files } = await this.app.vault.adapter.list(dir);
    for (const f of files) {
      if (live.has(f)) continue;
      try {
        await this.app.vault.adapter.remove(f);
      } catch (e) {
        console.warn(LOG, 'could not remove stale cache entry', f, e);
      }
    }
  }

  /**
   * Keep the group together when one of its files moves or is renamed.
   *
   * Nothing about which files belong together is stored: the stem is recovered
   * from the path that moved and the group rebuilt from it, so the old and new
   * groups zip one to one and the difference is the list of moves.
   *
   * This is not a convenience. Rename a PDF without its .pdf.mark and the
   * pairing in process() is gone for good — the .mark can never find its PDF
   * again, and nothing says so out loud.
   *
   * Moves go through fileManager.renameFile rather than vault.rename because
   * that is the one that rewrites [[links]] and ![[embeds]] pointing at the
   * file, honouring whatever link style the user has configured.
   */
  async onRename(file, oldPath) {
    // Our own doing, echoed back at us.
    if (this.moving.delete(oldPath)) return;

    if (file instanceof TFolder) return this.onFolderRename(oldPath, file.path);
    if (!(file instanceof TFile)) return;

    const oldStem = stemOf(oldPath, this.settings);
    const newStem = stemOf(file.path, this.settings);
    if (!oldStem || !newStem || oldStem === newStem) return;

    const from = groupPaths(oldStem, this.settings);
    const to = groupPaths(newStem, this.settings);

    for (let i = 0; i < from.length; i++) {
      if (from[i] === oldPath) continue;        // the one the user already moved
      await this.moveOne(from[i], to[i]);
    }

    // The stamped copy is keyed by the .mark's content, so the move does not
    // invalidate it — only which PDF it belongs to changed. Re-keying here
    // rather than waiting for the reprocess below keeps the ink on screen
    // through the move instead of blinking off and back.
    const cached = this.overlays.get(`${oldStem}.pdf`);
    if (cached) {
      this.overlays.delete(`${oldStem}.pdf`);
      this.overlays.set(`${newStem}.pdf`, cached);
    }

    // The sidecar carries `source:` and `artifact:` as plain quoted paths, not
    // links, so Obsidian's link updater cannot touch them. Reprocessing rebuilds
    // the file; writeTextIfChanged leaves it alone if nothing actually changed.
    for (const p of [`${newStem}.note`, `${newStem}.pdf.mark`]) {
      if (this.app.vault.getAbstractFileByPath(p) instanceof TFile) this.schedule(p);
    }
  }

  /** Move one companion, refusing to overwrite anything already sitting there. */
  async moveOne(from, to) {
    const f = this.app.vault.getAbstractFileByPath(from);
    if (!(f instanceof TFile)) return;

    if (this.app.vault.getAbstractFileByPath(to)) {
      new Notice(`Supernote: ${to.split('/').pop()} already exists — left ${from.split('/').pop()} behind.`);
      console.warn(LOG, 'target exists, not moving', from, '→', to);
      return;
    }

    await this.ensureFolder(to);
    this.moving.add(from);
    try {
      await this.app.fileManager.renameFile(f, to);
    } catch (e) {
      this.moving.delete(from);
      console.error(LOG, 'could not move', from, '→', to, e);
      new Notice(`Supernote: could not move ${from.split('/').pop()} — ${e.message}`);
    }
  }

  /**
   * A folder moved. Obsidian fires one event for the folder itself; whether it
   * also fires one per descendant varies, and either way is fine here — a
   * per-file event finds the companions already beside their sibling and moves
   * nothing.
   *
   * What does need doing is the sidecar mirror, which lives in a different tree
   * and so never travels with the drag. The mirror is an invariant in both
   * directions, so dragging a folder inside the index moves the sources to
   * match, exactly as dragging a source folder moves the index branch.
   */
  async onFolderRename(oldPath, newPath) {
    const dir = sidecarDir(this.settings.sidecarFolder);
    const inIndex = (p) => p === dir || p.startsWith(`${dir}/`);

    const [from, to] = inIndex(oldPath) && inIndex(newPath)
      ? [oldPath.slice(dir.length + 1), newPath.slice(dir.length + 1)]  // index → sources
      : [`${dir}/${oldPath}`, `${dir}/${newPath}`];                     // sources → index

    if (!from || !to || from === to) return;

    const f = this.app.vault.getAbstractFileByPath(from);
    if (!(f instanceof TFolder)) return;
    if (this.app.vault.getAbstractFileByPath(to)) {
      console.warn(LOG, 'target folder exists, not moving', from, '→', to);
      return;
    }

    await this.ensureFolder(to);
    this.moving.add(from);
    try {
      await this.app.fileManager.renameFile(f, to);
    } catch (e) {
      this.moving.delete(from);
      console.error(LOG, 'could not move folder', from, '→', to, e);
    }
  }

  /**
   * Deleting a source is allowed — everything generated is meant to be
   * disposable. But a generated PDF someone has linked in a note is not
   * disposable in practice, and Obsidian offers no way to intercept a delete,
   * so the most this can do is say what just happened.
   */
  onDelete(file) {
    if (!isSource(file)) return;
    const stem = stemOf(file.path, this.settings);
    if (!stem) return;

    if (file.extension === 'mark') {
      // The whole point of drawing the ink at view time: taking the .mark away
      // leaves the PDF exactly as it was, with nothing to undo.
      this.setOverlay(`${stem}.pdf`, null);
      new Notice(`Supernote: ink layer gone — ${stem.split('/').pop()}.pdf is plain again.`);
      return;
    }

    const linkers = this.linksTo(`${stem}.pdf`);
    if (linkers.length) {
      new Notice(`Supernote: ${stem.split('/').pop()}.pdf is still linked from `
        + `${linkers.map((p) => p.split('/').pop()).join(', ')} and will no longer be rebuilt.`);
    }
  }

  /** Notes whose links resolve to `path`. */
  linksTo(path) {
    const resolved = this.app.metadataCache.resolvedLinks || {};
    return Object.keys(resolved).filter((from) => resolved[from][path]);
  }

  /**
   * Wait until the file size stops changing, so we never parse a half-synced
   * file. Returns false if it never settles.
   *
   * This polls the adapter rather than the Vault API on purpose: TFile.stat is
   * the cached value from when the file was indexed, and it is precisely the
   * changing size on disk we need to observe.
   */
  async waitForStableSize(path, tries = 12) {
    let last = -1;
    for (let i = 0; i < tries; i++) {
      const stat = await this.app.vault.adapter.stat(normalizePath(path));
      if (!stat) return false;
      if (stat.size === last && stat.size > 0) return true;
      last = stat.size;
      await sleep(250);
    }
    return false;
  }

  /** Is the artefact already newer than its source? Then there is nothing to do. */
  async isCurrent(outPath, sourceMtime) {
    const stat = await this.app.vault.adapter.stat(normalizePath(outPath));
    return !!stat && stat.mtime >= sourceMtime;
  }

  async writeBinary(path, bytes) {
    const p = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(p);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, buf);
    else await this.app.vault.createBinary(p, buf);
  }

  /**
   * Write a sidecar, but only when its content would actually change.
   *
   * Content comparison rather than a timestamp check, because the sidecar
   * depends on settings as well as on the source file. Keyed on mtime, editing
   * the sidecar folder or the extra frontmatter would appear to do nothing
   * until the .note itself changed — a setting that silently no-ops is worse
   * than one that is missing.
   *
   * Returns true when something was written.
   */
  async writeTextIfChanged(path, text) {
    const p = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(p);

    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      if (current === text) return false;      // identical: leave the file alone
      await this.app.vault.process(existing, () => text);
      return true;
    }

    await this.ensureFolder(p);
    await this.app.vault.create(p, text);
    return true;
  }

  /** Create the parent folder of `path` if it is missing. */
  async ensureFolder(path) {
    const dir = path.split('/').slice(0, -1).join('/');
    if (!dir || this.app.vault.getAbstractFileByPath(dir)) return;
    try {
      await this.app.vault.createFolder(dir);
    } catch {
      // Already there, or created by a concurrent write. Either is fine.
    }
  }

  /**
   * Draw a .mark onto its PDF, and decide where the result goes.
   *
   * Two destinations, one pipeline. In place, the stamped bytes land in the
   * cache and the viewer is pointed at them, so the vault keeps one PDF and the
   * device keeps a pristine one to draw on. Otherwise they land beside the
   * original as "Name (annotated).pdf", which is what this plugin always did.
   *
   * Returns the path the sidecar should link to, or null when there was no ink
   * — the device writes a .mark merely from opening a PDF, so most of them are
   * empty and must produce nothing at all.
   */
  async stampMark(markPath, sn, markBytes, pdf, markMtime) {
    const inPlace = this.settings.overlayInPlace;
    const outPath = inPlace
      ? `${this.cacheDir()}/${cacheKey(markBytes, pdf.stat.size)}.pdf`
      : `${pdf.path.replace(/\.pdf$/i, '')}${this.settings.annotatedSuffix}.pdf`;

    // In place the key already encodes both inputs, so the entry existing means
    // it is current. Beside the original the name says nothing about content,
    // which is what the mtime comparison is for.
    const current = inPlace
      ? await this.app.vault.adapter.exists(normalizePath(outPath))
      : await this.isCurrent(outPath, Math.max(markMtime, pdf.stat.mtime));

    if (!current) {
      const original = await this.app.vault.readBinary(pdf);
      const out = await markToAnnotatedPdf(sn, new Uint8Array(original), PDFLib,
        (m) => console.warn(LOG, markPath, m));
      if (!out) {
        // Ink that used to be there and is not any more: the PDF has to go back
        // to rendering plain, which it will not do while the old entry stands.
        if (inPlace) this.setOverlay(pdf.path, null);
        return null;
      }

      if (inPlace) {
        await this.app.vault.adapter.mkdir(normalizePath(this.cacheDir()));
        await this.app.vault.adapter.writeBinary(normalizePath(outPath),
          out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
      } else {
        await this.writeBinary(outPath, out);
      }
      new Notice(`Annotated: ${pdf.name}`);
    }

    if (!inPlace) return outPath;
    this.setOverlay(pdf.path, outPath);
    // The one PDF is what anything should link to now.
    return pdf.path;
  }

  async process(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const isMark = file.extension === 'mark';
    if (isMark && !this.settings.convertMarks) return;
    if (!isMark && !this.settings.convertNotes) return;

    if (!(await this.waitForStableSize(path))) {
      console.warn(LOG, 'size never settled, skipping', path);
      return;
    }

    const bytes = new Uint8Array(await this.app.vault.readBinary(file));
    const sn = new SupernoteX(bytes);
    const sourceMtime = file.stat.mtime;

    let artefact = null;

    if (isMark) {
      const pdfPath = path.replace(/\.mark$/i, '');
      const pdf = this.app.vault.getAbstractFileByPath(pdfPath);
      if (!(pdf instanceof TFile)) {
        console.warn(LOG, 'no PDF beside', path);
        return;
      }
      artefact = await this.stampMark(path, sn, bytes, pdf, sourceMtime);
      if (artefact === null) return;          // no ink → deliberately nothing
    } else {
      const outPath = path.replace(/\.note$/i, '.pdf');

      if (await this.isCurrent(outPath, sourceMtime)) {
        artefact = outPath;
      } else {
        const out = await noteToPdf(sn, PDFLib);
        if (!out) return;
        await this.writeBinary(outPath, out);
        artefact = outPath;
        new Notice(`PDF created: ${outPath.split('/').pop()}`);
      }
    }

    // Handled independently of the PDF above: switching sidecars on long after
    // the PDFs were built has to backfill them, otherwise the setting appears
    // to do nothing at all and never says why. Building the sidecar is cheap —
    // the text is already parsed and no image is decoded — so it is rebuilt
    // every pass and written only if it differs.
    if (this.settings.writeSidecars) {
      const pages = collectText(sn);
      if (pages) {
        const target = indexPathFor(path, this.settings.sidecarFolder);
        await this.writeTextIfChanged(target, buildSidecar(sn, path, artefact, pages, {
          extraFrontmatter: this.settings.extraFrontmatter,
        }));
      }
    }
  }
}

const sleep = (ms) => new Promise((r) => window.setTimeout(r, ms));

class SupernoteAnnotationsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const save = () => this.plugin.saveSettings();

    new Setting(containerEl)
      .setName('Convert .note files to PDF')
      .setDesc('Writes a real PDF next to every notebook, keeping the device aspect ratio.')
      .addToggle((t) => t.setValue(this.plugin.settings.convertNotes)
        .onChange(async (v) => { this.plugin.settings.convertNotes = v; await save(); }));

    new Setting(containerEl)
      .setName('Stamp .mark files onto a PDF copy')
      .setDesc('Draws the annotations onto a copy of the PDF. The original and the .mark file are left untouched.')
      .addToggle((t) => t.setValue(this.plugin.settings.convertMarks)
        .onChange(async (v) => { this.plugin.settings.convertMarks = v; await save(); }));

    new Setting(containerEl)
      .setName('Show the annotations inside the PDF')
      .setDesc('Keeps one PDF instead of two: the ink is drawn as Obsidian opens the file, and '
        + 'nothing is written next to it. The PDF on disk stays untouched, so your device still '
        + 'sees a clean copy to draw on. Turn this off for a separate "(annotated)" file.')
      .addToggle((t) => t.setValue(this.plugin.settings.overlayInPlace)
        .setDisabled(!!this.plugin.overlayUnavailable)
        .onChange(async (v) => {
          this.plugin.settings.overlayInPlace = v;
          await save();
          this.plugin.overlays.clear();
          this.plugin.scanAll(true);
          this.display();
        }));

    if (this.plugin.overlayUnavailable) {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: 'This version of Obsidian does not expose what drawing the ink in place needs, '
          + 'so the separate file is being used instead.',
      });
    }

    new Setting(containerEl)
      .setName('Filename suffix')
      .setDesc('Appended to the annotated copy, when it is a separate file.')
      .addText((t) => t.setValue(this.plugin.settings.annotatedSuffix)
        .setDisabled(this.plugin.settings.overlayInPlace)
        .onChange(async (v) => { this.plugin.settings.annotatedSuffix = v || ' (annotated)'; await save(); }));

    new Setting(containerEl)
      .setName('Write text sidecars')
      .setDesc('Saves recognised handwriting as markdown so search and the tag pane can find it. '
        + 'Requires handwriting recognition to be switched on for the file on the device.')
      .addToggle((t) => t.setValue(this.plugin.settings.writeSidecars)
        .onChange(async (v) => { this.plugin.settings.writeSidecars = v; await save(); }));

    new Setting(containerEl)
      .setName('Sidecar folder')
      .setDesc('Where the Markdown twins are written, mirroring the source path below it.')
      .addText((t) => t.setPlaceholder(DEFAULT_FOLDER)
        .setValue(this.plugin.settings.sidecarFolder)
        .onChange(async (v) => { this.plugin.settings.sidecarFolder = v || DEFAULT_FOLDER; await save(); }));

    new Setting(containerEl)
      .setName('Extra frontmatter')
      .setDesc('Optional lines added to every sidecar, one property per line, for example "category: lectures".')
      .addTextArea((t) => t
        .setValue(this.plugin.settings.extraFrontmatter)
        .onChange(async (v) => { this.plugin.settings.extraFrontmatter = v; await save(); }));

    new Setting(containerEl)
      .setName('Scan the vault now')
      .setDesc('Checks every .note and .mark file and regenerates anything out of date.')
      .addButton((b) => b.setButtonText('Scan').setCta()
        .onClick(() => this.plugin.scanAll(true)));
  }
}
