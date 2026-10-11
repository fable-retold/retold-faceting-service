# K20 ExistsSplit

> Splits an entity's rows into two buckets: those that have at least one visible related row matching a condition, and those that do not.

## When to Use It

Use an ExistsSplit for "has / has not" facets: books with and without a 5-star review, projects with and without open issues, required forms already started or not started. It is the bucket form of the [K10 PathSemiJoin](#/page/fold_kinds/010-path-semi-join) and [K11 AntiPath](#/page/fold_kinds/011-anti-path) filters: the two buckets always add up to the total.

## How to Ask for It

Declare an `ExistsSplit` dimension with a `Path`, an optional `Where` on the last entity, an optional `Correlate`, and optional `Labels` for the two buckets:

<!-- docs-check: definitions Id=k20-five-star Fixture=Bookstore -->
```json
{
	"FormatVersion": 1,
	"Facets":
	[
		{
			"Facet": "Book.HasFiveStar",
			"Version": 1,
			"Title": "Five-star reviews",
			"Dimensions":
			[
				{
					"Kind": "ExistsSplit",
					"Path": [ "<Review.IDBook" ],
					"Where": [ { "Field": "Rating", "Op": "EQ", "Value": 5 } ],
					"Labels": { "true": "Has a 5-star review", "false": "No 5-star review" }
				}
			],
			"Exclude": "None"
		}
	]
}
```

Without `Labels` the buckets are labelled `Yes` and `No`. The path may have several steps, and its steps may be `TenantOnly`, as for `Exists`.

<!-- docs-check: request Fixture=Bookstore Entity=Book Definitions=k20-five-star -->
```json
{ "Facets": [ { "Key": "FiveStar", "Facet": "Book.HasFiveStar" } ] }
```

## Example

The full captured facet result, without the engine and display fields:

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Total": 1436,
	"DependsOn": [ "Book", "Review" ],
	"Facets":
	{
		"FiveStar":
		{
			"Key": "FiveStar",
			"Facet": "Book.HasFiveStar",
			"Fold": "ExistsSplit",
			"DataType": "Boolean",
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
					"Key": 1,
					"Label": "Has a 5-star review",
					"Count": 931,
					"Selected": false,
					"Clause": null,
					"Selection": { "Facet": "Book.HasFiveStar", "Key": 1 }
				},
				{
					"Key": 0,
					"Label": "No 5-star review",
					"Count": 505,
					"Selected": false,
					"Clause": null,
					"Selection": { "Facet": "Book.HasFiveStar", "Key": 0 }
				}
			]
		}
	}
}
```

Bucket `1` (a visible match exists) always comes first, then bucket `0`. Both are returned even at zero, and they partition the rows: 931 + 505 = 1436. `Semantics: "NoVisibleMatch"` marks bucket `0` as "no match this principal can see".

## What It Compiles To

The Live engine evaluates the existence test as a computed flag per row and groups by it. The golden `K20-ExistsSplit|SQLite` in `test/goldens/Facet-Live-M2-Goldens.json` is short enough to show whole: ProjectTrack projects split by whether they have an open issue (line breaks added):

```sql
SELECT "d"."Key" AS "Key", count(*) AS "Count"
FROM (SELECT "p"."FacetX0" AS "Key"
	FROM (SELECT "p"."IDProject" AS "IDProject",
			CASE WHEN EXISTS (SELECT 1
				FROM (SELECT "IDIssue", "IDProject" FROM Issue
					WHERE ( `State` = :e1_w1_State_w1 ) AND `Deleted` = :e1_FacetSoftDelete_w3 AND `IDCustomer` = :e1_TestTenancy_w4) "e1"
				WHERE "e1"."IDProject" = "p"."IDProject") THEN 1 ELSE 0 END AS "FacetX0"
		FROM (SELECT "IDProject" FROM Project
			WHERE `Deleted` = :p_FacetSoftDelete_w0 AND `IDCustomer` = :p_TestTenancy_w1) "p") "p") "d"
GROUP BY "d"."Key"
```

Both `Project` and `Issue` appear as Scoped Relations: each has its explicit `Deleted = 0` and the tenant predicate its own behavior added, and the issue relation has the dimension's `Where` in its fence.

## Buckets and Selection

- **`Key`** is `1` or `0`; **`Label`** comes from `Labels`, else `Yes` / `No`.
- **`Clause` is `null`** on both buckets: no standard pict clause expresses an existence test over an arbitrary path. Each bucket keeps its `Selection`. To filter the list to one side, apply a named scope with the same `Exists` or `NotExists`.

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes, as above. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when every entity and column on the path is mirrored; the existence test becomes a `UInt8` key. |

ExistsSplit facets are members of the conditional disjunctive scan (see [Architecture](#/page/Faceting_Architecture)).

## Notes and Limits

- An ExistsSplit counts under the whole filter by default (`Exclude: 'None'`) and owns no clause.
- It cannot be a pivot axis.
- The path follows the same rules and limits as `Exists` (`Limits.MaxHops`, `Limits.MaxExistsDepth`).

## Related

- [K10 PathSemiJoin](#/page/fold_kinds/010-path-semi-join) and [K11 AntiPath](#/page/fold_kinds/011-anti-path): each side as a filter.
- [K12 ChildRollup](#/page/fold_kinds/012-child-rollup): more than two bands.
- [K17 UnionOfPaths](#/page/fold_kinds/017-union-of-paths).
- [Definitions Files](#/page/Definitions).
