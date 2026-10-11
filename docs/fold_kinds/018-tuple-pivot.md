# K18 TuplePivot

> Counts distinct key tuples of a declared join of two to four entities, such as (store, book) pairs from a store's catalog, instead of counting rows of one entity.

## When to Use It

Use a TuplePivot when the thing to count is implied by configuration rather than stored as a row: "the books each store's catalog says it should carry", "the forms each intake requires, given its material type". Combined with a [K11 AntiPath](#/page/fold_kinds/011-anti-path) predicate it counts **expected minus actual**: catalog titles a store has not stocked, required forms nobody has filed.

If the expected items are stored as rows (a requirements table), facet that entity directly instead; the [lab-forms example](#/page/examples/E3_Lab_Forms_To_Fill_Out) shows both designs side by side.

## How to Ask for It

TuplePivots are declared in definitions files only. The facet's `Pivot` is a `Tuple` with `From` sides, `On` join pairs and the `Key` that makes a tuple distinct:

<!-- docs-check: definitions Id=k18-unstocked-titles Fixture=Bookstore -->
```json
{
	"FormatVersion": 1,
	"Facets":
	[
		{
			"Facet": "BookStore.UnstockedTitles",
			"Version": 1,
			"Title": "Catalog titles a store has not stocked",
			"Home": "BookStore",
			"Pivot":
			{
				"Tuple":
				{
					"From": [ { "As": "s", "Entity": "BookStore" }, { "As": "c", "Entity": "BookStoreCatalogJoin" } ],
					"On": [ [ "s.IDBookStore", "c.IDBookStore" ] ],
					"Key": [ "s.IDBookStore", "c.IDBook" ]
				}
			},
			"Where":
			[
				{
					"NotExists":
					{
						"From": "s",
						"Path": [ "<BookStoreInventory.IDBookStore" ],
						"Correlate": [ [ "c.IDBook", "IDBook" ] ]
					}
				}
			],
			"Dimensions": [ { "Kind": "Terms", "Field": "s.State", "Top": 10 } ]
		}
	]
}
```

Read it as: for every store `s` and every catalog entry `c` of that store, the tuple `(store, book)`; keep the tuples for which the store has no visible inventory row of that book; bucket them by the store's state.

| Part | Rule |
|---|---|
| `From` | 2 to 4 sides, each `{ As, Entity, Where? }`. `As` is a short lowercase alias; a side's `Where` filters that side's rows and may reference scopes. |
| `On` | Equality pairs `[ "a.Column", "b.Column" ]`. Every side must connect to the home side through pairs where one column is a foreign key to the other side's primary key, or both are foreign keys to the same target. |
| `Key` | The `alias.Column` list that identifies a tuple. The facet counts distinct `Key` tuples. |
| `Home` | The route entity; it must be one of the `From` entities. Client filters on the request apply to the home side. |
| Facet `Where` | Predicates on the tuple. An existence predicate names its starting side with `From`, and `Correlate` pairs name outer columns as `alias.Column`. |
| Dimensions | `Terms`, `DateHistogram`, `NumericHistogram` or `Ranges` on `alias.Column`, where that side's primary key (or the column itself) is in `Key`. No `Path`. |

Ask for it like any declared facet, on the home entity's route:

<!-- docs-check: request Fixture=Bookstore Entity=BookStore Definitions=k18-unstocked-titles -->
```json
{ "Facets": [ { "Key": "Unstocked", "Facet": "BookStore.UnstockedTitles" } ] }
```

## Example

Captured on the Bookstore fixture. Abridged: engine and display fields are removed, buckets after the first are shown without `Selected`, `Clause` and `Selection`, and four of the eight buckets are cut.

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Total": 38,
	"DependsOn": [ "BookStore", "BookStoreCatalogJoin", "BookStoreInventory" ],
	"Facets":
	{
		"Unstocked":
		{
			"Key": "Unstocked",
			"Facet": "BookStore.UnstockedTitles",
			"Field": "State",
			"Fold": "Terms",
			"Selectable": true,
			"ClauseType": null,
			"Disjunctive": "NotApplicable",
			"CountMode": "KeyDistinct",
			"Declared": true,
			"Semantics": "NoVisibleMatch",
			"Total": 381,
			"SumOfCounts": 366,
			"MissingCount": 15,
			"OtherCount": 0,
			"Buckets":
			[
				{
					"Key": "CA",
					"Label": "CA",
					"Count": 83,
					"Selected": false,
					"Clause": null,
					"Selection": { "Facet": "BookStore.UnstockedTitles", "Key": "CA" }
				},
				{ "Key": "TX", "Label": "TX", "Count": 78 },
				{ "Key": "", "Label": "", "Count": 72 },
				{ "Key": "WA", "Label": "WA", "Count": 61 },
				"…"
			]
		}
	}
}
```

Two totals, two units:

- The envelope **`Total` (38)** counts the route entity: the live book stores.
- The facet **`Total` (381)** counts tuples: (store, book) pairs that are in a store's catalog with no inventory row. Its buckets count tuples too: 83 unstocked titles in California stores. `MissingCount` (15) is tuples whose store has no state.
- **`CountMode: "KeyDistinct"`**: a tuple is counted once however many join rows produce it. A definition that declares `CountMode: 'Rows'` is read as `KeyDistinct` (load warning `CountModeCanonicalized`).
- **`Semantics: "NoVisibleMatch"`**: "unstocked" means "no inventory row this principal can see".

## What It Compiles To

The Live engine joins the sides' Scoped Relations by alias and keeps distinct key tuples, then folds them like any Terms facet. An excerpt of the lab-forms TuplePivot on SQLite, from the golden `K18-TuplePivot|SQLite` in `test/goldens/Facet-Live-M2-Goldens.json` (line breaks added; the predicate bodies are cut):

```sql
SELECT DISTINCT "p"."IDMaterialIntake" AS "TK0", "u1"."IDLabFormType" AS "TK1", "u1"."IDLabFormType" AS "FacetT0"
FROM (SELECT "IDMaterialIntake", "IDLabQueue", "IDMaterialType", "ReceivedDate" FROM MaterialIntake
	WHERE ( `Status` IN ( :p_w1_Status_w1_0, :p_w1_Status_w1_1 ) ) AND `Deleted` = :p_FacetSoftDelete_w3 AND `IDCustomer` = :p_TestTenancy_w4) "p"
JOIN (SELECT "IDMaterialTypeFormRequirement", "IDLabFormType", "IDMaterialType" FROM MaterialTypeFormRequirement
	WHERE ( `Required` = :u1_w1_Required_w1 ) AND `Deleted` = :u1_FacetSoftDelete_w3 AND `IDCustomer` = :u1_TestTenancy_w4) "u1"
	ON "p"."IDMaterialType" = "u1"."IDMaterialType"
WHERE (EXISTS (…) AND NOT EXISTS (…))
```

The home side always takes the alias `p`, other sides `u1`, `u2`, …; definition aliases (`s`, `c`, `i`, `r`) never reach SQL. Each side is a complete Scoped Relation, so a TuplePivot can never pair a row with another tenant's row.

## Buckets and Selection

Buckets are those of the dimension's kind (Terms here), with one difference: **`Clause` is always `null`**. A tuple count is not a count of route-entity rows, so no list clause could select "the stores behind these 83 tuples" and round-trip the number. Each bucket keeps its `Selection`.

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes, as above: a two-level distinct over the key tuples. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when every side's entity and columns are mirrored (`uniqExact` over the key tuple). |

A TuplePivot keeps its own statement: it is not a member of the conditional disjunctive scan.

## Notes and Limits

- A TuplePivot facet owns no clause and counts under the whole filter (`Exclude: 'None'`).
- Stats, DistinctCount, Missing, ChildRollup and ExistsSplit over a TuplePivot, and a 2-D Pivot of one, are refused (`422 FACET_FOLD_UNSUPPORTED`).
- Clients cannot send a TuplePivot (`Fold: 'TuplePivot'` is `422`); they are server-authored in definitions files.
- A side that no `On` pair connects to the home side disables the definition at load (`TupleOnNotJoined`): it would be a near-cartesian product.

## Related

- [K11 AntiPath](#/page/fold_kinds/011-anti-path): the "minus actual" half.
- [E3: Lab Forms I Still Have to Fill Out](#/page/examples/E3_Lab_Forms_To_Fill_Out): stored requirements versus a TuplePivot over configuration.
- [Concepts](#/page/Concepts): count modes.
- [Definitions Files](#/page/Definitions).
