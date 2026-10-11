# Internals

This page is for contributors: where the binding contracts live, how they are organized, the conventions every source file follows, how the service grew milestone by milestone, and where to start reading the code. Users of the service do not need any of it.

## The Internal Contracts

[Internal Contracts](#/page/internal-contracts) (`docs/internal-contracts.md`) is the binding interface specification between the package's internal services: every shape, method signature, field name, error code and option the services exchange. Code is written against it. To change a contract, change that file **first**, with a line in the relevant "Ambiguities resolved" section, and only then the code.

The file is organized in parts, one per milestone:

| Part | Sections | Covers |
|---|---|---|
| I | §0–§18 | the core: conventions, module map, the request pipeline and context, the normalized request, the filter AST, the fold IR, disjunctive variants, Scoped Relations, ScopeCapture and ScopeGuard, engines and the router, the envelope and its canonical math, the catalog, the host, error codes, the test harness |
| II | §19–§37 | cross-entity folds, the definitions registry, path grammar, bound values, clause compilation, lowering, the conditional disjunctive scan, per-hop scope (TenantOnly, Staged), Records / Count / Keys, PostgreSQL, the ProjectTrack and LabTrack fixtures |
| III | §38–§52 | change capture, the `ChangeEvent` and the `Seq` clock, generations, the cache key and scope probes, the result cache, freshness, read-your-writes, the SSE change feed, the demo's live changes |
| IV | §53–§70 | the ClickHouse store: the store contract, MirrorSpec and the closure rule, layout and type map, the client, the materializer, backfill and rebuild, reconcile, freshness and the breaker, routing, the ClickHouse fold compiler and engine |
| V | §71–§83 | the host adapter for `retold-application-foundation-server`: the two foundation installers, option precedence, coverage classes, the fence-compatible capture, sessions and entitlements, raw writers, the RAFS test harness, and the review fixes |

**Precedence.** A later part wins over an earlier one where they conflict, and each part opens with a table listing every earlier rule it changes (§19.2, §38.2, §53.2, §71.2). Each part also ends with "Ambiguities resolved / deviations from the design", where every decision that differs from the original design is recorded with its reason, the as-built notes and the review fixes, and with the seams left for the next milestone.

Section references in code comments look like `internal-contracts §26.3`. References to the design set look like `03 §3.2` (file `03-on-the-fly-engines.md`, section 3.2).

## Conventions Every File Follows

The full table is §0 of the contracts. In short:

- **Style.** Plain JavaScript, tabs, Allman braces everywhere, `pParameter`, `tmpLocal`, `libRequire`, `CONSTANT`.
- **Services.** Every class extends `fable-serviceproviderbase`, sets `this.serviceType`, and is registered by `RetoldFacetingService.registerServices()` from the ordered `SUB_SERVICES` list. Services find each other only as `this.fable.<serviceType>` or through the request context, never by requiring and constructing a sibling.
- **Options.** Every constructor receives the resolved `RetoldFaceting` options through `Retold-Faceting-Service-Options.js` `resolve()`, which is idempotent, so `new X(fable)` works. Services read `this.options`, never `fable.settings`.
- **Async.** Node-style callbacks `fCallback(pError, pResult)`; anything that may touch the database, a behavior or the host is async. Pure transforms are synchronous and throw facet errors.
- **Errors.** Every client-visible error is built with `Facet-Contract-Errors.js` `create(pCode, pMessage, pDetail)`. Anything else that escapes becomes `FACET_INTERNAL`, logged, never echoed.
- **SQL.** No identifier ever comes from the client; every column and table name comes from the catalog and is quoted by the dialect layer, and every value is bound. Entities are composed only as Scoped Relations spliced in by parameter, never with `addJoin`.
- **Determinism.** Nothing an engine compares depends on `Math.random` or the wall clock; the request clock is pinned once per request.
- **Logging.** Never log bound values, session contents or credentials.
- **Pure modules.** `source/contract/*` and the `Shell-Templates-<Dialect>.js` files require nothing outside their own folder, so browser code can deep-require them. The smoke test enforces this.
- **Client keys.** Maps keyed by client data are `Map`, `Set` or `Object.create(null)`; keys with control characters or `Object.prototype` names are refused.
- **Restify.** Route handlers never return a promise and call `fNext` exactly once; the facet routes read their own JSON body.

## The Original Design

The service was designed in a set of eleven documents, plus a review log. They are kept with the project's design records and are not published with these docs. The contracts cite them by number:

| Document | Title |
|---|---|
| `00` | Overview, Glossary and Decision Log |
| `01` | Fold Algebra, DSL, Catalog and Graph |
| `02` | API |
| `03` | On-the-fly Engines |
| `04` | Persistence (How Persistence Works) |
| `05` | Change Capture and Invalidation |
| `06` | Security and Tenancy |
| `07` | Deployment Topologies |
| `08` | Worked Examples |
| `09` | Sequence Flows |
| `10` | Modules, Upstream Changes and Roadmap |

The design describes more than is built (other roles, other stores, upstream changes to meadow and meadow-endpoints). Where the built service differs, the contracts win, and the "Ambiguities resolved" sections say why.

## Milestones

| Milestone | What it added | Contract |
|---|---|---|
| M1 | The core: `POST /1.0/Facet/:Entity/Query` and Describe; auto-derived single-entity folds (Terms, DateHistogram, NumericHistogram, Ranges, Stats, DistinctCount, Missing, 2-D Pivot); pict clauses and meadow-filter strings; disjunctive faceting; the Live and Reference engines; Scoped Relations and the ScopeGuard; execution on SQLite, with the other dialects' SQL pinned as goldens | Part I |
| M2 | Cross-entity folds (K8–K20, with K13, K15 and K16 refused as unsupported); definitions files, named scopes, aliases and `$` bindings; per-hop scope, `TenantOnly` and staged hops; the conditional disjunctive scan; Records, Count and Keys; PostgreSQL execution | Part II |
| M3 | The faceting demo, `example_applications/faceting_demo` | its `DEMO-SPEC.md` |
| M4 | Change capture, generations, the result cache, freshness modes, read-your-writes and the SSE change feed | Part III |
| M5 | The ClickHouse store: mirror specs, the materializer, backfill and rebuild, reconcile, freshness admission, the ClickHouse fold compiler and engine, per-facet routing | Part IV |
| Host | The `retold-application-foundation-server` host adapter: `foundationHookInstaller` and `foundationRouteInstaller`, tested on a real RAFS app in two tenants | Part V |

Each milestone ended with a review round. Its findings and fixes are recorded in the contracts (for example §51.46–§51.70 for M4 and §68 items 61–93 for M5), and each has a regression test (`test/Facet-Review-M2_tests.js`, `test/Facet-Invalidation-Review_tests.js`, `test/Facet-M5-Review_tests.js`).

## Where to Start Reading the Code

1. **`source/Retold-Faceting-Service.js`.** `attach()` wires everything; `queryInternal()` runs the request as a waterfall of `stage*` methods (principal, shape, freshness, gate, bind, filter, plan, cache, execute, records, post, store). The Records, Count and Keys entry points share the stages up to the filter.
2. **`source/contract/`.** The pure modules shared with clients: request normalization and limits, the envelope and bucket math, bucket clauses, error codes.
3. **`source/request/`** (normalizer, filter validator, clause compiler, filter AST, disjunctive planner) and **`source/plan/`** (binder, planner, fold IR, lowering): from a request body to engine-ready aggregates.
4. **`source/engine/live/`.** Scoped Relations, the statement composer, the cube executor, staged keys and the per-dialect shell templates. **`source/engine/Retold-Faceting-EngineReference.js`** is the test oracle.
5. **`source/security/`.** The principal resolver, the authorizer, scope capture, the ScopeGuard and the cache key.
6. **`source/change/`** and **`source/cache/`.** The change intake and its adapters, read-your-writes, generations and the result cache.
7. **`source/persistence/`** and **`source/store/`.** The mirror spec, the materializer and its per-entity pieces, the rebuilder, the reconciler, freshness, and the ClickHouse client, DDL, type map, store and fold compiler.
8. **`source/catalog/`**, **`source/host/`**, **`source/routes/`.** The catalog, graph and definitions registry; the host adapters; the HTTP routes and the change feed.

[Architecture](#/page/Faceting_Architecture) has the request lifecycle and component map diagrams that go with this list.

## Tests and Ports

Every test file that opens a server names a port from the registry in §14.4 of the contracts (19100–19199), and binds an ephemeral port by default, so the registry only names a run. A new file claims a free port by adding a row there. The smoke scripts in `debug/` bind their registry ports for real. See [Testing](#/page/Testing).

## Upstream Seams

The design proposes changes to other Retold modules. The service works without them today and has a seam where each would plug in:

> **Planned.** A meadow change bus that sees every DAL write (the change intake already has a bus adapter that takes over when `fable.MeadowChangeBus` exists).

> **Planned.** Ordered, multi-subscriber behaviors in meadow-endpoints (`addBehavior`); the intake uses them when present.

> **Planned.** A change context on write requests, so a write response can carry its `Seq` for read-your-writes.

> **Planned.** `pict-section-facet`, the client package (a facet provider and recordset filter views).

## Related

- [Internal Contracts](#/page/internal-contracts): the contributors' specification (not user documentation)
- [Architecture](#/page/Faceting_Architecture)
- [Testing](#/page/Testing)
- [Hosting](#/page/Hosting)
