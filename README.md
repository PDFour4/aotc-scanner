# AOTC Scanner

A small web application that finds unclaimed **American Opportunity Tax Credit**
across the tax years still open under IRC §6511, works out the optimal amount of
scholarship to elect into income, and tells you exactly who files what, by when.

**It runs entirely in your browser.** No server, no account, no analytics, no
network calls of any kind. Your figures are computed on your device and saved
only to that device's local storage.

That is a legal posture, not just a privacy preference. IRC §7216 makes it a
misdemeanour for anyone "providing services in connection with the preparation
of" a return to *use* taxpayer information for any purpose other than preparing
it. The surest way never to do that is never to hold the data.

## Publish it

```bash
brew install gh && gh auth login     # once
bash deploy.sh
```

That creates `aotc-scanner` under your GitHub account, pushes the files, and
turns on GitHub Pages. You get a URL like `https://you.github.io/aotc-scanner/`.
Free, and it works from any device.

To update later: `bash deploy.sh "what changed"`.

**Install it on your phone:** open the URL in Safari or Chrome and choose
*Add to Home Screen*. It becomes a real icon, opens without browser chrome, and
works with no signal at all — the service worker caches the whole application.

## Run it locally

No build step, no dependencies. It is plain ES modules:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

## Drop in a 1098-T

Drag the PDF onto a student and it reads box 1, box 5, box 8, box 9, the tax
year and the school's EIN, then **proposes** them. You confirm before anything
is applied.

The reading happens in your browser — `pdf.js` against the PDF's own text
layer. No OCR, no upload, no API. University-issued 1098-Ts are generated
documents rather than scans, so the text and its coordinates are already in the
file. `pdf.js` is lazy-loaded, so the 3 MB only downloads the first time you
actually drop a PDF.

**Confirm-before-apply is not politeness.** Boxes 1 and 5 decide the entire
credit, and a form parser is a heuristic — issuers move boxes, fonts change, and
a photo has no text layer at all. A wrong digit accepted silently would be worse
than typing it by hand, because it would look effortless.

A photo or a scan is detected and refused rather than guessed at. Download the
PDF from the school portal instead.

The locator anchors on the form's *structure*, not on pixel coordinates: box 1
is the topmost figure, box 5 is the rightmost of its row, and the box numbers
are the cell boundaries for the checkboxes. That last one matters — boxes 8 and
9 sit side by side, so nearest-label matching read a half-time undergraduate as
a graduate student, which denies the credit outright.

## The answer key

The step that says "report $7,181 on Schedule 1 line 8r" is useless the moment
you open FreeTaxUSA, because FreeTaxUSA never shows you Schedule 1. It shows
you a list of income types and asks which apply.

So every student-return step carries **"Filling it in — every line, with the
answer"**: what Schedule 1 and Form 1040 must say, line by line, with the box
you must tick, the ten income screens to leave blank, and — where it is
documented — the menu path in the actual product.

Line numbers are stored **per year**, because they move: the 2025 Form 1040
split line 12 into 12a/12b/12e. Every line carries its caption as well as its
number, so a drifted number is still findable by reading the page.

Whatever a tax product asks and whatever it calls its screens, the finished
return has to come out matching that table. Preview the PDF and compare.

## It tells you what it doesn't know

Every year carries a confidence chip and a **"what would sharpen this"** panel,
graded by how much each gap could move the answer:

- **blocking** — nothing can be computed until you supply it (the 1098-T boxes,
  the claimant's MAGI)
- **material** — the figure could change substantially or be wiped out (how many
  AOTC years are already used; whether the student had finished four years of
  college; **the scholarship award letter**)
- **minor** — the figure could shift a little (books not yet entered, an
  unverified year's inflation figures, the Tax Table's ±$2)

The award letter is the one that matters most and the one no amount of
arithmetic can settle. If the award restricts the money to tuition, the whole
election is unavailable. Somebody has to read the letter.

## Run it from a terminal

```bash
node run.mjs --demo
node run.mjs scenario.json
```

Same `engine.js` the app runs — nothing re-implemented, nothing approximated.
This exists for discipline: any figure quoted about these returns should come
out of here rather than out of somebody's head.

## Tests

Open `tests.html`. 87 golden fixtures covering the tax table, the dependent
standard deduction, both §25A tiers, the phase-out in both bands, the §6511
windows, and every disqualifier — plus end-to-end cases from real filed returns.

They mirror the Python suite in the companion `tax-scanner` repo one-for-one.
Two independent implementations of the same statute that must agree; if either
drifts, a fixture goes red.

## What it knows

| Rule | Authority |
|---|---|
| 100% of the first $2,000 + 25% of the next $2,000, capped at $2,500 | §25A(b)(1) |
| 40% refundable, denied to a child subject to the kiddie tax | §25A(i) |
| Four taxable years per student, counting elections by **anyone** | §25A(b)(2)(A) |
| No credit once the first four years of college are complete — a *separate* test | §25A(b)(2)(C) |
| Scholarships reduce qualified expenses *before* the credit is figured | §25A(g)(2) |
| Course materials count for this credit, and are rarely on a 1098-T | §25A(f)(1)(D) |
| A claimed dependent's credit belongs to the claimant, whose MAGI runs the phase-out | §25A(g)(3) |
| Phase-out $160k–$180k joint, $80k–$90k otherwise | §25A(d)(1) |
| Married filing separately is barred outright | §25A(g)(6) |
| A dependent's standard deduction, with taxable scholarship counting as *earned* income | §63(c)(5); Pub. 501 |
| Three years from filing or two from payment, whichever is later | §6511(a) |
| An early return is deemed filed on the due date | §6513(a) |
| A weekend deadline rolls to the next business day | §7503 |
| Electing scholarship into income to free qualified tuition | Pub. 970 ch. 2; Prop. Reg. 1.25A-5(c)(3) |

## Three rules the code keeps

**Unknown is never zero.** A missing input yields `null` and `null` propagates.
Nothing silently becomes `0` and turns into "not eligible" — that failure is the
reason this exists.

**No estimate is presented as exact.** Below $100,000 the IRS Tax Table is
mandatory, and it taxes the *midpoint* of a $50 band rather than your actual
income. This reproduces it to within about $2 and says so, because the table is
a published lookup and not a formula. Checked against two real returns it
matched one exactly and differed by $1 on the other. A $2 wobble never changes
whether a year is worth filing, but stating false precision about tax is how you
end up defending a number you cannot support.

**Money is integer cents.** `0.1 + 0.2` is exactly `0.3` here. Floats do not go
near a tax computation.

## What it does not do

It does not file anything, and it does not choose for you. It lays out the
options with the statute beside each one and leaves the decision where it
belongs. *In re Reynoso*, 477 F.3d 1117 (9th Cir. 2007) held that software which
**selects** a legal option for the user is the unauthorized practice of law.

It is a research tool, not tax advice. Have a preparer review anything before it
is filed — and hand them the printout, which carries every citation.

## Licence

MIT.
