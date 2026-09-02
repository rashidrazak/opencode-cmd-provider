# ADR-0006: Upstream-managed reasoning classification is derived, not hand-maintained

Status: accepted

Which Command Code models are reasoning-capable used to be a hand-typed set in
`src/provider/reasoning.ts`. Every upstream classification change (a model
gaining explicit efforts, a retirement, a new reasoning model) collided with
the generated data, the consistency test failed, the cron went red, and a
human had to edit runtime source before any refresh PR could ship — five
human rescues in six days (2026-08-28 → 09-02). Worse, the hand set was
already wrong: upstream's own data says `stepfun/Step-3.5-Flash` is
reasoning-capable while the hand set (and an advisory test list) pinned it
non-reasoning, so production silently under-advertised it.

The decision: **classification is upstream-managed data, derived once and
consumed everywhere**. The docs' RSC slug records carry a per-model
`reasoning` flag with complete Snapshot coverage; the refresh ladder
generates that flag into `src/catalog/classification.ts`
(`scripts/refresh-classification.mjs`, inside `npm run refresh` ordered after
fixture capture), and the runtime derives its reasoning metadata from it:

- `REASONING_MODELS` (reasoning-without-efforts) = capability flag true AND
  no efforts entry;
- `isReasoningModel` = has an efforts entry OR capability flag true.

Efforts precedence holds **by construction** — an efforts model can never
appear in the reasoning-without-efforts set — so the old "a model is
classified exactly once" invariant is true by construction instead of being
asserted after regeneration, and its cron-gate test shrank to a derivation
check. Exported names and signatures are unchanged, so auto-registration,
converters, and the model class are untouched; behavior changes only where
upstream's data disagrees with the old hand set (the Step-3.5-Flash fix).

## The override seam is the only human input

Human judgment moves to `scripts/classification-overrides.mjs` — modeled on
the tier-overrides seam (ADR-0005). An entry pins a model's capability **only
when upstream's own surfaces contradict each other**, and every entry carries
a written justification naming the disagreement. The map starts empty (the
three-way audit on spec #108 — live models.md efforts vs RSC reasoning flags
vs the hand set, all 61 Snapshot models — found zero upstream
self-contradictions). Overrides are applied at generation time and embedded
in the generated module, and the diff tool renders every active entry with
its justification into the refresh PR body, so pinned judgment calls rot
visibly instead of silently.

## Loud-by-design failure classes

Value changes must never fail, and silent defaults must never happen. The
refresh fails loudly (exit 1, naming the offending models and reasons) when:

- **A shape change reaches the RSC records.** The `reasoning` flag is a
  required slug-record field (`REQUIRED_SLUG_RECORD_FIELDS`); an upstream
  rename or drop is a loud shape failure naming the model — never a silent
  default-to-non-reasoning. A renamed field needs parser work, by design; no
  derivation can parse a format it has never seen.
- **A Snapshot model has no RSC record.** The shared coverage gate
  (`missingSnapshotModels` in `scripts/rsc-source.mjs`) fails the refresh —
  a partial classification would silently under-advertise those models
  (same rationale as the deals gate).

Deterministic generators make byte-equality-minus-date-lines equivalent to
data-equality, which is what lets the cron's drift check (below) reason
about data instead of bytes.

## Fetch semantics are shared, not copied

The classification generator reads the per-plan RSC pages only (goat + pro —
no pricing-limits fetch) through `scripts/rsc-source.mjs`, the shared record
source extracted from the Deals generator (issue #109). That module owns the
ADR-0005 fetch ladder — 5xx/network → committed fixtures; 4xx → loud failure
and nothing written — and the coverage gate, so no second generator can grow
a diverging copy of the fallback semantics.

## Cron and release integration

- The generated classification module rides the cron's commit list (fixtured
  refreshes commit it), and the cron's drift detection judges **meaningful
  change**: the generated catalog modules only, with the release gate's
  date-stamp ignores (`FACTS_LAST_REFRESHED`, `DEAL_LAST_REFRESHED`,
  `CLASSIFICATION_LAST_REFRESHED`) — the ADR-0003 convention. Date-only
  churn opens no PR at all (the PR #103 replay ships nothing); fixture-only
  bytes churn never opens a PR; facts source/package-version movements stay
  meaningful. The classification-diff section in the refresh PR body
  renders flips, promotions, retirements, and active overrides in plain
  language, plus a machine-readable classification-changed boolean that is
  deliberately unconsumed (no auto-merge policy yet).
- The release pipeline (ADR-0002, ADR-0003) is untouched; the release-time
  staleness gate for classification is the structural consistency test
  (`tests/classification.test.ts`) that fails `npm test` when a Snapshot
  model lacks a classification entry.

## Consequences

- Upstream classification changes land as generated-data diffs in the daily
  refresh PR with zero human edits; a red cron now means "needs code"
  (shape), never "needs data".
- The plugin's advertised reasoning matches upstream's published data by
  default instead of matching a transcription of it.
- Deleting the Deals slice leaves classification (Core provider behavior)
  untouched: the generated module lives in the catalog layer, never in
  `src/deals/` (ADR-0004).
- A future auto-merge policy can key off the diff tool's
  classification-changed signal without new plumbing; any workflow that
  pushes to main remains an ADR-level decision (see ADR-0002 and the
  auto-release trust model).
