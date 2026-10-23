# Verifying migration parity

The progress percentage measures accepted migration work. A parity pass requires a
fresh replay of the declared behavior suite against frozen inputs:

```sh
br parity --verify --report  # read-only readiness report, safe while a run is active
br parity main --prepare    # author/extend missing workflow checks against legacy
br parity --verify           # replay every slice; exit 0 only when verification passes
```

Both forms are available as `/br parity` in Pi. A blocked readiness report exits
nonzero. Full replay uses the workspace run lock; migration, another verification,
or any other job holding that lock must finish first. Lock acquisition is atomic
across processes, including stale-lock recovery; a crashed owner releases the
underlying lease automatically. Verification does not ask
models to regenerate scenarios, repair setup, judge away differences or change
migrated code. Prepare the recipes with `br parity --probe`, author the scenarios,
and fix failures before verifying again. Add `--json` to verification/report commands
for the complete machine-readable report, including coverage details grouped in the
human-readable output. Verification itself requires no model-provider credentials.

`br parity <slice> --prepare` lets the tester extend existing scenarios and write
drivers in that slice's `checks/` folder. It tries them on the old app before the
ordinary comparison against the target. Stable check differences enter the same
judge/resolver/reopen loop as HTTP differences. This preparation can call models
and repair test setup; final `--verify` consumes the resulting suite unchanged.
`br run` does this preparation itself: once all units of a slice are accepted and
its suite would not pass strict verification (no `steps.json`, a route without a
compared step, a page without a browser check), the run writes the missing
checks against the old app before comparing. A slice without HTTP route owners
is prepared the same way. A preparation that cannot write them still compares
with the existing suite; after 3 failed preparations under one plugin version
the run names the slice at its end (`br parity <slice> --prepare` by hand).
The run does not end while a comparison is running, so the units it reopens are
fixed in the same run. After the finish check the run replays everything with
`br parity --verify`; slices it sends back are compared again (twice per run at
most), and the replay runs again when main moved or a slice was compared since.
The run says "finished, parity verified" only when that replay passed; otherwise
"ended, parity not verified" with the first problems. The progress figure counts
migrated code as 70% and slices answering like the old app as 30%; it reaches
100% only with a passed replay for main's current commit, every unit accepted
and nothing compared since.
Those checks run again when a reopened unit is accepted, including after an
earlier successful comparison.
Preparation retains the original suite and drivers until the candidate validates.
An invalid draft is rolled back before retrying with the configured escalation
model; a failed preparation leaves the original files intact.
A preparation that cannot write every missing check keeps its best try when it
leaves fewer gaps than the suite had (still comparing every scenario the suite
had); the next preparation goes on from it, and such a try uses none of the
slice's tries. A check the old app cannot complete (it compares nothing) goes
back to the next preparation with its error, until it is fixed or replaced.

The claim is **parity for the declared behavior suite at the recorded commits**.
It does not establish correctness for every possible input or prove that the
scenario authors covered every business rule. Review scenario coverage against
the legacy app: successful workflows, each permission level, denied access,
invalid inputs, missing records, boundary values, downloads, background work,
and integrations. Exercise real application entry points. Test fixtures should
include cases that fail when important behavior is deliberately broken.

## Preconditions

- Both source and target are clean committed snapshots; source HEAD matches the
  migration's pinned source commit.
- Every unit is accepted, symbols are accepted/dropped, and units belong to
  verification slices. Parked units remain blockers. Source routes have unit
  owners or explicit compared scenarios in a required slice. For example, add
  an endpoint supplied by the target platform to the relevant existing slice
  even when its legacy framework implementation is not ported as an app unit.
  Every indexed method must be exercised; a skip or dropped symbol cannot cover it.
- Required gate evidence exists; no stale units, deferred judgments, unresolved
  weak-test findings, read-only truth cases or unlinked truth cases remain.
- Repeated tester revisions never waive a weak-test finding. `br run` reopens
  units accepted under the earlier waiver, keeping their code and raw legacy
  truth. Their weakness note clears only after a judged, clean review.
  Recovery questions use the latest weak-test verdict as a failure, rather than
  an older command error. Stale unanswered machine questions are replaced when
  the diagnosed failure changes; recorded answers remain intact.
  A finding that persists after a tester revision uses the configured escalation
  model for the next tester round, even if files changed. Existing revision and
  attempt limits still apply.
- Quirk decisions are resolved and their ported tests follow those decisions.
  `br run` recovers accepted units with late pending decisions at startup and
  reapplies changed decisions while scheduling. It keeps their code and raw
  legacy truth; a failed decision retest cannot accept the unit.
- A finish check for the same target commit reports no stubs, gaps or missing
  judgments. Run `br finish` again after repairs.
- Each slice has an existing `.bigrefactor/parity/slices/<slice>/steps.json`.
  Every indexed HTTP method/path has a compared scenario. Skip reasons do not
  cover routes for strict verification. Slices without HTTP routes need an
  executable check.
- Database migrations use deterministic reset recipes on both sides. Keep-schema
  migrations also need dumps on both sides. Every table declared by a slice's
  database schema units must appear in both legacy seed dumps and the target seed
  dump, including empty tables. Matching partial dumps cannot prove the omitted
  tables. Whole-database observations belong to the database slice; HTTP slices
  can retain workflow-specific dumps. Table coverage checks names; review dump
  drivers to ensure each observation includes the complete relevant records and
  values. When schemas differ, provide data checks that compare canonical
  business observations across the two schemas.

After an interrupted run, crash recovery snapshots pending unit code and tests
before removing its worktrees. The next unit start restores that work on current
main while keeping raw legacy truth. If a snapshot cannot be committed, recovery
retains the worktree and fails before closing its attempts.

## Inventory exclusions

Nested source classifications take precedence over a broader folder, regardless
of their order in the framework profile. This lets the inventory retain a
framework for its loaders while excluding its explicitly identified test
fixtures. Re-inventory removes those fixture routes and retains runtime
framework routes and started application units. Confirm the source and the
classification before updating the profile; missing or unowned application
routes remain verification failures.

## Exact numeric observations

HTTP JSON, executable checks, database dumps, suite expectations and legacy truth
retain numeric values that ordinary JavaScript parsing would round. Comparisons
keep large integers and precise decimals distinct, support finite JSON numbers
outside the native number range, and distinguish numbers from strings or ordinary
objects. Evidence serialization retains the numeric value; equivalent decimal
and exponent notation compares equally.

Legacy cases record the parser provenance individually. Historical verified
cases default to unproven provenance because a stored rounded value cannot be
repaired by changing the parser. Normal truth upgrades re-run these cases, keep
accepted code when the actual values match, and reopen a unit when they differ.
Final verification requires that revalidation; partial truth imports cannot mark
omitted historical cases as revalidated.

## Fixture provenance

`br run` has each app's setup model make what this needs (at most 3 tries per app,
at the run's start and after a strict replay that did not pass): a data reset
that empties the database and loads its schema and a small fixture (seed data
with the test account and enough rows for real pages, never a second full copy
of a large database), the files it reads recorded with its `set_fixture_files`
tool (never files in the temporary parity worktree, which is made again for
every check: a recorded file that is gone or there is recorded again), and, for
the old app, each tracked file of its copy changed for local config declared as
an override. Steps the old app answers with a server error (or not at all, or with its login
page although the comparison logged in) after its reset are compared nowhere: once no slice is queued, they go to its
setup model, which adds the rows they need to the fixture (often the test
account's own links: its agency, roles, permissions) or says which fail for
every user; the new apps then load the same data and those slices are compared
again. A new app's reset is made to load the same
business data as the old app's fixture, again whenever that fixture's content
changes. Untracked files in the read-only legacy repo do not count as changes;
its tracked files must match the pinned commit. Source routes no unit holds
(the framework's own, such as `post_command` or `robots.txt`) are given to one
slice each (the one whose routes share the first path segment, else the slice
with the most routes), whose suite must compare them; a route the old app does
not serve here is compared too (both answer 404). Once nothing else is left to
run, the run keeps writing and running truth scripts on the old code, a batch at
a time, while each batch leaves fewer units to do.

By hand, `.bigrefactor/parity/scope.json` looks like this:

```json
{
  "version": 1,
  "fixture": {
    "name": "migration-acceptance-fixture-v1",
    "files": [
      ".bigrefactor/parity/fixture.sql",
      ".bigrefactor/parity/reset-legacy.py",
      ".bigrefactor/parity/reset-target.py"
    ]
  },
  "legacyOverrides": [
    {"path": "app/localconfig.php", "why": "Connect to the isolated fixture database"}
  ]
}
```

Paths are relative to the workspace; absolute input paths also work. Include the
fixture data, reset/dump scripts, configuration, runner lockfiles and any other
external inputs needed to reproduce the test. Large snapshots are hashed as
streams. Fixture resets must actually restore equivalent initial business data;
a successful reset command alone cannot establish that. Include a `data` check
to reconcile the seed and migrated data (counts, values, relationships, nulls,
binary values, timezone/decimal handling and relevant constraints).

The old app runs in the workspace copy. Every git-tracked legacy file must match
the pinned source there, apart from documented runtime configuration overlays.
Initialize source submodules at the revisions pinned by their parent commits.
Verification checks those revisions and recursively fingerprints their tracked
files, including nested submodules. It records every submodule revision in the
report. Tracked symlinks are checked by their link targets; regular files are
checked by bytes and executable mode. A missing submodule or a moved framework
revision prevents verification.
Record extra bootstrap files and overlay inputs in `fixture.files` too. Do not
use overrides to replace old business logic with the new implementation.

## Browser, data, CLI and integration checks

Extend a slice's existing `steps.json` with executable checks. For example:

```json
{
  "steps": [
    {"id":"details", "route":"GET /flights/{id}", "method":"GET", "path":"/flights/42", "compare":"page"}
  ],
  "stacks": ["symfony", "react"],
  "checks": [
    {
      "id": "flight-details-manager",
      "kind": "browser",
      "covers": ["details"],
      "why": "Manager opens the real page, sees CPM and exports the selected devices",
      "command": {"cmd":"node", "args":[".bigrefactor/parity/checks/flight-details.mjs"]},
      "inputs": [".bigrefactor/parity/checks/flight-details.mjs"]
    }
  ]
}
```

`stacks` names any extra target servers a check needs; omit it when the backend
already serves the built frontend. Each `page` step needs a browser check naming
its id in `covers`: an HTTP status check does not establish UI behavior. Browser
drivers use Playwright, which the plugin ships: checks run with the plugin's
Playwright on `NODE_PATH`, so a CommonJS driver (`checks/*.cjs`) can
`require("playwright")` and launch headless Chromium (downloaded once, before
the first browser check, when the machine does not have it). When the new app
has a UI stack (a single-page app calling the server stack), its pages are that
app: a suite with page steps lists the UI stack in `stacks` and its browser check
opens `BR_PARITY_URLS.<ui stack>` on the new app; the server stack alone never
shows the pages. They load the real entry
point, log in as the scenario's role, interact through controls, assert the
expected observations, and emit business results. Never supply test-only props
or bypass production loaders. Selectors and paths can differ between the old UI
and a redesigned UI; the observed business behavior must match.

For a slice without HTTP routes, use `"steps":[]` and at least one check. Its
kind can be `browser`, `data`, `command`, or `effects`. Checks run while that
side's app is up, after its HTTP steps, with these environment variables:

| Variable | Meaning |
| --- | --- |
| `BR_PARITY_SIDE` | `legacy` or `target` |
| `BR_PARITY_APP_DIR` | That side's runtime project directory |
| `BR_PARITY_URLS` | JSON map: `legacy` → URL, or target stack ids → URLs |
| `BR_PARITY_SOURCE_DIR` | Pinned source checkout, read-only |
| `BR_PARITY_TARGET_DIR` | The isolated target worktree; empty on the legacy side |
| `BR_PARITY_CHECK` | Current check id |

Each command must finish successfully within two minutes and print exactly one
non-empty JSON object on stdout, for example:

```json
{"campaign":"Fixture campaign", "selectedDeviceCount":3, "exportColumns":["ID","Name"], "exportRows":3}
```

Send logs to stderr. Report values read from the running app, database, generated
file, job queue or captured external action. A constant success flag establishes
nothing. Commands that assert behavior should exit nonzero when an assertion
fails. Use isolated fake services for emails, queues and external APIs, then
compare the captured requests/effects. Include driver dependencies in `inputs`.

Checks run sequentially, legacy twice (with a reset before each app start) and
target once. Their observations must be deterministic and exactly equal, apart
from explicit verified behavior changes described below. Fix
clocks/seeds and project equivalent schemas into a canonical representation in
the driver. Strict verification blocks on unstable legacy observations instead
of treating an entire changing response as ignorable noise.

## HTTP observations and retained proof

Strict HTTP replay compares status, redirects and data according to each step's
`compare` mode. A `redirect` step must actually exercise a legacy redirect. It
also compares Content-Type/Content-Disposition, plus any header names listed in
`responseHeaders` (e.g. Cache-Control or security headers). Downloads retain raw
bytes as base64; set `"response":"bytes"` for textual exports requiring exact
bytes. Other JSON is compared structurally; plain text normalizes line endings
and the harness's differing local host/port. These are comparison rules, not a
claim of identical transport bytes. Use byte mode wherever bytes are contractual.
HTTP JSON keeps its structure, including objects with a `base64` field. Binary
wrapper normalization used for database dumps never converts an HTTP JSON object
into a string.

With compatible dump recipes, strict replay compares the initial seeded database
on both legacy runs and the target before sending any requests, including for
route-less slices. Table rows are compared as multisets; duplicate rows, column
values and ordered JSON arrays within rows are preserved. Different legacy
starting data between resets prevents a pass. It also compares database changes after
every request, including GET requests. Browser and other checks must report any
additional effects they cause themselves.

Before replay, verification also runs every stack's whole-project build, lint,
boot check (when provided), and all tracked ported tests in an isolated worktree
of that same commit. Test files are named explicitly to the runner; linked truth
test files that were not run, focused/skipped tests, an empty test run, or any
failed command prevent a pass. Command results and output are retained in the
verification report. This phase performs no repairs.

A 503, broken login, unavailable legacy response, skipped route, unstable field,
failed check or differing observation prevents a pass. Decisions to `leave` a
historical difference and model classifications of differences never suppress
the results of a fresh strict replay.

## Recorded intentional behavior changes

When the migration deliberately fixes a legacy bug, declare its exact old and
intended new results. This establishes conformance to the reviewed migration
contract. It does not establish exact legacy equivalence for that behavior.
An ordinary historical `allowed` or `leave` verdict is insufficient.

Add `changes` to the slice's `steps.json`, for example:

```json
{
  "changes": [
    {
      "id": "show-waiting-approvals",
      "quirkId": 2932,
      "why": "The saved decision fixes the legacy filter that hid all waiting approvals",
      "expected": [
        {
          "step": "check:waiting-approvals",
          "kind": "body",
          "legacy": {"rows": []},
          "target": {"rows": [{"id": 42, "status": "waiting"}]}
        }
      ]
    }
  ]
}
```

The referenced quirk must have a recorded `dropped` decision, an attributed
decision maker, and an accepted owning unit. Kept, pending, unknown and
unattributed decisions cannot authorize a change. Review that the declaration
describes that exact decision; an id alone cannot establish semantic relevance.
Specify intended outcomes from the saved decision, not whatever the new app
currently returns. Keep raw truth observations from legacy unchanged.

`step` names a compared HTTP step or `check:<id>` for an executable check. Checks
use kind `body` and specify their entire observation object. For HTTP steps,
`kind` is `body`, `status`, `redirect`, `header` or `data`; specify the complete
corresponding response body, status, normalized redirect, observed header map or
database delta. Use JSON null for an absent redirect. Wildcards, partial object
matches, execution errors and HTTP 5xx expectations are unsupported.
For a recorded data migration correction, use `step:"fixture", kind:"data"` and
the complete canonical old/new initial dumps. The reserved `fixture` id cannot
name an HTTP step. An undecided seed difference is always a failure.

Each expectation must reproduce the complete specified value in both legacy
runs and the specified target value. All expectations of a change must succeed.
Unexpected fields, values, statuses, effects or other differences still fail.
A stale expectation whose difference no longer occurs also fails. Verification
fingerprints the saved decisions and answers, so changing a decision during
replay invalidates the proof. Preparation retains existing declarations.

Reports label these suites `accepted-changes` and retain the decision and exact
expectations separately from suites that matched. Raw observations and
differences remain available in the evidence and ledger. Without `changes`,
every fresh difference fails verification.

The report is `.bigrefactor/parity/verification.json`. Each replay's normalized
HTTP observations and check outputs are retained under
`.bigrefactor/parity/evidence/<run-id>.json`, with their hashes in the report.
The report records commits, plugin/Node versions, recipes, configuration and
fixture/suite/driver fingerprints. It also records per-file and combined hashes
of the plugin implementation (`src/`, `bin/`, `package.json`), workspace adapter
manifests, command overrides and helper scripts, framework profile and legacy
runtime settings. The legacy runtime root is recorded separately from its file
contents. Ordinary command fix logs do not affect the fingerprint. Include
external runner dependencies and lockfiles in `fixture.files` or check `inputs`
as appropriate; implementation hashes do not fingerprint every installed package.
Reload Pi after plugin/adapter updates before verifying; the standalone CLI
starts a fresh process. Verification rechecks those inputs after replay and
fails if they changed. All slices must match the same target commit. Later code
or fixture changes require a new replay; status labels past reports as historical.


### Complete data checks and execution context

Dump commands receive `BR_PARITY_SIDE=legacy|target`, `BR_PARITY_SLICE`,
`BR_PARITY_PHASE=initial|step`, and `BR_PARITY_STEP` (empty for the initial
observation). Startup probes use phase `probe` and clear the scenario fields.
The harness supplies these values after recipe and inherited environment values.
Executable contracts receive the slice and phase `contract`, with an empty step.

Use the data slice for the complete seeded record comparison, including all
inventoried tables and fields, exact values, full payloads, and duplicate rows.
Use explicitly reviewed table sets for individual workflow effects. Each slice
must observe the same table set before and after its requests. A route-less
slice still performs an initial observation. Never substitute a sampled count
or a truncated payload for a complete observation.

Large data scans can set `recipe.dump.timeoutMs` in apps.json, or
`dumpTimeoutMs` through the boot setup tools. Executable checks can set their
own `timeoutMs`. Defaults remain ten minutes for dumps and two minutes for
contracts. Explicit values must be positive integer milliseconds, at most one
day. Budgets are frozen with recipes/suites, and extending a budget never changes
the required record coverage. Output remains bounded; full-row hashes and full
counts keep the result small while scanning every row.

Observation commands run in dedicated process groups. Their launcher watches
for a killed harness as well as normal exits. Completion, timeout, excess output,
and host death stop the owned reader processes, including background descendants.
