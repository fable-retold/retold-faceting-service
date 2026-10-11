# Testing

The faceting service is tested against **oracles**: independent ways of computing the same answer. Every fixture request is answered by the Live engine and by a pure-JavaScript Reference engine, every bucket's clause is counted through the real list route, and with a store the ClickHouse answer must equal both. A number that two independent paths agree on is very hard to get wrong by accident.

This page is for contributors to the module: it covers running the suites, the databases they use, the fixtures and their traps, the oracles, the smoke scripts and the demo checks, and how to write a test with the harness. To test facets in your own application, start with *Testing Facets in Your Application* below.

## Testing Facets in Your Application

Your application does not need this module's harness. Three in-process checks catch most mistakes, using the service's own methods ([JavaScript API](#/page/api/JavaScript_API)):

1. **One request per persona.** Build a synthetic request with the session each persona's list routes see (*The Request Argument* in the JavaScript API), run `query` with the body your page sends, and assert the `Total` and a few bucket counts.
2. **Every selectable bucket agrees with the list.** For each bucket with a `Clause`, add the clause to the body and run `count`: the `Count` must equal the bucket's `Count`. Then ask the stock [meadow-endpoints](#/doc/meadow/meadow-endpoints) count route (`GET /1.0/<Entity>s/Count/FilteredTo/…`) with the same filter as the same user, and expect the same number.
3. **Tenants never see each other.** Run the same body as a user of each tenant. No bucket key that exists only in one tenant's data may appear in the other's answer, and each `Total` must equal that tenant's own list count.

```javascript
tmpService.query('Project', tmpBody, tmpLeadRequest,
	(pError, pEnvelope) =>
	{
		let tmpBucket = pEnvelope.Facets.Status.Buckets[0];
		let tmpCountBody = { Clauses: (tmpBody.Clauses || []).concat([ tmpBucket.Clause ]) };
		if (tmpBody.Scopes)
		{
			tmpCountBody.Scopes = tmpBody.Scopes;
		}
		tmpService.count('Project', tmpCountBody, tmpLeadRequest,
			(pCountError, pCount) =>
			{
				// pCount.Count === tmpBucket.Count
			});
	});
```

[Troubleshooting](#/page/Troubleshooting) shows how to compare a Live answer with the Reference oracle on your own data.

## Running the Tests

```bash
npm test
```

Plain `npm test` runs every `test/**/*_tests.js` file with Mocha (TDD interface) on in-memory SQLite. It needs no docker and no network. The PostgreSQL and ClickHouse halves of the suites are gated: without their gate they show as pending.

Run one file on its own:

```bash
npx mocha --no-package --ui tdd --timeout 20000 test/Facet-Records-Keys_tests.js
```

Servers in the tests bind ephemeral ports on `127.0.0.1`, so two runs at the same time never collide.

### Goldens

The SQL each dialect builds is pinned in `test/goldens/` (`Facet-ShellTemplates-Goldens.json`, `Facet-Live-M2-Goldens.json`, `Facet-ClickHouse-Goldens.json`). After an intended SQL change, regenerate them and review the diff:

```bash
FACET_UPDATE_GOLDENS=1 npx mocha --no-package --ui tdd --timeout 20000 test/Facet-ShellTemplates_tests.js test/Facet-Live-M2_tests.js
```

The ClickHouse compiler goldens (`test/Facet-ClickHouse-Compiler_tests.js`) regenerate the same way. The goldens are also how the MySQL and MSSQL statements are checked: they are built, never executed.

## PostgreSQL

The PostgreSQL suites run against a dedicated throwaway container, `rfs-test-postgres` (`postgres:16-alpine`, `127.0.0.1:15433`). The scripts never touch any other container, image, volume or database.

```bash
npm run test:pg        # start rfs-test-postgres if needed, then run every suite with PostgreSQL on (TZ=UTC)
npm run test:pg:up     # only start (or reuse) the container
npm run test:pg:down   # stop and remove it
```

| Variable | Meaning |
|---|---|
| `RFS_TEST_POSTGRES=1` | run the PostgreSQL halves against `rfs-test-postgres` (`npm run test:pg` sets it) |
| `RFS_TEST_POSTGRES_URL=postgres://user:password@host:port/database` | run them against that server instead, with no docker; only `rfs_*` databases are created and dropped there |
| `RFS_TEST_POSTGRES_PASSWORD` | the container's password (default: a throwaway test-only value) |
| `TZ=UTC` | required: node-postgres reads `timestamp` values in local time, so the provider refuses to run without it |

Each harness gets a fresh `rfs_<pid>_<n>` database, created from the fixture model, seeded with the same rows as SQLite, indexed and analyzed like a production schema, and dropped when the harness stops. `start({ …, PostgresSchema: 'Meadow' })` uses the production `meadow-connection-postgresql` schema and an ICU collation instead. The container keeps running between runs.

## ClickHouse

The store suites run against a dedicated throwaway container, `rfs-test-clickhouse` (`clickhouse/clickhouse-server:24.8`, `127.0.0.1:18123`, data on tmpfs, a test-only user).

```bash
npm run test:ch        # start rfs-test-clickhouse if needed, then run every suite with ClickHouse on (TZ=UTC)
npm run test:ch:up     # only start (or reuse) the container
npm run test:ch:down   # stop and remove it
```

| Variable | Meaning |
|---|---|
| `RFS_TEST_CLICKHOUSE=1` | run the ClickHouse suites against `rfs-test-clickhouse` (`npm run test:ch` sets it) |
| `RFS_TEST_CLICKHOUSE_URL=http://user:password@host:port` | run them against that server instead; only `rfs_<pid>_<n>` databases are created and dropped there |
| `RFS_TEST_CLICKHOUSE_PASSWORD` | the container's password (default: a throwaway test-only value) |

With the gate on, an unreachable server fails the suite at setup; it is never silently skipped. Each harness started with `Store: 'ClickHouse'` materializes its fixture into a fresh database, waits for the backfill, and drops the database when it stops. Leftover databases of dead processes are swept the next time the container is ensured.

Both gates at once run every gated half (the store's conformance suite then also compares PostgreSQL sources):

```bash
RFS_TEST_POSTGRES=1 RFS_TEST_CLICKHOUSE=1 TZ=UTC npx mocha --timeout 30000
```

## The Fixtures

Every fixture is built by a deterministic seeded generator (one PRNG stream per table), so a run is repeatable. Each one plants **traps**: rows that an engine that cut a corner would count wrongly.

| Fixture | What it is | Some of its traps |
|---|---|---|
| `Bookstore` | the retold-harness bookstore model (books, authors, stores, sales, reviews) on one tenant | soft-deleted rows in every table, NULL dates and numbers, `''` strings, skewed categories, a negative publication-year outlier, a sale amount just below a histogram edge (`499.996`), dates stored in non-canonical text forms, a Terms value containing `~` |
| `Bookstore-Tenant` | the same model with an `IDTenant` column on every table, two tenants | tenant 1 is the base data, tenant 2 a small clone with its own IDs, and tenant-1 rows that reference tenant-2 parents |
| `ProjectTrack` | projects, memberships, tasks, issues, documents and a global `FormType` lookup; tenant column `IDCustomer` | inactive and soft-deleted memberships, overdue tasks spread over every band, a soft-deleted open blocker and a tenant-2 blocker on a tenant-1 project (neither may block), a soft-deleted client and a tenant-2 client referenced by live projects, NULL and dangling form types |
| `LabTrack` | lab queues, material intakes, required forms and an owner-scoped `LabForm`; tenant column `IDCustomer`, owner column `OwnerIDUser` | every lab-form case per requirement: none, started, complete by me, complete by a colleague (visible only through a `TenantOnly` hop), complete but soft-deleted, complete in the other tenant; a duplicate requirement row; a soft-deleted queue and intake |

The domain fixtures define named principals: ProjectTrack `Lead`, `Member`, `Outsider` (tenant 1) and `OtherLead` (tenant 2); LabTrack `Tech`, `Colleague`, `Newbie` (tenant 1) and `OtherTech` (tenant 2). Their definitions files (`test/fixtures/ProjectTrack-Definitions.json`, `LabTrack-Definitions.json`) hold the motivating examples and a coverage facet for each cross-entity fold kind, and must load with no disabled entry.

## The Oracles

| Oracle | Proves | Where |
|---|---|---|
| **O1** | the Live engine and the Reference engine give identical envelopes. The Reference reads each entity through its own list as the same principal and folds in JavaScript; it shares the plan with Live but none of Live's SQL composition | `Facet-Conformance-SQLite`, `Facet-Live-Bookstore`, `Facet-Motivating-Queries`, the PostgreSQL conformance suite |
| **O2** | each bucket's `Clause`, appended to the request's filter, counts the same rows through the real list route as the bucket's `Count` | `Facet-Conformance-SQLite` and the domain suites (through the Reference for scoped bodies) |
| **O-hand** | the motivating queries equal hand-written answers: SQL in `Facet-Reference-M2`, JavaScript over the seed rows in `Facet-Motivating-Queries` | those files |
| **O3** | ClickHouse == Live == Reference for every supported facet, as every principal, on SQLite and PostgreSQL sources; every facet the store supports really is answered by it, and every refusal is explained | `Facet-Conformance-ClickHouse` |
| **O5** | the plan forms (one statement per filter variant, the conditional disjunctive cube, staged hops) give identical answers | `Facet-PlanForms` |
| **O6** | per-hop scope: two-tenant isolation on every hop, the owner scope, ScopeGuard `Strict` and `Repair` | `Facet-Security-M2`, `Facet-Security`, `Facet-Live-Unit` |
| **O7** | every write path bumps exactly the expected generation keys; dependent answers miss and unrelated ones hit; `Exact` is never stale; the 304 path runs no SQL and only after authorization; one tenant's writes never reach another | `Facet-Invalidation`, `Facet-Invalidation-Review` (on both meadow-endpoints 4.0 and 4.1) |
| **O9** | every shell template dry-builds on every dialect, binds only scalars and matches its golden SQL | `Facet-ShellTemplates`, `Facet-Live-M2` |
| **O10** | the mirror ends equal to the source row for row after duplicate and out-of-order events, a crash between flush and ack, failed inserts, tenant, owner and foreign-key moves in one flush, raw SQL without notify, a rebuild under about 50 writes per second, and a wiped database | `Facet-Persistence-Chaos` |

Unit suites cover each service on its own: the pure contract modules, the clause compiler (against pict's own filter builder), the catalog and graph, definitions loading, the Binder and the planner, generations, the result cache, the cache key, the change intake, read-your-writes, the change feed, the mirror spec, the materializer (against an in-memory fake store), the rebuilder and reconciler, the ClickHouse client and compiler, and store routing. `Facet-Review-M2` and `Facet-M5-Review` hold a regression test for every review finding.

## Smoke Scripts

The smoke scripts boot a seeded harness, print sample answers and exit non-zero on a failed step. They bind **fixed** ports, so only one copy of each runs at a time.

```bash
node debug/m1-smoke.js     # Bookstore on port 19190: Describe and a sample Query
node debug/m2-smoke.js     # ProjectTrack (19191) and LabTrack: the three motivating queries as user 42 / tenant 7
node debug/m4-smoke.js     # ProjectTrack (19192), cache on: miss, hit, 304, a CRUD write, its change event, miss, hit
node debug/m5-smoke.js     # ProjectTrack (19193) and LabTrack with the ClickHouse store: each motivating query
                           # answered by ClickHouse and equal to Live, then a write and the store catching up
```

`node debug/m5-keymap-bench.js` times the store's keymap point read at scale inside `rfs-test-clickhouse` (`KEYMAP_ROWS`, default 10 million; `KEYMAP_BATCH`, default 2000).

## The Demo's Checks

The demo in `example_applications/faceting_demo` has its own checks:

```bash
cd example_applications/faceting_demo
npm start                # the demo at http://127.0.0.1:19300/ (DEMO_CLICKHOUSE=1 npm start adds the store)
npm test                 # an end-to-end server smoke through the demo's front server (port 19301)
npm run check:browser    # the built page in headless Chrome, every page's gestures (port 19302)
```

`check:browser` writes its screenshots to the OS temp directory; `DEMO_UPDATE_SCREENSHOTS=1` refreshes the tracked `screenshots/` instead. Both checks also run with `DEMO_CLICKHOUSE=1`. See [The Faceting Demo](#/page/examples/Faceting_Demo).

## Writing a Test with the Harness

`test/support/Facet-Test-Harness.js` boots a real retold-data-service on a seeded fixture, installs the faceting service, and gives you the oracles as methods. A test file looks like this:

```javascript
const libChai = require('chai');
const Expect = libChai.expect;

const libHarness = require('./support/Facet-Test-Harness.js');

// Claim a free registry port in docs/internal-contracts.md §14.4 (the server binds an ephemeral one).
const PORT = 19150;

suite
(
	'Project status facets',
	() =>
	{
		let _Harness = null;
		let tmpBody = { Facets: [ { Key: 'Status', Facet: 'Project.Status' } ], Total: true };

		suiteSetup((fDone) => { _Harness = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack' }, fDone); });
		suiteTeardown((fDone) => { _Harness.stop(fDone); });

		test('Live equals the Reference oracle (O1)',
			(fDone) =>
			{
				_Harness.compare('Project', tmpBody, _Harness.as('Lead'),
					(pError, pResult) =>
					{
						Expect(pError).to.not.exist;
						Expect(pResult.Live.Status).to.equal(200);
						Expect(pResult.LiveNormalized).to.deep.equal(pResult.ReferenceNormalized);
						return fDone();
					});
			});

		test('every bucket clause counts the same through the real list (O2)',
			(fDone) =>
			{
				_Harness.facetQuery('Project', tmpBody, _Harness.as('Lead'),
					(pError, pResponse) =>
					{
						Expect(pError).to.not.exist;
						return _Harness.assertSelectionRoundTrip('Project', tmpBody, pResponse.Body, _Harness.as('Lead'), fDone);
					});
			});

		test('the other tenant sees only its own projects',
			(fDone) =>
			{
				_Harness.facetQuery('Project', tmpBody, _Harness.as('OtherLead'),
					(pError, pResponse) =>
					{
						Expect(pError).to.not.exist;
						Expect(pResponse.Body.Total).to.equal(_Harness.seed.TenantLiveCounts[2].Project);
						return fDone();
					});
			});
	}
);
```

This suite passes against the ProjectTrack fixture.

### Harness Options

| Option | Meaning |
|---|---|
| `Port` | required: the file's registry port (the server binds an ephemeral port unless `FixedPort: true`) |
| `Fixture` | `'Bookstore'` (default), `'Bookstore-Tenant'`, `'ProjectTrack'` or `'LabTrack'` |
| `Provider` | `'SQLite'` (default, in memory) or `'PostgreSQL'` (gated; an unavailable provider calls back an error with `.Skip === true`) |
| `Seed`, `Scale` | the generator seed, and `'Small'` (default) or `'Medium'` (four times the rows) |
| `Faceting` | `RetoldFaceting` options merged over the fixture's own |
| `Definitions` | `'Auto'` (the fixture's definitions file), `false`, or an array of file paths and definitions objects |
| `TenancyBehavior` | `'Auto'` (installed for the tenant fixtures), `true`, `false`, or your own behavior function |
| `Store`, `StoreOptions` | `'ClickHouse'` materializes the fixture into a fresh store database (gated) |
| `MeadowEndpoints` | `'Installed'` (default) or `'Monorepo'` (the monorepo's meadow-endpoints checkout) |
| `Host`, `BeforeListen` | a bind address, and a function run after the test session shim and before the server listens (the demo installs its loopback guard there) |

The harness's test-only "authentication" is a `pre()` handler that turns the `x-facet-test-tenant` and `x-facet-test-user` headers into a session. Every helper takes `{ Tenant, User }` (or `_Harness.as('<Principal>')`); no tenant and no user means the anonymous session.

### Harness Members

| Member | What it does |
|---|---|
| `facetQuery(Entity, Body, Options, cb)` | `POST /1.0/Facet/:Entity/Query` over HTTP → `{ Status, Headers, Body }` |
| `query(Entity, Body, Options, cb)` | the same in process (`Options.Now` pins the request clock) |
| `reference(Entity, Body, Options, cb)` | the Reference engine's envelope for the same principal |
| `compare(Entity, Body, Options, cb)` | O1 in one call: `{ Live, Reference, LiveNormalized, ReferenceNormalized }` |
| `assertSelectionRoundTrip(Entity, Body, Envelope, Options, cb)` | O2 over every selectable bucket; a mismatch calls back an error with a `.Report` |
| `listCount(Entity, FilterString, Options, cb)`, `listRows(…)` | the real list route's count and rows |
| `request(Method, Path, Body, Options, cb)` | any HTTP request as a principal (CRUD writes, Describe, the change feed) |
| `installBehavior(Entity, Hash, fBehavior)` | adds a behavior after any existing one (meadow-endpoints behaviors are single-slot) |
| `storeQuery`, `compareStore`, `quiesce` | with `Store`: a store-preferred query, O3 in one call, and waiting until the mirror has applied every change |
| `seed`, `principals`, `traps`, `db` | the generated counts (`LiveCounts`, `TenantLiveCounts`), the named principals, the trap values, and the SQLite database |
| `stop(cb)` | closes the server and the database (and drops a store database); idempotent |

## The Docs Check

`test/Facet-Docs_tests.js` checks the JSON examples in these pages. A definitions file or a request body that carries a `docs-check` comment is loaded or sent through the harness, and must load with no disabled entry or answer without errors. It runs inside plain `npm test`.

## Related

- [Caching and Invalidation](#/page/Caching_And_Invalidation): what O7 checks
- [The ClickHouse Store](#/page/ClickHouse_Store): what O3 and O10 check
- [Security and Tenancy](#/page/Security_And_Tenancy): the isolation the fixtures' traps test
- [Internals](#/page/Internals): the contracts the suites are written against
