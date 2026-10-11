# Getting Started

This guide installs the faceting service on a retold-data-service, asks it what can be faceted, runs a first query, narrows it the way a list page would, and pages through the matching rows. Every request and every number below comes from a real run on the Bookstore model the module's tests use.

## Prerequisites

- A [retold-data-service](#/doc/meadow/retold-data-service) application with a compiled Stricture model (`MeadowModel-Extended.json`), running on SQLite or PostgreSQL. Those two databases are tested end to end.
- Familiarity with [meadow-endpoints](#/doc/meadow/meadow-endpoints) list routes and their behaviors. Facets are computed through the same behaviors, so whatever your lists filter, the facets filter too.

**Compatible with:** retold-data-service 2.1 or later, the meadow-endpoints 4.0 and 4.1 lines (the test suites run on both), and `fable` 3.1 as a peer dependency. The tests run on Node 22.

> **Warning.** On **MySQL** and **MSSQL** the service installs and runs its statements, but they are only checked against golden SQL and have never run against a real server. Treat those databases as unsupported for now; [Hosting](#/page/Hosting) has the details.

On PostgreSQL the process does not need to run in UTC. Facet keys are formatted in SQL, so buckets do not depend on the process time zone, and `Records` come back through the entity's own list read, so their dates look exactly like your list routes' dates.

The examples use the Bookstore model from `test/fixtures/Bookstore-Model.json`, seeded by `test/fixtures/Bookstore-Seed.js`, with no tenancy. Your own model works the same way; only the entity and column names change.

## Try It Without Your Own App

Every request on this page can be sent to a seeded Bookstore server the module's tests use. Save this as `try-facets.js` at the root of a checkout of the module, and run `node try-facets.js`:

```javascript
const libHarness = require('./test/support/Facet-Test-Harness.js');

let _Harness = libHarness.start({ Port: 19195, FixedPort: true, Host: '127.0.0.1', Fixture: 'Bookstore', LogLevel: 'error' },
	(pError) =>
	{
		if (pError)
		{
			console.error(`The playground did not start: ${pError.message}`);
			return _Harness.stop(() => { process.exit(1); });
		}
		console.log(`Bookstore facets at ${_Harness.baseURL}/1.0/Facet/ (Ctrl+C stops it)`);
	});
```

It prints `Bookstore facets at http://127.0.0.1:19195/1.0/Facet/` and keeps running, with the same seeded data, so you get the same numbers as this page. The harness needs the module's development dependencies: inside the retold monorepo they resolve from the umbrella `node_modules`; in a standalone clone, run `npm install` at the module root first. In the `curl` commands below, use `http://127.0.0.1:19195` in place of `http://localhost:8086`.

## Install

The package has not been published to npm yet. Until it is, install it from a checkout of the module (the demo application does this with a `file:` dependency) or from its git repository:

```bash
npm install /path/to/retold-faceting-service
npm install git+https://github.com/fable-retold/retold-faceting-service.git
```

After the first release, `npm install retold-faceting-service` works too. The service declares `fable` as a peer dependency. A retold-data-service application already has it.

## Install the Service on Your Data Service

Call `installOnRetoldDataService` inside the data service's `initializeService` callback, once the model is loaded and Orator is running:

```javascript
const libFable = require('fable');
const libRetoldDataService = require('retold-data-service');
const libMeadowConnectionSQLite = require('meadow-connection-sqlite');
const libRetoldFacetingService = require('retold-faceting-service');

let _Fable = new libFable(
	{
		Product: 'BookstoreFacets',
		ProductVersion: '1.0.0',
		APIServerPort: 8086,
		SQLite: { SQLiteFilePath: `${__dirname}/data/bookstore.db` }
	});

_Fable.serviceManager.addServiceType('MeadowSQLiteProvider', libMeadowConnectionSQLite);
_Fable.serviceManager.instantiateServiceProvider('MeadowSQLiteProvider');

_Fable.MeadowSQLiteProvider.connectAsync(
	(pConnectError) =>
	{
		if (pConnectError)
		{
			return console.error('SQLite connection failed:', pConnectError);
		}

		_Fable.serviceManager.addServiceType('RetoldDataService', libRetoldDataService);
		let _DataService = _Fable.serviceManager.instantiateServiceProvider('RetoldDataService',
			{
				FullMeadowSchemaPath: `${__dirname}/model/`,
				FullMeadowSchemaFilename: 'MeadowModel-Extended.json',
				StorageProvider: 'SQLite',
				StorageProviderModule: 'meadow-connection-sqlite'
			});

		_DataService.initializeService(
			(pInitError) =>
			{
				if (pInitError)
				{
					return console.error('Startup failed:', pInitError);
				}
				libRetoldFacetingService.installOnRetoldDataService(_DataService,
					{
						// Declared facets and named scopes: every *.json directly in this folder.
						Definitions: { Path: `${__dirname}/facets/` }
					},
					(pInstallError, pFacetingService) =>
					{
						if (pInstallError)
						{
							return console.error('Faceting install failed:', pInstallError);
						}
						// Facets, Records, Count and Keys are now served under /1.0/Facet/
						// (pFacetingService is also _Fable.RetoldFacetingService).
					});
			});
	});
```

The second argument holds the `RetoldFaceting` options. To read `fable.settings.RetoldFaceting` instead, pass `null` (any non-object works) as the second argument; the callback is always the third:

```javascript
libRetoldFacetingService.installOnRetoldDataService(_DataService, null, fInstalled);
```

The two sources are never merged: when you pass an options object, `fable.settings.RetoldFaceting` is ignored entirely. Anything you do not set keeps its default; see [Configuration](#/page/Configuration).

Give `Definitions.Path` an absolute path. A relative one resolves against the process's working directory. A missing folder loads nothing; unless it is the default `facets/`, the service logs a warning and records the load warning `DEFINITIONS_PATH_MISSING`.

The install refuses (and mounts nothing) when the data service is not usable, when the role is not `Embedded`, or when the service is already installed on this fable. It also refuses a model with an entity named like a facet route segment (`Facet`, `Describe`, `Agent`, `Admin`, `Changes` or `Status`).

On a model without a tenancy policy, the service logs this warning once at install:

```text
RetoldFaceting host: no scope policy is configured (ScopeAssurance 'Unscoped'): facets equal the lists the entities' own Reads behaviors produce, but the service cannot tell tenants apart — every write invalidates every principal's cached answers over its entity, and the change stream stays off unless SSE.Enabled is true.
```

That is expected for the single-tenant Bookstore. A multi-tenant application tells the service its policy, as *Tenancy* at the end of this page shows.

## Ask What Can Be Faceted

`GET /1.0/Facet/Describe` lists every entity this principal may facet. `GET /1.0/Facet/Describe/BookStoreSale` lists one:

```bash
curl -s http://localhost:8086/1.0/Facet/Describe/BookStoreSale
```

 This is the per-entity answer, abridged: two of its nine facet descriptors are shown, and a few top-level and descriptor fields (`ModelVersion`, `TimeZones`, `Freshness`, `Changes`, `Labels`, `Engines`) are left out.

```json
{
	"ContractVersion": 1,
	"Role": "Embedded",
	"ScopeAssurance": "Unscoped",
	"Limits": { "MaxFacets": 20, "MaxTop": 500, "MaxBuckets": 500, "MaxDateBuckets": 400, "MaxHops": 4, "TimeoutMS": 10000 },
	"Engines": { "Live": { "Available": true, "Dialect": "SQLite" }, "ClickHouse": { "Available": false, "Configured": false } },
	"Cache": { "Enabled": false },
	"Entity": "BookStoreSale",
	"Entities":
	{
		"BookStoreSale":
		{
			"Entity": "BookStoreSale",
			"DisplayName": "Book Store Sales",
			"Facets":
			[
				{
					"Facet": "BookStoreSale.SaleDate",
					"Field": "SaleDate",
					"DisplayName": "Sale Date",
					"DataType": "DateTime",
					"Folds": [ "DateHistogram", "Stats", "Missing" ],
					"DefaultFold": "DateHistogram",
					"ClauseType": "DateRange",
					"FilterKey": "SaleDate",
					"Intervals": [ "day", "week", "month", "quarter", "year" ],
					"DefaultInterval": "month",
					"Selectable": true,
					"Auto": true
				},
				{
					"Facet": "BookStoreSale.PaymentMethod",
					"Field": "PaymentMethod",
					"DisplayName": "Payment Method",
					"DataType": "String",
					"Folds": [ "Terms", "Missing", "DistinctCount" ],
					"DefaultFold": "Terms",
					"ClauseType": "DistinctSelectedValueList",
					"FilterKey": "PaymentMethod",
					"Selectable": true,
					"Auto": true
				}
			],
			"Scopes": [],
			"Dates": [ "CreateDate", "UpdateDate", "SaleDate" ],
			"Numeric": [ "TotalAmount" ],
			"Categorical": [ "PaymentMethod", "TransactionID", "IDBookStore", "IDUser", "IDCustomer" ]
		}
	}
}
```

Every facet here is an **auto facet**: the service derived it from the model, with no configuration. The FacetID is `Entity.Column`. `Folds` lists the computations you may ask of it, and `DefaultFold` is the one you get when you do not ask. [Describe](#/page/api/Describe) has the full reference.

> **Some column names are never facetable.** A column whose name matches the Sensitive pattern (it contains `Password`, `Hash`, `Secret`, `Token`, `Salt`, `ApiKey`, `Email` or `Phone`, or ends in `Key` or `Code`) is neither facetable nor filterable, even where your list route accepts it. That catches ordinary columns such as `ZipCode`, `CountryCode`, `StatusCode`, `SortKey` and `PhoneType`. On the Bookstore, `BookPrice.CouponCode` is missing from Describe, and a clause on it answers `400 FACET_UNKNOWN_FIELD` on the facet routes while the stock `GET /1.0/BookPrices/Count/FilteredTo/FBV~CouponCode~EQ~SAVE10` answers `{ "Count": 14 }`. Opt a column back in per entity:
>
> ```javascript
> Catalog: { BookPrice: { IncludeSensitive: [ 'CouponCode' ] } }
> ```
>
> With that option the same clause counts 14 on the facet routes too, and `BookPrice.CouponCode` gets a Terms facet.

## Your First Query

Post the facets you want to `POST /1.0/Facet/BookStoreSale/Query`. Each entry needs a `Key` (your name for it in the answer) and a `Facet`. Save this body as `first-query.json`:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale -->
```json
{
	"Facets":
	[
		{ "Key": "ByYear", "Facet": "BookStoreSale.SaleDate", "Interval": "year" },
		{ "Key": "ByMethod", "Facet": "BookStoreSale.PaymentMethod" }
	],
	"Total": true
}
```

Send it with the JSON content type:

```bash
curl -s -X POST http://localhost:8086/1.0/Facet/BookStoreSale/Query -H 'Content-Type: application/json' -d @first-query.json
```

The facet routes accept only JSON bodies. Without the `Content-Type` header, `curl -d` sends a form body, and the answer is `400` with `{ "Error": { "Code": "FACET_REQUEST_INVALID", "Status": 400, "Message": "The request body must be application/json.", "Detail": { "Reason": "UnsupportedContentType" } } }`.

The answer, abridged to the counts (each bucket also carries `Selected`, its `Clause` and a `Selection`):

```json
{
	"Entity": "BookStoreSale",
	"Engine": "Live",
	"Exact": true,
	"Total": 2918,
	"Filter": { "Applied": [], "Warnings": [] },
	"Facets":
	{
		"ByYear":
		{
			"Fold": "DateHistogram",
			"Interval": "year",
			"Total": 2918,
			"SumOfCounts": 2893,
			"MissingCount": 25,
			"Bounds": { "Lo": "2020-12-31 09:33:32", "Hi": "2024-12-30 21:55:33" },
			"Buckets":
			[
				{ "Key": "2020-01-01 00:00:00", "Label": "2020", "Count": 1 },
				{ "Key": "2021-01-01 00:00:00", "Label": "2021", "Count": 711 },
				{ "Key": "2022-01-01 00:00:00", "Label": "2022", "Count": 720 },
				{ "Key": "2023-01-01 00:00:00", "Label": "2023", "Count": 740 },
				{ "Key": "2024-01-01 00:00:00", "Label": "2024", "Count": 721 }
			]
		},
		"ByMethod":
		{
			"Fold": "Terms",
			"Total": 2918,
			"SumOfCounts": 2909,
			"MissingCount": 9,
			"DistinctCount": 5,
			"Buckets":
			[
				{ "Key": "Credit", "Label": "Credit", "Count": 1288 },
				{ "Key": "Debit", "Label": "Debit", "Count": 744 },
				{ "Key": "Cash", "Label": "Cash", "Count": 476 },
				{ "Key": "Online", "Label": "Online", "Count": 384 },
				{ "Key": "", "Label": "", "Count": 17 }
			]
		}
	}
}
```

The service picked the fold from the column type: a DateHistogram for the date and Terms for the string. For a single-valued facet, `SumOfCounts + MissingCount + OtherCount` equals the facet's `Total`. Here 2,893 sales have a sale date and 25 have none. The first bucket holds one sale, because the seed's sales start on 2020-12-31.

## Add the List's Filter

A list page has a filter. Send it as the same pict clause array a [pict-section-recordset](#/doc/pict/pict-section-recordset) would send to its list, here the "paid by credit card" checkbox:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale -->
```json
{
	"Clauses":
	[
		{ "Type": "DistinctSelectedValueList", "FilterByColumn": "PaymentMethod", "Values": [ "Credit" ], "FilterKey": "PaymentMethod", "Hash": "Method" }
	],
	"Facets":
	[
		{ "Key": "ByYear", "Facet": "BookStoreSale.SaleDate", "Interval": "year" },
		{ "Key": "ByMethod", "Facet": "BookStoreSale.PaymentMethod" }
	],
	"Total": true
}
```

The `Total` drops to 1,288, and so does `ByYear` (311, 310, 321 and 335 for 2021 to 2024). `ByMethod` does not change: it reports `Excluded: [ "Method" ]` and still counts all 2,918 sales, with the `Credit` bucket marked `Selected: true`. That is **disjunctive faceting**. A checklist that counted under its own selection would show `Credit 1288` and zero for everything else, and the user could never tick a second box. [Concepts](#/page/Concepts) explains it with a diagram.

The clause's `Hash` is optional. When present, it is the name the envelope uses for that clause in `Filter.Applied` and in each facet's `Excluded`. Without one, the service numbers the conjuncts `c1`, `c2` and so on.

## Select a Bucket by Its Clause

Every bucket a list clause can select carries that clause. This is the `2023` bucket of `ByYear` from the answer above:

<!-- docs-check: skip one bucket from an envelope, not a request body -->
```json
{
	"Key": "2023-01-01 00:00:00",
	"Label": "2023",
	"Count": 321,
	"Selected": false,
	"Start": "2023-01-01 00:00:00",
	"End": "2024-01-01 00:00:00",
	"EndExclusive": true,
	"Clause":
	{
		"Type": "DateRange",
		"FilterByColumn": "SaleDate",
		"Values": { "Start": "2023-01-01 00:00:00", "End": "2024-01-01 00:00:00" },
		"EndExclusive": true,
		"FilterKey": "SaleDate",
		"ClauseKey": "DateRange"
	},
	"Selection": { "Facet": "BookStoreSale.SaleDate", "Key": "2023-01-01 00:00:00" }
}
```

Filters your list page already builds are sent as they are. To select a bucket, copy the `Clause` from that bucket rather than constructing one, and the list then agrees with the bucket by construction:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale -->
```json
{
	"Clauses":
	[
		{ "Type": "DistinctSelectedValueList", "FilterByColumn": "PaymentMethod", "Values": [ "Credit" ], "FilterKey": "PaymentMethod", "Hash": "Method" },
		{ "Type": "DateRange", "FilterByColumn": "SaleDate", "Values": { "Start": "2023-01-01 00:00:00", "End": "2024-01-01 00:00:00" }, "EndExclusive": true, "FilterKey": "SaleDate", "ClauseKey": "DateRange", "Hash": "Year" }
	],
	"Facets":
	[
		{ "Key": "ByYear", "Facet": "BookStoreSale.SaleDate", "Interval": "year" },
		{ "Key": "ByMethod", "Facet": "BookStoreSale.PaymentMethod" }
	],
	"Total": true
}
```

The answer has `Total: 321`, exactly the bucket's count. `ByYear` now excludes `Year`, keeps every year's credit count and marks `2023` selected. `ByMethod` counts 2023 sales by method (740 in all: `Credit` 321, `Debit` 186, `Cash` 116, `Online` 104 and `""` 9, plus 4 missing).

Check the agreement against the list side of the same compiler. `POST /1.0/Facet/BookStoreSale/Records/Count` takes the same filter inputs:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale Route=Records/Count -->
```json
{
	"Clauses":
	[
		{ "Type": "DistinctSelectedValueList", "FilterByColumn": "PaymentMethod", "Values": [ "Credit" ], "FilterKey": "PaymentMethod", "Hash": "Method" },
		{ "Type": "DateRange", "FilterByColumn": "SaleDate", "Values": { "Start": "2023-01-01 00:00:00", "End": "2024-01-01 00:00:00" }, "EndExclusive": true, "FilterKey": "SaleDate", "ClauseKey": "DateRange", "Hash": "Year" }
	]
}
```

It answers `{ "Count": 321 }`. The stock meadow-endpoints count route agrees as well. `FilteredTo` segments are part of the URL path, so encode the spaces in the date values:

```bash
curl -s 'http://localhost:8086/1.0/BookStoreSales/Count/FilteredTo/FBV~PaymentMethod~EQ~Credit~FBV~SaleDate~GE~2023-01-01%2000:00:00~FBV~SaleDate~LT~2024-01-01%2000:00:00'
# {"Count":321}
```

### Select Several Values

To select several values of one facet, copy one bucket's `Clause` and set its `Values` to every selected key. Ticking `Debit` next to `Credit`:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale -->
```json
{
	"Clauses":
	[
		{ "Type": "DistinctSelectedValueList", "FilterByColumn": "PaymentMethod", "Values": [ "Credit", "Debit" ], "FilterKey": "PaymentMethod", "ClauseKey": "DistinctSelectedValueList", "Hash": "Method" }
	],
	"Facets":
	[
		{ "Key": "ByYear", "Facet": "BookStoreSale.SaleDate", "Interval": "year" },
		{ "Key": "ByMethod", "Facet": "BookStoreSale.PaymentMethod" }
	],
	"Total": true
}
```

The `Total` is 2,032 (1,288 credit plus 744 debit sales), and `ByYear` counts both (488, 497, 507 and 520 for 2021 to 2024). `ByMethod` still counts every method, with both `Credit` and `Debit` marked `Selected: true`.

## Or Send a Meadow Filter String

A client that already speaks meadow-filter can send `FilterString` instead of (or as well as) `Clauses`:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale -->
```json
{
	"FilterString": "FBV~PaymentMethod~EQ~Credit",
	"Facets":
	[
		{ "Key": "ByMethod", "Facet": "BookStoreSale.PaymentMethod" }
	],
	"Total": true
}
```

The answer has `Total: 1288` and `ByMethod` still counts all 2,918 sales, because a filter-string stanza on the facet's own column is excluded the same way. With no `Hash` to name it, the facet reports it as `Excluded: [ "c1" ]`. [The Request Body](#/page/api/Request) lists the clause types and filter instructions the service accepts.

## Declare a Named Scope

Auto facets cover one entity's own columns. Anything that crosses entities is declared in a **definitions file**. Create `facets/Bookstore-Facets.json` with one **named scope**, a reusable filter with a parameter:

<!-- docs-check: definitions Id=getting-started-bookstore Fixture=Bookstore -->
```json
{
	"FormatVersion": 1,
	"Description": "Bookstore: a named scope with one parameter.",
	"Scopes":
	{
		"Book.RatedAtLeast":
		{
			"Entity": "Book",
			"Description": "Books with at least one review rated MinRating or higher",
			"Params": { "MinRating": { "Type": "Integer", "Min": 1, "Max": 5, "Default": 4 } },
			"Where":
			[
				{ "Exists": { "Path": [ "<Review.IDBook" ], "Where": [ { "Field": "Rating", "Op": "GE", "Value": "$Param.MinRating" } ] } }
			]
		}
	}
}
```

`<Review.IDBook` is a path step: from `Book`, follow the to-many edge to the `Review` rows whose `IDBook` points back. `Exists` keeps a book when at least one such review, read through the `Review` entity's own list behaviors, matches. [Definitions Files](#/page/Definitions) has the full grammar.

Definitions load when the service is installed and again on every model reload, so restart the application. An entry that fails validation is disabled and logged with `FACET_DEFINITION_INVALID`; it is never half loaded. The new scope now appears in Describe under `Book`, with its `Params`.

Ask for books with a five-star review, counted by genre:

<!-- docs-check: request Fixture=Bookstore Entity=Book Definitions=getting-started-bookstore -->
```json
{
	"Scopes": [ { "Scope": "Book.RatedAtLeast", "Params": { "MinRating": 5 } } ],
	"Facets": [ { "Key": "Genre", "Facet": "Book.Genre", "Top": 5 } ],
	"Total": true
}
```

The answer, abridged:

```json
{
	"Entity": "Book",
	"Total": 931,
	"Filter": { "Applied": [ { "Scope": "Book.RatedAtLeast" } ], "Warnings": [] },
	"DependsOn": [ "Book", "Review" ],
	"Facets":
	{
		"Genre":
		{
			"Fold": "Terms",
			"Excluded": [],
			"Total": 931,
			"SumOfCounts": 708,
			"MissingCount": 9,
			"OtherCount": 214,
			"DistinctCount": 14,
			"Truncated": true,
			"TruncatedReason": "Top",
			"Buckets":
			[
				{ "Key": "Fiction", "Label": "Fiction", "Count": 286 },
				{ "Key": "Mystery", "Label": "Mystery", "Count": 135 },
				{ "Key": "Romance", "Label": "Romance", "Count": 110 },
				{ "Key": "Science Fiction", "Label": "Science Fiction", "Count": 93 },
				{ "Key": "Fantasy", "Label": "Fantasy", "Count": 84 }
			]
		}
	}
}
```

Three details:

- A named scope is never excluded. `Genre` reports `Excluded: []` and counts only books inside the scope.
- `Top: 5` kept the five largest genres. The other nine land in `OtherCount` (214), so `SumOfCounts + MissingCount + OtherCount` still equals `Total`.
- `DependsOn` names every entity the answer read. The cache and the change feed use it.

Leave out `Params` and the declared default applies: `MinRating` 4 gives 1,250 books. A value outside the declared range is refused before anything runs:

<!-- docs-check: request Fixture=Bookstore Entity=Book Definitions=getting-started-bookstore Expect=FACET_PARAM_INVALID -->
```json
{
	"Scopes": [ { "Scope": "Book.RatedAtLeast", "Params": { "MinRating": 9 } } ],
	"Facets": [ { "Key": "Genre", "Facet": "Book.Genre" } ]
}
```

```json
{ "Error": { "Code": "FACET_PARAM_INVALID", "Status": 400, "Message": "A parameter is invalid.", "Detail": { "Scope": "Book.RatedAtLeast", "Param": "MinRating", "Reason": "Range" } } }
```

A scope can also be named in the route. `POST /1.0/Facet/Book/Scope/Book.RatedAtLeast/Query` puts the path scope first and takes its parameters from the body's top-level `Params`:

<!-- docs-check: request Fixture=Bookstore Entity=Book Scope=Book.RatedAtLeast Definitions=getting-started-bookstore -->
```json
{
	"Params": { "MinRating": 5 },
	"Facets": [ { "Key": "Genre", "Facet": "Book.Genre", "Top": 5 } ],
	"Total": true
}
```

It answers the same `Total: 931`. The route form matters for lists, as the next section shows.

## Page Through the Rows with a Recordset

The list side of the compiler has the routes a pict-section-recordset already speaks. Point a record set at them with `FilterEndpointOverride`:

<!-- docs-check: skip pict-section-recordset configuration, not a facet request -->
```json
{
	"RecordSet": "BookStoreSale",
	"RecordSetType": "MeadowEndpoint",
	"FilterEndpointOverride": "Facet/BookStoreSale/Records"
}
```

With the default `RecordSetURLPrefix` of `/1.0/`, the recordset posts `{ Clauses, Experience }` to `/1.0/Facet/BookStoreSale/Records/<Offset>/<PageSize>` for a page and to `/1.0/Facet/BookStoreSale/Records/Count` for its count. Both run the faceting compiler, so the list, its count and the facets beside it always come from one filter. Posting the two clauses above to `/1.0/Facet/BookStoreSale/Records/0/3` returns the first three of the 321 sales as plain rows (abridged to five columns):

```json
[
	{ "IDBookStoreSale": 13, "SaleDate": "2023-04-01", "TotalAmount": 149.39, "PaymentMethod": "Credit", "IDBookStore": 29 },
	{ "IDBookStoreSale": 14, "SaleDate": "2023-07-01 00:00", "TotalAmount": 135.34, "PaymentMethod": "Credit", "IDBookStore": 37 },
	{ "IDBookStoreSale": 18, "SaleDate": "2023-07-02 13:49:02", "TotalAmount": 119.35, "PaymentMethod": "Credit", "IDBookStore": 31 }
]
```

The rows come back through the entity's own list read, behaviors included. To list a named scope, put it in the override: `Facet/Book/Scope/Book.RatedAtLeast/Records`. Its `Records/Count` answers `{ "Count": 1250 }` (the default `MinRating`). [Records, Count and Keys](#/page/api/Records_And_Keys) covers sorting, caps, `Keys` and asking for the first page inside a Query.

## Tenancy

The Bookstore has no tenants. When your entities do, describe the policy your list behaviors already enforce, so the service can check every captured scope against it:

```javascript
libRetoldFacetingService.installOnRetoldDataService(_DataService,
	{
		Definitions: { Path: `${__dirname}/facets/` },
		// The column every tenant-scoped entity filters on, and the session field that holds the value.
		Scope: { Policy: { Column: 'IDCustomer', SessionField: 'CustomerID' }, Guard: 'Strict' }
	}, fInstalled);
```

Set `SessionField`: meadow-endpoints sessions carry `CustomerID`, not `IDCustomer`, and without it every request answers `401`.

The policy does not add tenancy of its own. With `Guard: 'Strict'`, the service refuses to run an entity whose list behaviors did not put the policy's filter in place, and a request whose session has no value for the field is answered `401 FACET_UNAUTHENTICATED`. Personal (owner) scopes, global lookup tables and the other guard modes are covered in [Security and Tenancy](#/page/Security_And_Tenancy).

## Next Steps

- [Concepts](#/page/Concepts): the vocabulary behind these answers, with small diagrams.
- [Definitions Files](#/page/Definitions) and [Fold Kinds](#/page/Fold_Kinds): declared cross-entity facets.
- [The Request Body](#/page/api/Request) and [The Response Envelope](#/page/api/Envelope): every field.
- [Examples](#/page/Examples): three motivating questions answered end to end, and the demo application.
- [Caching and Invalidation](#/page/Caching_And_Invalidation): the optional result cache, ETags and the change feed.
