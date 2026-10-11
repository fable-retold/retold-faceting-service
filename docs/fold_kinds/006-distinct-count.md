# K6 DistinctCount

> Counts how many different values one column holds across the counted rows.

## When to Use It

Use DistinctCount for "how many different…" cards: distinct reviewers of the filtered reviews, distinct customers who bought, distinct genres on a shelf. It is available on foreign keys, integer `Numeric` columns and short strings. Like [K5 Stats](#/page/fold_kinds/005-stats), it is a measure with no buckets.

## How to Ask for It

Ask for `Fold: 'DistinctCount'`:

<!-- docs-check: request Fixture=Bookstore Entity=Review -->
```json
{ "Facets": [ { "Key": "Reviewers", "Facet": "Review.IDUser", "Fold": "DistinctCount" } ] }
```

The facet counts under the whole filter by default (`Exclude: 'None'`), so the number matches the rows the list shows.

## Example

The captured answer, abridged:

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Facets":
	{
		"Reviewers":
		{
			"Key": "Reviewers",
			"Facet": "Review.IDUser",
			"Fold": "DistinctCount",
			"Selectable": false,
			"Disjunctive": "NotApplicable",
			"Total": 5823,
			"SumOfCounts": 0,
			"MissingCount": 0,
			"OtherCount": 0,
			"DistinctCount": 240,
			"Buckets": []
		}
	}
}
```

The 5823 live reviews were written by 240 different users. On a string column, rows with no value are reported apart from the count:

<!-- docs-check: request Fixture=Bookstore Entity=Book -->
```json
{ "Facets": [ { "Key": "Genres", "Facet": "Book.Genre", "Fold": "DistinctCount" } ] }
```

<!-- docs-check: skip captured envelope, abridged -->
```json
{ "Facets": { "Genres": { "Key": "Genres", "Fold": "DistinctCount", "Total": 1436, "MissingCount": 16, "DistinctCount": 14 } } }
```

## What Counts as Distinct

- Only non-missing values count. NULL is never a value; on a numeric column, text that is not a number is not a value either.
- Values are compared exactly (binary comparison): `"Fiction"` and `"fiction"` are two values, and an empty string is a value.
- The result is in the facet's `DistinctCount` field. A [K1 Terms](#/page/fold_kinds/001-terms) facet also reports `DistinctCount` (the number of distinct keys before `Top`), so a Terms facet already tells you how many values exist when you need the buckets anyway.

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes. One single-row statement. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when the column is mirrored, with an exact distinct count (`uniqExact`). |

DistinctCount keeps its own statement: it is not a member of the conditional disjunctive scan.

> **Planned.** Approximate distinct counts (`CountMode: 'Approx'`) on stores, for very large tables.

## Notes and Limits

- DistinctCount is not selectable: no buckets, no clauses.
- `Decimal` and `DateTime` columns have no DistinctCount fold; asking for it is a per-facet `FACET_UNKNOWN_FOLD` (status 400) in `Errors`.

## Related

- [K1 Terms](#/page/fold_kinds/001-terms): the values themselves, with counts.
- [K5 Stats](#/page/fold_kinds/005-stats) and [K7 Missing](#/page/fold_kinds/007-missing): the other measures.
- [The Response Envelope](#/page/api/Envelope).
