// tests/parse-catalog.test.ts — the catalog-payload parser (ADR-0024).
//
// The client-view catalog (`GET /provider/v1/models?view=client`) replaced the
// npm package's `models.md` table as the Snapshot's membership authority: it is
// the source the Command Code CLI resolves models from, so a model the CLI
// offers is a model this plugin offers. These tests pin the *shape* contract
// only — every value below is synthetic and test-owned, so an upstream price
// or effort change moves the committed snapshot, never this suite (spec #108).
import { parseModelCatalog } from "../scripts/parse-catalog.mjs"
import { assert, assertEqual, run, throws } from "./harness.js"

/** A minimal well-formed record; overrides let each case break one field. */
function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "vendor/model",
    name: "Vendor Model",
    context_length: 1_000_000,
    reasoningEfforts: ["low", "high"],
    inputModalities: ["text", "image"],
    pricing: { inputCost: 2, outputCost: 10, cacheReadCost: 0.2, cacheWriteCost: 2.5 },
    ...overrides,
  }
}

/** A well-formed payload wrapping the given records. */
function payload(data: unknown[], overrides: Record<string, unknown> = {}) {
  return { catalogVersion: "test-catalog-version", data, ...overrides }
}

run([
  [
    "parses a record into a membership row with catalog provenance",
    () => {
      const parsed = parseModelCatalog(payload([record()]))
      assertEqual(parsed.rows, [
        {
          id: "vendor/model",
          name: "Vendor Model",
          contextLength: 1_000_000,
          contextSource: "catalog",
          efforts: ["low", "high"],
          cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
          costSource: "catalog",
          modalities: ["text", "image"],
        },
      ])
      assertEqual(parsed.catalogVersion, "test-catalog-version")
      assertEqual(parsed.hidden, [])
    },
  ],

  [
    "hidden records are excluded from membership and reported (never an error)",
    () => {
      const parsed = parseModelCatalog(
        payload([
          record({ id: "vendor/visible" }),
          record({ id: "vendor/free-variant", hidden: true }),
          record({ id: "vendor/retired", hidden: true }),
        ]),
      )
      assertEqual(
        parsed.rows.map((row: { id: string }) => row.id),
        ["vendor/visible"],
      )
      assertEqual(parsed.hidden, ["vendor/free-variant", "vendor/retired"])
    },
  ],

  [
    "exact context_length is kept as-is (no decimal rounding)",
    () => {
      // The models.md-era parser mapped the coarse "1.05M" cell to 1050000;
      // the catalog carries the true 1 MiB value and must ship it verbatim.
      const parsed = parseModelCatalog(payload([record({ context_length: 1_048_576 })]))
      assertEqual(parsed.rows[0].contextLength, 1_048_576)
    },
  ],

  [
    "the thinking-ladder off is dropped from the advertised efforts",
    () => {
      // ADR-0019: "off" means "send nothing", never an advertised effort; the
      // generated MODEL_EFFORTS drives the variant cycle, which pins this.
      const parsed = parseModelCatalog(
        payload([record({ reasoningEfforts: ["off", "low", "high"] })]),
      )
      assertEqual(parsed.rows[0].efforts, ["low", "high"])
    },
  ],

  [
    "an efforts list carrying only off resolves to null (model decides its depth)",
    () => {
      const parsed = parseModelCatalog(payload([record({ reasoningEfforts: ["off"] })]))
      assertEqual(parsed.rows[0].efforts, null)
    },
  ],

  [
    "a null or absent efforts list is null, not a shape failure",
    () => {
      assertEqual(
        parseModelCatalog(payload([record({ reasoningEfforts: null })])).rows[0].efforts,
        null,
      )
      const { reasoningEfforts: _drop, ...withoutEfforts } = record()
      assertEqual(parseModelCatalog(payload([withoutEfforts])).rows[0].efforts, null)
    },
  ],

  [
    "an absent pricing block is a cost gap (null), not a zero-fill",
    () => {
      const { pricing: _drop, ...withoutPricing } = record()
      const parsed = parseModelCatalog(payload([withoutPricing]))
      assertEqual(parsed.rows[0].cost, null)
      assertEqual(parsed.rows[0].costSource, null)
    },
  ],

  [
    "an absent cacheWriteCost ships as an explicit zero",
    () => {
      // Most models bill no cache write; absent is 0, distinct from a missing
      // input/output rate (which is a shape failure, below).
      const parsed = parseModelCatalog(
        payload([record({ pricing: { inputCost: 1, outputCost: 5, cacheReadCost: 0.05 } })]),
      )
      assertEqual(parsed.rows[0].cost, { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 0 })
    },
  ],

  [
    "an explicitly free record keeps a zero cost (never read as missing)",
    () => {
      const parsed = parseModelCatalog(
        payload([
          record({
            pricing: { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0 },
          }),
        ]),
      )
      assertEqual(parsed.rows[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    },
  ],

  [
    "unadvertised modalities resolve to undefined (runtime falls back to text)",
    () => {
      const parsed = parseModelCatalog(payload([record({ inputModalities: null })]))
      assertEqual(parsed.rows[0].modalities, undefined)
      const parsedSome = parseModelCatalog(payload([record({ inputModalities: [] })]))
      assertEqual(parsedSome.rows[0].modalities, undefined)
    },
  ],

  [
    "only text/image modalities survive (an unknown value is dropped)",
    () => {
      const parsed = parseModelCatalog(
        payload([record({ inputModalities: ["text", "audio", "image"] })]),
      )
      assertEqual(parsed.rows[0].modalities, ["text", "image"])
    },
  ],

  [
    "the catalogVersion is required (a payload without one is a shape change)",
    () => {
      throws(() => parseModelCatalog({ data: [record()] }), /catalogVersion/)
      throws(() => parseModelCatalog({ catalogVersion: "", data: [record()] }), /catalogVersion/)
    },
  ],

  [
    "a payload without a data array is a shape change",
    () => {
      throws(() => parseModelCatalog({ catalogVersion: "v" }), /data array/)
      throws(() => parseModelCatalog({ catalogVersion: "v", data: {} }), /data array/)
    },
  ],

  [
    "a payload with no selectable rows is a shape change",
    () => {
      throws(() => parseModelCatalog(payload([])), /no selectable model rows/)
      throws(() => parseModelCatalog(payload([record({ hidden: true })])), /no selectable/)
    },
  ],

  [
    "an entry with no usable id is a shape change",
    () => {
      throws(() => parseModelCatalog(payload([record({ id: "" })])), /no usable id/)
      throws(() => parseModelCatalog(payload([record({ id: 42 })])), /no usable id/)
    },
  ],

  [
    "a selectable entry with no name is a shape change",
    () => {
      throws(() => parseModelCatalog(payload([record({ name: "" })])), /name/)
    },
  ],

  [
    "an absent context_length is a gap (null) the refresh ladder resolves",
    () => {
      const { context_length: _drop, ...withoutContext } = record()
      const parsed = parseModelCatalog(payload([withoutContext]))
      assertEqual(parsed.rows[0].contextLength, null)
      assertEqual(parsed.rows[0].contextSource, null)
      assertEqual(
        parseModelCatalog(payload([record({ context_length: null })])).rows[0].contextLength,
        null,
      )
    },
  ],

  [
    "a present but unusable context_length is a shape change",
    () => {
      throws(() => parseModelCatalog(payload([record({ context_length: 0 })])), /context_length/)
      throws(() => parseModelCatalog(payload([record({ context_length: 1.5 })])), /context_length/)
      throws(() => parseModelCatalog(payload([record({ context_length: -1 })])), /context_length/)
    },
  ],

  [
    "a present but unusable rate is a shape change (never a guessed number)",
    () => {
      throws(
        () =>
          parseModelCatalog(
            payload([record({ pricing: { inputCost: -1, outputCost: 1, cacheReadCost: 0 } })]),
          ),
        /inputCost/,
      )
      throws(
        () =>
          parseModelCatalog(
            payload([
              record({ pricing: { inputCost: 1, outputCost: "expensive", cacheReadCost: 0 } }),
            ]),
          ),
        /outputCost/,
      )
    },
  ],

  [
    "a non-array efforts field is a shape change",
    () => {
      throws(
        () => parseModelCatalog(payload([record({ reasoningEfforts: "low,high" })])),
        /reasoningEfforts/,
      )
    },
  ],

  [
    "duplicate ids are a shape change",
    () => {
      throws(
        () =>
          parseModelCatalog(payload([record({ id: "vendor/dup" }), record({ id: "vendor/dup" })])),
        /duplicate model ids/,
      )
    },
  ],

  [
    "the refreshSeconds hint is surfaced when present",
    () => {
      assertEqual(
        parseModelCatalog(payload([record()], { refreshAfterSeconds: 900 })).refreshAfterSeconds,
        900,
      )
      assertEqual(parseModelCatalog(payload([record()])).refreshAfterSeconds, undefined)
    },
  ],
])
