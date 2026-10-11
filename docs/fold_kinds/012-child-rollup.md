# K12 ChildRollup

> Buckets an entity's rows by how many visible child rows each one has, in bands you declare: none, 1–2, 3–4, 5–9, 10 or more.

## When to Use It

Use a ChildRollup to show activity per parent: books by number of reviews, projects by number of my overdue tasks, customers by number of orders. The counted entity stays the parent; the children are only counted. Each parent row falls in exactly one band, so the facet is single-valued.

To filter by a child count instead ("at least three good reviews"), use [K19 HavingCount](#/page/fold_kinds/019-having-count).

## How to Ask for It

Declare a `ChildRollup` dimension with a `Child` (one `<` step to the child entity, `Agg: 'count'`, an optional `Where` on the child) and band `Edges`:

<!-- docs-check: definitions Id=k12-review-count Fixture=Bookstore -->
```json
{
	"FormatVersion": 1,
	"Facets":
	[
		{
			"Facet": "Book.ReviewCount",
			"Version": 1,
			"Title": "Reviews per book",
			"Dimensions":
			[
				{
					"Kind": "ChildRollup",
					"Child": { "Path": [ "<Review.IDBook" ], "Agg": "count" },
					"Edges": [ 1, 3, 5, 10 ]
				}
			],
			"Exclude": "None"
		}
	]
}
```

| Dimension field | Rule |
|---|---|
| `Child.Path` | Exactly one `<` step from the facet's entity to the child entity. |
| `Child.Agg` | `count`. Other aggregates (`sum`, `min`, `max`, `avg`) are planned and load as unsupported. |
| `Child.Where` | Optional predicates on the child: only matching children are counted (for example "assigned to me, overdue, not done"). |
| `Edges` | Strictly ascending positive integers starting at `1`. Band 0 is "no visible matching child"; band *i* is `[Edges[i−1], Edges[i])`; the last band is open. |
| `Labels` | Optional `{ "<band>": "<label>" }` overrides. |

<!-- docs-check: request Fixture=Bookstore Entity=Book Definitions=k12-review-count -->
```json
{ "Facets": [ { "Key": "Reviews", "Facet": "Book.ReviewCount" } ] }
```

## Example

The full captured facet result, without the engine and display fields:

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Total": 1436,
	"Facets":
	{
		"Reviews":
		{
			"Key": "Reviews",
			"Facet": "Book.ReviewCount",
			"Fold": "ChildRollup",
			"Selectable": true,
			"ClauseType": null,
			"Disjunctive": "NotApplicable",
			"CountMode": "Rows",
			"Declared": true,
			"Path": [ "<Review.IDBook" ],
			"Semantics": "NoVisibleMatch",
			"Total": 1436,
			"SumOfCounts": 1436,
			"MissingCount": 0,
			"OtherCount": 0,
			"Buckets":
			[
				{
					"Key": 0,
					"Label": "None",
					"Count": 64,
					"Selected": false,
					"Clause": null,
					"Selection": { "Facet": "Book.ReviewCount", "Key": 0 }
				},
				{
					"Key": 1,
					"Label": "1–2",
					"Count": 467,
					"Selected": false,
					"Start": 1,
					"End": 3,
					"EndExclusive": true,
					"Clause": null,
					"Selection": { "Facet": "Book.ReviewCount", "Key": 1 }
				},
				{
					"Key": 2,
					"Label": "3–4",
					"Count": 464,
					"Selected": false,
					"Start": 3,
					"End": 5,
					"EndExclusive": true,
					"Clause": null,
					"Selection": { "Facet": "Book.ReviewCount", "Key": 2 }
				},
				{
					"Key": 3,
					"Label": "5–9",
					"Count": 380,
					"Selected": false,
					"Start": 5,
					"End": 10,
					"EndExclusive": true,
					"Clause": null,
					"Selection": { "Facet": "Book.ReviewCount", "Key": 3 }
				},
				{
					"Key": 4,
					"Label": "10+",
					"Count": 61,
					"Selected": false,
					"Start": 10,
					"Clause": null,
					"Selection": { "Facet": "Book.ReviewCount", "Key": 4 }
				}
			]
		}
	}
}
```

Every band comes back, zero-filled, in band order. The bands partition the books, so `SumOfCounts` equals `Total` and nothing is missing. Band 0 is exactly the 64 books with no visible review, the same set the [K11 AntiPath](#/page/fold_kinds/011-anti-path) scope `Book.Unreviewed` selects. `Semantics: "NoVisibleMatch"` reminds a client that "None" means "none this principal can see".

## Buckets and Selection

- **`Key`** is the band number, `0` to the number of edges. **`Label`** is `None` for band 0, `a–(b−1)` for a closed band (`a` alone when the band holds one value), `a+` for the open band, unless `Labels` overrides it.
- **`Start` and `End`** are the band's child-count edges; band 0 has neither, the open band only `Start`.
- **`Clause` is always `null`.** No standard pict clause expresses "has between 3 and 4 visible reviews". Each bucket keeps its `Selection`.

> **Planned.** Selecting a bucket by its `Selection` (a `FacetSelection` clause), for kinds whose buckets have no pict clause; today such a clause answers `422 FACET_FOLD_UNSUPPORTED` with `Detail.Feature: 'Selections'`.

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes. Each parent row gets a correlated `count(*)` over the child's Scoped Relation (its `Where` fenced, soft delete and scope applied), and a `CASE` over the edges turns the count into a band. A parent with no visible child counts 0 and lands in band 0, never a dropped row. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when the parent and child entities and columns are mirrored. |

ChildRollup facets are members of the conditional disjunctive scan (see [Architecture](#/page/Faceting_Architecture)).

## Notes and Limits

- A ChildRollup counts under the whole filter by default (`Exclude: 'None'`) and owns no clause.
- A ChildRollup cannot be a pivot axis.
- `Edges` that do not start at 1, or are not strictly ascending integers, disable the definition at load (`BandEdges`): band 0 must mean exactly "no visible child".

## Related

- [K19 HavingCount](#/page/fold_kinds/019-having-count): a child count as a filter.
- [K20 ExistsSplit](#/page/fold_kinds/020-exists-split): "has any" as two buckets.
- [K9 BridgeTerms](#/page/fold_kinds/009-bridge-terms): the children's values as keys.
- [Definitions Files](#/page/Definitions).
