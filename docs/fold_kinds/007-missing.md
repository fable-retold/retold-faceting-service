# K7 Missing

> Counts the rows whose value is missing. Every bucketing facet reports it as `MissingCount`; the `Missing` fold reports it on its own.

## When to Use It

Use the missing count to show data quality next to a list ("27 books have no language") or to offer a "not set" choice. You usually get it for free: every Terms, histogram and Ranges facet carries `MissingCount`. Ask for the `Missing` fold when the count is all you need.

## How to Ask for It

Every auto facet column offers `Fold: 'Missing'`. A bucketing facet can also move its missing rows out of `MissingCount` with `Missing: false`:

<!-- docs-check: request Fixture=Bookstore Entity=Book -->
```json
{
	"Facets":
	[
		{ "Key": "NoLanguage", "Facet": "Book.Language", "Fold": "Missing" },
		{ "Key": "Language", "Facet": "Book.Language", "Top": 3, "Missing": false }
	]
}
```

## Example

The captured answer, abridged (buckets without `Selected`, `Clause` and `Selection`):

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Facets":
	{
		"NoLanguage":
		{
			"Key": "NoLanguage",
			"Fold": "Missing",
			"Selectable": false,
			"Total": 1436,
			"SumOfCounts": 0,
			"MissingCount": 27,
			"OtherCount": 0
		},
		"Language":
		{
			"Key": "Language",
			"Fold": "Terms",
			"Total": 1436,
			"SumOfCounts": 1241,
			"MissingCount": 0,
			"OtherCount": 195,
			"Truncated": true,
			"Buckets":
			[
				{ "Key": "eng", "Label": "eng", "Count": 862 },
				{ "Key": "en-US", "Label": "en-US", "Count": 271 },
				{ "Key": "", "Label": "", "Count": 108 }
			]
		}
	}
}
```

The `Missing` fold finds 27 books without a language. The Terms facet with `Missing: false` reports `MissingCount: 0` and counts those 27 rows in `OtherCount` instead, so `SumOfCounts + MissingCount + OtherCount = Total` still holds: 1241 + 0 + 195 = 1436.

## What Counts as Missing

| Column type | Missing values |
|---|---|
| `String` | `NULL` only. An empty string is a value (above, `""` is a bucket of 108 books). |
| `Numeric`, `Decimal`, `Boolean`, foreign keys | `NULL`, and any stored text that is not a number, such as `''` or `' '` |
| `DateTime` | `NULL`, `''`, and text that does not parse as a date |

Every engine applies the same rule. The integer `BookStoreInventory.BookCount` holds a few blank strings in the fixture, and they are missing:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreInventory -->
```json
{ "Facets": [ { "Key": "NoCount", "Facet": "BookStoreInventory.BookCount", "Fold": "Missing" } ] }
```

<!-- docs-check: skip captured envelope, abridged -->
```json
{ "Facets": { "NoCount": { "Key": "NoCount", "Fold": "Missing", "DataType": "Numeric", "Total": 1563, "MissingCount": 22 } } }
```

A path dimension adds one more case: a row whose related row is missing, soft-deleted or not visible to the principal has no value. [K8 PathTerms](#/page/fold_kinds/008-path-terms) counts such rows in `MissingCount`.

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when the column is mirrored. A column holding values the mirror cannot store exactly (the blank strings in an integer column above) is lossy, and its facets are answered Live (`LossyColumn`). |

`Missing` facets are members of the conditional disjunctive scan as per-group measures (see [Architecture](#/page/Faceting_Architecture)).

## Notes and Limits

- The `Missing` fold has no buckets and is not selectable. It counts under the whole filter by default (`Exclude: 'None'`).
- There is no "missing" bucket to click. To list the rows with no value, filter the list itself (a meadow-filter `IN` stanza on the column, which means "is NULL").

## Related

- [K1 Terms](#/page/fold_kinds/001-terms), [K2 DateHistogram](#/page/fold_kinds/002-date-histogram), [K3 NumericHistogram](#/page/fold_kinds/003-numeric-histogram), [K4 Ranges](#/page/fold_kinds/004-ranges): every one reports `MissingCount`.
- [Concepts](#/page/Concepts): `Total`, `SumOfCounts`, `MissingCount` and `OtherCount`.
