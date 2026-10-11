# The Request Body

Every facet route that takes a body takes the same JSON object: the filter the list would apply, plus what to compute over it. A Query reads all of it; the Records, Count and Keys routes read the filter fields and ignore `Facets`.

The service checks the body before it looks at the model, runs no SQL until the whole body is valid, and refuses features it does not support instead of ignoring them, so a client never receives an unfiltered answer by mistake.

## Fields

| Field | Type | Default | Read by | Meaning |
|---|---|---|---|---|
| `Clauses` | array | `[]` | every route | pict filter clauses, as pict-section-recordset sends them. |
| `FilterString` | string | none | every route | A meadow-filter string (`FBV~Language~EQ~eng`). |
| `Scopes` | array | `[]` | every route | Named scopes to apply: `[ { "Scope": "<Entity>.<Name>", "Params": { … } } ]`. |
| `Params` | object | `{}` | every route | Values for the `$Param` tokens of the declared facets the request names (and of the route scope). |
| `Facets` | array | (required) | Query | What to compute. 1 to `Limits.MaxFacets` entries. |
| `Total` | boolean | `true` | Query | Also count the rows of the full filter (the envelope's `Total`). |
| `Records` | object or `false` | none | Query, Records | A page of the matching rows: `{ Begin, Cap, Sort }`. |
| `Cap` | integer | `Limits.MaxKeys` | Keys | The most keys to return. |
| `Freshness` | object | `{ "Mode": <Freshness.DefaultMode> }` | Query | Which cached or stored answers are acceptable. |
| `Engine` | string | `'Auto'` | Query | `'Auto'` or `'Live'`. `'Live'` never uses the ClickHouse store. |
| `TimeoutMS` | number | `Limits.TimeoutMS` | every route | This request's deadline; can only shorten the configured one. |
| `Experience` | any | — | — | Accepted and ignored (pict-section-recordset sends it). |

Other top-level keys are ignored, within the body limits. These are refused:

| Body | Answer |
|---|---|
| A non-empty `Selections` array, or a `FacetSelection` clause | `422 FACET_FOLD_UNSUPPORTED` (`Feature: 'Selections'`) |
| `FilterExperience` | `422 FACET_FOLD_UNSUPPORTED` (`Feature: 'FilterExperience'`) |
| The legacy recordset facet payload (`Fields` / `Ranges` with no `Facets` array) | `400 FACET_REQUEST_INVALID` (`Reason: 'LegacyPayload'`) |
| A facet with a `Definition` | `403 FACET_ADHOC_FORBIDDEN` |

> **Planned.** Selections (selecting buckets by `{ Facet, Key }` instead of by clause) and inline facet definitions are designed but not accepted by this version.

## A Complete Example

Sales paid by card in 2023 or later, with three facets: payment methods, sales per year and the amount statistics.

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale -->
```json
{
	"Clauses":
	[
		{ "Type": "DistinctSelectedValueList", "FilterByColumn": "PaymentMethod", "Values": [ "Credit", "Debit" ], "FilterKey": "PaymentMethod", "Hash": "Pay-Card" }
	],
	"FilterString": "FBV~SaleDate~GE~2023-01-01",
	"Facets":
	[
		{ "Key": "Payment", "Facet": "BookStoreSale.PaymentMethod", "Top": 5 },
		{ "Key": "ByYear", "Facet": "BookStoreSale.SaleDate", "Interval": "year" },
		{ "Key": "Amount", "Facet": "BookStoreSale.TotalAmount", "Fold": "Stats" }
	],
	"Total": true
}
```

The `Payment` facet owns the `Pay-Card` clause (its `FilterKey` is the facet's column), so it is counted without that clause and still shows `Cash` and `Online` next to the two selected methods. `ByYear` owns the filter string's `SaleDate` term the same way: it shows every year, with 2023 and 2024 marked `Selected`. `Amount` is a Stats facet, which excludes nothing, so it is counted with both filters, like the `Total`. [The Response Envelope](#/page/api/Envelope) shows the answer's shape.

## Filters

The three filter inputs combine with AND. Every clause, every term of the filter string and every scope becomes one top-level *conjunct* of the request's filter; disjunctive faceting decides per facet which conjuncts it ignores.

### Clauses

`Clauses` takes the clause objects pict-section-recordset builds. Each has a `Type`; most also carry `FilterByColumn` (or `FilterByColumns`), `Values`, and the optional `Hash` and `FilterKey` that tie the clause to a facet.

| Type | Values | Becomes |
|---|---|---|
| `DistinctSelectedValueList` | `Values: [ … ]` | `column IN (…)`; with several columns, an OR across them. `null` values are skipped. |
| `DateRange`, `NumericRange`, `StringRange`, `Range` | `Values: { Start, End }`, optional `StartExclusive`, `EndExclusive` | `>= Start` (`>` when exclusive) and `<= End` (`<` when exclusive). A bound that is missing, `null` or `''` is left out (for `DateRange`, so is `'0'`); a numeric `0` is a bound. |
| `Match`, `StringMatch`, `DateMatch`, `NumericMatch` | `Values: [ … ]`, optional `ExactMatch` | `=` per value when `ExactMatch` (the default for `DateMatch` and `NumericMatch`), else `LIKE '%value%'`; an OR across columns and values. |
| `RawFilter` | `Value` (or `Filter`): a meadow-filter string | One conjunct that disjunctive faceting never removes. May name the delete column. |
| `NamedScope` | `Scope`, optional `Params` | The named scope, exactly as in `Scopes`. May not take part in an OR group. |
| `InternalJoin…` (ten types: `SelectedValue`, `SelectedValueList`, and each Match and Range type) | `RemoteTable`, `JoinInternalConnectionColumn`, `JoinExternalConnectionColumn`, `ExternalFilterByColumn(s)` or `ExternalFilterTableLookupColumn`, `Values` | A filter on a row this entity references through a model join. The join must exist in the model. |
| `ExternalJoin…` (the same ten) | `JoinTable`, `JoinTableCoreConnectionColumn`, `JoinTableExternalConnectionColumn`, `ExternalFilterByTable`, … | A filter through a join table. Both joins must exist in the model. |

Clause rules:

- Values are coerced by the column's data type: numbers to numbers, booleans to `0` / `1`, dates to `'YYYY-MM-DD HH:mm:ss'`. A value that cannot be coerced, or a string containing `~`, is `400 FACET_FILTER_INVALID`.
- A column that does not exist or is Sensitive is `400 FACET_UNKNOWN_FIELD`. Only `RawFilter` and `FilterString` may name the delete column (to show deleted rows; the envelope then says `IncludesDeleted: true`).
- A clause with `Enabled: false` is skipped. A clause left with no values is skipped too, and `Filter.Warnings` in the envelope gets `FACET_CLAUSE_EMPTY`.
- Clauses that share a `GUIDGroup` with `Junction: 'OR'` combine with OR, as pict renders them. Any OR at the top level makes the whole clause sequence one conjunct, following SQL precedence.
- Every bucket of a facet carries the clause that selects it (`Bucket.Clause`), already in this form; see [The Response Envelope](#/page/api/Envelope).

### FilterString

A meadow-filter string, the format of the list routes' `FilteredTo` segment. It is decoded once (`decodeURIComponent`) and split into four-part stanzas.

| Instruction | Meaning |
|---|---|
| `FBV`, `FBVOR` | Filter by value (AND / OR). |
| `FBL`, `FBLOR` | Filter by list; the operator must be `INN` or `NIN`, the value a comma-separated list. |
| `FOP`, `FOPOR`, `FCP` | Open a group (AND / OR) and close it. One level of nesting. |
| `FSF` | Sort: removed, with the warning `FACET_SORT_IGNORED` in `Filter.Warnings`. Facets have no order. |

Operators: `EQ`, `NE`, `GT`, `GE`, `LT`, `LE`, `LK`, `NLK`, `IN` (is null), `NN` (is not null), `INN` (in list), `NIN` (not in list). Any other instruction is `400 FACET_FILTER_INVALID` with `Detail: { Offset, Token, Reason: 'UnsupportedInstruction' }`; an unknown field is `400 FACET_UNKNOWN_FIELD`. Filter-string values are passed to SQL as strings, as the list routes pass them.

### Scopes and Params

`Scopes` names server-defined filters. Each entry is `{ "Scope": "<Entity>.<Name>", "Params": { … } }`; the scope must belong to the route entity. Scopes are never removed by disjunctive faceting.

`Params` at the top level supplies the `$Param` values of the declared facets the request names. Each scope reference carries its own `Params`. [Definitions Files](#/page/Definitions) describes parameter types and the `FACET_PARAM_INVALID` reasons.

This request runs on the ProjectTrack fixture as user 1 of tenant 1: the projects where that user is an owner or lead, by status and client.

<!-- docs-check: request Fixture=ProjectTrack Entity=Project User=1 Tenant=1 -->
```json
{
	"Scopes": [ { "Scope": "Project.MyProjects", "Params": { "Roles": [ "Owner", "Lead" ] } } ],
	"Facets":
	[
		{ "Key": "Status", "Facet": "Project.Status" },
		{ "Key": "Client", "Facet": "Project.IDClient", "Top": 5 }
	]
}
```

## Facets

Each entry of `Facets` asks for one facet. Only `Facet` is required.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `Facet` | string, or array of two | (required) | A FacetID (below), or two FacetIDs with `Fold: 'Pivot'`. |
| `Key` | string | the FacetID (two joined by `\|` for a pivot) | The facet's key in the envelope's `Facets` and `Errors`. Unique within the request; may not start with `#`. |
| `Fold` | string | the facet's default fold | One of the facet's folds: `Terms`, `DateHistogram`, `NumericHistogram`, `Ranges`, `Stats`, `DistinctCount`, `Missing`, `Pivot`, `ChildRollup`, `ExistsSplit`. |
| `Top` | integer ≥ 1 | `Limits.DefaultTop` (20) | Terms: buckets kept, by count. Pivot: keys kept per axis (default `Limits.MaxTop`). Clamped to `Limits.MaxTop`, with the warning `FACET_TOP_CLAMPED`. |
| `Order` | string | by count for Terms and pivot axes, by key for the bucketed histograms | `CountDesc`, `KeyAsc` or `KeyDesc`. `Top` always keeps the largest counts; `Order` only sorts what was kept. On a DateHistogram, NumericHistogram or ChildRollup, `KeyDesc` reverses the key order. |
| `Missing` | boolean | `true` | Report rows with no value in `MissingCount`. `false` folds them into `OtherCount`. |
| `Interval` | string | the facet's default (`Time.DefaultInterval`) | DateHistogram: `day`, `week`, `month`, `quarter` or `year`. |
| `EmptyBuckets` | boolean | `true` | DateHistogram: fill the gaps between the first and last bucket with zero-count buckets. |
| `TimeZone` | string | `Time.StorageTimeZone` | Only the storage time zone is accepted; any other is `422 FACET_TIMEZONE_UNSUPPORTED`. |
| `Buckets` | integer ≥ 1 | `Limits.DefaultBuckets` (20) | NumericHistogram, `Nice` mode: the target bucket count. Clamped to `Limits.MaxBuckets`, with the warning `FACET_BUCKETS_CLAMPED`. |
| `Mode` | string | `'Nice'` (`'Edges'` when `Edges` is given) | NumericHistogram: `Nice` (round-width buckets over the data's range) or `Edges` (your edges). `Log` is `422 FACET_FOLD_UNSUPPORTED`. |
| `Edges` | array of numbers | none | NumericHistogram `Edges` mode: 2 to `Limits.MaxBuckets` + 1 strictly ascending numbers. |
| `OpenEnded` | boolean | `false` | `Edges` mode: the last bucket has no upper bound. |
| `Ranges` | array | none | Ranges: 1 to `Limits.MaxBuckets` entries `{ Key, From, To, Label }`. `From` inclusive, `To` exclusive, either may be `null`; `Key` unique. A row lands in the first range that holds it. |
| `Exclude` | `'Self'`, `'None'` or array | `'Self'` for Terms, DateHistogram, NumericHistogram, Ranges; else `'None'` | Disjunctive policy: ignore the request's own filters on this facet (`Self`), keep them all (`None`), or ignore exactly the listed clause `Hash` values or conjunct Ids (`c1`, `c2`, …). |
| `CountMode` | string | — | Only `'Rows'` is accepted here; any other value is `422 FACET_FOLD_UNSUPPORTED`. Declared facets set their own count mode. |
| `Labels` | boolean | — | `false` skips the label lookup of a foreign-key Terms facet (keys only). |
| `Chart` | boolean | `false` | Add a `Chart` projection (`Labels` and `Datasets`) to the facet result. |

A declared facet takes its defaults from its definition; the request may still override `Top`, `Order`, `Missing`, `Interval`, `EmptyBuckets`, `Buckets`, `Mode`, `Edges`, `OpenEnded`, `Ranges`, `Exclude`, `Labels: false` and `Chart`.

### FacetIDs

| Form | Example | Facet |
|---|---|---|
| `Entity.Column` | `Book.Language` | The auto facet of a column. |
| `Entity.Name` | `Book.ReviewRating` | A declared facet. |
| `Entity.Name/Sibling` | `Review.BookGenre/ByBookType` | A declared facet's sibling. |
| `Entity.Column>Target.Column` | `Review.IDBook>Book.Language` | An automatic one-hop path facet: bucket rows by a column of the row a foreign key references. |

Every FacetID must start with the route entity. A FacetID that does not parse is `400 FACET_REQUEST_INVALID` for the whole request; a well-formed one that names no facet is a per-facet `FACET_UNKNOWN_FACET` in the envelope's `Errors`.

A `Fold` the facet does not offer is a per-facet error too: that facet's `Errors` entry is `FACET_UNKNOWN_FOLD` (status 400) with `Detail: { Facet, Fold, Folds }`, and the other facets are still answered. Only a fold name that does not exist at all fails the whole request (`400 FACET_UNKNOWN_FOLD` with `Detail: { Index, Fold }`). [Fold Kinds](#/page/Fold_Kinds) describes every fold.

`Fold: 'Pivot'` takes `Facet` as an array of exactly two FacetIDs and counts the combinations ([K14 Pivot](#/page/fold_kinds/014-pivot)). `Interval` and `Top` apply to both axes.

This request uses Ranges, a NumericHistogram with explicit edges, DistinctCount, Missing and a Pivot:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale -->
```json
{
	"FilterString": "FBV~SaleDate~GE~2023-01-01",
	"Facets":
	[
		{ "Key": "AmountBands", "Facet": "BookStoreSale.TotalAmount", "Fold": "Ranges",
		  "Ranges": [ { "Key": "small", "To": 50, "Label": "Under 50" }, { "Key": "mid", "From": 50, "To": 200 }, { "Key": "large", "From": 200 } ] },
		{ "Key": "AmountEdges", "Facet": "BookStoreSale.TotalAmount", "Edges": [ 0, 100, 500, 1000 ], "OpenEnded": true },
		{ "Key": "Methods", "Facet": "BookStoreSale.PaymentMethod", "Fold": "DistinctCount" },
		{ "Key": "NoStore", "Facet": "BookStoreSale.IDBookStore", "Fold": "Missing" },
		{ "Key": "MethodByYear", "Facet": [ "BookStoreSale.PaymentMethod", "BookStoreSale.SaleDate" ], "Fold": "Pivot", "Interval": "year", "Top": 3 }
	],
	"Total": true
}
```

## Total, Records and Cap

`Total: true` (the default on a Query) adds the row count of the full filter, with every clause and scope applied. It is the number a list with the same filter shows, and the number `Records/Count` returns.

`Records` on a Query adds one page of the matching rows to the envelope, read through the entity's own list behaviors. It takes `{ Begin, Cap, Sort }`:

| Key | Default | Bounds |
|---|---|---|
| `Begin` | `0` | `0` to `Limits.MaxRecordsOffset` (10000) |
| `Cap` | `250` (or `Limits.MaxRecordsPage` if lower) | `1` to `Limits.MaxRecordsPage` (500) |
| `Sort` | primary-key order | At most 4 `{ Field, Dir }` entries; `Dir` is `ASC` (default) or `DESC`. `Field` must be a filterable column of the entity. NULLs sort last; the primary key breaks ties. |

`Records: false` (or `null`) asks for none. `Cap` at the top level is read only by the Keys route. [Records, Count and Keys](#/page/api/Records_And_Keys) covers the record routes.

<!-- docs-check: request Fixture=Bookstore Entity=Book -->
```json
{
	"Clauses": [ { "Type": "DistinctSelectedValueList", "FilterByColumn": "Language", "Values": [ "fre" ] } ],
	"Facets": [ { "Key": "Genre", "Facet": "Book.Genre", "Top": 3 } ],
	"Records": { "Begin": 0, "Cap": 10, "Sort": [ { "Field": "PublicationYear", "Dir": "DESC" } ] }
}
```

## Freshness, Engine and TimeoutMS

`Freshness` matters only when the result cache or the ClickHouse store is on; with both off every answer is computed Live and exact.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `Mode` | string | `Freshness.DefaultMode` (`'Exact'`) | `Exact`: only an answer proven current. `Bounded`: a cached answer up to `MaxLagMS` old is acceptable. `Fast`: any cached answer within `Cache.MaxAgeMS` is acceptable. |
| `MaxLagMS` | integer | `Freshness.MaxLagMS` (5000) | `0` to `Cache.MaxAgeMS`. |
| `MinSeq` | string | none | A change sequence (`'e:<8 hex>:<n>'`, from `X-Retold-Facet-Seq`) the answer must include; makes the request Exact. The header `X-Retold-Facet-MinSeq` does the same when the body has none. |

A principal that wrote recently is answered `Exact` whatever it asks for (read-your-writes). [Caching and Invalidation](#/page/Caching_And_Invalidation) explains the modes; [The ClickHouse Store](#/page/ClickHouse_Store) explains how they route facets.

`Engine: 'Live'` keeps every facet on the Live engine even when a store could answer. `TimeoutMS` shortens the request's deadline; a facet still running at the deadline gets `FACET_TIMEOUT` in `Errors`.

<!-- docs-check: request Fixture=Bookstore Entity=Book -->
```json
{
	"Facets": [ { "Key": "Language", "Facet": "Book.Language", "Top": 5 } ],
	"Freshness": { "Mode": "Bounded", "MaxLagMS": 2000 },
	"Engine": "Live",
	"TimeoutMS": 3000
}
```

## Validation

A request is checked in this order, and the first failure answers the whole request:

1. The route reads the body: `application/json` only, at most `Limits.MaxBodyBytes` (256 KiB), and it must parse (`400 FACET_REQUEST_INVALID` with `Reason` `UnsupportedContentType`, `BodyTooLarge` or `BodyNotJSON`).
2. The principal is resolved from the host's session (`401 FACET_UNAUTHENTICATED`).
3. The body's shape: nesting depth, `Clauses` count, string and array lengths (`Detail.Limit`), then field shapes and values facet by facet (`Detail.Field`, `Detail.Index`, often `Detail.Reason`). These answer `400` (or `422` for a feature this version does not serve).
4. The route entity is gated (`404 FACET_UNKNOWN_ENTITY`).
5. Clauses, the filter string, scopes and parameters are checked against the model and the definitions, and every entity a scope or join clause reads is gated (`400`, `403`).

After that, problems with one facet (an unknown FacetID, an interval that gives too many buckets, a timeout) are reported per facet in the envelope's `Errors`, and the other facets are still answered. [Errors and Limits](#/page/api/Errors_And_Limits) lists every code.

This request asks for daily buckets over four years of sales. The facet fails on its own; the request still answers `200` with the `Total`:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale Expect=FACET_INTERVAL_TOO_FINE -->
```json
{
	"Facets": [ { "Key": "ByDay", "Facet": "BookStoreSale.SaleDate", "Interval": "day" } ]
}
```

```json
{
	"ByDay":
	{
		"Code": "FACET_INTERVAL_TOO_FINE",
		"Status": 422,
		"Message": "The interval produces too many buckets.",
		"Detail": { "Interval": "day", "MaxDateBuckets": 400, "Suggest": { "Interval": "week" } }
	}
}
```

## Checking a Body in the Browser

The request rules live in `source/contract/Facet-Contract-Request.js`, which requires nothing outside `source/contract/`. A client can run the same check before it sends a body:

```javascript
const libFacetRequest = require('retold-faceting-service/source/contract/Facet-Contract-Request.js');

try
{
	let tmpNormalized = libFacetRequest.normalizeRequest('Book', tmpBody, { Limits: { MaxFacets: 20 } });
	// tmpNormalized.Facets, .Clauses, .Warnings …
}
catch (pError)
{
	// pError.Code, pError.Status, pError.Detail: the same 400 / 403 / 422 the server would answer
}
```

## Related

- [Routes](#/page/api/Routes)
- [The Response Envelope](#/page/api/Envelope)
- [Records, Count and Keys](#/page/api/Records_And_Keys)
- [Errors and Limits](#/page/api/Errors_And_Limits)
- [pict-section-recordset](#/doc/pict/pict-section-recordset), which builds the clauses
