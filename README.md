# retold-faceting-service

Facets for any [retold-data-service](https://github.com/fable-retold/retold-data-service): term counts, date and numeric histograms, ranges, stats, distinct counts, missing counts and 2-D pivots, computed next to the list endpoints and always agreeing with them.

A facet request names an entity, the same filter clauses a pict-section-recordset sends to its list (or a meadow-filter string), and the facets to compute:

```
POST /1.0/Facet/BookStoreSale/Query
{
	"Clauses": [ { "Type": "DistinctSelectedValueList", "FilterByColumn": "PaymentMethod", "Values": [ "Credit" ], "FilterKey": "PaymentMethod" } ],
	"Facets":
	[
		{ "Key": "ByMonth", "Facet": "BookStoreSale.SaleDate", "Interval": "month" },
		{ "Key": "ByMethod", "Facet": "BookStoreSale.PaymentMethod" }
	],
	"Total": true
}
```

Each facet is computed *disjunctively* (a facet ignores its own clauses, so a selected checkbox never drives its siblings to zero), every bucket carries the pict clause that selects it, and every count is computed through the entity's own list behaviors (tenancy, soft-delete, app filters), so facets are never more permissive than the list.

## Status

**Milestone 4 (change capture, generations, result cache, freshness, SSE): implemented, reviewed and green** (`npm test`: 987 passing on in-memory SQLite, 196 pending — the PostgreSQL halves; `npm run test:pg`: 1183 passing; `debug/m4-smoke.js` green; the demo smoke 583 checks and its browser check 208, with every live check required). The review fixes are listed in `docs/internal-contracts.md` §51.46–§51.70. On top of Milestone 2:

- **Change capture without upstream changes.** At attach (and after every model reload) the service wraps, on each facetable entity's route-bound controller, the behavior **dispatcher** (`BehaviorInjection.runBehavior`) and the DAL's write methods — never a behavior slot, so a host's own `setBehavior` calls can neither be displaced nor remove the capture. Every write path of the stock CRUD routes, on meadow-endpoints 4.0.x and 4.1.x, is seen (single, bulk, update by PUT / PUT-by-id / PATCH, bulk update, upsert, Upserts, delete, undelete): the change is ingested at PostOperation **entry** (the row is committed; the host's own PostOperation behaviors then run, their callbacks untouched), from a pre-image snapshotted before any PreOperation behavior can mutate it; a write that commits but never reaches a PostOperation (a `PUT { Deleted: 1 }`, a tenant move under a QueryConfiguration filter, a re-read that fails) still yields a conservative event from the DAL path; a capture that cannot be derived fails closed (the whole entity is invalidated). A write is never failed or delayed. Each write becomes one `ChangeEvent` `{ Entity, Operation, IDs, Tenants, Owners, ChangedColumns, KeyImages, Actor, Seq }` (tenants and owners from the row images, before and after, never the writer's session; `Seq` = `'<NodeEpoch>:<n>'`). Writers the wrappers cannot see (DAL-direct, importers, raw SQL) call `notify(Entity, { IDs | Records | Tenants, ChangedColumns, Principal })` or `notifyByFilter(Entity, Filter, { Tenants })` after COMMIT — **always with `Tenants`** (a notify naming no tenant invalidates and signals every tenant; it is counted and warned about, and `ChangeCapture.RequireNotifyTenants` refuses it). An entity whose writes no source sees is never cached unless `ChangeCapture.NotifyManaged` names it. A Bus adapter seam takes over when the upstream `MeadowChangeBus` exists.
- **Generations** are tick-stamped per `(Entity, tenant | owner-qualified tenant | '*' | '#any', column | '#row' | '#all' | '#cols')`; a write bumps exactly its tenants' (and owners') keys on exactly its columns (`'#row'` when a delete, tenant, owner or identity column moves). The table is bounded by evicting whole (Entity, tenant) groups with per-group and per-entity floors (no ABA, never a global floor); the `'*'` / `'#any'` groups every fold reads are pinned.
- **Result cache (opt-in: `Cache: { Enabled: true }`).** Whole answers keyed by the plan, the canonical client conjuncts, each dependent entity's captured scope (as this principal, by probing its own list behaviors), the bound values, the role set and the ModelVersion — never a session — and validated by the GenVector of everything the answer reads (pivot, hops, label targets). An answer computed under a scope its probes did not see is never stored or shared. `Freshness: { Mode: 'Exact' | 'Bounded' | 'Fast', MaxLagMS, MinSeq }`: Exact never serves a stale entry; Bounded / Fast serve `Stale: true` (with `LagMS`) within the lag and refresh once in the background (at most `Cache.MaxConcurrentRefreshes` at a time); concurrent misses share one execution. The ETag becomes the generation Version, so `If-None-Match` answers `304` **before anything executes** (after authorization). Read-your-writes: a principal's Bounded / Fast reads are Exact for `Freshness.ReadYourWritesMS` after its own write; a `MinSeq` upgrades to Exact, and one this process cannot prove applied (another node's, or a future one) skips the cache and the 304 altogether. Answers carry `Cached`, `Stale`, `LagMS` and `DependsOn`. With the cache off (the default) every answer is exactly the M2 one plus `DependsOn`.
  **One process only:** generations and entries live in the serving process, so enable the cache only when every writer of the faceted tables runs in that same process (or reports through `notify()` in it); with several processes, one never sees another's writes until `Cache.MaxAgeMS`.
- **`GET /1.0/Facet/Changes`** (SSE): mounted by default on hosts with a scope policy (`SSE.Enabled: 'Auto'`; without a policy every write would reach every stream, so a single-tenant host opts in with `true`); authenticated, same-origin principals only (`SSE.AllowedOrigins` for others); `generation` events carry only `{ Entity, Generation }` (and the `Seq` only where `SSE.IncludeSeq` allows it), for tenants (and, for owner-scoped entities, owners) the principal can see, coalesced per entity per 250 ms by one shared timer; per-principal limits and a per-tenant fair share of the total; heartbeats; stalled consumers closed; each stream ends at its revalidation time so the client re-authenticates; a clean shutdown with streams open.
- **What a client is told.** On a host with a scope policy the node-wide `Seq` is not exposed (`Freshness.SeqHeader` / `SSE.IncludeSeq` default `'Auto'`), and the cache status headers (`X-Retold-Facet-Cache`, `-Freshness`) are an operator switch (`Cache.ExposeStatus`); a hit on an entry another principal computed says `Cached: false`. `Required` policy columns (sub-tenant restrictions) share the tenant's invalidation and signalling, and a `TenantOnly` fold over an owner-scoped entity is invalidated by a colleague's write but not pushed (it refreshes on its next request).

**Milestone 2 (cross-entity folds, definitions, named scopes, PostgreSQL): implemented, reviewed and green** (at M2: `npm test` 752 passing; `npm run test:pg` 929). On top of the Milestone 1 core:

- **Definitions files** (`Definitions.Path` — every `*.json` directly under it — plus `Definitions.Files` / `Definitions.Objects`) are loaded at attach and on every model reload: each entry is validated against `source/catalog/Facet-Definition-Schema.json` and the model graph, an invalid entry is disabled with a logged `FACET_DEFINITION_INVALID` (never partially loaded; everything that depends on it is disabled too), and `ModelVersion` covers the definitions. A file holds `Facets`, `Scopes`, `Aliases` (`FormatVersion: 1`); paths are declared with `>E.c` (to-one), `<E.c` (to-many), `=E.c` (co-reference) and `@Alias` steps, resolved at load, never solved at query time.
- **Cross-entity folds:** path Terms / histograms over to-one hops (K8), multi-valued Terms through a bridge or payload table (K9, `PivotDistinct`), path semi-joins and anti-joins incl. composite correlation (K10, K11: "no related row *visible to this principal*"), child-aggregate bands (K12 `ChildRollup`), unions of paths (K17 `Any`), TuplePivots (K18, expected-minus-actual), `HavingCount` (K19) and `ExistsSplit` (K20). Quantified (K13), Computed (K15) and UnionOfSources (K16) load as unsupported and answer `422 FACET_FOLD_UNSUPPORTED`.
- **Named scopes:** `Scopes: [ { Scope, Params } ]` in the body, or a `{ Type: 'NamedScope', Scope, Params }` clause, or the `/Scope/:Scope/` route forms; `$CurrentUser.*` comes from the principal only (unset → 401, never "matches nothing"), `$Now` / `$Today` are floored to `Cache.NowBucketMS`, `$Param.*` is validated against the scope's declared `Params`; scopes are never excluded by disjunction. pict's `InternalJoin*` / `ExternalJoin*` clauses compile to existence conjuncts over declared edges.
- **Per-hop scope:** every hop entity is a Scoped Relation rendered through its own list behaviors (tenancy, owner scope) with ScopeGuard and an explicit soft delete, composed by alias only (EXISTS / NOT EXISTS / derived-table LEFT JOIN / tuple correlation); a `TenantOnly` hop relaxes exactly the personal-scope column and nothing else, and only on an entity that keeps its tenant column (a definition that would relax an entity's only policy column is disabled at load, and the guard fails closed); an Opaque capture of a trusted entity runs Staged (a bounded key set bound as one scalar) after its replaced query's rendered SQL is checked bind by bind. Every entity a request reads is gated before anything about it is looked up: a scope or join entity the principal cannot facet fails the request with 403 (a hidden name and a nonexistent one get the same answer), a facet's own hop fails that facet with 403, a label target only loses its labels.
- **Read-side behaviors are audited (06 §3.5):** an entity whose `Reads-PostOperation` (or `Read-PreOperation`, `ReadsLite-` / `ReadDistinct-` / `ReadSelectList-PostOperation`) could drop or redact rows is Opaque for facets, Records, Count and Keys — as a pivot or as a hop — unless the host vouches for it with `Scope.TrustPostOperation: [ 'Entity' ]` (the behavior only decorates) or `Scope.PostOperationSafeColumns: { Entity: [ … ] }` (it never drops a row and never changes these columns; a relation reading only them answers). Describe reports `Opaque: { Reason: 'PostOperation' }`. Host behaviors that rewrite client operators (e.g. LIKE → ILIKE) are honored everywhere, including the column predicates the Live engine renders outside an entity's own relation.
- **Conditional disjunctive scan:** the single-valued facets of one pivot — Stats and Missing included, as per-group measures — are answered by one `GROUP BY` with the facets' own conjuncts as 0/1 flags, marginalized in JS (falls back to per-Variant statements over `CubeMaxGroups`, or when a host behavior rewrites a flag's operator); identical to the per-Variant answers (O5). The motivating queries run one cube statement plus one read per label target.
- **Records, Count and Keys** through the same compiler, always Live and Exact, hydrated through the entity's own list waterfall (`Reads-QueryConfiguration` → ScopeGuard → `doReads` → `Reads-PostOperation`):

```
POST /1.0/Facet/:Entity/Records                 body: filter inputs + Records: { Begin, Cap, Sort: [ { Field, Dir } ] }
POST /1.0/Facet/:Entity/Records/:Begin/:Cap     pict-section-recordset FilterEndpointOverride ({ Clauses, Experience })
POST /1.0/Facet/:Entity/Records/Count           → { Count }
POST /1.0/Facet/:Entity/Keys                    → { Entity, Keys, Count, Truncated, Version }   (Cap ≤ Limits.MaxKeys)
POST /1.0/Facet/:Entity/Scope/:Scope/Query | /Records | /Records/:Begin/:Cap | /Records/Count
```

  A recordset lists a named scope with `FilterEndpointOverride: 'Facet/MaterialIntakeRequirement/Scope/MaterialIntakeRequirement.ToDoForMe/Records'`; its list, count and facets then come from one compiler. A Query body may also carry `Records` (the envelope gains `Records`, `RecordShape`, `RecordsDropped`).
- **PostgreSQL** executes (the PG shells and the M2 compositions), with Live == Reference and Live(PG) == Live(SQLite) on every fixture, on the test DDL and on the production `meadow-connection-postgresql` DDL (BOOLEAN, NOT NULL defaults) under an ICU collation. Integer filter values outside a column's range are a 400, never a database error.

The three motivating questions of the design (08) run end to end over HTTP in `test/Facet-Motivating-Queries_tests.js` on both databases: projects for this user by complex criteria (E1), documents of a form type by month (E2), and the lab forms I still have to fill out — stored requirements with a co-reference anti-join (E3A) and implied requirements as a TuplePivot (E3B).

**Milestone 1 (core engine)** remains: `POST /1.0/Facet/:Entity/Query` and `GET /1.0/Facet/Describe` (Describe now also lists the declared facets and named scopes, with their `Params`, a principal may use); auto-derived Terms / DateHistogram / NumericHistogram / Ranges / Stats / DistinctCount / Missing / 2-D Pivot folds; pict clause arrays and meadow-filter strings; disjunctive faceting; a weak ETag that also hashes the computed answer; tenancy fail-closed (unset scope values are 401 on every route). MySQL and MSSQL shells dry-build to goldens (`test/goldens/`) and execute in a later milestone.

Later milestones cover Selections, the GROUPING SETS cube fallback, the upstream change bus (and with it the cache on by default), a durable change log, the Standalone/Agent roles, the ClickHouse/Solr stores, MySQL / MSSQL execution, and row-count prechecks (`Options.LIMITS_NOT_ENFORCED`).

## Installing on a retold-data-service

```javascript
const libRetoldFacetingService = require('retold-faceting-service');

_Fable.RetoldDataService.initializeService(
	(pError) =>
	{
		libRetoldFacetingService.installOnRetoldDataService(_Fable.RetoldDataService,
			{
				Role: 'Embedded',
				// Declared facets, named scopes and aliases (every *.json directly under the folder).
				Definitions: { Path: `${__dirname}/facets/` },
				// The tenancy policy the scope guard enforces on every hop.
				Scope: { Policy: { Column: 'IDCustomer', SessionField: 'CustomerID' }, Guard: 'Strict' },
				// Opt in to the result cache and the 304 short-circuit only when every write reaches the
				// service, in this process: through the stock CRUD routes (captured automatically) or
				// notify(Entity, { …, Tenants }) after COMMIT.
				Cache: { Enabled: true }
			},
			(pAttachError) =>
			{
				// Facets, Records, Count and Keys are now served under /1.0/Facet/
			});
	});
```

A definitions file (design `01 §4`) declares what the auto catalog cannot derive. For example, a named scope and a child-count band:

```json
{
	"FormatVersion": 1,
	"Scopes":
	{
		"Project.HasMyOverdue":
		{
			"Entity": "Project",
			"Where": [ { "Exists": { "Path": [ "<Task.IDProject" ], "Where": [ { "Field": "AssignedIDUser", "Op": "EQ", "Value": "$CurrentUser.IDUser" },
			                                                                 { "Field": "DueDate", "Op": "LT", "Value": "$Now" } ] } } ]
		}
	},
	"Facets":
	[
		{ "Facet": "Project.MyOverdueBand", "Version": 1,
		  "Dimensions": [ { "Kind": "ChildRollup", "Child": { "Path": [ "<Task.IDProject" ], "Agg": "count",
		                    "Where": [ { "Field": "AssignedIDUser", "Op": "EQ", "Value": "$CurrentUser.IDUser" } ] }, "Edges": [ 1, 3, 10 ] } ] }
	]
}
```

## Design

The architecture (fold algebra, API, engines, security, persistence, roadmap) lives in the design set `retold-faceting-service-design/design/` (`00-overview.md` is the entry point). The binding interfaces between this package's internal services are in [docs/internal-contracts.md](docs/internal-contracts.md).

## Testing

```
npm test
```

Tests use Mocha TDD on in-memory SQLite databases filled by deterministic seeded fixture builders (`test/fixtures/Bookstore-Seed.js`, and the M2 domains `ProjectTrack-Seed.js` and `LabTrack-Seed.js` with their definitions files, two tenants, an owner-scoped `LabForm`, global lookups and a trap for every hop: soft-deleted rows, NULL and dangling FKs, cross-tenant references). They never touch a shared database, and the servers listen on ephemeral ports, so runs that overlap do not collide. The oracles are:

- **O1**: every fixture request is answered by the Live engine and by the Reference engine (a pure-JS fold over rows each involved entity's own list endpoint returns, as the same principal), and the two envelopes must be identical.
- **O2**: each bucket's Clause is counted through the real list route (or, for scoped bodies and declared facets, through the Reference) and must equal the bucket's Count.
- **O-hand**: the motivating queries equal hand-written oracles (SQL in `Facet-Reference-M2_tests.js`, JS over the seed rows in `Facet-Motivating-Queries_tests.js`).
- **O5**: the per-Variant, cube and Staged plan forms give identical answers.
- **O-hand SQL for the lowering constructs** (HavingCount `EQ`, `Not` push-down, CheckParent forcing, `ExternalJoin*`), the **statement budgets** of the motivating queries, and on SQLite the **query plans** (every correlated hop probe is an index search on its correlation column) — `test/Facet-Review-M2_tests.js`, which also holds a regression for every finding of the M2 review.
- **pict oracle**, **two-tenant isolation on every hop**, the **LabForm owner scope**, **ScopeGuard** Strict and Repair, and the security regressions.
- **O7 (Milestone 4)**: every write kind through the stock CRUD routes and `notify()` / `notifyByFilter()` bump exactly the expected generation keys, dependent answers miss and unrelated ones hit (asserted on the cache metrics), Exact is never stale, Bounded is stale within its lag and refreshes once, the 304 path runs no SQL and only after authorization, one tenant's (or owner's) writes never invalidate or reach another, and a throwing subscriber never breaks a write — `test/Facet-Invalidation_tests.js` end to end (SQLite and PostgreSQL), with unit suites per service (`Facet-Generations`, `-ResultCache`, `-CacheKey`, `-ChangeIntake`, `-ReadYourWrites`, `-SSE`). `test/Facet-Invalidation-Review_tests.js` adds the review's obligations on both meadow-endpoints versions (the umbrella's 4.0.x and the monorepo's 4.1.x, harness option `MeadowEndpoints: 'Monorepo'`): writes that commit without reaching a PostOperation, a PreOperation that mutates the pre-image, a plain `setBehavior` after attach, a replaced dispatcher, scope drift between probe and execution, unprovable `MinSeq`s, model reloads mid-request, per-timeout single flight, and the client-visible defaults.

Run a single file with `npx mocha --no-package --ui tdd --timeout 20000 test/<File>_tests.js`. After an intended SQL change, regenerate the dialect goldens and review the diff:

```
FACET_UPDATE_GOLDENS=1 npx mocha --no-package --ui tdd --timeout 20000 test/Facet-ShellTemplates_tests.js test/Facet-Live-M2_tests.js
```

### PostgreSQL

The PostgreSQL suites are gated, so plain `npm test` stays SQLite-only and fast. They use a **dedicated** throwaway container, `rfs-test-postgres` (`postgres:16-alpine`, `127.0.0.1:15433`), and never touch any other container, image, volume or database:

```
npm run test:pg        # starts rfs-test-postgres if needed, then runs every PG suite (TZ=UTC)
npm run test:pg:up     # just start (or reuse) the container
npm run test:pg:down   # stop and remove it
```

| Variable | Meaning |
|---|---|
| `RFS_TEST_POSTGRES=1` | run the PG suites against `rfs-test-postgres` (`npm run test:pg` sets it) |
| `RFS_TEST_POSTGRES_URL=postgres://user:password@host:port/database` | run them against that server instead (no docker; only `rfs_*` databases are created and dropped) |
| `RFS_TEST_POSTGRES_PASSWORD` | the container's password (default: a throwaway test-only value) |
| `TZ=UTC` | required: node-postgres reads `timestamp` in local time (the hook refuses to run otherwise) |

Each harness gets a fresh `rfs_<pid>_<n>` database (UTF8, C collation), created from the model with nullable columns, seeded with the same rows as SQLite, indexed (FK / Join, GUID, tenancy and owner columns) and analyzed like a production schema, and dropped on release; `start({ …, PostgresSchema: 'Meadow' })` uses the production `meadow-connection-postgresql` DDL and an ICU `en-US` collation instead. `npm run test:pg` runs the whole spec set with the PostgreSQL suites on, so no PG suite can be left out. The container keeps running between runs; `npm run test:pg:down` stops and removes it.

### Smoke runs

To see the service answer, boot a seeded harness and print sample envelopes:

```
node debug/m1-smoke.js     # Bookstore on port 19190: Describe and a sample Query
node debug/m2-smoke.js     # ProjectTrack (19191) + LabTrack: the three motivating queries as user 42 / tenant 7
node debug/m4-smoke.js     # ProjectTrack (19192), cache on: miss, hit, 304, a CRUD write, its SSE event, miss, hit
```

## Demo

[`example_applications/faceting_demo`](example_applications/faceting_demo/README.md) is a pict single-page app over three seeded domains: ProjectTrack, LabTrack, and a Bookstore with demo definitions. It has four pages, each asking one question:

- **Projects for me** (E1): named scopes with a Roles parameter, disjunctive terms, a month histogram, an overdue-task band and a Status × Client pivot.
- **Documents by form type** (E2): a disjunctive form-type checklist and a histogram with click and drag. The readout states the selected span and the page Total. Edge buckets only partly inside the selection are drawn hatched.
- **Lab forms I still have to fill out** (E3): variant A shows the stored requirements and a work list with the related intake fields looked up. Variant B shows the same question as a TuplePivot over configuration. The cross-check opens with what the two variants agree on, then lists the planted mismatches.
- **Bookstore explorer**: its facet cards are built from `GET /1.0/Facet/Describe`.

Every page shows the active filters as removable chips. Its list always agrees with the facet Total, and you can verify that with `Records/Count`. A request / envelope inspector shows the current page's exchanges and timing. A DEMO "signed in as" switcher shows the same request answering differently per principal. Since Milestone 4 each page also has a "Make a change" card that writes through the domain's stock CRUD routes as the demo principal; the counts then update by themselves over `GET /1.0/Facet/Changes`, and the inspector shows whether an answer was Cached or Stale and its Version.

```
cd example_applications/faceting_demo
npm start        # http://127.0.0.1:19300/ (builds the bundle when needed)
npm test         # end-to-end server smoke through the demo's front server (port 19301)
npm run check:browser  # the built page in headless Chrome: every page's gestures (port 19302); screenshots go to the
                       # OS temp dir, DEMO_UPDATE_SCREENSHOTS=1 refreshes the tracked screenshots/
```

The switcher picks a principal through a request header. The demo host resolves that header to a test session. It is demo-only: the front server binds loopback, and the domain servers listen on 127.0.0.1 only, with a loopback guard installed before they listen. The test harness's `Host` and `BeforeListen` options, in `test/support/Facet-Test-Harness.js`, exist for this. `npx quack examples` serves only the static shell, because the facet API needs `npm start`.

## License

MIT
