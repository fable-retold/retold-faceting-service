# K19 HavingCount

> A filter: keep the rows whose number of visible matching child rows passes a comparison, such as "at least three reviews rated 4 or more". Written as a `HavingCount` predicate.

## When to Use It

Use `HavingCount` for thresholds on related rows: projects with two or more overdue tasks, customers with more than five orders, books with fewer than two reviews. It narrows every facet and the Total, like the other predicate kinds.

To show the child count as buckets instead, use [K12 ChildRollup](#/page/fold_kinds/012-child-rollup).

## How to Ask for It

Write a `HavingCount` predicate in a named scope or a declared facet's `Where`. `Path` is one `<` or `=` step to the child entity, `Where` filters the children counted, `Op` is `EQ`, `NE`, `GT`, `GE`, `LT` or `LE`, and `Value` is a non-negative integer:

<!-- docs-check: definitions Id=k19-review-counts Fixture=Bookstore -->
```json
{
	"FormatVersion": 1,
	"Scopes":
	{
		"Book.ManyGoodReviews":
		{
			"Entity": "Book",
			"Description": "Books with at least three reviews rated 4 or 5",
			"Where":
			[
				{
					"HavingCount":
					{
						"Path": [ "<Review.IDBook" ],
						"Where": [ { "Field": "Rating", "Op": "GE", "Value": 4 } ],
						"Op": "GE",
						"Value": 3
					}
				}
			]
		},
		"Book.FewReviews":
		{
			"Entity": "Book",
			"Description": "Books with fewer than two reviews (none counts)",
			"Where": [ { "HavingCount": { "Path": [ "<Review.IDBook" ], "Op": "LT", "Value": 2 } } ]
		}
	}
}
```

`HavingCount` also accepts `Correlate` and, in a TuplePivot, `From`, exactly like `Exists`.

## Using It in a Scope

<!-- docs-check: request Fixture=Bookstore Entity=Book Definitions=k19-review-counts -->
```json
{
	"Scopes": [ { "Scope": "Book.ManyGoodReviews" } ],
	"Facets": [ { "Key": "Language", "Facet": "Book.Language", "Top": 3 } ]
}
```

<!-- docs-check: skip captured envelope, abridged to the totals and bucket counts -->
```json
{
	"Total": 564,
	"Filter": { "Applied": [ { "Scope": "Book.ManyGoodReviews" } ], "Warnings": [] },
	"Facets":
	{
		"Language":
		{
			"Key": "Language",
			"Total": 564,
			"Buckets": [ { "Key": "eng", "Count": 345 }, { "Key": "en-US", "Count": 102 }, { "Key": "", "Count": 39 } ]
		}
	}
}
```

564 of the 1436 live books have three or more visible reviews rated 4 or 5.

### Comparisons That Include Zero

The count is over **visible matching** children, and a row with none has a count of 0. So a comparison that is true for 0 keeps the rows with no children at all:

<!-- docs-check: request Fixture=Bookstore Entity=Book Definitions=k19-review-counts -->
```json
{
	"Scopes": [ { "Scope": "Book.FewReviews" } ],
	"Total": true,
	"Facets": [ { "Key": "Language", "Facet": "Book.Language", "Top": 3 } ]
}
```

<!-- docs-check: skip captured envelope, abridged to Total and Filter -->
```json
{ "Total": 260, "Filter": { "Applied": [ { "Scope": "Book.FewReviews" } ], "Warnings": [] } }
```

The 260 books include the 64 with no visible review ([K11 AntiPath](#/page/fold_kinds/011-anti-path) finds the same 64). `{ "Op": "LT", "Value": 1 }` means exactly "has none" (the same rows as `NotExists`), and `{ "Op": "GE", "Value": 1 }` exactly "has at least one" (the same rows as `Exists`).

## What It Compiles To

On the Live engine the count is a correlated subquery over the child's Scoped Relation. From the golden `K19-HavingCount|SQLite` in `test/goldens/Facet-Live-M2-Goldens.json`, a ProjectTrack project kept when it has at least N overdue, unfinished tasks assigned to the principal (line breaks added, the surrounding statement cut):

```sql
WHERE (SELECT count(*)
	FROM (SELECT "IDTask", "IDProject" FROM Task
		WHERE ( ( `AssignedIDUser` = :j3_w1_AssignedIDUser_w2 AND `DueDate` < :j3_w1_DueDate_w3 AND `Status` != :j3_w1_Status_w4 ) )
			AND `Deleted` = :j3_FacetSoftDelete_w7 AND `IDCustomer` = :j3_TestTenancy_w8) "j3"
	WHERE "j3"."IDProject" = "p"."IDProject") >= :q1_N
```

The child relation carries its `Where` in a fence, the explicit `Deleted = 0` and the tenant predicate from the entity's own behavior. Every value is bound, including the threshold.

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes, as above. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when the parent and child are mirrored. A comparison true for 0 is compiled as "not in the set of parents whose count fails it", so parents with no children are kept, as on Live. |

## Notes and Limits

- `Path` must be exactly one `<` or `=` step; a longer path loads as unsupported (`Feature: 'HavingCountPath'`) and requests that use it answer `422 FACET_FOLD_UNSUPPORTED`.
- `Value` is an integer of at least 0; `$Param` values are not accepted for it.

## Related

- [K12 ChildRollup](#/page/fold_kinds/012-child-rollup): the count as bands.
- [K10 PathSemiJoin](#/page/fold_kinds/010-path-semi-join) and [K11 AntiPath](#/page/fold_kinds/011-anti-path): "has any" and "has none".
- [Definitions Files](#/page/Definitions).
