/**
 * extract.js — read a Form 1098-T without sending it anywhere.
 *
 * The whole point of this app is that tax documents stay on the device, so
 * uploading a PDF to an OCR service was never an option: IRC 7216 makes it a
 * misdemeanour to *use* taxpayer information for anything other than
 * preparing the return, and a third-party API call is a use.
 *
 * So parsing happens in the browser. pdf.js is lazy-loaded — 3 MB that most
 * sessions never need — and reads the PDF's own text layer with coordinates.
 * University-issued 1098-Ts are generated documents, not scans, so the text
 * and its positions are already in the file. No OCR, no network, no guessing
 * at pixels.
 *
 * ── The design rule that matters ──────────────────────────────────────────
 *
 * Extraction PROPOSES. The human CONFIRMS. Nothing here writes a figure into
 * the return without someone looking at it first.
 *
 * That is not politeness. Box 1 and box 5 are the two numbers the entire
 * credit turns on, and a form parser is a heuristic — issuers move boxes,
 * fonts change, a scan has no text layer at all. A wrong digit silently
 * accepted is exactly the failure this project exists to prevent, and it
 * would be worse than typing them by hand, because it would look effortless.
 *
 * So every field comes back with a confidence, every value is shown beside
 * its label for checking, and the user clicks to apply.
 */

'use strict';

let pdfjsPromise = null;

/** Load pdf.js on first use only. It is 3 MB; most sessions never need it. */
async function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./vendor/pdf.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

const MONEY = /^\$?\s*([\d,]+\.\d{2})$/;
const num = (s) => Number(String(s).replace(/[$,\s]/g, ''));

/** Every text run on the page, with its position. */
async function itemsOf(file) {
  const lib = await pdfjs();
  const buf = new Uint8Array(await file.arrayBuffer());
  const doc = await lib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const out = [];
  for (let n = 1; n <= Math.min(doc.numPages, 4); n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      const s = (it.str || '').trim();
      if (s) out.push({ s, x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), page: n });
    }
  }
  return out;
}

/** Group items into rows by y, within a tolerance (PDF y grows upward). */
function rows(items, tol = 6) {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const out = [];
  for (const it of sorted) {
    const row = out.find((r) => Math.abs(r.y - it.y) <= tol);
    if (row) { row.items.push(it); row.y = (row.y + it.y) / 2; }
    else out.push({ y: it.y, items: [it] });
  }
  for (const r of out) r.items.sort((a, b) => a.x - b.x);
  return out;
}

/**
 * Locate the 1098-T money boxes.
 *
 * The federal layout is fixed enough to exploit its shape rather than its
 * pixel coordinates, which differ between issuers:
 *
 *   box 1 (payments received) is the TOPMOST money figure on the form
 *   box 4 / box 5 share a row lower down; box 5 is the RIGHTMOST of that row
 *   box 6 sits alone in the row below
 *
 * Anchoring on relative position rather than absolute coordinates is what
 * makes this survive a different issuer's template. It is still a heuristic,
 * which is why nothing is applied without confirmation.
 */
export function locate1098T(items) {
  const money = items.filter((i) => MONEY.test(i.s))
    .map((i) => ({ ...i, v: num(i.s.match(MONEY)[1]) }));

  const found = { box1: null, box4: null, box5: null, box6: null };
  const conf = {};

  if (money.length) {
    const byRow = rows(money);
    const top = byRow[0];
    found.box1 = top.items[0].v;
    conf.box1 = top.items.length === 1 ? 'high' : 'medium';

    // The box 4 / box 5 row is the one containing the rightmost money item
    // below box 1.
    const below = byRow.slice(1);
    if (below.length) {
      let best = null;
      for (const r of below) {
        const right = r.items[r.items.length - 1];
        if (!best || right.x > best.right.x) best = { row: r, right };
      }
      if (best) {
        found.box5 = best.right.v;
        conf.box5 = 'high';
        if (best.row.items.length > 1) { found.box4 = best.row.items[0].v; conf.box4 = 'medium'; }
        const after = below[below.indexOf(best.row) + 1];
        if (after) { found.box6 = after.items[0].v; conf.box6 = 'low'; }
      }
    }
  }

  // Checkbox marks — boxes 7, 8, 9 and 10.
  //
  // Boxes 8 and 9 sit SIDE BY SIDE on one row, so a single X falls inside
  // both labels' y-band and simple proximity picks the wrong one. The real
  // structure of the form is a row of cells, and the leftmost thing in each
  // cell is its BOX NUMBER:
  //
  //     "8" x=205 ... "half-time student" x=211 ... [X] x=285 | "9" x=298 ...
  //
  // So the numbers are the cell boundaries. A mark belongs to the box whose
  // number is the closest one to its LEFT — never the nearest in either
  // direction, which was reporting a half-time undergraduate as a graduate
  // student and would have denied the credit outright.
  const marks = items.filter((i) => /^[X✓☑x]$/.test(i.s));
  // A box number is sometimes its own text run ("8") and sometimes fused with
  // its caption ("7 Checked if the amount"). Match both, or box 7 is
  // undetectable — and an undetectable box correctly returns null, not false,
  // which is right but less useful than simply finding it.
  const boxNo = (n) => items.filter(
    (i) => i.s === String(n) || new RegExp(`^${n}\\s`).test(i.s));

  const checked = (n) => {
    const anchors = boxNo(n);
    if (!anchors.length) return null;
    for (const m of marks) {
      // Every box number sharing this mark's row, ordered left to right.
      const row = [7, 8, 9, 10]
        .flatMap((k) => boxNo(k).map((a) => ({ k, x: a.x, y: a.y })))
        .filter((a) => Math.abs(a.y - m.y) <= 16 && a.x <= m.x)
        .sort((a, b) => a.x - b.x);
      if (row.length && row[row.length - 1].k === n) return true;
    }
    return false;
  };

  const halfTime = checked(8);
  const graduate = checked(9);
  const includesPrepayment = checked(7);

  // Year: the four-digit year printed on the form, sanity-bounded.
  const now = new Date().getUTCFullYear();
  const years = items.map((i) => i.s.match(/\b(20[0-4]\d)\b/)).filter(Boolean)
    .map((m) => Number(m[1])).filter((y) => y >= 2015 && y <= now);
  const year = years.length ? years.sort((a, b) => years.filter(v => v === b).length - years.filter(v => v === a).length)[0] : null;

  const ein = (items.find((i) => /^\d{2}-\d{7}$/.test(i.s)) || {}).s || null;
  // The student's name is not needed for any computation, so the bar for
  // reporting it is high: at least two words, and none of the form's own
  // boilerplate. Guessing wrong here is worse than saying nothing.
  const BOILER = /UNIVERSITY|COLLEGE|INSTITUTE|SERVICE|TREASURY|CORRECTED|STUDENT|FILER|COPY|INTERNAL|REVENUE|TUITION|STATEMENT|DEPARTMENT/;
  const name = (items.find((i) =>
    /^[A-Z][A-Z' .-]{6,}$/.test(i.s) && /\s/.test(i.s) && !BOILER.test(i.s)) || {}).s || null;

  return { year, ...found, halfTime, graduate, includesPrepayment, ein,
           studentName: name, confidence: conf, moneyCount: money.length };
}

/** True when the PDF has no text layer at all — a scan or a photo. */
export function looksScanned(items) {
  return items.length < 12;
}

export async function read1098T(file) {
  const items = await itemsOf(file);
  if (looksScanned(items)) {
    return {
      ok: false,
      reason: 'scanned',
      message:
        'This file has no text layer — it is a scan or a photo, so there is nothing to read. ' +
        'Download the 1098-T straight from the school portal as a PDF and it will read cleanly. ' +
        'Reading images would need OCR, which guesses at digits, and a misread digit in box 1 or ' +
        'box 5 is the one mistake this tool must not make.',
    };
  }
  const f = locate1098T(items);
  const problems = [];
  if (f.box1 === null) problems.push('box 1 (payments received) was not found');
  if (f.box5 === null) problems.push('box 5 (scholarships) was not found');
  if (f.year === null) problems.push('the tax year was not found');
  return { ok: problems.length === 0, fields: f, problems, itemCount: items.length };
}
