# API Reference

The faceting service speaks JSON over HTTP under one route prefix (default `/1.0/Facet`) on the host's own [Orator](#/doc/orator/orator) server, and offers the same operations in process to the host. This section is the reference for both.

## Routes at a Glance

All routes live under the route prefix (default `/1.0/Facet`). [Routes](#/page/api/Routes) is the authoritative table: when each route mounts, how bodies are read, and every header.

- `POST /:Entity/Query`: facets, `Total` and optionally a page of records ([The Request Body](#/page/api/Request), [The Response Envelope](#/page/api/Envelope))
- `POST /:Entity/Records`, `/:Entity/Records/:Begin/:Cap`, `/:Entity/Records/Count` and `/:Entity/Keys`: the list side, in the form [pict-section-recordset](#/doc/pict/pict-section-recordset) speaks ([Records, Count and Keys](#/page/api/Records_And_Keys))
- `POST /:Entity/Scope/:Scope/…`: the same routes inside a named scope
- `GET /Describe`, `/Describe/:Entity`, `/:Entity/Describe`: what the principal may facet ([Describe](#/page/api/Describe))
- `GET /Changes`: server-sent change events, when enabled ([The Change Feed](#/page/api/Change_Feed))
- `POST /Admin/…`: store maintenance, only with `Admin.Routes: true`

## A Request and Its Answer

A Query body says what to filter and what to compute:

<!-- docs-check: request Fixture=Bookstore Entity=Book -->
```json
{
	"Clauses": [ { "Type": "DistinctSelectedValueList", "FilterByColumn": "Language", "Values": [ "eng" ], "FilterKey": "Language", "Hash": "Language-eng" } ],
	"Facets":
	[
		{ "Key": "ByYear", "Facet": "Book.PublicationYear", "Buckets": 10 },
		{ "Key": "ByLanguage", "Facet": "Book.Language", "Top": 8 }
	],
	"Total": true
}
```

The answer is an envelope: `Total` (862 English books on the Bookstore fixture), and per facet a result whose buckets each carry a `Count`, a `Label` and the `Clause` that selects it. `ByLanguage` owns the `Language-eng` clause, so it is counted without it and still lists the eight most common languages, with `eng` (862) marked `Selected`; `ByYear` counts within the 862. [The Response Envelope](#/page/api/Envelope) walks through a full answer field by field.

## Headers Every Answer Carries

| Header | Value |
|---|---|
| `Cache-Control` | `private, no-cache` |
| `Vary` | `Cookie, Authorization` |
| `X-Retold-Facet-Contract` | `1`, the contract version |
| `ETag` | `W/"<Version>"` on `Query`, `Records`, `Count` and `Keys`; send it back in `If-None-Match` for a `304` |

The contract version is `1`. It is in every answer's `X-Retold-Facet-Contract` header and in the `ContractVersion` field of every envelope and Describe; a client can refuse a contract it does not know.

## Principals and Errors

Every route acts for the principal of the host's own session, exactly as the entity's list routes do. The principal is checked once the JSON body has been read, before the body is interpreted. Facets are never more permissive than the list: a facet counts only the rows the principal's list would show. [Security and Tenancy](#/page/Security_And_Tenancy) explains how.

Errors have one shape, `{ "Error": { Code, Status, Message, Detail } }` for the whole request or an entry of the envelope's `Errors` for one facet. [Errors and Limits](#/page/api/Errors_And_Limits) lists every code and every limit.

## In Process

The host can call the same operations directly on `fable.RetoldFacetingService`: `query`, `records`, `count`, `keys`, `describeRequest`, plus `notify` to report writes the service cannot see, `status` for monitoring, `storeAdmin` and `shutdown`. See [JavaScript API](#/page/api/JavaScript_API).

## Pages in This Section

- [Routes](#/page/api/Routes): every route, body rules, headers, conditional requests, admin routes.
- [The Request Body](#/page/api/Request): filters, facets, records, freshness.
- [The Response Envelope](#/page/api/Envelope): envelope, facet result and bucket fields.
- [Describe](#/page/api/Describe): discovering entities, facets and scopes.
- [Records, Count and Keys](#/page/api/Records_And_Keys): the list side of the same filter.
- [The Change Feed (SSE)](#/page/api/Change_Feed): change notifications for browsers.
- [Errors and Limits](#/page/api/Errors_And_Limits): codes, statuses and limits.
- [JavaScript API](#/page/api/JavaScript_API): module exports and in-process methods.
