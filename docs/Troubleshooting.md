# Troubleshooting

This page starts from what you see: a count you do not trust, a request that answers `401` or `404`, a column that is missing. Each section names the likely cause and the check that settles it. The numbers quoted come from the Bookstore fixture that [Getting Started](#/page/Getting_Started) uses.

## The Tools

Most questions are answered by fields the service already returns, or by a second request:

| Tool | Where | What it tells you |
|---|---|---|
| `Excluded`, `Disjunctive`, `KeptMixed` | each facet result | which list clauses the facet left out, and which mixed clause it had to keep |
| `SumOfCounts`, `MissingCount`, `OtherCount`, `MultiValued` | each facet result | where every counted row went |
| `POST <RoutePrefix>/<Entity>/Records/Count` | facet routes | the list side of the same compiler, for the same body |
| `GET /1.0/<Entity>s/Count/FilteredTo/<filter>` | the stock meadow-endpoints route | what the list route itself counts |
| `Engine`, `Exact`, `Cached`, `Stale`, `LagMS`, `Store` | the envelope and each facet result | which engine answered, and how fresh the answer is |
| `pMeta` | in-process `query` callback | statements run, Variants, cubes and cube fallbacks, the cache decision, store routing |
| `queryInternal(…, { ForceEngine: 'Reference' })` | in process | the test oracle's answer on your own data (see the last section) |
| `fable.RetoldFacetingDefinitionRegistry.disabled()` and `warnings()` | in process | definitions that did not load, and why |
| the server log | your host's log | the reasons behind a `401` or a `500`, which clients never see |

## A Bucket Count Is Larger Than the Total

**Cause: disjunctive faceting.** A facet ignores its own clause, so it counts rows the envelope `Total` does not. In Getting Started, with "paid by credit card" selected, the envelope `Total` is 1,288 while the `ByMethod` facet counts all 2,918 sales.

**Check:** the facet's `Excluded` lists the clause it left out (`[ "Method" ]`), and the facet's own `Total` is larger than the envelope's. This is intended: it lets a user tick a second box. A facet that should count only inside the filter takes `"Exclude": "None"`. See [Concepts](#/page/Concepts).

## The Buckets Add Up to More Than the Total

**Cause: a multi-valued facet.** A row can sit in several buckets: a book with three authors is counted in three author buckets ([K9 BridgeTerms](#/page/fold_kinds/009-bridge-terms)).

**Check:** the facet result says `MultiValued: true`, `CountMode: "PivotDistinct"` and `OtherCount: null`. Each bucket still counts distinct rows; only the sum exceeds the `Total`.

## The Buckets Add Up to Less Than the Total

**Cause: rows outside the displayed buckets.** For a single-valued facet `SumOfCounts + MissingCount + OtherCount = Total` always holds:

- `MissingCount`: rows with no value. NULL, non-numeric text in a number column, an unparseable date, or a path whose related row is missing or not visible to this user.
- `OtherCount`: rows with a value that is not shown. Values cut by `Top` (the result says `Truncated: true`, `TruncatedReason: "Top"`), numbers outside declared `Edges` or `Ranges`, and missing rows when the request says `Missing: false`.

**Check:** add the three numbers. The Getting Started genre facet shows 708 + 9 + 214 = 931, its `Total`.

## A Facet Disagrees With the List

Work through these in order; each one rules out a layer.

1. **Same principal.** The facet request and the list request must carry the same session. Two different users (or a signed-in page and an anonymous `curl`) see different rows.
2. **The service's own list side.** Post the same body to `<RoutePrefix>/<Entity>/Records/Count`. It shares the compiler with the Query, so its `Count` equals the envelope `Total`. For one bucket, add that bucket's `Clause` to the clauses: the count equals the bucket's `Count`.
3. **The stock list route.** Ask `GET /1.0/<Entity>s/Count/FilteredTo/<filter>` with the same filter as a meadow-filter string, URL-encoded (`2023-01-01%2000:00:00`). If it differs from step 2, the list page and the facet request are not sending the same filter.
4. **A mixed clause.** A facet result with `Disjunctive: "Partial"` had to keep a clause that filters its own column and another one (`KeptMixed` names it), so its buckets are counted under that clause.
5. **Behaviors the two routes do not share.** The stock count route runs `Count-QueryConfiguration`; the facet routes run `Reads-QueryConfiguration` (`Scope.Behavior`). If an application scopes one and not the other, the counts differ. A read-side post-operation behavior that drops rows is invisible to SQL: Describe reports the entity `Opaque` until you vouch for it ([Security and Tenancy](#/page/Security_And_Tenancy)).

## Every Request Answers 401

**Cause: the principal has no value for a policy column**, or it is not signed in. Facets read the policy value from `SessionData[Policy.SessionField]`, and `SessionField` defaults to the column name. meadow-endpoints sessions carry `CustomerID` and `UserID`, so `Policy: { Column: 'IDCustomer' }` without `SessionField: 'CustomerID'` makes every request `401`.

**Check:** the server log names the unset column at `info` level:

```text
RetoldFaceting request rfq-000001 unauthenticated: unset scope value(s) [IDCustomer]
```

Set `SessionField`. A session must also have `LoggedIn: true`; anonymous requests on a policy host pass only for entities in `Catalog.AllowAnonymous`. *Who Is Asking* in [Security and Tenancy](#/page/Security_And_Tenancy) has the full mapping.

## An Entity Answers 404

`404 FACET_UNKNOWN_ENTITY` means the entity does not exist, is not facetable, or may not be read by this principal; the three look the same on purpose. `GET /1.0/Facet/Describe` lists every entity this principal may facet. If yours is missing, check:

- the entity has a DAL on a supported dialect, a model table, and a route-bound meadow-endpoints controller whose read routes are connected;
- on a host with a scope policy, the entity carries the policy column and a behavior that filters on it, or it is listed in `Catalog.GlobalEntities`;
- it is not `Account`, `ApiKey`, `LoginChallenge` or `RetoldFacetChangeLog`, and not in `Catalog.NeverFacet`;
- a model has been loaded: a request before the first `loadModel` answers `404` for every entity.

## A Column Is Missing, or a Filter Answers 400 FACET_UNKNOWN_FIELD

**A Sensitive name.** A column whose name contains `Password`, `Hash`, `Secret`, `Token`, `Salt`, `ApiKey`, `Email` or `Phone`, or ends in `Key` or `Code`, is neither facetable nor filterable. A clause on `BookPrice.CouponCode` answers:

```text
400 {"Error":{"Code":"FACET_UNKNOWN_FIELD","Status":400,"Message":"A filter clause names an unknown field.","Detail":{"Field":"CouponCode","ClauseType":"DistinctSelectedValueList","Index":0}}}
```

while the stock `GET /1.0/BookPrices/Count/FilteredTo/FBV~CouponCode~EQ~SAVE10` answers `{ "Count": 14 }`. Opt the column in with `Catalog: { BookPrice: { IncludeSensitive: [ 'CouponCode' ] } }`; the facet route then counts 14 as well.

**No auto facet, but still filterable.** A String longer than `Catalog.MaxTermsStringSize` (128), a uniquely indexed String, `Text` and `JSON` columns, the primary key, GUIDs, and the delete, audit and policy columns get no auto facet. Filters on them still work. Opt a column in with `Catalog.<Entity>.Include`. The full table is *Which Columns Get Auto Facets* in [Configuration](#/page/Configuration).

## A Request Answers 500 FACET_SCOPE_POLICY_VIOLATION

**Cause: the ScopeGuard could not prove the answer is scoped.** The response never says why; the server log does:

```text
RetoldFaceting ScopeGuard (Strict) refused BookStoreSale: MissingPredicate(IDCustomer)
```

| Log reason | Meaning | Fix |
|---|---|---|
| `MissingPredicate(<Column>)` | the entity's read behavior added no top-level `<Column> = <value>` | add the filter to `Reads-QueryConfiguration` (*Turning On Tenancy* in [Security and Tenancy](#/page/Security_And_Tenancy)) |
| `WrongValue(<Column>)` | the behavior filtered on a value other than the principal's | read the value from the same session field as `SessionField` |
| `refused an opaque scope capture for <Entity>: <reasons>` | the behavior added a join, replaced the query, or a post-operation behavior is not vouched for | rework the behavior, or list the entity in `Scope.TrustedOpaque` / `Scope.TrustPostOperation` |

An `IN` list or an `OR` form of the tenant filter is refused as `MissingPredicate`: the guard accepts only a top-level `AND` equality.

## A Declared Facet or Scope Is Unknown

A request naming something from your definitions file gets a per-facet `FACET_UNKNOWN_FACET` or a whole-request `400 FACET_UNKNOWN_SCOPE` when that entry was disabled at load. Each disabled entry is logged at boot:

```text
RetoldFaceting definitions: Facet "Author.ByBookAlias" disabled: FACET_DEFINITION_INVALID UnknownAlias at "#object0""/Facets/0/Dimensions/0/Path/0"
```

In process, `fable.RetoldFacetingDefinitionRegistry.disabled()` returns the same entries with their `Reason`, `Pointer` and, for a dependant, `DependsOn`; `warnings()` returns load warnings such as `DEFINITIONS_PATH_MISSING`. [Definitions Files](#/page/Definitions) lists every reason.

## Numbers Look Stale, or Change Between Requests

Read the envelope first:

- `Cached: true` or `Stale: true`: the result cache answered. `Stale` answers are refreshed in the background.
- `Engine: "ClickHouse"` with `Exact: false`: the store answered with some lag. The `Store.Facets` entries say which engine answered each facet and why.
- A write the service cannot see (a direct DAL call, raw SQL, an importer, another process) never invalidates the cache. Report it with `notify()` ([JavaScript API](#/page/api/JavaScript_API)).

**Check:** repeat the request with `"Engine": "Live"` and `"Freshness": { "Mode": "Exact" }`. That answer is computed on the spot from the source database. If it is right, the difference is freshness; see [Caching and Invalidation](#/page/Caching_And_Invalidation).

## Compare Live With the Reference Oracle

The test suites check every Live answer against a **Reference** engine: a pure-JavaScript fold over the rows each entity's own list route returns, with no SQL composition. You can ask it about your own data, in process:

```javascript
const libFacetEnvelope = require('retold-faceting-service/source/contract/Facet-Contract-Envelope.js');

let tmpService = _Fable.RetoldFacetingService;
tmpService.query('BookStoreSale', tmpBody, tmpRequest,
	(pLiveError, pLive) =>
	{
		tmpService.queryInternal('BookStoreSale', tmpBody, tmpRequest, { ForceEngine: 'Reference' },
			(pReferenceError, pReference) =>
			{
				let tmpSame = JSON.stringify(libFacetEnvelope.normalizeForComparison(pLive))
					=== JSON.stringify(libFacetEnvelope.normalizeForComparison(pReference));
				console.log(`Live and Reference agree: ${tmpSame}`);
			});
	});
```

`tmpRequest` carries the session to act for (*The Request Argument* in [JavaScript API](#/page/api/JavaScript_API)). `normalizeForComparison` drops the fields that legitimately differ between engines: `Version`, `AsOf`, `ElapsedMS`, `Engine`, `Cached`, `LagMS`, `Stale` and `Store`. Captured with the Getting Started credit-card body: both answered `Total` 1288 with identical buckets, and the comparison was `true`.

The Reference engine reads **every row** of every entity the request touches into memory, through the list path. Use it on a development copy or a small table, never on a production hot path. Its answers are never cached.

To rule out the conditional disjunctive scan, run the same body with `{ PlanForm: { Cube: 'Never' } }` as the fourth argument. Every facet then gets its own statement: the captured run took 3 statements and 0 cubes instead of 1 and 1, with the same `Total`. A difference between the two forms is a bug worth reporting with the body and both envelopes.

## Related

- [Security and Tenancy](#/page/Security_And_Tenancy): the principal, the gate, the ScopeGuard
- [Errors and Limits](#/page/api/Errors_And_Limits): every error code
- [The Response Envelope](#/page/api/Envelope): every field named on this page
- [Testing](#/page/Testing): how the module's own suites use these checks
