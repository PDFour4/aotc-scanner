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

/* ───────────────────────────────  the plan  ───────────────────────────── */

/**
 * Turn results into filing instructions. A number without a next action is a
 * fact, not a plan — and facts do not get money back.
 */
export function buildSteps(rows, { claimantName = 'your parents' } = {}) {
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
    push({
      who: r.studentName,
      head: `${r.year}: ${r.studentName} reports the scholarship as income`,
      form: r.returnFiled ? 'Form 1040-X (amended)' : 'Form 1040 (original — never filed)',
      deadline: r.deadline, days: r.days,
      body:
        `Report ${C.fmt(res.reportOnLine8r, { cents: true })} on Schedule 1, line 8r ("Scholarship and fellowship grants not reported on Form W-2"). Making part of the scholarship taxable is what frees an equal amount of tuition to support the credit. ` +
        (r.returnFiled
          ? 'On Form 1040-X, column A is what was originally reported, column B the change, column C the corrected figure. In Part III say plainly that the student is electing to include scholarship in income under Pub. 970 so that qualified tuition supports the credit.'
          : `This year was never filed, so it is an ORIGINAL Form 1040, not an amendment. ${
              res.mustFile === false
                ? 'The student was not even required to file — the dependent threshold is above this income — but file anyway: it is the document showing the scholarship was taken into income, which is what the claimant\'s credit rests on when the IRS matches it against the school\'s 1098-T. A zero-tax return filed late carries no penalty, since the penalty is a percentage of tax owed.'
                : 'The student was required to file for this year, so the return is owed regardless of the credit.'
            } Not filing does NOT block the credit: it lives on the claimant's return, and their deadline runs from when THEY filed.`) +
        ` Extra tax to the student: ${C.fmt(res.studentTax, { cents: true })}.`,
      cite: '26 U.S.C. 117(a)-(b); 25A(g)(2); Pub. 970 ch. 2',
    });
    push({
      who: 'Claimant',
      head: `${r.year}: ${claimantName} claim the credit`,
      form: 'Form 1040-X with Form 8863 attached',
      deadline: r.deadline, days: r.days,
      body: `Attach Form 8863 with a Part III for ${r.studentName}. You need the student's social security number and the school's employer identification number — both are on the Form 1098-T. The credit lands on Form 1040 line 29 (the refundable 40%) and Schedule 3 line 3 (the rest). Expected credit ${C.fmt(res.credit, { cents: true })}, of which ${C.fmt(res.refundable, { cents: true })} comes back even if no tax is owed. File this together with the student's return above so the two tell one story.`,
      cite: '26 U.S.C. 25A(g)(3); 25A(i)',
      blockedBy: `the ${r.year} student return`,
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
