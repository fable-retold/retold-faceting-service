# Errors and Limits

Every error the faceting service returns has a stable code, an HTTP status and a plain message. A problem with the whole request fails the request; a problem with one facet becomes an entry in the envelope's `Errors` and the other facets are still answered. The limits that bound a request are listed at the end, each with the error it produces.

## Two Shapes

A **whole-request** error answers with its HTTP status and this body:

```json
{
	"Error":
	{
		"Code": "FACET_REQUEST_INVALID",
		"Status": 400,
		"Message": "Facets is required.",
		"Detail": { "Field": "Facets", "Reason": "Missing" }
	}
}
```

A **per-facet** error is an entry of the envelope's `Errors`, keyed by the facet's `Key` (or `#Total`), in the same shape, inside a `200` answer:

```json
{
	"Errors":
	{
		"ByDay": { "Code": "FACET_INTERVAL_TOO_FINE", "Status": 422, "Message": "The interval produces too many buckets.", "Detail": { "Interval": "day", "MaxDateBuckets": 400, "Suggest": { "Interval": "week" } } }
	}
}
```

When every facet failed and the `Total` (if requested) failed too, there is nothing to answer, and the request fails with the first facet's error as a whole-request error.

`Detail` names fields, limits and reasons; it never contains a filter value, a parameter value or row data. An error below 500 may carry a more specific message than its code's standard one ("Facets is required."); match on `Code`, never on `Message`. An error with a status of 500 or more has no `Detail` at all and only its code's standard message below: the specific cause is logged on the server, never sent. Every error answer carries the standard headers ([Routes](#/page/api/Routes)).

## Codes

| Code | Status | Standard message | Raised when |
|---|---|---|---|
| `FACET_UNAUTHENTICATED` | 401 | Authentication required. | On a host with a scope policy: an anonymous principal (unless `Catalog.AllowAnonymous` lists the entity), or a principal whose scope value is unset. A definition binding an unset `$CurrentUser` or `$Scope` value. A host behavior answering 401. A change-feed request that is not a signed-in user. |
| `FACET_FORBIDDEN` | 403 | Forbidden. | A scope, join clause or declared facet reads an entity the principal may not facet (no detail, so a hidden entity and a missing one look alike). An admin route request `Admin.authorize` refused. A change-feed request from another origin (`Reason: 'Origin'`). |
| `FACET_ADHOC_FORBIDDEN` | 403 | Inline facet definitions are not permitted. | A facet in the request carries a `Definition`. |
| `FACET_UNKNOWN_ENTITY` | 404 | Unknown entity. | The route entity does not exist, is not facetable, or may not be read by the principal (all three look the same). An admin route names an unknown store or an entity the store does not mirror. |
| `FACET_UNKNOWN_FACET` | 400 | Unknown facet. | Per facet: a well-formed FacetID that names no facet, a disabled definition, a facet of another entity, or an automatic path facet over a target the principal may not facet. `Detail: { Facet }`. |
| `FACET_UNKNOWN_FIELD` | 400 | Unknown field. | A filter-string field, clause column or `Records.Sort` field that is not a filterable column (Sensitive columns included). `Detail: { Field }`. |
| `FACET_UNKNOWN_SCOPE` | 400 | Unknown scope. | A named scope that does not exist, is disabled, or belongs to another entity. `Detail: { Scope }`. |
| `FACET_UNKNOWN_FOLD` | 400 | Unknown or unavailable fold for this facet. | A `Fold` name that does not exist, for the whole request (`Detail: { Index, Fold }`). Per facet: a fold the facet does not offer (`Detail: { Facet, Fold, Folds }`). |
| `FACET_FILTER_INVALID` | 400 | The filter is invalid. | A malformed filter string or clause: an unsupported instruction (`Detail: { Offset, Token, Reason }`), unbalanced groups, a value that cannot be coerced or contains `~`, a join clause that follows no model join (`UndeclaredJoin`), a `NamedScope` clause in an OR group, an unsupported clause type. |
| `FACET_PARAM_INVALID` | 400 | A parameter is invalid. | A scope or facet parameter: `Detail: { Scope or Facet, Param, Reason }` with `Reason` `Unknown`, `Required`, `Type`, `NotAllowed` or `Range`. |
| `FACET_REQUEST_INVALID` | 400 | The request is invalid. | The body's shape: not JSON, wrong content type, too large, too deep, a field of the wrong type or out of range, duplicate facet keys, a malformed FacetID, the legacy payload, a bad `Records` page or `Cap`. Per facet: an interval the facet does not offer (`Reason: 'IntervalNotOffered'`). `Detail` carries `Field`, `Index`, `Reason`, or `Limit` / `Max` / `Path` for size limits. |
| `FACET_TOO_MANY_FACETS` | 400 | Too many facets in one request. | More than `Limits.MaxFacets` facets. `Detail: { Max, Count }`. |
| `FACET_INTERVAL_TOO_FINE` | 422 | The interval produces too many buckets. | Per facet: a DateHistogram that would have more than `Limits.MaxDateBuckets` buckets. `Detail: { Interval, MaxDateBuckets, Suggest: { Interval } }`. |
| `FACET_PATH_TOO_BROAD` | 422 | The path matches too many keys. | Per facet: a staged hop that would carry more than `Limits.MaxStagedKeys` keys. `Detail: { Limit, Max, Suggest }`. |
| `FACET_FOLD_UNSUPPORTED` | 422 | This fold or feature is not supported here. | A feature this version does not serve: a fold named only through a FacetID (`PathTerms`, `BridgeTerms`, `TuplePivot`), `Computed`, `UnionOfSources`, `Mode: 'Log'`, an `Exclude` group, a `CountMode` other than `Rows`, `Selections`, `FilterExperience`, or a definition loaded with `Supported: false`. `Detail: { Feature, Milestone }`. |
| `FACET_TOO_LARGE` | 422 | The request is too large to compute. | A pivot with more than `Limits.CubeMaxGroups` cells (per facet), more than `Limits.MaxScopesPerRequest` scopes, `Limits.MaxRelationsPerRequest` relations or `Limits.MaxBehaviorRunsPerRequest` scope captures. `Detail: { Limit, … }`. |
| `FACET_TIMEZONE_UNSUPPORTED` | 422 | Only the storage time zone is supported. | A facet `TimeZone` other than `Time.StorageTimeZone`. `Detail: { Index, StorageTimeZone }`. |
| `FACET_RATE_LIMITED` | 429 | Too many requests. | Too many open change streams (`Detail: { Limit: 'SSE.…' }`). An admin action already running, or a rebuild inside `Admin.RebuildCooldownMS`. |
| `FACET_SCOPE_POLICY_VIOLATION` | 500 | The scope policy could not be verified. | `Scope.Guard: 'Strict'` found a captured scope without a required policy filter, or an entity's list behavior rewrote the query in a way the service cannot verify. The answer is refused rather than computed without its scope. |
| `FACET_INTERNAL` | 500 | Internal error. | Anything unexpected: a failed statement, a bug, a misconfigured host. Logged with the request's id. |
| `FACET_ENGINE_UNAVAILABLE` | 503 | No engine can answer this facet right now. | An admin action on a store that is unavailable or not materializing. (A failing store never fails a query: its facets fall back to Live.) |
| `FACET_TIMEOUT` | 504 | Facet exceeded its deadline. | Per facet: the facet was still running at the request's deadline (`Limits.TimeoutMS`, or the shorter `TimeoutMS` of the body). |

`FACET_DEFINITION_INVALID` (500, "A facet definition is invalid.") is never sent to a client. It marks definitions that failed to load, in the boot log and in `RetoldFacetingDefinitionRegistry.disabled()`; a request naming such a definition gets `FACET_UNKNOWN_FACET` or `FACET_UNKNOWN_SCOPE`. See [Definitions Files](#/page/Definitions).

### Reserved Codes

These codes are defined in `source/contract/Facet-Contract-Errors.js` for designed features but are **not raised by this version**:

| Code | Status |
|---|---|
| `FACET_SERVICE_AUTH_INVALID` | 401 |
| `FACET_FORBIDDEN_UPSTREAM` | 403 |
| `FACET_PATH_TOO_DEEP` | 400 |
| `FACET_MODEL_MISMATCH` | 409 |
| `FACET_SPEC_UNKNOWN` | 409 |
| `FACET_REQUIRES_AGENT` | 422 |
| `FACET_COMPUTED_TOO_LARGE` | 422 |
| `FACET_RESPONSE_TOO_LARGE` | 422 |
| `FACET_UPSTREAM_UNAVAILABLE` | 502 |
| `FACET_BUSY` | 503 |
| `FACET_MODEL_RELOADING` | 503 |

A request that arrives before any model is loaded is not answered with `FACET_MODEL_RELOADING`: Describe lists no entities, and a Query, Records, Count or Keys request gets `404 FACET_UNKNOWN_ENTITY`.

## Warnings

Warnings never fail anything. They ride along in the envelope:

| Code | Where | Meaning |
|---|---|---|
| `FACET_TOP_CLAMPED` | `Warnings` | `Top` was above `Limits.MaxTop`. `Detail: { Key, Requested, Applied }`. |
| `FACET_BUCKETS_CLAMPED` | `Warnings` | `Buckets` was above `Limits.MaxBuckets`. `Detail: { Key, Requested, Applied }`. |
| `FACET_STORE_FALLBACK` | `Warnings` | The ClickHouse store failed during the request and its facets were answered Live. `Detail: { Store, Reason }`. |
| `FACET_SORT_IGNORED` | `Filter.Warnings` | The filter string had an `FSF` sort stanza, which was removed. |
| `FACET_CLAUSE_EMPTY` | `Filter.Warnings` | A clause had no values left and was skipped. `Detail: { Index, Hash, ClauseType }`. |

## Limits

Each limit is an option under `RetoldFaceting.Limits` ([Configuration](#/page/Configuration)).

| Limit | Default | Exceeding it |
|---|---|---|
| `MaxBodyBytes` | 262144 | `400 FACET_REQUEST_INVALID`, `Reason: 'BodyTooLarge'` (route) or `Limit: 'MaxBodyBytes'` |
| `MaxJSONDepth` | 8 | `400 FACET_REQUEST_INVALID`, `Limit: 'MaxJSONDepth'` |
| `MaxClauses` | 100 | `400 FACET_REQUEST_INVALID`, `Limit: 'MaxClauses'` |
| `MaxValueBytes` | 1024 | `400 FACET_REQUEST_INVALID`, `Limit: 'MaxValueBytes'` with the `Path` of the string (filter strings are checked value by value instead) |
| `MaxInList` | 1000 | `400 FACET_REQUEST_INVALID`, `Limit: 'MaxInList'`; for a list parameter, `FACET_PARAM_INVALID` `Range` |
| `MaxFacets` | 20 | `400 FACET_TOO_MANY_FACETS` |
| `MaxTop` | 500 | clamped, warning `FACET_TOP_CLAMPED` |
| `DefaultTop` | 20 | (a default) |
| `MaxBuckets` | 500 | `Buckets` clamped with `FACET_BUCKETS_CLAMPED`; too many `Ranges` or `Edges` is `400 FACET_REQUEST_INVALID` |
| `DefaultBuckets` | 20 | (a default) |
| `MaxDateBuckets` | 400 | per facet `422 FACET_INTERVAL_TOO_FINE` |
| `MaxPivotDimensions` | 2 | `400 FACET_REQUEST_INVALID` |
| `TimeoutMS` | 10000 | per facet `504 FACET_TIMEOUT` |
| `MaxRecordsPage` | 500 | `400 FACET_REQUEST_INVALID`, `Field: 'Cap'` |
| `MaxRecordsOffset` | 10000 | `400 FACET_REQUEST_INVALID`, `Field: 'Begin'` |
| `MaxKeys` | 50000 | `400 FACET_REQUEST_INVALID`, `Field: 'Cap'` |
| `MaxScopesPerRequest` | 16 | `422 FACET_TOO_LARGE`, `Limit: 'MaxScopesPerRequest'` |
| `MaxRelationsPerRequest` | 32 | `422 FACET_TOO_LARGE`, `Limit: 'MaxRelationsPerRequest'` |
| `MaxBehaviorRunsPerRequest` | 32 | `422 FACET_TOO_LARGE`, `Limit: 'MaxBehaviorRunsPerRequest'` |
| `CubeMaxGroups` | 100000 | per facet `422 FACET_TOO_LARGE` for a pivot; above it a cube falls back to one statement per filter shape |
| `MaxTermsGroups` | 10000 | (bounds the rows a Terms statement returns when counts tie at the cut) |
| `MaxStagedKeys` | 50000 | per facet `422 FACET_PATH_TOO_BROAD` |
| `MaxHops` | 4 | at definition load: `TooManyHops`, the definition is disabled |
| `MaxExistsDepth` | 4 | at definition load: `ExistsTooDeep` |
| `MaxScopeDepth` | 3 | at definition load: `ScopeTooDeep` |

Size errors name the limit and the maximum, so a client can adjust:

```json
{ "Error": { "Code": "FACET_REQUEST_INVALID", "Status": 400, "Message": "A string value is too long.", "Detail": { "Limit": "MaxValueBytes", "Max": 1024, "Path": "Clauses[0].Values[0]" } } }
```

### Accepted but Not Enforced

These limit names are accepted in `Limits` but this version does not enforce them; setting one logs a warning when the service attaches: `InListChunk`, `MaxBindBytes`, `SharedMaxRowsPerStatement`, `MaxLiveRows`, `MaxLiveRowScansPerRequest`, `HardMaxLiveRows`, `SQLiteMaxRows`, `ScanFoldMaxRows`, `ScanFoldCPUMS`, `ExactDistinctMaxRows`, `ResponseBytes`.

## Handling Errors in a Client

- `400`: fix the request; `Detail.Field` and `Detail.Reason` say what to fix. Retrying the same body gives the same answer.
- `401`: sign in again. `403` and `404`: the principal may not facet that; do not retry.
- `422`: the request asks for too much, or for something this version does not do. `Detail.Suggest`, when present, names a coarser alternative (a larger interval, a smaller `Top`).
- `429`: back off.
- `5xx`: retry later. The server log has the cause, but the request id is not returned to the client, so match the log line by time and route. A failed stage logs `RetoldFaceting request rfq-NNNNNN failed in <Stage> (plan <hash>): <message>`; a `FACET_SCOPE_POLICY_VIOLATION` logs which entity and column the guard found missing.
- Always read `Errors` on a `200`: some facets may have failed while the others are valid.

## Related

- [The Request Body](#/page/api/Request)
- [The Response Envelope](#/page/api/Envelope)
- [Configuration](#/page/Configuration)
- [Security and Tenancy](#/page/Security_And_Tenancy)
