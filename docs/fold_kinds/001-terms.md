# K1 Terms

> Counts an entity's rows per distinct value of one column, keeps the most frequent values, and accounts for the rest in `OtherCount` and `MissingCount`.

## When to Use It

Use Terms for columns with a small set of values: a status, a type, a language, a boolean, a foreign key. It is the default fold for foreign keys, booleans and short strings, and an option on integer columns.

A Terms facet is the classic checkbox list next to a recordset. Because the service computes it disjunctively, checking one value never hides the others (see [Concepts](#/page/Concepts)).

## How to Ask for It

On an auto facet, name the column. Terms is already the default for `Book.Language`, a short string:

<!-- docs-check: request Fixture=Bookstore Entity=Book -->
```json
{
	"Facets": [ { "Key": "Language", "Facet": "Book.Language", "Top": 5 } ]
}
```

On an integer column, where the default is a histogram, ask for it with `Fold: 'Terms'`. The request options that shape a Terms result:

| Option | Default | Meaning |
|---|---|---|
| `Top` | `Limits.DefaultTop` (20) | How many buckets to keep. Values above `Limits.MaxTop` (500) are clamped, with a `FACET_TOP_CLAMPED` warning. |
| `Order` | `CountDesc` | Display order of the kept buckets: `CountDesc`, `KeyAsc` or `KeyDesc`. |
| `Missing` | `true` | Report rows with no value in `MissingCount`. With `false` they are counted in `OtherCount`. |
| `Labels` | on | `false` turns off the label lookup of a foreign-key column. |
| `Exclude` | `Self` | Which filter clauses the facet ignores. See [Concepts](#/page/Concepts). |

In a definitions file, a Terms dimension is `{ "Kind": "Terms", "Field": "Language" }`. You rarely need one for a column of the entity itself; declared Terms dimensions matter when they follow a path ([K8 PathTerms](#/page/fold_kinds/008-path-terms), [K9 BridgeTerms](#/page/fold_kinds/009-bridge-terms)) or sit under a definition `Where`.

## Example

The books the user has narrowed to English, with the Language facet next to the list. The clause carries a `Hash`, as pict-section-recordset clauses do:

<!-- docs-check: request Fixture=Bookstore Entity=Book -->
```json
{
	"Clauses":
	[
		{
			"Type": "DistinctSelectedValueList",
			"FilterByColumn": "Language",
			"Values": [ "eng" ],
			"FilterKey": "Language",
			"Hash": "Language-1"
		}
	],
	"Facets": [ { "Key": "Language", "Facet": "Book.Language", "Top": 5 } ],
	"Total": true
}
```

The captured answer on the Bookstore fixture, abridged: the envelope keeps `Entity`, `Total` and `Filter`; the facet's engine and display fields are removed; buckets after the first are shown without their `Clause` and `Selection`.

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Entity": "Book",
	"Total": 862,
	"Filter": { "Applied": [ { "Hash": "Language-1" } ], "Warnings": [] },
	"Facets":
	{
		"Language":
		{
			"Key": "Language",
			"Facet": "Book.Language",
			"Fold": "Terms",
			"Disjunctive": "Exact",
			"Excluded": [ "Language-1" ],
			"CountMode": "Rows",
			"Total": 1436,
			"SumOfCounts": 1321,
			"MissingCount": 27,
			"OtherCount": 88,
			"Truncated": true,
			"TruncatedReason": "Top",
			"DistinctCount": 10,
			"Buckets":
			[
				{
					"Key": "eng",
					"Label": "eng",
					"Count": 862,
					"Selected": true,
					"Clause":
					{
						"Type": "DistinctSelectedValueList",
						"FilterByColumn": "Language",
						"Values": [ "eng" ],
						"FilterKey": "Language",
						"ClauseKey": "DistinctSelectedValueList"
					},
					"Selection": { "Facet": "Book.Language", "Key": "eng" }
				},
				{ "Key": "en-US", "Label": "en-US", "Count": 271, "Selected": false },
				{ "Key": "", "Label": "", "Count": 108, "Selected": false },
				{ "Key": "en-GB", "Label": "en-GB", "Count": 48, "Selected": false },
				{ "Key": "fre", "Label": "fre", "Count": 32, "Selected": false }
			]
		}
	}
}
```

Read it this way:

- The envelope `Total` (862) is the list's count for the whole filter. The facet's own `Total` (1436) ignores the Language clause, because the facet owns it (`Excluded: [ "Language-1" ]`). So every other language still shows its count, and `eng` is marked `Selected`.
- Ten distinct languages exist (`DistinctCount`); five are kept (`Truncated`, `TruncatedReason: "Top"`). The rows in the other five are `OtherCount` (88), and the 27 books with a NULL language are `MissingCount`.
- `SumOfCounts + MissingCount + OtherCount = Total`: 1321 + 27 + 88 = 1436.
- An empty string is a value, not a missing value: `""` is a bucket of 108 books. Only NULL is missing in a string column.

### Ordering

`Order` changes how the kept buckets are shown, not which ones are kept. The kept set is always the first `Top` buckets by count, then key. Ratings sorted by value:

<!-- docs-check: request Fixture=Bookstore Entity=Review -->
```json
{
	"Facets": [ { "Key": "Rating", "Facet": "Review.Rating", "Fold": "Terms", "Order": "KeyAsc" } ]
}
```

<!-- docs-check: skip captured envelope, abridged to the bucket list -->
```json
{
	"Facets":
	{
		"Rating":
		{
			"Key": "Rating",
			"Fold": "Terms",
			"Total": 5823,
			"SumOfCounts": 5788,
			"MissingCount": 35,
			"OtherCount": 0,
			"Truncated": false,
			"Buckets":
			[
				{ "Key": 1, "Label": "1", "Count": 303, "Selected": false },
				{ "Key": 2, "Label": "2", "Count": 573, "Selected": false },
				{ "Key": 3, "Label": "3", "Count": 1196, "Selected": false },
				{ "Key": 4, "Label": "4", "Count": 1993, "Selected": false },
				{ "Key": 5, "Label": "5", "Count": 1723, "Selected": false }
			]
		}
	}
}
```

### Foreign-Key Labels

A Terms facet on a foreign key labels its buckets from the target entity. The label column is the target's `LabelColumn` catalog override when one is set, else its `Name`, `Title` or `FullName` column, else its first short string column.

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale -->
```json
{
	"Facets": [ { "Key": "Store", "Facet": "BookStoreSale.IDBookStore", "Top": 3 } ]
}
```

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Facets":
	{
		"Store":
		{
			"Key": "Store",
			"Facet": "BookStoreSale.IDBookStore",
			"Fold": "Terms",
			"DataType": "Numeric",
			"Total": 2918,
			"SumOfCounts": 400,
			"MissingCount": 0,
			"OtherCount": 2518,
			"Buckets":
			[
				{
					"Key": 1,
					"Label": "Paper Kingdom Books #1",
					"LabelResolved": true,
					"Count": 157,
					"Selected": false,
					"Clause":
					{
						"Type": "DistinctSelectedValueList",
						"FilterByColumn": "IDBookStore",
						"Values": [ 1 ],
						"FilterKey": "IDBookStore",
						"ClauseKey": "DistinctSelectedValueList"
					},
					"Selection": { "Facet": "BookStoreSale.IDBookStore", "Key": 1 }
				},
				{ "Key": 2, "Label": "Bright Library Books #2", "LabelResolved": true, "Count": 128, "Selected": false },
				{ "Key": 3, "Label": "Silent Orchard Books #3", "LabelResolved": true, "Count": 115, "Selected": false }
			]
		}
	}
}
```

Labels are read as the requesting principal, through the target's own list behaviors, with soft-deleted rows excluded. A key whose target row the principal cannot see (another tenant's, deleted, or missing) keeps `Label` equal to the key and gets `LabelResolved: false`. A target the principal may not read labels nothing; it is never an error.

## Buckets and Selection

| Field | For Terms |
|---|---|
| `Key` | The column value, normalized by data type: a number for numeric, ID, foreign-key and boolean columns, a string otherwise. |
| `Label` | The value as text, or the foreign-key label. |
| `Selected` | `true` when the facet's own clause selects this key (an `IN` or `EQ` on the column). |
| `Clause` | A `DistinctSelectedValueList` clause on the column. Writing it into the list filter selects exactly `Count` rows. |
| `Selection` | `{ Facet, Key }`, the server-side name of the bucket. |

A selected key that is not among the kept buckets is still returned, after them, with its real count (or `0`). A checked box never disappears from the list.

A value that contains `~` cannot travel in a meadow-filter string. Its bucket keeps `Selection` and `Count` but gets `Clause: null`.

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes. One ranked `GROUP BY` that returns at most `max(Top + 1, Limits.MaxTermsGroups)` groups, plus the selected keys. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when the column is mirrored. A Terms key on a `DateTime` column is answered Live (`ShapeUnsupported`). The usual store refusals apply (`NotMirrored`, `LossyColumn`, `DeletedRowsNotMirrored`, freshness). |

Terms facets on one entity are members of the conditional disjunctive scan: several of them, with the envelope Total, are answered by one `GROUP BY` (see [Architecture](#/page/Faceting_Architecture)).

## Notes and Limits

- `Limits.MaxTermsGroups` (10000) caps the groups a statement may return when counts tie at the cut.
- Strings longer than `Catalog.MaxTermsStringSize` (128) and uniquely indexed strings get no auto Terms facet.
- A numeric column's non-numeric text (`''` or `' '` stored in an integer column) counts as missing, not as a key.
- A `FacetID` naming another entity than the route's is a per-facet `FACET_UNKNOWN_FACET` (status 400) in `Errors`; a fold the column does not offer is a per-facet `FACET_UNKNOWN_FOLD` (status 400).

## Related

- [K7 Missing](#/page/fold_kinds/007-missing): what counts as missing.
- [K8 PathTerms](#/page/fold_kinds/008-path-terms) and [K9 BridgeTerms](#/page/fold_kinds/009-bridge-terms): Terms over related entities.
- [K14 Pivot](#/page/fold_kinds/014-pivot): Terms on two axes.
- [Concepts](#/page/Concepts): disjunctive faceting and the bucket clause round trip.
- [The Request Body](#/page/api/Request) and [The Response Envelope](#/page/api/Envelope).
