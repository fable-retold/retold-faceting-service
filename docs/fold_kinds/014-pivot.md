# K14 Pivot

> Counts an entity's rows per pair of keys from two dimensions, such as payment method × year, and reports each axis's marginal totals.

## When to Use It

Use a Pivot for a cross-tab or a heat map next to a list: status by client, payment method by year, rating band by genre. Both axes are dimensions of the same entity (or a one-hop path from it), and each row falls in at most one cell.

## How to Ask for It

**On auto facets**, give two FacetIDs and `Fold: 'Pivot'`:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale -->
```json
{
	"Facets":
	[
		{
			"Key": "MethodByYear",
			"Facet": [ "BookStoreSale.PaymentMethod", "BookStoreSale.SaleDate" ],
			"Fold": "Pivot",
			"Interval": "year",
			"Top": 3
		}
	]
}
```

Each axis uses its column's default fold, with these rules:

| Axis column | Axis kind |
|---|---|
| Short string, boolean, foreign key | Terms |
| `DateTime` | DateHistogram; the request `Interval` applies |
| Integer `Numeric` | Terms on the values, or Ranges when the request gives `Ranges` |
| `Decimal` | Ranges only: the request must give `Ranges`, else `422 FACET_FOLD_UNSUPPORTED` (`NumericPivotAxis`) |
| One-hop path FacetID (`E.c>T.col`) | That path dimension |

`Top` applies to each axis separately, keeping the keys with the largest marginal counts (default `Limits.MaxTop`). `Order` orders Terms axes; date axes are in date order and range axes in declared order. `Chart: true` adds a `Chart` with one dataset per column key.

**In a definitions file**, declare a facet with two `Dimensions` (Terms, DateHistogram or Ranges; never a to-many, ChildRollup or ExistsSplit axis):

<!-- docs-check: definitions Id=k14-method-by-year Fixture=Bookstore -->
```json
{
	"FormatVersion": 1,
	"Facets":
	[
		{
			"Facet": "BookStoreSale.MethodByYear",
			"Version": 1,
			"Title": "Payment method by year",
			"Dimensions":
			[
				{ "Kind": "Terms", "Field": "PaymentMethod" },
				{ "Kind": "DateHistogram", "Field": "SaleDate", "Interval": "year" }
			]
		}
	]
}
```

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale Definitions=k14-method-by-year -->
```json
{ "Facets": [ { "Key": "MethodByYear", "Facet": "BookStoreSale.MethodByYear", "Top": 3 } ] }
```

The declared facet returns the same cells as the auto request above. A declared facet cannot be one axis of a request `Pivot`; declare the 2-D facet instead.

## Example

The auto pivot, captured; engine and display fields are removed:

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Total": 2918,
	"Facets":
	{
		"MethodByYear":
		{
			"Key": "MethodByYear",
			"Facet": [ "BookStoreSale.PaymentMethod", "BookStoreSale.SaleDate" ],
			"Fold": "Pivot",
			"Selectable": false,
			"Disjunctive": "NotApplicable",
			"CountMode": "Rows",
			"Total": 2918,
			"SumOfCounts": 1877,
			"MissingCount": 34,
			"OtherCount": 1007,
			"Truncated": true,
			"Dimensions":
			[
				{ "Facet": "BookStoreSale.PaymentMethod", "Field": "PaymentMethod", "Fold": "Terms", "Interval": null },
				{ "Facet": "BookStoreSale.SaleDate", "Field": "SaleDate", "Fold": "DateHistogram", "Interval": "year" }
			],
			"RowKeys": [ "Credit", "Debit", "Cash" ],
			"ColumnKeys": [ "2022-01-01 00:00:00", "2023-01-01 00:00:00", "2024-01-01 00:00:00" ],
			"Cells":
			[
				{ "K1": "Credit", "K2": "2022-01-01 00:00:00", "Count": 310 },
				{ "K1": "Credit", "K2": "2023-01-01 00:00:00", "Count": 321 },
				{ "K1": "Credit", "K2": "2024-01-01 00:00:00", "Count": 335 },
				{ "K1": "Debit", "K2": "2022-01-01 00:00:00", "Count": 187 },
				{ "K1": "Debit", "K2": "2023-01-01 00:00:00", "Count": 186 },
				{ "K1": "Debit", "K2": "2024-01-01 00:00:00", "Count": 185 },
				{ "K1": "Cash", "K2": "2022-01-01 00:00:00", "Count": 123 },
				{ "K1": "Cash", "K2": "2023-01-01 00:00:00", "Count": 116 },
				{ "K1": "Cash", "K2": "2024-01-01 00:00:00", "Count": 114 }
			],
			"Marginals":
			{
				"Rows": [ { "Key": "Credit", "Count": 1277 }, { "Key": "Debit", "Count": 735 }, { "Key": "Cash", "Count": 472 } ],
				"Columns":
				[
					{ "Key": "2022-01-01 00:00:00", "Count": 717 },
					{ "Key": "2023-01-01 00:00:00", "Count": 736 },
					{ "Key": "2024-01-01 00:00:00", "Count": 720 }
				],
				"Total": 1877
			}
		}
	}
}
```

How to read it:

- **`RowKeys` and `ColumnKeys`** are the kept keys of each axis: the three payment methods and the three years with the most sales.
- **`Cells`** holds every non-empty displayed cell, `K1` from the first axis, `K2` from the second.
- **`Marginals.Rows` and `Marginals.Columns`** give each kept key's count across the **whole** other axis. Credit's 1277 includes its 2020 and 2021 sales, which are not displayed. **`Marginals.Total`** (1877) is the sum of the displayed cells, which is also `SumOfCounts`.
- **`MissingCount`** (34) is the rows missing a value on at least one axis; **`OtherCount`** (1007) is the rows outside the kept keys. `SumOfCounts + MissingCount + OtherCount = Total`.

## Buckets and Selection

A Pivot has no `Buckets` and is not selectable. A user who clicks a cell can apply each axis's own facet clause (a Terms clause on `PaymentMethod`, a date range for the year); request the matching single-axis facets alongside the pivot to get those clauses.

A pivot counts under the whole filter by default (`Exclude: 'None'`).

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes. One `GROUP BY k1, k2` statement; marginals and `Top` per axis are computed afterwards. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when both axis columns are mirrored. |

Pivots are members of the conditional disjunctive scan (see [Architecture](#/page/Faceting_Architecture)).

## Notes and Limits

- Exactly two dimensions (`Limits.MaxPivotDimensions` can only lower it). Both FacetIDs must name the route entity.
- More than `Limits.CubeMaxGroups` (100000) cells fails that facet with `422 FACET_TOO_LARGE` (`Detail.Limit: 'CubeMaxGroups'`).
- A NumericHistogram axis is refused (`422 FACET_FOLD_UNSUPPORTED`); use Ranges.
- A TuplePivot cannot be pivoted in two dimensions.

## Related

- [K1 Terms](#/page/fold_kinds/001-terms), [K2 DateHistogram](#/page/fold_kinds/002-date-histogram), [K4 Ranges](#/page/fold_kinds/004-ranges): the axis kinds.
- [K18 TuplePivot](#/page/fold_kinds/018-tuple-pivot): a pivot over a declared join, not two axes.
- [The Response Envelope](#/page/api/Envelope): the pivot result fields.
