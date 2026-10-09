/**
 * Facet-Live-M2-FoldIR — hand-lowered FoldIR (internal-contracts §24) for the motivating queries and
 * the coverage folds of the ProjectTrack / LabTrack benches, plus their DIRECT-SQL oracles written
 * from the definitions' prose (08 §2–§4): tenancy (IDCustomer), soft delete and the LabForm owner
 * scope are spelled out per table, so the oracle shares nothing with the Live engine.
 *
 * The FoldIR here is exactly what the Planner's lowering (§24.8) must produce for the definitions in
 * test/fixtures/*-Definitions.json; the Live tests run on it so Live is checked independently of
 * the lowering, and the Plan tests can compare the Planner's output against the same shapes.
 *
 * @author Steven Velozo <steven@velozo.com>
 */

// ------------------------------------------------------------------ builders

/**
 * A Rel (§24.1) with defaults.
 *
 * @param {string} pEntity
 * @param {string} pAs
 * @param {Array<string>} pProject
 * @param {Record<string, any>} [pExtra]
 * @return {Record<string, any>}
 */
const rel = (pEntity, pAs, pProject, pExtra) =>
{
	return Object.assign({ Entity: pEntity, As: pAs, Role: 'Hop', Project: pProject, Client: null, Where: null, WhereHash: '', Scope: 'Inherit', ScopeReason: null, SoftDelete: 'Explicit', Stage: 'Never' }, pExtra || {});
};

const on = (pOuterAlias, pOuterField, pInner) => { return { Outer: { Alias: pOuterAlias, Field: pOuterField }, Inner: pInner }; };
const exists = (pRel, pOn, pWhere) => { return { Node: 'Exists', Rel: pRel, On: pOn, Where: pWhere || null }; };
const notExists = (pRel, pOn, pWhere) => { return { Node: 'NotExists', Rel: pRel, On: pOn, Where: pWhere || null }; };
const countCmp = (pRel, pOn, pWhere, pOp, pN) => { return { Node: 'CountCmp', Rel: pRel, On: pOn, Where: pWhere || null, Op: pOp, N: pN }; };
const and = (...pItems) => { return { Node: 'And', Items: pItems }; };
const or = (...pItems) => { return { Node: 'Or', Items: pItems }; };
const cmp = (pAlias, pField, pOp, pValue) => { let tmpNode = { Node: 'Cmp', Alias: pAlias, Field: pField, Op: pOp }; if (typeof(pValue) !== 'undefined') { tmpNode.Value = pValue; } return tmpNode; };

/**
 * An Agg with defaults (§5.1 + §24.5).
 *
 * @param {Record<string, any>} pFields
 * @return {Record<string, any>}
 */
const agg = (pFields) =>
{
	return Object.assign(
		{
			Key: null, Kind: 'Terms', Pivot: null, Dimensions: [], Field: null, FieldInfo: null, Measures: [ { Op: 'count' } ], CountMode: 'Rows',
			Top: 50, Order: 'CountDesc', Missing: true, EmptyBuckets: true, Exclude: 'None', VariantId: 'v0', SelectedKeys: [],
			Where: null, WhereHash: '', Tuple: null, MultiValued: false, Origin: 'Declared'
		}, pFields);
};

/**
 * A Variant (§24.6) over hand-built conjuncts (Column-shape → ColumnConjuncts; PathPred given).
 *
 * @param {string} pVariantId
 * @param {string} pEntity
 * @param {Array<Record<string, any>>} pConjuncts
 * @param {Record<string, any>|null} pPathPred
 * @return {Record<string, any>}
 */
const variant = (pVariantId, pEntity, pConjuncts, pPathPred) =>
{
	return (
		{
			VariantId: pVariantId, Entity: pEntity, Hash: pConjuncts.map((pConjunct) => { return pConjunct.Id; }).join(','),
			ConjunctIds: pConjuncts.map((pConjunct) => { return pConjunct.Id; }), Conjuncts: pConjuncts,
			ColumnConjuncts: pConjuncts.filter((pConjunct) => { return pConjunct.Shape !== 'Path'; }),
			PathPred: pPathPred || null, ExcludedIds: [], IncludesDeleted: false, Facets: [], Where: null, WhereHash: ''
		});
};

/**
 * A conjunct (§4.2 + §23.1).
 *
 * @param {string} pId
 * @param {Record<string, any>} pPred - Part I Pred (Column shape) or the bound existence Pred (Path shape)
 * @param {Record<string, any>} [pExtra] - Shape, FoldPred, Fields, …
 * @return {Record<string, any>}
 */
const conjunct = (pId, pPred, pExtra) =>
{
	return Object.assign({ Id: pId, Origin: { Kind: 'Clause', Hash: null, FilterKey: null, ClauseType: null, Index: 0 }, Fields: [], NeverExclude: false, Fence: true, NamesDeleted: false, Shape: 'Column', Binds: [], Entities: [], Pred: pPred }, pExtra || {});
};

const columnDim = (pField, pDataType, pExtra) => { return Object.assign({ Kind: 'Column', Field: pField, DataType: pDataType, IsInteger: [ 'ID', 'Numeric', 'ForeignKey' ].indexOf(pDataType) >= 0, Scale: 0 }, pExtra || {}); };
const dateDim = (pField, pInterval, pExtra) => { return Object.assign({ Kind: 'DateBucket', Field: pField, Interval: pInterval, DataType: 'DateTime' }, pExtra || {}); };

// ------------------------------------------------------------------ SQL oracle helpers

/**
 * The visibility predicate of a tenant-scoped, soft-deletable table for a principal.
 *
 * @param {string} pAlias
 * @param {number} pTenant
 * @return {string}
 */
const visible = (pAlias, pTenant) =>
{
	return `${pAlias}.IDCustomer = ${Number(pTenant)} AND ${pAlias}.Deleted = 0`;
};

// ================================================================== LabTrack

const LAB_TEST_NOW = '2026-10-08 12:00:00';

/**
 * InMyQueues (08 §4.1) at an outer MaterialIntake alias: the queue path (the Status leaf goes into
 * the intake hop's own Rel.Where by the col/path split).
 *
 * @param {string} pOuter - the MaterialIntake alias
 * @param {string} pQueueAlias
 * @param {string} pMemberAlias
 * @param {number} pUser
 * @return {Record<string, any>}
 */
const labQueuePath = (pOuter, pQueueAlias, pMemberAlias, pUser) =>
{
	return exists(rel('LabQueue', pQueueAlias, [ 'IDLabQueue' ]), [ on(pOuter, 'IDLabQueue', 'IDLabQueue') ],
		exists(rel('LabQueueMember', pMemberAlias, [ 'IDLabQueueMember', 'IDLabQueue' ], { Where: { And: [ { Field: 'IDUser', Op: 'EQ', Value: pUser }, { Field: 'Active', Op: 'EQ', Value: 1 } ] }, Stage: 'Allowed' }),
			[ on(pQueueAlias, 'IDLabQueue', 'IDLabQueue') ]));
};

const OPEN_STATUSES = [ 'Received', 'InProgress' ];

/**
 * ToDoForMe (08 §4.2) lowered at the requirement pivot 'p'.
 *
 * @param {number} pUser
 * @param {string} [pScope] - the LabForm hop's scope ('TenantOnly' as declared, or 'Inherit')
 * @return {Record<string, any>}
 */
const toDoForMe = (pUser, pScope) =>
{
	let tmpScope = pScope || 'TenantOnly';
	return and(
		exists(rel('MaterialIntake', 'j1', [ 'IDMaterialIntake', 'IDLabQueue' ], { Where: { Field: 'Status', Op: 'IN', Value: OPEN_STATUSES } }), [ on('p', 'IDMaterialIntake', 'IDMaterialIntake') ],
			labQueuePath('j1', 'j2', 'j3', pUser)),
		notExists(rel('LabForm', 'j4', [ 'IDLabForm', 'IDMaterialIntake', 'IDLabFormType' ], { Where: { Field: 'Status', Op: 'EQ', Value: 'Complete' }, Scope: tmpScope, ScopeReason: (tmpScope === 'TenantOnly') ? 'A form completed by any technician in my lab satisfies the requirement.' : null, Stage: 'Allowed' }),
			[ on('p', 'IDMaterialIntake', 'IDMaterialIntake'), on('p', 'IDLabFormType', 'IDLabFormType') ]));
};

/**
 * The E3A (variant A) Aggs: ToDo and its siblings, all sharing W_def = ToDoForMe.
 *
 * @param {number} pUser
 * @param {string} [pScope]
 * @return {Array<Record<string, any>>}
 */
const e3aAggs = (pUser, pScope) =>
{
	let tmpWhere = toDoForMe(pUser, pScope);
	let tmpBase = { Pivot: 'MaterialIntakeRequirement', Where: tmpWhere, WhereHash: 'wh:todo', VariantId: 'vt' };
	return (
		[
			agg(Object.assign({ Key: 'ToDo', Kind: 'Terms', Dimensions: [ columnDim('IDLabFormType', 'Numeric') ] }, tmpBase)),
			agg(Object.assign({ Key: 'Queue', Kind: 'Terms', Dimensions: [ columnDim('IDLabQueue', 'ID',
				{ Via: [ { Rel: rel('MaterialIntake', 'l1', [ 'IDMaterialIntake', 'IDLabQueue' ], { Role: 'Lookup' }), On: [ on('p', 'IDMaterialIntake', 'IDMaterialIntake') ] },
				         { Rel: rel('LabQueue', 'l2', [ 'IDLabQueue' ], { Role: 'Lookup' }), On: [ on('l1', 'IDLabQueue', 'IDLabQueue') ] } ] }) ] }, tmpBase)),
			agg(Object.assign({ Key: 'Discipline', Kind: 'Terms', Dimensions: [ columnDim('Discipline', 'String',
				{ Via: [ { Rel: rel('LabFormType', 'l3', [ 'IDLabFormType', 'Discipline' ], { Role: 'Lookup' }), On: [ on('p', 'IDLabFormType', 'IDLabFormType') ] } ] }) ] }, tmpBase)),
			agg(Object.assign({ Key: 'Week', Kind: 'DateHistogram', Dimensions: [ dateDim('ReceivedDate', 'week',
				{ Via: [ { Rel: rel('MaterialIntake', 'l4', [ 'IDMaterialIntake', 'ReceivedDate' ], { Role: 'Lookup' }), On: [ on('p', 'IDMaterialIntake', 'IDMaterialIntake') ] } ] }) ] }, tmpBase)),
			agg(Object.assign({ Key: 'Started', Kind: 'ExistsSplit', Dimensions: [ { Kind: 'ExistsFlag', DataType: 'Boolean', IsInteger: true, Scale: 0,
				Pred: exists(rel('LabForm', 'e1', [ 'IDLabForm', 'IDMaterialIntake', 'IDLabFormType' ], { Where: { Field: 'Status', Op: 'NE', Value: 'Complete' }, Stage: 'Allowed' }),
					[ on('p', 'IDMaterialIntake', 'IDMaterialIntake'), on('p', 'IDLabFormType', 'IDLabFormType') ]) } ] }, tmpBase))
		]);
};

/**
 * The direct-SQL ToDoForMe predicate on requirement alias r.
 *
 * @param {number} pTenant
 * @param {number} pUser
 * @param {boolean} pRelaxed - the LabForm hop ignores the owner (TenantOnly)
 * @return {string}
 */
const toDoForMeSQL = (pTenant, pUser, pRelaxed) =>
{
	return `${visible('r', pTenant)}`
		+ ` AND EXISTS (SELECT 1 FROM MaterialIntake i WHERE ${visible('i', pTenant)} AND i.IDMaterialIntake = r.IDMaterialIntake AND i.Status IN ('Received', 'InProgress')`
		+ ` AND EXISTS (SELECT 1 FROM LabQueue q WHERE ${visible('q', pTenant)} AND q.IDLabQueue = i.IDLabQueue`
		+ ` AND EXISTS (SELECT 1 FROM LabQueueMember m WHERE ${visible('m', pTenant)} AND m.IDLabQueue = q.IDLabQueue AND m.IDUser = ${Number(pUser)} AND m.Active = 1)))`
		+ ` AND NOT EXISTS (SELECT 1 FROM LabForm f WHERE ${visible('f', pTenant)}${pRelaxed ? '' : ` AND f.OwnerIDUser = ${Number(pUser)}`} AND f.IDMaterialIntake = r.IDMaterialIntake AND f.IDLabFormType = r.IDLabFormType AND f.Status = 'Complete')`;
};

/**
 * Oracle rows (Key, N) for the E3A Aggs.
 *
 * @param {Record<string, any>} K - the bench (sql)
 * @param {number} pTenant
 * @param {number} pUser
 * @param {boolean} pRelaxed
 * @return {Record<string, Array<{ Key: any, N: number }>>}
 */
const e3aOracle = (K, pTenant, pUser, pRelaxed) =>
{
	let tmpWhere = toDoForMeSQL(pTenant, pUser, pRelaxed);
	let tmpFrom = `FROM MaterialIntakeRequirement r WHERE ${tmpWhere}`;
	return (
		{
			Total: K.sql(`SELECT count(*) AS N ${tmpFrom}`)[0].N,
			ToDo: K.sql(`SELECT r.IDLabFormType AS Key, count(*) AS N ${tmpFrom} GROUP BY r.IDLabFormType`),
			Queue: K.sql(`SELECT q.IDLabQueue AS Key, count(*) AS N FROM MaterialIntakeRequirement r`
				+ ` LEFT JOIN (SELECT * FROM MaterialIntake WHERE ${visible('MaterialIntake', pTenant)}) i ON i.IDMaterialIntake = r.IDMaterialIntake`
				+ ` LEFT JOIN (SELECT * FROM LabQueue WHERE ${visible('LabQueue', pTenant)}) q ON q.IDLabQueue = i.IDLabQueue WHERE ${tmpWhere} GROUP BY q.IDLabQueue`),
			Discipline: K.sql(`SELECT t.Discipline AS Key, count(*) AS N FROM MaterialIntakeRequirement r LEFT JOIN LabFormType t ON t.IDLabFormType = r.IDLabFormType WHERE ${tmpWhere} GROUP BY t.Discipline`),
			Week: K.sql(`SELECT strftime('%Y-%m-%d 00:00:00', i.ReceivedDate, '-6 days', 'weekday 1') AS Key, count(*) AS N FROM MaterialIntakeRequirement r`
				+ ` LEFT JOIN (SELECT * FROM MaterialIntake WHERE ${visible('MaterialIntake', pTenant)}) i ON i.IDMaterialIntake = r.IDMaterialIntake WHERE ${tmpWhere} GROUP BY 1`),
			Started: K.sql(`SELECT CASE WHEN EXISTS (SELECT 1 FROM LabForm f WHERE ${visible('f', pTenant)} AND f.OwnerIDUser = ${Number(pUser)} AND f.IDMaterialIntake = r.IDMaterialIntake AND f.IDLabFormType = r.IDLabFormType AND f.Status <> 'Complete') THEN 1 ELSE 0 END AS Key, count(*) AS N ${tmpFrom} GROUP BY 1`)
		});
};

/**
 * E3B (variant B) TuplePivot Aggs over (MaterialIntake 'p' = i, MaterialTypeFormRequirement 'u1' = r).
 *
 * @param {number} pUser
 * @return {Array<Record<string, any>>}
 */
const e3bAggs = (pUser) =>
{
	let tmpTuple = (
		{
			Sides:
			[
				{ Name: 'i', Alias: 'p', Rel: rel('MaterialIntake', 'p', [ 'IDMaterialIntake', 'IDMaterialType', 'IDLabQueue', 'ReceivedDate' ], { Role: 'TupleSide', Where: { Field: 'Status', Op: 'IN', Value: OPEN_STATUSES } }) },
				{ Name: 'r', Alias: 'u1', Rel: rel('MaterialTypeFormRequirement', 'u1', [ 'IDMaterialTypeFormRequirement', 'IDMaterialType', 'IDLabFormType' ], { Role: 'TupleSide', Where: { Field: 'Required', Op: 'EQ', Value: 1 } }) }
			],
			On: [ { Left: { Alias: 'p', Field: 'IDMaterialType' }, Right: { Alias: 'u1', Field: 'IDMaterialType' } } ],
			Key: [ { Alias: 'p', Field: 'IDMaterialIntake' }, { Alias: 'u1', Field: 'IDLabFormType' } ],
			Names: { i: 'p', r: 'u1' }
		});
	let tmpWhere = and(
		labQueuePath('p', 'j5', 'j6', pUser),
		notExists(rel('LabForm', 'j7', [ 'IDLabForm', 'IDMaterialIntake', 'IDLabFormType' ], { Where: { Field: 'Status', Op: 'EQ', Value: 'Complete' }, Scope: 'TenantOnly', ScopeReason: "Any technician's completed form satisfies the requirement.", Stage: 'Allowed' }),
			[ on('p', 'IDMaterialIntake', 'IDMaterialIntake'), on('u1', 'IDLabFormType', 'IDLabFormType') ]));
	let tmpBase = { Pivot: 'MaterialIntake', Tuple: tmpTuple, Where: tmpWhere, WhereHash: 'wh:formstodo', CountMode: 'KeyDistinct', VariantId: 'v0' };
	return (
		[
			agg(Object.assign({ Key: 'ToDo', Kind: 'Terms', Dimensions: [ columnDim('IDLabFormType', 'Numeric', { Alias: 'u1' }) ] }, tmpBase)),
			agg(Object.assign({ Key: 'Queue', Kind: 'Terms', Dimensions: [ columnDim('IDLabQueue', 'Numeric', { Alias: 'p' }) ] }, tmpBase)),
			agg(Object.assign({ Key: 'Week', Kind: 'DateHistogram', Dimensions: [ dateDim('ReceivedDate', 'week', { Alias: 'p' }) ] }, tmpBase)),
			agg(Object.assign({ Key: 'Total', Kind: 'Count', Dimensions: [] }, tmpBase))
		]);
};

/**
 * Oracle for E3B: distinct (intake, form type) tuples.
 *
 * @param {Record<string, any>} K
 * @param {number} pTenant
 * @param {number} pUser
 * @return {Record<string, any>}
 */
const e3bOracle = (K, pTenant, pUser) =>
{
	let tmpTuples = `SELECT DISTINCT i.IDMaterialIntake AS I, t.IDLabFormType AS F, i.IDLabQueue AS Q, i.ReceivedDate AS D FROM MaterialIntake i JOIN MaterialTypeFormRequirement t ON t.IDMaterialType = i.IDMaterialType`
		+ ` WHERE ${visible('i', pTenant)} AND i.Status IN ('Received', 'InProgress') AND ${visible('t', pTenant)} AND t.Required = 1`
		+ ` AND EXISTS (SELECT 1 FROM LabQueue q WHERE ${visible('q', pTenant)} AND q.IDLabQueue = i.IDLabQueue`
		+ ` AND EXISTS (SELECT 1 FROM LabQueueMember m WHERE ${visible('m', pTenant)} AND m.IDLabQueue = q.IDLabQueue AND m.IDUser = ${Number(pUser)} AND m.Active = 1))`
		+ ` AND NOT EXISTS (SELECT 1 FROM LabForm f WHERE ${visible('f', pTenant)} AND f.IDMaterialIntake = i.IDMaterialIntake AND f.IDLabFormType = t.IDLabFormType AND f.Status = 'Complete')`;
	return (
		{
			Total: K.sql(`SELECT count(*) AS N FROM (${tmpTuples}) x`)[0].N,
			ToDo: K.sql(`SELECT x.F AS Key, count(*) AS N FROM (${tmpTuples}) x GROUP BY x.F`),
			Queue: K.sql(`SELECT x.Q AS Key, count(*) AS N FROM (${tmpTuples}) x GROUP BY x.Q`),
			Week: K.sql(`SELECT strftime('%Y-%m-%d 00:00:00', x.D, '-6 days', 'weekday 1') AS Key, count(*) AS N FROM (${tmpTuples}) x GROUP BY 1`)
		});
};

/**
 * LabTrack coverage Aggs on the MaterialIntake pivot: K9 (ByRequiredForm through the bridge),
 * K9 with a Multi.Where (column predicates on the chain's last relation: the flag path), K12
 * (requirement-count bands), K19 (at least 3 visible requirements), K10 InMyQueues as a filter.
 *
 * @param {number} pUser
 * @return {Record<string, Record<string, any>>}
 */
const labCoverageAggs = (pUser) =>
{
	let tmpChain = () =>
	{
		return (
			[
				{ Rel: rel('MaterialIntakeRequirement', 'm1', [ 'IDMaterialIntakeRequirement', 'IDMaterialIntake', 'IDLabFormType' ], { Role: 'Multi' }), On: [ on('p', 'IDMaterialIntake', 'IDMaterialIntake') ] },
				{ Rel: rel('LabFormType', 'm2', [ 'IDLabFormType', 'Discipline' ], { Role: 'Multi' }), On: [ on('m1', 'IDLabFormType', 'IDLabFormType') ] }
			]);
	};
	return (
		{
			ByRequiredForm: agg({ Key: 'ByRequiredForm', Kind: 'Terms', Pivot: 'MaterialIntake', CountMode: 'PivotDistinct', MultiValued: true, Top: 25,
				Dimensions: [ { Kind: 'Multi', Chain: tmpChain(), Where: null, KeyField: 'IDLabFormType', DataType: 'ID', IsInteger: true, Scale: 0 } ] }),
			ByRequiredChemBio: agg({ Key: 'ByRequiredChemBio', Kind: 'Terms', Pivot: 'MaterialIntake', CountMode: 'PivotDistinct', MultiValued: true, Top: 25,
				Dimensions: [ { Kind: 'Multi', Chain: tmpChain(), KeyField: 'IDLabFormType', DataType: 'ID', IsInteger: true, Scale: 0,
					Where: or(cmp('m2', 'Discipline', 'EQ', 'Chemistry'), cmp('m2', 'Discipline', 'EQ', 'Biology')) } ] }),
			RequirementBands: agg({ Key: 'RequirementBands', Kind: 'ChildRollup', Pivot: 'MaterialIntake', Exclude: 'None',
				Dimensions: [ { Kind: 'ChildAgg', Rel: rel('MaterialIntakeRequirement', 'x1', [ 'IDMaterialIntakeRequirement', 'IDMaterialIntake' ], { Role: 'Child' }), On: [ on('p', 'IDMaterialIntake', 'IDMaterialIntake') ], Where: null, Agg: 'count', Field: null, Edges: [ 1, 2, 4 ], DataType: 'Numeric', IsInteger: true, Scale: 0 } ] }),
			ManyRequirements: agg({ Key: 'ManyRequirements', Kind: 'Count', Pivot: 'MaterialIntake',
				Where: countCmp(rel('MaterialIntakeRequirement', 'j8', [ 'IDMaterialIntakeRequirement', 'IDMaterialIntake' ]), [ on('p', 'IDMaterialIntake', 'IDMaterialIntake') ], null, 'GE', 3), WhereHash: 'wh:many' }),
			InMyQueuesByStatus: agg({ Key: 'InMyQueuesByStatus', Kind: 'Terms', Pivot: 'MaterialIntake', Dimensions: [ columnDim('Status', 'String') ],
				Where: labQueuePath('p', 'j9', 'j10', pUser), WhereHash: 'wh:inmyqueues' })
		});
};

/**
 * Oracles for labCoverageAggs.
 *
 * @param {Record<string, any>} K
 * @param {number} pTenant
 * @param {number} pUser
 * @return {Record<string, any>}
 */
const labCoverageOracle = (K, pTenant, pUser) =>
{
	let tmpIntakes = `FROM MaterialIntake i WHERE ${visible('i', pTenant)}`;
	let tmpPairs = `SELECT DISTINCT r.IDLabFormType AS F, i.IDMaterialIntake AS I FROM MaterialIntake i JOIN MaterialIntakeRequirement r ON r.IDMaterialIntake = i.IDMaterialIntake AND ${visible('r', pTenant)}`
		+ ` JOIN LabFormType t ON t.IDLabFormType = r.IDLabFormType WHERE ${visible('i', pTenant)}`;
	let tmpChemBio = `${tmpPairs} AND t.Discipline IN ('Chemistry', 'Biology')`;
	let tmpCount = `(SELECT count(*) FROM MaterialIntakeRequirement r WHERE ${visible('r', pTenant)} AND r.IDMaterialIntake = i.IDMaterialIntake)`;
	return (
		{
			Intakes: K.sql(`SELECT count(*) AS N ${tmpIntakes}`)[0].N,
			ByRequiredForm: K.sql(`SELECT x.F AS Key, count(*) AS N FROM (${tmpPairs}) x GROUP BY x.F`),
			ByRequiredFormCovered: K.sql(`SELECT count(DISTINCT x.I) AS N FROM (${tmpPairs}) x`)[0].N,
			ByRequiredChemBio: K.sql(`SELECT x.F AS Key, count(*) AS N FROM (${tmpChemBio}) x GROUP BY x.F`),
			ByRequiredChemBioCovered: K.sql(`SELECT count(DISTINCT x.I) AS N FROM (${tmpChemBio}) x`)[0].N,
			RequirementBands: K.sql(`SELECT CASE WHEN ${tmpCount} < 1 THEN 0 WHEN ${tmpCount} < 2 THEN 1 WHEN ${tmpCount} < 4 THEN 2 ELSE 3 END AS Key, count(*) AS N ${tmpIntakes} GROUP BY 1`),
			ManyRequirements: K.sql(`SELECT count(*) AS N ${tmpIntakes} AND ${tmpCount} >= 3`)[0].N,
			InMyQueuesByStatus: K.sql(`SELECT i.Status AS Key, count(*) AS N ${tmpIntakes}`
				+ ` AND EXISTS (SELECT 1 FROM LabQueue q WHERE ${visible('q', pTenant)} AND q.IDLabQueue = i.IDLabQueue`
				+ ` AND EXISTS (SELECT 1 FROM LabQueueMember m WHERE ${visible('m', pTenant)} AND m.IDLabQueue = q.IDLabQueue AND m.IDUser = ${Number(pUser)} AND m.Active = 1)) GROUP BY i.Status`)
		});
};

/**
 * E3A extras: the bucketed folds and a Pivot through Via axes (K8), and a K17 Or of two paths,
 * all on the requirement pivot with W_def = ToDoForMe.
 *
 * @param {number} pUser
 * @return {Array<Record<string, any>>}
 */
const e3aExtraAggs = (pUser) =>
{
	let tmpWhere = toDoForMe(pUser, 'TenantOnly');
	let fQueueVia = (pFirst, pSecond) =>
	{
		return [ { Rel: rel('MaterialIntake', pFirst, [ 'IDMaterialIntake', 'IDLabQueue' ], { Role: 'Lookup' }), On: [ on('p', 'IDMaterialIntake', 'IDMaterialIntake') ] },
		         { Rel: rel('LabQueue', pSecond, [ 'IDLabQueue' ], { Role: 'Lookup' }), On: [ on(pFirst, 'IDLabQueue', 'IDLabQueue') ] } ];
	};
	let tmpBase = { Pivot: 'MaterialIntakeRequirement', Where: tmpWhere, WhereHash: 'wh:todo', VariantId: 'vt' };
	let tmpQueueRanges = [ { Key: 'low', From: null, To: 2, Label: 'Low' }, { Key: 'mid', From: 2, To: 4, Label: 'Mid' }, { Key: 'high', From: 4, To: null, Label: 'High' } ];
	return (
		[
			agg(Object.assign({ Key: 'QueueRanges', Kind: 'Ranges', Dimensions: [ { Kind: 'Range', Field: 'IDLabQueue', Ranges: tmpQueueRanges, DataType: 'ID', IsInteger: true, Scale: 0, Via: fQueueVia('l5', 'l6') } ] }, tmpBase)),
			agg(Object.assign({ Key: 'QueueEdges', Kind: 'NumericHistogram', Dimensions: [ { Kind: 'NumericBucket', Field: 'IDLabQueue', Mode: 'Edges', Edges: [ 1, 2, 3 ], OpenEnded: true, Buckets: null, DataType: 'ID', IsInteger: true, Scale: 0, Via: fQueueVia('l7', 'l8') } ] }, tmpBase)),
			agg(Object.assign({ Key: 'FormByQueue', Kind: 'Pivot', Top: null, Dimensions: [ columnDim('IDLabFormType', 'Numeric'), columnDim('IDLabQueue', 'ID', { Via: fQueueVia('l9', 'l10') }) ] }, tmpBase)),
			// K17: requirements whose intake is in queue 1 OR that any technician has a pending form for
			// (a definition predicate never names a policy column: OwnerIDUser stays the relaxation's).
			agg({ Key: 'AnyPath', Kind: 'Count', Pivot: 'MaterialIntakeRequirement', VariantId: 'v0', WhereHash: 'wh:any',
				Where: or(
					exists(rel('MaterialIntake', 'j11', [ 'IDMaterialIntake' ], { Where: { Field: 'IDLabQueue', Op: 'EQ', Value: 1 }, Stage: 'Allowed' }), [ on('p', 'IDMaterialIntake', 'IDMaterialIntake') ]),
					exists(rel('LabForm', 'j12', [ 'IDLabForm', 'IDMaterialIntake', 'IDLabFormType' ], { Where: { Field: 'Status', Op: 'EQ', Value: 'Pending' }, Scope: 'TenantOnly', ScopeReason: 'test', Stage: 'Allowed' }),
						[ on('p', 'IDMaterialIntake', 'IDMaterialIntake'), on('p', 'IDLabFormType', 'IDLabFormType') ])) })
		]);
};

/**
 * Oracle for e3aExtraAggs.
 *
 * @param {Record<string, any>} K
 * @param {number} pTenant
 * @param {number} pUser
 * @return {Record<string, any>}
 */
const e3aExtraOracle = (K, pTenant, pUser) =>
{
	let tmpWhere = toDoForMeSQL(pTenant, pUser, true);
	let tmpJoin = `FROM MaterialIntakeRequirement r LEFT JOIN (SELECT * FROM MaterialIntake WHERE ${visible('MaterialIntake', pTenant)}) i ON i.IDMaterialIntake = r.IDMaterialIntake`
		+ ` LEFT JOIN (SELECT * FROM LabQueue WHERE ${visible('LabQueue', pTenant)}) q ON q.IDLabQueue = i.IDLabQueue WHERE ${tmpWhere}`;
	return (
		{
			QueueRanges: K.sql(`SELECT CASE WHEN q.IDLabQueue IS NULL THEN NULL WHEN q.IDLabQueue < 2 THEN 'low' WHEN q.IDLabQueue < 4 THEN 'mid' ELSE 'high' END AS Key, count(*) AS N ${tmpJoin} GROUP BY 1`),
			QueueEdgesMissing: K.sql(`SELECT count(*) AS N ${tmpJoin} AND q.IDLabQueue IS NULL`)[0].N,
			QueueEdges: K.sql(`SELECT CASE WHEN q.IDLabQueue < 2 THEN 0 WHEN q.IDLabQueue < 3 THEN 1 ELSE 2 END AS Key, count(*) AS N ${tmpJoin} AND q.IDLabQueue IS NOT NULL AND q.IDLabQueue >= 1 GROUP BY 1`),
			FormByQueue: K.sql(`SELECT r.IDLabFormType AS K1, q.IDLabQueue AS K2, count(*) AS N ${tmpJoin} GROUP BY 1, 2`),
			AnyPath: K.sql(`SELECT count(*) AS N FROM MaterialIntakeRequirement r WHERE ${visible('r', pTenant)} AND (EXISTS (SELECT 1 FROM MaterialIntake i WHERE ${visible('i', pTenant)} AND i.IDMaterialIntake = r.IDMaterialIntake AND i.IDLabQueue = 1)`
				+ ` OR EXISTS (SELECT 1 FROM LabForm f WHERE ${visible('f', pTenant)} AND f.IDMaterialIntake = r.IDMaterialIntake AND f.IDLabFormType = r.IDLabFormType AND f.Status = 'Pending'))`)[0].N
		});
};

// ================================================================== ProjectTrack

const PROJECT_NOW = '2026-10-08 12:00:00';

/**
 * The E1 conjuncts lowered (08 §2.3): c1 Status IN, c2 the Client join clause (Path), c3 the
 * StartDate range, c4 MyProjects (Or[Exists membership, Cmp owner]), c5 HasMyOverdue, c6 Unblocked.
 *
 * @param {number} pUser
 * @param {Array<number>} pClientIDs
 * @return {Record<string, any>}
 */
const e1Conjuncts = (pUser, pClientIDs) =>
{
	let tmpC2 = exists(rel('Client', 'h1', [ 'IDClient' ], { Where: { Field: 'IDClient', Op: 'IN', Value: pClientIDs } }), [ on('p', 'IDClient', 'IDClient') ]);
	let tmpC4 = or(
		exists(rel('ProjectMembership', 'h2', [ 'IDProjectMembership', 'IDProject' ], { Where: { And: [ { Field: 'IDUser', Op: 'EQ', Value: pUser }, { Field: 'Role', Op: 'IN', Value: [ 'Owner', 'Lead' ] }, { Field: 'Active', Op: 'EQ', Value: 1 } ] }, Stage: 'Allowed' }), [ on('p', 'IDProject', 'IDProject') ]),
		cmp('p', 'OwnerIDUser', 'EQ', pUser));
	let tmpC5 = exists(rel('Task', 'h3', [ 'IDTask', 'IDProject' ], { Where: { And: [ { Field: 'AssignedIDUser', Op: 'EQ', Value: pUser }, { Field: 'DueDate', Op: 'LT', Value: PROJECT_NOW }, { Field: 'Status', Op: 'NE', Value: 'Done' } ] }, Stage: 'Allowed' }), [ on('p', 'IDProject', 'IDProject') ]);
	let tmpC6 = notExists(rel('Issue', 'h4', [ 'IDIssue', 'IDProject' ], { Where: { And: [ { Field: 'Severity', Op: 'EQ', Value: 'Blocker' }, { Field: 'State', Op: 'EQ', Value: 'Open' } ] }, Stage: 'Allowed' }), [ on('p', 'IDProject', 'IDProject') ]);
	return (
		{
			c1: conjunct('c1', { Field: 'Status', Op: 'IN', Value: [ 'Active', 'AtRisk' ] }, { Fields: [ 'Status' ], Origin: { Kind: 'Clause', Hash: 'Status-DSVL-1', FilterKey: 'Status', ClauseType: 'DistinctSelectedValueList', Index: 0 } }),
			c2: conjunct('c2', { Exists: { Path: null } }, { Shape: 'Path', FoldPred: tmpC2, Fields: [ 'IDClient' ], Entities: [ 'Client' ], Origin: { Kind: 'Join', Hash: 'IDClient-IJ-1', FilterKey: 'IDClient', ClauseType: 'InternalJoinSelectedValueList', Index: 1 } }),
			c3: conjunct('c3', { And: [ { Field: 'StartDate', Op: 'GE', Value: '2024-06-01' }, { Field: 'StartDate', Op: 'LT', Value: '2027-01-01' } ] }, { Fields: [ 'StartDate' ], Origin: { Kind: 'Clause', Hash: 'StartDate-DR-1', FilterKey: 'StartDate', ClauseType: 'DateRange', Index: 2 } }),
			c4: conjunct('c4', { Or: [] }, { Shape: 'Path', FoldPred: tmpC4, NeverExclude: true, Fields: [ '@scope:Project.MyProjects' ], Entities: [ 'ProjectMembership' ], Origin: { Kind: 'Scope', Scope: 'Project.MyProjects', Hash: null, FilterKey: null, ClauseType: null, Index: 3 } }),
			c5: conjunct('c5', { Exists: {} }, { Shape: 'Path', FoldPred: tmpC5, NeverExclude: true, Fields: [ '@scope:Project.HasMyOverdue' ], Entities: [ 'Task' ], Origin: { Kind: 'Scope', Scope: 'Project.HasMyOverdue', Hash: null, FilterKey: null, ClauseType: null, Index: 4 } }),
			c6: conjunct('c6', { NotExists: {} }, { Shape: 'Path', FoldPred: tmpC6, NeverExclude: true, Fields: [ '@scope:Project.Unblocked' ], Entities: [ 'Issue' ], Origin: { Kind: 'Scope', Scope: 'Project.Unblocked', Hash: null, FilterKey: null, ClauseType: null, Index: 5 } })
		});
};

/**
 * The E1 plan: Variants (v0 full; v1 Status excludes c1; v2 Client excludes c2; v3 Started excludes
 * c3), the Aggs and the CubePlan of §25.2.
 *
 * @param {number} pUser
 * @param {Array<number>} pClientIDs
 * @return {{ Variants: Record<string, any>, Aggs: Array<Record<string, any>>, Cube: Record<string, any>, Conjuncts: Record<string, any> }}
 */
const e1Plan = (pUser, pClientIDs) =>
{
	let C = e1Conjuncts(pUser, pClientIDs);
	let fPath = (pIds) => { let tmpPreds = pIds.map((pId) => { return C[pId].FoldPred; }); return (tmpPreds.length === 1) ? tmpPreds[0] : and(...tmpPreds); };
	let tmpVariants = (
		{
			v0: variant('v0', 'Project', [ C.c1, C.c2, C.c3, C.c4, C.c5, C.c6 ], fPath([ 'c2', 'c4', 'c5', 'c6' ])),
			v1: variant('v1', 'Project', [ C.c2, C.c3, C.c4, C.c5, C.c6 ], fPath([ 'c2', 'c4', 'c5', 'c6' ])),
			v2: variant('v2', 'Project', [ C.c1, C.c3, C.c4, C.c5, C.c6 ], fPath([ 'c4', 'c5', 'c6' ])),
			v3: variant('v3', 'Project', [ C.c1, C.c2, C.c4, C.c5, C.c6 ], fPath([ 'c2', 'c4', 'c5', 'c6' ]))
		});
	let tmpBand = { Kind: 'ChildAgg', Rel: rel('Task', 'x1', [ 'IDTask', 'IDProject' ], { Role: 'Child', Where: { And: [ { Field: 'AssignedIDUser', Op: 'EQ', Value: pUser }, { Field: 'DueDate', Op: 'LT', Value: PROJECT_NOW }, { Field: 'Status', Op: 'NE', Value: 'Done' } ] } }),
		On: [ on('p', 'IDProject', 'IDProject') ], Where: null, Agg: 'count', Field: null, Edges: [ 1, 3, 10 ], DataType: 'Numeric', IsInteger: true, Scale: 0 };
	let tmpAggs = (
		[
			agg({ Key: '#Total', Kind: 'Count', Pivot: 'Project', VariantId: 'v0', Origin: 'Auto' }),
			agg({ Key: 'Status', Kind: 'Terms', Pivot: 'Project', VariantId: 'v1', Exclude: 'Self', Top: 10, Origin: 'Auto', SelectedKeys: [ 'Active', 'AtRisk' ], Dimensions: [ columnDim('Status', 'String') ] }),
			agg({ Key: 'Client', Kind: 'Terms', Pivot: 'Project', VariantId: 'v2', Exclude: 'Self', Top: 20, Origin: 'Auto', SelectedKeys: pClientIDs.slice(), Dimensions: [ columnDim('IDClient', 'Numeric') ] }),
			agg({ Key: 'Started', Kind: 'DateHistogram', Pivot: 'Project', VariantId: 'v3', Exclude: 'Self', Origin: 'Auto', Dimensions: [ dateDim('StartDate', 'month') ] }),
			agg({ Key: 'MyOverdue', Kind: 'ChildRollup', Pivot: 'Project', VariantId: 'v0', Dimensions: [ tmpBand ] }),
			agg({ Key: 'StatusByClient', Kind: 'Pivot', Pivot: 'Project', VariantId: 'v0', Origin: 'Auto', Top: null, Dimensions: [ columnDim('Status', 'String'), columnDim('IDClient', 'Numeric') ] })
		]);
	let tmpCube = (
		{
			CubeId: 'cube0',
			Pivot: 'Project',
			Flags: [ { Flag: 'b1', ConjunctId: 'c1' }, { Flag: 'b2', ConjunctId: 'c2' }, { Flag: 'b3', ConjunctId: 'c3' } ],
			Common: [ 'c4', 'c5', 'c6' ],
			WhereFlags: [],
			Dims:
			[
				{ Column: 'd1', Dim: columnDim('Status', 'String'), Members: [ 'Status', 'StatusByClient' ] },
				{ Column: 'd2', Dim: columnDim('IDClient', 'Numeric'), Members: [ 'Client', 'StatusByClient' ] },
				{ Column: 'd3', Dim: dateDim('StartDate', 'month'), Members: [ 'Started' ] },
				{ Column: 'd4', Dim: tmpBand, Members: [ 'MyOverdue' ] }
			],
			Bounds: [ { Lo: 'lo3', Hi: 'hi3', Dim: 'd3' } ],
			Members:
			[
				{ AggKey: '#Total', Dims: [], RequireFlags: [ 'b1', 'b2', 'b3' ], RequireWhere: null },
				{ AggKey: 'Status', Dims: [ 'd1' ], RequireFlags: [ 'b2', 'b3' ], RequireWhere: null },
				{ AggKey: 'Client', Dims: [ 'd2' ], RequireFlags: [ 'b1', 'b3' ], RequireWhere: null },
				{ AggKey: 'Started', Dims: [ 'd3' ], RequireFlags: [ 'b1', 'b2' ], RequireWhere: null },
				{ AggKey: 'MyOverdue', Dims: [ 'd4' ], RequireFlags: [ 'b1', 'b2', 'b3' ], RequireWhere: null },
				{ AggKey: 'StatusByClient', Dims: [ 'd1', 'd2' ], RequireFlags: [ 'b1', 'b2', 'b3' ], RequireWhere: null }
			],
			MaxGroups: 100000
		});
	tmpAggs.forEach((pAgg) => { pAgg.CubeId = 'cube0'; });
	return { Variants: tmpVariants, Aggs: tmpAggs, Cube: tmpCube, Conjuncts: C };
};

/**
 * Direct-SQL pieces of E1 on project alias pr.
 *
 * @param {number} pTenant
 * @param {number} pUser
 * @param {Array<number>} pClientIDs
 * @return {Record<string, string>}
 */
const e1SQL = (pTenant, pUser, pClientIDs) =>
{
	return (
		{
			base: visible('pr', pTenant),
			c1: `pr.Status IN ('Active', 'AtRisk')`,
			c2: `EXISTS (SELECT 1 FROM Client c WHERE ${visible('c', pTenant)} AND c.IDClient = pr.IDClient AND c.IDClient IN (${pClientIDs.map(Number).join(', ')}))`,
			c3: `pr.StartDate >= '2024-06-01' AND pr.StartDate < '2027-01-01'`,
			c4: `(EXISTS (SELECT 1 FROM ProjectMembership pm WHERE ${visible('pm', pTenant)} AND pm.IDProject = pr.IDProject AND pm.IDUser = ${Number(pUser)} AND pm.Role IN ('Owner', 'Lead') AND pm.Active = 1) OR pr.OwnerIDUser = ${Number(pUser)})`,
			c5: `EXISTS (SELECT 1 FROM Task t WHERE ${visible('t', pTenant)} AND t.IDProject = pr.IDProject AND t.AssignedIDUser = ${Number(pUser)} AND t.DueDate < '${PROJECT_NOW}' AND t.Status <> 'Done')`,
			c6: `NOT EXISTS (SELECT 1 FROM Issue s WHERE ${visible('s', pTenant)} AND s.IDProject = pr.IDProject AND s.Severity = 'Blocker' AND s.State = 'Open')`,
			band: `(SELECT count(*) FROM Task t WHERE ${visible('t', pTenant)} AND t.IDProject = pr.IDProject AND t.AssignedIDUser = ${Number(pUser)} AND t.DueDate < '${PROJECT_NOW}' AND t.Status <> 'Done')`
		});
};

/**
 * Oracle answers for every E1 Agg.
 *
 * @param {Record<string, any>} K
 * @param {number} pTenant
 * @param {number} pUser
 * @param {Array<number>} pClientIDs
 * @return {Record<string, any>}
 */
const e1Oracle = (K, pTenant, pUser, pClientIDs) =>
{
	let S = e1SQL(pTenant, pUser, pClientIDs);
	let fWhere = (pParts) => { return [ S.base ].concat(pParts.map((pPart) => { return S[pPart]; })).join(' AND '); };
	let tmpAll = fWhere([ 'c1', 'c2', 'c3', 'c4', 'c5', 'c6' ]);
	return (
		{
			Total: K.sql(`SELECT count(*) AS N FROM Project pr WHERE ${tmpAll}`)[0].N,
			Status: K.sql(`SELECT pr.Status AS Key, count(*) AS N FROM Project pr WHERE ${fWhere([ 'c2', 'c3', 'c4', 'c5', 'c6' ])} GROUP BY pr.Status`),
			Client: K.sql(`SELECT pr.IDClient AS Key, count(*) AS N FROM Project pr WHERE ${fWhere([ 'c1', 'c3', 'c4', 'c5', 'c6' ])} GROUP BY pr.IDClient`),
			Started: K.sql(`SELECT strftime('%Y-%m-01 00:00:00', pr.StartDate) AS Key, count(*) AS N FROM Project pr WHERE ${fWhere([ 'c1', 'c2', 'c4', 'c5', 'c6' ])} GROUP BY 1`),
			MyOverdue: K.sql(`SELECT CASE WHEN ${S.band} < 1 THEN 0 WHEN ${S.band} < 3 THEN 1 WHEN ${S.band} < 10 THEN 2 ELSE 3 END AS Key, count(*) AS N FROM Project pr WHERE ${tmpAll} GROUP BY 1`),
			StatusByClient: K.sql(`SELECT pr.Status AS K1, pr.IDClient AS K2, count(*) AS N FROM Project pr WHERE ${tmpAll} GROUP BY pr.Status, pr.IDClient`),
			Keys: K.sql(`SELECT pr.IDProject AS Key FROM Project pr WHERE ${tmpAll} ORDER BY CASE WHEN pr.StartDate IS NULL THEN 1 ELSE 0 END, pr.StartDate DESC, pr.IDProject ASC`).map((pRow) => { return pRow.Key; })
		});
};

/**
 * ProjectTrack coverage Aggs: E2 on Document, K8 two hops, K10 two hops, K9 ByMember, K20
 * HasOpenIssues, K19 ManyOverdue.
 *
 * @param {number} pUser
 * @param {number} pFormTypeID
 * @return {Record<string, any>}
 */
const projectCoverage = (pUser, pFormTypeID) =>
{
	let tmpE2c1 = conjunct('c1', { Exists: {} }, { Shape: 'Path', Fields: [ 'IDFormType' ], Entities: [ 'FormType' ], Origin: { Kind: 'Join', Hash: 'IDFormType-IJ-1', FilterKey: 'IDFormType', ClauseType: 'InternalJoinSelectedValueList', Index: 0 },
		FoldPred: exists(rel('FormType', 'h1', [ 'IDFormType' ], { Where: { Field: 'IDFormType', Op: 'IN', Value: [ pFormTypeID ] }, Stage: 'Allowed' }), [ on('p', 'IDFormType', 'IDFormType') ]) });
	let tmpE2c2 = conjunct('c2', { And: [ { Field: 'DocumentDate', Op: 'GE', Value: '2025-03-01' }, { Field: 'DocumentDate', Op: 'LT', Value: '2026-07-01' } ] }, { Fields: [ 'DocumentDate' ], Origin: { Kind: 'Clause', Hash: 'DocumentDate-DR-1', FilterKey: 'DocumentDate', ClauseType: 'DateRange', Index: 1 } });
	let tmpVariants = (
		{
			v0: variant('v0', 'Document', [ tmpE2c1, tmpE2c2 ], tmpE2c1.FoldPred),
			v1: variant('v1', 'Document', [ tmpE2c1 ], tmpE2c1.FoldPred),
			v2: variant('v2', 'Document', [ tmpE2c2 ], null)
		});
	let tmpMyProjects = exists(rel('Project', 'j1', [ 'IDProject' ]), [ on('p', 'IDProject', 'IDProject') ],
		exists(rel('ProjectMembership', 'j2', [ 'IDProjectMembership', 'IDProject' ], { Where: { And: [ { Field: 'IDUser', Op: 'EQ', Value: pUser }, { Field: 'Active', Op: 'EQ', Value: 1 } ] }, Stage: 'Allowed' }), [ on('j1', 'IDProject', 'IDProject') ]));
	return (
		{
			E2Variants: tmpVariants,
			E2Aggs:
			[
				agg({ Key: '#Total', Kind: 'Count', Pivot: 'Document', VariantId: 'v0', Origin: 'Auto' }),
				agg({ Key: 'ByMonth', Kind: 'DateHistogram', Pivot: 'Document', VariantId: 'v1', Origin: 'Auto', Dimensions: [ dateDim('DocumentDate', 'month') ] }),
				agg({ Key: 'ByForm', Kind: 'Terms', Pivot: 'Document', VariantId: 'v2', Origin: 'Auto', Top: 20, SelectedKeys: [ pFormTypeID ], Dimensions: [ columnDim('IDFormType', 'Numeric') ] }),
				agg({ Key: 'Status', Kind: 'Terms', Pivot: 'Document', VariantId: 'v0', Origin: 'Auto', Dimensions: [ columnDim('Status', 'String') ] })
			],
			ByClient: agg({ Key: 'ByClient', Kind: 'Terms', Pivot: 'Document', Dimensions: [ columnDim('Name', 'String',
				{ Via: [ { Rel: rel('Project', 'l1', [ 'IDProject', 'IDClient' ], { Role: 'Lookup' }), On: [ on('p', 'IDProject', 'IDProject') ] },
				         { Rel: rel('Client', 'l2', [ 'IDClient', 'Name' ], { Role: 'Lookup' }), On: [ on('l1', 'IDClient', 'IDClient') ] } ] }) ] }),
			InMyProjects: agg({ Key: 'InMyProjects', Kind: 'Terms', Pivot: 'Document', Dimensions: [ columnDim('Status', 'String') ], Where: tmpMyProjects, WhereHash: 'wh:inmyprojects' }),
			ByMember: agg({ Key: 'ByMember', Kind: 'Terms', Pivot: 'Project', CountMode: 'PivotDistinct', MultiValued: true, Top: 50,
				Dimensions: [ { Kind: 'Multi', KeyField: 'IDUser', DataType: 'ID', IsInteger: true, Scale: 0, Where: null,
					Chain: [ { Rel: rel('ProjectMembership', 'm1', [ 'IDProjectMembership', 'IDProject', 'IDUser' ], { Role: 'Multi', Where: { Field: 'Active', Op: 'EQ', Value: 1 } }), On: [ on('p', 'IDProject', 'IDProject') ] },
					         { Rel: rel('User', 'm2', [ 'IDUser' ], { Role: 'Multi' }), On: [ on('m1', 'IDUser', 'IDUser') ] } ] } ] }),
			HasOpenIssues: agg({ Key: 'HasOpenIssues', Kind: 'ExistsSplit', Pivot: 'Project', Exclude: 'None', Dimensions: [ { Kind: 'ExistsFlag', DataType: 'Boolean', IsInteger: true, Scale: 0,
				Pred: exists(rel('Issue', 'e1', [ 'IDIssue', 'IDProject' ], { Where: { Field: 'State', Op: 'EQ', Value: 'Open' }, Stage: 'Allowed' }), [ on('p', 'IDProject', 'IDProject') ]) } ] }),
			ManyOverdue: agg({ Key: 'ManyOverdue', Kind: 'Terms', Pivot: 'Project', Dimensions: [ columnDim('Status', 'String') ],
				Where: countCmp(rel('Task', 'j3', [ 'IDTask', 'IDProject' ], { Where: { And: [ { Field: 'AssignedIDUser', Op: 'EQ', Value: pUser }, { Field: 'DueDate', Op: 'LT', Value: PROJECT_NOW }, { Field: 'Status', Op: 'NE', Value: 'Done' } ] } }), [ on('p', 'IDProject', 'IDProject') ], null, 'GE', 3), WhereHash: 'wh:manyoverdue' })
		});
};

/**
 * Oracles for projectCoverage.
 *
 * @param {Record<string, any>} K
 * @param {number} pTenant
 * @param {number} pUser
 * @param {number} pFormTypeID
 * @return {Record<string, any>}
 */
const projectCoverageOracle = (K, pTenant, pUser, pFormTypeID) =>
{
	let tmpC1 = `EXISTS (SELECT 1 FROM FormType f WHERE f.IDFormType = d.IDFormType AND f.IDFormType IN (${Number(pFormTypeID)}))`;
	let tmpC2 = `d.DocumentDate >= '2025-03-01' AND d.DocumentDate < '2026-07-01'`;
	let tmpDocs = `FROM Document d WHERE ${visible('d', pTenant)}`;
	let tmpPairs = `SELECT DISTINCT m.IDUser AS U, pr.IDProject AS P FROM Project pr JOIN ProjectMembership m ON m.IDProject = pr.IDProject AND ${visible('m', pTenant)} AND m.Active = 1`
		+ ` JOIN User u ON u.IDUser = m.IDUser AND ${visible('u', pTenant)} WHERE ${visible('pr', pTenant)}`;
	let tmpOverdue = `(SELECT count(*) FROM Task t WHERE ${visible('t', pTenant)} AND t.IDProject = pr.IDProject AND t.AssignedIDUser = ${Number(pUser)} AND t.DueDate < '${PROJECT_NOW}' AND t.Status <> 'Done')`;
	return (
		{
			E2:
			{
				Total: K.sql(`SELECT count(*) AS N ${tmpDocs} AND ${tmpC1} AND ${tmpC2}`)[0].N,
				ByMonth: K.sql(`SELECT strftime('%Y-%m-01 00:00:00', d.DocumentDate) AS Key, count(*) AS N ${tmpDocs} AND ${tmpC1} GROUP BY 1`),
				ByForm: K.sql(`SELECT d.IDFormType AS Key, count(*) AS N ${tmpDocs} AND ${tmpC2} GROUP BY d.IDFormType`),
				Status: K.sql(`SELECT d.Status AS Key, count(*) AS N ${tmpDocs} AND ${tmpC1} AND ${tmpC2} GROUP BY d.Status`)
			},
			ByClient: K.sql(`SELECT c.Name AS Key, count(*) AS N FROM Document d LEFT JOIN (SELECT * FROM Project WHERE ${visible('Project', pTenant)}) pr ON pr.IDProject = d.IDProject`
				+ ` LEFT JOIN (SELECT * FROM Client WHERE ${visible('Client', pTenant)}) c ON c.IDClient = pr.IDClient WHERE ${visible('d', pTenant)} GROUP BY c.Name`),
			InMyProjects: K.sql(`SELECT d.Status AS Key, count(*) AS N ${tmpDocs} AND EXISTS (SELECT 1 FROM Project pr WHERE ${visible('pr', pTenant)} AND pr.IDProject = d.IDProject`
				+ ` AND EXISTS (SELECT 1 FROM ProjectMembership m WHERE ${visible('m', pTenant)} AND m.IDProject = pr.IDProject AND m.IDUser = ${Number(pUser)} AND m.Active = 1)) GROUP BY d.Status`),
			Projects: K.sql(`SELECT count(*) AS N FROM Project pr WHERE ${visible('pr', pTenant)}`)[0].N,
			ByMember: K.sql(`SELECT x.U AS Key, count(*) AS N FROM (${tmpPairs}) x GROUP BY x.U`),
			ByMemberCovered: K.sql(`SELECT count(DISTINCT x.P) AS N FROM (${tmpPairs}) x`)[0].N,
			HasOpenIssues: K.sql(`SELECT CASE WHEN EXISTS (SELECT 1 FROM Issue s WHERE ${visible('s', pTenant)} AND s.IDProject = pr.IDProject AND s.State = 'Open') THEN 1 ELSE 0 END AS Key, count(*) AS N FROM Project pr WHERE ${visible('pr', pTenant)} GROUP BY 1`),
			ManyOverdue: K.sql(`SELECT pr.Status AS Key, count(*) AS N FROM Project pr WHERE ${visible('pr', pTenant)} AND ${tmpOverdue} >= 3 GROUP BY pr.Status`)
		});
};

// ------------------------------------------------------------------ cube plans

// Kinds a cube may answer (§25.1).
const CUBE_KINDS = [ 'Count', 'Terms', 'DateHistogram', 'NumericHistogram', 'Ranges', 'Pivot', 'ChildRollup', 'ExistsSplit' ];

/**
 * The CubePlan (§25.2) the Planner forms for one pivot, built here from the Aggs and Variants so the
 * O5 tests can force a cube over every fixture: members = the eligible Aggs; Flags = every conjunct
 * some member excludes (conjunct order); Common = the rest of v0; one WhereFlag per distinct
 * non-empty WhereHash; Dims de-duplicated by canonical JSON; RequireFlags = Flags minus the member's
 * own exclusions.
 *
 * @param {string} pCubeId
 * @param {string} pPivot
 * @param {Array<Record<string, any>>} pAggs
 * @param {Record<string, any>} pVariants - v0 is the full filter
 * @return {Record<string, any>|null} null when no Agg is eligible
 */
const cubePlanFor = (pCubeId, pPivot, pAggs, pVariants) =>
{
	let tmpFull = pVariants.v0.ConjunctIds;
	let tmpMembers = pAggs.filter(
		(pAgg) =>
		{
			let tmpVariant = pVariants[pAgg.VariantId || 'v0'];
			let tmpDimensions = pAgg.Dimensions || [];
			if ((pAgg.Pivot !== pPivot) || pAgg.Tuple || pAgg.MultiValued || (CUBE_KINDS.indexOf(pAgg.Kind) < 0) || !tmpVariant || tmpVariant.IncludesDeleted)
			{
				return false;
			}
			if (tmpDimensions.some((pDimension) => { return pDimension.Kind === 'Multi'; }))
			{
				return false;
			}
			return (pAgg.Kind !== 'NumericHistogram') || (tmpDimensions[0].Mode === 'Edges');
		});
	if (tmpMembers.length < 1)
	{
		return null;
	}
	let fExcluded = (pAgg) => { let tmpKept = pVariants[pAgg.VariantId || 'v0'].ConjunctIds; return tmpFull.filter((pId) => { return tmpKept.indexOf(pId) < 0; }); };
	let tmpFlagIds = tmpFull.filter((pId) => { return tmpMembers.some((pAgg) => { return fExcluded(pAgg).indexOf(pId) >= 0; }); });
	let tmpFlags = tmpFlagIds.map((pId, pIndex) => { return { Flag: `b${pIndex + 1}`, ConjunctId: pId }; });
	let tmpWhereFlags = [];
	let tmpDims = [];
	let tmpPlanMembers = tmpMembers.map(
		(pAgg) =>
		{
			let tmpWhereFlag = null;
			if (pAgg.WhereHash)
			{
				let tmpExisting = tmpWhereFlags.find((pFlag) => { return pFlag.WhereHash === pAgg.WhereHash; });
				if (!tmpExisting)
				{
					tmpExisting = { Flag: `w${tmpWhereFlags.length + 1}`, WhereHash: pAgg.WhereHash, Where: pAgg.Where };
					tmpWhereFlags.push(tmpExisting);
				}
				tmpWhereFlag = tmpExisting.Flag;
			}
			let tmpDimColumns = (pAgg.Dimensions || []).map(
				(pDimension) =>
				{
					let tmpSignature = JSON.stringify(pDimension);
					let tmpExisting = tmpDims.find((pDim) => { return JSON.stringify(pDim.Dim) === tmpSignature; });
					if (!tmpExisting)
					{
						tmpExisting = { Column: `d${tmpDims.length + 1}`, Dim: pDimension, Members: [] };
						tmpDims.push(tmpExisting);
					}
					tmpExisting.Members.push(pAgg.Key);
					return tmpExisting.Column;
				});
			let tmpExcluded = fExcluded(pAgg);
			return { AggKey: pAgg.Key, Dims: tmpDimColumns, RequireFlags: tmpFlags.filter((pFlag) => { return tmpExcluded.indexOf(pFlag.ConjunctId) < 0; }).map((pFlag) => { return pFlag.Flag; }), RequireWhere: tmpWhereFlag };
		});
	return (
		{
			CubeId: pCubeId,
			Pivot: pPivot,
			Flags: tmpFlags,
			Common: tmpFull.filter((pId) => { return tmpFlagIds.indexOf(pId) < 0; }),
			WhereFlags: tmpWhereFlags,
			Dims: tmpDims,
			Members: tmpPlanMembers,
			MemberAggs: tmpMembers,
			MaxGroups: 100000
		});
};

// ------------------------------------------------------------------ comparison helpers

/**
 * Raw Groups as a sorted [ [ key, count ] ] list (keys stringified for a stable comparison).
 *
 * @param {Array<{ Key: any, Count: number }>} pGroups
 * @return {Array<Array<any>>}
 */
const groupList = (pGroups) =>
{
	return (pGroups || []).map((pGroup) => { return [ (pGroup.Key === null) ? null : String(pGroup.Key), pGroup.Count ]; })
		.sort((pA, pB) => { return String(pA[0]).localeCompare(String(pB[0])); });
};

/**
 * Oracle rows ({ Key, N }) as a groupList, NULL keys removed (they are MissingCount).
 *
 * @param {Array<{ Key: any, N: number }>} pRows
 * @return {Array<Array<any>>}
 */
const oracleList = (pRows) =>
{
	return groupList(pRows.filter((pRow) => { return pRow.Key !== null; }).map((pRow) => { return { Key: pRow.Key, Count: pRow.N }; }));
};

/**
 * The NULL-key count of oracle rows.
 *
 * @param {Array<{ Key: any, N: number }>} pRows
 * @return {number}
 */
const oracleMissing = (pRows) =>
{
	return pRows.filter((pRow) => { return pRow.Key === null; }).reduce((pSum, pRow) => { return pSum + pRow.N; }, 0);
};

/**
 * The sum of oracle counts.
 *
 * @param {Array<{ N: number }>} pRows
 * @return {number}
 */
const oracleTotal = (pRows) =>
{
	return pRows.reduce((pSum, pRow) => { return pSum + pRow.N; }, 0);
};

/**
 * A RawFacetResult normalized for an O5 comparison (groups and cells sorted).
 *
 * @param {Record<string, any>} pRaw
 * @return {Record<string, any>}
 */
const normalizeRaw = (pRaw) =>
{
	if (!pRaw)
	{
		return pRaw;
	}
	let tmpCopy = JSON.parse(JSON.stringify(pRaw));
	tmpCopy.Groups = groupList(tmpCopy.Groups);
	if (Array.isArray(tmpCopy.Cells))
	{
		tmpCopy.Cells = tmpCopy.Cells.map((pCell) => { return [ JSON.stringify(pCell.Keys), pCell.Count ]; }).sort((pA, pB) => { return pA[0].localeCompare(pB[0]); });
	}
	return tmpCopy;
};

module.exports = (
	{
		rel: rel, on: on, exists: exists, notExists: notExists, countCmp: countCmp, and: and, or: or, cmp: cmp,
		agg: agg, variant: variant, conjunct: conjunct, columnDim: columnDim, dateDim: dateDim,
		visible: visible,
		LAB_TEST_NOW: LAB_TEST_NOW, PROJECT_NOW: PROJECT_NOW, OPEN_STATUSES: OPEN_STATUSES,
		labQueuePath: labQueuePath, toDoForMe: toDoForMe, toDoForMeSQL: toDoForMeSQL, e3aAggs: e3aAggs, e3aOracle: e3aOracle,
		e3aExtraAggs: e3aExtraAggs, e3aExtraOracle: e3aExtraOracle,
		e3bAggs: e3bAggs, e3bOracle: e3bOracle, labCoverageAggs: labCoverageAggs, labCoverageOracle: labCoverageOracle,
		e1Conjuncts: e1Conjuncts, e1Plan: e1Plan, e1SQL: e1SQL, e1Oracle: e1Oracle,
		projectCoverage: projectCoverage, projectCoverageOracle: projectCoverageOracle,
		CUBE_KINDS: CUBE_KINDS, cubePlanFor: cubePlanFor,
		groupList: groupList, oracleList: oracleList, oracleMissing: oracleMissing, oracleTotal: oracleTotal, normalizeRaw: normalizeRaw
	});
