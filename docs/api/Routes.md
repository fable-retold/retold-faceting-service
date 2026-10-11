# Routes

The faceting service mounts its routes on the host's [Orator](#/doc/orator/orator) service server, under `RoutePrefix` (default `/1.0/Facet`). Every route resolves the principal from the host's own session, exactly as the entity's list routes do. The principal is checked once the JSON body has been read, before the body is interpreted.

## Route Table

| Method | Path | Answers | Page |
|---|---|---|---|
| `POST` | `/1.0/Facet/:Entity/Query` | The envelope: facets, `Total`, optional records. | [The Request Body](#/page/api/Request), [The Response Envelope](#/page/api/Envelope) |
| `POST` | `/1.0/Facet/:Entity/Records` | A JSON array: one page of the matching records. | [Records, Count and Keys](#/page/api/Records_And_Keys) |
| `POST` | `/1.0/Facet/:Entity/Records/:Begin/:Cap` | The same, with the page in the path (the [pict-section-recordset](#/doc/pict/pict-section-recordset) form). | [Records, Count and Keys](#/page/api/Records_And_Keys) |
| `POST` | `/1.0/Facet/:Entity/Records/Count` | `{ Count }`. | [Records, Count and Keys](#/page/api/Records_And_Keys) |
| `POST` | `/1.0/Facet/:Entity/Keys` | `{ Entity, Keys, Count, Truncated, Version }`. | [Records, Count and Keys](#/page/api/Records_And_Keys) |
| `POST` | `/1.0/Facet/:Entity/Scope/:Scope/Query` | As `Query`, with the named scope `:Scope` applied. | [Records, Count and Keys](#/page/api/Records_And_Keys) |
| `POST` | `/1.0/Facet/:Entity/Scope/:Scope/Records`, `…/Records/:Begin/:Cap`, `…/Records/Count` | As the `Records` routes, with the named scope applied. | [Records, Count and Keys](#/page/api/Records_And_Keys) |
| `GET` | `/1.0/Facet/Describe` | What the principal may facet, for every entity. | [Describe](#/page/api/Describe) |
| `GET` | `/1.0/Facet/Describe/:Entity`, `/1.0/Facet/:Entity/Describe` | The same, for one entity. | [Describe](#/page/api/Describe) |
| `GET` | `/1.0/Facet/Changes` | A server-sent event stream of changes. Mounted only when `SSE.Enabled` allows it. | [The Change Feed](#/page/api/Change_Feed) |
| `POST` | `/1.0/Facet/Admin/Rebuild/:Store/:Entity` | Start a rebuild of one mirrored entity. Mounted only with `Admin.Routes: true`. | below |
| `POST` | `/1.0/Facet/Admin/Reconcile/:Store/:Entity` | Start a reconcile of one mirrored entity. Mounted only with `Admin.Routes: true`. | below |

The record routes are `POST` only, because pict-section-recordset posts its filter. A route that is not mounted (for example `/Changes` on a host without a scope policy) answers the server's own `404` (`{ "code": "ResourceNotFound", … }`), not a facet error.

### Reserved Entity Names

An entity named `Facet`, `Describe`, `Agent`, `Admin`, `Changes` or `Status` would collide with these routes. When the model has one, the service refuses to attach at all: `installOnRetoldDataService` calls back with an error naming the entities, and no route is mounted.

## Request Bodies

The `POST` routes read their body themselves, never through a server-wide body parser:

- The `Content-Type` must be `application/json` or a `+json` type. Anything else (a form post, `text/plain`, a multipart upload) is refused before a byte is read, so an HTML form on another site can never send a query with a user's cookies.
- The body may be at most `Limits.MaxBodyBytes` (256 KiB), checked against `Content-Length` and again while it streams in.
- If host middleware already parsed the body, the parsed body is used, after the same content-type check.

Every refusal is a facet error with the standard headers:

| Problem | Answer |
|---|---|
| Wrong content type | `400 FACET_REQUEST_INVALID`, `Detail: { Reason: 'UnsupportedContentType' }` |
| Too large | `400 FACET_REQUEST_INVALID`, `Detail: { Reason: 'BodyTooLarge', Limit: 'MaxBodyBytes', Max: 262144 }` |
| Not JSON | `400 FACET_REQUEST_INVALID`, `Detail: { Reason: 'BodyNotJSON' }` |

```json
{
	"Error":
	{
		"Code": "FACET_REQUEST_INVALID",
		"Status": 400,
		"Message": "The request body must be application/json.",
		"Detail": { "Reason": "UnsupportedContentType" }
	}
}
```

## Response Headers

| Header | Sent on | Value |
|---|---|---|
| `Cache-Control` | every answer | `private, no-cache`: a shared cache never stores an answer, and a browser always revalidates. |
| `Vary` | every answer | `Cookie, Authorization`. |
| `X-Retold-Facet-Contract` | every answer | `1`, the contract version. |
| `ETag` | `Query`, `Records`, `Count`, `Keys` (200 and 304) | `W/"<Version>"`, for example `W/"fv1:6e3dbc1113faa5eb"`. |
| `X-Retold-Facet-Seq` | `Query`, `Records`, `Count`, `Keys` | The change sequence the answer covers (`e:<8 hex>:<n>`). Only when `Freshness.SeqHeader` allows it (by default, on a host without a scope policy) and a change source is installed. |
| `X-Retold-Facet-Scope-Repaired` | `Query`, `Records`, `Count`, `Keys` | `1` when `Scope.Guard: 'Repair'` had to add a missing scope filter. |
| `X-Retold-Facet-Records-Dropped` | `Records` | The number of keys that no longer read back between the key statement and the record read. Only when not 0. |
| `X-Retold-Facet-Cache` | `Query`, only with `Cache.ExposeStatus` | `Off`, `Bypass`, `Miss`, `Hit`, `Stale` or `NotModified`. |
| `X-Retold-Facet-Freshness` | `Query`, only with `Cache.ExposeStatus` | The effective freshness mode, with `; upgraded=ReadYourWrites` or `; upgraded=MinSeq` when the service raised it to `Exact`. |

The change feed answers with its own streaming headers; see [The Change Feed](#/page/api/Change_Feed).

## Request Headers

| Header | Meaning |
|---|---|
| `If-None-Match` | One or more ETags (or `*`). When the answer's `Version` matches, the route answers `304 Not Modified` with no body. |
| `X-Retold-Facet-MinSeq` | A change sequence the answer must include, when the body's `Freshness` has no `MinSeq`. A malformed value is `400 FACET_REQUEST_INVALID`. |

## Conditional Requests

Every answer carries its `Version` as a weak `ETag`. Send it back in `If-None-Match` and an unchanged answer comes back as `304`:

```text
POST /1.0/Facet/Book/Query                                   → 200  ETag: W/"fv1:2f828809f461fd0a"
POST /1.0/Facet/Book/Query  If-None-Match: W/"fv1:2f828809f461fd0a"   → 304  (no body; same ETag)
```

When the 304 is decided depends on the cache:

- With `Cache.Enabled: false` (the default), the answer is computed and its `Version` compared afterwards. The 304 saves the transfer, not the queries.
- With `Cache.Enabled: true` and a cacheable request, the `Version` comes from the data's generations and is compared before any SQL runs, right after the principal, the filter and the plan are checked.
- An answer served stale from the cache never earns a 304, because its `Version` is not the current one.
- `Records`, `Count` and `Keys` compare after their statements ran.

Authorization always runs first, so a 304 never answers a principal that could not read the entity.

## Admin Routes

The admin routes start store maintenance for one mirrored entity. They exist for operators and tests; the in-process `storeAdmin()` call ([JavaScript API](#/page/api/JavaScript_API)) does the same without a route.

They mount only when `Admin.Routes` is exactly `true`. Every request then needs a resolved principal, and `Admin.authorize(pRequest, pPrincipal)` must return exactly `true`; otherwise the answer is `403 FACET_FORBIDDEN` with no detail.

| Route | Body | Action |
|---|---|---|
| `POST /1.0/Facet/Admin/Rebuild/:Store/:Entity` | `{}` | Rebuild the entity's mirror from the source. |
| `POST /1.0/Facet/Admin/Reconcile/:Store/:Entity` | `{ "Level": "Sweep" \| "Bisect" \| "Scrub" \| "Verify" }` | Run one reconcile pass at that level. |

A started action answers `202` with `{ "Started": true, "Action": "<action>", "Store": "ClickHouse", "Entity": "<Entity>" }` and keeps running; its outcome goes to the log. Refusals:

| Answer | When |
|---|---|
| `400 FACET_REQUEST_INVALID` | An unknown reconcile `Level`. |
| `401 FACET_UNAUTHENTICATED` | The principal is refused, as on every other route (for example an anonymous request on a host with a scope policy). |
| `403 FACET_FORBIDDEN` | `Admin.authorize` did not return `true`. |
| `404 FACET_UNKNOWN_ENTITY` | An unknown store, or an entity the store does not mirror. |
| `429 FACET_RATE_LIMITED` | The same action is already running for the entity (`Limit: 'Admin.InFlight'`), or a rebuild finished less than `Admin.RebuildCooldownMS` ago (`Limit: 'Admin.RebuildCooldownMS'`, with `RetryAfterMS`). |
| `503 FACET_ENGINE_UNAVAILABLE` | The store is unavailable or not materializing. |

[The ClickHouse Store](#/page/ClickHouse_Store) explains rebuilds and reconcile levels.

## Related

- [API Reference](#/page/API_Reference)
- [Errors and Limits](#/page/api/Errors_And_Limits)
- [Caching and Invalidation](#/page/Caching_And_Invalidation)
- [Configuration](#/page/Configuration)
