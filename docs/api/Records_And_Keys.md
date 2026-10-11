# Records, Count and Keys

The facets and the list must agree. So the faceting service also answers the list side of a filter: the matching records, their count and their keys, compiled from the same body by the same code that computes the facets. A list built on these routes always shows the envelope's `Total`, whatever clauses, filter string and named scopes the filter carries.

These answers are always computed Live and exact: the result cache and the ClickHouse store never serve them.

## Routes

| Route | Body | Answer |
|---|---|---|
| `POST /1.0/Facet/:Entity/Records` | filter fields + `Records: { Begin, Cap, Sort }` | A JSON array of records. |
| `POST /1.0/Facet/:Entity/Records/:Begin/:Cap` | filter fields (pict-section-recordset sends `{ Clauses, Experience }`) | A JSON array of records. |
| `POST /1.0/Facet/:Entity/Records/Count` | filter fields | `{ "Count": <n> }` |
| `POST /1.0/Facet/:Entity/Keys` | filter fields + `Cap` | `{ Entity, Keys, Count, Truncated, Version }` |
| `POST /1.0/Facet/:Entity/Scope/:Scope/Records` (and `/Records/:Begin/:Cap`, `/Records/Count`) | as above | As above, with the named scope applied. |

The filter fields are the same as a Query's: `Clauses`, `FilterString`, `Scopes` and `Params` ([The Request Body](#/page/api/Request)). `Facets` is ignored, and `Experience` (which pict-section-recordset sends) is accepted and ignored.

## Records

A `Records` body names the page with `Begin`, `Cap` and an optional `Sort`:

<!-- docs-check: request Fixture=Bookstore Entity=Book Route=Records -->
```json
{
	"Clauses": [ { "Type": "DistinctSelectedValueList", "FilterByColumn": "Language", "Values": [ "fre" ] } ],
	"Records": { "Begin": 0, "Cap": 2, "Sort": [ { "Field": "PublicationYear", "Dir": "DESC" } ] }
}
```

The answer is a bare array of records, exactly as the entity's own list route returns them. Captured on the Bookstore fixture, with each record cut to four of its sixteen columns:

```json
[
	{ "IDBook": 604, "Title": "The Golden Harbor", "Language": "fre", "PublicationYear": 2017 },
	{ "IDBook": 728, "Title": "Their Winter River", "Language": "fre", "PublicationYear": 2017 }
]
```

| Key | Default | Bounds |
|---|---|---|
| `Begin` | `0` | `0` to `Limits.MaxRecordsOffset` (10000) |
| `Cap` | `250` (or `Limits.MaxRecordsPage` if lower) | `1` to `Limits.MaxRecordsPage` (500) |
| `Sort` | primary-key order | At most 4 entries `{ Field, Dir }`. `Dir` is `ASC` (default) or `DESC`, in any case. `Field` must be a filterable column of the entity, else `400 FACET_UNKNOWN_FIELD`. NULLs sort last; the primary key breaks ties. |

A `Begin` or `Cap` out of range is `400 FACET_REQUEST_INVALID` with `Detail: { Field, Max }`.

### The Page in the Path

pict-section-recordset fetches a page by posting its clauses to `<URLPrefix><FilterEndpointOverride>/<Offset>/<PageSize>` and counts by posting to `<URLPrefix><FilterEndpointOverride>/Count`. The `Records/:Begin/:Cap` and `Records/Count` routes are those two URLs. The path's `Begin` and `Cap` replace the body's; a `Records.Sort` in the body is kept. A path segment that is not a non-negative integer of at most nine digits is `400 FACET_REQUEST_INVALID`.

<!-- docs-check: request Fixture=Bookstore Entity=Book Route=Records/0/25 -->
```json
{
	"Clauses": [ { "Type": "DistinctSelectedValueList", "FilterByColumn": "Language", "Values": [ "fre" ] } ],
	"Experience": {}
}
```

<!-- docs-check: request Fixture=Bookstore Entity=Book Route=Records/Count -->
```json
{
	"Clauses": [ { "Type": "DistinctSelectedValueList", "FilterByColumn": "Language", "Values": [ "fre" ] } ]
}
```

```json
{ "Count": 32 }
```

### Pointing a Recordset at the Faceting Routes

Give the recordset configuration a `FilterEndpointOverride` under the default `RecordSetURLPrefix` of `/1.0/`, and its list pages and count come from the faceting service:

```json
{
	"RecordSet": "Book",
	"RecordSetType": "MeadowEndpoint",
	"RecordSetMeadowEntity": "Book",
	"FilterEndpointOverride": "Facet/Book/Records"
}
```

The list then reads `POST /1.0/Facet/Book/Records/<Offset>/<PageSize>` and `POST /1.0/Facet/Book/Records/Count` with the clauses the user picked. For a list inside a named scope, put the scope in the path: `"FilterEndpointOverride": "Facet/MaterialIntakeRequirement/Scope/MaterialIntakeRequirement.ToDoForMe/Records"` is the work list of the [E3 example](#/page/examples/E3_Lab_Forms_To_Fill_Out). [pict-section-recordset](#/doc/pict/pict-section-recordset) documents the rest of the configuration.

### Records Inside a Query

A Query body may carry `Records` too. The envelope then adds the page next to the facets, so one round trip answers both:

<!-- docs-check: request Fixture=Bookstore Entity=Book -->
```json
{
	"Clauses": [ { "Type": "DistinctSelectedValueList", "FilterByColumn": "Language", "Values": [ "fre" ] } ],
	"Facets": [ { "Key": "Genre", "Facet": "Book.Genre", "Top": 3 } ],
	"Records": { "Cap": 1 }
}
```

The envelope gains `Records` (the array), `RecordShape: 'Entity'` and `RecordsDropped`. The records are part of the envelope's `Version`, so a changed record changes the `ETag`. The page always covers the full filter, whatever the facets exclude, and is read Live even when a store answered the facets.

## Count

`Records/Count` returns `{ Count }`: the rows of the full filter. It equals the `Total` of a Query with the same body and, for a filter the stock list routes can express (no named scopes or join clauses), the count of the entity's own list. The demo's "Verify with Records/Count" button checks the first of these on every answer.

## Keys

`Keys` returns every primary key of the full filter, in primary-key order, up to `Cap` (default and maximum `Limits.MaxKeys`, 50000), with the full count:

<!-- docs-check: request Fixture=Bookstore Entity=Book Route=Keys -->
```json
{
	"Clauses": [ { "Type": "DistinctSelectedValueList", "FilterByColumn": "Language", "Values": [ "fre" ] } ],
	"Cap": 5
}
```

```json
{
	"Entity": "Book",
	"Keys": [ 69, 138, 180, 182, 210 ],
	"Count": 32,
	"Truncated": true,
	"Version": "fv1:602c75b166a404f2"
}
```

`Truncated` is `true` when more keys matched than `Cap`. The keys are what a bulk action should work on: call `keys()` in process with the user's own request ([JavaScript API](#/page/api/JavaScript_API)) rather than trusting a list of keys a client posts back, so the action covers exactly the rows that user may see.

## Named Scopes in the Path

The `/Scope/:Scope/` forms apply a named scope before any other filter. The scope's parameters come from the top-level `Params` (only the names that scope declares); the rest of the body is unchanged. On the ProjectTrack fixture, as user 1 of tenant 1, the first three projects that user owns or leads, by name:

<!-- docs-check: request Fixture=ProjectTrack Entity=Project Scope=Project.MyProjects Route=Records/0/3 User=1 Tenant=1 -->
```json
{
	"Params": { "Roles": [ "Owner", "Lead" ] },
	"Records": { "Sort": [ { "Field": "Name" } ] }
}
```

```json
[
	{ "IDProject": 1, "Name": "Atlas 1", "Status": "Active", "IDClient": 3, "OwnerIDUser": 5, "IDCustomer": 1 },
	{ "IDProject": 4, "Name": "Atlas 4", "Status": "Active", "IDClient": 9, "OwnerIDUser": 1, "IDCustomer": 1 },
	{ "IDProject": 9, "Name": "Atlas 9", "Status": "Active", "IDClient": 3, "OwnerIDUser": 1, "IDCustomer": 1 }
]
```

(Each record is cut to six of its fifteen columns.) `POST /1.0/Facet/Project/Scope/Project.MyProjects/Records/Count` with the same body answers `{ "Count": 15 }`, and `…/Scope/Project.MyProjects/Query` gives `Total: 15`. An unknown scope, or a scope of another entity, is `400 FACET_UNKNOWN_SCOPE`.

## How Records Are Read

The page is produced in two steps, so a record list can never show a row the entity's own list would hide:

1. **Keys.** One statement selects the primary keys of the page, under the full filter and every scope, in the requested order.
2. **Records.** The keys are read back through the entity's own list path: a fresh query on its data access layer with the request's column filters and `primary key IN (keys)`, the soft-delete filter (unless the filter names the delete column itself), the entity's own `Reads-QueryConfiguration` behavior, the read, and then its `Reads-PostOperation` behavior. Records come back in the order of the page's keys (the requested `Sort`, then the primary key).

A key that no longer reads back (the row was deleted, moved to another tenant or changed hands between the two steps) is dropped. The number dropped is in the `X-Retold-Facet-Records-Dropped` header (or the envelope's `RecordsDropped`).

An entity whose list behavior rewrites the query in a way the service cannot read back is refused with `500 FACET_SCOPE_POLICY_VIOLATION` rather than read without its scope. [Security and Tenancy](#/page/Security_And_Tenancy) explains when that happens.

## Headers and Errors

Each route sets the standard headers, an `ETag` from the answer's `Version`, and `X-Retold-Facet-Scope-Repaired` when a scope had to be repaired; a matching `If-None-Match` answers `304` ([Routes](#/page/api/Routes)). The `Version` covers the keys, the count, the page and (for Records) the records themselves, so an edited record with the same keys still gets a new `ETag`.

Errors are the same as a Query's filter errors ([Errors and Limits](#/page/api/Errors_And_Limits)): `400` for a bad body, field, clause, scope or parameter; `401`, `403` and `404` for the principal and the entities; `422 FACET_TOO_LARGE` for too many scopes.

## Related

- [The Request Body](#/page/api/Request)
- [Routes](#/page/api/Routes)
- [JavaScript API](#/page/api/JavaScript_API)
- [pict-section-recordset](#/doc/pict/pict-section-recordset)
