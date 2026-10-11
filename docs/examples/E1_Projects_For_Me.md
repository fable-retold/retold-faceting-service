# E1: Projects for Me

> "Give me all the projects for this user based on this complex criteria."

The first motivating question filters one entity, `Project`, by facts that live in three other entities: memberships, tasks and issues. It is answered with three named scopes, three list clauses, five facets and the first page of records, in one request.

![The Projects page of the demo, as user 42](../images/demo-projects.jpg)

## The Question

In words: *projects I own or lead, that have an overdue task assigned to me and no open blocker, that are Active or At risk, belong to Cobalt Works or Iris Media, and started in 2026.*

The first three conditions are about the user and about related rows. They are **named scopes**, declared once and reused. The last three are the list page's own filters: a status checklist, a client checklist and a date range. Each of those has a facet, so the page can show what ticking another box would do.

## The Model

The ProjectTrack fixture (`test/fixtures/ProjectTrack-Model.json`) has these entities in play, each with the standard audit columns, a `Deleted` column and the tenant column `IDCustomer`:

| Entity | Columns used here |
|---|---|
| `Project` | `IDProject`, `Name`, `Status`, `StartDate`, `IDClient`, `OwnerIDUser` |
| `ProjectMembership` | `IDProject`, `IDUser`, `Role`, `Active` |
| `Task` | `IDProject`, `AssignedIDUser`, `Status`, `DueDate` |
| `Issue` | `IDProject`, `Severity`, `State` |
| `Client` | `IDClient`, `Name` |

The test harness installs the service on this domain with a tenancy policy and the domain's definitions file:

```javascript
{
	Scope:
		{
			Policy: { Column: 'IDCustomer', SessionField: 'CustomerID', Exclude: [ 'FormType' ], PersonalScopes: {} },
			Guard: 'Strict'
		},
	Catalog: { GlobalEntities: [ 'FormType' ] },
	Definitions: { Path: false, Files: [ DEFINITIONS_PATH ] }
}
```

`DEFINITIONS_PATH` is `test/fixtures/ProjectTrack-Definitions.json`.

## The Definitions

This is the part of the domain's definitions file that E1 uses: an alias, the three scopes and the overdue-task band. The file also holds a fourth scope and three coverage facets for the test suite.

<!-- docs-check: definitions Id=e1-projecttrack-excerpt Fixture=ProjectTrack -->
```json
{
	"FormatVersion": 1,
	"Aliases":
	{
		"MemberOf": [ "<ProjectMembership.IDProject" ]
	},
	"Scopes":
	{
		"Project.MyProjects":
		{
			"Entity": "Project",
			"Description": "Projects where I hold one of the given roles, or that I own",
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
		},
		"Project.HasMyOverdue":
		{
			"Entity": "Project",
			"Description": "Projects with at least one overdue task assigned to me",
			"Where":
			[
				{ "Exists": { "Path": [ "<Task.IDProject" ], "Where": [ { "Field": "AssignedIDUser", "Op": "EQ", "Value": "$CurrentUser.IDUser" },
				                                                     { "Field": "DueDate", "Op": "LT", "Value": "$Now" },
				                                                     { "Field": "Status", "Op": "NE", "Value": "Done" } ] } }
			]
		},
		"Project.Unblocked":
		{
			"Entity": "Project",
			"Description": "Projects with no open Blocker issue (NoVisibleMatch)",
			"Where":
			[
				{ "NotExists": { "Path": [ "<Issue.IDProject" ], "Where": [ { "Field": "Severity", "Op": "EQ", "Value": "Blocker" },
				                                                         { "Field": "State", "Op": "EQ", "Value": "Open" } ] } }
			]
		}
	},
	"Facets":
	[
		{
			"Facet": "Project.MyOverdueBand",
			"Version": 1,
			"Title": "My overdue tasks per project",
			"Dimensions":
			[
				{ "Kind": "ChildRollup",
				  "Child": { "Path": [ "<Task.IDProject" ], "Agg": "count",
				             "Where": [ { "Field": "AssignedIDUser", "Op": "EQ", "Value": "$CurrentUser.IDUser" },
				                        { "Field": "DueDate", "Op": "LT", "Value": "$Now" },
				                        { "Field": "Status", "Op": "NE", "Value": "Done" } ] },
				  "Edges": [ 1, 3, 10 ] }
			],
			"Exclude": "None"
		}
	]
}
```

How to read it:

- **`MyProjects`** is a union (`Any`, [K17](#/page/fold_kinds/017-union-of-paths)) of two conditions: an active membership with one of the given roles, reached through the alias `@MemberOf` (the to-many step `<ProjectMembership.IDProject`, [K10 Exists](#/page/fold_kinds/010-path-semi-join)), or ownership of the project itself. `Roles` is an `EnumList` parameter with a default.
- **`HasMyOverdue`** keeps a project when at least one of its tasks is assigned to me, past due and not done.
- **`Unblocked`** keeps a project when no open Blocker issue exists ([K11 NotExists](#/page/fold_kinds/011-anti-path)). "No issue" means no issue *visible to this user*: a soft-deleted blocker or another tenant's blocker never blocks. The description's `NoVisibleMatch` is the service's name for this meaning ("no related row visible to this user matches"); it also appears as a facet's `Semantics`.
- **`MyOverdueBand`** is a declared facet ([K12 ChildRollup](#/page/fold_kinds/012-child-rollup)): it counts my overdue tasks per project and puts each project in a band, `None`, `1–2`, `3–9` or `10+`, cut at the edges 1, 3 and 10.

`$CurrentUser.IDUser` comes from the request's principal, never from the body. A session without a user is answered `401 FACET_UNAUTHENTICATED`, never "matches nothing". `$Now` is the request time, floored to `Cache.NowBucketMS` (one minute by default), so every request within the same minute binds the same value. [Definitions Files](#/page/Definitions) covers every part of this syntax.

## The Request

`POST /1.0/Facet/Project/Query`, as the demo sends it on load:

<!-- docs-check: request Fixture=ProjectTrack Entity=Project User=1 Tenant=1 -->
```json
{
	"Scopes":
	[
		{ "Scope": "Project.MyProjects", "Params": { "Roles": [ "Owner", "Lead" ] } },
		{ "Scope": "Project.HasMyOverdue" },
		{ "Scope": "Project.Unblocked" }
	],
	"Clauses":
	[
		{ "Type": "DistinctSelectedValueList", "FilterByColumn": "Status", "Values": [ "Active", "AtRisk" ], "FilterKey": "Status", "Hash": "Projects-Status" },
		{ "Type": "DistinctSelectedValueList", "FilterByColumn": "IDClient", "Values": [ 3, 9 ], "FilterKey": "IDClient", "Hash": "Projects-Client" },
		{ "Type": "DateRange", "FilterByColumn": "StartDate", "Values": { "Start": "2026-01-01 00:00:00", "End": "2027-01-01 00:00:00" }, "EndExclusive": true, "FilterKey": "StartDate", "Hash": "Projects-Started" }
	],
	"Facets":
	[
		{ "Key": "Status", "Facet": "Project.Status", "Top": 10 },
		{ "Key": "Client", "Facet": "Project.IDClient", "Top": 20 },
		{ "Key": "Started", "Facet": "Project.StartDate", "Interval": "month" },
		{ "Key": "MyOverdue", "Facet": "Project.MyOverdueBand" },
		{ "Key": "StatusByClient", "Facet": [ "Project.Status", "Project.IDClient" ], "Fold": "Pivot", "Top": 10 }
	],
	"Total": true,
	"Records": { "Begin": 0, "Cap": 25, "Sort": [ { "Field": "StartDate", "Dir": "DESC" } ] }
}
```

The demo also sends `"Freshness": { "Mode": "Bounded", "MaxLagMS": 5000 }` and a `ClauseKey` on each clause; neither changes the counts. (`ClauseKey` is pict-section-recordset's clause-type marker; copy it as it is.) The principal is the fixture's story user, the project lead (user 1 of tenant 1). The demo shows the same user as user 42 of tenant 7.

## The Answer

The real answer, abridged: freshness and display fields, every bucket's `Clause` and `Selection` (all but one), and all but five columns of each record are left out.

```json
{
	"Entity": "Project",
	"Version": "fv1:a1866339f4b7b864",
	"Engine": "Live",
	"Exact": true,
	"Total": 6,
	"Filter":
	{
		"Applied":
		[
			{ "Hash": "Projects-Status" }, { "Hash": "Projects-Client" }, { "Hash": "Projects-Started" },
			{ "Scope": "Project.MyProjects" }, { "Scope": "Project.HasMyOverdue" }, { "Scope": "Project.Unblocked" }
		],
		"Warnings": []
	},
	"DependsOn": [ "Client", "Issue", "Project", "ProjectMembership", "Task" ],
	"Facets":
	{
		"Status":
		{
			"Fold": "Terms", "Excluded": [ "Projects-Status" ], "Total": 7, "SumOfCounts": 7, "MissingCount": 0,
			"Buckets":
			[
				{ "Key": "Active", "Label": "Active", "Count": 4, "Selected": true },
				{ "Key": "AtRisk", "Label": "AtRisk", "Count": 2, "Selected": true },
				{
					"Key": "OnHold", "Label": "OnHold", "Count": 1, "Selected": false,
					"Clause": { "Type": "DistinctSelectedValueList", "FilterByColumn": "Status", "Values": [ "OnHold" ], "FilterKey": "Status", "ClauseKey": "DistinctSelectedValueList" }
				}
			]
		},
		"Client":
		{
			"Fold": "Terms", "Excluded": [ "Projects-Client" ], "Total": 8, "SumOfCounts": 8, "MissingCount": 0,
			"Buckets":
			[
				{ "Key": 3, "Label": "Cobalt Works", "LabelResolved": true, "Count": 3, "Selected": true },
				{ "Key": 9, "Label": "Iris Media", "LabelResolved": true, "Count": 3, "Selected": true },
				{ "Key": 11, "Label": "11", "LabelResolved": false, "Count": 1, "Selected": false },
				{ "Key": 13, "Label": "13", "LabelResolved": false, "Count": 1, "Selected": false }
			]
		},
		"Started":
		{
			"Fold": "DateHistogram", "Interval": "month", "Excluded": [ "Projects-Started" ], "Total": 8, "SumOfCounts": 7, "MissingCount": 1,
			"Buckets":
			[
				{ "Key": "2025-12-01 00:00:00", "Label": "Dec 2025", "Count": 1, "Selected": false },
				{ "Key": "2026-01-01 00:00:00", "Label": "Jan 2026", "Count": 0, "Selected": true },
				{ "Key": "2026-02-01 00:00:00", "Label": "Feb 2026", "Count": 1, "Selected": true },
				{ "Key": "2026-03-01 00:00:00", "Label": "Mar 2026", "Count": 1, "Selected": true },
				{ "Key": "2026-04-01 00:00:00", "Label": "Apr 2026", "Count": 0, "Selected": true },
				{ "Key": "2026-05-01 00:00:00", "Label": "May 2026", "Count": 1, "Selected": true },
				{ "Key": "2026-06-01 00:00:00", "Label": "Jun 2026", "Count": 0, "Selected": true },
				{ "Key": "2026-07-01 00:00:00", "Label": "Jul 2026", "Count": 1, "Selected": true },
				{ "Key": "2026-08-01 00:00:00", "Label": "Aug 2026", "Count": 0, "Selected": true },
				{ "Key": "2026-09-01 00:00:00", "Label": "Sep 2026", "Count": 0, "Selected": true },
				{ "Key": "2026-10-01 00:00:00", "Label": "Oct 2026", "Count": 0, "Selected": true },
				{ "Key": "2026-11-01 00:00:00", "Label": "Nov 2026", "Count": 1, "Selected": true },
				{ "Key": "2026-12-01 00:00:00", "Label": "Dec 2026", "Count": 1, "Selected": true }
			]
		},
		"MyOverdue":
		{
			"Fold": "ChildRollup", "Declared": true, "Disjunctive": "NotApplicable", "Excluded": [], "Total": 6,
			"Buckets":
			[
				{ "Key": 0, "Label": "None", "Count": 0, "Clause": null },
				{ "Key": 1, "Label": "1–2", "Count": 3, "Start": 1, "End": 3, "EndExclusive": true, "Clause": null },
				{ "Key": 2, "Label": "3–9", "Count": 2, "Start": 3, "End": 10, "EndExclusive": true, "Clause": null },
				{ "Key": 3, "Label": "10+", "Count": 1, "Start": 10, "Clause": null }
			]
		},
		"StatusByClient":
		{
			"Fold": "Pivot", "Disjunctive": "NotApplicable", "Excluded": [], "Total": 6,
			"RowKeys": [ "Active", "AtRisk" ],
			"ColumnKeys": [ 3, 9 ],
			"Cells":
			[
				{ "K1": "Active", "K2": 3, "Count": 2 },
				{ "K1": "Active", "K2": 9, "Count": 2 },
				{ "K1": "AtRisk", "K2": 3, "Count": 1 },
				{ "K1": "AtRisk", "K2": 9, "Count": 1 }
			],
			"Marginals":
			{
				"Rows": [ { "Key": "Active", "Count": 4 }, { "Key": "AtRisk", "Count": 2 } ],
				"Columns": [ { "Key": 3, "Count": 3 }, { "Key": 9, "Count": 3 } ],
				"Total": 6
			}
		}
	},
	"Records":
	[
		{ "IDProject": 16, "Name": "Hangar 16", "Status": "Active", "StartDate": "2026-12-31 23:59:59", "IDClient": 3 },
		{ "IDProject": 5, "Name": "Drift 5", "Status": "AtRisk", "StartDate": "2026-11-30 17:45:00", "IDClient": 9 },
		{ "IDProject": 4, "Name": "Atlas 4", "Status": "Active", "StartDate": "2026-07-01 00:00:00", "IDClient": 9 },
		{ "IDProject": 3, "Name": "Jetty 3", "Status": "AtRisk", "StartDate": "2026-05-20 08:00:00", "IDClient": 3 },
		{ "IDProject": 2, "Name": "Ion 2", "Status": "Active", "StartDate": "2026-03-15 10:30:00", "IDClient": 9 },
		{ "IDProject": 1, "Name": "Atlas 1", "Status": "Active", "StartDate": "2026-02-10 09:00:00", "IDClient": 3 }
	],
	"RecordShape": "Entity",
	"RecordsDropped": 0
}
```

## Reading the Answer, Card by Card

**The total.** Six projects pass every scope and every clause. `POST /1.0/Facet/Project/Records/Count` with the same `Scopes` and `Clauses` answers `{ "Count": 6 }`, and the six records are those projects, newest start first.

**Status** ([K1 Terms](#/page/fold_kinds/001-terms)) excludes its own clause, so it counts 7 projects: the 4 Active and 2 At risk that are selected, plus 1 On hold. Ticking `OnHold` in the demo writes that bucket's key into the Status clause and the total becomes 7, while this card's own counts stay put.

**Client** also excludes its own clause and counts 8 projects. Two of them point at clients this user cannot read: client 11 is soft-deleted and client 13 belongs to the other tenant. The labels are looked up through the `Client` entity's own list, which hides both, so those buckets keep their key, report `LabelResolved: false`, and can still be selected. The demo shows them as "Client #11 (no name)" and "#13".

**Started** ([K2 DateHistogram](#/page/fold_kinds/002-date-histogram)) counts 8 projects by start month, ignoring the 2026 window: one started on 2025-12-31 and one has no start date (`MissingCount: 1`). The months inside the window are `Selected`. Empty months between the first and last bucket come back with `Count: 0`, so a chart needs no gap filling.

**My overdue tasks per project** is the declared band. It uses `Exclude: "None"`, so it counts the six projects of the answer: three with one or two overdue tasks, two with three to nine, one with ten or more. `None` is zero here because the `HasMyOverdue` scope already requires at least one. Its buckets carry `Clause: null`: no list clause can select "projects with three to nine of my overdue tasks", so the demo shows this card read-only.

> **Planned.** Selecting buckets that carry no list clause, such as these bands.

**Status by Client** ([K14 Pivot](#/page/fold_kinds/014-pivot)) is counted under the full filter, so its cells add up to the total. A pivot cell has no clause of its own. The demo selects a cell by writing the matching single-key bucket clauses of the `Status` and `Client` facets, in one request; Active by Iris Media gives 2.

**The scopes never move.** `Filter.Applied` lists them, but no facet excludes them. A named scope is part of the question, not a selection on a card.

## Variations

### A Join Clause Instead of a Key List

The design writes the client filter as a join to `Client`. That clause compiles to an existence condition over the declared edge, and it belongs to the same `IDClient` facet, so the answer is the same:

<!-- docs-check: request Fixture=ProjectTrack Entity=Project User=1 Tenant=1 -->
```json
{
	"Scopes":
	[
		{ "Scope": "Project.MyProjects", "Params": { "Roles": [ "Owner", "Lead" ] } },
		{ "Scope": "Project.HasMyOverdue" },
		{ "Scope": "Project.Unblocked" }
	],
	"Clauses":
	[
		{ "Type": "DistinctSelectedValueList", "FilterByColumn": "Status", "Values": [ "Active", "AtRisk" ], "FilterKey": "Status", "Hash": "Projects-Status" },
		{ "Type": "InternalJoinSelectedValueList", "RemoteTable": "Client", "JoinInternalConnectionColumn": "IDClient", "JoinExternalConnectionColumn": "IDClient", "Values": [ 3, 9 ], "FilterKey": "IDClient", "Hash": "Projects-Client" },
		{ "Type": "DateRange", "FilterByColumn": "StartDate", "Values": { "Start": "2026-01-01 00:00:00", "End": "2027-01-01 00:00:00" }, "EndExclusive": true, "FilterKey": "StartDate", "Hash": "Projects-Started" }
	],
	"Facets":
	[
		{ "Key": "Status", "Facet": "Project.Status", "Top": 10 },
		{ "Key": "Client", "Facet": "Project.IDClient", "Top": 20 }
	],
	"Total": true
}
```

It answers `Total: 6`, and `Client` still reports `Excluded: [ "Projects-Client" ]`.

### Another User, Another Role

The same question as user 2 of the same tenant, a member and reviewer who owns nothing, answers `Total: 0`: the `Roles` parameter asks for Owner or Lead. Add `Member` to the roles and drop `HasMyOverdue` (this user has no overdue tasks on those projects):

<!-- docs-check: request Fixture=ProjectTrack Entity=Project User=2 Tenant=1 -->
```json
{
	"Scopes":
	[
		{ "Scope": "Project.MyProjects", "Params": { "Roles": [ "Owner", "Lead", "Member" ] } },
		{ "Scope": "Project.Unblocked" }
	],
	"Clauses":
	[
		{ "Type": "DistinctSelectedValueList", "FilterByColumn": "Status", "Values": [ "Active", "AtRisk" ], "FilterKey": "Status", "Hash": "Projects-Status" },
		{ "Type": "DistinctSelectedValueList", "FilterByColumn": "IDClient", "Values": [ 3, 9 ], "FilterKey": "IDClient", "Hash": "Projects-Client" },
		{ "Type": "DateRange", "FilterByColumn": "StartDate", "Values": { "Start": "2026-01-01 00:00:00", "End": "2027-01-01 00:00:00" }, "EndExclusive": true, "FilterKey": "StartDate", "Hash": "Projects-Started" }
	],
	"Facets":
	[
		{ "Key": "Status", "Facet": "Project.Status", "Top": 10 }
	],
	"Total": true
}
```

It answers `Total: 2`. The original request as the other tenant's lead answers `Total: 1`: that tenant's single project. The body is identical in every case; only the session differs.

### Errors

An empty role list fails the parameter's validation before anything runs:

<!-- docs-check: request Fixture=ProjectTrack Entity=Project User=1 Tenant=1 Expect=FACET_PARAM_INVALID -->
```json
{
	"Scopes": [ { "Scope": "Project.MyProjects", "Params": { "Roles": [] } } ],
	"Facets": [ { "Key": "Status", "Facet": "Project.Status" } ],
	"Total": true
}
```

```json
{ "Error": { "Code": "FACET_PARAM_INVALID", "Status": 400, "Message": "A parameter is invalid.", "Detail": { "Scope": "Project.MyProjects", "Param": "Roles", "Reason": "Type" } } }
```

Without a session, every request on this tenant-scoped domain is refused:

```json
{ "Error": { "Code": "FACET_UNAUTHENTICATED", "Status": 401, "Message": "Authentication required." } }
```

## Related

- [Concepts](#/page/Concepts): disjunctive faceting and named scopes
- [Definitions Files](#/page/Definitions): scopes, parameters, aliases and `$` bindings
- [The Response Envelope](#/page/api/Envelope): every field shown above
- [Records, Count and Keys](#/page/api/Records_And_Keys): the `Records` block of a Query
- [E2: Documents by Form Type](#/page/examples/E2_Documents_By_Form_Type), the next question
