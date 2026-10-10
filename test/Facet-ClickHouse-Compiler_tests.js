/**
 * Facet-ClickHouse-Compiler (internal-contracts §66.2, owner: builder C, port 19143).
 *
 * Proves the ClickHouse fold compiler (source/store/clickhouse/ClickHouse-FoldCompiler.js) and the
 * store engine (source/engine/Retold-Faceting-EngineClickHouse.js):
 *
 *   - unit (no ClickHouse): the §63.3 predicate table (operators, NULL semantics, IN / NOT IN, LIKE per
 *     source dialect, ILIKE transforms, value typing, date literals, string ranges), every §63.2–§63.3
 *     refusal reason (NotMirrored, LossyColumn, ScopeMissing, OperatorUnsupported, OperatorType,
 *     ValueType, DateLiteral per dialect, LikeCase, StringOrder, Transformed, OpaqueScope, plus
 *     ShapeUnsupported), the five §63.7 worked examples' shapes, every kind's row shape, the public
 *     API (compileFilter for the materializer's filter resolution, compileRelation, compileFoldPred,
 *     dimensionExpression), and REASON_CLASSES;
 *   - goldens (no ClickHouse): test/goldens/Facet-ClickHouse-Goldens.json — the engine's dry-run
 *     compile() of every kind K1–K12, K14 (Column × Column, Column × DateBucket, Range axes), K17,
 *     K18, K19 (both P(0) branches), K20, the #Total, a two-link Via chain, Multi, Nice and Edges
 *     NumericHistograms, Ranges, Stats (integer, decimal, date), DistinctCount, Missing and the cube
 *     grain statement, captured from real scope (the domains' tenancy / owner behaviors), with their
 *     parameter maps and types; no value ever appears in SQL text (a scan over every golden).
 *     FACET_UPDATE_GOLDENS=1 rewrites them (REVIEW the diff);
 *   - the engine without ClickHouse: capable() reason by reason, execute() over a fake store
 *     (folding, settings, freshness, whole vs partial store errors, Opaque captures refused, a
 *     capture error Live would raise returned as Live returns it);
 *   - CH-gated (RFS_TEST_CLICKHOUSE=1, rfs-test-clickhouse): mirrors loaded statically
 *     (Facet-ClickHouse-Support.loadMirrors) for ProjectTrack, LabTrack, Bookstore and
 *     Bookstore-Tenant; every kind executes and its RawFacetResult equals Live's for the same Agg
 *     (the engine end to end), the cube equals per-Variant (O5 on ClickHouse), dates before 1970 and
 *     Nice decimal edges (499.996) bucket identically, '' vs NULL keys, cross-tenant FK references
 *     land in Missing on K8, the Bookstore conformance list answers equal or refuses with its reason;
 *     the PostgreSQL half when RFS_TEST_POSTGRES is on as well; store errors through the client's
 *     fault injector.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libFS = require('fs');
const libPath = require('path');

const libBuilders = require('./support/Facet-Test-Builders.js');
const libSupport = require('./support/Facet-ClickHouse-Support.js');
const libKit = require('./support/Facet-Live-M2-Kit.js');
const F = require('./support/Facet-Live-M2-FoldIR.js');
const libHarness = require('./support/Facet-Test-Harness.js');
const libProviders = require('./support/Facet-Harness-Providers.js');
const libConformanceFixtures = require('./fixtures/Bookstore-Conformance-Fixtures.js');

const libClickHouseClientForTests = require('../source/store/clickhouse/ClickHouse-Client.js');
const libFoldCompiler = require('../source/store/clickhouse/ClickHouse-FoldCompiler.js');
const libClickHouseClient = require('../source/store/clickhouse/ClickHouse-Client.js');
const libFacetBuckets = require('../source/contract/Facet-Contract-Buckets.js');
const libRetoldFacetingEngineClickHouse = require('../source/engine/Retold-Faceting-EngineClickHouse.js');

const PORT = 19143;

const GOLDEN_FILE = libPath.join(__dirname, 'goldens', 'Facet-ClickHouse-Goldens.json');
const UPDATE_GOLDENS = (process.env.FACET_UPDATE_GOLDENS === '1');

const CH_GATE = libSupport.available();

// The literals a compiled statement may hold: the two wire formats and the DateTime64 time zone.
const ALLOWED_LITERALS = Object.freeze([ "'%Y-%m-%d 00:00:00'", "'%Y-%m-%d %H:%i:%S'", "'UTC'" ]);

// Every reason any test saw (checked against REASON_CLASSES at the end).
const SEEN_REASONS = new Set();

// ====================================================================== hand-made specs (pure tests)

/**
 * A MirrorSpec (§55.2 shape, the fields the compiler reads).
 *
 * @param {string} pEntity
 * @param {string} pKind - 'Tenant' | 'Personal' | 'Global' | 'Unscoped'
 * @param {string|null} pTenant
 * @param {string|null} pOwner
 * @param {Array<Array<string>>} pColumns - [ Column, DataType, Mirror ]
 * @return {Record<string, any>}
 */
const spec = (pEntity, pKind, pTenant, pOwner, pColumns) =>
{
	return (
		{
			Entity: pEntity, Store: 'ClickHouse', Identity: `ID${pEntity}`, Kind: pKind, TenantColumn: pTenant, OwnerColumn: pOwner, DeleteColumn: 'Deleted',
			Columns: pColumns.map((pColumn) => { return { Column: pColumn[0], DataType: pColumn[1], Mirror: pColumn[2] }; }),
			ColumnNames: pColumns.map((pColumn) => { return pColumn[0]; }).sort()
		});
};

const I64 = 'Int64';
const NI64 = 'Nullable(Int64)';
const NU8 = 'Nullable(UInt8)';
const NSTR = 'Nullable(String)';
const NF64 = 'Nullable(Float64)';
const NDT = "Nullable(DateTime64(3, 'UTC'))";

const SPECS = Object.freeze(
	{
		Project: spec('Project', 'Tenant', 'IDCustomer', null,
			[ [ 'IDProject', 'ID', I64 ], [ 'IDCustomer', 'Numeric', I64 ], [ 'Deleted', 'Boolean', NU8 ], [ 'Status', 'String', NSTR ], [ 'Name', 'String', NSTR ],
				[ 'IDClient', 'Numeric', NI64 ], [ 'OwnerIDUser', 'Numeric', NI64 ], [ 'StartDate', 'DateTime', NDT ] ]),
		ProjectMembership: spec('ProjectMembership', 'Tenant', 'IDCustomer', null,
			[ [ 'IDProjectMembership', 'ID', I64 ], [ 'IDCustomer', 'Numeric', I64 ], [ 'Deleted', 'Boolean', NU8 ], [ 'IDProject', 'Numeric', NI64 ], [ 'IDUser', 'Numeric', NI64 ], [ 'Active', 'Boolean', NU8 ], [ 'Role', 'String', NSTR ] ]),
		Task: spec('Task', 'Tenant', 'IDCustomer', null,
			[ [ 'IDTask', 'ID', I64 ], [ 'IDCustomer', 'Numeric', I64 ], [ 'Deleted', 'Boolean', NU8 ], [ 'IDProject', 'Numeric', NI64 ], [ 'AssignedIDUser', 'Numeric', NI64 ], [ 'DueDate', 'DateTime', NDT ], [ 'Status', 'String', NSTR ] ]),
		Client: spec('Client', 'Tenant', 'IDCustomer', null,
			[ [ 'IDClient', 'ID', I64 ], [ 'IDCustomer', 'Numeric', I64 ], [ 'Deleted', 'Boolean', NU8 ], [ 'Name', 'String', NSTR ] ]),
		FormType: spec('FormType', 'Global', null, null, [ [ 'IDFormType', 'ID', I64 ], [ 'Name', 'String', NSTR ], [ 'Category', 'String', NSTR ] ]),
		Document: spec('Document', 'Tenant', 'IDCustomer', null,
			[ [ 'IDDocument', 'ID', I64 ], [ 'IDCustomer', 'Numeric', I64 ], [ 'Deleted', 'Boolean', NU8 ], [ 'DocumentDate', 'DateTime', NDT ], [ 'IDFormType', 'Numeric', NI64 ], [ 'IDProject', 'Numeric', NI64 ], [ 'Status', 'String', NSTR ] ]),
		MaterialIntakeRequirement: spec('MaterialIntakeRequirement', 'Tenant', 'IDCustomer', null,
			[ [ 'IDMaterialIntakeRequirement', 'ID', I64 ], [ 'IDCustomer', 'Numeric', I64 ], [ 'Deleted', 'Boolean', NU8 ], [ 'IDMaterialIntake', 'Numeric', NI64 ], [ 'IDLabFormType', 'Numeric', NI64 ] ]),
		LabForm: spec('LabForm', 'Personal', 'IDCustomer', 'OwnerIDUser',
			[ [ 'IDLabForm', 'ID', I64 ], [ 'IDCustomer', 'Numeric', I64 ], [ 'OwnerIDUser', 'Numeric', NI64 ], [ 'Deleted', 'Boolean', NU8 ], [ 'IDMaterialIntake', 'Numeric', NI64 ], [ 'IDLabFormType', 'Numeric', NI64 ], [ 'Status', 'String', NSTR ] ]),
		BookStoreSale: spec('BookStoreSale', 'Unscoped', null, null,
			[ [ 'IDBookStoreSale', 'ID', I64 ], [ 'Deleted', 'Boolean', NU8 ], [ 'SaleDate', 'DateTime', NDT ], [ 'TotalAmount', 'Decimal', NF64 ], [ 'PaymentMethod', 'String', NSTR ], [ 'IDBookStore', 'Numeric', NI64 ] ])
	});

// FoxHound entry builders (the shapes a capture hands the compiler).
const E = (pColumn, pOperator, pValue, pConnector, pParameter) => { return { Column: pColumn, Operator: pOperator, Value: pValue, Connector: pConnector || 'AND', Parameter: pParameter || pColumn }; };
const OPEN = (pConnector) => { return { Column: '', Operator: '(', Value: '', Connector: pConnector || 'AND', Parameter: 'FacetFenceOpen' }; };
const CLOSE = () => { return { Column: '', Operator: ')', Value: '', Connector: 'AND', Parameter: 'FacetFenceClose' }; };
const SCOPED = (pTenant) => { return [ E('Deleted', '=', 0, 'AND', 'FacetSoftDelete'), E('IDCustomer', '=', pTenant || 1, 'AND', 'TestTenancy') ]; };

/**
 * A relation capture for the compile input.
 *
 * @param {string} pEntity
 * @param {Array<Record<string, any>>} pFilter
 * @param {Record<string, any>} [pCapture]
 * @return {Record<string, any>}
 */
const relation = (pEntity, pFilter, pCapture) =>
{
	return { Entity: pEntity, Filter: pFilter, Capture: Object.assign({ Opaque: false, Portable: true }, pCapture || {}) };
};

/**
 * A compile input over the hand-made specs.
 *
 * @param {Record<string, any>} pRelations
 * @param {Record<string, any>} [pExtra]
 * @return {Record<string, any>}
 */
const input = (pRelations, pExtra) =>
{
	return Object.assign({ Database: 'rfs_main', Specs: SPECS, Relations: pRelations, SourceDialect: 'SQLite', Limits: { DefaultTop: 20, MaxTermsGroups: 10000, MaxDateBuckets: 400, CubeMaxGroups: 100000 } }, pExtra || {});
};

/**
 * Every {name:Type} reference of a statement is bound with that type, every bound name is
 * referenced, and the SQL holds no literal but the two wire formats and the DateTime64 zone.
 *
 * @param {Record<string, any>} pStatement - { SQL, Params, Types }
 * @param {string} pLabel
 */
const expectHygiene = (pStatement, pLabel) =>
{
	let tmpReferences = pStatement.SQL.match(/\{([A-Za-z_][A-Za-z0-9_]*):([^}]+)\}/g) || [];
	let tmpNames = new Set();
	tmpReferences.forEach(
		(pReference) =>
		{
			let tmpMatch = /^\{([A-Za-z_][A-Za-z0-9_]*):([^}]+)\}$/.exec(pReference);
			tmpNames.add(tmpMatch[1]);
			Expect(pStatement.Params, `${pLabel}: ${tmpMatch[1]} bound`).to.have.property(tmpMatch[1]);
			Expect(pStatement.Types[tmpMatch[1]], `${pLabel}: ${tmpMatch[1]} type`).to.equal(tmpMatch[2]);
		});
	Object.keys(pStatement.Params).forEach((pName) => { Expect(tmpNames.has(pName), `${pLabel}: ${pName} referenced`).to.equal(true); });
	let tmpLiterals = pStatement.SQL.match(/'[^']*'/g) || [];
	tmpLiterals.forEach((pLiteral) => { Expect(ALLOWED_LITERALS, `${pLabel}: literal ${pLiteral}`).to.include(pLiteral); });
	// No bound string value is spelled in the SQL as a literal or a bare word token.
	Object.keys(pStatement.Params).forEach(
		(pName) =>
		{
			let tmpValues = Array.isArray(pStatement.Params[pName]) ? pStatement.Params[pName] : [ pStatement.Params[pName] ];
			tmpValues.forEach(
				(pValue) =>
				{
					if ((typeof(pValue) === 'string') && (pValue.length > 0))
					{
						Expect(pStatement.SQL.indexOf(`'${pValue}'`), `${pLabel}: value of ${pName} in the SQL`).to.equal(-1);
					}
				});
		});
};

/**
 * Compile and expect a refusal with that exact reason.
 *
 * @param {Record<string, any>} pResult
 * @param {string} pReason
 */
const expectRefused = (pResult, pReason) =>
{
	Expect(pResult, JSON.stringify(pResult).slice(0, 300)).to.have.property('Refused', pReason);
	SEEN_REASONS.add(pReason);
};

/**
 * The only statement of a compiled Agg.
 *
 * @param {Record<string, any>} pCompiled
 * @return {Record<string, any>}
 */
const only = (pCompiled) =>
{
	Expect(pCompiled.Refused, pCompiled.Refused).to.equal(undefined);
	Expect(pCompiled.Statements).to.have.length(1);
	expectHygiene(pCompiled.Statements[0], pCompiled.Statements[0].Purpose);
	return pCompiled.Statements[0];
};

// ====================================================================== bench helpers

/**
 * The single- / multi-Variant overrides of an empty filter.
 *
 * @param {string} pEntity
 * @return {Record<string, any>}
 */
const emptyVariants = (pEntity) =>
{
	return { Variants: { v0: F.variant('v0', pEntity, [], null), vt: F.variant('vt', pEntity, [], null) } };
};

/**
 * A store stub for dry-run compiles (never queried) or canned answers.
 *
 * @param {(pSQL: string, pParams: any, pTypes: any, pSettings: any, fCallback: Function) => void} [fQuery]
 * @return {Record<string, any>}
 */
const stubStore = (fQuery) =>
{
	return (
		{
			Database: 'rfs_main',
			status: () => { return { Configured: true, Available: true, Database: 'rfs_main' }; },
			queryRows: fQuery || ((pSQL, pParams, pTypes, pSettings, fCallback) => { return fCallback(Object.assign(new Error('The stub store does not answer.'), { StoreError: true, Status: 500 })); })
		});
};

/**
 * Every MirrorSpec of a bench's catalog (MirrorSpec.compile over a declaration of every entity).
 *
 * @param {Record<string, any>} pFable
 * @return {Record<string, any>}
 */
const benchSpecs = (pFable) =>
{
	let tmpMirrorSpec = pFable.RetoldFacetingMirrorSpec;
	let tmpCompiled = tmpMirrorSpec.compile(tmpMirrorSpec.declareAll([ 'ClickHouse' ]), { Stores: [ 'ClickHouse' ] });
	return tmpCompiled.Specs.ClickHouse;
};

/**
 * A request context on a Facet-Test-Harness (principal resolved), like the Kit's K.context.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pSession - { Tenant, User } or {}
 * @param {Record<string, any>} pOverrides
 * @param {(pError?: Error, pContext?: Record<string, any>) => void} fCallback
 */
const harnessContext = (pHarness, pEntity, pSession, pOverrides, fCallback) =>
{
	let tmpContext = pHarness.faceting.newContext(pEntity, libHarness.syntheticRequest(pEntity, pSession || {}, null), { Now: libKit.TEST_NOW });
	Object.keys(pOverrides || {}).forEach((pKey) => { tmpContext[pKey] = pOverrides[pKey]; });
	pHarness.fable.RetoldFacetingPrincipalResolver.resolve(tmpContext,
		(pError, pPrincipal) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			tmpContext.Principal = pPrincipal;
			return fCallback(null, tmpContext);
		});
};

/**
 * Leave the engine's stack before calling back (assertion errors must not re-enter it).
 *
 * @param {Record<string, any>} pEngine
 * @param {string} pMethod - 'execute' | 'compile'
 * @param {Record<string, any>} pContext
 * @param {Array<Record<string, any>>} pAggs
 * @param {Function} fCallback
 */
const call = (pEngine, pMethod, pContext, pAggs, fCallback) =>
{
	pEngine[pMethod](pContext, pAggs,
		(pError, pResult) =>
		{
			setImmediate(() => { fCallback(pError, pResult); });
		});
};

// ====================================================================== scenarios (Kit FoldIR)

// The pre-1970 / range-edge date traps the ClickHouse benches add to ProjectTrack (Mutate).
const mutateProjectTrack = (pRows) =>
{
	pRows.Project[2].StartDate = '1965-03-15 10:00:00';
	pRows.Project[3].StartDate = '1969-12-31 23:59:59';
	pRows.Project[5].StartDate = '1900-01-01 00:00:00';
	pRows.Project[6].StartDate = '1970-01-01 00:00:00';
	pRows.Task[0].DueDate = '1968-02-29 12:00:00';
};

/**
 * Extra ProjectTrack Aggs: every date interval and date Stats over the pre-1970 traps, K19 with
 * P(0) true, a Terms keyed on a two-link Via.
 *
 * @return {Array<Record<string, any>>}
 */
const projectExtraAggs = () =>
{
	let tmpFew = F.countCmp(F.rel('Issue', 'j9', [ 'IDIssue', 'IDProject' ], { Where: { Field: 'State', Op: 'EQ', Value: 'Open' } }), [ F.on('p', 'IDProject', 'IDProject') ], null, 'LT', 2);
	return (
		[
			F.agg({ Key: 'StartDay', Kind: 'DateHistogram', Pivot: 'Project', Dimensions: [ F.dateDim('StartDate', 'day') ] }),
			F.agg({ Key: 'StartWeek', Kind: 'DateHistogram', Pivot: 'Project', Dimensions: [ F.dateDim('StartDate', 'week') ] }),
			F.agg({ Key: 'StartQuarter', Kind: 'DateHistogram', Pivot: 'Project', Dimensions: [ F.dateDim('StartDate', 'quarter') ] }),
			F.agg({ Key: 'StartYear', Kind: 'DateHistogram', Pivot: 'Project', Dimensions: [ F.dateDim('StartDate', 'year') ] }),
			F.agg({ Key: 'StartStats', Kind: 'Stats', Pivot: 'Project', Field: 'StartDate', FieldInfo: { DataType: 'DateTime', Scale: 0 } }),
			F.agg({ Key: 'StartMissing', Kind: 'Missing', Pivot: 'Project', Field: 'StartDate', FieldInfo: { DataType: 'DateTime', Scale: 0 } }),
			F.agg({ Key: 'StartDistinct', Kind: 'DistinctCount', Pivot: 'Project', Field: 'StartDate', FieldInfo: { DataType: 'DateTime', Scale: 0 } }),
			F.agg({ Key: 'ClientStats', Kind: 'Stats', Pivot: 'Project', Field: 'IDClient', FieldInfo: { DataType: 'Numeric', Scale: 0 } }),
			F.agg({ Key: 'ClientNice', Kind: 'NumericHistogram', Pivot: 'Project', Dimensions: [ { Kind: 'NumericBucket', Field: 'IDClient', Mode: 'Nice', Buckets: 4, Edges: null, OpenEnded: false, DataType: 'Numeric', IsInteger: true, Scale: 0 } ] }),
			F.agg({ Key: 'StatusByYear', Kind: 'Pivot', Pivot: 'Project', Top: null, Dimensions: [ F.columnDim('Status', 'String'), F.dateDim('StartDate', 'year') ] }),
			F.agg({ Key: 'FewOpenIssues', Kind: 'Terms', Pivot: 'Project', Where: tmpFew, WhereHash: 'wh:few', Dimensions: [ F.columnDim('Status', 'String') ] }),
			F.agg({ Key: 'FewOpenIssuesTotal', Kind: 'Count', Pivot: 'Project', Where: tmpFew, WhereHash: 'wh:few' })
		]);
};

// [ Name, Domain, Entity, Principal, () => overrides, () => Aggs ]
const SCENARIOS =
[
	[ 'E1 per Variant', 'ProjectTrack', 'Project', 'Lead', () => { return { Variants: F.e1Plan(1, [ 1, 2, 3, 8, 101 ]).Variants, PlanForm: { Cube: 'Never' } }; }, () => { return F.e1Plan(1, [ 1, 2, 3, 8, 101 ]).Aggs; } ],
	[ 'E1 cube', 'ProjectTrack', 'Project', 'Lead', () => { let P = F.e1Plan(1, [ 1, 2, 3, 8, 101 ]); return { Variants: P.Variants, Cubes: [ P.Cube ] }; }, () => { return F.e1Plan(1, [ 1, 2, 3, 8, 101 ]).Aggs; } ],
	[ 'E2', 'ProjectTrack', 'Document', 'Lead', () => { return { Variants: F.projectCoverage(1, 3).E2Variants }; }, () => { return F.projectCoverage(1, 3).E2Aggs; } ],
	[ 'Project coverage', 'ProjectTrack', 'Project', 'Lead', () => { return emptyVariants('Project'); }, () => { let C = F.projectCoverage(1, 3); return [ C.ByMember, C.HasOpenIssues, C.ManyOverdue ]; } ],
	[ 'Document coverage', 'ProjectTrack', 'Document', 'Lead', () => { return emptyVariants('Document'); }, () => { let C = F.projectCoverage(1, 3); return [ C.ByClient, C.InMyProjects ]; } ],
	[ 'Project extras', 'ProjectTrack', 'Project', 'Lead', () => { return emptyVariants('Project'); }, projectExtraAggs ],
	[ 'E1 as tenant 2', 'ProjectTrack', 'Project', 'OtherLead', () => { return { Variants: F.e1Plan(101, [ 101, 102, 103, 1 ]).Variants, PlanForm: { Cube: 'Never' } }; }, () => { return F.e1Plan(101, [ 101, 102, 103, 1 ]).Aggs; } ],
	[ 'E3A TenantOnly', 'LabTrack', 'MaterialIntakeRequirement', 'Tech', () => { return emptyVariants('MaterialIntakeRequirement'); }, () => { return F.e3aAggs(1, 'TenantOnly'); } ],
	[ 'E3A Inherit', 'LabTrack', 'MaterialIntakeRequirement', 'Tech', () => { return emptyVariants('MaterialIntakeRequirement'); }, () => { return F.e3aAggs(1, 'Inherit'); } ],
	[ 'E3A extras', 'LabTrack', 'MaterialIntakeRequirement', 'Tech', () => { return emptyVariants('MaterialIntakeRequirement'); }, () => { return F.e3aExtraAggs(1); } ],
	[ 'E3B', 'LabTrack', 'MaterialIntake', 'Tech', () => { return emptyVariants('MaterialIntake'); }, () => { return F.e3bAggs(1); } ],
	[ 'Lab coverage', 'LabTrack', 'MaterialIntake', 'Tech', () => { return emptyVariants('MaterialIntake'); }, () => { return Object.values(F.labCoverageAggs(1)); } ],
	[ 'E3A as tenant 2', 'LabTrack', 'MaterialIntakeRequirement', 'OtherTech', () => { return emptyVariants('MaterialIntakeRequirement'); }, () => { return F.e3aAggs(101, 'TenantOnly'); } ]
];

/**
 * Bookstore Aggs (M1 kinds over decimals / dates / strings; no tenancy on 'Bookstore').
 *
 * @return {Array<[ string, string, Array<Record<string, any>> ]>} [ Name, Entity, Aggs ]
 */
const bookstoreGoldenAggs = () =>
{
	let fNumeric = (pField, pScale, pMode, pExtra) => { return Object.assign({ Kind: 'NumericBucket', Field: pField, Mode: pMode, Buckets: 10, Edges: null, OpenEnded: false, DataType: pScale ? 'Decimal' : 'Numeric', IsInteger: !pScale, Scale: pScale }, pExtra || {}); };
	return (
		[
			[ 'Sale', 'BookStoreSale',
				[
					F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'BookStoreSale' }),
					F.agg({ Key: 'Pay', Kind: 'Terms', Pivot: 'BookStoreSale', Top: 3, SelectedKeys: [ 'Cash' ], Dimensions: [ F.columnDim('PaymentMethod', 'String') ] }),
					F.agg({ Key: 'Month', Kind: 'DateHistogram', Pivot: 'BookStoreSale', Dimensions: [ F.dateDim('SaleDate', 'month') ] }),
					F.agg({ Key: 'AmountNice', Kind: 'NumericHistogram', Pivot: 'BookStoreSale', Dimensions: [ fNumeric('TotalAmount', 2, 'Nice') ] }),
					F.agg({ Key: 'AmountEdges', Kind: 'NumericHistogram', Pivot: 'BookStoreSale', Dimensions: [ fNumeric('TotalAmount', 2, 'Edges', { Edges: [ 0, 50, 200 ], OpenEnded: true, Buckets: null }) ] }),
					F.agg({ Key: 'AmountRanges', Kind: 'Ranges', Pivot: 'BookStoreSale', Dimensions: [ { Kind: 'Range', Field: 'TotalAmount', Ranges: [ { Key: 'small', From: null, To: 50 }, { Key: 'medium', From: 50, To: 200 }, { Key: 'large', From: 200, To: null } ], DataType: 'Decimal', IsInteger: false, Scale: 2 } ] }),
					F.agg({ Key: 'AmountStats', Kind: 'Stats', Pivot: 'BookStoreSale', Field: 'TotalAmount', FieldInfo: { DataType: 'Decimal', Scale: 2 } }),
					F.agg({ Key: 'StoreStats', Kind: 'Stats', Pivot: 'BookStoreSale', Field: 'IDBookStore', FieldInfo: { DataType: 'Numeric', Scale: 0 } }),
					F.agg({ Key: 'DateStats', Kind: 'Stats', Pivot: 'BookStoreSale', Field: 'SaleDate', FieldInfo: { DataType: 'DateTime', Scale: 0 } }),
					F.agg({ Key: 'PayDistinct', Kind: 'DistinctCount', Pivot: 'BookStoreSale', Field: 'PaymentMethod', FieldInfo: { DataType: 'String', Scale: 0 } }),
					F.agg({ Key: 'PayMissing', Kind: 'Missing', Pivot: 'BookStoreSale', Field: 'PaymentMethod', FieldInfo: { DataType: 'String', Scale: 0 } }),
					F.agg({ Key: 'PayByYear', Kind: 'Pivot', Pivot: 'BookStoreSale', Top: null, Dimensions: [ F.columnDim('PaymentMethod', 'String'), F.dateDim('SaleDate', 'year') ] }),
					F.agg({ Key: 'PayByAmount', Kind: 'Pivot', Pivot: 'BookStoreSale', Top: null, Dimensions: [ F.columnDim('PaymentMethod', 'String'), { Kind: 'Range', Field: 'TotalAmount', Ranges: [ { Key: 'small', From: null, To: 50 }, { Key: 'large', From: 50, To: null } ], DataType: 'Decimal', IsInteger: false, Scale: 2 } ] })
				] ]
		]);
};

suite
(
	'Facet-ClickHouse-Compiler',
	() =>
	{
		// ============================================================ the compiler (pure)

		suite
		(
			'Compiler: predicates, values and the captured scope (§63.2–§63.3)',
			() =>
			{
				test('the module exports and its constants',
					() =>
					{
						Expect(libFoldCompiler.COMPILER_VERSION).to.equal(1);
						Expect(libFoldCompiler.READ_SETTINGS).to.include({ enable_extended_results_for_datetime_functions: 1, join_use_nulls: 1, transform_null_in: 0, output_format_json_quote_64bit_integers: 1 });
						Expect(libFoldCompiler.REASON_CLASSES).to.include.members([ 'NotMirrored', 'LossyColumn', 'ScopeMissing', 'OpaqueScope', 'StoreError', 'ShapeUnsupported' ]);
						Expect(libFoldCompiler.paramName('p', 3)).to.equal('p_3');
						Expect(() => { libFoldCompiler.paramName('1x', 0); }).to.throw();
						[ 'compileAgg', 'compileCube', 'compileRelation', 'compileFilter', 'compileFoldPred', 'dimensionExpression', 'collectRelations' ].forEach((pName) => { Expect(libFoldCompiler[pName], pName).to.be.a('function'); });
					});

				test('a relation is one FINAL scan with _IsDeleted = 0 and its captured filter, every value a typed parameter',
					() =>
					{
						let tmpResult = libFoldCompiler.compileRelation({ As: 'p', Project: [ 'IDProject', 'Status' ] },
							input({ p: relation('Project', [ OPEN(), E('IDClient', 'IN', [ 3, 5 ]), CLOSE() ].concat(SCOPED(1))) }));
						Expect(tmpResult.SQL).to.equal('(SELECT `IDProject`, `Status` FROM `rfs_main`.`Project` FINAL WHERE `_IsDeleted` = 0 AND (( `IDClient` IN {p_0:Array(Int64)} ) AND `Deleted` = {p_1:UInt8} AND `IDCustomer` = {p_2:Int64})) AS p');
						Expect(tmpResult.Params).to.deep.equal({ p_0: [ 3, 5 ], p_1: 0, p_2: 1 });
						Expect(tmpResult.Types).to.deep.equal({ p_0: 'Array(Int64)', p_1: 'UInt8', p_2: 'Int64' });
						// A global entity without a filter: no AND ( … ).
						let tmpGlobal = libFoldCompiler.compileRelation({ As: 'l1', Project: [ 'IDFormType', 'Name' ] }, input({ l1: relation('FormType', []) }));
						Expect(tmpGlobal.SQL).to.equal('(SELECT `IDFormType`, `Name` FROM `rfs_main`.`FormType` FINAL WHERE `_IsDeleted` = 0) AS l1');
					});

				test('operators: = != <> < <= > >=, IN / NOT IN (NULL-safe), IS NULL forms, NULL comparisons, empty IN, OR groups as FoxHound renders them',
					() =>
					{
						let tmpSpec = SPECS.Project;
						let tmpResult = libFoldCompiler.compileFilter(tmpSpec,
							[
								E('IDClient', '!=', 4), E('IDClient', '<>', 5, 'AND'), E('IDClient', '<', 9), E('IDClient', '<=', 8), E('IDClient', '>', 1), E('IDClient', '>=', 2),
								OPEN('AND'), E('Status', 'IN', [ 'A', 'B' ]), E('Status', 'NOT IN', [ 'C' ], 'OR'), CLOSE(),
								E('StartDate', 'IS', null), E('Name', 'IS NULL', ''), E('OwnerIDUser', 'IS NOT NULL', ''),
								E('IDClient', '=', null), E('Status', 'IN', []), E('Status', 'NOT IN', [])
							], { SourceDialect: 'SQLite' });
						Expect(tmpResult.SQL).to.equal('`IDClient` != {w_0:Int64} AND `IDClient` != {w_1:Int64} AND `IDClient` < {w_2:Int64} AND `IDClient` <= {w_3:Int64} AND `IDClient` > {w_4:Int64} AND `IDClient` >= {w_5:Int64}'
							+ ' AND ( `Status` IN {w_6:Array(String)} OR (isNotNull(`Status`) AND NOT (`Status` IN {w_7:Array(String)})) )'
							+ ' AND isNull(`StartDate`) AND isNull(`Name`) AND isNotNull(`OwnerIDUser`) AND 0 AND 0 AND 1');
						Expect(tmpResult.Params).to.deep.equal({ w_0: 4, w_1: 5, w_2: 9, w_3: 8, w_4: 1, w_5: 2, w_6: [ 'A', 'B' ], w_7: [ 'C' ] });
						// The first entry of a group ignores its connector; a qualified column of the entity's own table is fine.
						let tmpGroup = libFoldCompiler.compileFilter(tmpSpec, [ OPEN('OR'), E('Project.Status', '=', 'A', 'OR'), E('`Project`.`Name`', '=', 'B', 'OR'), CLOSE() ], { SourceDialect: 'SQLite', Prefix: 'c' });
						Expect(tmpGroup.SQL).to.equal('( `Status` = {c_0:String} OR `Name` = {c_1:String} )');
					});

				test('M5 review: a column NOT IN drops NULL rows (three-valued logic, like FoxHound SQL) — an anti-join keeps them; a parameter over the HTTP field limit is refused (ParameterSize); request reads are readonly = 2',
					() =>
					{
						// Column NOT IN: (isNotNull(c) AND NOT (c IN p)) — NULL NOT IN (…) is unknown in SQL, so Live drops
						// the row; 'NOT ifNull(c IN p, 0)' would keep it (the review's Genre NIN repro: 1009 vs 988).
						let tmpString = libFoldCompiler.compileFilter(SPECS.Project, [ E('Status', 'NOT IN', [ 'Done' ]) ], { SourceDialect: 'SQLite' });
						Expect(tmpString.SQL).to.equal('(isNotNull(`Status`) AND NOT (`Status` IN {w_0:Array(String)}))');
						let tmpInt = libFoldCompiler.compileFilter(SPECS.Project, [ E('IDClient', 'NOT IN', [ 3, 5 ]) ], { SourceDialect: 'PostgreSQL' });
						Expect(tmpInt.SQL).to.equal('(isNotNull(`IDClient`) AND NOT (`IDClient` IN {w_0:Array(Int64)}))');
						// A NOT IN inside an OR group keeps its guard.
						let tmpOr = libFoldCompiler.compileFilter(SPECS.Project, [ OPEN('AND'), E('Status', '=', 'A'), E('IDClient', 'NOT IN', [ 3 ], 'OR'), CLOSE() ], { SourceDialect: 'SQLite' });
						Expect(tmpOr.SQL).to.equal('( `Status` = {w_0:String} OR (isNotNull(`IDClient`) AND NOT (`IDClient` IN {w_1:Array(Int64)})) )');
						// A huge IN list (a client list, a behavior-appended key set): refused before any round trip.
						let tmpHuge = [];
						for (let i = 0; i < 20000; i++)
						{
							tmpHuge.push(`a-rather-long-status-value-${i}`);
						}
						expectRefused(libFoldCompiler.compileFilter(SPECS.Project, [ E('Status', 'IN', tmpHuge) ], { SourceDialect: 'SQLite' }), 'ParameterSize');
						Expect(libFoldCompiler.REASON_CLASSES).to.include.members([ 'ParameterSize', 'StoreBusy', 'Freshness' ]);
						Expect(libFoldCompiler.MAX_PARAM_TEXT).to.be.below(libClickHouseClientForTests.MAX_PARAM_TEXT);
						// Every request read: never a write or DDL, whatever the credential could do.
						Expect(libFoldCompiler.READ_SETTINGS.readonly).to.equal(2);
					});

				test('value typing: integer literals on Int64, numeric text on Float64, 0 / 1 on UInt8, strings on String — anything else is ValueType',
					() =>
					{
						let tmpOK = libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('IDBookStore', '=', '12'), E('TotalAmount', '>=', '4.5'), E('Deleted', '=', '0'), E('Deleted', '=', true) ], { SourceDialect: 'SQLite' });
						// A Float64 value travels as its round-trip text, converted with toFloat64 (§68 #22: {p:Float64} parses inexactly on 24.8).
						Expect(tmpOK.Params).to.deep.equal({ w_0: 12, w_1: '4.5', w_2: 0, w_3: 1 });
						Expect(tmpOK.Types).to.deep.equal({ w_0: 'Int64', w_1: 'String', w_2: 'UInt8', w_3: 'UInt8' });
						Expect(tmpOK.SQL).to.include('`TotalAmount` >= toFloat64({w_1:String})');
						let tmpFloatIn = libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('TotalAmount', 'IN', [ 5.94, '7.56' ]), E('TotalAmount', 'NOT IN', [ 1.1 ]) ], { SourceDialect: 'SQLite' });
						Expect(tmpFloatIn.SQL).to.equal('has(arrayMap(rfsValue -> toFloat64(rfsValue), {w_0:Array(String)}), `TotalAmount`) AND (isNotNull(`TotalAmount`) AND NOT (has(arrayMap(rfsValue -> toFloat64(rfsValue), {w_1:Array(String)}), `TotalAmount`)))');
						Expect(tmpFloatIn.Params).to.deep.equal({ w_0: [ '5.94', '7.56' ], w_1: [ '1.1' ] });
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('IDBookStore', '=', '4.5') ], { SourceDialect: 'SQLite' }), 'ValueType:BookStoreSale.IDBookStore');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('IDBookStore', '>', 4.5) ], { SourceDialect: 'SQLite' }), 'ValueType:BookStoreSale.IDBookStore');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('PaymentMethod', '=', 5) ], { SourceDialect: 'SQLite' }), 'ValueType:BookStoreSale.PaymentMethod');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('Deleted', '=', 'true') ], { SourceDialect: 'SQLite' }), 'ValueType:BookStoreSale.Deleted');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('TotalAmount', '=', 'abc') ], { SourceDialect: 'SQLite' }), 'ValueType:BookStoreSale.TotalAmount');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('IDBookStore', 'IN', [ 1, null ]) ], { SourceDialect: 'SQLite' }), 'ValueType:BookStoreSale.IDBookStore');
					});

				test('DateTime literals follow the source dialect (canonical everywhere; day-only only under >= / < on SQLite)',
					() =>
					{
						let tmpOK = libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('SaleDate', '>=', '2025-03-01'), E('SaleDate', '<', '2026-07-01'), E('SaleDate', '=', '2025-05-05 10:30:00') ], { SourceDialect: 'SQLite' });
						Expect(tmpOK.Params).to.deep.equal({ w_0: '2025-03-01 00:00:00', w_1: '2026-07-01 00:00:00', w_2: '2025-05-05 10:30:00' });
						Expect(tmpOK.Types.w_0).to.equal("DateTime64(3, 'UTC')");
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('SaleDate', '>', '2025-03-01') ], { SourceDialect: 'SQLite' }), 'DateLiteral:BookStoreSale.SaleDate');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('SaleDate', '=', '2025-03-01') ], { SourceDialect: 'SQLite' }), 'DateLiteral:BookStoreSale.SaleDate');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('SaleDate', '>=', '2025-03-01T00:00:00') ], { SourceDialect: 'SQLite' }), 'DateLiteral:BookStoreSale.SaleDate');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('SaleDate', '<', '1800-01-01 00:00:00') ], { SourceDialect: 'PostgreSQL' }), 'DateLiteral:BookStoreSale.SaleDate');
						// PostgreSQL compares a day-only literal as a timestamp under every operator.
						let tmpPostgreSQL = libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('SaleDate', '>', '2025-03-01'), E('SaleDate', 'IN', [ '2025-03-02' ]) ], { SourceDialect: 'PostgreSQL' });
						Expect(tmpPostgreSQL.Params).to.deep.equal({ w_0: '2025-03-01 00:00:00', w_1: [ '2025-03-02 00:00:00' ] });
						Expect(tmpPostgreSQL.Types.w_1).to.equal("Array(DateTime64(3, 'UTC'))");
					});

				test('LIKE follows the source dialect: ILIKE with doubled backslashes on SQLite (ASCII only), LIKE on PostgreSQL; ILIKE transforms; LIKE only on String',
					() =>
					{
						let tmpSQLite = libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('PaymentMethod', 'LIKE', 'Cr\\_%'), E('PaymentMethod', 'NOT LIKE', '%x%') ], { SourceDialect: 'SQLite' });
						Expect(tmpSQLite.SQL).to.equal('`PaymentMethod` ILIKE {w_0:String} AND `PaymentMethod` NOT ILIKE {w_1:String}');
						Expect(tmpSQLite.Params.w_0).to.equal('Cr\\\\_%');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('PaymentMethod', 'LIKE', 'Ç%') ], { SourceDialect: 'SQLite' }), 'LikeCase:BookStoreSale.PaymentMethod');
						let tmpPostgreSQL = libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('PaymentMethod', 'LIKE', 'Ç\\_%'), E('PaymentMethod', 'ILIKE', 'x%'), E('PaymentMethod', 'NOT ILIKE', 'y%') ], { SourceDialect: 'PostgreSQL' });
						Expect(tmpPostgreSQL.SQL).to.equal('`PaymentMethod` LIKE {w_0:String} AND `PaymentMethod` ILIKE {w_1:String} AND `PaymentMethod` NOT ILIKE {w_2:String}');
						Expect(tmpPostgreSQL.Params.w_0).to.equal('Ç\\_%');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('TotalAmount', 'LIKE', '1%') ], { SourceDialect: 'SQLite' }), 'OperatorType:BookStoreSale.TotalAmount');
					});

				test('String ranges compile only under a Binary source order',
					() =>
					{
						Expect(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('PaymentMethod', '>=', 'C') ], { SourceDialect: 'SQLite' }).SQL).to.equal('`PaymentMethod` >= {w_0:String}');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('PaymentMethod', '<', 'C') ], { SourceDialect: 'PostgreSQL' }), 'StringOrder:BookStoreSale.PaymentMethod');
						Expect(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('PaymentMethod', '<', 'C') ], { SourceDialect: 'PostgreSQL', SourceStringOrder: 'Binary' }).SQL).to.equal('`PaymentMethod` < {w_0:String}');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('PaymentMethod', '<', 'C') ], { SourceDialect: 'SQLite', SourceStringOrder: 'Collated' }), 'StringOrder:BookStoreSale.PaymentMethod');
						// Equality on a string is exact on every source.
						Expect(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('PaymentMethod', '=', 'C') ], { SourceDialect: 'PostgreSQL' }).SQL).to.equal('`PaymentMethod` = {w_0:String}');
					});

				test('unsupported operators, connectors and malformed groups are refused, never guessed',
					() =>
					{
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('PaymentMethod', 'REGEXP', 'C.*') ], { SourceDialect: 'SQLite' }), 'OperatorUnsupported:REGEXP');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('PaymentMethod', 'IS', 'x') ], { SourceDialect: 'SQLite' }), 'OperatorUnsupported:IS');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('PaymentMethod', '=', 'x'), E('IDBookStore', '=', 1, 'NONE') ], { SourceDialect: 'SQLite' }), 'OperatorUnsupported:NONE');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('PaymentMethod', '=', 'x', 'XOR') ], { SourceDialect: 'SQLite' }), 'OperatorUnsupported:XOR');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ OPEN(), E('PaymentMethod', '=', 'x') ], { SourceDialect: 'SQLite' }), 'ShapeUnsupported:Parentheses');
						expectRefused(libFoldCompiler.compileFilter(SPECS.BookStoreSale, [ E('Other.PaymentMethod', '=', 'x') ], { SourceDialect: 'SQLite' }), 'OpaqueScope:BookStoreSale');
					});

				test('the whitelist: an unmirrored entity or column, a column still filling, Lossy columns (Value anywhere, Compare in predicates only)',
					() =>
					{
						let tmpAgg = F.agg({ Key: 'S', Kind: 'Terms', Pivot: 'Project', Dimensions: [ F.columnDim('Status', 'String') ] });
						let tmpScoped = { p: relation('Project', SCOPED(1)) };
						expectRefused(libFoldCompiler.compileAgg(F.agg({ Key: 'X', Kind: 'Count', Pivot: 'Issue' }), input({ p: relation('Issue', SCOPED(1)) })), 'NotMirrored:Issue');
						expectRefused(libFoldCompiler.compileAgg(F.agg({ Key: 'S', Kind: 'Terms', Pivot: 'Project', Dimensions: [ F.columnDim('Summary', 'String') ] }), input(tmpScoped)), 'NotMirrored:Project.Summary');
						expectRefused(libFoldCompiler.compileAgg(tmpAgg, input(tmpScoped, { Filling: { Project: [ 'Status' ] } })), 'NotMirrored:Project.Status');
						expectRefused(libFoldCompiler.compileAgg(tmpAgg, input(tmpScoped, { Lossy: { Project: { Status: 'Value' } } })), 'LossyColumn:Project.Status');
						// 'Compare': a predicate naming the column is refused; a dimension reading it is not.
						let tmpDate = F.agg({ Key: 'D', Kind: 'DateHistogram', Pivot: 'Project', Dimensions: [ F.dateDim('StartDate', 'month') ] });
						Expect(libFoldCompiler.compileAgg(tmpDate, input(tmpScoped, { Lossy: { Project: { StartDate: 'Compare' } } })).Refused).to.equal(undefined);
						expectRefused(libFoldCompiler.compileAgg(tmpDate, input({ p: relation('Project', [ OPEN(), E('StartDate', '>=', '2024-01-01'), CLOSE() ].concat(SCOPED(1))) }, { Lossy: { Project: { StartDate: 'Compare' } } })), 'LossyColumn:Project.StartDate');
						// A behavior-appended entry naming a column the spec lacks (§63.2 dynamic check).
						expectRefused(libFoldCompiler.compileAgg(tmpAgg, input({ p: relation('Project', SCOPED(1).concat([ E('Secret', '=', 1) ])) })), 'NotMirrored:Project.Secret');
					});

				test('fail closed: a tenant relation whose final filter lost its depth-0 tenant entry (or holds a depth-0 OR) is ScopeMissing; Opaque captures are OpaqueScope',
					() =>
					{
						let tmpAgg = F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'Project' });
						expectRefused(libFoldCompiler.compileAgg(tmpAgg, input({ p: relation('Project', [ E('Deleted', '=', 0) ]) })), 'ScopeMissing:Project');
						expectRefused(libFoldCompiler.compileAgg(tmpAgg, input({ p: relation('Project', [ OPEN(), E('IDCustomer', '=', 1), CLOSE(), E('Deleted', '=', 0) ]) })), 'ScopeMissing:Project');
						expectRefused(libFoldCompiler.compileAgg(tmpAgg, input({ p: relation('Project', [ E('Deleted', '=', 0), E('IDCustomer', '=', 1), E('IDClient', '=', 2, 'OR') ]) })), 'ScopeMissing:Project');
						expectRefused(libFoldCompiler.compileAgg(tmpAgg, input({ p: relation('Project', [ E('Deleted', '=', 0), E('IDCustomer', '=', '') ]) })), 'ScopeMissing:Project');
						expectRefused(libFoldCompiler.compileAgg(tmpAgg, input({ p: relation('Project', SCOPED(1), { Opaque: true, Portable: false }) })), 'OpaqueScope:Project');
						expectRefused(libFoldCompiler.compileAgg(tmpAgg, input({ p: relation('Project', SCOPED(1), { Portable: false }) })), 'OpaqueScope:Project');
						// A Personal entity relaxed to TenantOnly keeps its tenant entry (owner removed): scoped.
						let tmpRelaxed = libFoldCompiler.compileAgg(F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'LabForm' }), input({ p: relation('LabForm', SCOPED(1)) }));
						Expect(tmpRelaxed.Refused).to.equal(undefined);
						// A global entity has no tenant to check.
						Expect(libFoldCompiler.compileAgg(F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'FormType' }), input({ p: relation('FormType', []) })).Refused).to.equal(undefined);
					});

				test('fragments render the probed post-behavior operators (ILIKE); a transform the compiler cannot reproduce is Transformed',
					() =>
					{
						let tmpWhere = F.cmp('p', 'Status', 'LK', 'act%');
						let tmpAgg = F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'Project', Where: tmpWhere, WhereHash: 'wh:lk' });
						let tmpSignature = libFoldCompiler.entrySignature({ Column: 'Status', Operator: 'LIKE', Value: 'act%' });
						Expect(tmpSignature).to.equal('Status|LIKE|"act%"');
						let tmpPlain = only(libFoldCompiler.compileAgg(tmpAgg, input({ p: relation('Project', SCOPED(1)) })));
						Expect(tmpPlain.SQL).to.include('WHERE (p.`Status` ILIKE {q1_0:String})');
						let tmpTransformedPG = only(libFoldCompiler.compileAgg(tmpAgg, input({ p: relation('Project', SCOPED(1)) }, { SourceDialect: 'PostgreSQL', Fragments: { Project: { [tmpSignature]: 'ILIKE' } } })));
						Expect(tmpTransformedPG.SQL).to.include('WHERE (p.`Status` ILIKE {q1_0:String})');
						let tmpUntransformedPG = only(libFoldCompiler.compileAgg(tmpAgg, input({ p: relation('Project', SCOPED(1)) }, { SourceDialect: 'PostgreSQL' })));
						Expect(tmpUntransformedPG.SQL).to.include('WHERE (p.`Status` LIKE {q1_0:String})');
						expectRefused(libFoldCompiler.compileAgg(tmpAgg, input({ p: relation('Project', SCOPED(1)) }, { Fragments: { Project: { [tmpSignature]: '~*' } } })), 'Transformed:Project');
					});

				test('correlation across more than one level and a DateTime Terms key are ShapeUnsupported (the Agg runs Live)',
					() =>
					{
						// An inner On pair naming the pivot from inside a nested existence (multi-level correlation).
						let tmpWhere = F.exists(F.rel('Task', 'j1', [ 'IDTask', 'IDProject' ]), [ F.on('p', 'IDProject', 'IDProject') ],
							F.exists(F.rel('Client', 'j2', [ 'IDClient' ]), [ F.on('p', 'IDClient', 'IDClient') ]));
						expectRefused(libFoldCompiler.compileAgg(F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'Project', Where: tmpWhere }),
							input({ p: relation('Project', SCOPED(1)), j1: relation('Task', SCOPED(1)), j2: relation('Client', SCOPED(1)) })), 'ShapeUnsupported:Correlation');
						expectRefused(libFoldCompiler.compileAgg(F.agg({ Key: 'D', Kind: 'Terms', Pivot: 'Project', Dimensions: [ F.columnDim('StartDate', 'DateTime') ] }), input({ p: relation('Project', SCOPED(1)) })), 'ShapeUnsupported:DateTimeKey');
						expectRefused(libFoldCompiler.compileAgg({ Key: 'X', Kind: 'Bogus', Pivot: 'Project', Dimensions: [] }, input({ p: relation('Project', SCOPED(1)) })), 'KindUnsupported:Bogus');
					});
			}
		);

		suite
		(
			'Compiler: kinds, row shapes and the §63.7 worked examples',
			() =>
			{
				const P1 = () => { return relation('Project', [ OPEN(), E('IDClient', 'IN', [ 3, 5 ]), CLOSE() ].concat(SCOPED(1))); };

				test('§63.7 K1 Terms: the ranked window over one FINAL scan, Live\'s rank cut (Top + 1, MaxTermsGroups) and the typed selected keys',
					() =>
					{
						let tmpStatement = only(libFoldCompiler.compileAgg(F.agg({ Key: 'Status', Kind: 'Terms', Pivot: 'Project', Top: 10, SelectedKeys: [ 'Active', 7 ], Dimensions: [ F.columnDim('Status', 'String') ] }), input({ p: P1() })));
						Expect(tmpStatement.Purpose).to.equal('Terms');
						Expect(tmpStatement.SQL).to.equal('SELECT Key, Count, FacetTotal, FacetMissing, FacetDistinct FROM (SELECT Key, Count, sum(Count) OVER () AS FacetTotal, sumIf(Count, isNull(Key)) OVER () AS FacetMissing,'
							+ ' countIf(isNotNull(Key)) OVER () AS FacetDistinct, rank() OVER (ORDER BY isNull(Key) ASC, Count DESC) AS FacetRank,'
							+ ' row_number() OVER (ORDER BY isNull(Key) ASC, Count DESC, Key ASC) AS FacetRow FROM (SELECT p.`Status` AS Key, count() AS Count'
							+ ' FROM (SELECT `IDProject`, `Status` FROM `rfs_main`.`Project` FINAL WHERE `_IsDeleted` = 0 AND (( `IDClient` IN {p_0:Array(Int64)} ) AND `Deleted` = {p_1:UInt8} AND `IDCustomer` = {p_2:Int64})) AS p GROUP BY Key))'
							+ ' WHERE (FacetRank <= {fTopPlusOne:UInt32} AND FacetRow <= {fMaxGroups:UInt32}) OR Key IN {fSelected:Array(String)} ORDER BY FacetRow');
						Expect(tmpStatement.Params).to.deep.equal({ p_0: [ 3, 5 ], p_1: 0, p_2: 1, fTopPlusOne: 11, fMaxGroups: 10000, fSelected: [ 'Active' ] });
						Expect(tmpStatement.MaxRows).to.equal(10001);
						// An integer key binds Array(Int64) keys (numeric strings normalized; non-numbers dropped); none selected → no OR.
						let tmpClient = only(libFoldCompiler.compileAgg(F.agg({ Key: 'Client', Kind: 'Terms', Pivot: 'Project', SelectedKeys: [ '3', 5, 'x' ], Dimensions: [ F.columnDim('IDClient', 'Numeric') ] }), input({ p: P1() })));
						Expect(tmpClient.Params.fSelected).to.deep.equal([ 3, 5 ]);
						Expect(tmpClient.Types.fSelected).to.equal('Array(Int64)');
						let tmpNone = only(libFoldCompiler.compileAgg(F.agg({ Key: 'Status', Kind: 'Terms', Pivot: 'Project', Dimensions: [ F.columnDim('Status', 'String') ] }), input({ p: P1() })));
						Expect(tmpNone.SQL).to.not.include('fSelected');
						Expect(tmpNone.Params.fTopPlusOne).to.equal(51);
					});

				test('§63.7 K2 DateHistogram: toStartOfMonth in Date32, the wire format, bounds per bucket, MaxDateBuckets + 2 rows',
					() =>
					{
						let tmpStatement = only(libFoldCompiler.compileAgg(F.agg({ Key: 'ByMonth', Kind: 'DateHistogram', Pivot: 'Document', Dimensions: [ F.dateDim('DocumentDate', 'month') ] }),
							input({ p: relation('Document', [ OPEN(), E('IDFormType', 'IN', [ 4 ]), CLOSE() ].concat(SCOPED(1))) })));
						Expect(tmpStatement.SQL).to.equal("SELECT formatDateTime(B, '%Y-%m-%d 00:00:00') AS Key, Count, formatDateTime(LoV, '%Y-%m-%d %H:%i:%S') AS Lo, formatDateTime(HiV, '%Y-%m-%d %H:%i:%S') AS Hi"
							+ ' FROM (SELECT toStartOfMonth(p.`DocumentDate`) AS B, count() AS Count, min(p.`DocumentDate`) AS LoV, max(p.`DocumentDate`) AS HiV'
							+ ' FROM (SELECT `IDDocument`, `DocumentDate` FROM `rfs_main`.`Document` FINAL WHERE `_IsDeleted` = 0 AND (( `IDFormType` IN {p_0:Array(Int64)} ) AND `Deleted` = {p_1:UInt8} AND `IDCustomer` = {p_2:Int64})) AS p GROUP BY B)'
							+ ' ORDER BY isNull(B), B LIMIT {fMaxGroups:UInt32}');
						Expect(tmpStatement.Params.fMaxGroups).to.equal(402);
						Expect(tmpStatement.Settings.enable_extended_results_for_datetime_functions).to.equal(1);
						let tmpIntervals = { day: 'toDate32', week: 'toMonday', quarter: 'toStartOfQuarter', year: 'toStartOfYear' };
						Object.keys(tmpIntervals).forEach(
							(pInterval) =>
							{
								let tmpOther = only(libFoldCompiler.compileAgg(F.agg({ Key: 'D', Kind: 'DateHistogram', Pivot: 'Document', Dimensions: [ F.dateDim('DocumentDate', pInterval) ] }), input({ p: relation('Document', SCOPED(1)) })));
								Expect(tmpOther.SQL, pInterval).to.include(`${tmpIntervals[pInterval]}(p.\`DocumentDate\`) AS B`);
							});
					});

				test('§63.7 K10 PathSemiJoin: the Variant path predicate as a NULL-safe IN subquery over the hop\'s own scoped relation',
					() =>
					{
						let tmpPath = F.exists(F.rel('ProjectMembership', 'h1', [ 'IDProjectMembership', 'IDProject' ], { Where: { And: [ { Field: 'IDUser', Op: 'EQ', Value: 42 }, { Field: 'Active', Op: 'EQ', Value: 1 } ] } }), [ F.on('p', 'IDProject', 'IDProject') ]);
						let tmpStatement = only(libFoldCompiler.compileAgg(F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'Project' }),
							input({ p: relation('Project', SCOPED(1)), h1: relation('ProjectMembership', [ OPEN(), OPEN(), E('IDUser', '=', 42), E('Active', '=', 1), CLOSE(), CLOSE() ].concat(SCOPED(1))) }, { Variant: { PathPred: tmpPath } })));
						Expect(tmpStatement.SQL).to.equal('SELECT count() AS Total FROM (SELECT p.`IDProject` AS `IDProject` FROM (SELECT `IDProject` FROM `rfs_main`.`Project` FINAL WHERE `_IsDeleted` = 0 AND (`Deleted` = {p_0:UInt8} AND `IDCustomer` = {p_1:Int64})) AS p'
							+ ' WHERE ifNull(p.`IDProject` IN (SELECT h1.`IDProject` FROM (SELECT `IDProjectMembership`, `IDProject` FROM `rfs_main`.`ProjectMembership` FINAL WHERE `_IsDeleted` = 0'
							+ ' AND (( ( `IDUser` = {h1_0:Int64} AND `Active` = {h1_1:UInt8} ) ) AND `Deleted` = {h1_2:UInt8} AND `IDCustomer` = {h1_3:Int64})) AS h1), 0)) AS p');
						Expect(tmpStatement.Params).to.deep.equal({ p_0: 0, p_1: 1, h1_0: 42, h1_1: 1, h1_2: 0, h1_3: 1 });
					});

				test('§63.7 K11 AntiPath: a composite NOT ifNull(tuple IN …) over the TenantOnly hop (no owner entry), a NULL outer value stays "to do"',
					() =>
					{
						let tmpWhere = F.notExists(F.rel('LabForm', 'h2', [ 'IDLabForm', 'IDMaterialIntake', 'IDLabFormType' ], { Where: { Field: 'Status', Op: 'EQ', Value: 'Complete' }, Scope: 'TenantOnly', ScopeReason: 'x' }),
							[ F.on('p', 'IDMaterialIntake', 'IDMaterialIntake'), F.on('p', 'IDLabFormType', 'IDLabFormType') ]);
						let tmpStatement = only(libFoldCompiler.compileAgg(F.agg({ Key: 'ToDo', Kind: 'Terms', Pivot: 'MaterialIntakeRequirement', Where: tmpWhere, Dimensions: [ F.columnDim('IDLabFormType', 'Numeric') ] }),
							input({ p: relation('MaterialIntakeRequirement', SCOPED(1)), h2: relation('LabForm', [ OPEN(), E('Status', '=', 'Complete'), CLOSE() ].concat(SCOPED(1))) })));
						Expect(tmpStatement.SQL).to.include('WHERE NOT ifNull((p.`IDMaterialIntake`, p.`IDLabFormType`) IN (SELECT h2.`IDMaterialIntake`, h2.`IDLabFormType` FROM (SELECT `IDLabForm`, `IDLabFormType`, `IDMaterialIntake` FROM `rfs_main`.`LabForm` FINAL WHERE `_IsDeleted` = 0 AND (( `Status` = {h2_0:String} ) AND `Deleted` = {h2_1:UInt8} AND `IDCustomer` = {h2_2:Int64})) AS h2), 0)');
						Expect(tmpStatement.SQL).to.not.include('OwnerIDUser');
						Expect(tmpStatement.Types.fSelected).to.equal(undefined);
					});

				test('§63.7 K12 ChildRollup: the restricted child count as a LEFT JOIN (join_use_nulls), bands with Edges[0] = 1',
					() =>
					{
						let tmpBand = { Kind: 'ChildAgg', Rel: F.rel('Task', 'x1', [ 'IDTask', 'IDProject' ], { Role: 'Child', Where: { And: [ { Field: 'AssignedIDUser', Op: 'EQ', Value: 42 }, { Field: 'DueDate', Op: 'LT', Value: '2026-10-08 12:00:00' } ] } }),
							On: [ F.on('p', 'IDProject', 'IDProject') ], Where: null, Agg: 'count', Field: null, Edges: [ 1, 3, 10 ], DataType: 'Numeric', IsInteger: true, Scale: 0 };
						let tmpStatement = only(libFoldCompiler.compileAgg(F.agg({ Key: 'MyOverdueBand', Kind: 'ChildRollup', Pivot: 'Project', Dimensions: [ tmpBand ] }),
							input({ p: relation('Project', SCOPED(1)), x1: relation('Task', [ OPEN(), OPEN(), E('AssignedIDUser', '=', 42), E('DueDate', '<', '2026-10-08 12:00:00'), CLOSE(), CLOSE() ].concat(SCOPED(1))) })));
						Expect(tmpStatement.Purpose).to.equal('KeyGroups');
						Expect(tmpStatement.SQL).to.equal('SELECT Key, count() AS Count FROM (SELECT multiIf(p.`FacetC0` < {fE0:Int64}, 0, p.`FacetC0` < {fE1:Int64}, 1, p.`FacetC0` < {fE2:Int64}, 2, 3) AS Key'
							+ ' FROM (SELECT p.`IDProject` AS `IDProject`, ifNull(ca0.`N`, 0) AS `FacetC0` FROM (SELECT `IDProject` FROM `rfs_main`.`Project` FINAL WHERE `_IsDeleted` = 0 AND (`Deleted` = {p_0:UInt8} AND `IDCustomer` = {p_1:Int64})) AS p'
							+ ' LEFT JOIN (SELECT x1.`IDProject` AS `K0`, count() AS `N` FROM (SELECT `IDTask`, `IDProject` FROM `rfs_main`.`Task` FINAL WHERE `_IsDeleted` = 0 AND (( ( `AssignedIDUser` = {x1_0:Int64} AND `DueDate` < {x1_1:DateTime64(3, \'UTC\')} ) ) AND `Deleted` = {x1_2:UInt8} AND `IDCustomer` = {x1_3:Int64})) AS x1'
							+ ' WHERE x1.`IDProject` IN (SELECT p2.`IDProject` FROM (SELECT `IDProject` FROM `rfs_main`.`Project` FINAL WHERE `_IsDeleted` = 0 AND (`Deleted` = {p_0:UInt8} AND `IDCustomer` = {p_1:Int64})) AS p2) GROUP BY `K0`) AS ca0 ON ca0.`K0` = p.`IDProject`) AS p) GROUP BY Key');
						Expect(tmpStatement.Params).to.deep.equal({ p_0: 0, p_1: 1, x1_0: 42, x1_1: '2026-10-08 12:00:00', x1_2: 0, x1_3: 1, fE0: 1, fE1: 3, fE2: 10 });
					});

				test('K19 CountCmp: P(0) false → ifNull(o IN (… HAVING P(count())), 0); P(0) true → NOT ifNull(o IN (… HAVING NOT P(count())), 0)',
					() =>
					{
						let fCount = (pOp, pN) => { return F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'Project', Where: F.countCmp(F.rel('Task', 'j1', [ 'IDTask', 'IDProject' ]), [ F.on('p', 'IDProject', 'IDProject') ], null, pOp, pN) }); };
						let tmpRelations = { p: relation('Project', SCOPED(1)), j1: relation('Task', SCOPED(1)) };
						let tmpFalse = only(libFoldCompiler.compileAgg(fCount('GE', 3), input(tmpRelations)));
						Expect(tmpFalse.SQL).to.include('WHERE ifNull(p.`IDProject` IN (SELECT j1.`IDProject` FROM (SELECT `IDTask`, `IDProject` FROM `rfs_main`.`Task` FINAL WHERE `_IsDeleted` = 0 AND (`Deleted` = {j1_0:UInt8} AND `IDCustomer` = {j1_1:Int64})) AS j1 GROUP BY j1.`IDProject` HAVING count() >= {q1_N:UInt64}), 0)');
						Expect(tmpFalse.Params.q1_N).to.equal(3);
						let tmpTrue = only(libFoldCompiler.compileAgg(fCount('LT', 2), input(tmpRelations)));
						Expect(tmpTrue.SQL).to.include('WHERE NOT ifNull(p.`IDProject` IN (SELECT j1.`IDProject` FROM (SELECT `IDTask`, `IDProject` FROM `rfs_main`.`Task` FINAL WHERE `_IsDeleted` = 0 AND (`Deleted` = {j1_0:UInt8} AND `IDCustomer` = {j1_1:Int64})) AS j1 GROUP BY j1.`IDProject` HAVING NOT (count() < {q1_N:UInt64})), 0)');
						Expect(only(libFoldCompiler.compileAgg(fCount('EQ', 0), input(tmpRelations))).SQL).to.include('HAVING NOT (count() = {q1_N:UInt64})');
						Expect(only(libFoldCompiler.compileAgg(fCount('NE', 0), input(tmpRelations))).SQL).to.include('HAVING count() != {q1_N:UInt64}');
					});

				test('K17 Any: an Or holding an existence node renders whole; its column leaves are inline qualified fragments',
					() =>
					{
						let tmpAny = F.or(F.exists(F.rel('ProjectMembership', 'h1', [ 'IDProjectMembership', 'IDProject' ]), [ F.on('p', 'IDProject', 'IDProject') ]), F.cmp('p', 'OwnerIDUser', 'EQ', 7), F.and(F.cmp('p', 'Status', 'EQ', 'Done'), F.cmp('p', 'IDClient', 'NULL')));
						let tmpStatement = only(libFoldCompiler.compileAgg(F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'Project', Where: tmpAny }),
							input({ p: relation('Project', SCOPED(1)), h1: relation('ProjectMembership', SCOPED(1)) })));
						Expect(tmpStatement.SQL).to.include('WHERE (ifNull(p.`IDProject` IN (SELECT h1.`IDProject` FROM (SELECT `IDProjectMembership`, `IDProject` FROM `rfs_main`.`ProjectMembership` FINAL WHERE `_IsDeleted` = 0 AND (`Deleted` = {h1_0:UInt8} AND `IDCustomer` = {h1_1:Int64})) AS h1), 0)'
							+ ' OR (p.`OwnerIDUser` = {q1_0:Int64}) OR (( p.`Status` = {q2_0:String} AND isNull(p.`IDClient`) )))');
					});

				test('K8 Via (two links): ANY LEFT JOIN of each link\'s scoped relation; the last link\'s field keys the fold',
					() =>
					{
						let tmpDimension = F.columnDim('Name', 'String', { Via: [ { Rel: F.rel('Project', 'l1', [ 'IDProject', 'IDClient' ], { Role: 'Lookup' }), On: [ F.on('p', 'IDProject', 'IDProject') ] },
							{ Rel: F.rel('Client', 'l2', [ 'IDClient', 'Name' ], { Role: 'Lookup' }), On: [ F.on('l1', 'IDClient', 'IDClient') ] } ] });
						let tmpStatement = only(libFoldCompiler.compileAgg(F.agg({ Key: 'ByClient', Kind: 'Terms', Pivot: 'Document', Dimensions: [ tmpDimension ] }),
							input({ p: relation('Document', SCOPED(1)), l1: relation('Project', SCOPED(1)), l2: relation('Client', SCOPED(1)) })));
						Expect(tmpStatement.SQL).to.include('SELECT p.`IDDocument` AS `IDDocument`, p.`IDProject` AS `IDProject`, l2.`Name` AS `FacetV0` FROM (SELECT `IDDocument`, `IDProject` FROM `rfs_main`.`Document` FINAL WHERE `_IsDeleted` = 0 AND (`Deleted` = {p_0:UInt8} AND `IDCustomer` = {p_1:Int64})) AS p'
							+ ' ANY LEFT JOIN (SELECT `IDProject`, `IDClient` FROM `rfs_main`.`Project` FINAL WHERE `_IsDeleted` = 0 AND (`Deleted` = {l1_0:UInt8} AND `IDCustomer` = {l1_1:Int64})) AS l1 ON l1.`IDProject` = p.`IDProject`'
							+ ' ANY LEFT JOIN (SELECT `IDClient`, `Name` FROM `rfs_main`.`Client` FINAL WHERE `_IsDeleted` = 0 AND (`Deleted` = {l2_0:UInt8} AND `IDCustomer` = {l2_1:Int64})) AS l2 ON l2.`IDClient` = l1.`IDClient`');
						Expect(tmpStatement.SQL).to.include('SELECT p.`FacetV0` AS Key, count() AS Count');
					});

				test('K9 Multi: three statements (uniqExact of the pivot key per chain key, the Total, the covered pivot rows)',
					() =>
					{
						let tmpDimension = { Kind: 'Multi', KeyField: 'IDUser', DataType: 'ID', IsInteger: true, Scale: 0, Where: F.cmp('m1', 'Active', 'EQ', 1), Chain: [ { Rel: F.rel('ProjectMembership', 'm1', [ 'IDProjectMembership', 'IDProject', 'IDUser' ], { Role: 'Multi' }), On: [ F.on('p', 'IDProject', 'IDProject') ] } ] };
						let tmpCompiled = libFoldCompiler.compileAgg(F.agg({ Key: 'ByMember', Kind: 'Terms', Pivot: 'Project', CountMode: 'PivotDistinct', MultiValued: true, Top: 5, Dimensions: [ tmpDimension ] }),
							input({ p: relation('Project', SCOPED(1)), m1: relation('ProjectMembership', SCOPED(1)) }));
						Expect(tmpCompiled.Fold).to.equal('Multi');
						Expect(tmpCompiled.Statements.map((pStatement) => { return pStatement.Purpose; })).to.deep.equal([ 'MultiTerms', 'Count', 'MultiCovered' ]);
						tmpCompiled.Statements.forEach((pStatement) => { expectHygiene(pStatement, pStatement.Purpose); });
						Expect(tmpCompiled.Statements[0].SQL).to.include('SELECT m1.`IDUser` AS Key, uniqExact(p.`IDProject`) AS Count FROM (SELECT `IDProject` FROM `rfs_main`.`Project` FINAL WHERE `_IsDeleted` = 0 AND (`Deleted` = {p_0:UInt8} AND `IDCustomer` = {p_1:Int64})) AS p'
							+ ' INNER JOIN (SELECT `IDProjectMembership`, `Active`, `IDProject`, `IDUser` FROM `rfs_main`.`ProjectMembership` FINAL WHERE `_IsDeleted` = 0 AND (`Deleted` = {m1_0:UInt8} AND `IDCustomer` = {m1_1:Int64})) AS m1 ON m1.`IDProject` = p.`IDProject`'
							+ ' WHERE isNotNull(m1.`IDUser`) AND (m1.`Active` = {q1_0:UInt8}) GROUP BY Key');
						Expect(tmpCompiled.Statements[2].SQL).to.match(/^SELECT uniqExact\(p\.`IDProject`\) AS Covered FROM /);
					});

				test('K18 TuplePivot: SELECT DISTINCT over the sides joined in order, the Variant / Where over every side; M1 shells count tuples',
					() =>
					{
						let tmpTuple = { Sides: [ { Name: 'i', Alias: 'p', Rel: F.rel('MaterialIntakeRequirement', 'p', [ 'IDMaterialIntakeRequirement', 'IDMaterialIntake' ], { Role: 'TupleSide' }) }, { Name: 'r', Alias: 'u1', Rel: F.rel('LabForm', 'u1', [ 'IDLabForm', 'IDMaterialIntake', 'IDLabFormType' ], { Role: 'TupleSide' }) } ],
							On: [ { Left: { Alias: 'p', Field: 'IDMaterialIntake' }, Right: { Alias: 'u1', Field: 'IDMaterialIntake' } } ], Key: [ { Alias: 'p', Field: 'IDMaterialIntake' }, { Alias: 'u1', Field: 'IDLabFormType' } ], Names: { i: 'p', r: 'u1' } };
						let tmpWhere = F.cmp('u1', 'Status', 'EQ', 'Complete');
						let tmpStatement = only(libFoldCompiler.compileAgg(F.agg({ Key: 'T', Kind: 'Terms', Pivot: 'MaterialIntakeRequirement', CountMode: 'KeyDistinct', Tuple: tmpTuple, Where: tmpWhere, Dimensions: [ F.columnDim('IDLabFormType', 'Numeric', { Alias: 'u1' }) ] }),
							input({ p: relation('MaterialIntakeRequirement', SCOPED(1)), u1: relation('LabForm', SCOPED(1)) })));
						Expect(tmpStatement.SQL).to.include('FROM (SELECT DISTINCT p.`IDMaterialIntake` AS `TK0`, u1.`IDLabFormType` AS `TK1`, u1.`IDLabFormType` AS `FacetT0` FROM (SELECT `IDMaterialIntakeRequirement`, `IDMaterialIntake` FROM `rfs_main`.`MaterialIntakeRequirement` FINAL');
						Expect(tmpStatement.SQL).to.include('INNER JOIN (SELECT `IDLabForm`, `IDLabFormType`, `IDMaterialIntake`, `Status` FROM `rfs_main`.`LabForm` FINAL');
						Expect(tmpStatement.SQL).to.include('ON p.`IDMaterialIntake` = u1.`IDMaterialIntake` WHERE (u1.`Status` = {q1_0:String})) AS p');
						Expect(tmpStatement.SQL).to.include('SELECT p.`FacetT0` AS Key, count() AS Count');
					});

				test('K20 ExistsFlag, NumericHistogram (Nice two-phase, Edges), Ranges, Stats (integer, decimal, date), DistinctCount, Missing, Pivot axes',
					() =>
					{
						let tmpRelations = { p: relation('BookStoreSale', [ E('Deleted', '=', 0) ]) };
						let tmpNice = F.agg({ Key: 'A', Kind: 'NumericHistogram', Pivot: 'BookStoreSale', Dimensions: [ { Kind: 'NumericBucket', Field: 'TotalAmount', Mode: 'Nice', Buckets: 10, DataType: 'Decimal', IsInteger: false, Scale: 2 } ] });
						let tmpBounds = only(libFoldCompiler.compileAgg(tmpNice, input(tmpRelations)));
						Expect(tmpBounds.Purpose).to.equal('NumericBounds');
						Expect(tmpBounds.SQL).to.match(/^SELECT count\(\) AS Rows, count\(p\.`TotalAmount`\) AS NonNull, min\(p\.`TotalAmount`\) AS Lo, max\(p\.`TotalAmount`\) AS Hi FROM /);
						let tmpBuckets = only(libFoldCompiler.compileAgg(tmpNice, input(tmpRelations, { Geometry: { Mode: 'Nice', Factor: 100, LoUnits: 0, WidthUnits: 5000, N: 6 } })));
						Expect(tmpBuckets.Purpose).to.equal('NumericHistogram');
						Expect(tmpBuckets.SQL).to.include('SELECT least(intDiv(toInt64(if(p.`TotalAmount` < 0, -floor(-p.`TotalAmount` * {fFactor:Int64} + 0.5), floor(p.`TotalAmount` * {fFactor:Int64} + 0.5))) - {fLoUnits:Int64}, {fWidthUnits:Int64}), {fLastIndex:Int64}) AS FacetCand,'
							+ ' multiIf(p.`TotalAmount` < ({fLoUnits:Int64} + FacetCand * {fWidthUnits:Int64}) / {fFactor:Int64}, FacetCand - 1, FacetCand < {fLastIndex:Int64} AND p.`TotalAmount` >= ({fLoUnits:Int64} + (FacetCand + 1) * {fWidthUnits:Int64}) / {fFactor:Int64}, FacetCand + 1, FacetCand) AS Key');
						Expect(tmpBuckets.SQL).to.include('WHERE isNotNull(p.`TotalAmount`)) GROUP BY Key');
						Expect(tmpBuckets.Params).to.include({ fFactor: 100, fLoUnits: 0, fWidthUnits: 5000, fLastIndex: 5 });
						let tmpEdges = only(libFoldCompiler.compileAgg(tmpNice, input(tmpRelations, { Geometry: { Mode: 'Edges', Edges: [ 0, 50, 200 ], OpenEnded: true } })));
						Expect(tmpEdges.SQL).to.include('multiIf(p.`TotalAmount` >= toFloat64({fE0:String}) AND p.`TotalAmount` < toFloat64({fE1:String}), 0, p.`TotalAmount` >= toFloat64({fE1:String}) AND p.`TotalAmount` < toFloat64({fE2:String}), 1, p.`TotalAmount` >= toFloat64({fE2:String}), 2, NULL) AS Key');
						let tmpRanges = only(libFoldCompiler.compileAgg(F.agg({ Key: 'R', Kind: 'Ranges', Pivot: 'BookStoreSale', Dimensions: [ { Kind: 'Range', Field: 'TotalAmount', Ranges: [ { Key: 'a', From: null, To: 50 }, { Key: 'b', From: 50, To: null }, { Key: 'all' } ] } ] }), input(tmpRelations)));
						Expect(tmpRanges.SQL).to.include('multiIf(isNull(p.`TotalAmount`), -1, p.`TotalAmount` < toFloat64({fR0To:String}), 0, p.`TotalAmount` >= toFloat64({fR1From:String}), 1, 1, 2, -2) AS Key');
						let fStats = (pField, pDataType, pScale) => { return only(libFoldCompiler.compileAgg(F.agg({ Key: 'S', Kind: 'Stats', Pivot: 'BookStoreSale', Field: pField, FieldInfo: { DataType: pDataType, Scale: pScale } }), input(tmpRelations))); };
						Expect(fStats('IDBookStore', 'Numeric', 0).SQL).to.include('sum(p.`IDBookStore`) AS SumUnits');
						Expect(fStats('TotalAmount', 'Decimal', 2).SQL).to.include('sum(toInt64(if(p.`TotalAmount` < 0, -floor(-p.`TotalAmount` * {fFactor:Int64} + 0.5), floor(p.`TotalAmount` * {fFactor:Int64} + 0.5)))) AS SumUnits');
						Expect(fStats('SaleDate', 'DateTime', 0).SQL).to.include("formatDateTime(min(p.`SaleDate`), '%Y-%m-%d %H:%i:%S') AS Min, formatDateTime(max(p.`SaleDate`), '%Y-%m-%d %H:%i:%S') AS Max, NULL AS SumUnits");
						expectRefused(libFoldCompiler.compileAgg(F.agg({ Key: 'S', Kind: 'Stats', Pivot: 'BookStoreSale', Field: 'PaymentMethod', FieldInfo: { DataType: 'String', Scale: 0 } }), input(tmpRelations)), 'OperatorType:BookStoreSale.PaymentMethod');
						Expect(only(libFoldCompiler.compileAgg(F.agg({ Key: 'D', Kind: 'DistinctCount', Pivot: 'BookStoreSale', Field: 'PaymentMethod', FieldInfo: { DataType: 'String' } }), input(tmpRelations))).SQL).to.include('uniqExact(p.`PaymentMethod`) AS Distinct');
						Expect(only(libFoldCompiler.compileAgg(F.agg({ Key: 'M', Kind: 'Missing', Pivot: 'BookStoreSale', Field: 'SaleDate', FieldInfo: { DataType: 'DateTime' } }), input(tmpRelations))).SQL).to.match(/^SELECT count\(\) AS Rows, count\(p\.`SaleDate`\) AS NonNull FROM /);
						let tmpPivot = only(libFoldCompiler.compileAgg(F.agg({ Key: 'P', Kind: 'Pivot', Pivot: 'BookStoreSale', Dimensions: [ F.columnDim('PaymentMethod', 'String'), F.dateDim('SaleDate', 'year') ] }), input(tmpRelations)));
						Expect(tmpPivot.SQL).to.include("SELECT K1, K2, count() AS Count FROM (SELECT p.`PaymentMethod` AS K1, formatDateTime(toStartOfYear(p.`SaleDate`), '%Y-%m-%d 00:00:00') AS K2 FROM");
						Expect(tmpPivot.Params.fMaxGroups).to.equal(100001);
						let tmpRangeAxis = only(libFoldCompiler.compileAgg(F.agg({ Key: 'P', Kind: 'Pivot', Pivot: 'BookStoreSale', Dimensions: [ F.columnDim('PaymentMethod', 'String'), { Kind: 'Range', Field: 'TotalAmount', Ranges: [ { Key: 'a', To: 50 } ] } ] }), input(tmpRelations)));
						Expect(tmpRangeAxis.SQL).to.include('multiIf(isNull(p.`TotalAmount`), -1, p.`TotalAmount` < toFloat64({fD1R0To:String}), 0, -2) AS K2');
						let tmpFlag = only(libFoldCompiler.compileAgg(F.agg({ Key: 'X', Kind: 'ExistsSplit', Pivot: 'Project', Dimensions: [ { Kind: 'ExistsFlag', DataType: 'Boolean', IsInteger: true, Scale: 0, Pred: F.exists(F.rel('Task', 'e1', [ 'IDTask', 'IDProject' ]), [ F.on('p', 'IDProject', 'IDProject') ]) } ] }),
							input({ p: relation('Project', SCOPED(1)), e1: relation('Task', SCOPED(1)) })));
						Expect(tmpFlag.SQL).to.include('if(ifNull(p.`IDProject` IN (SELECT e1.`IDProject` FROM');
						Expect(tmpFlag.SQL).to.include('SELECT p.`FacetX0` AS Key FROM');
					});

				test('the cube grain: one GROUP BY over dims, flags, z; bounds and measures per group; MaxGroups + 1 rows',
					() =>
					{
						let tmpCube = (
							{
								CubeId: 'cube0', Pivot: 'BookStoreSale', MaxGroups: 50,
								Dims: [ { Column: 'd1', Dim: F.columnDim('PaymentMethod', 'String') }, { Column: 'd2', Dim: F.dateDim('SaleDate', 'month') }, { Column: 'd3', Dim: { Kind: 'NumericBucket', Field: 'TotalAmount', Mode: 'Edges', Edges: [ 0, 100 ], OpenEnded: true } } ],
								Measures: [ { Column: 'm1', Kind: 'Stats', Field: 'TotalAmount', DataType: 'Decimal', Scale: 2 }, { Column: 'm2', Kind: 'Missing', Field: 'SaleDate', DataType: 'DateTime' } ],
								Resolved: { CommonPathPred: null, Flags: [ { Column: 'b1', ColumnPred: { Field: 'PaymentMethod', Op: 'IN', Value: [ 'Cash' ] } } ], Bounds: [ { Dim: 'd2', Column: 'v2', Lo: 'lo2', Hi: 'hi2', NonNull: 'nn2', Kind: 'Date' }, { Dim: 'd3', Column: 'v3', Lo: 'lo3', Hi: 'hi3', NonNull: 'nn3', Kind: 'Numeric' } ] }
							});
						let tmpCompiled = libFoldCompiler.compileCube(tmpCube, [], input({ p: relation('BookStoreSale', [ E('Deleted', '=', 0) ]) }));
						Expect(tmpCompiled.Fold).to.equal('CubeGrain');
						expectHygiene(tmpCompiled.Statement, 'Cube');
						Expect(tmpCompiled.Statement.SQL).to.equal("SELECT `d1`, `d2`, `d3`, `b1`, formatDateTime(min(`v2`), '%Y-%m-%d %H:%i:%S') AS `lo2`, formatDateTime(max(`v2`), '%Y-%m-%d %H:%i:%S') AS `hi2`,"
							+ ' min(`v3`) AS `lo3`, max(`v3`) AS `hi3`, count(`v3`) AS `nn3`, count(`m1`) AS `m1nn`, min(`m1`) AS `m1lo`, max(`m1`) AS `m1hi`,'
							+ ' sum(toInt64(if(`m1` < 0, -floor(-`m1` * {fm1Factor:Int64} + 0.5), floor(`m1` * {fm1Factor:Int64} + 0.5)))) AS `m1su`, count(`m2`) AS `m2nn`, count() AS `N`'
							+ " FROM (SELECT p.`PaymentMethod` AS `d1`, formatDateTime(toStartOfMonth(p.`SaleDate`), '%Y-%m-%d 00:00:00') AS `d2`,"
							+ ' multiIf(p.`TotalAmount` >= toFloat64({fd2E0:String}) AND p.`TotalAmount` < toFloat64({fd2E1:String}), 0, p.`TotalAmount` >= toFloat64({fd2E1:String}), 1, NULL) AS `d3`, p.`b1` AS `b1`,'
							+ ' p.`SaleDate` AS `v2`, p.`TotalAmount` AS `v3`, p.`TotalAmount` AS `m1`, p.`SaleDate` AS `m2`, 0 AS `z`'
							+ ' FROM (SELECT p.`IDBookStoreSale` AS `IDBookStoreSale`, p.`PaymentMethod` AS `PaymentMethod`, p.`SaleDate` AS `SaleDate`, p.`TotalAmount` AS `TotalAmount`, if((p.`PaymentMethod` IN {q1_0:Array(String)}), 1, 0) AS `b1`'
							+ ' FROM (SELECT `IDBookStoreSale`, `PaymentMethod`, `SaleDate`, `TotalAmount` FROM `rfs_main`.`BookStoreSale` FINAL WHERE `_IsDeleted` = 0 AND (`Deleted` = {p_0:UInt8})) AS p) AS p)'
							+ ' GROUP BY `d1`, `d2`, `d3`, `b1`, `z` LIMIT {fMaxGroups:UInt32}');
						Expect(tmpCompiled.Statement.Params.fMaxGroups).to.equal(51);
					});

				test('the public API: compileFilter for the materializer (SourceDialect only), compileFoldPred, dimensionExpression, collectRelations',
					() =>
					{
						let tmpFilter = libFoldCompiler.compileFilter(SPECS.Task, [ E('Status', '=', 'Open'), E('IDProject', 'IN', [ 5, 9 ]) ], { SourceDialect: 'SQLite' });
						Expect(tmpFilter).to.deep.equal({ SQL: '`Status` = {w_0:String} AND `IDProject` IN {w_1:Array(Int64)}', Params: { w_0: 'Open', w_1: [ 5, 9 ] }, Types: { w_0: 'String', w_1: 'Array(Int64)' } });
						Expect(libFoldCompiler.compileFilter(SPECS.Task, [], { SourceDialect: 'SQLite' }).SQL).to.equal('1');
						let tmpPred = libFoldCompiler.compileFoldPred(F.and(F.cmp('p', 'Status', 'EQ', 'Open'), { Node: 'True' }), input({ p: relation('Task', SCOPED(1)) }));
						Expect(tmpPred.SQL).to.equal('((p.`Status` = {q1_0:String}) AND 1)');
						let tmpKey = libFoldCompiler.dimensionExpression(F.dateDim('DueDate', 'week'), 'x.`DueDate`', { ColumnInfo: { Mirror: NDT } });
						Expect(tmpKey.SQL).to.equal("formatDateTime(toMonday(x.`DueDate`), '%Y-%m-%d 00:00:00')");
						let tmpCollected = libFoldCompiler.collectRelations(F.e3aAggs(1, 'TenantOnly')[1], { PathPred: null });
						Expect(tmpCollected.Relations.map((pRelation) => { return pRelation.Alias; })).to.deep.equal([ 'p', 'j1', 'j2', 'j3', 'j4', 'l1', 'l2' ]);
						Expect(tmpCollected.Relations[0].Columns).to.deep.equal([ 'IDLabFormType', 'IDMaterialIntake' ]);
						Expect(tmpCollected.Leaves).to.deep.equal({});
					});
			}
		);

		// ============================================================ goldens and the engine (no ClickHouse)

		suite
		(
			'Goldens and the engine on the SQLite benches (no ClickHouse)',
			() =>
			{
				let _Benches = {};
				let _Bookstore = null;
				let _Goldens = { COMPILER_VERSION: libFoldCompiler.COMPILER_VERSION, Statements: {} };
				let _Stored = null;

				suiteSetup(
					(fDone) =>
					{
						try
						{
							_Stored = JSON.parse(libFS.readFileSync(GOLDEN_FILE, 'utf8'));
						}
						catch (pReadError)
						{
							_Stored = { Statements: {} };
						}
						_Benches.ProjectTrack = libKit.start({ Domain: 'ProjectTrack', Mutate: mutateProjectTrack },
							(pProjectError) =>
							{
								if (pProjectError)
								{
									return fDone(pProjectError);
								}
								_Benches.LabTrack = libKit.start({ Domain: 'LabTrack' },
									(pLabError) =>
									{
										if (pLabError)
										{
											return fDone(pLabError);
										}
										_Bookstore = libHarness.start({ Port: PORT, Fixture: 'Bookstore' },
											(pBookError) =>
											{
												if (pBookError)
												{
													return fDone(pBookError);
												}
												[ _Benches.ProjectTrack.fable, _Benches.LabTrack.fable, _Bookstore.fable ].forEach(
													(pFable) =>
													{
														pFable.RetoldFacetingEngineClickHouse.useStaticMirrors({ Specs: benchSpecs(pFable), Store: stubStore() });
													});
												return fDone();
											});
									});
							});
					});

				suiteTeardown(
					(fDone) =>
					{
						if (UPDATE_GOLDENS)
						{
							libFS.writeFileSync(GOLDEN_FILE, `${JSON.stringify(_Goldens, null, '\t')}\n`);
						}
						let fStop = (pBench, fNext) => { if (!pBench) { return fNext(); } pBench.stop(() => { return fNext(); }); };
						fStop(_Benches.ProjectTrack, () => { fStop(_Benches.LabTrack, () => { fStop(_Bookstore, fDone); }); });
					});

				/**
				 * Record (or compare) one golden statement.
				 *
				 * @param {string} pKey
				 * @param {Record<string, any>} pStatement
				 */
				let fGolden = (pKey, pStatement) =>
				{
					expectHygiene(pStatement, pKey);
					let tmpEntry = { Purpose: pStatement.Purpose, SQL: pStatement.SQL, Params: pStatement.Params, Types: pStatement.Types, MaxRows: pStatement.MaxRows };
					_Goldens.Statements[pKey] = tmpEntry;
					if (!UPDATE_GOLDENS)
					{
						Expect(_Stored.Statements, `golden ${pKey} (regenerate with FACET_UPDATE_GOLDENS=1)`).to.have.property(pKey);
						Expect(JSON.parse(JSON.stringify(tmpEntry)), pKey).to.deep.equal(_Stored.Statements[pKey]);
					}
				};

				SCENARIOS.forEach(
					(pScenario) =>
					{
						test(`golden: ${pScenario[0]} (${pScenario[1]}) compiles every Agg from its real captured scope`,
							(fDone) =>
							{
								let K = _Benches[pScenario[1]];
								K.context(pScenario[2], pScenario[3], pScenario[4](),
									(pContextError, pContext) =>
									{
										Expect(pContextError).to.equal(null);
										call(K.fable.RetoldFacetingEngineClickHouse, 'compile', pContext, pScenario[5](),
											(pError, pResult) =>
											{
												Expect(pError).to.equal(null);
												Expect(pResult.Refused, JSON.stringify(pResult.Refused)).to.deep.equal({});
												Expect(pResult.Errors).to.deep.equal({});
												Object.keys(pResult.Compiled).sort().forEach(
													(pKey) =>
													{
														pResult.Compiled[pKey].Statements.forEach((pStatement, pIndex) => { fGolden(`${pScenario[1]}/${pScenario[0]}/${pKey}/${pIndex}`, pStatement); });
													});
												Object.keys(pResult.Cubes).sort().forEach((pCubeId) => { fGolden(`${pScenario[1]}/${pScenario[0]}/cube:${pCubeId}`, pResult.Cubes[pCubeId]); });
												if (pScenario[0] === 'E1 cube')
												{
													Expect(Object.keys(pResult.Cubes)).to.deep.equal([ 'cube0' ]);
												}
												return fDone();
											});
									});
							});
					});

				test('golden: Bookstore M1 kinds (decimal Nice two-phase, Edges, Ranges, Stats integer / decimal / date, DistinctCount, Missing, Pivot Column × DateBucket and × Range)',
					(fDone) =>
					{
						let tmpCase = bookstoreGoldenAggs()[0];
						harnessContext(_Bookstore, tmpCase[1], {}, { Variants: emptyVariants(tmpCase[1]).Variants },
							(pContextError, pContext) =>
							{
								Expect(pContextError).to.equal(null);
								call(_Bookstore.fable.RetoldFacetingEngineClickHouse, 'compile', pContext, tmpCase[2],
									(pError, pResult) =>
									{
										Expect(pError).to.equal(null);
										Expect(pResult.Refused).to.deep.equal({});
										Object.keys(pResult.Compiled).sort().forEach(
											(pKey) =>
											{
												pResult.Compiled[pKey].Statements.forEach((pStatement, pIndex) => { fGolden(`Bookstore/${tmpCase[0]}/${pKey}/${pIndex}`, pStatement); });
											});
										// The Nice histogram's second phase over a contract geometry.
										let tmpNice = pResult.Compiled.AmountNice;
										let tmpBuckets = libFoldCompiler.compileAgg(tmpCase[2].find((pAgg) => { return pAgg.Key === 'AmountNice'; }), Object.assign({}, tmpNice.Input, { Geometry: { Mode: 'Nice', Factor: 100, LoUnits: 0, WidthUnits: 5000, N: 10 } }));
										fGolden(`Bookstore/${tmpCase[0]}/AmountNice/phase2`, tmpBuckets.Statements[0]);
										let tmpEdges = libFoldCompiler.compileAgg(tmpCase[2].find((pAgg) => { return pAgg.Key === 'AmountEdges'; }), Object.assign({}, pResult.Compiled.AmountEdges.Input, { Geometry: { Mode: 'Edges', Edges: [ 0, 50, 200 ], OpenEnded: true } }));
										fGolden(`Bookstore/${tmpCase[0]}/AmountEdges/phase2`, tmpEdges.Statements[0]);
										return fDone();
									});
							});
					});

				test('the stored goldens hold no statement the compiler no longer produces',
					() =>
					{
						if (UPDATE_GOLDENS)
						{
							return;
						}
						Expect(_Stored.COMPILER_VERSION).to.equal(libFoldCompiler.COMPILER_VERSION);
						Object.keys(_Stored.Statements).forEach((pKey) => { Expect(_Goldens.Statements, `stale golden ${pKey}`).to.have.property(pKey); });
						// Every kind the obligation lists is in the goldens.
						let tmpPurposes = new Set(Object.keys(_Goldens.Statements).map((pKey) => { return _Goldens.Statements[pKey].Purpose; }));
						[ 'Count', 'Terms', 'DateHistogram', 'NumericBounds', 'NumericHistogram', 'Ranges', 'Stats', 'DistinctCount', 'Missing', 'Pivot', 'KeyGroups', 'MultiTerms', 'MultiCovered', 'Cube' ].forEach(
							(pPurpose) => { Expect(tmpPurposes.has(pPurpose), pPurpose).to.equal(true); });
						let tmpAll = Object.keys(_Goldens.Statements).map((pKey) => { return _Goldens.Statements[pKey].SQL; }).join('\n');
						[ 'NOT ifNull((p.`IDMaterialIntake`, p.`IDLabFormType`) IN', 'HAVING NOT (count() <', 'HAVING count() >=', 'ANY LEFT JOIN', 'SELECT DISTINCT p.', 'toMonday(', 'toStartOfQuarter(', 'toStartOfYear(', 'toDate32(' ].forEach(
							(pFragment) => { Expect(tmpAll.indexOf(pFragment), pFragment).to.be.above(-1); });
					});

				test('capable(): the store, the mode, the kind, Show-deleted, the closure rule, Lossy values and the read breaker, in that order',
					(fDone) =>
					{
						let K = _Benches.ProjectTrack;
						let tmpEngine = K.fable.RetoldFacetingEngineClickHouse;
						let tmpSpecs = benchSpecs(K.fable);
						let P = F.e1Plan(1, [ 1, 2 ]);
						K.context('Project', 'Lead', { Variants: P.Variants },
							(pContextError, pContext) =>
							{
								let tmpStatus = P.Aggs.find((pAgg) => { return pAgg.Key === 'Status'; });
								try
								{
									Expect(tmpEngine.capable(tmpStatus, pContext)).to.deep.equal({ Capable: true });
									// No store / an unavailable store / no running materializer outside the static seam.
									tmpEngine.useStaticMirrors({ Specs: tmpSpecs, Store: Object.assign(stubStore(), { status: () => { return { Available: false }; } }) });
									Expect(tmpEngine.capable(tmpStatus, pContext)).to.deep.equal({ Capable: false, Reason: 'StoreUnavailable' });
									tmpEngine.useStaticMirrors(null);
									Expect(tmpEngine.capable(tmpStatus, pContext).Reason).to.equal('StoreUnavailable');
									tmpEngine.useStaticMirrors({ Specs: tmpSpecs, Store: stubStore() });
									Expect(tmpEngine.capable(tmpStatus, Object.assign({}, pContext, { Mode: 'Records' }))).to.deep.equal({ Capable: false, Reason: 'Mode' });
									Expect(tmpEngine.capable(F.agg({ Key: 'X', Kind: 'Pivot', Pivot: 'Project', Dimensions: [ F.columnDim('Status', 'String') ] }), pContext)).to.deep.equal({ Capable: false, Reason: 'KindUnsupported:Pivot' });
									let tmpDeleted = Object.assign({}, pContext, { Variants: { v0: Object.assign({}, P.Variants.v0, { IncludesDeleted: true }) } });
									Expect(tmpEngine.capable(F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'Project' }), tmpDeleted)).to.deep.equal({ Capable: false, Reason: 'DeletedRowsNotMirrored' });
									let tmpNoTask = Object.assign({}, tmpSpecs);
									delete tmpNoTask.Task;
									tmpEngine.useStaticMirrors({ Specs: tmpNoTask, Store: stubStore() });
									Expect(tmpEngine.capable(tmpStatus, pContext)).to.deep.equal({ Capable: false, Reason: 'NotMirrored:Task' });
									tmpEngine.useStaticMirrors({ Specs: tmpSpecs, Store: stubStore(), Filling: { Project: [ 'Status' ] } });
									Expect(tmpEngine.capable(tmpStatus, pContext)).to.deep.equal({ Capable: false, Reason: 'NotMirrored:Project.Status' });
									tmpEngine.useStaticMirrors({ Specs: tmpSpecs, Store: stubStore(), Lossy: { Project: { Status: 'Value' } } });
									Expect(tmpEngine.capable(tmpStatus, pContext)).to.deep.equal({ Capable: false, Reason: 'LossyColumn:Project.Status' });
									// 'Compare': the Variant's DateRange conjunct (a predicate) refuses statically; a fold that only
									// buckets the column (Started excludes that conjunct) stays capable.
									tmpEngine.useStaticMirrors({ Specs: tmpSpecs, Store: stubStore(), Lossy: { Project: { StartDate: 'Compare' } } });
									Expect(tmpEngine.capable(tmpStatus, pContext)).to.deep.equal({ Capable: false, Reason: 'LossyColumn:Project.StartDate' });
									Expect(tmpEngine.capable(P.Aggs.find((pAgg) => { return pAgg.Key === 'Started'; }), pContext)).to.deep.equal({ Capable: true });
									tmpEngine.useStaticMirrors({ Specs: tmpSpecs, Store: stubStore() });
									let tmpFreshness = K.fable.RetoldFacetingFreshness;
									let fBreaker = tmpFreshness.breakerOpen;
									tmpFreshness.breakerOpen = (pEngine, pEntity, pNow, pKind) => { return (pEngine === 'ClickHouse') && (pEntity === 'Issue') && (pKind === 'Read'); };
									try
									{
										Expect(tmpEngine.capable(tmpStatus, pContext)).to.deep.equal({ Capable: false, Reason: 'Breaker:Issue' });
									}
									finally
									{
										tmpFreshness.breakerOpen = fBreaker;
									}
									[ 'StoreUnavailable', 'Mode', 'KindUnsupported:Pivot', 'DeletedRowsNotMirrored', 'NotMirrored:Task', 'NotMirrored:Project.Status', 'LossyColumn:Project.Status', 'LossyColumn:Project.StartDate', 'Breaker:Issue' ].forEach((pReason) => { SEEN_REASONS.add(pReason); });
								}
								finally
								{
									tmpEngine.useStaticMirrors({ Specs: tmpSpecs, Store: stubStore() });
								}
								return fDone();
							});
					});

				test('execute() over a fake store: rows folded by EngineLive.foldRows, deadline settings, freshness read first, statements counted',
					(fDone) =>
					{
						let K = _Benches.ProjectTrack;
						let tmpEngine = K.fable.RetoldFacetingEngineClickHouse;
						let tmpSeen = [];
						let tmpStore = stubStore(
							(pSQL, pParams, pTypes, pSettings, fCallback) =>
							{
								tmpSeen.push({ SQL: pSQL, Settings: pSettings });
								if (/^SELECT count\(\) AS Total/.test(pSQL))
								{
									return fCallback(null, [ { Total: 7 } ]);
								}
								return fCallback(null, [ { Key: 'Active', Count: 4, FacetTotal: 7, FacetMissing: 1, FacetDistinct: 2 }, { Key: 'Done', Count: 2, FacetTotal: 7, FacetMissing: 1, FacetDistinct: 2 } ]);
							});
						tmpEngine.useStaticMirrors({ Specs: benchSpecs(K.fable), Store: tmpStore });
						let tmpAggs = [ F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'Project' }), F.agg({ Key: 'Status', Kind: 'Terms', Pivot: 'Project', Dimensions: [ F.columnDim('Status', 'String') ] }) ];
						K.context('Project', 'Lead', Object.assign(emptyVariants('Project'), { Store: { Statements: 0 } }),
							(pContextError, pContext) =>
							{
								call(tmpEngine, 'execute', pContext, tmpAggs,
									(pError, pExecution) =>
									{
										tmpEngine.useStaticMirrors({ Specs: benchSpecs(K.fable), Store: stubStore() });
										Expect(pError).to.equal(null);
										Expect(pExecution.Engine).to.equal('ClickHouse');
										Expect(pExecution.Results['#Total'].Total).to.equal(7);
										Expect(pExecution.Results.Status).to.include({ Total: 7, MissingCount: 1, DistinctKeys: 2 });
										Expect(pExecution.Results.Status.Groups).to.deep.equal([ { Key: 'Active', Count: 4 }, { Key: 'Done', Count: 2 } ]);
										Expect(pExecution.Statements).to.equal(2);
										Expect(pContext.Store.Statements).to.equal(2);
										Expect(pExecution.Freshness).to.have.all.keys('#Total', 'Status');
										Expect(pExecution.Refused).to.deep.equal({});
										Expect(pExecution.Captures).to.have.property('Project');
										tmpSeen.forEach(
											(pSeen) =>
											{
												Expect(pSeen.Settings.max_execution_time).to.be.within(1, 30);
												Expect(pSeen.Settings.result_overflow_mode).to.equal('throw');
												Expect(pSeen.Settings.join_use_nulls).to.equal(1);
											});
										return fDone();
									});
							});
					});

				test('execute(): every store statement failing is one whole-call .StoreError (the Router falls back); some failing are Refused StoreError',
					(fDone) =>
					{
						let K = _Benches.ProjectTrack;
						let tmpEngine = K.fable.RetoldFacetingEngineClickHouse;
						let tmpAggs = [ F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'Project' }), F.agg({ Key: 'Status', Kind: 'Terms', Pivot: 'Project', Dimensions: [ F.columnDim('Status', 'String') ] }) ];
						tmpEngine.useStaticMirrors({ Specs: benchSpecs(K.fable), Store: stubStore() });
						K.context('Project', 'Lead', emptyVariants('Project'),
							(pContextError, pContext) =>
							{
								call(tmpEngine, 'execute', pContext, tmpAggs,
									(pError) =>
									{
										Expect(pError).to.be.an('error');
										Expect(pError.StoreError).to.equal(true);
										let tmpPartial = stubStore(
											(pSQL, pParams, pTypes, pSettings, fCallback) =>
											{
												if (/^SELECT count\(\) AS Total/.test(pSQL))
												{
													return fCallback(null, [ { Total: 3 } ]);
												}
												return fCallback(Object.assign(new Error('ClickHouse 500: Code: 241. Memory limit'), { StoreError: true, Status: 500, Code: 241 }));
											});
										tmpEngine.useStaticMirrors({ Specs: benchSpecs(K.fable), Store: tmpPartial });
										K.context('Project', 'Lead', emptyVariants('Project'),
											(pSecondError, pSecondContext) =>
											{
												call(tmpEngine, 'execute', pSecondContext, tmpAggs,
													(pPartialError, pExecution) =>
													{
														tmpEngine.useStaticMirrors({ Specs: benchSpecs(K.fable), Store: stubStore() });
														Expect(pPartialError).to.equal(null);
														Expect(pExecution.Results['#Total'].Total).to.equal(3);
														Expect(pExecution.Results).to.not.have.property('Status');
														Expect(pExecution.Refused).to.deep.equal({ Status: 'StoreError' });
														SEEN_REASONS.add('StoreError');
														return fDone();
													});
											});
									});
							});
					});

				test('execute(): an untrusted Opaque capture is Live\'s own 500 (per facet); a trusted one is Refused OpaqueScope (never staged); a refused principal fails the request as on Live',
					(fDone) =>
					{
						let K = _Benches.LabTrack;
						let tmpEngine = K.fable.RetoldFacetingEngineClickHouse;
						let tmpController = K.fable.MeadowEndpoints.LabQueue.controller;
						let tmpInjection = tmpController.BehaviorInjection;
						let fOriginal = tmpInjection._BehaviorFunctions['Reads-QueryConfiguration'];
						// A behavior that replaces the query: Opaque for every engine.
						tmpInjection.setBehavior('Reads-QueryConfiguration',
							function (pRequest, pRequestState, fCallback)
							{
								return fOriginal.call(this, pRequest, pRequestState,
									(pError) =>
									{
										pRequestState.Query.parameters.queryOverride = 'SELECT <%= FieldList %> FROM LabQueue<%= Where %>';
										return fCallback(pError);
									});
							});
						let fRestore = () => { tmpInjection.setBehavior('Reads-QueryConfiguration', fOriginal); };
						let tmpAggs = F.e3aAggs(1, 'TenantOnly');
						K.context('MaterialIntakeRequirement', 'Tech', emptyVariants('MaterialIntakeRequirement'),
							(pContextError, pContext) =>
							{
								call(tmpEngine, 'compile', pContext, tmpAggs,
									(pError, pResult) =>
									{
										if (pError)
										{
											fRestore();
										}
										Expect(pError).to.equal(null);
										// ToDoForMe (every Agg's W_def) reaches LabQueue: the guard's OpaqueUntrusted 500, per facet (an Agg's own hop), as Live.
										Expect(Object.keys(pResult.Compiled)).to.deep.equal([]);
										Expect(Object.keys(pResult.Errors)).to.have.length(tmpAggs.length);
										Object.keys(pResult.Errors).forEach((pKey) => { Expect(pResult.Errors[pKey].Code, pKey).to.equal('FACET_SCOPE_POLICY_VIOLATION'); });
										K.context('MaterialIntakeRequirement', 'Tech', emptyVariants('MaterialIntakeRequirement'),
											(pLiveContextError, pLiveContext) =>
											{
												call(K.fable.RetoldFacetingEngineLive, 'execute', pLiveContext, F.e3aAggs(1, 'TenantOnly'),
													(pLiveError, pLive) =>
													{
														Expect(pLiveError).to.equal(null);
														Object.keys(pResult.Errors).forEach((pKey) => { Expect(pResult.Errors[pKey], pKey).to.deep.equal(pLive.Errors[pKey]); });
														// Trusted (Scope.TrustedOpaque): the capture comes back Opaque and the store refuses it.
														K.context('MaterialIntakeRequirement', 'Tech', emptyVariants('MaterialIntakeRequirement'),
															(pTrustedContextError, pTrustedContext) =>
															{
																pTrustedContext.Options = Object.assign({}, pTrustedContext.Options, { Scope: Object.assign({}, pTrustedContext.Options.Scope, { TrustedOpaque: [ 'LabQueue' ] }) });
																call(tmpEngine, 'compile', pTrustedContext, F.e3aAggs(1, 'TenantOnly'),
																	(pTrustedError, pTrusted) =>
																	{
																		fRestore();
																		Expect(pTrustedError).to.equal(null);
																		Expect(Object.keys(pTrusted.Compiled)).to.deep.equal([]);
																		Expect(Object.keys(pTrusted.Refused)).to.have.length(tmpAggs.length);
																		Object.keys(pTrusted.Refused).forEach((pKey) => { Expect(pTrusted.Refused[pKey], pKey).to.equal('OpaqueScope:LabQueue'); });
																		SEEN_REASONS.add('OpaqueScope:LabQueue');
																		// Anonymous on a tenant entity: the behavior's 401, whole request (as Live).
																		K.context('MaterialIntakeRequirement', null, emptyVariants('MaterialIntakeRequirement'),
																			(pAnonymousError, pAnonymous) =>
																			{
																				call(tmpEngine, 'compile', pAnonymous, [ F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'MaterialIntakeRequirement' }) ],
																					(pCaptureError) =>
																					{
																						Expect(pCaptureError).to.be.an('error');
																						Expect(pCaptureError.StoreError).to.not.equal(true);
																						K.context('MaterialIntakeRequirement', null, emptyVariants('MaterialIntakeRequirement'),
																							(pLiveAnonymousError, pLiveAnonymous) =>
																							{
																								call(K.fable.RetoldFacetingEngineLive, 'execute', pLiveAnonymous, [ F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'MaterialIntakeRequirement' }) ],
																									(pLiveCaptureError) =>
																									{
																										Expect(pLiveCaptureError).to.be.an('error');
																										Expect(pCaptureError.Code).to.equal(pLiveCaptureError.Code);
																										Expect(pCaptureError.Status).to.equal(pLiveCaptureError.Status);
																										return fDone();
																									});
																							});
																					});
																			});
																	});
															});
													});
											});
									});
							});
					});

				test('captureRelation: the final filter of a TenantOnly hop (owner entry relaxed away), memoized per request, never building SQL',
					(fDone) =>
					{
						let K = _Benches.LabTrack;
						let tmpBuilder = K.fable.RetoldFacetingScopedRelationBuilder;
						K.context('MaterialIntakeRequirement', 'Tech', emptyVariants('MaterialIntakeRequirement'),
							(pContextError, pContext) =>
							{
								let tmpRel = F.rel('LabForm', 'j4', [ 'IDLabForm', 'IDLabFormType', 'IDMaterialIntake' ], { Where: { Field: 'Status', Op: 'EQ', Value: 'Complete' }, Scope: 'TenantOnly', ScopeReason: 'any technician' });
								tmpBuilder.captureRelation(pContext, tmpRel,
									(pError, pCaptured) =>
									{
										Expect(pError).to.equal(null);
										Expect(pCaptured).to.include({ Entity: 'LabForm', Alias: 'j4', Opaque: false, Dialect: 'SQLite' });
										let tmpColumns = pCaptured.Filter.map((pEntry) => { return pEntry.Column; });
										Expect(tmpColumns).to.include('IDCustomer');
										Expect(tmpColumns).to.include('Deleted');
										Expect(tmpColumns).to.not.include('OwnerIDUser');
										Expect(pCaptured.Capture.Relaxed).to.equal(true);
										let tmpRelations = pContext.Counters.StoreRelations;
										tmpBuilder.captureRelation(pContext, Object.assign({}, tmpRel, { As: 'h9' }),
											(pAgainError, pAgain) =>
											{
												Expect(pAgainError).to.equal(null);
												Expect(pAgain.Alias).to.equal('h9');
												Expect(pAgain.Filter).to.deep.equal(pCaptured.Filter);
												Expect(pContext.Counters.StoreRelations).to.equal(tmpRelations);
												// Not counted against Live's relation counter.
												Expect(pContext.Counters.Relations).to.equal(0);
												return fDone();
											});
									});
							});
					});
			}
		);

		// ============================================================ ClickHouse (gated)

		suite
		(
			'ClickHouse: every kind equals Live on the M2 benches (SQLite, and PostgreSQL when gated)',
			() =>
			{
				let _Benches = {};
				let _Databases = [];
				let _Skip = !CH_GATE.Available;

				suiteSetup(
					function (fDone)
					{
						if (_Skip)
						{
							this.skip();
							return;
						}
						this.timeout(240000);
						libSupport.ensure(
							(pEnsureError) =>
							{
								if (pEnsureError)
								{
									return fDone(pEnsureError);
								}
								let tmpPlan = [ [ 'SQLite', 'ProjectTrack' ], [ 'SQLite', 'LabTrack' ] ];
								if (libProviders.available('PostgreSQL').Available)
								{
									tmpPlan.push([ 'PostgreSQL', 'ProjectTrack' ], [ 'PostgreSQL', 'LabTrack' ]);
								}
								let fNext = (pIndex) =>
								{
									if (pIndex >= tmpPlan.length)
									{
										return fDone();
									}
									let tmpProvider = tmpPlan[pIndex][0];
									let tmpDomain = tmpPlan[pIndex][1];
									let K = libKit.start({ Domain: tmpDomain, Provider: tmpProvider, Mutate: (tmpDomain === 'ProjectTrack') ? mutateProjectTrack : null },
										(pStartError) =>
										{
											if (pStartError)
											{
												return fDone(pStartError);
											}
											let tmpDatabase = libSupport.freshDatabase();
											_Databases.push(tmpDatabase);
											libSupport.loadMirrors(K, { Database: tmpDatabase },
												(pLoadError, pLoaded) =>
												{
													if (pLoadError)
													{
														return fDone(pLoadError);
													}
													let tmpLossy = {};
													Object.keys(pLoaded.Entities).forEach((pEntity) => { tmpLossy[pEntity] = pLoaded.Entities[pEntity].Lossy; });
													K.fable.RetoldFacetingEngineClickHouse.useStaticMirrors({ Lossy: tmpLossy });
													K.Loaded = pLoaded;
													_Benches[`${tmpProvider}|${tmpDomain}`] = K;
													return fNext(pIndex + 1);
												});
										});
								};
								fNext(0);
							});
					});

				suiteTeardown(
					function (fDone)
					{
						this.timeout(60000);
						let tmpBenches = Object.keys(_Benches).map((pKey) => { return _Benches[pKey]; });
						let fStop = (pIndex) =>
						{
							if (pIndex >= tmpBenches.length)
							{
								let fRelease = (pDatabaseIndex) =>
								{
									if (pDatabaseIndex >= _Databases.length)
									{
										return fDone();
									}
									libSupport.release(_Databases[pDatabaseIndex], () => { return fRelease(pDatabaseIndex + 1); });
								};
								return fRelease(0);
							}
							tmpBenches[pIndex].stop(() => { return fStop(pIndex + 1); });
						};
						fStop(0);
					});

				/**
				 * Live and ClickHouse over the same FoldIR, fresh contexts each.
				 */
				let fBoth = (K, pEntity, pPrincipal, fOverrides, fAggs, fCallback) =>
				{
					K.context(pEntity, pPrincipal, fOverrides(),
						(pLiveContextError, pLiveContext) =>
						{
							Expect(pLiveContextError).to.equal(null);
							call(K.fable.RetoldFacetingEngineLive, 'execute', pLiveContext, fAggs(),
								(pLiveError, pLive) =>
								{
									Expect(pLiveError).to.equal(null);
									K.context(pEntity, pPrincipal, fOverrides(),
										(pStoreContextError, pStoreContext) =>
										{
											Expect(pStoreContextError).to.equal(null);
											call(K.fable.RetoldFacetingEngineClickHouse, 'execute', pStoreContext, fAggs(),
												(pStoreError, pStore) =>
												{
													Expect(pStoreError, pStoreError ? `${pStoreError.message} ${pStoreError.Cause ? pStoreError.Cause.message : ''}` : '').to.equal(null);
													return fCallback(pLive, pStore);
												});
										});
								});
						});
				};

				[ 'SQLite', 'PostgreSQL' ].forEach(
					(pProvider) =>
					{
						SCENARIOS.forEach(
							(pScenario) =>
							{
								test(`${pProvider} ${pScenario[1]}: ${pScenario[0]} — every RawFacetResult equals Live's`,
									function (fDone)
									{
										let K = _Benches[`${pProvider}|${pScenario[1]}`];
										if (!K)
										{
											this.skip();
											return;
										}
										fBoth(K, pScenario[2], pScenario[3], pScenario[4], pScenario[5],
											(pLive, pStore) =>
											{
												Expect(pStore.Refused, JSON.stringify(pStore.Refused)).to.deep.equal({});
												Expect(pStore.Errors).to.deep.equal(pLive.Errors);
												Expect(Object.keys(pStore.Results).sort()).to.deep.equal(Object.keys(pLive.Results).sort());
												Object.keys(pLive.Results).forEach((pKey) => { Expect(F.normalizeRaw(pStore.Results[pKey]), pKey).to.deep.equal(F.normalizeRaw(pLive.Results[pKey])); });
												Expect(pStore.Engine).to.equal('ClickHouse');
												Expect(pStore.Statements).to.be.above(0);
												return fDone();
											});
									});
							});
					});

				test('O5 on ClickHouse: the cube (one grain statement) equals the per-Variant statements, member by member',
					function (fDone)
					{
						let K = _Benches['SQLite|ProjectTrack'];
						let tmpEngine = K.fable.RetoldFacetingEngineClickHouse;
						let P = () => { return F.e1Plan(1, [ 1, 2, 3, 4, 5, 8, 101 ]); };
						K.context('Project', 'Lead', { Variants: P().Variants, Cubes: [ P().Cube ] },
							(pCubeContextError, pCubeContext) =>
							{
								call(tmpEngine, 'execute', pCubeContext, P().Aggs,
									(pCubeError, pCube) =>
									{
										Expect(pCubeError).to.equal(null);
										Expect(pCube.CubeFallbacks).to.deep.equal([]);
										Expect(pCube.Statements).to.equal(1);
										K.context('Project', 'Lead', { Variants: P().Variants, PlanForm: { Cube: 'Never' } },
											(pVariantContextError, pVariantContext) =>
											{
												call(tmpEngine, 'execute', pVariantContext, P().Aggs,
													(pVariantError, pVariant) =>
													{
														Expect(pVariantError).to.equal(null);
														Expect(pVariant.Statements).to.equal(P().Aggs.length);
														Object.keys(pVariant.Results).forEach((pKey) => { Expect(F.normalizeRaw(pCube.Results[pKey]), pKey).to.deep.equal(F.normalizeRaw(pVariant.Results[pKey])); });
														return fDone();
													});
											});
									});
							});
					});

				test('date traps before 1970 and at the DateTime64 floor bucket identically (day, week, quarter, year, Stats); cross-tenant / deleted FK targets are Missing on K8',
					function (fDone)
					{
						let K = _Benches['SQLite|ProjectTrack'];
						fBoth(K, 'Project', 'Lead', () => { return emptyVariants('Project'); }, projectExtraAggs,
							(pLive, pStore) =>
							{
								Expect(pStore.Refused).to.deep.equal({});
								let tmpYears = pStore.Results.StartYear.Groups.map((pGroup) => { return pGroup.Key; });
								Expect(tmpYears).to.include('1965-01-01 00:00:00');
								Expect(tmpYears).to.include('1969-01-01 00:00:00');
								Expect(tmpYears).to.include('1900-01-01 00:00:00');
								Expect(pStore.Results.StartWeek.Groups.map((pGroup) => { return pGroup.Key; })).to.include('1969-12-29 00:00:00');
								Expect(pStore.Results.StartStats.Stats.Min).to.equal('1900-01-01 00:00:00');
								Object.keys(pLive.Results).forEach((pKey) => { Expect(F.normalizeRaw(pStore.Results[pKey]), pKey).to.deep.equal(F.normalizeRaw(pLive.Results[pKey])); });
								let C = F.projectCoverage(1, 3);
								fBoth(K, 'Document', 'Lead', () => { return emptyVariants('Document'); }, () => { return [ C.ByClient ]; },
									(pLiveDocuments, pStoreDocuments) =>
									{
										// Documents of projects with a deleted / tenant-2 / NULL client have no visible Name: Missing.
										Expect(pStoreDocuments.Results.ByClient.MissingCount).to.be.above(0);
										Expect(pStoreDocuments.Results.ByClient.MissingCount).to.equal(pLiveDocuments.Results.ByClient.MissingCount);
										Expect(pStoreDocuments.Results.ByClient.Groups.map((pGroup) => { return pGroup.Key; })).to.not.include('T2 Client 101');
										return fDone();
									});
							});
					});

				test('a store error through the client\'s fault injector: the whole call fails with .StoreError (the Router falls back to Live)',
					function (fDone)
					{
						let K = _Benches['SQLite|ProjectTrack'];
						let tmpStore = K.fable.RetoldFacetingStoreClickHouse;
						tmpStore.setFaultInjector((pInfo) => { return (pInfo.Kind === 'Query') ? { Status: 500, Text: 'Code: 241. DB::Exception: Memory limit (injected)', When: 'Before' } : null; });
						K.context('Project', 'Lead', emptyVariants('Project'),
							(pContextError, pContext) =>
							{
								call(K.fable.RetoldFacetingEngineClickHouse, 'execute', pContext, [ F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'Project' }) ],
									(pError) =>
									{
										tmpStore.setFaultInjector(null);
										Expect(pError).to.be.an('error');
										Expect(pError.StoreError).to.equal(true);
										Expect(pError.Status).to.equal(500);
										return fDone();
									});
							});
					});
			}
		);

		suite
		(
			'ClickHouse: the Bookstore conformance list (Bookstore and Bookstore-Tenant) equals Live or refuses with its reason',
			() =>
			{
				let _Skip = !CH_GATE.Available;
				const FIXTURES = [ [ 'Bookstore', {} ], [ 'Bookstore-Tenant', { Tenant: 1 } ], [ 'Bookstore-Tenant', { Tenant: 2 } ] ];
				let _Harnesses = {};
				let _Databases = [];

				suiteSetup(
					function (fDone)
					{
						if (_Skip)
						{
							this.skip();
							return;
						}
						this.timeout(240000);
						libSupport.ensure(
							(pEnsureError) =>
							{
								if (pEnsureError)
								{
									return fDone(pEnsureError);
								}
								let tmpFixtures = [ 'Bookstore', 'Bookstore-Tenant' ];
								let fNext = (pIndex) =>
								{
									if (pIndex >= tmpFixtures.length)
									{
										return fDone();
									}
									let H = libHarness.start({ Port: PORT, Fixture: tmpFixtures[pIndex] },
										(pStartError) =>
										{
											if (pStartError)
											{
												return fDone(pStartError);
											}
											let tmpDatabase = libSupport.freshDatabase();
											_Databases.push(tmpDatabase);
											libSupport.loadMirrors(H, { Database: tmpDatabase },
												(pLoadError, pLoaded) =>
												{
													if (pLoadError)
													{
														return fDone(pLoadError);
													}
													let tmpLossy = {};
													Object.keys(pLoaded.Entities).forEach((pEntity) => { tmpLossy[pEntity] = pLoaded.Entities[pEntity].Lossy; });
													H.fable.RetoldFacetingEngineClickHouse.useStaticMirrors({ Lossy: tmpLossy });
													H.Loaded = pLoaded;
													// Every Live execution also runs the store over the same context and Aggs.
													let tmpLive = H.fable.RetoldFacetingEngineLive;
													let fExecute = tmpLive.execute.bind(tmpLive);
													H.Captured = [];
													tmpLive.execute = (pContext, pAggs, fCallback) =>
													{
														fExecute(pContext, pAggs,
															(pError, pExecution) =>
															{
																H.fable.RetoldFacetingEngineClickHouse.execute(pContext, pAggs,
																	(pStoreError, pStore) =>
																	{
																		H.Captured.push({ Live: pExecution, LiveError: pError, Store: pStore, StoreError: pStoreError });
																		return fCallback(pError, pExecution);
																	});
															});
													};
													let fIntercepted = tmpLive.execute;
													H.restoreLive = () => { tmpLive.execute = fExecute; };
													H.interceptLive = () => { tmpLive.execute = fIntercepted; };
													_Harnesses[tmpFixtures[pIndex]] = H;
													return fNext(pIndex + 1);
												});
										});
								};
								fNext(0);
							});
					});

				suiteTeardown(
					function (fDone)
					{
						this.timeout(60000);
						let tmpHarnesses = Object.keys(_Harnesses).map((pKey) => { return _Harnesses[pKey]; });
						let fStop = (pIndex) =>
						{
							if (pIndex >= tmpHarnesses.length)
							{
								let fRelease = (pDatabaseIndex) =>
								{
									if (pDatabaseIndex >= _Databases.length)
									{
										return fDone();
									}
									libSupport.release(_Databases[pDatabaseIndex], () => { return fRelease(pDatabaseIndex + 1); });
								};
								return fRelease(0);
							}
							tmpHarnesses[pIndex].restoreLive();
							tmpHarnesses[pIndex].stop(() => { return fStop(pIndex + 1); });
						};
						fStop(0);
					});

				// The refusals the Bookstore data must produce (and only these): Lossy columns and Show-deleted.
				const EXPECTED_REFUSALS = [ 'LossyColumn:BookStoreSale.SaleDate', 'LossyColumn:BookPrice.EndDate', 'LossyColumn:BookStoreInventory.BookCount', 'DeletedRowsNotMirrored' ];

				FIXTURES.forEach(
					(pFixture) =>
					{
						test(`${pFixture[0]} ${JSON.stringify(pFixture[1])}: every fixture's store-answered facets equal Live; refusals carry their reasons`,
							function (fDone)
							{
								let H = _Harnesses[pFixture[0]];
								let tmpFixtures = libConformanceFixtures.build(Expect, () => { return {}; }, libHarness).Fixtures;
								let tmpAnswered = 0;
								let tmpRefusals = new Set();
								let fNext = (pIndex) =>
								{
									if (pIndex >= tmpFixtures.length)
									{
										Expect(tmpAnswered).to.be.above(60);
										tmpRefusals.forEach((pReason) => { Expect(EXPECTED_REFUSALS, pReason).to.include(pReason); SEEN_REASONS.add(pReason); });
										if (pFixture[0] === 'Bookstore')
										{
											Expect(Array.from(tmpRefusals).sort()).to.deep.equal(EXPECTED_REFUSALS.slice().sort());
										}
										return fDone();
									}
									let X = tmpFixtures[pIndex];
									H.Captured = [];
									H.query(X.Entity, X.Body, Object.assign({}, X.Session || {}, pFixture[1]),
										() =>
										{
											H.Captured.forEach(
												(pCapture) =>
												{
													Expect(pCapture.StoreError, `${X.Name}: ${pCapture.StoreError ? pCapture.StoreError.message : ''}`).to.equal(null);
													Object.keys(pCapture.Live.Results).forEach(
														(pKey) =>
														{
															if (pCapture.Store.Results[pKey])
															{
																tmpAnswered++;
																Expect(F.normalizeRaw(pCapture.Store.Results[pKey]), `${X.Name} / ${pKey}`).to.deep.equal(F.normalizeRaw(pCapture.Live.Results[pKey]));
																return;
															}
															Expect(pCapture.Store.Refused, `${X.Name} / ${pKey}`).to.have.property(pKey);
															tmpRefusals.add(pCapture.Store.Refused[pKey]);
														});
													Object.keys(pCapture.Live.Errors).forEach(
														(pKey) =>
														{
															if (!pCapture.Store.Refused[pKey])
															{
																Expect(pCapture.Store.Errors[pKey], `${X.Name} / ${pKey}`).to.deep.equal(pCapture.Live.Errors[pKey]);
															}
														});
												});
											return fNext(pIndex + 1);
										});
								};
								fNext(0);
							});
					});

				test('Bookstore golden Aggs (decimals, dates, strings; Nice / Edges / Ranges / Stats / DistinctCount / Missing / Pivot axes) execute and equal Live',
					function (fDone)
					{
						let H = _Harnesses.Bookstore;
						let tmpCase = bookstoreGoldenAggs()[0];
						harnessContext(H, tmpCase[1], {}, { Variants: emptyVariants(tmpCase[1]).Variants },
							(pLiveContextError, pLiveContext) =>
							{
								Expect(pLiveContextError).to.equal(null);
								H.restoreLive();
								call(H.fable.RetoldFacetingEngineLive, 'execute', pLiveContext, bookstoreGoldenAggs()[0][2],
									(pLiveError, pLive) =>
									{
										Expect(pLiveError).to.equal(null);
										harnessContext(H, tmpCase[1], {}, { Variants: emptyVariants(tmpCase[1]).Variants },
											(pStoreContextError, pStoreContext) =>
											{
												call(H.fable.RetoldFacetingEngineClickHouse, 'execute', pStoreContext, bookstoreGoldenAggs()[0][2],
													(pStoreError, pStore) =>
													{
														Expect(pStoreError).to.equal(null);
														Expect(pStore.Refused).to.deep.equal({});
														Expect(Object.keys(pStore.Results).sort()).to.deep.equal(Object.keys(pLive.Results).sort());
														Object.keys(pLive.Results).forEach((pKey) => { Expect(F.normalizeRaw(pStore.Results[pKey]), pKey).to.deep.equal(F.normalizeRaw(pLive.Results[pKey])); });
														return fDone();
													});
											});
									});
							});
					});

				test('Bookstore traps answered by the store: \'\' keys vs NULL Missing (Book.Language), the 499.996 Nice edge (TotalAmount)',
					function (fDone)
					{
						let H = _Harnesses.Bookstore;
						H.interceptLive();
						H.Captured = [];
						H.query('Book', { Facets: [ { Key: 'Lang', Facet: 'Book.Language', Top: 50 } ] }, {},
							() =>
							{
								let tmpLang = H.Captured[0];
								Expect(tmpLang.Store.Results.Lang.Groups.some((pGroup) => { return pGroup.Key === ''; })).to.equal(true);
								Expect(tmpLang.Store.Results.Lang.MissingCount).to.be.above(0);
								Expect(F.normalizeRaw(tmpLang.Store.Results.Lang)).to.deep.equal(F.normalizeRaw(tmpLang.Live.Results.Lang));
								H.Captured = [];
								H.query('BookStoreSale', { Facets: [ { Key: 'Amount', Facet: 'BookStoreSale.TotalAmount', Fold: 'NumericHistogram', Buckets: 20 }, { Key: 'AmountStats', Facet: 'BookStoreSale.TotalAmount', Fold: 'Stats' } ] }, {},
									() =>
									{
										let tmpAmount = H.Captured[0];
										Expect(tmpAmount.Store.Refused).to.deep.equal({});
										Expect(tmpAmount.Store.Results.Amount.Bounds.Hi).to.be.at.least(499.996);
										Expect(F.normalizeRaw(tmpAmount.Store.Results.Amount)).to.deep.equal(F.normalizeRaw(tmpAmount.Live.Results.Amount));
										Expect(tmpAmount.Store.Results.AmountStats.Stats).to.deep.equal(tmpAmount.Live.Results.AmountStats.Stats);
										return fDone();
									});
							});
					});
			}
		);

		suite
		(
			'ClickHouse: planner-produced Aggs (definitions, scopes, cubes) on ProjectTrack and LabTrack equal Live for every principal',
			() =>
			{
				let _Skip = !CH_GATE.Available;
				let _Harnesses = {};
				let _Databases = [];
				// The motivating requests (08 §2–§4) through the real pipeline: the planner's Variants, cubes and definitions.
				const BODIES = Object.freeze(
					{
						ProjectTrack:
						[
							[ 'Project',
								{
									Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead' ] } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
									Clauses:
									[
										{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active', 'AtRisk' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' },
										{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: [ 1, 2, 3, 4, 5, 101 ], FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' },
										{ Type: 'DateRange', FilterByColumn: 'StartDate', Values: { Start: '2026-01-01 00:00:00', End: '2027-01-01 00:00:00' }, EndExclusive: true, FilterKey: 'StartDate', Hash: 'StartDate-DR-1' }
									],
									Facets: [ { Key: 'Status', Facet: 'Project.Status' }, { Key: 'Client', Facet: 'Project.IDClient', Top: 20 }, { Key: 'Started', Facet: 'Project.StartDate', Interval: 'month' }, { Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' }, { Key: 'StatusByClient', Facet: [ 'Project.Status', 'Project.IDClient' ], Fold: 'Pivot' } ],
									Total: true
								} ],
							[ 'Document',
								{
									Clauses:
									[
										{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'FormType', JoinInternalConnectionColumn: 'IDFormType', JoinExternalConnectionColumn: 'IDFormType', Values: [ 3 ], FilterKey: 'IDFormType', Hash: 'IDFormType-IJ-1' },
										{ Type: 'DateRange', FilterByColumn: 'DocumentDate', Values: { Start: '2026-01-01 00:00:00', End: '2026-07-01 00:00:00' }, EndExclusive: true, FilterKey: 'DocumentDate', Hash: 'DocumentDate-DR-1' }
									],
									Facets: [ { Key: 'ByMonth', Facet: 'Document.DocumentDate', Interval: 'month' }, { Key: 'ByForm', Facet: 'Document.IDFormType', Top: 20 }, { Key: 'Status', Facet: 'Document.Status', Exclude: 'None' } ],
									Total: true
								} ]
						],
						LabTrack:
						[
							[ 'MaterialIntakeRequirement', { Facets: [ { Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' }, { Key: 'Week', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek' }, { Key: 'Discipline', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' }, { Key: 'Started', Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started' } ], Total: true } ],
							[ 'MaterialIntake', { Facets: [ { Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntake.FormsToDo/ByQueue' }, { Key: 'Week', Facet: 'MaterialIntake.FormsToDo/ByWeek' }, { Key: 'ByRequiredForm', Facet: 'MaterialIntake.ByRequiredForm' } ], Total: true } ]
						]
					});
				const PRINCIPALS = Object.freeze({ ProjectTrack: [ 'Lead', 'Member', 'Outsider', 'OtherLead' ], LabTrack: [ 'Tech', 'Colleague', 'Newbie', 'OtherTech' ] });

				suiteSetup(
					function (fDone)
					{
						if (_Skip)
						{
							this.skip();
							return;
						}
						this.timeout(240000);
						libSupport.ensure(
							(pEnsureError) =>
							{
								if (pEnsureError)
								{
									return fDone(pEnsureError);
								}
								let tmpDomains = Object.keys(BODIES);
								let fNext = (pIndex) =>
								{
									if (pIndex >= tmpDomains.length)
									{
										return fDone();
									}
									let H = libHarness.start({ Port: PORT, Fixture: tmpDomains[pIndex] },
										(pStartError) =>
										{
											if (pStartError)
											{
												return fDone(pStartError);
											}
											let tmpDatabase = libSupport.freshDatabase();
											_Databases.push(tmpDatabase);
											libSupport.loadMirrors(H, { Database: tmpDatabase },
												(pLoadError, pLoaded) =>
												{
													if (pLoadError)
													{
														return fDone(pLoadError);
													}
													let tmpLossy = {};
													Object.keys(pLoaded.Entities).forEach((pEntity) => { tmpLossy[pEntity] = pLoaded.Entities[pEntity].Lossy; });
													H.fable.RetoldFacetingEngineClickHouse.useStaticMirrors({ Lossy: tmpLossy });
													let tmpLive = H.fable.RetoldFacetingEngineLive;
													let fExecute = tmpLive.execute.bind(tmpLive);
													H.Captured = [];
													tmpLive.execute = (pContext, pAggs, fCallback) =>
													{
														fExecute(pContext, pAggs,
															(pError, pExecution) =>
															{
																H.fable.RetoldFacetingEngineClickHouse.execute(pContext, pAggs,
																	(pStoreError, pStore) =>
																	{
																		H.Captured.push({ Live: pExecution, Store: pStore, StoreError: pStoreError });
																		return fCallback(pError, pExecution);
																	});
															});
													};
													H.restoreLive = () => { tmpLive.execute = fExecute; };
													_Harnesses[tmpDomains[pIndex]] = H;
													return fNext(pIndex + 1);
												});
										});
								};
								fNext(0);
							});
					});

				suiteTeardown(
					function (fDone)
					{
						this.timeout(60000);
						let tmpHarnesses = Object.keys(_Harnesses).map((pKey) => { return _Harnesses[pKey]; });
						let fStop = (pIndex) =>
						{
							if (pIndex >= tmpHarnesses.length)
							{
								let fRelease = (pDatabaseIndex) =>
								{
									if (pDatabaseIndex >= _Databases.length)
									{
										return fDone();
									}
									libSupport.release(_Databases[pDatabaseIndex], () => { return fRelease(pDatabaseIndex + 1); });
								};
								return fRelease(0);
							}
							tmpHarnesses[pIndex].restoreLive();
							tmpHarnesses[pIndex].stop(() => { return fStop(pIndex + 1); });
						};
						fStop(0);
					});

				Object.keys(BODIES).forEach(
					(pDomain) =>
					{
						BODIES[pDomain].forEach(
							(pBody) =>
							{
								test(`${pDomain} ${pBody[0]}: every principal, every facet store-answered and equal to Live`,
									function (fDone)
									{
										let H = _Harnesses[pDomain];
										let tmpPrincipals = PRINCIPALS[pDomain];
										let fNext = (pIndex) =>
										{
											if (pIndex >= tmpPrincipals.length)
											{
												return fDone();
											}
											H.Captured = [];
											H.query(pBody[0], pBody[1], Object.assign({ Now: libKit.TEST_NOW }, H.as(tmpPrincipals[pIndex])),
												(pError) =>
												{
													Expect(pError).to.equal(null);
													Expect(H.Captured).to.have.length(1);
													let tmpCapture = H.Captured[0];
													Expect(tmpCapture.StoreError).to.equal(null);
													Expect(tmpCapture.Store.Refused, tmpPrincipals[pIndex]).to.deep.equal({});
													Expect(tmpCapture.Store.Errors).to.deep.equal(tmpCapture.Live.Errors);
													Expect(Object.keys(tmpCapture.Store.Results).sort()).to.deep.equal(Object.keys(tmpCapture.Live.Results).sort());
													Object.keys(tmpCapture.Live.Results).forEach((pKey) => { Expect(F.normalizeRaw(tmpCapture.Store.Results[pKey]), `${tmpPrincipals[pIndex]} / ${pKey}`).to.deep.equal(F.normalizeRaw(tmpCapture.Live.Results[pKey])); });
													return fNext(pIndex + 1);
												});
										};
										fNext(0);
									});
							});
					});
			}
		);

		suite
		(
			'ClickHouse: numeric buckets at decimal edges equal the contract math (§10.3.2)',
			() =>
			{
				let _Skip = !CH_GATE.Available;
				let _Database = null;
				let _Client = null;
				// Values on, just below and just above decimal edges (8.4 / 0.2 widths), the sub-scale 499.996 trap, negatives, NULL.
				const VALUES = [ 0.2, 0.4, 0.6, 8.2, 8.4, 8.6, 8.39, 8.41, 4.2, 4.3, 0.29, 0.005, 1.005, 2.675, 499.996, 499.995, 500, -0.2, -8.4, -0.005, 12.3, 99.99, null, null ];
				const NUM_SPEC = spec('Num', 'Unscoped', null, null, [ [ 'IDNum', 'ID', I64 ], [ 'Deleted', 'Boolean', NU8 ], [ 'Amount', 'Decimal', NF64 ] ]);

				suiteSetup(
					function (fDone)
					{
						if (_Skip)
						{
							this.skip();
							return;
						}
						libSupport.ensure(
							(pEnsureError) =>
							{
								if (pEnsureError)
								{
									return fDone(pEnsureError);
								}
								let tmpInfo = libSupport.connectionInfo();
								_Database = libSupport.freshDatabase();
								_Client = new libClickHouseClient({ URL: tmpInfo.URL, User: tmpInfo.User, Password: tmpInfo.Password, Database: 'default' });
								_Client.command(`CREATE DATABASE IF NOT EXISTS \`${_Database}\` ENGINE = Atomic`, null, null,
									(pCreateError) =>
									{
										if (pCreateError)
										{
											return fDone(pCreateError);
										}
										_Client.command(`CREATE TABLE \`${_Database}\`.\`Num\` (\`IDNum\` Int64, \`Deleted\` Nullable(UInt8), \`Amount\` Nullable(Float64), \`_Version\` UInt64, \`_IsDeleted\` UInt8) ENGINE = ReplacingMergeTree(\`_Version\`, \`_IsDeleted\`) ORDER BY (\`IDNum\`)`, null, null,
											(pTableError) =>
											{
												if (pTableError)
												{
													return fDone(pTableError);
												}
												let tmpRows = VALUES.map((pValue, pIndex) => { return { IDNum: pIndex + 1, Deleted: 0, Amount: pValue, _Version: 1, _IsDeleted: 0 }; });
												_Client.insert(`\`${_Database}\`.\`Num\``, tmpRows, {}, (pInsertError) => { return fDone(pInsertError || undefined); });
											});
									});
							});
					});

				suiteTeardown(
					function (fDone)
					{
						if (!_Database)
						{
							return fDone();
						}
						libSupport.release(_Database, () => { return fDone(); });
					});

				/**
				 * Run a compiled statement on the test database.
				 */
				let fRun = (pStatement, fCallback) =>
				{
					_Client.query(pStatement.SQL, pStatement.Params, pStatement.Settings, (pError, pRows) => { Expect(pError, pError ? pError.message : '').to.equal(null); return fCallback(pRows); });
				};

				test('Nice histograms over several scales and bucket counts: bounds, then every bucket count equals FacetBuckets.numericIndex',
					function (fDone)
					{
						let tmpNonNull = VALUES.filter((pValue) => { return pValue !== null; });
						let tmpCases = [];
						[ 1, 2, 3 ].forEach((pScale) => { [ 3, 7, 20, 42 ].forEach((pBuckets) => { tmpCases.push({ Scale: pScale, Buckets: pBuckets }); }); });
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpCases.length)
							{
								return fDone();
							}
							let tmpCase = tmpCases[pIndex];
							let tmpAgg = F.agg({ Key: 'N', Kind: 'NumericHistogram', Pivot: 'Num', Dimensions: [ { Kind: 'NumericBucket', Field: 'Amount', Mode: 'Nice', Buckets: tmpCase.Buckets, DataType: 'Decimal', IsInteger: false, Scale: tmpCase.Scale } ] });
							let tmpInput = input({ p: relation('Num', [ E('Deleted', '=', 0) ]) }, { Database: _Database, Specs: { Num: NUM_SPEC } });
							let tmpBounds = libFoldCompiler.compileAgg(tmpAgg, tmpInput);
							fRun(tmpBounds.Statements[0],
								(pBoundsRows) =>
								{
									Expect(pBoundsRows[0]).to.deep.equal({ Rows: VALUES.length, NonNull: tmpNonNull.length, Lo: Math.min(...tmpNonNull), Hi: Math.max(...tmpNonNull) });
									let tmpGeometry = libFacetBuckets.numericGeometry(pBoundsRows[0].Lo, pBoundsRows[0].Hi, tmpCase.Buckets, tmpCase.Scale, 500);
									let tmpBuckets = libFoldCompiler.compileAgg(tmpAgg, Object.assign({}, tmpInput, { Geometry: { Mode: 'Nice', Factor: tmpGeometry.Factor, LoUnits: tmpGeometry.LoUnits, WidthUnits: tmpGeometry.WidthUnits, N: tmpGeometry.N } }));
									fRun(tmpBuckets.Statements[0],
										(pRows) =>
										{
											let tmpExpected = {};
											tmpNonNull.forEach((pValue) => { let tmpKey = libFacetBuckets.numericIndex(pValue, tmpGeometry); tmpExpected[tmpKey] = (tmpExpected[tmpKey] || 0) + 1; });
											let tmpActual = {};
											pRows.forEach((pRow) => { tmpActual[pRow.Key] = pRow.Count; });
											Expect(tmpActual, JSON.stringify(tmpCase)).to.deep.equal(tmpExpected);
											return fNext(pIndex + 1);
										});
								});
						};
						fNext(0);
					});

				test('Edges and Ranges at decimal boundaries: first match wins, half-open, the open bucket, NULL apart',
					function (fDone)
					{
						let tmpInput = input({ p: relation('Num', [ E('Deleted', '=', 0) ]) }, { Database: _Database, Specs: { Num: NUM_SPEC } });
						let tmpEdges = [ -0.2, 0.2, 8.4, 499.995 ];
						let tmpEdgesAgg = F.agg({ Key: 'E', Kind: 'NumericHistogram', Pivot: 'Num', Dimensions: [ { Kind: 'NumericBucket', Field: 'Amount', Mode: 'Edges', Edges: tmpEdges, OpenEnded: true, DataType: 'Decimal', IsInteger: false, Scale: 3 } ] });
						let tmpGeometry = libFacetBuckets.edgesGeometry(tmpEdges, true, 3);
						fRun(libFoldCompiler.compileAgg(tmpEdgesAgg, Object.assign({}, tmpInput, { Geometry: { Mode: 'Edges', Edges: tmpEdges, OpenEnded: true } })).Statements[0],
							(pRows) =>
							{
								let tmpExpected = {};
								VALUES.filter((pValue) => { return pValue !== null; }).forEach((pValue) => { let tmpKey = libFacetBuckets.numericIndex(pValue, tmpGeometry); tmpExpected[String(tmpKey)] = (tmpExpected[String(tmpKey)] || 0) + 1; });
								let tmpActual = {};
								pRows.forEach((pRow) => { tmpActual[String(pRow.Key)] = pRow.Count; });
								Expect(tmpActual).to.deep.equal(tmpExpected);
								let tmpRanges = [ { Key: 'neg', From: null, To: 0 }, { Key: 'tiny', From: 0, To: 0.2 }, { Key: 'mid', From: 0.2, To: 8.4 }, { Key: 'overlap', From: 8.39, To: 8.41 }, { Key: 'big', From: 8.4, To: null } ];
								let tmpRangesAgg = F.agg({ Key: 'R', Kind: 'Ranges', Pivot: 'Num', Dimensions: [ { Kind: 'Range', Field: 'Amount', Ranges: tmpRanges, DataType: 'Decimal', IsInteger: false, Scale: 3 } ] });
								fRun(libFoldCompiler.compileAgg(tmpRangesAgg, tmpInput).Statements[0],
									(pRangeRows) =>
									{
										let tmpExpectedRanges = {};
										VALUES.forEach(
											(pValue) =>
											{
												let tmpIndex = (pValue === null) ? -1 : tmpRanges.findIndex((pRange) => { return ((pRange.From === null) || (pValue >= pRange.From)) && ((pRange.To === null) || (pValue < pRange.To)); });
												let tmpKey = (tmpIndex === -1) && (pValue !== null) ? -2 : tmpIndex;
												tmpExpectedRanges[String(tmpKey)] = (tmpExpectedRanges[String(tmpKey)] || 0) + 1;
											});
										let tmpActualRanges = {};
										pRangeRows.forEach((pRow) => { tmpActualRanges[String(pRow.Key)] = pRow.Count; });
										Expect(tmpActualRanges).to.deep.equal(tmpExpectedRanges);
										return fDone();
									});
							});
					});
			}
		);

		suite
		(
			'Reasons',
			() =>
			{
				test('every refusal reason seen in this file belongs to REASON_CLASSES',
					() =>
					{
						Expect(SEEN_REASONS.size).to.be.above(15);
						SEEN_REASONS.forEach((pReason) => { Expect(libFoldCompiler.REASON_CLASSES, pReason).to.include(pReason.split(':')[0]); });
						Expect(new libRetoldFacetingEngineClickHouse(libBuilders.newFable()).EngineName).to.equal('ClickHouse');
						Expect(libRetoldFacetingEngineClickHouse.ENGINE_NAME).to.equal('ClickHouse');
					});
			}
		);
	}
);
