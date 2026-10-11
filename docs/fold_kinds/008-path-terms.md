# K8 PathTerms

> Buckets an entity's rows by a column of a related row, reached through one or more to-one (`>`) hops. Each row has at most one value, so the facet stays single-valued.

## When to Use It

Use PathTerms when the value a user wants to filter by lives on a parent row: sales by their store's state, reviews by their book's language, line items by the region of their order's store. The counted entity stays the same (the counts are sales, reviews, line items); only the key is read through the path.

A to-one path follows foreign keys from child to parent. For the other direction (a book's authors, a project's members), where one row can have many keys, use [K9 BridgeTerms](#/page/fold_kinds/009-bridge-terms).

## How to Ask for It

**One hop, no definitions.** A FacetID of the form `Entity.ForeignKey>Target.Column` is synthesized on demand:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale -->
```json
{ "Facets": [ { "Key": "StoreState", "Facet": "BookStoreSale.IDBookStore>BookStore.State", "Top": 5 } ] }
```

The service builds such a facet when `Entity.ForeignKey` is a graph edge to `Target`, the edge is neither an audit-user nor a tenant edge, `Target` is not a hub entity (`Catalog.HubEntities`, by default `User`, `Customer` and `DataSource`), and `Target.Column` is a facetable column with a bucketing fold. The facet takes the target column's folds: Terms for a short string, DateHistogram for a date, NumericHistogram or Ranges for a number. A path that does not qualify is `400 FACET_UNKNOWN_FACET`, the same answer as one that does not exist.

Describe does not list these one-hop facets unless `Catalog.ListOneHop` is `true`; they work either way.

**Several hops, in a definitions file.** Declare a dimension with a `Path` of `>` steps and the `Field` on the last entity:

<!-- docs-check: definitions Id=k08-store-state Fixture=Bookstore -->
```json
{
	"FormatVersion": 1,
	"Facets":
	[
		{
			"Facet": "BookStoreSaleItem.StoreState",
			"Version": 1,
			"Title": "Sale items by store state",
			"Dimensions":
			[
				{
					"Kind": "Terms",
					"Path": [ ">BookStoreSaleItem.IDBookStoreSale", ">BookStoreSale.IDBookStore" ],
					"Field": "State",
					"Top": 8
				}
			],
			"Exclude": "Self"
		}
	]
}
```

A path dimension may be `Terms`, `DateHistogram`, `NumericHistogram` or `Ranges`. On Terms, `LabelField` names a label column of the last entity (useful when `Field` is that entity's key). Paths are resolved when the file loads, never at query time; `Limits.MaxHops` (4) caps the steps.

## Example

The one-hop FacetID above, captured on the Bookstore fixture. Abridged: engine and display fields are removed, and buckets after the first are shown without `Clause` and `Selection`.

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Total": 2918,
	"DependsOn": [ "BookStore", "BookStoreSale" ],
	"Facets":
	{
		"StoreState":
		{
			"Key": "StoreState",
			"Facet": "BookStoreSale.IDBookStore>BookStore.State",
			"Field": "State",
			"Fold": "Terms",
			"ClauseType": "InternalJoinMatch",
			"FilterKey": "BookStoreSale.IDBookStore>BookStore.State",
			"CountMode": "Rows",
			"Declared": false,
			"Definition": null,
			"Path": [ ">BookStoreSale.IDBookStore" ],
			"Total": 2918,
			"SumOfCounts": 2323,
			"MissingCount": 290,
			"OtherCount": 305,
			"Buckets":
			[
				{
					"Key": "TX",
					"Label": "TX",
					"Count": 641,
					"Selected": false,
					"Clause":
					{
						"Type": "InternalJoinMatch",
						"RemoteTable": "BookStore",
						"JoinInternalConnectionColumn": "IDBookStore",
						"JoinExternalConnectionColumn": "IDBookStore",
						"ExternalFilterByColumns": [ "State" ],
						"ExactMatch": true,
						"Values": [ "TX" ],
						"FilterKey": "BookStoreSale.IDBookStore>BookStore.State",
						"ClauseKey": "InternalJoinMatch"
					},
					"Selection": { "Facet": "BookStoreSale.IDBookStore>BookStore.State", "Key": "TX" }
				},
				{ "Key": "CA", "Label": "CA", "Count": 514, "Selected": false },
				{ "Key": "", "Label": "", "Count": 511, "Selected": false },
				{ "Key": "WA", "Label": "WA", "Count": 407, "Selected": false },
				{ "Key": "FL", "Label": "FL", "Count": 250, "Selected": false }
			]
		}
	}
}
```

- **`MissingCount` (290)** is the sales whose store is gone: the fixture plants sales at soft-deleted stores and at stores that do not exist. The hop is a Scoped Relation of `BookStore`, so a store the principal cannot see (deleted, another tenant's, hidden by the store's own list behaviors) gives no value, and the sale is missing rather than dropped. The `Total` never changes because of a path.
- **`DependsOn`** lists both entities: the answer reads `BookStore` as well as `BookStoreSale`.
- **`Path`** and **`Declared: false`** tell a client this is a one-hop path facet, not a declared one.

### Selecting a Bucket

A one-hop Terms bucket carries an `InternalJoinMatch` clause, a standard pict join clause. Put it in the filter, and the facet owns it by `FilterKey`:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale -->
```json
{
	"Clauses":
	[
		{
			"Type": "InternalJoinMatch",
			"RemoteTable": "BookStore",
			"JoinInternalConnectionColumn": "IDBookStore",
			"JoinExternalConnectionColumn": "IDBookStore",
			"ExternalFilterByColumns": [ "State" ],
			"ExactMatch": true,
			"Values": [ "WA" ],
			"FilterKey": "BookStoreSale.IDBookStore>BookStore.State",
			"Hash": "StoreState-1"
		}
	],
	"Facets": [ { "Key": "StoreState", "Facet": "BookStoreSale.IDBookStore>BookStore.State", "Top": 3 } ]
}
```

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Total": 407,
	"Facets":
	{
		"StoreState":
		{
			"Key": "StoreState",
			"Disjunctive": "Exact",
			"Excluded": [ "StoreState-1" ],
			"Total": 2918,
			"Buckets":
			[
				{ "Key": "TX", "Label": "TX", "Count": 641, "Selected": false },
				{ "Key": "CA", "Label": "CA", "Count": 514, "Selected": false },
				{ "Key": "", "Label": "", "Count": 511, "Selected": false },
				{ "Key": "WA", "Label": "WA", "Count": 407, "Selected": true }
			]
		}
	}
}
```

The envelope `Total` is 407, the `WA` bucket's count. The same clause on `POST /1.0/Facet/BookStoreSale/Records/Count` answers `{ "Count": 407 }`: the bucket clause round trip (see [Concepts](#/page/Concepts)). Under the hood the join clause is an existence filter over the store, a [K10 PathSemiJoin](#/page/fold_kinds/010-path-semi-join).

### A Declared Two-Hop Facet

The `BookStoreSaleItem.StoreState` facet from the definitions file above:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSaleItem Definitions=k08-store-state -->
```json
{ "Facets": [ { "Key": "StoreState", "Facet": "BookStoreSaleItem.StoreState" } ] }
```

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Total": 4565,
	"Facets":
	{
		"StoreState":
		{
			"Key": "StoreState",
			"Facet": "BookStoreSaleItem.StoreState",
			"Fold": "Terms",
			"ClauseType": null,
			"Declared": true,
			"Definition": { "Facet": "BookStoreSaleItem.StoreState", "Version": 1 },
			"Path": [ ">BookStoreSaleItem.IDBookStoreSale", ">BookStoreSale.IDBookStore" ],
			"Total": 4565,
			"SumOfCounts": 4008,
			"MissingCount": 557,
			"OtherCount": 0,
			"Buckets":
			[
				{
					"Key": "TX",
					"Label": "TX",
					"Count": 992,
					"Selected": false,
					"Clause": null,
					"Selection": { "Facet": "BookStoreSaleItem.StoreState", "Key": "TX" }
				},
				{ "Key": "CA", "Label": "CA", "Count": 780 },
				{ "Key": "", "Label": "", "Count": 772 },
				"…"
			]
		}
	}
}
```

Only the first three of the eight buckets are shown. No standard pict clause expresses a two-hop join, so the buckets have `Clause: null` and keep their `Selection`.

## Buckets and Selection

| Path | Bucket clause |
|---|---|
| One `>` hop, Terms on a column | `InternalJoinMatch` with `ExactMatch: true` |
| One `>` hop, Terms on the target's key | `InternalJoinSelectedValueList` |
| One `>` hop, DateHistogram / NumericHistogram / Ranges | `InternalJoinDateRange` / `InternalJoinNumericRange` |
| Two or more hops | `null` (Selection only) |
| Any path whose steps carry a `Where`, a `TenantOnly` scope or `CheckParent` | `null`: no join clause can carry the restriction, and one without it would select more rows than the bucket counted |

Buckets otherwise behave like [K1 Terms](#/page/fold_kinds/001-terms) or the histogram kind they use: `Top`, `Order`, selected keys that always come back, and labels from `LabelField` or the target's label column.

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes. Each hop is a Scoped Relation joined with `LEFT JOIN … ON` the foreign key, so an invisible target gives NULL, never a dropped row. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when every entity and column on the path is mirrored (`ANY LEFT JOIN` per hop). Otherwise the facet is answered Live (`NotMirrored`). |

Path Terms facets on one entity can be members of the conditional disjunctive scan (see [Architecture](#/page/Faceting_Architecture)).

## Notes and Limits

- A FacetID with a second hop (`A.b>B.c>C.d`) is unknown (`400 FACET_UNKNOWN_FACET`): declare multi-hop paths in a definitions file.
- Every hop is gated: a principal who may not facet the target entity gets `400 FACET_UNKNOWN_FACET` for a one-hop FacetID (as if it did not exist) and `403 FACET_FORBIDDEN` for that facet of a declared path.
- A path FacetID may be a [K14 Pivot](#/page/fold_kinds/014-pivot) axis.

## Related

- [K9 BridgeTerms](#/page/fold_kinds/009-bridge-terms): to-many paths.
- [K10 PathSemiJoin](#/page/fold_kinds/010-path-semi-join): filtering by a related row.
- [Definitions Files](#/page/Definitions): path step grammar.
- [Concepts](#/page/Concepts): Scoped Relations.
