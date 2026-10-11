# JavaScript API

Everything the HTTP routes do, a host can do in process: query facets, read records, counts and keys, report writes, and inspect or maintain the service. This page lists the module's exports and the methods of the running service.

## Module Exports

`require('retold-faceting-service')` returns the service class, with these attached:

| Export | What it is |
|---|---|
| (the module itself) | `RetoldFacetingService`, a `fable-serviceproviderbase` service class. `serviceType` is `'RetoldFacetingService'`. |
| `installOnRetoldDataService(pRetoldDataService, pOptions, fCallback)` | Install and attach the service on a retold-data-service. The usual entry point. |
| `foundationHookInstaller`, `foundationRouteInstaller` | Boot steps for a `retold-application-foundation-server` app; see [Hosting](#/page/Hosting). |
| `Options` | The options module: `DEFAULTS`, `STORE_DEFAULTS`, `LIMITS_NOT_ENFORCED`, `ROUTE_RESERVED_NAMES`, `NEVER_FACETABLE`, and the helpers `resolve(pOptions)`, `deepMerge(pBase, pOverride)` and `hasScopePolicy(pResolvedOptions)`. |
| `TOTAL_KEY` | `'#Total'`, the key of the `Total` in `Errors`. |
| `CACHE_STATUSES` | The result-cache statuses: `Off`, `Bypass`, `Miss`, `Hit`, `Stale`, `NotModified`, `Refresh`. |
| `SUB_SERVICES` | The `[ serviceType, class ]` pairs the service registers on fable. |
| `SHUTDOWN_MARKER` | The symbol set on a server whose `close()` the service wrapped. |

```javascript
const libRetoldFacetingService = require('retold-faceting-service');
```

## installOnRetoldDataService

```javascript
libRetoldFacetingService.installOnRetoldDataService(pRetoldDataService, pOptions, fCallback)
```

Call it inside the retold-data-service `initializeService` callback, once the model is loaded. It registers `RetoldFacetingService` on the data service's fable (or uses an instance the app already registered), then attaches it: binds the host, builds the catalog, loads the definitions, installs change capture, registers any store, and mounts the routes. `fCallback(pError, pService)` gets the attached service.

| Parameter | Meaning |
|---|---|
| `pRetoldDataService` | The initialized `fable.RetoldDataService`. |
| `pOptions` | `RetoldFaceting` options, partial. When not an object, `fable.settings.RetoldFaceting` is used. See [Configuration](#/page/Configuration). |
| `fCallback` | `(pError, pService)`. |

It calls back with an error, and mounts nothing, when the data service is missing or has no Orator service server, when `Role` is not `'Embedded'`, when a faceting service is already attached on that fable, or when the model has an entity named like a facet route. [Getting Started](#/page/Getting_Started) shows it in a complete server, and [Hosting](#/page/Hosting) describes what attaching does.

## The Running Service

After install, the service is `fable.RetoldFacetingService` (also the `pService` of the callback). Its sub-services are on fable too, under their own service types, for example `fable.RetoldFacetingDefinitionRegistry`.

### The Request Argument

The query methods take the request they act for, so they can resolve its principal exactly as the facet routes do. Pass the restify request you are handling. Outside a request, build one with the session the host's list routes would see:

```javascript
let tmpRequest =
	{
		params: {},
		headers: {},
		query: {},
		UserSession: { LoggedIn: true, UserID: 5, IDUser: 5, IDTenant: 1, CustomerID: 1 }
	};
```

On a [retold-data-service](#/doc/meadow/retold-data-service) host the principal comes from [meadow-endpoints](#/doc/meadow/meadow-endpoints)' session handling, the same the list routes use. With its default session source (`MeadowEndpointsSessionDataSource: 'Request'`) that is `pRequest.UserSession` merged over `MeadowEndpointsDefaultSessionObject`, so a synthetic request's `UserSession` must carry the fields your host's sessions carry. Without one, the principal is anonymous: on a host with a scope policy, that is `401 FACET_UNAUTHENTICATED`.

### `query`

```javascript
tmpService.query(pEntity, pBody, pRequest, fCallback)   // fCallback(pError, pEnvelope, pMeta)
```

Runs a Query exactly as `POST <RoutePrefix>/<Entity>/Query` would, with the same body ([The Request Body](#/page/api/Request)) and the same envelope ([The Response Envelope](#/page/api/Envelope)). `pError` is a facet error (`Code`, `Status`, `Detail`, and `FacetError: true`) for a whole-request failure. Per-facet failures are in `pEnvelope.Errors`.

```javascript
tmpService.query('Book', { Facets: [ { Key: 'Lang', Facet: 'Book.Language', Top: 2 } ], Total: true }, tmpRequest,
	(pError, pEnvelope, pMeta) =>
	{
		if (pError)
		{
			return fNext(pError);
		}
		// pEnvelope.Total, pEnvelope.Facets.Lang.Buckets …
		return fNext();
	});
```

On the Bookstore-Tenant fixture with the request above, `pEnvelope.Total` was `1436` and the two buckets `eng` (862) and `en-US` (271).

`pMeta` is for in-process callers only (it is never sent over HTTP). Captured for that query:

```json
{
	"Version": "fv1:47b8b4a280e0eecc",
	"Engine": "Live",
	"ScopeRepaired": false,
	"Statements": 1,
	"Labels": 0,
	"Relations": 1,
	"BehaviorRuns": 1,
	"Variants": 1,
	"Cubes": 1,
	"CubeFallbacks": [],
	"Staged": { "Relations": 0, "Keys": 0 },
	"BindHash": "b:4f53cda18c2baa0c",
	"RecordsDropped": 0,
	"Cache": { "Status": "Off", "Reason": null, "Key": null, "GenVector": null, "LagMS": 0, "Coalesced": false },
	"Seq": "e:1abb78ee:0",
	"Freshness": { "Mode": "Exact", "Requested": "Exact", "Upgrade": null },
	"ProbeRuns": 0
}
```

| Field | Meaning |
|---|---|
| `Version`, `Engine` | As in the envelope. |
| `Statements` | Every SQL statement the request ran (facets, label reads, record reads, store reads). `Labels` counts the label reads among them. |
| `Relations`, `BehaviorRuns` | Scoped relations built, and list-behavior runs made to capture scopes. |
| `Variants`, `Cubes`, `CubeFallbacks`, `Staged` | How the plan was shaped (see [Architecture](#/page/Faceting_Architecture)). |
| `BindHash` | A hash of every `$` value the request bound. |
| `ScopeRepaired`, `RecordsDropped` | As the headers of the same names. |
| `Cache`, `Seq`, `Freshness`, `ProbeRuns` | The result cache's decision, the change sequence the answer covers, the effective freshness mode, and the scope probes the cache ran. |
| `NotModified` | `true` on a 304: the request's `If-None-Match` matched, nothing ran, and `pEnvelope` is `null`. |
| `Store` | With a store configured: the full routing decisions, with reasons. |

### `queryInternal`

```javascript
tmpService.queryInternal(pEntity, pBody, pRequest, pInternalOptions, fCallback)   // fCallback(pError, pEnvelope, pMeta)
```

The pipeline behind `query` (which calls it with `{}`), with options no client can reach. Use it to debug and compare, never to serve a request:

| Option | Meaning |
|---|---|
| `ForceEngine: 'Reference'` | Answer with the Reference oracle: a pure-JavaScript fold over the rows each entity's own list route returns. It reads every row of every entity the request touches, so use it on development data only. Never cached. |
| `PlanForm: { Cube, Staged }` | Override `Execution.Cube` and `Execution.Staged` for this request: `'Auto'`, `'Always'` or `'Never'`. `{ Cube: 'Never' }` gives every facet its own statement. |
| `Now` | Pin the request clock (`$Now`, `$Today`) to a date string or epoch milliseconds. |

On the Bookstore, the Getting Started credit-card body answered `Total` 1288 on all three: Live with 1 statement and 1 cube, Reference with the same buckets, and `{ PlanForm: { Cube: 'Never' } }` with 3 statements and 0 cubes. [Troubleshooting](#/page/Troubleshooting) shows how to compare the envelopes.

### `records`, `count` and `keys`

```javascript
tmpService.records(pEntity, pBody, pRequest, fCallback)   // fCallback(pError, pRecords, pMeta)
tmpService.count(pEntity, pBody, pRequest, fCallback)     // fCallback(pError, { Count }, pMeta)
tmpService.keys(pEntity, pBody, pRequest, fCallback)      // fCallback(pError, { Entity, Keys, Count, Truncated, Version }, pMeta)
```

The same answers as the `Records`, `Records/Count` and `Keys` routes ([Records, Count and Keys](#/page/api/Records_And_Keys)). `pMeta` carries `Version`, `Statements`, `ScopeRepaired` and `Seq`; for `records` also `Dropped` and `Keys`. Captured on the Bookstore-Tenant fixture with a `Language: eng` clause:

```text
count  → { "Count": 862 }
keys   → { "Entity": "Book", "Keys": [ 2, 3, 5 ], "Count": 862, "Truncated": true, "Version": "fv1:e8240f1c53ca9b52" }   (Cap 3)
```

`keys` is the call for bulk actions: run it with the acting user's request, and work on the keys it returns rather than on keys a client sent.

### `withPathScope`

```javascript
let tmpBody = tmpService.withPathScope('Project.MyProjects', pBody);
```

Returns the body the `/Scope/:Scope/` routes use: the scope prepended to `Scopes`, with the parameters that scope declares taken from the top-level `Params`. Pass the result to `query`, `records` or `count`.

### `describe` and `describeRequest`

```javascript
tmpService.describeRequest(pEntity, pRequest, fCallback)  // fCallback(pError, pDescribe); pEntity null for every entity
let tmpDescribe = tmpService.describe(pEntity, pPrincipal)  // synchronous; throws FACET_UNKNOWN_ENTITY
```

`describeRequest` resolves the principal from the request and checks the entity, as `GET <RoutePrefix>/Describe` does. `describe` takes an already resolved principal; prefer `describeRequest`. See [Describe](#/page/api/Describe).

### `notify`, `notifyChanged` and `notifyByFilter`

```javascript
let tmpSeq = tmpService.notify(pEntity, pChange);                         // the change's Seq, or null when refused
let tmpSeq2 = tmpService.notifyChanged(pEntity, pChange);                 // the same as notify
let tmpSeq3 = tmpService.notifyByFilter(pEntity, pFilter, pOptions);      // "anything matching this filter changed"
```

Writes that go through an entity's stock CRUD routes are seen automatically. A write the service cannot see (a direct DAL call, raw SQL, an importer) must be reported, after its transaction commits, or cached answers and change-feed clients will not learn about it. `pChange`:

| Key | Meaning |
|---|---|
| `Operation` | `Create`, `Update` (default), `Delete`, `Undelete`, `Touch` or `EntityDirty`. |
| `IDs` | The changed primary keys. |
| `Records`, `Before` | Row images after and before the write; IDs, tenants and owners are read from them. |
| `Tenants` | The tenant values the change touched. Without `Tenants` or row images, every tenant is invalidated. |
| `Owners` | `[ { Tenant, Owner } ]` for personally scoped entities. |
| `ChangedColumns` | The columns an update changed; absent means "any column". |
| `Principal` or `PrincipalKey` | The writer, for read-your-writes. |

`notifyByFilter(pEntity, pFilter, pOptions)` reports that rows matching a pre-write filter changed: `pFilter` is a meadow-filter string or an array of FoxHound filter entries, and `pOptions` takes `Tenants`, `Owners` and `Principal` / `PrincipalKey`. These methods never throw: an invalid call (an unknown entity, a bad field) logs a warning and returns `null`.

```javascript
// after an importer committed new reviews for tenant 7
tmpService.notify('Review', { Operation: 'Create', IDs: tmpNewIDs, Tenants: [ 7 ] });
```

[Caching and Invalidation](#/page/Caching_And_Invalidation) explains when you need these.

### `status`

```javascript
let tmpStatus = tmpService.status();
```

Counters for monitoring, never tenant data: `Role`, `Attached`, `ModelVersion`, `Engines` (`Live`, `ClickHouse` availability), `Cache` (enabled flag, entries, bytes, hits, misses, …), `Generations`, `Changes` (the change source and event counts), `SSE` (connections, events sent, refusals), `ReadYourWrites`, `Stores`, `Freshness` and `StoreClickHouse`. An abridged capture:

```json
{
	"Role": "Embedded",
	"Attached": true,
	"ModelVersion": "m:f6b3eefe4281",
	"Engines": { "Live": { "Available": true }, "ClickHouse": { "Configured": false, "Available": false, "Reason": null } },
	"Changes": { "Source": "Interim", "Entities": 13, "Events": 2, "BySource": { "Notify": 2 }, "ByOperation": { "Update": 1, "EntityDirty": 1 }, "Invalid": 1, "LastSeq": "e:1abb78ee:2" },
	"SSE": { "Connections": 0, "Enabled": true, "Opened": 0, "Sent": 0 }
}
```

(The `Cache`, `Generations`, `ReadYourWrites`, `Stores`, `Freshness` and `StoreClickHouse` sections, and most counters of `Changes` and `SSE`, are cut.) The `RetoldFacetingDefinitionRegistry` has its own `status()`, `disabled()` and `warnings()`; see [Definitions Files](#/page/Definitions).

### `storeAdmin`

```javascript
tmpService.storeAdmin(pAction, pStore, pEntity, pOptions, fCallback)   // fCallback(pError, pResult)
```

Starts store maintenance for one mirrored entity, as the admin routes do but without a route or an authorization check: the host decides who may call it. `pAction` is `Rebuild`, `Sweep`, `Bisect`, `Scrub` or `Verify`; `pStore` is `'ClickHouse'`; `pOptions.Full: false` makes a `Scrub` partial. Refusals are the admin routes' errors (`404` unknown store or entity, `429` already running or in cooldown, `503` store unavailable). Without a store configured:

```text
storeAdmin('Rebuild', 'ClickHouse', 'Book', {}, …) → FACET_UNKNOWN_ENTITY (404) "Unknown store."
```

[The ClickHouse Store](#/page/ClickHouse_Store) explains the actions.

### `shutdown`

```javascript
tmpService.shutdown(fCallback)
```

Stops the materializer (draining for up to `Materializer.DrainOnStopMS`), ends open change streams with `closed { Reason: 'Shutdown' }`, clears the change-intake timers and the cache's bookkeeping, and closes the ClickHouse client. Idempotent; never throws. You rarely call it: the service wraps the Orator server's `close()`, so `fable.Orator.stopWebServer()` runs it first.

### Lifecycle Methods

| Method | Meaning |
|---|---|
| `attach({ RetoldDataService }, fCallback)` | What `installOnRetoldDataService` calls. Idempotent. |
| `connectRoutes(pServiceServer)` | Mount the facet routes on a service server you built yourself. `attach` already does this. Idempotent. |
| `rebuildCatalog(pModel, pReload)` | Rebuild the graph and catalog from a model and reload the definitions. Called by `attach` and on every host model reload; returns the definitions load result. |
| `installStores(fCallback)` | Register the configured stores. Called by `attach` and after a model reload. Idempotent. |
| `cacheEnabled()` | `Cache.Enabled`. |
| `currentSeq()` | The current change sequence, or `null` without a change source. |

## Browser-Safe Contract Modules

The files in `source/contract/` require nothing outside that folder, so a client bundle can use them to build and check requests and read envelopes the same way the server does:

| Module | Use |
|---|---|
| `Facet-Contract-Request.js` | `normalizeRequest`, `parseFacetID`, the constants (`FOLDS`, `INTERVALS`, `ORDERS`, `LIMIT_DEFAULTS`, …). |
| `Facet-Contract-Envelope.js` | `normalizeForComparison`, the envelope builders. |
| `Facet-Contract-Clauses.js` | The bucket clause builders and the clause signature used to match clauses to facets. |
| `Facet-Contract-Buckets.js` | Date and numeric bucket arithmetic and labels. |
| `Facet-Contract-Errors.js` | `CODES` and the error helpers. |

> **Planned.** A `pict-section-facet` view package will use these modules to render facet panels in pict applications.

## Related

- [API Reference](#/page/API_Reference)
- [Hosting](#/page/Hosting)
- [Caching and Invalidation](#/page/Caching_And_Invalidation)
- [fable](#/doc/fable/fable) (service providers)
