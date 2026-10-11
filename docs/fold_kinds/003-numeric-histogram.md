# K3 NumericHistogram

> Counts an entity's rows per numeric band: equal-width bands with round edges (`Nice`), or bands between edges you declare (`Edges`).

## When to Use It

Use a NumericHistogram to show how a number is distributed: prices, amounts, counts, years. It is the default fold of `Numeric` (integer) and `Decimal` columns. For a few named bands ("low", "medium", "high") use [K4 Ranges](#/page/fold_kinds/004-ranges); for totals and averages use [K5 Stats](#/page/fold_kinds/005-stats).

## How to Ask for It

**Nice mode** (the default) picks a width from 1, 2 or 5 times a power of ten, so the edges are round numbers. `Buckets` is the target number of bands:

<!-- docs-check: request Fixture=Bookstore Entity=BookPrice -->
```json
{
	"Facets": [ { "Key": "Price", "Facet": "BookPrice.Price", "Buckets": 8 } ]
}
```

**Edges mode** uses the edges you give. `OpenEnded: true` adds a last band from the last edge up:

<!-- docs-check: request Fixture=Bookstore Entity=Book -->
```json
{
	"Facets":
	[
		{
			"Key": "Era",
			"Facet": "Book.PublicationYear",
			"Edges": [ 1900, 1950, 2000, 2020 ],
			"OpenEnded": true
		}
	]
}
```

| Option | Default | Meaning |
|---|---|---|
| `Mode` | `Nice`, or `Edges` when `Edges` is given | `Nice` or `Edges`. `Log` is planned and answers `422 FACET_FOLD_UNSUPPORTED`. |
| `Buckets` | `Limits.DefaultBuckets` (20) | Nice mode: the target number of bands. Clamped to `Limits.MaxBuckets` (500) with a `FACET_BUCKETS_CLAMPED` warning. |
| `Edges` | none | Edges mode: 2 to `MaxBuckets + 1` strictly ascending finite numbers. |
| `OpenEnded` | `false` | Edges mode: add a band `[last edge, ∞)`. |
| `Missing` | `true` | Report rows with no number in `MissingCount`. |
| `Exclude` | `Self` | Which clauses the facet ignores. |

In a definitions file: `{ "Kind": "NumericHistogram", "Field": "Price", "Mode": "Edges", "Edges": [ 0, 10, 25, 50 ] }`. A Boolean column can never be a numeric dimension.

## Example

The Nice histogram of book prices, a `Decimal(8,2)` column. Abridged: engine and display fields are removed, and buckets after the first are shown without `Selected`, `Clause` and `Selection`.

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Facets":
	{
		"Price":
		{
			"Key": "Price",
			"Facet": "BookPrice.Price",
			"Fold": "NumericHistogram",
			"Disjunctive": "Exact",
			"CountMode": "Rows",
			"Total": 1571,
			"SumOfCounts": 1571,
			"MissingCount": 0,
			"OtherCount": 0,
			"Bounds": { "Lo": 5, "Hi": 59.96 },
			"Geometry": { "Mode": "Nice", "Lo": 5, "Hi": 59.96, "Width": 10, "N": 6, "Scale": 2, "Edges": [ 0, 10, 20, 30, 40, 50, 60 ] },
			"Buckets":
			[
				{
					"Key": 0,
					"Label": "0–<10",
					"Count": 134,
					"Selected": false,
					"Start": 0,
					"End": 10,
					"EndExclusive": true,
					"Clause":
					{
						"Type": "NumericRange",
						"FilterByColumn": "Price",
						"Values": { "Start": 0, "End": 10 },
						"EndExclusive": true,
						"FilterKey": "Price",
						"ClauseKey": "NumericRange"
					},
					"Selection": { "Facet": "BookPrice.Price", "Key": 0 }
				},
				{ "Key": 1, "Label": "10–<20", "Count": 269, "Start": 10, "End": 20, "EndExclusive": true },
				{ "Key": 2, "Label": "20–<30", "Count": 325, "Start": 20, "End": 30, "EndExclusive": true },
				{ "Key": 3, "Label": "30–<40", "Count": 264, "Start": 30, "End": 40, "EndExclusive": true },
				{ "Key": 4, "Label": "40–<50", "Count": 293, "Start": 40, "End": 50, "EndExclusive": true },
				{ "Key": 5, "Label": "50–60", "Count": 286, "Start": 50, "End": 60, "EndExclusive": false }
			]
		}
	}
}
```

Eight bands were asked for; prices run from 5 to 59.96, so a width of 10 covers them in six. The `Geometry` block tells a chart exactly where the edges are. Every band is half-open except the last, which is closed (`EndExclusive: false`) so the maximum value lands in it.

The Edges example on `Book.PublicationYear` (abridged the same way, buckets without `Selected`, `Clause` and `Selection`):

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Facets":
	{
		"Era":
		{
			"Key": "Era",
			"Fold": "NumericHistogram",
			"Total": 1436,
			"SumOfCounts": 1373,
			"MissingCount": 33,
			"OtherCount": 30,
			"Bounds": { "Lo": -1750, "Hi": 2017 },
			"Geometry":
			{
				"Mode": "Edges",
				"Lo": 1900,
				"Hi": null,
				"Width": null,
				"N": 4,
				"Scale": 0,
				"Edges": [ 1900, 1950, 2000, 2020 ],
				"OpenEnded": true
			},
			"Buckets":
			[
				{ "Key": 0, "Label": "1900–1949", "Count": 11, "Start": 1900, "End": 1950, "EndExclusive": true },
				{ "Key": 1, "Label": "1950–1999", "Count": 657, "Start": 1950, "End": 2000, "EndExclusive": true },
				{ "Key": 2, "Label": "2000–2019", "Count": 705, "Start": 2000, "End": 2020, "EndExclusive": true },
				{ "Key": 3, "Label": "2020+", "Count": 0, "Start": 2020, "EndExclusive": true }
			]
		}
	}
}
```

The 30 books published before 1900 (the fixture plants one in the year −1750) fall below the first edge: they are in no band, so they are `OtherCount`. Integer columns get integer labels: `1900–1949` means 1900 to 1949 inclusive, because the band is `[1900, 1950)`. The open band has only a `Start` and is labelled `2020+`.

An integer column in Nice mode gets integer widths too. `BookStoreInventory.BookCount` with `Buckets: 8`:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreInventory -->
```json
{ "Facets": [ { "Key": "Copies", "Facet": "BookStoreInventory.BookCount", "Buckets": 8 } ] }
```

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Facets":
	{
		"Copies":
		{
			"Key": "Copies",
			"Total": 1563,
			"MissingCount": 22,
			"Geometry": { "Mode": "Nice", "Lo": 0, "Hi": 49, "Width": 10, "N": 5, "Scale": 0, "Edges": [ 0, 10, 20, 30, 40, 50 ] },
			"Buckets":
			[
				{ "Key": 0, "Label": "0–9", "Count": 550, "Start": 0, "End": 10, "EndExclusive": true },
				{ "Key": 1, "Label": "10–19", "Count": 284, "Start": 10, "End": 20, "EndExclusive": true },
				{ "Key": 2, "Label": "20–29", "Count": 247, "Start": 20, "End": 30, "EndExclusive": true },
				{ "Key": 3, "Label": "30–39", "Count": 241, "Start": 30, "End": 40, "EndExclusive": true },
				{ "Key": 4, "Label": "40–50", "Count": 219, "Start": 40, "End": 50, "EndExclusive": false }
			]
		}
	}
}
```

`MissingCount` (22) counts every row without a number: NULL, and text such as `''` or `' '` stored in the integer column (the fixture plants a few such rows, which SQLite allows). A number column's non-numeric text is always missing, never a band.

## Buckets and Selection

- **`Key`** is the band index, `0` to `N − 1`.
- **`Start` and `End`** are the band edges; `EndExclusive` is `true` except on the last Nice band. An open Edges band has only `Start`.
- **The `Clause`** is a `NumericRange` clause with the same `Start`, `End` and `EndExclusive`. Writing it into the list filter selects exactly `Count` rows.
- **`Selected`** is `true` when the facet's own range clauses select a range that contains the whole band. On integer columns `GT a` is read as `GE a+1` and `LE b` as `LT b+1`, so a closed band `[90, 100]` matches a selection of `90` to `100`.
- **Exact arithmetic.** The geometry is computed in integer units of the column's scale (cents for a `Decimal(…,2)`), and the band a value falls in is decided against the exact edges, on every engine. A value stored with more decimals than its scale still lands where its band's clause puts it.

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes. Nice mode runs two statements: the bounds, then the bands. Edges mode runs one. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when the column is mirrored; the same two-phase plan as Live. A decimal column with more than 15 significant digits, or integer text such as `''`, makes the column lossy and the facet is answered Live (`LossyColumn`). |

Edges-mode histograms are members of the conditional disjunctive scan; Nice-mode histograms keep their own statements, because their edges depend on the bounds of the rows they count (see [Architecture](#/page/Faceting_Architecture)).

## Notes and Limits

- A NumericHistogram cannot be a pivot axis. A pivot over an integer column uses Terms on that axis; a pivot over a decimal column needs `Ranges` (see [K14 Pivot](#/page/fold_kinds/014-pivot)).
- `Edges` combined with `Mode: 'Nice'` is `400 FACET_REQUEST_INVALID`, and so is `Mode: 'Edges'` without `Edges`.
- With no non-null values, Nice mode returns no bands.

## Related

- [K4 Ranges](#/page/fold_kinds/004-ranges): named, possibly uneven bands.
- [K5 Stats](#/page/fold_kinds/005-stats): min, max, sum and average of the same column.
- [Concepts](#/page/Concepts): half-open buckets and `OtherCount`.
- [The Request Body](#/page/api/Request) and [The Response Envelope](#/page/api/Envelope).
