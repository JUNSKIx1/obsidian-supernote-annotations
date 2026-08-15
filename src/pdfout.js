/*
 * Turning decoded Supernote pages into PDFs.
 *
 *   .note  → a new PDF, one image page per note page
 *   .mark  → a copy of the original PDF with the ink stamped on top
 *
 * The original PDF and the .mark are only ever read. The annotated version is a
 * separate file, so the Supernote can keep editing its own annotations — burning
 * them into the source would make them permanent and uneditable on the device.
 */

import { decodePage } from './rle.js';
import { encodePng, crop, flattenToWhite, placement } from './render.js';

const A4_WIDTH = 595.28;

/** PDF page numbers carrying ink, from the container footer: { "1": offset, … }. */
function markedPageNumbers(sn) {
  const page = (sn.footer && sn.footer.PAGE) || {};
  return Object.keys(page)
    .map((k) => parseInt(k, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * .note → PDF. Pages keep the device's aspect ratio, sized to A4 width, so
 * handwriting is never stretched.
 * Returns null when every page is blank — an empty PDF helps nobody.
 */
async function noteToPdf(sn, PDFLib) {
  const doc = await PDFLib.PDFDocument.create();
  const pageHeight = A4_WIDTH * (sn.pageHeight / sn.pageWidth);
  let drew = 0;

  for (let i = 0; i < sn.pages.length; i++) {
    const decoded = decodePage(sn.pages[i], sn.pageWidth, sn.pageHeight, true);
    const page = doc.addPage([A4_WIDTH, pageHeight]);
    if (!decoded.bbox) continue;               // blank page: keep it, leave it empty
    const png = await encodePng(flattenToWhite(decoded.data), decoded.width, decoded.height);
    const img = await doc.embedPng(png);
    page.drawImage(img, { x: 0, y: 0, width: A4_WIDTH, height: pageHeight });
    drew++;
  }

  if (!drew) return null;
  return doc.save();
}

/**
 * .mark + original PDF → annotated copy, or null when the mark holds no ink.
 *
 * An empty .mark is normal, not an error: the device writes one merely from
 * opening a PDF, and most of them never receive a stroke. Returning null for
 * those is what stops a vault filling with pointless duplicate PDFs.
 */
async function markToAnnotatedPdf(sn, pdfBytes, PDFLib, warn) {
  const pageNumbers = markedPageNumbers(sn);
  if (!pageNumbers.length) return null;

  // Decode first: if there is no ink anywhere, do not even open the PDF.
  const inked = [];
  for (let i = 0; i < sn.pages.length && i < pageNumbers.length; i++) {
    const decoded = decodePage(sn.pages[i], sn.pageWidth, sn.pageHeight, false);
    if (decoded.bbox) inked.push({ pdfPage: pageNumbers[i], decoded });
  }
  if (!inked.length) return null;

  const doc = await PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  let stamped = 0;

  for (const { pdfPage, decoded } of inked) {
    const page = pages[pdfPage - 1];
    if (!page) {
      if (warn) warn(`page ${pdfPage} does not exist in the PDF (${pages.length} pages) — skipped`);
      continue;
    }

    const size = page.getSize();
    const rotation = (page.getRotation && page.getRotation().angle) || 0;
    // A rotated page is displayed with its dimensions swapped, and the device
    // annotated what it displayed.
    const swapped = rotation === 90 || rotation === 270;
    const viewW = swapped ? size.height : size.width;
    const viewH = swapped ? size.width : size.height;
    if (rotation % 360 !== 0 && warn) {
      warn(`page ${pdfPage} is rotated by ${rotation}° — placement is approximate`);
    }

    const place = placement(decoded.width, decoded.height, viewW, viewH);
    const box = decoded.bbox;
    const piece = crop(decoded.data, decoded.width, box);
    const png = await encodePng(piece.data, piece.width, piece.height);
    const img = await doc.embedPng(png);

    // Canvas pixels → page points. The canvas measures from the top-left, PDF
    // from the bottom-left, hence the flip on y.
    const x = (box[0] - place.offsetX) / place.scale;
    const yTop = (box[1] - place.offsetY) / place.scale;
    const w = piece.width / place.scale;
    const h = piece.height / place.scale;
    const y = viewH - yTop - h;

    page.drawImage(img, { x, y, width: w, height: h });
    stamped++;
  }

  if (!stamped) return null;
  return doc.save();
}

export { noteToPdf, markToAnnotatedPdf, markedPageNumbers };
