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

**Milestone 5 (the ClickHouse store): implemented, reviewed and green** (`npm test`: 1194 passing, 266 pending — the gated halves, no docker needed; `npm run test:pg`: 1394 passing; `npm run test:ch`: 1308 passing; both gates at once: 1542 passing, none pending; `debug/m5-smoke.js` green; the demo smoke 583 checks, 453 with `DEMO_CLICKHOUSE=1`, and the browser check 208, with and without the store). The binding text is `docs/internal-contracts.md` Part IV (§53–§70, the as-built decisions in §68, the review fixes in §68 #61–#93). On top of Milestone 4:

- **An optional materialized store** (`Stores.ClickHouse`, `Materialize`): every declared entity is mirrored row for row into `ReplacingMergeTree` tables (`rfs_<InstanceID>` unless `Database` is given), kept current by a materializer subscribed to the change intake — a fresh, trusted DAL read of the changed IDs per cycle (latest read wins, one INSERT per flush carrying rows and tombstones, a keymap so tenant / owner / FK moves leave no ghost), a shadow table + `EXCHANGE TABLES` for rebuilds under writes, and Sweep / Bisect / Scrub reconciliation for writes no hint reported. Feature-not-boot: a store that is down or misconfigured leaves the service answering Live, and is retried.
- **Per-facet routing with freshness**: a facet goes to the store only when the store engine can answer it (every entity and column it reads mirrored, no Show-deleted, no value the mirror cannot compare exactly, a Portable scope capture) **and** the request's `Freshness` admits the store's state: `Exact` (the default) only when every entity it reads is fully applied, `Bounded` within `MaxLagMS`, `Fast` whenever the store is usable. Everything else, and anything the store fails on, is answered Live in the same request (`FACET_STORE_FALLBACK`, a circuit breaker per engine and entity). `Engine: 'Live'` in the body always asks the authoritative engine. Each facet says which engine answered it and how current it is (`Engine`, `Exact`, `AsOf`, `LagMS`), and the envelope's `Store` block says why a facet stayed Live (reason classes; full reasons with `ExposeReasons`). Store answers are never cached (their ETag is the representation digest). Records, Count and Keys always run Live. The same three-way oracle as before holds on the store: **ClickHouse == Live == Reference** on every supported fixture, on SQLite and PostgreSQL sources (O3), and the persistence chaos suite (O10) ends with the mirror equal to the source row for row.
- **Operations**: `status()` / Describe report the store and each mirrored entity's state (`Live`, `Lagging`, `CatchingUp`, `Rebuilding`, `Unverified`, …); `storeAdmin('Rebuild' | 'Sweep' | 'Bisect' | 'Scrub' | 'Verify', 'ClickHouse', Entity, Options, cb)` in process, and guarded admin routes when `Admin.Routes` is true and `Admin.authorize` approves.
- **Hardened by the M5 review** (`docs/internal-contracts.md` §68 #61–#93; regressions in `test/Facet-M5-Review_tests.js`): string parameters are escaped for ClickHouse's Escaped format and an over-long one is refused before sending; a column `NOT IN` drops NULL rows exactly as the list does; SQLite boolean words and PostgreSQL timestamps can no longer put wrong values in the mirror; **one process materializes a store** (a lease row; other processes answer Live) and a database carries an owner marker; every store statement is bounded by the request's deadline on the client side (a hung server is cut off, the same request answers Live, the whole store is marked unreachable until a ping succeeds) and a graceful stop is bounded too; only store faults count toward the breaker (a malformed request cannot switch the store off for other tenants) and half-open admits one probe; the store's lag is not exposed to clients of a multi-tenant host unless `ExposeFreshness`; writes are batched per flush interval, state rows coalesced, keymap reads done without FINAL, builds queued, the Sweep and the Scrub paced, and a swap or wipe error never loses more than the table it concerns.

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

Later milestones cover Selections, the GROUPING SETS cube fallback, the upstream change bus (and with it the cache on by default, and cacheable store answers), a durable change log, the Standalone/Agent roles (and reader-only store processes), store-side denormalization (path columns, dictionaries, rollups), the Solr / OpenSearch stores, MySQL / MSSQL execution, and row-count prechecks (`Options.LIMITS_NOT_ENFORCED`).

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

To also answer facets from a ClickHouse store (Milestone 5), add the store and declare what it mirrors; the service boots and answers Live while the store is unreachable, and uses it per facet once it is current enough for each request:

```javascript
libRetoldFacetingService.installOnRetoldDataService(_Fable.RetoldDataService,
	{
		Scope: { Policy: { Column: 'IDCustomer', SessionField: 'CustomerID' }, Guard: 'Strict' },
		Stores:
			{
				ClickHouse:
					{
						URLEnv: 'FACET_CLICKHOUSE_URL',            // 'http(s)://host:port', no credentials in it
						UserEnv: 'FACET_CLICKHOUSE_USER',
						PasswordEnv: 'FACET_CLICKHOUSE_PASSWORD',  // secrets by environment variable name (or by value from code), never logged
						// Required: an explicit Database, or a non-default InstanceID (rfs_<InstanceID>); with neither the store
						// is Misconfigured (every deployment left at the defaults would share one database).
						Database: 'facets_main',
						// Optional least-privilege credential for request reads (grant it SELECT on the database only); every
						// request read runs with readonly = 2 regardless.  The writer needs CREATE / INSERT / ALTER / DROP on
						// that database only (no SOURCES, no ACCESS MANAGEMENT).
						ReaderUserEnv: 'FACET_CLICKHOUSE_READER',
						ReaderPasswordEnv: 'FACET_CLICKHOUSE_READER_PASSWORD'
						// https:// URLs take CA / Cert / Key (PEM text) and RejectUnauthorized; plain http:// to a host that is
						// not loopback is logged as insecure unless AllowInsecure: true.
					}
			},
		// Which entities are mirrored ('Auto' columns: identity, policy and delete columns, every Join column and
		// every filterable column the type map mirrors exactly; IncludeColumns / ExcludeColumns adjust it).
		Materialize:
			{
				Project: { Store: [ 'ClickHouse' ] },
				Task: { Store: [ 'ClickHouse' ], Watermark: 'UpdateDate' },
				ProjectMembership: { Store: [ 'ClickHouse' ] }
			}
	}, fAttached);
```

A facet is answered by the store only when every entity it reads is mirrored with every column it reads (`MirrorSpec.warnings()` lists declared facets and scopes that cannot be: `ClosureIncomplete`). Operating notes:

- **One materializing process per store.** The first process to start takes a lease in the store (`_rfs_lease`, renewed every `Materializer.Lease.HeartbeatMS`); any other process pointed at the same database leaves the store unused and answers Live (`NotLeader`) until the holder stops — a graceful stop hands it over within a heartbeat. Several app processes therefore work, but only one of them uses the store (reader-only store processes are a later milestone). The database also records which deployment owns it (`_rfs_owner`: InstanceID + a fingerprint of the source database); pointing another deployment at it is refused (`Misconfigured`) unless `Owner: 'Adopt'`.
- **Freshness on a multi-tenant host.** The store's lag is global (another tenant's write makes it lag), so with a scope policy `ExposeFreshness: 'Auto'` hides `LagMS` / `AsOf` and freshness reasons from clients (they see `Exact`), and Describe's per-entity store state is shown only to principals your `Admin.authorize(pRequest, pPrincipal)` approves. Set `ExposeFreshness: true` on a single-tenant host or to accept the signal.
- **Parameter values travel in the request URI** (ClickHouse's HTTP parameters): a proxy or load balancer in front of ClickHouse must not log query strings, and should terminate TLS.
- **Timeouts.** Each store statement gets 40 % of the request's remaining deadline, enforced by the client as well as by `max_execution_time`; a hung or slow store costs one deadline share, then the request answers Live and, after `UnreachableAfterFailures`, every request answers Live at once until a background ping succeeds. `Freshness.DefaultMode` stays `'Exact'`, so a default request uses the store only when it has applied every observed change; ask `Bounded` or `Fast` to trade freshness for the store. Writers the intake cannot see must `notify()` as before (the store re-reads what they name), and the reconcile timers (`Reconcile.*`) repair what nobody reported.

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

### ClickHouse

Milestone 5's ClickHouse store (`Stores.ClickHouse`, `Materialize`; contract: `docs/internal-contracts.md` Part IV) has its suites gated like the PostgreSQL ones. They use a **dedicated** throwaway container, `rfs-test-clickhouse` (`clickhouse/clickhouse-server:24.8`, `127.0.0.1:18123`, tmpfs data, a test-only user), never any other container:

```
npm run test:ch        # starts rfs-test-clickhouse if needed, then runs every suite with the ClickHouse gate on (TZ=UTC)
npm run test:ch:up     # just start (or reuse) the container
npm run test:ch:down   # stop and remove it
```

| Variable | Meaning |
|---|---|
| `RFS_TEST_CLICKHOUSE=1` | run the ClickHouse suites against `rfs-test-clickhouse` (`npm run test:ch` sets it) |
| `RFS_TEST_CLICKHOUSE_URL=http://user:password@host:port` | run them against that server instead (no docker; only `rfs_<pid>_<n>` databases are created and dropped) |
| `RFS_TEST_CLICKHOUSE_PASSWORD` | the container's password (default: a throwaway test-only value) |

Each harness started with `Store: 'ClickHouse'` (`test/support/Facet-Test-Harness.js`) materializes its fixture into a fresh `rfs_<pid>_<n>` database, waits for the backfill, offers `storeQuery` / `compareStore` (ClickHouse, Live and the Reference for one body), and drops the database on stop. `RFS_TEST_POSTGRES=1 RFS_TEST_CLICKHOUSE=1 TZ=UTC npx mocha --timeout 30000` runs every gated half at once (the O3 suite then also compares PostgreSQL sources). The oracles added by Milestone 5:

- **O3** (`test/Facet-Conformance-ClickHouse_tests.js`): ClickHouse == Live == Reference for the Bookstore conformance list (Bookstore, both tenants of Bookstore-Tenant), the motivating queries and Describe-driven per-kind coverage of ProjectTrack and LabTrack as every principal, with each facet the store supports really answered by it, every refusal explained (Show-deleted, a trusted Opaque hop, a non-mirrored entity or column, Lossy columns, a SQLite day-only date literal) and answered with the Reference's numbers, and decimals at values the 24.8 Float64 parser misreads.
- **Routing** (`test/Facet-Store-Routing_tests.js`): admission per Freshness mode (Exact never stale), `Engine: 'Live'`, read-your-writes, same-request fallback, the breaker, the Store block, no caching of store answers, Records / Count / Keys never on the store, feature-not-boot.
- **O10** (`test/Facet-Persistence-Chaos_tests.js`): duplicate and out-of-order events, a crash between flush and ack, 5xx inserts, one flush with every kind of move, FK moves, raw SQL without notify, a rebuild under ~50 writes/s and a volume wipe, each ending with the mirror equal to the source.
- **Review regressions** (`test/Facet-M5-Review_tests.js`): parameter escaping against the server, NOT IN over NULLs, boolean text, backslash values, `ParameterSize`, the breaker and deterministic errors, `ExposeFreshness`, a hung store behind a byte-swallowing TCP proxy (deadline fallback, `Unreachable`, ping, bounded shutdown), the lease and the owner marker, a swap that errors after landing, a single dropped table, insert / keymap-read rates under a write stream, Scrub pacing, `capable()` cost with a 90k backlog, and PostgreSQL timestamps under a non-UTC process time zone.

`node debug/m5-keymap-bench.js` (inside `rfs-test-clickhouse`; `KEYMAP_ROWS`, default 10M, and `KEYMAP_BATCH`, default 2000) times the keymap point read with and without FINAL at `index_granularity` 8192 and 256.

The ClickHouse client (`source/store/clickhouse/ClickHouse-Client.js`: HTTP, `{name:Type}` parameters, JSONEachRow inserts with deduplication tokens, lifted from Sluice) lives in this module for now; it requires nothing outside `source/store/clickhouse/` and is slated to move to a future `meadow-connection-clickhouse` module.

**ClickHouse 24.8 parses Float64 text inexactly**: a `{p:Float64}` query parameter and JSONEachRow / CSV / Values input of values such as `5.94` or `7.56` land one ulp off. Only `toFloat64(<String>)` under `precise_float_parsing = 1` is exact, so the store inserts decimals through it and the fold compiler binds every Float64 value as text (`toFloat64({p:String})`, IN lists as `has(arrayMap(…))`); code that talks to the store directly must do the same (`docs/internal-contracts.md` §68 #22, #49).

### Smoke runs

To see the service answer, boot a seeded harness and print sample envelopes:

```
node debug/m1-smoke.js     # Bookstore on port 19190: Describe and a sample Query
node debug/m2-smoke.js     # ProjectTrack (19191) + LabTrack: the three motivating queries as user 42 / tenant 7
node debug/m4-smoke.js     # ProjectTrack (19192), cache on: miss, hit, 304, a CRUD write, its SSE event, miss, hit
node debug/m5-smoke.js     # ProjectTrack (19193) + LabTrack with the ClickHouse store (rfs-test-clickhouse): E1 / E2 / E3A / E3B
                           # answered by ClickHouse and equal to Live, a write, Exact → Live while the store lags, Fast's LagMS → 0
```

## Demo

[`example_applications/faceting_demo`](example_applications/faceting_demo/README.md) is a pict single-page app over three seeded domains: ProjectTrack, LabTrack, and a Bookstore with demo definitions. It has four pages, each asking one question:

- **Projects for me** (E1): named scopes with a Roles parameter, disjunctive terms, a month histogram, an overdue-task band and a Status × Client pivot.
- **Documents by form type** (E2): a disjunctive form-type checklist and a histogram with click and drag. The readout states the selected span and the page Total. Edge buckets only partly inside the selection are drawn hatched.
- **Lab forms I still have to fill out** (E3): variant A shows the stored requirements and a work list with the related intake fields looked up. Variant B shows the same question as a TuplePivot over configuration. The cross-check opens with what the two variants agree on, then lists the planted mismatches.
- **Bookstore explorer**: its facet cards are built from `GET /1.0/Facet/Describe`.

Every page shows the active filters as removable chips. Its list always agrees with the facet Total, and you can verify that with `Records/Count`. A request / envelope inspector shows the current page's exchanges and timing. A DEMO "signed in as" switcher shows the same request answering differently per principal. Since Milestone 4 each page also has a "Make a change" card that writes through the domain's stock CRUD routes as the demo principal; the counts then update by themselves over `GET /1.0/Facet/Changes`, and the inspector shows whether an answer was Cached or Stale and its Version.

With `DEMO_CLICKHOUSE=1` (Milestone 5) every domain also materializes into the ClickHouse store: the strip says which engine answered each facet and how far behind the store is, a toggle asks `Auto`, `Live` or `Store (Fast)`, and "Live vs Store" shows both answers side by side; after "Make a change" an Exact refetch stays correct through Live while the store catches up.

```
cd example_applications/faceting_demo
npm start        # http://127.0.0.1:19300/ (builds the bundle when needed); DEMO_CLICKHOUSE=1 npm start adds the store
npm test         # end-to-end server smoke through the demo's front server (port 19301)
npm run check:browser  # the built page in headless Chrome: every page's gestures (port 19302); screenshots go to the
                       # OS temp dir, DEMO_UPDATE_SCREENSHOTS=1 refreshes the tracked screenshots/
```

The switcher picks a principal through a request header. The demo host resolves that header to a test session. It is demo-only: the front server binds loopback, and the domain servers listen on 127.0.0.1 only, with a loopback guard installed before they listen. The test harness's `Host` and `BeforeListen` options, in `test/support/Facet-Test-Harness.js`, exist for this. `npx quack examples` serves only the static shell, because the facet API needs `npm start`.

## License

MIT
