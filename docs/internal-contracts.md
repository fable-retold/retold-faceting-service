# retold-faceting-service — Internal Contracts (Milestones 1, 2, 4 and 5)

> **Part IV (§53–§70) is the Milestone 5 contract (the ClickHouse store: MirrorSpec, materializer, rebuild, reconcile, freshness, the ClickHouse fold compiler and engine) and wins over Parts I–III wherever they conflict** (§53.2 lists every earlier rule it changes). **Part III (§38–§52) is the Milestone 4 contract (change capture, generations, result cache, freshness, SSE) and wins over Parts I and II wherever they conflict** (§38.2 lists every earlier rule it changes). **Part II (§19–§37) is the Milestone 2 contract and wins over Part I wherever they conflict** (§19.2 lists every Part I rule it changes). Part I (§0–§18) below is the Milestone 1 contract as built. (Milestone 3 was the `example_applications/faceting_demo` app; its spec is that folder's `DEMO-SPEC.md`.)

> **Binding.** This file is the interface spec Milestone 1 is coded against. Every shape, method name, field name and error code here is a contract between modules. If you need to change a contract, change it here first; never silently diverge. Where this file and the design set (`/Users/steven/Documents/retold-faceting-service-design/design/`) disagree, **this file wins for M1** and §16 lists every deliberate deviation.

Design references are written `01 §8.2` (file `01-fold-algebra.md`, section 8.2).

---

## 0. Conventions every file follows

| Topic | Rule |
|---|---|
| Style | Plain JS, **tabs**, **Allman braces everywhere** (stubs too), `pParam`, `tmpLocal`, `libRequire`, `CONSTANT`. |
| Services | Every class extends `fable-serviceproviderbase`, sets `this.serviceType = '<Type>'` in the constructor, and exports `module.exports = Class; module.exports.serviceType = '<Type>';`. The `contract/*` modules and the `Shell-Templates-<Dialect>.js` modules are **not** classes (see below). |
| Registration | The main service registers every sub-service with `this.fable.addServiceType(Type, Class)` + `this.fable.instantiateServiceProvider(Type, tmpResolvedOptions)`, so each is reachable as `this.fable.<serviceType>` (e.g. `this.fable.RetoldFacetingCatalog`). Services find each other **only** through `this.fable.<serviceType>` or through `pContext` (never by `require`-ing a sibling service and constructing it). |
| Options | Every service constructor receives the **resolved** `RetoldFaceting` options (`Retold-Faceting-Service-Options.js` → `resolve(pPartial)`) as `pOptions`. Constructors call `libOptions.resolve(pOptions)` themselves, so `new X(pFable)` and `new X(pFable, {})` work (the smoke test relies on this). `resolve()` is idempotent. Read options as `this.options.Limits.MaxTop`, never from `fable.settings` directly. |
| Async | Node callbacks: `fCallback(pError, pResult)`. Anything that may touch the DB, a behavior, or the host is async. Pure transforms are synchronous. |
| Errors | Build every client-visible error with `libFacetErrors.create(pCode, pMessage, pDetail)` (`contract/Facet-Contract-Errors.js`). Synchronous request-phase services (Normalizer, FilterValidator, ClauseCompiler, FilterAST, DisjunctivePlanner, Planner.lower, contract builders) **throw** such errors; async services pass them to `fCallback`. Any other `Error` that escapes is mapped to `FACET_INTERNAL` (500) by the route, logged with the plan hash, never echoed. |
| Restify | Handlers never return a promise and call `fNext` exactly once. Use the fable Orator service server (`post`, `get`). The Query route reads its own body (JSON Content-Type only, counted against `Limits.MaxBodyBytes`); restify's combined `bodyParser` (multipart / urlencoded / temp files) is never used. |
| Identifiers | No identifier ever comes from the client. Every column/table name used in SQL comes from `RetoldFacetingCatalog` (validated against `^[A-Za-z_][A-Za-z0-9_]{0,63}$` at build) and is quoted by `RetoldFacetingDialects`. Every value is bound. |
| SQL composition | Scoped Relations only (D-03). **Never** `query.addJoin`. Relations are spliced through `query.parameters.SR<n>` and referenced as `<%= _Params.SR<n> %>`; never concatenated into template text. |
| Determinism | No `Math.random` / wall-clock in anything an engine compares. `pContext.Now` is pinned once per request. Test fixtures use a fixed PRNG seed. |
| Logging | `this.fable.log.*`; never log values bound into SQL, session contents or credentials. |
| Pure modules | `contract/*` may `require` **only** sibling contract modules (`./Facet-Contract-*.js`, including `Facet-Contract-Util.js`: `hasOwn`, `isPlainObject`, `toFiniteNumber`, `toCount`, `keyProblem`, `logSafe`); `Shell-Templates-<Dialect>.js` requires nothing. The smoke test enforces both (they are deep-required by browser code later, design `10 §3.1` "zero requires"). Server-only helpers (`stripColumn`, `normalizeScopeValue`, `isUnsetScopeValue`) live in `source/Retold-Faceting-Util.js`. |
| Client keys | Facet Keys and range Keys become map keys and log text: every map keyed by client data is a `Map`, a `Set` or `Object.create(null)`, or is read with `hasOwn`; keys with control characters or an `Object.prototype` name (`__proto__`, `constructor`, `prototype`, `hasOwnProperty`) are refused by `normalizeRequest` (400); keys are logged through `logSafe` (JSON-quoted). |
| fable defaults | `fable.instantiateServiceProvider(Type, …)` makes the **first** instance of a type the default `fable.<Type>`; later instances do not replace it. `RetoldFacetingService.registerServices()` is idempotent for that reason. |
| Contract aliases | In this document and in code, the pure modules are required as `libFacetRequest` (`contract/Facet-Contract-Request.js`, called `FacetRequest` below), `libFacetEnvelope` (`FacetEnvelope`), `libFacetBuckets` (`FacetBuckets`), `libFacetClauses` (`FacetClauses`), `libFacetErrors` (`FacetErrors`), and the options module as `libOptions`. |

### 0.1 Service hashes (all on `fable`)

```
RetoldFacetingService
RetoldFacetingHostDataService            (the active host; also referenced as pContext.Host)
RetoldFacetingCatalog  RetoldFacetingGraph
RetoldFacetingRequestNormalizer  RetoldFacetingFilterValidator  RetoldFacetingClauseCompiler
RetoldFacetingFilterAST  RetoldFacetingDisjunctivePlanner
RetoldFacetingPlanner  RetoldFacetingFoldIR
RetoldFacetingPrincipalResolver  RetoldFacetingScopeCapture  RetoldFacetingScopeGuard  RetoldFacetingAuthorizer
RetoldFacetingRouter  RetoldFacetingEngineLive  RetoldFacetingEngineReference      (EngineBase is abstract, not registered)
RetoldFacetingLabelResolver                                                       (FK labels, §18.6)
RetoldFacetingScopedRelationBuilder  RetoldFacetingDialects  RetoldFacetingShellTemplates
RetoldFacetingRoutes
RetoldFacetingDefinitionRegistry  RetoldFacetingBinder                             (M2, §19.3)
RetoldFacetingPredicateCompiler  RetoldFacetingStagedKeys  RetoldFacetingCubeExecutor   (M2, §19.3)
```

---

## 1. Module map

| Area | Files |
|---|---|
| Contract (pure, shared with pict-section-facet) | `source/contract/Facet-Contract-Request.js`, `-Envelope.js`, `-Buckets.js`, `-Clauses.js`, `-Errors.js`, `-Util.js` |
| Host and catalog | `source/host/Retold-Faceting-Host-Base.js`, `source/host/Retold-Faceting-Host-DataService.js`, `source/catalog/Retold-Faceting-Catalog.js`, `source/catalog/Retold-Faceting-Graph.js`, `source/catalog/Retold-Faceting-LabelResolver.js`, `source/Retold-Faceting-Installers.js` |
| Request | `source/request/Retold-Faceting-RequestNormalizer.js`, `-FilterValidator.js`, `-ClauseCompiler.js`, `-FilterAST.js`, `-DisjunctivePlanner.js` |
| Plan | `source/plan/Retold-Faceting-Planner.js`, `-FoldIR.js` |
| Live engine and scope | `source/engine/live/*` (ScopedRelationBuilder, Dialects, ShellTemplates, `Shell-Templates-<Dialect>.js`), `source/engine/Retold-Faceting-EngineLive.js`, `source/security/Retold-Faceting-ScopeCapture.js`, `-ScopeGuard.js` |
| Reference engine (O1) | `source/engine/Retold-Faceting-EngineReference.js` |
| Wiring | `source/Retold-Faceting-Service.js`, `-Service-Options.js`, `-Util.js`, `source/engine/Retold-Faceting-Router.js`, `-EngineBase.js`, `source/security/Retold-Faceting-PrincipalResolver.js`, `-Authorizer.js`, `source/routes/*` |
| Tests | `test/*_tests.js`, `test/support/Facet-Test-Harness.js`, `test/support/Facet-Test-Builders.js`, `test/fixtures/*` (the bookstore model is a copy in `test/fixtures/Bookstore-Model.json`), `test/goldens/*`; `debug/m1-smoke.js` |
| M2 additions (§19.3) | `source/catalog/Retold-Faceting-DefinitionRegistry.js`, `source/catalog/Facet-Definition-Schema.json`, `source/plan/Retold-Faceting-Binder.js`, `source/engine/live/Retold-Faceting-PredicateCompiler.js`, `-StagedKeys.js`, `-CubeExecutor.js`; `test/support/Facet-Harness-Providers.js`, `Facet-Docker-Postgres.js`; `test/fixtures/ProjectTrack-*`, `LabTrack-*`, `Bookstore-Conformance-Fixtures.js`; `test/Facet-Review-M2_tests.js` (the M2 review regressions) |
| Shared server helpers | `source/Retold-Faceting-Util.js` (`stripColumn`, `columnQualifier`, `sha1Hex`, scope-value normalization); the `$`-token grammar and param types live in `Facet-Contract-Request.js` (`TOKEN_PATTERN`, `PARAM_TYPES`), the integer range rule in `Facet-Contract-Buckets.js` (`integerRange`), the value coercion rule is `ClauseCompiler.coerceValue` (a pure module function the registry and the Binder use) |

Test files are named `*_tests.js`; each one that opens a server names a **registry port in 19100–19199** (§14.4) but binds an ephemeral port by default (the harness reads the bound port back), so overlapping runs never collide.

---

## 2. Request pipeline (M1) and the request context

### 2.1 Order (normative; mirrors `03 §2.1`, minus cache/cost/stores)

```
Route  POST /1.0/Facet/:Entity/Query  (route-local JSON body parser) → RetoldFacetingService.query(Entity, Body, pRequest, cb)
  0 Context     RetoldFacetingService.newContext(Entity, pRequest, pInternalOptions) → pContext (§2.2)
  1 Principal   RetoldFacetingPrincipalResolver.resolve(pContext) → pContext.Principal  (401 FACET_UNAUTHENTICATED)
  2 Shape       RetoldFacetingRequestNormalizer.normalize(pEntity, pBody) → NormalizedRequest   (400 shape/limit errors)
  3 Gate        RetoldFacetingAuthorizer.check(pContext, [Entity]) — root not facetable/readable → 404 FACET_UNKNOWN_ENTITY
  4 Filter      FilterAST.build(Entity, NormalizedRequest) (calls FilterValidator + ClauseCompiler) → FilterAST   (400 FACET_FILTER_INVALID / FACET_UNKNOWN_FIELD)
  5 Facets      Catalog.facet(FacetID) per Facets[] entry; unknown → per-facet error (FACET_UNKNOWN_FACET / FACET_UNKNOWN_FOLD)
  6 Plan        Planner.plan(pContext) → { Aggs, Variants, DepSet } (DisjunctivePlanner inside)
  7 Route       Router.route(pAggs, pContext) → Engine (Live, or the forced Reference engine)
  8 Execute     Engine.execute(pContext, pAggs) → Execution { Results, Errors, Captures }   (ScopeCapture + ScopeGuard inside Live)
  9 Post        Envelope.buildFacetResult per Agg + Envelope.buildEnvelope (contract, pure)
 10 Respond     ETag: W/"fv1:<Version>", Cache-Control: private, no-cache, Vary: Cookie, Authorization, X-Retold-Facet-Contract: 1
```

Authorization (3) precedes field validation (4) so error codes never reveal the schema of an entity the principal cannot read.

### 2.2 `pContext` (one object per request, created by `RetoldFacetingService.queryInternal`)

```javascript
{
	RequestID: 'rfq-000017',            // monotonic per process; for logs only
	Entity: 'BookStoreSale',            // route :Entity (validated by step 3)
	Request: pRequest,                  // the restify request, or a synthetic { params: {}, headers: {}, query: {}, UserSession: {…} } for in-process calls
	Host: <RetoldFacetingHostDataService>,
	Options: <resolved RetoldFaceting options>,
	Principal: <Principal>,             // §12.2 (frozen)
	NormalizedRequest: <NormalizedRequest>,   // §3
	FilterAST: <FilterAST>,             // §4
	Variants: { v0: <Variant>, … },     // §6 (set by the Planner)
	Dialect: 'SQLite',                  // Host.getDialectProfile(Entity).Name
	Now: '2026-10-08T15:02:11.120Z',    // pinned once (AsOf of every Live result)
	Deadline: 1791472455120,            // Date.now() + min(Limits.TimeoutMS, request TimeoutMS)
	ForceEngine: null,                  // 'Reference' only via queryInternal options (tests / fixture CLI); never from the client
	Memo: { Relations: {}, Captures: {}, VariantRows: {} },   // per-request memoization (SRs, captures, Reference rows)
	Counters: { Relations: 0, BehaviorRuns: 0, Statements: 0 },
	Warnings: [ ]                       // { Code, Detail } appended by any stage; surfaced in envelope.Warnings
}
```

`Counters.Relations > Limits.MaxRelationsPerRequest` or `Counters.BehaviorRuns > Limits.MaxBehaviorRunsPerRequest` → `422 FACET_TOO_LARGE` (raised by whoever increments). `Date.now() > Deadline` between statements → that facet fails with `504 FACET_TIMEOUT`.

---

## 3. (a) Normalized request — `RetoldFacetingRequestNormalizer.normalize(pEntity, pBody)`

Input: the parsed JSON body (`02 §3`). Output (synchronous; throws a FacetError on rejection):

```javascript
{
	Entity: 'BookStoreSale',
	Clauses: [ <pict clause object, shallow-copied> ],   // shape-checked only (object, Type string); compiled later
	FilterString: 'FBV~PaymentMethod~EQ~Credit' | null,   // RAW as received (still percent-encoded if the client encoded it); FilterValidator decodes once
	Facets:
	[
		{
			Key: 'ByMonth',                     // default: the FacetID (or FacetIDs joined with '|' for a pivot); must be unique → else FACET_REQUEST_INVALID
			FacetIDs: [ 'BookStoreSale.SaleDate' ],   // ALWAYS an array; length 1, or 2 when Fold === 'Pivot'
			Fold: 'DateHistogram' | null,       // null = the catalog default fold (resolved by the Planner)
			Interval: 'month' | null,           // day | week | month | quarter | year
			TimeZone: null,                     // if set and !== Time.StorageTimeZone → 422 FACET_TIMEZONE_UNSUPPORTED (Normalizer)
			Top: 20 | null,                     // integer ≥ 1; clamped to Limits.MaxTop (clamp is silent; a Warning is added)
			Order: 'CountDesc' | 'KeyAsc' | 'KeyDesc' | null,
			Missing: true,                      // default true
			Buckets: 20 | null,                 // NumericHistogram Nice bucket target, 1..Limits.MaxBuckets
			Mode: 'Nice' | 'Edges' | null,      // NumericHistogram; 'Edges' requires Edges; 'Log' → 422 FACET_FOLD_UNSUPPORTED in M1
			Edges: [ 0, 10, 50 ] | null,        // strictly ascending finite numbers, 2..Limits.MaxBuckets+1
			OpenEnded: false,                   // Edges mode: last bucket open ([e_n, ∞))
			Ranges: [ { Key: 'low', From: null, To: 3, Label: 'Low' } ] | null,   // Ranges fold; Keys unique strings; From inclusive, To exclusive
			Exclude: 'Self' | 'None' | [ '<clause Hash or conjunct Id>' … ] | null,   // null = per-fold default (§6.2); 'Group:<n>' → 422 in M1
			CountMode: null,                    // only 'Rows' is legal in M1; anything else → 422 FACET_FOLD_UNSUPPORTED
			Labels: null,                       // accepted, ignored in M1 (no FK label reads yet)
			Chart: false,                       // add the Chart projection
			EmptyBuckets: true                  // DateHistogram gap fill
		}
	],
	Total: true,                            // default true
	TimeoutMS: 10000,                       // min(body.TimeoutMS, Limits.TimeoutMS)
	Freshness: { Mode: 'Exact' },           // accepted and ignored in M1 (Live is always Exact)
	Warnings: [ { Code: 'FACET_TOP_CLAMPED', Detail: { Key, Requested, Applied } } ]
}
```

Rules:

- `Facets` missing or empty → `400 FACET_REQUEST_INVALID`; more than `Limits.MaxFacets` → `400 FACET_TOO_MANY_FACETS`.
- `Facet` may be a string or an array of exactly two strings; an array requires `Fold: 'Pivot'` (and `Fold: 'Pivot'` requires an array of two) → else `400 FACET_REQUEST_INVALID`.
- L1 limits (`06 §8`): body ≤ 256 KiB, JSON depth ≤ 8, `Clauses` ≤ 100, any string value ≤ 1 KiB, any value array ≤ 1 000 → `400 FACET_REQUEST_INVALID` with `Detail.Limit`.
- **Inputs not in M1** (they are later milestones; refuse instead of ignoring, so a client never silently gets an unfiltered answer):
  - `Scopes` (non-empty) or a `NamedScope` clause → `400 FACET_UNKNOWN_SCOPE` (no scopes are registered in M1);
  - `Definition` on a facet → `403 FACET_ADHOC_FORBIDDEN`;
  - `Selections` (non-empty), `FilterExperience` (non-null), `Records`, `Params` (non-empty) → `422 FACET_FOLD_UNSUPPORTED` with `Detail: { Feature: '<field name>', Milestone: 1 }`.
- The legacy `RecordSetSearchFacetPayload` alias (`02 §3.2`) is **not** accepted in M1 (seam: `normalizeLegacy()` stub).
- The Normalizer never looks at the catalog; FacetID existence is checked in step 5. It does validate FacetID **syntax** with `FacetRequest.parseFacetID` (§11.2): a syntactically invalid FacetID (`parseFacetID` returns `null`) is a request-level `400 FACET_REQUEST_INVALID`; a well-formed but unknown FacetID is a per-facet `FACET_UNKNOWN_FACET` (step 5).
- **Pure reference implementation (A):** `FacetRequest.normalizeRequest(pEntity, pBody, pOptions)` (contract, zero requires; shared with the client) implements every rule of this section and returns exactly the shape above; `FacetRequest.normalizeFacetSpec(pSpec, pIndex, pOptions, pWarnings)` and `FacetRequest.checkLimits(pBody, pLimits)` are its parts. The Normalizer service may delegate (`return libFacetRequest.normalizeRequest(pEntity, pBody, this.options);`). Its additions to the rules above: a Fold name that does not exist → `400 FACET_UNKNOWN_FOLD` (request level), a later-milestone fold (`PathTerms`, `BridgeTerms`, `ChildRollup`, `ExistsSplit`, `Computed`, `UnionOfSources`, `TuplePivot`) → `422 FACET_FOLD_UNSUPPORTED`; Keys starting with `#` are reserved (`400`, `Reason: 'ReservedKey'`); `Buckets` above `MaxBuckets` is clamped with warning `FACET_BUCKETS_CLAMPED`; `Edges` without `Mode` imply `Mode: 'Edges'`; filter strings (`FilterString`, a clause's `Filter`, a `RawFilter`'s `Value`) are exempt from the 1 KiB per-string limit (the body limit still applies; the FilterValidator limits each value inside them). Errors carry `Detail: { Field, Index, Reason? }` (`Detail.Limit/Max/Path` for L1).
- The legacy payload converter exists as a seam: `FacetRequest.isLegacyPayload(pBody)` / `FacetRequest.legacyToRequest(pEntity, pBody)`; `normalizeRequest` applies it only when `pOptions.AcceptLegacy === true` (never in M1), otherwise a legacy body is `400 FACET_REQUEST_INVALID` with `Reason: 'LegacyPayload'`.

---

## 4. (b) FilterAST

### 4.1 Predicate nodes (`Pred`) — the DSL shape of `01 §4.4`, column-only in M1

```javascript
{ Field: 'Rating', Op: 'GE', Value: 4 }                       // comparison
{ Field: 'PaymentMethod', Op: 'IN', Value: [ 'Credit', 'Cash' ] }
{ Field: 'Language', Op: 'NULL' }                             // no Value; meadow-filter 'IN' (IS NULL) maps here
{ Field: 'Language', Op: 'NOTNULL' }                          // meadow-filter 'NN'
{ And: [ <Pred>, … ] }
{ Or:  [ <Pred>, … ] }
```

- `Op` ∈ `EQ NE GT GE LT LE LK NLK IN NIN NULL NOTNULL`. `IN`/`NIN` values are non-empty arrays of scalars (≤ 1 000); every other op takes one scalar (string | number | boolean); `NULL`/`NOTNULL` take none.
- `Field` is always a whitelisted column of the conjunct's entity (`Catalog.column(Entity, Field)` non-null). The delete column is legal **only** in conjuncts from `FilterString` or `RawFilter` (§4.4).
- No `Not` node in M1 (meadow-filter cannot express it; clauses do not need it).
- Values are **data**: never template-evaluated, never parsed for `$` tokens. A string value containing `~` (or decoding to it) is rejected (`400 FACET_FILTER_INVALID`).

### 4.2 Conjunct

```javascript
{
	Id: 'c1',                                // 'c' + 1-based index in FilterAST.Conjuncts order
	Origin:
	{
		Kind: 'Clause' | 'String' | 'RawFilter',
		Hash: 'PaymentMethod-DistinctSelectedValueList-3b1f' | null,   // the pict clause Hash when present
		FilterKey: 'PaymentMethod' | null,   // pict clause FilterKey (default: its FilterByColumn when exactly one)
		ClauseType: 'DistinctSelectedValueList' | null,
		Index: 0                             // index of the clause in Clauses[], or of the term in the FilterString
	},
	Fields: [ 'PaymentMethod' ],             // sorted, unique: every Field referenced anywhere in Pred
	NeverExclude: false,                     // true for RawFilter (and, later, NamedScope/definition Where)
	Fence: true,                             // client intent → rendered inside the client fence. Always true in M1.
	NamesDeleted: false,                     // Pred references the entity's delete column (Show-deleted)
	Pred: <Pred>
}
```

### 4.3 FilterAST

```javascript
{
	Entity: 'BookStoreSale',
	Conjuncts: [ <Conjunct>, … ],            // order: all Clauses (array order), then the FilterString terms (left to right)
	IncludesDeleted: false,                  // any conjunct NamesDeleted
	Applied: [ { Hash: '…' } | { String: true } | { RawFilter: '<Hash or index>' } ],   // envelope Filter.Applied
	Warnings: [ { Code: 'FACET_SORT_IGNORED', Detail: 'FSF stanzas do not affect facets.' } ]
}
```

### 4.4 Building conjuncts

**From a meadow-filter string** (`FilterValidator.validate` → stanzas; `FilterAST.fromStanzas` → conjuncts), exactly `01 §8.2`:

- Decode **once** with `decodeURIComponent` (malformed escape → `400 FACET_FILTER_INVALID`), split on `~` into quads; a trailing partial quad is an error.
- Instruction allowlist: `FBV FBVOR FBL FBLOR FOP FOPOR FCP`. `FSF` is **stripped** with warning `FACET_SORT_IGNORED`. Everything else (`FBD FBDOR FBJ* FSJF FDST`, unknown) → `400 FACET_FILTER_INVALID` with `Detail: { Offset: <quad index>, Token }`.
- Operators: `EQ NE GT GE LT LE LK NLK IN NN INN NIN` mapped to `EQ NE GT GE LT LE LK NLK NULL NOTNULL IN NIN`. `FBL`/`FBLOR` accept only `INN`/`NIN` (value split on `,`; empty items rejected). `FBV`/`FBVOR` with `INN`/`NIN` → `400` (meadow-filter would bind a string to an `IN`).
- Field: exact, case-sensitive match of a filterable column (`Catalog.column`); Sensitive and unknown fields → `400 FACET_UNKNOWN_FIELD` with `Detail: { Field }` (the root entity is already authorized, so naming it is safe). The delete column is accepted here.
- Parens: `FOP`/`FOPOR` open, `FCP` closes; **one nesting level** (a `FOP` inside a group → `400`); unbalanced → `400`. Field/Value of paren quads are ignored.
- **Precedence (SQL, the way FoxHound renders flat connectors):** scan depth-0 *terms* left to right (a term is one stanza, or one whole `FOP…FCP` group; its connector is the stanza's / the `FOPOR`'s). Split the term sequence at every `OR`-connected term into OR-branches; each branch = AND of its terms. The connector of the **first** term of a sequence (depth 0, or first inside a group) is ignored (FoxHound emits no connector there). One branch → each term is its own conjunct. Two or more branches → the **whole string is one conjunct** `{ Or: [ And(branch₁), And(branch₂), … ] }` (single-term branches are not wrapped in `And`). Inside a group the same rule produces the group's `Pred`.
- Fixtures (C's tests, also O1): `FBV~A~EQ~1~FBV~B~EQ~2~FBVOR~C~EQ~3` → one conjunct `Or[And(A=1,B=2), C=3]`; `FBV~A~EQ~1~FOP~0~(~0~FBV~B~EQ~2~FBVOR~C~EQ~3~FCP~0~)~0` → two conjuncts `A=1` and `Or[B=2, C=3]`.
- Origin: `{ Kind: 'String', Hash: null, FilterKey: null, ClauseType: null, Index: <term index> }`.

**From pict clauses** (`ClauseCompiler.compile(pEntity, pClauses)` → conjuncts; one conjunct per clause; M1 clause types):

| Clause `Type` | Conjunct `Pred` |
|---|---|
| `DistinctSelectedValueList` (`Values: [...]`, `FilterByColumn` or `FilterByColumns`) | one field: `{ Field, Op: 'IN', Value: [non-null values] }`; several fields: `Or` of those. `null`/`undefined` values skipped (pict does the same). No values left → the clause is **ignored** (no conjunct) and a warning `FACET_CLAUSE_EMPTY` is added. |
| `DateRange`, `NumericRange`, `StringRange`, `Range` (`Values: { Start, End }`, `StartExclusive`, `EndExclusive`) | per field `And[ {GE|GT Start}, {LE|LT End} ]` (missing bound omitted; one bound → just that comparison); several fields: `And` of all. A bound is absent when `null`, `undefined` or `''` — and for `DateRange` also `'0'`. (Deviation from pict: a numeric `0` **is** a bound.) Both absent → ignored + `FACET_CLAUSE_EMPTY`. |
| `Match`, `StringMatch`, `DateMatch`, `NumericMatch` (`Values: [...]`, `ExactMatch`) | `Or` over fields × values of `EQ` (ExactMatch, or Numeric/DateMatch when ExactMatch is undefined) else `LK '%v%'` |
| `RawFilter` (`Filter` or `Value`: a meadow-filter string) | parsed through the FilterString path into **one** conjunct (all its terms ANDed / OR-normalized), `Origin.Kind: 'RawFilter'`, `NeverExclude: true`; may name the delete column |
| anything else (`InternalJoin*`, `ExternalJoin*`, `FacetSelection`, …) | `400 FACET_FILTER_INVALID` with `Detail: { ClauseType, Reason: 'UnsupportedClauseType' }` (`NamedScope` → `400 FACET_UNKNOWN_SCOPE`, §3) |

- `GUIDGroup` + `Junction: 'OR'`: clauses sharing a `GUIDGroup` whose `Junction` is `'OR'` become **one** conjunct `{ Or: [ <each clause Pred> ] }` with `Origin.Hash` = the first clause's Hash and `Fields` = union.
- **Value coercion by column DataType** (L3): `ID`/`Numeric`/`Decimal`/`ForeignKey` → `Number` (non-finite → `400 FACET_FILTER_INVALID`); `Boolean` → `0`/`1` (accepts `true/false/'true'/'false'/0/1/'0'/'1'`); `DateTime` → canonical `'YYYY-MM-DD HH:mm:ss'` via `FacetBuckets.canonicalDateTime(v)` (accepts `YYYY-MM-DD`, `YYYY-MM-DD HH:mm[:ss]`, `YYYY-MM-DDTHH:mm:ss[.fff][Z]`; unparseable → `400`); `String`/`Text` → `String(v)`. FilterString values are **not** coerced (list parity: meadow-filter passes them as strings).
- `FilterByColumn(s)` must be filterable columns (`400 FACET_UNKNOWN_FIELD`); a clause may not name the delete column (only `RawFilter`/`FilterString` may).

### 4.5 Rendering the AST into a FoxHound query — `FilterAST.applyToQuery(pConjuncts, pQuery, pOptions)`

```javascript
FilterAST.applyToQuery(pConjuncts, pQuery, { Dialect: 'SQLite', ParameterPrefix: 'c' })
```

- Appends FoxHound filter entries for the conjuncts, ANDed, **without** the fence (the caller adds `addFilter('', '', '(', 'AND', 'FacetFenceOpen')` before and `addFilter('', '', ')', 'AND', 'FacetFenceClose')` after). Or/And nodes render as `addFilter('', '', '(', <connector>)` … `addFilter('', '', ')')` groups; the first entry inside a group carries connector `AND` (ignored by FoxHound).
- Op → FoxHound operator: `EQ =`, `NE !=`, `GT >`, `GE >=`, `LT <`, `LE <=`, `LK LIKE`, `NLK NOT LIKE`, `IN IN`, `NIN NOT IN`, `NOTNULL IS NOT NULL`, and `NULL`: **`IS NULL` on PostgreSQL/MySQL/MSSQL; on SQLite operator `IS` with value `null`** (the SQLite dialect has no `IS NULL` branch until FH-2; `"C" IS :p` with a NULL bind is SQL's `IS NULL`; verified in the skeleton probe).
- Parameter names: `<ParameterPrefix><ConjunctIndex>_<Field>` (FoxHound appends `_w<i>`), so every bound name is unique and alphanumeric.
- `FilterAST.toFilterString(pConjuncts, pOptions)` renders the same conjuncts as a **fenced** meadow-filter string (`FOP~0~(~0~ … ~FCP~0~)~0`; each conjunct that is an `Or`/`And` group becomes its own nested `FOP`/`FOPOR` … `FCP` group) for the harness `listCount` oracle. Default `{ Encode: false }`: the **raw** (decoded) string — the harness URL-encodes the whole string exactly once for the GET path, and restify decodes it once (meadow-endpoints 4.0.21 GET routes do no further decoding). `{ Encode: true }`: each value `encodeURIComponent`-ed, i.e. the form a client puts in a POST body `FilterString`. `NULL` renders as `FBV~F~IN~0`, `NOTNULL` as `FBV~F~NN~0`, `IN`/`NIN` as `FBL~F~INN~a,b` / `FBL~F~NIN~a,b` (a value containing `,` or `~` → throw `FACET_FILTER_INVALID`: the list cannot carry it). Empty conjunct list → `''`.
- `FilterAST.build(pEntity, pInput)` reads **only** `pInput.Clauses` and `pInput.FilterString` (so the harness can call it without a full NormalizedRequest).

---

## 5. (c) FoldIR subset (K1–K7, K14) — `RetoldFacetingFoldIR` + `RetoldFacetingPlanner`

The Planner turns each normalized facet spec + catalog descriptor into one **Agg**. Engines compile Aggs; nothing downstream re-reads the catalog for typing (every Dim carries what it needs).

### 5.1 Agg

```javascript
{
	Key: 'ByMonth',                          // request Facets[].Key ('#Total' for the envelope Total)
	FacetID: 'BookStoreSale.SaleDate',       // pivot: the two FacetIDs joined with '|'
	FacetIDs: [ 'BookStoreSale.SaleDate' ],
	Kind: 'DateHistogram',                   // Terms | DateHistogram | NumericHistogram | Ranges | Stats | DistinctCount | Missing | Pivot | Count
	Pivot: 'BookStoreSale',                  // entity pivot (string) — TuplePivot/Union are later
	Dimensions: [ <Dim> ],                   // Terms/DateHistogram/NumericHistogram/Ranges: 1; Pivot: 2; Stats/DistinctCount/Missing/Count: []
	Field: 'SaleDate',                       // the measured column for Stats/DistinctCount/Missing; = Dimensions[0].Field for bucketed folds; null for Pivot/Count
	FieldInfo: <ColumnInfo>,                 // §11.1 (for Stats/DistinctCount/Missing; null otherwise)
	Measures: [ { Op: 'count' } ],           // M1: always count; Stats implies its own fixed measure set
	CountMode: 'Rows',                       // M1: always Rows (all M1 dimensions are single-valued)
	Top: 20,                                 // Terms (and per-axis for Pivot); null otherwise
	Order: 'CountDesc',
	Missing: true,
	EmptyBuckets: true,
	Chart: false,
	Exclude: 'Self',                         // resolved policy (§6.2)
	VariantId: 'v1',
	Disjunctive: { Mode: 'Exact' | 'Partial' | 'NotApplicable', Excluded: [ 'c2' ], ExcludedHashes: [ '…' ], KeptMixed: [ ], Owned: [ 'c2' ] },
	ClauseType: 'DateRange' | 'DistinctSelectedValueList' | 'NumericRange' | null,
	FilterKey: 'SaleDate' | null,
	Selectable: true,                        // bucketed single-field folds; false for Stats/DistinctCount/Missing/Pivot/Count
	DepSet: { BookStoreSale: [ 'IDBookStoreSale', 'SaleDate', 'Deleted', … ] },   // pivot columns: PK, dims/measure cols, every conjunct field, delete column, policy columns
	DisplayName: 'Sale Date'
}
```

### 5.2 Dimensions

```javascript
{ Kind: 'Column',        Field: 'PaymentMethod', DataType: 'String', IsInteger: false, Scale: 0 }
{ Kind: 'DateBucket',    Field: 'SaleDate', Interval: 'month' }                     // day | week | month | quarter | year
{ Kind: 'NumericBucket', Field: 'TotalAmount', Mode: 'Nice', Buckets: 20, Edges: null, OpenEnded: false, IsInteger: false, Scale: 2 }
{ Kind: 'NumericBucket', Field: 'PublicationYear', Mode: 'Edges', Buckets: null, Edges: [ 1800, 1900, 2000, 2030 ], OpenEnded: true, IsInteger: true, Scale: 0 }
{ Kind: 'Range',         Field: 'Rating', Ranges: [ { Key: 'low', From: null, To: 3, Label: 'Low' }, { Key: 'high', From: 3, To: null, Label: 'High' } ], IsInteger: true, Scale: 0 }
```

Fold → Dim: `Terms → Column`, `DateHistogram → DateBucket`, `NumericHistogram → NumericBucket`, `Ranges → Range`. `Pivot` axes: each FacetID's own default fold mapped the same way, with the request's `Interval` applied to date axes; **M1 allows only `Column`, `DateBucket` and `Range` axes** (a numeric-histogram axis → per-facet `422 FACET_FOLD_UNSUPPORTED`). Both pivot axes must be on the route entity.

### 5.3 Per-kind semantics every engine implements identically

All counts are over the Agg's Variant base set `B(F′)` (each pivot row once). "Key" below is the dimension key computed by the canonical functions of `contract/Facet-Contract-Buckets.js` (§10.3) — engines must produce byte-identical keys.

| Kind | Raw result fields (§9.2) |
|---|---|
| `Count` (`#Total`) | `Total` |
| `Terms` | `Total`, `MissingCount` (rows whose value IS NULL; for a numeric DataType also any non-number — `''`, `' '`, text — by `FacetBuckets.numericValue`), `Groups` = non-null keys with counts — at least `min(Top + 1, DistinctKeys)` groups chosen by the canonical order (CountDesc, then Key ascending by `FacetBuckets.compareKeys`), plus every selected key; the Live statement ranks by count whatever the `Order` and returns at most `max(Top + 1, Limits.MaxTermsGroups)` ranked rows (ties beyond that in SQL key order — BINARY on SQLite, i.e. canonical) plus the selected keys (one scalar bind each through the `P0` slot); the Reference returns all groups. `DistinctKeys` (number of distinct non-null keys). |
| `DateHistogram` | `Total`, `MissingCount` (rows whose `dateKey` is null: NULL, `''`, unparseable), `Groups` = every non-null key, `Bounds: { Lo, Hi }` = min/max of `canonicalDateTime(value)` over rows with a non-null key (null when none). More than `Limits.MaxDateBuckets` keys after gap fill → `422 FACET_INTERVAL_TOO_FINE` with `Suggest: { Interval: <next coarser> }` (raised in post-processing). The Live statement returns at most `MaxDateBuckets + 2` key rows (anything more is TOO_FINE whatever the rest holds). |
| `NumericHistogram` | `Total`, `MissingCount` (NULL), `Bounds: { Lo, Hi }` (min/max of non-null values; null when NonNull = 0), `Geometry` (§10.3.2: `FacetBuckets.numericGeometry(Bounds.Lo, Bounds.Hi, Dim.Buckets, Dim.Scale, Limits.MaxBuckets)` in Nice mode — the Live engine runs a bounds statement first — or `FacetBuckets.edgesGeometry(Dim.Edges, Dim.OpenEnded, Dim.Scale)`), `Groups` = `{ Key: <bucket index>, Count }` for non-empty indexes; rows outside an `Edges` geometry (below the first edge, or ≥ the last edge when not `OpenEnded`) are in no group (they surface as `OtherCount`). |
| `Ranges` | `Total`, `MissingCount` (NULL), `Groups` = `{ Key: <range Key>, Count }`; a row goes to the **first** range in declared order with `(From == null || v >= From) && (To == null || v < To)` (CASE semantics); rows in no range → no group. |
| `Stats` | `Total` (= Rows), `MissingCount` (= Rows − NonNull), `Stats: { Rows, NonNull, Min, Max, SumUnits, Factor }` — numeric: `SumUnits = Σ round(v × Factor)` (an exact integer), `Factor = 10^Scale`; DateTime: `Min`/`Max` canonical strings, `SumUnits: null`. |
| `DistinctCount` | `Total`, `MissingCount`, `DistinctCount` (distinct non-missing values; binary comparison; a numeric DataType counts only numbers) |
| `Missing` | `Total`, `MissingCount` (NULL; DateTime also unparseable; a numeric DataType also any non-number) |
| `Pivot` | `Total`, `Cells: [ { Keys: [ k1, k2 ], Count } ]` — **every** non-empty cell, including cells with a null key on either axis (post-processing moves those into `MissingCount`) and cells whose Range-axis value is in no declared range (key `FacetBuckets.NO_RANGE_KEY` = `'#NoRange'`; post-processing counts those as `OtherCount`, exactly like the Ranges fold). Each axis key is computed exactly as its single-dimension fold computes it (`Column` → `normalizeKey` / `numericValue`, `DateBucket` → `dateKey`, `Range` → the first matching range Key, null for NULL, `NO_RANGE_KEY` for no range). More than `Limits.CubeMaxGroups` cells → per-facet `422 FACET_TOO_LARGE { Limit: 'CubeMaxGroups' }` on every engine (the Live statement stops at `CubeMaxGroups + 1` cells). |

Envelope arithmetic (`OtherCount`, `SumOfCounts`, gap fill, Top truncation, labels, clauses) is done **only** in post-processing (§10.4), never in an engine.

### 5.4 `FoldIR` service and `Planner` service (wiring owns both)

```javascript
RetoldFacetingFoldIR.agg(pFields)            → Agg with defaults applied (pure)
RetoldFacetingFoldIR.dimensionFor(pFold, pDescriptor, pFacetSpec)  → Dim (pure)
RetoldFacetingFoldIR.depSet(pAgg, pVariant, pCatalog) → { Entity: [cols] } (pure)
RetoldFacetingPlanner.plan(pContext, fCallback) → fCallback(null, { Aggs: [Agg…], Variants: {…}, DepSet: {…}, Errors: { Key: FacetErrorEntry } })
RetoldFacetingPlanner.lower(pFacetSpec, pDescriptors, pContext)  → Agg (pDescriptors: one catalog descriptor per FacetID; throws a per-facet FacetError)
RetoldFacetingPlanner.depSet(pAggs)                              → the union of every Agg's DepSet (sorted columns)
```

`plan()` always emits the `#Total` Agg (`Kind: 'Count'`, `VariantId: 'v0'`) when `NormalizedRequest.Total` is true. Per-facet planning errors go to `Errors[Key]`, not to `fCallback(pError)`.

---

## 6. (d) Variants — `RetoldFacetingDisjunctivePlanner.variants(pFilterAST, pFacetSpecs)`

### 6.1 Input

```javascript
pFacetSpecs = [ { Key: 'ByMonth', OwnedFields: [ 'SaleDate' ], FilterKey: 'SaleDate', Exclude: 'Self' }, … ]
```

`OwnedFields` = `OF(f)` = the dimension field(s) (auto facets in M1); a Pivot owns both axis fields; Stats/DistinctCount/Missing own their field.

### 6.2 Exclusion rules (`01 §8.3`)

- Default `Exclude`: `Self` for Terms, DateHistogram, NumericHistogram, Ranges; `None` for Stats, DistinctCount, Missing, Pivot (and `#Total`).
- A conjunct is **owned** by facet f when (in this order): its `Origin.Hash` or `Id` is listed in an explicit `Exclude` array; or `Origin.FilterKey` equals f's `FilterKey`; or `Fields ⊆ OwnedFields`.
- Under `Self` (or an explicit array) owned conjuncts are excluded, **except** `NeverExclude` conjuncts, which are kept.
- A conjunct whose `Fields` intersect `OwnedFields` but is not owned (mixed), or an owned `NeverExclude` conjunct, is kept and listed in `KeptMixed`; the facet's mode is then `Partial`.
- Mode: `NotApplicable` under `None`; else `Partial` if `KeptMixed` is non-empty, else `Exact`.

### 6.3 Output

```javascript
{
	Variants:
	{
		v0: <Variant>,          // ALWAYS present: the full filter (every conjunct) — Total, and every Exclude:'None' facet
		v1: <Variant>, …        // one per distinct kept-conjunct set, numbered in order of first appearance among pFacetSpecs
	},
	Facets:
	{
		ByMonth: { VariantId: 'v1', Mode: 'Exact', Excluded: [ 'c2' ], ExcludedHashes: [ 'SaleDate-DateRange-7a01' ], KeptMixed: [ ], Owned: [ 'c2' ] }
	}
}
```

Variant:

```javascript
{
	VariantId: 'v1',
	Hash: 'c1,c3',                    // canonical: kept conjunct Ids joined with ',' (stable; '' for the empty set)
	Entity: 'BookStoreSale',
	ConjunctIds: [ 'c1', 'c3' ],      // kept, in FilterAST order
	Conjuncts: [ <Conjunct>, … ],     // the same objects as FilterAST.Conjuncts (never copies)
	ExcludedIds: [ 'c2' ],
	IncludesDeleted: false,           // any kept conjunct NamesDeleted → the pivot SR uses SoftDelete 'ClientControlled'
	Facets: [ 'ByMonth' ]             // Agg keys sharing it ('#Total' is in v0)
}
```

Facets with identical kept sets **share** a Variant (and therefore a pivot Scoped Relation, memoized per request). The conditional disjunctive scan (one GROUP BY for all single-valued facets, `01 §8.4`) is **not** M1; the Variant/Owned data above is exactly what it will need.

---

## 7. (e) Scoped Relations — `RetoldFacetingScopedRelationBuilder.buildRelation(pContext, pRel, fCallback)`

### 7.1 `Rel` (FoldIR relation, M1 subset of `01 §6`)

```javascript
{
	Entity: 'BookStoreSale',
	As: 'p',                                  // alias: ^[a-eg-z][a-z0-9]{0,7}$ — never starts with 'f' (shell params are f*)
	Project: [ 'IDBookStoreSale', 'SaleDate' ],   // minimal: PK + dimension/measure columns; never Sensitive
	Client: [ <Conjunct>, … ] | null,         // the Variant's conjuncts (fenced)
	Where: null,                              // definition predicates — later milestones
	Scope: 'Inherit',                         // 'TenantOnly' is later
	SoftDelete: 'Explicit' | 'ClientControlled'   // 'ClientControlled' iff Variant.IncludesDeleted
}
```

### 7.2 Build steps (normative; `03 §3.2`)

1. `tmpDAL = Host.getExecutionDAL(Entity)`; `tmpQuery = tmpDAL.query` (fresh clone).
2. If `Client` non-empty: `addFilter('', '', '(', 'AND', 'FacetFenceOpen')`, `FilterAST.applyToQuery(Client, tmpQuery, { Dialect })`, `addFilter('', '', ')', 'AND', 'FacetFenceClose')`.
3. If `SoftDelete === 'Explicit'` and `Host.hasDeleteColumn(Entity)`: `addFilter(Host.getDeleteColumn(Entity), 0, '=', 'AND', 'FacetSoftDelete')` (depth 0, outside the fence; D-37).
4. `ScopeCapture.capture(pContext, Entity, tmpQuery, Scope, fCaptured)` — runs `Reads-QueryConfiguration` on the **route-bound** controller, then ScopeGuard (§8). Error → `fCallback(error)`. `Capture.Opaque` → refused in M1 (`500 FACET_SCOPE_POLICY_VIOLATION`, `Reason: 'OpaqueUntrusted'`; Staged hops are later).
5. `tmpQuery.parameters.FacetProjection = Project.map(quote).join(', ')`; `tmpQuery.parameters.queryOverride = 'SELECT <%= _Params.FacetProjection %> FROM<%= TableName %><%= Where %>'`; `tmpQuery.setDialect(DialectName).buildReadQuery()`.
6. `Dialects.harvest(tmpQuery, As, DialectName)` → rename every bound name `X` in `query.query.parameters` to `<As>_X` (longest names first, word-boundary, dialect sigil, skip PG `::`), strip a trailing `;`.

Memoized in `pContext.Memo.Relations` by `Entity|As|ClientIds|SoftDelete|Project`; each new build increments `pContext.Counters.Relations` and (via capture) `BehaviorRuns`.

### 7.3 Result

```javascript
{
	Alias: 'p',
	Entity: 'BookStoreSale',
	SQL: 'SELECT "IDBookStoreSale", "SaleDate" FROM BookStoreSale WHERE ( `PaymentMethod` IN ( :p_c1_PaymentMethod_w1_0 ) ) AND `Deleted` = :p_FacetSoftDelete_w3 AND `IDTenant` = :p_TestTenancy_w4',
	Params: { p_c1_PaymentMethod_w1_0: 'Credit', p_FacetSoftDelete_w3: 0, p_TestTenancy_w4: 1 },
	ParamTypes: { },                          // MSSQL only (merged into query.parameterTypes by the engine)
	Columns: [ 'IDBookStoreSale', 'SaleDate' ],
	Capture: <ScopeCapture>,                  // §8.1
	Staged: false
}
```

### 7.4 Composing and executing a statement (EngineLive, `03 §3.7`)

- Outer query: `tmpPivotDAL.query`, **`setDisableDeleteTracking(true)`** (so FoxHound adds no stray `Deleted` param to the outer statement), `parameters['SR' + i] = Relation.SQL`, `Object.assign(query.query.parameters, Relation.Params)`, shell slot text into `query.parameters.<Slot>`, bound shell values (`f*` names, scalars only, never arrays) into `query.query.parameters`, `parameters.queryOverride = <shell template>`.
- Execute with `tmpPivotDAL.provider.Read(tmpQuery, fDone)` inside `try/catch`; rows are `tmpQuery.parameters.result.value` (raw driver rows; on SQLite they are null-prototype objects — copy to plain objects before returning).
- Shell templates come from `ShellTemplates.render(pDialectName, pAgg, pSlots)`; per-dialect expressions (date keys, numeric index, clamp) come from `Shell-Templates-<Dialect>.js`. PostgreSQL/MySQL/MSSQL shells must **dry-build** (SQL text goldens via `setDialect('<Dialect>').buildReadQuery()` with no provider) but are never executed in M1.
- `EngineLive.compileAgg(pContext, pAgg, pRelations, pDialectName)` → `{ Dialect, SQL, Params, ParamTypes, Statements: [ … ] }` without executing — the O9 golden entry point.

---

## 8. (f) ScopeCapture and ScopeGuard

### 8.1 `RetoldFacetingScopeCapture.capture(pContext, pEntity, pQuery, pScopeMode, [pCaptureOptions,] fCallback)`

`pCaptureOptions` (optional, M2 review): `{ Columns: [ … ] }` — the relation's projection (the PostOperation safe-column rule below); `{ Fresh: true }` — never replay a memoized capture (Records hydration needs the request state this very query's behavior ran with).

```javascript
{
	Entity: 'BookStoreSale',
	Source: 'Behaviors',                       // 'Declared' (controller-less) is later
	Behavior: 'Reads-QueryConfiguration',      // Scope.BehaviorOverrides[Entity] || Scope.Behavior
	BehaviorRan: true,                         // false when the controller has no behavior at that hash
	PostBehaviorFilter: [ <filter entry copies> ],   // deep copy of query.parameters.filter after behaviors
	Appended: [ { Column: 'IDTenant', Operator: '=', Value: 1, Connector: 'AND', Parameter: 'TestTenancy', Depth: 0 } ],
	Transformed: [ { Index: 3, Before: { Operator: 'LIKE' }, After: { Operator: 'ILIKE' } } ],
	Opaque: false,
	OpaqueReasons: [ ],                         // 'JoinAdded' | 'QueryOverride' | 'QueryBranches' | 'UnknownColumn:<c>' | 'UnknownOperator:<op>' | 'NonScalarValue:<c>' | 'PostOperation'
	PostOperation: null | { Behaviors: [ 'Reads-PostOperation' ], Opaque, Trusted },   // the read-side behaviors present (06 §3.5)
	Portable: true,                             // !Opaque and every operator in the base set (stores are later; kept for the seam)
	Guard: <GuardResult>,                       // §8.2
	Fingerprint: 'sf:9c1e4a0b77d2'              // 'sf:' + first 12 hex of sha256(Entity | canonical(Appended) | canonical(Transformed) | Behavior | ScopeMode)
}
```

- Snapshot before: deep copy of `filter`, plus `join`, `queryOverride`, `queryBranches`, `dataElements`, `distinct`. Run the behavior with `controller.initializeRequestState(pContext.Request, 'Reads')`, `state.Query = pQuery`, `controller.BehaviorInjection.runBehavior(Behavior, controller, pContext.Request, state, cb)`. Behavior error (e.g. a tenancy behavior's 401) → `fCallback(FacetError FACET_UNAUTHENTICATED (401) when the behavior error carries status 401, else FACET_INTERNAL)`.
- `Depth` on each entry = paren depth at that entry (the fence makes client entries depth ≥ 1).
- Memoized per request in `pContext.Memo.Captures` by `(Entity, ClientIds, SoftDelete, ScopeMode)`; each run increments `pContext.Counters.BehaviorRuns`.
- Column checks strip a table qualifier and quotes (`"T"."C"`, `` `T`.`C` ``, `T.C` → `C`).
- **Read-side behavior audit (06 §3.5, M2 review).** The list paths also run `Read-PreOperation`, `Reads-PostOperation`, `ReadsLite-PostOperation`, `ReadDistinct-PostOperation`, `ReadSelectList-PostOperation`; a row filter or redaction there is invisible to a capture of the QueryConfiguration. When the route-bound controller has any of them (`BehaviorInjection.getBehaviors()` once ME-1 lands, else the `_BehaviorFunctions` keys) the capture is **Opaque** with reason `'PostOperation'` — refused, and never stageable (a staged key query does not run it either) — unless the entity is in `Scope.TrustPostOperation` (the host vouches that the behavior only decorates) or every column the relation reads (its `Columns` projection plus every column its pre-behavior filter names, the explicit soft delete excepted) is listed in `Scope.PostOperationSafeColumns[Entity]` (the host vouches that the behavior never drops a row and never changes those columns). Without `Columns` the safe-column rule cannot apply (fail closed). The audit is part of the memo key. This covers the pivot of Query / Records / Count / Keys, every hop, fragment probes and label reads (an Opaque label read only loses its labels). Describe reports `Entities[E].Opaque: { Reason: 'PostOperation', SafeColumns }`.
- The capture object carries its request state as a non-enumerable `RequestState` (never hashed).

### 8.2 `RetoldFacetingScopeGuard.assert(pContext, pEntity, pQuery, pCapture)` → `GuardResult` (synchronous)

Uses `pContext.Host.getScopePolicy()` and `pContext.Principal`. Called by `ScopeCapture.capture` after the behaviors ran; a refusal is returned as the result (`Satisfied: false`) and `capture` turns it into the `FACET_SCOPE_POLICY_VIOLATION` callback error (with `Detail: { Entity, Violations }` — column names only, never values).

```javascript
{
	Mode: 'Strict' | 'Repair' | 'Off',
	Required: [ { Column: 'IDTenant', Value: 1 } ],   // from Host.getScopePolicy().requiredFor(Entity, Principal)
	Satisfied: true,
	Repaired: false,
	Violations: [ ]   // { Rule: 'MissingPredicate' | 'WrongValue' | 'DepthZeroOr' | 'UnbalancedFence' | 'OpaqueUntrusted' | 'UnsetValue' | 'PersonalColumnPresent' | 'TenantOnlyUnscoped', Column? }
}
```

Assertion per required column `C` (`06 §3.3`): (1) an entry at depth 0 with `Operator '='`, `Connector 'AND'`, column `C` (a qualified entry must name the entity's own table: `Other.IDCustomer` never satisfies this entity's requirement); (2) its `Value` equals the principal's policy value and that value is not in `Scope.UnsetValues`; (3) **no depth-0 entry has connector `OR`**; (4) the fence is balanced. `Strict` → violation = `500 FACET_SCOPE_POLICY_VIOLATION` (the capture calls back with the error; no SQL runs). `Repair` → **only** when every violation is `MissingPredicate`: wrap the whole post-behavior filter in a new depth-0 group, append `addFilter(C, value, '=', 'AND', 'FacetPolicy' + C)`, `Repaired: true`, log error, and the route sets `X-Retold-Facet-Scope-Repaired: 1`; any other violation is refused as in Strict. `Off` → `Satisfied: true`, no checks (only legal with no policy).

### 8.3 Scope policy config (plain RDS, `RetoldFaceting.Scope`)

```javascript
Scope:
{
	Behavior: 'Reads-QueryConfiguration',
	BehaviorOverrides: { },
	Guard: 'Strict',                         // effective 'Off' when Policy is false and Required is empty (Describe: ScopeAssurance 'Unscoped')
	Policy: false | { Column: 'IDTenant', SessionField: 'IDTenant', Exclude: [ ], PersonalScopes: { } },   // 'Auto' === false on plain RDS
	Required: { },                           // { Entity: [ { Column, From: '$CurrentUser.<Field>' | '$Scope.<Column>' } ] }
	UnsetValues: [ 0, '', null ],
	TrustedOpaque: [ ],                      // M2: entities whose Opaque capture may run Staged (§26.3)
	TrustPostOperation: [ ],                 // M2 review: entities whose read-side Pre/PostOperation behavior only decorates (§8.1)
	PostOperationSafeColumns: { },           // M2 review: { Entity: [ columns the PostOperation never drops a row over nor changes ] }
	UserRecordFields: [ 'IDUser', 'IDCustomer' ],
	AllowHeaderSession: false
}
```

`Host.getScopePolicy()` normalizes this into:

```javascript
{
	Kind: 'Policy' | 'None',
	Column: 'IDTenant', SessionField: 'IDTenant', Exclude: [ ], PersonalScopes: { }, Required: { }, UnsetValues: [ 0, '', null ], Guard: 'Strict',
	requiredFor: function (pEntity, pPrincipal) { return [ { Column, Value } ]; },   // [] for Global entities
	isScoped: function (pEntity) { return true | false; }                          // has ≥ 1 required column
}
```

Required set for entity `E` (plain RDS, M1): the policy `Column` if `E` has that column and is not in `Exclude`; plus `PersonalScopes[E].Column`; plus `Required[E]` entries. Values: `Principal.ScopeValues[Column]`.

---

## 9. (g) Engines and the Router

### 9.1 Engine interface (`RetoldFacetingEngineBase`, `03 §4`)

```javascript
get EngineName()                                   // 'Live' | 'Reference'
capable(pAgg, pContext)          → { Capable: true } | { Capable: false, Reason: '…' }     // pure, no I/O
freshness(pDepSet)               → { Exact: true, AsOf: <ISO>, LagMS: 0 }
execute(pContext, pAggs, fCallback)
```

`execute` runs every Agg (all Variants) of one request. Callback:

```javascript
fCallback(pError, pExecution)
// pError: only for whole-request failures (scope violation on the pivot, behavior 401, DB unavailable)
pExecution =
{
	Engine: 'Live',
	AsOf: pContext.Now,
	Exact: true,
	Results: { '#Total': <RawFacetResult>, ByMonth: <RawFacetResult>, … },
	Errors: { Pages: <FacetErrorEntry> },             // per-Agg failures (timeout, too fine, unsupported)
	Captures: { BookStoreSale: { Fingerprint: 'sf:…', Repaired: false } },   // for Version and the Repaired header
	Statements: 3                                     // Live: statements executed; Reference: list reads executed
}
```

### 9.2 RawFacetResult

```javascript
{
	Key: 'ByMonth',
	Kind: 'DateHistogram',
	VariantId: 'v1',
	Total: 4120,
	MissingCount: 3,
	Groups: [ { Key: '2026-03-01 00:00:00', Count: 412 }, … ],   // see §5.3 per kind (unordered is fine)
	DistinctKeys: null,                     // Terms only
	Bounds: { Lo: '2025-07-01 00:00:00', Hi: '2026-06-30 23:10:00' } | null,
	Geometry: null,                         // NumericHistogram only (§10.3.2)
	Stats: null,                            // Stats only
	DistinctCount: null,                    // DistinctCount only
	Cells: null                             // Pivot only
}
```

Numbers are JS numbers (engines convert driver bigint/string counts). Keys: Terms keys are the raw column value normalized by `FacetEnvelope.normalizeKey(value, DataType)` (Numeric/Decimal/ID/Boolean/ForeignKey → Number; everything else → String; null stays null).

### 9.3 EngineLive (D) and EngineReference (E)

- **Live** (`03 §3`): per Agg, one pivot SR for the Variant (memoized), then one statement per Agg (NumericHistogram `Nice`: a bounds statement first, then the bucket statement; `Pivot` on SQLite: one `GROUP BY k1, k2` statement — marginals are post-processing). `capable()` refuses nothing M1 plans produce.
- **Reference** (O1, `10 §5.1`): **must not** use ScopedRelationBuilder, Dialects, ShellTemplates or EngineLive. Per Variant (memoized in `pContext.Memo.VariantRows`): replay the **list endpoint waterfall** on the route-bound controller: `state = controller.initializeRequestState(pContext.Request, 'Reads')`; `state.Query = controller.DAL.query` (the DAL the list itself reads through, which is also `Host.getExecutionDAL(Entity)` for Live: after an RDS reload re-binds `fable.DAL[E]` the routes keep the old controller, D-31); `setCap(0)` (no LIMIT) and `setBegin(0)`; fence `(`…`)` around `FilterAST.applyToQuery(Variant.Conjuncts, state.Query, { Dialect })`; **no explicit soft-delete** (FoxHound's implicit `Deleted = 0`, exactly as the list); `runBehavior(Scope.Behavior)`; `controller.DAL.doReads(state.Query, (pError, pQuery, pRecords) => …)`; `runBehavior('Reads-PostOperation')`. Then fold the records in JS with the canonical functions of `contract/Facet-Contract-Buckets.js` and return the same RawFacetResult shapes. The Reference engine **does not** run ScopeGuard (the list does not); its capture fingerprint is `'ref:' + VariantHash`. A behavior error maps through the shared `FacetErrors.fromBehaviorError` (a facet error passes through; status `401` — number or numeric string — → `FACET_UNAUTHENTICATED`; else `FACET_INTERNAL`), exactly as ScopeCapture maps it, as a whole-request `pError`. Records are plain objects from meadow's marshaller (`DefaultObject` + every selected column, NULLs preserved).

### 9.4 Router (wiring)

```javascript
RetoldFacetingRouter.register(pEngine)
RetoldFacetingRouter.route(pAggs, pContext, fCallback)   // → fCallback(pError, pExecution)
```

M1: `pContext.ForceEngine` set → that engine; otherwise the first registered engine whose `capable()` accepts every Agg — `Live`. (Cache, stores, Pushdown, FanOut are later.)

---

## 10. (h) Envelope, FacetResult, Bucket — and the canonical math

### 10.1 Envelope (`02 §4.1`, M1 fields)

```javascript
{
	ContractVersion: 1,
	Entity: 'BookStoreSale',
	Version: 'fv1:9c1e4a0b77d2c3e4',    // weak ETag value (§10.5); header ETag: W/"fv1:…"
	ModelVersion: 'm:4a1e9b0c22d1',
	Engine: 'Live',                     // engine of the Total
	Exact: true,
	AsOf: '2026-10-08T15:02:11.120Z',
	LagMS: 0, Stale: false, Cached: false,
	ElapsedMS: 41,
	Total: 1834,                        // only when Total requested; = list Count for the same session and filter
	TotalCountMode: 'Rows',
	IncludesDeleted: false,
	Filter: { Applied: [ … ], Warnings: [ … ] },   // FilterAST.Applied / FilterAST.Warnings
	Facets: { ByMonth: <FacetResult>, … },
	Errors: { Pages: { Code: 'FACET_TIMEOUT', Status: 504, Message: 'Facet exceeded its deadline.' } },
	Warnings: [ ]                       // pContext.Warnings + NormalizedRequest.Warnings
}
```

Partial success → HTTP 200 with `Errors`. The request fails (HTTP status of the first error, body `{ Error: … }`) only when every facet **and** the Total (if requested) failed.

### 10.2 FacetResult (`02 §4.3`, M1 fields)

```javascript
{
	Key: 'ByMonth', Facet: 'BookStoreSale.SaleDate', Field: 'SaleDate', Fold: 'DateHistogram',
	DisplayName: 'Sale Date', DataType: 'DateTime',
	Selectable: true, ClauseType: 'DateRange', FilterKey: 'SaleDate',
	Engine: 'Live', Exact: true, AsOf: '…', LagMS: 0, Stale: false, Cached: false,
	Interval: 'month', TimeZone: 'UTC',                         // date folds only
	Disjunctive: 'Exact', Excluded: [ '<clause Hash, else conjunct Id>' ], KeptMixed: [ ],
	CountMode: 'Rows',
	Total: 4120, SumOfCounts: 4117, MissingCount: 3, OtherCount: 0,
	MultiValued: false, Truncated: false, TruncatedReason: null,   // 'Top' | 'MaxBuckets'
	DistinctCount: 31,                                        // Terms: DistinctKeys; DistinctCount fold: the value
	Bounds: { Lo, Hi } | null,
	Buckets: [ <Bucket> ],                                    // [] for Stats/DistinctCount/Missing/Pivot
	Stats: { Rows, NonNull, Min, Max, Sum, Avg } | null,     // Stats fold
	// Pivot results only (02 §4.3, at the FacetResult top level):
	Dimensions: [ { Facet, Field, Fold, Interval } ], RowKeys: [ … ], ColumnKeys: [ … ],
	Cells: [ { K1, K2, Count } ], Marginals: { Rows: [ { Key, Count } ], Columns: [ { Key, Count } ], Total },
	Geometry: null | { Mode, Lo, Hi, Width, N, Scale, Edges: [ … ] },   // NumericHistogram
	Chart: null | { Labels: [ … ], Datasets: [ { label: DisplayName, data: [ … ] } ] }
}
```

- `OtherCount = Total − SumOfCounts − MissingCount` (always present: every M1 fold is single-valued); for Stats/DistinctCount/Missing it is `0` and `SumOfCounts` is `0`.
- Selected-zero Terms keys (§10.4) are counted in `SumOfCounts` as 0 and do not change `OtherCount`.
- Stats formatting: `Decimal` → `Min`, `Max`, `Sum` as strings with exactly `Scale` decimals (`(units / Factor).toFixed(Scale)`, computed from integer units); integer columns → `Min`, `Max`, `Sum` as Numbers; every numeric column → `Avg = Number((SumUnits / NonNull / Factor).toFixed(Scale + 4))` (a Number); `DateTime` → `Min`/`Max` canonical strings, `Sum`/`Avg` null; `NonNull === 0` → `Min`/`Max`/`Sum`/`Avg` null.

### 10.3 Canonical math (`contract/Facet-Contract-Buckets.js`; both engines and the post-processor use these)

#### 10.3.1 Dates (D-22: naive wall clock in `StorageTimeZone`, wire format `YYYY-MM-DD HH:mm:ss`)

- `canonicalDateTime(v)` → `'YYYY-MM-DD HH:mm:ss'` or `null`. Accepts strings `YYYY-MM-DD`, `YYYY-MM-DD HH:mm`, `YYYY-MM-DD HH:mm:ss`, with `T` instead of space, optional `.fff` and optional `Z`/`+00:00` (dropped — StorageTimeZone is UTC in M1). `''`, `null`, non-strings, out-of-range parts → `null`.
- `dateKey(v, pInterval)` → bucket start string or `null` (null whenever `canonicalDateTime(v)` is null). `day`: `YYYY-MM-DD 00:00:00`; `week`: ISO Monday on or before the date; `month`: `YYYY-MM-01 00:00:00`; `quarter`: first month of the quarter; `year`: `YYYY-01-01 00:00:00`. Must equal SQLite `strftime` (`03 §3.4` table) for canonical inputs.
- `nextDateKey(pKey, pInterval)` → the following bucket start (the bucket's `End`).
- `fillDateKeys(pLoKey, pHiKey, pInterval, pMax)` → every key from Lo through Hi inclusive (more than `pMax` keys → throws `FACET_INTERVAL_TOO_FINE` with `Detail: { Suggest: { Interval: coarserInterval(pInterval) } }`).
- `dateLabel(pKey, pInterval)` → `day` `'2026-03-02'`, `week` `'Week of 2026-03-02'`, `month` `'Mar 2026'`, `quarter` `'Q1 2026'`, `year` `'2026'`.
- `coarserInterval(pInterval)` → `day→week→month→quarter→year→null` (for `Suggest`).

#### 10.3.2 Numbers (integer-unit bucketing; exact on every dialect)

- `Scale` = column scale (`Decimal(10,2)` → 2; integer columns 0); `Factor = 10^Scale`; `units(v) = Math.round(v * Factor)` (SQL: `ROUND(v * :fFactor)` cast to integer). The GEOMETRY is integer-unit; bucket MEMBERSHIP is decided against the exact edges with the RAW value (below), so a value with more decimals than the Scale (SQLite REAL) lands where its bucket Clause puts it.
- `numericGeometry(pLo, pHi, pBuckets, pScale, pMaxBuckets)` (Nice mode) → `{ Mode: 'Nice', Lo, Hi, Scale, Factor, LoUnits, WidthUnits, Width, N, Edges }`, computed entirely in integer units:
  ```
  loU = units(Lo); hiU = units(Hi)
  loU −= 1 when the edge loU/Factor > Lo;  hiU += 1 when hiU/Factor < Hi      (cover the RAW bounds)
  candidates (units) = 1, 2, 5, 10, 20, 50, 100, …          (m × 10^k, m ∈ {1,2,5}; ≥ 1 unit, so integer columns get integer widths)
  WidthUnits = the smallest candidate with WidthUnits × pBuckets ≥ (hiU − loU)
  LoUnits    = Math.floor(loU / WidthUnits) × WidthUnits      (toward −∞; negative outliers are fine)
  N          = max(1, ceil((hiU − LoUnits) / WidthUnits))
  while N > pMaxBuckets: WidthUnits = next candidate; recompute LoUnits and N
  Width      = WidthUnits / Factor;  Edges[i] = Number(((LoUnits + i × WidthUnits) / Factor).toFixed(Scale)), i = 0..N
  ```
  No non-null values (`Lo === null`) → `N = 0`, `Edges: []`.
- `numericIndex(v, pGeometry)` (Nice) → candidate `c = min(floor((units(v) − LoUnits) / WidthUnits), N − 1)`, then corrected once against the exact edges with the raw value: `c − 1` when `v < Edges[c]`, `c + 1` when `c < N − 1` and `v ≥ Edges[c + 1]` (one step suffices: a bucket is ≥ 1 unit, rounding moves a value ≤ ½ unit). The clamp puts `Hi` into the last bucket, which is **closed** (`[Edges[N−1], Edges[N]]`, `EndExclusive: false`). SQL does the same, e.g. SQLite `CASE WHEN v < (:fLoUnits + c * :fWidthUnits) / :fFactor THEN c - 1 WHEN c < :fLastIndex AND v >= (:fLoUnits + (c + 1) * :fWidthUnits) / :fFactor THEN c + 1 ELSE c END` with `c` the integer candidate; the edge is a quotient of two exact doubles, so it equals the contract's `Edges[i]` bit for bit.
- Edges mode: `edgesGeometry(pEdges, pOpenEnded, pScale)` → `{ Mode: 'Edges', Edges, N: Edges.length − 1 (+1 if OpenEnded), … }`; `numericIndex` for Edges = the `i` with `Edges[i] ≤ v < Edges[i+1]` (the open bucket `v ≥ Edges[last]`), else `null` (Other).
- `numericBucketBounds(pGeometry, pIndex)` → `{ Start: Edges[i], End: Edges[i+1], EndExclusive }`: half-open except the last Nice bucket (`EndExclusive: false`, `End = Edges[N] ≥ Hi`); an open-ended Edges bucket has only `Start`.
- `numericLabel(…)`: integer columns `'0–9'` (`[a, b)` → `a–(b−1)`), decimals `'0–<10'`, closed last bucket `'a–b'`, open `'a+'`.
- `compareKeys(a, b)` → numbers numerically, strings by UTF-16 code unit (`a < b`), `null` last. Terms order `CountDesc`: count descending then `compareKeys` ascending; `KeyAsc`/`KeyDesc` by `compareKeys`. It is a **total** order on mixed keys (finite numbers before every other non-null key, which compare as Strings), so `compareKeys(10, '10') === -1`: compare keys only after `normalizeKey`.
- A1 implementation notes (`contract/Facet-Contract-Buckets.js`): `units` rounds half away from zero (SQL `ROUND`; identical to `Math.round` for values with ≤ `Scale` decimals) and returns `null` for non-numbers; `numericGeometry` treats `pMaxBuckets < 2` as 2 (a span across an aligned edge never fits one bucket) and throws `FACET_INTERNAL` beyond 2^53 units; every mode decides membership with raw comparisons (`v >= Edge`). `numericValue(v)` is the one "is this stored value a number" rule (numbers, bigints, plain numeric-literal strings, booleans → 0/1; `''`, `' '`, text → null), and `DATA_TYPE_CLASSES` / `INTEGER_TYPES` / `DECIMAL_TYPES` / `NUMERIC_KEY_TYPES` / `isNumericType` the one DataType classification. Also exported: `formatUnits(pUnits, pScale)` (exact decimal string from integer units), `rangeKey(pValue, pRanges)` (first matching declared range, CASE semantics), `rangeLabel(pRange, pIsInteger)`, `normalizeKey` (the same function `FacetEnvelope.normalizeKey` re-exports; a blank string in a numeric column stays a String), `INTERVAL_ORDER`, `NUMERIC_KEY_TYPES`. `canonicalDateTime` also reads a JS `Date` in UTC (driver values in M2); a width-1 integer bucket is labelled `'5'`, not `'5–5'`. Years format like SQLite `strftime('%Y')` (C `%04d`), so the ISO week of `0000-01-01` is `'-001-12-27 00:00:00'`; such out-of-range bucket keys (and `10000-…`) are accepted by the key functions — `normalizeDateKey(pKey, pInterval)` (re-key an engine group), `compareDateKeys` (chronological order), `nextDateKey`, `fillDateKeys`, `dateLabel` — but never by `canonicalDateTime` / `dateKey` (stored values stay 0000–9999).

### 10.4 Post-processing — pure functions in `contract/Facet-Contract-Envelope.js` (A), called by the service (wiring)

```javascript
FacetEnvelope.buildFacetResult(pAgg, pRaw, pPost)       // → FacetResult (throws FacetError for that facet, e.g. FACET_INTERVAL_TOO_FINE)
FacetEnvelope.buildEnvelope(pParts)                     // → Envelope
FacetEnvelope.normalizeKey(pValue, pDataType)           // §9.2
FacetEnvelope.normalizeForComparison(pEnvelope)         // strips Version, AsOf, ElapsedMS, Engine (envelope + facets), Cached, LagMS, Stale; for O1 deep-equal
```

`pPost = { Engine, AsOf, Exact, Limits, StorageTimeZone, OwnedConjuncts: [Conjunct…] /* by Agg.Disjunctive.Owned */, DisplayName }`.

`buildFacetResult` does, in order: sort `Groups` by the Agg's `Order`; Terms → truncate to `Top` (`Truncated: true, TruncatedReason: 'Top'` when more groups than `Top` exist **or** `DistinctKeys > Top`); DateHistogram → gap fill between `dateKey(Bounds.Lo)` and `dateKey(Bounds.Hi)` when `EmptyBuckets` (cap `MaxDateBuckets`); NumericHistogram → one bucket per index `0..N−1` (zero-filled); Ranges → one bucket per declared range (zero-filled); Pivot → marginals, `Top` per axis by marginal (CountDesc), cells restricted to the kept keys, null-key cells into `MissingCount`; then for every bucket `Label`, `Start`/`End`/`EndExclusive`, `Selected`, `Clause` (`FacetClauses.bucketClause`), `Selection: { Facet, Key }`; selected-zero Terms buckets appended (`Count: 0, Selected: true`) for owned keys not already present; `SumOfCounts`, `OtherCount`; `Chart` when requested.

Engine-independence rules (A, binding on the post-processor):

- Groups are re-keyed through the canonical key functions and duplicates merged (`'5'` and `5` in a Numeric column are one key).
- Terms: the kept set is always the first `Top` groups in the **canonical** order (Count desc, Key asc); `Order` only changes the display order of the kept set. So an engine returning `Top + 1` groups and one returning every group produce identical buckets. `Top: null` → `Limits.DefaultTop`.
- A selected Terms key that is not in the kept set is appended (sorted by `compareKeys`, after the kept buckets) with the count the engine returned for it, else `0`. The Live Terms statement returns the selected keys' groups too (`Agg.SelectedKeys`, one scalar bind each), so both engines report real counts.
- A Terms key holding `'~'` (or `'%7E'`) cannot be a clause value: its bucket keeps `Selection` and `Count` but gets `Clause: null` (UnsafeKey, `03 §6.1`).
- `Missing: false` folds missing rows into `OtherCount` (`MissingCount: 0`), so `SumOfCounts + MissingCount + OtherCount === Total` always holds for bucketed folds and Pivot.
- Pivot: marginals are over cells whose two keys are real (non-null, in a declared range — so the two marginal sums are equal) and are reported for the kept keys; `NO_RANGE_KEY` cells are `OtherCount` like the Ranges fold, NULL cells `MissingCount`; `Top` (`null` → `Limits.MaxTop`) applies per axis by marginal; Column axes display in `Order`, DateBucket axes by key, Range axes in declared order; `SumOfCounts` = `Marginals.Total` = the displayed cells; `Chart` = rows × one dataset per column key.
- Bucket `Selection` and a non-null `Clause` appear only when `Agg.Selectable`; `Excluded` lists each excluded conjunct's `Origin.Hash` (looked up in `pPost.OwnedConjuncts`, else the parallel `ExcludedHashes` entry), else its `Id`.
- `FacetEnvelope.requestFailure(pEnvelope, pTotalRequested)` → the first `Errors` entry when every facet and the requested Total failed (§10.1), else `null`.

### 10.5 Version (weak ETag, wiring)

`Version = 'fv1:' + sha256( ModelVersion | Entity | canonicalJSON(NormalizedRequest.Facets) | canonicalJSON(FilterAST.Conjuncts[].Pred + Ids) | sorted Captures[Entity].Fingerprint | canonicalJSON(Principal.ScopeValues) | Engine | canonicalJSON(normalizeForComparison(Envelope)) ).slice(0, 16)`. There are no generations in M1, so the Version also hashes the computed representation itself (every count, key, label, `Excluded`, `Filter.Applied`; the volatile fields stripped): a write that changes any count, or a request that differs only in a clause Hash, is a different ETag, so an `If-None-Match` 304 is never stale. P3 replaces the representation digest with the DepSet generations.

### 10.6 Bucket (`02 §4.4`)

```javascript
{
	Key: '2026-03-01 00:00:00',          // Terms: the value; DateHistogram: bucket start; NumericHistogram: index; Ranges: range Key
	Label: 'Mar 2026',
	Count: 412,
	Selected: false,
	Start: '2026-03-01 00:00:00', End: '2026-04-01 00:00:00', EndExclusive: true,   // range buckets only
	Clause: { … } | null,                // §10.7
	Selection: { Facet: 'BookStoreSale.SaleDate', Key: '2026-03-01 00:00:00' }
}
```

### 10.7 Bucket clauses (`FacetClauses.bucketClause(pFacetResultMeta, pBucket)`, `02 §5`)

| Fold | Clause |
|---|---|
| Terms (any column, **FK columns included in M1**) | `{ Type: 'DistinctSelectedValueList', FilterByColumn: Field, Values: [ Key ], FilterKey, ClauseKey: 'DistinctSelectedValueList' }` |
| DateHistogram | `{ Type: 'DateRange', FilterByColumn, Values: { Start, End }, EndExclusive: true, FilterKey, ClauseKey: 'DateRange' }` |
| NumericHistogram, Ranges | `{ Type: 'NumericRange', FilterByColumn, Values: { Start?, End? }, EndExclusive: <bucket's>, FilterKey, ClauseKey: 'NumericRange' }` (open bucket: only `Start`; a range with only `To`: only `End`) |
| Stats, DistinctCount, Missing, Pivot | no buckets / `Clause: null` |

O2 (selection round trip): replacing every conjunct the facet owns with the compiled `Bucket.Clause` and counting through the **list** (`GET /1.0/<E>s/Count/FilteredTo/<fenced filter>`) equals `Bucket.Count`; for single-valued folds also `SumOfCounts + MissingCount + OtherCount == Total`, and envelope `Total == list Count`.

### 10.8 Selected (`FacetClauses.selectedFrom(pAgg, pOwnedConjuncts)`)

Terms: keys from owned `IN`/`EQ` predicates on the field (and `Or` of them), normalized with `normalizeKey` → `{ Keys: [ … ] }`. Range folds: owned `GE/GT` + `LT/LE` bounds on the field → `{ Range: { Lo, LoInclusive, Hi, HiInclusive } }`; a bucket is `Selected` when `[Start, End)` lies inside it. Nothing owned → nothing selected.

Full return shape: `{ Keys, Range, Ranges, Constrained }` — `Ranges` is the union of selected intervals (an `Or` of spans; `Range` is `Ranges[0]` when there is exactly one, else `null`), `Constrained` is false when nothing owned is expressible. `NeverExclude` conjuncts (RawFilter) are not selections; several owned conjuncts are ANDed (key sets / intervals intersect); date bounds are compared as `canonicalDateTime` strings, numeric bounds as numbers, and on integer columns `GT a` ≡ `GE a+1`, `LE b` ≡ `LT b+1` (so a closed integer bucket `[90, 100]` is `[90, 101)`). `FacetClauses.bucketSelected(pAgg, pSelected, pBucket)` applies the test. Also in `Facet-Contract-Clauses.js`: `ownership(pFacetSpec, pConjunct)` → `'Explicit' | 'FilterKey' | 'Fields' | null` and `exclusionFor(pFacetSpec, pConjuncts)` → `{ Mode, Owned, Excluded, ExcludedHashes (parallel, null when no Hash), KeptMixed, Kept }` (the §6.2 rule for one facet; the DisjunctivePlanner may delegate), `isMixed`, `clauseHash(pClause)` (deterministic `<FilterKey>-<ClauseKey>-<12 hex>` content hash), `canonicalJSON`, `shortHash` (non-cryptographic).

---

## 11. (i) Catalog — `RetoldFacetingCatalog` (B)

### 11.1 ColumnInfo

```javascript
{
	Entity: 'BookStoreSale', Column: 'TotalAmount',
	DataType: 'Decimal',            // Columns[].DataType (authoritative, 01 §3.1)
	MeadowType: 'Decimal',          // MeadowSchema.Schema[].Type (detects Deleted/AutoIdentity/audit types)
	Size: '10,2', IsInteger: false, Scale: 2,
	Join: null, JoinTarget: null,   // FK: Join = target PK column, JoinTarget = target entity (via the PK-column index)
	IsPK: false, IsDeleteColumn: false, IsAudit: false, IsPolicyColumn: false,
	Sensitive: false,               // Sensitive columns are NEVER returned by column() — see below
	Filterable: true,               // every non-Sensitive column (including Text, ID, GUID, the delete column)
	Facetable: true                 // has ≥ 1 fold
}
```

### 11.2 Facet descriptor and FacetID grammar

Auto FacetID: `<Entity>.<Column>`; `FacetRequest.parseFacetID(pFacetID)` → `{ Entity, Column, Kind: 'Auto' }` | `{ Kind: 'Path' }` (contains `>`) | `{ Kind: 'Declared', Entity, Name }` (contains `/`) | `null` (syntax error). Entity and Column must match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`. M1 resolves only `Auto`: `Path` → per-facet `422 FACET_FOLD_UNSUPPORTED` (`Detail.Feature: 'PathFacet'`), `Declared` → per-facet `400 FACET_UNKNOWN_FACET`. The FacetID's entity must equal the route entity (else per-facet `400 FACET_UNKNOWN_FACET`).

```javascript
{
	Facet: 'BookStoreSale.SaleDate', Entity: 'BookStoreSale', Field: 'SaleDate',
	DisplayName: 'Sale Date',       // de-camel-cased column name (later: overrides)
	DataType: 'DateTime', IsInteger: false, Scale: 0,
	Folds: [ 'DateHistogram', 'Stats', 'Missing' ], DefaultFold: 'DateHistogram',
	ClauseType: 'DateRange', FilterKey: 'SaleDate',
	Intervals: [ 'day', 'week', 'month', 'quarter', 'year' ], DefaultInterval: 'month',   // DateTime only
	Target: null,                   // FK target entity
	Labels: false,                  // FK label resolution is later
	Selectable: true, Engines: [ 'Live' ], Auto: true
}
```

Derivation (M1; `01 §3.2` with the M1 adjustments of §16):

| Column | Folds (first = default) | ClauseType (default fold) |
|---|---|---|
| PK (`DataType: 'ID'` or MeadowType `AutoIdentity`), GUID (`DataType: 'GUID'`, MeadowType `AutoGUID`, or a column name starting with `GUID` — the bookstore's `User.GUIDUser` is `Numeric`/`Integer`) | none (still filterable) | — |
| Has `Join` (any DataType) | Terms, Missing, DistinctCount | DistinctSelectedValueList |
| `Boolean` (not the delete column) | Terms, Missing | DistinctSelectedValueList |
| `DateTime` (not `DeleteDate`) | DateHistogram, Stats, Missing | DateRange |
| `Numeric` integer, no Join | NumericHistogram, Terms, Ranges, Stats, DistinctCount, Missing | NumericRange |
| `Decimal` | NumericHistogram, Ranges, Stats, Missing | NumericRange |
| `String` with Size ≤ `Catalog.MaxTermsStringSize` (128), not in a unique index | Terms, Missing, DistinctCount | DistinctSelectedValueList |
| `Text`, `JSON`, `JSONProxy`, longer `String` | none (still filterable) | — |
| delete column, `DeleteDate`, `CreatingIDUser`/`UpdatingIDUser`/`DeletingIDUser`, the policy column | none (still filterable, except Sensitive) | — |
| Sensitive (`/Password|Hash|Secret|Token|Salt|ApiKey|Key$|Code$|Email|Phone/i` + `Catalog.Sensitive` entries) | none, **not filterable**, absent from Describe | — |

### 11.3 Catalog methods

```javascript
rebuild(pModel, pHost)              // sync; builds entities, columns, descriptors; computes ModelVersion from RetoldFacetingGraph.graphHash()
                                    // (the service rebuilds the Graph first); throws on illegal identifiers
modelVersion()                      // 'm:' + first 12 hex of sha1(GraphHash | catalog options | policy hash)
entities()                          // [ 'Book', … ] facetable entity names (Host.isFacetable)
getFacetable(pEntity)               // EntityDescriptor | null  { Entity, DisplayName, PK, DeleteColumn, Columns: { Name: ColumnInfo }, Facets: [ descriptor ], Dates, Numeric, Categorical, ScopeAssurance }
facet(pFacetID)                     // descriptor | null (Auto only in M1)
column(pEntity, pColumn)            // ColumnInfo | null (null for unknown AND Sensitive — the FilterValidator whitelist)
filterableColumns(pEntity)          // [ names ]
isSensitive(pEntity, pColumn)       // default denylist + Catalog.Sensitive entries − Catalog.<E>.IncludeSensitive
describe(pEntity, pPrincipal)       // the Describe entity block (02 §7)
```

`RetoldFacetingGraph` (B): `rebuild(pModel)`, `edge(pName)` (`'Review.IDBook'`), `outgoing(pEntity)`, `incoming(pEntity)`, `isBridge(pEntity)`, `graphHash()`. Edges keyed by `(From, FromColumn)`; targets via the PK-column index. Used by nothing in M1 except `ModelVersion` and Describe `Target`; it exists so M2 paths have a home.

---

## 12. (j) Host — `RetoldFacetingHostDataService` (B), base `RetoldFacetingHostBase`

### 12.1 Methods

```javascript
bind(pRetoldDataService, fCallback)       // capture fable.DAL / fable.MeadowEndpoints refs and SNAPSHOT the route-bound controller per entity;
                                          // refuse (FacetError FACET_INTERNAL) when MeadowEndpointsSessionDataSource === 'Header' and !Scope.AllowHeaderSession
getHostKind()                             // 'DataService'
getModel(fCallback)                       // fCallback(null, RetoldDataService.fullModel)
getModelSync()                            // same, synchronously (the catalog build is sync)
onModelChanged(fListener)                 // interim: wraps RetoldDataService.loadModel; listener(pModel) after a load
listEntities()                            // every entity with a DAL
getDAL(pEntity)                           // fable.DAL[pEntity] | null
getExecutionDAL(pEntity)                  // M1: === getDAL (Shared pool on SQLite); Dedicated pools are later
getRouteBoundController(pEntity)          // the controller captured at bind() (routes stay bound to it across RDS reloads, D-31) | null
getServiceServer()                        // fable.OratorServiceServer
getScopePolicy()                          // §8.3 normalized policy
getAuthorizer()                           // null on plain RDS (Strategy 'None')
getDialectProfile(pEntity)                // { Name: 'SQLite' | 'PostgreSQL' | 'MySQL' | 'MSSQL' } from the DAL's provider name
hasDeleteColumn(pEntity) / getDeleteColumn(pEntity)   // from MeadowSchema.Schema Type 'Deleted'
getPrimaryKey(pEntity)                    // MeadowSchema.DefaultIdentifier (AutoIdentity column)
isFacetable(pEntity, pPrincipal)          // 06 §5.1 for plain RDS: route-bound controller; not NeverFacet/Account/ApiKey/LoginChallenge/RetoldFacetChangeLog;
                                          // with a policy: scoped OR listed in Catalog.GlobalEntities
resolvePrincipal(pRequest, fCallback)     // §12.2 (raw; PrincipalResolver adds the unset-value check)
installChangeIntake(pIntake)              // later (no-op stub)
```

Route-bound controller: `fable.MeadowEndpoints[E].controller` **as first seen at `bind()`**; after `onModelChanged`, entities that already had routes keep their captured controller (RDS skips `connectRoutes` for them), new entities take the new one.

### 12.2 Principal (frozen)

```javascript
{
	Kind: 'User' | 'Anonymous',            // User when SessionData.LoggedIn === true
	Source: 'InProcess',
	IDUser: 7,                              // SessionData.UserID || SessionData.IDUser || 0
	IDCustomer: 0,                          // SessionData.CustomerID || SessionData.IDCustomer || 0
	ScopeValues: { IDTenant: 1 },           // keyed by policy column, from SessionData[SessionField]
	UserRecord: { IDUser: 7, IDCustomer: 0 },   // only Scope.UserRecordFields
	RoleSetHash: '',
	ResolvedAt: 1791472000000
}
```

Plain RDS: `SessionData = controller.initializeRequestState(pRequest, 'Reads').SessionData` (any route-bound controller; the session marshaler is shared). `RetoldFacetingPrincipalResolver.resolve(pContext, fCallback)` (wiring) wraps `pContext.Host.resolvePrincipal(pContext.Request, …)`: with a policy, any required `ScopeValues[Column]` in `Scope.UnsetValues` → `401 FACET_UNAUTHENTICATED` before anything else runs.

### 12.3 Installer (`source/Retold-Faceting-Installers.js`, B)

```javascript
installOnRetoldDataService(pRetoldDataService, pOptions, fCallback)
// 1 fable.addServiceType('RetoldFacetingService', …) + instantiateServiceProvider('RetoldFacetingService', resolve(pOptions))
// 2 RetoldFacetingService.attach({ RetoldDataService: pRetoldDataService }, fCallback)  — host bind, catalog build, routes
```

`attach()` refuses (boot error) an entity named `Facet`, `Describe`, `Agent`, `Admin`, `Changes` or `Status` (D-17).

---

## 13. (k) Error codes used in M1 (`contract/Facet-Contract-Errors.js`)

| Code | Status | M1 use |
|---|---|---|
| `FACET_UNAUTHENTICATED` | 401 | policy value unset; a behavior's 401 |
| `FACET_FORBIDDEN` | 403 | (reserved for hops/labels; not produced by M1 auto facets) |
| `FACET_ADHOC_FORBIDDEN` | 403 | `Definition` on a facet |
| `FACET_UNKNOWN_ENTITY` | 404 | root entity unknown, not facetable or not readable |
| `FACET_UNKNOWN_FACET` | 400 | per facet: unknown/declared FacetID, entity mismatch |
| `FACET_UNKNOWN_FIELD` | 400 | filter names an unknown or Sensitive column |
| `FACET_UNKNOWN_SCOPE` | 400 | any `Scopes` / `NamedScope` clause |
| `FACET_UNKNOWN_FOLD` | 400 | per facet: `Fold` not in the descriptor's `Folds` |
| `FACET_FILTER_INVALID` | 400 | validator/compiler rejection (`Detail: { Offset, Token }` or `{ ClauseType, Reason }`) |
| `FACET_REQUEST_INVALID` | 400 | **M1 addition**: body shape and L1 limits (non-object body, bad types, duplicate Keys, size/depth/count limits) |
| `FACET_TOO_MANY_FACETS` | 400 | `Facets.length > Limits.MaxFacets` |
| `FACET_INTERVAL_TOO_FINE` | 422 | date buckets > `MaxDateBuckets` (`Suggest: { Interval }`) |
| `FACET_FOLD_UNSUPPORTED` | 422 | not-in-M1 features (`Detail: { Feature, Milestone: 1 }`): path facets, Log mode, numeric pivot axis, `Group:` exclusion, non-Rows CountMode, Selections, FilterExperience, Records, Params |
| `FACET_TOO_LARGE` | 422 | relation / behavior-run budgets |
| `FACET_TIMEZONE_UNSUPPORTED` | 422 | `TimeZone ≠ StorageTimeZone` |
| `FACET_SCOPE_POLICY_VIOLATION` | 500 | ScopeGuard Strict refusal; Opaque capture |
| `FACET_INTERNAL` | 500 | anything unexpected |
| `FACET_MODEL_RELOADING` | 503 | catalog rebuild in progress |
| `FACET_TIMEOUT` | 504 | deadline exceeded (per facet) |

Shapes: whole-request failure → HTTP status + `{ Error: { Code, Status, Message, Detail } }`; per facet → `Errors[Key] = { Code, Status, Message }` (FacetErrorEntry). `libFacetErrors.create(pCode, pMessage, pDetail)` returns an `Error` with `.FacetError === true`, `.Code`, `.Status`, `.Detail`; `toResponse(pError)` and `toEntry(pError)` map any error (non-facet errors → `FACET_INTERNAL` with a generic message). `isFacetError(pError)`.

---

## 14. (l) Test harness, fixtures and the Reference oracle (E)

### 14.1 `test/support/Facet-Test-Harness.js`

```javascript
const libHarness = require('./support/Facet-Test-Harness.js');

let _Harness = libHarness.start(
	{
		Port: 19110,                     // REQUIRED registry port (§14.4); the server binds an EPHEMERAL port unless FixedPort: true
		Fixture: 'Bookstore',            // 'Bookstore' | 'Bookstore-Tenant'
		Seed: 20261008,                  // default fixed seed
		Scale: 'Small',                  // 'Small' (default, fast) | 'Medium'
		Faceting: { },                   // RetoldFaceting option overrides (e.g. { Scope: { Guard: 'Repair' } })
		TenancyBehavior: 'Auto',         // 'Auto' (installed iff Fixture is Bookstore-Tenant) | true | false | function (custom behavior, e.g. the E1 clobber)
		LogLevel: 'fatal'
	},
	(pError) => { /* ready */ });
```

The returned object (synchronously; fields populate before `fDone`):

```javascript
{
	fable, rds, faceting,                // fable, fable.RetoldDataService, fable.RetoldFacetingService
	db,                                  // the node:sqlite DatabaseSync (read-only use in tests)
	baseURL: 'http://127.0.0.1:<bound port>',   // set once the server listens
	port: <bound port>,
	model,                               // the model object loaded into RDS (Bookstore-Tenant adds IDTenant everywhere)
	seed: { Fixture, Seed, Scale, Counts: { Entity: rows incl. deleted }, LiveCounts: { Entity: non-deleted }, Tenants: [ 1, 2 ] | [ ] },
	stop(fDone),                         // closes the server and the DB; idempotent
	request(pMethod, pPath, pBody, pOptions, fCallback),      // fetch; pOptions.Tenant / pOptions.User set the test session; → fCallback(null, { Status, Headers, Body })
	facetQuery(pEntity, pBody, pOptions, fCallback),          // POST /1.0/Facet/:Entity/Query → { Status, Headers, Body }
	reference(pEntity, pBody, pOptions, fCallback),           // in-process faceting.queryInternal(…, { ForceEngine: 'Reference' }) with the same session → (pError, pEnvelope)
	listCount(pEntity, pFilterString, pOptions, fCallback),   // GET /1.0/<E>s/Count[/FilteredTo/<encodeURIComponent(raw)>] → (pError, Count)
	listRows(pEntity, pFilterString, pOptions, fCallback),    // GET /1.0/<E>s[/FilteredTo/<encodeURIComponent(raw)>]/0/0 (Cap 0 = all) → (pError, Records)
	toFilterString(pEntity, pBody),                           // RAW fenced meadow-filter string for the body's Clauses + FilterString (FilterAST.build + toFilterString)
	normalize(pEnvelope),                                     // FacetEnvelope.normalizeForComparison
	assertSelectionRoundTrip(pEntity, pBody, pEnvelope, pOptions, fCallback)   // O2 over every selectable bucket with Count > 0 (and a sample of Count 0)
}
```

Session shim (test-only): the harness registers `fable.OratorServiceServer.pre(…)` reading `x-facet-test-tenant` / `x-facet-test-user` and setting `pRequest.UserSession = { LoggedIn: true, UserID: <user>, IDTenant: <tenant>, CustomerID: <tenant> }` (no header → anonymous default session). `MeadowEndpointsSessionDataSource` stays `'Request'`. In-process calls (`reference`) build a synthetic request with the same `UserSession`.

Test tenancy behavior (Bookstore-Tenant): for **every** entity, `setBehavior` (or `addBehavior` once ME-1 lands) on `Reads-QueryConfiguration` and `Count-QueryConfiguration`: unset `SessionData.IDTenant` → `fCallback(controller.ErrorHandler.getError('Authentication required.', 401))`; else `pRequestState.Query.addFilter('IDTenant', SessionData.IDTenant, '=', 'AND', 'TestTenancy')`. Faceting option defaults for that fixture: `Scope: { Policy: { Column: 'IDTenant', SessionField: 'IDTenant' }, Guard: 'Strict' }`.

Further harness members:

- `compare(pEntity, pBody, pOptions, fCallback)` → `{ Live: <HTTP response>, Reference: <envelope>, LiveNormalized, ReferenceNormalized }` (O1 in one call).
- `installBehavior(pEntity, pHash, fBehavior)` (and the exported `installBehavior(pController, pHash, fBehavior)`): **chain-wraps** whatever is already at that hash (existing first, then the new one; an error short-circuits), because `setBehavior` is single-slot. The tenancy behavior is installed this way, on the entities that have the policy column (or `TenancyEntities: [ … ]`; a custom `TenancyBehavior` function defaults to every entity); `TenancyBehavior: true` on a fixture without the column is a start error. `tenancyEntities` lists where it went.
- `assertSelectionRoundTrip` checks against the REQUEST, not the service's own claims: (1) the exclusion it derives on its own (`expectedExclusion(pBody, pSpec)`: clauses and FilterString stanzas on the facet's column, Self folds only; bodies with OR junctions / groups are skipped) must equal `FacetResult.Excluded`; (2) envelope `Total` against the list Count of the RAW `body.FilterString` when there are no Clauses (and no top-level OR — the stock list does not parenthesize its own soft delete), else the rendered filter; (3) a Terms bucket's `Clause` is null exactly when its key holds `'~'`, and every non-null `Clause` compiles (a refused Clause is a mismatch, never skipped); then it removes the conjuncts the facet excluded, appends the compiled `Bucket.Clause`, and compares the list Count; facet `Total` against the list Count of the facet's own filter, and `SumOfCounts + MissingCount + OtherCount == Total` for Terms/DateHistogram/NumericHistogram/Ranges. Options `MaxBuckets` (positive buckets per facet), `ZeroSample` (default 2). Mismatch → `fCallback(Error with .Report, Report)`; only a bucket value the list SYNTAX cannot carry is counted in `Report.Skipped`.
- Exports: `sessionFor`, `syntheticRequest(pEntity, pOptions, pBody)`, `testTenancyBehavior`, `installBehavior`, `expectedExclusion`, `TENANCY_BEHAVIOR_HASHES`, `BUCKETED_FOLDS`.
- Seed result also carries `TenantCounts` / `TenantLiveCounts` (`{ 1: { Entity: n }, 2: … }`) and `Traps` (`FirstSaleDate`, `LastSaleDate`, `PublicationYearOutlier`, `TotalAmountOutlier`, `MissingStoreIDBase`, `SubScaleAmount` (499.996, just below the Nice edge 500.00), `BoundarySaleDates` (`'2023-04-01'`, `'2023-07-01 00:00'`, `'2022-01-01T00:00:00'`), `UnsafeGenre` (`'Sci~Fi'`), `TextBookCounts` (`''`, `' '` in the integer `BookStoreInventory.BookCount`)); the seed module also exports `fingerprint(db, model)` (sha256 of every table in PK order), `stream(seed, name)`, `primaryKeyOf`, `foreignKeysOf`, `SCALES`, `TENANT_COLUMN`. Small: User 240, Customer 120, Author 400, Book 1 500, BookStore 40, Employee 120, Inventory 1 600, Review 6 000, Sale 3 000 (+ items, prices, joins); Medium ×4. Generation is one PRNG stream per table.

Boot sequence: `new libFable({ Product, APIServerPort: 0 /* ephemeral; Port with FixedPort */, SQLite: { SQLiteFilePath: ':memory:' }, LogStreams: [ { streamtype: 'console', level } ] })` → register + `connectAsync` `MeadowSQLiteProvider` → `BookstoreSeed.build(db, …)` → `RetoldDataService` with `{ StorageProvider: 'SQLite', FullMeadowSchemaFilename: false }` → `pre()` session shim → `initializeService` → `rds.loadModel('Bookstore', model, 'SQLite', …)` → tenancy behaviors → `installOnRetoldDataService(rds, FacetingOptions, …)`. `stop` → `fable.Orator.stopWebServer(…)`.

### 14.2 `test/fixtures/Bookstore-Seed.js`

```javascript
const libBookstoreSeed = require('./fixtures/Bookstore-Seed.js');
libBookstoreSeed.model(pFixture)                       // deep clone of test/fixtures/Bookstore-Model.json (a copy of the retold-harness MeadowModel-Extended.json); 'Bookstore-Tenant' adds an IDTenant
                                                      // column (Columns[], MeadowSchema.Schema Type 'Integer', DefaultObject 0, JsonSchema) to EVERY table
libBookstoreSeed.createTables(pDB, pModel)             // DDL generated from the model (never the harness .sql files)
libBookstoreSeed.build(pDB, { Fixture, Seed, Scale })  // createTables + deterministic rows → { Fixture, Seed, Scale, Counts, LiveCounts, Tenants }
libBookstoreSeed.prng(pSeed)                           // mulberry32; the only randomness source
```

Data requirements (`08 §5`): soft-deleted rows in every table that has `Deleted` (both sides of future anti-joins); NULL dates and NULL numbers; `''` strings (e.g. `Book.Language`); skewed categories (PaymentMethod, Language, Rating); decimals with exactly the column scale; DateTime values as `YYYY-MM-DD HH:mm:ss`; a non-empty `BookStoreCatalogJoin`; `BookStoreSale.SaleDate` spanning several years including a single-day first month; `Book.PublicationYear` with a negative outlier. Bookstore-Tenant: tenant 1 = the base data, tenant 2 = a ~5 % clone with distinct IDs and the same distributions, plus tenant-1 rows referencing tenant-2 parents.

### 14.3 Reference engine rules (O1)

See §9.3. The harness's `reference()` and the HTTP `facetQuery()` must produce envelopes that are deep-equal after `normalize()` for every fixture request — that is the M1 exit criterion, together with O2 (`assertSelectionRoundTrip`) and the two-tenant isolation test (tenant 2's facets equal the facets of tenant 2's own list; no tenant-1 row ever counts).

### 14.4 Port registry (19100–19199)

| Port | File |
|---|---|
| 19100 | (reserved: skeleton probes) |
| 19101 | `test/Facet-Host_tests.js` |
| 19102 | `test/Facet-Catalog-Graph_tests.js` |
| 19103 | `test/Facet-FilterAST_tests.js` (only if it boots a server) |
| 19104 | `test/Facet-Live-Unit_tests.js` |
| 19105 | `test/Facet-ShellTemplates_tests.js` (only if it boots a server) |
| 19106 | `test/Facet-Reference_tests.js` |
| 19110 | `test/Facet-Live-Bookstore_tests.js` |
| 19111 | `test/Facet-Conformance-SQLite_tests.js` (four harnesses in turn: Bookstore, Bookstore-Tenant, Strict clobber, Repair clobber) |
| 19112 | `test/Facet-Security_tests.js` |
| 19113 | `test/Facet-ClauseCompiler_tests.js` (the pict Filter.js oracle) |
| 19190 | `debug/m1-smoke.js` (manual smoke run, not part of `npm test`) |
| 19120–19129 | M2 test files (§32.4) |
| 19196–19198 | `example_applications/faceting_demo` (registry tags of the ProjectTrack, LabTrack and Bookstore domains; binds ephemeral; the demo's own ports are 19300–19310: 19300 `npm start`, 19301 its `npm test`, 19302 its `npm run check:browser`) |
| 19130–19137, 19192 | M4 test files and `debug/m4-smoke.js` (§49.2) |
| 19140–19147, 19193 | M5 test files and `debug/m5-smoke.js` (§69.2) |
| 19138–19139, 19148–19189, 19194–19195, 19199 | free; claim one by adding a row here |

---

## 15. Module export summary and method index (what the smoke test checks)

### 15.1 Exports

| File | Export | Kind |
|---|---|---|
| `source/Retold-Faceting-Service.js` | `RetoldFacetingService` (+ statics `.installOnRetoldDataService`, `.Options`, `.SUB_SERVICES`) | service |
| `source/Retold-Faceting-Installers.js` | `{ installOnRetoldDataService }` | functions |
| `source/Retold-Faceting-Service-Options.js` | `{ DEFAULTS, ROUTE_RESERVED_NAMES, NEVER_FACETABLE, resolve, deepMerge, hasScopePolicy }` | data + pure functions |
| `source/contract/Facet-Contract-Request.js` | `{ CONTRACT_VERSION, FOLDS, SELECTABLE_FOLDS, INTERVALS, ORDERS, NUMERIC_MODES, EXCLUDE_POLICIES, DEFAULT_EXCLUDE, FOLD_CLAUSE_TYPE, M1_CLAUSE_TYPES, FILTER_INSTRUCTIONS, FILTER_STRIPPED_INSTRUCTIONS, FILTER_OPERATOR_MAP, PRED_OPS, IDENTIFIER_PATTERN, parseFacetID, defaultExcludeFor, clauseTypeFor, clampPositiveInteger, LIMIT_DEFAULTS, LATER_FOLDS, RESERVED_KEY_PREFIX, checkLimits, normalizeFacetSpec, normalizeRequest, isLegacyPayload, legacyToRequest }` | pure |
| `source/contract/Facet-Contract-Envelope.js` | `{ CONTRACT_VERSION, NUMERIC_KEY_TYPES, VOLATILE_FIELDS, normalizeKey, emptyFacetResult, buildFacetResult, buildEnvelope, requestFailure, normalizeForComparison }` | pure |
| `source/contract/Facet-Contract-Buckets.js` | `{ INTERVAL_ORDER, NUMERIC_KEY_TYPES, canonicalDateTime, dateKey, normalizeDateKey, compareDateKeys, nextDateKey, fillDateKeys, dateLabel, coarserInterval, units, formatUnits, numericGeometry, edgesGeometry, numericIndex, numericBucketBounds, numericLabel, rangeKey, rangeLabel, normalizeKey, compareKeys }` | pure |
| `source/contract/Facet-Contract-Clauses.js` | `{ TILDE_PATTERN, canonicalJSON, shortHash, isClauseSafeKey, clauseSignature, clauseHash, ownership, isMixed, exclusionFor, bucketClause, selectedFrom, bucketSelected }` | pure |
| `source/contract/Facet-Contract-Util.js` | `{ RESERVED_KEY_NAMES, CONTROL_CHARACTER_PATTERN, NUMERIC_LITERAL_PATTERN, isPlainObject, hasOwn, isPresent, toFiniteNumber, toCount, keyProblem, logSafe }` | pure |
| `source/contract/Facet-Contract-Errors.js` | `{ CODES, create, isFacetError, toResponse, toEntry }` | pure (complete) |
| `source/engine/live/Shell-Templates-<Dialect>.js` | `{ Dialect, Templates: { Count, Terms, DateHistogram, NumericBounds, NumericHistogram, Ranges, Stats, DistinctCount, Missing, Pivot }, Expressions: { dateKey(pColumnSQL, pInterval), numericIndex(pColumnSQL) } }` | pure data |
| every other `source/**/*.js` | the service class (`module.exports = Class; module.exports.serviceType = '…'`); some add statics (`Catalog.SENSITIVE_PATTERN`, `FoldIR.FOLD_DIMENSION_KIND`, `ScopeCapture.PORTABLE_OPERATORS`, `ScopedRelationBuilder.ALIAS_PATTERN` / `.PROJECTION_TEMPLATE`, `Dialects.DIALECT_PROFILES`, `ShellTemplates.ALLOWED_SLOT_PATTERN`) | service |

### 15.2 Method index (binding signatures; sections above give the semantics)

| Service | Methods |
|---|---|
| `RetoldFacetingService` | `registerServices()`, `attach({ RetoldDataService }, fCallback)`, `connectRoutes(pServiceServer)`, `query(pEntity, pBody, pRequest, fCallback)`, `queryInternal(pEntity, pBody, pRequest, { ForceEngine }, fCallback)`, `newContext(pEntity, pRequest, pInternalOptions)`, `describe(pEntity, pPrincipal)`, `describeRequest(pEntity, pRequest, fCallback)`, `status()`; property `Host` |
| `RetoldFacetingHostBase` / `…HostDataService` | §12.1 |
| `RetoldFacetingCatalog` | `rebuild(pModel, pHost)`, `modelVersion()`, `entities()`, `getFacetable(pEntity)`, `facet(pFacetID)`, `column(pEntity, pColumn)`, `filterableColumns(pEntity)`, `isSensitive(pEntity, pColumn)`, `describe(pEntity, pPrincipal)` |
| `RetoldFacetingGraph` | `rebuild(pModel)`, `edge(pName)`, `outgoing(pEntity)`, `incoming(pEntity)`, `isBridge(pEntity)`, `graphHash()` |
| `RetoldFacetingRequestNormalizer` | `normalize(pEntity, pBody)` → NormalizedRequest (throws), `normalizeLegacy(pEntity, pBody)` → null |
| `RetoldFacetingFilterValidator` | `validate(pEntity, pFilterString, { AllowDeleteColumn })` → `{ Stanzas, Warnings }` (throws) |
| `RetoldFacetingClauseCompiler` | `compile(pEntity, pClauses)` → `{ Conjuncts, Warnings }` (throws), `coerceValue(pColumnInfo, pValue)` |
| `RetoldFacetingFilterAST` | `fromStanzas(pEntity, pStanzas, pOrigin)`, `build(pEntity, { Clauses, FilterString })` → FilterAST, `applyToQuery(pConjuncts, pQuery, { Dialect, ParameterPrefix })`, `toFilterString(pConjuncts, { Encode })`, `fieldsOf(pPred)` |
| `RetoldFacetingDisjunctivePlanner` | `variants(pFilterAST, pFacetSpecs)` → `{ Variants, Facets }` |
| `RetoldFacetingFoldIR` | `agg(pFields)`, `dimensionFor(pFold, pDescriptor, pFacetSpec)`, `depSet(pAgg, pVariant, pCatalog)` |
| `RetoldFacetingPlanner` | `plan(pContext, fCallback)`, `lower(pFacetSpec, pDescriptors, pContext)`, `depSet(pAggs)` |
| `RetoldFacetingPrincipalResolver` | `resolve(pContext, fCallback)` |
| `RetoldFacetingAuthorizer` | `check(pContext, pEntities, fCallback)` → `{ Allowed, Denied }` |
| `RetoldFacetingScopeCapture` | `capture(pContext, pEntity, pQuery, pScopeMode, fCallback)`, `probe(pEntity, fCallback)` (later) |
| `RetoldFacetingScopeGuard` | `assert(pContext, pEntity, pQuery, pCapture)` → GuardResult |
| `RetoldFacetingRouter` | `register(pEngine)`, `engine(pEngineName)`, `route(pAggs, pContext, fCallback)` |
| `RetoldFacetingEngineBase` (+ Live, Reference) | `EngineName` getter, `capable(pAgg, pContext)`, `freshness(pDepSet)`, `execute(pContext, pAggs, fCallback)`, `newExecution(pContext)`; Live adds `compileAgg(pContext, pAgg, pRelations, pDialectName)`; Reference adds `readVariantRows(pContext, pVariant, fCallback)`, `fold(pAgg, pRecords)` |
| `RetoldFacetingScopedRelationBuilder` | `buildRelation(pContext, pRel, fCallback)`, `relationKey(pRel)` |
| `RetoldFacetingDialects` | `forName(pDialectName)`, `forDAL(pDAL)`, `quote(pDialectName, pIdentifier)`, `harvest(pQuery, pAlias, pDialectName)` → `{ SQL, Params, ParamTypes }`, `mergeParameterTypes(pQuery, pParamTypes)` |
| `RetoldFacetingShellTemplates` | `dialect(pDialectName)`, `render(pDialectName, pAgg, pSlots)` → `{ Template, Slots, Bound }`, `validateAll()` → `{ Errors }` |
| `RetoldFacetingRoutes` | `connect(pServiceServer)`, `setStandardHeaders(pResponse, pVersion)`, `sendError(pResponse, pError, fNext)`, `handleQuery`, `handleDescribe` |

## 16. Ambiguities resolved / M1 deviations from the design

1. **Describe route.** The design table (`02 §2.1`) has `GET /1.0/Facet/Describe/:Entity`; the M1 brief says `GET /1.0/Facet/:Entity/Describe`. Both are mounted (they cannot collide: `Describe` is a reserved entity name). Describe is the canonical form in docs.
2. **Contract modules are not classes.** The brief asks for class skeletons in every file, but `10 §3.1` requires `contract/` to be pure with zero requires (it cannot extend `fable-serviceproviderbase`). Contract modules export frozen constants and pure functions; the smoke test asserts their exports instead of constructing them. Same for `Shell-Templates-<Dialect>.js` (data consumed by the `RetoldFacetingShellTemplates` service).
3. **Terms on integer columns.** `01 §3.2` lists only NumericHistogram/Stats/Missing for numeric columns, but the design's own fixture F1 runs Terms on `Review.Rating`. M1 lists `Terms`, `Ranges` and `DistinctCount` as non-default folds on integer `Numeric` columns (Decimal: `Ranges` only).
4. **FK Terms buckets.** The design writes FK buckets back as `InternalJoinSelectedValueList`. M1 has no join-clause compiler, so FK Terms facets write `DistinctSelectedValueList` on the FK column itself (equivalent by L3 on the pivot). **Labels (wiring, superseding the earlier "no label reads")**: FK Terms buckets are labelled by one scoped, guarded read of the target per facet (§18.6), `LabelResolved: true|false`; `Labels: false` on the facet turns it off. The FK size-class gate (`AutoFKTermsMaxTargetRows`) is a seam: M1 lists every FK facet.
5. **Numeric bucketing in integer units** (§10.3.2) instead of the design's float `FLOOR((v − Lo) / Width)`: the float form disagrees between PG `numeric` and JS doubles at decimal edges (e.g. 8.4 / 0.2). Same edges, same buckets, exact everywhere.
6. **Stats sums** are exact integer-unit sums, formatted from units (§10.2), so Live and Reference agree to the cent.
7. **New error code `FACET_REQUEST_INVALID` (400)** for body shape and L1 limits; the design lists the limits but no code. Not-in-M1 request features use `FACET_FOLD_UNSUPPORTED` (422) with `Detail.Feature`, `Scopes` use `FACET_UNKNOWN_SCOPE` (nothing is registered), inline `Definition` uses `FACET_ADHOC_FORBIDDEN`.
8. **SQLite NULL predicates** render as `"C" IS :p` with a NULL bind (`IS NULL` semantics) instead of shell fragments (`03 §3.2`), because in M1 the predicate must live inside the fenced FoxHound WHERE of the SR. Verified on node:sqlite.
9. **Reference engine applies the Variant through `FilterAST.applyToQuery`** inside the list waterfall rather than through `controller.parseFilter(string)`, because the stock SQLite list cannot render `IS NULL` (FH-2) and has no fence (ME-2). Independence from Live is kept where it matters: no SRs, no harvest, no shells, no explicit soft-delete, JS folding. The fully independent oracle is O2 through the real HTTP Count route.
10. **Pivot axes** limited to Column / DateBucket / Range; null-key cells go to `MissingCount`, no-range cells to `OtherCount`; `Top` applies per axis by marginal; the pivot fields sit at the FacetResult top level (`02 §4.3`).
11. **Date Missing** = NULL **or unparseable** (incl. `''`), because SQLite `strftime('')` is NULL; dates are never bucketed from non-canonical text.
12. **Numeric `0` is a range bound** in the clause compiler (pict's Filter.js drops it by truthiness — upstream quirk, noted for PICT-1).
13. **No conditional disjunctive scan, no cache, no generations** in M1: one statement per Agg (per Variant SR shared). `Version` hashes the computed representation instead (§10.5) until P3.
14. **Principal on plain RDS** comes from the meadow-endpoints session marshaler; the tests' "authentication" is a harness-only `pre()` shim setting `pRequest.UserSession` from test headers.
15. **Security services take `pContext` first** (`resolve(pContext)`, `check(pContext, pEntities)`, `assert(pContext, pEntity, pQuery, pCapture)`) instead of the design's `resolve(pRequest)` / `check(pEntities, pPrincipal)` / `assert(pEntity, pPrincipal, pQuery)`, matching the design's own `capture(pContext, …)` so every security call reaches the host and principal the same way.
16. **`capable(pAgg, pContext)`** instead of `capable(pAgg, pDepSet, pCaptures)`: in M1 captures happen inside `execute` (there is no store routing that needs them up front).
17. **`Dialects.harvest(pQuery, pAlias, pDialectName)`** is a service method keyed by dialect name rather than a method on a per-dialect profile object.
18. **SQLite in M1.** The meadow group rule is "Postgres everywhere" for applications; M1 *executes* only on in-memory SQLite because that is the test fixture backend, and the PostgreSQL/MySQL/MSSQL shells are dry-built SQL goldens until M2 executes them. Nothing in M1 may assume SQLite-only semantics outside `Shell-Templates-SQLite.js` and the `NULL` rendering of §4.5.
19. **Options defaults for M1:** `Freshness.DefaultMode: 'Exact'` and `Cache.Enabled: false` (design: `'Bounded'`, cache on) because no store or cache exists yet; `Limits` gains `DefaultTop`, `DefaultBuckets` and the L1 limits (`MaxBodyBytes`, `MaxJSONDepth`, `MaxClauses`, `MaxValueBytes`, `MaxInList`) as explicit keys; `Time.DefaultInterval: 'month'`.
20. **Filter-string encoding for the list oracle.** The installed meadow-endpoints (4.0.21) GET routes decode the filter only through restify's path-param decoding, so the oracle sends the RAW string URL-encoded once (§4.5); `FilterString` in a facet POST body stays percent-encoded and is decoded once by the FilterValidator (`02 §3.1`).
21. **Clause sequence = pict's filter string.** pict prepends every RawFilter's stanzas, unwrapped, before the clause groups; the ClauseCompiler composes the same top-level sequence. Without an OR in it each RawFilter and each clause is its own conjunct (a RawFilter fenced alone, `NeverExclude`); with one, SQL precedence makes the whole clause filter ONE conjunct (`NeverExclude` when it holds a RawFilter). Proven against pict's Filter.js by `test/Facet-ClauseCompiler_tests.js`.
22. **Day-aligned date bounds bind date-only.** A midnight `GE` / `LT` DateTime bound binds `'YYYY-MM-DD'` (it sorts before every same-day text form on SQLite TEXT dates), so a clause agrees with canonical bucketing for every stored shape `canonicalDateTime` accepts; `GT` / `LE` keep the canonical value; FilterString values are never rewritten (list parity).
23. **Stats Min / Max / Sum are reported at the column Scale** (from integer units): a stored value with more decimals than the Scale is rounded in Stats (499.996 → `'500.00'`), while bucket membership uses the raw value (§10.3.2).
24. **Scope values are normalized once** (trimmed; numeric literals → Number; booleans → 0/1) in `buildPrincipal`; `0`, `''`, `null`, `false` (and `'0'`, `' 0'`, `'00'`) are always unset, plus `Scope.UnsetValues`.

---

## 17. Seams for later milestones (stub, do not implement)

> M2 implements the definitions, path, Staged-hop, cube, Records/Keys and PostgreSQL seams below (Part II); the remaining seams are listed in §37.

| Seam | Where | M1 behavior |
|---|---|---|
| Definitions, named scopes, aliases | `catalog/` (`DefinitionRegistry` file not created yet) | `Scopes` → 400; declared FacetIDs → 400 |
| Path facets / cross-entity FoldIR (K8–K20) | `Planner.lower`, `FoldIR` | `422 FACET_FOLD_UNSUPPORTED` |
| Staged hops (Opaque captures) | `ScopedRelationBuilder` | refused (500 `FACET_SCOPE_POLICY_VIOLATION`; the reason is logged, never sent) |
| MySQL / MSSQL Terms, DistinctCount and Pivot key collation | `Shell-Templates-MySQL.js`, `-MSSQL.js` (`valueKey`) | dry-built only: keys group under a BINARY collation while a bucket's `DistinctSelectedValueList` Clause is evaluated by the list under the column's (case/accent-insensitive, PAD SPACE) collation — must be resolved (group under the column collation, or merge keys under it in post-processing) with a case-variant O2 fixture before those dialects execute (M2) |
| Row-count prechecks (`MaxLiveRows`, `SQLiteMaxRows`, …) | `EngineLive` | not enforced (`Options.LIMITS_NOT_ENFORCED`; attach warns when one is configured); statements are bounded in rows returned instead (§5.3) |
| Conditional disjunctive scan | `EngineLive` | per-Agg statements |
| CostModel / Admission / Dedicated pool / worker thread | `EngineLive`, `Host.getExecutionDAL` | shared host DAL on the event loop |
| Labels | post-processing | FK Terms labels done (§18.6); Pivot axis labels and label caching are later |
| ResultCache / Generations / ChangeIntake | `Router` | always execute |
| Records / Keys / Explain / GET Query / SSE | `routes/` | not mounted |
| Agent, Standalone, Pushdown, FanOut, stores | — | not present |

---

## 18. Implementation notes (M1)

Everything here is additive to the sections above; where it refines a rule the section is named.

### 18.1 Query entry point

- `RetoldFacetingService.query(pEntity, pBody, pRequest, fCallback)` / `queryInternal(…, { ForceEngine }, fCallback)` call back `fCallback(pError, pEnvelope, pMeta)`. The third argument is in-process only (never serialized): `pMeta = { Version, Engine, ScopeRepaired, Statements, Relations, BehaviorRuns, Variants }` — the route uses `ScopeRepaired` for `X-Retold-Facet-Scope-Repaired: 1`, the tests use the counters (Variant sharing).
- Pipeline order is §2.1 exactly. `pContext.Deadline` is reset after step 2 to `start + min(Limits.TimeoutMS, NormalizedRequest.TimeoutMS)`. A stage that throws a non-facet error becomes a logged `FACET_INTERNAL` carrying the plan hash (`sha256(Entity | canonicalJSON(Facets))[0..12]`), never the message.
- `Errors` lists facets in **request order** (planning errors and execution errors interleaved as the facets were requested), then `'#Total'` when the Total failed. A whole-request failure (§10.1) is re-created from the first entry with its `Detail`.
- `execute()` with no Aggs (every facet failed planning and `Total: false`) runs nothing; the request then fails with the first facet error.

### 18.2 Planner and FoldIR

- `Planner.resolveFacets(pFacetSpec, pContext)` → descriptors (step 5): `Path` → 422 `FACET_FOLD_UNSUPPORTED` `{ Feature: 'PathFacet', Milestone: 1 }`; `Declared`, another entity, unknown or Sensitive column → 400 `FACET_UNKNOWN_FACET` `{ Facet }`.
- `Planner.lower`: Fold not in `descriptor.Folds` → per-facet 400 `FACET_UNKNOWN_FOLD` `{ Facet, Fold, Folds }`; `Ranges` without `Ranges`, `Mode: 'Edges'` without `Edges`, an `Interval` the descriptor does not offer → per-facet 400 `FACET_REQUEST_INVALID` `{ Field, Facet, Reason }`. Terms `Top` defaults to `Limits.DefaultTop`; Pivot `Top` stays null (post-processing uses `MaxTop`). `FilterKey` = descriptor FilterKey for every single-field fold; `ClauseType = clauseTypeFor(Fold)`; `Selectable` = the fold is bucketed. Pivot `DisplayName` = the two names joined with `' × '`.
- Every Dim carries `DataType` (DateBucket, NumericBucket and Range included).
- `FoldIR.pivotAxisFor(pDescriptor, pFacetSpec)`: the axis facet's default fold mapped as in §5.2, except a `NumericHistogram`-default axis becomes a **Range** axis when the request carries `Ranges`, else a **Column** (Terms) axis when the facet lists `Terms` (integer columns), else per-facet 422 `{ Feature: 'NumericPivotAxis' }`.
- Agg additions: `SelectedKeys` (Terms: `FacetClauses.selectedFrom(Agg, Owned).Keys`), `LabelLookup` (Terms on an FK with a label column and `Labels !== false`, else null). `DepSet = FoldIR.depSet(Agg, Variant, Catalog)` (PK, delete column, policy columns, dimension/measure columns, every kept conjunct field).
- `'#Total'` is passed to the DisjunctivePlanner as `{ Key: '#Total', OwnedFields: [], FilterKey: null, Exclude: 'None' }`, so it is listed in `v0.Facets`.

### 18.3 Engines and Router

- `ShellTemplates.render` Terms: `fTopPlusOne = Top + 1` (`Top` null → `Limits.DefaultTop`) for every `Order`, `fMaxGroups = max(Top + 1, Limits.MaxTermsGroups)`, and `Agg.SelectedKeys` bound as `fS0…fSn` and OR-ed in through the `P0` slot (`' OR "r"."Key" IN (:fS0, …)'`, structural text built from bind names only), so a selected key ranked below `Top + 1` keeps its real count in Live exactly as in the Reference. DateHistogram binds `fMaxGroups = MaxDateBuckets + 2`, Pivot `fMaxGroups = CubeMaxGroups + 1`.
- `Router.route`: `ForceEngine` → that engine (unknown → `FACET_INTERNAL`); otherwise the first registered engine whose `capable()` accepts every Agg, falling back to Live (which reports the Aggs it refuses per facet).

### 18.4 Post-processing (contract Envelope)

- Ranges: a range that overlaps an earlier one collects only what earlier ranges left (CASE semantics). Its bucket keeps the declared `Start`/`End`/`Label`, but its `Clause` selects the **effective** span (one interval), or is `null` when the effective span is empty or split (the bucket keeps its `Selection`). So O2 holds for every bucket that has a Clause.

### 18.5 Version

`Version = 'fv1:' + sha256( ModelVersion | Entity | canonicalJSON({ Facets, Total }) | canonicalJSON(Conjuncts[].{ Id, Pred }) | sorted '<Entity>=<Captures[Entity].Fingerprint>' | canonicalJSON(Principal.ScopeValues) | Engine | canonicalJSON(normalizeForComparison(Envelope)) )[0..16]` (§10.5 plus `Total`). `If-None-Match` (weak comparison; a list; `*`) equal to the Version → `304` with the standard headers and no body; because the representation is part of the Version, a 304 is only ever sent for an identical answer.

### 18.6 FK labels

For each Terms facet with a `LabelLookup`, `RetoldFacetingLabelResolver` reads the target **as the principal**: the target must be `Host.isFacetable` + `Catalog.getFacetable` + `Authorizer.canRead`, and both the key and label columns must be catalog columns (never Sensitive). Query: `Host.getExecutionDAL(Target).query` projected to exactly `[ KeyColumn, LabelColumn ]`, `KeyColumn IN (<bucket keys>)` rendered by `FilterAST.applyToQuery` inside the `FacetFenceOpen`/`FacetFenceClose` fence, an **explicit** depth-0 `<DeleteColumn> = 0` (`FacetSoftDelete`, D-37) when the target has a delete column, then `ScopeCapture.capture(…, 'Inherit')` (the target's `Reads-QueryConfiguration` + ScopeGuard), then `doReads`. Keys found get `Label = String(<label column>)`, `LabelResolved: true`; keys not visible (another tenant's parent, a soft-deleted or missing row, a failed or Opaque capture) keep `Label = String(Key)`, `LabelResolved: false` — never an error, never an unscoped read. `Chart.Labels` follow. Labels are post-processing, so Live and Reference envelopes carry the same labels. Catalog descriptors (and Describe) now say `Labels: true` for FK facets with a label column.

### 18.7 Security services

- `PrincipalResolver.resolve` decides 401 **without looking at whether the route entity exists or is facetable** (06 §5.2 / §11): no policy → pass; a policy and an `Anonymous` principal → 401 unless the root entity is in `Catalog.AllowAnonymous` (Describe without an entity: unless that list is non-empty); a policy and any other principal → 401 when ANY policy column (`Policy.Column`, every `PersonalScopes` column, every `Required` column) holds an unset value. The 401 carries no Detail (the column names are logged).
- `Authorizer.check(pContext, pEntities, fCallback)` → `{ Allowed, Denied }` (`Host.isFacetable && Catalog.getFacetable && canRead`); the root (first entity) denied → `fCallback(404 FACET_UNKNOWN_ENTITY)`. `Authorizer.canRead(pContext, pEntity)`: on a policy host an Anonymous principal reads only `Catalog.AllowAnonymous` entities; otherwise it consults `Host.getAuthorizer().canRead(E, Principal)` when a host authorizer exists (null on plain RDS → true), failing closed if it throws.
- Every 5xx client form (`toResponse` / `toEntry`) carries only the code's canonical Message and no Detail (a `FACET_SCOPE_POLICY_VIOLATION` keeps its rule list on the Error for the log and in-process callers); the route logs a non-canonical 5xx message.
- Behavior errors map through `FacetErrors.fromBehaviorError` on Live (ScopeCapture) and the Reference alike.

### 18.8 Describe

`describe(pEntity, pPrincipal, pContext)` → `{ ContractVersion, ModelVersion, Role, ScopeAssurance (deployment-wide), TimeZones, Limits { MaxFacets, MaxTop, MaxBuckets, MaxDateBuckets, MaxHops, TimeoutMS }, Freshness { DefaultMode, MaxLagMS }, Engines { Live { Available, Dialect } }, Entities { E: Catalog.describe(E, Principal, fCanRead) } }` — only entities `Authorizer.canRead` allows, and an FK `Target` only when the principal can read it; the per-entity forms (`/Describe/:Entity`, `/:Entity/Describe`) return the same shape with one entry and `Entity: E` (unknown / not facetable → 404). `describeRequest` resolves the principal (401 rules above) and gates the entity like a query.

### 18.9 attach

`attach()` also: refuses reserved entity names (D-17) from `Host.reservedEntityNames()` (DALs, endpoints, model tables — the one check; the installer relies on it); warns about configured `LIMITS_NOT_ENFORCED`; runs `ShellTemplates.validateAll()` and refuses to boot on any error; registers `Host.onModelChanged(m => rebuildCatalog(m))` (Graph then Catalog; a failed rebuild is logged and the previous catalog stays). `rebuildCatalog(pModel)` is public.


---

# Part II — Milestone 2: cross-entity folds, definitions, named scopes, PostgreSQL

> **Binding for M2.** Part II wins over Part I wherever they conflict; §19.2 lists every Part I rule it changes. Where Part II and the design set disagree, Part II wins for M2 and §36 lists each deliberate deviation. The M2 builders are **A** (definitions, paths, post-processing), **B** (binding, clause compilation, lowering, variants and the cube plan), **C** (Live SQL, per-hop scope, Staged, cube execution), **D** (fixtures, Reference engine, harness), **E** (PostgreSQL) and the **wiring** agent (service pipeline, routes, end-to-end tests); §35 is the file ownership table.

---

## 19. Overview, precedence, services, options, context

### 19.1 What M2 adds

| Area | Addition | Owner |
|---|---|---|
| Definitions | `RetoldFacetingDefinitionRegistry` + `catalog/Facet-Definition-Schema.json`: definitions files (`FormatVersion`, `Aliases`, `Expressions`, `Scopes`, `Facets`), validated at load, invalid entries disabled (§20) | A |
| Paths | `RetoldFacetingGraph.resolvePath`: `>E.c`, `<E.c`, `=E.c` (co-reference), `@Alias`, step objects; resolved at load, never solved at query time (§21) | A |
| Folds | K8 PathTerms, K9 BridgeTerms (`PivotDistinct`), K10 PathSemiJoin, K11 AntiPath (incl. composite `Correlate`), K12 ChildRollup, K17 UnionOfPaths (`Any`), K18 TuplePivot, K19 HavingCount, K20 ExistsSplit. K13 Quantified, K15 Computed, K16 UnionOfSources: `422 FACET_FOLD_UNSUPPORTED` `{ Feature, Milestone: 2 }` | B lowers, C/D execute |
| Filters | Named scopes (request `Scopes` and the `NamedScope` clause), `$CurrentUser.*` / `$Scope.*` / `$Now` / `$Today` / `$StartOf.*` / `$Param.*`, `BindHash`; `InternalJoin*` / `ExternalJoin*` clauses compile to `Exists` conjuncts (§22, §23) | B |
| Plans | Variants keyed by kept conjuncts **and** the definition `Where`; the conditional disjunctive scan (cube, §25); Staged hops (§26.3) | B plans, C executes |
| Scope | Every hop is a Scoped Relation (own DAL, own behaviors, ScopeGuard, explicit `Deleted`); `Scope: 'TenantOnly'` hops (§26.2) | C |
| Routes | `POST /1.0/Facet/:Entity/Records`, `…/Records/:Begin/:Cap`, `…/Records/Count`, `…/Keys`, the `…/Scope/:Scope/…` forms; `Records` in the Query body (§28) | wiring |
| Oracles | Reference engine across entities (each hop read through **its** list as the same principal, §27.2); O5 plan forms (§34) | D, C |
| Fixtures | ProjectTrack and LabTrack (two tenants, owner scope on `LabForm`, global lookups), definitions files for E1/E2/E3 (§31) | D |
| PostgreSQL | dedicated `rfs-test-postgres` container, `Provider: 'PostgreSQL'` harness hook, execution of the PG shells, `npm run test:pg` (§33) | E |

### 19.2 Part I rules changed by Part II

| Part I | M1 rule | M2 rule |
|---|---|---|
| §2.1 | Principal → Shape → Gate → Filter → Plan → Execute → Post | Principal → Shape → Gate → **Bind** (§22.6) → Filter → Plan → Execute → **Records** (a Query body with `Records`, §28.3) → Post. Gate also covers every entity the request filter references, before their fields are validated (§19.6); the Plan stage puts the plan and its `Cubes` on the context for the engines; the Records / Count / Keys entry points run Principal → Shape → Gate → Bind → Filter → Params → `planBase` → Live (§28.3) |
| §2.2 | context fields | + `Bind`, `PlanForm`, `Mode`, `Plan`, `Cubes`, `RecordsResult`; `Now` may be pinned in-process (§19.5) |
| §3 | `Scopes`, `NamedScope` → 400; `Params`, `Records` → 422 | accepted (§28.2, normalizer owned by wiring); `Selections`, `FilterExperience`, `Definition` still refused (`Milestone: 2`, `403` for `Definition`) |
| §3 / §11.2 | `Path` FacetIDs → 422; `Declared` → 400 | resolved through the registry (§20.8) |
| §4.1 | column-only `Pred` | + `Exists` / `NotExists` / `HavingCount` nodes (bound, paths resolved) in conjuncts that come from scopes and join clauses (§23.2) |
| §4.2 | Conjunct | + `Shape`, `Binds`, `Entities`; `Origin.Kind` `'Scope'` and `'Join'` (§23.1) |
| §4.4 | M1 clause table; `InternalJoin*` / `ExternalJoin*` / `NamedScope` refused | compiled (§23.4); `M2_CLAUSE_TYPES` supersedes `M1_CLAUSE_TYPES` |
| §4.5 | `applyToQuery` / `toFilterString` render every conjunct | refuse `Shape: 'Path'` conjuncts (`FACET_INTERNAL` / `FACET_FILTER_INVALID { Reason: 'PathConjunct' }`) (§23.6) |
| §5.1, §5.2 | Agg, Dims | additions §24.3, §24.5 |
| §6 | Variants by kept conjunct set | by (kept set, `WhereHash`); + `ColumnConjuncts`, `PathPred`, `Where` (§25.1) |
| §7.1, §7.2 | `Rel.Where` refused; `Scope` only `'Inherit'`; Opaque refused | `Where` rendered in its own fence, `'TenantOnly'`, Staged (§24.1, §26) |
| §8.1, §8.2 | `ScopeMode` only `'Inherit'` | `'TenantOnly'` (§26.2) |
| §9.1 | `Captures` for the pivot | for every captured entity (pivot and hops); + `Cubes`, `Staged` counters (§26.6) |
| §9.3 | Reference over one list | across entities (§27.2) |
| §10.1, §10.2 | envelope, FacetResult | additions (§29) |
| §10.5 / §18.5 | Version | + `BindHash`; `ModelVersion` covers the definitions (§30.2) |
| §13 | error table | §19.7 |
| §14 | harness | §32 |
| §17 | seams | §37 |

Everything in Part I that is not listed here still holds (fences, explicit soft delete, harvest renaming, shells never bind arrays, canonical bucket math, every value bound, every identifier from the catalog).

### 19.3 New files and services (skeletons exist; every service is registered in `SUB_SERVICES`)

| File | Export (`serviceType`) | Owner |
|---|---|---|
| `source/catalog/Retold-Faceting-DefinitionRegistry.js` | `RetoldFacetingDefinitionRegistry` (+ statics `DEFINITION_SCHEMA`, `FORMAT_VERSION`) | A |
| `source/catalog/Facet-Definition-Schema.json` | draft-07 JSON schema of a definitions file | A |
| `source/plan/Retold-Faceting-Binder.js` | `RetoldFacetingBinder` (+ `TOKEN_PATTERN`, `PARAM_TYPES`) | B |
| `source/engine/live/Retold-Faceting-PredicateCompiler.js` | `RetoldFacetingPredicateCompiler` (+ `FRAGMENT_PREFIX`) | C |
| `source/engine/live/Retold-Faceting-StagedKeys.js` | `RetoldFacetingStagedKeys` | C |
| `source/engine/live/Retold-Faceting-CubeExecutor.js` | `RetoldFacetingCubeExecutor` | C |
| `test/support/Facet-Harness-Providers.js` | provider hook (SQLite implemented; PostgreSQL by E) | E |
| `test/support/Facet-Docker-Postgres.js` | the `rfs-test-postgres` container helper | E |
| `test/fixtures/ProjectTrack-Model.json`, `LabTrack-Model.json` | domain models (08 §1), complete | D |
| `test/fixtures/ProjectTrack-Seed.js`, `LabTrack-Seed.js` | seed modules (`model()`, `FACETING_OPTIONS` implemented; `generate` / `build` by D) | D |
| `test/fixtures/ProjectTrack-Definitions.json`, `LabTrack-Definitions.json` | E1 / E3 definitions + coverage facets (schema-valid) | D |

Registration order (`SUB_SERVICES`): … Catalog, **DefinitionRegistry**, RequestNormalizer, FilterValidator, ClauseCompiler, FilterAST, DisjunctivePlanner, FoldIR, **Binder**, Planner, … ScopedRelationBuilder, **PredicateCompiler**, **StagedKeys**, **CubeExecutor**, EngineLive, … . A builder may add a further service only by adding it to `SUB_SERVICES` and to `test/Facet-Smoke_tests.js` in the same change. Optional helper modules a builder may add without registration: `source/plan/Retold-Faceting-Lowering.js` (B, pure functions or a service), `source/engine/live/Retold-Faceting-StatementComposer.js` (C).

Bookstore-Seed now also exports `generate(pOptions)` (rows without a database), `GENERATION_ORDER`, `insertRows`, `countRows`; `build()` is unchanged in behavior.

### 19.4 Options (M2)

```javascript
Definitions: { Path: 'facets/' | false, Files: [ '<path>' … ], Objects: [ <definitions object> … ], AllowAdHoc: false },
Execution:   { …, Cube: 'Auto' | 'Always' | 'Never', Staged: 'Auto' | 'Always' | 'Never' },
Limits:      { …, MaxHops: 4, MaxExistsDepth: 4, MaxScopeDepth: 3, MaxScopesPerRequest: 16, MaxStagedKeys: 50000,
               MaxRecordsPage: 500, MaxRecordsOffset: 10000, MaxKeys: 50000 },
Cache:       { …, NowBucketMS: 60000 },          // $Now granularity (§22.1), even with the cache off
Scope:       { …, TrustedOpaque: [ 'Entity' … ],  // entities whose Opaque capture may run Staged (§26.3)
               TrustPostOperation: [ 'Entity' … ], PostOperationSafeColumns: { Entity: [ … ] } }   // the read-side behavior audit (§8.1)
```

`MaxExistsDepth`, `MaxStagedKeys`, `MaxRecordsPage`, `MaxRecordsOffset`, `MaxKeys` moved from `LIMITS_NOT_ENFORCED` into `DEFAULTS.Limits`; each is enforced by its owner (§35). `AllowAdHoc` stays ignored: inline `Definition` is always `403 FACET_ADHOC_FORBIDDEN` in M2.

### 19.5 Request context additions (`newContext`)

```javascript
{
	…M1 fields,
	Now: '2026-10-08T15:02:11.120Z',          // in-process callers may pin it: queryInternal(…, { Now: '2026-10-08T12:00:00Z' })
	PlanForm: { Cube: 'Auto', Staged: 'Auto' }, // Execution.Cube / .Staged, overridable in-process only: queryInternal(…, { PlanForm: { Cube: 'Never' } })
	Bind: null,                                 // BindContext (§22.1), set by the Bind stage
	Mode: 'Query',                              // 'Query' | 'Records' | 'Count' | 'Keys' — newContext's 4th argument, set by the entry point
	Plan: null,                                 // the Planner.plan (or planBase) result, set by the Plan stage
	Cubes: [],                                  // Plan.Cubes: EngineLive reads them here (§25.2)
	RecordsResult: null                         // { Records, Dropped, Keys, Captures } of a Query body's Records (§28.4)
}
```

`ForceEngine`, `PlanForm` and `Now` are reachable only through `pInternalOptions` (tests, the fixture CLI), never from a client; `Mode` only through the entry point (`query` / `records` / `count` / `keys`). Engines create `Memo.HopRows` (Reference), `Memo.Staged` (Live) and `Counters.StagedKeys` lazily (`newContext` keeps the M1 `Memo` shape).

### 19.6 The per-entity gate

`RetoldFacetingAuthorizer.canFacet(pContext, pEntity)` (implemented) = `Host.isFacetable(E, Principal) && Catalog.getFacetable(E) && canRead(E)`; `check()` uses it. Every M2 caller gates with it:

| Entity referenced by | When gated | Failure |
|---|---|---|
| the route | stage Gate (M1) | `404 FACET_UNKNOWN_ENTITY` |
| the request filter: every entity of a named scope's predicates (scope entity and every hop), every join-clause target and join table | inside `FilterAST.build` **before** that entity's fields are validated (`pInput.CanFacet`, §23.3) | whole request `403 FACET_FORBIDDEN`, no Detail |
| one facet only: definition `Where`, dimension paths, tuple sides, child relations | Planner, per facet (`Agg.Entities`) | per facet `403 FACET_FORBIDDEN`, no Detail |
| label targets, selected-zero key targets | LabelResolver (M1 §18.6) | unlabeled keys |

Unknown, not facetable and unreadable entities are indistinguishable at every row.

### 19.7 Errors in M2

| Code | Status | M2 use |
|---|---|---|
| `FACET_UNKNOWN_SCOPE` | 400 | unknown, disabled, or wrong-entity scope (`Detail: { Scope }`); same body for each |
| `FACET_UNKNOWN_FACET` | 400 | unknown or disabled declared facet / sibling; an unresolvable path FacetID |
| `FACET_PARAM_INVALID` | 400 | `Params` fail a declared schema (`Detail: { Scope \| Facet, Param, Reason }`; never the value) |
| `FACET_FILTER_INVALID` | 400 | an integer column compared with a number outside the column's range — 32-bit unless `Size: 'bigint'` — from a clause, a FilterString or a bound value (`Reason: 'InvalidNumber'`: never a statement the database fails), join clause not on a declared edge (`Reason: 'UndeclaredJoin'`), a `NamedScope` clause with `Junction: 'OR'` or a `GUIDGroup` (`Reason: 'NamedScopeJunction'`), a path conjunct the list syntax cannot carry (`Reason: 'PathConjunct'`, `toFilterString` only) |
| `FACET_UNKNOWN_FIELD` | 400 | a join clause's remote field (`Detail: { Field, Entity }`, after that entity passed the gate) |
| `FACET_FORBIDDEN` | 403 | §19.6 |
| `FACET_UNAUTHENTICATED` | 401 | also: a `$CurrentUser.*` / `$Scope.*` token binds an unset value (§22.4) |
| `FACET_FOLD_UNSUPPORTED` | 422 | K13/K15/K16 and the other `Supported: false` features (§20.3 stage 12) with `Detail: { Feature, Milestone: 2 }`; Live refusals keep M1 behavior |
| `FACET_PATH_TOO_BROAD` | 422 | a Staged key set over `MaxStagedKeys` (`Detail: { Limit: 'MaxStagedKeys', Suggest: { Engine: 'ClickHouse' } }`) |
| `FACET_TOO_LARGE` | 422 | `MaxRelationsPerRequest`, `MaxBehaviorRunsPerRequest`, `MaxScopesPerRequest` |
| `FACET_REQUEST_INVALID` | 400 | Records/Keys page limits (`Detail: { Field: 'Cap' \| 'Begin', Max }`), bad `Sort` |
| `FACET_DEFINITION_INVALID` | (500) | **load-time only** (boot log, `disabled()`, Status); never a request error |
| `FACET_SCOPE_POLICY_VIOLATION` | 500 | also: a refused `TenantOnly` relaxation, an untrusted Opaque hop |

Errors raised by the request filter (scopes, join clauses, params, binding) fail the whole request; errors raised by one facet's definition fail that facet only (`Errors[Key]`), exactly like M1 per-facet errors.

---

## 20. The DefinitionRegistry (A)

### 20.1 Sources and load

- **Sources**, in this order: every `*.json` file directly under `Definitions.Path` (sorted by file name; not recursive; `Path: false` or a missing directory loads nothing — a configured `Path` other than the default that is missing or not a directory adds the warning `DEFINITIONS_PATH_MISSING` (Kind `'File'`, `Source` = the path) and logs at warn; the default `'facets/'` missing logs at info), then each `Definitions.Files` entry (absolute, or relative to `Path`, or to `process.cwd()` when `Path` is false), then each `Definitions.Objects` entry (a parsed object; its source name is `#object<i>`). Files are read synchronously at boot (`attach`) and on reload.
- **Atomic swap.** `load()` builds new maps and replaces the old ones only when it finishes; a reload that throws keeps the previous registry (logged).
- **Names are global.** A scope, facet or alias name defined in two sources disables **both** (`Reason: 'DuplicateName'`). A declared alias may not reuse a synthetic bridge alias name (`'AliasShadowsBridge'`).
- **Order of boot** (wiring, in `rebuildCatalog`): `Graph.rebuild(model)` → `Catalog.rebuild(model, Host)` → `DefinitionRegistry.load(Options.Definitions)` → `Catalog.refreshModelVersion()` (A adds it: ModelVersion material + `definitionsHash()`). A model reload re-runs the same sequence on the retained sources.
- `pEnvironment` defaults: `Graph = fable.RetoldFacetingGraph`, `Catalog = fable.RetoldFacetingCatalog`, `Policy = fable.RetoldFacetingService.Host.getScopePolicy()` (or `{ Kind: 'None', PersonalScopes: {} }` without a host), `Options = this.options`.

### 20.2 What the schema checks vs what the registry checks

`Facet-Definition-Schema.json` checks **shape only** (types, enums, identifier and step-string patterns, required keys, no unknown keys). The registry validates it with a **built-in** validator implementing exactly the keywords the schema uses (`type const enum pattern properties propertyNames required additionalProperties items minItems maxItems minLength maxLength minimum oneOf anyOf $ref`) — no runtime dependency. `test/Facet-Definitions_tests.js` cross-checks the built-in validator against `ajv` (6.x, umbrella `node_modules`, test-only) on every fixture and on negative cases. Everything else is semantic and checked against the graph, the catalog and the policy (§20.3).

The schema is applied **per entry**: the file envelope (`FormatVersion`, section types) first — a bad envelope disables every entry of that source (`Kind: 'File'`); then each alias against `#/definitions/Path`, each scope against `#/definitions/ScopeDefinition`, each facet against `#/definitions/FacetDefinition`.

### 20.3 Validation stages (in order; the first failure disables the entry)

1. **Schema** (§20.2).
2. **Names.** `Facet: '<Home>.<Name>'`: `Home` is an entity in the catalog (host-facetable); `<Name>` is not a column of `Home` (`'NameShadowsColumn'`); for an entity pivot `Pivot` (default `Home`) equals `Home`; for a TuplePivot `Home` defaults to the first `From` entity and must be one of them. Scope names `'<Entity>.<Name>'` must have `<Entity>` equal to the scope's `Entity` (`'ScopeEntityMismatch'`). Sibling names are identifiers, unique per facet; sibling FacetIDs are `'<Facet>/<Name>'`.
3. **Aliases.** Spliced recursively; unknown → `'UnknownAlias'`; a cycle disables every alias in it (`'AliasCycle'`). Graph bridge aliases (`'Book~Author'`) are always available.
4. **Paths.** Every path through `Graph.resolvePath` (§21); errors carry `Step` (the index after splicing).
5. **Predicates.** Each `Field` is a catalog column of the entity the predicate is evaluated on (`Catalog.column` non-null; Sensitive and unknown are both `'UnknownField'`), never the delete column (`'DeletedField'`), never a policy column (`'PolicyField'`: scope is the policy's job); `NULL`/`NOTNULL` take no `Value`; `IN`/`NIN` take a non-empty array or a list-typed `$Param`; every other op takes one scalar or a scalar token. Literal values are coerced with `ClauseCompiler.coerceValue` (`'InvalidValue'`). A string `Value` starting with `$` must be a valid token (§22.2) (`'UnknownToken'`); `$Param.<Name>` must be declared by the enclosing scope or facet (`'UndeclaredParam'`); a list `$Param` under a scalar op is `'ParamShape'`. `Correlate` pairs: the outer field (optionally `alias.Field` in a TuplePivot) is a column of the outer entity, the inner field a column of the path's last entity, both numeric-class or both non-numeric (`'CorrelateType'`).
6. **Scope references** `{ "Scope": X, "Params"? }`: X exists and is enabled (`'UnknownScope'`, or `'DependsOnDisabled'`), X's `Entity` equals the entity the reference is evaluated on (`'ScopeEntityMismatch'`), the reference's `Params` satisfy X's schema (literals, or tokens of the enclosing definition; missing without `Default` → `'ScopeParamMissing'`), expansion depth ≤ `Limits.MaxScopeDepth` (`'ScopeTooDeep'`), no cycle (every scope in a cycle is disabled, `'ScopeCycle'`).
7. **Existence depth.** The number of nested existence subqueries after lowering (one per path step, one per `CheckParent`, across nested `Exists`/scope expansions) ≤ `Limits.MaxExistsDepth` (`'ExistsTooDeep'`).
8. **`TenantOnly`** only on steps of `Exists` / `NotExists` / `HavingCount` / `ExistsSplit` paths (`'TenantOnlyNotAllowed'` on dimension, label, child-rollup or tuple paths), with a non-empty `ScopeReason` (`'TenantOnlyNeedsReason'`), on an entity with a `PersonalScopes` entry in the policy (`'TenantOnlyNeedsPolicy'`) **that keeps another required column** (`'TenantOnlyNeedsTenant'`: `Policy.requiredFor(E, null)` minus the personal column must be non-empty, and the personal column may be neither the policy `Column` nor one of `Required[E]` — otherwise the relaxation would read every tenant). No `$Param` may be compared anywhere under a path holding a `TenantOnly` step (its step Wheres, the existence `Where`, nested existence nodes): `'TenantOnlyParam'` (a client-chosen value compared with other users' rows would let a client binary-search their private columns, 06 §4.4); literals and `$CurrentUser` / `$Scope` / `$Now` tokens are fine.
9. **CheckParent forcing** (§21.4) — a warning `'CheckParentForced'`, not an error.
10. **Dimensions** (§20.5).
11. **TuplePivot** (§20.6).
12. **Unsupported in M2** — the entry loads with `Supported: false, Unsupported: { Feature, Milestone: 2 }`; a request that uses it gets `422 FACET_FOLD_UNSUPPORTED` with that Detail (per facet; whole request for a scope): `All` / `AllNonEmpty` (`'Quantified'`), any `Expr` or `Expressions` use (`'Computed'`), `Pivot.Union` (`'UnionOfSources'`), `Mode: 'Log'` (`'LogMode'`), `CountMode: 'Approx'`, a declared `CountMode: 'KeyDistinct'` or `DistinctKey` (`'CountMode'`; a TuplePivot's declared `'Rows'` canonicalizes to `'KeyDistinct'` over its `Key`), `Measures` other than `[ { Op: 'count' } ]` (`'Measures'`), `ChildRollup` with `Agg ≠ 'count'` (`'ChildRollupAgg'`) or a `Child.Path` that is not one `<` step (`'ChildRollupPath'`), `HavingCount` whose path is not one `<` or `=` step (`'HavingCountPath'`), `Exclude: 'Group:…'` / `ExcludeGroup` (`'ExcludeGroup'`), a path predicate inside a lookup step's `Where` (`'LookupPathWhere'`), a 2-D declared facet over a TuplePivot (`'TuplePivotPivot'`), a dimension `TimeZone` other than the storage time zone (`'TimeZone'`).
13. **Ignored with a warning:** a `Catalog` section (`'CatalogSectionIgnored'`), `Elide: true` (`'ElideIgnored'`: M2 never elides a hop, §36), `Engines`, `Freshness`, `Limits`, `Visibility`, `Records`, `Missing`, `ClauseType`, `Selectable` (`'Ignored:<Key>'`).

### 20.4 Disabled entries and warnings

```javascript
// RetoldFacetingDefinitionRegistry.disabled() → [ DisabledEntry ]
{
	Kind: 'Facet' | 'Scope' | 'Alias' | 'File',
	Name: 'Project.MyProjects',
	Source: '/abs/path/facets/Project.json' | '#object0',
	Errors:
	[
		{ Code: 'FACET_DEFINITION_INVALID', Reason: 'UnknownField', Pointer: '/Scopes/Project.MyProjects/Where/0/Any/0/Exists/Where/1',
		  Step: 0, Entity: 'ProjectMembership', Field: 'Rol', DependsOn: null }
	]
}
// warnings() → [ { Code: 'CheckParentForced' | 'ElideIgnored' | 'CatalogSectionIgnored' | 'Ignored:<Key>', Kind, Name, Source, Pointer } ]
```

Each disabled entry is logged once (`fable.log.error`, code, source, pointer, reason; never a value). Everything that references a disabled entry is disabled with `Reason: 'DependsOnDisabled', DependsOn: '<name>'`. A request naming a disabled entry gets the same answer as an unknown one (§19.7).

Reasons beyond the ones §20.3 / §21 name (as built): `BandEdges`, `TenantOnlyNeedsTenant`, `TenantOnlyParam` (M2 review), `UnknownEntity` (an entity on a path, a scope or a tuple side that is not in the catalog — a load error, not a request-time 403; label paths are exempt), `HomeMismatch`, `PivotMismatch`, `InvalidPath`, `InvalidStep`, `TokenType` (a token whose value type cannot reach the column), `ParamSchema`, `ScopeParamInvalid`, `DimensionShape`, `FieldType`, `FieldNotFoldable`, `LabelsPath`, `TupleAlias`, `TupleHome`, and for whole sources `Unreadable`, `InvalidJSON`, `Internal`. A name defined twice is disabled everywhere it appears; every member of an alias or scope cycle is disabled. `validate(pObject)` checks the object on its own (it cannot reference scopes or aliases already loaded).

### 20.5 Dimension rules (per `Kind`)

| Kind | Requires | Rules |
|---|---|---|
| `Terms` on a pivot column | `Field` | a catalog column of the pivot (any column the auto catalog could fold: not PK/GUID/Sensitive/Text/long String) |
| `Terms` / `DateHistogram` / `NumericHistogram` / `Ranges` over a **to-one** path (K8) | `Path` (only `>` steps) + `Field` on the last entity | Terms: any non-Sensitive catalog column of the last entity **including its primary key** (bucketing by the target row, e.g. 08 §4.2 `ByQueue` on `IDLabQueue`); DateHistogram: a DateTime column; NumericHistogram / Ranges: a numeric column, **never a Boolean** (`'FieldType'`: a production PostgreSQL BOOLEAN has no min / max / arithmetic; Booleans are Terms / Missing, as the auto catalog folds them); `LabelField` (Terms only) a column of the last entity → `LabelLookup { Entity: last, KeyColumn: Field, LabelColumn: LabelField }` |
| `Terms` over a path with any `<` or `=` step (K9) | `Path` + `KeyField` (any non-Sensitive column of the last entity, its primary key included); optional `Where` (on the last entity), `LabelField` | forces `CountMode: 'PivotDistinct'` (an explicit `'Rows'` is an error `'CountModeRows'`); `LabelField` → `LabelLookup` on the last entity keyed by `KeyField` |
| `ChildRollup` (K12) | `Child: { Path: [ '<C.fk' ], Agg: 'count', Where? }`, `Edges` strictly ascending positive integers **starting at 1** (`'BandEdges'`: band 0 is exactly "no visible child", so a count of 1 is never filed under 'None') | band keys 0..n (§24.9) |
| `ExistsSplit` (K20) | `Path`, optional `Where`, `Correlate`, `Labels: { "true", "false" }` | keys `1` (exists) and `0`; labels default `'Yes'` / `'No'` |
| any, in a TuplePivot | `Field: '<alias>.<Column>'` | the alias's primary key or the column itself is in `Key` (so the dimension is a function of the tuple: single-valued) (`'TupleDimensionNotKeyed'`); `Path` not allowed (`'TuplePath'`) |

`Labels: { Path: [ '>E.c' … ], Field }` on a Terms dimension (a to-one path from the dimension's entity — the pivot, or the tuple side's entity — to the label entity, whose last step's target column equals the dimension's key) → `LabelLookup { Entity: <path To>, KeyColumn: <last step's To column>, LabelColumn: Field }`. `Top`, `Order`, `Missing`, `Interval`, `EmptyBuckets`, `Mode` (`'Nice'`/`'Edges'`), `Buckets`, `Edges`, `OpenEnded`, `Ranges` mean what they mean for auto facets and are the defaults a request may override. A facet with two `Dimensions` is a 2-D Pivot over the declared dims (each must be single-valued: no K9, K12 or K20 axis, `'PivotAxis'`).

### 20.6 TuplePivot rules (K18)

`From` has 2–4 sides with unique aliases (`^[a-z][a-z0-9]{0,7}$`), entities in the catalog; side `Where` is evaluated on that side's entity (scope references allowed); **every** side must be reachable from the Home side through Join-related `On` pairs — one column `Join`s the other side's primary key, or both columns `Join` the same target primary key (co-referencing FKs, 08 §4.3) — else `'TupleOnNotJoined'` with the unreachable side's pointer (`/Pivot/Tuple/From/<i>`; a side with no pair or only non-join pairs is a near-cartesian product); other pairs are plain equalities; `Key` lists `alias.Column` pairs; `Home` is the route entity and must be a `From` entity (the first side with that entity is the **Home side**; it may be declared anywhere in `From` — the Planner lowers the sides Home first, then in connectivity order, §24.4). A declared `CountMode: 'Rows'` canonicalizes to `'KeyDistinct'` (distinct `Key` tuples) with the load warning `CountModeCanonicalized`; Describe and every FacetResult report `CountMode: 'KeyDistinct'`. TuplePivots are server-authored only (definitions files). Facet-level `Where` predicates use `From: '<alias>'` to start a path at a side (default: the Home side) and `Correlate` outer fields as `'<alias>.<Column>'` (default alias: the path's `From`).

### 20.7 Canonical forms (what the registry serves)

**CanonicalPred** (unbound): Part I `Pred` plus existence nodes; every path resolved; every scope reference inlined; `Any` → `Or`; `Not` pushed down (operator negation `EQ↔NE GT↔LE GE↔LT LK↔NLK IN↔NIN NULL↔NOTNULL`, De Morgan, `Exists↔NotExists`, `HavingCount` op negation `EQ↔NE GE↔LT GT↔LE`); a `Where` array is an `And` (a one-item array is the item); `$`-strings become `Bind` leaves.

```javascript
{ Field: 'Role', Op: 'IN', Value: [ 'Owner' ] }                      // literal, coerced by the column DataType
{ Field: 'IDUser', Op: 'EQ', Bind: '$CurrentUser.IDUser' }            // bound later by the Binder (never a Value and a Bind)
{ And: [ … ] }   { Or: [ … ] }
{ Exists:    { From: null | '<tuple alias>', Path: <PathPlan>, Where: <CanonicalPred> | null, Correlate: [ { Outer: { Alias: null | 'r', Field: 'IDLabFormType' }, Inner: 'IDLabFormType' } ] } }
{ NotExists: { …same… } }
{ HavingCount: { From, Path, Where, Correlate, Op: 'GE', Value: 3 } }
```

`Exists.Where` is evaluated on `Path.To`; each `PathPlan` step may carry its own `Where` (evaluated on that step's target).

**CanonicalScope**

```javascript
{
	Scope: 'Project.MyProjects', Entity: 'Project', Description: '…',
	Params: { Roles: { Type: 'EnumList', Values: [ 'Owner', 'Lead', 'Member', 'Reviewer' ], Default: [ 'Owner', 'Lead', 'Member' ] } },
	Where: <CanonicalPred>,                 // the And of the declared Where items
	Entities: [ 'Project', 'ProjectMembership' ],   // every entity it reads (gate list)
	Binds: [ '$CurrentUser.IDUser', '$Param.Roles' ],
	Relaxed: false,                         // any TenantOnly step
	Supported: true, Unsupported: null,
	DefinitionHash: 'dh:…', Source: '…'
}
```

**CanonicalFacet** (declared facets and each sibling; also the synthesized PathAuto facets)

```javascript
{
	Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue', Origin: 'Declared' | 'Sibling' | 'PathAuto', SiblingOf: 'MaterialIntakeRequirement.MyFormsToDo' | null,
	Entity: 'MaterialIntakeRequirement',            // = Home = the route entity
	Version: 1, Title, Description, DisplayName,
	Pivot: { Kind: 'Entity', Entity: 'MaterialIntakeRequirement' }
	     | { Kind: 'Tuple', Sides: [ { Name: 'i', Entity: 'MaterialIntake', Where: <CanonicalPred>|null }, … ],
	         On: [ { Left: { Name: 'i', Field: 'IDMaterialType' }, Right: { Name: 'r', Field: 'IDMaterialType' } } ],
	         Key: [ { Name: 'i', Field: 'IDMaterialIntake' }, { Name: 'r', Field: 'IDLabFormType' } ], Home: 'i' },
	Where: <CanonicalPred> | null,                  // W_def, never excluded
	Dimensions: [ <CanonicalDim> ],                 // 1, or 2 for a declared Pivot
	Fold: 'Terms' | 'DateHistogram' | 'NumericHistogram' | 'Ranges' | 'ChildRollup' | 'ExistsSplit' | 'Pivot',
	Folds: [ … ],                                   // folds a request may ask for (PathAuto: the target descriptor's bucketed folds)
	CountMode: 'Rows' | 'PivotDistinct' | 'KeyDistinct',   // TuplePivot → 'KeyDistinct' (distinct Key tuples), K9 → 'PivotDistinct'
	Exclude: 'Self' | 'None' | [ … ], FilterKey: '…',       // FilterKey default: §23.5
	Params: { … }, Entities: [ … ], Binds: [ … ],
	Relaxed: false, Semantics: 'NoVisibleMatch' | null,      // NoVisibleMatch when any NotExists / ExistsSplit / ChildRollup is involved
	Supported: true, Unsupported: null,
	DefinitionHash: 'dh:…', FoldHash: 'fh:…', Source: '…'
}
// CanonicalDim
{
	Kind: 'Terms' | 'DateHistogram' | 'NumericHistogram' | 'Ranges' | 'ChildRollup' | 'ExistsSplit',
	Field: 'IDLabQueue' | null, Alias: null | 'i',          // Alias = TuplePivot side name
	Path: <PathPlan> | null, PathShape: 'ToOne' | 'ToMany' | null,
	KeyField: null | 'IDUser', LabelLookup: null | { Entity, KeyColumn, LabelColumn },
	Where: <CanonicalPred> | null, Correlate: [ … ] | null,  // K9 / K20
	Child: null | { Path: <PathPlan>, Agg: 'count', Field: null, Where: <CanonicalPred> | null },   // K12
	Edges, Labels, Top, Order, Missing, Interval, EmptyBuckets, Mode, Buckets, OpenEnded, Ranges,
	DataType, IsInteger, Scale                               // of the keyed column (Field / KeyField), from the catalog
}
```

Hashes: `DefinitionHash = 'dh:' + sha1(canonicalJSON(entry as authored))[0..12]`, `FoldHash = 'fh:' + sha1(DefinitionHash | GraphHash)[0..12]` (siblings: the parent's DefinitionHash with `'/<Name>'`), `definitionsHash() = 'd:' + sha1(canonicalJSON({ Sources: [ { Source, Hash: sha1(content) } ], Disabled: [ '<Kind>:<Name>' … ] }))[0..12]` — `Source` is the file **basename** (`#object<i>` for objects), so the hash is the same on every machine.

As built, a CanonicalFacet also carries `Path` (the step strings of a path dimension), `MultiValued`, `Selectable`, `ClauseType`, `OwnedFields`, `WhereScopes` (the request `Scopes` equivalent to a `Where` made only of scope references) and `Siblings` (the sibling FacetIDs of a main facet); canonical forms are deep-frozen. Conventions:

- **FilterKey default:** a facet on a pivot column defaults to that column; any other single-dimension facet to its FacetID; a 2-D pivot gets `null`. A declared `FilterKey` applies to the main facet only.
- **Exclude:** siblings inherit the declared `Exclude`, except ChildRollup, ExistsSplit and TuplePivot siblings (`'None'`).
- **CountMode:** K9 is always `PivotDistinct`, a TuplePivot always `KeyDistinct`, everything else `Rows`.
- **TuplePivot `Where`:** facet-level leaves carry `Alias`; existence nodes always carry `From` (a side name).
- **Predicates:** nested `And` / `Or` groups are flattened.
- **Explicit co-reference** (`{ Via, To }`) is written `'=E.c@S.s'` in `Path` strings only when it differs from the default co-reference source.
- **Labels:** label targets are not in `Entities` (the gate list) and need not be facetable (the LabelResolver gates them, unlabelled when refused, §19.6); `LabelField` is allowed only on path dimensions; a facet-level `Labels` is the default of its main dimensions; ChildRollup / ExistsSplit `Labels` travel on the lowered FoldIR dimension (§24.3) for §29.2.
- **Entities:** the definition's own entity first, then the others in order of appearance.

### 20.8 FacetID resolution (Planner step 5, M2)

| `parseFacetID` Kind | Resolution |
|---|---|
| `Auto` `'E.Name'` | `registry.facet('E.Name')` first (a declared name never equals a column, §20.3), else `Catalog.facet` (M1) |
| `Declared` `'E.Name/Sibling'` | `registry.facet` |
| `Path` `'E.c>T.col'` | `registry.resolveFacet`: synthesized **PathAuto** when `E.c` is a graph edge to `T`, the edge is neither `Audit` nor `Tenant`, `T` is not a hub, and `T.col` has a catalog descriptor with at least one bucketed fold; exactly one hop (a longer path FacetID is unknown: multi-hop paths are declared). Dimension = the target descriptor's default fold over `Path: [ '>E.c' ]`, `Field: col`; `Folds` = the descriptor's folds ∩ `[ Terms, DateHistogram, NumericHistogram, Ranges ]`; FK target columns keep their `LabelLookup` |

The resolved facet's `Entity` must equal the route entity, else `400 FACET_UNKNOWN_FACET` (as M1). Disabled or unknown → `400 FACET_UNKNOWN_FACET`; `Supported: false` → `422`. The per-facet gate runs **during resolution** (before the request Params are checked): a declared facet whose entities the principal may not facet is `403` and declares no params (its top-level Params read as `Unknown`, like a nonexistent facet's); a **PathAuto** facet whose target the principal may not facet is the same `400 FACET_UNKNOWN_FACET` as a path that does not exist (no 403-vs-400 oracle on hidden entities or edges). `resolveFacet` caches only real PathAuto facets (bounded by edges × target columns), never a miss. A request `Fold` must be in `Folds` (`400 FACET_UNKNOWN_FOLD`); a request may override `Top`, `Order`, `Missing`, `Interval`, `EmptyBuckets`, `Buckets`, `Mode`, `Edges`, `OpenEnded`, `Ranges`, `Exclude`, `Labels: false`, `Chart` exactly as for auto facets.

### 20.9 Registry API

| Method | Returns |
|---|---|
| `load(pSources?, pEnvironment?)` | `{ Loaded: { Facets, Scopes, Aliases }, Disabled: [ DisabledEntry ], Warnings: [ … ], DefinitionsHash }` (sync) |
| `validate(pDefinitionsObject, pEnvironment?)` | `{ Valid, Errors: [ … ], Warnings: [ … ], Canonical: { Facets, Scopes, Aliases } }` (no state change) |
| `facet(pFacetID)` / `resolveFacet(pFacetID)` | CanonicalFacet \| null (§20.8) |
| `scope(pName)` | CanonicalScope \| null |
| `scopesFor(pEntity)` / `facetsFor(pEntity)` | enabled entries homed on the entity (Describe) |
| `alias(pName)` | canonical steps of a **declared** alias \| null |
| `expression(pName)` | always `null` in M2 |
| `disabled()` / `warnings()` | lists (§20.4) |
| `definitionsHash()` | `'d:…'` |
| `status()` | `{ Files, Facets, Scopes, Aliases, Disabled, Warnings }` |

---

## 21. Paths (A: `RetoldFacetingGraph.resolvePath`)

### 21.1 Grammar (01 §4.5, normative)

```
Path       := Step+                         JSON array; a space-separated string is sugar
Step       := '>' Entity '.' Column         forward: standing on Entity, go to the row Column references   (to-one)
            | '<' Entity '.' Column         reverse: standing on Column's target, go to the Entity rows     (to-many)
            | '=' Entity '.' Column         co-reference: standing on S, whose FK Joins the same target PK
                                            as Entity.Column, go to the Entity rows sharing that target     (to-many)
            | '@' AliasName                 splice a declared or bridge alias
            | { Step, Where?, As?, Elide?, CheckParent?, Scope?, ScopeReason? }
            | { Via: 'S.s', To: 'E.c', Where?, CheckParent?, Scope?, ScopeReason? }    explicit co-reference
```

### 21.2 PathPlan

```javascript
{
	From: 'MaterialIntakeRequirement', To: 'LabForm',
	Steps:
	[
		{
			Index: 0, Raw: '=LabForm.IDMaterialIntake',
			Direction: 'Forward' | 'Reverse' | 'CoReference',
			Edge: 'LabForm.IDMaterialIntake',                       // the graph edge the step walks (for '=': the target side's edge)
			From: 'MaterialIntakeRequirement', To: 'LabForm',
			On: [ [ 'IDMaterialIntake', 'IDMaterialIntake' ] ],    // [ column on From, column on To ] pairs (equality)
			Via: null | 'MaterialIntakeRequirement.IDMaterialIntake', // co-reference: the source FK edge
			Parent: null | 'MaterialIntake',                        // co-reference: the shared target entity
			CheckParent: false,                                     // after forcing (§21.4)
			Cardinality: 'ToOne' | 'ToMany',
			Where: <CanonicalPred> | null,                          // hop predicate on To
			Scope: 'Inherit' | 'TenantOnly', ScopeReason: null | '…',
			Elide: false, As: null
		}
	],
	Hops: 1,
	ToOne: false,                                                    // every step Forward
	Signature: '=LabForm.IDMaterialIntake'                           // the step Raw strings (aliases spliced, Where/Scope ignored) joined by ' '
}
```

`On` by direction: `>E.c` standing on `E`: `[[ c, edge.ToColumn ]]`, next entity `edge.To`. `<E.c` standing on `edge.To`: `[[ edge.ToColumn, c ]]`, next `E`. `=E.c` standing on `S`: `[[ s, c ]]` where `s` is the **unique** FK column of `S` whose edge `To` equals `edge(E.c).To` (several → `'AmbiguousCoReference'`: use the `{ Via, To }` form; none → `'NotCoReferent'`), next `E`.

### 21.3 Resolution rules

- Each step starts at the entity where the previous one ended (`'WrongStart'`); `E.c` must be a graph edge (`'UnknownEdge'`; a column without `Join` is `'NotAJoin'`); `{ Via, To }` requires both edges to `Join` the same target PK (`'NotCoReferent'`) and `Via`'s entity to be the current entity.
- Aliases are spliced before counting: `Hops ≤ Limits.MaxHops` (`'TooManyHops'`). A step object's options apply to that one step; an alias's step objects keep theirs.
- Audit-user and tenant edges may be walked when declared (01 §5.1) but are never offered by PathAuto (§20.8).
- `resolvePath` validates structure only; step `Where` fields, `TenantOnly` rules and depth are the registry's (§20.3).

### 21.4 CheckParent forcing

A co-reference step skips its parent. The registry forces `CheckParent: true` (warning `'CheckParentForced'`) when the parent entity has a delete column **or** a required policy column for some principal (`Policy.requiredFor(Parent, null)` non-empty, or the policy `Column` is a column of Parent and Parent is not excluded), **unless** a sibling item at the top level of the same `Where` (a scope's `Where`, or the facet's `Where` for a facet dimension; scope references inlined first) is an `Exists` whose first step is `>S.s` — the same FK of the same entity into the parent (08 §4.2: `ToDoForMe` visits the intake first, so no forcing). With `CheckParent: true` the lowering adds the parent as a correlated existence check inside the co-reference subquery (§24.8).

### 21.5 Graph API additions (A)

```javascript
resolvePath(pFrom, pSteps, pOptions) → PathPlan          // throws FACET_DEFINITION_INVALID { Reason, Step } ; pOptions: { Aliases: Map|object, MaxHops }
coReferenceSource(pEntity, pEdgeName) → 'S.s' | null      // throws AmbiguousCoReference when several
pathSignature(pPathPlan) → string
```

---

## 22. Bound values (B: `RetoldFacetingBinder`)

### 22.1 BindContext

```javascript
{
	Principal: <frozen Principal>,
	CurrentUser: { IDUser: 42, IDCustomer: 1, …Scope.UserRecordFields },   // from Principal.IDUser / IDCustomer / UserRecord ONLY
	Scope: { IDCustomer: 1, OwnerIDUser: 42 },                               // Principal.ScopeValues
	Now: '2026-10-08 15:02:00',      // pContext.Now floored to Cache.NowBucketMS, the naive wall clock 'YYYY-MM-DD HH:mm:ss' in Time.StorageTimeZone (Intl; an unknown zone is FACET_INTERNAL)
	Today: '2026-10-08 00:00:00',
	StartOf: { day, week, month, quarter, year },                            // FacetBuckets.dateKey(Now, interval)
	NowBucketMS: 60000,
	Used: Map<token, value>                                                  // every value bind() substituted (Binder.recordUsed: a second DIFFERENT value of one key is kept under '<key>#2', '#3', …)
}
```

`Binder.context(pContext)` is pure over `pContext.Principal`, `pContext.Now`, `pContext.Options`. The same floored `Now` is bound in Live, the Reference and Records, so every engine compares against one instant.

### 22.2 Tokens

`$CurrentUser.IDUser`, `$CurrentUser.IDCustomer`, `$CurrentUser.<F>` with `F` in `Scope.UserRecordFields`; `$Scope.<Column>` with `Column` a policy column (`Policy.Column`, a `PersonalScopes` column or a `Required` column); `$Now`, `$Today`, `$StartOf.<day|week|month|quarter|year>`; `$Param.<Name>`. `TOKEN_PATTERN` is the grammar; anything else starting with `$` is a load error. Tokens appear only as a whole `Value` in definitions (never inside arrays, never in client input: a client clause value `'$Now'` is the literal string).

### 22.3 Params

| Type | Accepts | Bound as |
|---|---|---|
| `Enum` | one member of `Values` | scalar |
| `EnumList` | non-empty array (≤ `MaxInList`) of distinct members of `Values` | array |
| `Integer` / `IntegerList` | **safe** integers (numbers or numeric strings; `Number.isSafeInteger`) within `Min` / `Max` | number / array |
| `String` | string ≤ `MaxLength` (default 256), no `~` | string |
| `Boolean` | `true false 0 1 'true' 'false' '0' '1'` | `1` / `0` |
| `DateTime` | anything `canonicalDateTime` accepts | canonical string |

`validateParams(pSchema, pValues, pOwner)`: unknown name → `400 FACET_PARAM_INVALID { Reason: 'Unknown' }`; missing without `Default` → `'Required'`; wrong type → `'Type'`; not in `Values` → `'NotAllowed'`; out of range → `'Range'`. `Detail` names `Scope` or `Facet` and `Param`, never the value. Sources: `Scopes[i].Params` (and a `NamedScope` clause's `Params`) validate against that scope; the top-level request `Params` validate against every referenced declared facet's `Params` (a name no referenced facet declares → `'Unknown'`); the `/Scope/:Scope/` route form takes the scope's params from the top-level `Params` (only the names that scope declares).

### 22.4 Binding

`bind(pPred, pBindContext, pParams)` returns a new tree (also binding every `PathPlan` step `Where`): each `{ Bind }` leaf becomes `{ Field, Op, Value }` with the value coerced by the column DataType (`ClauseCompiler.coerceValue`, element-wise for lists); a list param under `IN`/`NIN` stays a list, an `Enum` under `IN` becomes a one-element list. A `$CurrentUser.*` or `$Scope.*` value that is unset (`isUnsetScopeValue` with `Scope.UnsetValues`) → `401 FACET_UNAUTHENTICATED` (whole request; fail closed, never "matches nothing"). Every substituted token is recorded in `Used` (params keyed `'$Param:<Owner>.<Name>'`).

### 22.5 BindHash

`bindHash(pBindContext) = 'b:' + sha256(canonicalJSON([ [ token, value ] … ] sorted by token))[0..16]` over `Used` at the end of planning (filter and every Agg). A scope referenced twice with different Params binds both values (`'$Param:<Scope>.<Name>'` and `'…#2'`), so two different answers never share a BindHash. It is part of the Version (§30.2) and of every future cache key; a request that binds nothing has the hash of `[]`.

### 22.6 The Bind stage (wiring)

After Gate and before Filter: `pContext.Bind = Binder.context(pContext)`. `FilterAST.build` receives it (scope and join expansion bind immediately); the Planner binds definition `Where`, dimension and child predicates with it; `Plan.BindHash` is computed last.

---

## 23. FilterAST and clauses (B)

### 23.1 Conjunct additions

```javascript
{
	…M1 fields (Id, Origin, Fields, NeverExclude, Fence, NamesDeleted, Pred),
	Origin: { Kind: 'Clause' | 'String' | 'RawFilter' | 'Scope' | 'Join', Hash, FilterKey, ClauseType, Index,
	          Scope: 'Project.MyProjects' | undefined, Params: { … } | undefined },     // Scope conjuncts only (validated params)
	Shape: 'Column' | 'Path',          // 'Path' when Pred contains an Exists / NotExists / HavingCount node
	Binds: [ '$CurrentUser.IDUser' ],  // tokens this conjunct bound
	Entities: [ 'ProjectMembership' ]  // entities other than the route entity it reads (gated, §19.6)
}
```

M1 conjuncts get `Shape: 'Column'`, `Binds: []`, `Entities: []`.

### 23.2 Bound Pred grammar (conjunct `Pred`)

Part I §4.1 leaves and `And`/`Or`, plus the CanonicalPred existence nodes (§20.7) with every `Bind` replaced by a coerced `Value` (also inside step `Where`s). Conjuncts never use `From` (TuplePivots are definitions-only). A Path-shape conjunct's leaves are on the route entity; its existence nodes' `Where`s are on their `Path.To`.

### 23.3 `FilterAST.build(pEntity, pInput)` (M2)

```javascript
FilterAST.build(pEntity,
	{
		Clauses, FilterString,                     // M1
		Scopes: [ { Scope, Params } ] | null,      // request Scopes (the normalizer validated the shape)
		Bind: <BindContext> | null,                // required when any scope or join clause is present, else FACET_INTERNAL
		CanFacet: (pEntity) => boolean | null      // §19.6; null = allow (unit tests)
	})
→ { Entity, Conjuncts, IncludesDeleted, Applied, Warnings, Entities: [ … ] }   // Entities: every non-root entity any conjunct reads
```

Conjunct order (and so Ids): every clause in array order (a `NamedScope` clause at its own index; merged OR groups as M1), then the FilterString terms, then the request `Scopes` in array order. Bodies without scopes or join clauses produce exactly the M1 Ids. `Applied` gains `{ Scope: '<name>' }` for every scope conjunct (clause or request). More than `Limits.MaxScopesPerRequest` scopes (clauses + request) → `422 FACET_TOO_LARGE { Limit: 'MaxScopesPerRequest' }`.

### 23.4 Compile targets

| Input | Conjunct |
|---|---|
| request `Scopes[i]` / clause `{ Type: 'NamedScope', Scope, Params }` | `registry.scope(Scope)`: unknown, disabled or `Entity ≠ route entity` → `400 FACET_UNKNOWN_SCOPE { Scope }`; gate every `scope.Entities` (`403`) **before** `Supported: false` → `422` (no feature leak about a scope over hidden entities); params validated (§22.3); `Pred = Binder.bind(scope.Where)`; `Origin: { Kind: 'Scope', Scope, Params, Hash: <clause Hash or null>, FilterKey: null, ClauseType: 'NamedScope' \| null }`, `Fields: [ '@scope:<Scope>' ]`, `NeverExclude: true`. A `NamedScope` **clause** is extracted before the pict-sequence algebra (it is never OR-combined with client clauses); `Junction: 'OR'` or a `GUIDGroup` on it → `400 FACET_FILTER_INVALID { Reason: 'NamedScopeJunction' }` |
| `InternalJoinSelectedValue(List)` | **first** the client-named `RemoteTable` is gated (an unknown, hidden or unreadable name is the same `403`, no Detail, before any graph lookup; a missing name is a malformed clause); then edge `<Entity>.<JoinInternalConnectionColumn>` must exist with `To === RemoteTable` and `ToColumn === (JoinExternalConnectionColumn \|\| ToColumn)`, else `400 FACET_FILTER_INVALID { Reason: 'UndeclaredJoin' }`; gate `RemoteTable`; lookup field `ExternalFilterTableLookupColumn \|\| 'ID' + RemoteTable` (a filterable column of RemoteTable, else `FACET_UNKNOWN_FIELD`); `Pred = { Exists: { Path: [ '>E.c' ], Where: { Field: lookup, Op: 'IN', Value: [ coerced non-null values ] } } }` (no values → ignored + `FACET_CLAUSE_EMPTY`) |
| `InternalJoinMatch / StringMatch / DateMatch / NumericMatch` | same edge rule; fields `ExternalFilterByColumns \|\| [ ExternalFilterByColumn ] \|\| [ 'Name' ]`; per field × value `EQ` (ExactMatch, or Numeric/Date default) else `LK '%v%'`, `Or` of all, inside one `Exists` |
| `InternalJoinRange / StringRange / NumericRange / DateRange` | same edge rule; per field `GE/GT Start`, `LE/LT End` (M1 bound rules incl. day-aligned date binding), `And` of all, inside one `Exists` |
| `ExternalJoin*` | **first** `JoinTable` and `ExternalFilterByTable` are gated (as above); then `JoinTable.JoinTableCoreConnectionColumn` must be an edge to the route entity's `CoreConnectionColumn` (default its PK) and `JoinTable.JoinTableExternalConnectionColumn` an edge to `ExternalFilterByTable.ExternalFilterByTableConnectionColumn` (default that edge's ToColumn), else `UndeclaredJoin`; gate `JoinTable` and `ExternalFilterByTable`; `Pred = { Exists: { Path: [ '<J.core', '>J.ext' ], Where: <remote pred on ExternalFilterByTable as for InternalJoin*> } }` (SelectedValue lookup field `ExternalFilterTableLookupColumn \|\| 'ID' + ExternalFilterByTable`) |
| any other type | M1 (`400 UnsupportedClauseType`) |

Join clauses take part in the pict top-level sequence exactly like column clauses (`Junction`, `GUIDGroup`, `Ordinal`); an OR that binds a join clause with a column clause produces one Path-shape conjunct (`Or[Exists, leaf]`). `Origin.Kind: 'Join'`, `ClauseType` = the clause type; `M2_CLAUSE_TYPES` = M1 types + the twenty `InternalJoin*` / `ExternalJoin*` types + `NamedScope`.

### 23.5 Ownership signatures, FilterKey defaults

- A join conjunct whose every remote field is the edge's `ToColumn` (lookup by the target key, L3) has `Fields: [ JoinInternalConnectionColumn ]` and default `FilterKey` = that column (E1's `IDClient` clause is owned by the `Project.IDClient` facet by both rules). Otherwise `Fields: [ '@path:<PathPlan.Signature>#<RemoteField>' … ]`.
- A facet whose dimension is a path (K8, K9) owns `'@path:<Signature>#<Field or KeyField>'`; its default `FilterKey` is its FacetID. Declared facets on a pivot column own the column and default `FilterKey` to it.
- Scope conjuncts own nothing (`'@scope:<name>'`) and are `NeverExclude`; ChildRollup, ExistsSplit and TuplePivot facets own nothing (default `Exclude: 'None'` for K12/K20/TuplePivot unless declared).

### 23.6 Rendering rules

- `applyToQuery` renders `Shape: 'Column'` conjuncts only; a Path-shape conjunct → `FACET_INTERNAL` (a wiring bug). Rel `Where` (column-only) renders through it with `ParameterPrefix: 'w'`.
- `toFilterString` throws `FACET_FILTER_INVALID { Reason: 'PathConjunct' }` for a Path-shape conjunct: the stock list cannot carry it, so the harness counts those through the Reference engine (§32.3).

---

## 24. FoldIR (B lowers; C and D consume)

FoldIR stays "the only thing engines compile" (01 §6): the Planner lowers bound conjuncts and canonical definitions into Rels, predicate trees and dimensions; **both** engines read the same FoldIR (Live compiles it to SQL, the Reference interprets it over list reads), so a lowering bug shows in both and the per-kind oracles (§34) must catch it independently of the engines.

### 24.1 Rel (M2)

```javascript
{
	Entity: 'Task',
	As: 'h3',                                   // plan-wide unique SQL alias (§24.7)
	Role: 'Pivot' | 'TupleSide' | 'Hop' | 'Lookup' | 'Multi' | 'Child' | 'Parent',
	Project: [ 'IDTask', 'IDProject' ],         // PK first, then sorted unique: inner On columns, Key / dimension / KeyField columns; catalog columns only
	Client: [ <Conjunct> ] | null,              // Pivot and the Home TupleSide only: the Variant's Column-shape conjuncts (client fence, M1)
	Where: <ColumnPred> | null,                 // bound, column-only ({ Field, Op, Value } / And / Or); never the delete or a policy column
	WhereHash: '' | 'wh:<12 hex>',              // sha1(canonicalJSON(Where))
	Scope: 'Inherit' | 'TenantOnly',
	ScopeReason: null | '…',                    // required with TenantOnly
	SoftDelete: 'Explicit' | 'ClientControlled',// ClientControlled only for Role 'Pivot' when the Variant IncludesDeleted
	Stage: 'Never' | 'Allowed'                  // Allowed: leaf of an Exists / NotExists / ExistsFlag with no nested Where and integer inner On columns (§26.3)
}
```

### 24.2 FoldPred (predicates outside Rels)

```javascript
{ Node: 'Cmp', Alias: 'p', Field: 'OwnerIDUser', Op: 'EQ', Value: 42 }     // column leaf on Alias's row; rendered as a PredicateFragment (Live) / list membership (Reference)
{ Node: 'And', Items: [ … ] }   { Node: 'Or', Items: [ … ] }
{ Node: 'Exists' | 'NotExists',
  Rel: <Rel>,
  On: [ { Outer: { Alias: 'p', Field: 'IDProject' }, Inner: 'IDProject' } ],   // equality pairs; Outer is any alias in scope, Inner a column of Rel.Entity
  Where: <FoldPred> | null }                                                   // nested; its Cmp leaves use Alias === Rel.As
{ Node: 'CountCmp', Rel, On, Where, Op: 'EQ'|'NE'|'GT'|'GE'|'LT'|'LE', N: 3 } // K19: (count of matching visible rows) Op N
{ Node: 'True' }   { Node: 'False' }
```

SQL three-valued logic applies to every Cmp (a NULL never satisfies a comparison; `NE` rejects NULL), and On pairs are SQL equality (NULL never equal).

### 24.3 Dimensions (M2)

M1 Dims (`Column`, `DateBucket`, `NumericBucket`, `Range`) gain two optional fields:

```javascript
Alias: 'p' | 'u1',                    // the relation the Field is read from (TuplePivot sides); default 'p'
Via: null | [ { Rel: <Rel Role 'Lookup'>, On: [ { Outer: { Alias, Field }, Inner } ] } … ]   // K8: a to-one chain from Alias; the value is Field of the LAST Rel, NULL when any link has no visible row
```

New kinds:

```javascript
{ Kind: 'Multi', Chain: [ { Rel: <Rel Role 'Multi'>, On } … ], Where: <FoldPred> | null,    // K9: Where on the last Rel (nested)
  KeyField: 'IDUser', DataType, IsInteger, Scale }
{ Kind: 'ChildAgg', Rel: <Rel Role 'Child'>, On, Where: <FoldPred> | null, Agg: 'count', Field: null,
  Edges: [ 1, 3, 10 ], IsInteger: true }                                                       // K12
{ Kind: 'ExistsFlag', Pred: <FoldPred Exists node> }                                           // K20: key 1 when true, 0 when false
```

Every Dim keeps `DataType`, `IsInteger`, `Scale` of its keyed column (ChildAgg: `DataType: 'Numeric'`, `IsInteger: true`; ExistsFlag: `DataType: 'Boolean'`). A ChildAgg / ExistsFlag Dim also carries the definition's `Labels` (`{ '<band>': … }` / `{ true, false }`) when it declares any; §29.2 labels its buckets from them (the engines ignore them).

### 24.4 TupleJoin (K18)

```javascript
Agg.Tuple =
{
	Sides: [ { Name: 'i', Alias: 'p', Rel: <Rel Role 'TupleSide'> }, { Name: 'r', Alias: 'u1', Rel: <Rel Role 'TupleSide'> } ],
	On: [ { Left: { Alias: 'p', Field: 'IDMaterialType' }, Right: { Alias: 'u1', Field: 'IDMaterialType' } } ],
	Key: [ { Alias: 'p', Field: 'IDMaterialIntake' }, { Alias: 'u1', Field: 'IDLabFormType' } ],
	Names: { i: 'p', r: 'u1' }
}
```

The **Home side** (the first side whose entity is the route entity) takes SQL alias `'p'`, carries the Variant's Column conjuncts (`Rel.Client`), and the Variant's `PathPred` applies to it unchanged. Other sides are `'u1'`, `'u2'`, … (numbered in declared order); definition names never reach SQL. `Tuple.Sides` is ordered **Home first, then each side as soon as an On pair links it to a side already placed** (whatever order the definition declared), so `Sides[0].Alias === 'p'` and every later side joins an earlier one in both engines. `Agg.Pivot` is the Home entity; `CountMode: 'KeyDistinct'`.

### 24.5 Agg additions

```javascript
{
	…M1 fields,
	Kind: …M1 | 'ChildRollup' | 'ExistsSplit',          // K8 / K9 are Terms (and DateHistogram/NumericHistogram/Ranges for K8) with Via / Multi dims
	Origin: 'Auto' | 'PathAuto' | 'Declared' | 'Sibling',
	Definition: null | { Facet, Version, DefinitionHash, FoldHash, SiblingOf },
	Where: <FoldPred> | null,                           // the definition Where (W_def), lowered at pivot / tuple scope; never excluded
	WhereHash: '' | 'wh:…',
	Tuple: null | <TupleJoin>,
	CountMode: 'Rows' | 'PivotDistinct' | 'KeyDistinct',
	MultiValued: false,                                 // true for Multi dims
	Relaxed: false, Semantics: null | 'NoVisibleMatch',
	Path: null | [ '>MaterialIntakeRequirement.IDMaterialIntake', '>MaterialIntake.IDLabQueue' ],   // FacetResult.Path (path dims)
	OwnedFields: [ … ],                                 // OF(f) handed to the DisjunctivePlanner (§23.5)
	Entities: [ … ],                                    // every entity the Agg reads (per-facet gate, DepSet)
	Relations: [ { Alias, Entity, Role } ],             // flat listing of every Rel inside the Agg (informational)
	CubeId: null | 'cube0',                             // set when the Agg is a cube member (§25.2)
	LabelLookup: …M1, also from LabelField / Labels.Path
}
```

### 24.6 Variant (M2)

```javascript
{
	…M1 fields (VariantId, Entity, ConjunctIds, Conjuncts, ExcludedIds, IncludesDeleted, Facets),
	Hash: 'c1,c3|wh:…',                   // kept conjunct Ids '|' WhereHash ('' for no W_def)
	ColumnConjuncts: [ … ],               // kept Shape 'Column' conjuncts → pivot Rel.Client
	PathPred: <FoldPred> | null,          // kept Shape 'Path' conjuncts, lowered at scope 'p' (And of them)
	Where: <FoldPred> | null,             // the W_def shared by its facets (null for v0)
	WhereHash: '',
	Relations: [ { Alias, Entity, Role } ]
}
```

Facets group by **(kept conjunct set, WhereHash)**; `v0` is always the full filter with no W_def (envelope Total, Records, Count, Keys, and every `Exclude: 'None'` facet without a W_def). The DisjunctivePlanner takes `pFacetSpecs[i].WhereHash` (+ `Where`) besides the M1 fields.

### 24.7 Aliases

Plan-wide unique (one counter per prefix for the whole plan, so any composition — the cube included — never collides): `'p'` the entity pivot / Home side; `'p2'`, `'p3'`, … extra renderings of the pivot (ChildAgg restriction); `'u<n>'` other tuple sides; `'h<n>'` hops of Variant filter predicates; `'j<n>'` hops of definition `Where`s; `'l<n>'` Via lookups; `'m<n>'` Multi chains; `'x<n>'` ChildAgg children; `'e<n>'` ExistsFlag hops; parent checks use their chain's prefix. Shell templates use only the single letters `p t r d g k v c` as internal aliases, which a FoldIR alias (letter + digits) never equals. All match `ScopedRelationBuilder.ALIAS_PATTERN`. Bind names: SR `'<alias>_…'`, fragments `'q<n>_…'`, staged keys `'<alias>_Keys'` / `'<alias>_K<i>'`, shells `'f…'`.

### 24.8 Lowering rules (B)

| Construct | FoldIR |
|---|---|
| kept Column-shape conjunct | pivot `Rel.Client` (fenced; M1) |
| kept Path-shape conjunct | `Variant.PathPred` (And), scope `'p'`; its leaves → `Cmp { Alias: 'p' }` |
| `Exists { Path s₁…sₙ, Where W, Correlate C }` at outer alias `o` | `Exists { Rel(s₁.To, Where: col(s₁.Where)), On: s₁.On (Outer o), Where: And(path(s₁.Where), <s₂ … the same, Outer = s₁'s alias>) }`; the innermost Rel's `Where` = `col(sₙ.Where ∧ W)`, its nested `Where` = `path(sₙ.Where ∧ W)`, and `C` is appended to the innermost `On` with `Outer` = the pivot / `From` side alias |
| `NotExists { … }` | the **outermost** node is `NotExists`, every inner node `Exists` ("no visible chain") |
| co-reference step `=E.c` from `S` | an `Exists` over `Rel(E)` with `On [[S.s → E.c]]`; `CheckParent: true` adds, inside that `Exists`'s `Where`, `Exists { Rel(Parent, Role 'Parent'), On: [ { Outer: { Alias: <E alias>, Field: c }, Inner: <Parent PK> } ] }` (01 §4.5) |
| `HavingCount { Path (one '<' or '=' step), Where, Correlate, Op, Value }` | `CountCmp { Rel(step To, Where: col(...)), On, Where: path(...), Op, N: Value }` |
| `Or` / `Any` | `Or`; an `Or` that contains any existence node stays whole (its leaves become `Cmp` on the alias in scope) |
| `col(X)` / `path(X)` | split of an `And`: column-only items (leaves, column-only And/Or) go into the Rel's `Where`; items with existence nodes stay as nested FoldPred |
| step `Scope: 'TenantOnly'` | that step's `Rel.Scope = 'TenantOnly'`, `ScopeReason` |
| K8 dimension (to-one `Path` + `Field`) | `Dim.Via` = one Lookup Rel per step (`Where` = `col(step.Where)`; a path part → refused at load, §20.3) |
| K9 dimension | `Dim.Kind 'Multi'`: one Multi Rel per step (step `Where` split col / path as above), the dimension's `Where` split col → the last Rel's `Where`, path → `Multi.Where`; `Agg.CountMode 'PivotDistinct'`, `MultiValued: true` |
| ChildAgg / Multi / Via `On` | from the path's step `On` pairs, `Outer` = the previous alias (the pivot for the first step) |
| K12 `ChildRollup` | `Dim.Kind 'ChildAgg'` (child `Where` split col/path as above) |
| K20 `ExistsSplit` | `Dim.Kind 'ExistsFlag'`, its `Exists` lowered as above at scope `'p'` |
| TuplePivot | `Agg.Tuple`; each side's `Where` → `col` into the side Rel, `path` into `Agg.Where` with `Outer` = that side's alias |
| definition `Where` (W_def) | `Agg.Where` (whole tree, scope `'p'`; column leaves stay `Cmp` so the cube can flag them — C may render a top-level column-only item inside the pivot SR instead, in its own fence) |
| L3 FK pushdown | optional: an `Exists` whose single `>` step's `Where` is only `ToColumn IN K` may get a sibling `Cmp { p.FK IN K }`; it never replaces the `Exists` |
| L4 elision | never in M2 (§36) |

### 24.9 Raw results of the new kinds (both engines, then §29 post-processing)

| Kind / Dim | RawFacetResult |
|---|---|
| Terms with `Via` (K8) | as M1 Terms; a pivot row whose chain has no visible target has key NULL → `MissingCount` |
| DateHistogram / NumericHistogram / Ranges with `Via` | as M1, value read through the chain (NULL → Missing) |
| Terms with `Multi` (K9) | `Total` = pivot rows; `Groups` = key → number of **distinct pivot rows** with at least one visible chain to that key; `MissingCount` = pivot rows with no key; `DistinctKeys`; Live row caps and `SelectedKeys` as M1 Terms |
| ChildRollup (K12) | `Total`; `MissingCount: 0`; `Groups: [ { Key: band, Count } ]` — band 0 = no visible matching child (`Edges[0]` is always 1, so band 0 is exactly a count of 0 / NULL), band i = `[Edges[i−1], Edges[i])`, last band open (01 §4.6) |
| ExistsSplit (K20) | `Total`; `MissingCount: 0`; `Groups: [ { Key: 1, Count }, { Key: 0, Count } ]` |
| any kind over a TuplePivot | `Total` = distinct `Key` tuples passing `Agg.Where` and the Variant; `Groups` count distinct `Key` tuples per key |
| Pivot | axes may carry `Via`; a Pivot over a TuplePivot is refused at load |

`Total` of every facet is computed over its own base set (never summed from buckets); for K9 `SumOfCounts` may exceed `Total`.

### 24.10 DepSet across hops

`FoldIR.depSet(pAgg, pVariant, pCatalog)` = for every Rel in the Agg **and** in its Variant's `PathPred`: the Rel's PK, delete column, policy columns, `Project` columns, `Where` fields and inner `On` columns; plus M1's pivot columns. `Planner.depSet(pAggs)` unions as M1.

### 24.11 Planner / FoldIR API additions (B)

```javascript
Planner.plan(pContext, fCallback)            // → { Aggs, Variants, Cubes: [ CubePlan ], DepSet, Entities, BindHash, Errors }
Planner.planBase(pContext, fCallback)        // Records / Count / Keys: → { Variant: <v0 lowered>, Pivot: Entity, DepSet, Entities, BindHash }
Planner.resolveFacets(pFacetSpec, pContext)  // §20.8 (registry first)
Planner.lowerPred(pBoundPred, pScope, pAliasCounter) → FoldPred        // pScope: { Alias, Entity }
FoldIR.rel(pFields) → Rel (defaults applied)
FoldIR.realias(pTree, pFrom, pTo) → tree (pure; tests and composers)
FoldIR.relations(pTree) → [ Rel ] (every Rel inside a FoldPred / Dim / Agg)
```

---

## 25. Variants and the conditional disjunctive scan (B plans, C executes)

### 25.1 Eligibility

A **cube member** is an Agg on an entity pivot (`Tuple` null), not `MultiValued`, of kind `Count`, `Terms`, `DateHistogram`, `NumericHistogram` (only `Mode: 'Edges'`), `Ranges`, `Pivot`, `ChildRollup`, `ExistsSplit`, **`Stats` or `Missing`** (M2 review: single-row aggregates as per-group *measures*, §25.2) (dimensions may carry `Via`), whose Variant is not `IncludesDeleted` and excludes no conjunct that `NamesDeleted`. Per pivot entity the planner forms one cube when `PlanForm.Cube` is `'Always'` and at least one member exists, or `'Auto'` and at least two members exist; `'Never'` forms none. NumericHistogram `Nice` (bounds, then buckets), DistinctCount, K9 and TuplePivot Aggs keep their own statements.

### 25.2 CubePlan

```javascript
{
	CubeId: 'cube0',
	Pivot: 'Project',
	Flags: [ { Flag: 'b1', ConjunctId: 'c1' }, … ],      // every conjunct some member excludes, in conjunct order
	Common: [ 'c4', 'c5' ],                                // every other conjunct (scopes, RawFilters, unowned): the cube's base filter
	WhereFlags: [ { Flag: 'w1', WhereHash: 'wh:…', Where: <FoldPred> } ],   // one per distinct non-empty member WhereHash
	Dims: [ { Column: 'd1', Dim: <Dim>, Members: [ 'Status', 'StatusByClient' ] } ],   // de-duplicated by canonical JSON of the Dim
	Bounds: [ { Lo: 'lo1', Hi: 'hi1', Dim: 'd3' } ],      // min / max of the canonical date VALUE per group, for DateHistogram members
	Measures: [ { Column: 'm1', Kind: 'Stats' | 'Missing', Field, DataType, Scale, Members: [ … ] } ],   // per group: count(v) "m1nn"; Stats also min "m1lo", max "m1hi", the integer-unit sum "m1su" (bind 'fm1Factor'); members carry Measure: 'm1'
	Members: [ { AggKey: 'Status', Dims: [ 'd1' ], RequireFlags: [ 'b2', 'b3' ], RequireWhere: null | 'w1' } … ],
	MaxGroups: <Limits.CubeMaxGroups>
}
```

`RequireFlags` of a member = `Flags` minus the conjuncts its Variant excludes; `#Total` requires every flag and no W_def. Plan: `{ …, Cubes: [ CubePlan ] }`; each member Agg keeps its full per-Variant form and gets `CubeId`.

### 25.3 Execution and marginalization (C, `RetoldFacetingCubeExecutor`)

- Base relation: the pivot SR built from the **Common** Column conjuncts (fenced), the Common Path conjuncts as pivot-level predicates; each flag `b<n>` = `CASE WHEN <conjunct> THEN 1 ELSE 0 END` (column conjuncts as PredicateFragments, path conjuncts as `EXISTS (…)`), each `w<n>` likewise for a W_def; one **plain** `GROUP BY` over every `d<n>`, `b<n>`, `w<n>` with `count(*) AS "N"` and the `lo`/`hi` bounds; at most `MaxGroups + 1` rows.
- Behavior transforms: if the capture of the Common SR has `Transformed` entries (a behavior rewrote client operators, e.g. LIKE → ILIKE), **or** the fragment probe (§26.4) finds a transformed flag / W_def / Common column leaf, the flags would be evaluated outside the pivot's own relation: **fall back** (per-Variant statements, which put the owned conjuncts back inside the relation).
- Measures marginalize like the counts: `Rows = Σ N`, `NonNull = Σ nn`, `Min = min(lo)`, `Max = max(hi)` (numbers, or canonical date strings), `SumUnits = Σ su`; the result goes through `EngineLive.foldRows` exactly as the single-row Stats / Missing statement's row does (O5).
- Fallbacks are logged at `warn` (with the driver's code and message, never bound values) for `Statement`, `Compose`, `Collect`, `Relation`; at `info` for `CubeMaxGroups`, `Transformed`, `Ineligible`.
- `marginalize(pCubePlan, pMemberAggs, pGrainRows)` (pure): member m sums `N` over grain rows whose `RequireFlags` are all `1` and whose `RequireWhere` (if any) is `1`, grouped by its dims; DateHistogram bounds are the min / max over the same rows; keys are normalized exactly as the per-Variant statement's rows are (`foldRows`). The RawFacetResult of every member **equals** its per-Variant result (O5).
- More than `MaxGroups` grain rows → `FellBack: true`: the members run per Variant (never an error, recorded in `Execution.CubeFallbacks`).

---

## 26. Live: per-hop Scoped Relations, TenantOnly, Staged, composition (C)

### 26.1 `buildRelation` (M2)

1. Shape checks as M1 (`Rel.Where` is now legal; `Scope` is `'Inherit'` or `'TenantOnly'`).
2. Fresh `DAL.query`; client fence (Pivot / Home side only, M1); **Where fence**: `addFilter('', '', '(', 'AND', 'FacetWhereOpen')`, `FilterAST.applyToQuery([ { Id: 'w', Pred: Rel.Where } ], …, { ParameterPrefix: 'w' })`, `addFilter('', '', ')', 'AND', 'FacetWhereClose')`.
3. Explicit `Deleted = 0` at depth 0 for every Role except a `ClientControlled` pivot (D-37).
4. `ScopeCapture.capture(pContext, Entity, query, Rel.Scope, …)` (§26.2 for TenantOnly).
5. Opaque capture: Staged when §26.3 allows it, else `500 FACET_SCOPE_POLICY_VIOLATION { Reason: 'OpaqueUntrusted' }` (as M1).
6. Projection, build, harvest as M1.
7. Memo: the pre-harvest relation is memoized by `(Entity | ClientIds | WhereHash | Scope | SoftDelete | Project)` — **alias excluded** — and harvested per alias; `Counters.Relations` counts distinct keys (so the same hop under two aliases costs one relation and one behavior run).

### 26.2 TenantOnly

`RetoldFacetingScopeCapture.relaxPersonalScope(pFilter, pPolicy, pPrincipal, pEntity)` — static, pure, exported (the Reference uses the same function, §27.2):

```javascript
→ { Filter: [ …entries without the removed one ], Removed: [ <entry> ], Refused: null | 'NoPersonalScope' | 'NotFound' | 'NotExact' | 'ColumnElsewhere' }
```

The personal column is `pPolicy.PersonalScopes[pEntity].Column`. Exactly one entry may name it (after `stripColumn`), at depth 0, `Operator '='`, `Connector 'AND'`, `Value` equal (after `normalizeScopeValue`) to `pPrincipal.ScopeValues[Column]`; that entry is removed. Any other mention (inside a group, under OR, with IN, a second entry, a client conjunct) → `'ColumnElsewhere'`; no entry → `'NotFound'`; a non-exact one → `'NotExact'`.

`capture(…, 'TenantOnly')`: run the behaviors, then relax; `Refused` → the capture is Opaque (`OpaqueReasons: [ 'TenantOnlyRefused:<reason>' ]`) and is **never** staged (always the 500); ScopeGuard then asserts the required set **minus** the personal column, that no entry names the personal column, that the remaining required set is **not empty** (`'TenantOnlyUnscoped'`, fail closed: a personal-only entity relaxed would cross tenants), and — always for a TenantOnly capture — that no depth-0 connector is OR. `Fingerprint` and the capture memo key include the scope mode. The relaxation keeps the tenant predicate and every other behavior entry; it never crosses tenants (06 §4.4). Facets using a TenantOnly hop report `Relaxed: true`.

### 26.3 Staged hops

- **When.** `PlanForm.Staged` `'Never'` → never (an Opaque capture is refused). `'Auto'` (default) → a Rel with `Stage: 'Allowed'` whose capture is Opaque and whose entity is in `Scope.TrustedOpaque`. `'Always'` (O5 tests) → every Rel with `Stage: 'Allowed'`. A `Stage: 'Never'` Rel with an Opaque capture is refused (dimensions, children, CountCmp, non-leaf hops: `422 FACET_FOLD_UNSUPPORTED { Feature: 'StagedNonLeaf' }` when the entity is trusted, else the 500).
- **Run.** The hop's own scoped query (Where fence, soft delete, behaviors, guard) as `SELECT DISTINCT <inner On columns>` capped at `Limits.MaxStagedKeys + 1` rows through `provider.Read`. For a trusted Opaque capture whose behavior replaced the query, ScopeGuard still asserts the post-behavior **filter** (required depth-0 `=` AND entries, no depth-0 OR — never deferred; `Deferred: true` only marks the capture), and `StagedKeys.assertRenderedPolicy` checks the replacement exactly: it must be a `queryOverride` template (a `queryBranches` replacement is `TemplateNotVerifiable`) that renders `<%= Where %>` exactly once (`WhereNotRenderedOnce`), holds no `UNION` anywhere and no `OR` after the Where (`TemplateWidens`), and for every required policy column the guarded filter entry's **own** bind (`<Parameter>_w<index>`) holds the principal's value and appears in the SQL as `<column> = <bind>` (optionally qualified by the entity's own table) (`PolicyNotRendered`); any violation is the 500. The inner columns are read from its rows. More than `MaxStagedKeys` keys → `422 FACET_PATH_TOO_BROAD` (whole request for a Variant `PathPred` hop, per facet otherwise).
- **StagedRelation.**

```javascript
{ Alias: 'h2', Entity: 'LabForm', Staged: true, Dialect, Columns: [ 'IDMaterialIntake', 'IDLabFormType' ],
  Keys: [ [ 7, 3 ], … ],                         // distinct, sorted, integers only (a non-integer value → FACET_INTERNAL)
  Count: 412, Capture: <ScopeCapture>,
  Params: { h2_Keys: '[[7,3],…]' } | { h2_K0: '{7,…}', h2_K1: '{3,…}' }, ParamTypes: { } }
```

- **Positional keys.** The staged key columns are the On pairs' inner columns in On order; the membership maps key column `i` to `On[i].Outer` by position (two pairs that share an inner column — `'=E.c'` plus a Correlate onto `c` — keep both correlations).
- **Membership** (`StagedKeys.membership`, ONE scalar per key column, never a JS array): SQLite `IN (SELECT value FROM json_each(:h2_Keys))` / composite `EXISTS (SELECT 1 FROM json_each(:h2_Keys) AS "v" WHERE json_extract("v"."value", '$[0]') = … AND …)`; PostgreSQL `= ANY(CAST(:h2_K0 AS bigint[]))` / composite `EXISTS (SELECT 1 FROM unnest(CAST(:h2_K0 AS bigint[]), CAST(:h2_K1 AS bigint[])) AS "v"("a", "b") WHERE …)`; MySQL `JSON_TABLE`, MSSQL `OPENJSON` (dry-built). `NOT` for anti-joins. No chunking in M2.

### 26.4 Composition rules

- **Pivot-level predicates first.** `Variant.PathPred` and `Agg.Where` filter pivot rows before any dimension join; a PredicateFragment is rendered only in a scope whose sole FROM item is its alias (wrap the pivot in a derived table before joining Via / Multi / ChildAgg relations).
- **Fragments honor the entity's behaviors (M2 review).** A column leaf rendered as a PredicateFragment (a scope's leaf under `Any` with an existence node, a W_def leaf, a cube flag, a nested Where leaf on a hop alias) is outside its entity's Scoped Relation, so the entity's behavior never sees it. `StatementComposer.buildUses` therefore ends with `probeFragments`: per entity, one capture (`PredicateCompiler.probeTransforms`, memoized per request in `pContext.Memo.FragmentProbes`) of a fresh query whose client fence holds exactly those leaves; every entry the behavior's operator rewrite touched (`Transformed`) is recorded by `(column, operator, value)` and `fragment()` renders the rewritten operator. An Opaque probe is the 500. Each probe is a behavior run (counts toward `MaxBehaviorRunsPerRequest`).
- **Exists / NotExists / CountCmp** as in 03 §3.4 (`NOT EXISTS`, never `NOT IN`); every On pair is an equality on quoted, alias-qualified catalog columns.
- **Via (K8):** `LEFT JOIN (<SR>) "l1" ON "l1"."<pk>" = "p"."<fk>"` per link (to-one by construction), so an invisible target is NULL, never a dropped row.
- **Multi (K9):** two-level distinct (`SELECT key, count(*) FROM (SELECT DISTINCT key, "p"."<pk>" …) GROUP BY key`), never `count(DISTINCT …)`; a sibling count of the pivot gives `Total`, and pivot rows with no key give `MissingCount`.
- **ChildAgg (K12):** the child aggregate is restricted to the pivot's keys (a second rendering of the pivot SR, alias `'p2'`, 03 §3.4) or computed as a correlated scalar subquery — both must agree.
- **TuplePivot (K18):** `FROM (<SR p>) "p" JOIN (<SR u1>) "u1" ON …` then the two-level distinct over `Key` columns.
- **ExistsFlag (K20):** `CASE WHEN EXISTS (…) THEN 1 ELSE 0 END`.
- **Shell templates.** New templates go into all four `Shell-Templates-<Dialect>.js` files (in a block marked `// M2`), use only structural slots (`SR<n>[a-z]?`, `D<n>`, `P<n>`, `JOINS`, `WHERE`, `AND_WHERE`, and new `FLAGS`, `GROUP` if needed — `ALLOWED_SLOT_PATTERN` and `PASS_THROUGH_SLOT_PATTERN` may gain exactly those), never bind arrays, and pass `validateAll()`. An empty slot renders as `''` (C always sets it), so the M1 goldens do not change when M1 templates gain a `WHERE` / `JOINS` slot.
- `compileAgg(pContext, pAgg, pRelations, pDialectName, pOptions)` stays the O9 entry point; the O9 goldens gain one K8, K9, K10, K11 (composite), K12, K18, K19, K20 and cube statement per dialect, and a Staged membership per dialect.

### 26.5 Records / Count / Keys statements (C)

```javascript
EngineLive.countBase(pContext, pBasePlan, fCallback)                       // → (pError, Count)
EngineLive.recordKeys(pContext, pBasePlan, { Sort, Begin, Cap }, fCallback) // → (pError, { Keys, Statements })
EngineLive.keys(pContext, pBasePlan, { Cap }, fCallback)                    // → (pError, { Keys, Count, Truncated })
```

Ordered keys: `SELECT "p"."<pk>" FROM (<v0 SR>) "p" <PathPred> ORDER BY <sort> LIMIT :fCap OFFSET :fBegin` where each sort field renders `CASE WHEN "p"."F" IS NULL THEN 1 ELSE 0 END, "p"."F" <Dir>` (NULLs last in both directions on every dialect) and the PK ascending is always the final tie-break. Keys: ordered by PK, `LIMIT :fCapPlusOne` (`Truncated` when `Cap + 1` came back); when not truncated `Count` is the key list's length (one statement, one snapshot); only a truncated answer runs the count statement (on PostgreSQL READ COMMITTED it may see a later snapshot; `Count ≥ Cap + 1` either way).

### 26.6 Execution additions

`Execution.Captures[Entity]` aggregates the fingerprints of **every** captured relation of that entity (pivot, hops, children, tuple sides; TenantOnly captures fingerprint differently); `Execution.Repaired` as M1 over all of them; `Execution.CubeFallbacks: [ CubeId ]`; `Execution.Staged: { Relations: n, Keys: n }`. `Counters.StagedKeys` counts staged keys.

---

## 27. Engines

### 27.1 Live `capable()` (C)

Accepts every kind of §24.9 except: TuplePivot with a Pivot Agg, Multi or ChildAgg pivot axes, `CountMode` other than the Agg's own; refuses with `{ Capable: false, Reason }` → per-facet `422 FACET_FOLD_UNSUPPORTED { Feature: Reason, Milestone: 2 }`.

### 27.2 Reference across entities (D)

The oracle interprets the same FoldIR **without** any SQL composition: every relation is read through **its own entity's list waterfall** as the same principal, and every predicate is evaluated in JS except column predicates, which the database evaluates through those list reads (so LIKE, collation and numeric-text semantics are the list's, on every dialect).

```
listRows(Entity, { Client, Where, Scope }):                       memoized in pContext.Memo.HopRows by Entity|Scope|ClientIds|WhereHash
	state = controller.initializeRequestState(pContext.Request, 'Reads')   (the route-bound controller of Entity)
	state.Query = controller.DAL.query; setCap(0); setBegin(0)
	fence(Client) ; fence(Where)                                           (FilterAST.applyToQuery)
	runBehavior(Scope.Behavior)                                            (Entity's own tenancy / owner scope, as its list)
	Scope 'TenantOnly' → ScopeCapture.relaxPersonalScope(state.Query.parameters.filter, policy, Principal, Entity)
	                      Refused → 500 FACET_SCOPE_POLICY_VIOLATION (same as Live)
	doReads (FoxHound's implicit Deleted = 0, as the list) ; runBehavior('Reads-PostOperation')
member(Alias, ColumnPred, row):  the PK of row is in listRows(Entity(Alias), { Where: ColumnPred }) (memoized)
eval(FoldPred, env):             env = { alias → row }
	Cmp / column-only And-Or on one alias → member(…)
	And / Or                              → JS logic
	Exists(Rel, On, Where)                → some h in listRows(Rel) with every On pair equal (SQL equality: NULL never equal;
	                                        numbers compared after FacetBuckets.numericValue, strings exactly) and eval(Where, env + { Rel.As: h })
	NotExists                             → !Exists
	CountCmp                              → (number of such h) Op N
base rows: entity pivot → listRows(Pivot, { Client: Variant.ColumnConjuncts }) (M1 readVariantRows);
           TuplePivot → listRows per side, hash-joined on On, distinct by Key
keep rows where eval(Variant.PathPred) and eval(Agg.Where); then fold (§24.9):
	Via      → follow each link (0 matches → NULL key; > 1 → FACET_INTERNAL)
	Multi    → distinct keys over every chain; count distinct pivot PKs per key
	ChildAgg → number of matching child rows → band
	ExistsFlag → eval → 1 / 0
```

On-pair equality is **typed** by the inner column's catalog DataType (numeric: compare the numbers, so `'7'` = 7; text: compare the exact strings, so `'007'` ≠ `'7'`; the registry requires both sides of a pair to be of one class, `CorrelateType`). Relation memo keys and column groups are memoized by object identity (no per-row hashing). Hops rely on FoxHound's implicit `Deleted = 0` (as the lists), while Live adds an explicit one (I1): **a hop's behavior must not name the delete column** (it would switch the implicit one off and the engines would differ); the explicit Live form is the authoritative one.

Independence: the Reference never uses ScopedRelationBuilder, PredicateCompiler, StagedKeys, CubeExecutor, ShellTemplates, Dialects or EngineLive. It shares the Planner's FoldIR, `FilterAST.applyToQuery` (M1 deviation 9), `ScopeCapture.relaxPersonalScope` (§36) and the contract math. Captures: `'ref:' + VariantHash` for the pivot and `'ref:hop:' + Entity + '|' + Scope + '|' + WhereHash` for each hop entity. `Statements` counts list reads. Oracle helpers with the Live signatures of §26.5: `recordKeys`, `keys`, `countBase`.

### 27.3 Router

Unchanged; `ForceEngine` still selects the Reference; `PlanForm` reaches the engines through the context.

---

## 28. Records, Count and Keys (wiring)

### 28.1 Routes (all POST, JSON bodies read by the M1 route-local reader)

| Route | Body | Response |
|---|---|---|
| `/1.0/Facet/:Entity/Records` | Query filter inputs + `Records: { Begin, Cap, Sort }` | bare array of records |
| `/1.0/Facet/:Entity/Records/:Begin/:Cap` | `{ Clauses, Experience }` (pict `FilterEndpointOverride`) and/or any Query filter input | bare array |
| `/1.0/Facet/:Entity/Records/Count` | same | `{ Count }` |
| `/1.0/Facet/:Entity/Keys` | Query filter inputs + `{ Cap }` | `{ Entity, Keys, Count, Truncated, Version }` |
| `/1.0/Facet/:Entity/Scope/:Scope/Records[/:Begin/:Cap \| /Count]`, `/1.0/Facet/:Entity/Scope/:Scope/Query` | same | same; the path scope is prepended to `Scopes` with params from the top-level `Params` |

pict-section-recordset posts (`RecordSet-RecordProvider-MeadowEndpoints.js:525–625`), so no GET forms are mounted. `Experience` is accepted and ignored (`Projection` is a later milestone).

### 28.2 Normalization (wiring owns `contract/Facet-Contract-Request.js` M2 changes)

- `normalizeRequest(pEntity, pBody, { Limits, Time, Mode })` serves four modes (`REQUEST_MODES`): `'Query'` (default; `Facets` required, `Records` optional), `'Records'` (`Facets` optional and **ignored**, the page defaulted), `'Count'` (`Facets` and `Records` ignored), `'Keys'` (`Facets` and `Records` ignored, a top-level `Cap`). Every mode reads the same filter inputs: `Clauses` (a `NamedScope` clause is shape-checked and carried, its `Params` copied; a `FacetSelection` clause is `422 { Feature: 'Selections' }`), `FilterString`, `Scopes`, `Params`. The recordset's `Experience` is accepted and ignored (`Projection` is M3).
- `Scopes: [ { Scope, Params? } ]` — each entry a plain object with a non-empty `Scope` string ≤ 256 characters and an optional plain-object `Params`, else `400 FACET_REQUEST_INVALID { Field: 'Scopes', Index }`; normalized to `[ { Scope, Params: {} … } ]` (`[]` when absent). Existence, entity, enablement and the count (`MaxScopesPerRequest`, `422 FACET_TOO_LARGE`) are the FilterAST's (§23.3).
- `Params` (top level, a scope reference's, a `NamedScope` clause's): a plain object whose names pass `keyProblem` (no control characters, no `Object.prototype` names), copied into a fresh object, else `400 FACET_REQUEST_INVALID { Field, Reason }`; values are the Binder's (§22.3).
- `Records: { Begin, Cap, Sort }` — `Begin` integer `0 ≤ Begin ≤ Limits.MaxRecordsOffset` (default 0), `Cap` integer `1 ≤ Cap ≤ Limits.MaxRecordsPage` (default `min(250, MaxRecordsPage)`: the list's and the recordset's default page), else `400 FACET_REQUEST_INVALID { Field: 'Begin' | 'Cap', Max }`; `Sort` at most `MAX_RECORDS_SORT` (4) entries `{ Field: <identifier>, Dir: 'ASC' | 'DESC' }` (`Dir` case-insensitive, default `'ASC'`), else `400 { Field: 'Sort' }`. A sort field that is not a filterable, non-Sensitive pivot column is `400 FACET_UNKNOWN_FIELD { Field, Entity }` (the service's Filter stage, after the gate). `Records: false` / `null` on a Query body means none.
- Keys `Cap`: integer `1 ≤ Cap ≤ Limits.MaxKeys`, default `MaxKeys`.
- `MaxRecordsPage`, `MaxRecordsOffset`, `MaxKeys` are request limits: the contract's `LIMIT_DEFAULTS` owns them (500 / 10 000 / 50 000) and the service options build `Limits` from it.
- `FOLDS` gains `ChildRollup` and `ExistsSplit` (default `Exclude: 'None'`, no clause type); `LATER_FOLDS` keeps `PathTerms`, `BridgeTerms`, `TuplePivot`, `Computed`, `UnionOfSources`; `Selections`, `FilterExperience` still refused. Every `422 FACET_FOLD_UNSUPPORTED` the contract raises carries `{ Feature, Milestone: 2 }` (`MILESTONE`).
- The NormalizedRequest (§3) gains `Mode`, `Scopes`, `Params`, `Records` (`null` or the page) and `Cap` (`null` unless Keys); `Total` is `false` outside the Query mode.
- The route forms (`Routes.routeBody`): `/Records/:Begin/:Cap` sets `Records.Begin` / `Records.Cap` from the path (keeping the body's `Records.Sort`); a segment that is not a non-negative integer of at most 9 digits is `400 FACET_REQUEST_INVALID { Field, Max }` before the normalizer runs (which checks the range). `/Scope/:Scope/` prepends `{ Scope, Params: <the names that scope declares, from the top-level Params> }` to `Scopes` (`RetoldFacetingService.withPathScope`; an unknown scope gets no params and is refused by the FilterAST).

### 28.3 Plan and execution

Records / Count / Keys: Principal → Shape (mode) → Gate → Bind → Filter (FilterAST with `Bind` and `CanFacet`, the sort-field check) → Params (`Planner.checkRequestParams`: every top-level name must be declared by a scope the request names) → `Planner.planBase` (v0 lowered) → `EngineLive.countBase` / `recordKeys` / `keys` — always Live and Exact (D-38): `pInternalOptions.ForceEngine` is dropped — then, for Records, **hydration** (`RetoldFacetingService.hydrate`):

1. `Host.getExecutionDAL(E).query`, `setCap(0).setBegin(0)`;
2. inside the client fence (`FacetFenceOpen` / `FacetFenceClose`): the Variant's **column conjuncts** and `pk IN (keys)`, rendered by `FilterAST.applyToQuery` (prefix `c`) — so a row that left the column filter between the key statement and the hydration is dropped too;
3. the explicit soft delete (`Deleted = 0`, `FacetSoftDelete`) unless a column conjunct names the delete column (the client's own choice, exactly as the pivot relation);
4. `ScopeCapture.capture(…, 'Inherit', { Columns: [ pk ], Fresh: true })` (the entity's own `Reads-QueryConfiguration` on the route-bound controller + ScopeGuard + the read-side behavior audit of §8.1); an Opaque capture is `500 FACET_SCOPE_POLICY_VIOLATION { Reason: 'OpaqueUntrusted' }`;
5. `DAL.doReads`, then `Reads-PostOperation` on the route-bound controller with **the same request state the QueryConfiguration ran with** (`capture.RequestState`, as the list waterfall shares one state) carrying `Query` and `Records`;
6. records reordered to key order; keys that did not hydrate are dropped and counted.

A Query body with `Records` runs the same `planBase` (reusing the request's v0, §24.11) → `recordKeys` → hydration in the **Records** stage, after the facets executed and before the envelope (so the records are part of the Version).

### 28.4 Responses and headers

Records: bare JSON array; `X-Retold-Facet-Records-Dropped: <n>` when n > 0 (only reachable when the pivot's read-side behaviors are vouched for, §8.1). The Records Version also hashes the hydrated records (`sha256(canonicalJSON(Records))`), so a changed or re-decorated record with the same keys gets a new ETag, never a stale 304. Count: `{ Count }`. Keys: `{ Entity, Keys, Count, Truncated, Version }`. Every route sets the M1 standard headers (`ETag` from the Version of §30.2, `Cache-Control: private, no-cache`, `Vary`, `X-Retold-Facet-Contract`), `X-Retold-Facet-Scope-Repaired: 1` when any capture of the answer was repaired, and answers `304` to a matching `If-None-Match` (the statements have run). A Query body with `Records` adds `Records: [ … ]`, `RecordShape: 'Entity'`, `RecordsDropped: n` to the envelope (`normalizeForComparison` keeps them: both engines' envelopes carry the same Live records).

### 28.5 In-process API (wiring)

```javascript
RetoldFacetingService.records(pEntity, pBody, pRequest, fCallback)   // → (pError, pRecords, pMeta { Dropped, Version, Keys, Statements, ScopeRepaired })
RetoldFacetingService.count(pEntity, pBody, pRequest, fCallback)     // → (pError, { Count }, pMeta { Version, Statements, ScopeRepaired })
RetoldFacetingService.keys(pEntity, pBody, pRequest, fCallback)      // → (pError, { Entity, Keys, Count, Truncated, Version }, pMeta { Version, Statements, ScopeRepaired })
RetoldFacetingService.baseInternal(pMode, pEntity, pBody, pRequest, pInternalOptions, fCallback)   // Now / PlanForm in-process (tests); ForceEngine ignored
RetoldFacetingService.withPathScope(pScope, pBody)                   // the /Scope/:Scope/ body (§28.2)
```

The query `pMeta` (in-process, §18.1) gains `Cubes`, `CubeFallbacks`, `Staged`, `BindHash` and `RecordsDropped`. `Statements` is **every** SQL statement of the request (`pContext.Counters.Statements`: facets, staged key sets, label reads, Records keys and hydration), and `Labels` counts the label reads among them (the LabelResolver groups facets by label target and reads each target once, IN-list chunks of `Limits.MaxInList`).

---

## 29. Envelope and post-processing (A)

### 29.1 FacetResult additions

Present **only** on facets whose Agg `Origin` is not `'Auto'` (M1 envelopes are unchanged):

```javascript
Declared: true | false,                    // false for PathAuto
Definition: { Facet, Version } | null,
Path: [ '>Review.IDBook' ] | null,
Relaxed: false, Semantics: 'NoVisibleMatch' | null,
CountMode: 'Rows' | 'PivotDistinct' | 'KeyDistinct'
```

`MultiValued: true` (K9) → `OtherCount: null`, `SumOfCounts` = Σ displayed counts (may exceed `Total`); `MissingCount` = pivot rows with no key. Fold names: `ChildRollup`, `ExistsSplit` are new `Fold` values; K8/K9 report `Fold: 'Terms'` (or the K8 bucketed fold).

### 29.2 Post-processing of the new kinds

| Kind | Buckets |
|---|---|
| ChildRollup | every band `0…n` (zero-filled), Key = band, Label `'None'` (or `Labels['0']`) for 0, `'a–(b−1)'` integer bands, `'a+'` the open band (01 §4.6), `Start`/`End` = band edges (band 0 has none), `Clause: null`, `Selection` |
| ExistsSplit | Key `1` then `0`, Labels from the definition (`'Yes'` / `'No'`), `Clause: null`, `Selection` |
| K8 / K9 Terms | as M1 Terms (Top, Order, selected-zero keys); labels through `LabelLookup` (M1 §18.6, any target entity) |
| TuplePivot facets | as their bucket kind; `Clause: null` on every bucket (a tuple count is not a count of route-entity rows, so no list clause can round-trip it) |

### 29.3 Bucket clauses

| Facet | Clause |
|---|---|
| K8, one `>` step, Terms | `{ Type: 'InternalJoinMatch', RemoteTable: T, JoinInternalConnectionColumn: c, JoinExternalConnectionColumn: <edge ToColumn>, ExternalFilterByColumns: [ Field ], ExactMatch: true, Values: [ Key ], FilterKey, ClauseKey: 'InternalJoinMatch' }`; when `Field` is the target's key column: `InternalJoinSelectedValueList` with `Values: [ Key ]` |
| K8, one `>` step, DateHistogram / NumericHistogram / Ranges | `InternalJoinDateRange` / `InternalJoinNumericRange` with `ExternalFilterByColumns: [ Field ]`, `Values: { Start?, End? }`, `EndExclusive` as the M1 range clauses |
| K8 over 2+ steps | `null` (Selection only) |
| any K8 / K9 path whose steps carry a `Where`, a `TenantOnly` scope or `CheckParent`, or whose dimension carries a `Where` (`FacetClauses.pathRestricted`) | `null` (Selection only): no join clause carries the restriction, and a clause without it would select more rows than the bucket counted (I4 / O2) |
| K9 over exactly `<J.a >J.b` ending at the target key (`KeyField` = that edge's ToColumn) | `{ Type: 'ExternalJoinSelectedValueList', CoreConnectionColumn: <edge(J.a).ToColumn>, JoinTable: J, JoinTableCoreConnectionColumn: a, JoinTableExternalConnectionColumn: b, ExternalFilterByTable: T, ExternalFilterByTableConnectionColumn: <edge(J.b).ToColumn>, ExternalFilterTableLookupColumn: KeyField, Values: [ Key ], FilterKey, ClauseKey }`; any other K9 path → `null` |
| ChildRollup, ExistsSplit, TuplePivot | `null` |
| auto facets, FK Terms | M1 (FK Terms keep `DistinctSelectedValueList`, §16.4) |

Keys holding `~` keep `Clause: null` (M1 UnsafeKey). Every non-null clause compiles through §23.4 and selects exactly `Bucket.Count` rows (O2).

### 29.4 Selected from owned path conjuncts

`selectedFrom(pAgg, pOwned)` also reads owned join conjuncts: an `Exists` over the facet's own path whose `Where` is `IN` / `EQ` on the facet's field (or, L3, on the target key for an FK facet) gives the selected keys; ranges likewise. ChildRollup / ExistsSplit / TuplePivot facets select nothing in M2.

---

## 30. Describe, Version, Filter.Applied (wiring + A)

### 30.1 Describe

`Entities[E].Scopes` = `registry.scopesFor(E)` filtered to scopes whose `Entities` all pass `canFacet`: `[ { Scope, Description, Params, Relaxed } ]` (`Params` as declared, defaults included). `Entities[E].Facets` adds, after the auto facets, every enabled declared facet and sibling homed on E whose `Entities` all pass `canFacet`: `{ Facet, Declared: true, Title, Description, DisplayName, Folds: [ Fold ], DefaultFold, Selectable, ClauseType, FilterKey, Path?, MultiValued, CountMode, Relaxed, Semantics, Params, Engines: [ 'Live' ], Supported, Unsupported }`. An entity whose read-side behaviors make it Opaque (§8.1) carries `Opaque: { Reason: 'PostOperation', SafeColumns }`. PathAuto facets are listed only with `Catalog.ListOneHop: true`. Disabled definitions never appear.

### 30.2 Version and ModelVersion

`ModelVersion` material gains `registry.definitionsHash()` (A: `Catalog.refreshModelVersion()`, called by `rebuildCatalog` after every definitions load). The Query Version (M1 §18.5) gains `canonicalJSON({ Scopes, Params, Records })` next to `{ Facets, Total }`, the bound conjunct `Pred`s (already part of `Conjuncts[].{ Id, Pred }`), the `Captures` fingerprints of **every** captured entity, and `Plan.BindHash` (so the same request differs across principals of one tenant whenever it binds `$CurrentUser`); the envelope digest includes the Records. Records/Count/Keys Versions hash `ModelVersion | Entity | Mode | { Scopes, Params } | conjuncts | Captures (the hydration capture joins the pivot's) | ScopeValues | BindHash | <the keys (and the page and drop count) or the count>` (`RetoldFacetingService.baseVersion`).

### 30.3 Filter.Applied

`{ Hash }` for clauses (join clauses included), `{ String: true }`, `{ RawFilter }` as M1, and `{ Scope: '<name>' }` for every scope conjunct in conjunct order.

---

## 31. Fixtures: ProjectTrack and LabTrack (D)

### 31.1 Models (complete; generated from 08 §1)

`test/fixtures/ProjectTrack-Model.json` — Customer, User, Client, Project, ProjectMembership, Task, Issue, FormType, Document. `test/fixtures/LabTrack-Model.json` — Customer, User, LabQueue, LabQueueMember, MaterialType, MaterialIntake, LabFormType, MaterialIntakeRequirement, MaterialTypeFormRequirement, LabForm. Same Stricture-extended shape as `Bookstore-Model.json`. Every table has `ID<Table>`, `GUID<Table>` (36), the audit columns (`CreatingIDUser`/`UpdatingIDUser`/`DeletingIDUser` without `Join`) and `Deleted`, **except** `FormType` and `LabFormType` (global lookups: `ID`, `GUID`, `Name`, `Category` / `Discipline`; no audit, no `Deleted`, no `IDCustomer`). `User` = `LoginID`, `NameFirst`, `NameLast`, `IDCustomer → Customer`; `Customer` = `Name`. Every other column, type and `Join` is exactly 08 §1 (`OwnerIDUser`, `AssignedIDUser`, `IDUser` join `User.IDUser`; `IDCustomer` joins `Customer.IDCustomer` and is flagged a tenant edge). Graph facts: no bridges in ProjectTrack; in LabTrack `MaterialIntakeRequirement` is structurally a bridge (synthetic alias `MaterialIntake~LabFormType`) and stays an ordinary pivot; it carries the tenancy column, so its bridge record is `Elidable: false` (01 §5.3: a tenant-scoped join table is a regular entity for scoping; the alias is only a convenience splice); `ProjectMembership`, `LabQueueMember`, `MaterialTypeFormRequirement` carry payload (not bridges). Hubs: `User`, `Customer`. D may add columns only by regenerating both the model and this paragraph.

### 31.2 Policy and behaviors

Each seed module exports `FACETING_OPTIONS` (the harness deep-merges a test's `Faceting` over it):

```javascript
// ProjectTrack-Seed.FACETING_OPTIONS
{
	Scope: { Policy: { Column: 'IDCustomer', SessionField: 'CustomerID', Exclude: [ 'FormType' ], PersonalScopes: {} }, Guard: 'Strict' },
	Catalog: { GlobalEntities: [ 'FormType' ] },
	Definitions: { Path: false, Files: [ DEFINITIONS_PATH ] }
}
// LabTrack-Seed.FACETING_OPTIONS
{
	Scope:
	{
		Policy: { Column: 'IDCustomer', SessionField: 'CustomerID', Exclude: [ 'LabFormType' ], PersonalScopes: { LabForm: { Column: 'OwnerIDUser', SessionField: 'UserID' } } },
		Guard: 'Strict'
	},
	Catalog: { GlobalEntities: [ 'LabFormType' ] },
	Definitions: { Path: false, Files: [ DEFINITIONS_PATH ] }
}
```

The harness installs a test tenancy behavior (chain-wrapped, M1 `installBehavior`) on `Reads-QueryConfiguration` and `Count-QueryConfiguration` of every entity that has `IDCustomer`: `addFilter('IDCustomer', SessionData.CustomerID, '=', 'AND', 'TestTenancy')`, `401` when unset; on `LabForm` additionally `addFilter('OwnerIDUser', SessionData.UserID, '=', 'AND', 'TestOwner')`, `401` when unset. Sessions come from the M1 shim (`{ Tenant, User }` → `CustomerID = IDTenant = Tenant`, `UserID = IDUser = User`).

### 31.3 Seed requirements

Common: deterministic (one mulberry32 stream per table, `Bookstore-Seed.prng`), explicit IDs, canonical `'YYYY-MM-DD HH:mm:ss'` dates; tenant 1 is the base, tenant 2 a smaller domain of its own (≥ 15 % of tenant 1's rows, distinct IDs, its own users / clients / queues); ≥ 1 soft-deleted row per table per tenant on both sides of every anti-join; every date compared with `$Now` (`Task.DueDate`) is `≤ '2025-12-31 23:59:59'`, `≥ '2031-01-01 00:00:00'` or NULL (so any clock in 2026–2030 and the pinned test `Now` `'2026-10-08T12:00:00Z'` give identical answers); cross-tenant references both ways (they must land in Missing / fail existence); NULL FKs; `''` in Terms columns. Small scale: ProjectTrack ≈ 60 projects, 600 tasks, 150 issues, 200 memberships, 800 documents, 30 users, 12 clients per tenant 1; LabTrack ≈ 6 queues, 40 queue members, 8 material types, 300 intakes, 900 requirements, 40 type requirements, 700 lab forms, 30 users in tenant 1; 12 form types and 12 lab form types (global). `Medium` ×4.

ProjectTrack must contain: the `Lead` principal with Owner/Lead memberships on ≥ 6 projects (one inactive, one soft-deleted membership) and ownership (`OwnerIDUser`) of ≥ 3 projects without a membership (and ≥ 1 with both); overdue tasks of Lead (open; `Done`; soft-deleted; future; NULL `DueDate`) spread so the `MyOverdueBand` bands 0, 1–2, 3–9 and 10+ are all non-empty; open Blocker issues on some of Lead's projects, a closed Blocker, an open non-Blocker, a **soft-deleted open Blocker** (must not block) and a tenant-2 open Blocker referencing a tenant-1 project (invisible: must not block); `Project.Status` ∈ `Active, AtRisk, OnHold, Done, ''`; `StartDate` across 2024-01…2027-06 with NULLs; a soft-deleted client referenced by live projects and a tenant-2 client referenced from tenant 1 (an `InternalJoin` to either must fail existence); documents across 2025-01…2026-12 (NULL dates), 12 form types, NULL and dangling `IDFormType`.

LabTrack must contain: `Tech` active in two queues, inactive in one, with a soft-deleted membership in another; `Colleague` active in one of Tech's queues; `Newbie` in none; a soft-deleted queue with live intakes; intakes with `Status` `Received / InProgress / Complete / ''`, `ReceivedDate` across ≥ 20 ISO weeks (NULLs), NULL `IDLabQueue`; a soft-deleted intake with live requirements (they must drop out); per requirement every LabForm case — none, `Pending` by Tech (Started), `Complete` by Tech, `Complete` by Colleague (done only through `TenantOnly`), `Complete` but soft-deleted (still to do), `Complete` in tenant 2 for a tenant-1 intake (invisible: still to do); `MaterialTypeFormRequirement` with `Required` 0 and 1, a **duplicate** `(IDMaterialType, IDLabFormType)` row (TuplePivot distinct-key trap) and a soft-deleted row; lab form types with `Discipline` `''`.

`Traps` (values, not positions): ProjectTrack `{ E1ClientIDs: [ a, b ], E2FormTypeID, DeletedClientID, CrossTenantClientID, DanglingFormTypeID, TestNow: '2026-10-08T12:00:00Z' }`; LabTrack `{ TechQueueIDs, DeletedQueueID, DeletedIntakeID, DuplicateTypeRequirement: { IDMaterialType, IDLabFormType }, ColleagueCompleted: [ { IDMaterialIntake, IDLabFormType } ], TestNow }`.

### 31.4 Principals

`generate()` / `build()` return `Principals: { Name: { Tenant, User, Note } }`: ProjectTrack `Lead`, `Member` (Member/Reviewer roles only), `Outsider` (tenant 1, no memberships, owns nothing), `OtherLead` (tenant 2's Lead); LabTrack `Tech`, `Colleague`, `Newbie`, `OtherTech` (tenant 2).

### 31.5 Definitions and the three motivating queries

`ProjectTrack-Definitions.json` and `LabTrack-Definitions.json` (schema-valid) hold 08 §2.1 and §4.1–§4.3 verbatim plus coverage entries: `Project.ManyOverdue` (K19), `Document.InMyProjects` (K10 two hops), `Project.ByMember` (K9 over `ProjectMembership`), `Project.HasOpenIssues` (K20), `Document.ByClient` (K8 two hops), `MaterialIntake.ByRequiredForm` (K9 through the bridge alias). Both must load with **no** disabled entry. The request bodies every test uses (in-process callers pin `Now: Traps.TestNow`):

```javascript
// E1 — as Principals.Lead
POST /1.0/Facet/Project/Query
{
	Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead' ] } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
	Clauses:
	[
		{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active', 'AtRisk' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' },
		{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: Traps.E1ClientIDs, FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' },
		{ Type: 'DateRange', FilterByColumn: 'StartDate', Values: { Start: '2026-01-01 00:00:00', End: '2027-01-01 00:00:00' }, EndExclusive: true, FilterKey: 'StartDate', Hash: 'StartDate-DR-1' }
	],
	Facets:
	[
		{ Key: 'Status', Facet: 'Project.Status' }, { Key: 'Client', Facet: 'Project.IDClient', Top: 20 },
		{ Key: 'Started', Facet: 'Project.StartDate', Interval: 'month' }, { Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' },
		{ Key: 'StatusByClient', Facet: [ 'Project.Status', 'Project.IDClient' ], Fold: 'Pivot' }
	],
	Total: true,
	Records: { Begin: 0, Cap: 50, Sort: [ { Field: 'StartDate', Dir: 'DESC' } ] }
}
// E2 — as Principals.Lead
POST /1.0/Facet/Document/Query
{
	Clauses:
	[
		{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'FormType', JoinInternalConnectionColumn: 'IDFormType', JoinExternalConnectionColumn: 'IDFormType', Values: [ Traps.E2FormTypeID ], FilterKey: 'IDFormType', Hash: 'IDFormType-IJ-1' },
		{ Type: 'DateRange', FilterByColumn: 'DocumentDate', Values: { Start: '2026-01-01 00:00:00', End: '2026-07-01 00:00:00' }, EndExclusive: true, FilterKey: 'DocumentDate', Hash: 'DocumentDate-DR-1' }
	],
	Facets: [ { Key: 'ByMonth', Facet: 'Document.DocumentDate', Interval: 'month', Chart: true }, { Key: 'ByForm', Facet: 'Document.IDFormType', Top: 20 }, { Key: 'Status', Facet: 'Document.Status', Exclude: 'None' } ],
	Records: { Begin: 0, Cap: 100 }
}
// E3 variant A — as Principals.Tech
POST /1.0/Facet/MaterialIntakeRequirement/Query
{ Facets: [ { Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' },
            { Key: 'Week', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek' }, { Key: 'Discipline', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' },
            { Key: 'Started', Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started' } ] }
// the work list (pict FilterEndpointOverride 'Facet/MaterialIntakeRequirement/Scope/MaterialIntakeRequirement.ToDoForMe/Records'):
POST /1.0/Facet/MaterialIntakeRequirement/Scope/MaterialIntakeRequirement.ToDoForMe/Records/0/50   { Clauses: [] }
POST /1.0/Facet/MaterialIntakeRequirement/Scope/MaterialIntakeRequirement.ToDoForMe/Records/Count  { Clauses: [] }   // == ToDo.Total
// E3 variant B — as Principals.Tech
POST /1.0/Facet/MaterialIntake/Query
{ Facets: [ { Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntake.FormsToDo/ByQueue' }, { Key: 'Week', Facet: 'MaterialIntake.FormsToDo/ByWeek' } ] }
```

Hand-derived expectations (O-hand): `test/Facet-Reference-M2_tests.js` computes each motivating answer with direct SQL over the fixture database, written in the test from the definitions' prose (e.g. E3A ToDo = live tenant-1 requirement rows whose live intake is in a live queue where Tech is an active live member, intake Status in Received/InProgress, with no live tenant-1 `Complete` LabForm of **any** owner for the same intake and form type), independent of both engines. Live, the Reference and that SQL must agree.

### 31.6 Seed module API

```javascript
libSeed.model()                         // deep clone of the domain model
libSeed.generate({ Seed, Scale })       // → { Fixture, Seed, Scale, Model, Rows: { Table: [ row ] }, Order: [ tables, parents first ], Tenants: [ 1, 2 ], TenantColumn: 'IDCustomer', Traps, Principals }
libSeed.build(pDB, { Seed, Scale })     // node:sqlite: createTables + insert → { Fixture, Seed, Scale, Model, Counts, LiveCounts, Tenants, TenantCounts, TenantLiveCounts, Traps, Principals }
libSeed.FACETING_OPTIONS, libSeed.DEFINITIONS_PATH, libSeed.MODEL_PATH, libSeed.TENANT_COLUMN, libSeed.DEFAULT_SEED, libSeed.SCALES
```

---

## 32. Harness (D) and the provider hook (E)

### 32.1 `start()` (M2)

```javascript
libHarness.start(
	{
		Port: 19124,                                            // registry port (§32.4); ephemeral bind as M1
		Fixture: 'Bookstore' | 'Bookstore-Tenant' | 'ProjectTrack' | 'LabTrack',   // Domain: accepted as an alias of Fixture
		Provider: 'SQLite' | 'PostgreSQL',                      // default 'SQLite' (through the hook, §32.2)
		Definitions: 'Auto' | false | [ path | object … ],     // 'Auto': the domain's DEFINITIONS_PATH (none for the bookstore fixtures)
		Faceting: { },                                          // deep-merged over the domain's FACETING_OPTIONS; Definitions.Objects concatenated
		TenancyBehavior: 'Auto' | true | false | function,     // 'Auto': on for Bookstore-Tenant, ProjectTrack, LabTrack (§31.2)
		Seed, Scale, TenancyEntities, LogLevel, FixedPort       // M1
	}, fDone);
```

A PostgreSQL harness whose provider is unavailable calls `fDone` with an error whose `.Skip === true`; PG suites turn it into a skipped suite.

Harness object additions:

| Member | Purpose |
|---|---|
| `provider`, `connection` | the hook's provider name and connection |
| `principals`, `traps` | from the seed |
| `as(pName)` | `{ Tenant, User }` of a named principal (throws on an unknown name) |
| `query(pEntity, pBody, pOptions, cb)` | in-process Live (`queryInternal` without `ForceEngine`), honoring `pOptions.Now` / `PlanForm` |
| `reference(…)` / `compare(…)` | M1, plus `pOptions.Now` / `PlanForm` passed as internal options; `compareInProcess(…)` pins `Now` on both sides |
| `records(pEntity, pBody, pOptions, cb)`, `recordsPage(pEntity, pBegin, pCap, pBody, pOptions, cb)`, `recordsCount(…)`, `keys(…)`, `scopeRecords(pEntity, pScope, pBegin, pCap, pBody, pOptions, cb)`, `scopeRecordsCount(…)` | the §28 routes over HTTP |
| `assertSelectionRoundTrip(…, { CountVia: 'Auto' \| 'List' \| 'Reference' })` | M1 O2; `'Auto'` counts through the stock list when no conjunct is Path-shaped, there are no `Scopes` and the envelope has no **declared** facet (`FacetResult.Declared === true`: its counts are under the definition `Where`), else through the Reference: the body without the facet's excluded clauses, plus `Bucket.Clause`, one probe facet (the facet itself with `Exclude: 'None'`; its `Total` is the count), `Total: true` (an excluded FilterString term or an un-removable conjunct is `Skipped`) |
| `assertTenantIsolation(pEntity, pBody, pPrincipalNames, cb)` | per principal: Live == Reference, and every FK bucket key and every Records/Keys key belongs to that principal's tenant (from `seed.Rows`) |
| exports `DOMAINS`, `domainSeed(pFixture)`, `domainOptions(pFixture)` | fixture → seed module / its `FACETING_OPTIONS` |

`expectedExclusion` learns join clauses (FilterKey rule, as column clauses) and treats `NamedScope` clauses and request `Scopes` as never excluded.

### 32.2 Provider hook (`test/support/Facet-Harness-Providers.js`)

```javascript
PROVIDERS                                                         // [ 'SQLite', 'PostgreSQL' ]
available(pProvider)                    → { Available, Reason }  // PostgreSQL: only with RFS_TEST_POSTGRES=1 or RFS_TEST_POSTGRES_URL
fableSettings(pProvider, pHarnessOptions) → settings for new libFable(…)   // SQLite: { SQLite: { SQLiteFilePath: ':memory:' } }; PG: { PostgreSQL: { host, port, user, password, database, max: 4 } }
connect(pProvider, pFable, pHarnessOptions, fCallback)            // → (pError, pConnection { Provider, StorageProvider, db, pool, Database, Coerced, Schema: 'Harness' | 'Meadow' })   // pHarnessOptions.PostgresSchema 'Meadow': the production DDL (§33.3)
seed(pConnection, pSeedModule, pSeedOptions, fCallback)           // → (pError, pSeedResult): SQLite = pSeedModule.build(db); PG = createTables from the model + insert generate().Rows
release(pConnection, fCallback)                                   // SQLite: close; PG: end the pool, DROP DATABASE
```

The harness owns domains, principals, behaviors and oracles; the hook owns providers. SQLite is implemented (what the M1 harness did inline); E implements PostgreSQL. The harness passes `pConnection.StorageProvider` to RDS (`StorageProvider`, `loadModel(…, StorageProvider)`).

### 32.3 O2 through the Reference

When `CountVia` resolves to `'Reference'`, the count of a modified body is the Reference envelope `Total` for that body as the same principal (with the same pinned `Now`). This keeps O2 independent of Live; the stock list remains the oracle whenever it can express the filter.

### 32.4 Port registry additions

| Port | File |
|---|---|
| 19120 | `test/Facet-Definitions_tests.js` (A; only if it boots a server) |
| 19121 | `test/Facet-Plan-M2_tests.js` (B) |
| 19122 | `test/Facet-Live-M2_tests.js` (C) |
| 19123 | `test/Facet-PlanForms_tests.js` (C) |
| 19124 | `test/Facet-Reference-M2_tests.js` (D) |
| 19125 | `test/Facet-Conformance-PostgreSQL_tests.js` (E) |
| 19126 | `test/Facet-Motivating-Queries_tests.js` (wiring) |
| 19127 | `test/Facet-Records-Keys_tests.js` (wiring) |
| 19128 | `test/Facet-Security-M2_tests.js` (C + wiring: per-hop isolation, TenantOnly, Opaque/Staged, 403 gates) |
| 19129 | `test/Facet-Review-M2_tests.js` (the M2 review regressions, SQLite and PostgreSQL) |
| 19191 | `debug/m2-smoke.js` (pinned; ProjectTrack on 19191, LabTrack on an ephemeral port) |

---

## 33. PostgreSQL (E)

### 33.1 The container (`test/support/Facet-Docker-Postgres.js`)

| | |
|---|---|
| name | `rfs-test-postgres` — the **only** container this module creates, starts, stops or removes |
| image | `postgres:16-alpine` |
| port | `127.0.0.1:15433 → 5432` |
| password | `RFS_TEST_POSTGRES_PASSWORD`, else the throwaway `'rfs-throwaway-test-only'` |
| `ensure(pOptions, cb)` | `docker ps -a --filter name=^/rfs-test-postgres$`: absent → `docker run -d --name rfs-test-postgres -e POSTGRES_PASSWORD=… -p 127.0.0.1:15433:5432 postgres:16-alpine` (a name conflict from a concurrent run reuses that container); stopped → `docker start rfs-test-postgres`; then poll `docker exec rfs-test-postgres pg_isready -U postgres` (≤ 60 s); a wrong password (`28P01`) stops polling at once with a hint; the leftover `rfs_*` sweep never runs against `RFS_TEST_POSTGRES_URL` (a shared server: local pid liveness proves nothing) |
| guard | `assertOwnContainer`: `exec` only with the container as the FIRST argument after the verb; `inspect` is not allowed |
| `stop(cb)` | `docker stop rfs-test-postgres` then `docker rm rfs-test-postgres` |
| CLI | `node test/support/Facet-Docker-Postgres.js ensure \| stop` |

Never another container, image, volume or network (in particular never `sluice-dev-postgres` on 5433); never `docker system prune`, never `rm -f` of anything but this name. Test runs reuse a running container and leave it running; `npm run test:pg:down` removes it.

### 33.2 Gating

`RFS_TEST_POSTGRES=1` → the container; `RFS_TEST_POSTGRES_URL=postgres://user:password@host:port/database` → that server (the hook still creates and drops only its own `rfs_*` databases and never touches another database). Neither → every PG suite is skipped, so plain `npm test` stays SQLite-only and fast. The PG hook refuses to run unless the process time zone is UTC (`new Date(2020, 0, 1).getTimezoneOffset() === 0`; node-postgres parses `timestamp` in local time) with a clear error.

### 33.3 Schema and data

Both providers create, after the rows are in, an index on every `Join` / `ForeignKey` column (each graph edge's On / Correlate column), every GUID column and the tenancy / owner columns (`IDCustomer`, `IDTenant`, `OwnerIDUser`), then `ANALYZE` (so the planner probes a correlated hop through its correlation index, not the tenancy index); `Bookstore-Seed.indexColumns` / `createIndexes` own the rule. **Production mode** (`start({ …, Provider: 'PostgreSQL', PostgresSchema: 'Meadow' })`): the tables come from `meadow-connection-postgresql`'s `generateCreateTableStatement` (BOOLEAN NOT NULL DEFAULT false, INTEGER / VARCHAR NOT NULL defaults), NULLs are inserted as the column DEFAULT (the seed's `Rows` are updated so the JS oracles see what the database holds), and the database uses an ICU `en-US` collation; `Facet-Review-M2` runs E1 / E3A / E3B, Boolean Terms and a Records string sort (== the list's order, ≠ byte order) on it.

One fresh database per harness, `rfs_<pid>_<counter>`, `CREATE DATABASE … TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'` (byte collation: the same order as SQLite BINARY and `compareKeys` for the ASCII fixtures), dropped by `release()`; `ensure()` also drops leftover `rfs_*` databases that have no connections. Tables come from the model with **nullable** columns and no defaults (seeded NULLs stay NULL): `ID → SERIAL PRIMARY KEY` (explicit IDs inserted, then `setval`), `GUID → VARCHAR(n)`, `Numeric` / FK / audit user `→ INTEGER`, `Decimal → DECIMAL(p,s)`, `String → VARCHAR(n)`, `Text` / `JSON → TEXT`, `DateTime → TIMESTAMP`, `Boolean` (incl. `Deleted`) `→ SMALLINT` (meadow's PostgreSQL convention). Rows are `seed.generate().Rows` inserted in `Order` in batches. A value a typed column cannot hold (the bookstore's `''` / `' '` in `BookStoreInventory.BookCount`) is inserted as NULL and listed in `pConnection.Coerced` (G1 is SQLite-only); `DECIMAL(10,2)` rounds the 499.996 trap to 500.00. RDS runs with `StorageProvider: 'PostgreSQL'` and the umbrella `meadow-connection-postgresql` (`MeadowPostgreSQLProvider`).

### 33.4 Execution and parity

PG Live == PG Reference for every M1 conformance fixture first (the requests of `Facet-Conformance-SQLite_tests.js`), then every M2 fixture of §34 on the two domains. Explicit checks: the corrected `numericIndex` on `numeric` (values exactly on an edge, decimal edges such as 8.4 / 0.2, the clause count of every bucket through the list), DateHistogram on every interval (ISO week across year ends, quarter and year starts, the boundary traps) equal to `FacetBuckets.dateKey`, exact Stats sums on `DECIMAL`, Terms over SMALLINT booleans, bigint counts arriving as strings, `IS NULL` predicates, Terms tie-break order under `C` collation, and the M2 shells (EXISTS chains, Staged `= ANY(CAST(:k AS bigint[]))` and `unnest`, the cube). Fixes go to the existing entries of `Shell-Templates-PostgreSQL.js` and to the PostgreSQL branch of `Retold-Faceting-Dialects.js`; MySQL / MSSQL are untouched.

### 33.5 Scripts (`package.json`)

```json
"test:pg": "RFS_TEST_POSTGRES=1 TZ=UTC npx mocha --timeout 20000",
"test:pg:up": "node test/support/Facet-Docker-Postgres.js ensure",
"test:pg:down": "node test/support/Facet-Docker-Postgres.js stop"
```

`test:pg` runs the **whole** spec set with the gate on (the SQLite halves are fast), so a new PG-gated suite can never be left out. The provider hook ensures the container itself (the first harness of a process runs `ensure()`), so `test:pg:up` is optional. `npm test` is unchanged (every PG suite skips without the gate). Suites gate **only** on provider availability; any other unmet precondition is a hard failure in `suiteSetup`, never a pending test.

---

## 34. Oracles and conformance obligations (M2)

| Oracle | M2 obligation |
|---|---|
| **O1** | Live == Reference (normalized envelopes) for every fixture request of §31.5 and §34 rows below, as every principal of the domain, on SQLite (and on PG under the gate) |
| **O2** | every bucket with a Clause round-trips (`CountVia: 'Auto'`); envelope `Total` == list Count (or Reference Total when Path-shaped / scoped); E3A `ToDo.Total` == `/Scope/…ToDoForMe/Records/Count` |
| **O-hand** | the four motivating answers equal hand-written SQL over the fixture database (§31.5) |
| **O5** | `PlanForm` `{ Cube: 'Never', Staged: 'Never' }` == `{ Cube: 'Always' }` == `{ Staged: 'Always' }` for every cross-entity fixture (RawFacetResults and envelopes); a > 1 000-key Staged set; cube fallback == per-Variant |
| **O6 (M2)** | two-tenant isolation on every hop (tenant-2 rows never count, cross-tenant references land in Missing / non-existence); a hop's tenancy behavior removed → Strict 500; LabForm owner scope (`Inherit` hop sees only the principal's forms, `TenantOnly` sees the tenant's, never another tenant's); relaxation refused when the owner column appears elsewhere; untrusted Opaque hop → 500; 403 for unreadable scope / join / hop entities before field validation; `$CurrentUser` unset → 401; client `'$Now'` is a literal |
| **O9** | goldens for every new statement form per dialect (§26.4) |

Per test file:

- `test/Facet-Definitions_tests.js` (A): every §20.3 reason has a failing fixture (disabled, logged, dependents disabled, nothing partial); both domain files load with zero disabled entries; ajv cross-check; CheckParent forcing on / off; canonical E1 / E3A / E3B forms against hand-written expectations; hashes stable and ModelVersion moving with a definitions change; `resolvePath` for every direction, co-reference (ambiguous, `{ Via, To }`), aliases (declared, bridge, cycle), `MaxHops`; PathAuto synthesis; §29 post-processing as pure functions (band labels, ExistsSplit, MultiValued arithmetic, the clause table, selected keys from join conjuncts).
- `test/Facet-Plan-M2_tests.js` (B): every token and its failure; params (each type and error reason); `$Now` flooring and pinning; BindHash; NamedScope (clause and request) and every join clause type incl. `UndeclaredJoin`, gate-before-validation, OR with a join clause; M1 bodies keep their conjunct Ids; every row of §24.8 (golden FoldIR for E1, E3A, E3B); Variants with W_def; the E1 CubePlan (flags `b1`–`b3`, RequireFlags per facet, Total requiring all); DepSet across hops; plan-wide unique aliases.
- `test/Facet-Live-M2_tests.js` (C): every K kind on the domains against direct SQL and the Reference; TenantOnly; per-hop scope; Staged and Opaque; PG dry-builds and O9 goldens.
- `test/Facet-PlanForms_tests.js` (C): O5.
- `test/Facet-Reference-M2_tests.js` (D): O-hand, O1 and O2 on both domains for every principal, two-tenant isolation, owner scope, cross-tenant references.
- `test/Facet-Conformance-PostgreSQL_tests.js` (E): §33.4.
- `test/Facet-Motivating-Queries_tests.js`, `test/Facet-Records-Keys_tests.js` (wiring): E1, E2, E3A, E3B over HTTP as the principals (envelopes, Records pages and order, hydration, dropped header, `Count`, `Keys`, scope routes, pict `FilterEndpointOverride` shapes, limits, Versions differing across principals of one tenant through BindHash).

---

## 35. File ownership and the shared-file protocol

| Owner | Files (M2) |
|---|---|
| **A** | `source/catalog/Retold-Faceting-DefinitionRegistry.js`, `source/catalog/Facet-Definition-Schema.json`, `source/catalog/Retold-Faceting-Graph.js` (`resolvePath`, `coReferenceSource`, `pathSignature`), `source/catalog/Retold-Faceting-Catalog.js` (`refreshModelVersion`, PathAuto descriptor support, Describe pieces of §30.1), `source/contract/Facet-Contract-Envelope.js`, `-Buckets.js`, `-Clauses.js` (§29), `test/Facet-Definitions_tests.js` |
| **B** | `source/plan/*` (Planner, FoldIR, Binder, optional `Retold-Faceting-Lowering.js`), `source/request/Retold-Faceting-ClauseCompiler.js`, `source/request/Retold-Faceting-FilterAST.js`, `source/request/Retold-Faceting-DisjunctivePlanner.js`, `test/Facet-Plan-M2_tests.js` |
| **C** | `source/engine/live/*` (ScopedRelationBuilder, PredicateCompiler, StagedKeys, CubeExecutor, ShellTemplates, Dialects, the M2 entries of every `Shell-Templates-<Dialect>.js`), `source/engine/Retold-Faceting-EngineLive.js`, `source/engine/Retold-Faceting-EngineBase.js`, `source/security/Retold-Faceting-ScopeCapture.js`, `source/security/Retold-Faceting-ScopeGuard.js`, `test/Facet-Live-M2_tests.js`, `test/Facet-PlanForms_tests.js`, `test/Facet-Security-M2_tests.js` (with wiring), `test/goldens/*` |
| **D** | `test/fixtures/ProjectTrack-*`, `test/fixtures/LabTrack-*`, `source/engine/Retold-Faceting-EngineReference.js`, `test/support/Facet-Test-Harness.js`, `test/Facet-Reference-M2_tests.js` |
| **E** | `test/support/Facet-Harness-Providers.js`, `test/support/Facet-Docker-Postgres.js`, `test/fixtures/Bookstore-Seed.js` (provider helpers only), the existing M1 entries of `source/engine/live/Shell-Templates-PostgreSQL.js`, the PostgreSQL branch of `source/engine/live/Retold-Faceting-Dialects.js`, `package.json` scripts `test:pg*`, `test/Facet-Conformance-PostgreSQL_tests.js` |
| **wiring** | `source/Retold-Faceting-Service.js`, `-Installers.js`, `-Service-Options.js`, `-Util.js`, `source/routes/*`, `source/engine/Retold-Faceting-Router.js`, `source/security/Retold-Faceting-Authorizer.js`, `-PrincipalResolver.js`, `source/contract/Facet-Contract-Request.js`, `source/request/Retold-Faceting-RequestNormalizer.js`, `source/catalog/Retold-Faceting-LabelResolver.js`, `README.md`, `docs/internal-contracts.md` after the builders, `test/Facet-Motivating-Queries_tests.js`, `test/Facet-Records-Keys_tests.js`, `debug/m2-smoke.js`, and the M1 tests whose expectations the normalizer change alters |
| **shared** | `test/Facet-Smoke_tests.js` (anyone ADDS assertions), `source/contract/Facet-Contract-Errors.js` (add codes only), `source/contract/Facet-Contract-Util.js` (add helpers only) |

Protocol:

1. Edit only your files. A contract change is made **here first**, in the same change, with a line in §36.
2. Shared files and files two owners touch (the PostgreSQL shell file: C adds a `// M2` block, E fixes existing entries; `Retold-Faceting-Dialects.js`: C generally, E the PostgreSQL branch): string-replacement `Edit` only, re-read first, never a whole-file `Write`, add rather than remove.
3. When your contracted change breaks an M1 assertion in someone else's test file, fix that assertion in the same change (never weaken an oracle) and say so in your report.
4. `npm test` green after every change; PostgreSQL suites are gated.
5. M1 rules stand: umbrella `node_modules` only (no `npm install`), Node 22 `fetch`, ephemeral ports (except smoke scripts), Retold style (tabs, Allman, `pVariable` / `tmpVariable` / `libX`, services extend `fable-serviceproviderbase` with `serviceType`), restify handlers never return promises and call `fNext` once, Mocha TDD, never `git add` / `commit` / `push`, never modify files outside this module, docker only for `rfs-test-postgres`.

---

## 36. Ambiguities resolved / M2 deviations from the design

1. **Records routes are POST** (pict-section-recordset posts to `…/:Offset/:PageSize` and `…/Count`); "the recordset FilterEndpointOverride GET shape" in the brief is read as the URL shape. No GET forms in M2.
2. **`Domain`** in the brief is the harness `Fixture` option; both names are accepted.
3. **Selections / `FacetSelection` stay refused** (`422 { Milestone: 2 }`); Selection-only buckets (ChildRollup, ExistsSplit, multi-hop K8, K9 off the bridge form, TuplePivot) are checked by O1 and O-hand, not O2.
4. **TuplePivot buckets have no Clause** and TuplePivot Records (synthetic tuples) are M3; `Records` in a TuplePivot definition is ignored with a warning.
5. **No L4 elision** (an elided existence check differs on dangling FKs, and the list-based Reference cannot elide); `Elide: true` is a load warning; L3 only adds an implied predicate.
6. **`$Now` binds floored to `Cache.NowBucketMS`** (the bound value equals the hashed one); seeds keep `$Now`-compared dates far from any plausible clock; tests pin `Now` in-process.
7. **Unset `$CurrentUser` / `$Scope` values are 401**, never "matches nothing".
8. **`Not` and `Any` are desugared, scope references inlined, at load**; there is no `Scope` or `Not` node at run time.
9. **`NamedScope` clauses are taken out of the pict sequence** (always ANDed; `Junction: 'OR'` / `GUIDGroup` refused), so a scope can never be OR-combined with client intent (I3).
10. **Gate granularity:** entities read by the request filter fail the whole request (403) before their fields are validated; entities read by one facet fail that facet (403).
11. **Definition predicates may not name policy columns** (`'PolicyField'`): scope is the policy's job, and it keeps the `TenantOnly` relaxation exact.
12. **TuplePivot Home side is SQL alias `'p'`**; definition aliases are logical names only.
13. **Plan-wide unique aliases** with disjoint prefixes; relation memo keys exclude the alias.
14. **Cube scope:** formed for ≥ 2 eligible members under `'Auto'`; over `CubeMaxGroups` or with a `Transformed` capture it falls back to per-Variant statements (never an error); the 01 §8.4 step 5 GROUPING SETS / UNION ALL fallback is M3.
15. **Staged scope:** leaf existence hops with integer keys only, one scalar per key column, no chunking; a trusted Opaque query must still show the policy binds.
16. **The Reference shares** the Planner's FoldIR, `FilterAST.applyToQuery` and `relaxPersonalScope` with Live; it evaluates column predicates by list membership, never by JS comparison.
17. **Ignored definition keys** (`Catalog` section, `Engines`, `Freshness`, `Limits`, `Visibility`, `Missing`, `ClauseType`, `Selectable`, `Records`) load with warnings.
18. **K12** is `count` over one `<` step; **K19** is one `<` / `=` step; a **K9** `Where` applies to the last step's entity.
19. **ExistsSplit keys are `1` / `0`** (numbers, like Boolean Terms keys), labels from the definition (default `'Yes'` / `'No'`).
20. **New FacetResult fields appear only on non-auto facets**, so M1 envelopes are byte-identical.
21. **PostgreSQL test DDL** is the model with nullable columns, SMALLINT booleans and C collation, not `meadow-connection-postgresql`'s `createTables` (its NOT NULL defaults would rewrite seeded NULLs, and its BOOLEAN differs from meadow's SMALLINT convention). The production DDL (BOOLEAN, NOT NULL defaults) under an ICU collation is covered separately (§33.3 production mode).
22. **PostgreSQL tests require `TZ=UTC`.**
23. **Ad-hoc `Definition` stays 403** whatever `Definitions.AllowAdHoc` says.
24. **FK Terms keep `DistinctSelectedValueList`** (M1 §16.4); one-hop K8 buckets use the `InternalJoin*` clauses.
25. **The schema is enforced by a built-in validator** (no runtime dependency); ajv is a test-only cross-check.
26. **`Definitions.Objects`** (in-memory definitions) is added for tests and code-built hosts.
27. **Default `FilterKey` of a path facet is its FacetID.**
28. **MultiValued facets report `OtherCount: null`.**
29. **Definitions are validated per entry**; a bad file envelope disables the whole source.
30. **The `/Scope/:Scope/` route takes that scope's params from the top-level `Params`.**
31. **Records sort NULLs last in both directions** with the PK as the final tie-break, on every dialect.

As built (the builders' and the wiring agent's additions; all additive unless noted):

32. **Definitions (A).** The extra disabled reasons, the `TimeZone` unsupported feature, the extra CanonicalFacet fields and the FilterKey / Exclude / CountMode / Labels / Entities conventions are in §20.4 and §20.7. An entity on a path that is not in the catalog is a **load** error (`UnknownEntity`), not a request-time 403 (label paths are exempt); so a `NeverFacet` entity disables the definitions that read it, and the request-time 403 of §19.6 covers per-principal refusals (`Host.isFacetable`, the host authorizer). `definitionsHash()` hashes file basenames. `buildEnvelope` passes `Records`, `RecordShape`, `RecordsDropped` through; MultiValued facets report `OtherCount: null`; M2 FacetResult fields appear on non-auto facets only.
33. **Variants and lowering (B).** `Variant.Hash` stays the M1 value (`c1,c3`) without a definition Where and becomes `c1,c3|wh:…` with one (M1 hashes and Reference fingerprints unchanged); Variants also carry `PathConjuncts`. Optional extra arguments: `Binder.bind(…, { Entity, Sides, Owner, OwnerKind })`, `ClauseCompiler.compile(…, { Bind, CanFacet })`, `FilterAST.newConjunct(…, pExtra)`. Helpers: FilterAST `scopeConjunct`, `isPathConjunct`, `hasExistence`, `entitiesOf`; ClauseCompiler `pathPlan`, `M2_CLAUSE_TYPES`; FoldIR `columnsOf`, `pivotColumns`. `Plan.Lowered` maps each Path conjunct Id to its FoldPred; CubePlan flags carry `Shape` and `Pred`, the CubePlan `CommonColumn`, `CommonPath`, `CommonPathPred`, `ConjunctPreds`. Identical K8 hop chains are shared between Aggs (one Rel, the union projection; joined once per alias); a definition Where is lowered once per WhereHash; `Multi.Where` may name any alias of its chain. A PathAuto facet may be a request pivot axis, a declared one may not (`422 DeclaredPivotAxis`). Top-level Params declared by a request scope are accepted (§22.3, the `/Scope/` form). `PolyJoinRemoteType` filters the join-table step. `planBase` reuses the request's v0. `Planner.checkRequestParams(pContext, pResolved)` is the public form of the Params check (the Records / Count / Keys pipeline). The L3 pushdown of §24.8 is not implemented (L3 only owns the join conjunct through the connection column).
34. **Live (C).** Live widens each Rel's projection to every column its trees read on that alias. `recordKeys` / `keys` also return `Captures`; `countBase` calls back a third `pMeta { Captures }`. Captures gain `ScopeMode`, `Relaxed`, `Removed`, `RelaxRefused`, `Trusted`, `Replaced`; guard results gain `Relaxed` / `Deferred` only when they apply. Live refusals report `Milestone: 2`. The shell registry adds `M2_TEMPLATES` and `dimensionExpression()`. `PlanForm.ChildAgg` (`'Correlated'` default, or `'Restricted'`) is a test-only switch `newContext` does not pass. Error attribution follows §19.7: an error on the pivot or a Variant path-predicate hop fails the request (except `TOO_LARGE`, `FOLD_UNSUPPORTED`, `TIMEOUT`, which stay per facet as in M1); an error on a facet's own hops fails that facet (except 401). MSSQL staged binds use `NVarChar`. Upstream: FoxHound's SQLite dialect mangles qualified filter columns, so PredicateFragments stay unqualified and a column predicate outside its only FROM item goes through a 0/1 flag column. `source/engine/live/Retold-Faceting-StatementComposer.js` and the test support files `Facet-Live-M2-Kit.js` / `Facet-Live-M2-FoldIR.js` exist beyond §35.
35. **Reference and harness (D).** O2 through the Reference counts a probe facet (`Exclude: 'None'`, its `Total`) rather than `Facets: []` (the normalizer refuses an empty list, and a W_def facet must be counted under its Where). `assertTenantIsolation(pEntity, pBody, pNames[, { Keys: false }], cb)` also checks the first Records page. Extra harness members: `facetingOptions`, `visibleRows`, `M2_BUCKETED_FOLDS`, `needsReferenceCount(pBody[, pEnvelope])`, `internalOptions`, `policyBehavior`; `build()` also returns `Rows`, `Order`, `TenantColumn`. Reference semantics: a NULL K9 `KeyField` is no key; ExistsSplit returns non-empty groups only, key 1 first; the definition Where comes from `Agg.Where`, else `Variant.Where`; a facet relation failure is per facet except 401; a Variant `PathPred` failure fails the request. Each tenant has exactly one (live) Customer row.
36. **PostgreSQL (E).** Both conformance suites build the Bookstore fixture list from `test/fixtures/Bookstore-Conformance-Fixtures.js` (`build(Expect, countsOf, libHarness) → { Fixtures, RatingRanges }`); the PG suite applies its deltas to it. Every gated suite fails at teardown when a statement reuses an array bind or binds an empty array (meadow's PG provider binds only the first element of a reused array, and `IN ( )` is a syntax error) — no M2 statement does. On a production PG database without C collation the Terms row cap breaks ties in that collation (adding `COLLATE "C"` would change the PG goldens): M3.
37. **Fractional range bounds on INTEGER columns** bind their integer equivalent (`GE` / `LT` → `ceil`, `GT` / `LE` → `floor`; `ClauseCompiler._rangeBound`): the same integer rows, and PostgreSQL never sees `'0.5'` bound to an integer parameter (22P02). Bucket Clauses keep their exact bounds; the compiler normalizes them, so they count identically on the list, the Reference and Live.
38. **ChildRollup / ExistsSplit Labels** travel on the lowered FoldIR dimension (`Dim.Labels`, §24.3); without it the definition's labels were lost (`'Yes'` / `'No'`, `'None'`).
39. **The cube is on by default** (`Execution.Cube: 'Auto'`), M1 bodies included: two or more cube-eligible facets of one pivot (the Total counts) are one grouped statement. The M1 tests that counted statements or Terms rows now pin `PlanForm: { Cube: 'Never' }` or lower `CubeMaxGroups` (the cube statement returns at most `CubeMaxGroups + 1` grain rows, then falls back to the capped per-Variant Terms statements), and assert the cube form separately (O5).
40. **Hydration includes the Variant's column conjuncts** next to `pk IN (keys)` (§28.3), so a row that stopped matching between the two statements is dropped, not returned; the explicit soft delete follows the client exactly as the pivot relation does.
41. **A TuplePivot's Home side and a client clause naming the delete column:** the Home side honours the client's choice like an entity pivot (no explicit soft delete when a client conjunct names the column); Live and the Reference agree (`Facet-Motivating-Queries` E3B), which settles builder B's open question.
42. **Scopes entries are shape-checked by the normalizer** (`400 FACET_REQUEST_INVALID { Field: 'Scopes', Index }` for a non-object or a missing `Scope`), and `FACET_UNKNOWN_SCOPE` stays the FilterAST's answer for a well-formed unknown, disabled or wrong-entity name — so the two are distinguishable only by shape, never by existence.
43. **`newContext(pEntity, pRequest, pInternalOptions, pMode)`**: the mode is a fourth argument set by the entry point, never an internal option.

M2 review (`.build-notes/m2-report.md` lists every finding):

44. **Read-side behaviors are audited** (06 §3.5, §8.1): Opaque `'PostOperation'` unless `TrustPostOperation` / `PostOperationSafeColumns`; the Reference stays the list's truth (it runs the PostOperation), so for such an entity Live refuses where the Reference answers — the refusal is the contract.
45. **TenantOnly fails closed** twice: at load (`TenantOnlyNeedsTenant`, `TenantOnlyParam`) and in the guard (`TenantOnlyUnscoped`, the depth-0 OR check always on).
46. **Trusted replaced queries are asserted on their filter and their exact rendered binds** (§26.3), never "the column appears and some bind has the value".
47. **Gates come before graph lookups and before Supported** (§23.4, §20.8): hidden and missing entity names, hidden PathAuto targets and nonexistent paths, unsupported scopes over hidden entities are indistinguishable.
48. **Fragments render post-behavior operators** through per-entity probes (§26.4); the cube falls back when a flag leaf is transformed.
49. **Restricted path facets have no bucket Clause** (§29.3).
50. **TuplePivot sides lower Home first in connectivity order**; every side must be reachable through Join-related On pairs (§20.6, §24.4).
51. **ChildRollup Edges start at 1**; **numeric folds refuse Boolean columns** at load.
52. **`$Now` is the StorageTimeZone wall clock**; **BindHash keeps every value of a repeated key**; **Integer params and integer filter values are range-checked**.
53. **Stats and Missing are cube measures**; `Keys` counts only when truncated; `Statements` counts every statement (labels and Records included); the LabelResolver reads each label target once.
54. **Test databases are indexed and analyzed** like a production schema, a production-DDL / ICU PostgreSQL mode exists, and readiness gates are gone (§33).

---

## 37. Seams for M3

| Seam | M2 behavior |
|---|---|
| GROUPING SETS / UNION ALL cube fallback, grain estimates | per-Variant fallback |
| `Selections`, `FacetSelection`, Records of a Selection-only bucket | `422 { Milestone: 2 }` / Clause `null` |
| TuplePivot Records (`RecordShape: 'Tuple'`), TuplePivot Pivot | ignored / refused at load |
| K13 Quantified, K15 Computed (Expressions), K16 UnionOfSources, non-count Measures, ChildRollup sum/min/max, multi-step HavingCount / ChildRollup | `Supported: false` → 422 |
| L4 elision from the capture | never; when it comes, it may only consider bridges with `Elidable: true` (a tenant-scoped join table is never elided: eliding it would skip its tenant predicate) |
| TuplePivot siblings in one grouped statement (or the distinct tuple set staged once per request) | one statement per TuplePivot facet (E3B: three) |
| NumericHistogram `Nice` bounds taken from a Stats measure of the same column and Variant | a separate bounds statement |
| `COUNT(*) OVER ()` in the truncated Keys statement (one snapshot) | a second count statement when truncated |
| Controller-less hops (`Catalog.Controllerless`) | refused (FACET_INTERNAL from the capture, as M1) |
| MySQL / MSSQL execution and collation (G2, C10) | dry-built only |
| Staged chunking (MySQL 5.7, MSSQL < 2016), non-integer staged keys | refused |
| Result cache keyed by BindHash + generations (P3) | Version hashes the representation (M1 §10.5) |
| Explain, the GET Query form, `Experience.Projection` on Records | not mounted / ignored |
| Keyset paging (`AfterKey`) past `MaxRecordsOffset` / `MaxKeys` | 400 / `Truncated: true` |
| `/Scope/:Scope/Keys` | use `/Keys` with `Scopes` |
| `COLLATE "C"` on PostgreSQL string keys (Terms tie order on non-C databases) | the test databases are C-collated |
| CostModel, row prechecks (`LIMITS_NOT_ENFORCED`) | not enforced |


---

# Part III — Milestone 4: change capture, generations, result cache, freshness, SSE

> **Binding for M4.** Part III wins over Parts I and II wherever they conflict; §38.2 lists every earlier rule it changes. Where Part III and the design set disagree, Part III wins for M4 and §51 lists each deliberate deviation. The M4 builders are **A** (generations, cache key, result cache), **B** (change intake, `notify` / `notifyByFilter`, the Seq clock), **C** (SSE, read-your-writes), **D** (the demo client and demo host) and the **wiring** agent (service pipeline, routes, envelope, Version, end-to-end O7 tests); §50 is the ownership table. Design references: `05` (core), `04 §8.2–§8.3`, `02 §3.3 / §4.2 / §8 / §10 / §13`, `06 §7 / §11`, `09 §3.1 / §4.7 / §4.8 / §4.10 / §4.20 / §4.29`.

---

## 38. Overview, precedence, services, options, context

### 38.1 What M4 adds

| Area | Addition | Owner |
|---|---|---|
| Change intake | `RetoldFacetingChangeIntake`: one normalization + Seq + synchronous delivery point (`ingest`) for every change source; the **interim** source wraps each facetable entity's route-bound controller's behavior **dispatcher** (`BehaviorInjection.runBehavior`) and its DAL write methods (§40, as revised by the review §51.46); a **Bus** adapter seam for the upstream `MeadowChangeBus` (no-op until it exists); `notify` / `notifyByFilter` for raw writers; `covers` / `uncovered` (is every write of an entity seen?) | B |
| Seq clock | `NodeEpoch` `'e:' + 8 hex` per process, `Seq = '<NodeEpoch>:<n>'` assigned in `ingest` (§39.1) | B |
| Generations | `RetoldFacetingGenerations`: tick-stamped counters per `(Entity, TenantKey, Column \| '#row' \| '#all' \| '#cols')`, owner-qualified tenant keys, `'*'`, `'#any'`, eviction floors, GenVector (§41) | A |
| Cache key | `RetoldFacetingCacheKey`: the cache DepSet (pivot, hops, label targets), per-entity scope probes, cacheability, key material, dependencies → GenVector, Version (§42) | A |
| Result cache | `RetoldFacetingResultCache`: own LRU bounded by entries and bytes, Freshness `Exact` / `Bounded` / `Fast`, single-flight background refresh, metrics (§43) | A |
| Pipeline | Freshness stage, Cache stage (304 without executing, hit, stale-while-revalidate), Store; generation Version / ETag; envelope `Cached` / `Stale` / `LagMS` / `AsOf` / `DependsOn`; `X-Retold-Facet-Seq` / `-Cache` / `-Freshness` headers (§44) | wiring |
| Read-your-writes | `RetoldFacetingReadYourWrites`: last write Seq per principal; `Bounded` / `Fast` upgraded to `Exact` for `ReadYourWritesMS` after the principal's own write, and whenever `MinSeq` is sent (§45) | C |
| SSE | `RetoldFacetingSSE`: `GET /1.0/Facet/Changes`, authenticated principals only, events `{ Entity, Generation, Seq }` for tenants / owners the principal can see, coalesced per entity, heartbeat, connection limits, clean shutdown (§46) | C |
| Demo | provider subscribe + coalesced refetch, inspector Cached / Stale / Version, a "Make a change" panel per page writing through the stock CRUD routes as the demo principal (§47) | D |

### 38.2 Earlier rules changed by Part III

| Earlier | Rule there | M4 rule |
|---|---|---|
| §2.1 / §19.2 pipeline | Principal → Shape → Gate → Bind → Filter → Plan → Execute → Records → Post | Principal → Shape → **Freshness** → Gate → Bind → Filter → Plan → **Cache** → Execute → Records → Post → **Store** (§44.1). Records / Count / Keys are unchanged (never cached) |
| §2.2 / §19.5 context | | + `Freshness`, `Cache`, `IfNoneMatch`, `CacheRefresh` (§38.6) |
| §3 `Freshness` | accepted and ignored (`{ Mode: 'Exact' }`) | normalized: `{ Mode, MaxLagMS, MinSeq }` (§44.2) |
| §10.1 / §10.2 | `Cached: false, Stale: false, LagMS: 0` always | set by the cache paths, envelope and every FacetResult (§44.4); the envelope gains `DependsOn` (§44.7) |
| §10.5 / §18.5 / §30.2 Version | digest of the computed representation (gap G3) | the **generation Version** `hash(Key, GenVector)` for answers that are cacheable end to end while `Cache.Enabled`; the digest form otherwise (§44.5) |
| §18.1 / §28.5 `pMeta` | | + `Cache`, `Seq`, `Freshness`, `ProbeRuns`, `NotModified` (§44.9) |
| §17 / §37 seams | ResultCache / Generations / ChangeIntake / SSE stubbed | implemented (Interim + notify; Bus is a seam) |
| §0 conventions | services, pure modules | + **intake adapters** (`change/Change-Intake-*.js`): plain classes owned and constructed by the ChangeIntake service, never registered on fable (§38.3) |
| §12.1 `Host.installChangeIntake` | no-op seam | still a no-op: the ChangeIntake service installs itself through `Host.getRouteBoundController` (§40.1); `Host.entityScopeColumns` is new (§38.5) |
| §14.4 / §32.4 ports | | + §49.2 |

Everything earlier that is not listed here still holds. In particular: a `Records` / `Count` / `Keys` request is always Live and executes (D-38), and the Reference engine (`ForceEngine`) never reads or writes the cache.

### 38.3 New files and services

| File | Export | Owner |
|---|---|---|
| `source/cache/Retold-Faceting-Generations.js` | service `RetoldFacetingGenerations` (+ statics `tenantKey`, `genKey`, `encodePart`, `ROW`, `ALL`, `COLS`, `ANY`, `GLOBAL`, `NO_TENANT`; `tenantKey` / `genKey` / `encodePart` are implemented in the skeleton and pinned by the smoke test) | A |
| `source/cache/Retold-Faceting-ResultCache.js` | service `RetoldFacetingResultCache` | A |
| `source/security/Retold-Faceting-CacheKey.js` | service `RetoldFacetingCacheKey` (+ statics `KEY_VERSION`, `UNCACHEABLE_REASONS`) | A |
| `source/change/Retold-Faceting-ChangeIntake.js` | service `RetoldFacetingChangeIntake` (+ statics `OPERATIONS`, `SOURCES`, `INTERIM_SLOTS`) | B |
| `source/change/Change-Intake-Interim.js` | class `ChangeIntakeInterim` (adapter; `new (pIntake)`) | B |
| `source/change/Change-Intake-Bus.js` | class `ChangeIntakeBus` (adapter; `new (pIntake)`) | B |
| `source/change/Retold-Faceting-ReadYourWrites.js` | service `RetoldFacetingReadYourWrites` | C |
| `source/routes/Retold-Faceting-SSE.js` | service `RetoldFacetingSSE` (+ statics `EVENT_TYPES`) | C |

Every service is registered in `SUB_SERVICES` (skeletons exist and construct; the contracts pass registered them after `RetoldFacetingLabelResolver`, in this order: CacheKey, Generations, ResultCache, ChangeIntake, ReadYourWrites, then Router, Routes, then SSE). A builder may add a further service only by adding it to `SUB_SERVICES` and to `test/Facet-Smoke_tests.js` in the same change.

Services that need the host read it as `this.fable.RetoldFacetingService.Host` (null before `attach`: then every entity is `Unscoped` and nothing is installed). Services never `require` a sibling service; the adapters receive their owning ChangeIntake and reach everything through `pIntake.fable`.

### 38.4 Options (M4)

```javascript
Cache:
{
	Enabled: false,                  // M4: opt-in (§51.1). true = result cache + generation Version + 304 without executing;
	                                 // correct only while every writer runs in THIS process (§51.50)
	ExposeStatus: false,             // review: X-Retold-Facet-Cache / -Freshness headers + a truthful Cached on another principal's hit (§51.57)
	MaxConcurrentRefreshes: 4,       // review: background refreshes in flight at once (§51.56)
	MaxBytes: 67108864, MaxEntries: 5000, MaxEntryBytes: 4194304, MaxAgeMS: 600000,
	GenerationGranularity: 'Column' | 'Entity',
	MaxGenerationKeys: 'Auto',       // 'Auto' → clamp(MaxBytes / 320, 4096, 200000) (review §51.53)
	MaxGenerationFloors: 50000,
	OpaqueTTLMS: 0,                  // ignored in M4: Opaque answers are never cached (§42.3)
	NowBucketMS, AsOfBucketMS, AgentlessTTLMS   // unchanged / unused in M4
},
Freshness: { DefaultMode: 'Exact', MaxLagMS: 5000, ReadYourWritesMS: 10000, ReadYourWritesMaxPrincipals: 10000,
             SeqHeader: 'Auto' /* true | false | 'Auto' = only without a scope policy (§51.58) */, … },
ChangeCapture: { Intake: 'Auto' | 'Interim' | 'Bus' | 'None', NotifySettleMS: 1000,
                 NotifyManaged: [] | true,      // review: entities whose every write the host notify()s (§51.48)
                 RequireNotifyTenants: false,   // review: refuse a notify of a tenant-scoped entity naming no tenant (§51.64)
                 MaxEventIDs: 10000, MaxEventOwners: 1000 },   // review: beyond them ids / owners become "unknown" (§51.65)
SSE: { Enabled: 'Auto' /* true | false | 'Auto' = only with a scope policy (§51.59) */, AllowedOrigins: [],
       CoalesceMS: 250, HeartbeatMS: 15000, GlobalTickMS: 60000, MaxPerPrincipal: 2, MaxPerTenant: 200,
       MaxConnections: 1000, RevalidateMS: 300000, RetryMS: 3000, IncludeSeq: 'Auto' /* as SeqHeader */ }
```

`Scope.DependsOn` stays reserved (accepted, ignored in M4, §52). Every key above exists in `DEFAULTS` (added by the contracts pass); its owner enforces it.

### 38.5 Shared helpers (implemented by the contracts pass; builders use, never fork)

| Helper | Where | Rule |
|---|---|---|
| `SEQ_PATTERN`, `NODE_EPOCH_PATTERN`, `parseSeq(pSeq)` → `{ Epoch, N }` \| null, `formatSeq(pEpoch, pN)` | `source/Retold-Faceting-Util.js` | the Seq grammar of §39.1 |
| `principalKey(pPrincipal)` → `'pk:' + 16 hex` | `source/Retold-Faceting-Util.js` | sha256 over `[ Kind, IDUser, IDCustomer, ScopeValues (sorted, normalized), RoleSetHash ]`; never SessionID / ResolvedAt / Source. The principal of a write (`Host.buildPrincipal(pRequestState.SessionData, pRequest)`) and of a read of the same session get the same key |
| `Host.entityScopeColumns(pEntity)` | `source/host/Retold-Faceting-Host-Base.js` | §41.2 (Kind, TenantColumn, OwnerColumn, RequiredColumns, DeleteColumn, PrimaryKey, RowColumns) |
| `normalizeScopeValue`, `isUnsetScopeValue` | `Retold-Faceting-Util.js` (M1) | every tenant / owner value is normalized with them before it becomes a key |

### 38.6 Request context additions (`newContext`)

```javascript
{
	…M2 fields,
	Freshness: { Mode: 'Exact', MaxLagMS: 5000, MinSeq: null, Requested: 'Bounded', Upgrade: 'ReadYourWrites' | 'MinSeq' | null },   // §45 (set by the Freshness stage)
	IfNoneMatch: 'W/"fv1:…"' | null,    // pRequest.headers['if-none-match'] (the Cache stage compares it, §44.5)
	CacheRefresh: false,               // true only for the background refresh (pInternalOptions.CacheRefresh; never from a client)
	Cache:                             // set by the Cache stage (§44.3); { Status: 'Off' } when Cache.Enabled is false
	{
		Status: 'Off' | 'Bypass' | 'Miss' | 'Hit' | 'Stale' | 'NotModified' | 'Refresh',
		Reason: null | '<§42.3 reason>',
		Cacheable: false,
		Key: 'ck:…', Short: 'ck:…12', Version: 'fv1:…',
		Deps: <§42.1 result>, Probe: <§42.2 result>, Dependencies: [ … ], GenVector: { Hash, Entries, MaxTick },
		SeqAtCompute: 'e:…:n', Entry: <§43.1 entry> | null, LagMS: 0,
		ProbeRuns: 0, VectorAt: <Date.now() when the GenVector was read>, Coalesced: false   // as built (wiring)
	},
	// As built (wiring):
	CacheDeps: <§42.1 result>,          // computed for EVERY Query (cache on or off): the envelope's DependsOn
	SeqAtCompute: 'e:…:n',             // read in newContext (Records / Count / Keys) and again at the Cache stage (Query)
	PinnedNow: '2026-10-08T12:00:00.000Z' | null,   // the in-process Now when pinned (key material, §42.4)
	InternalOptions: { Now?, PlanForm? },           // what a background refresh repeats (never ForceEngine)
	RequestBody: <the Query body>        // kept only for the background refresh of a Stale serve; never key material
}
```

---

## 39. ChangeEvent and the Seq clock (B)

### 39.1 NodeEpoch and Seq

- `NodeEpoch` = `'e:' + 8 lowercase hex`, minted once when the ChangeIntake service is constructed (first 8 hex of sha256 of `fable.getUUID()` and the start time), exposed as `RetoldFacetingChangeIntake.NodeEpoch`. A restart is a new epoch.
- `Seq` = `'<NodeEpoch>:<n>'`, `n` a per-process counter, `0` before the first change; `ingest` assigns `++n` **synchronously**, once per delivered event (a bulk write of 10 rows takes 10 seqs). Grammar: `Util.SEQ_PATTERN` (`/^e:[0-9a-f]{8}:(0|[1-9][0-9]{0,14})$/`). `currentSeq()` is the last assigned Seq (`'<epoch>:0'` before any).
- Seqs compare only within one epoch (`parseSeq(a).N` vs `parseSeq(b).N`); a Seq of another epoch is "foreign" (§45).
- Generations keep their own `BootEpoch` (`'g:' + 8 hex`, §41.5); the two are independent process-lifetime identifiers.

### 39.2 ChangeEvent (aligned with 05 §3.3 so the upstream bus can replace the interim intake)

```javascript
{
	ChangeID: 'ch:000017',                  // per-process counter (logs, tests)
	Source: 'Interim' | 'Notify' | 'Bus',
	Entity: 'LabForm',
	Operation: 'Create' | 'Update' | 'Delete' | 'Undelete' | 'Touch' | 'EntityDirty',
	IDs: [ 1201 ],                          // [] when unknown (EntityDirty, a notify without ids)
	Tenants: [ 7 ],                         // normalized tenant values of Before ∪ After; '*' = unknown, unset (Scope.UnsetValues), or the entity has no tenant column
	Owners: [ { Tenant: 7, Owner: 42 } ] | null,   // Kind 'Personal' only (§41.2): one pair per distinct (tenant, owner) of Before ∪ After; Owner '*' = unknown; Tenant '#none' when the entity has no tenant column, '*' when unknown
	ChangedColumns: [ 'Status', 'UpdateDate', 'UpdatingIDUser' ] | null,   // Update / Touch: §40.3; null = unknown (→ '#all'); null on every other Operation
	KeyImages: { '1201': { B: { IDCustomer: 7, OwnerIDUser: 42 }, A: { IDCustomer: 7, OwnerIDUser: 42 } } },   // the policy columns only (TenantColumn, OwnerColumn); B absent on Create, A absent on Delete / Undelete; {} when no images
	Filter: null | 'FBV~IDSource~EQ~12' | [ <FoxHound filter entries> ],   // EntityDirty (notifyByFilter) only: the PRE-write predicate, carried, never executed in M4
	Actor: { PrincipalKey: 'pk:…' | null, UserID: 42 | 0, Verb: 'Update' | 'UpdateBulk' | 'Upsert' | 'Notify' | … },
	Timestamp: 1791472445120,
	Epoch: 'e:4f0c2b9e',
	Seq: 'e:4f0c2b9e:88121'
}
```

- Full row images (`Images` in 05) are **never** put on the event (nothing in M4 needs them; nothing may hold rows).
- The event is frozen (the object and its arrays / nested objects) before delivery; subscribers never mutate it.
- `Tenants` never comes from the writer's session (05 §3.3): only from row images, or from a `notify` caller's explicit `Tenants`. A write whose tenant column is submitted but whose old row is unknown adds `'*'` (the old tenant is unknown).
- Vocabulary: `Create` / `Delete` / `Undelete` change row membership; `Update` / `Touch` change columns; `EntityDirty` = "anything in this entity may have changed" (notifyByFilter, overflow). `DeleteByFilter` (05) is folded into `EntityDirty` in M4.

### 39.3 Delivery

`ingest(pRaw)` is the one entry point every source uses (Interim, `notify`, `notifyByFilter`, Bus): it validates and normalizes the raw change (§40.3 / §40.5 shapes), assigns `ChangeID` and `Seq`, freezes the event, then calls every subscriber **synchronously, in subscription order**, each in its own `try/catch` (an exception is logged at warn with the subscriber name and counted in `stats().SubscriberErrors`; the remaining subscribers still run). `ingest` never throws and returns the event, or `null` for an invalid raw change (logged at warn, counted). Subscribers must be O(1)-ish and must not do I/O (they bump counters and arm timers).

```javascript
RetoldFacetingChangeIntake.subscribe(pName, fListener)   // fListener(pChangeEvent); a second subscribe with the same name replaces the first
RetoldFacetingChangeIntake.unsubscribe(pName)
```

The wiring subscribes, in this order (§44.10): `'Generations'` → `Generations.applyChange(e)`; `'ReadYourWrites'` → `ReadYourWrites.onChange(e)`. SSE listens to Generations bumps (§41.7), not to the intake.

### 39.4 Alignment with the upstream bus

The shape above is 05 §3.3 minus `Images`, plus `Owners` (pre-derived from `KeyImages` so consumers need not know the policy) and `Actor.PrincipalKey`. When `MeadowChangeBus` (M-1) and `ChangeContext` (ME-3) land, the Bus adapter maps a bus event onto this shape (`Source: 'Bus'`; the bus `Seq` is kept when it matches `SEQ_PATTERN`, else a local Seq is assigned) and the interim wrappers are not installed (§40.1).

---

## 40. Intake (B)

### 40.1 Install and source selection

`RetoldFacetingChangeIntake.install()` → `{ Source: 'Interim' | 'Bus' | 'None', Entities: [ … ] }` — idempotent; the wiring calls it after every `rebuildCatalog` (attach and each model reload).

| `ChangeCapture.Intake` | Behavior |
|---|---|
| `'Auto'` (default) | `'Bus'` when `ChangeIntakeBus.available()` (fable has a `MeadowChangeBus` with `subscribe`), else `'Interim'` |
| `'Interim'` | the interim wrappers only |
| `'Bus'` | the bus only; no bus → `'None'` with a warn log |
| `'None'` | nothing installed; generations never move (only `notify` bumps them) |

Interim entities: every name in `Catalog.entities()` that has a route-bound controller (`Host.getRouteBoundController(E)`). A dispatcher / DAL method that already carries **this intake's** wrapper (marker `Symbol.for('RetoldFaceting.Intake')` on the wrapper function: `{ Intake, Entity, Original }`) is skipped, so a reload wraps only new controllers and nothing is ever wrapped twice; one that was **replaced** since is wrapped again (review §51.48). Coverage is read from the actual functions, never from a remembered set: `Interim.isCovered(controller)`, `ChangeIntake.covers(E)` / `uncovered(Es)` (§40.8). Catalog entities with no route-bound controller that are not `ChangeCapture.NotifyManaged` are logged at install (their answers are never cached, `'NoChangeSource'`).

### 40.2 Wrapping rules (meadow-endpoints 4.0.21 installed; identical slots in the 4.1.x repo)

> **Revised by the review (§51.46–§51.49).** The interim intake no longer puts wrappers into the slots below (a host's ordinary single-slot `setBehavior` silently replaced them). It wraps, once per route-bound controller, the behavior **dispatcher** `BehaviorInjection.runBehavior` (an own, non-enumerable property shadowing the prototype method; the original runs with the injection as `this`) and, once per DAL object, `doCreate` / `doUpdate` / `doDelete` / `doUndelete`. The dispatcher wrapper looks only at the slot name:
>
> | Slot | Before the slot's behavior | After it called back without an error |
> |---|---|---|
> | `Update-` / `Delete-` / `Undelete-PreOperation` | snapshot a shallow copy of `OriginalRecord` (else `Record`) on the request state — before any host behavior can mutate the shared row object | (Delete / Undelete) arm the write query |
> | `Create-` / `Update-QueryConfiguration` | — | arm the write query (the last slot before the DAL call) |
> | `Create-` / `Update-` / `Delete-` / `Undelete-PostOperation` | capture the change and **ingest it at entry** (the row is committed), then dispatch to the host's behavior; its callback passes through unchanged | — |
>
> Arming puts `{ Entity, Operation, State, Request }` on the query object (`Symbol.for('RetoldFaceting.IntakePending')`, non-enumerable). The DAL wrapper observes only an armed query (a DAL-direct write passes straight through); when the DAL calls back with an error, or Create / Update **without a record** — a committed UPDATE whose re-read failed (meadow's own delete tracking after `PUT { Deleted: 1 }`; an `Update-QueryConfiguration` filter the moved row no longer satisfies) or an INSERT whose re-read failed — no PostOperation will run, so it ingests a **conservative** event: the snapshot pre-image and the record actually submitted to the provider (`query.query.records[0]`; an Update's after-image = pre-image overlaid with it), `ChangedColumns: null` (`'#all'`). A per-request-state marker (`Symbol.for('RetoldFaceting.IntakeState')`) makes the precise PostOperation path and the conservative DAL path ingest **at most once** per record. A capture that cannot be derived (or that `ingest` refuses) **fails closed**: an `EntityDirty` of `Tenants: ['*']`. Every wrapper only acts while the intake's source is `'Interim'`; nothing ever throws into or delays a write. With ME-1 (`addBehavior`, no `runBehavior`) the capture and the snapshots register at the lowest order (`{ Name: 'Faceting', Order: -1000 }`) and the arms at the highest (`{ Name: 'FacetingArm', Order: 1000 }`). The text below is the M4 build's slot inventory; its "Wrapper" steps are superseded by this note.

The four per-record slots below are reached by **every** write path of both versions: single Create (`POST /1.0/E`), bulk Create (`POST /1.0/Es`, one `doCreate` per record), Update (`PUT /1.0/E`, `PUT|PATCH /1.0/E/:IDRecord`), bulk Update (`PUT /1.0/Es`, one `doUpdate` per record), Upsert / Upserts / Upserts/Detailed (`Meadow-Operation-Upsert` → `doCreate` or `doUpdate` per record), Delete (`DELETE /1.0/E[/:IDRecord]`), Undelete (`GET /1.0/E/Undelete/:IDRecord`). The endpoint-level slots (`CreateBulk-`, `UpdateBulk-`, `UpsertBulk-PostOperation`) are **not** wrapped (they would double-count). The 4.1.x `POST /1.0/Es/Query` is a read.

| Slot | Runs after | Request state available |
|---|---|---|
| `Create-PostOperation` | `DAL.doCreate` succeeded with a record | `Record` (re-read row), `RecordToCreate` (submitted), `SessionData`, `Verb` |
| `Update-PostOperation` | `DAL.doUpdate` succeeded with a record | `OriginalRecord` (pre-image: read by Update; the cached row on the Upsert path), `Record` (post-image), `RecordToModify` (submitted) |
| `Delete-PostOperation` | `DAL.doDelete` without error | `OriginalRecord` / `Record` (pre-image), `IDRecord`, `RecordCount` |
| `Undelete-PostOperation` | `DAL.doUndelete` without error | `OriginalRecord` / `Record` (the deleted row), `RecordCount` |

Wrapper (per controller, per slot), normative:

1. With ME-1 (`BehaviorInjection.addBehavior` is a function): `addBehavior(Slot, fCapture, { Name: 'Faceting', Order: 1000 })` and stop.
2. Otherwise read the existing function **before** wrapping (`_BehaviorFunctions[Slot]`, may be absent) and `setBehavior(Slot, fWrapper)` where `fWrapper` is a `function` (never an arrow: it keeps the controller as `this`) that:
   1. computes the raw change **synchronously at entry** from the request state (§40.3) inside `try/catch` (a failure is logged at warn, counted in `stats().WrapperErrors`, and the write proceeds with no event) — at entry, so a previous behavior that decorates or mutates `Record` cannot change what is captured;
   2. calls the previous function **first**, as `fPrevious.call(this, pRequest, pRequestState, fWrapped)` (no previous function → `fWrapped()` directly);
   3. `fWrapped(pError)` ingests the computed change exactly once (inside `try/catch`, errors logged and swallowed) and then calls the original `fCallback(pError)` with the previous behavior's error **unchanged** — the row committed whatever the previous behavior said, so the event is ingested even when it errors;
   4. if `fPrevious` throws synchronously before calling back, the wrapper ingests the change and calls `fCallback(pThrown)` (what `runBehavior` would have done); if it throws after calling back, the exception is rethrown (it belongs to the continuation).
3. Ingest is synchronous and does no I/O, so the write's response is never delayed by more than the subscribers' O(1) work, and by the time the client receives its 2xx the generations are already bumped (read-your-writes inside the process).

Writes that fail before the DAL call (validation, a 404 pre-read, a refusing PreOperation) produce no event: nothing was submitted. A DAL write that fails (or whose re-read fails) produces the conservative event of the note above, whether or not the provider committed (an extra invalidation is harmless).

### 40.3 Deriving the change from the request state

Let `S = Host.entityScopeColumns(E)` (§41.2), `PK = S.PrimaryKey`, and compare only **model columns** of `E` (`Host.entityHasColumn`; decorations are ignored).

| Slot | Operation | Before | After | IDs | ChangedColumns |
|---|---|---|---|---|---|
| Create | `Create` | — | `Record` (else `RecordToCreate`) | `[ After[PK] ]` | `null` |
| Update | `Update` | `OriginalRecord` | `Record` | `[ After[PK] ?? Before[PK] ?? RecordToModify[PK] ]` | Before and After: the model columns whose values differ (compared as `canonicalJSON` of the value, a `Date` as its ISO string) ∪ `UpdateDate`, `UpdatingIDUser`; no Before: the submitted model columns of `RecordToModify` ∪ the two audit columns, and when `S.TenantColumn` (or `S.OwnerColumn`) is among them `Tenants` gains `'*'` (resp. `Owners` gains an unknown-owner pair) |
| Delete | `Delete` | `OriginalRecord ?? Record` | — | `[ Before[PK] ?? IDRecord ]` | `null` |
| Undelete | `Undelete` | `OriginalRecord ?? Record` | — | `[ Before[PK] ]` | `null` |

- `Tenants` / `Owners` / `KeyImages` from `Before` and `After` per §39.2 (values normalized with `normalizeScopeValue`; `isUnsetScopeValue(v, Scope.UnsetValues)` → unknown).
- No update is suppressed as a no-op (meadow stamps `UpdateDate` on every update, which an `UpdateDate` facet reads).
- `Actor`: `Host.buildPrincipal(pRequestState.SessionData, pRequest)` → `Util.principalKey`; `UserID` = that principal's `IDUser`; `Verb` = `pRequestState.Verb` (or its `ParentRequestState.Verb`). A failure to build the principal leaves `PrincipalKey: null` (no read-your-writes for that write), never fails the capture.
- `RetoldFacetingChangeIntake.changeFromRows(pEntity, pOperation, pBefore, pAfter, pExtra)` → raw change is the one implementation, shared with `notify({ Records, Before })`.

### 40.4 What the interim intake cannot see (documented, tested as "not seen")

DAL-direct writes (`fable.DAL.E.doUpdate` from app code, importers — an unarmed query), raw SQL, `provider.*` calls, writes on controllers that are not route-bound, and **writes made by another process** (generations live in one process, §51.50). These must call `notify` / `notifyByFilter` until M-1 lands (§51.1); an entity whose writes no source sees is never cached unless `ChangeCapture.NotifyManaged` names it (§40.8). Sweep / Bisect / Scrub are later milestones.

### 40.5 `notify` and `notifyByFilter` (raw writers; call only after COMMIT)

```javascript
RetoldFacetingService.notify(pEntity, pChange)                    // → Seq | null   (delegates to ChangeIntake.notify)
RetoldFacetingService.notifyChanged(pEntity, pChange)             // alias (05 §5)
RetoldFacetingService.notifyByFilter(pEntity, pFilter, pOptions)  // → Seq | null   (delegates to ChangeIntake.notifyByFilter)

pChange =
{
	Operation: 'Update',            // Create | Update | Delete | Undelete | Touch | EntityDirty (default Update)
	IDs: [ 1, 2 ],                  // optional
	Records: [ <row after> … ],     // optional: IDs, tenants, owners and KeyImages are read from them (changeFromRows)
	Before: [ <row before> … ],     // optional: the pre-images (moves)
	Tenants: [ 7 ],                 // optional: explicit tenant values; absent with no rows → [ '*' ] (every tenant)
	Owners: [ { Tenant: 7, Owner: 42 } ],   // optional (Personal entities)
	ChangedColumns: [ 'Value' ] | null,     // Update / Touch; absent or null → unknown ('#all')
	Principal: <Principal> | PrincipalKey: 'pk:…'   // optional: read-your-writes for the writer (§45)
}
pFilter = 'FBV~IDSource~EQ~12' | [ <FoxHound filter entries> ]   // the PRE-write predicate (05 §5)
pOptions = { Tenants, Owners, Principal | PrincipalKey }
```

- Validation: `pEntity` must have a DAL (`Host.getDAL(E)`); `Operation` must be one of `OPERATIONS`; arrays must be arrays; a `pFilter` must be a non-empty string or an array. A failure logs a warn (entity name and reason only, `logSafe`) and returns `null` — **never throws** (the caller's commit already happened).
- `notifyByFilter` emits `Operation: 'EntityDirty'`, `IDs: []`, `Filter` carried (never executed or parsed in M4), `Tenants` from `pOptions.Tenants` else `[ '*' ]`.
- **Settle (05 §5):** every `Source: 'Notify'` event is re-ingested once more after `ChangeCapture.NotifySettleMS` (a new Seq, `ChangeID` + `'~settle'`), so a notify sent just before its commit became visible cannot leave a cache entry computed on the old row valid. `0` disables. Settles are **coalesced per (Entity, Operation)** within one window (review §51.65): the first notify arms one timer, later ones merge their IDs, Tenants, Owners and ChangedColumns (an unknown list wins); a merged settle carries `KeyImages: {}` and no Filter. The timer is `unref()`'d and cleared by `shutdown()`.
- **Unknown tenants (review §51.64):** a notify of a Tenant / Personal entity whose event falls back to `'*'` is counted (`stats().UnknownTenant`) and warned about at most once a minute per entity; `ChangeCapture.RequireNotifyTenants: true` refuses (null + warn) a notify that names no tenant (no `Tenants`, no row carrying the tenant column).
- **Size caps (review §51.65):** an event with more than `MaxEventIDs` ids carries `IDs: []` and `KeyImages: {}`; more than `MaxEventOwners` owner pairs, `Owners: null` (Part/* per tenant). Derivation is linear (Set-based dedupe): 50 000 ids in well under 100 ms.

### 40.6 Bus adapter seam (`Change-Intake-Bus.js`)

`new ChangeIntakeBus(pIntake)`: `available()` → `!!(fable.MeadowChangeBus && typeof fable.MeadowChangeBus.subscribe === 'function')`; `install()` → subscribes `{ onChangeSync: (e) => pIntake.ingestBusEvent(e), onBatch: (b, f) => f() }` under `'RetoldFaceting'` and returns true, else false; `uninstall()`. `ChangeIntake.ingestBusEvent(pBusEvent)` maps 05 §3.3 onto §39.2 (`Owners` derived from `KeyImages` + `Host.entityScopeColumns`, `Images` dropped). M4 ships no bus; B tests the adapter against a fake bus object.

### 40.7 ChangeIntake API (B)

```javascript
NodeEpoch                                           // 'e:' + 8 hex
install() → { Source, Entities }                    // §40.1
subscribe(pName, fListener) / unsubscribe(pName)    // §39.3
ingest(pRaw) → ChangeEvent | null                   // §39.3
changeFromRows(pEntity, pOperation, pBefore, pAfter, pExtra) → raw change   // §40.3
notify(pEntity, pChange) → Seq | null               // §40.5
notifyByFilter(pEntity, pFilter, pOptions) → Seq | null
ingestBusEvent(pBusEvent) → ChangeEvent | null      // §40.6
nextSeq() → Seq                                     // implemented in the skeleton; only ingest calls it
currentSeq() → Seq                                  // implemented in the skeleton
shutdown()                                          // clears settle timers; uninstalls nothing (wrappers stay harmless)
stats() → { Source, Entities, Events, BySource: {}, ByOperation: {}, SubscriberErrors, WrapperErrors, Invalid,
             UnconfirmedWrites, FailClosed, Rewraps, UnknownTenant, Capped, LastSeq }
notifyManaged(pEntity) → boolean, covers(pEntity) → boolean, uncovered(pEntities) → [ … ]   // §40.8
```

### 40.8 Coverage (review §51.48)

`covers(E)`: `'Bus'` and `'None'` cover every entity (the operator chose them); `ChangeCapture.NotifyManaged` (true, or a list naming E) covers E; under `'Interim'`, E is covered iff its route-bound controller's dispatcher (ME-1: its registered slots) carries this intake's wrapper — a dispatcher or DAL method replaced since the install is wrapped again, warned about, and an `EntityDirty` (`Tenants: ['*']`, `Actor.Verb: 'Rewrap'`) is ingested **before** `covers` returns, so no answer computed during the gap survives the lookup that follows. `CacheKey.precheck` asks `uncovered(DepSet entities)` for every cacheable request (`'NoChangeSource'`).

---

## 41. Generations (A)

### 41.1 Key grammar

```
GenKey    = Entity '|' TenantKey '|' Column
TenantKey = '*'                       a change that may affect every tenant (unknown tenant; every write of a Global / Unscoped entity)
          | '#any'                    bumped by every write of the entity; read only by folds with no captured tenant
          | Part                      one tenant
          | Part '/' Owner            one owner of a Personal entity in one tenant
          | Part '/*'                 a write in that tenant whose owner is unknown (read by every owner-qualified fold of the tenant)
Part      = enc(tenant) | '#none'     ('#none': a Personal entity without a tenant column)
Owner     = enc(owner)
Column    = <model column name> | '#row' | '#all' | '#cols'
enc(v)    = encodeURIComponent(String(normalizeScopeValue(v))).replace(/\*/g, '%2A')
```

`'#…'` keys never collide with an encoded value (`'#'` encodes as `%23`), nor does `'*'` (encoded `%2A`). `Generations.tenantKey(pTenant, pOwner)` (static and instance) is the one implementation: `pTenant` unknown (`'*'`, null, unset) → `'*'`; `pOwner` `undefined` → the tenant key; `pOwner` unknown → `Part + '/*'`. `Generations.genKey(pEntity, pTenantKey, pColumn)`.

### 41.2 Entity scope kinds (`Host.entityScopeColumns(E)`, §38.5)

| Kind | When | Writes bump tenant keys | A fold reads tenant keys |
|---|---|---|---|
| `Unscoped` | no policy (`Kind: 'None'`) | `'*'` | `'*'` |
| `Global` | policy, but `E` has no (non-excluded) tenant column and no personal column — global lookups, `Exclude`d entities, entities scoped only by `Required` columns | `'*'` | `'*'` |
| `Tenant` | `E` has the policy `Column` and is not excluded | each `enc(t)` of `Tenants` (`'*'` for unknown) | `enc(t)` (the principal's `ScopeValues[TenantColumn]`), `'*'` — or `'#any'`, `'*'` when that value is unset |
| `Personal` | `E` has its `PersonalScopes` column | the tenant keys as `Tenant` (`Part` = `'#none'` without a tenant column) **plus** `Part/Owner` for each pair of `Owners` (`Part/*` for an unknown owner; when `Owners` is null, `Part/*` for each known tenant) | owner-qualified `Part/o`, `Part/*`, `'*'` (`o` = `ScopeValues[OwnerColumn]`) — or tenant-wide `Part`, `'*'` when the plan reads `E` through a `TenantOnly` Rel anywhere (§42.1) or `o` is unset |

Every write also bumps `'#any'`. `RowColumns` (delete, tenant, owner, identity, `Required`) are the columns whose change moves a row in or out of a scope or fold.

### 41.3 Bumping a ChangeEvent — `applyChange(pEvent)`

Columns (granularity `'Column'`):

| Operation | Column keys bumped |
|---|---|
| `Create`, `Delete`, `Undelete` | `'#row'` |
| `Update`, `Touch` with `ChangedColumns: null` | `'#all'` |
| `Update`, `Touch` with a list | each column: `'#row'` when it is in `RowColumns`, else the column itself; plus `'#cols'` ("some column changed") |
| `EntityDirty`, anything else | `'#all'` |

Granularity `'Entity'`: every bump that is not `'#row'` becomes `'#all'`.

One bump = `Tick = ++GlobalTick`, `At = Date.now()`, stamped on **every** `genKey(E, T, C)` for `T` in the event's tenant keys (§41.2, plus `'#any'`) and `C` in its columns: `table.set(GenKey, { Tick, At })` (LRU-refreshed). Returns the bump record (also passed to bump listeners, §41.7):

```javascript
{ Entity, Tick, At, Seq, Source, Operation, TenantKeys: [ … ], Columns: [ … ], Keys: [ 'E|T|C', … ] }
```

An invalid event (no Entity) returns `null` and bumps nothing; `applyChange` never throws. `bumpEntity(pEntity, pReason)` bumps `(E, '*', '#all')` and `(E, '#any', '#all')` (model reloads and tests).

### 41.4 Reading — what a fold depends on

`CacheKey.dependencies` (§42.5) produces, per DepSet entity `E`, `{ Entity, TenantKeys, Columns }`:

- `TenantKeys` = `Generations.foldTenantKeys(pPrincipal, E, pTenantOnly)` (the right-hand column of §41.2);
- `Columns` = (`DepSet[E]` ∪ the probe capture's `Appended` columns (stripped)) − `RowColumns` ∪ `'#row'`, `'#all'` (∪ `'#cols'` when `DepSet[E]` holds `'#cols'`, §42.1). Granularity `'Entity'`: `'#row'`, `'#all'`.

### 41.5 GenVector — `vector(pDependencies)`

`Entries` = every `[ genKey(E, T, C), read(…).Tick ]` for each dependency, `T` in its `TenantKeys`, `C` in its `Columns`, deduplicated, sorted by key; `MaxTick` = the largest tick; `Hash` = `'g:' + sha256(BootEpoch + '|' + JSON.stringify(<the sorted keys>) + '|' + MaxTick).slice(0, 16)` where `BootEpoch` = `'g:' + 8 hex` minted at construction (a restart changes every hash, 05 §6.3). Ticks only grow, so any bump of a dependency after the read raises `MaxTick`; an eviction can change the hash only by raising `MaxTick` (the evicted group's own last bump newer than every dependency), i.e. only ever invalidates more (review §51.53). `read(pGenKey)` → `{ Tick, At }`: the table value (LRU-refreshed), else `{ Tick: floor(E, T), At: null }` without inserting anything.

The vector is read **before** execution (§44.3) and stored with the entry: a write that commits during execution leaves the stored vector older than the current one, so the entry is stale from birth (never served as Exact).

### 41.6 Eviction floors (no ABA, 05 §6.2) — revised by the review (§51.53)

- Keys live in **groups**, one per `E|T` (the floor key), each holding at most the entity's columns. The `'*'` and `'#any'` groups of every entity are **pinned**: created on first bump or read (starting at the floor their keys read so far), never evicted (≤ 2 × entities groups), so the keys every fold reads never fall back to a floor.
- Other groups are bounded by `Cache.MaxGenerationKeys` (`'Auto'` → `clamp(MaxBytes / 320, 4096, 200000)`): while the evictable keys exceed it, the least recently used of the 16 oldest-inserted groups is evicted **whole** (recency is a use stamp on bump and read — never a Map re-insertion on the hot path). Evicting a group with largest tick `x` sets `Floor[E|T] = max(Floor[E|T], x)` (`FloorRaises`); a group recreated later starts at that floor (its `Base`).
- Floors are bounded by `Cache.MaxGenerationFloors`; the oldest floor `f` of `E|T` folds into `EntityFloor[E] = max(EntityFloor[E], f)` — **never a global floor**: churn on one entity can never move another entity's keys. (`GlobalFloor` is raised only by `clear()`.)
- A key whose group is missing reads `max(Floor[E|T] ?? 0, EntityFloor[E] ?? 0, GlobalFloor)`; a present group's column it never saw reads the group's `Base`. Reads are monotone, so an entry that saw the evicted group's last bump stays valid and one that predates it is invalid.
- `stats()` adds `Groups`, `PinnedKeys`, `EntityFloors`, `GroupEvictions`, `EntityFloorRaises`, `ApplyErrors`, `MaxKeys`, `ApproxBytes`. `applyChange` fails closed: an event that breaks after its Entity was read bumps `bumpEntity(E, 'ApplyError')`; `scopeColumns` falls back to an Unscoped descriptor (bumps `'*'`) when the host throws.

### 41.7 API (A)

```javascript
BootEpoch, GlobalTick (getter)
applyChange(pEvent) → Bump | null               // §41.3; then calls every bump listener (sync, try/catch each)
bumpEntity(pEntity, pReason) → Bump
subscribe(pName, fListener) / unsubscribe(pName)   // bump listeners: fListener(pBump); SSE subscribes 'SSE'
read(pGenKey) → { Tick, At }
vector(pDependencies) → { Hash, Entries, MaxTick }
scopeColumns(pEntity) → Host.entityScopeColumns(pEntity), or an Unscoped descriptor without a host
tenantKeysForChange(pEvent) → [ … ]             // §41.2 middle column + '#any'
columnsForChange(pEvent) → [ … ]                // §41.3
foldTenantKeys(pPrincipal, pEntity, pTenantOnly) → [ … ]   // §41.2 right column
principalTenantKeys(pPrincipal, pEntity) → [ … ]           // SSE visibility (§46.4): Tenant → [ enc(t) ]; Personal → [ Part/o, Part/* ]; Global / Unscoped → [ '*' ]; [] when unset
static tenantKey(pTenant, pOwner), static genKey(pEntity, pTenantKey, pColumn)
stats() → { Keys, Floors, GlobalFloor, GlobalTick, Bumps, Evictions, FloorRaises }
clear()                                          // tests
```

---

## 42. DepSet, scope probes and the cache key (A)

### 42.1 The cache DepSet — `CacheKey.depSet(pContext, pPlan)`

```javascript
{
	DepSet: { Project: [ 'IDProject', 'Status', … ], Client: [ 'IDClient', 'Name' ], … },   // sorted columns
	Entities: [ 'Client', 'Project', … ],      // sorted; the envelope's DependsOn (§44.7)
	TenantOnly: [ 'LabForm' ],                 // entities some Rel reads with Scope 'TenantOnly'
	LabelTargets: [ 'Client' ],
	Records: true | false
}
```

- `Plan.DepSet` (every Agg's DepSet over its Rels and its Variant's PathPred, §24.10);
- ∪ each `Agg.LabelLookup` target `{ Entity: [ KeyColumn, LabelColumn ] }` (plus its PK, delete and policy columns) **when** `Authorizer.canFacet(pContext, Target)` (a target the principal cannot read contributes no data and no dependency);
- ∪ `'#cols'` on the pivot when the Query body has `Records` (hydrated records carry every column);
- `TenantOnly` from `FoldIR.relations(…)` over every Agg and every Variant's `PathPred` / `Where` (`Rel.Scope === 'TenantOnly'`).

The wiring computes it for every Query (also with the cache off: `DependsOn`).

### 42.2 Scope probes — `CacheKey.captureScopes(pContext, pDepSet, fCallback)`

For each entity of the cache DepSet, in sorted order, one capture of the entity's scope **as this principal**, on a scratch context `Object.assign({}, pContext, { Memo: { Relations: {}, Captures: {}, VariantRows: {} }, Counters: { Relations: 0, BehaviorRuns: 0, Statements: 0 } })` (probes never touch the request's memo or its M2 budgets):

1. `tmpQuery = Host.getExecutionDAL(E).query`; when `Host.hasDeleteColumn(E)`: `addFilter(DeleteColumn, 0, '=', 'AND', 'FacetSoftDelete')` (exactly a hop relation with no client conjuncts);
2. `ScopeCapture.capture(probeContext, E, tmpQuery, 'Inherit', { Columns: <real columns of DepSet[E]> }, …)` — the entity's own `Reads-QueryConfiguration` on the route-bound controller, ScopeGuard, the read-side audit;
3. callback `(null, { Captures: { E: <capture> }, Uncacheable: [ { Entity, Reason } ], ProbeRuns, ScopeRepaired })` — **never an error**: a probe error (behavior 401, guard refusal, controller-less entity) or an Opaque capture makes the request uncacheable (§42.3) and the request proceeds exactly as in M2 (its own execution produces the real error, if any). Probe failures are logged at debug (entity and reason only).

`ProbeRuns` = the scratch context's `BehaviorRuns`; it is reported in `pMeta.ProbeRuns` and is **not** counted against `MaxBehaviorRunsPerRequest`. More DepSet entities than `Limits.MaxRelationsPerRequest` → no probes, `Reason: 'TooManyEntities'`. Probes run no SQL (the stock behaviors add filters; a host behavior that does I/O pays it once per entity per cacheable request).

### 42.3 Cacheability — `CacheKey.cacheability(pContext, pPlan, pDeps, pProbe)` → `{ Cacheable, Reason }`

Pre-execution (the first that applies is the `Reason`; `Status: 'Bypass'`):

| Reason | When |
|---|---|
| `'Mode'` | `pContext.Mode !== 'Query'` (Records / Count / Keys are never cached) |
| `'ForceEngine'` | an in-process `ForceEngine` (the Reference oracle) |
| `'PlanErrors'` | `Plan.Errors` is non-empty (per-facet 400 / 403 / 422) |
| `'NoChangeSource'` | (review §51.48) some DepSet entity is not `ChangeIntake.covers`ed |
| `'ModelReload'` | (review §51.51) the catalog's ModelVersion differs from the one `newContext` snapshotted |
| `'TooManyEntities'` | §42.2 |
| `'ProbeError'` | a probe failed |
| `'Opaque'` | a probe capture is `Opaque` (untrusted, trusted-and-stageable, or `PostOperation`) |
| `'RecordsPostOperation'` | `Records` requested and the pivot's capture has read-side behaviors (`PostOperation` non-null, trusted or safe-column): decorations may depend on the session or other tables |
| `'NotCacheable'` | a probe's request state has `FacetCacheable === false` (06 §7 determinism escape) |

Post-execution (never stored; the answer still goes out): `'ScopeChanged'` (review §51.49, §42.8), `'Errors'` (the envelope has any `Errors` entry), `'Staged'` (`pExecution.Staged.Relations > 0`), `'TooLarge'` (entry bytes > `Cache.MaxEntryBytes`). `UNCACHEABLE_REASONS` lists all of them (`'Mode', 'ForceEngine', 'PlanErrors', 'NoChangeSource', 'ModelReload', 'TooManyEntities', 'ProbeError', 'Opaque', 'RecordsPostOperation', 'NotCacheable', 'Errors', 'Staged', 'ScopeChanged', 'TooLarge'`).

### 42.4 Key material — `CacheKey.material(pContext, pPlan, pProbe)`, `key(…)`

```javascript
{
	v: 1,                                          // KEY_VERSION
	Instance: Options.InstanceID,
	Boot: Generations.BootEpoch,
	Model: pContext.ModelVersion,                  // covers definitions and policy (§30.2); snapshotted in newContext (review §51.51)
	EngineClass: 'Live',
	Entity: pContext.Entity, Mode: 'Query',
	Request: { Facets, Total, Scopes, Params, Records, Warnings },   // NormalizedRequest minus Clauses / FilterString (raw), Freshness, TimeoutMS
	Client: FilterAST.Conjuncts.map(({ Id, Origin, Shape, NeverExclude, Pred }) …),  // canonical client conjuncts incl. clause Hashes (Excluded, Filter.Applied)
	Applied: FilterAST.Applied, FilterWarnings: FilterAST.Warnings,
	Scope: [ [ Entity, Capture.Fingerprint ], … ],  // every probe capture (Appended + Transformed + behavior + mode), sorted by entity
	Bind: Plan.BindHash,                           // $CurrentUser / $Param / floored $Now (§22.5)
	Gate: Principal.RoleSetHash || '',
	PlanForm: pContext.PlanForm, PinnedNow: <the in-process Now when pinned, else null>
}
Key   = 'ck:' + sha256(canonicalJSON(material))          // 64 hex
Short = Key.slice(0, 15)                                   // logs, headers, pMeta
```

- **Never** the SessionID, the request object, cookies or headers: the material reads only the context fields above. Two principals share an entry iff their captured scopes, bound values and role sets are equal (06 §7): same-tenant users share answers over tenant-only entities; a `$CurrentUser` binding, an owner predicate or a tenant switch under one session changes the key.
- `Principal.ScopeValues` are deliberately **not** key material (the captures carry the values the SQL uses).
- `planHash(pContext)` = `'ph:' + 16 hex` of the `Request` + `Client` parts (logs).

### 42.5 Dependencies — `CacheKey.dependencies(pContext, pDeps, pProbe)` → `[ { Entity, TenantKeys, Columns } ]`

§41.4 for every entity of `pDeps.DepSet`, with `pTenantOnly = pDeps.TenantOnly.includes(E)` and the probe capture's `Appended` columns. The wiring then reads `Generations.vector(dependencies)`.

### 42.6 Version — `CacheKey.version(pKey, pGenVectorHash)`

`'fv1:' + sha256(pKey + '|' + pGenVectorHash).slice(0, 16)` — the same `fv1:<16 hex>` shape as M1, so the ETag regexes hold.

### 42.8 Scope drift — `CacheKey.scopeDrift(pContext)` (review §51.49)

The key's scope comes from the probes; the execution re-runs every Reads behavior. After probes, the Cache stage arms `pContext.ScopeLog = []`; `ScopeCapture._finishCapture` pushes `{ Entity, ScopeMode, Appended }` (what the behavior appended, before any TenantOnly relaxation) for every capture whose behavior ran (memo replays add nothing; probes run with `ScopeLog: null`). `scopeDrift` is `{ Drift: true, Entity }` when an execution capture's `Appended` differs (canonical JSON) from its entity's probe capture, or captures an entity no probe saw. `cachePostCheck` then marks the answer `Bypass 'ScopeChanged'`: never stored, the digest Version, and a single-flight joiner never takes it (§44.11). Client-operator transforms are not compared (probes carry no client conjuncts; the key's Client part covers them). A host behavior whose appended filters depend on the request's own filters therefore never caches (its execution always "drifts" from its probe) — uncacheable, never wrong.

### 42.7 API (A)

```javascript
depSet(pContext, pPlan) → Deps                                   // §42.1 (sync)
captureScopes(pContext, pDeps, fCallback)                         // §42.2
cacheability(pContext, pPlan, pDeps, pProbe) → { Cacheable, Reason }   // §42.3 pre-execution
material(pContext, pPlan, pProbe) → object                        // §42.4
key(pContext, pPlan, pProbe) → { Key, Short }
planHash(pContext) → 'ph:…'
dependencies(pContext, pDeps, pProbe) → [ … ]                     // §42.5
version(pKey, pGenVectorHash) → 'fv1:…'                           // §42.6
scopeDrift(pContext) → { Drift, Entity }                          // §42.8 (review)
```

---

## 43. ResultCache and Freshness (A)

### 43.1 Entry

```javascript
{
	Key: 'ck:…', GenVectorHash: 'g:…', MaxTick: 1834,
	SeqAtCompute: 'e:4f0c2b9e:88121',
	Body: '<JSON of the envelope with Version: null, ElapsedMS: 0>',   // a string: hits parse a fresh copy, callers can never mutate the stored answer
	Bytes: 18233,                                  // Buffer.byteLength(Body) + 512
	CreatedAt: 1791472445120, AsOf: '2026-10-08T15:02:11.120Z', Engine: 'Live',
	Meta: { DependsOn: [ … ], ScopeRepaired: false, RecordsDropped: 0, Statements: 3, BindHash: 'b:…' }
}
```

### 43.2 Bounds and eviction

`Map`-based approximate LRU (no cachetrax). `set(pKey, pEntry)`: an entry over `MaxEntryBytes` is refused (`Rejected`); an existing entry with a larger `MaxTick` is kept (a slow compute never overwrites a newer answer); otherwise replace, then evict until `Entries ≤ MaxEntries` and `Bytes ≤ MaxBytes` (`Evictions`): the least recently used of the 16 oldest-inserted entries (exact LRU for small caches). `get` stamps recency (a use counter on the slot — never a Map re-insertion, review §51.54) and deletes entries older than `Cache.MaxAgeMS` (`Expired`). One entry per Key (the latest). An entry records `By` (the computing principal's key, §51.57).

### 43.3 Lookup — `lookup(pKey, pGenVector, pFreshness, pNow)` → `{ Status, Entry, LagMS }`

| Situation | `Exact` | `Bounded` | `Fast` |
|---|---|---|---|
| no entry (or expired) | Miss | Miss | Miss |
| `entry.GenVectorHash === pGenVector.Hash` | **Hit** | **Hit** | **Hit** |
| vector differs, `pNow − entry.CreatedAt ≤ MaxLagMS` | Miss | **Stale** | **Stale** |
| vector differs, `MaxLagMS < age ≤ Cache.MaxAgeMS` | Miss | Miss | **Stale** |

`LagMS` = `pNow − entry.CreatedAt` for Stale (conservative: the age of the answer, never less than its true staleness), `0` for Hit. An `Exact` request never takes an entry whose vector differs (so it never returns a stale answer). `MinSeq` and read-your-writes reach the cache as `Mode: 'Exact'` (§45). Counters: `Hits`, `StaleHits`, `Misses`.

### 43.4 Single flight and background refresh

- `refresh(pKey, fWork)` → `true` when started: at most **one** refresh per Key in flight (`Refreshing` set) and at most `Cache.MaxConcurrentRefreshes` (4) in flight overall — beyond that none starts (`RefreshesSkipped`) and the stale answer keeps being served (review §51.56); `fWork(fDone)` recomputes and stores through the normal path (§44.6) — **through the single flight** (§44.11), so a concurrent foreground miss of the same key and vector joins it; `fDone(pError)` clears the flag; an error is logged at warn and counted (`RefreshErrors`), never thrown. So under any number of viewers a stale Key costs at most one recompute per refresh.
- `flight(pFlightKey, fWork, fCallback)`: concurrent callers with the same flight key share one `fWork` run and all receive its `(pError, pResult)`. The wiring SHOULD use it for misses (`FlightKey = Key + '|' + GenVector.Hash`); the waiters' `pMeta.Cache.Status` is `'Miss'` with `Coalesced: true`.

### 43.5 Metrics — `stats()`

`{ Entries, Bytes, MaxEntries, MaxBytes, Hits, StaleHits, Misses, Stores, Rejected, Evictions, Expired, Refreshes, RefreshErrors, RefreshesSkipped, Flights, NotModified, Bypass: { <Reason>: n } }`; `note(pMetric, pReason)` increments `NotModified` / `Bypass[Reason]` (the wiring calls it).

### 43.6 API (A)

```javascript
get(pKey) → entry | null       set(pKey, pEntry) → boolean       delete(pKey)       clear()
lookup(pKey, pGenVector, pFreshness, pNow) → { Status, Entry, LagMS }
refresh(pKey, fWork) → boolean      flight(pFlightKey, fWork, fCallback)
note(pMetric, pReason)              stats()       shutdown()   // clears flights' bookkeeping
```

---

## 44. Pipeline integration (wiring)

### 44.1 Order

```
Route POST …/Query (and /Scope/:Scope/Query) → RetoldFacetingService.query → queryInternal
  1 Principal
  2 Shape        NormalizedRequest.Freshness = { Mode, MaxLagMS, MinSeq } (§44.2)
  3 Freshness    pContext.Freshness = ReadYourWrites.effectiveFreshness(Principal, NormalizedRequest.Freshness, now)   (§45)
  4 Gate  5 Bind  6 Filter  7 Plan                                  (M2)
  8 Cache        §44.3 (304 without executing; Hit / Stale served here; Miss continues)
  9 Execute  10 Records                                             (M2)
 11 Post         + DependsOn; Version: generation form or digest form (§44.5)
 12 Store        §44.6
 13 Respond      headers §44.8
```

The Cache stage runs after Plan because the key needs the bound plan, the per-facet gates and the DepSet; everything before it runs no SQL. Authorization therefore always precedes any cache read and any 304 (06 §7).

### 44.2 Freshness normalization (`contract/Facet-Contract-Request.js`, wiring)

`normalizeRequest(pEntity, pBody, { Limits, Time, Mode, Freshness: { DefaultMode, MaxLagMS, MaxAgeMS } })`: `Freshness` absent → `{ Mode: DefaultMode, MaxLagMS, MinSeq: null }`; otherwise a plain object (else `400 FACET_REQUEST_INVALID { Field: 'Freshness' }`) whose `Mode` ∈ `FRESHNESS_MODES` (`'Exact' | 'Bounded' | 'Fast'`, else `{ Field: 'Freshness.Mode' }`), `MaxLagMS` an integer `0 ≤ v ≤ MaxAgeMS` (else `{ Field: 'Freshness.MaxLagMS', Max }`), `MinSeq` a string matching `SEQ_PATTERN` (else `{ Field: 'Freshness.MinSeq' }`); unknown keys are ignored. The route also reads `X-Retold-Facet-MinSeq` into `Freshness.MinSeq` when the body has none (02 §10). `Freshness` is never key material.

### 44.3 The Cache stage

`Cache.Enabled === false` → `pContext.Cache = { Status: 'Off' }`; the request runs exactly as M2 (digest Version), plus `DependsOn` and the Seq header. Otherwise:

1. `Deps = CacheKey.depSet(pContext, pPlan)`; quick pre-checks of §42.3 (`Mode`, `ForceEngine`, `PlanErrors`, `NoChangeSource`, `ModelReload`) → `Bypass`.
2. `Probe = CacheKey.captureScopes(pContext, Deps)`; `CacheKey.cacheability(…)` → `Bypass` with its Reason (`ResultCache.note('Bypass', Reason)`).
3. `{ Key, Short } = CacheKey.key(…)`; `Dependencies = CacheKey.dependencies(…)`; `GenVector = Generations.vector(Dependencies)`; `SeqAtCompute = ChangeIntake.currentSeq()`; `Version = CacheKey.version(Key, GenVector.Hash)`; `Cacheable: true`; `pContext.ScopeLog = []` (§42.8).
3a. (review §51.50) A `MinSeq` this process cannot prove applied — another epoch, a counter beyond the local one, or (in-process) malformed — skips steps 4–6: no 304, no lookup, no flight; the answer is computed Live, stored, and answered with the **digest** Version (`Reason: 'MinSeq'`, `Status: 'Miss'`).
4. **304:** `pContext.CacheRefresh` false and `If-None-Match` matches `Version` (weak comparison, a list, `*`; `Routes.matchesETag`) → call back `(null, null, { NotModified: true, Version, Cache: { Status: 'NotModified', … }, Statements: 0, Seq: ChangeIntake.currentSeq(), Freshness, ProbeRuns })` — no SQL ran (`ResultCache.note('NotModified')`).
5. `pContext.CacheRefresh` → skip the lookup (`Status: 'Refresh'`), continue to Execute.
6. `lookup = ResultCache.lookup(Key, GenVector, pContext.Freshness, Date.now())`: **Hit** / **Stale** → serve (§44.4); **Miss** → continue (optionally through `ResultCache.flight`).

### 44.4 Serving a cached entry

`Envelope = JSON.parse(entry.Body)`, then: `Version` = `CacheKey.version(Key, entry.GenVectorHash)` (the representation served), `ElapsedMS` = this request's, envelope **and every FacetResult**: `Cached: true`, `Stale` (`true` for Stale), `LagMS` (Stale: the lookup's `LagMS`; Hit: 0), `Exact: !Stale`; `AsOf` and `Engine` stay the entry's. `pMeta.Statements: 0`, `pMeta.ScopeRepaired` from `entry.Meta` or the probes, `pMeta.RecordsDropped` from `entry.Meta`. A **Stale** serve also starts `ResultCache.refresh(Key, fWork)`, where `fWork` runs `queryInternal(pEntity, pBody, <refresh request>, { CacheRefresh: true }, …)` and ignores its result: the refresh request copies `params`, `query`, `headers` minus `if-none-match`, and `UserSession` from the original (same principal → same key), and its answer is stored, never sent.

### 44.5 Version, ETag and 304

| Answer | Version | 304 |
|---|---|---|
| `Cache.Enabled` and cacheable end to end (pre and post checks of §42.3 pass, except `'TooLarge'`) | **generation form** `CacheKey.version(Key, GenVector.Hash)` (computed in §44.3) | before execution when `If-None-Match` matches (§44.3 step 4) |
| Stale serve | `CacheKey.version(Key, entry.GenVectorHash)` | — (the stage compares against the **current** Version only, so a 304 is never stale) |
| everything else (cache off, Bypass, post-check `Errors` / `Staged`, Reference) | the M2 **digest form** (§10.5, §30.2) | after execution, as M2 (`Routes.handleQuery`) |

The generation form changes after any write that bumps a key of the answer's vector (a write by another tenant to a tenant-scoped entity, or another owner's write to an owner-scoped one, does not), and is stable otherwise (no time component except a bound `$Now` bucket through `BindHash`). It never hashes the representation, so it is valid only while every write reaches the intake — hence opt-in (§51.1).

### 44.6 Storing

After Post, when `pContext.Cache.Cacheable` and the post checks pass: `ResultCache.set(Key, { Key, GenVectorHash: GenVector.Hash, MaxTick: GenVector.MaxTick, SeqAtCompute, Body: JSON of the envelope with Version null and ElapsedMS 0, CreatedAt: Date.now(), AsOf: envelope.AsOf, Engine, Meta })` — the vector read **before** execution (§41.5). Errors are never stored (whole-request failures never reach Store; envelopes with `Errors` fail the post check).

### 44.7 Envelope additions

- `Cached`, `Stale`, `LagMS`, `AsOf`, `Exact` (envelope and each FacetResult) per §44.4; computed answers keep `Cached: false, Stale: false, LagMS: 0`.
- `DependsOn: [ 'Client', 'Project', … ]` — `CacheKey.depSet(…).Entities` (sorted; label targets only when readable), on every Query envelope (cache on or off; both engines; not a volatile field). The client refetches on SSE events for these entities (§47.2).
- `normalizeForComparison` keeps stripping `Version`, `AsOf`, `ElapsedMS`, `Engine`, `Cached`, `LagMS`, `Stale`; `Exact` stays (a Stale answer is a different claim).

### 44.8 Headers

| Header | Routes | Value |
|---|---|---|
| `ETag`, `Cache-Control`, `Vary`, `X-Retold-Facet-Contract` | all (M1) | unchanged |
| `X-Retold-Facet-Seq` | Query (200 and 304), Records, Count, Keys | the Seq the answer covers: computed / Miss → `SeqAtCompute` (read before execution); Hit and 304 → `currentSeq()`; Stale → `entry.SeqAtCompute`; Records / Count / Keys → `currentSeq()` read before execution. Sent when `Freshness.SeqHeader` is true, or `'Auto'` (default) on a host **without** a scope policy (review §51.58); never when the intake is `'None'` |
| `X-Retold-Facet-Cache` | Query, only with `Cache.ExposeStatus` (review §51.57) | `Off` \| `Bypass` \| `Miss` \| `Hit` \| `Stale` \| `NotModified` |
| `X-Retold-Facet-Freshness` | Query, only with `Cache.ExposeStatus` | the effective mode, `'; upgraded=ReadYourWrites'` / `'; upgraded=MinSeq'` when §45 upgraded it |

### 44.9 `pMeta` and the in-process API

The query `pMeta` (§18.1, §28.5) gains `Cache: { Status, Reason, Key: Short, GenVector: Hash, LagMS, Coalesced }`, `Seq`, `Freshness: { Mode, Requested, Upgrade }`, `ProbeRuns`, and `NotModified: true` on the 304 path (with `pEnvelope === null`). `Routes.handleQuery`: `pMeta.NotModified` → standard headers + Version + `304`, no body. New service methods: `notify`, `notifyChanged`, `notifyByFilter` (§40.5), `shutdown(fCallback)` (§44.10), and `status()` gains `{ Cache: ResultCache.stats(), Generations: Generations.stats(), Changes: ChangeIntake.stats(), SSE: SSE.stats(), ReadYourWrites: ReadYourWrites.stats() }`. Describe gains `Freshness.ReadYourWritesMS`, `Cache: { Enabled }`, `Changes: { Intake: <Source>, Stream: SSE.Enabled ? '<RoutePrefix>/Changes' : null }`.

### 44.10 attach, model reload, shutdown

- `attach`: after `rebuildCatalog` → `installChangeCapture()` = `ChangeIntake.install()` + the subscriptions of §39.3 (`'Generations'` first, then `'ReadYourWrites'`) + `Generations.subscribe('SSE', (b) => SSE.onBump(b))` (idempotent); `Routes.connect` also calls `SSE.connect(server)` when `SSE.Enabled`.
- Model reload (`rebuildCatalog(pModel, true)`): `ChangeIntake.install()` again (wraps only new controllers), `ResultCache.clear()` (the ModelVersion in every key changed), `SSE.broadcastModelChanged()`.
- **Shutdown:** at attach the service wraps the host service server's `close(fCallback)` once (marker property; wrap the object `fable.Orator.stopWebServer` actually closes — `fable.Orator.serviceServer`, normally `Host.getServiceServer()`): the wrapper runs `RetoldFacetingService.shutdown()` first — `SSE.closeAll('Shutdown')`, `ChangeIntake.shutdown()`, `ResultCache.shutdown()` — then the original `close`. So `fable.Orator.stopWebServer` (and the harness `stop`) completes with streams open, and no timer or socket keeps a Mocha run alive. Every M4 timer is `unref()`'d.

### 44.11 Single flight (review §51.55, §51.56)

Every cacheable miss — and the background refresh — computes through `ResultCache.flight(Key | GenVector.Hash | TimeoutMS)`: a joiner never shares a leader with another timeout. A joiner takes the leader's answer (its own parsed copy, `Coalesced: true`, `Statements: 0`) unless the leader's answer ended `Bypass` for `'Errors'` (e.g. a per-facet timeout at the leader's deadline) or `'ScopeChanged'` — then the joiner computes its own answer outside the flight. A refresh that joins a foreground computation stores nothing itself. A `MinSeq`-unproven request (§44.3 step 3a) never joins a flight.

---

## 45. Read-your-writes (C: `RetoldFacetingReadYourWrites`)

- **Tracking:** `onChange(pEvent)` records `{ Seq, At: Date.now() }` under `pEvent.Actor.PrincipalKey` (skipped when null), in a `Map` bounded by `Freshness.ReadYourWritesMaxPrincipals` (oldest dropped). Entries older than `ReadYourWritesMS` are expired lazily.
- **Upgrade:** `effectiveFreshness(pPrincipal, pFreshness, pNow)` → `{ Mode, MaxLagMS, MinSeq, Requested, Upgrade }`: `Requested = pFreshness.Mode`; `Mode: 'Exact'` stays (`Upgrade: null`); a `MinSeq` (any epoch) → `'Exact'`, `Upgrade: 'MinSeq'`; else when `principalKey(pPrincipal)` wrote within `ReadYourWritesMS` → `'Exact'`, `Upgrade: 'ReadYourWrites'`; else unchanged. Exact is enough for the principal's own (local) writes because generations bump synchronously at intake: an equal vector already includes them. A `MinSeq` this process cannot prove applied (another epoch, or beyond the local counter) is not enough: the Cache stage then skips the lookup and the 304 entirely (§44.3 step 3a, review §51.50).
- **Tracking cost (review §51.54):** a principal already at the newest end of the write-order Map (a bulk write: one event per record) is updated in place, never re-inserted.
- `lastWrite(pPrincipal)` → `{ Seq, At } | null`; `stats()` → `{ Principals, Writes, Upgrades: { ReadYourWrites, MinSeq } }`; `clear()`.
- Without ME-3 the write response carries no `X-Retold-Change-Seq` (§51.6); the tracker is the 04 §8.3 fallback.

---

## 46. SSE (C: `RetoldFacetingSSE`)

### 46.1 Route

`GET <RoutePrefix>/Changes` (`/1.0/Facet/Changes`; `Changes` is a reserved entity name, D-17), mounted by `SSE.connect(pServiceServer)` (idempotent) when `SSE.Enabled` is true, or `'Auto'` (the default, review §51.59) on a host **with** a scope policy — without one every write would reach every stream; `true` is the operator's statement that the host is single-tenant.

0. (review §51.62) A request with an `Origin` header that is neither this host (`new URL(Origin).host === Host`) nor listed in `SSE.AllowedOrigins` (`'*'` = any) → `403 FACET_FORBIDDEN { Reason: 'Origin' }`, before any principal resolves: a cross-site page can neither read a victim's stream nor hold its connection slots.
1. Resolve the principal through `PrincipalResolver.resolve` on a context with `Entity: ''` (the M1 401 rules); a principal whose `Kind !== 'User'` → `401 FACET_UNAUTHENTICATED` (JSON, standard headers). An error → its JSON error.
2. Limits: open connections of this `principalKey` ≥ `MaxPerPrincipal`, of its tenant ≥ the tenant's **fair share** `min(MaxPerTenant, max(1, floor(MaxConnections / active tenants incl. this one)))` (review §51.62; no per-tenant cap without a policy: one bucket is not a tenant), or in total ≥ `MaxConnections` → `429 FACET_RATE_LIMITED` with `Detail: { Limit: 'SSE.MaxPerPrincipal' | 'SSE.MaxPerTenant' | 'SSE.MaxConnections' }` (refuse new, never evict old: no reconnect ping-pong between tabs; every stream ends at its revalidation time, so shares rebalance as tenants come and go).
3. `writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'Vary': 'Cookie, Authorization', 'X-Retold-Facet-Contract': '1' })`, `socket.setTimeout(0)`, `setNoDelay(true)`; write `retry: <RetryMS × [1, 1.5) jittered>\n\n`, then the `ready` event. Restify discipline: the handler never returns a promise and calls `fNext(false)` exactly once, when the stream ends (client close, `closeAll`, revalidation failure); nothing else writes to the response.

### 46.2 Events (UTF-8, one JSON object per `data:` line)

```
event: ready
data: {"NodeEpoch":"e:4f0c2b9e","Seq":"e:4f0c2b9e:12","CoalesceMS":250,"HeartbeatMS":15000,"Reset":false}

id: e:4f0c2b9e:15
event: generation
data: {"Entity":"Project","Generation":"g:7f3a09c1e2d4","Seq":"e:4f0c2b9e:15"}

: hb

event: model
data: {"ModelVersion":"m:4a1e9b0c22d1"}

event: closed
data: {"Reason":"Shutdown" | "Revalidate"}
```

- `generation` carries **only** `Entity`, `Generation` and (optionally) `Seq`: no tenant, owner, column, row id, count or row data. `Generation` is opaque: `'g:' + 12 hex` of sha256(`Generations.BootEpoch` | principalKey | Entity | the largest tick among the bumps forwarded to this connection for this entity) — it changes when the visible data changed and reveals nothing about other tenants' write volume. `Seq` (the latest forwarded bump's) and `ready.Seq` are included when `SSE.IncludeSeq` is true, or `'Auto'` (the default) on a host **without** a scope policy (review §51.58: the node-wide counter would reveal other tenants' write volume). No `id:` line is ever written (events are not replayed).
- `ready.Reset: true` when the request carried `Last-Event-ID` (events are not replayed; the client refetches everything visible). Clients also refetch on every `ready` after their first.
- `model` after a model reload (`broadcastModelChanged`); clients refetch everything visible.

### 46.3 Coalescing, heartbeat, backpressure

(Revised by the review, §51.60–§51.61.) `onBump` runs inside every write, so it only records the entity's pending `{ MaxTick, Seq, Keys, All }` and arms ONE shared flush timer (`CoalesceMS`, unref'd): O(tenant keys of the bump) per record whatever the number of streams. The shared flush filters the candidate connections (their tenant buckets, or every connection for an `All` entity — no policy, or a `'#none'` part), checks §46.4 and writes at most **one** `generation` event per (connection, entity) per window. One shared housekeeping timer (period `min(HeartbeatMS, RevalidateMS / 4)`) sends the heartbeat comment `: hb` (skipped while blocked), closes a stream blocked (`write()` false, no `'drain'`) longer than 2 × `HeartbeatMS` (`Stalled`; its socket destroyed), and revalidates each stream at its `RevalidateMS` (jittered ±10 %). A blocked stream holds its events (coalesced per entity) until `'drain'`.

**Revalidation (review §51.60):** the session a stream opened with is a snapshot (the session layer resolved it once for this request), so it is never re-read from the request object: without a host hook the stream ends with `closed { Reason: 'Revalidate' }` and the client reconnects through the host's full authentication (a logout or a tenant switch then answers 401 / another principal). A host whose sessions live in a store implements `Host.revalidatePrincipal(pRequest, fCallback(pError, pPrincipal))`; an error, a non-User principal or a different `principalKey` then closes the stream, anything else keeps it open.

### 46.4 Authorization of each bump (`onBump(pBump)`)

A bump of entity `E` is forwarded to a connection iff **both**:

1. `Authorizer.canFacet(<connection context>, E)` — computed lazily per entity per connection and cached until revalidation or a model reload; and
2. one of the bump's `TenantKeys` is in `Generations.principalTenantKeys(Principal, E)`: its own tenant key for a `Tenant` entity; its own `Part/o` or `Part/*` for a `Personal` entity (never the plain tenant key, so a colleague's private write is not signalled, 06 §11); for `'*'` see 3.

3. `'*'` bumps (Global / Unscoped entities, unknown tenants): with a policy they are **not** forwarded individually; they are queued per entity and flushed every `GlobalTickMS` to every connection passing 1 (06 §11); with no policy (Kind `'None'`) they are forwarded immediately like tenant bumps. `'#any'` is never forwarded.

Connections are indexed by visible tenant key so a bump touches only candidate connections.

### 46.5 API (C)

```javascript
connect(pServiceServer) → boolean           handleChanges(pRequest, pResponse, fNext)
onBump(pBump)                              broadcastModelChanged()
closeAll(pReason)                          stats() → { Connections, Principals, Tenants, Enabled, Opened, Refused: { <Limit> | Origin: n }, Sent, Coalesced, Heartbeats, Closed, Revalidated, Stalled }
enabled(), includeSeq(), originAllowed(pRequest), tenantCap(pTenantPart), flush(), housekeeping()   // review
connections() → [ { PrincipalKey, OpenedAt, Sent } ]   // tests
```

---

## 47. Client and demo (D)

All paths below are under `example_applications/faceting_demo/`; D owns every file there (DEMO-SPEC.md gains §12 "Live changes (M4)" with the measured numbers).

### 47.1 Provider subscribe API (`source/providers/Pict-Provider-Facet.js`, liftable)

```javascript
subscribeChanges(pDomain)            // open (or reuse) ONE stream per domain for the current principal key: GET <prefix(pDomain)>/1.0/Facet/Changes
closeChanges(pDomain)                // one domain, or every domain when omitted (a principal switch closes all and reopens for the new principal)
changeState(pDomain) → AppData.Facet.Changes[pDomain] = { Status: 'Connecting' | 'Open' | 'Closed' | 'Error', PrincipalKey, LastSeq, LastEventAt, Events, Reconnects }
```

- Transport: `EventSource` when the host needs no custom request headers (a cookie-session app); otherwise (the demo: the persona travels in `X-Retold-Facet-Demo-Principal`, which `EventSource` cannot send) a `fetch()` stream reader with `Accept: text/event-stream` and the provider's request headers, parsed by a pure SSE line parser (`source/providers/Facet-Changes.js`). No persona or ID ever goes into a URL. Reconnect with **jittered** backoff (`retry:` from the server, doubled, max 30 s, × [½, 1]); a `closed` event reconnects too — `'Revalidate'` at once (attempt 0: through the host's authentication), `'Shutdown'` with backoff (review §51.63); a 401 / 403 / 404 / 429 answer stops reconnecting until the next principal change. An SSE-triggered refetch waits a random 0..`ChangeJitterMS` (150) first, so every page that heard one event does not refetch in the same tick. Without a `Seq` on the event (the default on a policy host) the refetch asks `Freshness: { Mode: 'Exact' }` instead of a `MinSeq`.
- Every received event is logged as an exchange of kind `'Change'` for the inspector.

### 47.2 Coalesced refetch

Each group keeps `DependsOn` from its last envelope. On `generation(Entity, Seq)` for domain `D`: every group of `D` whose `DependsOn` includes `Entity` is refetched if it is visible (the existing per-group coalescing: one POST per group per tick, with `Freshness.MinSeq: Seq` and `If-None-Match`), or marked stale (refetched when shown). `ready` (after the first) and `model` refetch every visible group of the domain. The exchange records the trigger ("Live update: Project @ e:…:15").

### 47.3 Inspector

The Envelope tab and the summary strip show `Cached`, `Stale` (+ `LagMS`), `Exact`, `Version` / ETag, `X-Retold-Facet-Cache`, `X-Retold-Facet-Seq`, `X-Retold-Facet-Freshness` and the trigger; 304s keep "304 from cache". A stream status chip per domain (Open / Reconnecting / Off).

### 47.4 "Make a change" panels (real writes through the stock meadow-endpoints CRUD routes, as the demo principal)

| Page | Action | Request (through the front proxy) |
|---|---|---|
| Projects for me | Set the status of a listed project (Active / At risk / On hold / Done); Undo | `PUT /api/ProjectTrack/1.0/Project` `{ IDProject, Status }` |
| Documents by form type | Add a document of the selected form type dated 2026-03-15; Delete it; Undelete it | `POST /api/ProjectTrack/1.0/Document` `{ Title, Status: 'Draft', DocumentDate, IDFormType, IDProject }`; `DELETE …/1.0/Document/<ID>`; `GET …/1.0/Document/Undelete/<ID>` |
| Lab forms (A) | Complete one of my started forms; Re-open it | `PUT /api/LabTrack/1.0/LabForm` `{ IDLabForm, Status: 'Complete' \| 'Pending', CompletedDate }` (the form is a Pending LabForm of mine for a Started work-list row, found through `POST …/1.0/Facet/LabForm/Records/0/1`) |
| Bookstore explorer | Add a 5-star review to the first listed book; Remove it | `POST /api/Bookstore/1.0/Review` `{ IDBook, Rating: 5, Text }`; `DELETE …/1.0/Review/<ID>` |

The panel shows the write's status; the counts then change through the SSE refetch alone (no manual reload). Writes are logged as exchanges of kind `'Write'`.

### 47.5 Demo host

- Domain servers: `Faceting: { Cache: { Enabled: true } }` (SSE defaults); the provider sends `Freshness: { Mode: 'Bounded', MaxLagMS: 5000 }` by default (so `Stale` is observable: e.g. user43 right after user42 adds a document shares the E2 key), `MinSeq` on SSE-triggered refetches.
- **Write guard** (demo host, chain-wrapped through `harness.installBehavior` after boot; the intake wraps the dispatcher, so the two never touch): `Create-PreOperation` stamps the tenant column (and `OwnerIDUser` on `LabForm`) from the session and refuses (403) a body naming another, and (review §51.66) refuses a foreign key (`IDProject`, `IDBook`, `IDFormType`, … by meadow's `ID<Table>` naming) whose row is not in the persona's tenant (a shared lookup: does not exist); `Update-`, `Delete-`, `Undelete-PreOperation` refuse (403) a row outside the session's tenant (and owner on `LabForm`) and a row the persona does not own (`OWNERSHIP_RULES`): a Project it is not an active member of, a Document it neither wrote nor is an active member of the project of, a Review it did not write.
- **Demo-only switches:** `Cache.ExposeStatus`, `Freshness.SeqHeader` and `SSE.IncludeSeq` are `true` on the demo's domains (the inspector shows the cache status and the Seq, and the MinSeq flow is visible); a multi-tenant deployment keeps their defaults.
- Front server (`server/Faceting-Demo-Front.js`): (a) `GET /api/<Domain>/1.0/Facet/Changes` proxied as a **stream** (persona header resolved as for other facet calls, `Accept: text/event-stream` forwarded, no upstream timeout, no buffering, upstream aborted when the browser disconnects); (b) a write **allowlist** — exactly the rows of §47.4 (method + path pattern + permitted body keys; JSON only, ≤ 16 KiB); anything else under `/api/<Domain>/1.0/` stays `404 DEMO_NOT_FOUND`, extra body keys `400 DEMO_WRITE_INVALID`; (c) keep `x-retold-facet-*` response headers (already). `/api/Demo/Status` adds each domain's `faceting.status()` `Cache` / `Changes` / `SSE` stats.

### 47.6 Demo checks

- `npm test` (smoke, port 19301): for each §47.4 action as user42 — the write answers 2xx through the proxy; a stream opened as user42 receives a `generation` event for the entity within 2 s while a stream as user81 (tenant 8) receives none for it; the dependent group's refetch (with its pre-write ETag) answers 200 with the expected delta; an unaffected group's request with its old ETag answers 304 and `X-Retold-Facet-Cache: NotModified`; a repeat request answers `Hit`; user43's E2 request issued right after user42's Document write and before any refetch answers `Stale: true` (user42 and user43 share the E2 key: same tenant, nothing bound to `$CurrentUser`), and a later one is fresh; undo restores the totals. The smoke leaves the data as it found it.
- `npm run check:browser` (port 19302): every page's "Make a change" updates the affected card without a manual refetch; the inspector shows Cached / Stale / Version; new screenshots `28`–`31`; the existing 141 checks stay green.

---

## 48. Errors (M4)

No new codes. `429 FACET_RATE_LIMITED` (`Detail: { Limit }`) for SSE limits; `401 FACET_UNAUTHENTICATED` for an anonymous stream; `400 FACET_REQUEST_INVALID { Field: 'Freshness' | 'Freshness.Mode' | 'Freshness.MaxLagMS' | 'Freshness.MinSeq' }`. Intake, notify, generation, probe and cache failures are never client errors: they log (no values) and degrade to M2 behavior.

---

## 49. Tests (O7) and ports

### 49.1 Obligations per file

| File (owner, port) | Must prove |
|---|---|
| `test/Facet-Generations_tests.js` (A, no server) | the key grammar (`tenantKey` / `genKey`, encoding, `'*'` / `'#any'` / `'#none'` / `t/*`); `applyChange` for every Operation × Kind row of §41.2–§41.3 (exact key sets: column precision, `'#row'` for delete / tenant / owner / identity / Required columns, `'#cols'`, `'*'` for Global / Unscoped, owner-qualified keys and `t/*` for unknown owners, both tenants on a move, `'#any'` always); granularity `'Entity'`; one tick per event; `vector` determinism and sensitivity (a bump outside the deps leaves the hash unchanged, inside changes it); eviction floors with tiny bounds: no ABA (entry that saw the last bump stays valid, older one invalid), per-tenant isolation of floors, floor-map overflow → GlobalFloor; `foldTenantKeys` / `principalTenantKeys`; bump listeners isolated by try/catch |
| `test/Facet-ResultCache_tests.js` (A, no server) | LRU by entries and by bytes, `MaxEntryBytes` refusal, `MaxAgeMS` expiry, newer-`MaxTick`-wins, the §43.3 table for every mode (Exact never stale), `LagMS`, single-flight `refresh` (N concurrent stale lookups → 1 work), `flight` waiters share one result, errors never stored, every metric |
| `test/Facet-CacheKey_tests.js` (A, 19132) | `depSet` (hops, label targets gated, `'#cols'` with Records, TenantOnly); probes (no SQL, scratch counters, Opaque / PostOperation / 401 / controller-less → Bypass reason, never an error); `cacheability` table; key material never contains a SessionID or request header (two sessions of one principal share a key; same-tenant users share over a tenant-only entity; `$CurrentUser` scope, owner-scoped `LabForm` and a tenant switch split it; clause Hash differences split it); `dependencies` per Kind; `version` shape |
| `test/Facet-ChangeIntake_tests.js` (B, 19133) | over HTTP on ProjectTrack / LabTrack / Bookstore-Tenant: single Create, bulk Create, Update (PUT and PUT/PATCH by id), bulk Update, Upsert (create and update paths), Upserts, Delete, Undelete each emit exactly the §40.3 events (Operation, IDs, Tenants incl. both on a move and `'*'` without a pre-image, Owners, ChangedColumns diff, KeyImages, Actor.PrincipalKey = `principalKey` of the read principal, Seq monotonic and well-formed); a pre-existing PostOperation installed before attach and one installed after both still run, in order, with the controller as `this`; a previous behavior that errors / throws still yields one event and the same client response; a throwing subscriber leaves the 2xx response and the other subscribers intact; the event is delivered before the client sees the response; `install` is idempotent across a model reload (no double events); DAL-direct writes produce nothing; `notify` / `notifyByFilter` shapes, validation (`null` + warn, never throw), settle re-delivery (`NotifySettleMS` small); the Bus adapter against a fake bus |
| `test/Facet-SSE_tests.js` (C, 19134) | 401 anonymous; headers, `retry`, `ready`; a bump in the principal's tenant → one `generation` with only `{ Entity, Generation, Seq }`; another tenant's bump → nothing; Personal: own owner key forwarded, a colleague's not; `'*'` only through the global tick (small `GlobalTickMS`); no policy → immediate; non-facetable entity never; coalescing (many bumps in `CoalesceMS` → one event); heartbeat; 429 per principal / tenant / total; revalidation closes on a changed principal; `closeAll` ends streams and `harness.stop` completes with streams open; no timer survives |
| `test/Facet-ReadYourWrites_tests.js` (C, 19135) | upgrade within `ReadYourWritesMS`, not after, not for another principal; `MinSeq` (own, foreign, malformed is the normalizer's 400); bound on tracked principals |
| `test/Facet-Invalidation_tests.js` (wiring, 19136; PostgreSQL half gated; the file the M4 brief names, replacing the `Facet-Cache-M4_tests.js` skeleton) | end to end with `Cache.Enabled`: writes through every endpoint kind and `notify` / `notifyByFilter` bump exactly the expected keys (via a Generations listener) and invalidate exactly the dependent answers: dependent folds miss, unrelated folds hit (assert `stats()`), a `Title` edit does not invalidate a `Status` facet, a label-column edit invalidates the labelled facet, a global-lookup (`FormType`) edit invalidates every tenant; Exact never stale; Bounded `Stale: true` within `MaxLagMS`, one background refresh, then fresh; Fast; ETag stable / changes after a write; the 304 path runs no SQL (`Statements: 0` and a provider spy) and only after authorization (401 / 404 / 403 still win); tenant A's writes never invalidate tenant B's entries; owner-scoped isolation; read-your-writes and `MinSeq` upgrades through HTTP; `X-Retold-Facet-*` headers; cache off = M2 behavior (digest Versions, no 304 short-circuit, no lookups; the envelope differs only by `DependsOn`); uncacheable Reasons; shutdown with open streams; on PostgreSQL: write → miss → fresh counts and the 304 path |
| `debug/m4-smoke.js` (wiring, 19192) | a manual run: E1 query, a write, the event, the miss and the hit |
| demo smoke / browser check (D, 19301 / 19302) | §47.6 |

Keep `npm test` fast: SSE / RYW / refresh tests use small `CoalesceMS`, `HeartbeatMS`, `GlobalTickMS`, `ReadYourWritesMS`, `NotifySettleMS`, and wait on conditions (stats, events) rather than fixed sleeps where possible.

**Review additions (§51.46–§51.66):** `test/Facet-Invalidation-Review_tests.js` runs the write-path obligations on BOTH meadow-endpoints versions — the harness's `MeadowEndpoints: 'Installed' | 'Monorepo'` option builds the endpoints with the umbrella's 4.0.21 or `modules/meadow/meadow-endpoints` (4.1.x; the suite skips when the checkout is absent): `PUT { Deleted: 1 }`, a tenant move under an `Update-QueryConfiguration` filter, a `Create-QueryConfiguration` filter the new row fails and a bulk update's per-record failure all bump (and the Exact answer equals the Reference oracle); a mutating `Update-PreOperation`; a plain `setBehavior` after attach; a replaced dispatcher; `NoChangeSource`; the bump at PostOperation entry; then once: scope drift (`ScopeChanged`, never stored, never shared with a joiner), an unprovable `MinSeq`, `ModelReload`, per-timeout flights, the refresh joining the flight, and the client-visible defaults (no Seq / cache headers on a policy host, `Cached: false` on another principal's hit; the Seq header and no stream without a policy). Unit additions: Generations (group eviction, pinned keys, entity floors, a 50k-bump hot-path bound, `'Auto'` from `MaxBytes`, fail-closed apply), ResultCache (refresh cap, approximate LRU), ChangeIntake (the DAL failure path, rewrap, coverage, coalesced settles, linear 50k-id notify and the caps, unknown-tenant counting), SSE (Origin, fair share, stalled streams, revalidation by reconnect, `IncludeSeq` default).

### 49.2 Port registry additions

| Port | File |
|---|---|
| 19130 | `test/Facet-Generations_tests.js` (A; only if it boots a server) |
| 19131 | `test/Facet-ResultCache_tests.js` (A; only if it boots a server) |
| 19132 | `test/Facet-CacheKey_tests.js` (A) |
| 19133 | `test/Facet-ChangeIntake_tests.js` (B) |
| 19134 | `test/Facet-SSE_tests.js` (C) |
| 19135 | `test/Facet-ReadYourWrites_tests.js` (C) |
| 19136 | `test/Facet-Invalidation_tests.js` (wiring) |
| 19137 | `test/Facet-Invalidation-Review_tests.js` (wiring, the review fixes; write paths on both meadow-endpoints versions) |
| 19192 | `debug/m4-smoke.js` (pinned) |
| 19301–19305 | the demo's own checks (19301 smoke, 19302 browser check); 19300 is the demo server, never used by a builder |

---

## 50. File ownership and the shared-file protocol

| Owner | Files (M4) |
|---|---|
| **A** | `source/cache/Retold-Faceting-Generations.js`, `source/cache/Retold-Faceting-ResultCache.js`, `source/security/Retold-Faceting-CacheKey.js`, `test/Facet-Generations_tests.js`, `test/Facet-ResultCache_tests.js`, `test/Facet-CacheKey_tests.js` |
| **B** | `source/change/Retold-Faceting-ChangeIntake.js`, `source/change/Change-Intake-Interim.js`, `source/change/Change-Intake-Bus.js`, `test/Facet-ChangeIntake_tests.js` |
| **C** | `source/routes/Retold-Faceting-SSE.js`, `source/change/Retold-Faceting-ReadYourWrites.js`, `test/Facet-SSE_tests.js`, `test/Facet-ReadYourWrites_tests.js` |
| **D** | everything under `example_applications/faceting_demo/` (incl. `DEMO-SPEC.md` §12, its README, screenshots) |
| **wiring** | `source/Retold-Faceting-Service.js`, `-Service-Options.js`, `-Util.js`, `-Installers.js`, `source/routes/Retold-Faceting-Routes.js`, `source/engine/Retold-Faceting-Router.js`, `source/contract/Facet-Contract-Request.js` (Freshness), `source/contract/Facet-Contract-Envelope.js` (`DependsOn`), `source/request/Retold-Faceting-RequestNormalizer.js`, `source/host/*` (beyond `entityScopeColumns`), `README.md`, `docs/internal-contracts.md` after the builders, `test/Facet-Invalidation_tests.js`, `debug/m4-smoke.js`, and every earlier test whose expectations M4 alters (e.g. an exact envelope key list gaining `DependsOn`) |
| **shared** | `test/Facet-Smoke_tests.js` (anyone ADDS assertions), `source/contract/Facet-Contract-Errors.js` (add codes only), `source/contract/Facet-Contract-Util.js` (add helpers only) |

Protocol (M2 §35, unchanged): edit only your files; a contract change is made **here first** with a line in §51; shared files by string-replacement `Edit` only (re-read first, add rather than remove); fix (never weaken) an earlier assertion your contracted change breaks, and say so; `npm test` green after every change; `npm run test:pg` green before you report; umbrella `node_modules` only, Node 22 `fetch`, ephemeral ports (except smoke scripts), Retold style, Mocha TDD, never `git add` / `commit` / `push`, never modify files outside this module, docker only for `rfs-test-postgres`; a demo server may be running on 19300 — leave it alone, use 19301–19305 and stop what you start. Builders may build against each other's **skeletons**: B and C test their services with direct calls (synthetic events / bumps) where the other service is not done yet; the end-to-end paths are the wiring's.

---

## 51. Ambiguities resolved / M4 deviations from the design

1. **The cache and the generation Version are opt-in (`Cache.Enabled: false` by default).** The design (05 §1.1) puts the cache on by default behind the L1 DAL hook (M-1). Without it the interim intake sees only endpoint writes; a host whose importers, DAL calls or raw SQL do not `notify()` would get stale answers and stale 304s. `Cache.Enabled: true` is the operator's statement that every write reaches the intake; it turns on the result cache, the generation Version and the 304 short-circuit together. With it off, the M2 representation-digest Version (G3) stays, so every earlier expectation holds (only an exact envelope key list sees the new `DependsOn`). The intake, generations and SSE are on by default (`ChangeCapture.Intake: 'Auto'`, `SSE.Enabled: true`): they never change an answer.
2. **`Freshness.DefaultMode` stays `'Exact'`** (design: `'Bounded'`); the demo opts into `Bounded`.
3. **Whole-envelope entries** (one entry per request Key) rather than per-Agg entries (09 §3.1): the cube composes facets into one statement, and the per-request key is what the ETag needs. Per-Agg reuse across different requests is a later optimization.
4. **The cache key's scope comes from per-entity probes** (§42.2) run before execution, because M2 captures happen inside the engines (after the point where a hit or a 304 must be decided). The probe uses the entity's own `Reads-QueryConfiguration` exactly like a hop relation without client conjuncts; client-operator transforms are covered by the client conjuncts in the key plus the 06 §7 determinism rule (`FacetCacheable: false` opts out). Probes are not counted against the M2 behavior budget.
5. **Owner-qualified keys gain `Part/*`** for writes whose owner is unknown. 05 §6.1 says "unknown owner → the tenant key only", which an owner-qualified fold does not read, so such a write would leave its entries valid. Every owner-qualified fold also reads `Part/*`.
6. **No `X-Retold-Change-Seq` on write responses** (that is ME-3; a PostOperation behavior has no response object). Read-your-writes is the tracker (04 §8.3 fallback); `MinSeq` is accepted and upgrades to Exact.
7. **`LagMS` of a Stale answer is its age** (`now − CreatedAt`), an upper bound of its true staleness, so `Bounded` never serves an answer staler than `MaxLagMS`.
8. **No no-op suppression** (05 §3.3 `NoOpIgnoreColumns`): meadow stamps `UpdateDate` on every update, and an `UpdateDate` facet must see it.
9. **`DeleteByFilter` is folded into `EntityDirty`**, and filters are carried, never executed (no materializer in M4).
10. **SSE `Generation` is opaque** (per principal, per entity) instead of a raw tick, and `'*'` bumps go through the global tick, so the stream reveals neither other tenants' activity nor the node's write volume through the generation. The `Seq` (in `ready`, `generation` and the `X-Retold-Facet-Seq` header) is the node's change counter and does reveal the aggregate write rate; since the review both switches default to `'Auto'` — off on a host with a scope policy (§51.58).
11. **SSE coalesces at 250 ms** (the brief) instead of 5 000 ms with burst suppression (02 §10); limits refuse (429) instead of evicting.
12. **SSE events for a `Personal` entity are owner-qualified**, so a `TenantOnly`-relaxed facet (E3) is not pushed a colleague's completion (06 §11); it refreshes on its next request (its Version does read the tenant key).
13. **Records-bearing Query bodies are cacheable** (the pivot reads `'#cols'`) unless the pivot has read-side behaviors (`RecordsPostOperation`). Records / Count / Keys routes are never cached (D-38) and keep their digest Versions.
14. **Opaque answers are never cached** (`Cache.OpaqueTTLMS` and `Scope.DependsOn` are reserved).
15. **Intake adapters are plain classes**, the third module kind besides services and pure modules (§38.2).
16. **Envelopes with any `Errors` entry are neither stored nor given a generation Version** (a transient per-facet error must not become a 304-able answer).
17. **The 304 short-circuit compares only the current generation Version**; a client holding a Stale Version gets a 200.
18. **`DependsOn`** is a new envelope field (sorted entity names the answer depends on; readable entities only) so clients can match SSE events to visible groups without knowing the plan.

### As built (wiring pass): decisions the builders and the wiring made beyond the text above (items continue the numbering)

Wiring:

19. **`CreatedAt` of an entry is the moment its GenVector was read** (before execution, `pContext.Cache.VectorAt`), not the store time: a Stale `LagMS` (the entry's age) then always covers the execution time too, so `Bounded` never serves an answer staler than `MaxLagMS` (§51.7).
20. **Post-execution Bypass** (`Errors`, `Staged`): `X-Retold-Facet-Cache: Bypass` with the Reason in `pMeta.Cache.Reason`, the digest Version, nothing stored; the lookup's `Miss` was already counted (`Misses` counts lookups, `Bypass[Reason]` counts uncacheable answers). `TooLarge` keeps `Status: 'Miss'` and the generation Version (valid without an entry, so a later `If-None-Match` still 304s before execution), with `Reason: 'TooLarge'`, counted as `Bypass.TooLarge` and `Rejected`.
21. **Single flight is used for every cacheable miss** (`FlightKey = Key|GenVector.Hash`). Joiners get their own copy parsed from the stored form (`Body`), their own `ElapsedMS`, the leader's Version, and `pMeta { Statements: 0, Relations: 0, BehaviorRuns: 0, Cache.Coalesced: true }` (they ran no SQL). The background refresh never joins a flight.
22. **The background refresh** is a full `queryInternal` with `CacheRefresh: true` and the original `Now` / `PlanForm` internal options; its Freshness is forced `Exact` without consulting read-your-writes (its upgrades are not counted), and it skips the lookup (`Status: 'Refresh'`).
23. **`X-Retold-Facet-MinSeq`** is read by the Shape stage (every mode) when the body has no `MinSeq`; a malformed header is `400 FACET_REQUEST_INVALID { Field: 'Freshness.MinSeq' }`, like a malformed body value. `normalizeRequest` shape-checks `Freshness` in every mode; only a Query reads it.
24. **One Seq grammar**: `SEQ_PATTERN` lives in the pure `Facet-Contract-Request.js` (a client validates `MinSeq` with it); `Retold-Faceting-Util.SEQ_PATTERN` is the same object. `FRESHNESS_MODES`, `FRESHNESS_DEFAULTS`, `resolveFreshnessSettings` and `normalizeFreshness` are exported there too.
25. **`If-None-Match: *`** matches the current generation Version (M1's `'*'` rule), so it is a 304 before execution once authorization passed; a Stale answer's route never turns into a 304, even after execution (§51.17).
26. **`buildEnvelope` adds `DependsOn` only when it is given** (the service always gives it for a Query, both engines); Records / Count / Keys answers and older callers are unchanged.
27. **`installChangeCapture()`** (attach, every reload; public) also warns when `Cache.Enabled` is on with no change source installed (`ChangeCapture.Intake: 'None'` / no bus): only `notify()` then moves generations, so an unnotified write leaves a cached answer and its 304 stale (tested).
28. **The shutdown hook** wraps `fable.Orator.serviceServer.close` (else `Host.getServiceServer()`) once, marked `Symbol.for('RetoldFaceting.Shutdown')` (exported as `SHUTDOWN_MARKER`); `shutdown(fCallback)` is idempotent. SSE socket-destroy fallbacks (unref'd) clear as each socket closes, which can be a tick after the server's `close` callback.
29. **Describe** `Changes.Stream` follows `SSE.Enabled`; `status().Cache` carries `Enabled` beside the ResultCache metrics. The service exports `CACHE_STATUSES` and `SHUTDOWN_MARKER`.
30. **The demo browser check centers the pivot cell before its real click**: puppeteer only scrolls an element that is out of view, and a cell at the viewport's bottom edge sits under the fixed inspector bar (the click opened the drawer instead). Checked: nothing covers the cell once centered.

Builder A (generations, cache key, result cache):

31. `CacheKey.precheck(pContext, pPlan)` is the §44.3 step-1 check (Mode, ForceEngine, PlanErrors). `cacheability()` fails closed: no probe, or a probe without a capture for some DepSet entity, is `'ProbeError'`. An untrusted Opaque entity (the guard refuses its capture, so it is absent from `Captures`) reports `'Opaque'`, like a trusted Opaque capture.
32. The scope part of the key carries `[ Entity, Fingerprint, { Appended, Transformed, Behavior, ScopeMode, Required, Repaired, PostOperation } ]` plus `ContextWarnings`: in Repair mode the guard adds the tenant predicate after the capture's diff, so the fingerprint alone could let two tenants share a key.
33. With `Records`, `depSet` adds every `FilterAST.Entities` entity (with `'#cols'` and its structural columns): the Records rows are the full filter's, whatever Variant the facets planned.
34. Generations: `clear()` raises `GlobalFloor` to `GlobalTick` (no ABA through a clear); `bumpEntity` notifies the bump listeners; a Personal entity without a tenant column uses `'#none'`; a Personal fold of a principal with no tenant value reads `[ '#any', '*' ]`.
35. ResultCache: `set()` computes `Bytes` (and `CreatedAt` when absent), freezes the entry, refuses malformed or error entries, and returns whether the entry survived eviction (false also when a newer `MaxTick` is kept); `refresh()` runs its work on `setImmediate`; `refreshing(key)` is public and a stalled refresh releases its key after `max(60 s, 2 × Limits.TimeoutMS)`; `Flights` counts work runs started; `shutdown()` also forgets flights.

Builder B (intake):

36. An Update with no before-image lists the submitted model columns **without the primary key** (it only locates the row; including it would make every such update a `'#row'` bump).
37. The audit columns `UpdateDate` / `UpdatingIDUser` are added only when the entity's model has them (FormType / LabFormType updates report just their own columns).
38. `notify({ Records })` for a record without a matching `Before`, with `ChangedColumns` absent or null, adds `'*'` to `Tenants` (and an unknown-owner pair): the §39.2 unknown-old-tenant rule applies to notify too.
39. Interim wrappers go inert once the intake's source is no longer `'Interim'` (no double events when the Bus arrives); after `shutdown()`, `notify` still delivers but arms no settle re-delivery.
40. Only `Catalog.entities()` are wrapped: under a policy an entity without the tenant column must be in `Catalog.GlobalEntities` to be facetable, hence captured. ~~Host code that later calls a plain `setBehavior` on a wrapped slot silently replaces the wrapper.~~ Superseded by §51.46: the dispatcher is wrapped, never a slot. meadow-endpoints error bodies carry a debug `Stack` that gains one frame (the wrapper); the rest of the error response is byte-identical.
41. A Personal entity with no tenant column produces `Tenants: [ '*' ]` with `Owners` carrying `Tenant: '#none'`; Generations then bumps `'*'` (over-invalidation, safe; owner isolation is lost for such an entity — no fixture has one).

Builder C (read-your-writes, SSE):

42. Read-your-writes ignores notify settle re-deliveries (`ChangeID` ending `'~settle'`); `ReadYourWritesMS ≤ 0` turns write tracking off (`MinSeq` still upgrades); a malformed `MinSeq` from an in-process caller still upgrades to Exact and is reported as `MinSeq: null`; `lastWrite(pPrincipal | pPrincipalKey, pNow?)`.
43. SSE indexes connections, and counts `MaxPerTenant`, by `Generations.tenantKey(ScopeValues[Policy.Column])` (one `'*'` bucket without a policy). Bumps keyed `'#none'`, and `'*'` bumps on a host without a policy, go to every connection that passes the checks; under a policy the global tick runs from the first `'*'` bump until the last stream closes; `GlobalTickMS` is clamped to ≥ 10 ms.
44. A server-initiated close (Shutdown, Revalidate) also ends the TCP connection, with a 1 s unref'd destroy fallback; a refused stream (401 / 429 / 500) ends the chain with `fNext(false)`; a client that disconnects while its principal resolves is never registered. `Sent` counts every event but not the `retry:` frame or heartbeats; `timerCount()` and the static `CLOSE_REASONS` are test helpers; SSE settings are read at use time (tunable on the live options object).

Builder D (demo):

45. The Bookstore card reviews the first listed book **without** a 5-star review (so the counts move); an answer without `DependsOn` is refetched for any change of its domain; a page with no open stream refetches itself after a write and says so; the stream stops reconnecting on 400 / 401 / 403 / 404 / 405 / 406 / 429 / 501 (anything else backs off and retries).


### Review fixes (after the M4 build; items continue the numbering)

46. **The interim intake wraps the dispatcher, not the slots** (§40.2 note). A host's ordinary single-slot `setBehavior` after attach replaced the slot wrapper silently (and a re-install trusted a marker set); wrapping `BehaviorInjection.runBehavior` means no slot assignment can remove the intake, the host's slot functions stay its own, and `_BehaviorFunctions` is never touched.
47. **Pre-images are snapshotted at `*-PreOperation` entry.** `Record` and `OriginalRecord` are one object until the DAL update; a PreOperation that merged `RecordToModify` into it rewrote the "before" image (the real change and the old tenant vanished). Without a snapshot (a test calling a slot directly) the submitted columns join the diff and a submitted policy column whose images agree adds the unknown tenant / owner.
48. **Coverage is checked per request** (§40.8): a replaced dispatcher is re-wrapped and its entity invalidated before the lookup; an entity no source sees is `Bypass 'NoChangeSource'` unless `ChangeCapture.NotifyManaged` names it.
49. **Probe / execution scope drift** (§42.8): an answer computed under a scope its key does not name is never stored or shared (`'ScopeChanged'`); a joiner computes its own answer. This closes the cross-principal leak where a membership change between the probe and the execution stored a wider answer under a narrower key.
50. **An unprovable `MinSeq` skips the cache and the 304** (§44.3 step 3a) and is answered with the digest Version. The cache is correct only while every writer runs in this process: generations live in one process (stated on `Cache.Enabled` and in the README) until the upstream bus exists.
51. **ModelVersion is snapshotted in `newContext`** (key material) and a mismatch at the Cache stage is `Bypass 'ModelReload'`: an old-model plan is never stored under the new ModelVersion.
52. **The bump happens at PostOperation entry** (the row is committed), before the host's own PostOperation behaviors: a slow or never-calling-back host behavior no longer decides how long Exact hits and 304s stay stale.
53. **Generations: group eviction, pinned `'*'` / `'#any'` groups, per-entity floors, a MaxTick vector hash** (§41.5–§41.6). The single GlobalFloor made every eviction past the floor bound move every fold's vector in every tenant (and a cross-tenant ETag churn signal); keys are now evicted per (Entity, TenantKey) group, the pinned groups never fall back to a floor, an overflowing floor raises only its entity's floor, and the hash covers the dependency keys and their max tick. Residual: an idle tenant's group evicted under another tenant's pressure changes that tenant's vector only when its own last bump is newer than every key a fold reads (rare; only ever invalidates more). Per-tenant key budgets are an M5 option.
54. **No Map re-insertion on hot paths** (P3): Generations and the ResultCache stamp a use counter and evict the least recently used of the 16 oldest-inserted entries; ReadYourWrites updates the newest writer in place.
55. **Single flight per timeout; joiners never inherit `Errors` / `ScopeChanged`** (§44.11): a joiner with a longer deadline no longer receives the leader's per-facet timeouts, one with a shorter deadline no longer waits past its own.
56. **Background refreshes through the flight, at most `Cache.MaxConcurrentRefreshes` at once** (§43.4).
57. **`Cache.ExposeStatus`** (default false): `X-Retold-Facet-Cache` / `-Freshness` only for operators and demos; a hit on an entry another principal computed says `Cached: false` (entries record `By`), so the envelope no longer tells a user that a colleague ran the same query. `Stale` stays truthful. Residual: `ElapsedMS` remains a weak timing signal.
58. **`Freshness.SeqHeader` / `SSE.IncludeSeq` default `'Auto'`**: the node-wide Seq is sent only on a host without a scope policy; the SSE `id:` line is gone. Rejected for M4: per-principal HMAC-wrapped Seq tokens (the server would have to map them back for `MinSeq`); clients on policy hosts refetch with `Mode: 'Exact'`.
59. **`SSE.Enabled` default `'Auto'`** (mounted only with a scope policy); a probe that sees appended scope filters on a host without a policy logs a warning (generations and the stream cannot isolate tenants there); the bind warning no longer claims facets equal anonymous lists.
60. **Revalidation by reconnect** (§46.3): the stream never trusts the session snapshot it opened with; `Host.revalidatePrincipal` is the optional keep-open hook.
61. **SSE fan-out off the write path** (§46.3): `onBump` is O(tenant keys); one shared flush, one shared housekeeping timer (no per-connection timers); streams blocked > 2 × `HeartbeatMS` are closed. Rejected: dropping audit-column-only bumps (a Records-bearing answer reads `'#cols'`, so an `UpdateDate`-only write can change what a client shows); clients jitter instead (§47.1).
62. **SSE `Origin` check, per-tenant fair share, no tenant cap without a policy** (§46.1). Kept: refuse-new for `MaxPerPrincipal` (evicting the oldest reintroduces tab ping-pong; the Origin check removes the cross-site slot-holding attack it was meant to stop).
63. **The demo client reconnects after `closed`** (Shutdown with jittered backoff, Revalidate at once) and jitters SSE-triggered refetches.
64. **Unknown-tenant notifies are counted and warned about; `ChangeCapture.RequireNotifyTenants`** refuses them (§40.5).
65. **notify() is linear and capped** (`MaxEventIDs`, `MaxEventOwners`), and **settles coalesce per (Entity, Operation)** per window (§40.5).
66. **Demo write guards read the rows they protect** (§47.5): foreign keys into another tenant's data, a colleague's document and a project the persona is not a member of are 403.
67. **Documented, not changed:** `Required` policy columns (a sub-tenant restriction such as a department) share the tenant-level generation keys and stream signalling (S5): their writes invalidate and signal every principal of the tenant. A `TenantOnly`-relaxed fold over a `Personal` entity (E3) is invalidated by a colleague's write but not *pushed* (§51.12): it refreshes on its next request (poll it, or refetch on any event of the entity). Both are M5 options (Required-qualified keys; an Entity-only signal for TenantOnly readers).
68. **Rejected (perf, minor):** answering hits from a deep-frozen parsed envelope instead of `JSON.parse(Body)` (about 40 µs on a 16 KB envelope; the string form is what guarantees no caller can mutate a stored answer) — only the needless `JSON.stringify` of answers no joiner may take is gone; memoizing the Planner output per normalized request (plans are decorated by later stages; an M5 optimization with its own invalidation).
69. **Per-record write-path work is memoized** (P13): `Host.entityScopeColumns` per policy object, the writer's principal per request, Buffers compared with `Buffer.equals`.
70. **Verification runs never rewrite tracked files**: the demo browser check writes screenshots to a scratch directory unless `DEMO_UPDATE_SCREENSHOTS=1`.
---

## 52. Seams for M5

| Seam | M4 behavior |
|---|---|
| Upstream `MeadowChangeBus` (M-1) + `ChangeContext` (ME-3): `Touch` for committed-but-unread updates, DAL-direct writes, `X-Retold-Change-Seq` on writes | Bus adapter no-op; interim wrappers |
| Multi-subscriber behaviors (ME-1 `addBehavior`) | used when present, else chain-wrapped |
| Durable change log, Agent change feed, multi-node log tail, ProxyTap | not present |
| Sweep / Bisect / Scrub, parity canary | not present (raw writers must `notify`) |
| Stores (ClickHouse / Solr), `ApplyToken`, `AppliedSeq`, `applied` SSE events, `MinSeqWaitMS` | Live only; MinSeq → Exact |
| `Cache.OpaqueTTLMS`, `Scope.DependsOn` (cacheable Opaque / decorated answers) | never cached |
| Per-Agg cache entries, shared cache across instances | whole-envelope, in-memory, per process (every writer must run in the process, §51.50) |
| Per-principal Seq tokens (an HMAC-wrapped Seq a policy host may hand out) | the Seq is not sent on a policy host by default (§51.58) |
| Required-qualified tenant keys; an Entity-only signal for TenantOnly readers of a Personal entity | tenant-level keys and signals (§51.67) |
| Per-tenant generation key budgets | group eviction + per-entity floors (§51.53) |
| Plan memoization; frozen-envelope hits | per request (§51.68) |
| Automatic `GenerationGranularity: 'Entity'` on high floor-raise rates | manual option only |
| GET Query form (HTTP caching for widgets) | not mounted |
| SSE replay from `Last-Event-ID` | `ready.Reset: true` → client refetch |


---

# Part IV — Milestone 5: the ClickHouse store

> **Binding for M5.** Part IV wins over Parts I–III wherever they conflict; §53.2 lists every earlier rule it changes. Where Part IV and the design set disagree, Part IV wins for M5 and §68 lists each deliberate deviation. The M5 builders are **A** (store contract, ClickHouse client, type map, DDL, the ClickHouse store's connection / registration / schema / state / write side, MirrorSpec and the Materialize schema), **B** (materializer: PendingSet, WriterClock, WriterLoop, FlushBuffer, MaterializeSource-InProcess, Freshness), **C** (the ClickHouse fold compiler and `EngineClickHouse`), **D** (Rebuilder, Reconciler, the O10 chaos suite) and the **wiring** agent (Router and service integration, Describe, envelope, harness `Store` option, O3 conformance, `debug/m5-smoke.js`, the demo toggle); §67 is the ownership table. Design references: `04` (authoritative: §2–§10, §13, §14), `05 §6.4 / §8 / §10–§12`, `03 §10–§11`, `06 §4.2–§4.3 / §12`, `09 §4.4–§4.6, §4.9, §4.13–§4.15, §4.26, §4.29, §4.31–§4.33`, `10 §5.1` (O3, O10).

---

## 53. Overview, precedence, services, options, context

### 53.1 What M5 adds

| Area | Addition | Owner |
|---|---|---|
| Store contract | `RetoldFacetingStoreBase` (04 §2, split: the write side and lifecycle on the store, the query side on an engine, §54) | A |
| ClickHouse client | `ClickHouse-Client.js`: dependency-free HTTP client lifted from Sluice, callbacks, `{name:Type}` parameters, settings passthrough, 64-bit normalization, JSONEachRow insert with `insert_deduplication_token`, ping, a test fault injector (§57) | A |
| ClickHouse store | `RetoldFacetingStoreClickHouse`: feature-not-boot registration, database `rfs_<InstanceKey>`, DDL (mirror, keymap, `_rfs_entity_state`), the write-side contract, shadow tables, state, checksums (§54, §56) | A |
| MirrorSpec | `RetoldFacetingMirrorSpec` + `Materialize-Schema.json`: which entities and columns are mirrored, sort keys, SpecHash, the closure rule (§55) | A |
| Materializer | `RetoldFacetingMaterializer` + per (store, entity) `PendingSet`, `WriterLoop`, `FlushBuffer`, per store `WriterClock`; `MaterializeSource-InProcess` (trusted DAL reads, no behaviors); event → pending; latest-read-wins cycles; one mirror INSERT per flush; keymap; AppliedSeq after the ack; crash safety (§58) | B |
| Freshness | `RetoldFacetingFreshness`: per (store, entity) state machine, `ObservedSeq` / `AppliedSeq` / `LagMS`, admission per request Freshness mode, circuit breaker per (engine, entity) (§61) | B |
| Rebuild / reconcile | `RetoldFacetingRebuilder` (backfill, shadow + `EXCHANGE TABLES`, wipe recovery) and `RetoldFacetingReconciler` (Sweep, Bisect, Scrub, Unverified recovery, admin triggers) (§59, §60) | D |
| Compiler / engine | `ClickHouse-FoldCompiler.js` (FoldIR + captured scope → ClickHouse SQL, every kind Live supports) and `RetoldFacetingEngineClickHouse` (`capable` / `freshness` / `execute`) (§63, §64) | C |
| Pipeline | Router: stores before Live per Agg, same-request fallback, breaker; envelope `Store` block and per-facet `Engine / Exact / AsOf / LagMS`; store answers never cached (digest Version); Describe; harness `Store` option; demo toggle (§62) | wiring |

### 53.2 Earlier rules changed by Part IV

| Earlier | Rule there | M5 rule |
|---|---|---|
| §9.4 / §18.3 / §27.3 Router | `ForceEngine`, else the first engine that accepts every Agg (Live) | per Agg: a registered store engine that is `capable` and admitted by Freshness answers it, everything else is Live; same-request fallback on a store error; `PreferEngine` (in-process) (§62.1) |
| §9.1 engine interface | `capable(pAgg, pContext)` pure | unchanged for Live; the store engine's `capable` is pure and static, its `execute` may additionally refuse Aggs at capture time (`Execution.Refused`, §64) |
| §10.1 / §10.2 envelope | `Engine` of the Total; `Exact: true, LagMS: 0` | per-facet `Engine`, `Exact`, `AsOf`, `LagMS` from the engine that answered it; envelope-level rules §62.3; a `Store` block when a store is registered (§62.3) |
| §10.4 `normalizeForComparison` | strips `Version, AsOf, ElapsedMS, Engine, Cached, LagMS, Stale` | also strips `Store` (wiring adds it to `VOLATILE_FIELDS`) |
| §44.5 Version / §44.6 storing | generation Version for cacheable answers | an answer with **any** store-served facet is post-execution `Bypass 'Store'`: digest Version, never stored (ApplyToken caching is a seam, §70) |
| §39.3 intake subscribers | `'Generations'`, `'ReadYourWrites'` | + `'Freshness'`, then `'Materializer'` (in that order, after the M4 two) (§58.2) |
| §38.4 options | `Stores`, `Materialize`, `Materializer`, `Reconcile` placeholders | defined (§53.4) |
| §3 normalized request | `Freshness` | + `Engine: 'Auto' \| 'Live'` (§62.2) |
| §38.6 context | | + `Store` (§53.5); `pInternalOptions.PreferEngine` |
| §12.1 host | | unchanged (the materializer reads through `Host.getDAL`, §58.7) |
| §14.4 / §32.4 / §49.2 ports | | + §69.2 |
| §33 docker | `rfs-test-postgres` is the only container | + `rfs-test-clickhouse` (§69.1); still never any other container |

Everything earlier that is not listed here still holds. In particular: Records / Count / Keys are always Live and Exact (D-38); labels are always the Live scoped label read (§18.6), never a dictionary; the Reference engine never reads a store; a store never answers a Show-deleted request.

### 53.3 New files and services

| File | Export | Kind | Registered | Owner |
|---|---|---|---|---|
| `source/store/Retold-Faceting-StoreBase.js` | `RetoldFacetingStoreBase` (+ statics `TARGET_LIVE`, `BUILD_ID_PATTERN`, `shadowTarget`, `isShadowTarget`, `abstractError`) | service (abstract) | no | A |
| `source/store/clickhouse/ClickHouse-Client.js` | class `ClickHouseClient` (+ statics `PARAM_NAME_PATTERN`, `SETTING_NAME_PATTERN`, `QUALIFIED_TABLE_PATTERN`, `redact`, `normalizeRows`) | plain class (liftable: no fable, no sibling requires); **working** from the contracts pass (ping, query, command, insert with tokens, parameters, 64-bit normalization, fault injector, typed errors — verified against 24.8); A hardens and tests it | no | A |
| `source/store/clickhouse/ClickHouse-TypeMap.js` | `{ TYPE_MAP_VERSION, DATETIME_MIN, DATETIME_MAX, mirrorType, baseType, paramType, isNullableType, toStoreValue, toStoreRow, fromStoreValue, canonicalDateLiteral }` | pure module | — | A |
| `source/store/clickhouse/ClickHouse-DDL.js` | `{ DDL_VERSION, IDENTIFIER_PATTERN, META_COLUMNS, STATE_TABLE, KEYMAP_PREFIX, SHADOW_INFIX, sanitizeInstanceKey, databaseName, quoteIdentifier, qualified, mirrorTableName, keymapTableName, createDatabaseDDL, mirrorDDL, keymapDDL, entityStateDDL, addColumnsDDL, exchangeDDL, renameDDL, dropTableDDL, specComment, parseSpecComment }` | pure module | — | A |
| `source/store/clickhouse/Retold-Faceting-StoreClickHouse.js` | `RetoldFacetingStoreClickHouse` (+ statics `STORE_NAME`, `WIPE_ERROR_CODES`) | service | `SUB_SERVICES` | A |
| `source/persistence/Retold-Faceting-MirrorSpec.js` | `RetoldFacetingMirrorSpec` (+ statics `SPEC_VERSION`, `MATERIALIZE_SCHEMA`, `UNSUPPORTED_KEYS`) | service | `SUB_SERVICES` | A |
| `source/persistence/Materialize-Schema.json` | draft-07 schema of `RetoldFaceting.Materialize` | data | — | A |
| `source/persistence/Retold-Faceting-Materializer.js` | `RetoldFacetingMaterializer` (+ statics `HINT_SOURCES`) | service | `SUB_SERVICES` | B |
| `source/persistence/Retold-Faceting-WriterLoop.js` | `RetoldFacetingWriterLoop` (+ statics `WORK_KINDS`, `TEST_HOOKS`) | service class, one per (store, entity) | no: constructed by the Materializer | B |
| `source/persistence/Retold-Faceting-WriterClock.js` | `RetoldFacetingWriterClock` (`next()`, `seed()`, `Last`: implemented by the contracts pass, pinned by the smoke test) | service class, one per store | no: constructed by the Materializer | B |
| `source/persistence/Retold-Faceting-PendingSet.js` | `RetoldFacetingPendingSet` | service class, one per (store, entity) | no | B |
| `source/persistence/Retold-Faceting-FlushBuffer.js` | `RetoldFacetingFlushBuffer` | service class, one per (store, entity) | no | B |
| `source/persistence/MaterializeSource-InProcess.js` | `RetoldFacetingMaterializeSourceInProcess` | service | `SUB_SERVICES` | B |
| `source/persistence/Retold-Faceting-Freshness.js` | `RetoldFacetingFreshness` (+ statics `STATES`, `ADMISSION`, `BREAKER_DEFAULTS`) | service | `SUB_SERVICES` | B |
| `source/store/clickhouse/ClickHouse-FoldCompiler.js` | `{ COMPILER_VERSION, OPERATOR_MAP, READ_SETTINGS, REASON_CLASSES, paramName, compileFilter, compileRelation, compileFoldPred, dimensionExpression, compileAgg, compileCube }` | pure module | — | C |
| `source/engine/Retold-Faceting-EngineClickHouse.js` | `RetoldFacetingEngineClickHouse` (extends `RetoldFacetingEngineBase`; + static `ENGINE_NAME`) | service | `SUB_SERVICES`; registered with the Router only when the store is configured (§54.2) | C |
| `source/persistence/Retold-Faceting-Rebuilder.js` | `RetoldFacetingRebuilder` (+ static `REBUILD_REASONS`) | service | `SUB_SERVICES` | D |
| `source/persistence/Retold-Faceting-Reconciler.js` | `RetoldFacetingReconciler` (+ static `LEVELS`) | service | `SUB_SERVICES` | D |
| `test/support/Facet-Docker-ClickHouse.js` | the `rfs-test-clickhouse` container helper (implemented by the contracts pass) | test support | — | A (after the contracts pass) |
| `test/support/Facet-ClickHouse-Support.js` | gate, fresh databases, store options, `loadMirrors`, `assertMirrorEqualsSource` (§66.1) | test support | — | A |
| `test/support/Facet-Store-Fake.js` | an in-memory store implementing the §54.3 write side, with fault injection (§66.1) | test support | — | B (D uses it) |

`SUB_SERVICES` order (the contracts pass inserted them after `RetoldFacetingReadYourWrites` and before `RetoldFacetingRouter`, so the M4 order assertions — the five M4 services after the LabelResolver, `Router`, `Routes`, `SSE` last — still hold): `RetoldFacetingMirrorSpec`, `RetoldFacetingFreshness`, `RetoldFacetingMaterializeSourceInProcess`, `RetoldFacetingStoreClickHouse`, `RetoldFacetingMaterializer`, `RetoldFacetingRebuilder`, `RetoldFacetingReconciler`, `RetoldFacetingEngineClickHouse`. Every constructor is side-effect free (no timers, no I/O, no subscriptions): nothing happens until the wiring calls `installStores()` (§54.2), so a host without `Stores.ClickHouse` behaves exactly as M4. The per-(store, entity) classes are fable service classes (they extend `fable-serviceproviderbase`, set `serviceType`, resolve options, so the smoke test constructs them) but are **constructed by the Materializer** with `new libX(this.fable, this.options, '<Store>:<Entity>')` and reached only through it (`Materializer.loop(pStore, pEntity)`), never through `fable.<Type>`. Services find each other through `this.fable.<serviceType>` as before; the Materializer hands its per-entity objects to D through `loop()` / `pendingInfo()`.

The ClickHouse client and the three pure `store/clickhouse/*` modules require nothing outside `source/contract/` and `source/store/clickhouse/` (the client: nothing but `http` / `https` / `crypto`), so they can move to the planned `meadow-connection-clickhouse` module unchanged (README note, §68 #1).

### 53.4 Options (M5)

```javascript
Stores:
{
	ClickHouse: false | {                          // an object registers the store (§54.2); false (default) = on-the-fly only
		URL: null, URLEnv: null,                    // 'http(s)://host:port' (no credentials in it); URLEnv names an environment variable
		User: 'default', UserEnv: null,
		Password: '', PasswordEnv: null,            // secrets only by value from code or by env-var name; never logged
		Database: null,                             // default 'rfs_' + InstanceKey (§56.1); must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$;
		                                            //   REQUIRED (or a non-default InstanceID): the default 'main' → Misconfigured (review)
		TimeoutMS: 20000, PingTimeoutMS: 3000,
		RetryConnectMS: 60000,                      // feature-not-boot retry period while unavailable (unref'd timer)
		InsertRetries: 2,                           // same-token retries of ONE insert on a network error / 5xx (§57)
		QuerySettings: { },                         // operator extras for every read (names ^[a-z_][a-z0-9_]*$, scalar values)
		SourceStringOrder: 'Auto',                  // 'Auto' | 'Binary' | 'Collated': may String range operators compile (§63.3)
		ExposeReasons: false,                       // envelope Store.Facets[k].Reason: the full reason (true) or its class only (§62.3)
		// --- review additions (§68 "Review fixes") ---
		ExposeFreshness: 'Auto',                    // per-facet LagMS / AsOf, freshness reasons, Describe's per-entity State / LagMS:
		                                            //   'Auto' = only on a host WITHOUT a scope policy (the lag is global: other tenants'
		                                            //   write activity); Admin.authorize principals always get Describe's detail
		ReaderUser: null, ReaderUserEnv: null,      // a least-privilege credential (SELECT on the database) for request reads;
		ReaderPassword: '', ReaderPasswordEnv: null, //  unset → the writer's.  Every request read runs with readonly = 2 regardless
		MaxConcurrentReads: 32,                     // request reads in flight (own socket pool); beyond → that facet Live, 'StoreBusy'
		WriterMaxSockets: 16,                       // the materializer's pool (separate from the readers')
		ReadLimits: { MaxMemoryBytes: 4294967296, MaxRowsToRead: 0, MaxBytesToRead: 0 },   // per request read (0 = server default)
		HealthMinTimeoutMS: 1000,                   // a time-out counts as a store fault only when the statement had at least this long
		UnreachableAfterFailures: 2,                // network failures / time-outs within BreakerWindowMS → the store 'Unreachable'
		UnreachablePingMS: 2000,                    //   (every facet Live at once, O(1)) until a background ping succeeds
		AllowInsecure: false,                       // http:// to a non-loopback host is warned about unless true
		CA: null, Cert: null, Key: null, RejectUnauthorized: true,   // https:// options (PEM text)
		Owner: 'Check'                              // the database's owner marker (§56.1): 'Check' refuses another deployment's
		                                            //   database ('Misconfigured'); 'Adopt' takes it over
	},
	Solr: false, OpenSearch: false
},
Materialize: { },                                  // { Entity: <declaration> } (§55.1)
Materializer:
{
	Enabled: 'Auto',                                // 'Auto' = true when a store is registered; false = the store is never used
	BatchIDs: 2000, ReadChunkIDs: 1000,
	FlushIntervalMS: 1000, FlushRows: 50000,
	RebuildPageSize: 25000,                         // review: was 100000 (one page = one source read + one insert per target)
	OverflowIDs: 100000,                           // PendingSet bound; beyond it the entity collapses to Dirty (§58.3)
	MaxBackoffMS: 30000, DrainOnStopMS: 5000, IdleTickMS: 50,
	// --- review additions ---
	StreamDelayMS: 'Auto',                          // a stream hint waits up to this for company ('Auto' = the flush interval in force;
	                                                //   0 = a cycle per arrival): ~one source read, keymap read and insert set per interval
	PromptRangeKinds: [ 'Resync', 'RebuildPage' ],  // range pages flushed at once; Scrub / Fill pages wait for the interval
	MaxConcurrentBuilds: 2,                         // backfills / rebuilds / boot verifies per store at once (the rest queue)
	StateWriteIntervalMS: 5000,                     // AppliedSeq / cursor-only state changes coalesced into one multi-row INSERT per store
	PartsBackoffAbove: 150, HealthCheckMS: 30000,   // active parts above → the flush interval stretched ×4 until merges catch up
	Lease: { Enabled: true, TTLMS: 30000, HeartbeatMS: 10000, SettleMS: 250 }   // one materializer per store (§58.10)
},
Reconcile:
{
	AutoStart: true,                                // timers per entity; tests set false and call the in-process API
	SweepIntervalMS: 'Auto',                        // 'Auto' = 600000 with an intake and the entity not in RawWriterEntities, else 60000
	RawWriterEntities: [ ], MaxTxnMS: 60000, SweepCap: 5000,
	LeafRange: 2000, BisectIntervalMS: 86400000, HardDeleteBisectIntervalMS: 3600000, RebuildDivergenceRatio: 0.01,
	ScrubPeriodMS: 86400000, ScrubRowsPerSecond: 2000, ScrubTickMS: 1000,
	ScrubUnknownTotalRowsPerTick: 256,              // review: the pace while the row count is unknown (seeded from the store at start)
	BootBisectAfterMS: 300000,                      // review: a clean restart after more downtime than this Bisects before Exact
	JitterRatio: 0.15                               // review: timers start at a random phase, periods ± this share
},
Freshness: { …M4, BreakerFailures: 5, BreakerWindowMS: 30000, BreakerOpenMS: 30000 },
Admin: { RebuildCooldownMS: 600000, Routes: false, authorize: null }   // §60.5; authorize also gates Describe's store detail
```

The contracts pass added every key above to `DEFAULTS` (`Stores.ClickHouse` stays `false`); the object form's defaults are the exported `libOptions.STORE_DEFAULTS.ClickHouse` (`deepMerge` cannot merge an object over `false`, so `StoreClickHouse.configure` merges the host's section over them). `Freshness.DefaultMode` stays `'Exact'` (§51.2): with a store configured a default request uses the store only when it is fully caught up (§61.3).

### 53.5 Request context and pMeta additions

```javascript
pContext.Store =                                     // set by the Router (wiring) on every Query once a store is registered; null otherwise
{
	Prefer: 'Auto' | 'Live' | 'ClickHouse',          // NormalizedRequest.Engine ('Live') or pInternalOptions.PreferEngine (tests, O3)
	Decisions: { '<AggKey>': { Engine: 'ClickHouse' | 'Live', Reason: null | '<§65 reason>', Freshness: <§61.3 result> | null } },
	Fallback: null | { Reason: 'Error' | 'Timeout' | 'Breaker', Detail },
	Statements: 0                                     // ClickHouse statements this request ran
}
pMeta.Store = { Used: [ AggKey … ], Refused: { AggKey: Reason }, Fallback, Statements, ElapsedMS }   // in-process only; full reasons
```

`pInternalOptions.PreferEngine: 'ClickHouse'` (tests only, never from a client) routes every Agg the store engine is `capable` of to the store **without** the freshness admission (the O3 suites quiesce the materializer first); capability, closure and eligibility still apply.

---

## 54. The store contract and its registration

### 54.1 Split of the design's store class

04 §2 makes a store both a writer target and an engine. M5 splits it: `RetoldFacetingStoreBase` / `RetoldFacetingStoreClickHouse` (A) own the lifecycle and the write side and run raw statements; `RetoldFacetingEngineClickHouse` (C) is the engine the Router talks to (`capable` / `freshness` / `execute`), compiling through `ClickHouse-FoldCompiler.js` and executing through `Store.queryRows`. `StoreBase` keeps the design's query-side names as thin delegates so a later Solr store can choose either shape.

### 54.2 Registration and feature-not-boot (wiring + A)

At `attach`, after `rebuildCatalog` and `installChangeCapture()`, the wiring calls `installStores()` (public, idempotent; also after every model reload):

1. `Stores.ClickHouse` not a plain object (false / absent) → nothing; the Router keeps M4 behavior; Describe `Engines.ClickHouse: { Available: false, Configured: false }`.
2. `Materializer.Enabled === false` → the store is not used (log info, `Configured: true, Available: false, Reason: 'NoMaterializer'`); a non-materializing reader process is a seam (§70).
3. `StoreClickHouse.configure(<resolved Stores.ClickHouse>)` (resolves `URLEnv` / `UserEnv` / `PasswordEnv`, the database name; **never** throws: a configuration problem — no URL, bad database name — sets `Available: false, Reason: 'Misconfigured'` and logs an error without secrets).
4. `Router.register(EngineClickHouse)` **before** Live (preference order), then `Materializer.start(fCallback)` (§58.1). `start` never fails `attach`: ping failure, DDL failure or an invalid `Materialize` entry leave the store or that entity unavailable, logged, retried every `RetryConnectMS` (unref'd); the service boots and answers Live.
5. Model reload: `Materializer.reload()` (MirrorSpec recompile, additive ALTER or rebuild per entity, §55.4).
6. Shutdown (`RetoldFacetingService.shutdown`, M4 §44.10): `Materializer.stop()` first (drain ≤ `DrainOnStopMS`, final flush, clean-shutdown flags), then the M4 steps.

`StoreClickHouse.status()` → `{ Configured, Available, Reason, Database, Version, LastError: <message without values> | null, ConnectedAt }`.

### 54.3 `RetoldFacetingStoreBase` methods (A; ClickHouse implements all)

Every async method calls back `(pError, pResult)` and never throws; an error carries `.StoreError = true`, `.Code` (ClickHouse error code number when known), `.Status` (HTTP status), and a message **without** bound values. `pTarget` is `'Live'` or `'Shadow:<BuildID>'` (`StoreBase.shadowTarget(pBuildID)`).

| Method | Contract |
|---|---|
| `configure(pStoreOptions)` | sync; §54.2 step 3 |
| `connect(fCallback)` | ping + `SELECT version()`; `(null, { Up, Version })` — `Up: false` is not an error |
| `ensureSchema(pSpecs, fCallback)` | `CREATE DATABASE IF NOT EXISTS … ENGINE = Atomic` and `_rfs_entity_state`, then **reports** per spec what exists → `{ Entities: { E: { MirrorExists, KeymapExists, SpecHash: <from the table COMMENT> \| null, Columns: [ name … ] } } }`; it never creates a live mirror or keymap: live tables come only from a backfill's `RENAME` (§59.1), so a live table always holds a complete build |
| `createLive(pEntity, pSpec, fCallback)` | the live mirror and keymap `IF NOT EXISTS` — for `Facet-ClickHouse-Support.loadMirrors` and tests only; the Materializer never calls it |
| `addColumns(pEntity, pSpec, pColumns, fCallback)` | additive `ALTER TABLE … ADD COLUMN IF NOT EXISTS` on the mirror (and the keymap for tracked columns), then the COMMENT updated to the new SpecHash |
| `health(fCallback)` | `{ Up, Version, Database, Tables, ActivePartsMax }` |
| `maxVersion(fCallback)` | the largest `_Version` in any mirror, keymap or state table of the database (0 when none) — the WriterClock floor (§58.4) |
| `readKeys(pEntity, pIDs, pTarget, fCallback)` | keymap point read (`FINAL`, `_IsDeleted = 0`, `Identity IN {ids:Array(Int64)}`) → `Map<ID, Array<{ Key: { <SortKey scope columns> }, Tracked: { … }, UpdateDate, Version }>>` — **every** live keymap row of the ID (§58.5 superset invariant) |
| `readKeyRange(pEntity, pAfterID, pToID, pTarget, fCallback)` | the same for `AfterID < Identity ≤ ToID` |
| `writeBatch(pEntity, pBatch, pToken, pTarget, fCallback)` | the three-insert flush protocol of §58.6 for one target; `pBatch = { Rows, Tombstones, KeyIntents, KeyRetires }`; `pToken = '<Entity>:<FlushID>:<Target>'`; chunk tokens `'<pToken>:K<i>'`, `':M<i>'`, `':R<i>'`; the mirror receives **one** INSERT per chunk carrying rows **and** tombstones; each INSERT retried up to `InsertRetries` times with its own token on a network error or 5xx |
| `beginShadow(pEntity, pBuildID, pSpec, fCallback)` | `CREATE TABLE <E>__shadow_<BuildID>` and `_rfs_keys_<E>__shadow_<BuildID>` from the spec's DDL (drops leftovers of the same name first) |
| `swapShadow(pEntity, pBuildID, pFirstEnable, fCallback)` | first enable: `RENAME TABLE` shadow → live (mirror, then keymap); otherwise `EXCHANGE TABLES <E> AND <E>__shadow_<BuildID>`, then the keymaps |
| `dropShadow(pEntity, pBuildID, fCallback)` | `DROP TABLE IF EXISTS` both shadow tables (after a swap they hold the old data) |
| `readState(pEntity, fCallback)` / `writeState(pEntity, pState, fCallback)` | `_rfs_entity_state` (§56.5); read → the state object or `null` |
| `bucketChecksums(pEntity, pLeafRange, pTarget, fCallback)` | over the keymap's live **distinct** IDs: `{ '<bucket>': { Count, IDSum } }`, bucket = `intDiv(ID, LeafRange)` (§60.2) |
| `readLeafRows(pEntity, pAfterID, pToID, pColumns, fCallback)` | mirror `FINAL`, `_IsDeleted = 0` rows of the range (content compare, `assertMirrorEqualsSource`) |
| `queryRows(pSQL, pParams, pTypes, pSettings, fCallback)` | a read with the §57.3 read settings merged under `pSettings`; rows normalized (§57.2) |
| `command(pSQL, pParams, pSettings, fCallback)` | DDL / admin statement (rebuild, wipe tests) |
| `dropDatabase(fCallback)` | `DROP DATABASE IF EXISTS <db> SYNC` — tests and the wipe scenario only |
| `capabilities()` | `{ Folds: [ every §5.3 / §24.9 kind ], Predicates: 'Portable', Paths: 'Subquery', CountModes: [ 'Rows', 'PivotDistinct', 'KeyDistinct' ], TimeZones: [ 'UTC' ] }` |
| `status()` | §54.2 |

---

## 55. Materialize declaration, MirrorSpec and the closure rule (A)

### 55.1 The declaration (`RetoldFaceting.Materialize`, schema `source/persistence/Materialize-Schema.json`)

```javascript
Materialize:
{
	Document:
	{
		Store: [ 'ClickHouse' ],                     // required; every name must be a configured store
		Columns: 'Auto',                             // 'Auto' (rule 1 below) | [ explicit column list ] (scope, identity, delete, UpdateDate and Join columns are always added)
		IncludeColumns: [ ],                         // added to 'Auto' (e.g. a GUID or a String longer than 256 that filters need)
		ExcludeColumns: [ ],                         // removed from 'Auto' (never a scope / identity / delete column: that entry is invalid)
		SortKey: 'Auto',                             // 'Auto' only in M5 (§55.3)
		Watermark: 'Auto',                           // 'Auto' | 'UpdateDate' | false (§60.1)
		Mutability: 'Mutable',                       // 'AppendOnly' accepted with a warning and treated as 'Mutable' (no aggregates in M5)
		// design keys accepted with a load warning 'Unsupported:<Key>' and ignored in M5 (rows are still mirrored; folds use Subquery mode):
		PathColumns: { }, RelationFields: { }, Rollups: { }, Aggregates: { }, Dictionary: false
	}
}
```

Validation (at `start` and every reload): the built-in validator of §20.2 against `Materialize-Schema.json` (A cross-checks with ajv in tests), then semantics: the entity is in `Catalog.entities()` (facetable) and has a DAL; it is not a `NeverFacet` / reserved / `_rfs_*` name; every named column is a catalog column (`Catalog.column`), never Sensitive; `Store` names a configured store. An invalid entry disables **that entity in that store** with a logged `FACET_DEFINITION_INVALID`-style error (`MirrorSpec.disabled()`), never a partial spec; the other entities load.

### 55.2 MirrorSpec

```javascript
{
	Entity: 'LabForm', Store: 'ClickHouse',
	Identity: 'IDLabForm',
	Kind: 'Personal',                                // Host.entityScopeColumns(E).Kind (§41.2)
	TenantColumn: 'IDCustomer', OwnerColumn: 'OwnerIDUser', RequiredColumns: [ ], DeleteColumn: 'Deleted',
	SortKey: [ 'IDCustomer', 'OwnerIDUser', 'IDLabForm' ],
	Columns:
	[
		{ Column: 'IDLabForm', DataType: 'ID', Mirror: 'Int64', Role: 'Identity' },
		{ Column: 'IDCustomer', DataType: 'Numeric', Mirror: 'Int64', Role: 'Tenant' },
		{ Column: 'OwnerIDUser', DataType: 'Numeric', Mirror: 'Nullable(Int64)', Role: 'Owner', Join: 'IDUser' },
		{ Column: 'Deleted', DataType: 'Boolean', Mirror: 'Nullable(UInt8)', Role: 'Delete' },
		{ Column: 'UpdateDate', DataType: 'DateTime', Mirror: "Nullable(DateTime64(3, 'UTC'))", Role: 'Watermark' },
		{ Column: 'IDMaterialIntake', DataType: 'Numeric', Mirror: 'Nullable(Int64)', Role: 'FK', Join: 'IDMaterialIntake' },
		{ Column: 'Status', DataType: 'String', Mirror: 'Nullable(String)', Role: 'Column' },
		…
	],
	ColumnNames: [ … ],                               // sorted, for the closure check
	KeymapColumns: [ 'IDLabForm', 'IDCustomer', 'OwnerIDUser', 'IDMaterialIntake', 'IDLabFormType', 'UpdateDate' ],   // identity, sort-key scope, TrackedKeyColumns, UpdateDate
	TrackedKeyColumns: [ 'IDCustomer', 'OwnerIDUser', 'IDMaterialIntake', 'IDLabFormType' ],   // scope ∪ FK (Join) columns
	SourceColumns: [ … ],                             // what MaterializeSource reads: Columns (no meta columns)
	Watermark: 'UpdateDate' | null,
	Warnings: [ 'Unsupported:PathColumns', … ],
	SpecHash: 'ms:4be1d0c2'
}
```

**Compilation rules** (04 §4, adapted):

1. **Columns** (`'Auto'`): the identity; the policy columns `Host.entityScopeColumns` reports (tenant, owner, every `Required` column); the delete column; `UpdateDate` / `CreateDate` when present; every `Join` column; every catalog **filterable** column whose DataType the type map mirrors (§56.3) — `String` only up to Size 256, never `Text` / `JSON` / `JSONProxy`, never Sensitive (`Catalog.column` is null), never a GUID column — plus `IncludeColumns`, minus `ExcludeColumns`. An explicit `Columns` list is that list plus the always-added columns.
2. **TrackedKeyColumns** = the scope columns ∪ every `Join` column; **KeymapColumns** = identity ∪ sort-key scope columns ∪ TrackedKeyColumns ∪ `UpdateDate` (when mirrored).
3. **SortKey** (`'Auto'`): `Tenant` / `Personal` entity → `[ TenantColumn, OwnerColumn?, Identity ]`; a `Personal` entity without a tenant column → `[ OwnerColumn, Identity ]`; `Global` / `Unscoped` → `[ Identity ]`. `Required` columns are mirrored, never in the sort key.
4. **SpecHash** = `'ms:' + sha1(canonicalJSON({ Columns: [ [ Column, Mirror ] … ] (sorted), SortKey, KeymapColumns, TypeMap: TYPE_MAP_VERSION, DDL: DDL_VERSION }))[0..8]`.
5. The spec covers only its own entity: M5 compiles no PathColumns, dictionaries, relation fields or rollups, so a mirror never holds derived data and no DependencyIndex / fan-out exists (§68 #4).

### 55.3 The closure rule (store eligibility, A provides the check, C applies it)

A fold is store-eligible only if **every** entity of its DepSet is mirrored in that store with **every** column the fold reads:

- statically (`EngineClickHouse.capable`): `MirrorSpec.covers(pStore, pDepSet)` → `{ Covered: true }` or `{ Covered: false, Reason: 'NotMirrored:<E>' | 'NotMirrored:<E>.<C>' }`, where `pDepSet` is the Agg's DepSet (§24.10: every Rel's PK, delete column, policy columns, Project columns, Where fields, inner On columns, the pivot's conjunct fields) unioned with its Variant's (`FoldIR.depSet`), and columns still being filled after an additive change (§55.4) count as not mirrored;
- dynamically (§63.2): every column a captured filter names (a behavior may append a column the DepSet does not list) must be a spec column, else `NotMirrored:<E>.<C>`.

`MirrorSpec.compile` does **not** add closure entities automatically (04 §3.4 "advice, never auto-enable" — §68 #3): it logs one warning per declared facet / scope whose `Entities` are not all mirrored (`ClosureIncomplete`, listed in `MirrorSpec.warnings()`), so an operator sees which definitions will stay Live.

### 55.4 Spec changes

At `start` and on reload, per entity: no state row or no live table → backfill (§59.1). Same SpecHash → resume (§58.1). A **new** SpecHash whose columns are a superset of the live table's with the same types, sort key and keymap layout → **additive**: `Store.addColumns`, the new columns go into `entityInfo.FillingColumns` (they read as not mirrored) until a full Scrub pass completes (§60.3), then the state row records the new SpecHash. Anything else (a removed or retyped column, a changed sort key) → shadow rebuild (§59.2, Reason `'SpecChange'`). An entity removed from `Materialize` stops its loop; its tables are left in place (never dropped automatically).

### 55.5 MirrorSpec API (A)

```javascript
compile(pMaterialize, pEnvironment) → { Specs: { Store: { Entity: MirrorSpec } }, Disabled: [ … ], Warnings: [ … ] }   // pure over Catalog, Host, Registry; also stores the result
validate(pMaterialize, pEnvironment) → { Valid, Errors, Warnings }                                                       // no state change
spec(pStore, pEntity) → MirrorSpec | null
entities(pStore) → [ Entity … ]
covers(pStore, pDepSet, pFilling) → { Covered, Reason }     // pFilling: { Entity: [ columns ] } still being filled (from the Materializer)
column(pStore, pEntity, pColumn) → spec column | null
disabled() / warnings()
```

---

## 56. ClickHouse layout, DDL and the type map (A)

### 56.1 Names

- **Database** `Stores.ClickHouse.Database`, else `'rfs_' + InstanceKey` where `InstanceKey = InstanceID.replace(/[^A-Za-z0-9_]/g, '_')` (`DDL.databaseName`); when the sanitized key differs from the InstanceID (or is longer than 50 characters) the name is `rfs_<key[0..50]>_<FNV-1a hash of the InstanceID>`, so two InstanceIDs never share a database (review). With neither `Database` nor a non-default `InstanceID` the store is `Misconfigured` (every deployment left at the defaults would share `rfs_main`). Always `ENGINE = Atomic` (needed for `EXCHANGE TABLES`). Tests use `rfs_<pid>_<n>` (§69.3); the demo `rfs_demo_<port>_<pid>_<domain>` (§69.3).
- **Tables:** mirror `<Entity>`; keymap `_rfs_keys_<Entity>` (`index_granularity = 256`, `non_replicated_deduplication_window = 1000`: point reads by ID touch ~25× fewer rows, §68 review); shadows `<Entity>__shadow_<BuildID>` and `_rfs_keys_<Entity>__shadow_<BuildID>` (`BuildID` = 8 lowercase hex); state `_rfs_entity_state`; the materializer lease `_rfs_lease` (`Store, Owner, ExpiresAtMS, Released, _Version`; ReplacingMergeTree by `_Version`, read FINAL: the latest claim wins, §58.10); the owner marker `_rfs_owner` (`Store, InstanceID, Fingerprint, _Version`: written on first use with this deployment's InstanceID and the source fingerprint `sf:<sha256 of dialect, host, port, database, SQLite file>`; a different InstanceID or source → `Misconfigured` unless `Owner: 'Adopt'`). Every identifier matches `DDL.IDENTIFIER_PATTERN` (`^[A-Za-z_][A-Za-z0-9_]{0,63}$`, shadow names are built from validated parts) and is backtick-quoted (`DDL.quoteIdentifier`); an entity named `_rfs_*` is refused at MirrorSpec validation.
- **Meta columns** (`DDL.META_COLUMNS`): `_Version UInt64` (WriterClock, never `UpdateDate`), `_IsDeleted UInt8` (1 = tombstone), `_AppliedAt DateTime64(3, 'UTC') DEFAULT now64(3)` (mirror only). A model column named like a meta column disables the entity.

### 56.2 DDL (generated by `ClickHouse-DDL.js`; verified on 24.8 by the contracts pass)

```sql
CREATE DATABASE IF NOT EXISTS `rfs_main` ENGINE = Atomic;

-- Mirror (example: LabTrack.LabForm, a Personal entity: tenant IDCustomer, owner OwnerIDUser)
CREATE TABLE IF NOT EXISTS `rfs_main`.`LabForm`
(
	`IDLabForm`        Int64,                                    -- identity: never Nullable
	`IDCustomer`       Int64,                                    -- tenant (sort key): never Nullable (unset → quarantined, §56.4)
	`OwnerIDUser`      Nullable(Int64),                          -- owner (sort key): Nullable, allow_nullable_key
	`CreateDate`       Nullable(DateTime64(3, 'UTC')),
	`CreatingIDUser`   Nullable(Int64),
	`UpdateDate`       Nullable(DateTime64(3, 'UTC')),
	`UpdatingIDUser`   Nullable(Int64),
	`Deleted`          Nullable(UInt8),                          -- always 0 on live rows; mirrored so compiled filters stay valid
	`DeleteDate`       Nullable(DateTime64(3, 'UTC')),
	`DeletingIDUser`   Nullable(Int64),
	`IDMaterialIntake` Nullable(Int64),
	`IDLabFormType`    Nullable(Int64),
	`Status`           Nullable(String),
	`CompletedDate`    Nullable(DateTime64(3, 'UTC')),
	`_Version`         UInt64,
	`_IsDeleted`       UInt8,
	`_AppliedAt`       DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(`_Version`, `_IsDeleted`)
ORDER BY (`IDCustomer`, `OwnerIDUser`, `IDLabForm`)
SETTINGS allow_nullable_key = 1, index_granularity = 8192, non_replicated_deduplication_window = 1000
COMMENT 'rfs mirror LabForm spec=ms:0123abcd';

-- Keymap (the before-image of record, §58.5): one row per (identity, sort-key scope values) ever written live
CREATE TABLE IF NOT EXISTS `rfs_main`.`_rfs_keys_LabForm`
(
	`IDLabForm` Int64, `IDCustomer` Int64, `OwnerIDUser` Nullable(Int64),
	`IDMaterialIntake` Nullable(Int64), `IDLabFormType` Nullable(Int64), `UpdateDate` Nullable(DateTime64(3, 'UTC')),
	`_Version` UInt64, `_IsDeleted` UInt8
)
ENGINE = ReplacingMergeTree(`_Version`, `_IsDeleted`)
ORDER BY (`IDLabForm`, `IDCustomer`, `OwnerIDUser`)
SETTINGS allow_nullable_key = 1, non_replicated_deduplication_window = 1000
COMMENT 'rfs keymap LabForm spec=ms:0123abcd';

-- Per (store, entity) state, inside the store it describes (04 §8.1)
CREATE TABLE IF NOT EXISTS `rfs_main`.`_rfs_entity_state`
(
	`Store` LowCardinality(String), `Entity` String,
	`State` LowCardinality(String), `Epoch` UInt32, `SpecHash` String,
	`AppliedSeq` String,                                          -- JSON { "<NodeEpoch>": n } (informational across restarts, §61.2)
	`CleanShutdown` UInt8,                                        -- 1 only after a graceful stop drained and flushed
	`LossyColumns` String,                                        -- JSON { "<Column>": "Compare" | "Value" } (§56.3)
	`FillingColumns` String,                                      -- JSON [ … ] (§55.4)
	`SweepWatermark` Nullable(String), `ScrubCursor` Nullable(Int64), `ScrubbedThrough` Nullable(DateTime64(3, 'UTC')),
	`LastRebuild` Nullable(DateTime64(3, 'UTC')), `LastBisect` Nullable(DateTime64(3, 'UTC')), `UnverifiedSince` Nullable(DateTime64(3, 'UTC')),
	`Detail` String,                                              -- JSON: counters (Quarantined, LastError code), never values
	`_Version` UInt64, `_UpdatedAt` DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(`_Version`) ORDER BY (`Store`, `Entity`);
```

- Sort key per §55.2 rule 3; a `Global` / `Unscoped` entity is `ORDER BY (<Identity>)`. The keymap is `ORDER BY (<Identity>, <sort-key scope columns>)` so **several** live keys of one ID can coexist there (§58.5); its `_IsDeleted` rows retire keys. (The design's EmbeddedRocksDB keymap holds one key per ID and cannot keep that invariant across a partial flush: §68 #6.)
- No `PARTITION BY` in M5 (no `do_not_merge_across_partitions_select_final` needed); partitions above `PartitionAboveRows` are a seam.
- Every read of a mirror or keymap uses `FINAL` **and** `_IsDeleted = 0` (FINAL already drops `is_deleted` rows on 24.8; the predicate stays, belt and braces).
- `_rfs_entity_state` reads use `FINAL` (latest `_Version` per `(Store, Entity)`); every write is a full row (the latest state object), version from the WriterClock.
- No `_rfs_clock` table: the clock floor is `Store.maxVersion()` (§58.4, §68 #7).

### 56.3 Type map and value conversion (`ClickHouse-TypeMap.js`)

`TYPE_MAP_VERSION = 1`. `mirrorType(pColumnInfo, pRole)` → the column type; `toStoreValue(pColumnInfo, pValue, pSourceDialect)` → `{ Value, Lossy: null | 'Compare' | 'Value' }`; `toStoreRow(pSpec, pSourceRow, pSourceDialect)` → `{ Row, Lossy: { Column: 'Compare' | 'Value' }, Quarantined: false | '<reason>' }` (`Row` holds the spec's columns only, JSONEachRow-ready); `paramType(pMirrorType)` strips `Nullable(…)`; `canonicalDateLiteral(pValue, pOperator, pSourceDialect)` (§63.3).

| Catalog DataType | Mirror type (`Nullable(…)` except identity and tenant) | Value written | Lossy |
|---|---|---|---|
| `ID` (the identity) | `Int64` | a safe integer (number, bigint, integer-literal string) | anything else: the row is skipped, `Lossy.<Identity> = 'Value'` (the entity becomes ineligible) |
| `ForeignKey`, `Numeric` with `IsInteger` | `Nullable(Int64)` | safe integer; `null` → NULL | non-integer number, unsafe magnitude, non-numeric text (SQLite `''` / `' '`): NULL + `'Value'` |
| `Decimal`, non-integer `Numeric` | `Nullable(Float64)` | `Number(v)` (a JS number as is; a numeric string — PostgreSQL `numeric` — parsed) | more than 15 significant digits, or non-numeric text: NULL + `'Value'` |
| `String` | `Nullable(String)` | `String(v)` (a Buffer as UTF-8) | — |
| `DateTime` | `Nullable(DateTime64(3, 'UTC'))` | `canonicalDateTime(v) + '.000'` (a JS `Date` read in UTC; `TZ=UTC` on PostgreSQL) | unparseable or `''` → NULL + `'Value'`; outside `DATETIME_MIN` `'1900-01-01 00:00:00'` … `DATETIME_MAX` `'2299-12-31 23:59:59'` → NULL + `'Value'`; on a **SQLite** source, a parseable value whose stored text is not exactly the canonical text (`'2022-01-01T00:00:00'`, `'2023-07-01 00:00'`) → `'Compare'` |
| `Boolean` (incl. the delete column) | `Nullable(UInt8)` | `true / 1 / '1' / 'true'` → 1, `false / 0 / '0' / 'false'` → 0 | anything else: NULL + `'Value'` |
| `GUID` | `Nullable(String)` (only when named in `IncludeColumns`) | `String(v)` | — |
| `Text`, `JSON`, `JSONProxy`, unknown | not mirrored | | |

- **Tenant sort-key column**: the base type, not Nullable; **owner** sort-key column: Nullable (with `allow_nullable_key = 1`). A tenant column of DataType `String` maps to `String`.
- **Lossy flags** accumulate per (store, entity, column) in the WriterLoop (§58.5 step 5) and persist in `_rfs_entity_state.LossyColumns`; they only grow, except that a completed rebuild resets them to what the rebuild saw. `'Value'`: the mirror cannot reproduce the source value, so **any** fold reading the column (dimension, measure, predicate, On pair) is ineligible (`LossyColumn:<E>.<C>`). `'Compare'`: the value buckets identically but the source compares it as text, so a fold whose **predicates** (client conjuncts, `Where`, scope entries, On pairs) name the column is ineligible; dimension and measure reads stay eligible. On PostgreSQL typed columns cannot hold such values, so in practice only out-of-range dates are lossy there.
- **Integer / decimal parity:** integers stay exact as `Int64`; decimals become doubles, which is exactly what both Live dialects compare (SQLite `REAL`; PostgreSQL `numeric` against the double edge expressions of §10.3.2); Stats sums are integer units (§63.4) and so exact to the scale.
- **Date parity (D-22):** values are the naive wall clock in `StorageTimeZone` (`UTC`, the M1 wire format `YYYY-MM-DD HH:mm:ss`), labelled `'UTC'` in ClickHouse purely as a label; bucketing uses the `toStartOf*` family with `enable_extended_results_for_datetime_functions = 1` (Date32: correct from 1900 to 2299; without it `toStartOfMonth` wraps dates before 1970, verified), formatted back to the wire format.

### 56.4 Row liveness and quarantine

A source row is **live** iff it exists, its delete column (when the entity has one) is exactly `0` (`NULL` or any other value is not live: Live's explicit `Deleted = 0` excludes it too), and — for a `Tenant` / `Personal` entity — its tenant value is set (`!isUnsetScopeValue(v, Scope.UnsetValues)`). A non-live row is never mirrored (tombstoned if the keymap has it). A row whose only fault is an unset tenant is **quarantined**: counted in `Materializer.status()…Quarantined` and `_rfs_entity_state.Detail`, visible only through Live, where no principal sees it (tenant-0 principals are refused, 06 §2.2). An unset owner is not a quarantine: the owner sort-key column is Nullable.

---

## 57. The ClickHouse client (`ClickHouse-Client.js`, A)

### 57.1 Shape

```javascript
const libClickHouseClient = require('…/store/clickhouse/ClickHouse-Client.js');
let tmpClient = new libClickHouseClient({ URL: 'http://127.0.0.1:18123', User: 'rfs_test', Password: '…', Database: 'default', TimeoutMS: 20000, PingTimeoutMS: 3000 });
tmpClient.ping((pError, pUp) => …)                                              // GET /ping → Up when 200 and 'Ok.'
tmpClient.query(pSQL, pParams, pSettings, (pError, pRows, pMeta) => …)           // FORMAT JSON → rows (normalized, §57.2), meta [ { name, type } ]
tmpClient.command(pSQL, pParams, pSettings, (pError) => …)                       // no result rows (DDL, EXCHANGE, …)
tmpClient.insert(pTable, pRows, { Token, Settings }, (pError, pCount) => …)      // INSERT INTO <pTable> FORMAT JSONEachRow; Token → insert_deduplication_token
tmpClient.formatParam(pValue) → string                                           // the param_<name> text (§57.2)
tmpClient.setFaultInjector(fInjector | null)                                     // tests only (§57.4)
ClickHouseClient.redact(pText) → string                                          // strips the password if a server echoes it
```

Callbacks, never promises (Part I §0). `pTable` must be a pre-quoted qualified name built by `ClickHouse-DDL.qualified`. Credentials go in `X-ClickHouse-User` / `X-ClickHouse-Key` headers, never in the URL or a log. An error is `Error('ClickHouse <status>: <first 400 chars>')` with `.StoreError = true`, `.Status`, `.Code` (parsed from `Code: <n>.`), and a network error / timeout has `.Status = 0`, `.Retryable = true` (5xx are retryable too, 4xx never).

### 57.2 Parameters and results

- Every value travels as a query parameter `param_<name>`, referenced in the SQL as `{name:Type}`; parameter names match `^[A-Za-z_][A-Za-z0-9_]*$` (anything else is a programming error: `FACET_INTERNAL`). ClickHouse parses a parameter's text in the **Escaped** (TSV) format, so `formatParam` (`ClickHouseClient.formatParamText`) escapes: `null` → `\N`; numbers / bigints → their decimal text; booleans → `1` / `0`; **strings → `\` `TAB` `LF` `CR` `NUL` `BS` `FF` backslash-escaped** (review: a raw `C:\temp` was read as `C:<TAB>emp`, a raw `\N` as NULL); arrays → a ClickHouse array literal (`[1,2]`, `['a\'b','c\\d',NULL]`: items single-quoted with `\`, `'` and the control characters escaped, then the whole text escaped once more as above). Values never enter SQL text.
- **Size:** a parameter whose text exceeds `MAX_PARAM_TEXT` (100 000 bytes; the server refuses fields over `http_max_field_value_size`, 128 KiB, code 1000) is refused before sending (`.ParameterSize`, `.Deterministic`); the fold compiler refuses such a binding earlier (`ParameterSize`, at 90 % of it), so that facet answers Live. Parameter values travel in the request URI: a proxy or server that logs URIs logs them (README).
- **Call options** (review): `query` / `command` take an optional fourth `pCallOptions` `{ TimeoutMS }` and `insert` a `TimeoutMS` option: an overall deadline from issue (connect, send, server time and the response body), after which the request is destroyed and fails `.TimedOut` (`NetworkCode 'ETIMEDOUT'`). `close()` destroys in-flight requests (a bounded shutdown). TLS: `CA`, `Cert`, `Key`, `RejectUnauthorized`; `MaxSockets` sizes the keep-alive pool; `isLoopback()` / `isHttps()` let the store warn about clear-text credentials.
- **Error classes** (review): `.Deterministic` (the statement itself is wrong: parse / type / parameter / unknown-identifier codes, `DETERMINISTIC_CODES`), `.Limit` (a per-query limit: `LIMIT_CODES` 158, 241, 307, 396), `.TimedOut` (`TIMEOUT_CODES` 159, 160, or the client deadline). None of them counts as a store fault (§61.4).
- Settings are URL parameters merged from the client defaults, the call's `pSettings`; a setting name must match `^[a-z_][a-z0-9_]*$` and its value be a scalar.
- **64-bit normalization:** queries ask `output_format_json_quote_64bit_integers = 1`; using the `meta` types, `Int64` / `UInt64` / `Int128`… (and their `Nullable` / `LowCardinality` forms) become JS numbers when `Number.isSafeInteger`, else stay decimal strings; `Float64` values that ClickHouse quotes (`inf`, `nan`) stay strings; everything else is JSON as returned.
- `insert` serializes each row with `JSON.stringify` (one per line); `null` → JSON null; DateTime64 values are `'YYYY-MM-DD HH:mm:ss.SSS'` strings (the WriterLoop already converted them). `pCount` = rows sent. Settings `insert_deduplication_token` (when `Token`), `insert_deduplicate = 1`.

### 57.3 Read settings (every `Store.queryRows`)

`readonly = 2` (review: a request read can never write, even if a statement were ever mis-built; settings still apply), `enable_extended_results_for_datetime_functions = 1`, `precise_float_parsing = 1` (Float64 values are bound as `toFloat64({p:String})`, never `{p:Float64}`: §68 #22), `join_use_nulls = 1`, `transform_null_in = 0`, `cancel_http_readonly_queries_on_client_close = 1`, `output_format_json_quote_64bit_integers = 1`, `max_execution_time = max(1, ceil(0.4 × remaining deadline seconds))` (the engine passes it), `max_result_rows = Limits.CubeMaxGroups + 2` with `result_overflow_mode = 'throw'` for grouped statements (the engine passes it), plus `Stores.ClickHouse.QuerySettings` and `ReadLimits` (`max_memory_usage`, `max_rows_to_read`, `max_bytes_to_read`). Request reads go through their own client (`ReaderUser` when configured: grant it `SELECT` on the database only) with `MaxConcurrentReads` sockets; beyond that a facet answers Live (`StoreBusy`). Each read carries the request's remaining store budget as its client `TimeoutMS` as well as `max_execution_time`. (Row policies as a tenancy backstop remain a seam, §70.)

### 57.4 Fault injection (tests)

`setFaultInjector(fInjector)`: before each HTTP request the client calls `fInjector({ Kind: 'Query' | 'Command' | 'Insert' | 'Ping', SQL, Table, Token, Attempt })`; a return of `null` proceeds; `{ Status: 500, Text, When: 'Before' }` fails the call without sending it; `{ Status: 500, Text, When: 'After' }` sends it, lets it land, then reports the failure (the "insert landed but the client saw a 5xx" case that dedup tokens exist for); `{ Error: <Error> }` fails as a network error. Production code never sets one.

---

## 58. The materializer (B)

### 58.1 Lifecycle (`RetoldFacetingMaterializer`)

```
start(fCallback)                                       // §54.2 step 4; idempotent; never calls back an error that should fail attach
  per configured store S (M5: 'ClickHouse'):
    Store.connect → Up false → S Unavailable; retry every RetryConnectMS (unref'd); return (Live answers meanwhile)
    MirrorSpec.compile(Materialize) → specs of S (invalid entries disabled, logged)
    Store.ensureSchema(specs) (database + _rfs_entity_state; reports which live tables exist) → error → Unavailable + retry
    WriterClock(S).seed(Store.maxVersion())
    per entity E of S: construct PendingSet, FlushBuffer, WriterLoop; state = Store.readState(E):
      null (or no live table)                         → Building; Rebuilder.backfill(S, E)          (§59.1)
      SpecHash differs: additive                      → Store.addColumns; FillingColumns; Scrub     (§55.4)
      SpecHash differs: not additive                  → Rebuilding; Rebuilder.rebuild(S, E, 'SpecChange')
      CleanShutdown = 1                               → CatchingUp; Watermark → Reconciler.sweep from the watermark; then Live
      CleanShutdown = 0                               → Unverified (UnverifiedSince = now); Reconciler.verify(S, E) (§60.4)
      then writeState(E, { …, CleanShutdown: 0 })     // running: an unclean exit from here on is detectable
    Reconciler.start(S) when Reconcile.AutoStart
stop(fCallback)          // graceful: stop accepting work, drain every loop ≤ DrainOnStopMS (flush), CleanShutdown = 1 for each
                         // entity that drained and flushed (0 for the others), clear timers; idempotent
crash()                  // TESTS ONLY: drop every in-memory structure and timer without writing anything (a kill -9)
reload()                 // model reload: recompile specs; §55.4 per entity
onChange(pEvent)         // ChangeIntake subscriber 'Materializer' (§58.2); synchronous, no I/O, O(IDs)
enqueue(pStore, pEntity, pIDs, { Source, SeqN? })     // Reconciler / filter resolution / admin: IDs into the PendingSet
loop(pStore, pEntity) → WriterLoop | null
flushNow(pStore, pEntity, fCallback)                  // flush buffered cycles now (tests, MinSeq seam)
quiesce(pStore, pEntities | null, pTimeoutMS, fCallback)   // until no pending, in-flight, buffered, Dirty or resolving work remains and the
                                                           // last flush acked; (error after pTimeoutMS); the O3 / O10 suites' "quiescence"
pendingInfo(pStore, pEntity) → { Pending, InFlight, Buffered, Resolving, OldestFirstSeen, MinSeqN, Dirty: null | { Since, MinSeqN, Generation }, Overflow }
entityInfo(pStore, pEntity) → { Spec, State, Epoch, Lossy: { Column: 'Compare'|'Value' }, FillingColumns: [ … ], Quarantined, Available }
setState(pStore, pEntity, pState, pReason)            // through Freshness (§61.1); persisted with the next writeState
recoverWipe(pStore)                                   // §59.3: every entity Absent → ensureSchema → backfill (Reason 'Wipe')
status() → { Stores: { S: { Available, Entities: { E: { State, Pending, InFlight, Buffered, LagMS, AppliedSeq, Cycles, Flushes, FlushErrors, Rows, Tombstones, Quarantined, Lossy } } } } }
```

`Materializer.Enabled === false` → `start` does nothing (and the Router never uses the store).

Review changes to the lifecycle (§68 "Review fixes"): after `ensureSchema` (which also creates `_rfs_lease` / `_rfs_owner` and checks the owner marker, §56.1; a mismatch is `Misconfigured`, never retried) and the clock seed, the store's **lease** is taken (§58.10); without it the store stays unused (`NotLeader`) and the start is retried every `HeartbeatMS`. Backfills, SpecChange rebuilds and boot verifies run at most `MaxConcurrentBuilds` at a time per store (the rest queue; a failed backfill is retried with back-off). A `CleanShutdown = 1` boot after more than `Reconcile.BootBisectAfterMS` of downtime Bisects before the entity serves Exact. State rows: lifecycle changes (State, CleanShutdown, SpecHash, Lossy / Filling columns, Epoch) are written at once; AppliedSeq / cursor-only changes are coalesced into one multi-row INSERT per store every `StateWriteIntervalMS`. `stop` is bounded: at `DrainOnStopMS` (+ a grace of min(2 s, max(250 ms, DrainOnStopMS / 5))) the store's connections are destroyed; the lease is released last. `quiesce` also waits for due coalesced state writes and for an armed notify settle re-delivery of the entity (`ChangeIntake.settling(E)`: a change already reported that will be delivered once more). `recoverWipe` confirms the loss first (`Store.tablesExist`) and rebuilds only the entities whose live table or keymap is gone. `storeAvailable(S)` is the O(1) readiness check the engine uses per Agg (never `status()` on the request path).

### 58.2 Event → pending (`onChange`)

The wiring subscribes, after the M4 two: `ChangeIntake.subscribe('Freshness', (e) => Freshness.observe(e))`, then `ChangeIntake.subscribe('Materializer', (e) => Materializer.onChange(e))`. For every store S that mirrors `e.Entity` (others are ignored; `Freshness.observe` still records the Seq):

| Event | Pending |
|---|---|
| `Create` / `Update` / `Delete` / `Undelete` / `Touch` with `IDs` non-empty | each ID → `PendingSet(S, E).add(ID, SeqN)` (integer-literal strings such as a URL's `'1201'` are read as numbers); an ID that is still not a safe integer → `Dirty` instead |
| any operation with `IDs: []` and no `Filter` (capped events, fail-closed `EntityDirty`, a rewrap, a notify naming no IDs) | `PendingSet(S, E).markDirty(SeqN, Tenants)` → a whole-entity **Resync** (§58.3) |
| `EntityDirty` with a `Filter` (`notifyByFilter`) | a filter-resolution task (§58.8); on any failure → `markDirty` |
| notify settle re-deliveries (`ChangeID` ending `'~settle'`) | as any event (a harmless re-hint) |

`SeqN` = `parseSeq(e.Seq).N` (the local NodeEpoch; a foreign-epoch Bus Seq → null, which makes the hint's lag but not its Seq count). The add is synchronous, in the same tick as `Freshness.observe`, so a store can never be judged Exact for an entity with an observed, unapplied change (§61.2).

### 58.3 PendingSet (`RetoldFacetingPendingSet`, one per (store, entity))

```javascript
add(pID, pSeqN, pNow)            // pNow = the local monotonic clock (performance.now()); entry { FirstSeen, LastSeen, Hints, MinSeqN, InFlight: null }
                                 // re-hint of a pending ID: LastSeen = pNow, Hints++, MinSeqN = min(…); of an IN-FLIGHT ID: also Rehint = { FirstSeen, MinSeqN }
take(pMax) → [ { ID, Snapshot: { LastSeen, Hints, MinSeqN } } ]   // oldest FirstSeen first; marks them InFlight
ack(pTaken, pReadStart)          // after the flush: delete entries whose LastSeen ≤ pReadStart and Hints === Snapshot.Hints;
                                 // others stay pending (InFlight cleared; MinSeqN/FirstSeen from Rehint)
release(pTaken)                  // flush failed: InFlight cleared, entries stay pending unchanged (the retry is a NEW cycle: new v, fresh read)
markDirty(pSeqN, pTenants, pNow) // Dirty = { Since, MinSeqN, Tenants, Generation: ++n } (an existing Dirty keeps its Since / MinSeqN, bumps Generation)
clearDirty(pGeneration)          // only when no newer markDirty arrived since the Resync started
size() / inFlight() / info()     // info → pendingInfo fields (§58.1)
```

Lag is measured from `FirstSeen`, acks use `LastSeen` / `Hints` (04 §6.2): a change committed after the read is never acked away. **Overflow:** more than `Materializer.OverflowIDs` pending IDs → the set keeps accepting into a fresh map while the overflowed IDs collapse into `markDirty` (a whole-entity Resync; the design's tenant-scoped Scrub + Sweep + fan-out remediation is simplified, §68 #9). `Resync` = a Range pass over the whole entity through the WriterLoop at stream priority (§58.5), started by the loop when Dirty is set and no Resync is running.

### 58.4 WriterClock (`RetoldFacetingWriterClock`, one per store)

`next()` → `max(Date.now() × 1000, last + 1)` (microseconds, a safe integer for centuries); `seed(pFloor)` → `last = max(last, pFloor)`. At `start` the floor is `Store.maxVersion()`, so a restart, a restore or wall-clock skew can never go backwards. Versions are global to the store (every entity of S draws from one clock).

### 58.5 WriterLoop cycle (`RetoldFacetingWriterLoop`, one per (store, entity); serialized: at most one cycle in flight)

Work kinds (`WORK_KINDS`), taken in priority order: **Stream** (≤ `BatchIDs` IDs from the PendingSet) → **Range** tasks (`Resync`, `Scrub`, `Fill`; an ID range `(AfterID, ToID]` or `(AfterID, +∞)` capped) → one **RebuildPage** (§59.2). The loop runs on `setImmediate` while work exists, else idles (`IdleTickMS` poll for due flushes; unref'd).

```
1  v = WriterClock(S).next()                                   // BEFORE the read (04 §6.1)
2  take work; readStart = performance.now()
3  source read (MaterializeSource-InProcess, trusted, NO behaviors, IncludeDeleted):
     Stream: readRows(E, IDs, { Columns: Spec.SourceColumns })   (chunks of ReadChunkIDs)
     Range / RebuildPage: readRange(E, AfterID, Cap, { Columns, ToID })   → also defines the covered range (AfterID, LastID]
4  before-image, per target T in targets() ([ 'Live' ], or [ 'Live', 'Shadow:<b>' ] while rebuilding, [ 'Shadow:<b>' ] while Building):
     Stream: Store.readKeys(E, IDs, T)        Range / RebuildPage: Store.readKeyRange(E, AfterID, LastID, T)
5  per ID, per target (TypeMap.toStoreRow(Spec, sourceRow, SourceDialect) → { Row, Lossy, Quarantined }; Lossy merged into the entity's flags):
     source missing, or not live (§56.4)               → a tombstone for EVERY live keymap key of the ID; KeyRetire each
     source live, key K = (sort-key scope values)      → mirror row at K (_Version v, _IsDeleted 0); KeyIntent (ID, K, Tracked, UpdateDate) @v;
                                                         a tombstone + KeyRetire for every live keymap key ≠ K (tenant / owner moves)
     source missing and no keymap key                   → nothing
   (RebuildPage writes only to its shadow target; it diffs against the shadow keymap.)
6  FlushBuffer.append(T, { Rows, Tombstones, KeyIntents, KeyRetires }, { Version: v, ReadStart: readStart, Taken })
7  flush when FlushIntervalMS has passed since the buffer's first append, or ≥ FlushRows rows are buffered, or flushNow(),
   or before a swap / finishRebuild / stop:  for each target, Store.writeBatch(E, batch, '<E>:<FlushID>:<Target>', T)   (§58.6)
   error → for every covered cycle PendingSet.release(Taken) (Range tasks re-queued), back off (×2 from 100 ms to MaxBackoffMS),
           Freshness.recordWriteFailure(S, E); a wipe error (§59.3) → Materializer.recoverWipe(S)
8  ack, after EVERY target of the flush succeeded: PendingSet.ack(Taken, ReadStart) per covered cycle; Range progress / completion callbacks;
   Freshness.applied(S, E) (recomputes AppliedSeq, §61.2); Store.writeState(E, { State, Epoch, SpecHash, AppliedSeq, LossyColumns, … }) with v
```

- **Latest-read-wins** (04 §6.3): cycles are serialized per (S, E) and `v` is assigned before the read, so a higher `_Version` always carries an equal or newer source state; ReplacingMergeTree keeps the highest; duplicate or out-of-order hints are harmless re-reads.
- **Keymap superset invariant:** the keymap's live keys of an ID ⊇ the mirror's live keys of that ID at every point a reader or a later cycle can observe (guaranteed by the §58.6 order: intents before the mirror insert, retirements after). So a partial flush (a crash or a failed insert between the three inserts) can leave a superfluous tombstone or intent, never a ghost row no later cycle tombstones.
- **Quarantine / Lossy** per §56.3–§56.4; the cycle never fails because of a value.
- **Range coverage:** A Range read that returns fewer rows than its `Cap` is the last page of its pass: its covered keymap range is `(AfterID, +∞)` (or `(AfterID, ToID]`), so keymap IDs above the last source ID — a hard-deleted tail — are tombstoned too.
- **Test hooks** (`TEST_HOOKS`, `loop.setTestHook(pName, fHook)`; null in production): `'afterRead'`, `'afterFlushBeforeAck'` (the crash test: the hook calls `Materializer.crash()`), `'beforeSwap'`.
- **Batching (review):** a Stream cycle starts only when `BatchIDs` IDs wait, or the oldest waiting hint is `StreamDelayMS` old ('Auto' = the flush interval in force, stretched ×4 above `PartsBackoffAbove` active parts), or a flush / quiesce / stop / swap asks — so a steady write stream costs about one source read, one keymap read and one insert set per interval per entity (measured: 150 writes over 3 s → ≤ 10 inserts per table, `test/Facet-M5-Review_tests.js`), not one per write; the lag stays about one flush interval. `PromptRangeKinds` pages flush as soon as nothing else is runnable; Scrub / Fill pages wait for the interval. The keymap point read is done without FINAL (`Store._liveKeyEntries`: the latest `_Version` per (ID, key) wins in JS, a tie goes to the retirement), measured 20–40 % faster than FINAL at 10M–40M keymap rows (`debug/m5-keymap-bench.js`).
- **Rebuild pins (review):** `beginRebuild` pins the shadow to the spec it was built for; `finishRebuild` makes the live target follow the shadow's spec, and a model reload during a rebuild keeps the live spec (`KeepLiveSpec`) until the swap. A swap error never drops the shadow (§59.2). The Lossy flags a rebuild collects are per ID (capped at `LOSSY_ID_CAP`, beyond → sticky until a full Scrub rotation), so a corrected row clears its flag.

WriterLoop API (B; D drives the Range / rebuild parts):

```javascript
targets() → [ 'Live' | 'Shadow:<BuildID>' … ]
addRangeTask({ Kind: 'Resync' | 'Scrub' | 'Fill' | 'RebuildPage', Target: 'Live' | 'Shadow:<b>', AfterID, ToID: null | n, Cap }, fOnDone(pError, { LastID, Rows, Exhausted }))
beginRebuild(pBuildID, pFirstEnable, fCallback)   // Store.beginShadow; targets gain the shadow (first enable: targets = [ shadow ] only)
finishRebuild(pBuildID, fCallback)                // at a between-flush point: flush everything, Store.swapShadow, Store.dropShadow,
                                                  // targets = [ 'Live' ], Epoch++ ; no write is in flight to a table being exchanged
abortRebuild(pBuildID, fCallback)                 // targets back to [ 'Live' ], Store.dropShadow
flush(fCallback) / idle() → boolean / stats()
```

### 58.6 FlushBuffer and the flush protocol (`RetoldFacetingFlushBuffer` + `Store.writeBatch`)

`FlushID` = the `_Version` of the first cycle in the flush (decimal); token base `'<Entity>:<FlushID>:<Target>'`. Per target, in this order, each chunked at `FlushRows`:

1. **Keymap intents** — `INSERT INTO _rfs_keys_<E>[__shadow_b]` the KeyIntents (`_IsDeleted 0`), token `…:K<i>`;
2. **Mirror** — **one** `INSERT INTO <E>[__shadow_b]` per chunk carrying the rows **and** the tombstones (tombstones: identity + sort-key columns + `_Version` + `_IsDeleted 1`, every other column NULL), token `…:M<i>`;
3. **Keymap retirements** — `INSERT` the KeyRetires (`_IsDeleted 1`), token `…:R<i>`.

A retried INSERT (client retry on 5xx / network) reuses its token, so an insert that landed is a no-op the second time; a new flush has a new FlushID and never collides (the per-flush token of 04 §5.2; the mirror never receives rows and tombstones of one cycle in two inserts). A later cycle re-reads instead of re-sending (§58.5 step 7). The buffer exposes `append`, `due(pNow)`, `size()`, `take()`, `rows()`.

### 58.7 MaterializeSource-InProcess (`RetoldFacetingMaterializeSourceInProcess`)

The trusted reader (D-26, 06 §12): `Host.getDAL(E)` (the DAL, never the route-bound controller), a fresh `DAL.query`, `setDisableDeleteTracking(true)` (sees soft-deleted rows), an explicit projection of `Spec.SourceColumns` (never `SELECT *`, never Sensitive), **no behaviors**, `provider.Read` directly (raw rows; copied to plain objects), always an explicit `setCap` (meadow's default is 250). Its output goes only into the store.

```javascript
readRows(pEntity, pIDs, { Columns }, fCallback)                      // Identity IN (chunk) → rows (missing IDs = hard-deleted)
readRange(pEntity, pAfterID, pCap, { Columns, ToID }, fCallback)     // keyset: Identity > AfterID [AND ≤ ToID] ORDER BY Identity LIMIT Cap
readIDs(pEntity, pAfterID, pToID, fCallback)                         // [ { ID, Live } ] of the range (Bisect leaves)
sweep(pEntity, { Column, From: { At, ID }, Cap }, fCallback)         // compound keyset (04 §9.1): rows { ID, At } ordered (At, ID); → { Rows, Next }
checksums(pEntity, pLeafRange, fCallback)                            // { '<bucket>': { Count, IDSum } } over LIVE rows (§56.4: delete column = 0,
                                                                     // tenant set) — one aggregate statement per dialect (SQLite / PostgreSQL)
idsByFilter(pEntity, pFilterEntries, { Cap }, fCallback)             // FoxHound filter entries + setDisableDeleteTracking(true) → IDs (keyset-paged)
dialect(pEntity) → 'SQLite' | 'PostgreSQL'                           // the SourceDialect the type map and the compiler use
```

Aggregate statements (`checksums`) are `queryOverride` reads built only from validated identifiers and bound values, like the Live shells.

### 58.8 Filter-scoped hints (`notifyByFilter`, 09 §4.29)

`Materializer.resolveFilter(S, E, pFilter, pTenants, pSeqN)` (the entity counts as `Resolving` until done): (1) the filter as FoxHound entries — a meadow-filter string through `FilterAST.build(E, { FilterString })` + `applyToQuery` on a scratch `DAL.query`, an entry array as given; (2) **mirror** IDs: `FoldCompiler.compileFilter(Spec, Entries, { SourceDialect })` → `SELECT DISTINCT <Identity> FROM <E> FINAL WHERE _IsDeleted = 0 AND (<where>)` through `Store.queryRows` (the PRE-write predicate: rows that left the filter are found here); (3) **source** IDs: `MaterializeSource.idsByFilter` (includes rows the write soft-deleted); (4) `enqueue(S, E, M ∪ S, { Source: 'Filter', SeqN })`. A compile refusal or any error → `markDirty` (whole-entity Resync). Hard-deleted rows appear in M only and are tombstoned by the cycle's diff.

### 58.9 Crash safety

- In memory only: the PendingSet, in-flight cycles and the buffer. A crash loses them; the store's `CleanShutdown` flag is 0 while running, so the next `start` puts every entity in `Unverified` until `Reconciler.verify` (Bisect + a full Scrub) completes (§60.4). Exact requests never use an `Unverified` entity.
- `AppliedSeq` and the state row are written only after the flush's inserts were acknowledged, so a persisted state never claims data the store does not hold; a wiped store loses its state with its data (checkpoints live inside the store they describe, 04 §1.8).


---

### 58.10 The materializer lease (review: one materializer per store, D-28 enforced)

`_rfs_lease` holds one row per store (latest `_Version` wins, read FINAL). `_acquireLease`: read; an unexpired, unreleased lease of another owner → not the leader (`NotLeader`, asked again every `HeartbeatMS`); else write a claim `{ Owner: OwnerID, ExpiresAtMS: now + TTLMS }`, wait `SettleMS` (a concurrent claimant's row lands), read back: the owner of the latest row leads (of two simultaneous claimants exactly one wins). The holder renews every `HeartbeatMS` (never after `ValidUntil = claim + TTL − min(HeartbeatMS, TTL / 3)`: a process paused past it loses the lease rather than override a successor); every flush and state write checks `leaseValid(S)` first (a flush without it fails `NotLeader` and is not charged to the write breaker). A lost lease halts every loop of the store (cycles back to pending), marks its entities Absent and the store unused (`LeaseLost`), and retries; a re-acquired store boots from its state rows. A graceful `stop` writes `Released` last, so a successor takes over within a heartbeat. A process that is not the leader answers every facet Live (`StoreUnavailable`); reader-only processes that query a store another process materializes are an M6 seam (§70).

## 59. Backfill, rebuild and wipe recovery (D: `RetoldFacetingRebuilder`)

### 59.1 Backfill (first enable)

`Rebuilder.backfill(pStore, pEntity, pOptions, fCallback)`: state `Building` (never used by the Router); `BuildID` = 8 hex; `WriterLoop.beginRebuild(BuildID, true)` (targets = the shadow only, so stream hints that arrive during the build land in the shadow too); pages `addRangeTask({ Kind: 'RebuildPage', Target: shadow, AfterID, Cap: RebuildPageSize })` from `AfterID = -∞` until exhausted, interleaved by the loop's priority with Stream cycles; then `WriterLoop.finishRebuild(BuildID)` (flush, `RENAME` shadow → live, mirror then keymap); state `CatchingUp` → `Live` once the PendingSet drains. The callback reports `{ BuildID, Pages, Rows, ElapsedMS }`.

### 59.2 Rebuild (shadow + swap, 04 §7)

`Rebuilder.rebuild(pStore, pEntity, { Reason: 'Admin' | 'SpecChange' | 'Divergence' | 'Wipe' }, fCallback)` — at most one in flight per (store, entity) (a second call joins the first):

```
WriterLoop.beginRebuild(BuildID, false)        → CREATE <E>__shadow_<b> + its keymap; targets = [ Live, Shadow:<b> ]; state Rebuilding
loop: v = clock.next(); readRange(E, AfterID, RebuildPageSize) → rows @v into the shadow only (+ shadow keymap); AfterID = last ID
      (Stream cycles keep running and dual-write: each target diffed against ITS keymap)
WriterLoop.finishRebuild(b)                    → between two flushes, nothing in flight: EXCHANGE TABLES <E> AND <E>__shadow_<b>,
                                                  then the keymaps; DROP the shadows (they now hold the old data); targets = [ Live ]; Epoch++
state → Live, or Unverified when Reason is 'Divergence' (04 §8.1); LossyColumns reset to what the rebuild saw
```

**Swap failures (review):** `EXCHANGE` of the mirror and of the keymap are two statements; the store records each shadow table's UUID at `beginShadow` and, on a retry, checks whether the live name already holds the shadow's UUID (the half landed, even if the client saw an error) and resumes with the other half. A failed swap never drops the shadow: the loop holds writes, the entity is marked `Rebuilding`/`Divergence` (never Exact while the live table may be the new build and the keymap not), and `finishRebuild` is retried with back-off (500 ms ×2 to `MaxBackoffMS`) until it lands or the loop no longer runs that build. A completed build records the source's `maxStamp(Watermark)` read before its first page as the entity's `SweepWatermark`, so the next Sweep starts there.

Correctness of the dual-write window (04 §7): a row changed before its page was read is in the page; a row changed after its page was read produces a hint → a later stream cycle with a higher `_Version`, written to both tables; a row deleted after its page was read gets a tombstone in the shadow too (each target is diffed against its own keymap). Rebuild pages carry versions from the same clock as stream cycles.

### 59.3 Wipe recovery

A store error with a missing database or table (ClickHouse codes `81` `UNKNOWN_DATABASE`, `60` `UNKNOWN_TABLE`: `StoreClickHouse.WIPE_ERROR_CODES`) on a write, a state read or a request read (`Materializer.suspectWipe`, at most once per min(60 s, `RebuildCooldownMS`)) → `Materializer.recoverWipe(S)`: the loss is confirmed first (`Store.tablesExist`: which entities lost their live mirror or keymap; all of them when the database is gone); only those go `Absent` and are backfilled (Reason `'Wipe'`) after `ensureSchema`; intact entities keep running (review: one dropped table no longer rebuilt every entity). A false alarm changes nothing. The Router serves Live meanwhile (04 §13.4: "A store volume was wiped: nothing"). The O10 volume-wipe test drops the database (`Store.dropDatabase`) under a running materializer.

### 59.4 Rebuilder API (D)

```javascript
backfill(pStore, pEntity, pOptions, fCallback)
rebuild(pStore, pEntity, { Reason }, fCallback)          // REBUILD_REASONS = [ 'Admin', 'SpecChange', 'Divergence', 'Wipe' ]
status(pStore, pEntity) → null | { BuildID, Reason, Phase: 'Pages' | 'Swapping', Pages, Rows, StartedAt }
cancel(pStore, pEntity, fCallback)                       // abortRebuild; state back to the prior one (Unverified when the prior was a divergence)
```

---

## 60. Reconcile (D: `RetoldFacetingReconciler`)

All three levels only **enqueue** IDs or Range tasks; the WriterLoop's re-read and diff do every repair (04 §9). `LEVELS = [ 'Sweep', 'Bisect', 'Scrub', 'Verify' ]`.

### 60.1 Sweep (entities with a watermark only)

`Spec.Watermark` is `'UpdateDate'` when the declaration says so, or (`'Auto'`) when the entity has `UpdateDate` **and** its model column is marked `Indexed` — else null (`NoWatermark`: no Sweep; Describe / Health say so). `Reconciler.sweep(S, E, pOptions, fCallback)`: compound keyset pages through `MaterializeSource.sweep` from `(W − OverlapMS, 0)` (`OverlapMS = Reconcile.MaxTxnMS`, + 3 600 000 when the source session time zone is not UTC), `Cap = Reconcile.SweepCap`, every ID in the window that is not already pending → `Materializer.enqueue(…, { Source: 'Sweep' })` (no compare); after a **complete** pass `W = max(UpdateDate seen)` (the DB's stamps), persisted in `_rfs_entity_state.SweepWatermark`. → `{ Enqueued, Watermark, Pages }`. Interval `Reconcile.SweepIntervalMS` (`'Auto'` per §53.4).

### 60.2 Bisect (inserts and hard deletes)

`Reconciler.bisect(S, E, pOptions, fCallback)`: one pass per side — `MaterializeSource.checksums(E, LeafRange)` (live rows, §56.4) and `Store.bucketChecksums(E, LeafRange, 'Live')` (the keymap's live distinct IDs) — diffed in JS on `{ Count, IDSum }`; each differing leaf → `MaterializeSource.readIDs` and `Store.readKeyRange` → every ID present on exactly one side → `enqueue(…, { Source: 'Bisect' })`. Divergence = differing IDs / total live, **excluding** IDs pending or in flight and source rows stamped after `BisectStart − OverlapMS`; above `Reconcile.RebuildDivergenceRatio` → `Rebuilder.rebuild(S, E, { Reason: 'Divergence' })` (ends `Unverified`). → `{ Buckets, DifferingLeaves, Enqueued, Divergence, Rebuilt }`; `LastBisect` persisted. Interval `BisectIntervalMS` (`HardDeleteBisectIntervalMS` for `NoWatermark` entities). Bisect cannot see in-place updates (04 §9.2): the Scrub bounds those.

### 60.3 Scrub (everything, by rotation)

`Reconciler.scrub(S, E, { Full }, fCallback)`: Range tasks `{ Kind: 'Scrub', Target: 'Live', AfterID: ScrubCursor, Cap: ScrubRowsPerSecond × ScrubTickMS / 1000 }` at Range priority (below Stream); the cursor advances and persists (`ScrubCursor`); a wrap sets `ScrubbedThrough = <the pass's start time>`. `{ Full: true }` runs one complete pass now, as fast as the loop allows, and calls back when it wrapped (tests, `verify`, the additive-column fill with `Kind: 'Fill'`). Unconditional: no compare, because re-reads are idempotent. → `{ Ranges, Rows, Wrapped }`. Store-internal audits are a seam (no derived fields in M5).

### 60.4 Unverified recovery — `Reconciler.verify(S, E, fCallback)`

`bisect`, then a full `scrub` from the last `ScrubbedThrough` high-water (M5: the whole entity); when both completed and no newer Unverified trigger arrived → state `Live` (`UnverifiedSince` cleared, persisted). Runs at `start` for every entity booted without the clean-shutdown flag (04 §13.1, 09 §4.33).

### 60.5 Triggers

- **Timers** (`Reconcile.AutoStart`): per entity, Sweep at `SweepIntervalMS`, Bisect at `BisectIntervalMS` / `HardDeleteBisectIntervalMS`, Scrub ticking every `ScrubTickMS` with a full rotation per `ScrubPeriodMS` (`ScrubRowsPerSecond` is a ceiling); all unref'd; `stop()` clears them.
- **In-process admin** (wiring exposes it): `RetoldFacetingService.storeAdmin(pAction, pStore, pEntity, pOptions, fCallback)` with `pAction ∈ { 'Rebuild', 'Sweep', 'Bisect', 'Scrub', 'Verify' }` → the Rebuilder / Reconciler call; unknown store or entity → `404 FACET_UNKNOWN_ENTITY`; store unavailable → `503 FACET_ENGINE_UNAVAILABLE`; one in flight per (store, entity, action) and `Admin.RebuildCooldownMS` between rebuilds → `429 FACET_RATE_LIMITED { Limit: 'Admin.InFlight' | 'Admin.RebuildCooldownMS' }`.
- **Admin routes** (platform / test only): `POST <RoutePrefix>/Admin/Rebuild/:Store/:Entity` and `POST <RoutePrefix>/Admin/Reconcile/:Store/:Entity` `{ Level }` are mounted **only** when `Admin.Routes === true`; every request resolves the principal (M1 401 rules) and must pass `Admin.authorize(pRequest, pPrincipal) === true` (a host function; absent or anything else → `403 FACET_FORBIDDEN`, no Detail); `202 { Started: true, Action, Store, Entity }`. The demo never mounts them.

`Reconciler` API (D): `start(pStore)`, `stop()`, `sweep`, `bisect`, `scrub`, `verify`, `status(pStore, pEntity) → { LastSweep, Watermark, LastBisect, Divergence, ScrubCursor, ScrubbedThrough, Running: [ Level … ] }`.

---

## 61. Freshness (B: `RetoldFacetingFreshness`)

### 61.1 State machine (per (store, entity); 04 §8.1)

```
Absent ──start──► Building ──swap──► CatchingUp ──drained──► Live ◄──► Lagging   (Lagging: computed, LagMS > Freshness.LagWarnMS)
                                                               │
           SpecChange / Admin rebuild ──► Rebuilding ──swap──► Live (Unverified when the trigger was a divergence)
           breaker open on writes (5 write failures / 30 s) ──► Degraded ──flush succeeds──► CatchingUp
           unclean boot / divergence rebuild ──► Unverified ──verify done──► Live
           wipe ──► Absent ──► Building …
```

`STATES = [ 'Absent', 'Building', 'CatchingUp', 'Live', 'Lagging', 'Rebuilding', 'Unverified', 'Degraded' ]`. Transitions go through `Freshness.setState(S, E, pState, pReason)` (the Materializer, Rebuilder and Reconciler call it); the state is persisted with the next `writeState` (`Lagging` is never persisted: it is `Live` plus a lag).

### 61.2 The numbers

- **ObservedSeq(E)** — `observe(pEvent)` (intake subscriber `'Freshness'`, synchronous): `{ <NodeEpoch>: highest n }` per entity.
- **Pending work(S, E)** — from `Materializer.pendingInfo`: pending, in-flight and buffered hints, Range tasks of a Resync, a Dirty mark, filter resolutions.
- **Exact(S, E)** ⇔ state ∈ { `Live`, `Lagging`, `Rebuilding` (not divergence-triggered) } ∧ no pending work ∧ `ChangeIntake.covers(E)` (an entity whose writes no source sees can never be proven current: `NoChangeSource:<E>`) ∧ no `FillingColumns` read by the fold (checked by C).
- **AppliedSeq(S, E)** = `ObservedSeq(E)` when there is no pending work; else `min(MinSeqN of pending / in-flight / buffered entries, Dirty.MinSeqN) − 1` for the local epoch. Advanced only after a flush ack (§58.5 step 8); persisted with the state row (informational after a restart: a new process is a new epoch).
- **LagMS(S, E)** = `now − min(FirstSeen)` over pending work (0 when none); `Unverified` → `now − UnverifiedSince`; Dirty → `now − Dirty.Since`; `Building` / `Absent` / `Degraded` → `Infinity`.
- For a DepSet: `Exact` = every entity Exact; `LagMS` = max; `AsOf` = `new Date(now − LagMS).toISOString()` (`pContext.Now` when 0); `State` = the worst entity state (the `STATES` order above, `Live` best); `ApplyToken` = `'at:' + sha256(canonicalJSON([ [ E, AppliedSeq, Epoch ] … ]))[0..16]` (reported; the cache does not bind it in M5, §62.4).

### 61.3 Admission (`ADMISSION`, per entity; `admits` checks every DepSet entity)

| State | `Exact` (also any `MinSeq`, read-your-writes upgrades) | `Bounded` (`MaxLagMS`) | `Fast` |
|---|---|---|---|
| `Absent`, `Building`, `Degraded` | no | no | no |
| `CatchingUp` | no | no | yes |
| `Live`, `Lagging` | iff Exact(S, E) | iff `LagMS ≤ MaxLagMS` | yes |
| `Rebuilding` | iff Exact(S, E) and not divergence-triggered | iff `LagMS ≤ MaxLagMS` | yes |
| `Unverified` | no | iff `LagMS ≤ MaxLagMS` | yes |
| breaker open on (`ClickHouse`, E) | no | no | no |

`admits(pStore, pDepSet, pFreshness, pNow)` → `{ Admit, Reason: null | 'State:<State>:<E>' | 'Unverified:<E>' | 'NotExact:<E>' | 'Lagging:<E>' | 'NoChangeSource:<E>' | 'Breaker:<E>', Freshness: { Exact, LagMS, AsOf, State, ApplyToken, Entities } }`. `MinSeq` waiting (`MinSeqWaitMS`, nudging a flush) is a seam (§70): a `MinSeq` request is an `Exact` request.

### 61.4 Circuit breaker (per (engine, entity))

`recordFailure(pEngine, pEntity, pNow)` / `recordSuccess(…)` / `breakerOpen(pEngine, pEntity, pNow)`: `BreakerFailures` (5) failures within `BreakerWindowMS` (30 s) open the breaker for `BreakerOpenMS` (30 s); then half-open: one request is let through, a success closes it, a failure re-opens it. Read failures (the Router, §62.1) and write failures (the WriterLoop; an open write breaker is the `Degraded` state) are counted separately (`Kind: 'Read' | 'Write'`).

Review changes: only **store faults** count — `Store.isHealthFailure(pError, pBudgetMS)`: a network error, a 5xx marked retryable, or a time-out of a statement that had at least `HealthMinTimeoutMS`; never a deterministic error (a statement the server cannot parse, a parameter it cannot read: one bad request must not take the store away from every tenant), a per-query limit, `StoreBusy`, `ParameterSize` or a missing shadow. A whole-request read failure is charged once to the pivot entity, not to every DepSet entity. Half-open admits exactly one probe request: `breakerOpen(…, pClaim)` hands the probe to the first claimant (a per-request token, so every Agg of that request may use the store), `releaseProbe` frees it when the probe's request refused the store anyway; capability reads (no claim) see a half-open breaker as closed. Network failures and time-outs additionally feed the store-wide `Unreachable` detection (`UnreachableAfterFailures` within `BreakerWindowMS` → `Store.status().Available = false`, every facet Live at once with no round trip, a background ping every `UnreachablePingMS` restores it).

### 61.5 Freshness API (B)

```javascript
observe(pEvent)                    observedSeq(pEntity) → { Epoch: n }
register(pStore, pEntity, pState)  setState(pStore, pEntity, pState, pReason)   state(pStore, pEntity) → { State, Since, Reason, Epoch, Divergence }
applied(pStore, pEntity)           entityFreshness(pStore, pEntity, pNow) → { State, Exact, LagMS, AppliedSeq, ObservedSeq, Pending }
freshness(pStore, pDepSet, pNow) → §61.2 DepSet result        admits(pStore, pDepSet, pFreshness, pNow) → §61.3
recordFailure / recordSuccess / breakerOpen (pEngine, pEntity, pNow, pKind)
recordWriteFailure(pStore, pEntity) / recordWriteSuccess(pStore, pEntity)
stats() → { Entities: { 'S:E': { State, LagMS, Exact } }, Breakers: { 'Engine:E:Kind': { Open, Failures } } }
```

---

## 62. Router, envelope, Describe and the cache (wiring)

### 62.1 Routing (`Router.route`, 03 §10 as M5 needs it)

```
route(pAggs, pContext, fCallback):
  ForceEngine set                                  → that engine only (M4; the Reference never reads a store)
  no store engine registered, or Mode ≠ 'Query'   → M4 behavior (Live)
  Prefer = NormalizedRequest.Engine === 'Live' ? 'Live' : (pInternalOptions.PreferEngine || 'Auto')
  for each Agg:                                     (Prefer 'Live' → every Agg Live, Reason 'Requested')
      c = EngineClickHouse.capable(Agg, pContext)             // static (§64.1); never I/O
      a = Freshness.admits('ClickHouse', DepSet(Agg), pContext.Freshness, now)   // skipped under PreferEngine 'ClickHouse'
      store Agg iff c.Capable ∧ a.Admit; else Live with Reason c.Reason || a.Reason
  storeAggs non-empty → EngineClickHouse.execute(pContext, storeAggs, (pError, pExecution) …)
      pError (a store error: .StoreError)          → Freshness.recordFailure('ClickHouse', E, now, 'Read') for each DepSet entity,
                                                      Warning FACET_STORE_FALLBACK, every store Agg re-run on Live (same request, same deadline)
      pExecution.Refused { AggKey: Reason }        → those Aggs re-run on Live (capture-time refusals, §64.2); no warning
      success                                       → Freshness.recordSuccess(…)
  Live Aggs → EngineLive.execute(pContext, liveAggs, …)        (a CubePlan whose members are split across engines runs each
                                                                 engine over its own members only: the wiring passes each engine
                                                                 the cube restricted to the Aggs it got)
  merge: Results, Errors, Captures (union), Statements (sum), Engines { AggKey: 'ClickHouse' | 'Live' }, Freshness { AggKey: … }
```

The store attempt's deadline is `0.4 ×` the remaining request deadline (`max_execution_time`, §57.3), so a fallback still has time. A whole-request store error never becomes a client error: it falls back. A per-Agg store failure (a timeout of one statement) falls that Agg back. Records / Count / Keys never route (D-38).

Review changes: the store attempt's budget is `pContext.Store.DeadlineAt = now + 0.4 × (Deadline − now)`, carried by every statement both as `max_execution_time` and as the client's own `TimeoutMS` (a hung server — accepting and never answering — is cut off by the client, not only by the server). The Live Aggs of the request run **concurrently** with the store attempt (not after it); a fallback runs a second Live execution for the store Aggs that failed, within the same request deadline. `pRun.Abandon` lets a request whose deadline passed stop issuing statements. Store-side warnings are rate-limited (`WARN_EVERY_MS` 10 s per reason). A request read that hits a wipe code calls `Materializer.suspectWipe(S)`.

### 62.2 Request

`NormalizedRequest.Engine: 'Auto' (default) | 'Live'` (`contract/Facet-Contract-Request.js`, every mode reads it, only a Query uses it; anything else → `400 FACET_REQUEST_INVALID { Field: 'Engine' }`). `'Live'` never routes to a store (the demo's "Live" side of the toggle; a client may always ask for the authoritative engine). It is not key material: it can only make an answer a Live answer.

### 62.3 Envelope (wiring; `contract/Facet-Contract-Envelope.js`)

- Each FacetResult's `Engine`, `Exact`, `AsOf`, `LagMS` come from the engine that answered its Agg: Live → `Engine: 'Live', Exact: true, LagMS: 0, AsOf: pContext.Now`; ClickHouse → `Engine: 'ClickHouse'` and the Agg's `Freshness.freshness('ClickHouse', DepSet(Agg))` read **before** execution (`Exact`, `LagMS`, `AsOf`); `Stale: false` and `Cached: false` for every computed answer (Stale stays the cache's notion, 02 §4.1).
- Envelope: `Engine` = the Total's engine when the Total was requested, else the first facet's (request order); `Exact` = every facet and the Total Exact; `LagMS` = max; `AsOf` = the oldest.
- `Store` block — present **only** when a store is registered (so M1–M4 envelopes are unchanged):
  ```javascript
  Store: { Name: 'ClickHouse', Available: true,
           Facets: { '<Key>': { Engine: 'ClickHouse' | 'Live', Reason: null | '<reason>' } },   // '#Total' included
           Fallback: null | { Reason: 'Error' | 'Timeout' | 'Breaker' } }
  ```
  `Reason` is the full §65 reason when `Stores.ClickHouse.ExposeReasons` is true (the demo), else its class (the text before the first `':'`, e.g. `'NotMirrored'`) — entity and column names of other tables and the names of behavior-appended columns stay in the logs and `pMeta.Store`. `normalizeForComparison` strips `Store` (added to `VOLATILE_FIELDS`).
- `Warnings`: `{ Code: 'FACET_STORE_FALLBACK', Detail: { Store: 'ClickHouse', Reason } }` once per request whose store attempt failed. Capability / freshness refusals add no warning.

### 62.4 Version and the result cache

An answer with **any** facet served by a store is post-execution `Bypass 'Store'` (added to `UNCACHEABLE_REASONS`): the digest Version (§10.5 — it hashes the representation, so a 304 is never stale) and never stored. Binding a store answer to the cache needs an `ApplyToken` in the entry (05 §6.4) — a seam (§70). A cache **hit** or a 304 for a request that would have used the store is still correct: those entries and generation Versions belong to Live answers, which a matching GenVector proves current. `Engine: 'Live'` requests and every Live-only answer cache exactly as in M4.

### 62.5 Describe (wiring)

`Engines.ClickHouse = { Configured, Available, Reason, Entities: { E: { State, LagMS, Exact } } }` (only `canRead` entities). `Entities[E].Store = { ClickHouse: { Materialized: true | false, State, Reason: null | 'NotDeclared' | 'Disabled' | 'LossyColumn:<C>' …, Watermark: 'UpdateDate' | null } }` when a store is registered; facet descriptors list `Engines: [ 'Live', 'ClickHouse' ]` when every entity they read is mirrored. `status()` gains `{ Stores: Materializer.status(), Freshness: Freshness.stats(), StoreClickHouse: StoreClickHouse.status() }`.

### 62.6 Harness `Store` option (wiring, `test/support/Facet-Test-Harness.js`)

`start({ …, Store: 'ClickHouse', StoreOptions: { Materialize: 'All' | { … }, Reconcile: { … } } })`: requires the CH gate (else the harness calls back `.Skip === true`, like PostgreSQL); a fresh database `rfs_<pid>_<n>` (§69.3) put into `Faceting.Stores.ClickHouse`; `Materialize: 'All'` declares every catalog entity of the fixture; `Reconcile.AutoStart: false` unless given; after attach the harness waits for `Materializer.quiesce` (backfill done). Members: `store` (the StoreClickHouse service), `materializer`, `quiesce(fCallback)`, `storeQuery(pEntity, pBody, pOptions, cb)` (in-process with `PreferEngine: 'ClickHouse'`), `compareStore(pEntity, pBody, pOptions, cb)` → `{ Store, Live, Reference, StoreNormalized, LiveNormalized, ReferenceNormalized, Engines }` (O3 in one call); `stop` drops the database.

---

## 63. The ClickHouse fold compiler (C: `ClickHouse-FoldCompiler.js`)

### 63.1 Input and output

Pure functions, no I/O, no fable:

```javascript
compileAgg(pAgg, pInput) → { Statements: [ { Purpose, SQL, Params: { name: value }, Types: { name: 'Int64' … }, Settings: { … } } ], Fold: '<row shape, §63.5>' }
                         | { Refused: '<§65 reason>' }
compileCube(pCubePlan, pMemberAggs, pInput) → { Statement, Fold: 'CubeGrain' } | { Refused }     // the grain statement for CubeExecutor.marginalize
compileRelation(pRel, pInput) → { SQL: '(SELECT … FINAL WHERE …) AS `<As>`', Params, Types } | { Refused }
compileFilter(pSpec, pEntries, pInput) → { SQL, Params, Types } | { Refused }                     // FoxHound entries → a WHERE fragment (also §58.8)
compileFoldPred(pPred, pInput) → { SQL, Params, Types } | { Refused }
dimensionExpression(pDimension, pColumnSQL, pInput) → { SQL, Params, Types } | { Refused }

pInput =
{
	Database: 'rfs_main',
	Specs: { Entity: MirrorSpec },                     // the identifier whitelist
	Relations: { '<As>': { Entity, Filter: [ <final FoxHound entries> ], Capture } },   // §64.2, one per Rel alias the Agg reaches
	Fragments: { … },                                  // the probed PredicateFragment operator transforms (§63.3), from PredicateCompiler.probeTransforms
	Lossy: { Entity: { Column: 'Compare' | 'Value' } }, Filling: { Entity: [ … ] },
	SourceDialect: 'SQLite' | 'PostgreSQL', SourceStringOrder: 'Binary' | 'Collated',
	Limits: <resolved Limits>, Geometry: null | <§10.3.2 geometry, NumericHistogram second phase>
}
```

### 63.2 Relations, scope and identifiers

- A `Rel` compiles to a derived table `(SELECT <Project> FROM `<Database>`.`<Entity>` FINAL WHERE `_IsDeleted` = 0 AND (<compileFilter(Relations[As].Filter)>)) AS `<As>`` — the **final** FoxHound filter of that Rel's capture: the client fence, the `Where` fence, the explicit soft delete, every behavior-appended entry, behavior operator transforms and TenantOnly relaxations already applied, exactly what Live renders (§64.2). One `FINAL` scan per relation; the pivot relation appears once per statement (the cube makes it one per pivot, §63.6).
- Identifiers only from the spec (`Specs[E].ColumnNames`, the DDL names), validated against `IDENTIFIER_PATTERN` and backtick-quoted; a column the spec lacks → `NotMirrored:<E>.<C>`; one still filling → `NotMirrored:<E>.<C>`; a `'Value'`-lossy column read anywhere, or a `'Compare'`-lossy one in a predicate or On pair → `LossyColumn:<E>.<C>`.
- **Fail closed** (06 §4.3): a `Tenant` / `Personal` entity whose final filter has no depth-0 `=` `AND` entry on its tenant column → `ScopeMissing:<E>` (the guard should have refused first; the compiler never emits an unscoped query). A non-Portable or Opaque capture never reaches the compiler (`OpaqueScope:<E>`, §64.2).
- **Parameters** are all `{name:Type}`: filter entries of relation `<As>` are `<As>_<i>` (i = the entry's ordinal among value-bearing entries), statement values `f<Name>` (`fMaxGroups`, `fSelected`, `fE<i>`, `fLoUnits` …), fragment values `q<n>_<i>`; types from `TypeMap.paramType` of the spec column (`Array(T)` for `IN` / `NOT IN`), shell numbers `Int64` / `UInt32` / `Float64`. No value is ever concatenated into SQL.

### 63.3 Predicates (`compileFilter`, `compileFoldPred`)

FoxHound entry → ClickHouse (04 §5.4), connectors and `(` / `)` groups as FoxHound renders them (the first entry of a group ignores its connector):

| Entry | ClickHouse |
|---|---|
| `=` `!=` `<>` `<` `<=` `>` `>=` | the same, `` `C` <op> {p:T} `` (`<>` → `!=`) |
| `IN` / `NOT IN` (array value) | `` `C` IN {p:Array(T)} `` / `` (isNotNull(`C`) AND NOT (`C` IN {p:Array(T)})) `` (review: a column NOT IN drops a NULL row, as FoxHound's `C NOT IN (…)` does under SQL's three-valued logic); Float64 lists as `has(arrayMap(…), C)`; an empty array → `0` / `1` |
| `IS` with `null`, `IS NULL` / `IS NOT NULL` | `isNull(`C`)` / `isNotNull(`C`)` |
| `LIKE` / `NOT LIKE` | SQLite source: `ilike` / `NOT ilike` (SQLite LIKE is ASCII case-insensitive) with every `\` in the pattern doubled (SQLite has no LIKE escape; ClickHouse treats `\` as one); a pattern with a non-ASCII character → `LikeCase:<E>.<C>`. PostgreSQL source: `like` / `notLike` as given |
| `ILIKE` / `NOT ILIKE` (a behavior transform) | `ilike` / `NOT ilike` |
| any other operator | `OperatorUnsupported:<op>` |

- **Three-valued logic:** a comparison with NULL is NULL (false in WHERE) in both systems; only negations need care. A **column** `NOT IN` is unknown for a NULL column and drops the row (Live's `C NOT IN (…)`), so it renders `isNotNull(C) AND NOT (C IN …)` (corrected by the review: the as-built `NOT ifNull(C IN …, 0)` kept NULL rows the list does not return — O3 now covers NOT IN over nullable String, Int64 and Float64 columns, alone and inside an OR group). **Anti-joins** (path NOT EXISTS) keep `NOT ifNull(… IN …, 0)`: a row with no (or a NULL) correlation value is kept, exactly as Live's `NOT EXISTS` keeps it.
- **Value typing:** each value must parse exactly as the column's mirror type (JS-side check before binding): integers for `Int64` (a FilterString value `'4.5'` on an integer column → `ValueType:<E>.<C>`), finite numbers for `Float64`, `0` / `1` (or the boolean words) for `UInt8`; `LIKE` only on `String` columns (`OperatorType:<E>.<C>`).
- **DateTime literals** (`TypeMap.canonicalDateLiteral`): a canonical `'YYYY-MM-DD HH:mm:ss'` binds as itself under any operator; a day-only `'YYYY-MM-DD'` binds as `'YYYY-MM-DD 00:00:00'` under `>=` / `<` on both dialects (what clause compilation emits, M1 §16.22) and under any operator on PostgreSQL (a timestamp literal); any other form, or a day-only literal under `>` / `<=` / `=` / `!=` on SQLite (a text comparison there) → `DateLiteral:<E>.<C>`.
- **String ranges:** `<` `<=` `>` `>=` on a `String` column compile only when `SourceStringOrder` is `'Binary'` (`'Auto'` → `'Binary'` on SQLite, `'Collated'` on PostgreSQL), else `StringOrder:<E>.<C>`.
- **PredicateFragments** (`Cmp` leaves outside a relation: scope leaves under `Any`, W_def leaves, cube flags, nested Where leaves on a hop alias) render the **post-behavior** operator recorded by the per-entity fragment probe (`PredicateCompiler.probeTransforms`, §26.4), as Live does; a leaf whose transform the compiler cannot reproduce → `Transformed:<E>`.
- **Existence nodes** (`FoldPred`), at outer alias `o`:
  - `Exists { Rel, On, Where }` → `ifNull((o.A1[, o.A2 …]) IN (SELECT r.I1[, r.I2 …] FROM <Rel> WHERE <Where>), 0)` (a one-pair `On` uses the scalar form); nested `Where` compiled recursively with the inner alias in scope;
  - `NotExists` → `NOT ifNull(… IN (…), 0)` (verified: a NULL outer value keeps the row; a tuple with a NULL element never matches);
  - `CountCmp { Rel, On, Where, Op, N }` with `P(c) = c Op N`: when `P(0)` is false → `ifNull(o.A IN (SELECT r.I FROM <Rel> WHERE … GROUP BY r.I HAVING P(count())), 0)`; when `P(0)` is true → `NOT ifNull(o.A IN (SELECT … HAVING NOT P(count())), 0)`;
  - `And` / `Or` / `True` / `False` → `(… AND …)` / `(… OR …)` / `1` / `0`.

### 63.4 Dimensions and measures (`dimensionExpression`)

| Dim | ClickHouse key expression (value `v`) |
|---|---|
| `Column` | `v` (keys normalized by DataType in the fold, §9.2) |
| `DateBucket` | `day` `toDate32(v)`, `week` `toMonday(v)`, `month` `toStartOfMonth(v)`, `quarter` `toStartOfQuarter(v)`, `year` `toStartOfYear(v)` — Date32 under `enable_extended_results_for_datetime_functions = 1`, then `formatDateTime(b, '%Y-%m-%d 00:00:00')` on the ≤ `MaxDateBuckets + 2` result rows; bounds `formatDateTime(min(v) / max(v), '%Y-%m-%d %H:%i:%S')` |
| `NumericBucket` Nice | units `u = if(v < 0, -floor(-v * {fFactor} + 0.5), floor(v * {fFactor} + 0.5))` (half away from zero, = `FacetBuckets.units`); `c = least(intDiv(toInt64(u) - {fLoUnits:Int64}, {fWidthUnits:Int64}), {fLastIndex:Int64})` (non-negative by construction, so `intDiv` floors); `multiIf(v < ({fLoUnits} + c * {fWidthUnits}) / {fFactor}, c - 1, c < {fLastIndex} AND v >= ({fLoUnits} + (c + 1) * {fWidthUnits}) / {fFactor}, c + 1, c)` — §10.3.2 exactly; integer columns `fFactor = 1` |
| `NumericBucket` Edges | `multiIf(v >= {fE0} AND v < {fE1}, 0, …, v >= {fEn}, n, NULL)` (the open bucket only when `OpenEnded`; outside → NULL, no group) |
| `Range` | `multiIf(isNull(v), -1, <cond0>, 0, <cond1>, 1, …, -2)` with `From` / `To` bound `Float64` (first match wins, CASE semantics; `-1` NULL → Missing, `-2` → `NO_RANGE_KEY`) |
| `Via` (K8) | `ANY LEFT JOIN (SELECT r.<To> AS `l1_k`, r.<Field> AS `l1_v` FROM <Rel l1>) AS l1 ON <outer FK> = l1.l1_k` per link (`join_use_nulls = 1`: an invisible target is NULL, never a dropped row); the derived table projects only the join key and uniquely aliased values so unqualified pivot columns still resolve |
| `Multi` (K9) | inner joins along the chain from the pivot set; `Count = uniqExact(p.<PK>)` per key (`PivotDistinct`); a NULL `KeyField` is no key; `Total` = count of the pivot set; covered = `uniqExact(p.<PK>)` over rows with a key → `MissingCount = Total − covered` (three statements or one with `GROUPING SETS`, C's choice; the row shapes are Live's MultiTerms / Count / MultiCovered) |
| `ChildAgg` (K12) | `p LEFT JOIN (SELECT r.<inner> AS K, count() AS N FROM <child Rel> WHERE <Where> AND r.<inner> IN (SELECT <outer> FROM <pivot Rel>) GROUP BY K) AS x ON p.<outer> = x.K`, band `multiIf(ifNull(x.N, 0) < {fE0}, 0, … , n)` with `Edges[0] = 1` (band 0 = no visible matching child, 01 §4.6) |
| `ExistsFlag` (K20) | the `Exists` expression of §63.3 as the `UInt8` key (`1` / `0`) |
| TuplePivot (K18) | `FROM <side p> INNER JOIN <side u1> ON p.a = u1.b …` (sides Home first, §24.4), counts `uniqExact(tuple(<Key columns>))` per key and in total (`KeyDistinct`) |

Measures: `count()` rows; `Stats` → `count() AS Rows, count(v) AS NonNull, min(v) AS Min, max(v) AS Max, sum(toInt64(<units of v>)) AS SumUnits` (dates: `formatDateTime(min(v), …)`, `SumUnits` NULL); `DistinctCount` → `uniqExact(v)` (`ExactDistinctMaxRows` / `uniqCombined64` is a seam); `Missing` → `count() AS Rows, count(v) AS NonNull`.

### 63.5 Per-kind statements and row shapes

Every statement returns **the row shape the Live shell of the same kind returns**, so `EngineLive.foldRows` folds both (one normalization path; C may call it, it is pure over `pRows`):

| Kind | Rows |
|---|---|
| `Count` | `{ Total }` |
| `Terms` (K1, K8 via, K14 axis forms) | `{ Key, Count, FacetTotal, FacetMissing, FacetDistinct }` — ranked `ORDER BY isNull(Key), Count DESC, Key ASC`, at most `max(Top + 1, MaxTermsGroups)` ranked rows plus every `Agg.SelectedKeys` key (`fSelected`) |
| `DateHistogram` | `{ Key, Count, Lo, Hi }` per bucket, the NULL-key row = Missing; at most `MaxDateBuckets + 2` rows |
| `NumericHistogram` | bounds `{ Rows, NonNull, Lo, Hi }`, then `{ Key: <index>, Count }` (two statements; the geometry comes from `FacetBuckets` between them, exactly as Live) |
| `Ranges` | `{ Key: <index or -1>, Count }` |
| `Stats` / `DistinctCount` / `Missing` | `{ Rows, NonNull, Min, Max, SumUnits }` / `{ Rows, NonNull, Distinct }` / `{ Rows, NonNull }` |
| `Pivot` (K14) | `{ K1, K2, Count }` (index keys for Range axes), at most `CubeMaxGroups + 1` rows |
| `ChildRollup` / `ExistsSplit` | `{ Key, Count }` |
| Multi Terms (K9) | `MultiTerms { Key, Count, FacetDistinct }`, `Count { Total }`, `MultiCovered { Covered }` |

Total / Variant semantics are §5.3 and §24.9 unchanged: every count over the Agg's Variant base set (`Rel.Client` in the pivot relation, `Variant.PathPred` and `Agg.Where` as pivot-level predicates **before** any dimension join, §26.4).

### 63.6 The cube (one FINAL scan per pivot)

When the plan carries a `CubePlan` (§25.2) and every member is store-routed, `compileCube` emits the grain statement — the Common relation, the flags `b<n>` / `w<n>` as `UInt8` expressions of §63.3, the `d<n>` dimension expressions, `count() AS N`, the bounds and measure columns — one `GROUP BY` with at most `CubeMaxGroups + 1` rows, and the engine marginalizes with `CubeExecutor.marginalize` (pure). It falls back to per-Variant statements exactly when Live does (a `Transformed` Common capture or flag leaf, over `CubeMaxGroups`), and its members' RawFacetResults must equal the per-Variant ones (O5 on ClickHouse).

### 63.7 Worked examples (the compiler's output for these FoldIR inputs must be equivalent; the goldens pin the exact text)

Conventions: database `rfs_main`; ProjectTrack / LabTrack tenant 1 (`IDCustomer`), principal `IDUser` 42; whitespace is illustrative. All five were executed on 24.8 by the contracts pass.

**K1 Terms** — `Project.Status`, `Exclude: 'Self'`, a kept client clause `IDClient IN (3, 5)`; the pivot relation's final filter is `( IDClient IN [3,5] ) AND Deleted = 0 AND IDCustomer = 1` (fence, explicit soft delete, the tenancy behavior's entry):

```sql
SELECT Key, Count, FacetTotal, FacetMissing, FacetDistinct
FROM
(
	SELECT Key, Count,
		sum(Count) OVER () AS FacetTotal,
		sumIf(Count, isNull(Key)) OVER () AS FacetMissing,
		countIf(isNotNull(Key)) OVER () AS FacetDistinct,
		row_number() OVER (ORDER BY isNull(Key) ASC, Count DESC, Key ASC) AS FacetRank
	FROM
	(
		SELECT p.`Status` AS Key, count() AS Count
		FROM (SELECT `IDProject`, `Status` FROM `rfs_main`.`Project` FINAL
		      WHERE `_IsDeleted` = 0 AND (( `IDClient` IN {p_0:Array(Int64)} ) AND `Deleted` = {p_1:UInt8} AND `IDCustomer` = {p_2:Int64})) AS p
		GROUP BY Key
	)
)
WHERE FacetRank <= {fMaxGroups:UInt32} OR Key IN {fSelected:Array(String)}
ORDER BY FacetRank
-- p_0 = [3,5], p_1 = 0, p_2 = 1, fMaxGroups = max(Top + 1, MaxTermsGroups), fSelected = Agg.SelectedKeys ([] here)
```

**K2 DateHistogram** — `Document.DocumentDate`, `Interval: 'month'`, kept clause `IDFormType IN (4)`:

```sql
SELECT if(isNull(B), NULL, formatDateTime(B, '%Y-%m-%d 00:00:00')) AS Key, Count,
       formatDateTime(LoV, '%Y-%m-%d %H:%i:%S') AS Lo, formatDateTime(HiV, '%Y-%m-%d %H:%i:%S') AS Hi
FROM
(
	SELECT toStartOfMonth(p.`DocumentDate`) AS B, count() AS Count, min(p.`DocumentDate`) AS LoV, max(p.`DocumentDate`) AS HiV
	FROM (SELECT `IDDocument`, `DocumentDate` FROM `rfs_main`.`Document` FINAL
	      WHERE `_IsDeleted` = 0 AND (( `IDFormType` IN {p_0:Array(Int64)} ) AND `Deleted` = {p_1:UInt8} AND `IDCustomer` = {p_2:Int64})) AS p
	GROUP BY B
)
ORDER BY isNull(B), B
LIMIT {fMaxGroups:UInt32}
SETTINGS enable_extended_results_for_datetime_functions = 1     -- (sent as a URL setting, §57.3)
-- fMaxGroups = MaxDateBuckets + 2; gap fill and TOO_FINE stay in post-processing (§5.3)
```

**K10 PathSemiJoin** — the `#Total` of `Project` under the Variant path predicate `Exists { <ProjectMembership.IDProject, Where IDUser = 42 AND Active = 1 }` (hop alias `h1`, its own captured scope):

```sql
SELECT count() AS Total
FROM (SELECT `IDProject` FROM `rfs_main`.`Project` FINAL
      WHERE `_IsDeleted` = 0 AND (`Deleted` = {p_0:UInt8} AND `IDCustomer` = {p_1:Int64})) AS p
WHERE ifNull(p.`IDProject` IN
	(SELECT h1.`IDProject`
	 FROM (SELECT `IDProjectMembership`, `IDProject` FROM `rfs_main`.`ProjectMembership` FINAL
	       WHERE `_IsDeleted` = 0 AND ((`IDUser` = {h1_0:Int64} AND `Active` = {h1_1:UInt8}) AND `Deleted` = {h1_2:UInt8} AND `IDCustomer` = {h1_3:Int64})) AS h1), 0)
```

**K11 AntiPath, composite correlation, TenantOnly hop** — E3A `MaterialIntakeRequirement.MyFormsToDo/ByDiscipline`-style Terms on `IDLabFormType` with `NotExists { =LabForm.IDMaterialIntake (TenantOnly), Where Status = 'Complete', Correlate IDLabFormType }`; the LabForm relation's final filter has the tenant entry but **no** `OwnerIDUser` entry (relaxed by the capture, §26.2):

```sql
SELECT Key, Count, FacetTotal, FacetMissing, FacetDistinct
FROM ( SELECT Key, Count, sum(Count) OVER () AS FacetTotal, sumIf(Count, isNull(Key)) OVER () AS FacetMissing,
              countIf(isNotNull(Key)) OVER () AS FacetDistinct, row_number() OVER (ORDER BY isNull(Key) ASC, Count DESC, Key ASC) AS FacetRank
       FROM ( SELECT p.`IDLabFormType` AS Key, count() AS Count
              FROM (SELECT `IDMaterialIntakeRequirement`, `IDMaterialIntake`, `IDLabFormType` FROM `rfs_main`.`MaterialIntakeRequirement` FINAL
                    WHERE `_IsDeleted` = 0 AND (`Deleted` = {p_0:UInt8} AND `IDCustomer` = {p_1:Int64})) AS p
              WHERE NOT ifNull((p.`IDMaterialIntake`, p.`IDLabFormType`) IN
                    (SELECT h2.`IDMaterialIntake`, h2.`IDLabFormType`
                     FROM (SELECT `IDLabForm`, `IDMaterialIntake`, `IDLabFormType` FROM `rfs_main`.`LabForm` FINAL
                           WHERE `_IsDeleted` = 0 AND ((`Status` = {h2_0:String}) AND `Deleted` = {h2_1:UInt8} AND `IDCustomer` = {h2_2:Int64})) AS h2), 0)
              GROUP BY Key ) )
WHERE FacetRank <= {fMaxGroups:UInt32} OR Key IN {fSelected:Array(Int64)}
ORDER BY FacetRank
-- a requirement whose IDMaterialIntake is NULL stays "to do" (NOT EXISTS semantics), verified
```

**K12 ChildRollup** — `Project.MyOverdueBand` (`Edges: [1, 3, 10]`), child `Task` with `Where AssignedIDUser = 42 AND DueDate < $Now`:

```sql
SELECT multiIf(ifNull(x1.N, 0) < {fE0:Int64}, 0, ifNull(x1.N, 0) < {fE1:Int64}, 1, ifNull(x1.N, 0) < {fE2:Int64}, 2, 3) AS Key, count() AS Count
FROM (SELECT `IDProject` FROM `rfs_main`.`Project` FINAL
      WHERE `_IsDeleted` = 0 AND (`Deleted` = {p_0:UInt8} AND `IDCustomer` = {p_1:Int64})) AS p
LEFT JOIN
	(SELECT x1i.`IDProject` AS K, count() AS N
	 FROM (SELECT `IDTask`, `IDProject` FROM `rfs_main`.`Task` FINAL
	       WHERE `_IsDeleted` = 0 AND ((`AssignedIDUser` = {x1_0:Int64} AND `DueDate` < {x1_1:DateTime64(3, 'UTC')}) AND `Deleted` = {x1_2:UInt8} AND `IDCustomer` = {x1_3:Int64})) AS x1i
	 WHERE x1i.`IDProject` IN (SELECT `IDProject` FROM `rfs_main`.`Project` FINAL
	                          WHERE `_IsDeleted` = 0 AND (`Deleted` = {p_0:UInt8} AND `IDCustomer` = {p_1:Int64}))
	 GROUP BY K) AS x1
ON p.`IDProject` = x1.K
GROUP BY Key ORDER BY Key
-- fE0 = 1, fE1 = 3, fE2 = 10; x1_1 = the bound $Now ('2026-10-08 12:00:00'); join_use_nulls = 1 → a project with no visible overdue task is band 0
```

---

## 64. `RetoldFacetingEngineClickHouse` (C)

### 64.1 `capable(pAgg, pContext)` — pure, static

`{ Capable: true }` iff all hold, else `{ Capable: false, Reason }` with the first failing reason: the store is `Available` and its materializer running (`StoreUnavailable`); `pContext.Mode === 'Query'` (`Mode`); the kind is one Live supports (§27.1; anything Live refuses the store refuses: `KindUnsupported:<Kind>`); the Variant is not `IncludesDeleted` and excludes no conjunct that `NamesDeleted` (`DeletedRowsNotMirrored`); `MirrorSpec.covers('ClickHouse', DepSet, Filling)` (`NotMirrored:<E>` / `NotMirrored:<E>.<C>`); no Lossy column read per §56.3 (`LossyColumn:<E>.<C>`, from `Materializer.entityInfo`); the read breaker is closed for every DepSet entity (`Breaker:<E>`). Freshness admission is the Router's (§62.1).

### 64.2 `execute(pContext, pAggs, fCallback)`

1. **Captures.** For every Rel the Aggs reach (pivot relations per Variant, hops of `PathPred` / `Agg.Where`, Via / Multi / Child / tuple sides): `ScopedRelationBuilder.captureRelation(pContext, pRel)` — §26.1 steps 1–5 without projection, build or harvest (C adds this method to the builder, add-only; memoized per request with the relation key minus `Project`, counted against `MaxRelationsPerRequest` / `MaxBehaviorRunsPerRequest` like Live) → `{ Entity, Alias, Filter: <deep copy of query.parameters.filter after capture, relaxation and guard repair>, Capture, Opaque }`. A capture error that Live would also raise (401, a Strict guard 500, `TOO_LARGE`) is returned exactly as Live returns it (whole request or per facet, §36 #34): the store never hides a security error behind a fallback. An Opaque / non-Portable capture → that Agg is `Refused: 'OpaqueScope:<E>'` (never staged). Fragment probes as Live (`PredicateCompiler.probeTransforms`).
2. **Compile** each Agg (`compileAgg`, or `compileCube` for a cube whose members are all here); a `{ Refused }` goes to `Execution.Refused[AggKey]`.
3. **Freshness** per Agg (`Freshness.freshness('ClickHouse', DepSet(Agg))`, read before the statements run) → the RawFacetResult's engine fields.
4. **Run** through `Store.queryRows` with `max_execution_time` from the deadline (§57.3); statements of one request may run concurrently up to `Execution.MaxParallelStatements`; rows → `EngineLive.foldRows` / NumericHistogram two-phase / Multi three statements / `CubeExecutor.marginalize`.
5. **Errors.** A store error (`.StoreError`) → `fCallback(error)` (the Router falls back and counts the breaker) unless only some Aggs failed, in which case those go to `Refused` with `'StoreError'` and the rest return; a per-facet `FACET_TOO_LARGE` / `FACET_INTERVAL_TOO_FINE` from post-processing rules stays a per-facet error exactly as on Live (the same contract math raises it).

`Execution` = the §9.1 shape with `Engine: 'ClickHouse'`, `Exact` / `AsOf` / `LagMS` per Agg in `Freshness: { AggKey: … }`, `Refused: { AggKey: Reason }`, `Statements` (ClickHouse statements), `Captures` (as Live, so Versions and `ScopeRepaired` keep working).

`freshness(pDepSet)` → `Freshness.freshness('ClickHouse', pDepSet, Date.now())`.

---

## 65. Store-eligibility reasons

A store answers an Agg only when every check passes; otherwise the Agg runs Live and its reason is reported (`Store.Facets[Key].Reason`, `pMeta.Store.Refused`, debug log). **Refusal is never a wrong number** (O3).

| Reason | Where | Rule |
|---|---|---|
| `Requested` | Router | the request asked `Engine: 'Live'` |
| `StoreUnavailable` | capable | not configured / not connected / materializer off |
| `Mode` | capable | Records / Count / Keys (never routed) |
| `KindUnsupported:<Kind>` | capable | a kind Live refuses too |
| `DeletedRowsNotMirrored` | capable | Show-deleted: the Variant names the delete column |
| `NotMirrored:<E>` / `NotMirrored:<E>.<C>` | capable / compile | closure rule (§55.3), filling columns, behavior-appended columns |
| `LossyColumn:<E>.<C>` | capable / compile | §56.3 |
| `Breaker:<E>` | capable / admits | §61.4 |
| `State:<State>:<E>`, `Unverified:<E>`, `NotExact:<E>`, `Lagging:<E>`, `NoChangeSource:<E>` | admits | §61.3 |
| `OpaqueScope:<E>` | execute | an Opaque / non-Portable capture (06 §4.3) |
| `ScopeMissing:<E>` | compile | fail-closed tenant check (§63.2) |
| `OperatorUnsupported:<op>`, `OperatorType:<E>.<C>`, `ValueType:<E>.<C>`, `DateLiteral:<E>.<C>`, `LikeCase:<E>.<C>`, `StringOrder:<E>.<C>`, `Transformed:<E>` | compile | §63.3 |
| `StoreError` | execute | a statement failed (the request also gets `FACET_STORE_FALLBACK` when the whole store attempt failed) |

`REASON_CLASSES` (the compiler module) lists every class; `Reason.split(':')[0]` is always one of them.

---

## 66. Tests (O3, O10) and obligations per file

### 66.1 Gating and shared support

- **Gate:** `RFS_TEST_CLICKHOUSE=1` (the `rfs-test-clickhouse` container) or `RFS_TEST_CLICKHOUSE_URL=http://user:password@host:port` (that server; only `rfs_<pid>_<n>` databases are created and dropped there, never swept). Neither → every ClickHouse suite is **skipped**, so `npm test` stays fast and docker-free. With the gate on, an unreachable server is a hard failure in `suiteSetup`, never a pending test. Suites that also need PostgreSQL gate on both (`RFS_TEST_POSTGRES=1 RFS_TEST_CLICKHOUSE=1`).
- **`test/support/Facet-Docker-ClickHouse.js`** (§69.1) — implemented by the contracts pass.
- **`test/support/Facet-ClickHouse-Support.js`** (A): `available()` → `{ Available, Reason }`; `ensure(fCallback)` (once per process, through the docker helper); `freshDatabase()` → `'rfs_<pid>_<n>'` (registered for the leftover sweep's keep list); `storeOptions(pDatabase, pExtra)` → a `Stores.ClickHouse` object for the test server; `release(pDatabase, fCallback)` (DROP DATABASE); `loadMirrors(pHarness, { Database, Entities }, fCallback)` — the **static loader** C's execution tests and A's own tests use before the materializer exists: MirrorSpec compile → `Store.configure / connect / ensureSchema / createLive` → every source row through `MaterializeSource`-equivalent trusted DAL reads → `TypeMap.toStoreRow` → `Store.writeBatch(…, 'Live')`; `assertMirrorEqualsSource(pHarness, pStoreName, pEntity, fCallback)` — the O10 invariant: the live, non-quarantined source rows converted by `TypeMap.toStoreRow` equal `Store.readLeafRows` over the whole range, row for row and column for column (meta columns excluded), and the keymap's live keys equal the mirror's; mismatch → an Error with `.Report = { Missing, Extra, Different }` (IDs only, never values).
- **`test/support/Facet-Store-Fake.js`** (B): an in-memory store implementing every write-side method of §54.3 (`readKeys`, `readKeyRange`, `writeBatch` with per-table token dedup, shadows and swaps, state, `bucketChecksums`, `readLeafRows`, `maxVersion`) plus `failNext(pMethod, pWhen)` fault injection and `tables()` for assertions; B's and D's unit tests run the WriterLoop / Rebuilder / Reconciler against it with no ClickHouse.
- Every ClickHouse suite uses a fresh database per harness and drops it in `suiteTeardown`; none touches the demo's `rfs_demo_*` databases.

### 66.2 Obligations per file

| File (owner, port) | Must prove |
|---|---|
| `test/Facet-Store-ClickHouse_tests.js` (A, 19141) | **unit (no CH):** `formatParam` (scalars, NULL, arrays with quotes / backslashes / NULL), setting-name and param-name validation, 64-bit normalization from `meta`, error parsing (`Code`, `Status`, `Retryable`, no secret in a message); TypeMap every row of §56.3 incl. every Lossy case (SQLite `''` in an integer column, 499.996-style decimals stay exact, `'2022-01-01T00:00:00'` → Compare, `'1899-12-31'` → Value, bigints, Buffers, Booleans), quarantine; DDL text goldens for a Tenant, a Personal, a Global and an Unscoped entity (sort keys, keymap order, Nullable rules, COMMENT / SpecHash); `sanitizeInstanceKey` / `databaseName`. **CH-gated:** ping, query, command, insert with a dedup token (a second insert with the same token is dropped, a new token is not), `insert` retry with `When: 'After'` fault → one copy; `ensureSchema` idempotent (twice → same tables, COMMENT read back); `writeBatch` three-insert order (intent / mirror / retire) and the superset invariant under a fault between each pair; `readKeys` returns every live key of a moved ID; shadow create / `EXCHANGE` / `RENAME` (first enable) / drop; `readState` / `writeState` latest-wins; `bucketChecksums` / `readLeafRows`; `maxVersion`; a `Date32` bucket before 1970 (the extended-results setting is on); feature-not-boot: a wrong URL / port → `connect` `Up: false`, no throw, `status().Available: false` |
| `test/Facet-MirrorSpec_tests.js` (A, 19140 only if it boots) | the Materialize schema (built-in validator == ajv on fixtures and negative cases); every compilation rule of §55.2 on the three domains (columns Auto / explicit / Include / Exclude, never Sensitive / Text / long String / GUID, scope + delete + Join always, sort keys per Kind, TrackedKeyColumns, SpecHash stable and sensitive to type / column / sort-key changes); invalid entries disabled per entity with reasons, nothing partial; `Unsupported:<Key>` warnings; `covers` (DepSet within the spec, a missing entity, a missing column, filling columns); `ClosureIncomplete` warnings for definitions whose entities are not all mirrored; additive vs non-additive change classification (§55.4) |
| `test/Facet-Materializer_tests.js` (B, 19142) | **unit (fake store):** PendingSet add / re-hint / take / ack (a re-hint during the read keeps the entry; LastSeen / Hints rule), release, Dirty generations, overflow → Dirty; WriterClock monotone above `seed`, never backwards across a restart seed; one cycle per kind of diff (insert, update, soft delete → tombstone, hard delete → tombstone, undelete, tenant move, owner move, quarantine, Lossy flags); one flush = one mirror INSERT carrying rows + tombstones, the K / M / R order, tokens `'<E>:<FlushID>:<Target>:<Phase><i>'`; flush failure → hints released, new cycle with a higher `v` and a fresh read; ack only after every target succeeded; `AppliedSeq` advances only after the ack; event → pending mapping of §58.2 (IDs, empty IDs → Dirty, settle, foreign seq); filter resolution (mirror ∪ source, refusal → Dirty); Freshness state machine transitions, Exact / LagMS / AppliedSeq numbers, the §61.3 admission table cell by cell, the breaker (open, half-open, close), `NoChangeSource`; `quiesce`; `stop` writes `CleanShutdown = 1` only when drained, `crash()` writes nothing. **CH-gated:** a harness (SQLite, ProjectTrack) with the store: CRUD writes reach the mirror (`assertMirrorEqualsSource` after `quiesce`); a boot with `CleanShutdown = 0` → `Unverified`; `MaterializeSource` never runs a behavior (a behavior that would throw is never called) and sees soft-deleted rows |
| `test/Facet-ClickHouse-Compiler_tests.js` (C, 19143) | **goldens (no CH):** `test/goldens/Facet-ClickHouse-Goldens.json` — one statement per kind K1–K12, K14 (Column × DateBucket and Range axes), K17 (`Any`), K18, K19 (both `P(0)` branches), K20, the `#Total`, a Via chain of two links, Multi, Nice and Edges NumericHistogram, Ranges, Stats (integer, decimal, date), DistinctCount, Missing and the cube grain statement; parameter maps and types; the five §63.7 examples; every refusal reason of §63.2–§63.3 (`NotMirrored`, `LossyColumn`, `ScopeMissing`, `OperatorUnsupported`, `ValueType`, `DateLiteral` per dialect, `LikeCase`, `StringOrder`, `Transformed`); no value ever appears in SQL text (a scan over every golden). `FACET_UPDATE_GOLDENS=1` rewrites them. **CH-gated:** with `loadMirrors` on Bookstore, Bookstore-Tenant, ProjectTrack and LabTrack, every golden kind executes and its RawFacetResult equals Live's for the same Agg (the engine end to end, `PreferEngine`), the cube equals per-Variant (O5 on ClickHouse), dates before 1970 and at Nice decimal edges (8.4 / 0.2, 499.996) bucket identically, `''` vs NULL keys, cross-tenant FK references land in Missing on K8 |
| `test/Facet-Rebuilder-Reconciler_tests.js` (D, 19144) | **unit (fake store):** backfill (Building → swap → Live), rebuild (dual-write window: a write after its page was read ends in the shadow at a higher version; a delete after its page is tombstoned in the shadow), `finishRebuild` only between flushes, cancel; Sweep compound keyset (more than `SweepCap` rows sharing one `UpdateDate`, a lower ID stamped later, the watermark only after a complete pass, overlap); Bisect bucket diff (an insert, a hard delete, one delete + one insert with equal counts caught by IDSum), the divergence ratio excluding pending / recent IDs, escalation to a rebuild ending `Unverified`; Scrub cursor, wrap, `Full`; `verify` → Live; timers unref'd and cleared by `stop()`. **CH-gated:** the same on a real store, with admin triggers through `storeAdmin` (busy → 429, unknown → 404) and the guarded admin routes (`Admin.Routes` off → not mounted; on without `authorize` → 403) |
| `test/Facet-Persistence-Chaos_tests.js` (D, 19145) | **O10 subset (CH-gated), each ending with `quiesce` and `assertMirrorEqualsSource` for every mirrored entity:** duplicate events (the same notify ×5, a settle) → one row per ID, no extra flushes beyond the cycles; out-of-order events (Seqs delivered reversed through `ingest`); a crash between flush and ack (`afterFlushBeforeAck` hook → `crash()` → a new Materializer on the same database: `Unverified`, Exact requests go Live, Bounded / Fast may use the store, then `verify` → `Live` and the mirror equals the source); an INSERT 5xx (`When: 'Before'` and `'After'`) then retry (no loss, no duplicate part beyond dedup); ONE flush containing an update, a soft delete, a hard delete (raw SQL + notify), a tenant move and an owner move (`FINAL` counts per tenant and per owner equal the source); an FK move (Task.IDProject 5 → 9 through CRUD, and through raw SQL + notify without a before-image): K12 / K10 answers on ClickHouse equal Live for both projects; raw SQL without notify: a stamped update repaired by the Sweep, an unstamped in-place update by the Scrub, a raw insert and a raw hard delete by Bisect; a rebuild under a write stream of about 50 writes/s for its whole duration (a timer issuing CRUD writes) ending identical to the source; a volume wipe (`Store.dropDatabase` under a running materializer) → Live answers meanwhile → backfill → identical |
| `test/Facet-Conformance-ClickHouse_tests.js` (wiring, 19146) | **O3 (CH-gated; PostgreSQL half when both gates are on):** for every request of `Bookstore-Conformance-Fixtures` (Bookstore and Bookstore-Tenant), the M2 motivating bodies (E1, E2, E3A, E3B) and the per-kind coverage facets of both domains, as every principal of the domain, after `quiesce`: `normalize(Store) == normalize(Live) == normalize(Reference)` (`compareStore`), **and** every facet the capability matrix supports reports `Store.Facets[k].Engine === 'ClickHouse'` (a suite that silently fell back everywhere fails); every unsupported case answers Live with its reason and the right numbers: Show-deleted (`DeletedRowsNotMirrored`), an Opaque hop (`OpaqueScope`), a non-mirrored entity / column (`NotMirrored`), a Lossy column (the Bookstore `''` counts, the non-canonical SaleDate texts on SQLite), a SQLite day-only `GT` date literal (`DateLiteral`); two-tenant isolation on the store (tenant-2 rows never count; cross-tenant references Missing) |
| `test/Facet-Store-Routing_tests.js` (wiring, 19147) | Router + envelope (CH-gated): `Exact` → store only when caught up, else Live (a write not yet flushed: `NotExact`); `Bounded` within / beyond `MaxLagMS`; `Fast` while `Unverified` / `CatchingUp`; `Engine: 'Live'` → Live; read-your-writes upgrade sends the writer's next read Live; a store error (fault injector) → same-request Live answer with `FACET_STORE_FALLBACK` and a breaker that opens after 5 and half-opens; per-facet engines in one envelope (a store facet next to a Show-deleted one); `Store` block present only with a store, `ExposeReasons` off → classes only; store answers never cached and carry the digest Version (cache on); Records / Count / Keys never touch the store (a statement spy); feature-not-boot: a harness whose ClickHouse URL is dead boots, answers Live, Describe says `Available: false`, and starts using the store once it comes up (`RetryConnectMS` small) |
| `test/Facet-M5-Review_tests.js` (review, 19148) | **CH-gated (PG halves with both gates):** a regression for every M5 review finding that needs the real store — the client round-trips backslashes / a trailing backslash / TAB / LF / CR / `\N` / quotes as `{p:String}` and `Array(String)`, and refuses an over-long parameter without sending; O3 for a column NOT IN over NULLs (nullable String, Int64, Float64; alone and in an OR group) on SQLite and PostgreSQL sources; SQLite `'true'` text in an integer column → `LossyColumn` (Live numbers) and cleared once corrected; backslash values under `=`, `!=`, IN, LIKE, NOT LIKE and a behavior-appended `!=` scope entry; an IN list over the field limit → `ParameterSize` (no statement, breaker untouched); deterministic store errors never open the breaker (another tenant keeps the store); `ExposeFreshness: false` (no LagMS / AsOf, `Freshness` reasons, Describe detail only for `Admin.authorize`); a hung store behind a TCP proxy (Live inside the deadline with `Fallback: Timeout`, `Unreachable` after two, O(1) refusals, a ping restores it, a bounded shutdown); the lease (a second process stays `NotLeader` until the first stops gracefully, then takes over and serves) and the owner marker (another InstanceID → `Misconfigured`); a keymap EXCHANGE that lands but errors → the swap resumes and completes; one dropped mirror table → only that entity rebuilt; a 50 writes/s stream → a handful of inserts and keymap reads; the paced Scrub (unknown and seeded totals); `capable()` + `entityFreshness()` O(1) with a 90k backlog; PostgreSQL timestamps read as the naive text under a non-UTC process TZ |
| `debug/m5-smoke.js` (wiring, 19193) | a manual run: ProjectTrack + the store; E1 Live vs ClickHouse side by side; a write; `LagMS` until caught up; then equal again |
| `debug/m5-keymap-bench.js` (review) | the keymap point read at scale: FINAL vs no FINAL, `index_granularity` 8192 vs 256, `KEYMAP_ROWS` (default 10M) / `KEYMAP_BATCH` (default 2000) |
| demo (wiring, 19301–19305) | `DEMO_CLICKHOUSE=1`: §66.3 |

### 66.3 Demo (wiring)

`DEMO_CLICKHOUSE=1 npm start` (in `example_applications/faceting_demo`) ensures `rfs-test-clickhouse` through the docker helper and gives each domain `Stores.ClickHouse` (database `rfs_demo_<front port>_<pid>_<domain>` — review: two demo processes never share or drop each other's database, and the test container's leftover sweep drops a dead process's; `ExposeReasons: true`, `ExposeFreshness: true`) with every domain entity materialized; without the variable the demo is exactly M4. The inspector shows per facet `Engine`, `Exact`, `AsOf`, `LagMS` and the `Store` block (reasons); a toggle sends `Engine: 'Live'` (Live, Exact) or `Freshness: { Mode: 'Fast' }` (store whenever capable) and can show both answers side by side; after "Make a change" the store side shows `LagMS` until the flush lands, while an `Exact` request is still correct through the Live fallback. Demo checks run on 19301–19305; 19300 is the user's running demo, never touched.

---

## 67. File ownership and the shared-file protocol

| Owner | Files (M5) |
|---|---|
| **A** | `source/store/Retold-Faceting-StoreBase.js`, `source/store/clickhouse/ClickHouse-Client.js`, `ClickHouse-TypeMap.js`, `ClickHouse-DDL.js`, `source/store/clickhouse/Retold-Faceting-StoreClickHouse.js`, `source/persistence/Retold-Faceting-MirrorSpec.js`, `source/persistence/Materialize-Schema.json`, `test/support/Facet-ClickHouse-Support.js`, `test/support/Facet-Docker-ClickHouse.js` (after the contracts pass), `test/Facet-Store-ClickHouse_tests.js`, `test/Facet-MirrorSpec_tests.js` |
| **B** | `source/persistence/Retold-Faceting-Materializer.js`, `-WriterLoop.js`, `-WriterClock.js`, `-PendingSet.js`, `-FlushBuffer.js`, `MaterializeSource-InProcess.js`, `-Freshness.js`, `test/support/Facet-Store-Fake.js`, `test/Facet-Materializer_tests.js` |
| **C** | `source/store/clickhouse/ClickHouse-FoldCompiler.js`, `source/engine/Retold-Faceting-EngineClickHouse.js`, the **added** `captureRelation` method of `source/engine/live/Retold-Faceting-ScopedRelationBuilder.js` (add-only), `test/goldens/Facet-ClickHouse-Goldens.json`, `test/Facet-ClickHouse-Compiler_tests.js` |
| **D** | `source/persistence/Retold-Faceting-Rebuilder.js`, `-Reconciler.js`, `test/Facet-Rebuilder-Reconciler_tests.js`, `test/Facet-Persistence-Chaos_tests.js` |
| **wiring** | `source/Retold-Faceting-Service.js` (`installStores`, `storeAdmin`, subscriptions, shutdown, status), `-Service-Options.js`, `-Util.js`, `-Installers.js`, `source/engine/Retold-Faceting-Router.js`, `source/routes/*` (admin routes), `source/contract/Facet-Contract-Request.js` (`Engine`), `source/contract/Facet-Contract-Envelope.js` (`Store`, `VOLATILE_FIELDS`), `source/security/Retold-Faceting-CacheKey.js` (`'Store'` reason only), `test/support/Facet-Test-Harness.js` (`Store` option), `README.md`, `docs/internal-contracts.md` after the builders, `test/Facet-Conformance-ClickHouse_tests.js`, `test/Facet-Store-Routing_tests.js`, `debug/m5-smoke.js`, `example_applications/faceting_demo/**` (the toggle) |
| **shared** | `test/Facet-Smoke_tests.js` (anyone ADDS assertions), `source/contract/Facet-Contract-Errors.js` (add codes only — M5 adds none), `source/contract/Facet-Contract-Util.js` (add helpers only) |

Protocol (M4 §50, unchanged): edit only your files; a contract change is made **here first** with a line in §68; shared files by string-replacement `Edit` only (re-read first, add rather than remove); fix (never weaken) an earlier assertion your contracted change breaks, and say so; `npm test` green after every change, `npm run test:ch` green before you report (and `npm run test:pg` when you touched anything PostgreSQL reaches); umbrella `node_modules` only (no `npm install`), Node 22 `fetch`, ephemeral ports, Retold style, Mocha TDD, never `git add` / `commit` / `push`, never modify files outside this module (Sluice is read-only prior art), docker only for `rfs-test-postgres` and `rfs-test-clickhouse`; a demo may be running on 19300 — leave it alone, use 19301–19305 and stop what you start. **Dependency order for gated tests:** A's client / DDL / TypeMap / store / `loadMirrors` → C's execution tests; B's WriterLoop → D's CH-gated suites; until then builders test against the skeletons and the fake store (unit), and the wiring pass re-runs everything.

---

## 68. Ambiguities resolved / M5 deviations from the design

1. **The ClickHouse client lives inside this module** (`source/store/clickhouse/`) instead of a new `meadow-connection-clickhouse` (04 §5): it requires nothing outside `store/clickhouse/` so it can move unchanged; the README says it is slated to move.
2. **Store and engine are two services** (§54.1): the write side and lifecycle on `RetoldFacetingStoreClickHouse`, the Router-facing `capable` / `freshness` / `execute` on `RetoldFacetingEngineClickHouse`. `capable` stays pure and static; capture-time refusals come back as `Execution.Refused` (03 §10's "re-check the actual captures").
3. **No automatic closure**: `MirrorSpec.compile` never adds entities the declaration did not name (04 §4 rule 2 says it does; 04 §3.4 says never auto-enable infrastructure). Folds whose DepSet is not covered stay Live (`NotMirrored`), and `ClosureIncomplete` warnings list them.
4. **No derived data in M5:** PathColumns (`Denormalize` / `Dictionary`), dictionaries, relation fields, rollups and append-only aggregates are accepted with `Unsupported:<Key>` warnings and ignored; to-one dimensions use the scoped `ANY LEFT JOIN` / `Subquery` forms (04 §5.3); so there is no DependencyIndex or fan-out, and an FK move is repaired by rewriting the child row alone. Labels are always the Live scoped read (never `dictGet`).
5. **Sort keys:** `[Tenant, Owner, Identity]` with the owner column `Nullable` under `allow_nullable_key = 1` (verified on 24.8: NULL keys dedup and tombstone like any value), so an owner-less row of a Personal entity is still mirrored (TenantOnly hops see it, as Live does); only an unset **tenant** is quarantined.
6. **Keymap = `ReplacingMergeTree` ordered by `(Identity, scope keys)`**, not EmbeddedRocksDB (04 §5.1 names it the fallback form): several live keys per ID may coexist, which is what makes the three-insert flush (intent → mirror → retire) keep "keymap ⊇ mirror" through any partial failure, so a moved row can never be left behind as a ghost.
7. **No `_rfs_clock` table:** the clock floor is `max(_Version)` over the store's tables at `start` (`Store.maxVersion`), which already survives restarts, restores and skew.
8. **Every non-key column is `Nullable`** and decimals are `Float64`: the test schemas and SQLite allow NULL anywhere, Live compares decimals as doubles on both dialects, and Stats sums are exact integer units — exactness over storage size (`LowCardinality` and native `Decimal` are later optimizations).
9. **PendingSet overflow collapses to a whole-entity Resync** (04 §6.2 scopes it to the affected tenants and adds a Sweep and fan-out; M5 has no fan-out and re-reads everything).
10. **Lossy columns** (§56.3) are new: values the mirror cannot reproduce exactly (SQLite text in typed columns, out-of-range dates, non-canonical date text compared as text) make exactly the folds that read them Live-only, instead of the design's silent type coercion.
11. **Date literals and LIKE follow the source dialect** (§63.3): SQLite compares dates as text and LIKE case-insensitively without an escape character; the compiler binds only the literal forms both systems compare identically and maps LIKE to `ilike` with backslashes doubled on SQLite.
12. **Store answers are never cached in M5** (`Bypass 'Store'`, digest Version): binding an `ApplyToken` into cache entries (05 §6.4) is a seam.
13. **No `MinSeq` waiting:** a `MinSeq` (or a read-your-writes upgrade) is an `Exact` request, which the store answers only when fully applied, else Live (`MinSeqWaitMS` and flush nudging are seams).
14. **Exact also requires change coverage** (`ChangeIntake.covers`, `NoChangeSource`): an entity whose writes no source sees can be stale in the mirror for a Scrub period, so only `Bounded` / `Fast` may use it.
15. **`Freshness.DefaultMode` stays `'Exact'`**, so a default request uses the store only when it is caught up; the demo toggles `Fast`.
16. **One process materializes and serves** (`Materializer.Enabled: 'Auto'`); a reader-only process (state polling, `StatePollMS`) is a seam, and with `Enabled: false` the store is not used.
17. **Request `Engine: 'Live'`** is a new optional request field (not in 02): the authoritative engine on demand; it never changes a cache key because it can only produce a Live answer.
18. **Admin routes are off by default and guarded by a host `authorize` hook**; in-process `storeAdmin` is the supported trigger (06 §5 platform principals are not modelled yet).
19. **Reconcile cadence uses intervals** (`BisectIntervalMS`) instead of a cron string.
20. **Test containers use tmpfs** (no docker volume); the volume-wipe scenario drops the database instead of deleting a volume.
21. **Reader / writer users, settings constraints and the row-policy backstop** (04 §5.1, §5.7, INFERRED) are not built in M5; every statement runs as the configured user with the read settings of §57.3.

### As built (builder A: client, TypeMap, DDL, StoreClickHouse, MirrorSpec, support)

22. **ClickHouse 24.8 parses Float64 text inexactly** (verified on the container): JSONEachRow / CSV / TSV / Values input **and `{p:Float64}` query parameters** use a fast parser that lands one ulp off for values such as `5.94` and `7.56` (`precise_float_parsing` does not change them); only `toFloat64(<String>)` under `precise_float_parsing = 1` is exact. So: (a) `Store.writeBatch` inserts into any table with a Float64 column as `INSERT INTO t (…) SELECT …, toFloat64(f) … FROM input('… f Nullable(String) …') FORMAT JSONEachRow` with `precise_float_parsing = 1`, the value sent as its shortest round-trip text (dedup tokens work unchanged for `INSERT … SELECT … FROM input()`, verified); (b) `READ_SETTINGS` (§57.3) gains `precise_float_parsing = 1`; (c) **an engine statement must bind a Float64 value as `toFloat64({p:String})` (the value as `String(v)`), never `{p:Float64}`** — this applies to C's `Float64` shell numbers and Float64 filter values (§63.2) (an Int64 / UInt32 / DateTime64 / String parameter is exact as is).
23. **DateTime values keep the source's milliseconds** (`'YYYY-MM-DD HH:mm:ss.SSS'` from a PostgreSQL `Date`, or the first three fraction digits of a text) instead of `'.000'` (§56.3): the mirror then compares exactly like PostgreSQL; bucketing and the `formatDateTime(…, '%Y-%m-%d %H:%i:%S')` bounds are unaffected; on SQLite a text with a fraction is not canonical, so it is `Compare`-lossy anyway.
24. **Batch shapes of `writeBatch`** (§54.3, §58.6). `Rows`: flat store rows (`TypeMap.toStoreRow(…).Row` + `_Version`; `{ Row, Version }` also accepted). `Tombstones` / `KeyRetires`: `{ ID, Key: { <sort-key scope column>: v }, Version }` or a flat row carrying the identity, the sort-key columns and `_Version`. `KeyIntents`: `{ ID, Key, Tracked, UpdateDate, Version }` or a flat keymap row. The store sets `_IsDeleted` itself (0 / 1 / 0 / 1), restricts every row to the target table's actual columns (a retyped column of an old live table is written NULL) and refuses a malformed batch (no safe-integer identity, no version) before anything is sent. Result `{ Rows, Tombstones, KeyIntents, KeyRetires, Inserts }`; an error carries `.Phase` (`'K' | 'M' | 'R'`), `.Result` and `.Wipe` for codes 60 / 81; a write or key read of a shadow table that no longer exists (an aborted or finished rebuild) is `.ShadowMissing` with `Code: null`, never a wipe. `readKeys` / `readKeyRange` return only IDs with at least one live key; Key / Tracked / UpdateDate are store values, so `TypeMap.keyString(spec, key)` compares a keymap key with `TypeMap.keyOf(spec, row)`.
25. **`ensureSchema` reports more per entity** than §54.3 lists: `KeymapSpecHash`, `ColumnTypes` / `KeymapColumnTypes` (`{ name: type }`), `SortKey` / `KeymapSortKey` (from `system.tables.sorting_key`), `KeymapColumns`, and `Shadows` (BuildIDs of leftover `<E>__shadow_<b>` tables); it refuses a database whose engine is not `Atomic`. `MirrorSpec.classifyChange(report, spec)` turns a report into `{ Kind: 'Absent' | 'Same' | 'Additive' | 'Rebuild', Added, KeymapAdded, Reason }` (§55.4; same columns under another SpecHash → `Rebuild 'SpecHash'`, never a silent resume).
26. **State rows** (`readState` / `writeState`): DateTime fields read back as epoch milliseconds (`writeState` takes ms numbers, `Date`s or date text); JSON columns parsed; `CleanShutdown` 0 / 1; `Version` = the row's `_Version`. `writeState` merges the given fields over the last state this store read or wrote for the entity (a partial update keeps the rest) and uses `pState.Version` (the caller's WriterClock), else `max(now µs, highest version seen + 1)`. An older version never overrides a newer one (FINAL).
27. **Client** (`ClickHouse-Client.js`): `Database: null` sends no `database=` (the store qualifies every name, so a statement never depends on a database that may not exist yet); keep-alive sockets (unref'd; a reused socket reset before any response is re-sent once for Ping / Query / Insert); `insert(…, { Token, Retries, Query, Settings })` re-sends a retryable failure with the **same** token up to `Retries` times (never without a token); error messages keep server detail only for codes that never echo a value (`DETAIL_SAFE_CODES`), inserts never; `.Name` (the exception name), `.NetworkCode` (node's code; `.Code` stays the ClickHouse number or null); a 5xx with a deterministic code (`DETERMINISTIC_CODES`, e.g. `BAD_QUERY_PARAMETER` 457, which ClickHouse answers with a 500) is not `Retryable`. The fault injector's `Attempt` is the statement's attempt (an insert's same-token retries count 1, 2, …) and `Sequence` counts every request since the injector was set.
28. **MirrorSpec as built**: the spec also carries `SpecVersion`, `Mutability`, `UnsetValues` (the policy's, for the quarantine rule; not hashed) and per column `IsInteger` / `Scale`; `TenantColumn` / `OwnerColumn` name the policy columns even when one is the identity (`Customer.IDCustomer`: one sort-key column, still the tenant for the compiler's fail-closed check). Disabled entries are `{ Code: 'FACET_DEFINITION_INVALID', Kind: 'Materialize', Store, Entity, Reason, Column?, Pointer }` with `Reason` ∈ `REASONS`; an entity named in an unconfigured store is disabled there only. Added API: `specs(pStore)` (what `ensureSchema` takes), `stores()`, `declareAll(pStores)` (every facetable entity), `classifyChange`, static `validateSchema` (the built-in draft-07 subset over `Materialize-Schema.json`, cross-checked with ajv; the registry's validator is bound to its own schema). `covers()` skips `@…` pseudo-fields (as `FoldIR.depSet` does) and accepts `{ Entity: { column: true } }` too. Watermark `'Auto'` reads `Indexed` from the model column, the MeadowSchema entry, or a declared index whose first column is `UpdateDate`.
29. **TypeMap helpers for the write side**: `isLive(spec, sourceRow)` (§56.4), `keyOf` / `trackedOf` / `keyString` / `keyColumnsOf`, `specColumn`, `isUnsetTenant`. `toStoreRow` returns `Quarantined: 'Identity'` (and `Row: null`) for an identity that is not a safe integer, `'TenantUnset'` for an unset tenant of a Tenant / Personal entity (the Row is still built, for counters). Integer text must be the canonical text of a safe integer (`'007'`, `'-0'`, `' 7'` are SQLite TEXT → NULL + `Value`).
30. **StoreClickHouse extras**: `resolvedOptions()` (the resolved section without the password: what C reads `SourceStringOrder` / `ExposeReasons` / `QuerySettings` from), `close()` (shutdown: drops the keep-alive sockets), `stats()`, static `isWipeError` and `READ_SETTINGS`; `swapShadow` remembers a half-done swap so a retry only completes the keymap half (never swaps the mirror back); a first-enable `RENAME` onto an existing live table falls back to `EXCHANGE`. `StoreBase` keeps the design's query-side names as delegates to `fable.RetoldFacetingEngine<StoreName>` (`capable`, `freshness`, `execute`, `EngineName`).
31. **`Facet-ClickHouse-Support` as built**: `loadMirrors(pHarness, { Database, Entities?, Materialize?, StoreOptions? })` compiles through the harness's own MirrorSpec service and configures the harness's own StoreClickHouse (so the engine sees both), writes every live, non-quarantined row with its keymap intent in one batch per entity, then a state row `{ State: 'Live', Epoch: 1, SpecHash, LossyColumns, Detail: { Quarantined, Loader: 'Static' } }`, and calls back `{ Database, Specs, Entities: { E: { Rows, Quarantined, Lossy, Source } }, Disabled, Warnings }` (C passes `Entities[E].Lossy` as `pInput.Lossy`). Also exported: `readSourceRows(pHarness, pSpec)` (trusted DAL reads, soft-deleted rows included), `expectedRows(pHarness, pSpec)` → `{ Rows: Map(ID → store row), Lossy, Quarantined, Source }`, `sourceDialect(pHarness, pEntity)`. `assertMirrorEqualsSource`'s `.Report` also has `Columns` (`{ ID: [ differing column names ] }`) and `KeymapMissing` / `KeymapExtra` / `KeymapDifferent`; on success it calls back `{ Rows, Quarantined, Lossy }`.
32. **Rebuilder as built (D).** `backfill(S, E, { Reason? })` (Reason defaults to `'Backfill'`, `BACKFILL_REASON`) calls back `{ BuildID, Reason, Pages, Rows, ElapsedMS, State, CaughtUp, FirstEnable }` once the first enable is `Live` — the hints from before the `RENAME` are applied when the oldest pending `FirstSeen` is newer than the swap, so it converges under a steady write stream — or after `CATCH_UP_CALLBACK_MS` (30 s) with `CaughtUp: false` (the CatchingUp → Live watch goes on). `rebuild(S, E, { Reason })`: an unknown Reason is `400 FACET_REQUEST_INVALID { Field: 'Reason' }`; state `Absent` / `Building` or Reason `'Wipe'` takes the first-enable path; an entity the store does not materialize is `404 FACET_UNKNOWN_ENTITY`. A second backfill / rebuild joins the build in flight; Reason `'Wipe'` supersedes it instead (abortRebuild; the old callers get the new build's result). `status().Phase` adds `'CatchingUp'` (`PHASES`). `cancel` → `{ Cancelled, BuildID?, Reason: 'NotRunning' | 'Swapping' | 'Completed' }`; a cancelled or failed build restores the prior state (a first enable → `Absent`; a divergence-marked rebuild → `Unverified`), its error carries `.Cancelled` / `.Superseded` / `.Step`. Added: `lastCompleted(S, E)` → `{ BuildID, Reason, At, AtMS, SwappedAtMS, Pages, Rows, ElapsedMS, State }` (storeAdmin's `RebuildCooldownMS`), `stateFields(S, E)` → `{ LastRebuild }`, `stop()` (clears the catch-up timers; a build that only waits for its catch-up completes with `CaughtUp: false`), `stats()`.
33. **Reconciler as built (D).** The state row has one writer (the Materializer): D's fields reach it by push (`Materializer.updateState(S, E, fields, cb)`) and pull (`Reconciler.stateFields(S, E)` → `{ SweepWatermark, ScrubCursor, ScrubbedThrough, LastBisect }`, `Rebuilder.stateFields` → `{ LastRebuild }`), never through `Store.writeState`; D also never calls `Store.readState` (it refreshes the store's merge cache, and a read racing a Materializer write could put an older row back under the next merged write): a record is seeded once from `Materializer.stateRow(S, E)` when present, else `entityInfo(S, E).StateRow`, else a plain `FINAL` read of `_rfs_entity_state` through `queryRows`; `stop()` forgets the records (the next start re-seeds). **Sweep:** window start `{ At: <W − OverlapMS as 'YYYY-MM-DD HH:mm:ss' UTC>, ID: null }` (`>=`), a pass with no watermark `{ At: null, ID: null }`, later pages from `Next`; IDs already pending are hinted again (a re-hint of an in-flight ID is what keeps a raw stamped write committed after that cycle's read from being acked away, §58.3); the watermark is stored as `'YYYY-MM-DD HH:mm:ss.SSS'`; `OverlapMS` adds 3 600 000 when the source dialect is not SQLite and the process time zone is not UTC. **Bisect:** options `{ Escalate: false, LeafRange }`; the result adds `LeafSample` (≤ 20 differing buckets) and `Busy` (more than 20 Sweep pages of recently stamped rows: it never escalates then); the pending exclusion uses `Materializer.isPending` (else the `pendingInfo` Pending + InFlight count is subtracted, so the ratio can only err low), read before the differing IDs are enqueued; a divergence rebuild is followed by a background `verify` unless the Bisect is a verify's own. **Scrub:** options `{ Full, Kind: 'Scrub' | 'Fill', Cap }`; `Absent` / `Building` → `{ Skipped: 'State:<S>' }`; a rotation resumed from a persisted cursor never sets `ScrubbedThrough`; the timer owes `Total × ScrubTickMS / ScrubPeriodMS` rows per tick (`Total` from the last wrap or Bisect; the `ScrubRowsPerSecond` ceiling until known) and issues a Range task once 256 rows (or the whole entity) are owed. **verify** → `{ Verified, State, Attempts, Bisect, Scrub, Reason? }`: Unverified → Live only when the entity is still in the same Unverified state (same `Since`); a divergence rebuild or a newer trigger restarts it (at most `VERIFY_MAX_ATTEMPTS` = 3 passes, then `Verified: false`); an entity that is not Unverified keeps its state. **Concurrency:** one run per (store, entity, level); the same intent joins, a different one (a full Scrub during a tick, a verify's own Bisect / Scrub) queues behind it; `isRunning(S, E, Level)` is storeAdmin's `Admin.InFlight` test; the timers skip `Absent` / `Building` / `Degraded` / `Rebuilding` and a level still running; `start()` honors `Reconcile.AutoStart` itself and is idempotent per entity. A waiter callback that throws is re-thrown on the next tick after every other waiter was called (never swallowed).
34. **D's ClickHouse suites before the wiring.** `Facet-Persistence-Chaos` wires the store itself while `RetoldFacetingService.installStores` is absent (`configure` → intake subscribers `'Freshness'` then `'Materializer'` → `Materializer.start`) and uses the harness `Store` option once it exists; its Router checks (Exact / Fast admission answers, K12 / K10 ClickHouse == Live through `compareStore`, Live answers during the wipe) run only then (before, the same scenarios assert Freshness admission and the mirror invariant). `Facet-Rebuilder-Reconciler`'s CH half drives B's real WriterLoop / PendingSet / FlushBuffer / WriterClock over A's store and B's source through a minimal Materializer stand-in; its storeAdmin / admin-route half is skipped until `installStores` and `storeAdmin` exist.

### As built (builder B: the materializer and Freshness)

35. **Batch entries are flat, ready-to-insert rows** (incl. `_Version` / `_IsDeleted`), the form #24 accepts.
36. **The state row has one writer, the Materializer**: `updateState(S, E, fields, cb)` (push) and the Rebuilder's / Reconciler's `stateFields()` (pull). `Detail.Spec` holds a snapshot of the live table's layout (names and types only), so an incompatible change found at boot can rebuild beside the old tables; without a snapshot the live tables are dropped and backfilled while Live answers.
37. **A rebuild started while `Unverified` never serves Exact before its swap** (Freshness marks it like a divergence rebuild).
38. **A hinted ID stays in flight until its flush acknowledges**: a re-hint waits for that flush, then gets a new cycle; later cycles see unflushed key changes (a row moved twice inside one flush window leaves no ghost).
39. **The breaker's half-open check has no side effects** (`breakerOpen` is a pure read apart from noting half-open): the Router and the engine may both call it; requests go through until the next recorded success or failure.
40. **A row is live only when its delete column is exactly 0** (the SQL `Deleted = 0` meaning). `TypeMap.isLive` also counts the text `'false'` as live; that only matters for text in an integer delete column (no fixture has one) and is left as is.
41. **`stop()` sets every entity `Absent`** (nothing is served from mirrors no longer maintained); a range-task page flushes at once when nothing else is runnable; after 8 consecutive stream cycles a waiting range task gets a turn; the loop always calls back on a later tick.
42. **API additions**: Materializer `store(S)`, `useStore()` (tests), `enabled()`, `started()`, `isPending(S, E, ID)`, `pendingInfo(S, E, { Light })` (+ `Buffered`, `Resolving`, `ResolvingSince`, `Tasks`, `Resync`), `entityInfo().LiveSpec`; WriterLoop `attach`, `setSpec(spec, { KeepLiveSpec })`, `specFor`, `setTargets`, `requestFlush`, `working`, `quiet`, `drain`, `halt`, `reset`; Freshness `setEpoch`, `appliedSeq`, `unregister`. `Freshness.freshness()` computes `AsOf` from the `pNow` it is given; the envelope substitutes the request clock when `LagMS` is 0 (#53).

### As built (builder C: the compiler and the engine)

43. **`REASON_CLASSES` gains `ShapeUnsupported`**: a multi-level correlation (`:Correlation`, no fixture uses one), a Terms / Pivot / Multi key on a DateTime column (`:DateTimeKey`), malformed FoldIR, a parameter collision.
44. **Terms cut**: Live's exact cut (rank ≤ Top + 1 and row_number ≤ max(Top + 1, MaxTermsGroups), plus the selected keys, typed to the key column; no `OR` without selected keys) instead of the §63.7 K1 text, so raw results equal Live's.
45. **Equivalent statement shapes**: TuplePivot = `SELECT DISTINCT` + `count()` (Live's composition, not `uniqExact(tuple)`); Via = `ANY LEFT JOIN` over each link's whole scoped relation, every column qualified; column predicates render as inline qualified fragments; ChildAgg = the restricted LEFT JOIN with `ca<i>` aliases.
46. **Compiler interface additions**: `compileAgg` input `Variant: { PathPred }`, each statement's `MaxRows`; NumericHistogram runs in two phases (no `Geometry` → the bounds statement, with it → the bucket statement); `compileCube` expects `pCubePlan.Resolved = { CommonPathPred, Flags, Bounds }`; exports `collectRelations`, `collectCubeRelations`, `entrySignature`, `columnPredEntries`, `DATE_BUCKETS`.
47. **Value rules stricter than §63.3**: a comparison against NULL renders `0`; `IS` with a non-null value is `OperatorUnsupported`; NULL inside an IN list, any number on a String column and `'true'` / `'false'` text on UInt8 are `ValueType`. `capable()` also refuses a Compare-lossy column named by the Variant's conjunct fields (the compiler checks the remaining predicates; `IS NULL` on such a column is still refused).
48. **Opaque captures**: an untrusted one is the guard's `OpaqueUntrusted` 500 inside `ScopeCapture.capture`, exactly as for Live; only `Scope.TrustedOpaque` entities come back `Refused: 'OpaqueScope:<E>'` (Live then answers what it answers, e.g. its Staged path's own refusal of a non-leaf opaque hop). The `captureRelation` memo key excludes Project except for an entity with read-side PostOperation behaviors (reused only for the same projection); store captures count on `Counters.StoreRelations` (a same-request Live fallback is not charged twice).
49. **Float64 values are bound as text** (the wiring applied #22 (c) to the compiler): `bind(…, 'Float64')` emits `toFloat64({name:String})` with the value's shortest round-trip text, and an IN list over a Float64 column is `has(arrayMap(rfsValue -> toFloat64(rfsValue), {name:Array(String)}), <column>)` (`inList()`; ClickHouse's `IN` needs a constant right side, and `has()` answers like `IN` wherever the compiler uses it: in a WHERE / HAVING and under the NULL-safe `NOT ifNull(…, 0)`); a raw `Array(Float64)` bind is refused. The compiler's `READ_SETTINGS` gain `precise_float_parsing = 1`. The goldens were regenerated; O3 proves it on values the 24.8 parser lands one ulp off (5.94, 7.56, 1.14, 4.69, 6.81, 5.56: `=`, IN, NOT IN, `>=` / `<`, Ranges and Edges).

### As built (the wiring)

50. **`installStores(fCallback)`** (§54.2) runs at attach after `installChangeCapture()` and after every model reload (then `Materializer.reload()`); never fails attach and never waits for ClickHouse (`Materializer.start` runs in the background; the harness `Store` option quiesces). `Materialize: 'All'` (tests, the demo) is re-declared from the catalog at every install (`MirrorSpec.declareAll`). Without a store section a previously registered engine is unregistered. `storeRegistered()` / `storeAvailability()` → `{ Configured, Available, Reason }` (the reason of the store, else of the materializer).
51. **Router**: `register(pEngine, { Store: true })` puts a store engine first (idempotent; `unregister`, `storeEngine()`, `engineNames()`); the M4 whole-request rule never picks a store engine. The store Aggs run first, then ONE Live execution over the Live Aggs plus every fallback (in plan order), each engine seeing `pContext.Cubes` restricted to its own Aggs (`restrictCubes`: a cube keeps only its members on that engine, which marginalize independently). A whole-call store error counts one read failure per DepSet entity per request; capture-time refusals (`Refused`) re-run Live without a warning except `'StoreError'` ones (a per-statement failure), which also get `FACET_STORE_FALLBACK`. `Fallback.Reason` is `'Timeout'` for ClickHouse codes 159 / 160 (or a network time-out), else `'Error'`; `'Breaker'` is never a Fallback: an open breaker is the refusal `Breaker:<E>` (no statement sent, no warning). A store error whose cause carries `.Wipe` also starts `Materializer.recoverWipe(S)` (C's open question: a read may notice a wipe first). A non-store error of the store engine is returned as is.
52. **Context and in-process options**: `pContext.Store` is set by `newContext` for every Query once a store is registered (`{ Name, Prefer, Decisions, Fallback, Statements }`; null with `ForceEngine`); `pInternalOptions.PreferEngine: 'ClickHouse' | 'Live'` (tests) — a store preference is also never looked up in or stored to the cache (`Bypass 'ForceEngine'`). `pMeta.Statements` now counts the store's statements too (`pMeta.Store.Statements` is their share); `pMeta.Store` adds `Prefer` and `Engines`.
53. **Envelope**: each FacetResult's `Engine` / `Exact` / `AsOf` / `LagMS` from its engine (`engineFields`): a store answer's `AsOf` is the request clock when its `LagMS` is 0, and its `LagMS` is `null` when unbounded (an entity still building, only reachable with `PreferEngine`), which makes the envelope `LagMS` `null` too. With no per-Agg engines (M4, `ForceEngine`) the envelope is byte-for-byte the M4 one. The `Store` block is built after the envelope (never in a stored cache body); an answer served from the result cache or shared by a single-flight leader gets a `Store` block whose every facet is `{ Engine: 'Live', Reason: null }` (entries only hold Live answers).
54. **Cache**: `'Store'` is also an `UNSHARED_REASON` (a single-flight joiner may ask Exact where the leader asked Fast). The background refresh of a Stale serve runs with `PreferEngine: 'Live'` (it exists to store an entry, and only Live answers are stored). The demo turns the result cache off when it runs the store (an entry is served before routing, so its Live answers would hide the store).
55. **Admin**: `storeAdminRefusal(pAction, pStore, pEntity)` (400 / 404 / 503 / 429) is shared by `storeAdmin` and the routes; busy = this service's own in-flight set ∪ `Rebuilder.status` (Rebuild) ∪ `Reconciler.isRunning` (the levels); the cooldown counts only rebuilds — a first-enable build (the boot backfill, a wipe recovery) never blocks one. The admin routes run the action in the background and answer `202` at once.
56. **Describe / status**: `Engines.ClickHouse` and `Entities[E].Store` as §62.5; a facet descriptor lists `[ 'Live', 'ClickHouse' ]` when its column is in the entity's spec (auto facets) or every entity of the declared facet is mirrored (entity-level). `status()` gains `Engines.ClickHouse` (= `storeAvailability()`), `Stores` (= `Materializer.status()`, so `Stores.Stores.ClickHouse`), `Freshness`, `StoreClickHouse`.
57. **`StoreClickHouse.readState` never moves its merge cache backwards** (D's open issue #4): a read row replaces the cached state only when its `Version` is at least the cached one.
58. **Harness**: the `Store` option as §62.6, plus `StoreOptions.Store` (extra section keys: a URL, `ExposeReasons`, …), `Quiesce: false`, `QuiesceTimeoutMS`, `Database` (a fixed name, kept by `stop()`) and `DropFirst` (the demo's `rfs_demo_<domain>`). An ephemeral harness now binds **127.0.0.1** (was: every interface): a wildcard bind could be handed the port number another process holds on 127.0.0.1 (a running demo's domain servers), and loopback requests then reached THAT server — the intermittent 404s builder A saw. `compareStore` also returns `StoreMeta` (full reasons) and `LiveMeta`.
59. **Test adjustments (fixes, not weakenings)**: `Facet-Persistence-Chaos` runs with `Freshness.ReadYourWritesMS: 0` (its admission checks query as Lead, who writes in the earlier scenarios; read-your-writes correctly upgraded Lead's Fast reads to Exact — `Facet-Store-Routing` tests the upgrade itself); `Facet-ClickHouse-Compiler` expects the #49 Float64 forms; the normalized-request expectations of `Facet-Contract` / `Facet-FilterAST` gain `Engine: 'Auto'`; `Facet-CacheKey` expects `'Store'` in `UNCACHEABLE_REASONS`.
60. **Test file name**: the routing / freshness obligations of §66.2 are in `test/Facet-Store-Routing_tests.js` (the contract's name; the wiring brief called it `Facet-Store-Freshness`).

### Review fixes (after the M5 build; items continue the numbering; R<n> = finding n of the review, regressions in `test/Facet-M5-Review_tests.js` unless named)

61. **Column NOT IN keeps three-valued logic (R1, critical)**: `(isNotNull(C) AND NOT (C IN …))`, Float64 lists too; anti-joins keep `NOT ifNull(…, 0)` (§63.3). Goldens and the compiler tests updated; O3 bodies with NIN over nullable String / Int64 / Float64 holding NULLs, alone and in an OR group, on SQLite and PostgreSQL sources.
62. **Scalar parameters are escaped for the Escaped format (R12, critical)**: `formatParamText` (§57.2); array items are escaped once as literal items and once more as text. A SQLite LIKE pattern's doubled backslashes now survive transport. Round-trip tests against the server (backslashes, a trailing backslash, TAB / LF / CR, `\N`, quotes) and O3 for `=`, `!=`, IN, LIKE, NOT LIKE and a behavior-appended `!=` scope entry over backslash values.
63. **SQLite boolean words are Value-lossy (R2)**: `TypeMap.booleanValue(pValue, pSourceDialect)`: on SQLite only the canonical integer texts map; `'true'` / `'false'` text is `{ Value: null, Lossy: 'Value' }` (Live neither matches `= 1` nor counts it as 1). Drivers that return real booleans keep them.
64. **PostgreSQL timestamps are read as naive text (R3)**: `MaterializeSource._projection` selects `to_char(C, 'YYYY-MM-DD HH24:MI:SS.US')` for DateTime columns (a queryOverride), so the process time zone never shifts a mirrored value; non-SQLite text with a nonzero sub-millisecond part is `Compare`-lossy (the mirror keeps milliseconds).
65. **Rebuild spec pins (R4)**: `setSpec(pSpec, { KeepLiveSpec, LiveChanged })`; `_reloadStore` keeps the live target's spec while a rebuild runs; `finishRebuild` pins the live target to the shadow's spec; `onSwapped` reports the spec that went live.
66. **Divergence survives Degraded and CatchingUp (R5)**: Freshness keeps `PriorDivergence` through Degraded and treats a prior `CatchingUp` / `Unverified` (or a Degraded entity whose prior was one of them) as unproven, so a Rebuilding entity stays non-Exact until its swap; `Rebuilder._abort` maps such priors to `Unverified` and schedules a verify.
67. **One materializer per store (R6)**: the lease (§58.10) and the owner marker (§56.1).
68. **Swaps never destroy a half-done exchange (R7)**: §59.2 (UUID check, shadow kept, retry with back-off, entity non-Exact meanwhile).
69. **Boot / backfill failures in proportion (R8)**: a `readState` error retries the boot (`_retryLater`), a wipe code goes to `recoverWipe`, live tables are never dropped on a read error; a failed backfill is retried with back-off (`_retryBackfill`).
70. **Boot Bisect after downtime (R9)**: `Reconcile.BootBisectAfterMS` (300 s): a clean restart whose state row is older holds `CatchingUp` and Bisects before Live, watermark or not.
71. **Leftover shadows dropped at boot (R10)**: `ensureSchema` reports `Shadows`; `_bootEntity` drops those of an entity with no build in flight (logged).
72. **The flaky single-flight test (R11)** (`Facet-Invalidation-Review`): the leader is gated on a hook instead of timing; the baseline is green again.
73. **Breaker counts store faults only (R13)**: §61.4 (`isHealthFailure`; deterministic / limit / busy / ParameterSize errors never count; a request's failure charged once, to the pivot); the compiler refuses a parameter over 90 % of `MAX_PARAM_TEXT` (`ParameterSize`, Live with no round trip). A per-tenant failure budget is not added: with only health failures counted a tenant can no longer open the breaker by request shape.
74. **Freshness exposure gated (R14)**: `ExposeFreshness` (§53.4): off on policy hosts by default — a store answer carries only a coarse `Exact` (`LagMS` / `AsOf` null when not exact), freshness refusal reasons become `Freshness`, Describe's per-entity State / LagMS / Exact and the infrastructure reason go only to `Admin.authorize` principals. Per-tenant pending tracking (admission and lag per requesting tenant) is deferred (§70).
75. **Database naming and ownership (R15)**: §56.1 (explicit `Database` or a non-default InstanceID required; injective derived names; the `_rfs_owner` marker; `Owner: 'Adopt'`).
76. **Lossy flags clear (R16)**: per-ID tracking per column (`LOSSY_ID_CAP` IDs; beyond it, or seeded at boot, the flag is sticky until a full Scrub rotation passes); a corrected or tombstoned row clears its ID, the last one clears the flag. Describe's per-entity Reason is the class (`LossyColumn`) unless detailed and `ExposeReasons`. Refusing only the Aggs whose scope holds lossy rows is not done (it needs a per-tenant lossy index; the column-wide refusal is correct, only conservative).
77. **Least privilege for reads (R17, R18)**: `readonly = 2` forced on every request read; `ReaderUser` (§53.4); separate reader / writer clients and socket pools; `MaxConcurrentReads` (`StoreBusy`); `ReadLimits`.
78. **Wipe recovery confirmed and scoped (R19)**: §59.3 (`tablesExist`, only the lost entities, `suspectWipe` rate-limited).
79. **Transport security (R20)**: a warning for `http://` to a non-loopback host unless `AllowInsecure`; `CA` / `Cert` / `Key` / `RejectUnauthorized`; README notes that parameter values travel in the request URI.
80. **A hung store (R21, critical; R22)**: client-side deadlines per statement from the request budget (§57.2, §62.1); a failed cube statement fails its members as `StoreError` (fallback, not a store re-run); the store-wide `Unreachable` flag with a background ping; a single half-open probe per breaker; rate-limited warnings. Tested behind a byte-swallowing TCP proxy.
81. **Bounded graceful stop (R23)**: shutdown state rows in one multi-row INSERT with the remaining drain time as `TimeoutMS` and no retries; at the hard deadline the clients are closed (sockets destroyed) and `stop` completes (CleanShutdown stays 0: the safe outcome).
82. **Batched stream cycles (R24)**: §58.5 (`StreamDelayMS`).
83. **Keymap reads (R25)**: no FINAL (`_liveKeyEntries`), keymap `index_granularity = 256`; `debug/m5-keymap-bench.js` (10M rows, 2000-ID batches: no-FINAL 50 ms vs FINAL 69 ms at granularity 8192; 86 vs 97 ms at 256, reading 11× fewer rows; 40M rows: 50-ID batches 11.6 ms at 256 vs 12.7 ms at 8192 reading 30× fewer rows, 2000-ID batches 175 vs 125 ms — a hot-cache, single-node measurement; the 85M cold-cache benchmark decides the final granularity).
84. **State writes coalesced (R26)**: §58.1 (`StateWriteIntervalMS`, lifecycle changes immediate); the Scrub cursor rides the periodic write; `PartsBackoffAbove` stretches the flush interval ×4 while merges lag.
85. **Scrub pacing after a restart (R27)**: `Reconciler._seedTotal` seeds the row count from `Store.approximateRows` (system.parts); `ScrubUnknownTotalRowsPerTick` until known; Scrub / Fill pages wait for the flush interval (`PromptRangeKinds`).
86. **Build concurrency and memory (R28)**: `MaxConcurrentBuilds` (2) queues backfills, rebuilds and boot verifies per store; `RebuildPageSize` 25000. Skipping the key overlay for shadow-only RebuildPages is not done (the page size bounds it).
87. **Sweep volume (R29)**: a build records the source's `maxStamp` before its first page as the Sweep watermark; Sweep pages are pre-filtered against the keymap's `UpdateDate` (only missing or newer IDs are re-hinted); the Sweep waits for room in the PendingSet.
88. **Reconcile schedule (R30)**: jittered phases and periods (`JitterRatio`); Bisects run one entity at a time per store (a queue); bucket checksums `GROUP BY` the identity with `optimize_aggregation_in_order`. Reporting missing `UpdateDate` indexes in Describe is not done.
89. **`capable()` is O(1) (R31)**: `Materializer.storeAvailable(S)`; no `status()` on the request path (measured < 250 µs per `capable()` + `entityFreshness()` with a 90k backlog).
90. **Live runs alongside the store (R32)**: §62.1.
91. **Demo databases per process (R33)**: `rfs_demo_<port>_<pid>_<domain>` (§66.3, §69.3), swept when the process is gone.
92. **Ops tests (R34)**: `test/Facet-M5-Review_tests.js` (hung store, bounded shutdown, insert / keymap-read rates, Scrub pacing, `capable()` cost, lease, owner marker, swap retry, single-table wipe).
93. **Found while fixing**: `Materializer.quiesce` also waits for an armed notify settle re-delivery (`ChangeIntake.settling(E)`) — with coalesced state writes quiesce became fast enough to return before a raw notify's settle re-hint, which then made the next Exact read Live (`Facet-Store-Routing`, intermittent); the harness's `stop()` abandons the materializer of a test database (`crash()` + `close()`) and gracefully shuts down a fixed one, so lease heartbeats and state timers never outlive a harness.

---

## 69. Containers, ports and scripts

### 69.1 The container (`test/support/Facet-Docker-ClickHouse.js`)

| | |
|---|---|
| name | `rfs-test-clickhouse` — the only ClickHouse container this module creates, starts, stops or removes |
| image | `clickhouse/clickhouse-server:24.8` (24.8.14.39 at the contracts pass; pulled if absent) |
| port | `127.0.0.1:18123 → 8123` (HTTP only) |
| user | `rfs_test`; password `RFS_TEST_CLICKHOUSE_PASSWORD`, else the throwaway `'rfs-ch-throwaway-test-only'`; `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1` |
| data | `--tmpfs /var/lib/clickhouse:rw` (no volume), `--ulimit nofile=262144:262144` |
| exact `docker run` | `docker run -d --name rfs-test-clickhouse --label com.retold.faceting.test=1 -e CLICKHOUSE_USER -e CLICKHOUSE_PASSWORD -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 -p 127.0.0.1:18123:8123 --ulimit nofile=262144:262144 --tmpfs /var/lib/clickhouse:rw clickhouse/clickhouse-server:24.8` (the two credentials passed through the environment, never on the command line; `node test/support/Facet-Docker-ClickHouse.js args` prints it) |
| `ensure(pOptions, cb)` | `ps -a --filter name=^/rfs-test-clickhouse$`: absent → run (a name conflict reuses that container), stopped → start, paused → unpause; then poll `GET /ping` and an authenticated `SELECT 1` (≤ 90 s; an authentication failure stops at once with a hint); then drop leftover `rfs_<pid>_<n>` databases whose process is gone (never on a URL server) |
| guard | `assertOwnContainer`: `ps` must filter on the name, `run` must name it, `start` / `stop` / `unpause` / `rm -v` only the name; no `exec`, `inspect`, `pull` or anything else (the image is pulled by hand or by `docker run`) |
| `stop(cb)` | `docker stop` + `docker rm -v rfs-test-clickhouse` (a no-op against `RFS_TEST_CLICKHOUSE_URL`) |
| CLI | `node test/support/Facet-Docker-ClickHouse.js ensure \| stop \| status \| ping \| args` |

Never another container, image, volume or network (in particular never a Sluice ClickHouse); never `docker system prune`. Test runs reuse a running container and leave it running; `npm run test:ch:down` removes it.

### 69.2 Ports

| Port | File |
|---|---|
| 19140 | `test/Facet-MirrorSpec_tests.js` (A; only if it boots a server) |
| 19141 | `test/Facet-Store-ClickHouse_tests.js` (A) |
| 19142 | `test/Facet-Materializer_tests.js` (B) |
| 19143 | `test/Facet-ClickHouse-Compiler_tests.js` (C) |
| 19144 | `test/Facet-Rebuilder-Reconciler_tests.js` (D) |
| 19145 | `test/Facet-Persistence-Chaos_tests.js` (D) |
| 19146 | `test/Facet-Conformance-ClickHouse_tests.js` (wiring) |
| 19147 | `test/Facet-Store-Routing_tests.js` (wiring) |
| 19148 | `test/Facet-M5-Review_tests.js` (review) |
| 19193 | `debug/m5-smoke.js` (pinned) |
| 19301–19305 | the demo's checks; 19300 is the user's demo server, never used by a builder |
| 18123 | `rfs-test-clickhouse` (host side) |

### 69.3 Databases and scripts

- Test databases `rfs_<pid>_<n>` (`Facet-ClickHouse-Support.freshDatabase`), dropped on release, leftovers of dead processes swept by `ensure`; the demo uses `rfs_demo_<front port>_<pid>_<domain>` (review: per process, so two demos never share one; kept on a graceful stop, swept by the next `ensure` once the process is gone — `DEMO_DATABASE_PATTERN`); production `Stores.ClickHouse.Database` or `rfs_<InstanceKey>[_<hash>]` (§56.1). Databases named `rfs_demo_<domain>` from before the review are never swept: drop them by hand. `debug/m5-keymap-bench.js` uses `rfs_<pid>_9999` (dropped at its end, swept if it dies).
- `package.json`:

```json
"test:ch": "RFS_TEST_CLICKHOUSE=1 TZ=UTC npx mocha --timeout 30000",
"test:ch:up": "node test/support/Facet-Docker-ClickHouse.js ensure",
"test:ch:down": "node test/support/Facet-Docker-ClickHouse.js stop"
```

`test:ch` runs the **whole** spec set with the ClickHouse gate on (so no ClickHouse suite can be left out); the support module ensures the container itself, so `test:ch:up` is optional. `RFS_TEST_POSTGRES=1 RFS_TEST_CLICKHOUSE=1 TZ=UTC npx mocha --timeout 30000` runs every gated half at once.

---

## 70. Seams for M6

| Seam | M5 behavior |
|---|---|
| `ApplyToken` in cache entries (store answers cacheable, 05 §6.4) | store answers never cached (`Bypass 'Store'`) |
| `MinSeqWaitMS` + flush nudging for `MinSeq` / read-your-writes | Exact → Live when not applied |
| Reader-only processes polling `_rfs_entity_state` (`StatePollMS`), multi-node / Hybrid materialization, the Agent `Materialize` routes, `MaterializeSource-Agent` | one Embedded process materializes and serves; the lease (§58.10) keeps every other process off the store (they answer Live) |
| Settings constraints on the reader user; the row-policy backstop (`custom_rfs_tenant`) | an optional `ReaderUser` for request reads, `readonly = 2` on every request read (§57.3) |
| Per-tenant freshness (pending work and lag per tenant: Exact admission and `LagMS` for the requesting tenant only) and per-tenant Lossy refusal | global per (store, entity); gated by `ExposeFreshness` (§68 #74, #76) |
| PathColumns (`Denormalize`, `Dictionary` + `dictGetOrNull`), DependencyIndex fan-out, store-internal audits, rollups (`ru_*`) and their scheduler, append-only aggregates (`agg_*` + MVs), parity canary, Advice | rows only; Subquery / ANY LEFT JOIN forms |
| Partitioned mirrors (`intDiv(ID, 10 M)`, `do_not_merge_across_partitions_select_final`, cold `OPTIMIZE … FINAL`), `LowCardinality`, native `Decimal`, EmbeddedRocksDB keymaps, the 85 M-row benchmark | unpartitioned, Nullable, Float64, ReplacingMergeTree keymap |
| `uniqCombined64` above `ExactDistinctMaxRows` (`Exact: false`) | `uniqExact` always |
| Store-only folds (cost model: `503 FACET_ENGINE_UNAVAILABLE` / stale serve when the store is down) | every fold is live-eligible; Live always answers |
| Solr / OpenSearch stores | not present |
| Tenant-scoped overflow remediation (Scrub of affected tenants, Sweep, fan-out of old keys) | whole-entity Resync |
| A durable change log / Bus with `AppliedCursor` resume | in-memory PendingSet; Unverified + reconcile after a crash |
