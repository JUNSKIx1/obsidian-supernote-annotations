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

import { Plugin, PluginSettingTab, Setting, Notice, TFile, normalizePath } from 'obsidian';
import * as PDFLib from 'pdf-lib';
// Deep import on purpose: the package's index pulls in image-js, sql.js and
// fontkit, none of which this plugin needs. parsing.js imports only format.js,
// so this keeps the bundle small and free of Node built-ins. The version is
// pinned exactly in package.json because deep paths are not a public API.
import { SupernoteX } from 'supernote-typescript/lib/parsing.js';

import { noteToPdf, markToAnnotatedPdf } from './pdfout.js';
import { collectText, indexPathFor, buildSidecar, DEFAULT_FOLDER } from './sidecar.js';

const LOG = '[supernote-annotations]';

const DEFAULTS = {
  convertNotes: true,
  convertMarks: true,
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

    this.status = this.addStatusBarItem();
    this.setStatus('');

    for (const evt of ['create', 'modify']) {
      this.registerEvent(this.app.vault.on(evt, (file) => {
        if (isSource(file)) this.schedule(file.path);
      }));
    }

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
  }

  async scanAll(loud) {
    const files = this.app.vault.getFiles().filter(isSource);
    for (const f of files) this.enqueue(f.path);
    if (loud) new Notice(`Supernote: ${files.length} file(s) queued.`);
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

    const dir = p.split('/').slice(0, -1).join('/');
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
      try {
        await this.app.vault.createFolder(dir);
      } catch {
        // Already there, or created by a concurrent write. Either is fine.
      }
    }
    await this.app.vault.create(p, text);
    return true;
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
      const base = pdfPath.replace(/\.pdf$/i, '');
      const outPath = `${base}${this.settings.annotatedSuffix}.pdf`;
      const newest = Math.max(sourceMtime, pdf.stat.mtime);

      if (await this.isCurrent(outPath, newest)) {
        artefact = outPath;                   // already up to date, nothing to redraw
      } else {
        const original = await this.app.vault.readBinary(pdf);
        const out = await markToAnnotatedPdf(sn, new Uint8Array(original), PDFLib,
          (m) => console.warn(LOG, path, m));
        if (!out) return;                     // no ink → deliberately nothing
        await this.writeBinary(outPath, out);
        artefact = outPath;
        new Notice(`Annotated: ${outPath.split('/').pop()}`);
      }
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
      .setName('Filename suffix')
      .setDesc('Appended to the annotated copy.')
      .addText((t) => t.setValue(this.plugin.settings.annotatedSuffix)
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
