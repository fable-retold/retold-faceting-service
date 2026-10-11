# K17 UnionOfPaths

> A filter: keep the rows that satisfy **any** of several predicates, where some of them follow paths. Written as an `Any` predicate.

## When to Use It

Use `Any` when a row qualifies in more than one way: projects I am a member of **or** own, documents I wrote **or** that are shared with my team, books with a 5-star review **or** published before 1950. Each branch can be an `Exists`, a `NotExists`, a `HavingCount`, a scope reference or a plain column comparison.

Like the other predicate kinds, `Any` narrows every facet and the Total. It is not a facet on its own.

## How to Ask for It

Write an `Any` array in a named scope or a declared facet's `Where`:

<!-- docs-check: definitions Id=k17-loved-or-classic Fixture=Bookstore -->
```json
{
	"FormatVersion": 1,
	"Scopes":
	{
		"Book.LovedOrClassic":
		{
			"Entity": "Book",
			"Description": "Books with a 5-star review, or published before 1950",
			"Where":
			[
				{
					"Any":
					[
						{
							"Exists":
							{
								"Path": [ "<Review.IDBook" ],
								"Where": [ { "Field": "Rating", "Op": "EQ", "Value": 5 } ]
							}
						},
						{ "Field": "PublicationYear", "Op": "LT", "Value": 1950 }
					]
				}
			]
		}
	}
}
```

Items of a `Where` array are combined with AND; the items of an `Any` with OR. Nest them as deep as you need (within `Limits.MaxExistsDepth`). `Any` is the definitions spelling of OR, and the registry stores it as an `Or` node.

The ProjectTrack fixture's `Project.MyProjects` scope, used by the [E1 example](#/page/examples/E1_Projects_For_Me), is the classic case: an `Any` of "an active membership of mine with one of the given roles" and "I am the owner".

## Using It in a Scope

<!-- docs-check: request Fixture=Bookstore Entity=Book Definitions=k17-loved-or-classic -->
```json
{
	"Scopes": [ { "Scope": "Book.LovedOrClassic" } ],
	"Facets": [ { "Key": "Language", "Facet": "Book.Language", "Top": 3 } ]
}
```

<!-- docs-check: skip captured envelope, abridged to the totals and bucket counts -->
```json
{
	"Total": 953,
	"Filter": { "Applied": [ { "Scope": "Book.LovedOrClassic" } ], "Warnings": [] },
	"DependsOn": [ "Book", "Review" ],
	"Facets":
	{
		"Language":
		{
			"Key": "Language",
			"Total": 953,
			"Buckets": [ { "Key": "eng", "Count": 575 }, { "Key": "en-US", "Count": 176 }, { "Key": "", "Count": 76 } ]
		}
	}
}
```

931 books have a visible 5-star review (the [K20 ExistsSplit](#/page/fold_kinds/020-exists-split) example counts them); 22 more were published before 1950 without one. The union holds 953.

## How It Is Evaluated

- **An `Or` that holds an existence node stays whole.** The Live engine renders it as `( EXISTS (…) OR <column comparison> )` at the level of the row it starts from; it is never split into separate filters.
- **Column comparisons inside an `Any` honor the entity's behaviors.** Such a leaf is rendered outside the entity's own Scoped Relation, so the engine first runs the entity's `Reads-QueryConfiguration` on a probe query holding exactly those leaves. If a host behavior rewrites an operator (for example `LIKE` to `ILIKE`), the rendered leaf uses the rewritten operator, as the list would.
- **Every path branch is visible-only,** like [K10 PathSemiJoin](#/page/fold_kinds/010-path-semi-join): soft-deleted, other tenants' and hidden related rows never satisfy a branch.

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes. `OR` of `EXISTS` subqueries and column fragments, each subquery over Scoped Relations. |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when every entity and column is mirrored. A leaf whose operator a behavior rewrites in a way the store cannot reproduce is answered Live (`Transformed`). |

## Notes and Limits

- A scope's `Where` is a fixed part of the question: no facet excludes it.
- A `NamedScope` clause cannot be OR-combined with client clauses (`Junction: 'OR'` on it is `400 FACET_FILTER_INVALID`, `Reason: 'NamedScopeJunction'`); put the alternatives inside the scope's `Any` instead.

## Related

- [K10 PathSemiJoin](#/page/fold_kinds/010-path-semi-join), [K11 AntiPath](#/page/fold_kinds/011-anti-path) and [K19 HavingCount](#/page/fold_kinds/019-having-count): the branches.
- [Definitions Files](#/page/Definitions): predicate syntax.
- [Concepts](#/page/Concepts): named scopes.
