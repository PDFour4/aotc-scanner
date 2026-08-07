#!/usr/bin/env node
/**
 * run.mjs — drive the engine from a terminal.
 *
 * The same engine.js the app runs. Nothing re-implemented, nothing
 * approximated, no model in the loop: give it a scenario, it prints the
 * figures and what is still missing.
 *
 *   node run.mjs scenario.json
 *   node run.mjs --demo
 *
 * Its reason for existing is discipline. Any figure quoted about these
 * returns should come out of here, not out of anybody's head — that is how
 * the $202-that-was-really-$200 mistake happened, and it is exactly the class
 * of error the architecture is supposed to make impossible.
 */
import { readFileSync } from 'node:fs';
import * as E from './engine.js';

const DEMO = {
  claimant: { filingStatus: 'mfj', magi: { 2023: 120000, 2024: 125000 } },
  students: [
    { name: 'Older sibling', years: {
      2023: { box1: 31360, box5: 34541, wages: 0, priorUsed: 0, completed4: false },
      2024: { box1: 63893, box5: 65569, wages: 17189, taxAsFiled: 259, priorUsed: 0, completed4: false },
    } },
    { name: 'Younger sibling', years: {
      2024: { box1: 32533, box5: 38441, wages: 0, priorUsed: 0, completed4: false },
    } },
  ],
};

const arg = process.argv[2];
if (!arg) { console.error('usage: node run.mjs <scenario.json> | --demo'); process.exit(2); }
const cfg = arg === '--demo' ? DEMO : JSON.parse(readFileSync(arg, 'utf8'));

const $ = E.C.of;
let total = 0;

for (const s of cfg.students) {
  for (const [yStr, y] of Object.entries(s.years)) {
    const year = Number(yStr);
    const input = {
      year, box1: $(y.box1), box5: $(y.box5),
      courseMaterials: $(y.books) || 0, wages: $(y.wages) || 0,
      taxAsFiled: $(y.taxAsFiled) || 0,
      elect: y.elect == null ? null : $(y.elect),
      magi: $(cfg.claimant.magi[yStr]),
      filingStatus: cfg.claimant.filingStatus,
      priorYearsUsed: y.priorUsed ?? null,
      completedFourYears: y.completed4 ?? null,
    };
    const res = y.elect == null ? E.optimalElection(input) : E.computeYear(input);
    const rd = E.readiness(input, res);
    const dl = E.refundDeadline(year);

    console.log(`\n${s.name} — tax year ${year}`);
    console.log('  ' + '─'.repeat(52));
    if (!res || res.credit === null) {
      console.log('  cannot compute: ' + (res?.missing.join('; ') || 'inputs missing'));
    } else {
      const row = (k, v) => console.log(`  ${k.padEnd(34)}${String(v).padStart(14)}`);
      row('scholarship already taxable', E.C.fmt(res.naturalExcess, { cents: true }));
      row('elected into income', E.C.fmt(res.elect, { cents: true }));
      row('report on Schedule 1 line 8r', E.C.fmt(res.reportOnLine8r, { cents: true }));
      row('qualified expenses freed', E.C.fmt(res.qtre, { cents: true }));
      row('credit', E.C.fmt(res.credit, { cents: true }));
      row('  of which refundable', E.C.fmt(res.refundable, { cents: true }));
      row('extra tax to the student', E.C.fmt(res.additionalTax, { cents: true }));
      row('NET', E.C.fmt(res.net, { cents: true }));
      row('file by', `${E.fmtDate(dl)} (${E.daysUntil(dl)}d)`);
      total += res.net;
    }
    console.log(`  readiness: ${rd.label}`);
    for (const i of rd.items) console.log(`    [${i.severity}] ${i.what}`);
  }
}
console.log(`\n  TOTAL NET  ${E.C.fmt(total, { cents: true })}\n`);
