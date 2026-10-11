# K10 PathSemiJoin

> A filter: keep the rows that have at least one **visible** related row, along a path, matching a condition. Written as an `Exists` predicate.

## When to Use It

Use `Exists` for "has a related…" filters: projects where I am an active member, books with a review rated 4 or more, documents of projects in my team. The filter can follow several hops, and every hop is read as the requesting principal would see it.

PathSemiJoin is not a facet on its own. It narrows the rows that every facet, the Total and the list count. To show "has / has not" as two buckets, use [K20 ExistsSplit](#/page/fold_kinds/020-exists-split).

## How to Ask for It

`Exists` is a predicate in a definitions file:

```text
{ "Exists": { "Path": [ <steps> ], "Where": [ <predicates on the last entity> ], "Correlate": [ [ outer, inner ] … ] } }
```

It can sit in two places:

- **A named scope's `Where`.** Clients apply the scope by name, in `Scopes` or as a `NamedScope` clause.
- **A declared facet's `Where`.** That facet, and only that facet, counts within the condition.

This file declares both, on the same condition:

<!-- docs-check: definitions Id=k10-well-reviewed Fixture=Bookstore -->
```json
{
	"FormatVersion": 1,
	"Scopes":
	{
		"Book.WellReviewed":
		{
			"Entity": "Book",
			"Description": "Books with at least one review rated 4 or 5",
			"Where":
			[
				{
					"Exists":
					{
						"Path": [ "<Review.IDBook" ],
						"Where": [ { "Field": "Rating", "Op": "GE", "Value": 4 } ]
					}
				}
			]
		}
	},
	"Facets":
	[
		{
			"Facet": "Book.WellReviewedLanguage",
			"Version": 1,
			"Title": "Language of well-reviewed books",
			"Where": [ { "Scope": "Book.WellReviewed" } ],
			"Dimensions": [ { "Kind": "Terms", "Field": "Language", "Top": 3 } ]
		}
	]
}
```

Clients can also send `Exists` filters without a definitions file: pict's `InternalJoin*` and `ExternalJoin*` clauses compile to `Exists` over a declared graph edge. The [K8 PathTerms](#/page/fold_kinds/008-path-terms) bucket clause `InternalJoinMatch` is one. A join clause that names an edge the model does not declare is `400 FACET_FILTER_INVALID` (`Reason: 'UndeclaredJoin'`).

## Using It in a Scope

Apply the scope to a request:

<!-- docs-check: request Fixture=Bookstore Entity=Book Definitions=k10-well-reviewed -->
```json
{
	"Scopes": [ { "Scope": "Book.WellReviewed" } ],
	"Facets": [ { "Key": "Language", "Facet": "Book.Language", "Top": 3 } ]
}
```

<!-- docs-check: skip captured envelope, abridged -->
```json
{
	"Total": 1250,
	"Filter": { "Applied": [ { "Scope": "Book.WellReviewed" } ], "Warnings": [] },
	"DependsOn": [ "Book", "Review" ],
	"Facets":
	{
		"Language":
		{
			"Key": "Language",
			"Disjunctive": "Exact",
			"Excluded": [],
			"Total": 1250,
			"SumOfCounts": 1085,
			"MissingCount": 23,
			"OtherCount": 142,
			"Buckets":
			[
				{ "Key": "eng", "Label": "eng", "Count": 760, "Selected": false },
				{ "Key": "en-US", "Label": "en-US", "Count": 231, "Selected": false },
				{ "Key": "", "Label": "", "Count": 94, "Selected": false }
			]
		}
	}
}
```

Without the scope the fixture has 1436 live books; 1250 of them have a review rated 4 or 5. The scope is listed in `Filter.Applied`, it narrows the Total and every facet, and no facet ever excludes it: a scope is a fixed part of the question, not a user's checkbox. `DependsOn` now includes `Review`, the entity the scope reads.

## Using It in a Definition `Where`

A declared facet with a `Where` counts within it, while the request and its other facets do not change:

<!-- docs-check: request Fixture=Bookstore Entity=Book Definitions=k10-well-reviewed -->
```json
{
	"Facets":
	[
		{ "Key": "Language", "Facet": "Book.Language", "Top": 3 },
		{ "Key": "WellReviewed", "Facet": "Book.WellReviewedLanguage" }
	]
}
```

<!-- docs-check: skip captured envelope, abridged to the totals and bucket counts -->
```json
{
	"Total": 1436,
	"Filter": { "Applied": [], "Warnings": [] },
	"Facets":
	{
		"Language":
		{
			"Key": "Language",
			"Total": 1436,
			"Buckets": [ { "Key": "eng", "Count": 862 }, { "Key": "en-US", "Count": 271 }, { "Key": "", "Count": 108 } ]
		},
		"WellReviewed":
		{
			"Key": "WellReviewed",
			"Facet": "Book.WellReviewedLanguage",
			"Fold": "Terms",
			"Disjunctive": "Exact",
			"Declared": true,
			"Total": 1250,
			"SumOfCounts": 1085,
			"MissingCount": 23,
			"OtherCount": 142,
			"Buckets": [ { "Key": "eng", "Count": 760 }, { "Key": "en-US", "Count": 231 }, { "Key": "", "Count": 94 } ]
		}
	}
}
```

The definition's `Where` belongs to the facet, so disjunctive exclusion never removes it, and two facets with different `Where`s are planned separately.

## How the Path Is Evaluated

- **One witness per `Exists`.** `Exists(P, a and b)` asks for one related row that satisfies both; two `Exists` nodes, one with `a` and one with `b`, may be satisfied by two different rows. "A member who is an owner and active" is one node with both conditions.
- **Every hop is visible-only.** Each step is a Scoped Relation of its entity: its soft-deleted rows, other tenants' rows and rows its own list behaviors hide never satisfy the condition. "Has a review" means "has a review this principal can see".
- **`Correlate`** adds equality pairs between the starting row and the last row of the path, for composite keys. See [K11 AntiPath](#/page/fold_kinds/011-anti-path) for an example.
- **`TenantOnly` steps** relax an entity's personal scope (an owner column) on that one hop, never its tenant scope, so "completed by anyone in my lab" can be expressed. They need a `ScopeReason` and a policy with a `PersonalScopes` entry; see [Security and Tenancy](#/page/Security_And_Tenancy).
- `$`-values (`$CurrentUser.IDUser`, `$Now`, `$Param.<Name>`) are bound on the server from the principal and the scope's declared `Params`; see [Definitions Files](#/page/Definitions).

## Engine Support

| Engine | Support |
|---|---|
| Live, SQLite | Yes. Nested `EXISTS (SELECT 1 FROM (<scoped relation>) …)` per hop, each relation fenced, soft-deleted and scoped through its entity's behaviors. A hop whose entity's behavior replaces the query (an Opaque capture) runs Staged when the entity is in `Scope.TrustedOpaque`, else the request is refused (`500 FACET_SCOPE_POLICY_VIOLATION`). |
| Live, PostgreSQL | Yes. |
| ClickHouse store | Yes, when every entity and column on the path is mirrored (`IN (SELECT …)` subqueries). A Staged hop is never answered by the store (`OpaqueScope`). |

## Notes and Limits

- `Limits.MaxHops` (4) steps per path, and `Limits.MaxExistsDepth` (4) nested existence subqueries per predicate, are checked when the file loads.
- `Limits.MaxScopesPerRequest` (16) scopes per request; scope references nest at most `Limits.MaxScopeDepth` (3) deep.
- An unknown, disabled or wrong-entity scope is `400 FACET_UNKNOWN_SCOPE`. A scope over an entity the principal may not facet is `403 FACET_FORBIDDEN` for the whole request.

## Related

- [K11 AntiPath](#/page/fold_kinds/011-anti-path): "has no visible…".
- [K17 UnionOfPaths](#/page/fold_kinds/017-union-of-paths): "has this or that".
- [K19 HavingCount](#/page/fold_kinds/019-having-count): "has at least N…".
- [K20 ExistsSplit](#/page/fold_kinds/020-exists-split): the same condition as two buckets.
- [Concepts](#/page/Concepts): named scopes and Scoped Relations.
- [Definitions Files](#/page/Definitions): predicate syntax, scopes and `Params`.
