# K5 Stats

> Reduces one numeric or date column to a single row of statistics: rows, non-null values, minimum, maximum, sum and average.

## When to Use It

Use Stats for summary cards next to a list: total revenue of the filtered sales, the average price, the first and last sale date. It is available on every `Numeric`, `Decimal` and `DateTime` column. Stats has no buckets, so it is a measure, not something a user clicks.

## How to Ask for It

Ask for `Fold: 'Stats'`:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale -->
```json
{
	"Facets":
	[
		{ "Key": "AmountStats", "Facet": "BookStoreSale.TotalAmount", "Fold": "Stats" },
		{ "Key": "DateStats", "Facet": "BookStoreSale.SaleDate", "Fold": "Stats" }
	]
}
```

A Stats facet counts under the **whole** filter by default (`Exclude: 'None'`): the numbers describe exactly the rows the list shows. Set `Exclude: 'Self'` to ignore the facet's own clauses on the column, as the bucketing kinds do.

## Example

The captured answer, abridged to the fields that matter for Stats:

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Facets":
	{
		"AmountStats":
		{
			"Key": "AmountStats",
			"Facet": "BookStoreSale.TotalAmount",
			"Fold": "Stats",
			"DataType": "Decimal",
			"Selectable": false,
			"Disjunctive": "NotApplicable",
			"Total": 2918,
			"SumOfCounts": 0,
			"MissingCount": 15,
			"OtherCount": 0,
			"Stats": { "Rows": 2918, "NonNull": 2903, "Min": "15.58", "Max": "4875.50", "Sum": "443462.24", "Avg": 152.759986 },
			"Buckets": []
		},
		"DateStats":
		{
			"Key": "DateStats",
			"Fold": "Stats",
			"DataType": "DateTime",
			"Total": 2918,
			"MissingCount": 25,
			"Stats": { "Rows": 2918, "NonNull": 2893, "Min": "2020-12-31 09:33:32", "Max": "2024-12-30 21:55:33", "Sum": null, "Avg": null }
		}
	}
}
```

## The `Stats` Object

| Field | Numeric columns | `DateTime` columns |
|---|---|---|
| `Rows` | Rows counted (equals the facet `Total`) | Same |
| `NonNull` | Rows with a number | Rows with a usable date |
| `Min`, `Max` | Integer columns: numbers. `Decimal` columns: strings with exactly the column's scale (`"4875.50"`) | `YYYY-MM-DD HH:mm:ss` strings |
| `Sum` | Integer columns: a number. `Decimal` columns: an exact string | `null` |
| `Avg` | A number, rounded to the column's scale plus four decimals | `null` |

`MissingCount` is `Rows − NonNull`. With no non-null value, `Min`, `Max`, `Sum` and `Avg` are all `null`.

**Sums are exact.** Every engine sums integer units of the column's scale (cents for a `Decimal(10,2)`), and the decimal string is formatted from that integer. A sum of money never drifts by a floating-point cent, on SQLite, PostgreSQL or ClickHouse.

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes. One single-row statement. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when the column is mirrored. A decimal column with more than 15 significant digits is lossy and answered Live (`LossyColumn`). |

Stats facets are members of the conditional disjunctive scan as per-group measures: several Stats and bucketing facets of one entity can share one `GROUP BY` (see [Architecture](#/page/Faceting_Architecture)).

## Notes and Limits

- Stats is not selectable: `Selectable: false`, no buckets, no clauses.
- Text, JSON, string and boolean columns have no Stats fold; asking for it is a per-facet `FACET_UNKNOWN_FOLD` (status 400) in `Errors`.
- `Measures` other than a row count in a definitions file (sums or averages per bucket) are planned and load as unsupported.

## Related

- [K6 DistinctCount](#/page/fold_kinds/006-distinct-count) and [K7 Missing](#/page/fold_kinds/007-missing): the other measures.
- [K3 NumericHistogram](#/page/fold_kinds/003-numeric-histogram): the distribution of the same column.
- [The Response Envelope](#/page/api/Envelope): every facet result field.
