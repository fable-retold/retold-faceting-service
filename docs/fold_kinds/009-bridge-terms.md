# K9 BridgeTerms

> Buckets an entity's rows by a key reached through a to-many path, such as a book's authors through a join table. A row can carry several keys, so each bucket counts distinct rows and the buckets may add up to more than the total.

## When to Use It

Use BridgeTerms for many-to-many and parent-to-children questions: books by author (through `BookAuthorJoin`), projects by member, intakes by required form type, books by the ratings their reviews gave. The counted entity stays the same: the counts are books, and a book with three authors is counted once in each of the three author buckets.

For a single-valued key on a parent row, use [K8 PathTerms](#/page/fold_kinds/008-path-terms).

## How to Ask for It

Declare a `Terms` dimension whose `Path` has at least one `<` (to-many) or `=` (co-reference) step, and name the key column of the last entity with `KeyField`:

<!-- docs-check: definitions Id=k09-book-authors Fixture=Bookstore -->
```json
{
	"FormatVersion": 1,
	"Facets":
	[
		{
			"Facet": "Book.ByAuthor",
			"Version": 1,
			"Title": "Books by author",
			"Dimensions":
			[
				{
					"Kind": "Terms",
					"Path": "@Book~Author",
					"KeyField": "IDAuthor",
					"LabelField": "Name",
					"Top": 5
				}
			],
			"Exclude": "Self"
		}
	]
}
```

`@Book~Author` is a synthetic **bridge alias**. Apart from its identity, audit and tenant columns, `BookAuthorJoin` holds exactly two foreign keys, so the graph detects it as a bridge and offers the alias `<first target>~<second target>` for its two steps, `<BookAuthorJoin.IDBook >BookAuthorJoin.IDAuthor`. "First" and "second" follow the order of the two foreign-key columns in the model, and the alias works only from the first target. You can write those steps out instead, or declare your own alias in the file's `Aliases`. The alias is only a shorthand: every hop is still its own Scoped Relation, tenancy included.

To list the bridge aliases of your own model, call `fable.RetoldFacetingGraph.aliases()`. On the Bookstore it returns:

<!-- docs-check: skip captured return value -->
```json
{
	"Book~Author": [ "<BookAuthorJoin.IDBook", ">BookAuthorJoin.IDAuthor" ],
	"Book~BookStore": [ "<BookStoreCatalogJoin.IDBook", ">BookStoreCatalogJoin.IDBookStore" ]
}
```

There is no `Author~Book`: a path from the `Author` side writes the two steps out in the other order. Authors by the genres of their books:

<!-- docs-check: definitions Id=k09-author-genres Fixture=Bookstore -->
```json
{
	"FormatVersion": 1,
	"Facets":
	[
		{
			"Facet": "Author.ByBookGenre",
			"Version": 1,
			"Title": "Authors by the genres of their books",
			"Dimensions":
			[
				{ "Kind": "Terms", "Path": [ "<BookAuthorJoin.IDAuthor", ">BookAuthorJoin.IDBook" ], "KeyField": "Genre", "Top": 5 }
			]
		}
	]
}
```

<!-- docs-check: request Fixture=Bookstore Entity=Author Definitions=k09-author-genres -->
```json
{ "Facets": [ { "Key": "Genres", "Facet": "Author.ByBookGenre" } ], "Total": true }
```

Captured: `Total` 385 authors; the top buckets are `Fiction` 265, `Mystery` 176, `Romance` 156, `Science Fiction` 153 and `Fantasy` 138. An author who wrote books in three genres is counted once in each.

| Dimension field | Meaning |
|---|---|
| `Path` | Steps from the facet's entity; at least one `<` or `=` step. |
| `KeyField` | The column of the last entity whose values become the keys (its primary key, or any other non-sensitive column). |
| `LabelField` | Optional label column of the last entity. |
| `Where` | Optional predicates on the last entity: only matching related rows contribute keys (for example `Active = 1` on a membership). |

The count mode is always `PivotDistinct`. A definition that declares `CountMode: 'Rows'` on such a dimension is disabled at load.

Ask for the facet by its name:

<!-- docs-check: request Fixture=Bookstore Entity=Book Definitions=k09-book-authors -->
```json
{ "Facets": [ { "Key": "Authors", "Facet": "Book.ByAuthor" } ] }
```

## Example

Captured on the Bookstore fixture. Abridged: engine and display fields are removed, and buckets after the first are shown without `LabelResolved`, `Clause` and `Selection`.

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Total": 1436,
	"DependsOn": [ "Author", "Book", "BookAuthorJoin" ],
	"Facets":
	{
		"Authors":
		{
			"Key": "Authors",
			"Facet": "Book.ByAuthor",
			"Field": "IDAuthor",
			"Fold": "Terms",
			"ClauseType": "ExternalJoinSelectedValueList",
			"CountMode": "PivotDistinct",
			"MultiValued": true,
			"Declared": true,
			"Path": [ "<BookAuthorJoin.IDBook", ">BookAuthorJoin.IDAuthor" ],
			"Total": 1436,
			"SumOfCounts": 222,
			"MissingCount": 27,
			"OtherCount": null,
			"DistinctCount": 376,
			"Buckets":
			[
				{
					"Key": 1,
					"Label": "John Brown",
					"LabelResolved": true,
					"Count": 87,
					"Selected": false,
					"Clause":
					{
						"Type": "ExternalJoinSelectedValueList",
						"CoreConnectionColumn": "IDBook",
						"JoinTable": "BookAuthorJoin",
						"JoinTableCoreConnectionColumn": "IDBook",
						"JoinTableExternalConnectionColumn": "IDAuthor",
						"ExternalFilterByTable": "Author",
						"ExternalFilterByTableConnectionColumn": "IDAuthor",
						"ExternalFilterTableLookupColumn": "IDAuthor",
						"Values": [ 1 ],
						"FilterKey": "Book.ByAuthor",
						"ClauseKey": "ExternalJoinSelectedValueList"
					},
					"Selection": { "Facet": "Book.ByAuthor", "Key": 1 }
				},
				{ "Key": 2, "Label": "Richard Butler", "Count": 45, "Selected": false },
				{ "Key": 3, "Label": "Jessica Miller", "Count": 36, "Selected": false },
				{ "Key": 4, "Label": "Patricia Johnson", "Count": 28, "Selected": false },
				{ "Key": 10, "Label": "Patricia Moore", "Count": 26, "Selected": false }
			]
		}
	}
}
```

What changes for a multi-valued facet:

- **`MultiValued: true`** and **`CountMode: "PivotDistinct"`**: each bucket counts distinct books that have at least one visible link to that author.
- **`OtherCount` is `null`.** A book can be in several buckets, so `Total − SumOfCounts − MissingCount` means nothing; `SumOfCounts` may even exceed `Total`.
- **`MissingCount` (27)** is the books with no visible author at all.
- **`Total` (1436)** is still the number of books, computed on its own, never summed from buckets.
- **`DistinctCount` (376)** is the number of different authors over all books, before `Top`.

### Selecting a Bucket

When the path is exactly a bridge ending at the target's key (`<J.a >J.b` with `KeyField` the target's primary key), each bucket carries a standard `ExternalJoinSelectedValueList` clause. Selecting John Brown, with a Language facet beside the authors:

<!-- docs-check: request Fixture=Bookstore Entity=Book Definitions=k09-book-authors -->
```json
{
	"Clauses":
	[
		{
			"Type": "ExternalJoinSelectedValueList",
			"CoreConnectionColumn": "IDBook",
			"JoinTable": "BookAuthorJoin",
			"JoinTableCoreConnectionColumn": "IDBook",
			"JoinTableExternalConnectionColumn": "IDAuthor",
			"ExternalFilterByTable": "Author",
			"ExternalFilterByTableConnectionColumn": "IDAuthor",
			"ExternalFilterTableLookupColumn": "IDAuthor",
			"Values": [ 1 ],
			"FilterKey": "Book.ByAuthor",
			"Hash": "Author-1"
		}
	],
	"Facets":
	[
		{ "Key": "Authors", "Facet": "Book.ByAuthor", "Top": 3 },
		{ "Key": "Language", "Facet": "Book.Language", "Top": 3 }
	]
}
```

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Total": 87,
	"Facets":
	{
		"Authors":
		{
			"Key": "Authors",
			"Excluded": [ "Author-1" ],
			"Total": 1436,
			"Buckets":
			[
				{ "Key": 1, "Label": "John Brown", "Count": 87, "Selected": true },
				{ "Key": 2, "Label": "Richard Butler", "Count": 45, "Selected": false },
				{ "Key": 3, "Label": "Jessica Miller", "Count": 36, "Selected": false }
			]
		},
		"Language":
		{
			"Key": "Language",
			"Excluded": [],
			"Total": 87,
			"Buckets":
			[
				{ "Key": "eng", "Label": "eng", "Count": 44, "Selected": false },
				{ "Key": "en-US", "Label": "en-US", "Count": 19, "Selected": false },
				{ "Key": "", "Label": "", "Count": 7, "Selected": false }
			]
		}
	}
}
```

The 87 books by John Brown become the envelope `Total`. The Authors facet ignores its own clause and still shows every author; the Language facet counts John Brown's books.

## Buckets and Selection

- Buckets behave like [K1 Terms](#/page/fold_kinds/001-terms) buckets: `Top`, `Order`, labels, and selected keys that always come back.
- Only a path of exactly `<J.a >J.b` ending at the target's key gets a clause (`ExternalJoinSelectedValueList`). Any other to-many path, a path with step `Where`s, `TenantOnly` steps or `CheckParent`, and a dimension with a `Where` get `Clause: null` and keep their `Selection`: no standard clause can carry the restriction.

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes. A two-level distinct (`SELECT key, count(*) FROM (SELECT DISTINCT key, counted key …) GROUP BY key`), never `count(DISTINCT …)`, plus a count of the counted entity for `Total` and of the rows with no key for `MissingCount`. Every hop is a Scoped Relation. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when every entity and column on the path is mirrored (`uniqExact` of the counted entity's key per bucket). |

BridgeTerms keeps its own statements: multi-valued facets are not members of the conditional disjunctive scan.

## Notes and Limits

- A BridgeTerms dimension cannot be a pivot axis.
- Each hop of the path is gated: a principal who may not facet `BookAuthorJoin` or `Author` gets `403 FACET_FORBIDDEN` for this facet only.
- The demo's `Book.ReviewRating` facet is a BridgeTerms over a child table (`<Review.IDBook`, `KeyField: 'Rating'`): books by the ratings their reviews gave.

## Related

- [K8 PathTerms](#/page/fold_kinds/008-path-terms): single-valued paths.
- [K12 ChildRollup](#/page/fold_kinds/012-child-rollup): how many children, as bands.
- [Concepts](#/page/Concepts): count modes.
- [Definitions Files](#/page/Definitions): paths and aliases.
