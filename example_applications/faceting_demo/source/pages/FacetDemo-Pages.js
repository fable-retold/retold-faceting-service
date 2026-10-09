/**
 * FacetDemo-Pages -- the four demo pages as DATA (DEMO-SPEC §6).  Pure: no requires, so the node smoke test
 * (server/Faceting-Demo-Smoke.js) builds the exact request bodies the browser sends.
 *
 *   Groups[<GroupHash>]   one facet request family = one coalescing unit = one POST per filter change:
 *                         Domain, Entity, RouteScope (the /Scope/:Scope/ route form or null), Total,
 *                         Facets (the request specs, verbatim on the wire), InitialScopes, InitialSelections
 *                         (clauses in exactly the shape a bucket Clause has), Records (first page in the
 *                         Query body; later pages through /Records/:Begin/:Cap).
 *                         FacetsFrom: 'Describe' (Books): Facets start empty and come from GET …/Describe through
 *                         describedFacets() below (rules: Order, Skip, SkipAuditDates, Overrides).
 *   Pages[]               routing + layout: which widget renders which facet of which group, where; the literal
 *                         Question, a de-emphasized design Reference, a Note (shown under the question), the
 *                         page's EmptyHint and Try line.
 *
 * Panel kinds (DEMO-SPEC §7): Scope, Terms (Display: Checklist | Chips | Bars | Split; SortBy: 'KeyDesc' |
 * 'KeyAsc'; KeyNoun), Histogram, Pivot, Records (Columns may name a Lookup, Facet-Lookup.js), Compare, Change
 * (M4, DEMO-SPEC §12: the "Make a change" panel; Action: ProjectStatus | DocumentAdd | LabFormComplete |
 * ReviewAdd), and Described (the panels describedFacets() derived for a group).  Panel keys reference
 * Facets[].Key.
 *
 * Initial state = the motivating requests of design 08 (E1, E2, E3) as the story principal (user 42 /
 * tenant 7), validated against the fixtures: Projects Total 6, Documents 41, Lab forms (A) 237, Books 1436.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */

// Bucket-shaped initial selections (what clicking the bucket would write back).
const DSVL = (pColumn, pValues) =>
{
	return { Type: 'DistinctSelectedValueList', FilterByColumn: pColumn, Values: pValues, FilterKey: pColumn, ClauseKey: 'DistinctSelectedValueList' };
};
const DATE_RANGE = (pColumn, pStart, pEnd) =>
{
	return { Type: 'DateRange', FilterByColumn: pColumn, Values: { Start: pStart, End: pEnd }, EndExclusive: true, FilterKey: pColumn, ClauseKey: 'DateRange' };
};

// Meadow audit columns: a Describe-driven page does not facet on them unless asked.
const AUDIT_FIELDS = [ 'CreateDate', 'UpdateDate', 'DeleteDate' ];

const GROUPS =
{
	// ---------------------------------------------------------------- E1 (08 §2): ProjectTrack, as user 42
	Projects:
	{
		Hash: 'Projects',
		Domain: 'ProjectTrack',
		Entity: 'Project',
		RouteScope: null,
		Total: true,
		Facets:
		[
			{ Key: 'Status', Facet: 'Project.Status', Top: 10 },
			{ Key: 'Client', Facet: 'Project.IDClient', Top: 20 },
			{ Key: 'Started', Facet: 'Project.StartDate', Interval: 'month' },
			{ Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' },
			{ Key: 'StatusByClient', Facet: [ 'Project.Status', 'Project.IDClient' ], Fold: 'Pivot', Top: 10 }
		],
		InitialScopes:
		{
			'Project.MyProjects': { On: true, Params: { Roles: [ 'Owner', 'Lead' ] } },
			'Project.HasMyOverdue': { On: true },
			'Project.Unblocked': { On: true },
			'Project.ManyOverdue': { On: false }
		},
		InitialSelections:
		{
			Status: DSVL('Status', [ 'Active', 'AtRisk' ]),
			Client: DSVL('IDClient', [ 3, 9 ]),
			Started: DATE_RANGE('StartDate', '2026-01-01 00:00:00', '2027-01-01 00:00:00')
		},
		Records: { Begin: 0, Cap: 25, Sort: [ { Field: 'StartDate', Dir: 'DESC' } ] }
	},

	// ---------------------------------------------------------------- E2 (08 §3): ProjectTrack documents
	Documents:
	{
		Hash: 'Documents',
		Domain: 'ProjectTrack',
		Entity: 'Document',
		RouteScope: null,
		Total: true,
		Facets:
		[
			{ Key: 'ByForm', Facet: 'Document.IDFormType', Top: 20 },
			{ Key: 'ByMonth', Facet: 'Document.DocumentDate', Interval: 'month' },
			{ Key: 'Status', Facet: 'Document.Status' }
		],
		InitialScopes: {},
		InitialSelections:
		{
			// Form D (the E2 trap form type, IDFormType 4) and the first half of 2026.
			ByForm: DSVL('IDFormType', [ 4 ]),
			ByMonth: DATE_RANGE('DocumentDate', '2026-01-01 00:00:00', '2026-07-01 00:00:00')
		},
		Records: { Begin: 0, Cap: 25, Sort: [ { Field: 'DocumentDate', Dir: 'DESC' } ] }
	},

	// ---------------------------------------------------------------- E3 variant A (08 §4.2): LabTrack, stored requirements
	LabFormsA:
	{
		Hash: 'LabFormsA',
		Domain: 'LabTrack',
		Entity: 'MaterialIntakeRequirement',
		// The work list's named scope as a ROUTE scope: Total == ToDo.Total == Records/Count, and the list uses
		// the pict-section-recordset FilterEndpointOverride 'Facet/MaterialIntakeRequirement/Scope/MaterialIntakeRequirement.ToDoForMe/Records'.
		RouteScope: 'MaterialIntakeRequirement.ToDoForMe',
		Total: true,
		Facets:
		[
			{ Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo', Top: 20 },
			{ Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' },
			{ Key: 'Week', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek' },
			{ Key: 'Discipline', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' },
			{ Key: 'Started', Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started' }
		],
		InitialScopes: {},
		InitialSelections: {},
		Records: { Begin: 0, Cap: 25, Sort: [ { Field: 'IDMaterialIntake', Dir: 'ASC' } ] }
	},

	// ---------------------------------------------------------------- E3 variant B (08 §4.3): TuplePivot, implied by configuration
	LabFormsB:
	{
		Hash: 'LabFormsB',
		Domain: 'LabTrack',
		Entity: 'MaterialIntake',
		RouteScope: null,
		// The envelope Total would count every intake; the question's total is the ToDo facet's (KeyDistinct tuples).
		Total: false,
		Facets:
		[
			{ Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo', Top: 20 },
			{ Key: 'Queue', Facet: 'MaterialIntake.FormsToDo/ByQueue' },
			{ Key: 'Week', Facet: 'MaterialIntake.FormsToDo/ByWeek' }
		],
		InitialScopes: {},
		InitialSelections: {},
		Records: null
	},

	// ---------------------------------------------------------------- Bookstore explorer: the facet list comes from Describe
	Books:
	{
		Hash: 'Books',
		Domain: 'Bookstore',
		Entity: 'Book',
		RouteScope: null,
		Total: true,
		FacetsFrom: 'Describe',
		Facets: [],
		Describe:
		{
			// Cards in this order first, then anything else Describe offers (in Describe's order).
			Order: [ 'Book.Genre', 'Book.Language', 'Book.Type', 'Book.PublicationYear', 'Book.ReviewRating', 'Book.ReviewCount', 'Book.HasFiveStar' ],
			Skip: { 'Book.ISBN': 'an identifier: every book has its own value' },
			SkipAuditDates: true,
			Overrides:
			{
				'Book.Genre': { Top: 20, Display: 'Checklist', Collapse: 8 },
				'Book.Language': { Top: 12, Display: 'Chips' },
				'Book.Type': { Display: 'Chips' },
				// Edges, not Nice: the fixture has a -1750 outlier that would stretch Nice buckets to 200 years wide.
				// Years outside the edges land in OtherCount (the widget shows it).
				'Book.PublicationYear': { Key: 'Year', Spec: { Fold: 'NumericHistogram', Mode: 'Edges', Edges: [ 1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020, 2030 ] } },
				// An ordinal scale reads top-down: 5 stars first.
				'Book.ReviewRating': { SortBy: 'KeyDesc' }
			}
		},
		InitialScopes:
		{
			'Book.WellReviewed': { On: false }
		},
		InitialSelections: {},
		Records: { Begin: 0, Cap: 25, Sort: [ { Field: 'Title', Dir: 'ASC' } ] }
	}
};

// Audience-facing scope text (the definitions' Descriptions are written for the test suite).
const PROJECT_SCOPES =
{
	Labels:
	{
		'Project.MyProjects': 'My projects',
		'Project.HasMyOverdue': 'Has my overdue tasks',
		'Project.Unblocked': 'Unblocked'
	},
	Descriptions:
	{
		'Project.MyProjects': 'I own it, or hold one of the chosen roles',
		'Project.HasMyOverdue': 'A task assigned to me is past due',
		'Project.Unblocked': 'No open Blocker issue'
	},
	// Part of the definitions, not of the E1 question.
	Hide: [ 'Project.ManyOverdue' ]
};

const PAGES =
[
	{
		Hash: 'Projects',
		Route: '/Projects',
		NavLabel: 'Projects for me',
		Title: 'Projects for me',
		Question: 'Projects I own or lead that have an overdue task assigned to me and no open blocker, are Active or At risk, belong to Cobalt Works or Iris Media, and started in 2026.',
		Reference: { Text: 'Design 08 §2 (E1)', Tip: 'Three named scopes (one with a Roles parameter), three clauses and five facets, answered by ONE POST /1.0/Facet/Project/Query.' },
		Try: 'Tick OnHold: every Status count stays (multi-select). Drag Feb–Jul on the start-date bars. Click a Status × Client cell. "Client #11" (a deleted client) and "#13" (another tenant\'s) have no name this user can read; the seed plants them, and they still filter.',
		EmptyHint: 'Add the Member role to "My projects", or turn off "Has my overdue tasks".',
		Noun: { One: 'project', Many: 'projects' },
		Groups: [ 'Projects' ],
		Tabs: null,
		Layout:
		{
			Top:
			[
				{ Widget: 'Scope', Group: 'Projects', Labels: PROJECT_SCOPES.Labels, Descriptions: PROJECT_SCOPES.Descriptions, Hide: PROJECT_SCOPES.Hide },
				{ Widget: 'Change', Group: 'Projects', Action: 'ProjectStatus' }
			],
			Rail:
			[
				{ Widget: 'Terms', Group: 'Projects', FacetKey: 'Status', Display: 'Checklist' },
				{ Widget: 'Terms', Group: 'Projects', FacetKey: 'Client', Display: 'Checklist', Collapse: 8, KeyNoun: 'Client' },
				{ Widget: 'Terms', Group: 'Projects', FacetKey: 'MyOverdue', Display: 'Bars', Title: 'My overdue tasks per project' }
			],
			Main:
			[
				{ Widget: 'Histogram', Group: 'Projects', FacetKey: 'Started', Title: 'Start date', Intervals: [ 'week', 'month', 'quarter', 'year' ] },
				{ Widget: 'Pivot', Group: 'Projects', FacetKey: 'StatusByClient', Title: 'Status × Client', RowFacet: 'Status', ColumnFacet: 'Client', KeyNoun: 'Client' },
				{
					Widget: 'Records', Group: 'Projects', Title: 'Projects',
					Columns:
					[
						{ Field: 'Name', Label: 'Project' },
						{ Field: 'Status', Label: 'Status' },
						{ Field: 'StartDate', Label: 'Start date', Format: 'Date' },
						{ Field: 'IDClient', Label: 'Client', Lookup: { Entity: 'Client', Show: 'Name' }, KeyNoun: 'Client' },
						{ Field: 'OwnerIDUser', Label: 'Owner', Lookup: { Entity: 'User', Show: [ 'NameFirst', 'NameLast' ] }, MarkCurrentUser: true, KeyNoun: 'User' },
						{ Field: 'IDProject', Label: 'ID', Align: 'Right', Muted: true }
					]
				}
			]
		}
	},
	{
		Hash: 'Documents',
		Route: '/Documents',
		NavLabel: 'Documents by form type',
		Title: 'Documents by form type',
		Question: 'Documents of form type Form D dated January through June 2026, counted by month.',
		Reference: { Text: 'Design 08 §3 (E2)', Tip: 'A disjunctive form-type checklist and a month histogram with click and drag, in one POST /1.0/Facet/Document/Query.' },
		Try: 'Tick Form G next to Form D: every form keeps its count. Click one month bar, or drag a span. Switch the interval to "day" to see a per-facet 422 with a suggestion.',
		EmptyHint: 'Clear the month range or tick another form type.',
		Noun: { One: 'document', Many: 'documents' },
		Groups: [ 'Documents' ],
		Tabs: null,
		Layout:
		{
			Top: [ { Widget: 'Change', Group: 'Documents', Action: 'DocumentAdd' } ],
			Rail:
			[
				{ Widget: 'Terms', Group: 'Documents', FacetKey: 'ByForm', Display: 'Checklist', Title: 'Form type', Collapse: 8 },
				{ Widget: 'Terms', Group: 'Documents', FacetKey: 'Status', Display: 'Chips', Title: 'Status' }
			],
			Main:
			[
				{ Widget: 'Histogram', Group: 'Documents', FacetKey: 'ByMonth', Title: 'Document date', Intervals: [ 'day', 'week', 'month', 'quarter', 'year' ] },
				{
					Widget: 'Records', Group: 'Documents', Title: 'Documents',
					Columns:
					[
						{ Field: 'Title', Label: 'Title' },
						{ Field: 'DocumentDate', Label: 'Date', Format: 'Date' },
						{ Field: 'Status', Label: 'Status', Blank: '(blank)' },
						{ Field: 'IDFormType', Label: 'Form type', Lookup: { Entity: 'FormType', Show: 'Name' }, KeyNoun: 'Form type' },
						{ Field: 'IDProject', Label: 'Project', Lookup: { Entity: 'Project', Show: 'Name' }, KeyNoun: 'Project' },
						{ Field: 'IDDocument', Label: 'ID', Align: 'Right', Muted: true }
					]
				}
			]
		}
	},
	{
		Hash: 'LabForms',
		Route: '/LabForms',
		NavLabel: 'Lab forms to fill out',
		Title: 'Lab forms I still have to fill out',
		Question: 'Required lab forms for intakes in my lab queues that nobody in my lab has completed yet.',
		Reference: { Text: 'Design 08 §4 (E3)', Tip: 'Variant A: the stored requirements under a named scope with a co-reference anti-join. Variant B: the same question derived from the material-type configuration (a TuplePivot).' },
		Note: 'Lab-wide on purpose ("Relaxed"): a form completed by ANY technician in my lab counts as done, so a colleague\'s finished form takes it off my list.',
		Try: 'Tick Lab Form H, then Verify: the list and the counts agree. Pick Physics and drag a few weeks. Open tab B to see the same question answered from configuration.',
		EmptyHint: 'Nothing waits for this user: they are in no lab queue. Switch to User 42 or User 43.',
		Noun: { One: 'form to do', Many: 'forms to do' },
		Groups: [ 'LabFormsA', 'LabFormsB' ],
		Tabs:
		[
			{ Hash: 'A', Label: 'Variant A: stored requirements', Group: 'LabFormsA' },
			{ Hash: 'B', Label: 'Variant B: implied by configuration', Group: 'LabFormsB', Note: 'Variant B is read-only: its TuplePivot buckets carry no list clause, so its cards cannot filter and it has no work list. It is here to cross-check variant A.' }
		],
		Layout:
		{
			A:
			{
				Top: [ { Widget: 'Change', Group: 'LabFormsA', Action: 'LabFormComplete' } ],
				Rail:
				[
					{ Widget: 'Terms', Group: 'LabFormsA', FacetKey: 'ToDo', Display: 'Checklist', Title: 'Form type', Collapse: 8 },
					{ Widget: 'Terms', Group: 'LabFormsA', FacetKey: 'Discipline', Display: 'Chips', Title: 'Discipline' },
					{ Widget: 'Terms', Group: 'LabFormsA', FacetKey: 'Queue', Display: 'Bars', Title: 'Queue' },
					{ Widget: 'Terms', Group: 'LabFormsA', FacetKey: 'Started', Display: 'Split', Title: 'Started / not started' }
				],
				Main:
				[
					{ Widget: 'Histogram', Group: 'LabFormsA', FacetKey: 'Week', Title: 'Intake received, by week' },
					{
						Widget: 'Records', Group: 'LabFormsA', Title: 'My work list',
						Columns:
						[
							{ Field: 'IDMaterialIntake', Label: 'Intake', Format: 'Key', Align: 'Right' },
							{ Field: 'IDMaterialIntake', Label: 'Material', Lookup: { Entity: 'MaterialIntake', Show: 'IDMaterialType', Then: { Entity: 'MaterialType', Show: 'Name' } } },
							{ Field: 'IDMaterialIntake', Label: 'Received', Format: 'Date', Lookup: { Entity: 'MaterialIntake', Show: 'ReceivedDate' } },
							{ Field: 'IDMaterialIntake', Label: 'Queue', Lookup: { Entity: 'MaterialIntake', Show: 'IDLabQueue', Then: { Entity: 'LabQueue', Show: 'Name' } } },
							{ Field: 'IDLabFormType', Label: 'Form type', Lookup: { Entity: 'LabFormType', Show: 'Name' } },
							{ Field: 'IDLabFormType', Label: 'Discipline', Blank: '(blank)', Lookup: { Entity: 'LabFormType', Show: 'Discipline' } },
							{
								Field: 'IDMaterialIntake', Label: 'Started',
								Lookup:
								{
									Entity: 'LabForm', Key: 'IDMaterialIntake', Many: true, Match: { IDLabFormType: 'IDLabFormType' },
									Exists: { Field: 'Status', NotNull: true, NotEqual: 'Complete' }, Yes: 'Started', No: 'Not started',
									Tip: 'Started: one of my lab forms for this intake and form type exists and is not Complete (the rule of the Started card).'
								}
							}
						]
					}
				]
			},
			B:
			{
				Top: [],
				Rail:
				[
					{ Widget: 'Terms', Group: 'LabFormsB', FacetKey: 'ToDo', Display: 'Bars', Title: 'Form type' },
					{ Widget: 'Terms', Group: 'LabFormsB', FacetKey: 'Queue', Display: 'Bars', Title: 'Queue' }
				],
				Main:
				[
					{ Widget: 'Compare', Group: 'LabFormsB', FacetKey: 'ToDo', Title: 'Variant A and variant B, form type by form type', CompareGroup: 'LabFormsA', CompareFacetKey: 'ToDo' },
					{ Widget: 'Histogram', Group: 'LabFormsB', FacetKey: 'Week', Title: 'Intake received, by week' }
				]
			}
		}
	},
	{
		Hash: 'Bookstore',
		Route: '/Bookstore',
		NavLabel: 'Bookstore explorer',
		Title: 'Bookstore explorer',
		Question: 'Which books are in the catalog: by genre, language, type and decade, and how did readers rate them?',
		Reference: { Text: 'Facets from Describe', Tip: 'The page asks GET /1.0/Facet/Describe what Book offers (auto facets for its columns, three declared Book ← Review facets, the Well reviewed scope) and builds its cards from the answer.' },
		Note: 'Every card below is built from GET /1.0/Facet/Describe.',
		Try: 'Turn on Well reviewed, then drag 2000–2019 on the year bars. Tick "(blank)" under Language: an empty string is a value you can select.',
		EmptyHint: 'Clear a filter: the catalog is the same for every user of a tenant.',
		Noun: { One: 'book', Many: 'books' },
		Groups: [ 'Books' ],
		Tabs: null,
		Layout:
		{
			Top:
			[
				{ Widget: 'Scope', Group: 'Books', Descriptions: { 'Book.WellReviewed': 'At least one review rated 4 or 5' } },
				{ Widget: 'Change', Group: 'Books', Action: 'ReviewAdd' }
			],
			Rail: [ { Widget: 'Described', Group: 'Books' } ],
			Main:
			[
				{ Widget: 'Described', Group: 'Books' },
				{
					Widget: 'Records', Group: 'Books', Title: 'Books',
					Columns:
					[
						{ Field: 'Title', Label: 'Title' },
						{ Field: 'Genre', Label: 'Genre' },
						{ Field: 'Language', Label: 'Language', Blank: '(blank)' },
						{ Field: 'Type', Label: 'Type' },
						{ Field: 'PublicationYear', Label: 'Year', Align: 'Right' },
						{ Field: 'IDBook', Label: 'ID', Align: 'Right', Muted: true }
					]
				}
			]
		}
	}
];

/**
 * The request specs and panels of a Describe-driven group (FacetsFrom: 'Describe') from the Describe entry of
 * its entity.  Rules (group.Describe): Order (these facets first), Skip ({ Facet: reason }), SkipAuditDates
 * (CreateDate / UpdateDate / DeleteDate), Overrides[Facet] ({ Key, Spec, Top, Display, Collapse, SortBy, Title }).
 * Folds -> widgets: Terms -> Terms (Chips, or Bars when multi-valued), ChildRollup -> Terms Bars, ExistsSplit ->
 * Terms Split, NumericHistogram / DateHistogram / Ranges -> Histogram (Main).  Anything else is skipped with a
 * reason.  Pure, so the smoke test derives the browser's exact body.
 *
 * @param {Record<string, any>} pGroup - GROUPS[*]
 * @param {Record<string, any>} pEntity - Describe Entities[<Entity>]
 * @return {{ Facets: Array<Record<string, any>>, Panels: Array<Record<string, any>>, Skipped: Array<{ Facet: string, Title: string, Reason: string }> }}
 */
const describedFacets = (pGroup, pEntity) =>
{
	let tmpRules = (pGroup && pGroup.Describe) ? pGroup.Describe : {};
	let tmpOrder = Array.isArray(tmpRules.Order) ? tmpRules.Order : [];
	let tmpSkip = tmpRules.Skip || {};
	let tmpOverrides = tmpRules.Overrides || {};
	let tmpDescribed = (pEntity && Array.isArray(pEntity.Facets)) ? pEntity.Facets.slice() : [];
	let fRank = (pFacet) => { let tmpIndex = tmpOrder.indexOf(pFacet.Facet); return (tmpIndex >= 0) ? tmpIndex : (tmpOrder.length + tmpDescribed.indexOf(pFacet)); };
	tmpDescribed.sort((pLeft, pRight) => { return fRank(pLeft) - fRank(pRight); });

	let tmpResult = { Facets: [], Panels: [], Skipped: [] };
	tmpDescribed.forEach(
		(pFacet) =>
		{
			if (!pFacet || (typeof(pFacet.Facet) !== 'string'))
			{
				return;
			}
			let tmpName = pFacet.Facet;
			let tmpTitle = pFacet.Title || pFacet.DisplayName || tmpName;
			if (Object.prototype.hasOwnProperty.call(tmpSkip, tmpName))
			{
				tmpResult.Skipped.push({ Facet: tmpName, Title: tmpTitle, Reason: String(tmpSkip[tmpName]) });
				return;
			}
			if (tmpRules.SkipAuditDates && (AUDIT_FIELDS.indexOf(pFacet.Field) >= 0))
			{
				tmpResult.Skipped.push({ Facet: tmpName, Title: tmpTitle, Reason: 'an audit timestamp' });
				return;
			}
			if (pFacet.Supported === false)
			{
				tmpResult.Skipped.push({ Facet: tmpName, Title: tmpTitle, Reason: 'not supported for this principal' });
				return;
			}
			let tmpOverride = tmpOverrides[tmpName] || {};
			let tmpKey = tmpOverride.Key || tmpName.split('.').pop();
			let tmpSpec = Object.assign({ Key: tmpKey, Facet: tmpName }, tmpOverride.Spec || {});
			if (typeof(tmpOverride.Top) === 'number')
			{
				tmpSpec.Top = tmpOverride.Top;
			}
			let tmpFold = tmpSpec.Fold || pFacet.DefaultFold;
			let tmpPanel = { Group: pGroup.Hash, FacetKey: tmpKey, Title: tmpOverride.Title || tmpTitle };
			switch (tmpFold)
			{
				case 'Terms':
					Object.assign(tmpPanel, { Region: 'Rail', Widget: 'Terms', Display: tmpOverride.Display || ((pFacet.MultiValued === true) ? 'Bars' : 'Chips') });
					break;
				case 'ChildRollup':
					Object.assign(tmpPanel, { Region: 'Rail', Widget: 'Terms', Display: tmpOverride.Display || 'Bars' });
					break;
				case 'ExistsSplit':
					Object.assign(tmpPanel, { Region: 'Rail', Widget: 'Terms', Display: tmpOverride.Display || 'Split' });
					break;
				case 'NumericHistogram':
				case 'DateHistogram':
				case 'Ranges':
					Object.assign(tmpPanel, { Region: 'Main', Widget: 'Histogram' });
					if ((tmpFold === 'DateHistogram') && Array.isArray(pFacet.Intervals))
					{
						tmpPanel.Intervals = pFacet.Intervals.slice();
					}
					break;
				default:
					tmpResult.Skipped.push({ Facet: tmpName, Title: tmpTitle, Reason: `no card for the ${tmpFold} fold here` });
					return;
			}
			[ 'Collapse', 'SortBy', 'KeyNoun' ].forEach((pOption) => { if (typeof(tmpOverride[pOption]) !== 'undefined') { tmpPanel[pOption] = tmpOverride[pOption]; } });
			tmpResult.Facets.push(tmpSpec);
			tmpResult.Panels.push(tmpPanel);
		});
	return tmpResult;
};

// Expected answers of the initial state per persona (DEMO-SPEC §3.3), measured on the Small seed after the
// renumbering: envelope Total (LabFormsB: the ToDo facet's Total; its envelope Total is not requested).
// Anonymous gets 401 FACET_UNAUTHENTICATED on every group.  The smoke test asserts this whole table.
const EXPECTED_INITIAL_TOTALS =
{
	user42: { Projects: 6, Documents: 41, LabFormsA: 237, LabFormsB: 224, Books: 1436 },
	user43: { Projects: 0, Documents: 41, LabFormsA: 172, LabFormsB: 157, Books: 1436 },
	user44: { Projects: 0, Documents: 41, LabFormsA: 0, LabFormsB: 0, Books: 1436 },
	user81: { Projects: 1, Documents: 9, LabFormsA: 60, LabFormsB: 34, Books: 81 }
};

module.exports = (
	{
		DefaultPage: 'Projects',
		Groups: GROUPS,
		Pages: PAGES,
		AUDIT_FIELDS: AUDIT_FIELDS,
		describedFacets: describedFacets,
		EXPECTED_INITIAL_TOTALS: EXPECTED_INITIAL_TOTALS
	});
