# Configuration

Every option of the faceting service lives under one key, `RetoldFaceting`. You can leave all of it out: the defaults run Live facets on a plain [retold-data-service](#/doc/meadow/retold-data-service), with no cache, no change feed and no store. This page lists every option, its default, and what it does.

Options marked **Reserved** are accepted so that configuration written for later releases does not fail, but this version does not read them. Setting one changes nothing.

## How Options Resolve

`installOnRetoldDataService(pRetoldDataService, pOptions, fCallback)` takes its options from the first of these that is an object:

1. the `pOptions` argument;
2. `fable.settings.RetoldFaceting`;
3. nothing (every default).

The two sources are never merged with each other. The chosen object is then deep-merged over the defaults: plain objects merge key by key, while arrays and scalar values replace the default. A partial object is fine.

In the fable settings (for example the app's configuration JSON):

```json
{
	"RetoldFaceting":
	{
		"Definitions": { "Path": "./facets/" },
		"Limits": { "MaxFacets": 30 },
		"Cache": { "Enabled": true }
	}
}
```

Or explicitly, inside the retold-data-service `initializeService` callback:

```javascript
libRetoldFacetingService.installOnRetoldDataService(_Fable.RetoldDataService,
	{
		Scope: { Policy: { Column: 'IDCustomer', SessionField: 'CustomerID' } },
		Time: { StorageTimeZone: 'UTC' }
	},
	fInstalled);
```

The defaults are exported as `require('retold-faceting-service').Options.DEFAULTS`. Options are read when the service attaches; changing them on a running service is not supported, except where this page says otherwise.

## Top Level

| Option | Type | Default | Meaning |
|---|---|---|---|
| `Role` | string | `'Embedded'` | How the service runs. Only `'Embedded'` (inside the host process) exists today; the installer refuses anything else. |
| `InstanceID` | string | `'main'` | Names this deployment. Part of every result-cache key, and the default ClickHouse database name (`rfs_<InstanceID>`). |
| `RoutePrefix` | string | `'/1.0/Facet'` | Where the facet routes mount. See [Routes](#/page/api/Routes). |
| `Host` | string | `'Auto'` | `'Auto'`, `'DataService'` or `'ApplicationServer'`: the host kind the service may attach to. Attaching to another kind fails. |

> **Planned.** Other roles (a standalone faceting server, an agent next to a remote host, an edge gateway) are designed but not built.

## Catalog

The catalog derives the auto facets from the [Stricture](#/doc/meadow/stricture) model and is the whitelist of every column name that may reach SQL.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `Catalog.AutoDerive` | boolean | `true` | `false` creates no auto facets (columns stay filterable; `Include` still opts columns in). |
| `Catalog.MaxTermsStringSize` | number | `128` | A `String` column longer than this gets no Terms facet. A column without a `Size` counts as 64. |
| `Catalog.AutoFKTermsMaxTargetRows` | number | `10000` | The row count under which an entity is "small" in the catalog's size classes. Size classes are measured only on demand and do not change which facets exist. |
| `Catalog.HubEntities` | array | `[ 'User', 'Customer', 'DataSource' ]` | Entities treated as hubs (those present in the model). An automatic one-hop path facet never targets a hub. |
| `Catalog.ListOneHop` | boolean | `false` | `true` lists the automatic one-hop path facets (`Review.IDBook>Book.Language`) in Describe. They can be requested either way. |
| `Catalog.Sensitive` | `'Default'` or array | `'Default'` | The built-in name denylist, plus any `'Entity.Column'` or `'Column'` entries you add. Sensitive columns are neither facetable nor filterable. |
| `Catalog.GlobalEntities` | array | `[]` | With a scope policy, entities that have no scope column but may still be faceted (shared lookup tables). |
| `Catalog.NeverFacet` | array | `[]` | Entities that are never facetable. |
| `Catalog.AllowAnonymous` | array | (not set) | With a scope policy, entities an anonymous principal may facet. Without it, anonymous requests get `401`. |
| `Catalog.Include` | array | (not set) | `'Entity.Column'` entries to facet even when the rules below would not (audit-user and policy columns, foreign keys without a join target, long strings). |
| `Catalog.Exclude` | array | (not set) | `'Entity.Column'` entries never to facet (they stay filterable). |
| `Catalog.Controllerless` | object | `{}` | Declarations for entities without a route-bound controller. Not supported yet: the host logs a warning and those entities stay unfacetable. |
| `Catalog.OverridesFile` | any | `false` | **Reserved** (accepted, not read by this version). |
| `Catalog.<Entity>` | object | (not set) | Per-entity overrides, below. |

### Per-Entity Overrides

Any other key of `Catalog` is an entity name and holds that entity's overrides:

| Key | Type | Meaning |
|---|---|---|
| `Include`, `Exclude` | array of column names | As the global lists, for this entity. |
| `DisplayName` | string | The entity's display name in Describe. |
| `DisplayNames` | object | Column → display name of its auto facet. |
| `Intervals` | object | DateTime column → the intervals its auto facet accepts (a subset of `day`, `week`, `month`, `quarter`, `year`). Any other interval is a per-facet `FACET_REQUEST_INVALID` with `Reason: 'IntervalNotOffered'`. |
| `Cardinality` | object | Column → a hint string echoed in Describe. |
| `Sensitive` | array | More Sensitive columns of this entity. |
| `IncludeSensitive` | array or object | Columns to exempt from the Sensitive denylist. |
| `LabelColumn` | string | The column that labels foreign keys pointing at this entity. |

```javascript
Catalog:
	{
		Exclude: [ 'Book.ISBN' ],
		Book: { DisplayNames: { PublicationYear: 'Year published' }, Intervals: { CreateDate: [ 'month', 'year' ] } },
		Author: { LabelColumn: 'Name' }
	}
```

A `Catalog` section inside a definitions file is ignored; catalog overrides belong here.

### Which Columns Get Auto Facets

| Column | Folds offered (the first is the default) |
|---|---|
| Primary key, GUID, `Text`, `JSON` | none (still filterable) |
| Delete column, `DeleteDate`, audit user columns, scope-policy columns | none unless `Include`d |
| A foreign key (a `Join` in the model) | `Terms`, `Missing`, `DistinctCount`; buckets are labelled from the target's `Name`, `Title` or `FullName` column |
| `Boolean` | `Terms`, `Missing` |
| `DateTime` | `DateHistogram`, `Stats`, `Missing` |
| `Numeric` (integers) | `NumericHistogram`, `Terms`, `Ranges`, `Stats`, `DistinctCount`, `Missing` |
| `Decimal` | `NumericHistogram`, `Ranges`, `Stats`, `Missing` |
| `String` no longer than `MaxTermsStringSize` and not uniquely indexed | `Terms`, `Missing`, `DistinctCount` |
| A name matching the Sensitive denylist (`Password`, `Hash`, `Secret`, `Token`, `Salt`, `ApiKey`, names ending in `Key` or `Code`, `Email`, `Phone`) | none, and not filterable |

The entities `Account`, `ApiKey`, `LoginChallenge` and `RetoldFacetChangeLog` are never facetable. An entity named like a facet route segment (`Facet`, `Describe`, `Agent`, `Admin`, `Changes`, `Status`) stops the service from mounting at all.

## Definitions

| Option | Type | Default | Meaning |
|---|---|---|---|
| `Definitions.Path` | string or `false` | `'facets/'` | Directory of definitions files (`*.json`, not recursive). |
| `Definitions.Files` | array | `[]` | More files, absolute or relative to `Path`. |
| `Definitions.Objects` | array | `[]` | Parsed definitions objects. |
| `Definitions.AllowAdHoc` | boolean | `false` | **Reserved** (accepted, not read by this version). Inline request definitions are always refused. |

[Definitions Files](#/page/Definitions) covers loading, the file format and validation.

## Scope

How the service reproduces each entity's list scoping. [Security and Tenancy](#/page/Security_And_Tenancy) explains the model behind these options.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `Scope.Behavior` | string | `'Reads-QueryConfiguration'` | The list behavior whose filters every scoped relation replays. |
| `Scope.BehaviorOverrides` | object | `{}` | Entity → another behavior hash to replay for that entity. |
| `Scope.Guard` | string | `'Strict'` | With a scope policy: `'Strict'` refuses an answer whose captured scope lacks a required policy filter (`500 FACET_SCOPE_POLICY_VIOLATION`); `'Repair'` adds the missing filter and sets the `X-Retold-Facet-Scope-Repaired` header. With a scope policy, only `'Strict'` or `'Repair'` is accepted; any other value (including `'Off'`) makes install fail. On a retold-application-foundation-server app with tenancy only `'Strict'` is accepted. Without a policy the guard does not run. |
| `Scope.Policy` | `'Auto'` or object | `'Auto'` | The tenancy policy. `'Auto'` on a plain retold-data-service means no policy (`ScopeAssurance: 'Unscoped'`). An object: `{ Column, SessionField, Exclude, PersonalScopes }`, below. |
| `Scope.Required` | object | `{}` | Entity → `[ { Column, From } ]`: more columns that must carry the principal's value. `From` is `'$Scope.<Column>'` or `'$CurrentUser.<Field>'`. |
| `Scope.UserRecordFields` | array | `[ 'IDUser', 'IDCustomer' ]` | Fields of the session's user record a definition may bind with `$CurrentUser.<Field>`. |
| `Scope.UnsetValues` | array | `[ 0, '', null ]` | Values that count as "not set" for a scope value; an unset value answers `401`. |
| `Scope.TrustedOpaque` | array | `[]` | Entities whose list behavior may rewrite the query in a way the service cannot read back, and are still trusted (their hops run in the Staged plan form). |
| `Scope.TrustPostOperation` | array | `[]` | Entities whose read-side post-operation behaviors you vouch for. Others are reported `Opaque` in Describe. |
| `Scope.PostOperationSafeColumns` | object | `{}` | Entity → columns a facet may still read when the entity's post-operation behaviors are not vouched for. |
| `Scope.AllowHeaderSession` | boolean | `false` | Allow a host whose sessions come from request headers. Without it the service refuses to attach there; with it, `ScopeAssurance` is `'Spoofable'`. Not accepted on a retold-application-foundation-server app (header sessions always refuse the boot there). |
| `Scope.DependsOn` | object | `{}` | **Reserved** (accepted, not read by this version). |

A policy object:

| Key | Meaning |
|---|---|
| `Column` | The tenant column (`IDCustomer`). Every entity that has it is scoped to the principal's value. |
| `SessionField` | The session field holding that value (default: `Column`). |
| `Exclude` | Entities that have the column but are not scoped by it. |
| `PersonalScopes` | Entity → `{ Column, SessionField }`: a second, per-user scope on that entity (`LabForm.OwnerIDUser`). |

```javascript
Scope:
	{
		Policy:
			{
				Column: 'IDCustomer',
				SessionField: 'CustomerID',
				Exclude: [ 'FormType' ],
				PersonalScopes: { LabForm: { Column: 'OwnerIDUser', SessionField: 'UserID' } }
			},
		Guard: 'Strict'
	}
```

## Authorization

On a plain retold-data-service there are no entitlements: every facetable entity is readable by every principal the scope policy admits. None of these options is read there.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `Authorization.Strategy` | string or function | `'Auto'` | The entitlement source. With Retold-Entitlements on a retold-application-foundation-server app, a function `(pEntity, pPrincipal) => boolean` can only narrow the `<Entity>.read` check, and `'None'` refuses the boot. Not read on a retold-data-service host. |
| `Authorization.RequireAction` | string or `false` | `false` | retold-application-foundation-server only: a string names an extra action every facet request needs, on top of `<Entity>.read`. Set without entitlements, it denies every entity (warned at boot). Not read on a retold-data-service host. |
| `Authorization.EntitlementCacheMS` | number | `0` | retold-application-foundation-server only: `0` reads the action set on every request, as the app's own gate does; a positive value caches it per user and tenant in this process (writes to the role tables in the same process clear it; writes by other processes do not). Not read on a retold-data-service host. |
| `Authorization.PrivilegedActions` | array | `[]` | **Reserved** (accepted, not read by this version). |
| `Authorization.PlatformActionsFromRoles` | boolean | `false` | **Reserved** (accepted, not read by this version). |
| `ServiceAuth` | object | `{ KeysEnv: null, SkewMS: 30000, NonceStore: 'Auto' }` | **Reserved** (accepted, not read by this version). |

The `retold-application-foundation-server` host adapter reads the first three; see [Hosting](#/page/Hosting).

## Execution

| Option | Type | Default | Meaning |
|---|---|---|---|
| `Execution.MaxParallelStatements` | number | `4` | SQL statements one request runs at once. |
| `Execution.Cube` | string | `'Auto'` | `'Auto'`, `'Always'` or `'Never'`. The cube answers several facets of one entity with one conditional `GROUP BY`; `'Auto'` uses it when at least two facets qualify. |
| `Execution.Staged` | string | `'Auto'` | `'Auto'`, `'Always'` or `'Never'`. The staged form reads a hop's keys first and passes them on as a bound list; `'Auto'` stages only hops over entities in `Scope.TrustedOpaque`. |
| `Execution.Pool` | object | `{ Mode: 'Auto', AllowShared: false, Provider: null, ConnectionEnv: null, Max: 4, ApplicationName: 'retold-faceting', TreatReplicaAsExact: false, ReplicaMaxLagMS: 5000 }` | **Reserved** (accepted, not read by this version). Statements run on the host's own connection. |
| `Admission` | object | `{ PerPrincipal: 4, PerTenant: 16, Global: 64, QueueMS: 2000, PreAuth: { … } }` | **Reserved** (accepted, not read by this version). |

[Architecture](#/page/Faceting_Architecture) describes the plan forms.

## Limits

Limits bound what one request may ask for. The request limits are shared with the contract code, so a configured value applies everywhere it is checked. [Errors and Limits](#/page/api/Errors_And_Limits) lists the error each one produces.

| Option | Default | Bounds |
|---|---|---|
| `Limits.MaxFacets` | `20` | Facets in one request. |
| `Limits.MaxTop` | `500` | Largest `Top` (larger values are clamped, with a warning). Also the per-axis key limit of a pivot. |
| `Limits.DefaultTop` | `20` | `Top` when a Terms facet does not give one. |
| `Limits.MaxBuckets` | `500` | Largest `Buckets` (clamped, with a warning); most `Ranges`; most `Edges` (plus one). |
| `Limits.DefaultBuckets` | `20` | Target bucket count of a NumericHistogram in `Nice` mode. |
| `Limits.MaxDateBuckets` | `400` | Buckets a DateHistogram may produce. |
| `Limits.MaxPivotDimensions` | `2` | Dimensions of a pivot (only lowers the built-in 2). |
| `Limits.TimeoutMS` | `10000` | Deadline of one request; the body's `TimeoutMS` can only shorten it. |
| `Limits.MaxBodyBytes` | `262144` | Size of a request body. |
| `Limits.MaxJSONDepth` | `8` | Nesting of a request body. |
| `Limits.MaxClauses` | `100` | Entries in `Clauses`. |
| `Limits.MaxValueBytes` | `1024` | Any string in a request (filter strings excepted: each value inside them is checked instead). |
| `Limits.MaxInList` | `1000` | Any array in a request; list parameters. |
| `Limits.MaxRecordsPage` | `500` | Records per page. |
| `Limits.MaxRecordsOffset` | `10000` | Deepest `Begin` of a Records page. |
| `Limits.MaxKeys` | `50000` | Largest `Cap` of a Keys request (also its default). |
| `Limits.MaxHops` | `4` | Steps per path, after aliases are spliced (checked at definition load). |
| `Limits.MaxRelationsPerRequest` | `32` | Scoped relations one request builds. |
| `Limits.MaxBehaviorRunsPerRequest` | `32` | List-behavior runs one request makes to capture scopes. |
| `Limits.MaxTermsGroups` | `10000` | Rows a Terms statement may return beyond `Top + 1` when counts tie at the cut. |
| `Limits.CubeMaxGroups` | `100000` | Cells a Pivot may have; also the row cap of the cube (beyond it the cube falls back to one statement per filter shape). |
| `Limits.MaxExistsDepth` | `4` | Nested existence levels in a definition (checked at load). |
| `Limits.MaxScopeDepth` | `3` | Nested scope references in a definition (checked at load). |
| `Limits.MaxScopesPerRequest` | `16` | Named scopes in one request. |
| `Limits.MaxStagedKeys` | `50000` | Keys a staged hop may carry. |

These limit names are accepted but **not enforced** by this version; configuring one logs a warning when the service attaches: `InListChunk`, `MaxBindBytes`, `SharedMaxRowsPerStatement`, `MaxLiveRows`, `MaxLiveRowScansPerRequest`, `HardMaxLiveRows`, `SQLiteMaxRows`, `ScanFoldMaxRows`, `ScanFoldCPUMS`, `ExactDistinctMaxRows`, `ResponseBytes`.

## Time

| Option | Type | Default | Meaning |
|---|---|---|---|
| `Time.StorageTimeZone` | string | `'UTC'` | The time zone the database's naive date values are in. Date buckets, `$Now` and `$Today` use it. A request may only name this zone. |
| `Time.DefaultInterval` | string | `'month'` | The DateHistogram interval when a request or definition gives none. |
| `Time.AllowRequestTimeZone` | boolean | `false` | **Reserved** (accepted, not read by this version). |

## Cache

The result cache is off by default. It is correct only while every write to the faceted tables runs in this one process and passes through the change intake (or `notify()`); [Caching and Invalidation](#/page/Caching_And_Invalidation) explains why and what to do otherwise.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `Cache.Enabled` | boolean | `false` | The result cache, generation-based ETags, and `304` answers without running any SQL. |
| `Cache.ExposeStatus` | boolean | `false` | Send the `X-Retold-Facet-Cache` and `X-Retold-Facet-Freshness` headers, and a truthful `Cached` flag on an answer another principal computed. An operator or demo switch. |
| `Cache.MaxConcurrentRefreshes` | number | `4` | Background refreshes of stale entries in flight at once. |
| `Cache.MaxBytes` | number | `67108864` | Total size of cached answers. |
| `Cache.MaxEntries` | number | `5000` | Number of cached answers. |
| `Cache.MaxEntryBytes` | number | `4194304` | Largest single cached answer. |
| `Cache.MaxAgeMS` | number | `600000` | Oldest entry ever served; also the largest `Freshness.MaxLagMS` a request may ask for. |
| `Cache.GenerationGranularity` | string | `'Column'` | `'Column'` invalidates by the columns a write changed; `'Entity'` by entity only. |
| `Cache.MaxGenerationKeys` | number or `'Auto'` | `'Auto'` | Generation keys kept; `'Auto'` is `MaxBytes / 320`, between 4096 and 200000. |
| `Cache.MaxGenerationFloors` | number | `50000` | Floors kept for evicted generation keys. |
| `Cache.NowBucketMS` | number | `60000` | `$Now` is floored to this, so answers that bind `$Now` can be shared within the bucket. |
| `Cache.AgentlessTTLMS`, `Cache.OpaqueTTLMS`, `Cache.AsOfBucketMS` | number | `15000`, `0`, `5000` | **Reserved** (accepted, not read by this version). |

## Freshness

| Option | Type | Default | Meaning |
|---|---|---|---|
| `Freshness.DefaultMode` | string | `'Exact'` | The freshness mode of a request that names none: `'Exact'`, `'Bounded'` or `'Fast'`. |
| `Freshness.MaxLagMS` | number | `5000` | The default lag bound of `Bounded` / `Fast` requests and of the ClickHouse store's admission. |
| `Freshness.LagWarnMS` | number | `2000` | A mirrored entity lagging more than this reports the state `Lagging`. |
| `Freshness.ReadYourWritesMS` | number | `10000` | For this long after a principal's own write, its requests are answered `Exact`. |
| `Freshness.ReadYourWritesMaxPrincipals` | number | `10000` | Principals tracked for read-your-writes. |
| `Freshness.SeqHeader` | `true`, `false` or `'Auto'` | `'Auto'` | Send `X-Retold-Facet-Seq`. `'Auto'` sends it only on a host without a scope policy, because the node-wide counter would reveal other tenants' write volume. |
| `Freshness.BreakerFailures` | number | `5` | Store failures within `BreakerWindowMS` that open the circuit breaker for an entity. |
| `Freshness.BreakerWindowMS` | number | `30000` | The breaker's counting window. |
| `Freshness.BreakerOpenMS` | number | `30000` | How long an open breaker keeps facets on Live. |
| `Freshness.StatePollMS`, `Freshness.FeedMaxLagMS`, `Freshness.MinSeqWaitMS` | number | `250`, `2000`, `1500` | **Reserved** (accepted, not read by this version). |

## Change Capture

| Option | Type | Default | Meaning |
|---|---|---|---|
| `ChangeCapture.Intake` | string | `'Auto'` | `'Auto'` (the upstream change bus when fable has one, else the interim intake), `'Interim'` (wrap each facetable entity's CRUD write path), `'Bus'`, or `'None'` (install nothing; only `notify()` reports writes). `'Bus'` requires `fable.MeadowChangeBus`, which is planned upstream; without it the service logs a warning and installs no change source. |
| `ChangeCapture.NotifySettleMS` | number | `1000` | Every `notify()` is replayed once after this delay, so a notify sent just before its transaction committed cannot leave a stale cache entry. `0` turns the replay off. |
| `ChangeCapture.NotifyManaged` | `true` or array | `[]` | Entities whose every write the host reports through `notify()` (`true` = all). |
| `ChangeCapture.RequireNotifyTenants` | boolean | `false` | Refuse a `notify()` of a tenant-scoped entity that names no tenant (instead of invalidating every tenant). |
| `ChangeCapture.MaxEventIDs` | number | `10000` | Beyond this many IDs a change event carries "unknown" IDs. |
| `ChangeCapture.MaxEventOwners` | number | `1000` | Beyond this many owners a change event carries "unknown" owners. |

## SSE (The Change Feed)

| Option | Type | Default | Meaning |
|---|---|---|---|
| `SSE.Enabled` | `true`, `false` or `'Auto'` | `'Auto'` | Mount `GET <RoutePrefix>/Changes`. `'Auto'` mounts it only on a host with a scope policy; `true` states that the host is single-tenant. |
| `SSE.AllowedOrigins` | array or `'*'` | `[]` | Cross-origin pages allowed to open a stream. Same-origin requests are always allowed. |
| `SSE.CoalesceMS` | number | `250` | Changes within this window become one event per entity. |
| `SSE.HeartbeatMS` | number | `15000` | Interval of the `: hb` heartbeat comment. |
| `SSE.GlobalTickMS` | number | `60000` | With a scope policy, how often changes to unscoped entities are announced. |
| `SSE.MaxPerPrincipal` | number | `2` | Open streams per principal. |
| `SSE.MaxPerTenant` | number | `200` | Open streams per tenant (a fair share of `MaxConnections` when many tenants connect). |
| `SSE.MaxConnections` | number | `1000` | Open streams in total. |
| `SSE.RevalidateMS` | number | `300000` | Each stream ends after about this long (±10 %) so the client reconnects through the host's authentication. On a retold-application-foundation-server app the default is `60000`, and the stream re-reads its session and roles at that time instead of ending (it ends when they changed). |
| `SSE.RetryMS` | number | `3000` | The reconnect delay sent to the client (with jitter). |
| `SSE.IncludeSeq` | `true`, `false` or `'Auto'` | `'Auto'` | Put `Seq` in events; `'Auto'` as `Freshness.SeqHeader`. |

The SSE settings are read when each stream uses them, so a test may tune them on the live options object. See [The Change Feed](#/page/api/Change_Feed).

## Stores

The ClickHouse store is optional. Leave `Stores.ClickHouse` at `false` and every facet runs Live. [The ClickHouse Store](#/page/ClickHouse_Store) explains when to use it and how it stays correct.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `Stores.ClickHouse` | `false` or object | `false` | An object registers the store; its keys merge over the defaults below. |
| `Stores.Solr`, `Stores.OpenSearch` | any | `false` | **Reserved** (accepted, not read by this version). |

`Stores.ClickHouse` object keys:

| Key | Default | Meaning |
|---|---|---|
| `URL`, `URLEnv` | `null` | `http(s)://host:port`, or the name of an environment variable holding it. No credentials in the URL. |
| `User`, `UserEnv` | `'default'`, `null` | The writer's user, or its environment variable name. |
| `Password`, `PasswordEnv` | `''`, `null` | The writer's password, or its environment variable name. Never logged. |
| `Database` | `null` | The database name. Required unless `InstanceID` is set to something other than `'main'` (then `rfs_<InstanceID>`). |
| `ReaderUser`, `ReaderUserEnv`, `ReaderPassword`, `ReaderPasswordEnv` | `null`, `null`, `''`, `null` | A separate, least-privilege credential for request reads (default: the writer's). Every request read runs read-only either way. |
| `TimeoutMS` | `20000` | Statement timeout. |
| `PingTimeoutMS` | `3000` | Connection check timeout. |
| `RetryConnectMS` | `60000` | How often an unavailable store is retried while every facet answers Live. |
| `InsertRetries` | `2` | Retries of one insert after a network error or 5xx. |
| `QuerySettings` | `{}` | Extra ClickHouse settings for every read. |
| `SourceStringOrder` | `'Auto'` | `'Auto'`, `'Binary'` or `'Collated'`: whether string range filters may run on the store. |
| `ExposeReasons` | `false` | Put the full routing reason in the envelope's `Store` block (otherwise its class only). |
| `ExposeFreshness` | `'Auto'` | Per-facet `LagMS` / `AsOf` and Describe's per-entity store state; `'Auto'` only on a host without a scope policy. |
| `MaxConcurrentReads` | `32` | Store reads in flight; beyond it a facet answers Live. |
| `WriterMaxSockets` | `16` | The materializer's connection pool. |
| `ReadLimits` | `{ MaxMemoryBytes: 4294967296, MaxRowsToRead: 0, MaxBytesToRead: 0 }` | Per-read limits (`0` = the server's own). |
| `HealthMinTimeoutMS` | `1000` | A timeout counts against the store's health only when the statement had at least this long. |
| `UnreachableAfterFailures` | `2` | Network failures within `Freshness.BreakerWindowMS` that mark the whole store unreachable. |
| `UnreachablePingMS` | `2000` | How often an unreachable store is pinged. |
| `AllowInsecure` | `false` | Silence the warning for plain `http://` to a host that is not loopback. |
| `CA`, `Cert`, `Key`, `RejectUnauthorized` | `null`, `null`, `null`, `true` | TLS options (PEM text). |
| `Owner` | `'Check'` | `'Check'` refuses a database another deployment created; `'Adopt'` takes it over. |

### Materialize

`Materialize` declares which entities a store mirrors: `{ <Entity>: <declaration> }`, or `'All'` (every facetable entity; meant for tests and demos).

| Key | Default | Meaning |
|---|---|---|
| `Store` | (required) | `[ 'ClickHouse' ]`. |
| `Columns` | `'Auto'` | `'Auto'` or an explicit column list (scope, identity, delete, `UpdateDate` and join columns are always added). |
| `IncludeColumns` | `[]` | Columns added to `'Auto'`. |
| `ExcludeColumns` | `[]` | Columns removed from `'Auto'` (never a scope, identity or delete column). |
| `SortKey` | `'Auto'` | Only `'Auto'`. |
| `Watermark` | `'Auto'` | `'Auto'`, `'UpdateDate'` or `false`. |
| `Mutability` | `'Mutable'` | `'AppendOnly'` is accepted with a warning and treated as `'Mutable'`. |
| `PathColumns`, `RelationFields`, `Rollups`, `Aggregates`, `Dictionary` | — | Accepted with an `Unsupported:<Key>` warning and ignored. |

### Materializer

| Option | Default | Meaning |
|---|---|---|
| `Materializer.Enabled` | `'Auto'` | `'Auto'` materializes when a store is registered; `false` means the store is never used. |
| `Materializer.BatchIDs` | `2000` | IDs per materializer batch. |
| `Materializer.ReadChunkIDs` | `1000` | IDs per source read. |
| `Materializer.FlushIntervalMS` | `1000` | Flush interval of buffered rows. |
| `Materializer.FlushRows` | `50000` | Rows that force a flush. |
| `Materializer.RebuildPageSize` | `25000` | Rows per rebuild page. |
| `Materializer.OverflowIDs` | `100000` | Pending IDs per entity before it falls back to a full re-sync. |
| `Materializer.MaxBackoffMS` | `30000` | Longest retry backoff. |
| `Materializer.DrainOnStopMS` | `5000` | How long shutdown waits for pending work. |
| `Materializer.IdleTickMS` | `50` | Idle loop tick. |
| `Materializer.StreamDelayMS` | `'Auto'` | How long a change waits for company before its read cycle (`'Auto'` = the flush interval). |
| `Materializer.PromptRangeKinds` | `[ 'Resync', 'RebuildPage' ]` | Range pages flushed at once. |
| `Materializer.MaxConcurrentBuilds` | `2` | Backfills and rebuilds per store at once. |
| `Materializer.StateWriteIntervalMS` | `5000` | How often progress-only state rows are written. |
| `Materializer.PartsBackoffAbove` | `150` | Active ClickHouse parts above which flushing slows down. |
| `Materializer.HealthCheckMS` | `30000` | Health check interval. |
| `Materializer.Lease` | `{ Enabled: true, TTLMS: 30000, HeartbeatMS: 10000, SettleMS: 250 }` | One process materializes a store; the others leave it unused. |

### Reconcile

| Option | Default | Meaning |
|---|---|---|
| `Reconcile.AutoStart` | `true` | Start each mirrored entity's reconcile timers. |
| `Reconcile.SweepIntervalMS` | `'Auto'` | `'Auto'`: 600000 with a change intake (and the entity not in `RawWriterEntities`), else 60000. |
| `Reconcile.RawWriterEntities` | `[]` | Entities written outside the intake; they sweep more often. |
| `Reconcile.MaxTxnMS` | `60000` | The longest source transaction a sweep allows for. |
| `Reconcile.SweepCap` | `5000` | Rows per sweep. |
| `Reconcile.LeafRange` | `2000` | Key range of a bisect leaf. |
| `Reconcile.BisectIntervalMS` | `86400000` | Bisect period. |
| `Reconcile.HardDeleteBisectIntervalMS` | `3600000` | Bisect period for entities without soft delete. |
| `Reconcile.RebuildDivergenceRatio` | `0.01` | Divergence above which an entity is rebuilt. |
| `Reconcile.ScrubPeriodMS` | `86400000` | Full scrub period. |
| `Reconcile.ScrubRowsPerSecond` | `2000` | Scrub pace ceiling. |
| `Reconcile.ScrubTickMS` | `1000` | Scrub tick. |
| `Reconcile.ScrubUnknownTotalRowsPerTick` | `256` | Scrub pace while the row count is unknown. |
| `Reconcile.BootBisectAfterMS` | `300000` | After more downtime than this, a bisect runs before the entity answers Exact. |
| `Reconcile.JitterRatio` | `0.15` | Random spread of timer phases and periods. |

## Admin

| Option | Type | Default | Meaning |
|---|---|---|---|
| `Admin.Routes` | boolean | `false` | Mount the store admin routes. Only exactly `true` mounts them. |
| `Admin.authorize` | function | `null` | `(pRequest, pPrincipal) => boolean`. An admin route runs only when it returns exactly `true`; it also decides who sees Describe's store detail. |
| `Admin.RebuildCooldownMS` | number | `600000` | Shortest time between two admin rebuilds of one entity. |

The in-process `storeAdmin()` call needs no route; see [JavaScript API](#/page/api/JavaScript_API).

## Reserved Sections

These sections are accepted and not read by this version: `Agent` (`{ PrivateListener: false }`), `Upstream` (`{ URL: false }`), `Edge` (`{ Role: 'Gateway' }`), `Privacy` (`{ MinBucketCount: 0 }`) and `Compat` (one reserved switch, `false`).

## Related

- [Definitions Files](#/page/Definitions)
- [Hosting](#/page/Hosting)
- [Security and Tenancy](#/page/Security_And_Tenancy)
- [Errors and Limits](#/page/api/Errors_And_Limits)
