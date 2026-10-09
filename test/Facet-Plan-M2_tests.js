/**
 * Planning tests for Milestone 2 (Builder B): the Binder (internal-contracts §22), FilterAST and
 * the clause compiler (named scopes and join clauses, §23), the DisjunctivePlanner with definition
 * Wheres (§24.6), the lowering of every row of §24.8 into FoldIR (golden FoldIR for E1, E3A and
 * E3B), the conditional disjunctive scan plan (§25), the Records / Count / Keys base plan, DepSet
 * across hops and plan-wide unique aliases.
 *
 * No server, no database, no port: the real RetoldFacetingGraph and RetoldFacetingCatalog are built
 * from the ProjectTrack / LabTrack models (test/fixtures/*-Model.json) through a test host whose
 * scope policy is the domain's FACETING_OPTIONS policy; the services under test are the real ones.
 * The DefinitionRegistry is a test stub serving canonical forms (§20.7) HAND-WRITTEN here from the
 * fixture definitions files, so these tests pin the contract shapes the planner consumes without
 * depending on the registry builder; a cross-check suite compares the plans against the real
 * registry once it loads the fixture files with zero disabled entries (skipped until then).
 *
 * Expected FoldIR is written out by hand from the lowering rules of §24.8 (never produced by the
 * code under test and then copied back).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;
const libCrypto = require('crypto');

const libFable = require('fable');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../source/Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../source/contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../source/contract/Facet-Contract-Request.js');
const libFacetClauses = require('../source/contract/Facet-Contract-Clauses.js');
const libHostBase = require('../source/host/Retold-Faceting-Host-Base.js');
const libGraph = require('../source/catalog/Retold-Faceting-Graph.js');
const libCatalog = require('../source/catalog/Retold-Faceting-Catalog.js');
const libDefinitionRegistry = require('../source/catalog/Retold-Faceting-DefinitionRegistry.js');
const libFilterValidator = require('../source/request/Retold-Faceting-FilterValidator.js');
const libClauseCompiler = require('../source/request/Retold-Faceting-ClauseCompiler.js');
const libFilterAST = require('../source/request/Retold-Faceting-FilterAST.js');
const libDisjunctivePlanner = require('../source/request/Retold-Faceting-DisjunctivePlanner.js');
const libFoldIR = require('../source/plan/Retold-Faceting-FoldIR.js');
const libBinder = require('../source/plan/Retold-Faceting-Binder.js');
const libPlanner = require('../source/plan/Retold-Faceting-Planner.js');
const libLowering = require('../source/plan/Retold-Faceting-Lowering.js');

const libProjectTrackSeed = require('./fixtures/ProjectTrack-Seed.js');
const libLabTrackSeed = require('./fixtures/LabTrack-Seed.js');

// The pinned request clock every test binds $Now against (internal-contracts §31.3).
const TEST_NOW = '2026-10-08T12:00:00Z';
const TEST_NOW_CANONICAL = '2026-10-08 12:00:00';

const DOMAINS = { ProjectTrack: libProjectTrackSeed, LabTrack: libLabTrackSeed };

// ================================================================== Support: host, gate, registry

/**
 * A host over a model only (no DAL, no routes): what the catalog and the Binder read.
 */
class TestHost extends libHostBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'RetoldFacetingTestHost';
		this.Model = null;
	}

	getHostKind()
	{
		return 'Test';
	}

	getModelSync()
	{
		return this.Model;
	}

	listEntities()
	{
		return this.Model ? Object.keys(this.Model.Tables) : [];
	}

	isFacetable(pEntity)
	{
		return !!(this.Model && Object.prototype.hasOwnProperty.call(this.Model.Tables, pEntity));
	}

	getScopePolicy()
	{
		return this.buildScopePolicy(this.options.Scope, (pEntity, pColumn) => { return this.entityHasColumn(pEntity, pColumn); });
	}

	getPrimaryKey(pEntity)
	{
		let tmpTable = this.getEntityModel(pEntity);
		return tmpTable ? tmpTable.MeadowSchema.DefaultIdentifier : null;
	}

	getDeleteColumn(pEntity)
	{
		let tmpTable = this.getEntityModel(pEntity);
		let tmpEntry = tmpTable ? tmpTable.MeadowSchema.Schema.find((pSchema) => { return pSchema.Type === 'Deleted'; }) : null;
		return tmpEntry ? tmpEntry.Column : null;
	}

	getDialectProfile()
	{
		return { Name: 'SQLite', Provider: 'SQLite', Supported: true };
	}
}

/**
 * The per-entity gate (internal-contracts §19.6) with a deny list the tests control.
 */
class TestAuthorizer extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'RetoldFacetingAuthorizer';
		this.Denied = new Set();
		this.Calls = [];
	}

	canFacet(pContext, pEntity)
	{
		this.Calls.push(pEntity);
		return !this.Denied.has(pEntity) && !!this.fable.RetoldFacetingCatalog.getFacetable(pEntity);
	}
}

/**
 * A registry stub serving hand-written canonical forms (internal-contracts §20.7, §20.9 subset).
 */
class TestRegistry extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'RetoldFacetingDefinitionRegistry';
		this.Facets = new Map();
		this.Scopes = new Map();
		this.PathAuto = new Map();
	}

	facet(pFacetID)
	{
		return this.Facets.has(pFacetID) ? this.Facets.get(pFacetID) : null;
	}

	resolveFacet(pFacetID)
	{
		return this.facet(pFacetID) || (this.PathAuto.has(pFacetID) ? this.PathAuto.get(pFacetID) : null);
	}

	scope(pName)
	{
		return this.Scopes.has(pName) ? this.Scopes.get(pName) : null;
	}
}

// ================================================================== Support: canonical forms by hand

/**
 * A resolved PathPlan (internal-contracts §21.2), written independently of the code under test.
 * A step is a Raw string or { Step, Scope?, ScopeReason?, CheckParent?, Where? }.
 *
 * @param {any} pGraph
 * @param {string} pFrom
 * @param {Array<any>} pSteps
 * @return {Record<string, any>}
 */
const pathPlan = (pGraph, pFrom, pSteps) =>
{
	let tmpCurrent = pFrom;
	let tmpSteps = pSteps.map(
		(pStep, pIndex) =>
		{
			let tmpObject = (typeof(pStep) === 'string') ? { Step: pStep } : pStep;
			let tmpRaw = tmpObject.Step;
			let tmpEdge = pGraph.edge(tmpRaw.substring(1));
			if (!tmpEdge)
			{
				throw new Error(`test pathPlan: unknown edge ${tmpRaw}`);
			}
			let tmpStep = { Index: pIndex, Raw: tmpRaw, Edge: tmpEdge.Name, From: tmpCurrent, Via: null, Parent: null };
			switch (tmpRaw.charAt(0))
			{
				case '>':
					tmpStep.Direction = 'Forward';
					tmpStep.To = tmpEdge.To;
					tmpStep.On = [ [ tmpEdge.FromColumn, tmpEdge.ToColumn ] ];
					tmpStep.Cardinality = 'ToOne';
					break;
				case '<':
					tmpStep.Direction = 'Reverse';
					tmpStep.To = tmpEdge.From;
					tmpStep.On = [ [ tmpEdge.ToColumn, tmpEdge.FromColumn ] ];
					tmpStep.Cardinality = 'ToMany';
					break;
				default:
				{
					// '=E.c': the unique FK of the current entity into the same target.
					let tmpSource = pGraph.outgoing(tmpCurrent).filter((pCandidate) => { return pCandidate.To === tmpEdge.To; });
					if (tmpSource.length !== 1)
					{
						throw new Error(`test pathPlan: ambiguous co-reference ${tmpRaw}`);
					}
					tmpStep.Direction = 'CoReference';
					tmpStep.To = tmpEdge.From;
					tmpStep.On = [ [ tmpSource[0].FromColumn, tmpEdge.FromColumn ] ];
					tmpStep.Via = tmpSource[0].Name;
					tmpStep.Parent = tmpEdge.To;
					tmpStep.Cardinality = 'ToMany';
				}
			}
			tmpStep.CheckParent = (tmpObject.CheckParent === true);
			tmpStep.Where = tmpObject.Where || null;
			tmpStep.Scope = tmpObject.Scope || 'Inherit';
			tmpStep.ScopeReason = tmpObject.ScopeReason || null;
			tmpStep.Elide = false;
			tmpStep.As = null;
			tmpCurrent = tmpStep.To;
			return tmpStep;
		});
	return (
		{
			From: pFrom,
			To: tmpCurrent,
			Steps: tmpSteps,
			Hops: tmpSteps.length,
			ToOne: tmpSteps.every((pStep) => { return pStep.Direction === 'Forward'; }),
			Signature: tmpSteps.map((pStep) => { return pStep.Raw; }).join(' ')
		});
};

// Canonical leaves.
const lit = (pField, pOp, pValue) => { return (pValue === undefined) ? { Field: pField, Op: pOp } : { Field: pField, Op: pOp, Value: pValue }; };
const tok = (pField, pOp, pToken) => { return { Field: pField, Op: pOp, Bind: pToken }; };
const and = (...pItems) => { return { And: pItems }; };
const or = (...pItems) => { return { Or: pItems }; };
const existsC = (pPath, pWhere, pCorrelate, pFrom) => { return { Exists: { From: pFrom || null, Path: pPath, Where: pWhere || null, Correlate: pCorrelate || [] } }; };
const notExistsC = (pPath, pWhere, pCorrelate, pFrom) => { return { NotExists: { From: pFrom || null, Path: pPath, Where: pWhere || null, Correlate: pCorrelate || [] } }; };
const correlate = (pOuterAlias, pOuterField, pInner) => { return { Outer: { Alias: pOuterAlias, Field: pOuterField }, Inner: pInner }; };

const TENANT_ONLY_A = 'A form completed by any technician in my lab satisfies the requirement.';
const TENANT_ONLY_B = 'Any technician\'s completed form satisfies the requirement.';

/**
 * A canonical facet with defaults (internal-contracts §20.7).
 *
 * @param {Record<string, any>} pFields
 * @return {Record<string, any>}
 */
const canonicalFacet = (pFields) =>
{
	let tmpFacet = Object.assign(
		{
			Facet: null, Origin: 'Declared', SiblingOf: null, Entity: null, Version: 1, Title: null, Description: null, DisplayName: null,
			Pivot: null, Where: null, Dimensions: [], Fold: 'Terms', Folds: null, CountMode: 'Rows', Exclude: 'Self', FilterKey: null,
			Params: {}, Entities: [], Binds: [], Relaxed: false, Semantics: null, Supported: true, Unsupported: null,
			DefinitionHash: 'dh:test', FoldHash: 'fh:test', Source: '#test'
		}, pFields);
	if (!tmpFacet.Pivot)
	{
		tmpFacet.Pivot = { Kind: 'Entity', Entity: tmpFacet.Entity };
	}
	if (!tmpFacet.Folds)
	{
		tmpFacet.Folds = [ tmpFacet.Fold ];
	}
	return tmpFacet;
};

/**
 * A canonical dimension with defaults.
 *
 * @param {Record<string, any>} pFields
 * @return {Record<string, any>}
 */
const canonicalDim = (pFields) =>
{
	return Object.assign(
		{
			Kind: 'Terms', Field: null, Alias: null, Path: null, PathShape: null, KeyField: null, LabelLookup: null, Where: null, Correlate: null, Child: null,
			Edges: null, Labels: null, Top: null, Order: null, Missing: null, Interval: null, EmptyBuckets: null, Mode: null, Buckets: null, OpenEnded: null, Ranges: null
		}, pFields);
};

/**
 * The ProjectTrack canonical forms (hand-translated from test/fixtures/ProjectTrack-Definitions.json).
 *
 * @param {any} pGraph
 * @return {{ Scopes: Record<string, any>, Facets: Record<string, any>, PathAuto: Record<string, any> }}
 */
const projectTrackCanonical = (pGraph) =>
{
	let P = (pFrom, pSteps) => { return pathPlan(pGraph, pFrom, pSteps); };
	let tmpOverdueWhere = and(tok('AssignedIDUser', 'EQ', '$CurrentUser.IDUser'), tok('DueDate', 'LT', '$Now'), lit('Status', 'NE', 'Done'));
	let tmpScopes =
		{
			'Project.MyProjects':
				{
					Scope: 'Project.MyProjects', Entity: 'Project', Description: 'Projects where I hold one of the given roles, or that I own',
					Params: { Roles: { Type: 'EnumList', Values: [ 'Owner', 'Lead', 'Member', 'Reviewer' ], Default: [ 'Owner', 'Lead', 'Member' ] } },
					Where: or(
						existsC(P('Project', [ '<ProjectMembership.IDProject' ]), and(tok('IDUser', 'EQ', '$CurrentUser.IDUser'), tok('Role', 'IN', '$Param.Roles'), lit('Active', 'EQ', 1))),
						tok('OwnerIDUser', 'EQ', '$CurrentUser.IDUser')),
					Entities: [ 'Project', 'ProjectMembership' ], Binds: [ '$CurrentUser.IDUser', '$Param.Roles' ], Relaxed: false, Supported: true, Unsupported: null, DefinitionHash: 'dh:s1', Source: '#test'
				},
			'Project.HasMyOverdue':
				{
					Scope: 'Project.HasMyOverdue', Entity: 'Project', Params: {},
					Where: existsC(P('Project', [ '<Task.IDProject' ]), tmpOverdueWhere),
					Entities: [ 'Project', 'Task' ], Binds: [ '$CurrentUser.IDUser', '$Now' ], Relaxed: false, Supported: true, Unsupported: null, DefinitionHash: 'dh:s2', Source: '#test'
				},
			'Project.Unblocked':
				{
					Scope: 'Project.Unblocked', Entity: 'Project', Params: {},
					Where: notExistsC(P('Project', [ '<Issue.IDProject' ]), and(lit('Severity', 'EQ', 'Blocker'), lit('State', 'EQ', 'Open'))),
					Entities: [ 'Issue', 'Project' ], Binds: [], Relaxed: false, Supported: true, Unsupported: null, DefinitionHash: 'dh:s3', Source: '#test'
				},
			'Project.ManyOverdue':
				{
					Scope: 'Project.ManyOverdue', Entity: 'Project', Params: {},
					Where: { HavingCount: { From: null, Path: P('Project', [ '<Task.IDProject' ]), Where: and(tok('DueDate', 'LT', '$Now'), lit('Status', 'NE', 'Done')), Correlate: [], Op: 'GE', Value: 2 } },
					Entities: [ 'Project', 'Task' ], Binds: [ '$Now' ], Relaxed: false, Supported: true, Unsupported: null, DefinitionHash: 'dh:s4', Source: '#test'
				},
			'Document.InMyProjects':
				{
					Scope: 'Document.InMyProjects', Entity: 'Document', Params: {},
					Where: existsC(P('Document', [ '>Document.IDProject', '<ProjectMembership.IDProject' ]), and(tok('IDUser', 'EQ', '$CurrentUser.IDUser'), lit('Active', 'EQ', 1))),
					Entities: [ 'Document', 'Project', 'ProjectMembership' ], Binds: [ '$CurrentUser.IDUser' ], Relaxed: false, Supported: true, Unsupported: null, DefinitionHash: 'dh:s5', Source: '#test'
				}
		};
	let tmpFacets =
		{
			'Project.MyOverdueBand': canonicalFacet(
				{
					Facet: 'Project.MyOverdueBand', Entity: 'Project', Title: 'My overdue tasks per project', Fold: 'ChildRollup', Exclude: 'None', FilterKey: 'Project.MyOverdueBand',
					Dimensions: [ canonicalDim({ Kind: 'ChildRollup', Child: { Path: P('Project', [ '<Task.IDProject' ]), Agg: 'count', Field: null, Where: tmpOverdueWhere }, Edges: [ 1, 3, 10 ], DataType: 'Numeric', IsInteger: true, Scale: 0 }) ],
					Entities: [ 'Project', 'Task' ], Binds: [ '$CurrentUser.IDUser', '$Now' ], Semantics: 'NoVisibleMatch'
				}),
			'Project.ByMember': canonicalFacet(
				{
					Facet: 'Project.ByMember', Entity: 'Project', Title: 'Coverage K9: projects by active member (multi-valued)', Fold: 'Terms', CountMode: 'PivotDistinct', Exclude: 'Self', FilterKey: 'Project.ByMember',
					Dimensions: [ canonicalDim({ Kind: 'Terms', Path: P('Project', [ '<ProjectMembership.IDProject' ]), PathShape: 'ToMany', KeyField: 'IDUser', LabelLookup: { Entity: 'User', KeyColumn: 'IDUser', LabelColumn: 'NameFirst' }, Where: lit('Active', 'EQ', 1), Top: 25, DataType: 'Numeric', IsInteger: true, Scale: 0 }) ],
					Entities: [ 'Project', 'ProjectMembership' ]
				}),
			'Project.HasOpenIssues': canonicalFacet(
				{
					Facet: 'Project.HasOpenIssues', Entity: 'Project', Title: 'Coverage K20: projects with / without an open issue', Fold: 'ExistsSplit', Exclude: 'None', FilterKey: 'Project.HasOpenIssues',
					Dimensions: [ canonicalDim({ Kind: 'ExistsSplit', Path: P('Project', [ '<Issue.IDProject' ]), Where: lit('State', 'EQ', 'Open'), Correlate: [], Labels: { true: 'Has open issues', false: 'No open issues' }, DataType: 'Boolean', IsInteger: true, Scale: 0 }) ],
					Entities: [ 'Issue', 'Project' ], Semantics: 'NoVisibleMatch'
				}),
			'Document.ByClient': canonicalFacet(
				{
					Facet: 'Document.ByClient', Entity: 'Document', Title: 'Coverage K8 multi-hop: documents by their project\'s client', Fold: 'Terms', Exclude: 'Self', FilterKey: 'Document.ByClient',
					Dimensions: [ canonicalDim({ Kind: 'Terms', Path: P('Document', [ '>Document.IDProject', '>Project.IDClient' ]), PathShape: 'ToOne', Field: 'IDClient', LabelLookup: { Entity: 'Client', KeyColumn: 'IDClient', LabelColumn: 'Name' }, Top: 20, DataType: 'ID', IsInteger: true, Scale: 0 }) ],
					Entities: [ 'Client', 'Document', 'Project' ]
				})
		};
	// A synthesized PathAuto facet (internal-contracts §20.8): 'Task.IDProject>Project.Status'.
	let tmpPathAuto =
		{
			'Task.IDProject>Project.Status': canonicalFacet(
				{
					Facet: 'Task.IDProject>Project.Status', Origin: 'PathAuto', Entity: 'Task', Fold: 'Terms', Folds: [ 'Terms' ], Exclude: 'Self', FilterKey: 'Task.IDProject>Project.Status',
					Dimensions: [ canonicalDim({ Kind: 'Terms', Path: P('Task', [ '>Task.IDProject' ]), PathShape: 'ToOne', Field: 'Status', DataType: 'String', IsInteger: false, Scale: 0 }) ],
					Entities: [ 'Project', 'Task' ], DefinitionHash: null, FoldHash: 'fh:auto'
				}),
			'Task.IDProject>Project.StartDate': canonicalFacet(
				{
					Facet: 'Task.IDProject>Project.StartDate', Origin: 'PathAuto', Entity: 'Task', Fold: 'DateHistogram', Folds: [ 'DateHistogram' ], Exclude: 'Self', FilterKey: 'Task.IDProject>Project.StartDate',
					Dimensions: [ canonicalDim({ Kind: 'DateHistogram', Path: P('Task', [ '>Task.IDProject' ]), PathShape: 'ToOne', Field: 'StartDate', Interval: 'month', DataType: 'DateTime', IsInteger: false, Scale: 0 }) ],
					Entities: [ 'Project', 'Task' ], DefinitionHash: null, FoldHash: 'fh:auto'
				})
		};
	return { Scopes: tmpScopes, Facets: tmpFacets, PathAuto: tmpPathAuto };
};

/**
 * The LabTrack canonical forms (hand-translated from test/fixtures/LabTrack-Definitions.json).
 *
 * @param {any} pGraph
 * @return {{ Scopes: Record<string, any>, Facets: Record<string, any>, PathAuto: Record<string, any> }}
 */
const labTrackCanonical = (pGraph) =>
{
	let P = (pFrom, pSteps) => { return pathPlan(pGraph, pFrom, pSteps); };
	// MaterialIntake.InMyQueues (the alias @QueueMembers spliced).
	let tmpInMyQueues = and(
		existsC(P('MaterialIntake', [ '>MaterialIntake.IDLabQueue', '<LabQueueMember.IDLabQueue' ]), and(tok('IDUser', 'EQ', '$CurrentUser.IDUser'), lit('Active', 'EQ', 1))),
		lit('Status', 'IN', [ 'Received', 'InProgress' ]));
	// MaterialIntakeRequirement.ToDoForMe (the scope reference inlined; CheckParent not forced:
	// the sibling Exists visits the intake first, internal-contracts §21.4).
	let tmpToDoForMe = and(
		existsC(P('MaterialIntakeRequirement', [ '>MaterialIntakeRequirement.IDMaterialIntake' ]), tmpInMyQueues),
		notExistsC(P('MaterialIntakeRequirement', [ { Step: '=LabForm.IDMaterialIntake', Scope: 'TenantOnly', ScopeReason: TENANT_ONLY_A } ]),
			lit('Status', 'EQ', 'Complete'), [ correlate(null, 'IDLabFormType', 'IDLabFormType') ]));
	let tmpScopes =
		{
			'MaterialIntake.InMyQueues':
				{
					Scope: 'MaterialIntake.InMyQueues', Entity: 'MaterialIntake', Params: {}, Where: tmpInMyQueues,
					Entities: [ 'LabQueue', 'LabQueueMember', 'MaterialIntake' ], Binds: [ '$CurrentUser.IDUser' ], Relaxed: false, Supported: true, Unsupported: null, DefinitionHash: 'dh:l1', Source: '#test'
				},
			'MaterialIntakeRequirement.ToDoForMe':
				{
					Scope: 'MaterialIntakeRequirement.ToDoForMe', Entity: 'MaterialIntakeRequirement', Params: {}, Where: tmpToDoForMe,
					Entities: [ 'LabForm', 'LabQueue', 'LabQueueMember', 'MaterialIntake', 'MaterialIntakeRequirement' ], Binds: [ '$CurrentUser.IDUser' ], Relaxed: true, Supported: true, Unsupported: null, DefinitionHash: 'dh:l2', Source: '#test'
				}
		};
	let tmpMyFormsBase =
		{
			Entity: 'MaterialIntakeRequirement', Pivot: { Kind: 'Entity', Entity: 'MaterialIntakeRequirement' }, Where: tmpToDoForMe, Exclude: 'Self', Relaxed: true, Semantics: 'NoVisibleMatch',
			Entities: [ 'LabForm', 'LabQueue', 'LabQueueMember', 'MaterialIntake', 'MaterialIntakeRequirement' ], Binds: [ '$CurrentUser.IDUser' ]
		};
	let tmpFormsToDoPivot =
		{
			Kind: 'Tuple',
			Sides: [ { Name: 'i', Entity: 'MaterialIntake', Where: tmpInMyQueues }, { Name: 'r', Entity: 'MaterialTypeFormRequirement', Where: lit('Required', 'EQ', 1) } ],
			On: [ { Left: { Name: 'i', Field: 'IDMaterialType' }, Right: { Name: 'r', Field: 'IDMaterialType' } } ],
			Key: [ { Name: 'i', Field: 'IDMaterialIntake' }, { Name: 'r', Field: 'IDLabFormType' } ],
			Home: 'i'
		};
	let tmpFormsToDoWhere = notExistsC(P('MaterialIntake', [ { Step: '<LabForm.IDMaterialIntake', Scope: 'TenantOnly', ScopeReason: TENANT_ONLY_B } ]),
		lit('Status', 'EQ', 'Complete'), [ correlate('r', 'IDLabFormType', 'IDLabFormType') ], 'i');
	let tmpFormsToDoBase =
		{
			Entity: 'MaterialIntake', Pivot: tmpFormsToDoPivot, Where: tmpFormsToDoWhere, CountMode: 'KeyDistinct', Exclude: 'None', Relaxed: true, Semantics: 'NoVisibleMatch',
			Entities: [ 'LabForm', 'LabQueue', 'LabQueueMember', 'MaterialIntake', 'MaterialTypeFormRequirement' ], Binds: [ '$CurrentUser.IDUser' ]
		};
	let tmpFacets =
		{
			'MaterialIntakeRequirement.MyFormsToDo': canonicalFacet(Object.assign({}, tmpMyFormsBase,
				{
					Facet: 'MaterialIntakeRequirement.MyFormsToDo', Title: 'Lab forms I still need to complete', FilterKey: 'IDLabFormType',
					Dimensions: [ canonicalDim({ Kind: 'Terms', Field: 'IDLabFormType', LabelLookup: { Entity: 'LabFormType', KeyColumn: 'IDLabFormType', LabelColumn: 'Name' }, DataType: 'Numeric', IsInteger: true, Scale: 0 }) ]
				})),
			'MaterialIntakeRequirement.MyFormsToDo/ByQueue': canonicalFacet(Object.assign({}, tmpMyFormsBase,
				{
					Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue', Origin: 'Sibling', SiblingOf: 'MaterialIntakeRequirement.MyFormsToDo', FilterKey: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue',
					Dimensions: [ canonicalDim({ Kind: 'Terms', Path: P('MaterialIntakeRequirement', [ '>MaterialIntakeRequirement.IDMaterialIntake', '>MaterialIntake.IDLabQueue' ]), PathShape: 'ToOne', Field: 'IDLabQueue', LabelLookup: { Entity: 'LabQueue', KeyColumn: 'IDLabQueue', LabelColumn: 'Name' }, DataType: 'ID', IsInteger: true, Scale: 0 }) ]
				})),
			'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline': canonicalFacet(Object.assign({}, tmpMyFormsBase,
				{
					Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline', Origin: 'Sibling', SiblingOf: 'MaterialIntakeRequirement.MyFormsToDo', FilterKey: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline',
					Dimensions: [ canonicalDim({ Kind: 'Terms', Path: P('MaterialIntakeRequirement', [ '>MaterialIntakeRequirement.IDLabFormType' ]), PathShape: 'ToOne', Field: 'Discipline', DataType: 'String', IsInteger: false, Scale: 0 }) ]
				})),
			'MaterialIntakeRequirement.MyFormsToDo/ByWeek': canonicalFacet(Object.assign({}, tmpMyFormsBase,
				{
					Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek', Origin: 'Sibling', SiblingOf: 'MaterialIntakeRequirement.MyFormsToDo', Fold: 'DateHistogram', FilterKey: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek',
					Dimensions: [ canonicalDim({ Kind: 'DateHistogram', Path: P('MaterialIntakeRequirement', [ '>MaterialIntakeRequirement.IDMaterialIntake' ]), PathShape: 'ToOne', Field: 'ReceivedDate', Interval: 'week', DataType: 'DateTime', IsInteger: false, Scale: 0 }) ]
				})),
			'MaterialIntakeRequirement.MyFormsToDo/Started': canonicalFacet(Object.assign({}, tmpMyFormsBase,
				{
					Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started', Origin: 'Sibling', SiblingOf: 'MaterialIntakeRequirement.MyFormsToDo', Fold: 'ExistsSplit', Exclude: 'None', FilterKey: 'MaterialIntakeRequirement.MyFormsToDo/Started',
					Dimensions: [ canonicalDim({ Kind: 'ExistsSplit', Path: P('MaterialIntakeRequirement', [ '=LabForm.IDMaterialIntake' ]), Correlate: [ correlate(null, 'IDLabFormType', 'IDLabFormType') ], Where: lit('Status', 'NE', 'Complete'), Labels: { true: 'Started', false: 'Not started' }, DataType: 'Boolean', IsInteger: true, Scale: 0 }) ]
				})),
			'MaterialIntake.FormsToDo': canonicalFacet(Object.assign({}, tmpFormsToDoBase,
				{
					Facet: 'MaterialIntake.FormsToDo', Title: 'Lab forms I still need to complete (implied by material type)', FilterKey: 'MaterialIntake.FormsToDo',
					Dimensions: [ canonicalDim({ Kind: 'Terms', Field: 'IDLabFormType', Alias: 'r', LabelLookup: { Entity: 'LabFormType', KeyColumn: 'IDLabFormType', LabelColumn: 'Name' }, DataType: 'Numeric', IsInteger: true, Scale: 0 }) ]
				})),
			'MaterialIntake.FormsToDo/ByQueue': canonicalFacet(Object.assign({}, tmpFormsToDoBase,
				{
					Facet: 'MaterialIntake.FormsToDo/ByQueue', Origin: 'Sibling', SiblingOf: 'MaterialIntake.FormsToDo', FilterKey: 'MaterialIntake.FormsToDo/ByQueue',
					Dimensions: [ canonicalDim({ Kind: 'Terms', Field: 'IDLabQueue', Alias: 'i', LabelLookup: { Entity: 'LabQueue', KeyColumn: 'IDLabQueue', LabelColumn: 'Name' }, DataType: 'Numeric', IsInteger: true, Scale: 0 }) ]
				})),
			'MaterialIntake.FormsToDo/ByWeek': canonicalFacet(Object.assign({}, tmpFormsToDoBase,
				{
					Facet: 'MaterialIntake.FormsToDo/ByWeek', Origin: 'Sibling', SiblingOf: 'MaterialIntake.FormsToDo', Fold: 'DateHistogram', FilterKey: 'MaterialIntake.FormsToDo/ByWeek',
					Dimensions: [ canonicalDim({ Kind: 'DateHistogram', Field: 'ReceivedDate', Alias: 'i', Interval: 'week', DataType: 'DateTime', IsInteger: false, Scale: 0 }) ]
				})),
			'MaterialIntake.ByRequiredForm': canonicalFacet(
				{
					Facet: 'MaterialIntake.ByRequiredForm', Entity: 'MaterialIntake', Fold: 'Terms', CountMode: 'PivotDistinct', Exclude: 'Self', FilterKey: 'MaterialIntake.ByRequiredForm',
					Dimensions: [ canonicalDim({ Kind: 'Terms', Path: P('MaterialIntake', [ '<MaterialIntakeRequirement.IDMaterialIntake', '>MaterialIntakeRequirement.IDLabFormType' ]), PathShape: 'ToMany', KeyField: 'IDLabFormType', LabelLookup: { Entity: 'LabFormType', KeyColumn: 'IDLabFormType', LabelColumn: 'Name' }, Top: 25, DataType: 'ID', IsInteger: true, Scale: 0 }) ],
					Entities: [ 'LabFormType', 'MaterialIntake', 'MaterialIntakeRequirement' ]
				})
		};
	return { Scopes: tmpScopes, Facets: tmpFacets, PathAuto: {} };
};

const CANONICAL = { ProjectTrack: projectTrackCanonical, LabTrack: labTrackCanonical };

// ================================================================== Support: environments and contexts

/**
 * A fable with the real graph, catalog and request / plan services over a domain model, a test
 * host, a gate and (by default) the canonical-form registry stub.
 *
 * @param {string} pDomain - 'ProjectTrack' | 'LabTrack'
 * @param {{ Faceting?: Record<string, any>, Registry?: 'Stub' | 'Real' | false }} [pOptions]
 * @return {Record<string, any>}
 */
const newEnvironment = (pDomain, pOptions) =>
{
	let tmpOptions = pOptions || {};
	let tmpSeed = DOMAINS[pDomain];
	let tmpFacetingOptions = libOptions.resolve(libOptions.deepMerge(libOptions.deepMerge(tmpSeed.FACETING_OPTIONS, { Definitions: { Path: false, Files: [] } }), tmpOptions.Faceting || {}));
	let tmpFable = new libFable({ Product: 'RetoldFacetingPlanM2Tests', LogStreams: [ { streamtype: 'console', level: 'fatal' } ] });
	let tmpModel = tmpSeed.model();
	let fRegister = (pType, pClass) =>
	{
		tmpFable.addServiceType(pType, pClass);
		return tmpFable.instantiateServiceProvider(pType, tmpFacetingOptions);
	};
	let tmpHost = fRegister('RetoldFacetingTestHost', TestHost);
	tmpHost.Model = tmpModel;
	fRegister('RetoldFacetingGraph', libGraph);
	fRegister('RetoldFacetingCatalog', libCatalog);
	let tmpRegistry = null;
	if (tmpOptions.Registry === 'Real')
	{
		tmpRegistry = fRegister('RetoldFacetingDefinitionRegistry', libDefinitionRegistry);
	}
	else if (tmpOptions.Registry !== false)
	{
		tmpRegistry = fRegister('RetoldFacetingDefinitionRegistry', TestRegistry);
	}
	fRegister('RetoldFacetingFilterValidator', libFilterValidator);
	fRegister('RetoldFacetingClauseCompiler', libClauseCompiler);
	fRegister('RetoldFacetingFilterAST', libFilterAST);
	fRegister('RetoldFacetingDisjunctivePlanner', libDisjunctivePlanner);
	fRegister('RetoldFacetingFoldIR', libFoldIR);
	fRegister('RetoldFacetingBinder', libBinder);
	fRegister('RetoldFacetingPlanner', libPlanner);
	let tmpAuthorizer = fRegister('RetoldFacetingAuthorizer', TestAuthorizer);
	tmpFable.RetoldFacetingGraph.rebuild(tmpModel);
	tmpFable.RetoldFacetingCatalog.rebuild(tmpModel, tmpHost);
	if (tmpRegistry && (tmpOptions.Registry !== 'Real'))
	{
		let tmpCanonical = CANONICAL[pDomain](tmpFable.RetoldFacetingGraph);
		Object.keys(tmpCanonical.Scopes).forEach((pName) => { tmpRegistry.Scopes.set(pName, tmpCanonical.Scopes[pName]); });
		Object.keys(tmpCanonical.Facets).forEach((pName) => { tmpRegistry.Facets.set(pName, tmpCanonical.Facets[pName]); });
		Object.keys(tmpCanonical.PathAuto).forEach((pName) => { tmpRegistry.PathAuto.set(pName, tmpCanonical.PathAuto[pName]); });
	}
	return (
		{
			Domain: pDomain,
			fable: tmpFable,
			options: tmpFacetingOptions,
			host: tmpHost,
			graph: tmpFable.RetoldFacetingGraph,
			catalog: tmpFable.RetoldFacetingCatalog,
			registry: tmpRegistry,
			authorizer: tmpAuthorizer,
			ast: tmpFable.RetoldFacetingFilterAST,
			compiler: tmpFable.RetoldFacetingClauseCompiler,
			disjunctive: tmpFable.RetoldFacetingDisjunctivePlanner,
			foldIR: tmpFable.RetoldFacetingFoldIR,
			binder: tmpFable.RetoldFacetingBinder,
			planner: tmpFable.RetoldFacetingPlanner
		});
};

/**
 * A request context (internal-contracts §2.2 / §19.5) for a principal, with the Bind stage and the
 * FilterAST already run (the wiring's stages, done here by hand).
 *
 * @param {Record<string, any>} pEnv
 * @param {string} pEntity
 * @param {{ Tenant: number, User: number }|null} pWho
 * @param {Record<string, any>} pBody - request body (Facets / Clauses / FilterString / Scopes / Params / Total / Records)
 * @param {{ Now?: string, PlanForm?: Record<string, any>, NoFilter?: boolean, Session?: Record<string, any> }} [pInternal]
 * @return {Record<string, any>}
 */
const newContext = (pEnv, pEntity, pWho, pBody, pInternal) =>
{
	let tmpInternal = pInternal || {};
	let tmpSession = tmpInternal.Session || (pWho ? { LoggedIn: true, UserID: pWho.User, IDUser: pWho.User, CustomerID: pWho.Tenant, IDTenant: pWho.Tenant } : {});
	let tmpBody = pBody || {};
	let tmpWarnings = [];
	let tmpFacets = (Array.isArray(tmpBody.Facets) ? tmpBody.Facets : []).map((pSpec, pIndex) => { return libFacetRequest.normalizeFacetSpec(pSpec, pIndex, pEnv.options, tmpWarnings); });
	let tmpContext =
		{
			RequestID: 'rfq-test',
			Entity: pEntity,
			Request: { params: {}, headers: {}, query: {}, UserSession: tmpSession },
			Host: pEnv.host,
			Options: pEnv.options,
			Principal: pEnv.host.buildPrincipal(tmpSession, null, 'InProcess'),
			NormalizedRequest:
				{
					Entity: pEntity,
					Clauses: Array.isArray(tmpBody.Clauses) ? tmpBody.Clauses : [],
					FilterString: (typeof(tmpBody.FilterString) === 'string') ? tmpBody.FilterString : null,
					Facets: tmpFacets,
					Total: (tmpBody.Total !== false),
					Scopes: Array.isArray(tmpBody.Scopes) ? tmpBody.Scopes : [],
					Params: tmpBody.Params || {},
					Records: tmpBody.Records || null,
					Warnings: tmpWarnings
				},
			FilterAST: null,
			Variants: null,
			Dialect: 'SQLite',
			Now: tmpInternal.Now || TEST_NOW,
			Deadline: Date.now() + 10000,
			ForceEngine: null,
			PlanForm: Object.assign({ Cube: 'Auto', Staged: 'Auto' }, tmpInternal.PlanForm || {}),
			Bind: null,
			Mode: 'Query',
			Memo: { Relations: {}, Captures: {}, VariantRows: {} },
			Counters: { Relations: 0, BehaviorRuns: 0, Statements: 0 },
			Warnings: []
		};
	tmpContext.Bind = pEnv.binder.context(tmpContext);
	if (!tmpInternal.NoFilter)
	{
		tmpContext.FilterAST = pEnv.ast.build(pEntity,
			{
				Clauses: tmpContext.NormalizedRequest.Clauses,
				FilterString: tmpContext.NormalizedRequest.FilterString,
				Scopes: tmpContext.NormalizedRequest.Scopes,
				Bind: tmpContext.Bind,
				CanFacet: (pTarget) => { return pEnv.authorizer.canFacet(tmpContext, pTarget); }
			});
	}
	return tmpContext;
};

/**
 * Run Planner.plan synchronously (it calls back synchronously).
 *
 * @param {Record<string, any>} pEnv
 * @param {Record<string, any>} pContext
 * @return {{ Error: any, Plan: any }}
 */
const runPlan = (pEnv, pContext) =>
{
	let tmpResult = null;
	pEnv.planner.plan(pContext, (pError, pPlan) => { tmpResult = { Error: pError || null, Plan: pPlan || null }; });
	if (!tmpResult)
	{
		throw new Error('Planner.plan did not call back synchronously.');
	}
	return tmpResult;
};

/**
 * Plan and expect success.
 *
 * @return {Record<string, any>}
 */
const plan = (pEnv, pContext) =>
{
	let tmpResult = runPlan(pEnv, pContext);
	if (tmpResult.Error)
	{
		throw tmpResult.Error;
	}
	return tmpResult.Plan;
};

/**
 * The FacetError a function throws (fails the test when it does not throw one).
 *
 * @param {Function} fCall
 * @return {any}
 */
const facetError = (fCall) =>
{
	try
	{
		fCall();
	}
	catch (pError)
	{
		Expect(libFacetErrors.isFacetError(pError), `expected a FacetError, got ${pError && pError.message}`).to.equal(true);
		return pError;
	}
	throw new Error('Expected a FacetError, nothing was thrown.');
};

const aggByKey = (pPlan, pKey) =>
{
	let tmpAgg = pPlan.Aggs.find((pCandidate) => { return pCandidate.Key === pKey; });
	if (!tmpAgg)
	{
		throw new Error(`no Agg ${pKey}`);
	}
	return tmpAgg;
};

// ================================================================== Support: expected FoldIR builders

const wh = (pWhere) => { return (pWhere === null) ? '' : 'wh:' + libCrypto.createHash('sha1').update(libFacetClauses.canonicalJSON(pWhere)).digest('hex').substring(0, 12); };

/**
 * An expected Rel (every field of internal-contracts §24.1).
 */
const xRel = (pEntity, pAs, pRole, pProject, pWhere, pExtra) =>
{
	let tmpExtra = pExtra || {};
	return (
		{
			Entity: pEntity,
			As: pAs,
			Role: pRole,
			Project: pProject,
			Client: hasOwnKey(tmpExtra, 'Client') ? tmpExtra.Client : null,
			Where: pWhere || null,
			WhereHash: wh(pWhere || null),
			Scope: tmpExtra.Scope || 'Inherit',
			ScopeReason: tmpExtra.ScopeReason || null,
			SoftDelete: 'Explicit',
			Stage: tmpExtra.Stage || 'Never'
		});
};
const hasOwnKey = (pObject, pKey) => { return Object.prototype.hasOwnProperty.call(pObject, pKey); };
const xOn = (pAlias, pField, pInner) => { return { Outer: { Alias: pAlias, Field: pField }, Inner: pInner }; };
const xExists = (pRel, pOn, pWhere) => { return { Node: 'Exists', Rel: pRel, On: pOn, Where: pWhere || null }; };
const xNotExists = (pRel, pOn, pWhere) => { return { Node: 'NotExists', Rel: pRel, On: pOn, Where: pWhere || null }; };
const xAnd = (...pItems) => { return { Node: 'And', Items: pItems }; };
const xOr = (...pItems) => { return { Node: 'Or', Items: pItems }; };
const xCmp = (pAlias, pField, pOp, pValue) => { return (pValue === undefined) ? { Node: 'Cmp', Alias: pAlias, Field: pField, Op: pOp } : { Node: 'Cmp', Alias: pAlias, Field: pField, Op: pOp, Value: pValue }; };

/**
 * A JSON round trip (drops undefined, compares structure only).
 */
const plain = (pValue) => { return JSON.parse(JSON.stringify(pValue)); };

// ================================================================== Suites

suite
(
	'Facet-Plan-M2',
	() =>
	{
		suite
		(
			'Binder (internal-contracts §22)',
			() =>
			{
				let _Env = null;
				suiteSetup(() => { _Env = newEnvironment('LabTrack'); });

				let fContext = (pWho, pInternal) => { return newContext(_Env, 'LabForm', pWho, { Facets: [] }, Object.assign({ NoFilter: true }, pInternal || {})); };

				test('TOKEN_PATTERN / parseToken accept exactly the §22.2 grammar',
					() =>
					{
						[ '$CurrentUser.IDUser', '$CurrentUser.IDCustomer', '$CurrentUser.Department', '$Scope.IDCustomer', '$Now', '$Today',
							'$StartOf.day', '$StartOf.week', '$StartOf.month', '$StartOf.quarter', '$StartOf.year', '$Param.Roles' ].forEach(
							(pToken) =>
							{
								Expect(libBinder.TOKEN_PATTERN.test(pToken), pToken).to.equal(true);
								Expect(libBinder.parseToken(pToken), pToken).to.not.equal(null);
							});
						[ '$Now.x', '$Today.day', '$StartOf.decade', '$CurrentUser', '$Param.', '$Param.1x', 'Now', '$Bogus.X', '$CurrentUser.IDUser ', ' $Now', '$param.Roles' ].forEach(
							(pToken) =>
							{
								Expect(libBinder.parseToken(pToken), pToken).to.equal(null);
							});
						Expect(libBinder.PARAM_TYPES).to.deep.equal([ 'Enum', 'EnumList', 'Integer', 'IntegerList', 'String', 'Boolean', 'DateTime' ]);
					});

				test('context(): CurrentUser and Scope come from the Principal only; Now is floored to Cache.NowBucketMS',
					() =>
					{
						let tmpContext = fContext({ Tenant: 1, User: 42 }, { Now: '2026-10-08T15:02:41.120Z' });
						// A request body can never reach the BindContext.
						tmpContext.NormalizedRequest.Params = { IDUser: 99 };
						let tmpBind = _Env.binder.context(tmpContext);
						Expect(tmpBind.CurrentUser.IDUser).to.equal(42);
						Expect(tmpBind.CurrentUser.IDCustomer).to.equal(1);
						Expect(tmpBind.Scope).to.deep.equal({ IDCustomer: 1, OwnerIDUser: 42 });
						Expect(tmpBind.Now).to.equal('2026-10-08 15:02:00');
						Expect(tmpBind.Today).to.equal('2026-10-08 00:00:00');
						Expect(tmpBind.StartOf).to.deep.equal(
							{
								day: '2026-10-08 00:00:00', week: '2026-10-05 00:00:00', month: '2026-10-01 00:00:00',
								quarter: '2026-10-01 00:00:00', year: '2026-01-01 00:00:00'
							});
						Expect(tmpBind.NowBucketMS).to.equal(60000);
						Expect(tmpBind.Used instanceof Map).to.equal(true);
						Expect(tmpBind.Used.size).to.equal(0);
						// a coarser bucket floors further; pinning the clock pins every $-date
						let tmpHour = newEnvironment('LabTrack', { Faceting: { Cache: { NowBucketMS: 3600000 } } });
						let tmpHourContext = newContext(tmpHour, 'LabForm', { Tenant: 1, User: 42 }, { Facets: [] }, { NoFilter: true, Now: '2026-10-08T15:59:59.999Z' });
						Expect(tmpHour.binder.context(tmpHourContext).Now).to.equal('2026-10-08 15:00:00');
						Expect(_Env.binder.context(fContext({ Tenant: 1, User: 42 }, { Now: TEST_NOW })).Now).to.equal(TEST_NOW_CANONICAL);
						// no clock is a wiring bug
						let tmpNoClock = fContext({ Tenant: 1, User: 42 });
						tmpNoClock.Now = null;
						Expect(facetError(() => { _Env.binder.context(tmpNoClock); }).Code).to.equal('FACET_INTERNAL');
					});

				test('context(): $Now / $Today / $StartOf are the naive wall clock of Time.StorageTimeZone (D-22), not UTC',
					() =>
					{
						let tmpChicago = newEnvironment('LabTrack', { Faceting: { Time: { StorageTimeZone: 'America/Chicago' } } });
						// 03:30 UTC on Oct 8 is 22:30 on Oct 7 in Chicago (CDT, UTC-5): 'today' has not turned over yet.
						let tmpBind = tmpChicago.binder.context(newContext(tmpChicago, 'LabForm', { Tenant: 1, User: 42 }, { Facets: [] }, { NoFilter: true, Now: '2026-10-08T03:30:41Z' }));
						Expect(tmpBind.Now).to.equal('2026-10-07 22:30:00');
						Expect(tmpBind.Today).to.equal('2026-10-07 00:00:00');
						Expect(tmpBind.StartOf.month).to.equal('2026-10-01 00:00:00');
						// Standard time (CST, UTC-6) in January.
						Expect(tmpChicago.binder.context(newContext(tmpChicago, 'LabForm', { Tenant: 1, User: 42 }, { Facets: [] }, { NoFilter: true, Now: '2026-01-01T03:00:00Z' })).StartOf.year).to.equal('2025-01-01 00:00:00');
						Expect(libBinder.wallClockIn(Date.parse('2026-01-01T03:00:00Z'), 'America/Chicago')).to.equal('2025-12-31 21:00:00');
						Expect(libBinder.wallClockIn(Date.parse('2026-01-01T03:00:00Z'), 'UTC')).to.equal('2026-01-01 03:00:00');
						// An unknown zone is a configuration error, never a silent UTC.
						let tmpBogus = newEnvironment('LabTrack', { Faceting: { Time: { StorageTimeZone: 'Mars/Olympus' } } });
						Expect(facetError(() => { tmpBogus.binder.context(newContext(tmpBogus, 'LabForm', { Tenant: 1, User: 42 }, { Facets: [] }, { NoFilter: true, Now: TEST_NOW })); }).Code).to.equal('FACET_INTERNAL');
					});

				test('Integer params accept only safe integers (1e300 / 2^64 are a 400, never a database error)',
					() =>
					{
						let tmpSchema = { N: { Type: 'Integer' }, L: { Type: 'IntegerList' } };
						Expect(_Env.binder.validateParams(tmpSchema, { N: '42', L: [ 1, '2' ] }, { Scope: 'X' })).to.deep.equal({ N: 42, L: [ 1, 2 ] });
						[ { N: 1e300 }, { N: '99999999999999999999' }, { N: 2 ** 60 }, { N: 1.5 }, { L: [ 1, 1e300 ] } ].forEach(
							(pValues) =>
							{
								let tmpError = facetError(() => { _Env.binder.validateParams(tmpSchema, Object.assign({ N: 1, L: [ 1 ] }, pValues), { Scope: 'X' }); });
								Expect(tmpError, JSON.stringify(pValues)).to.include({ Code: 'FACET_PARAM_INVALID', Status: 400 });
								Expect(tmpError.Detail.Reason).to.equal('Type');
							});
					});

				test('bind(): every token kind binds, coerced by the column DataType, and is recorded in Used',
					() =>
					{
						let tmpBind = _Env.binder.context(fContext({ Tenant: 3, User: 42 }));
						let tmpPred = and(
							tok('OwnerIDUser', 'EQ', '$CurrentUser.IDUser'),
							tok('IDCustomer', 'EQ', '$Scope.IDCustomer'),
							tok('CompletedDate', 'LT', '$Now'),
							tok('CompletedDate', 'GE', '$StartOf.month'),
							tok('CompletedDate', 'GE', '$Today'),
							tok('Status', 'IN', '$Param.States'),
							tok('IDLabFormType', 'EQ', '$Param.FormType'),
							lit('Status', 'NE', 'Void'));
						let tmpBound = _Env.binder.bind(tmpPred, tmpBind, { States: [ 'Complete', 'Pending' ], FormType: '7' }, { Entity: 'LabForm', Owner: 'LabForm.Mine', OwnerKind: 'Scope' });
						Expect(tmpBound).to.deep.equal(and(
							lit('OwnerIDUser', 'EQ', 42),
							lit('IDCustomer', 'EQ', 3),
							lit('CompletedDate', 'LT', TEST_NOW_CANONICAL),
							lit('CompletedDate', 'GE', '2026-10-01 00:00:00'),
							lit('CompletedDate', 'GE', '2026-10-08 00:00:00'),
							lit('Status', 'IN', [ 'Complete', 'Pending' ]),
							lit('IDLabFormType', 'EQ', 7),
							lit('Status', 'NE', 'Void')));
						// the canonical tree is never mutated
						Expect(tmpPred.And[0]).to.deep.equal(tok('OwnerIDUser', 'EQ', '$CurrentUser.IDUser'));
						Expect(Array.from(tmpBind.Used.keys()).sort()).to.deep.equal(
							[ '$CurrentUser.IDUser', '$Now', '$Param:LabForm.Mine.FormType', '$Param:LabForm.Mine.States', '$Scope.IDCustomer', '$StartOf.month', '$Today' ]);
						Expect(tmpBind.Used.get('$Param:LabForm.Mine.States')).to.deep.equal([ 'Complete', 'Pending' ]);
						// an Enum under IN is a one-element list; a scalar is never bound under IN as a scalar
						let tmpEnum = _Env.binder.bind(tok('Status', 'IN', '$Param.State'), tmpBind, { State: 'Complete' }, { Entity: 'LabForm', Owner: 'X' });
						Expect(tmpEnum).to.deep.equal(lit('Status', 'IN', [ 'Complete' ]));
					});

				test('bind(): step Wheres and existence Wheres are bound on their own entities; HavingCount and Correlate pass through',
					() =>
					{
						let tmpBind = _Env.binder.context(fContext({ Tenant: 1, User: 5 }));
						let tmpPath = pathPlan(_Env.graph, 'MaterialIntake', [ { Step: '>MaterialIntake.IDLabQueue', Where: tok('Name', 'NE', '$Param.Queue') }, '<LabQueueMember.IDLabQueue' ]);
						let tmpPred = and(
							existsC(tmpPath, and(tok('IDUser', 'EQ', '$CurrentUser.IDUser'), lit('Active', 'EQ', 1)), [ correlate(null, 'IDCustomer', 'IDCustomer') ]),
							{ HavingCount: { From: null, Path: pathPlan(_Env.graph, 'MaterialIntake', [ '<LabForm.IDMaterialIntake' ]), Where: tok('CompletedDate', 'LT', '$Now'), Correlate: [], Op: 'GE', Value: 2 } });
						let tmpBound = _Env.binder.bind(tmpPred, tmpBind, { Queue: 'Closed' }, { Entity: 'MaterialIntake', Owner: 'S' });
						Expect(tmpBound.And[0].Exists.Path.Steps[0].Where).to.deep.equal(lit('Name', 'NE', 'Closed'));
						Expect(tmpBound.And[0].Exists.Path.Steps[1].Where).to.equal(null);
						Expect(tmpBound.And[0].Exists.Where).to.deep.equal(and(lit('IDUser', 'EQ', 5), lit('Active', 'EQ', 1)));
						Expect(tmpBound.And[0].Exists.Correlate).to.deep.equal([ correlate(null, 'IDCustomer', 'IDCustomer') ]);
						Expect(tmpBound.And[1].HavingCount.Where).to.deep.equal(lit('CompletedDate', 'LT', TEST_NOW_CANONICAL));
						Expect(tmpBound.And[1].HavingCount.Value).to.equal(2);
						// the PathPlan objects of the canonical tree are untouched
						Expect(tmpPath.Steps[0].Where).to.deep.equal(tok('Name', 'NE', '$Param.Queue'));
						Expect(_Env.binder.tokensOf(tmpPred)).to.deep.equal([ '$CurrentUser.IDUser', '$Now', '$Param.Queue' ]);
					});

				test('bind(): TuplePivot side leaves ("alias.Field" / Alias) coerce on the side entity',
					() =>
					{
						let tmpBind = _Env.binder.context(fContext({ Tenant: 1, User: 5 }));
						let tmpSides = { i: 'MaterialIntake', r: 'MaterialTypeFormRequirement' };
						Expect(_Env.binder.bind({ Field: 'r.Required', Op: 'EQ', Bind: '$Param.Flag' }, tmpBind, { Flag: 1 }, { Entity: 'MaterialIntake', Sides: tmpSides, Owner: 'F', OwnerKind: 'Facet' }))
							.to.deep.equal({ Field: 'r.Required', Op: 'EQ', Value: 1 });
						Expect(_Env.binder.bind({ Field: 'ReceivedDate', Alias: 'i', Op: 'LT', Bind: '$Now' }, tmpBind, {}, { Entity: 'MaterialIntake', Sides: tmpSides }))
							.to.deep.equal({ Field: 'ReceivedDate', Alias: 'i', Op: 'LT', Value: TEST_NOW_CANONICAL });
					});

				test('an unset $CurrentUser / $Scope value is 401 (fail closed, never "matches nothing")',
					() =>
					{
						let tmpAnonymous = _Env.binder.context(fContext(null));
						[ '$CurrentUser.IDUser', '$CurrentUser.IDCustomer', '$Scope.IDCustomer', '$Scope.OwnerIDUser' ].forEach(
							(pToken) =>
							{
								let tmpError = facetError(() => { _Env.binder.bind(tok('OwnerIDUser', 'EQ', pToken), tmpAnonymous, {}, { Entity: 'LabForm' }); });
								Expect(tmpError.Code, pToken).to.equal('FACET_UNAUTHENTICATED');
								Expect(tmpError.Status).to.equal(401);
								Expect(tmpError.Detail || null).to.equal(null);
							});
						// Scope.UnsetValues counts: a configured sentinel is unset too
						let tmpSentinel = newEnvironment('LabTrack', { Faceting: { Scope: { UnsetValues: [ 0, '', null, 999 ] } } });
						let tmpSentinelBind = tmpSentinel.binder.context(newContext(tmpSentinel, 'LabForm', { Tenant: 1, User: 999 }, { Facets: [] }, { NoFilter: true }));
						Expect(facetError(() => { tmpSentinel.binder.bind(tok('OwnerIDUser', 'EQ', '$CurrentUser.IDUser'), tmpSentinelBind, {}, { Entity: 'LabForm' }); }).Code).to.equal('FACET_UNAUTHENTICATED');
						// $Now needs no principal
						Expect(_Env.binder.bind(tok('CompletedDate', 'LT', '$Now'), tmpAnonymous, {}, { Entity: 'LabForm' }).Value).to.equal(TEST_NOW_CANONICAL);
					});

				test('tokens the registry should have refused fail as FACET_INTERNAL (never bound)',
					() =>
					{
						let tmpBind = _Env.binder.context(fContext({ Tenant: 1, User: 5 }));
						[ tok('Status', 'EQ', '$Bogus.X'), tok('Status', 'EQ', '$CurrentUser.Password'), tok('Status', 'EQ', '$Scope.Status'), tok('Status', 'EQ', '$Param.Undeclared') ].forEach(
							(pLeaf) =>
							{
								Expect(facetError(() => { _Env.binder.bind(pLeaf, tmpBind, {}, { Entity: 'LabForm' }); }).Code, pLeaf.Bind).to.equal('FACET_INTERNAL');
							});
						// a leaf with both a Value and a Bind, and a list bound under a scalar op
						Expect(facetError(() => { _Env.binder.bind({ Field: 'Status', Op: 'EQ', Value: 'x', Bind: '$Now' }, tmpBind, {}, { Entity: 'LabForm' }); }).Code).to.equal('FACET_INTERNAL');
						Expect(facetError(() => { _Env.binder.bind(tok('Status', 'EQ', '$Param.L'), tmpBind, { L: [ 'a' ] }, { Entity: 'LabForm' }); }).Code).to.equal('FACET_INTERNAL');
						Expect(facetError(() => { _Env.binder.bind(lit('Status', 'EQ', 'x'), null, {}, {}); }).Code).to.equal('FACET_INTERNAL');
						Expect(_Env.binder.bind(null, tmpBind, {}, {})).to.equal(null);
					});

				test('a $Param value the column cannot hold is 400 FACET_PARAM_INVALID (Reason Type), naming the owner, never the value',
					() =>
					{
						let tmpBind = _Env.binder.context(fContext({ Tenant: 1, User: 5 }));
						let tmpError = facetError(() => { _Env.binder.bind(tok('IDLabFormType', 'EQ', '$Param.FormType'), tmpBind, { FormType: 'seven' }, { Entity: 'LabForm', Owner: 'LabForm.ByType', OwnerKind: 'Facet' }); });
						Expect(tmpError.Code).to.equal('FACET_PARAM_INVALID');
						Expect(tmpError.Detail).to.deep.equal({ Facet: 'LabForm.ByType', Param: 'FormType', Reason: 'Type' });
					});

				test('validateParams(): every type, defaults, and every error reason (§22.3)',
					() =>
					{
						let tmpSchema =
							{
								Role: { Type: 'Enum', Values: [ 'Owner', 'Lead' ], Default: 'Owner' },
								Roles: { Type: 'EnumList', Values: [ 'Owner', 'Lead', 'Member' ], Default: [ 'Owner' ] },
								Days: { Type: 'Integer', Min: 1, Max: 30, Default: 7 },
								Ids: { Type: 'IntegerList', Min: 1 },
								Text: { Type: 'String', MaxLength: 5, Default: 'abc' },
								Flag: { Type: 'Boolean', Default: false },
								Since: { Type: 'DateTime', Default: '2026-01-01' }
							};
						let tmpOwner = { Scope: 'X.Y' };
						let fValid = (pValues) => { return _Env.binder.validateParams(tmpSchema, Object.assign({ Ids: [ 1 ] }, pValues), tmpOwner); };
						Expect(fValid({})).to.deep.equal({ Days: 7, Flag: 0, Ids: [ 1 ], Role: 'Owner', Roles: [ 'Owner' ], Since: '2026-01-01 00:00:00', Text: 'abc' });
						Expect(fValid({ Role: 'Lead', Roles: [ 'Lead', 'Member' ], Days: '30', Ids: [ '3', 4, 3 ], Text: 'hello', Flag: 'true', Since: '2026-03-02T10:11:12Z' }))
							.to.deep.equal({ Days: 30, Flag: 1, Ids: [ 3, 4 ], Role: 'Lead', Roles: [ 'Lead', 'Member' ], Since: '2026-03-02 10:11:12', Text: 'hello' });
						Expect(fValid({ Flag: 0 }).Flag).to.equal(0);
						Expect(fValid({ Flag: '1' }).Flag).to.equal(1);
						Expect(fValid({ Role: null }).Role).to.equal('Owner');
						let fReason = (pValues, pSchema) =>
						{
							let tmpError = facetError(() => { _Env.binder.validateParams(pSchema || tmpSchema, Object.assign({ Ids: [ 1 ] }, pValues), tmpOwner); });
							Expect(tmpError.Code).to.equal('FACET_PARAM_INVALID');
							Expect(tmpError.Status).to.equal(400);
							Expect(tmpError.Detail.Scope).to.equal('X.Y');
							Expect(JSON.stringify(tmpError.Detail)).to.not.contain('Nope');
							return tmpError.Detail.Reason + ':' + tmpError.Detail.Param;
						};
						Expect(fReason({ Bogus: 1 })).to.equal('Unknown:Bogus');
						Expect(facetError(() => { _Env.binder.validateParams(tmpSchema, JSON.parse('{ "Ids": [ 1 ], "__proto__": 1 }'), tmpOwner); }).Detail.Reason).to.equal('Unknown');
						Expect(fReason({ Ids: undefined })).to.equal('Required:Ids');
						Expect(fReason({ Ids: null })).to.equal('Required:Ids');
						Expect(fReason({ Role: 'Nope' })).to.equal('NotAllowed:Role');
						Expect(fReason({ Role: [ 'Owner' ] })).to.equal('Type:Role');
						Expect(fReason({ Roles: [] })).to.equal('Type:Roles');
						Expect(fReason({ Roles: 'Owner' })).to.equal('Type:Roles');
						Expect(fReason({ Roles: [ 'Owner', 'Owner' ] })).to.equal('Type:Roles');
						Expect(fReason({ Roles: [ 'Owner', 'Nope' ] })).to.equal('NotAllowed:Roles');
						Expect(fReason({ Days: 31 })).to.equal('Range:Days');
						Expect(fReason({ Days: 0 })).to.equal('Range:Days');
						Expect(fReason({ Days: 1.5 })).to.equal('Type:Days');
						Expect(fReason({ Days: 'x' })).to.equal('Type:Days');
						Expect(fReason({ Ids: [ 0 ] })).to.equal('Range:Ids');
						Expect(fReason({ Ids: [ 'a' ] })).to.equal('Type:Ids');
						Expect(fReason({ Text: 'toolong' })).to.equal('Range:Text');
						Expect(fReason({ Text: 'a~b' })).to.equal('NotAllowed:Text');
						Expect(fReason({ Text: 5 })).to.equal('Type:Text');
						Expect(fReason({ Flag: 'yes' })).to.equal('Type:Flag');
						Expect(fReason({ Since: 'yesterday' })).to.equal('Type:Since');
						let tmpLong = [];
						for (let i = 0; i < 1001; i++)
						{
							tmpLong.push(i + 1);
						}
						Expect(fReason({ Ids: tmpLong })).to.equal('Range:Ids');
						// a non-object Params container
						Expect(facetError(() => { _Env.binder.validateParams(tmpSchema, [ 1 ], { Facet: 'F' }); }).Detail).to.deep.equal({ Facet: 'F', Param: null, Reason: 'Type' });
						// no schema: any value is Unknown, none is fine
						Expect(_Env.binder.validateParams({}, undefined, tmpOwner)).to.deep.equal({});
						// an invalid declared Default is a definition bug
						Expect(facetError(() => { _Env.binder.validateParams({ A: { Type: 'Integer', Default: 'x' } }, {}, tmpOwner); }).Code).to.equal('FACET_INTERNAL');
					});

				test('bindHash(): b: + 16 hex over the sorted Used vector; differs by principal and by $Now bucket, stable otherwise',
					() =>
					{
						let fHash = (pWho, pNow, pParams) =>
						{
							let tmpBind = _Env.binder.context(fContext(pWho, { Now: pNow }));
							_Env.binder.bind(and(tok('OwnerIDUser', 'EQ', '$CurrentUser.IDUser'), tok('CompletedDate', 'LT', '$Now'), tok('Status', 'IN', '$Param.S')), tmpBind, { S: pParams || [ 'a' ] }, { Entity: 'LabForm', Owner: 'O' });
							return _Env.binder.bindHash(tmpBind);
						};
						let tmpHash = fHash({ Tenant: 1, User: 5 }, TEST_NOW);
						Expect(tmpHash).to.match(/^b:[0-9a-f]{16}$/);
						Expect(fHash({ Tenant: 1, User: 5 }, TEST_NOW)).to.equal(tmpHash);
						Expect(fHash({ Tenant: 1, User: 5 }, '2026-10-08T12:00:59Z')).to.equal(tmpHash);
						Expect(fHash({ Tenant: 1, User: 5 }, '2026-10-08T12:01:00Z')).to.not.equal(tmpHash);
						Expect(fHash({ Tenant: 1, User: 6 }, TEST_NOW)).to.not.equal(tmpHash);
						Expect(fHash({ Tenant: 1, User: 5 }, TEST_NOW, [ 'b' ])).to.not.equal(tmpHash);
						// nothing bound: the hash of []
						let tmpEmpty = 'b:' + libCrypto.createHash('sha256').update('[]').digest('hex').substring(0, 16);
						Expect(_Env.binder.bindHash(_Env.binder.context(fContext({ Tenant: 1, User: 5 })))).to.equal(tmpEmpty);
						Expect(_Env.binder.bindHash(null)).to.equal(tmpEmpty);
					});
			}
		);

		suite
		(
			'FilterAST, named scopes and join clauses (internal-contracts §23)',
			() =>
			{
				let _Env = null;
				suiteSetup(() => { _Env = newEnvironment('ProjectTrack'); });
				setup(() => { _Env.authorizer.Denied.clear(); });

				let LEAD = { Tenant: 1, User: 7 };
				let fAST = (pEntity, pBody, pWho) => { return newContext(_Env, pEntity, pWho || LEAD, Object.assign({ Facets: [] }, pBody)).FilterAST; };
				let fError = (pEntity, pBody, pWho) => { return facetError(() => { fAST(pEntity, pBody, pWho); }); };

				test('bodies without scopes or join clauses keep exactly the M1 conjuncts and Ids (plus Shape Column, Binds [], Entities [])',
					() =>
					{
						let tmpAST = fAST('Project',
							{
								Clauses:
									[
										{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active' ], Hash: 'h1' },
										{ Type: 'DateRange', FilterByColumn: 'StartDate', Values: { Start: '2026-01-01 00:00:00' }, Hash: 'h2' }
									],
								FilterString: 'FBV~Name~LK~%25a%25'
							});
						Expect(tmpAST.Conjuncts.map((pConjunct) => { return pConjunct.Id; })).to.deep.equal([ 'c1', 'c2', 'c3' ]);
						tmpAST.Conjuncts.forEach(
							(pConjunct) =>
							{
								Expect(pConjunct.Shape).to.equal('Column');
								Expect(pConjunct.Binds).to.deep.equal([]);
								Expect(pConjunct.Entities).to.deep.equal([]);
							});
						Expect(tmpAST.Conjuncts[0].Origin).to.deep.equal({ Kind: 'Clause', Hash: 'h1', FilterKey: 'Status', ClauseType: 'DistinctSelectedValueList', Index: 0 });
						Expect(tmpAST.Conjuncts[1].Pred).to.deep.equal({ Field: 'StartDate', Op: 'GE', Value: '2026-01-01' });
						Expect(tmpAST.Applied).to.deep.equal([ { Hash: 'h1' }, { Hash: 'h2' }, { String: true } ]);
						Expect(tmpAST.Entities).to.deep.equal([]);
					});

				test('request Scopes: one bound, NeverExclude, Path-shaped conjunct each, AFTER the clauses and the FilterString (§23.3)',
					() =>
					{
						let tmpAST = fAST('Project',
							{
								Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active' ], Hash: 'h1' } ],
								FilterString: 'FBV~Name~LK~%25a%25',
								Scopes: [ { Scope: 'Project.MyProjects' }, { Scope: 'Project.Unblocked', Params: {} } ]
							});
						Expect(tmpAST.Conjuncts.map((pConjunct) => { return pConjunct.Id; })).to.deep.equal([ 'c1', 'c2', 'c3', 'c4' ]);
						let tmpScope = tmpAST.Conjuncts[2];
						Expect(tmpScope.Origin).to.deep.equal({ Kind: 'Scope', Hash: null, FilterKey: null, ClauseType: null, Index: 0, Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead', 'Member' ] } });
						Expect(tmpScope.Fields).to.deep.equal([ '@scope:Project.MyProjects' ]);
						Expect(tmpScope.NeverExclude).to.equal(true);
						Expect(tmpScope.NamesDeleted).to.equal(false);
						Expect(tmpScope.Shape).to.equal('Path');
						Expect(tmpScope.Binds).to.deep.equal([ '$CurrentUser.IDUser', '$Param.Roles' ]);
						Expect(tmpScope.Entities).to.deep.equal([ 'ProjectMembership' ]);
						// the Pred is the canonical Where, bound (Roles from the declared Default, IDUser 7)
						let tmpPath = pathPlan(_Env.graph, 'Project', [ '<ProjectMembership.IDProject' ]);
						Expect(plain(tmpScope.Pred)).to.deep.equal(plain(or(
							existsC(tmpPath, and(lit('IDUser', 'EQ', 7), lit('Role', 'IN', [ 'Owner', 'Lead', 'Member' ]), lit('Active', 'EQ', 1))),
							lit('OwnerIDUser', 'EQ', 7))));
						Expect(tmpAST.Conjuncts[3].Origin.Scope).to.equal('Project.Unblocked');
						Expect(tmpAST.Conjuncts[3].Binds).to.deep.equal([]);
						Expect(tmpAST.Applied).to.deep.equal([ { Hash: 'h1' }, { String: true }, { Scope: 'Project.MyProjects' }, { Scope: 'Project.Unblocked' } ]);
						Expect(tmpAST.Entities).to.deep.equal([ 'Issue', 'ProjectMembership' ]);
					});

				test('a NamedScope clause sits at its own index and is never OR-combined with client clauses',
					() =>
					{
						let tmpAST = fAST('Project',
							{
								Clauses:
									[
										{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active' ], Hash: 'a' },
										{ Type: 'NamedScope', Scope: 'Project.HasMyOverdue', Hash: 'scope-1' },
										{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Name', Values: [ 'X' ], Junction: 'OR', Hash: 'b' }
									],
								Scopes: [ { Scope: 'Project.Unblocked' } ]
							});
						// a OR b is one client conjunct (the scope was taken out of the pict sequence first)
						Expect(tmpAST.Conjuncts.length).to.equal(3);
						Expect(tmpAST.Conjuncts[0].Pred).to.deep.equal({ Or: [ { Field: 'Status', Op: 'IN', Value: [ 'Active' ] }, { Field: 'Name', Op: 'IN', Value: [ 'X' ] } ] });
						Expect(tmpAST.Conjuncts[0].Shape).to.equal('Column');
						Expect(tmpAST.Conjuncts[1].Origin).to.deep.equal({ Kind: 'Scope', Hash: 'scope-1', FilterKey: null, ClauseType: 'NamedScope', Index: 1, Scope: 'Project.HasMyOverdue', Params: {} });
						Expect(tmpAST.Conjuncts[1].NeverExclude).to.equal(true);
						Expect(tmpAST.Conjuncts[2].Origin.Scope).to.equal('Project.Unblocked');
						Expect(tmpAST.Applied).to.deep.equal([ { Hash: 'a' }, { Hash: 'b' }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ]);
						// Junction OR / a GUIDGroup on the scope clause itself is refused
						[ { Junction: 'OR' }, { GUIDGroup: 'g1' } ].forEach(
							(pExtra) =>
							{
								let tmpError = fError('Project', { Clauses: [ Object.assign({ Type: 'NamedScope', Scope: 'Project.HasMyOverdue' }, pExtra) ] });
								Expect(tmpError.Code).to.equal('FACET_FILTER_INVALID');
								Expect(tmpError.Detail.Reason).to.equal('NamedScopeJunction');
							});
						// a disabled scope clause is skipped like any disabled clause
						Expect(fAST('Project', { Clauses: [ { Type: 'NamedScope', Scope: 'Project.HasMyOverdue', Enabled: false } ] }).Conjuncts).to.deep.equal([]);
					});

				test('unknown, wrong-entity and unsupported scopes; MaxScopesPerRequest',
					() =>
					{
						[ 'Project.Nope', 'Document.InMyProjects', 'Nope', '' ].forEach(
							(pName) =>
							{
								let tmpError = fError('Project', { Scopes: [ { Scope: pName } ] });
								Expect(tmpError.Code, pName).to.equal('FACET_UNKNOWN_SCOPE');
								Expect(tmpError.Status).to.equal(400);
								Expect(tmpError.Detail).to.deep.equal({ Scope: pName });
								Expect(fError('Project', { Clauses: [ { Type: 'NamedScope', Scope: pName } ] }).Code).to.equal('FACET_UNKNOWN_SCOPE');
							});
						Expect(fError('Project', { Scopes: [ 'Project.MyProjects' ] }).Code).to.equal('FACET_UNKNOWN_SCOPE');
						let tmpUnsupported = Object.assign({}, _Env.registry.scope('Project.Unblocked'), { Scope: 'Project.Quantified', Supported: false, Unsupported: { Feature: 'Quantified', Milestone: 2 } });
						_Env.registry.Scopes.set('Project.Quantified', tmpUnsupported);
						let tmpError = fError('Project', { Scopes: [ { Scope: 'Project.Quantified' } ] });
						Expect(tmpError.Code).to.equal('FACET_FOLD_UNSUPPORTED');
						Expect(tmpError.Status).to.equal(422);
						Expect(tmpError.Detail).to.deep.equal({ Feature: 'Quantified', Milestone: 2 });
						_Env.registry.Scopes.delete('Project.Quantified');
						let tmpMany = [];
						for (let i = 0; i < 17; i++)
						{
							tmpMany.push({ Scope: 'Project.Unblocked' });
						}
						let tmpTooMany = fError('Project', { Scopes: tmpMany });
						Expect(tmpTooMany.Code).to.equal('FACET_TOO_LARGE');
						Expect(tmpTooMany.Detail.Limit).to.equal('MaxScopesPerRequest');
						// clauses and request scopes count together
						let tmpMixed = fError('Project', { Scopes: tmpMany.slice(0, 16), Clauses: [ { Type: 'NamedScope', Scope: 'Project.Unblocked' } ] });
						Expect(tmpMixed.Detail.Limit).to.equal('MaxScopesPerRequest');
						Expect(fAST('Project', { Scopes: tmpMany.slice(0, 16) }).Conjuncts.length).to.equal(16);
					});

				test('scope params: validated against the scope (400 with Scope / Param / Reason); the gate comes first (403, no Detail)',
					() =>
					{
						let tmpError = fError('Project', { Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'King' ] } } ] });
						Expect(tmpError.Code).to.equal('FACET_PARAM_INVALID');
						Expect(tmpError.Detail).to.deep.equal({ Scope: 'Project.MyProjects', Param: 'Roles', Reason: 'NotAllowed' });
						Expect(fError('Project', { Scopes: [ { Scope: 'Project.MyProjects', Params: { Bogus: 1 } } ] }).Detail.Reason).to.equal('Unknown');
						Expect(fError('Project', { Clauses: [ { Type: 'NamedScope', Scope: 'Project.MyProjects', Params: { Roles: 'Owner' } } ] }).Detail.Reason).to.equal('Type');
						// an unreadable hop entity of the scope: 403 before the (bad) params are looked at
						_Env.authorizer.Denied.add('ProjectMembership');
						let tmpGate = fError('Project', { Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'King' ] } } ] });
						Expect(tmpGate.Code).to.equal('FACET_FORBIDDEN');
						Expect(tmpGate.Status).to.equal(403);
						Expect(tmpGate.Detail || null).to.equal(null);
						Expect(fError('Project', { Clauses: [ { Type: 'NamedScope', Scope: 'Project.MyProjects' } ] }).Code).to.equal('FACET_FORBIDDEN');
						// a scope that does not read the denied entity is unaffected
						Expect(fAST('Project', { Scopes: [ { Scope: 'Project.Unblocked' } ] }).Conjuncts.length).to.equal(1);
						_Env.authorizer.Denied.delete('ProjectMembership');
					});

				test('the gate comes before Supported: an unsupported scope over an unreadable entity is 403, not 422 (no feature leak)',
					() =>
					{
						let tmpUnsupported = Object.assign({}, _Env.registry.scope('Project.Unblocked'), { Scope: 'Project.QuantifiedHidden', Supported: false, Unsupported: { Feature: 'Quantified', Milestone: 2 } });
						_Env.registry.Scopes.set('Project.QuantifiedHidden', tmpUnsupported);
						Expect(fError('Project', { Scopes: [ { Scope: 'Project.QuantifiedHidden' } ] }).Code).to.equal('FACET_FOLD_UNSUPPORTED');
						_Env.authorizer.Denied.add('Issue');
						let tmpGate = fError('Project', { Scopes: [ { Scope: 'Project.QuantifiedHidden' } ] });
						_Env.authorizer.Denied.delete('Issue');
						_Env.registry.Scopes.delete('Project.QuantifiedHidden');
						Expect(tmpGate.Code).to.equal('FACET_FORBIDDEN');
						Expect(tmpGate.Detail || null).to.equal(null);
					});

				test('a scope bound for a principal without a user is 401; FilterAST without a BindContext is a wiring bug',
					() =>
					{
						Expect(fError('Project', { Scopes: [ { Scope: 'Project.HasMyOverdue' } ] }, { Tenant: 1, User: 0 }).Code).to.equal('FACET_UNAUTHENTICATED');
						Expect(fAST('Project', { Scopes: [ { Scope: 'Project.Unblocked' } ] }, { Tenant: 1, User: 0 }).Conjuncts.length).to.equal(1);
						let tmpNoBind = facetError(() => { _Env.ast.build('Project', { Scopes: [ { Scope: 'Project.Unblocked' } ] }); });
						Expect(tmpNoBind.Code).to.equal('FACET_INTERNAL');
						let tmpNoBindJoin = facetError(() => { _Env.ast.build('Project', { Clauses: [ { Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', Values: [ 1 ] } ] }); });
						Expect(tmpNoBindJoin.Code).to.equal('FACET_INTERNAL');
						// an UndeclaredJoin is reported before the missing BindContext
						Expect(facetError(() => { _Env.ast.build('Project', { Clauses: [ { Type: 'InternalJoinSelectedValueList', RemoteTable: 'User', JoinInternalConnectionColumn: 'IDClient', Values: [ 1 ] } ] }); }).Detail.Reason).to.equal('UndeclaredJoin');
					});

				test('InternalJoinSelectedValueList by the target key (L3): Exists over >E.c, owned like the FK column (E1 IDClient)',
					() =>
					{
						let tmpAST = fAST('Project', { Clauses: [ { Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: [ '3', 9, 3, null ], FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' } ] });
						let tmpConjunct = tmpAST.Conjuncts[0];
						let tmpPath = pathPlan(_Env.graph, 'Project', [ '>Project.IDClient' ]);
						Expect(plain(tmpConjunct.Pred)).to.deep.equal(plain(existsC(tmpPath, lit('IDClient', 'IN', [ 3, 9 ]))));
						Expect(tmpConjunct.Shape).to.equal('Path');
						Expect(tmpConjunct.Fields).to.deep.equal([ 'IDClient' ]);
						Expect(tmpConjunct.Entities).to.deep.equal([ 'Client' ]);
						Expect(tmpConjunct.NeverExclude).to.equal(false);
						Expect(tmpConjunct.NamesDeleted).to.equal(false);
						Expect(tmpConjunct.Origin).to.deep.equal({ Kind: 'Join', Hash: 'IDClient-IJ-1', FilterKey: 'IDClient', ClauseType: 'InternalJoinSelectedValueList', Index: 0 });
						Expect(tmpAST.Applied).to.deep.equal([ { Hash: 'IDClient-IJ-1' } ]);
						Expect(tmpAST.Entities).to.deep.equal([ 'Client' ]);
						// FilterKey defaults to the FK column; JoinExternalConnectionColumn defaults to the edge's ToColumn
						let tmpDefault = fAST('Project', { Clauses: [ { Type: 'InternalJoinSelectedValue', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', Value: 4 } ] }).Conjuncts[0];
						Expect(tmpDefault.Origin.FilterKey).to.equal('IDClient');
						Expect(tmpDefault.Pred.Exists.Where).to.deep.equal(lit('IDClient', 'IN', [ 4 ]));
						// a lookup column other than the key is owned through the path
						let tmpByName = fAST('Project', { Clauses: [ { Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', ExternalFilterTableLookupColumn: 'Name', Values: [ 'Acme' ] } ] }).Conjuncts[0];
						Expect(tmpByName.Fields).to.deep.equal([ '@path:>Project.IDClient#Name' ]);
						Expect(tmpByName.Origin.FilterKey).to.equal(null);
						// the PathPlan equals the graph's own resolution when the graph offers one
						if (typeof(_Env.graph.resolvePath) === 'function')
						{
							Expect(plain(tmpConjunct.Pred.Exists.Path)).to.deep.equal(plain(_Env.graph.resolvePath('Project', [ '>Project.IDClient' ], {})));
						}
					});

				test('all twenty join clause types compile to one Exists conjunct (Match: EQ / LK; Range: M1 bound rules)',
					() =>
					{
						let tmpInternal = { RemoteTable: 'Project', JoinInternalConnectionColumn: 'IDProject' };
						let tmpExternal = { JoinTable: 'ProjectMembership', JoinTableCoreConnectionColumn: 'IDProject', JoinTableExternalConnectionColumn: 'IDUser', ExternalFilterByTable: 'User' };
						let tmpInternalPath = pathPlan(_Env.graph, 'Task', [ '>Task.IDProject' ]);
						let tmpExternalPath = pathPlan(_Env.graph, 'Project', [ '<ProjectMembership.IDProject', '>ProjectMembership.IDUser' ]);
						let tmpCases =
							[
								[ 'InternalJoinSelectedValue', 'Task', tmpInternal, { Value: 5 }, lit('IDProject', 'IN', [ 5 ]) ],
								[ 'InternalJoinSelectedValueList', 'Task', tmpInternal, { Values: [ 5, 6 ] }, lit('IDProject', 'IN', [ 5, 6 ]) ],
								[ 'InternalJoinMatch', 'Task', tmpInternal, { Values: [ 'ang' ], ExternalFilterByColumn: 'Name' }, lit('Name', 'LK', '%ang%') ],
								[ 'InternalJoinStringMatch', 'Task', tmpInternal, { Values: [ 'Hangar', 'Dock' ], ExternalFilterByColumns: [ 'Name' ], ExactMatch: true }, or(lit('Name', 'EQ', 'Hangar'), lit('Name', 'EQ', 'Dock')) ],
								[ 'InternalJoinNumericMatch', 'Task', tmpInternal, { Values: [ '12' ], ExternalFilterByColumn: 'IDClient' }, lit('IDClient', 'EQ', 12) ],
								[ 'InternalJoinDateMatch', 'Task', tmpInternal, { Values: [ '2026-03-01' ], ExternalFilterByColumn: 'StartDate' }, lit('StartDate', 'EQ', '2026-03-01 00:00:00') ],
								[ 'InternalJoinRange', 'Task', tmpInternal, { Values: { Start: 'A', End: 'M' }, ExternalFilterByColumn: 'Name' }, and(lit('Name', 'GE', 'A'), lit('Name', 'LE', 'M')) ],
								[ 'InternalJoinStringRange', 'Task', tmpInternal, { Values: { Start: 'A' }, ExternalFilterByColumn: 'Status', StartExclusive: true }, lit('Status', 'GT', 'A') ],
								[ 'InternalJoinNumericRange', 'Task', tmpInternal, { Values: { Start: 0, End: 10 }, ExternalFilterByColumn: 'IDClient', EndExclusive: true }, and(lit('IDClient', 'GE', 0), lit('IDClient', 'LT', 10)) ],
								[ 'InternalJoinDateRange', 'Task', tmpInternal, { Values: { Start: '2026-01-01 00:00:00', End: '2027-01-01 00:00:00' }, ExternalFilterByColumn: 'StartDate', EndExclusive: true }, and(lit('StartDate', 'GE', '2026-01-01'), lit('StartDate', 'LT', '2027-01-01')) ],
								[ 'ExternalJoinSelectedValue', 'Project', tmpExternal, { Value: 7 }, lit('IDUser', 'IN', [ 7 ]) ],
								[ 'ExternalJoinSelectedValueList', 'Project', tmpExternal, { Values: [ 7, '8' ] }, lit('IDUser', 'IN', [ 7, 8 ]) ],
								[ 'ExternalJoinMatch', 'Project', tmpExternal, { Values: [ 'ann' ], ExternalFilterByColumn: 'NameFirst' }, lit('NameFirst', 'LK', '%ann%') ],
								[ 'ExternalJoinStringMatch', 'Project', tmpExternal, { Values: [ 'ann' ], ExternalFilterByColumns: [ 'NameFirst', 'NameLast' ] }, or(lit('NameFirst', 'LK', '%ann%'), lit('NameLast', 'LK', '%ann%')) ],
								[ 'ExternalJoinNumericMatch', 'Project', tmpExternal, { Values: [ 1 ], ExternalFilterByColumn: 'IDCustomer' }, lit('IDCustomer', 'EQ', 1) ],
								[ 'ExternalJoinDateMatch', 'Project', tmpExternal, { Values: [ '2026-01-02 03:04:05' ], ExternalFilterByColumn: 'CreateDate' }, lit('CreateDate', 'EQ', '2026-01-02 03:04:05') ],
								[ 'ExternalJoinRange', 'Project', tmpExternal, { Values: { End: 'M' }, ExternalFilterByColumn: 'NameLast' }, lit('NameLast', 'LE', 'M') ],
								[ 'ExternalJoinStringRange', 'Project', tmpExternal, { Values: { Start: 'a', End: 'z' }, ExternalFilterByColumn: 'LoginID' }, and(lit('LoginID', 'GE', 'a'), lit('LoginID', 'LE', 'z')) ],
								[ 'ExternalJoinNumericRange', 'Project', tmpExternal, { Values: { Start: 1, End: 2 }, ExternalFilterByColumn: 'IDCustomer' }, and(lit('IDCustomer', 'GE', 1), lit('IDCustomer', 'LE', 2)) ],
								[ 'ExternalJoinDateRange', 'Project', tmpExternal, { Values: { Start: '0', End: '2026-06-01' }, ExternalFilterByColumn: 'CreateDate', EndExclusive: true }, lit('CreateDate', 'LT', '2026-06-01') ]
							];
						Expect(tmpCases.length).to.equal(20);
						Expect(libClauseCompiler.INTERNAL_JOIN_TYPES.concat(libClauseCompiler.EXTERNAL_JOIN_TYPES).sort()).to.deep.equal(tmpCases.map((pCase) => { return pCase[0]; }).sort());
						for (let i = 0; i < tmpCases.length; i++)
						{
							let tmpCase = tmpCases[i];
							let tmpClause = Object.assign({ Type: tmpCase[0], Hash: `j${i}` }, tmpCase[2], tmpCase[3]);
							let tmpConjunct = fAST(tmpCase[1], { Clauses: [ tmpClause ] }).Conjuncts[0];
							let tmpExternalCase = (tmpCase[0].indexOf('ExternalJoin') === 0);
							let tmpPath = tmpExternalCase ? tmpExternalPath : tmpInternalPath;
							Expect(plain(tmpConjunct.Pred), tmpCase[0]).to.deep.equal(plain(existsC(tmpPath, tmpCase[4])));
							Expect(tmpConjunct.Shape, tmpCase[0]).to.equal('Path');
							Expect(tmpConjunct.Origin.Kind, tmpCase[0]).to.equal('Join');
							Expect(tmpConjunct.Origin.ClauseType, tmpCase[0]).to.equal(tmpCase[0]);
							Expect(tmpConjunct.Entities, tmpCase[0]).to.deep.equal(tmpExternalCase ? [ 'ProjectMembership', 'User' ] : [ 'Project' ]);
							if (tmpExternalCase)
							{
								Expect(tmpConjunct.Fields.every((pField) => { return pField.indexOf('@path:<ProjectMembership.IDProject >ProjectMembership.IDUser#') === 0; }), tmpCase[0]).to.equal(true);
							}
						}
						// ownership fields of a join conjunct name the remote columns through the path signature
						let tmpMatch = fAST('Task', { Clauses: [ Object.assign({ Type: 'InternalJoinMatch', Values: [ 'x' ], ExternalFilterByColumns: [ 'Status', 'Name' ] }, tmpInternal) ] }).Conjuncts[0];
						Expect(tmpMatch.Fields).to.deep.equal([ '@path:>Task.IDProject#Name', '@path:>Task.IDProject#Status' ]);
						// the pict default lookup / filter column
						let tmpDefaultName = fAST('Task', { Clauses: [ Object.assign({ Type: 'InternalJoinMatch', Values: [ 'x' ] }, tmpInternal) ] }).Conjuncts[0];
						Expect(tmpDefaultName.Pred.Exists.Where).to.deep.equal(lit('Name', 'LK', '%x%'));
					});

				test('join clauses must walk declared edges (UndeclaredJoin); empty join clauses are ignored with FACET_CLAUSE_EMPTY',
					() =>
					{
						let fReason = (pEntity, pClause) => { let tmpError = fError(pEntity, { Clauses: [ pClause ] }); Expect(tmpError.Code).to.equal('FACET_FILTER_INVALID'); return tmpError.Detail.Reason; };
						let tmpGood = { Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', Values: [ 1 ] };
						Expect(fReason('Project', Object.assign({}, tmpGood, { RemoteTable: 'User' }))).to.equal('UndeclaredJoin');
						// An unknown entity name is answered like a hidden one (403, no Detail), BEFORE any edge
						// lookup: the 400 UndeclaredJoin only follows once every named entity passed the gate.
						Expect(fError('Project', { Clauses: [ Object.assign({}, tmpGood, { RemoteTable: 'Nope' }) ] })).to.include({ Code: 'FACET_FORBIDDEN', Status: 403 });
						Expect(fError('Project', { Clauses: [ Object.assign({}, tmpGood, { RemoteTable: 'Nope' }) ] }).Detail || null).to.equal(null);
						Expect(fReason('Project', Object.assign({}, tmpGood, { RemoteTable: undefined }))).to.equal('UndeclaredJoin');
						Expect(fReason('Project', Object.assign({}, tmpGood, { JoinInternalConnectionColumn: 'Name' }))).to.equal('UndeclaredJoin');
						Expect(fReason('Project', Object.assign({}, tmpGood, { JoinInternalConnectionColumn: undefined }))).to.equal('UndeclaredJoin');
						Expect(fReason('Project', Object.assign({}, tmpGood, { JoinInternalConnectionColumn: 'IDClient;--' }))).to.equal('UndeclaredJoin');
						Expect(fReason('Project', Object.assign({}, tmpGood, { JoinExternalConnectionColumn: 'Name' }))).to.equal('UndeclaredJoin');
						Expect(fReason('Project', Object.assign({}, tmpGood, { JoinExternalConnectionColumn: 7 }))).to.equal('UndeclaredJoin');
						let tmpExternal = { Type: 'ExternalJoinSelectedValueList', JoinTable: 'ProjectMembership', JoinTableCoreConnectionColumn: 'IDProject', JoinTableExternalConnectionColumn: 'IDUser', ExternalFilterByTable: 'User', Values: [ 1 ] };
						Expect(fAST('Project', { Clauses: [ tmpExternal ] }).Conjuncts.length).to.equal(1);
						Expect(fReason('Project', Object.assign({}, tmpExternal, { JoinTable: 'Task' }))).to.equal('UndeclaredJoin');
						Expect(fReason('Project', Object.assign({}, tmpExternal, { JoinTableCoreConnectionColumn: 'IDUser' }))).to.equal('UndeclaredJoin');
						Expect(fReason('Project', Object.assign({}, tmpExternal, { ExternalFilterByTable: 'Client' }))).to.equal('UndeclaredJoin');
						Expect(fReason('Project', Object.assign({}, tmpExternal, { ExternalFilterByTableConnectionColumn: 'LoginID' }))).to.equal('UndeclaredJoin');
						Expect(fReason('Project', Object.assign({}, tmpExternal, { CoreConnectionColumn: 'IDClient' }))).to.equal('UndeclaredJoin');
						Expect(fReason('Task', tmpExternal)).to.equal('UndeclaredJoin');
						// the remote delete column is never a join field
						Expect(fReason('Project', { Type: 'InternalJoinMatch', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', ExternalFilterByColumn: 'Deleted', Values: [ 1 ] })).to.equal('DeleteColumnNotAllowed');
						// values stay data
						Expect(fReason('Project', { Type: 'InternalJoinMatch', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', ExternalFilterByColumn: 'Name', Values: [ 'a~b' ] })).to.equal('TildeInValue');
						Expect(fReason('Project', Object.assign({}, tmpGood, { Values: [ 'x' ] }))).to.equal('InvalidNumber');
						let tmpEmpty = fAST('Project', { Clauses: [ Object.assign({}, tmpGood, { Values: [ null ], Hash: 'e' }), { Type: 'InternalJoinRange', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', Values: { Start: '' } } ] });
						Expect(tmpEmpty.Conjuncts).to.deep.equal([]);
						Expect(tmpEmpty.Warnings.map((pWarning) => { return pWarning.Code + ':' + pWarning.Detail.ClauseType; })).to.deep.equal([ 'FACET_CLAUSE_EMPTY:InternalJoinSelectedValueList', 'FACET_CLAUSE_EMPTY:InternalJoinRange' ]);
					});

				test('ExternalJoin on a polymorphic join table: PolyJoinRemoteType filters the join-table step (never ignored)',
					() =>
					{
						let tmpClause = { Type: 'ExternalJoinSelectedValueList', JoinTable: 'ProjectMembership', JoinTableCoreConnectionColumn: 'IDProject', JoinTableExternalConnectionColumn: 'IDUser', ExternalFilterByTable: 'User', Values: [ 7 ], PolyJoinRemoteType: 'Lead', PolyJoinRemoteColumn: 'Role' };
						let tmpConjunct = fAST('Project', { Clauses: [ tmpClause ] }).Conjuncts[0];
						Expect(tmpConjunct.Pred.Exists.Path.Steps[0].Where).to.deep.equal(lit('Role', 'EQ', 'Lead'));
						Expect(tmpConjunct.Pred.Exists.Path.Steps[1].Where).to.equal(null);
						Expect(tmpConjunct.Pred.Exists.Path.Signature).to.equal('<ProjectMembership.IDProject >ProjectMembership.IDUser');
						// the default column (RemoteType) does not exist here: refused, not ignored
						let tmpError = fError('Project', { Clauses: [ Object.assign({}, tmpClause, { PolyJoinRemoteColumn: undefined }) ] });
						Expect(tmpError.Code).to.equal('FACET_UNKNOWN_FIELD');
						Expect(tmpError.Detail).to.include({ Field: 'RemoteType', Entity: 'ProjectMembership' });
						// lowered: the join table's Rel carries the step Where
						let tmpPlan = plan(_Env, newContext(_Env, 'Project', LEAD, { Facets: [], Clauses: [ tmpClause ] }));
						Expect(plain(tmpPlan.Lowered.c1)).to.deep.equal(plain(
							xExists(xRel('ProjectMembership', 'h1', 'Hop', [ 'IDProjectMembership', 'IDProject', 'IDUser' ], lit('Role', 'EQ', 'Lead')), [ xOn('p', 'IDProject', 'IDProject') ],
								xExists(xRel('User', 'h2', 'Hop', [ 'IDUser' ], lit('IDUser', 'IN', [ 7 ]), { Stage: 'Allowed' }), [ xOn('h1', 'IDUser', 'IDUser') ]))));
					});

				test('the gate comes before field validation: an unreadable remote table is 403 even for an unknown field',
					() =>
					{
						let tmpClause = { Type: 'InternalJoinMatch', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', ExternalFilterByColumn: 'Bogus', Values: [ 'x' ] };
						let tmpUnknown = fError('Project', { Clauses: [ tmpClause ] });
						Expect(tmpUnknown.Code).to.equal('FACET_UNKNOWN_FIELD');
						Expect(tmpUnknown.Detail.Field).to.equal('Bogus');
						Expect(tmpUnknown.Detail.Entity).to.equal('Client');
						_Env.authorizer.Denied.add('Client');
						let tmpForbidden = fError('Project', { Clauses: [ tmpClause ] });
						Expect(tmpForbidden.Code).to.equal('FACET_FORBIDDEN');
						Expect(tmpForbidden.Detail || null).to.equal(null);
						Expect(fError('Project', { Clauses: [ Object.assign({}, tmpClause, { ExternalFilterByColumn: 'Name' }) ] }).Code).to.equal('FACET_FORBIDDEN');
						_Env.authorizer.Denied.clear();
						_Env.authorizer.Denied.add('User');
						let tmpExternal = { Type: 'ExternalJoinMatch', JoinTable: 'ProjectMembership', JoinTableCoreConnectionColumn: 'IDProject', JoinTableExternalConnectionColumn: 'IDUser', ExternalFilterByTable: 'User', ExternalFilterByColumn: 'Bogus', Values: [ 'x' ] };
						Expect(fError('Project', { Clauses: [ tmpExternal ] }).Code).to.equal('FACET_FORBIDDEN');
						_Env.authorizer.Denied.clear();
						_Env.authorizer.Denied.add('ProjectMembership');
						Expect(fError('Project', { Clauses: [ tmpExternal ] }).Code).to.equal('FACET_FORBIDDEN');
					});

				test('an OR between a column clause and a join clause is ONE Path-shaped conjunct (Or[leaf, Exists])',
					() =>
					{
						let tmpAST = fAST('Project',
							{
								Clauses:
									[
										{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active' ], Hash: 'a' },
										{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', Values: [ 3 ], Junction: 'OR', Hash: 'b' }
									]
							});
						Expect(tmpAST.Conjuncts.length).to.equal(1);
						let tmpConjunct = tmpAST.Conjuncts[0];
						Expect(plain(tmpConjunct.Pred)).to.deep.equal(plain(or(lit('Status', 'IN', [ 'Active' ]), existsC(pathPlan(_Env.graph, 'Project', [ '>Project.IDClient' ]), lit('IDClient', 'IN', [ 3 ])))));
						Expect(tmpConjunct.Shape).to.equal('Path');
						Expect(tmpConjunct.Fields).to.deep.equal([ 'IDClient', 'Status' ]);
						Expect(tmpConjunct.Entities).to.deep.equal([ 'Client' ]);
						Expect(tmpConjunct.Origin.Kind).to.equal('Clause');
						Expect(tmpConjunct.Origin.Kinds).to.deep.equal([ 'Clause', 'Join' ]);
						Expect(tmpAST.Applied).to.deep.equal([ { Hash: 'a' }, { Hash: 'b' } ]);
					});

				test('rendering: applyToQuery refuses Path conjuncts (FACET_INTERNAL); toFilterString throws PathConjunct; Column conjuncts still render',
					() =>
					{
						let tmpAST = fAST('Project',
							{
								Clauses:
									[
										{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active' ] },
										{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', Values: [ 3 ] }
									]
							});
						let tmpEntries = [];
						let tmpQuery = { addFilter: (pColumn, pValue, pOperator, pConnector, pParameter) => { tmpEntries.push([ pColumn, pValue, pOperator, pConnector, pParameter ]); } };
						Expect(facetError(() => { _Env.ast.applyToQuery(tmpAST.Conjuncts, tmpQuery, { Dialect: 'SQLite' }); }).Code).to.equal('FACET_INTERNAL');
						Expect(tmpEntries).to.deep.equal([]);
						_Env.ast.applyToQuery([ tmpAST.Conjuncts[0] ], tmpQuery, { Dialect: 'SQLite' });
						Expect(tmpEntries).to.deep.equal([ [ 'Status', [ 'Active' ], 'IN', 'AND', 'c1_Status' ] ]);
						// a hand-built conjunct with an existence node but no Shape is refused too
						Expect(facetError(() => { _Env.ast.applyToQuery([ { Id: 'c9', Pred: tmpAST.Conjuncts[1].Pred } ], tmpQuery, { Dialect: 'SQLite' }); }).Code).to.equal('FACET_INTERNAL');
						let tmpString = facetError(() => { _Env.ast.toFilterString(tmpAST.Conjuncts); });
						Expect(tmpString.Code).to.equal('FACET_FILTER_INVALID');
						Expect(tmpString.Detail.Reason).to.equal('PathConjunct');
						Expect(_Env.ast.toFilterString([ tmpAST.Conjuncts[0] ])).to.equal('FOP~0~(~0~FBL~Status~INN~Active~FCP~0~)~0');
						// a Rel Where renders through applyToQuery with the 'w' prefix (C's Where fence)
						tmpEntries.length = 0;
						_Env.ast.applyToQuery([ { Id: 'w', Pred: and(lit('Severity', 'EQ', 'Blocker'), lit('State', 'EQ', 'Open')) } ], tmpQuery, { Dialect: 'SQLite', ParameterPrefix: 'w' });
						Expect(tmpEntries.map((pEntry) => { return pEntry[4]; })).to.deep.equal([ undefined, 'w1_Severity', 'w1_State', undefined ]);
					});
			}
		);

		suite
		(
			'DisjunctivePlanner with definition Wheres; FoldIR helpers (internal-contracts §24.6, §24.11)',
			() =>
			{
				let _Env = null;
				suiteSetup(() => { _Env = newEnvironment('ProjectTrack'); });

				let fAST = () =>
				{
					return newContext(_Env, 'Project', { Tenant: 1, User: 7 },
						{
							Facets: [],
							Clauses:
								[
									{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active' ], Hash: 'S' },
									{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', Values: [ 3 ], Hash: 'C' }
								],
							Scopes: [ { Scope: 'Project.Unblocked' } ]
						}).FilterAST;
				};

				test('Variants group by (kept conjunct set, WhereHash); v0 never carries a W_def; M1 Hashes are unchanged without one',
					() =>
					{
						let tmpAST = fAST();
						let tmpWhere = { Node: 'Cmp', Alias: 'p', Field: 'Name', Op: 'EQ', Value: 'x' };
						let tmpPlan = _Env.disjunctive.variants(tmpAST,
							[
								{ Key: 'A', OwnedFields: [ 'Status' ], FilterKey: 'Status', Exclude: 'Self' },
								{ Key: 'B', OwnedFields: [ 'Status' ], FilterKey: 'Status', Exclude: 'Self', WhereHash: 'wh:aaaaaaaaaaaa', Where: tmpWhere },
								{ Key: 'C', OwnedFields: [ 'X' ], FilterKey: null, Exclude: 'None', WhereHash: 'wh:aaaaaaaaaaaa', Where: tmpWhere },
								{ Key: 'D', OwnedFields: [ 'IDClient' ], FilterKey: 'IDClient', Exclude: 'Self', WhereHash: 'wh:aaaaaaaaaaaa', Where: tmpWhere },
								{ Key: 'E', OwnedFields: [ 'X' ], FilterKey: null, Exclude: 'Self', WhereHash: 'wh:aaaaaaaaaaaa' },
								{ Key: '#Total', OwnedFields: [], FilterKey: null, Exclude: 'None' }
							]);
						let tmpVariants = tmpPlan.Variants;
						Expect(Object.keys(tmpVariants)).to.deep.equal([ 'v0', 'v1', 'v2', 'v3', 'v4' ]);
						Expect(tmpVariants.v0.Hash).to.equal('c1,c2,c3');
						Expect(tmpVariants.v0.WhereHash).to.equal('');
						Expect(tmpVariants.v0.Where).to.equal(null);
						Expect(tmpVariants.v0.Facets).to.deep.equal([ '#Total' ]);
						Expect(tmpVariants.v1.Hash).to.equal('c2,c3');
						Expect(tmpVariants.v1.Facets).to.deep.equal([ 'A' ]);
						Expect(tmpVariants.v2.Hash).to.equal('c2,c3|wh:aaaaaaaaaaaa');
						Expect(tmpVariants.v2.Facets).to.deep.equal([ 'B' ]);
						Expect(tmpVariants.v2.Where).to.equal(tmpWhere);
						// a W_def under Exclude None is still its own Variant (all conjuncts + the W_def), shared by E (owns nothing)
						Expect(tmpVariants.v3.Hash).to.equal('c1,c2,c3|wh:aaaaaaaaaaaa');
						Expect(tmpVariants.v3.Facets).to.deep.equal([ 'C', 'E' ]);
						Expect(tmpVariants.v4.Hash).to.equal('c1,c3|wh:aaaaaaaaaaaa');
						Expect(tmpPlan.Facets.D).to.deep.equal({ VariantId: 'v4', Mode: 'Exact', Excluded: [ 'c2' ], ExcludedHashes: [ 'C' ], KeptMixed: [], Owned: [ 'c2' ] });
						// Column / Path split of the kept conjuncts
						Expect(tmpVariants.v0.ColumnConjuncts.map((pConjunct) => { return pConjunct.Id; })).to.deep.equal([ 'c1' ]);
						Expect(tmpVariants.v0.PathConjuncts.map((pConjunct) => { return pConjunct.Id; })).to.deep.equal([ 'c2', 'c3' ]);
						Expect(tmpVariants.v4.PathConjuncts.map((pConjunct) => { return pConjunct.Id; })).to.deep.equal([ 'c3' ]);
						Expect(tmpVariants.v0.PathPred).to.equal(null);
						Expect(tmpVariants.v0.Relations).to.deep.equal([]);
					});

				test('scope conjuncts are never excluded (owned only by an explicit Exclude, then kept as Partial); join conjuncts are owned by FilterKey or path fields',
					() =>
					{
						let tmpAST = fAST();
						let tmpPlan = _Env.disjunctive.variants(tmpAST,
							[
								{ Key: 'Everything', OwnedFields: [ '@scope:Project.Unblocked', 'Status' ], FilterKey: null, Exclude: 'Self' },
								{ Key: 'Explicit', OwnedFields: [], FilterKey: null, Exclude: [ 'c3' ] },
								{ Key: 'ByPath', OwnedFields: [ '@path:>Project.IDClient#IDClient' ], FilterKey: 'Project.ByClient', Exclude: 'Self' }
							]);
						Expect(tmpPlan.Facets.Everything.Excluded).to.deep.equal([ 'c1' ]);
						Expect(tmpPlan.Facets.Everything.KeptMixed).to.deep.equal([ 'c3' ]);
						Expect(tmpPlan.Facets.Everything.Mode).to.equal('Partial');
						Expect(tmpPlan.Facets.Explicit).to.deep.equal({ VariantId: 'v0', Mode: 'Partial', Excluded: [], ExcludedHashes: [], KeptMixed: [ 'c3' ], Owned: [ 'c3' ] });
						// the L3 join conjunct's Fields are [ 'IDClient' ], not the path field: not owned by a path facet
						Expect(tmpPlan.Facets.ByPath.Excluded).to.deep.equal([]);
					});

				test('FoldIR.rel / whereHash / relations / columnsOf / realias / pivotColumns',
					() =>
					{
						let tmpRel = _Env.foldIR.rel({ Entity: 'Task', As: 'h1', Where: lit('Status', 'NE', 'Done') });
						Expect(tmpRel).to.deep.equal(xRel('Task', 'h1', 'Hop', [], lit('Status', 'NE', 'Done')));
						Expect(tmpRel.WhereHash).to.match(/^wh:[0-9a-f]{12}$/);
						Expect(_Env.foldIR.rel({ Entity: 'Task', As: 'h2' }).WhereHash).to.equal('');
						Expect(libFoldIR.whereHash(null)).to.equal('');
						let tmpInner = { Node: 'Exists', Rel: _Env.foldIR.rel({ Entity: 'LabQueueMember', As: 'h2' }), On: [ xOn('h1', 'IDLabQueue', 'IDLabQueue') ], Where: { Node: 'Cmp', Alias: 'h2', Field: 'Active', Op: 'EQ', Value: 1 } };
						let tmpTree = xAnd(
							{ Node: 'Exists', Rel: _Env.foldIR.rel({ Entity: 'LabQueue', As: 'h1' }), On: [ xOn('p', 'IDLabQueue', 'IDLabQueue') ], Where: tmpInner },
							xCmp('p', 'Status', 'EQ', 'Open'));
						Expect(_Env.foldIR.relations(tmpTree).map((pRel) => { return pRel.As; })).to.deep.equal([ 'h1', 'h2' ]);
						Expect(_Env.foldIR.columnsOf(tmpTree, 'p')).to.deep.equal([ 'IDLabQueue', 'Status' ]);
						Expect(_Env.foldIR.columnsOf(tmpTree, 'h1')).to.deep.equal([ 'IDLabQueue' ]);
						Expect(_Env.foldIR.columnsOf(tmpTree, 'h2')).to.deep.equal([ 'Active', 'IDLabQueue' ]);
						let tmpRenamed = _Env.foldIR.realias(tmpTree, 'h1', 'q7');
						Expect(tmpRenamed.Items[0].Rel.As).to.equal('q7');
						Expect(tmpRenamed.Items[0].Where.On[0].Outer.Alias).to.equal('q7');
						Expect(tmpTree.Items[0].Rel.As).to.equal('h1');
						Expect(_Env.foldIR.columnsOf(tmpRenamed, 'q7')).to.deep.equal([ 'IDLabQueue' ]);
						// pivotColumns: what an Agg and its Variant read from 'p'
						let tmpAgg = _Env.foldIR.agg({ Key: 'K', Kind: 'Terms', Pivot: 'Project', Dimensions: [ { Kind: 'Column', Field: 'Status', Alias: 'p', Via: [ { Rel: _Env.foldIR.rel({ Entity: 'Client', As: 'l1' }), On: [ xOn('p', 'IDClient', 'IDClient') ] } ] } ], Where: xCmp('p', 'Name', 'NE', 'x') });
						Expect(_Env.foldIR.pivotColumns(tmpAgg, { VariantId: 'v1', ConjunctIds: [], PathPred: xCmp('p', 'OwnerIDUser', 'EQ', 7) })).to.deep.equal([ 'IDClient', 'Name', 'OwnerIDUser' ]);
						// the M2 Agg defaults
						let tmpDefaults = _Env.foldIR.agg({});
						Expect(tmpDefaults).to.include({ Origin: 'Auto', Definition: null, Where: null, WhereHash: '', Tuple: null, MultiValued: false, Relaxed: false, Semantics: null, Path: null, CubeId: null });
						Expect(tmpDefaults.OwnedFields).to.deep.equal([]);
						Expect(tmpDefaults.Entities).to.deep.equal([]);
						Expect(tmpDefaults.Relations).to.deep.equal([]);
					});

				test('the alias counter: one counter per prefix, plan-wide; "p" is the pivot so extra renderings start at "p2"',
					() =>
					{
						let tmpCounter = libLowering.newAliasCounter();
						Expect([ tmpCounter.next('h'), tmpCounter.next('h'), tmpCounter.next('j'), tmpCounter.next('p'), tmpCounter.next('u'), tmpCounter.next('h') ]).to.deep.equal([ 'h1', 'h2', 'j1', 'p2', 'u1', 'h3' ]);
						Expect(facetError(() => { tmpCounter.next('f'); }).Code).to.equal('FACET_INTERNAL');
					});
			}
		);

		suite
		(
			'E1 / E3A / E3B: golden FoldIR (internal-contracts §24.8, §31.5)',
			() =>
			{
				let _Project = null;
				let _Lab = null;
				suiteSetup(() => { _Project = newEnvironment('ProjectTrack'); _Lab = newEnvironment('LabTrack'); });

				let LEAD = { Tenant: 1, User: 7 };
				let TECH = { Tenant: 1, User: 5 };

				let fE1 = (pInternal) =>
				{
					return newContext(_Project, 'Project', LEAD,
						{
							Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead' ] } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
							Clauses:
								[
									{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active', 'AtRisk' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' },
									{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: [ 3, 9 ], FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' },
									{ Type: 'DateRange', FilterByColumn: 'StartDate', Values: { Start: '2026-01-01 00:00:00', End: '2027-01-01 00:00:00' }, EndExclusive: true, FilterKey: 'StartDate', Hash: 'StartDate-DR-1' }
								],
							Facets:
								[
									{ Key: 'Status', Facet: 'Project.Status' }, { Key: 'Client', Facet: 'Project.IDClient', Top: 20 },
									{ Key: 'Started', Facet: 'Project.StartDate', Interval: 'month' }, { Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' },
									{ Key: 'StatusByClient', Facet: [ 'Project.Status', 'Project.IDClient' ], Fold: 'Pivot' }
								],
							Total: true,
							Records: { Begin: 0, Cap: 50, Sort: [ { Field: 'StartDate', Dir: 'DESC' } ] }
						}, pInternal);
				};

				// The E1 filter conjuncts, lowered by hand (h hops in conjunct order).
				let E1_C2 = () => { return xExists(xRel('Client', 'h1', 'Hop', [ 'IDClient' ], lit('IDClient', 'IN', [ 3, 9 ]), { Stage: 'Allowed' }), [ xOn('p', 'IDClient', 'IDClient') ]); };
				let E1_C4 = () =>
				{
					return xOr(
						xExists(xRel('ProjectMembership', 'h2', 'Hop', [ 'IDProjectMembership', 'IDProject' ], and(lit('IDUser', 'EQ', 7), lit('Role', 'IN', [ 'Owner', 'Lead' ]), lit('Active', 'EQ', 1)), { Stage: 'Allowed' }), [ xOn('p', 'IDProject', 'IDProject') ]),
						xCmp('p', 'OwnerIDUser', 'EQ', 7));
				};
				let OVERDUE = () => { return and(lit('AssignedIDUser', 'EQ', 7), lit('DueDate', 'LT', TEST_NOW_CANONICAL), lit('Status', 'NE', 'Done')); };
				let E1_C5 = () => { return xExists(xRel('Task', 'h3', 'Hop', [ 'IDTask', 'IDProject' ], OVERDUE(), { Stage: 'Allowed' }), [ xOn('p', 'IDProject', 'IDProject') ]); };
				let E1_C6 = () => { return xNotExists(xRel('Issue', 'h4', 'Hop', [ 'IDIssue', 'IDProject' ], and(lit('Severity', 'EQ', 'Blocker'), lit('State', 'EQ', 'Open')), { Stage: 'Allowed' }), [ xOn('p', 'IDProject', 'IDProject') ]); };

				test('E1: the filter (two column clauses, an L3 join clause, three scopes) and every scope lowered once at scope "p"',
					() =>
					{
						let tmpContext = fE1();
						let tmpPlan = plan(_Project, tmpContext);
						Expect(tmpPlan.Errors).to.deep.equal({});
						Expect(Object.keys(tmpPlan.Lowered)).to.deep.equal([ 'c2', 'c4', 'c5', 'c6' ]);
						Expect(plain(tmpPlan.Lowered.c2)).to.deep.equal(plain(E1_C2()));
						Expect(plain(tmpPlan.Lowered.c4)).to.deep.equal(plain(E1_C4()));
						Expect(plain(tmpPlan.Lowered.c5)).to.deep.equal(plain(E1_C5()));
						Expect(plain(tmpPlan.Lowered.c6)).to.deep.equal(plain(E1_C6()));
					});

				test('E1: Variants (Status / Client / Started exclude their own clause; MyOverdue, StatusByClient and the Total share v0) and their PathPreds',
					() =>
					{
						let tmpPlan = plan(_Project, fE1());
						let tmpVariants = tmpPlan.Variants;
						Expect(Object.keys(tmpVariants).map((pId) => { return pId + '=' + tmpVariants[pId].Hash + ':' + tmpVariants[pId].Facets.join('+'); })).to.deep.equal(
							[ 'v0=c1,c2,c3,c4,c5,c6:MyOverdue+StatusByClient+#Total', 'v1=c2,c3,c4,c5,c6:Status', 'v2=c1,c3,c4,c5,c6:Client', 'v3=c1,c2,c4,c5,c6:Started' ]);
						Expect(plain(tmpVariants.v0.PathPred)).to.deep.equal(plain(xAnd(E1_C2(), E1_C4(), E1_C5(), E1_C6())));
						Expect(plain(tmpVariants.v1.PathPred)).to.deep.equal(plain(xAnd(E1_C2(), E1_C4(), E1_C5(), E1_C6())));
						// the Client facet excludes the join conjunct (owned by FilterKey AND by its L3 field)
						Expect(plain(tmpVariants.v2.PathPred)).to.deep.equal(plain(xAnd(E1_C4(), E1_C5(), E1_C6())));
						Expect(tmpVariants.v0.ColumnConjuncts.map((pConjunct) => { return pConjunct.Id; })).to.deep.equal([ 'c1', 'c3' ]);
						Expect(tmpVariants.v1.ColumnConjuncts.map((pConjunct) => { return pConjunct.Id; })).to.deep.equal([ 'c3' ]);
						Expect(tmpVariants.v2.Relations).to.deep.equal([ { Alias: 'h2', Entity: 'ProjectMembership', Role: 'Hop' }, { Alias: 'h3', Entity: 'Task', Role: 'Hop' }, { Alias: 'h4', Entity: 'Issue', Role: 'Hop' } ]);
						// a PathPred is shared, not copied: the same lowered conjunct object in every Variant that keeps it
						Expect(tmpVariants.v0.PathPred.Items[1]).to.equal(tmpVariants.v3.PathPred.Items[1]);
						let tmpClient = aggByKey(tmpPlan, 'Client');
						Expect(tmpClient.Disjunctive).to.deep.equal({ Mode: 'Exact', Excluded: [ 'c2' ], ExcludedHashes: [ 'IDClient-IJ-1' ], KeptMixed: [], Owned: [ 'c2' ] });
					});

				test('E1: MyOverdueBand lowers to a ChildAgg dimension (K12) on the full filter; auto facets keep their M1 Aggs',
					() =>
					{
						let tmpPlan = plan(_Project, fE1());
						let tmpBand = aggByKey(tmpPlan, 'MyOverdue');
						Expect(plain(tmpBand.Dimensions)).to.deep.equal(plain(
							[ { Kind: 'ChildAgg', Rel: xRel('Task', 'x1', 'Child', [ 'IDTask', 'IDProject' ], OVERDUE()), On: [ xOn('p', 'IDProject', 'IDProject') ], Where: null, Agg: 'count', Field: null, Edges: [ 1, 3, 10 ], DataType: 'Numeric', IsInteger: true, Scale: 0 } ]));
						Expect(tmpBand).to.include({ Kind: 'ChildRollup', Origin: 'Declared', VariantId: 'v0', Exclude: 'None', CountMode: 'Rows', FilterKey: 'Project.MyOverdueBand', Selectable: true, ClauseType: null, Field: null, MultiValued: false, Semantics: 'NoVisibleMatch', WhereHash: '', Where: null, Tuple: null, LabelLookup: null });
						Expect(tmpBand.OwnedFields).to.deep.equal([]);
						Expect(tmpBand.Path).to.deep.equal([ '<Task.IDProject' ]);
						Expect(tmpBand.Entities).to.deep.equal([ 'Project', 'Task' ]);
						Expect(tmpBand.Relations).to.deep.equal([ { Alias: 'x1', Entity: 'Task', Role: 'Child' } ]);
						Expect(tmpBand.Definition).to.deep.equal({ Facet: 'Project.MyOverdueBand', Version: 1, DefinitionHash: 'dh:test', FoldHash: 'fh:test', SiblingOf: null });
						let tmpStatus = aggByKey(tmpPlan, 'Status');
						Expect(tmpStatus).to.include({ Origin: 'Auto', Kind: 'Terms', VariantId: 'v1', FilterKey: 'Status', ClauseType: 'DistinctSelectedValueList', Top: 20 });
						Expect(tmpStatus.Dimensions).to.deep.equal([ { Kind: 'Column', Field: 'Status', DataType: 'String', IsInteger: false, Scale: 0 } ]);
						Expect(tmpStatus.OwnedFields).to.deep.equal([ 'Status' ]);
						Expect(tmpStatus.SelectedKeys).to.deep.equal([ 'Active', 'AtRisk' ]);
						Expect(aggByKey(tmpPlan, 'StatusByClient').OwnedFields).to.deep.equal([ 'Status', 'IDClient' ]);
					});

				test('E1: DepSet across every hop; the plan lists every entity it reads; BindHash covers what was bound',
					() =>
					{
						let tmpContext = fE1();
						let tmpPlan = plan(_Project, tmpContext);
						Expect(tmpPlan.DepSet).to.deep.equal(
							{
								Project: [ 'Deleted', 'IDClient', 'IDCustomer', 'IDProject', 'OwnerIDUser', 'StartDate', 'Status' ],
								Client: [ 'Deleted', 'IDClient', 'IDCustomer' ],
								ProjectMembership: [ 'Active', 'Deleted', 'IDCustomer', 'IDProject', 'IDProjectMembership', 'IDUser', 'Role' ],
								Task: [ 'AssignedIDUser', 'Deleted', 'DueDate', 'IDCustomer', 'IDProject', 'IDTask', 'Status' ],
								Issue: [ 'Deleted', 'IDCustomer', 'IDIssue', 'IDProject', 'Severity', 'State' ]
							});
						Expect(aggByKey(tmpPlan, 'Status').DepSet).to.deep.equal(
							{
								Project: [ 'Deleted', 'IDClient', 'IDCustomer', 'IDProject', 'OwnerIDUser', 'StartDate', 'Status' ],
								Client: [ 'Deleted', 'IDClient', 'IDCustomer' ],
								ProjectMembership: [ 'Active', 'Deleted', 'IDCustomer', 'IDProject', 'IDProjectMembership', 'IDUser', 'Role' ],
								Task: [ 'AssignedIDUser', 'Deleted', 'DueDate', 'IDCustomer', 'IDProject', 'IDTask', 'Status' ],
								Issue: [ 'Deleted', 'IDCustomer', 'IDIssue', 'IDProject', 'Severity', 'State' ]
							});
						Expect(Object.keys(aggByKey(tmpPlan, 'Client').DepSet).sort()).to.deep.equal([ 'Issue', 'Project', 'ProjectMembership', 'Task' ]);
						Expect(tmpPlan.Entities).to.deep.equal([ 'Client', 'Issue', 'Project', 'ProjectMembership', 'Task' ]);
						Expect(tmpPlan.BindHash).to.equal(_Project.binder.bindHash(tmpContext.Bind));
						Expect(Array.from(tmpContext.Bind.Used.keys()).sort()).to.deep.equal([ '$CurrentUser.IDUser', '$Now', '$Param:Project.MyProjects.Roles' ]);
						// another user of the same tenant: same filter text, different BindHash
						Expect(plan(_Project, newContext(_Project, 'Project', { Tenant: 1, User: 8 }, { Facets: [], Scopes: [ { Scope: 'Project.HasMyOverdue' } ] })).BindHash)
							.to.not.equal(plan(_Project, newContext(_Project, 'Project', LEAD, { Facets: [], Scopes: [ { Scope: 'Project.HasMyOverdue' } ] })).BindHash);
					});

				test('E1: the CubePlan (flags b1–b3, RequireFlags per facet, the Total requires all, shared dims de-duplicated)',
					() =>
					{
						let tmpPlan = plan(_Project, fE1());
						Expect(tmpPlan.Cubes.length).to.equal(1);
						let tmpCube = tmpPlan.Cubes[0];
						Expect(tmpCube.CubeId).to.equal('cube0');
						Expect(tmpCube.Pivot).to.equal('Project');
						Expect(tmpCube.Flags.map((pFlag) => { return [ pFlag.Flag, pFlag.ConjunctId, pFlag.Shape ]; })).to.deep.equal([ [ 'b1', 'c1', 'Column' ], [ 'b2', 'c2', 'Path' ], [ 'b3', 'c3', 'Column' ] ]);
						Expect(plain(tmpCube.Flags[1].Pred)).to.deep.equal(plain(E1_C2()));
						Expect(tmpCube.Flags[0].Pred).to.equal(null);
						Expect(tmpCube.Common).to.deep.equal([ 'c4', 'c5', 'c6' ]);
						Expect(tmpCube.CommonColumn).to.deep.equal([]);
						Expect(tmpCube.CommonPath).to.deep.equal([ 'c4', 'c5', 'c6' ]);
						Expect(plain(tmpCube.CommonPathPred)).to.deep.equal(plain(xAnd(E1_C4(), E1_C5(), E1_C6())));
						Expect(Object.keys(tmpCube.ConjunctPreds)).to.deep.equal([ 'c2', 'c4', 'c5', 'c6' ]);
						Expect(tmpCube.ConjunctPreds.c2).to.equal(tmpPlan.Lowered.c2);
						Expect(tmpCube.WhereFlags).to.deep.equal([]);
						Expect(tmpCube.Dims.map((pDim) => { return [ pDim.Column, pDim.Dim.Kind, pDim.Dim.Field || null, pDim.Members ]; })).to.deep.equal(
							[ [ 'd1', 'Column', 'Status', [ 'Status', 'StatusByClient' ] ], [ 'd2', 'Column', 'IDClient', [ 'Client', 'StatusByClient' ] ], [ 'd3', 'DateBucket', 'StartDate', [ 'Started' ] ], [ 'd4', 'ChildAgg', null, [ 'MyOverdue' ] ] ]);
						Expect(tmpCube.Bounds).to.deep.equal([ { Lo: 'lo1', Hi: 'hi1', Dim: 'd3' } ]);
						Expect(tmpCube.Members).to.deep.equal(
							[
								{ AggKey: 'Status', Dims: [ 'd1' ], RequireFlags: [ 'b2', 'b3' ], RequireWhere: null },
								{ AggKey: 'Client', Dims: [ 'd2' ], RequireFlags: [ 'b1', 'b3' ], RequireWhere: null },
								{ AggKey: 'Started', Dims: [ 'd3' ], RequireFlags: [ 'b1', 'b2' ], RequireWhere: null },
								{ AggKey: 'MyOverdue', Dims: [ 'd4' ], RequireFlags: [ 'b1', 'b2', 'b3' ], RequireWhere: null },
								{ AggKey: 'StatusByClient', Dims: [ 'd1', 'd2' ], RequireFlags: [ 'b1', 'b2', 'b3' ], RequireWhere: null },
								{ AggKey: '#Total', Dims: [], RequireFlags: [ 'b1', 'b2', 'b3' ], RequireWhere: null }
							]);
						Expect(tmpCube.MaxGroups).to.equal(100000);
						tmpPlan.Aggs.forEach((pAgg) => { Expect(pAgg.CubeId, pAgg.Key).to.equal('cube0'); });
						// each member keeps its full per-Variant form (the cube may fall back to it)
						Expect(aggByKey(tmpPlan, 'Status').VariantId).to.equal('v1');
					});

				test('E2: join clause on a global lookup + a date range, auto facets only (nothing declared)',
					() =>
					{
						let tmpContext = newContext(_Project, 'Document', LEAD,
							{
								Clauses:
									[
										{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'FormType', JoinInternalConnectionColumn: 'IDFormType', JoinExternalConnectionColumn: 'IDFormType', Values: [ 12 ], FilterKey: 'IDFormType', Hash: 'IDFormType-IJ-1' },
										{ Type: 'DateRange', FilterByColumn: 'DocumentDate', Values: { Start: '2026-01-01 00:00:00', End: '2026-07-01 00:00:00' }, EndExclusive: true, FilterKey: 'DocumentDate', Hash: 'DocumentDate-DR-1' }
									],
								Facets: [ { Key: 'ByMonth', Facet: 'Document.DocumentDate', Interval: 'month', Chart: true }, { Key: 'ByForm', Facet: 'Document.IDFormType', Top: 20 }, { Key: 'Status', Facet: 'Document.Status', Exclude: 'None' } ],
								Records: { Begin: 0, Cap: 100 }
							});
						let tmpPlan = plan(_Project, tmpContext);
						Expect(tmpPlan.Errors).to.deep.equal({});
						// FormType is a global lookup without a delete column: the existence check is still kept (no L4 elision in M2)
						Expect(plain(tmpPlan.Lowered.c1)).to.deep.equal(plain(xExists(xRel('FormType', 'h1', 'Hop', [ 'IDFormType' ], lit('IDFormType', 'IN', [ 12 ]), { Stage: 'Allowed' }), [ xOn('p', 'IDFormType', 'IDFormType') ])));
						Expect(Object.keys(tmpPlan.Variants).map((pId) => { return tmpPlan.Variants[pId].Hash + ':' + tmpPlan.Variants[pId].Facets.join('+'); })).to.deep.equal(
							[ 'c1,c2:Status+#Total', 'c1:ByMonth', 'c2:ByForm' ]);
						Expect(aggByKey(tmpPlan, 'ByForm').SelectedKeys).to.deep.equal([ 12 ]);
						Expect(tmpPlan.DepSet.FormType).to.deep.equal([ 'IDFormType' ]);
						Expect(tmpPlan.Cubes[0].Flags.map((pFlag) => { return pFlag.ConjunctId; })).to.deep.equal([ 'c1', 'c2' ]);
					});

				// ---- E3 variant A

				let fE3A = (pWho, pInternal) =>
				{
					return newContext(_Lab, 'MaterialIntakeRequirement', pWho || TECH,
						{
							Facets:
								[
									{ Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' },
									{ Key: 'Week', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek' }, { Key: 'Discipline', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' },
									{ Key: 'Started', Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started' }
								]
						}, pInternal);
				};
				let E3A_WHERE = () =>
				{
					return xAnd(
						xExists(xRel('MaterialIntake', 'j1', 'Hop', [ 'IDMaterialIntake', 'IDLabQueue' ], lit('Status', 'IN', [ 'Received', 'InProgress' ])), [ xOn('p', 'IDMaterialIntake', 'IDMaterialIntake') ],
							xExists(xRel('LabQueue', 'j2', 'Hop', [ 'IDLabQueue' ], null), [ xOn('j1', 'IDLabQueue', 'IDLabQueue') ],
								xExists(xRel('LabQueueMember', 'j3', 'Hop', [ 'IDLabQueueMember', 'IDLabQueue' ], and(lit('IDUser', 'EQ', 5), lit('Active', 'EQ', 1)), { Stage: 'Allowed' }), [ xOn('j2', 'IDLabQueue', 'IDLabQueue') ]))),
						xNotExists(xRel('LabForm', 'j4', 'Hop', [ 'IDLabForm', 'IDLabFormType', 'IDMaterialIntake' ], lit('Status', 'EQ', 'Complete'), { Scope: 'TenantOnly', ScopeReason: TENANT_ONLY_A, Stage: 'Allowed' }),
							[ xOn('p', 'IDMaterialIntake', 'IDMaterialIntake'), xOn('p', 'IDLabFormType', 'IDLabFormType') ]));
				};

				test('E3A: the definition Where (scope reference inlined, alias spliced, co-reference anti-join with a composite correlation, TenantOnly) is lowered ONCE and shared',
					() =>
					{
						let tmpPlan = plan(_Lab, fE3A());
						Expect(tmpPlan.Errors).to.deep.equal({});
						let tmpToDo = aggByKey(tmpPlan, 'ToDo');
						Expect(plain(tmpToDo.Where)).to.deep.equal(plain(E3A_WHERE()));
						Expect(tmpToDo.WhereHash).to.match(/^wh:[0-9a-f]{12}$/);
						[ 'Queue', 'Week', 'Discipline', 'Started' ].forEach(
							(pKey) =>
							{
								Expect(aggByKey(tmpPlan, pKey).Where, pKey).to.equal(tmpToDo.Where);
								Expect(aggByKey(tmpPlan, pKey).WhereHash, pKey).to.equal(tmpToDo.WhereHash);
							});
						// one Variant: no filter conjuncts, the shared W_def; the Total is v0 (no W_def)
						Expect(Object.keys(tmpPlan.Variants)).to.deep.equal([ 'v0', 'v1' ]);
						Expect(tmpPlan.Variants.v1.Hash).to.equal('|' + tmpToDo.WhereHash);
						Expect(tmpPlan.Variants.v1.Facets).to.deep.equal([ 'ToDo', 'Queue', 'Week', 'Discipline', 'Started' ]);
						Expect(tmpPlan.Variants.v1.Where).to.equal(tmpToDo.Where);
						Expect(tmpPlan.Variants.v0.Facets).to.deep.equal([ '#Total' ]);
						Expect(tmpPlan.Variants.v0.Where).to.equal(null);
					});

				test('E3A: the siblings — K8 Via chains (two hops, one hop, a global lookup), a K8 DateHistogram, and a K20 ExistsFlag',
					() =>
					{
						let tmpPlan = plan(_Lab, fE3A());
						let tmpToDo = aggByKey(tmpPlan, 'ToDo');
						Expect(tmpToDo.Dimensions).to.deep.equal([ { Kind: 'Column', Field: 'IDLabFormType', DataType: 'Numeric', IsInteger: true, Scale: 0 } ]);
						Expect(tmpToDo).to.include({ Kind: 'Terms', Origin: 'Declared', FilterKey: 'IDLabFormType', ClauseType: 'DistinctSelectedValueList', CountMode: 'Rows', Exclude: 'Self', Relaxed: true, Semantics: 'NoVisibleMatch' });
						Expect(tmpToDo.OwnedFields).to.deep.equal([ 'IDLabFormType' ]);
						Expect(tmpToDo.LabelLookup).to.deep.equal({ Entity: 'LabFormType', KeyColumn: 'IDLabFormType', LabelColumn: 'Name' });
						Expect(plain(aggByKey(tmpPlan, 'Queue').Dimensions)).to.deep.equal(plain(
							[ {
								Kind: 'Column', Field: 'IDLabQueue', DataType: 'ID', IsInteger: true, Scale: 0, Alias: 'p',
								Via:
									[
										{ Rel: xRel('MaterialIntake', 'l1', 'Lookup', [ 'IDMaterialIntake', 'IDLabQueue' ]), On: [ xOn('p', 'IDMaterialIntake', 'IDMaterialIntake') ] },
										{ Rel: xRel('LabQueue', 'l2', 'Lookup', [ 'IDLabQueue' ]), On: [ xOn('l1', 'IDLabQueue', 'IDLabQueue') ] }
									]
							} ]));
						let tmpQueue = aggByKey(tmpPlan, 'Queue');
						Expect(tmpQueue).to.include({ Origin: 'Sibling', Field: 'IDLabQueue', ClauseType: null, FilterKey: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' });
						Expect(tmpQueue.OwnedFields).to.deep.equal([ '@path:>MaterialIntakeRequirement.IDMaterialIntake >MaterialIntake.IDLabQueue#IDLabQueue' ]);
						Expect(tmpQueue.Path).to.deep.equal([ '>MaterialIntakeRequirement.IDMaterialIntake', '>MaterialIntake.IDLabQueue' ]);
						Expect(tmpQueue.Definition.SiblingOf).to.equal('MaterialIntakeRequirement.MyFormsToDo');
						Expect(tmpQueue.LabelLookup).to.deep.equal({ Entity: 'LabQueue', KeyColumn: 'IDLabQueue', LabelColumn: 'Name' });
						Expect(plain(aggByKey(tmpPlan, 'Week').Dimensions)).to.deep.equal(plain(
							[ { Kind: 'DateBucket', Field: 'ReceivedDate', Interval: 'week', DataType: 'DateTime', Alias: 'p', Via: [ { Rel: xRel('MaterialIntake', 'l3', 'Lookup', [ 'IDMaterialIntake', 'ReceivedDate' ]), On: [ xOn('p', 'IDMaterialIntake', 'IDMaterialIntake') ] } ] } ]));
						Expect(aggByKey(tmpPlan, 'Week').ClauseType).to.equal('InternalJoinDateRange');
						Expect(plain(aggByKey(tmpPlan, 'Discipline').Dimensions)).to.deep.equal(plain(
							[ { Kind: 'Column', Field: 'Discipline', DataType: 'String', IsInteger: false, Scale: 0, Alias: 'p', Via: [ { Rel: xRel('LabFormType', 'l4', 'Lookup', [ 'IDLabFormType', 'Discipline' ]), On: [ xOn('p', 'IDLabFormType', 'IDLabFormType') ] } ] } ]));
						Expect(aggByKey(tmpPlan, 'Discipline').ClauseType).to.equal('InternalJoinMatch');
						let tmpStarted = aggByKey(tmpPlan, 'Started');
						Expect(plain(tmpStarted.Dimensions)).to.deep.equal(plain(
							[ {
								Kind: 'ExistsFlag',
								Pred: xExists(xRel('LabForm', 'e1', 'Hop', [ 'IDLabForm', 'IDLabFormType', 'IDMaterialIntake' ], lit('Status', 'NE', 'Complete'), { Stage: 'Allowed' }), [ xOn('p', 'IDMaterialIntake', 'IDMaterialIntake'), xOn('p', 'IDLabFormType', 'IDLabFormType') ]),
								DataType: 'Boolean', IsInteger: true, Scale: 0,
								// The declared split labels travel with the dimension (internal-contracts §29.2).
								Labels: { true: 'Started', false: 'Not started' }
							} ]));
						Expect(tmpStarted).to.include({ Kind: 'ExistsSplit', ClauseType: null, Field: null, Selectable: true });
						Expect(tmpStarted.OwnedFields).to.deep.equal([]);
						Expect(tmpStarted.Path).to.deep.equal([ '=LabForm.IDMaterialIntake' ]);
					});

				test('E3A: the cube carries the shared W_def as one flag every member requires; DepSet reaches every hop and lookup',
					() =>
					{
						let tmpPlan = plan(_Lab, fE3A());
						let tmpCube = tmpPlan.Cubes[0];
						let tmpToDo = aggByKey(tmpPlan, 'ToDo');
						Expect(tmpCube.Flags).to.deep.equal([]);
						Expect(tmpCube.WhereFlags.length).to.equal(1);
						Expect(tmpCube.WhereFlags[0].Flag).to.equal('w1');
						Expect(tmpCube.WhereFlags[0].WhereHash).to.equal(tmpToDo.WhereHash);
						Expect(tmpCube.WhereFlags[0].Where).to.equal(tmpToDo.Where);
						Expect(tmpCube.Members.map((pMember) => { return pMember.AggKey + ':' + pMember.Dims.join(',') + ':' + pMember.RequireWhere; })).to.deep.equal(
							[ 'ToDo:d1:w1', 'Queue:d2:w1', 'Week:d3:w1', 'Discipline:d4:w1', 'Started:d5:w1', '#Total::null' ]);
						Expect(tmpCube.Bounds).to.deep.equal([ { Lo: 'lo1', Hi: 'hi1', Dim: 'd3' } ]);
						Expect(tmpPlan.DepSet).to.deep.equal(
							{
								MaterialIntakeRequirement: [ 'Deleted', 'IDCustomer', 'IDLabFormType', 'IDMaterialIntake', 'IDMaterialIntakeRequirement' ],
								MaterialIntake: [ 'Deleted', 'IDCustomer', 'IDLabQueue', 'IDMaterialIntake', 'ReceivedDate', 'Status' ],
								LabQueue: [ 'Deleted', 'IDCustomer', 'IDLabQueue' ],
								LabQueueMember: [ 'Active', 'Deleted', 'IDCustomer', 'IDLabQueue', 'IDLabQueueMember', 'IDUser' ],
								LabForm: [ 'Deleted', 'IDCustomer', 'IDLabForm', 'IDLabFormType', 'IDMaterialIntake', 'OwnerIDUser', 'Status' ],
								LabFormType: [ 'Discipline', 'IDLabFormType' ]
							});
						Expect(tmpPlan.Entities).to.deep.equal([ 'LabForm', 'LabFormType', 'LabQueue', 'LabQueueMember', 'MaterialIntake', 'MaterialIntakeRequirement' ]);
					});

				// ---- E3 variant B

				let fE3B = (pFacets) =>
				{
					return newContext(_Lab, 'MaterialIntake', TECH,
						{ Facets: pFacets || [ { Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntake.FormsToDo/ByQueue' }, { Key: 'Week', Facet: 'MaterialIntake.FormsToDo/ByWeek' } ] });
				};

				test('E3B: the TuplePivot (Home side "p" carrying the client fence, other sides u<n>, side Where split col → Rel / path → Agg Where, correlation to a side)',
					() =>
					{
						let tmpPlan = plan(_Lab, fE3B());
						Expect(tmpPlan.Errors).to.deep.equal({});
						let tmpToDo = aggByKey(tmpPlan, 'ToDo');
						Expect(plain(tmpToDo.Tuple)).to.deep.equal(plain(
							{
								Sides:
									[
										{ Name: 'i', Alias: 'p', Rel: xRel('MaterialIntake', 'p', 'TupleSide', [ 'IDMaterialIntake', 'IDLabQueue', 'IDMaterialType' ], lit('Status', 'IN', [ 'Received', 'InProgress' ]), { Client: [] }) },
										{ Name: 'r', Alias: 'u1', Rel: xRel('MaterialTypeFormRequirement', 'u1', 'TupleSide', [ 'IDMaterialTypeFormRequirement', 'IDLabFormType', 'IDMaterialType' ], lit('Required', 'EQ', 1)) }
									],
								On: [ { Left: { Alias: 'p', Field: 'IDMaterialType' }, Right: { Alias: 'u1', Field: 'IDMaterialType' } } ],
								Key: [ { Alias: 'p', Field: 'IDMaterialIntake' }, { Alias: 'u1', Field: 'IDLabFormType' } ],
								Names: { i: 'p', r: 'u1' }
							}));
						Expect(plain(tmpToDo.Where)).to.deep.equal(plain(xAnd(
							xExists(xRel('LabQueue', 'j1', 'Hop', [ 'IDLabQueue' ], null), [ xOn('p', 'IDLabQueue', 'IDLabQueue') ],
								xExists(xRel('LabQueueMember', 'j2', 'Hop', [ 'IDLabQueueMember', 'IDLabQueue' ], and(lit('IDUser', 'EQ', 5), lit('Active', 'EQ', 1)), { Stage: 'Allowed' }), [ xOn('j1', 'IDLabQueue', 'IDLabQueue') ])),
							xNotExists(xRel('LabForm', 'j3', 'Hop', [ 'IDLabForm', 'IDLabFormType', 'IDMaterialIntake' ], lit('Status', 'EQ', 'Complete'), { Scope: 'TenantOnly', ScopeReason: TENANT_ONLY_B, Stage: 'Allowed' }),
								[ xOn('p', 'IDMaterialIntake', 'IDMaterialIntake'), xOn('u1', 'IDLabFormType', 'IDLabFormType') ]))));
						Expect(tmpToDo.Dimensions).to.deep.equal([ { Kind: 'Column', Field: 'IDLabFormType', DataType: 'Numeric', IsInteger: true, Scale: 0, Alias: 'u1' } ]);
						Expect(tmpToDo).to.include({ Kind: 'Terms', Pivot: 'MaterialIntake', CountMode: 'KeyDistinct', Exclude: 'None', ClauseType: null, FilterKey: 'MaterialIntake.FormsToDo', MultiValued: false, Relaxed: true });
						Expect(tmpToDo.OwnedFields).to.deep.equal([]);
						Expect(tmpToDo.Entities).to.deep.equal([ 'LabForm', 'LabQueue', 'LabQueueMember', 'MaterialIntake', 'MaterialTypeFormRequirement' ]);
					});

				test('E3B: siblings get their own tuple sides (plan-wide aliases), share the WhereHash and the Variant; TuplePivots are never cube members',
					() =>
					{
						let tmpPlan = plan(_Lab, fE3B());
						let tmpQueue = aggByKey(tmpPlan, 'Queue');
						let tmpWeek = aggByKey(tmpPlan, 'Week');
						Expect(tmpQueue.Tuple.Names).to.deep.equal({ i: 'p', r: 'u2' });
						Expect(tmpWeek.Tuple.Names).to.deep.equal({ i: 'p', r: 'u3' });
						Expect(tmpQueue.Dimensions).to.deep.equal([ { Kind: 'Column', Field: 'IDLabQueue', DataType: 'Numeric', IsInteger: true, Scale: 0, Alias: 'p' } ]);
						Expect(tmpWeek.Dimensions).to.deep.equal([ { Kind: 'DateBucket', Field: 'ReceivedDate', Interval: 'week', DataType: 'DateTime', Alias: 'p' } ]);
						// each Home side projects what ITS Agg reads (ReceivedDate only for ByWeek)
						Expect(aggByKey(tmpPlan, 'ToDo').Tuple.Sides[0].Rel.Project).to.deep.equal([ 'IDMaterialIntake', 'IDLabQueue', 'IDMaterialType' ]);
						Expect(tmpWeek.Tuple.Sides[0].Rel.Project).to.deep.equal([ 'IDMaterialIntake', 'IDLabQueue', 'IDMaterialType', 'ReceivedDate' ]);
						Expect(tmpWeek.Where.Items[1].On[1]).to.deep.equal(xOn('u3', 'IDLabFormType', 'IDLabFormType'));
						Expect(tmpQueue.WhereHash).to.equal(aggByKey(tmpPlan, 'ToDo').WhereHash);
						Expect(tmpQueue.VariantId).to.equal(aggByKey(tmpPlan, 'ToDo').VariantId);
						Expect(tmpPlan.Cubes).to.deep.equal([]);
						Expect(aggByKey(tmpPlan, 'ToDo').CubeId).to.equal(null);
						// a client clause on the Home entity lands in the Home side's fence
						let tmpFiltered = plan(_Lab, newContext(_Lab, 'MaterialIntake', TECH, { Facets: [ { Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo' } ], Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Priority', Values: [ 'High' ] } ] }));
						let tmpHome = aggByKey(tmpFiltered, 'ToDo').Tuple.Sides[0].Rel;
						Expect(tmpHome.Client.map((pConjunct) => { return pConjunct.Id; })).to.deep.equal([ 'c1' ]);
						Expect(aggByKey(tmpFiltered, 'ToDo').Tuple.Sides[1].Rel.Client).to.equal(null);
					});

				test('plan-wide unique aliases: no two distinct Rels share an alias across Variants and Aggs (E1, E3A, E3B and a mixed request)',
					() =>
					{
						let fCheck = (pPlan) =>
						{
							let tmpByAlias = new Map();
							let tmpForest = Object.keys(pPlan.Variants).map((pId) => { return pPlan.Variants[pId]; }).concat(pPlan.Aggs);
							libFoldIR.relationsOf(tmpForest).forEach(
								(pRel) =>
								{
									Expect(pRel.As).to.match(/^[a-eg-z][a-z0-9]{0,7}$/);
									if (pRel.As === 'p')
									{
										return;
									}
									if (tmpByAlias.has(pRel.As))
									{
										Expect(tmpByAlias.get(pRel.As), pRel.As).to.equal(pRel);
									}
									tmpByAlias.set(pRel.As, pRel);
								});
							return tmpByAlias.size;
						};
						Expect(fCheck(plan(_Project, fE1()))).to.equal(5);
						Expect(fCheck(plan(_Lab, fE3A()))).to.equal(9);
						Expect(fCheck(plan(_Lab, fE3B()))).to.equal(12);
						let tmpMixed = plan(_Lab, newContext(_Lab, 'MaterialIntake', TECH,
							{
								Scopes: [ { Scope: 'MaterialIntake.InMyQueues' } ],
								Facets:
									[
										{ Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo' }, { Key: 'ByForm', Facet: 'MaterialIntake.ByRequiredForm' },
										{ Key: 'Queue', Facet: 'MaterialIntake.FormsToDo/ByQueue' }, { Key: 'Status', Facet: 'MaterialIntake.Status' }
									]
							}));
						Expect(fCheck(tmpMixed)).to.be.above(8);
					});
			}
		);

		suite
		(
			'Every lowering row of §24.8 (and the dimension kinds of §24.3)',
			() =>
			{
				let _Project = null;
				let _Lab = null;
				suiteSetup(() => { _Project = newEnvironment('ProjectTrack'); _Lab = newEnvironment('LabTrack'); });
				setup(() => { _Project.authorizer.Denied.clear(); _Lab.authorizer.Denied.clear(); });

				let LEAD = { Tenant: 1, User: 7 };
				let TECH = { Tenant: 1, User: 5 };
				let fScopePlan = (pEnv, pEntity, pScopes, pWho, pFacets) => { return plan(pEnv, newContext(pEnv, pEntity, pWho || LEAD, { Facets: pFacets || [], Scopes: pScopes })); };
				let fFacetPlan = (pEnv, pEntity, pFacets, pWho, pBody) => { return plan(pEnv, newContext(pEnv, pEntity, pWho || LEAD, Object.assign({ Facets: pFacets }, pBody || {}))); };
				let fAddScope = (pEnv, pScope) => { pEnv.registry.Scopes.set(pScope.Scope, Object.assign({ Params: {}, Relaxed: false, Supported: true, Unsupported: null, DefinitionHash: 'dh:x', Source: '#test', Binds: [] }, pScope)); };

				test('Exists over a multi-hop path: one nested Exists per step, the Where on the innermost Rel (K10, Document.InMyProjects)',
					() =>
					{
						let tmpPlan = fScopePlan(_Project, 'Document', [ { Scope: 'Document.InMyProjects' } ]);
						Expect(plain(tmpPlan.Lowered.c1)).to.deep.equal(plain(
							xExists(xRel('Project', 'h1', 'Hop', [ 'IDProject' ], null), [ xOn('p', 'IDProject', 'IDProject') ],
								xExists(xRel('ProjectMembership', 'h2', 'Hop', [ 'IDProjectMembership', 'IDProject' ], and(lit('IDUser', 'EQ', 7), lit('Active', 'EQ', 1)), { Stage: 'Allowed' }), [ xOn('h1', 'IDProject', 'IDProject') ]))));
						Expect(plain(tmpPlan.Variants.v0.PathPred)).to.deep.equal(plain(tmpPlan.Lowered.c1));
						Expect(tmpPlan.Variants.v0.ColumnConjuncts).to.deep.equal([]);
						Expect(Object.keys(tmpPlan.DepSet).sort()).to.deep.equal([ 'Document', 'Project', 'ProjectMembership' ]);
						Expect(tmpPlan.DepSet.Document).to.deep.equal([ 'Deleted', 'IDCustomer', 'IDDocument', 'IDProject' ]);
					});

				test('NotExists over a multi-hop path: only the OUTERMOST node negates ("no visible chain"); step Wheres split col / path per hop',
					() =>
					{
						let tmpPath = pathPlan(_Project.graph, 'Document', [ { Step: '>Document.IDProject', Where: lit('Status', 'NE', 'Done') }, '<ProjectMembership.IDProject' ]);
						fAddScope(_Project, { Scope: 'Document.NotMine', Entity: 'Document', Entities: [ 'Document', 'Project', 'ProjectMembership' ], Where: notExistsC(tmpPath, tok('IDUser', 'EQ', '$CurrentUser.IDUser')) });
						let tmpPlan = fScopePlan(_Project, 'Document', [ { Scope: 'Document.NotMine' } ]);
						Expect(plain(tmpPlan.Lowered.c1)).to.deep.equal(plain(
							xNotExists(xRel('Project', 'h1', 'Hop', [ 'IDProject' ], lit('Status', 'NE', 'Done')), [ xOn('p', 'IDProject', 'IDProject') ],
								xExists(xRel('ProjectMembership', 'h2', 'Hop', [ 'IDProjectMembership', 'IDProject' ], lit('IDUser', 'EQ', 7), { Stage: 'Allowed' }), [ xOn('h1', 'IDProject', 'IDProject') ]))));
					});

				test('a co-reference with CheckParent: the parent is an Exists inside the co-reference node, correlated to its FK (01 §4.5)',
					() =>
					{
						let tmpPath = pathPlan(_Lab.graph, 'MaterialIntakeRequirement', [ { Step: '=LabForm.IDMaterialIntake', CheckParent: true } ]);
						fAddScope(_Lab, { Scope: 'MaterialIntakeRequirement.NoCompleteForm', Entity: 'MaterialIntakeRequirement', Entities: [ 'LabForm', 'MaterialIntake', 'MaterialIntakeRequirement' ],
							Where: notExistsC(tmpPath, lit('Status', 'EQ', 'Complete'), [ correlate(null, 'IDLabFormType', 'IDLabFormType') ]) });
						let tmpPlan = fScopePlan(_Lab, 'MaterialIntakeRequirement', [ { Scope: 'MaterialIntakeRequirement.NoCompleteForm' } ], TECH);
						Expect(plain(tmpPlan.Lowered.c1)).to.deep.equal(plain(
							xNotExists(xRel('LabForm', 'h1', 'Hop', [ 'IDLabForm', 'IDLabFormType', 'IDMaterialIntake' ], lit('Status', 'EQ', 'Complete')),
								[ xOn('p', 'IDMaterialIntake', 'IDMaterialIntake'), xOn('p', 'IDLabFormType', 'IDLabFormType') ],
								xExists(xRel('MaterialIntake', 'h2', 'Parent', [ 'IDMaterialIntake' ], null, { Stage: 'Allowed' }), [ xOn('h1', 'IDMaterialIntake', 'IDMaterialIntake') ]))));
						// the parent entity is gated with the scope (an unreadable parent fails the request)
						_Lab.authorizer.Denied.add('MaterialIntake');
						Expect(facetError(() => { fScopePlan(_Lab, 'MaterialIntakeRequirement', [ { Scope: 'MaterialIntakeRequirement.NoCompleteForm' } ], TECH); }).Code).to.equal('FACET_FORBIDDEN');
					});

				test('HavingCount → CountCmp (K19, Project.ManyOverdue); a multi-step HavingCount is refused (422 HavingCountPath)',
					() =>
					{
						let tmpPlan = fScopePlan(_Project, 'Project', [ { Scope: 'Project.ManyOverdue' } ]);
						Expect(plain(tmpPlan.Lowered.c1)).to.deep.equal(plain(
							{ Node: 'CountCmp', Rel: xRel('Task', 'h1', 'Hop', [ 'IDTask', 'IDProject' ], and(lit('DueDate', 'LT', TEST_NOW_CANONICAL), lit('Status', 'NE', 'Done'))), On: [ xOn('p', 'IDProject', 'IDProject') ], Where: null, Op: 'GE', N: 2 }));
						fAddScope(_Project, { Scope: 'Document.ManyMembers', Entity: 'Document', Entities: [ 'Document', 'Project', 'ProjectMembership' ],
							Where: { HavingCount: { From: null, Path: pathPlan(_Project.graph, 'Document', [ '>Document.IDProject', '<ProjectMembership.IDProject' ]), Where: null, Correlate: [], Op: 'GE', Value: 3 } } });
						let tmpRefused = runPlan(_Project, newContext(_Project, 'Document', LEAD, { Facets: [], Scopes: [ { Scope: 'Document.ManyMembers' } ] }));
						Expect(tmpRefused.Error.Code).to.equal('FACET_FOLD_UNSUPPORTED');
						Expect(tmpRefused.Error.Detail).to.deep.equal({ Feature: 'HavingCountPath', Milestone: 2 });
					});

				test('Stage: Allowed only for a leaf existence Rel (no nested Where) whose inner On columns are integers',
					() =>
					{
						// a co-reference correlated on a String column: never staged
						let tmpPath = pathPlan(_Lab.graph, 'MaterialIntakeRequirement', [ '=LabForm.IDMaterialIntake' ]);
						fAddScope(_Lab, { Scope: 'MaterialIntakeRequirement.SameStatus', Entity: 'MaterialIntakeRequirement', Entities: [ 'LabForm', 'MaterialIntakeRequirement' ], Where: existsC(tmpPath, null, [ correlate(null, 'IDLabFormType', 'Status') ]) });
						let tmpPlan = fScopePlan(_Lab, 'MaterialIntakeRequirement', [ { Scope: 'MaterialIntakeRequirement.SameStatus' } ], TECH);
						Expect(tmpPlan.Lowered.c1.Rel.Stage).to.equal('Never');
						// a hop with a nested Where never stages; its leaf does
						let tmpE3A = fScopePlan(_Lab, 'MaterialIntakeRequirement', [ { Scope: 'MaterialIntakeRequirement.ToDoForMe' } ], TECH);
						let tmpChain = tmpE3A.Lowered.c1.Items[0];
						Expect([ tmpChain.Rel.Stage, tmpChain.Where.Rel.Stage, tmpChain.Where.Where.Rel.Stage ]).to.deep.equal([ 'Never', 'Never', 'Allowed' ]);
					});

				test('K8: a to-one dimension path is a Via chain of Lookup Rels (two hops, Document.ByClient); the value is read from the LAST link',
					() =>
					{
						let tmpPlan = fFacetPlan(_Project, 'Document', [ { Key: 'ByClient', Facet: 'Document.ByClient' } ]);
						let tmpAgg = aggByKey(tmpPlan, 'ByClient');
						Expect(plain(tmpAgg.Dimensions)).to.deep.equal(plain(
							[ {
								Kind: 'Column', Field: 'IDClient', DataType: 'ID', IsInteger: true, Scale: 0, Alias: 'p',
								Via:
									[
										{ Rel: xRel('Project', 'l1', 'Lookup', [ 'IDProject', 'IDClient' ]), On: [ xOn('p', 'IDProject', 'IDProject') ] },
										{ Rel: xRel('Client', 'l2', 'Lookup', [ 'IDClient' ]), On: [ xOn('l1', 'IDClient', 'IDClient') ] }
									]
							} ]));
						Expect(tmpAgg).to.include({ Kind: 'Terms', Field: 'IDClient', Top: 20, ClauseType: null, FilterKey: 'Document.ByClient', CountMode: 'Rows', MultiValued: false, Exclude: 'Self' });
						Expect(tmpAgg.OwnedFields).to.deep.equal([ '@path:>Document.IDProject >Project.IDClient#IDClient' ]);
						Expect(tmpAgg.LabelLookup).to.deep.equal({ Entity: 'Client', KeyColumn: 'IDClient', LabelColumn: 'Name' });
						Expect(tmpAgg.Path).to.deep.equal([ '>Document.IDProject', '>Project.IDClient' ]);
						Expect(tmpAgg.DepSet).to.deep.equal({ Document: [ 'Deleted', 'IDCustomer', 'IDDocument', 'IDProject' ], Project: [ 'Deleted', 'IDClient', 'IDCustomer', 'IDProject' ], Client: [ 'Deleted', 'IDClient', 'IDCustomer' ] });
						// Labels: false drops the label lookup
						Expect(aggByKey(fFacetPlan(_Project, 'Document', [ { Key: 'ByClient', Facet: 'Document.ByClient', Labels: false } ]), 'ByClient').LabelLookup).to.equal(null);
						// an unreadable hop of the dimension fails the facet only (403, no Detail)
						_Project.authorizer.Denied.add('Client');
						let tmpDenied = fFacetPlan(_Project, 'Document', [ { Key: 'ByClient', Facet: 'Document.ByClient' }, { Key: 'Status', Facet: 'Document.Status' } ]);
						Expect(tmpDenied.Errors.ByClient).to.deep.equal({ Code: 'FACET_FORBIDDEN', Status: 403, Message: 'Forbidden.' });
						Expect(aggByKey(tmpDenied, 'Status').Kind).to.equal('Terms');
					});

				test('a facet whose entities the principal may not read declares no params: its top-level Params read as Unknown (like a nonexistent facet)',
					() =>
					{
						let tmpWithParams = Object.assign({}, _Project.registry.facet('Document.ByClient'), { Facet: 'Document.ByClientParam', Params: { Min: { Type: 'Integer' } } });
						_Project.registry.Facets.set('Document.ByClientParam', tmpWithParams);
						let tmpFacets = [ { Key: 'ByClient', Facet: 'Document.ByClientParam' }, { Key: 'Status', Facet: 'Document.Status' } ];
						Expect(fFacetPlan(_Project, 'Document', tmpFacets, null, { Params: { Min: 3 } }).Errors).to.deep.equal({});
						_Project.authorizer.Denied.add('Client');
						let tmpError = facetError(() => { fFacetPlan(_Project, 'Document', tmpFacets, null, { Params: { Min: 3 } }); });
						let tmpNonexistent = facetError(() => { fFacetPlan(_Project, 'Document', [ { Key: 'ByClient', Facet: 'Document.NoSuchFacet' }, tmpFacets[1] ], null, { Params: { Min: 3 } }); });
						// Without the params the facet itself is the per-facet 403.
						let tmpPerFacet = fFacetPlan(_Project, 'Document', tmpFacets);
						_Project.authorizer.Denied.delete('Client');
						_Project.registry.Facets.delete('Document.ByClientParam');
						Expect(tmpError).to.include({ Code: 'FACET_PARAM_INVALID', Status: 400 });
						Expect(tmpError.Detail).to.deep.equal({ Param: 'Min', Reason: 'Unknown' });
						Expect(tmpError.Detail).to.deep.equal(tmpNonexistent.Detail);
						Expect(tmpPerFacet.Errors.ByClient).to.deep.equal({ Code: 'FACET_FORBIDDEN', Status: 403, Message: 'Forbidden.' });
					});

				test('K8: a step Where joins the Lookup Rel (column part); identical Via chains are shared (the cube de-duplicates them)',
					() =>
					{
						let tmpPath = pathPlan(_Project.graph, 'Task', [ { Step: '>Task.IDProject', Where: lit('Status', 'NE', 'Done') } ]);
						_Project.registry.Facets.set('Task.OpenProjectStart', canonicalFacet(
							{
								Facet: 'Task.OpenProjectStart', Entity: 'Task', Fold: 'DateHistogram', FilterKey: 'Task.OpenProjectStart', Entities: [ 'Project', 'Task' ],
								Dimensions: [ canonicalDim({ Kind: 'DateHistogram', Path: tmpPath, PathShape: 'ToOne', Field: 'StartDate', Interval: 'quarter', DataType: 'DateTime', IsInteger: false, Scale: 0 }) ]
							}));
						let tmpPlan = fFacetPlan(_Project, 'Task', [ { Key: 'A', Facet: 'Task.OpenProjectStart' }, { Key: 'B', Facet: 'Task.OpenProjectStart', Interval: 'year' }, { Key: 'C', Facet: 'Task.OpenProjectStart' } ]);
						let tmpA = aggByKey(tmpPlan, 'A');
						Expect(plain(tmpA.Dimensions[0].Via)).to.deep.equal(plain([ { Rel: xRel('Project', 'l1', 'Lookup', [ 'IDProject', 'StartDate' ], lit('Status', 'NE', 'Done')), On: [ xOn('p', 'IDProject', 'IDProject') ] } ]));
						Expect(tmpA.Dimensions[0].Interval).to.equal('quarter');
						Expect(aggByKey(tmpPlan, 'B').Dimensions[0].Interval).to.equal('year');
						Expect(aggByKey(tmpPlan, 'B').Dimensions[0].Via).to.equal(tmpA.Dimensions[0].Via);
						// A step Where narrows which Project rows count: no join clause carries it, so the bucket
						// has no Clause (Selection only), never one that selects more rows than it counted.
						Expect(tmpA.ClauseType).to.equal(null);
						// A and C have equal dimensions: one cube column for both; B differs by interval
						Expect(tmpPlan.Cubes[0].Dims.map((pDim) => { return pDim.Members; })).to.deep.equal([ [ 'A', 'C' ], [ 'B' ] ]);
						// a path predicate inside a lookup step's Where is refused per facet
						let tmpBadPath = pathPlan(_Project.graph, 'Task', [ { Step: '>Task.IDProject', Where: existsC(pathPlan(_Project.graph, 'Project', [ '<Issue.IDProject' ]), null) } ]);
						_Project.registry.Facets.set('Task.Bad', canonicalFacet({ Facet: 'Task.Bad', Entity: 'Task', Fold: 'Terms', Entities: [ 'Issue', 'Project', 'Task' ], Dimensions: [ canonicalDim({ Kind: 'Terms', Path: tmpBadPath, PathShape: 'ToOne', Field: 'Status', DataType: 'String', IsInteger: false, Scale: 0 }) ] }));
						let tmpBad = fFacetPlan(_Project, 'Task', [ { Key: 'Bad', Facet: 'Task.Bad' } ]);
						Expect(tmpBad.Errors.Bad.Code).to.equal('FACET_FOLD_UNSUPPORTED');
					});

				test('K9: a to-many dimension path is a Multi chain (PivotDistinct, MultiValued); the dimension Where joins the last Rel',
					() =>
					{
						let tmpPlan = fFacetPlan(_Project, 'Project', [ { Key: 'ByMember', Facet: 'Project.ByMember' } ]);
						let tmpAgg = aggByKey(tmpPlan, 'ByMember');
						Expect(plain(tmpAgg.Dimensions)).to.deep.equal(plain(
							[ { Kind: 'Multi', Chain: [ { Rel: xRel('ProjectMembership', 'm1', 'Multi', [ 'IDProjectMembership', 'IDProject', 'IDUser' ], lit('Active', 'EQ', 1)), On: [ xOn('p', 'IDProject', 'IDProject') ] } ], Where: null, KeyField: 'IDUser', DataType: 'Numeric', IsInteger: true, Scale: 0 } ]));
						Expect(tmpAgg).to.include({ Kind: 'Terms', Field: 'IDUser', CountMode: 'PivotDistinct', MultiValued: true, Top: 25, ClauseType: null });
						Expect(tmpAgg.OwnedFields).to.deep.equal([ '@path:<ProjectMembership.IDProject#IDUser' ]);
						// multi-valued facets are never cube members
						Expect(tmpAgg.CubeId).to.equal(null);
					});

				test('K9 through the synthetic bridge alias (two steps, <J.a >J.b ending at the target key → ExternalJoinSelectedValueList buckets)',
					() =>
					{
						let tmpPlan = fFacetPlan(_Lab, 'MaterialIntake', [ { Key: 'ByForm', Facet: 'MaterialIntake.ByRequiredForm' } ], TECH);
						let tmpAgg = aggByKey(tmpPlan, 'ByForm');
						Expect(plain(tmpAgg.Dimensions)).to.deep.equal(plain(
							[ {
								Kind: 'Multi',
								Chain:
									[
										{ Rel: xRel('MaterialIntakeRequirement', 'm1', 'Multi', [ 'IDMaterialIntakeRequirement', 'IDLabFormType', 'IDMaterialIntake' ]), On: [ xOn('p', 'IDMaterialIntake', 'IDMaterialIntake') ] },
										{ Rel: xRel('LabFormType', 'm2', 'Multi', [ 'IDLabFormType' ]), On: [ xOn('m1', 'IDLabFormType', 'IDLabFormType') ] }
									],
								Where: null, KeyField: 'IDLabFormType', DataType: 'ID', IsInteger: true, Scale: 0
							} ]));
						Expect(tmpAgg.ClauseType).to.equal('ExternalJoinSelectedValueList');
						Expect(tmpAgg.OwnedFields).to.deep.equal([ '@path:<MaterialIntakeRequirement.IDMaterialIntake >MaterialIntakeRequirement.IDLabFormType#IDLabFormType' ]);
						// a K9 dimension Where holding an existence node: the column part joins the last Rel, the path part becomes Multi.Where
						let tmpPath = pathPlan(_Project.graph, 'Project', [ '<ProjectMembership.IDProject' ]);
						_Project.registry.Facets.set('Project.ByBusyMember', canonicalFacet(
							{
								Facet: 'Project.ByBusyMember', Entity: 'Project', Fold: 'Terms', CountMode: 'PivotDistinct', FilterKey: 'Project.ByBusyMember', Entities: [ 'Project', 'ProjectMembership', 'Task' ],
								Dimensions: [ canonicalDim({ Kind: 'Terms', Path: tmpPath, PathShape: 'ToMany', KeyField: 'IDUser', DataType: 'Numeric', IsInteger: true, Scale: 0,
									Where: and(lit('Active', 'EQ', 1), existsC(pathPlan(_Project.graph, 'ProjectMembership', [ '>ProjectMembership.IDProject', '<Task.IDProject' ]), lit('Status', 'NE', 'Done'))) }) ]
							}));
						let tmpBusy = aggByKey(fFacetPlan(_Project, 'Project', [ { Key: 'Busy', Facet: 'Project.ByBusyMember' } ]), 'Busy');
						Expect(plain(tmpBusy.Dimensions[0].Chain[0].Rel.Where)).to.deep.equal(lit('Active', 'EQ', 1));
						Expect(plain(tmpBusy.Dimensions[0].Where)).to.deep.equal(plain(
							xExists(xRel('Project', 'm2', 'Hop', [ 'IDProject' ], null), [ xOn('m1', 'IDProject', 'IDProject') ],
								xExists(xRel('Task', 'm3', 'Hop', [ 'IDTask', 'IDProject' ], lit('Status', 'NE', 'Done'), { Stage: 'Allowed' }), [ xOn('m2', 'IDProject', 'IDProject') ]))));
					});

				test('K20: an ExistsSplit dimension is an ExistsFlag over an Exists lowered at "p" with "e" hops (Project.HasOpenIssues)',
					() =>
					{
						let tmpPlan = fFacetPlan(_Project, 'Project', [ { Key: 'Open', Facet: 'Project.HasOpenIssues' } ]);
						let tmpAgg = aggByKey(tmpPlan, 'Open');
						Expect(plain(tmpAgg.Dimensions)).to.deep.equal(plain(
							[ { Kind: 'ExistsFlag', Pred: xExists(xRel('Issue', 'e1', 'Hop', [ 'IDIssue', 'IDProject' ], lit('State', 'EQ', 'Open'), { Stage: 'Allowed' }), [ xOn('p', 'IDProject', 'IDProject') ]), DataType: 'Boolean', IsInteger: true, Scale: 0, Labels: { true: 'Has open issues', false: 'No open issues' } } ]));
						Expect(tmpAgg).to.include({ Kind: 'ExistsSplit', Exclude: 'None', Selectable: true, Semantics: 'NoVisibleMatch', ClauseType: null });
					});

				test('a definition Where (W_def) is the Agg Where, never excluded; its column leaves stay Cmp; facets group by WhereHash',
					() =>
					{
						_Project.registry.Facets.set('Project.ActiveByClient', canonicalFacet(
							{
								Facet: 'Project.ActiveByClient', Entity: 'Project', Fold: 'Terms', FilterKey: 'IDClient', Entities: [ 'Project' ],
								Where: lit('Status', 'EQ', 'Active'),
								Dimensions: [ canonicalDim({ Kind: 'Terms', Field: 'IDClient', DataType: 'Numeric', IsInteger: true, Scale: 0 }) ]
							}));
						let tmpPlan = fFacetPlan(_Project, 'Project', [ { Key: 'A', Facet: 'Project.ActiveByClient' }, { Key: 'B', Facet: 'Project.IDClient' } ], LEAD,
							{ Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'IDClient', Values: [ 3 ], Hash: 'cl' }, { Type: 'DistinctSelectedValueList', FilterByColumn: 'Name', Values: [ 'X' ] } ] });
						let tmpA = aggByKey(tmpPlan, 'A');
						Expect(tmpA.Where).to.deep.equal(xCmp('p', 'Status', 'EQ', 'Active'));
						Expect(tmpA.WhereHash).to.equal(wh(lit('Status', 'EQ', 'Active')));
						// both exclude their own IDClient clause; only the W_def separates their Variants
						Expect(tmpPlan.Variants[tmpA.VariantId].Hash).to.equal('c2|' + tmpA.WhereHash);
						Expect(tmpPlan.Variants[aggByKey(tmpPlan, 'B').VariantId].Hash).to.equal('c2');
						Expect(tmpPlan.Variants[tmpA.VariantId].Where).to.equal(tmpA.Where);
						Expect(tmpA.SelectedKeys).to.deep.equal([ 3 ]);
						// the cube: A requires the w flag and both conjunct flags it keeps
						let tmpCube = tmpPlan.Cubes[0];
						Expect(tmpCube.WhereFlags.map((pFlag) => { return pFlag.Flag + ':' + pFlag.WhereHash; })).to.deep.equal([ 'w1:' + tmpA.WhereHash ]);
						Expect(tmpCube.Members.find((pMember) => { return pMember.AggKey === 'A'; })).to.deep.equal({ AggKey: 'A', Dims: [ 'd1' ], RequireFlags: [], RequireWhere: 'w1' });
						Expect(tmpCube.Members.find((pMember) => { return pMember.AggKey === 'B'; })).to.deep.equal({ AggKey: 'B', Dims: [ 'd1' ], RequireFlags: [], RequireWhere: null });
						Expect(tmpCube.Flags.map((pFlag) => { return pFlag.ConjunctId; })).to.deep.equal([ 'c1' ]);
						Expect(tmpCube.Common).to.deep.equal([ 'c2' ]);
					});

				test('PathAuto facets (K8 one hop, synthesized by the registry): folds, request overrides, clause types; a pivot axis may be a PathAuto facet',
					() =>
					{
						let tmpPlan = fFacetPlan(_Project, 'Task', [ { Key: 'PS', Facet: 'Task.IDProject>Project.Status', Top: 5 }, { Key: 'PD', Facet: 'Task.IDProject>Project.StartDate', Interval: 'year' } ]);
						let tmpStatus = aggByKey(tmpPlan, 'PS');
						// both facets walk the same hop: one shared Lookup Rel projecting both columns
						Expect(plain(tmpStatus.Dimensions)).to.deep.equal(plain([ { Kind: 'Column', Field: 'Status', DataType: 'String', IsInteger: false, Scale: 0, Alias: 'p', Via: [ { Rel: xRel('Project', 'l1', 'Lookup', [ 'IDProject', 'StartDate', 'Status' ]), On: [ xOn('p', 'IDProject', 'IDProject') ] } ] } ]));
						Expect(aggByKey(tmpPlan, 'PD').Dimensions[0].Via).to.equal(tmpStatus.Dimensions[0].Via);
						Expect(tmpStatus).to.include({ Origin: 'PathAuto', Definition: null, Top: 5, ClauseType: 'InternalJoinMatch', FilterKey: 'Task.IDProject>Project.Status' });
						Expect(aggByKey(tmpPlan, 'PD').Dimensions[0].Interval).to.equal('year');
						Expect(aggByKey(tmpPlan, 'PD').ClauseType).to.equal('InternalJoinDateRange');
						// a fold the PathAuto facet does not offer
						let tmpFold = fFacetPlan(_Project, 'Task', [ { Key: 'PS', Facet: 'Task.IDProject>Project.Status', Fold: 'DateHistogram' } ]);
						Expect(tmpFold.Errors.PS.Code).to.equal('FACET_UNKNOWN_FOLD');
						// a 2-D pivot with a PathAuto axis (axes may carry Via)
						let tmpPivot = aggByKey(fFacetPlan(_Project, 'Task', [ { Key: 'X', Facet: [ 'Task.Status', 'Task.IDProject>Project.Status' ], Fold: 'Pivot' } ]), 'X');
						Expect(plain(tmpPivot.Dimensions)).to.deep.equal(plain(
							[
								{ Kind: 'Column', Field: 'Status', DataType: 'String', IsInteger: false, Scale: 0 },
								{ Kind: 'Column', Field: 'Status', DataType: 'String', IsInteger: false, Scale: 0, Alias: 'p', Via: [ { Rel: xRel('Project', 'l1', 'Lookup', [ 'IDProject', 'Status' ]), On: [ xOn('p', 'IDProject', 'IDProject') ] } ] }
							]));
						Expect(tmpPivot).to.include({ Kind: 'Pivot', FacetID: 'Task.Status|Task.IDProject>Project.Status', Origin: 'PathAuto', Exclude: 'None', Selectable: false });
						Expect(tmpPivot.OwnedFields).to.deep.equal([ '@path:>Task.IDProject#Status', 'Status' ]);
						// a declared facet is never a request pivot axis
						let tmpDeclaredAxis = fFacetPlan(_Project, 'Project', [ { Key: 'Y', Facet: [ 'Project.Status', 'Project.ByMember' ], Fold: 'Pivot' } ]);
						Expect(tmpDeclaredAxis.Errors.Y.Code).to.equal('FACET_FOLD_UNSUPPORTED');
					});

				test('bucket clauses of path facets (§29.3) compile back into conjuncts the facet owns, so a selection is excluded by its own facet only',
					() =>
					{
						let tmpClauses =
							[
								// K8 one hop, Terms on a non-key column → InternalJoinMatch (ExactMatch)
								{ Type: 'InternalJoinMatch', RemoteTable: 'LabFormType', JoinInternalConnectionColumn: 'IDLabFormType', JoinExternalConnectionColumn: 'IDLabFormType', ExternalFilterByColumns: [ 'Discipline' ], ExactMatch: true, Values: [ 'Chemistry' ], FilterKey: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline', ClauseKey: 'InternalJoinMatch', Hash: 'disc' },
								// K8 one hop, DateHistogram → InternalJoinDateRange
								{ Type: 'InternalJoinDateRange', RemoteTable: 'MaterialIntake', JoinInternalConnectionColumn: 'IDMaterialIntake', JoinExternalConnectionColumn: 'IDMaterialIntake', ExternalFilterByColumns: [ 'ReceivedDate' ], Values: { Start: '2026-03-02 00:00:00', End: '2026-03-09 00:00:00' }, EndExclusive: true, FilterKey: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek', ClauseKey: 'InternalJoinDateRange', Hash: 'week' }
							];
						let tmpPlan = fFacetPlan(_Lab, 'MaterialIntakeRequirement',
							[ { Key: 'Discipline', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' }, { Key: 'Week', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek' }, { Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' } ], TECH, { Clauses: tmpClauses });
						let tmpConjuncts = tmpPlan.Variants.v0.Conjuncts;
						Expect(tmpConjuncts[0].Fields).to.deep.equal(aggByKey(tmpPlan, 'Discipline').OwnedFields);
						Expect(tmpConjuncts[1].Fields).to.deep.equal(aggByKey(tmpPlan, 'Week').OwnedFields);
						Expect(plain(tmpConjuncts[1].Pred.Exists.Where)).to.deep.equal(plain(and(lit('ReceivedDate', 'GE', '2026-03-02'), lit('ReceivedDate', 'LT', '2026-03-09'))));
						Expect(aggByKey(tmpPlan, 'Discipline').Disjunctive.Excluded).to.deep.equal([ 'c1' ]);
						Expect(aggByKey(tmpPlan, 'Week').Disjunctive.Excluded).to.deep.equal([ 'c2' ]);
						Expect(aggByKey(tmpPlan, 'ToDo').Disjunctive.Excluded).to.deep.equal([]);
						// K9 through the bridge → ExternalJoinSelectedValueList
						let tmpBridge = fFacetPlan(_Lab, 'MaterialIntake', [ { Key: 'ByForm', Facet: 'MaterialIntake.ByRequiredForm' }, { Key: 'Status', Facet: 'MaterialIntake.Status' } ], TECH,
							{
								Clauses:
									[ {
										Type: 'ExternalJoinSelectedValueList', CoreConnectionColumn: 'IDMaterialIntake', JoinTable: 'MaterialIntakeRequirement', JoinTableCoreConnectionColumn: 'IDMaterialIntake',
										JoinTableExternalConnectionColumn: 'IDLabFormType', ExternalFilterByTable: 'LabFormType', ExternalFilterByTableConnectionColumn: 'IDLabFormType',
										ExternalFilterTableLookupColumn: 'IDLabFormType', Values: [ 3 ], FilterKey: 'MaterialIntake.ByRequiredForm', ClauseKey: 'ExternalJoinSelectedValueList', Hash: 'form'
									} ]
							});
						Expect(tmpBridge.Variants.v0.Conjuncts[0].Fields).to.deep.equal(aggByKey(tmpBridge, 'ByForm').OwnedFields);
						Expect(aggByKey(tmpBridge, 'ByForm').Disjunctive.Excluded).to.deep.equal([ 'c1' ]);
						Expect(aggByKey(tmpBridge, 'Status').Disjunctive.Excluded).to.deep.equal([]);
					});

				test('a declared 2-D facet is a Pivot over its declared dimensions (Via allowed; Multi / ChildAgg / ExistsFlag axes refused)',
					() =>
					{
						_Project.registry.Facets.set('Project.StatusByClientName', canonicalFacet(
							{
								Facet: 'Project.StatusByClientName', Entity: 'Project', Fold: 'Pivot', Exclude: 'None', Entities: [ 'Client', 'Project' ],
								Dimensions:
									[
										canonicalDim({ Kind: 'Terms', Field: 'Status', DataType: 'String', IsInteger: false, Scale: 0 }),
										canonicalDim({ Kind: 'Terms', Path: pathPlan(_Project.graph, 'Project', [ '>Project.IDClient' ]), PathShape: 'ToOne', Field: 'Name', DataType: 'String', IsInteger: false, Scale: 0 })
									]
							}));
						let tmpAgg = aggByKey(fFacetPlan(_Project, 'Project', [ { Key: 'P', Facet: 'Project.StatusByClientName' } ]), 'P');
						Expect(tmpAgg.Kind).to.equal('Pivot');
						Expect(tmpAgg.Dimensions.map((pDim) => { return pDim.Kind + ':' + pDim.Field + ':' + (pDim.Via ? pDim.Via.length : 0); })).to.deep.equal([ 'Column:Status:0', 'Column:Name:1' ]);
						Expect(tmpAgg.OwnedFields).to.deep.equal([ '@path:>Project.IDClient#Name', 'Status' ]);
						Expect(tmpAgg.Field).to.equal(null);
						Expect(tmpAgg.CubeId).to.equal('cube0');
						_Project.registry.Facets.set('Project.BadPivot', canonicalFacet(
							{
								Facet: 'Project.BadPivot', Entity: 'Project', Fold: 'Pivot', Exclude: 'None', Entities: [ 'Project', 'ProjectMembership' ],
								Dimensions: [ canonicalDim({ Kind: 'Terms', Field: 'Status', DataType: 'String', IsInteger: false, Scale: 0 }), _Project.registry.facet('Project.ByMember').Dimensions[0] ]
							}));
						let tmpBad = fFacetPlan(_Project, 'Project', [ { Key: 'B', Facet: 'Project.BadPivot' } ]);
						Expect(tmpBad.Errors.B.Code).to.equal('FACET_FOLD_UNSUPPORTED');
					});
			}
		);

		suite
		(
			'Planner: resolution, per-facet gates, params, failures (internal-contracts §19.6, §20.8, §22.3)',
			() =>
			{
				let _Project = null;
				suiteSetup(() => { _Project = newEnvironment('ProjectTrack'); });
				setup(() => { _Project.authorizer.Denied.clear(); });

				let LEAD = { Tenant: 1, User: 7 };
				let fPlan = (pBody, pWho, pInternal) => { return runPlan(_Project, newContext(_Project, 'Project', pWho || LEAD, pBody, pInternal)); };

				test('FacetID resolution: Auto (registry first, then the catalog), Declared, Path; another entity / unknown / disabled → 400 per facet',
					() =>
					{
						let tmpResult = fPlan(
							{
								Facets:
									[
										{ Key: 'Auto', Facet: 'Project.Status' },
										{ Key: 'DeclaredByAutoName', Facet: 'Project.MyOverdueBand' },
										{ Key: 'UnknownDeclared', Facet: 'Project.Nope/Sib' },
										{ Key: 'UnknownAuto', Facet: 'Project.Nope' },
										{ Key: 'OtherEntity', Facet: 'Document.ByClient' },
										{ Key: 'OtherEntityPath', Facet: 'Task.IDProject>Project.Status' },
										{ Key: 'UnknownPath', Facet: 'Project.IDClient>Client.Name' }
									]
							});
						Expect(tmpResult.Error).to.equal(null);
						Expect(tmpResult.Plan.Aggs.map((pAgg) => { return pAgg.Key; })).to.deep.equal([ 'Auto', 'DeclaredByAutoName', '#Total' ]);
						Expect(aggByKey(tmpResult.Plan, 'DeclaredByAutoName').Kind).to.equal('ChildRollup');
						[ 'UnknownDeclared', 'UnknownAuto', 'OtherEntity', 'OtherEntityPath', 'UnknownPath' ].forEach(
							(pKey) =>
							{
								Expect(tmpResult.Plan.Errors[pKey].Code, pKey).to.equal('FACET_UNKNOWN_FACET');
							});
						// without a registry service the planner still resolves auto facets (M1)
						let tmpNoRegistry = newEnvironment('ProjectTrack', { Registry: false });
						let tmpM1 = plan(tmpNoRegistry, newContext(tmpNoRegistry, 'Project', LEAD, { Facets: [ { Key: 'S', Facet: 'Project.Status' }, { Key: 'D', Facet: 'Project.MyOverdueBand' } ] }));
						Expect(tmpM1.Aggs.map((pAgg) => { return pAgg.Key; })).to.deep.equal([ 'S', '#Total' ]);
						Expect(tmpM1.Errors.D.Code).to.equal('FACET_UNKNOWN_FACET');
					});

				test('the per-facet gate: an unreadable entity of ONE facet fails that facet only (403, no Detail), before anything else about it',
					() =>
					{
						_Project.authorizer.Denied.add('Task');
						let tmpResult = fPlan({ Facets: [ { Key: 'S', Facet: 'Project.Status' }, { Key: 'Band', Facet: 'Project.MyOverdueBand', Fold: 'Terms' } ] });
						Expect(tmpResult.Error).to.equal(null);
						// 403 wins over the (also wrong) Fold
						Expect(tmpResult.Plan.Errors.Band).to.deep.equal({ Code: 'FACET_FORBIDDEN', Status: 403, Message: 'Forbidden.' });
						Expect(tmpResult.Plan.Aggs.map((pAgg) => { return pAgg.Key; })).to.deep.equal([ 'S', '#Total' ]);
						_Project.authorizer.Denied.clear();
						Expect(fPlan({ Facets: [ { Key: 'Band', Facet: 'Project.MyOverdueBand', Fold: 'Terms' } ] }).Plan.Errors.Band.Code).to.equal('FACET_UNKNOWN_FOLD');
					});

				test('Supported: false definitions are 422 FACET_FOLD_UNSUPPORTED { Feature, Milestone: 2 } per facet',
					() =>
					{
						_Project.registry.Facets.set('Project.Computed', canonicalFacet(
							{
								Facet: 'Project.Computed', Entity: 'Project', Entities: [ 'Project' ], Supported: false, Unsupported: { Feature: 'Computed', Milestone: 2 },
								Dimensions: [ canonicalDim({ Kind: 'Terms', Field: 'Status', DataType: 'String', IsInteger: false, Scale: 0 }) ]
							}));
						let tmpResult = fPlan({ Facets: [ { Key: 'C', Facet: 'Project.Computed' }, { Key: 'S', Facet: 'Project.Status' } ] });
						Expect(tmpResult.Plan.Errors.C.Code).to.equal('FACET_FOLD_UNSUPPORTED');
						Expect(tmpResult.Plan.Errors.C.Status).to.equal(422);
						Expect(aggByKey(tmpResult.Plan, 'S').Kind).to.equal('Terms');
					});

				test('facet params: the top-level Params validate against the referenced declared facets (an undeclared name fails the request); per-facet values fail that facet',
					() =>
					{
						_Project.registry.Facets.set('Project.RecentTasks', canonicalFacet(
							{
								Facet: 'Project.RecentTasks', Entity: 'Project', Fold: 'ChildRollup', Exclude: 'None', Entities: [ 'Project', 'Task' ],
								Params: { Since: { Type: 'DateTime', Default: '2026-01-01' }, States: { Type: 'EnumList', Values: [ 'Open', 'Done' ] } },
								Dimensions: [ canonicalDim({ Kind: 'ChildRollup', Child: { Path: pathPlan(_Project.graph, 'Project', [ '<Task.IDProject' ]), Agg: 'count', Field: null, Where: and(tok('DueDate', 'GE', '$Param.Since'), tok('Status', 'IN', '$Param.States')) }, Edges: [ 1, 5 ] }) ]
							}));
						let tmpOk = fPlan({ Facets: [ { Key: 'R', Facet: 'Project.RecentTasks' } ], Params: { States: [ 'Open' ] } });
						Expect(tmpOk.Error).to.equal(null);
						Expect(plain(aggByKey(tmpOk.Plan, 'R').Dimensions[0].Rel.Where)).to.deep.equal(and(lit('DueDate', 'GE', '2026-01-01 00:00:00'), lit('Status', 'IN', [ 'Open' ])));
						let tmpUnknown = fPlan({ Facets: [ { Key: 'R', Facet: 'Project.RecentTasks' } ], Params: { States: [ 'Open' ], Bogus: 1 } });
						Expect(tmpUnknown.Error.Code).to.equal('FACET_PARAM_INVALID');
						Expect(tmpUnknown.Error.Detail).to.deep.equal({ Param: 'Bogus', Reason: 'Unknown' });
						// a name declared by a request scope is not unknown (the /Scope/:Scope/ route copies the scope's params from here)
						let tmpScoped = fPlan({ Facets: [ { Key: 'R', Facet: 'Project.RecentTasks' } ], Params: { States: [ 'Open' ], Roles: [ 'Owner' ] }, Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner' ] } } ] });
						Expect(tmpScoped.Error).to.equal(null);
						let tmpMissing = fPlan({ Facets: [ { Key: 'R', Facet: 'Project.RecentTasks' }, { Key: 'S', Facet: 'Project.Status' } ] });
						Expect(tmpMissing.Error).to.equal(null);
						Expect(tmpMissing.Plan.Errors.R.Code).to.equal('FACET_PARAM_INVALID');
						Expect(tmpMissing.Plan.Errors.R.Status).to.equal(400);
						let tmpBad = fPlan({ Facets: [ { Key: 'R', Facet: 'Project.RecentTasks' } ], Params: { States: [ 'Nope' ] } });
						Expect(tmpBad.Plan.Errors.R.Code).to.equal('FACET_PARAM_INVALID');
						// with no declared facet, any Param is unknown
						Expect(fPlan({ Facets: [ { Key: 'S', Facet: 'Project.Status' } ], Params: { X: 1 } }).Error.Code).to.equal('FACET_PARAM_INVALID');
					});

				test('a 401 while binding a facet definition fails the WHOLE request (fail closed)',
					() =>
					{
						let tmpResult = fPlan({ Facets: [ { Key: 'S', Facet: 'Project.Status' }, { Key: 'Band', Facet: 'Project.MyOverdueBand' } ] }, { Tenant: 1, User: 0 });
						Expect(tmpResult.Error.Code).to.equal('FACET_UNAUTHENTICATED');
						Expect(tmpResult.Plan).to.equal(null);
					});

				test('Total: false plans no #Total Agg; an M1 body plans exactly as in M1 (no Lowered conjuncts, M1 Variant hashes, M1 Aggs)',
					() =>
					{
						let tmpPlan = fPlan({ Facets: [ { Key: 'S', Facet: 'Project.Status' } ], Total: false }).Plan;
						Expect(tmpPlan.Aggs.map((pAgg) => { return pAgg.Key; })).to.deep.equal([ 'S' ]);
						let tmpM1 = fPlan(
							{
								Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active' ], Hash: 'h' } ],
								FilterString: 'FBV~Name~NE~x',
								Facets: [ { Key: 'S', Facet: 'Project.Status' }, { Key: 'D', Facet: 'Project.StartDate', Fold: 'Stats' } ]
							}).Plan;
						Expect(tmpM1.Lowered).to.deep.equal({});
						Expect(Object.keys(tmpM1.Variants).map((pId) => { return tmpM1.Variants[pId].Hash; })).to.deep.equal([ 'c1,c2', 'c2' ]);
						Expect(tmpM1.Variants.v0.PathPred).to.equal(null);
						Expect(tmpM1.Variants.v0.ColumnConjuncts.length).to.equal(2);
						let tmpStats = aggByKey(tmpM1, 'D');
						Expect(tmpStats).to.include({ Kind: 'Stats', Field: 'StartDate', Origin: 'Auto', VariantId: 'v0' });
						Expect(tmpStats.FieldInfo.Column).to.equal('StartDate');
						Expect(tmpStats.DepSet).to.deep.equal({ Project: [ 'Deleted', 'IDCustomer', 'IDProject', 'Name', 'StartDate', 'Status' ] });
						Expect(tmpM1.BindHash).to.equal('b:' + libCrypto.createHash('sha256').update('[]').digest('hex').substring(0, 16));
						Expect(tmpM1.Entities).to.deep.equal([ 'Project' ]);
					});

				test('lowerPred() is the public lowering entry (a fresh counter when none is passed; a shared counter continues it)',
					() =>
					{
						let tmpPath = pathPlan(_Project.graph, 'Project', [ '<Issue.IDProject' ]);
						let tmpBound = and(lit('Status', 'EQ', 'Active'), existsC(tmpPath, lit('State', 'EQ', 'Open')));
						let tmpLowered = _Project.planner.lowerPred(tmpBound, { Alias: 'p', Entity: 'Project' });
						Expect(plain(tmpLowered)).to.deep.equal(plain(xAnd(xCmp('p', 'Status', 'EQ', 'Active'), xExists(xRel('Issue', 'h1', 'Hop', [ 'IDIssue', 'IDProject' ], lit('State', 'EQ', 'Open'), { Stage: 'Allowed' }), [ xOn('p', 'IDProject', 'IDProject') ]))));
						let tmpCounter = libLowering.newAliasCounter();
						_Project.planner.lowerPred(tmpBound, { Alias: 'p', Entity: 'Project', Prefix: 'j' }, tmpCounter);
						Expect(_Project.planner.lowerPred(tmpBound, { Alias: 'p', Entity: 'Project', Prefix: 'j' }, tmpCounter).Items[1].Rel.As).to.equal('j2');
						// an unbound leaf can never reach a plan
						Expect(facetError(() => { _Project.planner.lowerPred(tok('Status', 'EQ', '$Now'), { Alias: 'p', Entity: 'Project' }); }).Code).to.equal('FACET_INTERNAL');
					});
			}
		);

		suite
		(
			'Cube formation (internal-contracts §25.1, §25.2)',
			() =>
			{
				let _Project = null;
				suiteSetup(() => { _Project = newEnvironment('ProjectTrack'); });

				let LEAD = { Tenant: 1, User: 7 };
				let fCubes = (pBody, pPlanForm) => { return plan(_Project, newContext(_Project, 'Project', LEAD, pBody, { PlanForm: pPlanForm || {} })); };
				let STATUS = { Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active' ] };

				test('PlanForm: Never forms no cube; Auto needs two members (the Total counts); Always forms one from a single member',
					() =>
					{
						Expect(fCubes({ Facets: [ { Key: 'S', Facet: 'Project.Status' } ], Clauses: [ STATUS ] }, { Cube: 'Never' }).Cubes).to.deep.equal([]);
						let tmpAuto = fCubes({ Facets: [ { Key: 'S', Facet: 'Project.Status' } ], Clauses: [ STATUS ] });
						Expect(tmpAuto.Cubes.length).to.equal(1);
						Expect(tmpAuto.Cubes[0].Members.map((pMember) => { return pMember.AggKey; })).to.deep.equal([ 'S', '#Total' ]);
						Expect(fCubes({ Facets: [ { Key: 'S', Facet: 'Project.Status' } ], Total: false }).Cubes).to.deep.equal([]);
						let tmpAlways = fCubes({ Facets: [ { Key: 'S', Facet: 'Project.Status' } ], Total: false }, { Cube: 'Always' });
						Expect(tmpAlways.Cubes.length).to.equal(1);
						Expect(tmpAlways.Cubes[0].Members).to.deep.equal([ { AggKey: 'S', Dims: [ 'd1' ], RequireFlags: [], RequireWhere: null } ]);
						Expect(tmpAlways.Cubes[0].Flags).to.deep.equal([]);
						// the default comes from Execution.Cube
						let tmpNever = newEnvironment('ProjectTrack', { Faceting: { Execution: { Cube: 'Never' } } });
						let tmpContext = newContext(tmpNever, 'Project', LEAD, { Facets: [ { Key: 'S', Facet: 'Project.Status' } ] });
						tmpContext.PlanForm = {};
						Expect(plan(tmpNever, tmpContext).Cubes).to.deep.equal([]);
					});

				test('cube members: Stats and Missing join as measures; not members: K9 (MultiValued), NumericHistogram Nice, DistinctCount, TuplePivots, IncludesDeleted Variants',
					() =>
					{
						let tmpPlan = fCubes(
							{
								Facets:
									[
										{ Key: 'S', Facet: 'Project.Status' },
										{ Key: 'M', Facet: 'Project.ByMember' },
										{ Key: 'Stats', Facet: 'Project.StartDate', Fold: 'Stats' },
										{ Key: 'Missing', Facet: 'Project.Status', Fold: 'Missing' },
										{ Key: 'Open', Facet: 'Project.HasOpenIssues' }
									]
							});
						Expect(tmpPlan.Cubes[0].Members.map((pMember) => { return pMember.AggKey; })).to.deep.equal([ 'S', 'Stats', 'Missing', 'Open', '#Total' ]);
						Expect(aggByKey(tmpPlan, 'M').CubeId).to.equal(null);
						Expect(aggByKey(tmpPlan, 'Stats').CubeId).to.equal('cube0');
						Expect(tmpPlan.Cubes[0].Measures).to.deep.equal(
							[
								{ Column: 'm1', Kind: 'Stats', Field: 'StartDate', DataType: 'DateTime', Scale: 0, Members: [ 'Stats' ] },
								{ Column: 'm2', Kind: 'Missing', Field: 'Status', DataType: 'String', Scale: 0, Members: [ 'Missing' ] }
							]);
						Expect(tmpPlan.Cubes[0].Members.find((pMember) => { return pMember.AggKey === 'Missing'; })).to.include({ Measure: 'm2' });
						Expect(aggByKey(fCubes({ Facets: [ { Key: 'S', Facet: 'Project.Status' }, { Key: 'D', Facet: 'Project.Status', Fold: 'DistinctCount' } ] }), 'D').CubeId).to.equal(null);
						// a Show-deleted filter: every member keeps or excludes a NamesDeleted conjunct → no cube
						let tmpDeleted = fCubes({ Facets: [ { Key: 'S', Facet: 'Project.Status' }, { Key: 'N', Facet: 'Project.Name' } ], FilterString: 'FBL~Deleted~INN~0,1' });
						Expect(tmpDeleted.Cubes).to.deep.equal([]);
						// a NumericHistogram is a member only in Edges mode
						let tmpLab = newEnvironment('LabTrack');
						let tmpEdges = plan(tmpLab, newContext(tmpLab, 'MaterialIntake', { Tenant: 1, User: 5 }, { Facets: [ { Key: 'Queue', Facet: 'MaterialIntake.IDLabQueue', Fold: 'Terms' } ] }));
						Expect(tmpEdges.Cubes[0].Members.map((pMember) => { return pMember.AggKey; })).to.deep.equal([ 'Queue', '#Total' ]);
						Expect(_Project.planner.cubeEligible(Object.assign(_Project.foldIR.agg({ Key: 'H', Kind: 'NumericHistogram', Pivot: 'Project' }), { Dimensions: [ { Kind: 'NumericBucket', Field: 'X', Mode: 'Nice' } ] }), { ExcludedIds: [] }, {}, 'Project')).to.equal(false);
						Expect(_Project.planner.cubeEligible(Object.assign(_Project.foldIR.agg({ Key: 'H', Kind: 'NumericHistogram', Pivot: 'Project' }), { Dimensions: [ { Kind: 'NumericBucket', Field: 'X', Mode: 'Edges', Edges: [ 0, 1 ] } ] }), { ExcludedIds: [] }, {}, 'Project')).to.equal(true);
					});
			}
		);

		suite
		(
			'Records / Count / Keys: Planner.planBase (internal-contracts §24.11, §28.3)',
			() =>
			{
				let _Project = null;
				suiteSetup(() => { _Project = newEnvironment('ProjectTrack'); });

				test('the base plan is v0 with its PathPred lowered, the DepSet (plus Sort fields), the entities it reads and BindHash',
					() =>
					{
						let tmpContext = newContext(_Project, 'Project', { Tenant: 1, User: 7 },
							{
								Scopes: [ { Scope: 'Project.HasMyOverdue' } ],
								Clauses:
									[
										{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active' ] },
										{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', Values: [ 3 ] }
									],
								Records: { Begin: 0, Cap: 50, Sort: [ { Field: 'Name', Dir: 'ASC' } ] }
							});
						tmpContext.Mode = 'Records';
						let tmpBase = null;
						_Project.planner.planBase(tmpContext, (pError, pBase) => { Expect(pError || null).to.equal(null); tmpBase = pBase; });
						Expect(tmpBase.Pivot).to.equal('Project');
						Expect(tmpBase.Variant.VariantId).to.equal('v0');
						Expect(tmpBase.Variant.Hash).to.equal('c1,c2,c3');
						Expect(tmpBase.Variant.ColumnConjuncts.map((pConjunct) => { return pConjunct.Id; })).to.deep.equal([ 'c1' ]);
						Expect(plain(tmpBase.Variant.PathPred)).to.deep.equal(plain(xAnd(
							xExists(xRel('Client', 'h1', 'Hop', [ 'IDClient' ], lit('IDClient', 'IN', [ 3 ]), { Stage: 'Allowed' }), [ xOn('p', 'IDClient', 'IDClient') ]),
							xExists(xRel('Task', 'h2', 'Hop', [ 'IDTask', 'IDProject' ], and(lit('AssignedIDUser', 'EQ', 7), lit('DueDate', 'LT', TEST_NOW_CANONICAL), lit('Status', 'NE', 'Done')), { Stage: 'Allowed' }), [ xOn('p', 'IDProject', 'IDProject') ]))));
						Expect(tmpBase.Variant.Relations).to.deep.equal([ { Alias: 'h1', Entity: 'Client', Role: 'Hop' }, { Alias: 'h2', Entity: 'Task', Role: 'Hop' } ]);
						Expect(tmpBase.DepSet).to.deep.equal(
							{
								Project: [ 'Deleted', 'IDClient', 'IDCustomer', 'IDProject', 'Name', 'Status' ],
								Client: [ 'Deleted', 'IDClient', 'IDCustomer' ],
								Task: [ 'AssignedIDUser', 'Deleted', 'DueDate', 'IDCustomer', 'IDProject', 'IDTask', 'Status' ]
							});
						Expect(tmpBase.Entities).to.deep.equal([ 'Client', 'Project', 'Task' ]);
						Expect(tmpBase.BindHash).to.equal(_Project.binder.bindHash(tmpContext.Bind));
						Expect(tmpBase.BindHash).to.not.equal('b:' + libCrypto.createHash('sha256').update('[]').digest('hex').substring(0, 16));
						Expect(Object.keys(tmpContext.Variants)).to.deep.equal([ 'v0' ]);
						Expect(tmpContext.Variants.v0).to.equal(tmpBase.Variant);
						// the same filter planned for facets lowers to the same v0 PathPred
						let tmpPlan = plan(_Project, newContext(_Project, 'Project', { Tenant: 1, User: 7 },
							{
								Scopes: [ { Scope: 'Project.HasMyOverdue' } ],
								Clauses:
									[
										{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active' ] },
										{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', Values: [ 3 ] }
									],
								Facets: []
							}));
						Expect(plain(tmpPlan.Variants.v0.PathPred)).to.deep.equal(plain(tmpBase.Variant.PathPred));
						// a Query body with Records: planBase after plan() in the same request reuses plan()'s v0
						let tmpBoth = newContext(_Project, 'Project', { Tenant: 1, User: 7 },
							{ Scopes: [ { Scope: 'Project.HasMyOverdue' } ], Facets: [ { Key: 'S', Facet: 'Project.Status' } ], Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active' ] } ], Records: { Begin: 0, Cap: 10 } });
						let tmpBothPlan = plan(_Project, tmpBoth);
						let tmpBothBase = null;
						_Project.planner.planBase(tmpBoth, (pError, pBase) => { tmpBothBase = pBase; });
						Expect(tmpBothBase.Variant).to.equal(tmpBothPlan.Variants.v0);
						Expect(tmpBoth.Variants).to.equal(tmpBothPlan.Variants);
						Expect(Object.keys(tmpBoth.Variants)).to.deep.equal([ 'v0', 'v1' ]);
					});

				test('planBase without a filter: an empty v0, the pivot DepSet; an unwired planner fails cleanly',
					() =>
					{
						let tmpContext = newContext(_Project, 'Project', { Tenant: 1, User: 7 }, {});
						let tmpBase = null;
						_Project.planner.planBase(tmpContext, (pError, pBase) => { tmpBase = pBase; });
						Expect(tmpBase.Variant.Hash).to.equal('');
						Expect(tmpBase.Variant.PathPred).to.equal(null);
						Expect(tmpBase.DepSet).to.deep.equal({ Project: [ 'Deleted', 'IDCustomer', 'IDProject' ] });
						let tmpError = null;
						_Project.planner.planBase({ Entity: 'Project', Memo: {} }, (pError) => { tmpError = pError; });
						Expect(tmpError.Code).to.equal('FACET_INTERNAL');
						_Project.planner.plan({ Entity: 'Project', Memo: {} }, (pError) => { tmpError = pError; });
						Expect(tmpError.Code).to.equal('FACET_INTERNAL');
					});
			}
		);

		suite
		(
			'Cross-check: the real Graph.resolvePath and DefinitionRegistry produce the plans the hand-written canonical forms produce',
			() =>
			{
				let LEAD = { Tenant: 1, User: 7 };
				let TECH = { Tenant: 1, User: 5 };

				/**
				 * The real registry over a domain's definitions file, or null when it does not load the file
				 * cleanly yet (the suite then skips: the registry is another builder's).
				 */
				let fRealEnvironment = (pDomain) =>
				{
					let tmpEnv = newEnvironment(pDomain, { Registry: 'Real' });
					// The real registry must load the domain file cleanly: a disabled entry is a failure here.
					let tmpLoad = tmpEnv.registry.load({ Path: false, Files: [ DOMAINS[pDomain].DEFINITIONS_PATH ], Objects: [] },
						{ Graph: tmpEnv.graph, Catalog: tmpEnv.catalog, Policy: tmpEnv.host.getScopePolicy(), Options: tmpEnv.options });
					Expect(tmpLoad.Disabled, `${pDomain} definitions`).to.deep.equal([]);
					Expect(tmpLoad.Loaded.Facets, `${pDomain} definitions`).to.be.above(0);
					return tmpEnv;
				};

				/**
				 * The structural projection of a plan the engines consume (no definition hashes / sources).
				 */
				let fProjection = (pPlan) =>
				{
					return plain(
						{
							Aggs: pPlan.Aggs.map(
								(pAgg) =>
								{
									return (
										{
											Key: pAgg.Key, Kind: pAgg.Kind, Pivot: pAgg.Pivot, Origin: pAgg.Origin, Dimensions: pAgg.Dimensions, Where: pAgg.Where, WhereHash: pAgg.WhereHash,
											Tuple: pAgg.Tuple, CountMode: pAgg.CountMode, Exclude: pAgg.Exclude, OwnedFields: pAgg.OwnedFields, Entities: pAgg.Entities, ClauseType: pAgg.ClauseType,
											LabelLookup: pAgg.LabelLookup, Path: pAgg.Path, VariantId: pAgg.VariantId, CubeId: pAgg.CubeId, DepSet: pAgg.DepSet, MultiValued: pAgg.MultiValued,
											Relaxed: pAgg.Relaxed, Semantics: pAgg.Semantics, Field: pAgg.Field, Top: pAgg.Top
										});
								}),
							Variants: Object.keys(pPlan.Variants).map((pId) => { let tmpVariant = pPlan.Variants[pId]; return { Id: pId, Hash: tmpVariant.Hash, Facets: tmpVariant.Facets, PathPred: tmpVariant.PathPred, Where: tmpVariant.Where }; }),
							Cubes: pPlan.Cubes,
							Lowered: pPlan.Lowered,
							DepSet: pPlan.DepSet,
							Entities: pPlan.Entities,
							BindHash: pPlan.BindHash,
							Errors: pPlan.Errors
						});
				};

				let REQUESTS =
					{
						ProjectTrack:
							[
								[ 'Project', LEAD,
									{
										Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead' ] } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
										Clauses:
											[
												{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active', 'AtRisk' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' },
												{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: [ 3, 9 ], FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' },
												{ Type: 'DateRange', FilterByColumn: 'StartDate', Values: { Start: '2026-01-01 00:00:00', End: '2027-01-01 00:00:00' }, EndExclusive: true, FilterKey: 'StartDate', Hash: 'StartDate-DR-1' }
											],
										Facets:
											[
												{ Key: 'Status', Facet: 'Project.Status' }, { Key: 'Client', Facet: 'Project.IDClient', Top: 20 },
												{ Key: 'Started', Facet: 'Project.StartDate', Interval: 'month' }, { Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' },
												{ Key: 'StatusByClient', Facet: [ 'Project.Status', 'Project.IDClient' ], Fold: 'Pivot' },
												{ Key: 'ByMember', Facet: 'Project.ByMember' }, { Key: 'Open', Facet: 'Project.HasOpenIssues' }
											]
									} ],
								[ 'Project', LEAD, { Scopes: [ { Scope: 'Project.ManyOverdue' } ], Facets: [ { Key: 'S', Facet: 'Project.Status' } ] } ],
								[ 'Document', LEAD, { Scopes: [ { Scope: 'Document.InMyProjects' } ], Facets: [ { Key: 'ByClient', Facet: 'Document.ByClient' }, { Key: 'ByMonth', Facet: 'Document.DocumentDate' } ] } ]
							],
						LabTrack:
							[
								[ 'MaterialIntakeRequirement', TECH,
									{
										Facets:
											[
												{ Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' },
												{ Key: 'Week', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek' }, { Key: 'Discipline', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' },
												{ Key: 'Started', Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started' }
											]
									} ],
								[ 'MaterialIntakeRequirement', TECH, { Scopes: [ { Scope: 'MaterialIntakeRequirement.ToDoForMe' } ], Facets: [ { Key: 'T', Facet: 'MaterialIntakeRequirement.IDLabFormType' } ] } ],
								[ 'MaterialIntake', TECH,
									{
										Scopes: [ { Scope: 'MaterialIntake.InMyQueues' } ],
										Facets:
											[
												{ Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntake.FormsToDo/ByQueue' },
												{ Key: 'Week', Facet: 'MaterialIntake.FormsToDo/ByWeek' }, { Key: 'ByForm', Facet: 'MaterialIntake.ByRequiredForm' }
											]
									} ]
							]
					};

				Object.keys(REQUESTS).forEach(
					(pDomain) =>
					{
						test(`${pDomain}: every motivating and coverage request plans identically from the real registry`,
							function ()
							{
								let tmpReal = fRealEnvironment(pDomain);
								let tmpStub = newEnvironment(pDomain);
								REQUESTS[pDomain].forEach(
									(pRequest, pIndex) =>
									{
										let tmpFromStub = fProjection(plan(tmpStub, newContext(tmpStub, pRequest[0], pRequest[1], pRequest[2])));
										let tmpFromReal = fProjection(plan(tmpReal, newContext(tmpReal, pRequest[0], pRequest[1], pRequest[2])));
										Expect(tmpFromReal, `${pDomain} request ${pIndex}`).to.deep.equal(tmpFromStub);
									});
							});
					});

				test('every PathPlan written by hand here equals Graph.resolvePath (when the graph resolves paths)',
					function ()
					{
						let tmpEnv = newEnvironment('LabTrack');
						Expect(tmpEnv.graph.resolvePath).to.be.a('function');
						let tmpCases =
							[
								[ 'MaterialIntake', [ '>MaterialIntake.IDLabQueue', '<LabQueueMember.IDLabQueue' ] ],
								[ 'MaterialIntakeRequirement', [ '=LabForm.IDMaterialIntake' ] ],
								[ 'MaterialIntakeRequirement', [ '>MaterialIntakeRequirement.IDMaterialIntake', '>MaterialIntake.IDLabQueue' ] ],
								[ 'MaterialIntake', [ '<MaterialIntakeRequirement.IDMaterialIntake', '>MaterialIntakeRequirement.IDLabFormType' ] ],
								[ 'MaterialIntake', [ '<LabForm.IDMaterialIntake' ] ]
							];
						tmpCases.forEach(
							(pCase) =>
							{
								Expect(plain(tmpEnv.graph.resolvePath(pCase[0], pCase[1], {})), pCase[1].join(' ')).to.deep.equal(plain(pathPlan(tmpEnv.graph, pCase[0], pCase[1])));
							});
						// the clause compiler's join paths are the same shape
						let tmpProject = newEnvironment('ProjectTrack');
						let tmpEdge = tmpProject.graph.edge('ProjectMembership.IDProject');
						let tmpExternal = tmpProject.graph.edge('ProjectMembership.IDUser');
						Expect(plain(tmpProject.compiler.pathPlan('Project', [ { Direction: 'Reverse', Edge: tmpEdge }, { Direction: 'Forward', Edge: tmpExternal } ])))
							.to.deep.equal(plain(tmpProject.graph.resolvePath('Project', [ '<ProjectMembership.IDProject', '>ProjectMembership.IDUser' ], {})));
					});
			}
		);





	}
);

