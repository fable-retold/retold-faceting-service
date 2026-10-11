# Describe

Describe tells a client what it may facet: every entity the principal can read, its auto and declared facets with their folds, its named scopes with their parameters, and the limits and engines in force. A facet UI can be built from it without any knowledge of the model; the demo's Bookstore explorer is.

## Routes

| Route | Answers |
|---|---|
| `GET /1.0/Facet/Describe` | Every entity the principal may facet. |
| `GET /1.0/Facet/Describe/:Entity` | One entity. |
| `GET /1.0/Facet/:Entity/Describe` | The same as `/Describe/:Entity`. |

Describe depends on the principal, which is resolved first: on a host with a scope policy an anonymous request is `401 FACET_UNAUTHENTICATED` (unless `Catalog.AllowAnonymous` lists entities). Then:

- An entity the principal may not facet is left out of the list, and asking for it by name answers `404 FACET_UNKNOWN_ENTITY`, the same as an entity that does not exist.
- Foreign-key targets the principal cannot read are not named either.
- Declared facets and named scopes are listed only when the principal may facet every entity they read.

Describe answers carry the standard headers but no `ETag`.

## An Example

`GET /1.0/Facet/Describe/Book` on the Bookstore fixture (no scope policy), captured. Five of the seven auto facets are cut; nothing else is changed.

```json
{
	"ContractVersion": 1,
	"ModelVersion": "m:20a069fdedea",
	"Role": "Embedded",
	"ScopeAssurance": "Unscoped",
	"TimeZones": [ "UTC" ],
	"Limits": { "MaxFacets": 20, "MaxTop": 500, "MaxBuckets": 500, "MaxDateBuckets": 400, "MaxHops": 4, "TimeoutMS": 10000 },
	"Freshness": { "DefaultMode": "Exact", "MaxLagMS": 5000, "ReadYourWritesMS": 10000 },
	"Engines":
	{
		"Live": { "Available": true, "Dialect": "SQLite" },
		"ClickHouse": { "Available": false, "Configured": false }
	},
	"Cache": { "Enabled": false },
	"Changes": { "Intake": "Interim", "Stream": null },
	"Entities":
	{
		"Book":
		{
			"Entity": "Book",
			"DisplayName": "Books",
			"ScopeAssurance": "Unscoped",
			"Facets":
			[
				{
					"Facet": "Book.CreateDate", "Field": "CreateDate", "DisplayName": "Create Date", "DataType": "DateTime",
					"Folds": [ "DateHistogram", "Stats", "Missing" ], "DefaultFold": "DateHistogram",
					"ClauseType": "DateRange", "FilterKey": "CreateDate",
					"Intervals": [ "day", "week", "month", "quarter", "year" ], "DefaultInterval": "month",
					"Labels": false, "Selectable": true, "Engines": [ "Live" ], "Auto": true
				},
				{
					"Facet": "Book.Language", "Field": "Language", "DisplayName": "Language", "DataType": "String",
					"Folds": [ "Terms", "Missing", "DistinctCount" ], "DefaultFold": "Terms",
					"ClauseType": "DistinctSelectedValueList", "FilterKey": "Language",
					"Labels": false, "Selectable": true, "Engines": [ "Live" ], "Auto": true
				}
			],
			"Scopes": [],
			"Dates": [ "CreateDate", "UpdateDate" ],
			"Numeric": [ "PublicationYear" ],
			"Categorical": [ "Type", "Genre", "ISBN", "Language" ]
		}
	},
	"Entity": "Book"
}
```

## Top-Level Fields

| Field | Meaning |
|---|---|
| `ContractVersion` | `1`. |
| `ModelVersion` | The same value every envelope carries; it changes when the model, the catalog options, the scope policy or the definitions change. A client can cache a Describe until it does. |
| `Role` | `'Embedded'`. |
| `ScopeAssurance` | How the host scopes data: `'Unscoped'` (no scope policy), `'Guarded'` (a policy enforced on every scoped entity), `'Spoofable'` (sessions may come from request headers, `Scope.AllowHeaderSession`). |
| `TimeZones` | `[ <Time.StorageTimeZone> ]`: the only time zone a request may name. |
| `Limits` | `MaxFacets`, `MaxTop`, `MaxBuckets`, `MaxDateBuckets`, `MaxHops`, `TimeoutMS` as configured. |
| `Freshness` | `DefaultMode`, `MaxLagMS`, `ReadYourWritesMS`. |
| `Engines.Live` | `{ Available, Dialect }`: the SQL dialect facets run on (`SQLite`, `PostgreSQL`, `MySQL`, `MSSQL`). |
| `Engines.ClickHouse` | `{ Available: false, Configured: false }` without a store. With one: `{ Configured, Available }`, plus `Reason` and `Entities: { <Entity>: { State, LagMS, Exact } }` for principals allowed to see store detail (see below). |
| `Cache` | `{ Enabled }`: whether answers may come from the result cache (and a `304` may skip all SQL). |
| `Changes` | `{ Intake, Stream }`: the change source (`'Interim'`, `'Bus'` or `'None'`) and the change-feed path, or `null` when the feed is not mounted. |
| `Entities` | Entity name → entity block. |
| `Entity` | Present on the one-entity routes: the entity asked for. |

## Entity Blocks

| Field | Meaning |
|---|---|
| `Entity`, `DisplayName` | The entity and its display name (`Catalog.<Entity>.DisplayName`, else a plural of the name). |
| `ScopeAssurance` | For this entity: `'Unscoped'`, `'Guarded'`, `'Global'` (a policy host's entity with no scope column, listed in `Catalog.GlobalEntities`) or `'Spoofable'`. |
| `Facets` | The auto facets, then the declared facets and siblings. |
| `Scopes` | The named scopes on this entity: `[ { Scope, Description, Params, Relaxed } ]`. `Params` are the declared parameter schemas, defaults included. |
| `Dates`, `Numeric`, `Categorical` | The columns whose auto facet defaults to a DateHistogram, a NumericHistogram, or Terms. A quick way to lay out a UI. |
| `Opaque` | Present when the entity's read-side post-operation behaviors are not vouched for (`Scope.TrustPostOperation`): `{ Reason: 'PostOperation', SafeColumns }`. Facets may then read only `SafeColumns`. |
| `Store` | Present only when a store is configured: `{ ClickHouse: { Materialized, Reason, Watermark } }`, plus `State` for principals allowed to see store detail. `Reason` is `null`, `'NotDeclared'`, `'Disabled'` or `'LossyColumn'` (`'LossyColumn:<Column>'` for principals allowed to see store detail, with `Stores.ClickHouse.ExposeReasons`). |

### Auto Facet Descriptors

| Field | Meaning |
|---|---|
| `Facet`, `Field` | The FacetID and its column. |
| `DisplayName` | From `Catalog.<Entity>.DisplayNames`, else the column name with spaces (a foreign key loses its `ID` prefix: `IDBook` → `Book`). |
| `DataType` | The column's Stricture data type. |
| `Folds`, `DefaultFold` | The folds a request may ask for; the first is used when the request names none. |
| `ClauseType`, `FilterKey` | The clause type the default fold's buckets carry, and the `FilterKey` the facet owns. |
| `Intervals`, `DefaultInterval` | DateTime columns: the intervals offered and the default. |
| `Target` | Foreign keys: the referenced entity, when the principal may facet it. |
| `Cardinality` | Present when `Catalog.<Entity>.Cardinality` sets a hint for the column. |
| `Labels` | `true` when Terms buckets get labels from the referenced row. |
| `Selectable` | Whether the default fold's buckets can be selected. |
| `Engines` | `[ 'Live' ]`, or `[ 'Live', 'ClickHouse' ]` when the column is mirrored. |
| `Auto` | `true`. |

### Declared Facet Descriptors

Declared facets and siblings (and, with `Catalog.ListOneHop: true`, the automatic one-hop path facets) are listed after the auto facets. Captured on the Bookstore-Tenant fixture with the demo's definitions, as user 1 of tenant 1:

```json
{
	"Facet": "Book.ReviewRating",
	"Declared": true,
	"Title": "Review rating",
	"Description": "Books by the ratings their reviews gave (a book counts once per distinct rating it received, so the buckets can sum to more than the total).",
	"DisplayName": "Review rating",
	"Folds": [ "Terms" ],
	"DefaultFold": "Terms",
	"Selectable": true,
	"ClauseType": null,
	"FilterKey": "Book.ReviewRating",
	"Path": [ "<Review.IDBook" ],
	"MultiValued": true,
	"CountMode": "PivotDistinct",
	"Relaxed": false,
	"Semantics": null,
	"Params": {},
	"Engines": [ "Live" ],
	"Supported": true,
	"Unsupported": null
}
```

| Field | Meaning |
|---|---|
| `Declared` | `true` for a declared facet or sibling, `false` for an automatic path facet. |
| `Title`, `Description`, `DisplayName` | From the definition. |
| `Folds`, `DefaultFold` | The facet's fold (an automatic path facet offers its target column's bucketed folds). |
| `Selectable`, `ClauseType`, `FilterKey` | As for auto facets. `ClauseType: null` means buckets select by `Selection` only. |
| `Path` | Present for path facets: the step strings. |
| `MultiValued`, `CountMode` | Whether a row can land in several buckets, and what a count means (`Rows`, `PivotDistinct`, `KeyDistinct`). |
| `Relaxed` | `true` when a `TenantOnly` step relaxes a personal scope. |
| `Semantics` | `'NoVisibleMatch'` when the facet counts rows that have no visible related row (`NotExists`, ExistsSplit, ChildRollup), else `null`. |
| `Params` | The parameter schemas the facet declares. |
| `Engines` | `[ 'Live' ]`, or `[ 'Live', 'ClickHouse' ]` when a store mirrors every entity the facet reads. |
| `Supported`, `Unsupported` | `false` and `{ Feature, Milestone }` when the facet uses a feature this version does not serve; a request for it gets `422 FACET_FOLD_UNSUPPORTED`. |

The same Describe lists the demo's named scope in the entity block (everything else cut):

```json
{
	"Entities":
	{
		"Book":
		{
			"Scopes": [ { "Scope": "Book.WellReviewed", "Description": "Books with at least one review rated 4 or 5", "Params": {}, "Relaxed": false } ]
		}
	}
}
```

## Store Detail

Per-entity store state (`State`, `LagMS`, `Exact`) and infrastructure reasons tell an observer how busy the store is, which on a multi-tenant host reveals other tenants' write activity. They are shown when `Stores.ClickHouse.ExposeFreshness` allows it (by default, only on a host without a scope policy), or to a principal for whom `Admin.authorize(pRequest, pPrincipal)` returns `true`. Everyone else sees `{ Configured, Available }`. [The ClickHouse Store](#/page/ClickHouse_Store) describes the states.

## Building a UI from Describe

A generic facet panel needs only Describe and the Query route:

```javascript
let fBuildPanel = (pDescribe, pEntity) =>
{
	let tmpBlock = pDescribe.Entities[pEntity];
	let tmpFacets = tmpBlock.Facets
		.filter((pFacet) => { return (pFacet.Supported !== false); })
		.map((pFacet) => { return { Key: pFacet.Facet, Facet: pFacet.Facet }; });
	// One request for every facet; each bucket's Clause is the filter to add when it is clicked.
	return { Facets: tmpFacets.slice(0, pDescribe.Limits.MaxFacets), Total: true };
};
```

Use `DefaultFold` to choose a widget (a checklist for `Terms`, a range slider for the histograms, a band list for `ChildRollup`), `Intervals` to offer a date granularity, and `Scopes` with their `Params` to offer saved filters. [Bookstore Explorer](#/page/examples/Bookstore_Explorer) walks through a working one.

## Related

- [Routes](#/page/api/Routes)
- [Definitions Files](#/page/Definitions)
- [Configuration](#/page/Configuration) (the `Catalog` options shape the auto facets)
- [Security and Tenancy](#/page/Security_And_Tenancy)
