# The Change Feed (SSE)

`GET /1.0/Facet/Changes` is a server-sent event stream that tells a browser when data it can see has changed, so it can refetch the facets on screen instead of polling. An event names only the entity that changed; it never carries tenant, row or column data.

[Caching and Invalidation](#/page/Caching_And_Invalidation) explains where the changes come from. This page is the wire reference.

## When the Route Exists

The route mounts when `SSE.Enabled` is `true`, or `'Auto'` (the default) on a host with a scope policy. Without a policy the service cannot tell tenants apart, so every write would reach every stream; setting `SSE.Enabled: true` there states that the host is single-tenant. When the route is not mounted, a request gets the server's own `404`.

Describe reports the stream's path in `Changes.Stream` (or `null`).

## Opening a Stream

```text
GET /1.0/Facet/Changes
Cookie: <the host's session cookie>
```

Before the stream opens, the request must pass three checks. Each refusal is a JSON facet error with the standard headers:

| Check | Refusal |
|---|---|
| An `Origin` header must be this host, or listed in `SSE.AllowedOrigins` (`'*'` allows any). Requests without `Origin` pass. | `403 FACET_FORBIDDEN`, `Detail: { Reason: 'Origin' }` |
| The principal must be a signed-in user. | `401 FACET_UNAUTHENTICATED` |
| The principal may hold at most `SSE.MaxPerPrincipal` streams (2), its tenant a fair share of `SSE.MaxConnections` (at most `SSE.MaxPerTenant`), and the server at most `SSE.MaxConnections` (1000). New streams are refused; old ones are never dropped to make room. | `429 FACET_RATE_LIMITED`, `Detail: { Limit: 'SSE.MaxPerPrincipal' \| 'SSE.MaxPerTenant' \| 'SSE.MaxConnections' }` |

```json
{ "Error": { "Code": "FACET_RATE_LIMITED", "Status": 429, "Message": "Too many open change streams.", "Detail": { "Limit": "SSE.MaxPerPrincipal" } } }
```

An open stream answers `200` with these headers:

| Header | Value |
|---|---|
| `Content-Type` | `text/event-stream; charset=utf-8` |
| `Cache-Control` | `no-cache, no-transform` |
| `Connection` | `keep-alive` |
| `X-Accel-Buffering` | `no` (so an nginx proxy does not buffer the stream) |
| `Vary` | `Cookie, Authorization` |
| `X-Retold-Facet-Contract` | `1` |

## A Captured Stream

Captured on the Bookstore-Tenant fixture as user 5 of tenant 1, with `SSE.HeartbeatMS` lowered to 1500 for the capture. After the stream opened, the host called `notify('Book', …)` for a tenant-1 book and for a tenant-2 book, and then created a tenant-1 review through the stock `POST /1.0/Review` route:

```text
retry: 3491

event: ready
data: {"NodeEpoch":"e:32d02dcb","CoalesceMS":250,"HeartbeatMS":1500,"Reset":false}

event: generation
data: {"Entity":"Book","Generation":"g:fb3a497d78f7"}

event: generation
data: {"Entity":"Review","Generation":"g:097382aa90b6"}

event: generation
data: {"Entity":"Book","Generation":"g:d08ce0c6ed59"}

: hb

: hb
```

The tenant-2 change produced nothing on this tenant-1 stream. The second `Book` event is the notify's settle replay, one `ChangeCapture.NotifySettleMS` later. A second capture shows the other two events: a model reload, then the server shutting down.

```text
event: model
data: {"ModelVersion":"m:f6b3eefe4281"}

event: closed
data: {"Reason":"Shutdown"}
```

## Events

Every event's `data` is one line of JSON.

| Event | Data | Meaning |
|---|---|---|
| `ready` | `{ NodeEpoch, Seq?, CoalesceMS, HeartbeatMS, Reset }` | The stream is open. `NodeEpoch` identifies this server process (it changes on restart). `Reset` is `true` when the request carried a `Last-Event-ID` header. |
| `generation` | `{ Entity, Generation, Seq? }` | Data of `Entity` that this principal can see has changed. `Generation` is an opaque token (`'g:'` + 12 hex digits), different for every principal; compare it only for equality. |
| `model` | `{ ModelVersion }` | The host reloaded its model or definitions; everything should be refetched (and Describe reread). |
| `closed` | `{ Reason }` | The server is ending the stream: `'Shutdown'` (the server is stopping) or `'Revalidate'` (time to re-authenticate). The connection closes right after. |
| `: hb` | (a comment line) | A heartbeat every `SSE.HeartbeatMS` (15 s), so proxies keep the connection open. |

`Seq`, the node-wide change counter, appears in `ready` and `generation` only when `SSE.IncludeSeq` allows it: by default only on a host without a scope policy, because on a multi-tenant host consecutive values would reveal how much other tenants write. The first line, `retry: <ms>`, is `SSE.RetryMS` (3 s) plus up to 50 % jitter, so streams cut together do not all reconnect together.

## Who Gets Which Events

A change to entity E reaches a stream only when the stream's principal may facet E and the change touched that principal's own data:

- **Tenant-scoped entities** reach the streams of the changed rows' tenants only.
- **Personally scoped entities** (a `PersonalScopes` entry in the scope policy) reach only the owners of the changed rows, never their colleagues. A change whose owner is unknown reaches every owner in the tenant.
- **Unscoped entities** (and changes whose tenant is unknown) are collected and announced to every stream that may facet the entity once every `SSE.GlobalTickMS` (60 s) on a host with a scope policy; without a policy they go out at once.

Events are coalesced: all changes to one entity within `SSE.CoalesceMS` (250 ms) become one `generation` event per stream. A stream whose client stops reading holds its events (still coalesced) until it drains, and is closed after two heartbeat periods without progress.

## Streams End on Purpose

A stream remembers the session it was opened with. To make a logout, a tenant switch or a role change take effect, every stream ends after about `SSE.RevalidateMS` (5 minutes, ±10 %) with `closed { Reason: 'Revalidate' }`, and the client reconnects through the host's normal authentication. (A host adapter that can re-read a session from its store may instead check the principal and keep the stream open; the retold-data-service host does not.) A stream also ends with `closed { Reason: 'Shutdown' }` when the server stops.

Events are never replayed: no event has an `id:` line, and a reconnect starts fresh. So a client must refetch everything it shows on every `ready` after its first one, and whenever `Reset` is `true`; anything may have changed while it was disconnected.

## A Client

With cookie sessions, the browser's `EventSource` does everything, including reconnecting after `closed`:

```javascript
let tmpSource = new EventSource('/1.0/Facet/Changes', { withCredentials: true });
let tmpReadyCount = 0;

tmpSource.addEventListener('ready',
	(pEvent) =>
	{
		tmpReadyCount++;
		let tmpReady = JSON.parse(pEvent.data);
		if ((tmpReadyCount > 1) || tmpReady.Reset)
		{
			refetchEverything();
		}
	});

tmpSource.addEventListener('generation',
	(pEvent) =>
	{
		let tmpChange = JSON.parse(pEvent.data);
		// Refetch every facet group whose last envelope listed this entity in DependsOn.
		refetchGroupsDependingOn(tmpChange.Entity);
	});

tmpSource.addEventListener('model', () => { refetchEverything(); });
```

`refetchEverything` and `refetchGroupsDependingOn` are your own. Every Query envelope lists in `DependsOn` the entities its answer reads, which is what to match `generation.Entity` against.

`EventSource` cannot send request headers. A host that authenticates with a header must read the stream with `fetch()` and a stream reader instead, and reconnect itself after `closed` or a network error. The demo's facet provider (`example_applications/faceting_demo/source/providers/Pict-Provider-Facet.js`) implements both transports; [The Faceting Demo](#/page/examples/Faceting_Demo) shows it running.

A `401`, `403` or `429` refusal will not succeed on retry; stop until the principal changes. A `5xx` or a dropped connection is worth retrying with backoff.

## Related

- [Caching and Invalidation](#/page/Caching_And_Invalidation)
- [Configuration](#/page/Configuration) (the `SSE` options)
- [Routes](#/page/api/Routes)
- [Security and Tenancy](#/page/Security_And_Tenancy)
