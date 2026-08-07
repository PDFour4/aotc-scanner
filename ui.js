/**
 * ui.js — the application shell.
 *
 * Two rendering passes, deliberately separate:
 *
 *   renderStructure()  rebuilds the form controls. Runs only when the SHAPE of
 *                      the data changes — a student or a year added or removed.
 *   recompute()        recalculates and repaints every derived figure. Runs on
 *                      every keystroke.
 *
 * Splitting them is what lets the numbers update live without the input you
 * are typing into being destroyed underneath you.
 */

import * as E from './engine.js';
import { read1098T } from './extract.js';

const $ = (s, r = document) => r.querySelector(s);
const el = (t, a = {}, ...kids) => {
  const n = document.createElement(t);
  for (const [k, v] of Object.entries(a)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : String(c));
  return n;
};

/* ─────────────────────────────── storage ──────────────────────────────── */

const KEY = 'aotc-scanner-v1';

/** localStorage may be unavailable (private mode, embedded frames, some
 *  sandboxes). Fall back to memory rather than breaking the whole app. */
const store = (() => {
  let ok = true;
  try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); }
  catch { ok = false; }
  let mem = null;
  return {
    persistent: ok,
    read() {
      try { return ok ? JSON.parse(localStorage.getItem(KEY) || 'null') : mem; }
      catch { return null; }
    },
    write(v) {
      mem = v;
      if (ok) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* full */ } }
    },
    clear() { mem = null; if (ok) { try { localStorage.removeItem(KEY); } catch { /**/ } } },
  };
})();

/* ──────────────────────────────── state ───────────────────────────────── */

let uid = 1;
const blankYear = () => ({
  box1: '', box5: '', books: '', wages: '',
  priorUsed: '', filed: false, completed4: false, elect: '', taxAsFiled: '',
});
const blankStudent = (name = '') => ({
  id: uid++, name, dependent: true, years: {},
});

let state = store.read() || {
  v: 1,
  claimant: { name: 'my parents', filingStatus: 'mfj', magi: {} },
  students: [blankStudent()],
  done: {},
};
if (state.students?.length) uid = Math.max(...state.students.map(s => s.id)) + 1;

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  const badge = $('#saveState');
  badge.textContent = 'saving…';
  saveTimer = setTimeout(() => {
    store.write(state);
    badge.textContent = store.persistent ? 'saved on this device' : 'this session only';
  }, 350);
}

/* ─────────────────────────────── the maths ────────────────────────────── */

function rows() {
  const out = [];
  for (const s of state.students) {
    for (const [yStr, y] of Object.entries(s.years)) {
      const year = Number(yStr);
      const input = {
        year,
        box1: E.C.of(y.box1), box5: E.C.of(y.box5),
        courseMaterials: E.C.of(y.books) || 0,
        wages: E.C.of(y.wages) || 0,
        elect: y.elect === '' ? null : E.C.of(y.elect),
        magi: E.C.of(state.claimant.magi[yStr]),
        filingStatus: state.claimant.filingStatus,
        taxAsFiled: E.C.of(y.taxAsFiled) || 0,
        priorYearsUsed: y.priorUsed === '' ? null : Number(y.priorUsed),
        completedFourYears: y.completed4 ? true : (y.priorUsed === '' ? null : false),
        claimedAsDependent: s.dependent,
      };
      const auto = y.elect === '' && input.box1 !== null && input.box5 !== null
        ? E.optimalElection(input) : null;
      const result = auto || E.computeYear(input);
      const deadline = E.refundDeadline(year);
      out.push({
        studentId: s.id, studentName: s.name || 'Unnamed student',
        year, input, result, deadline, days: E.daysUntil(deadline),
        returnFiled: y.filed,
        readiness: E.readiness(input, result),
      });
    }
  }
  return out.sort((a, b) => a.days - b.days || a.year - b.year);
}

/* ─────────────────────────────── rendering ────────────────────────────── */

function bind(obj, key, node, { number = false } = {}) {
  node.value = obj[key] ?? '';
  node.addEventListener('input', () => {
    obj[key] = number && node.value !== '' ? node.value : node.value;
    save(); recompute();
  });
  return node;
}

function field(labelText, hint, input) {
  const isMoney = input.dataset && input.dataset.money;
  const control = isMoney
    ? el('div', { class: 'money-wrap' }, el('span', { class: 'pfx' }, '$'), input)
    : input;
  return el('div', {},
    el('label', {}, labelText, hint ? el('span', { class: 'hint' }, ' · ' + hint) : null),
    control);
}

function money(obj, key, ph = '0') {
  const i = el('input', { type: 'number', step: '1', min: '0', placeholder: ph, inputmode: 'decimal' });
  i.dataset.money = '1';
  return bind(obj, key, i, { number: true });
}

function renderClaimant() {
  const c = state.claimant;
  const host = $('#claimant');
  host.textContent = '';

  const name = bind(c, 'name', el('input', { type: 'text', placeholder: 'my parents' }));
  const status = el('select', {},
    ...[['mfj', 'Married filing jointly'], ['single', 'Single'], ['hoh', 'Head of household'],
        ['qss', 'Qualifying surviving spouse'], ['mfs', 'Married filing separately']]
      .map(([v, t]) => el('option', { value: v, selected: c.filingStatus === v }, t)));
  status.addEventListener('change', () => { c.filingStatus = status.value; save(); recompute(); });

  host.append(el('div', { class: 'grid g2' },
    field('Who claims the students', 'appears in the instructions', name),
    field('Their filing status', 'sets the phase-out band', status)));

  const years = [...new Set(state.students.flatMap(s => Object.keys(s.years)))].sort();
  if (years.length) {
    const g = el('div', { class: 'grid g4', style: 'margin-top:14px' });
    for (const y of years) {
      g.append(field(`${y} modified AGI`, null, money(c.magi, y, '—')));
    }
    host.append(g);
    host.append(el('p', { class: 'muted-sm', style: 'margin:10px 0 0' },
      'Line 11 of their Form 1040 for each year. The credit phases out from $160,000 to $180,000 joint, $80,000 to $90,000 otherwise.'));
  }
  if (c.filingStatus === 'mfs') {
    host.append(el('p', { class: 'why deny' }, 'Married filing separately bars the credit entirely.',
      el('cite', {}, '26 U.S.C. 25A(g)(6)')));
  }
}

function renderStudents() {
  const host = $('#students');
  host.textContent = '';

  state.students.forEach((s, idx) => {
    const box = el('div', { class: 'student' });

    const nameI = bind(s, 'name', el('input', { type: 'text', placeholder: 'Student name' }));
    nameI.addEventListener('input', () => { renderClaimant(); });
    const dep = el('input', { type: 'checkbox' });
    dep.checked = s.dependent;
    dep.addEventListener('change', () => { s.dependent = dep.checked; save(); recompute(); });

    box.append(el('div', { class: 'student-head' }, nameI,
      state.students.length > 1
        ? el('button', {
            class: 'ghost icon', type: 'button', title: 'Remove this student',
            onclick: () => { state.students.splice(idx, 1); save(); renderStructure(); },
          }, '✕')
        : null));

    box.append(el('label', { class: 'check' }, dep,
      el('span', {}, 'Claimed as a dependent on someone else\'s return')));
    if (s.dependent) {
      box.append(el('p', { class: 'why' },
        'Then the credit belongs to whoever claims them, not to the student. The student reports the scholarship; the claimant files Form 8863.',
        el('cite', {}, '26 U.S.C. 25A(g)(3)')));
    }

    box.append(dropZone(s));

    const yearsUsed = Object.keys(s.years).map(Number).sort();
    for (const y of yearsUsed) box.append(renderYear(s, y));

    const avail = E.COVERED.filter(y => !(y in s.years));
    if (avail.length) {
      const sel = el('select', { style: 'max-width:130px' },
        el('option', { value: '' }, '+ Add a year'),
        ...avail.map(y => el('option', { value: y }, y)));
      sel.addEventListener('change', () => {
        if (!sel.value) return;
        s.years[sel.value] = blankYear();
        save(); renderStructure();
      });
      box.append(el('div', { style: 'margin-top:16px' }, sel));
    }
    host.append(box);
  });
}

/**
 * Drop a 1098-T in. It is read in this browser — pdf.js against the PDF's own
 * text layer, no OCR and no network — and the values are PROPOSED, never
 * applied. Box 1 and box 5 decide the whole credit; a parser is a heuristic,
 * and a wrong digit accepted silently would be worse than typing it by hand,
 * because it would look effortless.
 */
function dropZone(s) {
  const zone = el('div', { class: 'drop' });
  const input = el('input', { type: 'file', accept: 'application/pdf', hidden: true });
  const label = el('p', { class: 'drop-label' },
    'Drop a Form 1098-T PDF here, or ',
    el('button', { class: 'linky', type: 'button', onclick: () => input.click() }, 'choose a file'));
  const note = el('p', { class: 'drop-note' },
    'Read on this device. Nothing is uploaded. Download it from the school portal as a PDF — a photo or scan has no text to read.');
  const result = el('div');
  zone.append(input, label, note, result);

  const handle = async (file) => {
    if (!file) return;
    result.textContent = '';
    result.append(el('p', { class: 'drop-note' }, 'Reading ' + file.name + '…'));
    let r;
    try { r = await read1098T(file); }
    catch (err) { r = { ok: false, message: 'Could not read that PDF: ' + err.message }; }
    result.textContent = '';
    result.append(reviewCard(s, r));
  };
  input.addEventListener('change', () => handle(input.files[0]));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); zone.classList.remove('over');
    handle(e.dataTransfer.files[0]);
  });
  return zone;
}

function reviewCard(s, r) {
  if (!r.ok && r.reason === 'scanned') {
    return el('p', { class: 'why deny' }, r.message);
  }
  const f = r.fields || {};
  const card = el('div', { class: 'review' });
  card.append(el('p', { class: 'review-head' }, 'Found in that file — check these before applying'));

  const rowsOut = [
    ['Tax year', f.year, 'high'],
    ['Box 1 · payments received', f.box1 === null ? null : E.C.fmt(E.C.of(f.box1)), f.confidence?.box1],
    ['Box 5 · scholarships or grants', f.box5 === null ? null : E.C.fmt(E.C.of(f.box5)), f.confidence?.box5],
    ['Box 8 · at least half-time', f.halfTime === null ? null : (f.halfTime ? 'yes' : 'no'), 'high'],
    ['Box 9 · graduate student', f.graduate === null ? null : (f.graduate ? 'yes' : 'no'), 'high'],
    ['School EIN', f.ein, 'high'],
  ];
  for (const [k, v, conf] of rowsOut) {
    card.append(el('div', { class: 'kv' }, el('span', {}, k),
      el('span', {}, v === null || v === undefined ? 'not found' : String(v))));
    void conf;
  }
  for (const p of (r.problems || [])) {
    card.append(el('p', { class: 'why deny' }, 'Could not find ' + p + ' — type it in below.'));
  }
  if (f.graduate) {
    card.append(el('p', { class: 'why warn' },
      'Box 9 is ticked: a graduate student is not eligible for this credit, only for the Lifetime Learning Credit.',
      el('cite', {}, '26 U.S.C. 25A(b)(3)')));
  }

  const canApply = f.year && f.box1 !== null && f.box5 !== null;
  card.append(el('div', { class: 'review-actions' },
    canApply
      ? el('button', { class: 'primary', type: 'button', onclick: () => {
          const y = s.years[f.year] || blankYear();
          y.box1 = f.box1; y.box5 = f.box5;
          if (f.year in s.years === false) s.years[f.year] = y;
          save(); renderStructure();
        } }, `Use these for ${f.year}`)
      : el('span', { class: 'muted-sm' }, 'Not enough was found to fill a year automatically.'),
    el('span', { class: 'muted-sm' }, 'Always compare against the paper form.')));
  return card;
}

function renderYear(s, year) {
  const y = s.years[year];
  const wrap = el('div', { class: 'yr', 'data-y': `${s.id}-${year}` });

  const meta = E.YEARS[year];
  wrap.append(el('div', { class: 'yr-head' },
    el('div', { class: 'yr-title' }, `Tax year ${year}`,
      el('span', { id: `conf-${s.id}-${year}` }),
      meta && !meta.verified
        ? el('span', { class: 'chip warning' }, el('span', { class: 'ic' }, '▲'), 'figures unverified')
        : null),
    el('button', {
      class: 'ghost icon', type: 'button', title: 'Remove this year',
      onclick: () => { delete s.years[year]; save(); renderStructure(); },
    }, '✕')));

  wrap.append(el('div', { class: 'grid g4' },
    field('1098-T box 1', 'tuition paid', money(y, 'box1')),
    field('1098-T box 5', 'scholarships', money(y, 'box5')),
    field('Books & supplies', 'not on the 1098-T', money(y, 'books')),
    field('Student W-2 wages', 'that year', money(y, 'wages'))));

  const prior = bind(y, 'priorUsed',
    el('input', { type: 'number', min: '0', max: '4', placeholder: '0' }), { number: true });
  const elect = bind(y, 'elect',
    el('input', { type: 'number', min: '0', placeholder: 'auto — best result' }), { number: true });
  elect.dataset.money = '1';

  const filed = el('input', { type: 'checkbox' });
  filed.checked = y.filed;
  filed.addEventListener('change', () => { y.filed = filed.checked; save(); renderStructure(); });
  const c4 = el('input', { type: 'checkbox' });
  c4.checked = y.completed4;
  c4.addEventListener('change', () => { y.completed4 = c4.checked; save(); recompute(); });

  wrap.append(el('div', { class: 'grid g2', style: 'margin-top:12px' },
    field('AOTC years already used', 'by anyone, before this year', prior),
    field('Scholarship moved into income', 'leave blank to optimise', elect)));

  wrap.append(el('div', { class: 'grid g2' },
    el('label', { class: 'check' }, filed, el('span', {}, `The student filed a ${year} return`)),
    el('label', { class: 'check' }, c4, el('span', {}, 'Had finished 4 years of college'))));

  if (y.filed) {
    const paid = bind(y, 'taxAsFiled',
      el('input', { type: 'number', min: '0', placeholder: '0' }), { number: true });
    paid.dataset.money = '1';
    wrap.append(el('div', { class: 'grid g2' },
      field(`Tax on the ${year} return as filed`, 'Form 1040 line 24 — so only the INCREASE counts against the credit', paid)));
  }

  wrap.append(el('div', { class: 'yr-out', id: `out-${s.id}-${year}` }));
  return wrap;
}

/* ───────────────────────────── derived paint ──────────────────────────── */

function paintYearOutputs(all) {
  for (const r of all) {
    const conf = document.getElementById(`conf-${r.studentId}-${r.year}`);
    if (conf) {
      conf.textContent = '';
      conf.append(el('span', { class: `chip ${CONF[r.readiness.level]}` },
        el('span', { class: 'ic' }, CONF_ICON[r.readiness.level]), r.readiness.label));
    }
    const host = document.getElementById(`out-${r.studentId}-${r.year}`);
    if (!host) continue;
    host.textContent = '';
    const res = r.result;

    if (res.reasons.some(x => x.kind === 'denied')) {
      for (const x of res.reasons.filter(y => y.kind === 'denied')) {
        host.append(el('p', { class: 'why deny', style: 'margin:0' }, x.text,
          x.cite ? el('cite', {}, x.cite) : null));
      }
      continue;
    }
    if (res.credit === null) {
      const need = res.missing.length ? res.missing : ['the 1098-T figures'];
      host.append(el('p', { class: 'muted-sm', style: 'margin:0' },
        'Still needed: ' + need.join('; ') + '.'));
      continue;
    }

    const u = E.urgency(r.days);
    host.append(
      kv('Scholarship already taxable', E.C.fmt(res.naturalExcess, { cents: true })),
      kv('Moved into income to free tuition', E.C.fmt(res.elect, { cents: true })),
      kv('Report on Schedule 1, line 8r', E.C.fmt(res.reportOnLine8r, { cents: true })),
      kv('Qualified expenses freed', E.C.fmt(res.qtre, { cents: true })),
      kv('Credit', E.C.fmt(res.credit, { cents: true })),
      kv('… of which refundable', E.C.fmt(res.refundable, { cents: true })),
      kv('Student tax on the corrected return',
         E.C.fmt(res.studentTax, { cents: true }) +
         (E.taxIsApproximate(res.studentTaxable) ? ' ±2' : '')),
      kv('Extra tax actually paid', E.C.fmt(res.additionalTax, { cents: true })),
      el('div', { class: 'kv total' }, el('span', {}, 'Net'),
        el('span', {}, E.C.fmt(res.net, { cents: true }))),
      el('p', { class: 'muted-sm', style: 'margin:8px 0 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center' },
        el('span', { class: `chip ${u.role}` }, el('span', { class: 'ic' }, u.icon),
          `file by ${E.fmtDate(r.deadline)}`),
        r.days >= 0 ? `${r.days.toLocaleString()} days` : 'window has closed',
        res.mustFile === false ? ' · student not required to file that year' : ''),
    );
    if (E.taxIsApproximate(res.studentTaxable)) {
      host.append(el('p', { class: 'why' },
        'Tax below $100,000 comes from the IRS Tax Table, which is a published lookup rather than a formula. This reproduces it to within about $2. That never changes whether a year is worth filing, but the exact dollar should come off the real table.',
        el('cite', {}, '26 U.S.C. 1; Form 1040 instructions, Tax Table')));
    }
    for (const x of res.reasons.filter(y => y.kind === 'warn' || y.kind === 'hint')) {
      host.append(el('p', { class: 'why' + (x.kind === 'warn' ? ' warn' : '') }, x.text,
        x.cite ? el('cite', {}, x.cite) : null));
    }
    host.append(readinessPanel(r));
  }
}

const CONF = { blocked: 'critical', rough: 'critical', close: 'warning', solid: 'good' };
const CONF_ICON = { blocked: '✕', rough: '!', close: '▲', solid: '●' };

function readinessPanel(r) {
  const rd = r.readiness;
  const d = el('details', { class: 'ready' });
  const n = rd.items.length;
  d.append(el('summary', {},
    n ? `What would sharpen this — ${n} item${n === 1 ? '' : 's'}` : 'Nothing material outstanding'));
  const body = el('div', { class: 'ready-body' });
  for (const i of rd.items) {
    body.append(el('div', { class: `ready-item ${i.severity}` },
      el('p', { class: 'ready-what' },
        el('span', { class: `sev ${i.severity}` }, i.severity),
        i.what),
      el('p', { class: 'ready-why' }, i.why),
      el('p', { class: 'ready-eff' }, i.effect)));
  }
  d.append(body);
  return d;
}
const kv = (k, v) => el('div', { class: 'kv' }, el('span', {}, k), el('span', {}, v));

function paintSummary(all) {
  const live = all.filter(r => r.result.ok && r.result.net > 0 && r.days >= 0);
  const host = $('#summary');
  host.textContent = '';

  if (!live.length) {
    host.append(el('div', { class: 'card empty' },
      el('p', {}, all.length
        ? 'No recoverable credit yet on what has been entered. Fill in the 1098-T boxes and the claimant\'s income and this fills in as you type.'
        : 'Add a student and a tax year below. Everything computes as you type, on this device.')));
    $('#resultsSection').hidden = true;
    $('#planSection').hidden = true;
    return;
  }

  const total = live.reduce((a, r) => a + r.result.net, 0);
  const soonest = live[0];
  const u = E.urgency(soonest.days);

  host.append(el('div', { class: 'tiles' },
    el('div', { class: 'card' },
      el('p', { class: 'tile-label' }, 'Recoverable in total'),
      el('p', { class: 'hero' }, E.C.fmt(total)),
      el('p', { class: 'hero-note' }, 'After the extra tax each student pays. The credits themselves come to ' +
        E.C.fmt(live.reduce((a, r) => a + r.result.credit, 0)) + '.')),
    el('div', { class: 'card' },
      el('p', { class: 'tile-label' }, 'Nearest deadline'),
      el('p', { class: 'tile-val' }, soonest.days.toLocaleString() + ' days'),
      el('p', { class: 'tile-note' }, `${soonest.year} · ${E.fmtDate(soonest.deadline)}`),
      el('p', { style: 'margin:8px 0 0' },
        el('span', { class: `chip ${u.role}` }, el('span', { class: 'ic' }, u.icon), u.word))),
    el('div', { class: 'card' },
      el('p', { class: 'tile-label' }, 'Returns to file'),
      el('p', { class: 'tile-val' }, String(live.length * 2)),
      el('p', { class: 'tile-note' }, `${live.length} year(s) — each needs a pair`))));

  $('#resultsSection').hidden = false;
  $('#planSection').hidden = false;
  paintChart(live);
  paintTable(live);
  paintSteps(live);
}

function paintChart(live) {
  const host = $('#chart');
  host.textContent = '';
  const peak = Math.max(...live.map(r => r.result.net), 1);
  for (const r of live) {
    const u = E.urgency(r.days);
    const pct = Math.max(2, 100 * r.result.net / peak);
    const bar = el('div', { class: 'bar' });
    const outer = el('div', {
      class: 'bar-outer',
      'data-tip': `${r.studentName}, ${r.year}. Credit ${E.C.fmt(r.result.credit, { cents: true })}, ` +
        `extra tax ${E.C.fmt(r.result.additionalTax, { cents: true })}, net ${E.C.fmt(r.result.net, { cents: true })}. ` +
        `File by ${E.fmtDate(r.deadline)}.`,
    }, bar);
    host.append(el('div', {},
      el('div', { class: 'row-label' },
        el('span', {}, el('span', { class: 'dot' }), `${r.studentName} · ${r.year}`),
        el('span', { class: `chip ${u.role}` }, el('span', { class: 'ic' }, u.icon),
          E.fmtDate(r.deadline))),
      el('div', { class: 'track' }, outer,
        el('span', { class: 'bar-val' }, E.C.fmt(r.result.net)))));
    requestAnimationFrame(() => { bar.style.width = pct + '%'; });
  }
  host.append(el('div', { class: 'axis' }, el('span', {}, '$0'),
    el('span', {}, E.C.fmt(peak))));
}

function paintTable(live) {
  const host = $('#tableWrap');
  host.textContent = '';
  const total = live.reduce((a, r) => a + r.result.net, 0);
  host.append(el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, 'Year'), el('th', {}, 'Student'),
      el('th', { class: 'num' }, 'Credit'), el('th', { class: 'num' }, 'Extra tax'),
      el('th', { class: 'num' }, 'Net'), el('th', {}, 'File by'))),
    el('tbody', {}, ...live.map(r => el('tr', {},
      el('td', {}, String(r.year)), el('td', {}, r.studentName),
      el('td', { class: 'num' }, E.C.fmt(r.result.credit, { cents: true })),
      el('td', { class: 'num' }, E.C.fmt(r.result.additionalTax, { cents: true })),
      el('td', { class: 'num' }, E.C.fmt(r.result.net, { cents: true })),
      el('td', {}, E.fmtDate(r.deadline))))),
    el('tfoot', {}, el('tr', {},
      el('td', { colspan: '4' }, 'Total'),
      el('td', { class: 'num' }, E.C.fmt(total, { cents: true })), el('td', {})))));
}

function paintSteps(live) {
  const steps = E.buildSteps(live, { claimantName: state.claimant.name || 'your parents' });
  const host = $('#steps');
  host.textContent = '';
  for (const s of steps) {
    const tick = el('input', { class: 'tick', type: 'checkbox', 'aria-label': `Mark step ${s.n} done` });
    tick.checked = !!state.done[s.head];
    const card = el('div', { class: 'step' + (tick.checked ? ' done' : '') });
    tick.addEventListener('change', () => {
      state.done[s.head] = tick.checked;
      card.classList.toggle('done', tick.checked);
      save(); paintProgress(steps);
    });
    const meta = el('div', { class: 'meta' },
      el('span', { class: 'tag', html: `Who: <b>${escapeHtml(s.who)}</b>` }),
      s.form ? el('span', { class: 'tag', html: `Form: <b>${escapeHtml(s.form)}</b>` }) : null);
    if (s.deadline) {
      const u = E.urgency(s.days);
      meta.append(el('span', { class: `chip ${u.role}` }, el('span', { class: 'ic' }, u.icon),
        `by ${E.fmtDate(s.deadline)} · ${s.days.toLocaleString()} days`));
    }
    card.append(tick, el('div', { class: 'step-body' },
      el('p', { class: 'step-head', html: `<span class="step-n">${s.n}</span>${escapeHtml(s.head)}` }),
      meta,
      el('p', {}, s.body),
      s.blockedBy ? el('p', { class: 'step-body blocked' }, '⚠',
        el('span', {}, `Do this first: ${s.blockedBy}`)) : null,
      s.cite ? el('details', {}, el('summary', {}, 'Why — the rule this rests on'),
        el('p', { class: 'cite' }, s.cite)) : null));
    host.append(card);
  }
  paintProgress(steps);
}

function paintProgress(steps) {
  const n = steps.filter(s => state.done[s.head]).length;
  $('#progressFill').style.width = (steps.length ? 100 * n / steps.length : 0) + '%';
  $('#progressTxt').textContent = `${n} of ${steps.length} done`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ────────────────────────────── orchestration ─────────────────────────── */

function renderStructure() {
  renderClaimant();
  renderStudents();
  recompute();
}

function recompute() {
  const all = rows();
  paintYearOutputs(all);
  paintSummary(all);
}

/* ──────────────────────────────── chrome ──────────────────────────────── */

$('#addStudent').addEventListener('click', () => {
  state.students.push(blankStudent());
  save(); renderStructure();
});

$('#themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
});
$('#printBtn').addEventListener('click', () => window.print());

const dlg = $('#dataDlg');
$('#dataBtn').addEventListener('click', () => dlg.showModal());
$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'aotc-scanner-backup.json' });
  a.click(); URL.revokeObjectURL(a.href);
});
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const next = JSON.parse(await f.text());
    if (!next || !Array.isArray(next.students)) throw new Error('not a backup file');
    state = next;
    uid = state.students.length ? Math.max(...state.students.map(s => s.id)) + 1 : 1;
    save(); renderStructure(); dlg.close();
  } catch (err) { alert('Could not read that file: ' + err.message); }
});
$('#clearBtn').addEventListener('click', () => {
  if (!confirm('Erase every figure stored in this browser? This cannot be undone.')) return;
  store.clear();
  state = { v: 1, claimant: { name: 'my parents', filingStatus: 'mfj', magi: {} },
            students: [blankStudent()], done: {} };
  renderStructure(); dlg.close();
});
$('#demoBtn').addEventListener('click', () => { state = demo(); save(); renderStructure(); dlg.close(); });

/** The worked example this tool was built from. */
function demo() {
  const a = blankStudent('Older sibling');
  a.years = {
    2023: { ...blankYear(), box1: 31360, box5: 34541, wages: '', priorUsed: 0, filed: false },
    2024: { ...blankYear(), box1: 63893, box5: 65569, wages: 17189, priorUsed: 0,
            filed: true, taxAsFiled: 259 },
  };
  const b = blankStudent('Younger sibling');
  b.years = {
    2024: { ...blankYear(), box1: 32533, box5: 38441, wages: '', priorUsed: 0, filed: false },
  };
  return {
    v: 1,
    claimant: { name: 'my parents', filingStatus: 'mfj', magi: { 2023: 120000, 2024: 125000 } },
    students: [a, b], done: {},
  };
}

/* hover tooltips for the bars */
const tip = $('#tip');
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) { tip.classList.remove('on'); return; }
  tip.textContent = t.getAttribute('data-tip');
  tip.classList.add('on');
  let x = e.clientX + 14, y = e.clientY + 16;
  if (x + tip.offsetWidth > innerWidth - 10) x = e.clientX - tip.offsetWidth - 14;
  if (y + tip.offsetHeight > innerHeight - 10) y = e.clientY - tip.offsetHeight - 16;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
});

/* offline */
if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

const verEl = document.getElementById('version');
if (verEl) verEl.textContent = 'v' + E.VERSION;

$('#saveState').textContent = store.persistent ? 'saved on this device' : 'this session only';
renderStructure();
