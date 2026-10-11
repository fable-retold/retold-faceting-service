# K11 AntiPath

> A filter: keep the rows that have **no visible** related row, along a path, matching a condition. Written as a `NotExists` predicate, optionally correlated on extra columns for composite keys.

## When to Use It

Use `NotExists` for "still to do" and "missing" questions: books nobody has reviewed, projects with no open blocker, catalog entries a store holds no stock row for, required forms nobody has completed. It is the filter behind most work lists.

Like [K10 PathSemiJoin](#/page/fold_kinds/010-path-semi-join), it narrows every facet and the Total; it is not a facet itself. Its semantics are deliberately "no **visible** match": a related row the principal cannot see does not count as a match, so the row stays in the list.

## How to Ask for It

Write a `NotExists` predicate in a named scope or a declared facet's `Where`:

```text
{ "NotExists": { "Path": [ <steps> ], "Where": [ <predicates on the last entity> ], "Correlate": [ [ outer, inner ] … ] } }
```

Two scopes on the Bookstore model: books with no visible review, and catalog entries (`BookStoreCatalogJoin`, a store's list of books it should carry) with no inventory row for the same book **and** the same store:

<!-- docs-check: definitions Id=k11-not-reviewed Fixture=Bookstore -->
```json
{
	"FormatVersion": 1,
	"Scopes":
	{
		"Book.Unreviewed":
		{
			"Entity": "Book",
			"Description": "Books with no visible review",
			"Where": [ { "NotExists": { "Path": [ "<Review.IDBook" ] } } ]
		},
		"BookStoreCatalogJoin.NotStocked":
		{
			"Entity": "BookStoreCatalogJoin",
			"Description": "Catalog entries the store holds no inventory row for",
			"Where":
			[
				{
					"NotExists":
					{
						"Path": [ "=BookStoreInventory.IDBook" ],
						"Correlate": [ [ "IDBookStore", "IDBookStore" ] ]
					}
				}
			]
		}
	}
}
```

The second scope uses a **co-reference** step, `=BookStoreInventory.IDBook`: standing on a catalog entry, go to the inventory rows that reference the same `Book` as the entry's own `IDBook`. `Correlate` adds the second half of the composite key: the inventory row's `IDBookStore` must equal the entry's `IDBookStore`. Each pair is `[ outer column, inner column ]`, and both columns must be numeric or both non-numeric.

A co-reference skips the shared parent (`Book`). When that parent can be soft-deleted or tenant-scoped, the registry adds a check that the parent is visible too, and logs the load warning `CheckParentForced`; this file loads with that warning and no disabled entry.

## Using It in a Scope

<!-- docs-check: request Fixture=Bookstore Entity=Book Definitions=k11-not-reviewed -->
```json
{
	"Scopes": [ { "Scope": "Book.Unreviewed" } ],
	"Facets": [ { "Key": "Language", "Facet": "Book.Language", "Top": 3 } ]
}
```

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Total": 64,
	"Filter": { "Applied": [ { "Scope": "Book.Unreviewed" } ], "Warnings": [] },
	"Facets":
	{
		"Language":
		{
			"Key": "Language",
			"Total": 64,
			"SumOfCounts": 56,
			"MissingCount": 1,
			"OtherCount": 7,
			"Buckets":
			[
				{ "Key": "eng", "Label": "eng", "Count": 41 },
				{ "Key": "en-US", "Label": "en-US", "Count": 13 },
				{ "Key": "", "Label": "", "Count": 2 }
			]
		}
	}
}
```

64 of the 1436 live books have no live review. The [K12 ChildRollup](#/page/fold_kinds/012-child-rollup) example's "None" band counts the same 64.

The composite scope on the catalog:

<!-- docs-check: request Fixture=Bookstore Entity=BookStoreCatalogJoin Definitions=k11-not-reviewed -->
```json
{
	"Scopes": [ { "Scope": "BookStoreCatalogJoin.NotStocked" } ],
	"Facets": [ { "Key": "Store", "Facet": "BookStoreCatalogJoin.IDBookStore", "Top": 3 } ]
}
```

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Total": 405,
	"Filter": { "Applied": [ { "Scope": "BookStoreCatalogJoin.NotStocked" } ], "Warnings": [] },
	"DependsOn": [ "Book", "BookStore", "BookStoreCatalogJoin", "BookStoreInventory" ],
	"Facets":
	{
		"Store":
		{
			"Key": "Store",
			"Total": 405,
			"Buckets":
			[
				{ "Key": 26, "Label": "Distant Station Books #26", "Count": 18 },
				{ "Key": 2, "Label": "Bright Library Books #2", "Count": 15 },
				{ "Key": 6, "Label": "Quiet Mountain Books #6", "Count": 15 }
			]
		}
	}
}
```

405 of the 420 catalog entries have no matching inventory row. `DependsOn` shows every entity the answer reads: the inventory hop, the forced parent check on `Book`, and the store labels.

## What It Compiles To

On the Live engine the outermost node is `NOT EXISTS` and every inner hop is `EXISTS`: "no visible chain". This excerpt is the composite anti-join of the [lab-forms example](#/page/examples/E3_Lab_Forms_To_Fill_Out) on SQLite, from the golden `K11-AntiPathComposite|SQLite` in `test/goldens/Facet-Live-M2-Goldens.json` (line breaks added, the rest of the statement cut):

```sql
… AND NOT EXISTS (SELECT 1
	FROM (SELECT "IDLabForm", "IDLabFormType", "IDMaterialIntake" FROM LabForm
		WHERE ( `Status` = :j4_w1_Status_w1 ) AND `Deleted` = :j4_FacetSoftDelete_w3 AND `IDCustomer` = :j4_TestTenancy_w4) "j4"
	WHERE "j4"."IDMaterialIntake" = "p"."IDMaterialIntake" AND "j4"."IDLabFormType" = "p"."IDLabFormType") …
```

The `LabForm` relation is a Scoped Relation: the definition's `Where` in its own fence, an explicit `Deleted = 0`, and the tenant predicate the entity's behavior appended. Its owner predicate is absent because that step is `TenantOnly` ("a form completed by anyone in my lab counts"). The second correlation (`IDLabFormType`) comes from `Correlate`. Every comparison is an equality, so a NULL never matches, and the anti-join is `NOT EXISTS`, never `NOT IN`.

## Using It in a Definition `Where`

A `NotExists` in a declared facet's `Where` restricts that facet only; the facet then reports `Semantics: "NoVisibleMatch"` so a client can say "no match visible to you" rather than "no match". The lab-forms example's `MaterialIntake.FormsToDo` facet combines a TuplePivot with a correlated `NotExists` to count "expected minus actual" (see [K18 TuplePivot](#/page/fold_kinds/018-tuple-pivot)).

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes, as above. An Opaque hop of an entity in `Scope.TrustedOpaque` runs Staged, rendered as `NOT EXISTS` over the bound key set. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when every entity and column is mirrored (`NOT ifNull(… IN (SELECT …), 0)`, which keeps a row whose correlation value is NULL, as `NOT EXISTS` does). A correlation with a row more than one level up (a `Correlate` at the end of a multi-step path) cannot be expressed on ClickHouse and is answered Live (`ShapeUnsupported`). |

## Notes and Limits

- The same load-time limits as `Exists` apply: `Limits.MaxHops`, `Limits.MaxExistsDepth`.
- `Correlate` takes 1 to 8 pairs. In a TuplePivot, an outer column is written `alias.Column`.
- A `TenantOnly` step is legal only on existence paths, needs a `ScopeReason`, and is refused at load when the entity has no other policy column to keep (so a relaxation can never read across tenants). See [Security and Tenancy](#/page/Security_And_Tenancy).

## Related

- [K10 PathSemiJoin](#/page/fold_kinds/010-path-semi-join): the positive form.
- [K20 ExistsSplit](#/page/fold_kinds/020-exists-split): both sides as buckets.
- [K18 TuplePivot](#/page/fold_kinds/018-tuple-pivot): expected minus actual.
- [Definitions Files](#/page/Definitions): co-reference steps, `CheckParent` and `Correlate`.
