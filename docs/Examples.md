# Examples

The service was designed around three questions that real list pages ask, each harder than the last. All three run end to end over HTTP in the module's test suite (`test/Facet-Motivating-Queries_tests.js`), on SQLite and PostgreSQL, and all three are pages of the demo application. A fourth page builds a whole explorer from `Describe`.

## The Examples

| Page | The question | Entity (fixture) | What it teaches |
|---|---|---|---|
| [E1: Projects for Me](#/page/examples/E1_Projects_For_Me) | "All the projects for this user based on this complex criteria" | `Project` (ProjectTrack) | Named scopes with a parameter, disjunctive checklists, a month histogram, a child-count band, a Status by Client pivot, and the first page of records in the same answer |
| [E2: Documents by Form Type](#/page/examples/E2_Documents_By_Form_Type) | "The documents of this form type, bucketed by month" | `Document` (ProjectTrack) | A disjunctive form-type checklist over a global lookup table, a date window, partial edge buckets after an interval change, and a per-facet error |
| [E3: Lab Forms I Still Have to Fill Out](#/page/examples/E3_Lab_Forms_To_Fill_Out) | "The lab forms I still have to fill out for my queues' intakes" | `MaterialIntakeRequirement` and `MaterialIntake` (LabTrack) | An anti-join on a composite key through a co-reference step, a relaxed (lab-wide) hop, a route scope feeding a work list, and the same question answered a second way as a TuplePivot |
| [Bookstore Explorer](#/page/examples/Bookstore_Explorer) | "Which books are in the catalog, and how did readers rate them?" | `Book` (Bookstore-Tenant) | A UI built from `GET /1.0/Facet/Describe`, auto facets next to declared cross-entity facets, and Edges for a skewed numeric column |

## Fold Kinds and Features by Example

| Example | Fold kinds | Other features |
|---|---|---|
| E1 | [K1 Terms](#/page/fold_kinds/001-terms), [K2 DateHistogram](#/page/fold_kinds/002-date-histogram), [K12 ChildRollup](#/page/fold_kinds/012-child-rollup), [K14 Pivot](#/page/fold_kinds/014-pivot); scopes built from [K10 PathSemiJoin](#/page/fold_kinds/010-path-semi-join), [K11 AntiPath](#/page/fold_kinds/011-anti-path) and [K17 UnionOfPaths](#/page/fold_kinds/017-union-of-paths) | Three named scopes, an `EnumList` parameter, an alias, labels from a foreign key, `Records` in the Query body |
| E2 | [K1 Terms](#/page/fold_kinds/001-terms), [K2 DateHistogram](#/page/fold_kinds/002-date-histogram) | A global lookup entity (`Catalog.GlobalEntities`), a dangling key, `422 FACET_INTERVAL_TOO_FINE` with a suggested interval |
| E3, variant A | [K1 Terms](#/page/fold_kinds/001-terms), [K8 PathTerms](#/page/fold_kinds/008-path-terms) (terms and a week histogram over to-one paths), [K20 ExistsSplit](#/page/fold_kinds/020-exists-split); its scope uses [K10](#/page/fold_kinds/010-path-semi-join) and [K11](#/page/fold_kinds/011-anti-path) with `Correlate` | A declared facet with siblings, a co-reference step (`=`), a `TenantOnly` hop over an owner-scoped entity, the `/Scope/:Scope/` route forms, a `pict-section-recordset` work list |
| E3, variant B | [K18 TuplePivot](#/page/fold_kinds/018-tuple-pivot), [K11 AntiPath](#/page/fold_kinds/011-anti-path) | Count mode `KeyDistinct`, buckets with no list clause |
| Bookstore Explorer | [K1 Terms](#/page/fold_kinds/001-terms), [K3 NumericHistogram](#/page/fold_kinds/003-numeric-histogram), [K9 BridgeTerms](#/page/fold_kinds/009-bridge-terms), [K12 ChildRollup](#/page/fold_kinds/012-child-rollup), [K20 ExistsSplit](#/page/fold_kinds/020-exists-split); a scope built from [K10](#/page/fold_kinds/010-path-semi-join) | Describe-driven cards, count mode `PivotDistinct` (buckets can sum to more than the total) |

## The Fixture Domains

The examples run on the seeded fixture domains in `test/fixtures/`. Each seed is deterministic and plants traps on purpose: soft-deleted rows, NULL and dangling foreign keys, cross-tenant references, and values that sit exactly on bucket edges.

| Fixture | Entities | Tenancy as the harness installs it |
|---|---|---|
| ProjectTrack | `Customer`, `User`, `Client`, `Project`, `ProjectMembership`, `Task`, `Issue`, `FormType`, `Document` | Two tenants on `IDCustomer`; `FormType` is a global lookup |
| LabTrack | `Customer`, `User`, `LabQueue`, `LabQueueMember`, `MaterialType`, `MaterialIntake`, `LabFormType`, `MaterialIntakeRequirement`, `MaterialTypeFormRequirement`, `LabForm` | Two tenants on `IDCustomer`; `LabForm` is also owner-scoped (`OwnerIDUser`); `LabFormType` is a global lookup |
| Bookstore-Tenant | The Bookstore model (`Book`, `Review`, `Author`, `BookStoreSale` and more) with an `IDTenant` column on every table | Tenant 1 holds the base data, tenant 2 a small clone |

Each domain has a story principal: user 1 of tenant 1 (the ProjectTrack "Lead", the LabTrack "Tech"). The motivating questions are written for "user 42 in tenant 7", so the demo and `debug/m2-smoke.js` renumber tenant 1 to 7 and user 1 to 42 after seeding. Renumbering changes only the IDs: the answers on these pages, captured as user 1 of tenant 1, are the ones the demo shows for user 42.

## Run the Demo

The demo lives in `example_applications/faceting_demo` and needs its Node host (the facet API is not static). Inside the retold monorepo it needs no install of its own; its dependencies resolve from the umbrella `node_modules`. In a standalone clone of the module, run `npm install` at the module root and again in the demo folder first; [The Faceting Demo](#/page/examples/Faceting_Demo) has the details.

```bash
cd example_applications/faceting_demo
npm start              # builds the bundle when needed, then serves http://127.0.0.1:19300/
```

[The Faceting Demo](#/page/examples/Faceting_Demo) explains what each part of the page shows, the client pattern behind it, and its test commands.

## Run the Questions Without a Browser

`debug/m2-smoke.js` boots the ProjectTrack and LabTrack fixtures in memory and prints E1, E2 and both E3 variants, abridged, as user 42 of tenant 7:

```bash
node debug/m2-smoke.js
```

`debug/m1-smoke.js` does the same for the Bookstore (a `Describe` and one query). Both bind fixed ports (19191 and 19190), so run one copy at a time.

## Related

- [Getting Started](#/page/Getting_Started): the same ideas on the Bookstore, step by step
- [Concepts](#/page/Concepts): the vocabulary these pages use
- [Fold Kinds](#/page/Fold_Kinds): every kind the examples use, one page each
- [Testing](#/page/Testing): the suites that run these questions
