# Definitions Files

A definitions file declares the facets, named scopes and path aliases that the model cannot derive on its own: "books by their reviews' ratings", "projects I belong to", "documents by their project's client". The faceting service loads the files at boot, checks every entry against the model, and serves the valid ones. An entry that fails a check is disabled as a whole, never half loaded, and so is everything that depends on it.

Auto facets need no file. Every facetable column of every entity already has one (`Book.Language`, `BookStoreSale.SaleDate`), derived from the Stricture model; see *Catalog* in [Configuration](#/page/Configuration). Write a definitions file when a facet crosses entities, needs a predicate of its own, or should be offered under a name.

## A First File

This file, for the Bookstore model, declares one alias, one named scope with a parameter, and five facets.

<!-- docs-check: definitions Id=definitions-bookstore-reviews Fixture=Bookstore -->
```json
{
	"FormatVersion": 1,
	"Description": "Bookstore reviews: a named scope and declared facets over Book and Review",
	"Aliases":
	{
		"Reviews": [ "<Review.IDBook" ]
	},
	"Scopes":
	{
		"Book.WellReviewed":
		{
			"Entity": "Book",
			"Description": "Books with at least one review rated MinRating or higher",
			"Params": { "MinRating": { "Type": "Integer", "Min": 1, "Max": 5, "Default": 4 } },
			"Where":
			[
				{ "Exists": { "Path": [ "@Reviews" ], "Where": [ { "Field": "Rating", "Op": "GE", "Value": "$Param.MinRating" } ] } }
			]
		}
	},
	"Facets":
	[
		{
			"Facet": "Book.ReviewRating",
			"Version": 1,
			"Title": "Review rating",
			"Dimensions": [ { "Kind": "Terms", "Path": [ "@Reviews" ], "KeyField": "Rating", "Top": 10 } ]
		},
		{
			"Facet": "Book.ReviewCount",
			"Version": 1,
			"Title": "Reviews per book",
			"Dimensions": [ { "Kind": "ChildRollup", "Child": { "Path": [ "@Reviews" ], "Agg": "count" }, "Edges": [ 1, 3, 10 ] } ]
		},
		{
			"Facet": "Book.RecentReviews",
			"Version": 1,
			"Title": "Reviewed since a date",
			"Params": { "Since": { "Type": "DateTime", "Default": "2024-01-01" } },
			"Dimensions":
			[
				{
					"Kind": "ExistsSplit",
					"Path": [ "@Reviews" ],
					"Where": [ { "Field": "CreateDate", "Op": "GE", "Value": "$Param.Since" } ],
					"Labels": { "true": "Reviewed since", "false": "Not reviewed since" }
				}
			]
		},
		{
			"Facet": "Book.ByAuthor",
			"Version": 1,
			"Title": "Author",
			"Dimensions": [ { "Kind": "Terms", "Path": [ "@Book~Author" ], "KeyField": "IDAuthor", "LabelField": "Name", "Top": 15 } ]
		},
		{
			"Facet": "Review.BookGenre",
			"Version": 1,
			"Title": "Genre of the reviewed book",
			"Dimensions": [ { "Kind": "Terms", "Path": [ ">Review.IDBook" ], "Field": "Genre" } ],
			"Siblings":
			{
				"ByBookType": { "Kind": "Terms", "Path": [ ">Review.IDBook" ], "Field": "Type" }
			}
		}
	]
}
```

A request names the scope in `Scopes` and the facets by their FacetIDs. Top-level `Params` feed the `$Param` tokens of the facets the request names; a scope reference carries its own `Params`.

<!-- docs-check: request Fixture=Bookstore Entity=Book Definitions=definitions-bookstore-reviews -->
```json
{
	"Scopes": [ { "Scope": "Book.WellReviewed", "Params": { "MinRating": 5 } } ],
	"Params": { "Since": "2024-06-01" },
	"Facets":
	[
		{ "Key": "Rating", "Facet": "Book.ReviewRating" },
		{ "Key": "Reviews", "Facet": "Book.ReviewCount" },
		{ "Key": "Recent", "Facet": "Book.RecentReviews" }
	]
}
```

The answer on the seeded Bookstore fixture, cut down to each bucket's `Key`, `Label` and `Count`:

```text
Total 931   Filter.Applied [ { "Scope": "Book.WellReviewed" } ]
Rating    Terms        PivotDistinct  5:931  4:669  3:496  2:290  1:168      (a book counts once per rating it received)
Reviews   ChildRollup  Rows           0 "None":0  1 "1–2":197  2 "3–9":675  3 "10+":59
Recent    ExistsSplit  Rows           1 "Reviewed since":285  0 "Not reviewed since":646
```

Every book in the scope has a 5-star review, so the `5` bucket holds all 931 of them. The `Rating` buckets add up to more than the total because the facet is multi-valued; [K9 BridgeTerms](#/page/fold_kinds/009-bridge-terms) explains why.

## Where Definitions Load From

The `Definitions` section of the `RetoldFaceting` options names the sources. They load in this order:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `Definitions.Path` | string or `false` | `'facets/'` | Every `*.json` file directly in this directory, sorted by name. Not recursive. Resolved against `process.cwd()`. `false` reads no directory. |
| `Definitions.Files` | array of strings | `[]` | More files, read after the directory. An absolute path, or a path relative to `Path` (relative to `process.cwd()` when `Path` is `false`). |
| `Definitions.Objects` | array of objects | `[]` | Parsed definitions objects, read last. Their source name in logs and in `disabled()` is `#object0`, `#object1`, … |
| `Definitions.AllowAdHoc` | boolean | `false` | **Reserved** (accepted, not read by this version). A request that carries an inline `Definition` is always refused with `403 FACET_ADHOC_FORBIDDEN`. |

```javascript
libRetoldFacetingService.installOnRetoldDataService(_Fable.RetoldDataService,
	{
		Definitions:
			{
				Path: `${__dirname}/facets/`,
				Files: [ `${__dirname}/shared/Review-Facets.json` ]
			}
	},
	(pError) =>
	{
		if (pError)
		{
			_Fable.log.error(`Faceting did not install: ${pError.message}`);
		}
	});
```

A missing default directory (`facets/`) is normal for an app that declares nothing: the service logs it at info level. Any other configured `Path` that is missing or not a directory logs a warning and adds the load warning `DEFINITIONS_PATH_MISSING`, so a typo does not boot silently with every declared facet unknown.

Each load logs one summary line. With a scope that failed and the facet that used it, the log reads:

```text
[error] RetoldFaceting definitions: Scope "Book.WellReviewed" disabled: FACET_DEFINITION_INVALID UnknownField at "#object0""/Scopes/Book.WellReviewed/Where/0/Exists/Where/0/Field"
[error] RetoldFaceting definitions: Facet "Book.ReviewedGenres" disabled: FACET_DEFINITION_INVALID DependsOnDisabled at "#object0""/Facets/0/Where/0" (depends on "Book.WellReviewed")
[warn] RetoldFaceting definitions: 1 warning(s): Ignored:Engines Book.ByLanguage
[info] RetoldFaceting definitions: 1 facet(s), 0 scope(s), 0 alias(es) loaded; 2 disabled (d:e9f53cc493af).
```

### Reloading

Definitions load when the service attaches, and again whenever the host reloads its model: the same sources are read again and checked against the new model. A load builds a complete new registry and swaps it in only when it finishes. If a reload throws, the previous registry stays in service and the failure is logged.

Names are global across every source. A facet, scope or alias defined in two files disables both definitions (`DuplicateName`).

## The File Format

A definitions file is one JSON object. Unknown top-level keys make the whole file invalid.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `FormatVersion` | number | Yes | Always `1`. |
| `Description` | string | No | Free text, up to 1024 characters. |
| `Aliases` | object | No | Alias name → path. See *Aliases* below. |
| `Scopes` | object | No | `'<Entity>.<Name>'` → scope definition. See *Named Scopes* below. |
| `Facets` | array | No | Facet definitions. See *Facet Definitions* below. |
| `Expressions` | object | No | Accepted. Every expression, and every facet or predicate that uses one, loads with `Supported: false`. |
| `Catalog` | object | No | Accepted and ignored, with the load warning `CatalogSectionIgnored`. Catalog overrides belong in the `RetoldFaceting.Catalog` options. |

> **Planned.** Computed dimensions and predicates (`Expressions`, `Expr`, fold kind K15) are not served by this version.

## Facet Definitions

Each entry of `Facets` declares one facet. Its FacetID is the `Facet` value, `'<Home>.<Name>'`; a request names it exactly that way.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `Facet` | string | Yes | `'<Home>.<Name>'`. `Home` is a facetable entity and the route entity of every request that uses the facet. `Name` may not be a column of `Home` (`NameShadowsColumn`), so a declared name never hides an auto facet. |
| `Version` | integer ≥ 1 | Yes | Your version of the definition. Echoed in each facet result's `Definition`. |
| `Dimensions` | array of 1 or 2 | Yes | What to bucket by. Two dimensions make a 2-D pivot ([K14 Pivot](#/page/fold_kinds/014-pivot)). See *Dimensions*. |
| `Title` | string | No | Shown by Describe. |
| `Description` | string | No | Shown by Describe. |
| `DisplayName` | string | No | The facet's display name. Default: `Title`, else the name with spaces between its words. |
| `Pivot` | string or object | No | The entity whose rows are counted. A string must equal `Home` (the default). `{ "Tuple": … }` counts tuples ([K18 TuplePivot](#/page/fold_kinds/018-tuple-pivot)). |
| `Home` | string | No | Only needed with a TuplePivot: the side the facet is homed on. Must equal the `Facet` prefix. |
| `Where` | array of predicates | No | Restricts the rows the facet counts. Disjunctive faceting never removes it. |
| `Siblings` | object | No | Name → dimension. Each sibling is its own facet, `'<Home>.<Name>/<Sibling>'`, sharing this facet's `Where`, `Pivot` and `Params`. |
| `Params` | object | No | Parameter schemas for `$Param` tokens in this facet. See *Parameters*. |
| `CountMode` | string | No | `Rows` or `PivotDistinct`. Usually left out: the service picks it (see below). |
| `Exclude` | `'Self'`, `'None'` or array | No | How the facet treats the request's own filter on it. See *Exclude and FilterKey*. |
| `FilterKey` | string | No | The clause `FilterKey` this facet owns (main facet only). |
| `Labels` | `false` or `{ Path, Field }` | No | The default label lookup of the facet's `Terms` dimensions. |
| `Measures` | array | No | Only `[ { "Op": "count" } ]` is served. |

### What the Service Decides for You

| Property | Rule |
|---|---|
| Fold | The dimension's `Kind`; `Pivot` for two dimensions. A K8 / K9 path facet reports the `Kind` it buckets by (`Terms`, …). |
| `CountMode` | A to-many path dimension (K9) is always `PivotDistinct`; declaring `Rows` for it is an error (`CountModeRows`). A TuplePivot always counts distinct key tuples (`KeyDistinct`); a declared `Rows` there is rewritten with the warning `CountModeCanonicalized`. Everything else is `Rows`. |
| `Exclude` default | `'Self'` for a one-dimension bucketing facet. `'None'` for ChildRollup, ExistsSplit, TuplePivot and 2-D pivot facets, which own no filter. Siblings inherit a declared `Exclude`, except ChildRollup, ExistsSplit and TuplePivot siblings (always `'None'`). |
| `FilterKey` default | A facet on a column of `Home` owns that column (`Genre`). Any other one-dimension facet owns its own FacetID. A 2-D pivot owns both of its axis columns; its default `Exclude` is `'None'`, so nothing is removed by default, but a request that sets `Exclude: 'Self'` removes clauses on either axis. The envelope reports the first axis column as the pivot's `FilterKey` (Describe shows `null`). |
| Display name of a sibling | The sibling name with spaces between its words (`ByBookType` → `By Book Type`). |

Facet keys that are accepted but ignored, each with a load warning `Ignored:<Key>`: `Engines`, `Freshness`, `Limits`, `Visibility`, `Records`, `Missing`, `ClauseType`, `Selectable`.

Facet features that load but are not served (`Supported: false`); a request that names the facet gets `422 FACET_FOLD_UNSUPPORTED` with the feature name in `Detail.Feature`:

| Feature | Trigger |
|---|---|
| `Measures` | `Measures` other than `[ { "Op": "count" } ]` |
| `CountMode` | `CountMode: 'Approx'`, `DistinctKey`, `KeyDistinct` outside a TuplePivot, or `PivotDistinct` on a TuplePivot |
| `ExcludeGroup` | `Exclude: 'Group:<name>'` or `ExcludeGroup` |
| `UnionOfSources` | `Pivot: { "Union": … }` (fold kind K16) |
| `TuplePivotPivot` | two `Dimensions` on a TuplePivot |
| `Computed` | an `Expr` in a dimension or predicate |
| `LogMode` | a dimension `Mode: 'Log'` |
| `TimeZone` | a dimension `TimeZone` other than `Time.StorageTimeZone` |
| `ChildRollupAgg`, `ChildRollupPath` | a ChildRollup `Agg` other than `'count'`, or a `Child.Path` that is not one `<` step |
| `HavingCountPath` | a `HavingCount` path that is not one `<` or `=` step |
| `Quantified` | an `All` or `AllNonEmpty` predicate (fold kind K13) |
| `LookupPathWhere` | an existence predicate inside the `Where` of a to-one (`>`) step |

> **Planned.** Quantified predicates (K13), computed dimensions (K15) and unions of sources (K16) are designed but not built; their definitions load so that files written for them are not lost.

## Dimensions

A dimension says what one facet buckets by. Its `Kind` and the fields beside it select the fold.

| Form | Fields | Fold kind |
|---|---|---|
| A column of `Home` | `Kind`, `Field` | [K1](#/page/fold_kinds/001-terms) to [K4](#/page/fold_kinds/004-ranges) |
| A column reached through a to-one path (only `>` steps) | `Kind`, `Path`, `Field` on the last entity; optional `LabelField` (Terms) | [K8 PathTerms](#/page/fold_kinds/008-path-terms) |
| A column reached through a to-many path (any `<` or `=` step) | `Kind: 'Terms'`, `Path`, `KeyField` on the last entity; optional `Where`, `LabelField` | [K9 BridgeTerms](#/page/fold_kinds/009-bridge-terms) |
| Count of visible children, in bands | `Kind: 'ChildRollup'`, `Child: { Path, Agg: 'count', Where? }`, `Edges` | [K12 ChildRollup](#/page/fold_kinds/012-child-rollup) |
| Whether a related row exists | `Kind: 'ExistsSplit'`, `Path`; optional `Where`, `Correlate`, `Labels` | [K20 ExistsSplit](#/page/fold_kinds/020-exists-split) |
| A side column of a TuplePivot | `Kind`, `Field: '<alias>.<Column>'` | [K18 TuplePivot](#/page/fold_kinds/018-tuple-pivot) |

`Kind` is one of `Terms`, `DateHistogram`, `NumericHistogram`, `Ranges`, `ChildRollup`, `ExistsSplit`. The column rules:

- `DateHistogram` needs a `DateTime` column. `NumericHistogram` and `Ranges` need a numeric column, never a `Boolean` (`FieldType`).
- A column of `Home` may not be its primary key, a GUID, a `Text` or `JSON` column, or a `String` longer than `Catalog.MaxTermsStringSize` (`FieldNotFoldable`).
- No dimension may name a Sensitive column, the delete column or a scope-policy column (`UnknownField`, `DeletedField`, `PolicyField`).
- `Edges` belongs only to `NumericHistogram`, `Ranges` only to `Ranges`, and `LabelField` / `Labels: { Path, Field }` only to `Terms` (`DimensionShape`).
- ChildRollup `Edges` are strictly ascending positive integers that start at `1`, because band 0 means exactly "no visible child" (`BandEdges`).

These dimension options are defaults that a request may override, with the same meaning they have on an auto facet: `Top`, `Order`, `Missing`, `Interval`, `EmptyBuckets`, `Mode` (`'Nice'` or `'Edges'`), `Buckets`, `Edges`, `OpenEnded`, `Ranges`. The request fields are described in [The Request Body](#/page/api/Request).

Labels for `Terms` keys come from, in order: `Labels: false` (no labels), `Labels: { "Path": [ … ], "Field": "<column>" }` (a to-one path from the dimension's entity to the entity holding the label), `LabelField` on a path dimension (a column of the last entity), or the auto facet's foreign-key label. A ChildRollup takes `Labels` as a map of band number to text (`{ "0": "None" }`); an ExistsSplit takes `{ "true": "…", "false": "…" }` (default `Yes` / `No`).

## Paths

A path walks the model's joins, one step per hop. Steps come from the `Join` declarations of the Stricture model; paths are resolved when definitions load, never at query time.

| Step | Read it as | Cardinality |
|---|---|---|
| `">E.c"` | Standing on `E`, follow its column `c` to the row it references. | to-one |
| `"<E.c"` | Standing on the entity that `E.c` references, go to the `E` rows that point here. | to-many |
| `"=E.c"` | Standing on `S`, go to the `E` rows whose `c` references the same parent as `S`'s own foreign key to that parent (a co-reference). | to-many |
| `"@Name"` | Splice in a declared alias or a bridge alias. | as spliced |
| `{ "Step": "<E.c", "Where": [ … ], "Scope": "TenantOnly", "ScopeReason": "…", "CheckParent": true }` | One step with options. | as the step |
| `{ "Via": "S.s", "To": "E.c", "Where": [ … ] }` | A co-reference that names the source foreign key, for when `S` has more than one key to the parent (`AmbiguousCoReference`). | to-many |

A path may also be written as one string with the steps separated by spaces (`">Document.IDProject >Project.IDClient"`). After aliases are spliced, a path may have at most `Limits.MaxHops` steps (default 4).

On the ProjectTrack fixture, a facet homed on `Task` that buckets tasks by their project's client walks two to-one steps:

```text
Task ──>Task.IDProject──▶ Project ──>Project.IDClient──▶ Client.IDClient (+ LabelField Name)
```

A named scope on `Project` that looks at memberships walks one to-many step, `<ProjectMembership.IDProject`, from a project to its membership rows. On LabTrack, the step `=LabForm.IDMaterialIntake` from a `MaterialIntakeRequirement` reaches the lab forms filed for the same material intake: both rows reference one `MaterialIntake`, and the path never visits it.

Each step's own `Where` filters the rows reached by that step. Step options:

- `Scope: 'TenantOnly'` relaxes the target entity's personal scope for that step only, keeping its tenant scope. It needs a `ScopeReason`, is allowed only on the paths of `Exists`, `NotExists`, `HavingCount` and `ExistsSplit`, only on an entity with a personal scope in the host's scope policy, and never with a `$Param` compared anywhere under the path. [Security and Tenancy](#/page/Security_And_Tenancy) explains when to use it.
- `CheckParent: true` adds a check that the shared parent of a co-reference is itself visible. The service turns it on by itself, with the warning `CheckParentForced`, whenever the parent could be hidden (it has a delete column or a scope-policy column) and nothing else in the same `Where` already proves the parent visible.
- `Elide: true` is accepted and ignored, with the warning `ElideIgnored`: no hop is ever skipped. `As` is accepted and has no effect in this version.

### Aliases

`Aliases` maps a name to a path. A name may contain `~`. Aliases may use other aliases; a cycle disables every alias in it (`AliasCycle`).

The graph also offers a **bridge alias** for every join table it detects: on the Bookstore model `@Book~Author` is `[ "<BookAuthorJoin.IDBook", ">BookAuthorJoin.IDAuthor" ]` and `@Book~BookStore` goes through `BookStoreCatalogJoin`. A declared alias may not reuse a bridge alias name (`AliasShadowsBridge`).

A bridge alias is named `<first target>~<second target>`: the targets of the join table's two foreign keys, in the order the columns appear in the model. It exists in that direction only, so it can start only at the first target (`@Author~Book` is disabled with `UnknownAlias`; write the steps out from the `Author` side instead). Two join tables between the same pair of entities get no bridge alias at all (the graph warning `BridgeAliasAmbiguous`). `fable.RetoldFacetingGraph.aliases()` lists the bridge aliases of the loaded model with their steps.

## Predicates

Predicates appear in a scope's `Where`, a facet's `Where`, a step's `Where`, and inside existence predicates. A `Where` array is an `And` of its items.

| Predicate | Shape | Meaning |
|---|---|---|
| Comparison | `{ "Field": "Rating", "Op": "GE", "Value": 4 }` | `Op` is `EQ`, `NE`, `GT`, `GE`, `LT`, `LE`, `LK`, `NLK`, `IN`, `NIN`, `NULL` or `NOTNULL`. `NULL` / `NOTNULL` take no `Value`; `IN` / `NIN` take a non-empty array or a list parameter; the rest take one value. |
| `And`, `Or` | `{ "Or": [ … ] }` | Boolean groups. |
| `Any` | `{ "Any": [ … ] }` | The same as `Or`; named for alternative paths ([K17 UnionOfPaths](#/page/fold_kinds/017-union-of-paths)). |
| `Not` | `{ "Not": { … } }` | Pushed down into the predicate it wraps (`EQ` becomes `NE`, `Exists` becomes `NotExists`, …). |
| `Exists` | `{ "Exists": { "Path": [ … ], "Where": [ … ], "Correlate": [ … ], "From": "<alias>" } }` | Some row along the path matches `Where` ([K10 PathSemiJoin](#/page/fold_kinds/010-path-semi-join)). |
| `NotExists` | same body | No visible row along the path matches ([K11 AntiPath](#/page/fold_kinds/011-anti-path)). |
| `HavingCount` | `{ "HavingCount": { "Path": [ … ], "Where": [ … ], "Op": "GE", "Value": 2 } }` | The number of matching rows compares to `Value` ([K19 HavingCount](#/page/fold_kinds/019-having-count)). `Op` is `EQ`, `NE`, `GT`, `GE`, `LT` or `LE`. |
| Scope reference | `{ "Scope": "MaterialIntake.InMyQueues", "Params": { … } }` | Inline a named scope of the entity the predicate is evaluated on. |

The rules every predicate follows:

- `Field` is a filterable column of the entity the predicate is evaluated on: the scope's entity, the facet's `Home`, a step's target, or the last entity of an existence path. It is never the delete column and never a scope-policy column; tenancy is the host policy's job.
- Literal values are coerced by the column's data type, exactly as clause values are. A value that cannot be coerced is `InvalidValue`.
- `Correlate` pairs `[ "<outer column>", "<inner column>" ]` tie the inner row to the outer one (both numeric or both not, `CorrelateType`). In a TuplePivot the outer side may be `'<alias>.<Column>'`.
- Existence predicates nest at most `Limits.MaxExistsDepth` deep (default 4, `ExistsTooDeep`), counting one level per path step and per forced parent check.

The ProjectTrack fixture's `Project.MyProjects` scope combines most of them:

```json
{
	"Entity": "Project",
	"Params": { "Roles": { "Type": "EnumList", "Values": [ "Owner", "Lead", "Member", "Reviewer" ], "Default": [ "Owner", "Lead", "Member" ] } },
	"Where":
	[
		{ "Any":
			[
				{ "Exists": { "Path": [ "@MemberOf" ], "Where": [ { "Field": "IDUser", "Op": "EQ", "Value": "$CurrentUser.IDUser" },
				                                                 { "Field": "Role", "Op": "IN", "Value": "$Param.Roles" },
				                                                 { "Field": "Active", "Op": "EQ", "Value": 1 } ] } },
				{ "Field": "OwnerIDUser", "Op": "EQ", "Value": "$CurrentUser.IDUser" }
			] }
	]
}
```

## Bound Values ($ Tokens)

A string `Value` that starts with `$` is a token. The service fills it in for each request, on the server; a client can never supply one, and client clause values are never read for `$`.

| Token | Value | When it cannot be bound |
|---|---|---|
| `$CurrentUser.IDUser`, `$CurrentUser.IDCustomer` | The principal's user and customer IDs. | An unset value (`Scope.UnsetValues`) answers `401 FACET_UNAUTHENTICATED`, never "matches nothing". |
| `$CurrentUser.<Field>` | Any field listed in `Scope.UserRecordFields` (from the session's user record). | As above. |
| `$Scope.<Column>` | The principal's value for a scope-policy column. | As above. |
| `$Now` | The request time, floored to `Cache.NowBucketMS` (default one minute), as the wall clock of `Time.StorageTimeZone`. | — |
| `$Today` | Midnight of `$Now`'s day. | — |
| `$StartOf.<day\|week\|month\|quarter\|year>` | The start of `$Now`'s day, week, month, quarter or year. | — |
| `$Param.<Name>` | A request parameter, checked against the declaring scope's or facet's `Params`. | `400 FACET_PARAM_INVALID` (see *Parameters*). |

Load-time checks catch the rest: a token outside this grammar is `UnknownToken`, a `$Param` the enclosing scope or facet does not declare is `UndeclaredParam`, a token whose type cannot reach the column (a date token on a number) is `TokenType`, and a list parameter under a single-value operator is `ParamShape`. A token is always a whole `Value`, never an array member.

## Named Scopes

A named scope is a reusable, server-authored filter on one entity. Requests apply it by name; disjunctive faceting never removes it, so every facet in the request is counted inside it.

| Field | Type | Required | Meaning |
|---|---|---|---|
| (key) | string | Yes | `'<Entity>.<Name>'`; `<Entity>` must equal `Entity` (`ScopeEntityMismatch`). |
| `Entity` | string | Yes | The entity the scope filters. |
| `Where` | array of 1 to 64 predicates | Yes | The filter. |
| `Description` | string | No | Shown by Describe. |
| `Params` | object | No | Parameter schemas for the scope's `$Param` tokens. |

A request uses a scope in any of these ways; all of them check the scope's parameters the same way:

- the `Scopes` array of the body: `[ { "Scope": "Book.WellReviewed", "Params": { "MinRating": 5 } } ]`;
- a `NamedScope` clause: `{ "Type": "NamedScope", "Scope": "Book.WellReviewed", "Params": { … } }`;
- the route form `/1.0/Facet/<Entity>/Scope/<Scope>/Query` (and the `Records` forms), which takes the scope's parameters from the top-level `Params`.

A definition can reference a scope too, as a predicate `{ "Scope": "…", "Params": { … } }`. A reference's `Params` may hold literals or tokens of the enclosing definition; a parameter missing without a `Default` is `ScopeParamMissing`. Scope references expand at most `Limits.MaxScopeDepth` deep (default 3, `ScopeTooDeep`), and a cycle disables every scope in it (`ScopeCycle`).

An unknown or disabled scope, or a scope of another entity, answers `400 FACET_UNKNOWN_SCOPE`. A request may name at most `Limits.MaxScopesPerRequest` scopes in all (default 16).

## Parameters

`Params` declares the parameters a scope or facet accepts, by name:

| Field | Applies to | Meaning |
|---|---|---|
| `Type` | all | `Enum`, `EnumList`, `Integer`, `IntegerList`, `String`, `Boolean` or `DateTime`. |
| `Values` | `Enum`, `EnumList` (required there, not allowed elsewhere) | The allowed values. |
| `Default` | all | Used when the request omits the parameter; must itself be valid. Without one, the parameter is required. |
| `Min`, `Max` | `Integer`, `IntegerList` | Inclusive bounds. |
| `MaxLength` | `String` | Longest accepted value, 1 to 1024 (default 256). |
| `Description` | all | Shown by Describe. |

What each type accepts from a request:

| Type | Accepts | Bound as |
|---|---|---|
| `Enum` | One member of `Values`. | the value |
| `EnumList` | A non-empty array of distinct members of `Values`, at most `Limits.MaxInList`. | an array |
| `Integer`, `IntegerList` | Safe integers, or numeric strings, within `Min` / `Max`. | a number, an array |
| `String` | A string up to `MaxLength`, without `~`. | the string |
| `Boolean` | `true`, `false`, `1`, `0`, `'true'`, `'false'`, `'1'`, `'0'`. | `1` or `0` |
| `DateTime` | `YYYY-MM-DD`, `YYYY-MM-DD HH:mm[:ss]` or an ISO timestamp. | `'YYYY-MM-DD HH:mm:ss'` |

A bad value answers `400 FACET_PARAM_INVALID`. Its `Detail` names the `Scope` or `Facet`, the `Param`, and a `Reason`: `Unknown` (no scope or facet in the request declares that name), `Required`, `Type`, `NotAllowed` (not in `Values`, or a `String` with `~`) or `Range`. The value itself is never echoed.

Top-level request `Params` feed the `$Param` tokens of the declared facets the request names; on the `/Scope/<Scope>/` route form they also feed the route scope. Each top-level name must be declared by one of those facets or by a scope the request names, else it is `Unknown`. A scope named in `Scopes` or in a `NamedScope` clause takes its parameters from that reference's own `Params`.

## Exclude and FilterKey

Disjunctive faceting counts each facet with every filter of the request except the ones the facet owns, so a selected value never drives its siblings to zero ([Concepts](#/page/Concepts) shows the idea). A declared facet owns:

- a clause whose `FilterKey` equals the facet's `FilterKey`;
- a clause whose columns are all columns the facet reads (for a path facet, the same path and column);
- any clause or conjunct listed in an explicit `Exclude` array (clause `Hash` values, or conjunct Ids `c1`, `c2`, …).

`Exclude: 'Self'` removes owned clauses; `'None'` keeps every filter. A facet's own `Where` and every named scope are never removed.

## TuplePivots

A TuplePivot counts combinations of rows from two to four entities instead of rows of one ([K18 TuplePivot](#/page/fold_kinds/018-tuple-pivot)). Its `Pivot.Tuple` follows these rules:

- Each side of `Pivot.Tuple.From` has a short lowercase alias (`i`, `r`), an `Entity` and an optional `Where`.
- Every side must join to the home side through the `On` pairs, which must follow model joins (`TupleOnNotJoined`).
- `Key` lists the columns that identify one tuple, and each dimension's `'<alias>.<Column>'` must be one of them or its side's primary key (`TupleDimensionNotKeyed`).
- Facet-level predicates start a path at a side with `"From": "<alias>"`.

The LabTrack fixture's `MaterialIntake.FormsToDo` is a complete TuplePivot; [E3: Lab Forms I Still Have to Fill Out](#/page/examples/E3_Lab_Forms_To_Fill_Out) walks through it.

## Validation and Disabling

<!-- bespoke diagram: edit diagrams/definitions-load.mmd or .hints.json, then: npx pict-renderer-graph build modules/meadow/retold-faceting-service/docs -->
![How a definitions file loads](diagrams/definitions-load.svg)

Every entry goes through the same stages; the first failure disables it:

1. **Schema.** The file envelope first (a bad envelope disables every entry of that file, `Kind: 'File'`), then each alias, scope and facet against `source/catalog/Facet-Definition-Schema.json`.
2. **Names.** Duplicates, the facet's `Home`, name clashes with columns, scope names that do not match their `Entity`.
3. **Aliases** spliced, cycles found.
4. **Paths** resolved against the model graph.
5. **Predicates:** fields, operators, values, tokens, parameters, correlations.
6. **Scope references:** existence, entity, parameters, depth, cycles.
7. **Existence depth** against `Limits.MaxExistsDepth`.
8. **`TenantOnly`** rules.
9. **Parent checks** forced where needed (a warning, not an error).
10. **Dimensions** and 11. **TuplePivots.**
12. **Unsupported features** marked `Supported: false`.
13. **Ignored keys** warned about.

A disabled entry is logged once, at error level, with its source and a JSON pointer to the failing part, never a value. Everything that references it is disabled too, with `Reason: 'DependsOnDisabled'`. A request that names a disabled facet or scope gets the same answer as one that names a nonexistent one: the facet's entry in `Errors` is `FACET_UNKNOWN_FACET`, and a disabled scope is `400 FACET_UNKNOWN_SCOPE`.

`RetoldFacetingDefinitionRegistry.disabled()` returns the disabled entries. For the failing file of the log above:

```json
[
	{
		"Kind": "Scope",
		"Name": "Book.WellReviewed",
		"Source": "#object0",
		"Errors":
		[
			{
				"Code": "FACET_DEFINITION_INVALID",
				"Reason": "UnknownField",
				"Pointer": "/Scopes/Book.WellReviewed/Where/0/Exists/Where/0/Field",
				"Step": null,
				"Entity": "Review",
				"Field": "Stars",
				"DependsOn": null
			}
		]
	},
	{
		"Kind": "Facet",
		"Name": "Book.ReviewedGenres",
		"Source": "#object0",
		"Errors":
		[
			{
				"Code": "FACET_DEFINITION_INVALID",
				"Reason": "DependsOnDisabled",
				"Pointer": "/Facets/0/Where/0",
				"Step": null,
				"Entity": null,
				"Field": null,
				"DependsOn": "Book.WellReviewed"
			}
		]
	}
]
```

`warnings()` returns the load warnings (`DEFINITIONS_PATH_MISSING`, `CatalogSectionIgnored`, `CheckParentForced`, `ElideIgnored`, `CountModeCanonicalized`, `Ignored:<Key>`), each with `Code`, `Kind`, `Name`, `Source` and `Pointer`. `status()` returns `{ Files, Facets, Scopes, Aliases, Disabled, Warnings }` counts.

### Checking a File in a Test

`validate(pDefinitions)` checks one parsed definitions object on its own, without changing what the service serves. It returns `{ Valid, Errors, Warnings, Canonical }`:

```javascript
let tmpRegistry = _Fable.RetoldFacetingDefinitionRegistry;
let tmpCheck = tmpRegistry.validate(JSON.parse(libFS.readFileSync(`${__dirname}/facets/Book.json`, 'utf8')));
if (!tmpCheck.Valid)
{
	tmpCheck.Errors.forEach((pError) => { console.log(`${pError.Kind} ${pError.Name}: ${pError.Reason} at ${pError.Pointer}`); });
}
```

`validate()` cannot see entries already loaded, so a file that references another file's scope or alias reports `UnknownScope` or `UnknownAlias` there. Load the files together, as the service does, to check cross-file references.

### Reasons

| Group | Reasons |
|---|---|
| Files | `Schema`, `Unreadable`, `InvalidJSON` |
| Names | `DuplicateName`, `AliasShadowsBridge`, `NameShadowsColumn`, `ScopeEntityMismatch`, `UnknownEntity`, `HomeMismatch`, `PivotMismatch` |
| Aliases and paths | `UnknownAlias`, `AliasCycle`, `InvalidPath`, `InvalidStep`, `WrongStart`, `UnknownEdge`, `NotAJoin`, `NotCoReferent`, `AmbiguousCoReference`, `TooManyHops` |
| Predicates | `UnknownField`, `DeletedField`, `PolicyField`, `InvalidValue`, `UnknownToken`, `UndeclaredParam`, `ParamShape`, `TokenType`, `CorrelateType`, `ParamSchema` |
| Scope references | `UnknownScope`, `DependsOnDisabled`, `ScopeParamMissing`, `ScopeParamInvalid`, `ScopeTooDeep`, `ScopeCycle` |
| Depth and tenancy | `ExistsTooDeep`, `TenantOnlyNotAllowed`, `TenantOnlyNeedsReason`, `TenantOnlyNeedsPolicy`, `TenantOnlyNeedsTenant`, `TenantOnlyParam` |
| Dimensions and tuples | `DimensionShape`, `FieldType`, `FieldNotFoldable`, `LabelsPath`, `CountModeRows`, `PivotAxis`, `BandEdges`, `TupleAlias`, `TupleHome`, `TupleOnNotJoined`, `TupleDimensionNotKeyed`, `TuplePath` |
| Other | `Internal` (an unexpected exception while compiling; logged) |

## Describe

`GET /1.0/Facet/Describe/<Entity>` lists, after the auto facets, every enabled declared facet and sibling homed on the entity, and every enabled named scope with its `Params`, as far as the principal may facet every entity they read. Disabled definitions never appear. See [Describe](#/page/api/Describe).

## Related

- [Fold Kinds](#/page/Fold_Kinds): what each dimension kind and predicate computes.
- [The Request Body](#/page/api/Request): naming declared facets, scopes and parameters in a request.
- [Configuration](#/page/Configuration): the `Definitions`, `Catalog`, `Scope` and `Limits` options.
- [Concepts](#/page/Concepts): facets, folds, scopes and disjunctive faceting in plain terms.
