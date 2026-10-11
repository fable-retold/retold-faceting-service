# K4 Ranges

> Counts an entity's rows per named numeric range that you declare, such as "low", "medium" and "high".

## When to Use It

Use Ranges when the bands mean something to your users and need not be equal: rating bands, price tiers, size classes. It is available on every `Numeric` and `Decimal` column. For an automatic, equal-width view of the same column, use [K3 NumericHistogram](#/page/fold_kinds/003-numeric-histogram).

## How to Ask for It

Ask for `Fold: 'Ranges'` and list the ranges. Each range has a unique `Key`, an optional `From` (inclusive), an optional `To` (exclusive) and an optional `Label`:

<!-- docs-check: request Fixture=Bookstore Entity=Review -->
```json
{
	"Facets":
	[
		{
			"Key": "RatingBand",
			"Facet": "Review.Rating",
			"Fold": "Ranges",
			"Ranges":
			[
				{ "Key": "low", "To": 3, "Label": "1 to 2 stars" },
				{ "Key": "mid", "From": 3, "To": 5, "Label": "3 to 4 stars" },
				{ "Key": "top", "From": 5, "Label": "5 stars" }
			]
		}
	]
}
```

| Rule | Detail |
|---|---|
| Count | 1 to `Limits.MaxBuckets` (500) ranges. `Fold: 'Ranges'` without `Ranges` is a per-facet `400 FACET_REQUEST_INVALID`. |
| Keys | Non-empty, unique strings; not starting with `#`. |
| Bounds | Finite numbers or absent. A range with both needs `From < To`. Leave `From` out for "below", `To` out for "and above". |
| Labels | Optional. Without one, the label is written from the bounds, the way histogram bands are labelled. |

In a definitions file the same list goes on a dimension: `{ "Kind": "Ranges", "Field": "Rating", "Ranges": [ … ] }`. Declared ranges are the default a request may override.

## Example

The captured answer, abridged: engine and display fields are removed, and only the first bucket keeps its `Selection`.

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Facets":
	{
		"RatingBand":
		{
			"Key": "RatingBand",
			"Facet": "Review.Rating",
			"Fold": "Ranges",
			"Disjunctive": "Exact",
			"CountMode": "Rows",
			"Total": 5823,
			"SumOfCounts": 5788,
			"MissingCount": 35,
			"OtherCount": 0,
			"Buckets":
			[
				{
					"Key": "low",
					"Label": "1 to 2 stars",
					"Count": 876,
					"Selected": false,
					"End": 3,
					"EndExclusive": true,
					"Clause":
					{
						"Type": "NumericRange",
						"FilterByColumn": "Rating",
						"Values": { "End": 3 },
						"EndExclusive": true,
						"FilterKey": "Rating",
						"ClauseKey": "NumericRange"
					},
					"Selection": { "Facet": "Review.Rating", "Key": "low" }
				},
				{
					"Key": "mid",
					"Label": "3 to 4 stars",
					"Count": 3189,
					"Selected": false,
					"Start": 3,
					"End": 5,
					"EndExclusive": true,
					"Clause":
					{
						"Type": "NumericRange",
						"FilterByColumn": "Rating",
						"Values": { "Start": 3, "End": 5 },
						"EndExclusive": true,
						"FilterKey": "Rating",
						"ClauseKey": "NumericRange"
					}
				},
				{
					"Key": "top",
					"Label": "5 stars",
					"Count": 1723,
					"Selected": false,
					"Start": 5,
					"EndExclusive": true,
					"Clause":
					{
						"Type": "NumericRange",
						"FilterByColumn": "Rating",
						"Values": { "Start": 5 },
						"EndExclusive": true,
						"FilterKey": "Rating",
						"ClauseKey": "NumericRange"
					}
				}
			]
		}
	}
}
```

Every declared range comes back, in declared order, even when its count is zero. The open-ended ranges carry only the bound they have, and so do their clauses.

## Buckets and Selection

- **First match wins.** A row goes to the first range, in declared order, whose `[From, To)` contains it, exactly like a SQL `CASE`. Rows in no range are `OtherCount`; NULLs and non-numeric text are `MissingCount`.
- **Overlapping ranges.** A range that overlaps an earlier one only collects what the earlier ones left. Its `Clause` selects exactly that remainder, so selecting the bucket gives `Count` rows. When the remainder would be two separate pieces, no single `NumericRange` clause can express it: the bucket gets `Clause: null` and keeps its `Selection`.
- **`Key`** is the range's own `Key`; `Start` and `End` are its declared bounds.
- **`Selected`** is `true` when the facet's own range clauses select a range containing the whole bucket.

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes. One `CASE` expression with the bounds bound as parameters. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when the column is mirrored (`multiIf` over the same bounds). The usual store refusals apply. |

Ranges facets are members of the conditional disjunctive scan (see [Architecture](#/page/Faceting_Architecture)).

## Notes and Limits

- Ranges is the only way to put a `Decimal` column on a pivot axis: give the pivot request `Ranges` (see [K14 Pivot](#/page/fold_kinds/014-pivot)).
- Range keys are client data: they are refused when they contain control characters or name an `Object.prototype` member.

## Related

- [K3 NumericHistogram](#/page/fold_kinds/003-numeric-histogram): equal-width bands.
- [Concepts](#/page/Concepts): buckets, `OtherCount` and `MissingCount`.
- [The Request Body](#/page/api/Request) and [The Response Envelope](#/page/api/Envelope).
