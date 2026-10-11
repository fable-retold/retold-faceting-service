# K2 DateHistogram

> Counts an entity's rows per calendar bucket (day, ISO week, month, quarter or year) of one date column.

## When to Use It

Use a DateHistogram for timelines: sales per month, documents per week, sign-ups per year. It is the default fold of every `DateTime` column. For the earliest and latest date as numbers, use [K5 Stats](#/page/fold_kinds/005-stats) instead.

## How to Ask for It

Name a `DateTime` column, and optionally an interval:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale -->
```json
{
	"Facets": [ { "Key": "ByYear", "Facet": "BookStoreSale.SaleDate", "Interval": "year" } ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `Interval` | `Time.DefaultInterval` (`month`) | `day`, `week`, `month`, `quarter` or `year`. A catalog `Intervals` override can narrow the list for a column. |
| `EmptyBuckets` | `true` | Fill the gaps: every bucket between the first and the last non-empty one is returned, with `Count: 0` where nothing fell. |
| `Missing` | `true` | Report rows without a usable date in `MissingCount`. |
| `TimeZone` | the storage time zone | Must equal `Time.StorageTimeZone` (`UTC`); anything else is `422 FACET_TIMEZONE_UNSUPPORTED`. |
| `Order` | ascending | `KeyDesc` lists the newest bucket first. |
| `Chart` | `false` | `true` adds a `Chart` object (`Labels` and one dataset of counts) ready for a chart widget. |
| `Exclude` | `Self` | Which clauses the facet ignores. See [Concepts](#/page/Concepts). |

In a definitions file: `{ "Kind": "DateHistogram", "Field": "SaleDate", "Interval": "week" }`. Through a to-one path it becomes a [K8 PathTerms](#/page/fold_kinds/008-path-terms)-style dimension, for example a requirement's intake date.

## Example

Sales per year on the Bookstore fixture. Abridged: engine and display fields are removed, and buckets after the first are shown without their `Clause` and `Selection`.

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Facets":
	{
		"ByYear":
		{
			"Key": "ByYear",
			"Facet": "BookStoreSale.SaleDate",
			"Fold": "DateHistogram",
			"Disjunctive": "Exact",
			"Excluded": [],
			"CountMode": "Rows",
			"Total": 2918,
			"SumOfCounts": 2893,
			"MissingCount": 25,
			"OtherCount": 0,
			"Bounds": { "Lo": "2020-12-31 09:33:32", "Hi": "2024-12-30 21:55:33" },
			"Interval": "year",
			"TimeZone": "UTC",
			"Buckets":
			[
				{
					"Key": "2020-01-01 00:00:00",
					"Label": "2020",
					"Count": 1,
					"Selected": false,
					"Start": "2020-01-01 00:00:00",
					"End": "2021-01-01 00:00:00",
					"EndExclusive": true,
					"Clause":
					{
						"Type": "DateRange",
						"FilterByColumn": "SaleDate",
						"Values": { "Start": "2020-01-01 00:00:00", "End": "2021-01-01 00:00:00" },
						"EndExclusive": true,
						"FilterKey": "SaleDate",
						"ClauseKey": "DateRange"
					},
					"Selection": { "Facet": "BookStoreSale.SaleDate", "Key": "2020-01-01 00:00:00" }
				},
				{
					"Key": "2021-01-01 00:00:00",
					"Label": "2021",
					"Count": 711,
					"Selected": false,
					"Start": "2021-01-01 00:00:00",
					"End": "2022-01-01 00:00:00",
					"EndExclusive": true
				},
				{
					"Key": "2022-01-01 00:00:00",
					"Label": "2022",
					"Count": 720,
					"Selected": false,
					"Start": "2022-01-01 00:00:00",
					"End": "2023-01-01 00:00:00",
					"EndExclusive": true
				},
				{
					"Key": "2023-01-01 00:00:00",
					"Label": "2023",
					"Count": 740,
					"Selected": false,
					"Start": "2023-01-01 00:00:00",
					"End": "2024-01-01 00:00:00",
					"EndExclusive": true
				},
				{
					"Key": "2024-01-01 00:00:00",
					"Label": "2024",
					"Count": 721,
					"Selected": false,
					"Start": "2024-01-01 00:00:00",
					"End": "2025-01-01 00:00:00",
					"EndExclusive": true
				}
			]
		}
	}
}
```

The first sale is on the last day of 2020, so the 2020 bucket holds a single row. `Bounds` reports the earliest and latest stored values; the buckets run from the bucket of `Bounds.Lo` to the bucket of `Bounds.Hi`. The 25 sales with no date are `MissingCount`.

### Too Many Buckets

Daily buckets over four years would be about 1460 buckets, more than `Limits.MaxDateBuckets` (400). That facet fails on its own, with a suggestion; the rest of the request still answers:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale Expect=FACET_INTERVAL_TOO_FINE -->
```json
{
	"Facets": [ { "Key": "ByDay", "Facet": "BookStoreSale.SaleDate", "Interval": "day" } ]
}
```

<!-- docs-check: skip captured envelope, abridged to Total, Facets and Errors -->
```json
{
	"Total": 2918,
	"Facets": {},
	"Errors":
	{
		"ByDay":
		{
			"Code": "FACET_INTERVAL_TOO_FINE",
			"Status": 422,
			"Message": "The interval produces too many buckets.",
			"Detail": { "Interval": "day", "MaxDateBuckets": 400, "Suggest": { "Interval": "week" } }
		}
	}
}
```

The HTTP status is `200`: a request fails as a whole only when every facet and the Total failed. A client can retry the facet with `Detail.Suggest.Interval`.

### Partial Edge Buckets

Buckets follow the calendar, not the filter. With a March 2024 filter and `Exclude: 'None'` (count inside the filter, a drill-down), the first ISO week starts on 26 February:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreSale -->
```json
{
	"Clauses":
	[
		{
			"Type": "DateRange",
			"FilterByColumn": "SaleDate",
			"Values": { "Start": "2024-03-01 00:00:00", "End": "2024-04-01 00:00:00" },
			"EndExclusive": true,
			"FilterKey": "SaleDate"
		}
	],
	"Facets": [ { "Key": "ByWeek", "Facet": "BookStoreSale.SaleDate", "Interval": "week", "Exclude": "None" } ]
}
```

<!-- docs-check: skip captured envelope, abridged: buckets without Clause, Selection and EndExclusive -->
```json
{
	"Total": 66,
	"Facets":
	{
		"ByWeek":
		{
			"Key": "ByWeek",
			"Disjunctive": "NotApplicable",
			"Total": 66,
			"SumOfCounts": 66,
			"Bounds": { "Lo": "2024-03-01 01:38:36", "Hi": "2024-03-31 14:38:49" },
			"Buckets":
			[
				{
					"Key": "2024-02-26 00:00:00",
					"Label": "Week of 2024-02-26",
					"Count": 8,
					"Selected": false,
					"Start": "2024-02-26 00:00:00",
					"End": "2024-03-04 00:00:00"
				},
				{
					"Key": "2024-03-04 00:00:00",
					"Label": "Week of 2024-03-04",
					"Count": 18,
					"Selected": true,
					"Start": "2024-03-04 00:00:00",
					"End": "2024-03-11 00:00:00"
				},
				{
					"Key": "2024-03-11 00:00:00",
					"Label": "Week of 2024-03-11",
					"Count": 20,
					"Selected": true,
					"Start": "2024-03-11 00:00:00",
					"End": "2024-03-18 00:00:00"
				},
				{
					"Key": "2024-03-18 00:00:00",
					"Label": "Week of 2024-03-18",
					"Count": 10,
					"Selected": true,
					"Start": "2024-03-18 00:00:00",
					"End": "2024-03-25 00:00:00"
				},
				{
					"Key": "2024-03-25 00:00:00",
					"Label": "Week of 2024-03-25",
					"Count": 10,
					"Selected": true,
					"Start": "2024-03-25 00:00:00",
					"End": "2024-04-01 00:00:00"
				}
			]
		}
	}
}
```

The week of 26 February holds only the 8 sales of 1 to 3 March. It is not `Selected`, because the bucket's whole span `[Start, End)` does not lie inside the selected range; the four weeks that do are `Selected`. Keep this in mind when a chart shows the first or last bucket of a filtered range: it may be partial.

## Buckets and Selection

- **Dates are naive wall-clock values** in `Time.StorageTimeZone`, written `YYYY-MM-DD HH:mm:ss`. The service accepts stored values as `YYYY-MM-DD`, `YYYY-MM-DD HH:mm`, `YYYY-MM-DD HH:mm:ss`, with `T` for the space, optional fractions and an optional `Z`.
- **Keys** are bucket starts: `day` is midnight, `week` is the ISO Monday on or before the date, `month` the first of the month, `quarter` the first month of the quarter, `year` the first of January.
- **Labels**: `2026-03-02` (day), `Week of 2026-03-02`, `Mar 2026`, `Q1 2026`, `2026`.
- **Every bucket is half-open**: `Start` is included, `End` (the next bucket's start) is not, and `EndExclusive` is `true`.
- **The `Clause`** is a `DateRange` clause on the column with the same `Start`, `End` and `EndExclusive: true`. Writing it into the list filter selects exactly `Count` rows.
- **Missing** rows are those whose value is NULL, an empty string, or text that does not parse as a date.
- **`Selected`** is `true` when the facet's own date clauses select a range that contains the whole bucket.

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes. Bucket keys come from `strftime` expressions that match the service's own date math. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when the column is mirrored. A stored value the mirror cannot hold (an unparseable or empty date, a year outside 1900 to 2299) makes the column lossy, and facets that read it are answered Live (`LossyColumn`). On a SQLite source, a date stored in a non-canonical form (for example `2023-07-01 00:00`) is lossy for comparisons only: filters on the column are answered Live. |

DateHistogram facets are members of the conditional disjunctive scan (see [Architecture](#/page/Faceting_Architecture)). A statement returns at most `Limits.MaxDateBuckets + 2` keys; anything beyond that is `FACET_INTERVAL_TOO_FINE` whatever the rest holds.

## Notes and Limits

- `Limits.MaxDateBuckets` (400) caps the buckets after gap fill.
- Request time zones are not supported yet: dates are bucketed in `Time.StorageTimeZone`.
- With `EmptyBuckets: false`, only non-empty buckets come back.

## Related

- [K5 Stats](#/page/fold_kinds/005-stats): earliest and latest dates.
- [K14 Pivot](#/page/fold_kinds/014-pivot): a date axis against another dimension.
- [Concepts](#/page/Concepts): half-open buckets and the bucket clause round trip.
- [The Request Body](#/page/api/Request) and [The Response Envelope](#/page/api/Envelope).
