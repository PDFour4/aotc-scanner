/**
 * engine.js — the deterministic tax engine.
 *
 * Pure functions, no DOM, no network, no storage. Everything the app shows is
 * computed here, in the browser, on the user's own device. Nothing is sent
 * anywhere — which is not just a privacy nicety: IRC 7216 makes it a
 * misdemeanour to *use* taxpayer information for any purpose other than
 * preparing the return, and the cheapest way to never do that is to never
 * hold it.
 *
 * Rules this file will not break:
 *   1. No estimate, no guess, no "close enough". Every number traces to a
 *      statute and is computed the way the statute says.
 *   2. Unknown is not zero. A missing input yields null, and null propagates;
 *      it never silently becomes 0 and turns into "not eligible".
 *   3. Money is integer cents. Floats do not touch a tax computation.
 *   4. Below $100,000 the IRS Tax Table is mandatory, and it charges the tax
 *      on the MIDPOINT of a $50 band — not on your exact taxable income.
 *      Using bracket arithmetic instead is the single most common error in
 *      automated tax software.
 *
 * Golden fixtures for every function live in tests.html and mirror the Python
 * test suite one-for-one, so the two implementations cannot drift apart.
 */

'use strict';

/** Bump on every release. The service worker keys its cache off this, so an
 *  old cached copy is discarded rather than served forever. */
export const VERSION = '1.3.0';

/* ────────────────────────────────  money  ─────────────────────────────── */

export const C = {
  /** dollars → integer cents */
  of(x) {
    if (x === null || x === undefined || x === '') return null;
    const n = typeof x === 'number' ? x : Number(String(x).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  },
  add(...xs) { return xs.reduce((a, b) => a + (b || 0), 0); },
  sub(a, b) { return (a || 0) - (b || 0); },
  /** multiply cents by a rate, rounding half up — the Form 1040 convention */
  rate(cents, r) { return Math.floor((cents || 0) * r + 0.5); },
  clampLow(c) { return (c || 0) < 0 ? 0 : (c || 0); },
  min(...xs) { return Math.min(...xs); },
  fmt(cents, { cents: withCents = false } = {}) {
    if (cents === null || cents === undefined) return '—';
    const neg = cents < 0;
    const v = Math.abs(cents) / 100;
    const s = v.toLocaleString('en-US', {
      style: 'currency', currency: 'USD',
      minimumFractionDigits: withCents ? 2 : 0,
      maximumFractionDigits: withCents ? 2 : 0,
    });
    return (neg ? '−' : '') + s;
  },
};

const $ = C.of;

/* ──────────────────────────────  parameters  ──────────────────────────── */

/**
 * IRC 25A dollar figures are STATUTORY and not inflation-adjusted: subsection
 * (h) — the inflation adjustment — was repealed by Pub. L. 116-260 sec.
 * 104(a)(2), and (d) was rewritten with fixed amounts, effective for tax
 * years beginning after 2020. So these hold for every covered year.
 */
export const AOTC = {
  firstTier: $(2000),          // 25A(b)(1)(A), at 100%
  secondTierTop: $(4000),      // 25A(b)(1)(B), 25% of the excess up to here
  secondTierRate: 0.25,
  maxPerStudent: $(2500),
  refundableRate: 0.40,        // 25A(i)
  maxYearsPerStudent: 4,       // 25A(b)(2)(A)
  phaseout: {                  // 25A(d)(1)
    single: { start: $(80000), band: $(10000) },
    hoh: { start: $(80000), band: $(10000) },
    mfj: { start: $(160000), band: $(20000) },
    qss: { start: $(160000), band: $(20000) },
    mfs: null,                 // 25A(g)(6) bars the credit outright
  },
};

/**
 * Year-scoped figures. `verified` marks whether the values were checked
 * against the year's Revenue Procedure. An unverified year still computes,
 * but the UI says so — a confident wrong answer is worse than a flagged one.
 */
export const YEARS = {
  2021: { verified: false, stdSingle: $(12550), depFloor: $(1100), depAddOn: $(350),
          brackets: { single: [[$(9950), .10], [$(40525), .12], [$(86375), .22], [Infinity, .24]] } },
  2022: { verified: false, stdSingle: $(12950), depFloor: $(1150), depAddOn: $(400),
          brackets: { single: [[$(10275), .10], [$(41775), .12], [$(89075), .22], [Infinity, .24]] } },
  2023: { verified: true, stdSingle: $(13850), depFloor: $(1250), depAddOn: $(400),
          brackets: { single: [[$(11000), .10], [$(44725), .12], [$(95375), .22], [Infinity, .24]] } },
  2024: { verified: true, stdSingle: $(14600), depFloor: $(1300), depAddOn: $(450),
          brackets: { single: [[$(11600), .10], [$(47150), .12], [$(100525), .22], [Infinity, .24]] } },
  2025: { verified: true, stdSingle: $(15750), depFloor: $(1350), depAddOn: $(450),
          brackets: { single: [[$(11925), .10], [$(48475), .12], [$(103350), .22], [Infinity, .24]] } },
  2026: { verified: false, stdSingle: $(16100), depFloor: $(1350), depAddOn: $(450),
          brackets: { single: [[$(12400), .10], [$(50400), .12], [$(105700), .22], [Infinity, .24]] },
          note: 'Verify against Rev. Proc. 2025-32 before relying on 2026 figures.' },
};

export const COVERED = Object.keys(YEARS).map(Number).sort();
export const FIRST_AOTC_YEAR = 2021;   // (d) rewritten effective after 2020

/* ─────────────────────────────  tax computation  ──────────────────────── */

/** How far a computed tax may sit from the published Tax Table. See taxOn(). */
export const TAX_TOLERANCE = $(2);

const TABLE_CEILING = $(100000);
const TABLE_BAND = $(50);

/**
 * Tax on taxable income. IRC 1, approximating the IRS Tax Table.
 *
 * Below $100,000 the Tax Table is mandatory and it taxes the MIDPOINT of the
 * $50 band your income falls in — so $5,308 is taxed as $5,325. Straight
 * bracket arithmetic gives $530.80 where the table says $533. TaxCalcBench
 * found that single mistake accounts for 15–20% of all failures when a
 * language model computes a return.
 *
 * BUT — and this is the honest part — the Tax Table is a **published lookup
 * table, not a formula**. The midpoint rule reproduces it closely and not
 * always exactly. Checked against two real filed returns:
 *
 *     2025, taxable $5,308 → filed $533 · this function $533  ✓
 *     2024, taxable $2,589 → filed $259 · this function $258  ✗ by $1
 *
 * No single rule reproduces both, so one of them departs from the pure
 * midpoint by a dollar. Until the actual table rows are loaded, treat any
 * figure from this function as ±TAX_TOLERANCE. That never changes whether a
 * year is worth filing — a $2 wobble against a $2,500 credit — but it must
 * not be presented as exact. Stating false precision about tax is how you
 * end up defending a number you cannot support.
 */
export function taxOn(taxableCents, year, status = 'single') {
  if (taxableCents === null) return null;
  const y = YEARS[year];
  if (!y) return null;
  if (taxableCents <= 0) return 0;

  const income = taxableCents < TABLE_CEILING
    ? Math.floor(taxableCents / TABLE_BAND) * TABLE_BAND + TABLE_BAND / 2
    : taxableCents;

  const brackets = y.brackets[status] || y.brackets.single;
  let tax = 0, prev = 0;
  for (const [top, rate] of brackets) {
    if (income <= prev) break;
    tax += C.rate(Math.min(income, top) - prev, rate);
    prev = top;
  }
  return Math.round(tax / 100) * 100;   // the table is stated in whole dollars
}

/** True when taxOn() used the Tax Table approximation rather than exact rates. */
export function taxIsApproximate(taxableCents) {
  return taxableCents !== null && taxableCents > 0 && taxableCents < TABLE_CEILING;
}

/**
 * IRC 63(c)(5): a dependent's standard deduction is the greater of a floor or
 * earned income plus a small add-on, capped at the regular amount.
 *
 * The load-bearing detail: **taxable scholarship counts as EARNED income**
 * for this test (Pub. 501). That is why a student can report thousands of
 * dollars of scholarship and still owe nothing — the deduction rises with it.
 */
export function dependentStandardDeduction(year, earnedCents) {
  const y = YEARS[year];
  if (!y || earnedCents === null) return null;
  return Math.min(y.stdSingle, Math.max(y.depFloor, earnedCents + y.depAddOn));
}

/** Is a dependent required to file at all? IRC 6012(a)(1). */
export function dependentMustFile(year, grossCents, earnedCents) {
  const t = dependentStandardDeduction(year, earnedCents);
  if (t === null || grossCents === null) return null;
  return grossCents > t;
}

/* ───────────────────────────────  IRC 25A  ────────────────────────────── */

/** 25A(b)(1): 100% of the first $2,000 + 25% of the next $2,000, cap $2,500. */
export function creditFromExpenses(qtreCents) {
  if (qtreCents === null) return null;
  const q = C.clampLow(qtreCents);
  const t1 = Math.min(q, AOTC.firstTier);
  const t2 = C.rate(C.clampLow(Math.min(q, AOTC.secondTierTop) - AOTC.firstTier),
                    AOTC.secondTierRate);
  return Math.min(t1 + t2, AOTC.maxPerStudent);
}

/** 25A(d)(1): ratable reduction over the MAGI band. */
export function applyPhaseout(creditCents, magiCents, status) {
  if (creditCents === null) return null;
  const p = AOTC.phaseout[status];
  if (p === undefined) return null;
  if (p === null) return 0;                    // MFS: 25A(g)(6)
  if (magiCents === null) return null;         // unknown ≠ under the threshold
  const excess = C.clampLow(magiCents - p.start);
  if (excess === 0) return creditCents;
  const frac = Math.min(1, excess / p.band);
  return C.clampLow(creditCents - C.rate(creditCents, frac));
}

/**
 * The whole manoeuvre, for one student in one year.
 *
 * Scholarships reduce qualified expenses under 25A(g)(2) *before* any credit
 * is computed, so a student whose aid covers tuition has zero qualified
 * expenses and gets nothing. Unless part of the scholarship is deliberately
 * taken into income — where the award's own terms permit it (Pub. 970;
 * Prop. Reg. 1.25A-5(c)(3)) — which frees an equal amount of tuition.
 *
 * `elect` is the extra scholarship moved into income beyond the amount that
 * was already taxable. Pass null to have the optimum chosen.
 */
export function computeYear(input) {
  const {
    year, box1, box5, courseMaterials = 0, wages = 0,
    elect = null, magi = null, filingStatus = 'single', taxAsFiled = 0,
    priorYearsUsed = null, completedFourYears = null,
    claimedAsDependent = null, kiddieTax = false,
  } = input;

  const out = {
    year, ok: false, reasons: [], missing: [],
    naturalExcess: null, elect: null, reportOnLine8r: null,
    qtre: null, credit: null, refundable: null,
    studentAgi: null, studentStdDed: null, studentTaxable: null,
    studentTax: null, additionalTax: null, mustFile: null, net: null,
    coverage: COVERED.includes(year) && year >= FIRST_AOTC_YEAR,
    verified: YEARS[year] ? YEARS[year].verified : false,
  };

  if (!out.coverage) {
    out.reasons.push({
      kind: 'out-of-scope',
      text: `Tax year ${year} is outside this tool's coverage (${FIRST_AOTC_YEAR}–${COVERED[COVERED.length - 1]}). ` +
            `Subsection (d) was rewritten effective for years after 2020 and the inflation adjustment in (h) was repealed, ` +
            `so earlier years used indexed thresholds this tool does not carry. It declines rather than applying the wrong figures.`,
      cite: 'Pub. L. 116-260 sec. 104(a)',
    });
    return out;
  }

  if (box1 === null || box5 === null) {
    out.missing.push('Form 1098-T box 1 and box 5');
    return out;
  }

  // Hard bars, before any arithmetic.
  if (filingStatus === 'mfs') {
    out.reasons.push({ kind: 'denied', text: 'Married filing separately bars the credit entirely.', cite: '26 U.S.C. 25A(g)(6)' });
    return out;
  }
  if (completedFourYears === true) {
    out.reasons.push({ kind: 'denied', text: 'The student had already completed the first 4 years of postsecondary education before this year began.', cite: '26 U.S.C. 25A(b)(2)(C)' });
    return out;
  }
  if (priorYearsUsed !== null && priorYearsUsed >= AOTC.maxYearsPerStudent) {
    out.reasons.push({ kind: 'denied', text: `The credit has already been claimed for this student in ${priorYearsUsed} prior years. The limit is 4, counting elections by any taxpayer.`, cite: '26 U.S.C. 25A(b)(2)(A)' });
    return out;
  }
  if (completedFourYears === null) out.missing.push('whether the student had finished 4 years of college before this year');
  if (priorYearsUsed === null) out.missing.push('how many prior years the credit was claimed for this student');

  // 25A(g)(2): scholarship in excess of qualified expenses is already taxable.
  const gross = C.add(box1, courseMaterials);
  out.naturalExcess = C.clampLow(C.sub(box5, box1));

  // How much extra to move into income. Only $4,000 of qualified expenses is
  // ever useful, so electing more is pure cost for no extra credit.
  const needed = C.clampLow(AOTC.secondTierTop - C.clampLow(C.sub(gross, box5)));
  out.elect = elect === null ? Math.min(needed, C.clampLow(C.sub(box5, out.naturalExcess))) : elect;
  out.reportOnLine8r = C.add(out.naturalExcess, out.elect);

  const taxFree = C.sub(box5, out.reportOnLine8r);
  out.qtre = C.clampLow(C.sub(gross, taxFree));

  const gray = creditFromExpenses(out.qtre);
  out.credit = applyPhaseout(gray, magi, filingStatus);
  if (out.credit === null) out.missing.push('modified adjusted gross income of whoever claims the credit');

  out.refundable = out.credit === null ? null
    : (kiddieTax ? 0 : C.rate(out.credit, AOTC.refundableRate));

  // The student's side of the ledger.
  out.studentAgi = C.add(wages, out.reportOnLine8r);
  out.studentStdDed = dependentStandardDeduction(year, out.studentAgi);
  out.studentTaxable = C.clampLow(C.sub(out.studentAgi, out.studentStdDed));
  out.studentTax = taxOn(out.studentTaxable, year, 'single');
  out.mustFile = dependentMustFile(year, out.studentAgi, out.studentAgi);

  // What the student actually pays OUT is the increase over what was already
  // paid on the return as filed -- not the whole recomputed tax. Getting this
  // wrong understates the net on every year that was already filed.
  out.additionalTax = C.clampLow(C.sub(out.studentTax, taxAsFiled || 0));

  out.net = out.credit === null ? null : C.sub(out.credit, out.additionalTax);
  out.ok = out.credit !== null && out.credit > 0;

  if (claimedAsDependent === true) {
    out.reasons.push({
      kind: 'note',
      text: 'Because the student is claimed as a dependent, the credit belongs to the claiming taxpayer, not the student. The student reports the scholarship; the claimant files Form 8863.',
      cite: '26 U.S.C. 25A(g)(3)',
    });
  }
  if (out.elect > needed) {
    out.reasons.push({
      kind: 'warn',
      text: `Only ${C.fmt(AOTC.secondTierTop)} of qualified expenses is ever useful. Electing ${C.fmt(out.elect)} instead of ${C.fmt(needed)} adds tax with no extra credit.`,
      cite: '26 U.S.C. 25A(b)(1)',
    });
  }
  if (courseMaterials === 0) {
    out.reasons.push({
      kind: 'hint',
      text: 'Required books, supplies and equipment count toward this credit and are almost never on a 1098-T. Adding them raises qualified expenses.',
      cite: '26 U.S.C. 25A(f)(1)(D)',
    });
  }
  return out;
}

/** Sweep the allocation to find the elect amount with the best net result. */
export function optimalElection(input) {
  let best = null;
  const cap = C.clampLow(C.sub(input.box5, C.clampLow(C.sub(input.box5, input.box1))));
  for (let e = 0; e <= Math.min(cap, $(12000)); e += $(50)) {
    const r = computeYear({ ...input, elect: e });
    if (r.net === null) continue;
    if (!best || r.net > best.net || (r.net === best.net && r.elect < best.elect)) best = r;
  }
  return best;
}

/* ──────────────────────────────  IRC 6511  ────────────────────────────── */

const DUE_MONTH = 3, DUE_DAY = 15;   // 15 April, month is 0-indexed

function nudgeWeekend(d) {
  const x = new Date(d.getTime());
  while (x.getUTCDay() === 0 || x.getUTCDay() === 6) x.setUTCDate(x.getUTCDate() + 1);
  return x;
}

export function statutoryDueDate(year) {
  return nudgeWeekend(new Date(Date.UTC(year + 1, DUE_MONTH, DUE_DAY)));
}

/**
 * The refund window: 3 years from filing or 2 from payment, whichever is
 * later. A return filed early is deemed filed on the due date (6513(a)), and
 * a deadline landing on a weekend rolls forward (7503).
 */
export function refundDeadline(year, filedOnISO = null) {
  const due = statutoryDueDate(year);
  let deemed = due;
  if (filedOnISO) {
    const f = new Date(filedOnISO + 'T00:00:00Z');
    if (!isNaN(f) && f > due) deemed = f;
  }
  const d = new Date(deemed.getTime());
  d.setUTCFullYear(d.getUTCFullYear() + 3);
  return nudgeWeekend(d);
}

export function daysUntil(dateObj, todayISO = null) {
  const today = todayISO ? new Date(todayISO + 'T00:00:00Z') : new Date();
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((dateObj.getTime() - t) / 86400000);
}

export function urgency(days) {
  if (days < 0) return { role: 'closed', icon: '✕', word: 'closed' };
  if (days <= 120) return { role: 'critical', icon: '!', word: 'closing soon' };
  if (days <= 365) return { role: 'warning', icon: '▲', word: 'within a year' };
  return { role: 'good', icon: '●', word: 'open' };
}


/* ─────────────────────── where to get it, where to send it ────────────── */

/**
 * Form URLs, mailing addresses and filing mechanics.
 *
 * All verified live on 10 August 2026. Two things here are worth knowing
 * before editing:
 *
 * 1. Prior-year forms live at /pub/irs-prior/{form}--{year}.pdf — note the
 *    DOUBLE hyphen. Current and non-year-specific forms live at /pub/irs-pdf/.
 *
 * 2. Form 1040-X is NOT year-specific: one current revision covers every year,
 *    with the year written into a blank field. But the Form 8863 attached to
 *    it MUST be that year's version. Getting this backwards is a common way to
 *    have an amendment bounced.
 *
 * The layout facts are versioned data, not hardcoded strings, for a reason —
 * see PART_EXPLANATION below.
 */
export const FORM_URL = {
  prior: (form, year) => `https://www.irs.gov/pub/irs-prior/${form}--${year}.pdf`,
  current: (form) => `https://www.irs.gov/pub/irs-pdf/${form}.pdf`,
};

/**
 * Which numbered Part of Form 1040-X holds the explanation of changes.
 *
 * Revision December 2025 RENUMBERED the form: Part I is now Dependents,
 * Part II is the Explanation of Changes, and Part III is Direct Deposit.
 * Before that revision the explanation was Part III.
 *
 * This is stored as dated data rather than a literal because a stale "write it
 * in Part III" instruction is now actively harmful: Part III is direct-deposit
 * details, which a paper filer must leave blank. Form layout drifts the same
 * way tax law does, and deserves the same treatment.
 */
export const PART_EXPLANATION = (asOf = new Date()) =>
  asOf >= new Date(Date.UTC(2025, 11, 1)) ? 'Part II' : 'Part III';

/**
 * Verified mailing addresses. Deliberately sparse: only what was actually
 * checked is here, and everything else falls through to the IRS lookup page.
 * A confidently wrong address sends a refund claim into a void.
 */
const AUSTIN_GROUP = ['AL', 'AR', 'FL', 'GA', 'LA', 'MS', 'OK', 'TX'];

export const WHERE_TO_FILE = {
  form1040: 'https://www.irs.gov/filing/where-to-file-addresses-for-taxpayers-and-tax-professionals-filing-form-1040',
  form1040x: 'https://www.irs.gov/filing/where-to-file-addresses-for-taxpayers-and-tax-professionals-filing-form-1040x',
};

export function mailingAddress(state, kind) {
  const st = (state || '').toUpperCase();
  if (kind === '1040x' && AUSTIN_GROUP.includes(st)) {
    return { lines: ['Department of the Treasury', 'Internal Revenue Service', 'Austin, TX 73301-0052'],
             note: 'Same address whether or not a payment is enclosed.', verified: '2026-08-10' };
  }
  if (kind === '1040' && st === 'TX') {
    return { lines: ['Department of the Treasury', 'Internal Revenue Service', 'Austin, TX 73301-0002'],
             note: 'This is the no-payment / refund address. A return WITH a payment goes to Charlotte, NC instead.',
             verified: '2026-08-10' };
  }
  return null;
}

/** Tax years the IRS e-file system accepts: the current year plus two prior. */
export function efileWindow(today = new Date()) {
  const y = today.getUTCFullYear();
  // The window rolls at the annual MeF cutover, historically somewhere between
  // mid-November and late December. Before the cutover the newest accepted
  // year is last year's; the exact 2026 date has not been announced.
  const newest = today.getUTCMonth() >= 11 ? y : y - 1;
  return { years: [newest, newest - 1, newest - 2], newest };
}

export const LINKS = {
  amendedStatus: 'https://www.irs.gov/filing/wheres-my-amended-return',
  freeTaxUsaPrior: 'https://www.freetaxusa.com/prior-year/',
  quickAlerts: 'https://www.irs.gov/e-file-providers/quickalerts-library',
};

/* ───────────────────────────────  the plan  ───────────────────────────── */

/**
 * Turn results into filing instructions. A number without a next action is a
 * fact, not a plan — and facts do not get money back.
 */
export function buildSteps(rows, { claimantName = 'your parents', state = '' } = {}) {
  const PART = PART_EXPLANATION();
  const win = efileWindow();
  const live = rows.filter(r => r.result.ok && r.result.net > 0 && r.days >= 0)
                   .sort((a, b) => a.days - b.days);
  const steps = [];
  const push = (s) => steps.push({ n: steps.length + 1, ...s });

  push({
    who: 'Either',
    head: 'Count the AOTC years already used, per student',
    body: 'The credit is available for at most 4 taxable years per student, and elections by ANY taxpayer count — so a year a parent claimed counts against the student. Separately, no credit is allowed for a year if the student had finished the first 4 years of college before that year began. Two different tests, routinely confused. Settle this before touching a form.',
    cite: '26 U.S.C. 25A(b)(2)(A) and (b)(2)(C)',
  });
  push({
    who: 'Claimant',
    head: `Check ${claimantName}' income for each year`,
    body: 'The credit phases out between $160,000 and $180,000 of modified AGI on a joint return, $80,000 to $90,000 otherwise, and is gone above the top of that band. A year over the ceiling is not worth amending.',
    cite: '26 U.S.C. 25A(d)(1)',
  });

  for (const r of live) {
    const res = r.result;
    const yr = r.year;
    push({
      who: r.studentName,
      head: `${r.year}: ${r.studentName} reports the scholarship as income`,
      form: r.returnFiled ? 'Form 1040-X (amended)' : 'Form 1040 (original — never filed)',
      deadline: r.deadline, days: r.days,
      body:
        `Report ${C.fmt(res.reportOnLine8r, { cents: true })} on Schedule 1, line 8r ("Scholarship and fellowship grants not reported on Form W-2"). Making part of the scholarship taxable is what frees an equal amount of tuition to support the credit. ` +
        (r.returnFiled
          ? `On Form 1040-X, column A is what was originally reported, column B the change, column C the corrected figure. In ${PART} — "Explanation of Changes" — say plainly that the student is electing to include scholarship in income under Pub. 970 so that qualified tuition supports the credit.`
          : `This year was never filed, so it is an ORIGINAL Form 1040, not an amendment. ${
              res.mustFile === false
                ? 'The student was not even required to file — the dependent threshold is above this income — but file anyway: it is the document showing the scholarship was taken into income, which is what the claimant\'s credit rests on when the IRS matches it against the school\'s 1098-T. A zero-tax return filed late carries no penalty, since the penalty is a percentage of tax owed.'
                : 'The student was required to file for this year, so the return is owed regardless of the credit.'
            } Not filing does NOT block the credit: it lives on the claimant's return, and their deadline runs from when THEY filed.`) +
        ` Extra tax to the student: ${C.fmt(res.studentTax, { cents: true })}.`,
      cite: '26 U.S.C. 117(a)-(b); 25A(g)(2); Pub. 970 ch. 2',
      links: r.returnFiled
        ? [{ label: 'Form 1040-X (current revision — one form, every year)', url: FORM_URL.current('f1040x') },
           { label: 'Form 1040-X instructions', url: FORM_URL.current('i1040x') },
           { label: `${yr} Schedule 1`, url: FORM_URL.prior('f1040s1', yr) }]
        : [{ label: `${yr} Form 1040`, url: FORM_URL.prior('f1040', yr) },
           { label: `${yr} Schedule 1`, url: FORM_URL.prior('f1040s1', yr) },
           { label: `${yr} Form 1040 instructions (tax table inside)`, url: FORM_URL.prior('i1040gi', yr) },
           { label: 'Prepare it free — FreeTaxUSA prior year', url: LINKS.freeTaxUsaPrior }],
      mail: mailingAddress(state, r.returnFiled ? '1040x' : '1040'),
      mailLookup: r.returnFiled ? WHERE_TO_FILE.form1040x : WHERE_TO_FILE.form1040,
      howNotes: r.returnFiled ? [
        `Write "${yr}" in the calendar-year box at the top — Form 1040-X is one current form used for every year.`,
        'Both spouses sign a joint amendment, by hand.',
      ] : [
        `The IRS e-file system currently accepts ${win.years.join(', ')}, so ${yr} is technically still in range — but consumer software almost universally refuses to e-file prior years, so plan on printing and mailing. A preparer with an EFIN can e-file it.`,
        "Sign in ink and date it with today's actual date, never backdated. A typed name is not a signature on paper.",
        'FreeTaxUSA prepares prior-year federal returns for $0. Texas has no state return, so there is nothing further to pay.',
      ],
    });
    push({
      who: 'Claimant',
      head: `${r.year}: ${claimantName} claim the credit`,
      form: 'Form 1040-X with Form 8863 attached',
      deadline: r.deadline, days: r.days,
      body: `Attach Form 8863 with a Part III for ${r.studentName}. You need the student's social security number and the school's employer identification number — both are on the Form 1098-T. The credit lands on Form 1040 line 29 (the refundable 40%) and Schedule 3 line 3 (the rest). Expected credit ${C.fmt(res.credit, { cents: true })}, of which ${C.fmt(res.refundable, { cents: true })} comes back even if no tax is owed. File this together with the student's return above so the two tell one story.`,
      cite: '26 U.S.C. 25A(g)(3); 25A(i)',
      blockedBy: `the ${r.year} student return`,
      links: [
        { label: 'Form 1040-X (current revision — one form, every year)', url: FORM_URL.current('f1040x') },
        { label: 'Form 1040-X instructions', url: FORM_URL.current('i1040x') },
        { label: `${yr} Form 8863 — must be this year's version`, url: FORM_URL.prior('f8863', yr) },
        { label: `${yr} Form 8863 instructions`, url: FORM_URL.prior('i8863', yr) },
      ],
      mail: mailingAddress(state, '1040x'),
      mailLookup: WHERE_TO_FILE.form1040x,
      howNotes: [
        `Put the explanation in ${PART} of Form 1040-X, "Explanation of Changes": failed to claim the American Opportunity Credit under IRC 25A for a qualifying student; Form 8863 attached. The December 2025 revision RENUMBERED this form — older guidance says Part III, which is now Direct Deposit and must be left blank on a paper filing.`,
        `Form 1040-X is not year-specific, but the Form 8863 attached to it must be the ${yr} version. Write "${yr}" in the calendar-year box.`,
        'Assemble attachments behind the corrected Form 1040 in Attachment Sequence order — the number is printed at the top right of each form.',
        'Do NOT attach the Form 1098-T. It is an information return you keep; the school already sent the IRS its copy.',
        `Form 1040-X can be e-filed for ${win.years.join(', ')}, so ${yr} is in range today. FreeTaxUSA charges roughly $18 per amended year.`,
        'Both spouses must sign a joint amendment, by hand, on paper.',
      ],
    });
  }

  if (live.length) {
    const first = live[0];
    push({
      who: 'Either',
      head: 'File the earliest year first, and file each pair together',
      deadline: first.deadline, days: first.days,
      body: `The ${first.year} window closes ${fmtDate(first.deadline)} and cannot be extended — a refund claim one day late is worth nothing. Send the student's return and the claimant's 1040-X in the same batch. Later years can follow at a calmer pace.`,
      cite: '26 U.S.C. 6511(a)',
    });
  }

  push({
    who: 'Either',
    head: 'Keep the evidence together',
    body: 'Per year, per student: the Form 1098-T, the school billing statement showing what was actually paid and when, the scholarship award letter, and receipts for required books. The award letter is the one nobody keeps and the one that matters most — the allocation only works if the award terms do not restrict the money to tuition.',
    cite: 'Prop. Reg. 1.25A-5(c)(3); Pub. 970',
  });
  push({
    who: 'Either',
    head: 'Then wait, and track it',
    body: 'Amended returns take roughly 8 to 16 weeks. Track at irs.gov/filing/wheres-my-amended-return with a social security number, date of birth and ZIP code. Do not send a duplicate because nothing shows for three weeks — that makes it slower, not faster.',
  });
  return steps;
}

export function fmtDate(d) {
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/* ─────────────────────────── how solid is this? ───────────────────────── */

/**
 * What is still missing, and how much it matters.
 *
 * A number without its own error bars invites more confidence than it has
 * earned. This turns "here is $2,500" into "here is $2,500, and here are the
 * four things that could move it."
 *
 * Severities:
 *   blocking  nothing can be computed until this is supplied
 *   material  the figure shown could change substantially, or be wiped out
 *   minor     the figure could shift by a small amount
 *
 * Note the last item. The scholarship award terms are the one input that
 * cannot be computed from anything — somebody has to read the letter. If the
 * award restricts the money to tuition, this entire approach is unavailable,
 * and no amount of arithmetic will discover that.
 */
export function readiness(input, res) {
  const items = [];
  const add = (severity, what, why, effect) => items.push({ severity, what, why, effect });

  if (input.box1 === null || input.box5 === null) {
    add('blocking', 'Form 1098-T boxes 1 and 5',
        'Everything starts from what the school reported.',
        'Nothing can be computed without them.');
  }
  if (res.credit === null && input.magi === null) {
    add('blocking', "The claimant's modified AGI for this year",
        'Line 11 of their Form 1040. The credit phases out over a $10,000 band ($20,000 joint).',
        'The credit could be the full amount or nothing at all.');
  }
  if (input.priorYearsUsed === null || input.priorYearsUsed === undefined) {
    add('material', 'How many years the credit was already claimed for this student',
        'Counting elections by ANY taxpayer, not only the claimant. 25A(b)(2)(A) caps it at four.',
        'A fifth year is worth $0 — the whole filing would be wasted.');
  }
  if (input.completedFourYears === null || input.completedFourYears === undefined) {
    add('material', 'Whether the student had finished four years of college before this year began',
        'A separate test from the four-year cap, and constantly confused with it. 25A(b)(2)(C).',
        'If yes, the credit is denied outright for this year.');
  }
  add('material', 'The scholarship award letter',
      'The election only works where the award terms do NOT restrict the money to tuition. Prop. Reg. 1.25A-5(c)(3).',
      'If the award is tuition-restricted, this approach is unavailable for that award. Nothing here can tell you — someone has to read it.');

  if (!input.courseMaterials) {
    const capped = res.qtre !== null && res.qtre >= AOTC.secondTierTop;
    add(capped ? 'minor' : 'material', 'Books, supplies and required equipment',
        'They count toward this credit and are almost never on a 1098-T. 25A(f)(1)(D).',
        capped
          ? 'Qualified expenses already exceed the $4,000 ceiling, so adding them changes nothing here.'
          : 'Qualified expenses are under $4,000, so every dollar of books raises the credit directly.');
  }
  if (!input.wages && input.wages !== 0) {
    add('material', "The student's W-2 wages for this year",
        'They set how much of the elected scholarship is actually taxed.',
        'Treated as $0 right now, which understates the tax cost if there were wages.');
  }
  if (input.taxAsFiled === 0 && res.studentTax > 0) {
    add('minor', 'Tax shown on the student return as originally filed',
        'Only the INCREASE over what was already paid counts against the credit.',
        'Left at $0, the net shown is conservative — the real figure is likely better.');
  }
  const y = YEARS[input.year];
  if (y && !y.verified) {
    add('minor', `Confirmation of the ${input.year} inflation figures`,
        y.note || 'The standard deduction and brackets for this year were not checked against its Revenue Procedure.',
        'The tax cost could move slightly.');
  }
  if (res.studentTaxable !== null && taxIsApproximate(res.studentTaxable)) {
    add('minor', 'The exact figure from the IRS Tax Table',
        'The table is a published lookup, not a formula. This reproduces it to about $2.',
        'The tax could differ by a dollar or two. It never changes whether a year is worth filing.');
  }

  const rank = { blocking: 0, material: 1, minor: 2 };
  items.sort((a, b) => rank[a.severity] - rank[b.severity]);

  const blocking = items.filter(i => i.severity === 'blocking').length;
  const material = items.filter(i => i.severity === 'material').length;
  const level = blocking ? 'blocked' : material > 2 ? 'rough' : material ? 'close' : 'solid';
  const label = {
    blocked: 'Not enough to compute yet',
    rough: 'Rough — several facts still open',
    close: 'Close — a few facts to confirm',
    solid: 'Solid — nothing material outstanding',
  }[level];
  return { level, label, items, blocking, material };
}

/* ────────────────── filling it in: the line-by-line answer key ────────── */

/**
 * Form line numbers, by year.
 *
 * These MOVE. The 2025 Form 1040 split line 12 into 12a/12b/12e; 2023 and 2024
 * share a layout. So this is dated data, like the rules and like the 1040-X
 * part numbering — never a hardcoded string.
 *
 * Every entry carries a NAME as well as a number, because the name is what
 * actually locates the box if a number ever drifts. A caption you can read off
 * the page beats a number you have to trust.
 */
const LINES = {
  2023: { wages: '1a', schedule1: '8', totalIncome: '9', adjustments: '10',
          agi: '11', stdDed: '12', taxable: '15', tax: '16', totalTax: '24',
          withheld: '25a', payments: '33', refund: '34', owed: '37',
          dependentBox: 'the "Someone can claim: You as a dependent" box, top right' },
  2024: { wages: '1a', schedule1: '8', totalIncome: '9', adjustments: '10',
          agi: '11', stdDed: '12', taxable: '15', tax: '16', totalTax: '24',
          withheld: '25a', payments: '33', refund: '34', owed: '37',
          dependentBox: 'the "Someone can claim: You as a dependent" box, top right' },
  2025: { wages: '1a', schedule1: '8', totalIncome: '9', adjustments: '10',
          agi: '11a', stdDed: '12e', taxable: '15', tax: '16', totalTax: '24',
          withheld: '25a', payments: '33', refund: '34', owed: '37',
          dependentBox: 'line 12a, "Someone can claim: You as a dependent"' },
};

/**
 * What the finished return should say, line by line.
 *
 * This is the answer to "the software is asking me things and I do not know
 * what to type." Whatever screens a given product puts in front of you, and
 * whatever it calls them, the finished return has to come out matching this.
 * Check the PDF preview against it before filing and you cannot be far wrong.
 */
export function returnSheet(input, res, { year } = {}) {
  const y = year || input.year;
  const L = LINES[y] || LINES[2024];
  if (!res || res.reportOnLine8r === null) return null;

  const wages = input.wages || 0;
  const sch1 = res.reportOnLine8r;

  return {
    year: y,
    layoutVerified: !!LINES[y],
    schedule1: [
      { line: '8r', name: 'Scholarship and fellowship grants not reported on Form W-2',
        value: sch1, note: 'This is the entry the whole thing turns on.' },
      { line: '9', name: 'Total other income — add lines 8a through 8z', value: sch1 },
      { line: '10', name: 'Combine lines 1 through 7 and 9', value: sch1,
        note: `Carries to Form 1040 line ${L.schedule1}.` },
    ],
    form1040: [
      { line: L.wages, name: 'Total amount from Form(s) W-2, box 1', value: wages,
        note: wages === 0 ? 'Leave blank or zero — no W-2 for this year.' : null },
      { line: L.schedule1, name: 'Additional income from Schedule 1, line 10', value: sch1 },
      { line: L.totalIncome, name: 'Total income', value: C.add(wages, sch1) },
      { line: L.adjustments, name: 'Adjustments to income (Schedule 1, line 26)', value: 0 },
      { line: L.agi, name: 'Adjusted gross income', value: res.studentAgi },
      { line: L.stdDed, name: 'Standard deduction', value: res.studentStdDed,
        note: `Limited because the student is claimed as a dependent — earned income plus the year's add-on, capped. Taxable scholarship counts as EARNED income here, which is why it rises with the amount reported. IRC 63(c)(5).` },
      { line: L.taxable, name: 'Taxable income', value: res.studentTaxable },
      { line: L.tax, name: 'Tax', value: res.studentTax,
        note: res.studentTax === 0 ? 'Zero, so no penalty for filing late.' : 'From the IRS Tax Table.' },
      { line: L.totalTax, name: 'Total tax', value: res.studentTax },
      { line: L.withheld, name: 'Federal income tax withheld from Form(s) W-2', value: 0 },
      { line: L.payments, name: 'Total payments', value: 0 },
      { line: res.studentTax > 0 ? L.owed : L.refund,
        name: res.studentTax > 0 ? 'Amount you owe' : 'Amount overpaid',
        value: res.studentTax },
    ],
    mustCheck: [
      `Tick ${L.dependentBox}. This is what limits the standard deduction — leave it unticked and the return is wrong in the taxpayer's favour, which is the kind of wrong that gets noticed.`,
      'Filing status: Single.',
      'Do NOT claim an education credit on this return. The student is a dependent, so the credit belongs to whoever claims them. IRC 25A(g)(3).',
    ],
    skip: [
      'Interest income (1099-INT)', 'Dividends (1099-DIV)',
      'Unemployment (1099-G)', 'Social Security (SSA-1099)',
      'Retirement income (1099-R)', 'State tax refund (1099-G)',
      'Stocks and investments sold (1099-B)', 'Capital loss carryovers',
      'Self-employment / business income', 'Rental income',
    ],
  };
}

/**
 * Where the entry lives in the consumer products, where that is documented.
 *
 * Kept short and few on purpose. Vendor menus are renamed constantly, so this
 * is a pointer, not a script — the answer key above is the thing that stays
 * true. Verified 10 August 2026.
 */
export const SOFTWARE_HINTS = [
  { product: 'FreeTaxUSA',
    path: 'Income → Uncommon Income → Other Income → "Other Sources of Income"',
    note: 'That is the route for taxable scholarship with no W-2. There is also a 1098-T route under Deductions/Credits → College Tuition (1098-T), but on a DEPENDENT student\'s own return that path is about the credit, which this student cannot take — so the Other Income route is the cleaner one here.',
    url: 'https://www.freetaxusa.com/answer/3576/Scholarships-and-Grants/' },
];
