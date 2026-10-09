/**
 * Facet-Reference-M2 tests (internal-contracts §31, §32, §34 — builder D):
 *
 *   1. The ProjectTrack and LabTrack fixtures: determinism, sizes, two tenants, and every story row
 *      the motivating queries depend on (checked on the generated rows and with SQL on the built
 *      database).
 *   2. The M2 harness on both domains: principals, the domain tenancy and owner behaviors on the
 *      lists, auto facets Live == Reference (O1) and O2 through the list, FK label isolation.
 *   3. The Reference engine across entities, driven with HAND-BUILT FoldIR (§24, independent of the
 *      Planner): E1, E3 variant A, E3 variant B and the coverage kinds (K8 multi-hop, K9, K10 two
 *      hops, K11 composite, K12, K18, K19, K20, CheckParent), each against hand-written SQL over the
 *      fixture database (O-hand); TenantOnly relaxation and its refusals; owner scope; cross-tenant
 *      references; the Records / Count / Keys oracle helpers.
 *   4. End to end through the real pipeline (registry → binder → planner → Live / Reference):
 *      O1, O-hand, O2 and two-tenant isolation for E1, E2, E3A and E3B as every principal of the
 *      domain.  These run once the M2 pipeline is wired (the probe names what is missing) and are
 *      reported pending until then.
 *
 * Port 19124 (internal-contracts §32.4); every harness binds an ephemeral port.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const { DatabaseSync } = require('node:sqlite');

const libFable = require('fable');

const libHarness = require('./support/Facet-Test-Harness.js');
const libProjectTrackSeed = require('./fixtures/ProjectTrack-Seed.js');
const libLabTrackSeed = require('./fixtures/LabTrack-Seed.js');
const libBookstoreSeed = require('./fixtures/Bookstore-Seed.js');
const libRetoldFacetingGraph = require('../source/catalog/Retold-Faceting-Graph.js');
const libRetoldFacetingEngineReference = require('../source/engine/Retold-Faceting-EngineReference.js');
const libFacetEnvelope = require('../source/contract/Facet-Contract-Envelope.js');

const PORT = 19124;

// The pinned request clock and the $Now it binds (floored to Cache.NowBucketMS = 1 minute).
const TEST_NOW = libProjectTrackSeed.TEST_NOW;
const NOW = '2026-10-08 12:00:00';

const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// ---------------------------------------------------------------------------------- SQL helpers

/**
 * SQL rows → plain objects (node:sqlite returns null-prototype rows).
 *
 * @param {any} pDB
 * @param {string} pSQL
 * @param {Record<string, any>|Array<any>} [pBinds]
 * @return {Array<Record<string, any>>}
 */
const sqlAll = (pDB, pSQL, pBinds) =>
{
	let tmpStatement = pDB.prepare(pSQL);
	let tmpBinds = pBinds;
	if (pBinds && !Array.isArray(pBinds))
	{
		// Only the named parameters this statement uses (node:sqlite refuses unknown ones).
		tmpBinds = {};
		Object.keys(pBinds).forEach((pName) => { if (new RegExp(`\\$${pName}\\b`).test(pSQL)) { tmpBinds[pName] = pBinds[pName]; } });
	}
	let tmpRows = Array.isArray(tmpBinds) ? tmpStatement.all(...tmpBinds) : (tmpBinds ? tmpStatement.all(tmpBinds) : tmpStatement.all());
	return tmpRows.map((pRow) => { return Object.assign({}, pRow); });
};

/**
 * { K, N } rows → { key: count } (keys stringified; NULL keys under '#null').
 *
 * @param {Array<Record<string, any>>} pRows
 * @return {Record<string, number>}
 */
const keyCounts = (pRows) =>
{
	let tmpMap = {};
	for (let i = 0; i < pRows.length; i++)
	{
		tmpMap[(pRows[i].K === null) ? '#null' : String(pRows[i].K)] = Number(pRows[i].N);
	}
	return tmpMap;
};

/**
 * RawFacetResult Groups → { key: count }.
 *
 * @param {Array<{ Key: any, Count: number }>} pGroups
 * @return {Record<string, number>}
 */
const groupMap = (pGroups) =>
{
	let tmpMap = {};
	for (let i = 0; i < pGroups.length; i++)
	{
		tmpMap[String(pGroups[i].Key)] = pGroups[i].Count;
	}
	return tmpMap;
};

/**
 * Remove the '#null' entry of a keyCounts map and return [ map, nullCount ].
 *
 * @param {Record<string, number>} pMap
 * @return {[ Record<string, number>, number ]}
 */
const splitNull = (pMap) =>
{
	let tmpCopy = Object.assign({}, pMap);
	let tmpNull = tmpCopy['#null'] || 0;
	delete tmpCopy['#null'];
	return [ tmpCopy, tmpNull ];
};

/**
 * SQLite ISO-week Monday of a DateTime column (independent of the contract's dateKey).
 *
 * @param {string} pColumn
 * @return {string}
 */
const sqlWeek = (pColumn) =>
{
	return `strftime('%Y-%m-%d 00:00:00', ${pColumn}, '-' || ((CAST(strftime('%w', ${pColumn}) AS INTEGER) + 6) % 7) || ' days')`;
};

// ---------------------------------------------------------------------------------- FoldIR builders (§24)

/**
 * A FoldIR Rel (internal-contracts §24.1).
 *
 * @param {string} pEntity
 * @param {string} pAs
 * @param {Record<string, any>|null} [pWhere] - column-only Pred
 * @param {Record<string, any>} [pExtra]
 * @return {Record<string, any>}
 */
const rel = (pEntity, pAs, pWhere, pExtra) =>
{
	return Object.assign({ Entity: pEntity, As: pAs, Role: 'Hop', Project: [], Client: null, Where: pWhere || null, WhereHash: '', Scope: 'Inherit', ScopeReason: null, SoftDelete: 'Explicit', Stage: 'Never' }, pExtra || {});
};

const on = (pOuterAlias, pOuterField, pInner) =>
{
	return { Outer: { Alias: pOuterAlias, Field: pOuterField }, Inner: pInner };
};

const exists = (pRel, pOn, pWhere) =>
{
	return { Node: 'Exists', Rel: pRel, On: pOn, Where: pWhere || null };
};

const notExists = (pRel, pOn, pWhere) =>
{
	return { Node: 'NotExists', Rel: pRel, On: pOn, Where: pWhere || null };
};

const countCmp = (pRel, pOn, pWhere, pOp, pN) =>
{
	return { Node: 'CountCmp', Rel: pRel, On: pOn, Where: pWhere || null, Op: pOp, N: pN };
};

const cmp = (pAlias, pField, pOp, pValue) =>
{
	let tmpNode = { Node: 'Cmp', Alias: pAlias, Field: pField, Op: pOp };
	if (typeof(pValue) !== 'undefined')
	{
		tmpNode.Value = pValue;
	}
	return tmpNode;
};

const and = (...pItems) => { return { Node: 'And', Items: pItems }; };
const or = (...pItems) => { return { Node: 'Or', Items: pItems }; };

// Column Preds (Part I grammar) for Rel.Where
const leaf = (pField, pOp, pValue) => { return (typeof(pValue) === 'undefined') ? { Field: pField, Op: pOp } : { Field: pField, Op: pOp, Value: pValue }; };
const allOf = (...pPreds) => { return (pPreds.length === 1) ? pPreds[0] : { And: pPreds }; };

/**
 * A Column-shaped conjunct (internal-contracts §4.2, §23.1).
 *
 * @param {string} pId
 * @param {Record<string, any>} pPred
 * @param {string} pHash
 * @return {Record<string, any>}
 */
const conjunct = (pId, pPred, pHash) =>
{
	let tmpFields = [];
	let fWalk = (pNode) =>
	{
		if (Array.isArray(pNode.And) || Array.isArray(pNode.Or))
		{
			(pNode.And || pNode.Or).forEach(fWalk);
			return;
		}
		if (tmpFields.indexOf(pNode.Field) < 0)
		{
			tmpFields.push(pNode.Field);
		}
	};
	fWalk(pPred);
	return (
		{
			Id: pId,
			Origin: { Kind: 'Clause', Hash: pHash || null, FilterKey: tmpFields[0], ClauseType: null, Index: 0 },
			Fields: tmpFields.sort(),
			NeverExclude: false,
			Fence: true,
			NamesDeleted: false,
			Shape: 'Column',
			Binds: [],
			Entities: [],
			Pred: pPred
		});
};

/**
 * A Variant (internal-contracts §24.6).
 *
 * @param {string} pVariantId
 * @param {string} pEntity
 * @param {Array<Record<string, any>>} pColumnConjuncts
 * @param {Record<string, any>|null} pPathPred
 * @return {Record<string, any>}
 */
const variant = (pVariantId, pEntity, pColumnConjuncts, pPathPred) =>
{
	let tmpIds = pColumnConjuncts.map((pConjunct) => { return pConjunct.Id; });
	return (
		{
			VariantId: pVariantId,
			Hash: `${tmpIds.join(',')}|${pVariantId}`,
			Entity: pEntity,
			ConjunctIds: tmpIds,
			Conjuncts: pColumnConjuncts,
			ColumnConjuncts: pColumnConjuncts,
			PathPred: pPathPred || null,
			Where: null,
			WhereHash: '',
			ExcludedIds: [],
			IncludesDeleted: false,
			Facets: []
		});
};

/**
 * An Agg (internal-contracts §5.1 + §24.5) with defaults.
 *
 * @param {string} pKey
 * @param {string} pKind
 * @param {string} pVariantId
 * @param {Record<string, any>} [pFields]
 * @return {Record<string, any>}
 */
const agg = (pKey, pKind, pVariantId, pFields) =>
{
	return Object.assign(
		{
			Key: pKey, FacetID: pKey, FacetIDs: [ pKey ], Kind: pKind, Pivot: null, Dimensions: [], Field: null, FieldInfo: null,
			Measures: [ { Op: 'count' } ], CountMode: 'Rows', Top: null, Order: 'CountDesc', Missing: true, EmptyBuckets: true, Chart: false,
			Exclude: 'None', VariantId: pVariantId, ClauseType: null, FilterKey: null, Selectable: false, DepSet: {}, DisplayName: pKey,
			SelectedKeys: [], LabelLookup: null, Origin: 'Declared', Definition: null, Where: null, WhereHash: '', Tuple: null, MultiValued: false
		}, pFields || {});
};

const columnDim = (pField, pDataType, pExtra) => { return Object.assign({ Kind: 'Column', Field: pField, DataType: pDataType || 'String', IsInteger: (pDataType === 'Numeric'), Scale: 0 }, pExtra || {}); };
const dateDim = (pField, pInterval, pExtra) => { return Object.assign({ Kind: 'DateBucket', Field: pField, Interval: pInterval, DataType: 'DateTime' }, pExtra || {}); };

/**
 * Fill every Rel's Project (internal-contracts §24.1: the primary key first, then the sorted unique
 * columns the plan reads from that relation: inner On columns, columns an On pair or a Cmp leaf
 * reads through its alias, Via / Multi key fields, tuple Key / On / dimension columns), as the
 * Planner does, so the hand-built FoldIR is faithful for every engine.
 *
 * @param {Record<string, any>} pModel - the domain model
 * @param {Record<string, any>} pVariants
 * @param {Array<Record<string, any>>} pAggs
 */
const fillProjections = (pModel, pVariants, pAggs) =>
{
	let tmpColumns = new Map();
	let tmpRelOf = Object.create(null);
	let fAdd = (pRel, pColumn) =>
	{
		if (!pRel || (typeof(pColumn) !== 'string'))
		{
			return;
		}
		if (!tmpColumns.has(pRel))
		{
			tmpColumns.set(pRel, new Set());
		}
		tmpColumns.get(pRel).add(pColumn);
	};
	let fBind = (pRel) =>
	{
		if (pRel)
		{
			tmpRelOf[pRel.As] = pRel;
			fAdd(pRel, null);
			if (!tmpColumns.has(pRel))
			{
				tmpColumns.set(pRel, new Set());
			}
		}
	};
	let fOn = (pRel, pOn) =>
	{
		(Array.isArray(pOn) ? pOn : []).forEach(
			(pPair) =>
			{
				fAdd(pRel, pPair.Inner);
				fAdd(tmpRelOf[pPair.Outer.Alias], pPair.Outer.Field);
			});
	};
	let fPred = (pNode) =>
	{
		if (!pNode)
		{
			return;
		}
		if (pNode.Node === 'Cmp')
		{
			fAdd(tmpRelOf[pNode.Alias], pNode.Field);
			return;
		}
		if ((pNode.Node === 'And') || (pNode.Node === 'Or'))
		{
			pNode.Items.forEach(fPred);
			return;
		}
		if ((pNode.Node === 'Exists') || (pNode.Node === 'NotExists') || (pNode.Node === 'CountCmp'))
		{
			fBind(pNode.Rel);
			fOn(pNode.Rel, pNode.On);
			fPred(pNode.Where);
		}
	};
	Object.keys(pVariants).forEach((pKey) => { fPred(pVariants[pKey].PathPred); fPred(pVariants[pKey].Where); });
	pAggs.forEach(
		(pAgg) =>
		{
			if (pAgg.Tuple)
			{
				pAgg.Tuple.Sides.forEach((pSide) => { fBind(pSide.Rel); });
				pAgg.Tuple.On.forEach((pPair) => { fAdd(tmpRelOf[pPair.Left.Alias], pPair.Left.Field); fAdd(tmpRelOf[pPair.Right.Alias], pPair.Right.Field); });
				pAgg.Tuple.Key.forEach((pPart) => { fAdd(tmpRelOf[pPart.Alias], pPart.Field); });
			}
			fPred(pAgg.Where);
			(pAgg.Dimensions || []).forEach(
				(pDimension) =>
				{
					if (Array.isArray(pDimension.Via))
					{
						pDimension.Via.forEach((pLink) => { fBind(pLink.Rel); fOn(pLink.Rel, pLink.On); });
						fAdd(pDimension.Via[pDimension.Via.length - 1].Rel, pDimension.Field);
					}
					else if (typeof(pDimension.Alias) === 'string')
					{
						fAdd(tmpRelOf[pDimension.Alias], pDimension.Field);
					}
					if (pDimension.Kind === 'Multi')
					{
						pDimension.Chain.forEach((pLink) => { fBind(pLink.Rel); fOn(pLink.Rel, pLink.On); });
						fAdd(pDimension.Chain[pDimension.Chain.length - 1].Rel, pDimension.KeyField);
						fPred(pDimension.Where);
					}
					if (pDimension.Kind === 'ChildAgg')
					{
						fBind(pDimension.Rel);
						fOn(pDimension.Rel, pDimension.On);
						fPred(pDimension.Where);
					}
					if (pDimension.Kind === 'ExistsFlag')
					{
						fPred(pDimension.Pred);
					}
				});
		});
	tmpColumns.forEach(
		(pSet, pRel) =>
		{
			let tmpPK = libBookstoreSeed.primaryKeyOf(pModel, pRel.Entity);
			pSet.delete(null);
			pSet.delete(tmpPK);
			pRel.Project = [ tmpPK ].concat(Array.from(pSet).sort());
		});
};

/**
 * A direct-drive request context (internal-contracts §2.2 + §19.5) with the principal resolved
 * through the real resolver.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pVariants
 * @param {string|{ Tenant?: number, User?: number }} pPrincipal - a principal name, or a session
 * @param {(pError?: Error, pContext?: Record<string, any>) => void} fCallback
 */
const newContext = (pHarness, pEntity, pVariants, pPrincipal, fCallback) =>
{
	let tmpSession = (typeof(pPrincipal) === 'string') ? pHarness.as(pPrincipal) : (pPrincipal || {});
	let tmpContext = (
		{
			RequestID: 'rfq-reference-m2',
			Entity: pEntity,
			Request: libHarness.syntheticRequest(pEntity, tmpSession),
			Host: pHarness.fable.RetoldFacetingHostDataService,
			Options: pHarness.faceting.options,
			Principal: null,
			NormalizedRequest: null,
			FilterAST: null,
			Variants: pVariants,
			Dialect: 'SQLite',
			Now: TEST_NOW,
			Deadline: Date.now() + 60000,
			ForceEngine: 'Reference',
			PlanForm: { Cube: 'Auto', Staged: 'Auto' },
			Bind: null,
			Mode: 'Query',
			Memo: { Relations: {}, Captures: {}, VariantRows: {} },
			Counters: { Relations: 0, BehaviorRuns: 0, Statements: 0 },
			Warnings: []
		});
	pHarness.fable.RetoldFacetingPrincipalResolver.resolve(tmpContext,
		(pError, pResolved) =>
		{
			if (pError)
			{
				return fCallback(pError, tmpContext);
			}
			tmpContext.Principal = pResolved;
			return fCallback(null, tmpContext);
		});
};

/**
 * Run the Reference engine on hand-built Aggs and leave its stack before asserting.
 */
const runReference = (pHarness, pEntity, pVariants, pAggs, pPrincipal, fCallback) =>
{
	// Agg.Pivot is the route entity for entity pivots and the Home entity for a TuplePivot (§24.4).
	pAggs.forEach((pAgg) => { if (!pAgg.Pivot) { pAgg.Pivot = pEntity; } });
	fillProjections(pHarness.model, pVariants, pAggs);
	newContext(pHarness, pEntity, pVariants, pPrincipal,
		(pContextError, pContext) =>
		{
			if (pContextError)
			{
				return setImmediate(() => { fCallback(pContextError, null, pContext); });
			}
			pHarness.fable.RetoldFacetingEngineReference.execute(pContext, pAggs,
				(pError, pExecution) =>
				{
					setImmediate(() => { fCallback(pError, pExecution, pContext); });
				});
		});
};

/**
 * The engine-comparable part of a RawFacetResult (order-free).
 *
 * @param {Record<string, any>} pRaw
 * @return {string|null}
 */
const rawSignature = (pRaw) =>
{
	if (!pRaw)
	{
		return null;
	}
	let tmpGroups = (Array.isArray(pRaw.Groups) ? pRaw.Groups : []).map((pGroup) => { return [ pGroup.Key, pGroup.Count ]; });
	tmpGroups.sort((pA, pB) => { return (JSON.stringify(pA[0]) < JSON.stringify(pB[0])) ? -1 : 1; });
	let tmpCells = Array.isArray(pRaw.Cells) ? pRaw.Cells.map((pCell) => { return [ pCell.Keys, pCell.Count ]; }) : null;
	if (tmpCells)
	{
		tmpCells.sort((pA, pB) => { return (JSON.stringify(pA[0]) < JSON.stringify(pB[0])) ? -1 : 1; });
	}
	return JSON.stringify({ Total: pRaw.Total, Missing: pRaw.MissingCount, Groups: tmpGroups, Cells: tmpCells, Bounds: pRaw.Bounds || null });
};

/**
 * Compare a Live and a Reference RawFacetResult (null when they agree).  Terms: the Live statement
 * returns only the groups ranked within Top + 1 (ties included) plus selected keys, the Reference
 * every group (internal-contracts §5.3), so every Live group must be a Reference group with the
 * same count and the Reference's canonical first Top + 1 groups must all be in Live; every other
 * field must be equal.
 *
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pLive
 * @param {Record<string, any>} pReference
 * @param {number} pDefaultTop
 * @return {string|null}
 */
const rawMismatch = (pAgg, pLive, pReference, pDefaultTop) =>
{
	if (!pLive || !pReference)
	{
		return `missing result (Live ${!!pLive}, Reference ${!!pReference})`;
	}
	if (pAgg.Kind !== 'Terms')
	{
		let tmpLive = rawSignature(pLive);
		let tmpReference = rawSignature(pReference);
		return (tmpLive === tmpReference) ? null : `Live ${tmpLive} ≠ Reference ${tmpReference}`;
	}
	if ((pLive.Total !== pReference.Total) || (pLive.MissingCount !== pReference.MissingCount))
	{
		return `Total / Missing: Live ${pLive.Total} / ${pLive.MissingCount}, Reference ${pReference.Total} / ${pReference.MissingCount}`;
	}
	let tmpReferenceCounts = new Map(pReference.Groups.map((pGroup) => { return [ JSON.stringify(pGroup.Key), pGroup.Count ]; }));
	let tmpLiveCounts = new Map(pLive.Groups.map((pGroup) => { return [ JSON.stringify(pGroup.Key), pGroup.Count ]; }));
	for (let [ tmpKey, tmpCount ] of tmpLiveCounts)
	{
		if (tmpReferenceCounts.get(tmpKey) !== tmpCount)
		{
			return `Live group ${tmpKey}=${tmpCount}, Reference ${tmpReferenceCounts.get(tmpKey)}`;
		}
	}
	let tmpTop = ((typeof(pAgg.Top) === 'number') ? pAgg.Top : pDefaultTop) + 1;
	let tmpCanonical = pReference.Groups.slice().sort((pA, pB) => { return (pB.Count - pA.Count) || ((JSON.stringify(pA.Key) < JSON.stringify(pB.Key)) ? -1 : 1); });
	for (let i = 0; i < Math.min(tmpTop, tmpCanonical.length); i++)
	{
		if (!tmpLiveCounts.has(JSON.stringify(tmpCanonical[i].Key)))
		{
			return `Reference top group ${JSON.stringify(tmpCanonical[i].Key)} missing from Live`;
		}
	}
	if ((typeof(pLive.DistinctKeys) === 'number') && (typeof(pReference.DistinctKeys) === 'number') && (pLive.DistinctKeys !== pReference.DistinctKeys))
	{
		return `DistinctKeys: Live ${pLive.DistinctKeys}, Reference ${pReference.DistinctKeys}`;
	}
	return null;
};

/**
 * O1 on hand-built FoldIR: the same Aggs through the Live engine and the Reference engine (fresh
 * contexts), raw results compared per Agg.
 */
const crossCheck = (pHarness, pEntity, pVariants, pAggs, pPrincipal, fCallback) =>
{
	runReference(pHarness, pEntity, pVariants, pAggs, pPrincipal,
		(pReferenceError, pReference) =>
		{
			if (pReferenceError)
			{
				return fCallback(pReferenceError);
			}
			newContext(pHarness, pEntity, pVariants, pPrincipal,
				(pContextError, pContext) =>
				{
					pContext.ForceEngine = null;
					pHarness.fable.RetoldFacetingEngineLive.execute(pContext, pAggs,
						(pLiveError, pLive) =>
						{
							setImmediate(() => { fCallback(pLiveError || null, { Live: pLive, Reference: pReference }); });
						});
				});
		});
};

/**
 * Which pieces of the M2 pipeline are missing (the end-to-end suite requires none to be).
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pScope - a scope the domain's definitions declare
 * @return {{ Ready: boolean, Missing: Array<string> }}
 */
const pipelineReadiness = (pHarness, pScope) =>
{
	let tmpMissing = [];
	let tmpFable = pHarness.fable;
	let tmpRegistry = tmpFable.RetoldFacetingDefinitionRegistry;
	if (!tmpRegistry || (typeof(tmpRegistry.scope) !== 'function') || !tmpRegistry.scope(pScope))
	{
		tmpMissing.push('DefinitionRegistry loads the domain definitions (A)');
	}
	if (typeof(tmpFable.RetoldFacetingPlanner.planBase) !== 'function')
	{
		tmpMissing.push('Planner.planBase (B)');
	}
	if (typeof(tmpFable.RetoldFacetingEngineLive.countBase) !== 'function')
	{
		tmpMissing.push('EngineLive.countBase (C)');
	}
	if (typeof(pHarness.faceting.records) !== 'function')
	{
		tmpMissing.push('RetoldFacetingService.records (wiring)');
	}
	return { Ready: (tmpMissing.length < 1), Missing: tmpMissing };
};

// ---------------------------------------------------------------------------------- O-hand SQL

/**
 * E1 base set (08 §2, as written in the definitions' prose): live tenant-t projects, optionally
 * without the Status / Client / StartDate clause, where I (u) hold an active Owner/Lead membership
 * or own the project, with an overdue unfinished task assigned to me, and no visible open Blocker.
 *
 * @param {{ Status?: boolean, Client?: boolean, Start?: boolean }} pKeep
 * @return {string} SQL over alias p, binds $t $u $now
 */
const e1Where = (pKeep) =>
{
	let tmpTerms = [ 'p.IDCustomer = $t', 'p.Deleted = 0' ];
	if (pKeep.Status !== false)
	{
		tmpTerms.push('p.Status IN (\'Active\', \'AtRisk\')');
	}
	if (pKeep.Client !== false)
	{
		tmpTerms.push('EXISTS (SELECT 1 FROM Client c WHERE c.IDClient = p.IDClient AND c.IDCustomer = $t AND c.Deleted = 0 AND c.IDClient IN (3, 9))');
	}
	if (pKeep.Start !== false)
	{
		tmpTerms.push('p.StartDate >= \'2026-01-01 00:00:00\' AND p.StartDate < \'2027-01-01 00:00:00\'');
	}
	tmpTerms.push('(EXISTS (SELECT 1 FROM ProjectMembership m WHERE m.IDProject = p.IDProject AND m.IDCustomer = $t AND m.Deleted = 0 AND m.IDUser = $u AND m.Role IN (\'Owner\', \'Lead\') AND m.Active = 1) OR p.OwnerIDUser = $u)');
	tmpTerms.push('EXISTS (SELECT 1 FROM Task k WHERE k.IDProject = p.IDProject AND k.IDCustomer = $t AND k.Deleted = 0 AND k.AssignedIDUser = $u AND k.DueDate < $now AND k.Status != \'Done\')');
	tmpTerms.push('NOT EXISTS (SELECT 1 FROM Issue i WHERE i.IDProject = p.IDProject AND i.IDCustomer = $t AND i.Deleted = 0 AND i.Severity = \'Blocker\' AND i.State = \'Open\')');
	return tmpTerms.join(' AND ');
};

// Lead's overdue unfinished tasks per project (the MyOverdueBand child count), as SQL over p.
const LEAD_OVERDUE_COUNT = '(SELECT count(*) FROM Task k WHERE k.IDProject = p.IDProject AND k.IDCustomer = $t AND k.Deleted = 0 AND k.AssignedIDUser = $u AND k.DueDate < $now AND k.Status != \'Done\')';
const BAND_SQL = `CASE WHEN ${LEAD_OVERDUE_COUNT} < 1 THEN 0 WHEN ${LEAD_OVERDUE_COUNT} < 3 THEN 1 WHEN ${LEAD_OVERDUE_COUNT} < 10 THEN 2 ELSE 3 END`;

/**
 * E3 variant A ToDo (08 §4.2 prose): live tenant-t requirements whose live intake (Received /
 * InProgress) sits in a live queue where I am an active live member, with no live tenant-t
 * Complete LabForm of ANY owner for the same intake and form type.
 *
 * @param {boolean} [pAnyOwner] - false: only my own forms count as done (no TenantOnly)
 * @return {string} SQL over alias r, binds $t $u
 */
const e3aWhere = (pAnyOwner) =>
{
	let tmpOwner = (pAnyOwner === false) ? ' AND f.OwnerIDUser = $u' : '';
	return [
		'r.IDCustomer = $t', 'r.Deleted = 0',
		'EXISTS (SELECT 1 FROM MaterialIntake i WHERE i.IDMaterialIntake = r.IDMaterialIntake AND i.IDCustomer = $t AND i.Deleted = 0 AND i.Status IN (\'Received\', \'InProgress\')'
			+ ' AND EXISTS (SELECT 1 FROM LabQueue q WHERE q.IDLabQueue = i.IDLabQueue AND q.IDCustomer = $t AND q.Deleted = 0'
			+ ' AND EXISTS (SELECT 1 FROM LabQueueMember m WHERE m.IDLabQueue = q.IDLabQueue AND m.IDCustomer = $t AND m.Deleted = 0 AND m.IDUser = $u AND m.Active = 1)))',
		`NOT EXISTS (SELECT 1 FROM LabForm f WHERE f.IDMaterialIntake = r.IDMaterialIntake AND f.IDLabFormType = r.IDLabFormType AND f.IDCustomer = $t AND f.Deleted = 0 AND f.Status = 'Complete'${tmpOwner})`
	].join(' AND ');
};

/**
 * E3 variant B tuples (08 §4.3 prose): distinct (intake, required form type) for live tenant-t
 * intakes (Received / InProgress) in my queues × live tenant-t Required type requirements of the
 * intake's material type, minus completed forms of any owner.
 *
 * @return {string} a SELECT of i.IDMaterialIntake, r.IDLabFormType, i.IDLabQueue, i.ReceivedDate (not distinct)
 */
const e3bSelect = () =>
{
	return 'SELECT i.IDMaterialIntake AS I, r.IDLabFormType AS F, i.IDLabQueue AS Q, i.ReceivedDate AS D'
		+ ' FROM MaterialIntake i JOIN MaterialTypeFormRequirement r ON r.IDMaterialType = i.IDMaterialType'
		+ ' WHERE i.IDCustomer = $t AND i.Deleted = 0 AND i.Status IN (\'Received\', \'InProgress\')'
		+ ' AND r.IDCustomer = $t AND r.Deleted = 0 AND r.Required = 1'
		+ ' AND EXISTS (SELECT 1 FROM LabQueue q WHERE q.IDLabQueue = i.IDLabQueue AND q.IDCustomer = $t AND q.Deleted = 0'
		+ ' AND EXISTS (SELECT 1 FROM LabQueueMember m WHERE m.IDLabQueue = q.IDLabQueue AND m.IDCustomer = $t AND m.Deleted = 0 AND m.IDUser = $u AND m.Active = 1))'
		+ ' AND NOT EXISTS (SELECT 1 FROM LabForm f WHERE f.IDMaterialIntake = i.IDMaterialIntake AND f.IDLabFormType = r.IDLabFormType AND f.IDCustomer = $t AND f.Deleted = 0 AND f.Status = \'Complete\')';
};

// ---------------------------------------------------------------------------------- hand-built FoldIR of the motivating queries

/**
 * E1 (08 §2) lowered by hand exactly as §24.8 prescribes, for one principal.
 *
 * @param {number} pUser
 * @return {{ Variants: Record<string, any>, Aggs: Array<Record<string, any>> }}
 */
const e1FoldIR = (pUser) =>
{
	let tmpC1 = conjunct('c1', leaf('Status', 'IN', [ 'Active', 'AtRisk' ]), 'Status-DSVL-1');
	let tmpC3 = conjunct('c3', allOf(leaf('StartDate', 'GE', '2026-01-01 00:00:00'), leaf('StartDate', 'LT', '2027-01-01 00:00:00')), 'StartDate-DR-1');
	let tmpC2 = exists(rel('Client', 'h1', leaf('IDClient', 'IN', [ 3, 9 ])), [ on('p', 'IDClient', 'IDClient') ]);
	let tmpC4 = or(exists(rel('ProjectMembership', 'h2', allOf(leaf('IDUser', 'EQ', pUser), leaf('Role', 'IN', [ 'Owner', 'Lead' ]), leaf('Active', 'EQ', 1))), [ on('p', 'IDProject', 'IDProject') ]),
		cmp('p', 'OwnerIDUser', 'EQ', pUser));
	let tmpC5 = exists(rel('Task', 'h3', allOf(leaf('AssignedIDUser', 'EQ', pUser), leaf('DueDate', 'LT', NOW), leaf('Status', 'NE', 'Done'))), [ on('p', 'IDProject', 'IDProject') ]);
	let tmpC6 = notExists(rel('Issue', 'h4', allOf(leaf('Severity', 'EQ', 'Blocker'), leaf('State', 'EQ', 'Open'))), [ on('p', 'IDProject', 'IDProject') ]);
	let tmpVariants =
		{
			v0: variant('v0', 'Project', [ tmpC1, tmpC3 ], and(tmpC2, tmpC4, tmpC5, tmpC6)),
			v1: variant('v1', 'Project', [ tmpC3 ], and(tmpC2, tmpC4, tmpC5, tmpC6)),
			v2: variant('v2', 'Project', [ tmpC1, tmpC3 ], and(tmpC4, tmpC5, tmpC6)),
			v3: variant('v3', 'Project', [ tmpC1 ], and(tmpC2, tmpC4, tmpC5, tmpC6))
		};
	let tmpChild = { Kind: 'ChildAgg', Rel: rel('Task', 'x1', allOf(leaf('AssignedIDUser', 'EQ', pUser), leaf('DueDate', 'LT', NOW), leaf('Status', 'NE', 'Done')), { Role: 'Child' }),
		On: [ on('p', 'IDProject', 'IDProject') ], Where: null, Agg: 'count', Field: null, Edges: [ 1, 3, 10 ], DataType: 'Numeric', IsInteger: true, Scale: 0 };
	let tmpAggs =
		[
			agg('#Total', 'Count', 'v0', { Origin: 'Auto' }),
			agg('Status', 'Terms', 'v1', { Origin: 'Auto', Dimensions: [ columnDim('Status', 'String') ], Field: 'Status' }),
			agg('Client', 'Terms', 'v2', { Origin: 'Auto', Dimensions: [ columnDim('IDClient', 'Numeric') ], Field: 'IDClient' }),
			agg('Started', 'DateHistogram', 'v3', { Origin: 'Auto', Dimensions: [ dateDim('StartDate', 'month') ], Field: 'StartDate' }),
			agg('MyOverdue', 'ChildRollup', 'v0', { Dimensions: [ tmpChild ] }),
			agg('StatusByClient', 'Pivot', 'v0', { Origin: 'Auto', Dimensions: [ columnDim('Status', 'String'), columnDim('IDClient', 'Numeric') ] })
		];
	return { Variants: tmpVariants, Aggs: tmpAggs };
};

/**
 * E3 variant A (08 §4.2) lowered by hand: W_def = ToDoForMe at scope 'p'; the siblings' K8 Via
 * chains and the Started ExistsSplit (no CheckParent: ToDoForMe visits the intake first, §21.4).
 *
 * @param {number} pUser
 * @param {string} [pFormScope] - the scope of the anti-join's LabForm hop ('TenantOnly' as declared)
 * @return {{ Variants: Record<string, any>, Aggs: Array<Record<string, any>>, Where: Record<string, any> }}
 */
const e3aFoldIR = (pUser, pFormScope) =>
{
	let tmpScope = pFormScope || 'TenantOnly';
	let tmpWhere = and(
		exists(rel('MaterialIntake', 'j1', leaf('Status', 'IN', [ 'Received', 'InProgress' ])), [ on('p', 'IDMaterialIntake', 'IDMaterialIntake') ],
			exists(rel('LabQueue', 'j2', null), [ on('j1', 'IDLabQueue', 'IDLabQueue') ],
				exists(rel('LabQueueMember', 'j3', allOf(leaf('IDUser', 'EQ', pUser), leaf('Active', 'EQ', 1))), [ on('j2', 'IDLabQueue', 'IDLabQueue') ]))),
		notExists(rel('LabForm', 'j4', leaf('Status', 'EQ', 'Complete'), { Scope: tmpScope, ScopeReason: (tmpScope === 'TenantOnly') ? 'A form completed by any technician in my lab satisfies the requirement.' : null }),
			[ on('p', 'IDMaterialIntake', 'IDMaterialIntake'), on('p', 'IDLabFormType', 'IDLabFormType') ]));
	let tmpVariant = variant('v1', 'MaterialIntakeRequirement', [], null);
	tmpVariant.Where = tmpWhere;
	tmpVariant.WhereHash = 'wh:todoforme';
	let tmpLookup = (pEntity, pAs) => { return rel(pEntity, pAs, null, { Role: 'Lookup' }); };
	let tmpDeclared = { Where: tmpWhere, WhereHash: 'wh:todoforme', Exclude: 'Self', Semantics: 'NoVisibleMatch', Relaxed: (tmpScope === 'TenantOnly') };
	let tmpAggs =
		[
			agg('#Total', 'Count', 'v0', { Origin: 'Auto' }),
			agg('ToDo', 'Terms', 'v1', Object.assign({ Dimensions: [ columnDim('IDLabFormType', 'Numeric') ], Field: 'IDLabFormType' }, tmpDeclared)),
			agg('Queue', 'Terms', 'v1', Object.assign({ Dimensions: [ columnDim('IDLabQueue', 'Numeric', { Via: [ { Rel: tmpLookup('MaterialIntake', 'l1'), On: [ on('p', 'IDMaterialIntake', 'IDMaterialIntake') ] }, { Rel: tmpLookup('LabQueue', 'l2'), On: [ on('l1', 'IDLabQueue', 'IDLabQueue') ] } ] }) ], Field: 'IDLabQueue' }, tmpDeclared)),
			agg('Discipline', 'Terms', 'v1', Object.assign({ Dimensions: [ columnDim('Discipline', 'String', { Via: [ { Rel: tmpLookup('LabFormType', 'l3'), On: [ on('p', 'IDLabFormType', 'IDLabFormType') ] } ] }) ], Field: 'Discipline' }, tmpDeclared)),
			agg('Week', 'DateHistogram', 'v1', Object.assign({ Dimensions: [ dateDim('ReceivedDate', 'week', { Via: [ { Rel: tmpLookup('MaterialIntake', 'l4'), On: [ on('p', 'IDMaterialIntake', 'IDMaterialIntake') ] } ] }) ], Field: 'ReceivedDate' }, tmpDeclared)),
			agg('Started', 'ExistsSplit', 'v1', Object.assign({ Dimensions: [ { Kind: 'ExistsFlag', DataType: 'Boolean', IsInteger: true, Scale: 0,
				Pred: exists(rel('LabForm', 'e1', leaf('Status', 'NE', 'Complete')), [ on('p', 'IDMaterialIntake', 'IDMaterialIntake'), on('p', 'IDLabFormType', 'IDLabFormType') ]) } ] }, tmpDeclared, { Exclude: 'None' }))
		];
	return { Variants: { v0: variant('v0', 'MaterialIntakeRequirement', [], null), v1: tmpVariant }, Aggs: tmpAggs, Where: tmpWhere };
};

/**
 * E3 variant B (08 §4.3) lowered by hand: the TuplePivot i × r (Home side 'p', r → 'u1'), i's
 * InMyQueues path part and the composite anti-join in Agg.Where.
 *
 * @param {number} pUser
 * @return {{ Variants: Record<string, any>, Aggs: Array<Record<string, any>> }}
 */
const e3bFoldIR = (pUser) =>
{
	let tmpTuple =
		{
			Sides:
				[
					{ Name: 'i', Alias: 'p', Rel: rel('MaterialIntake', 'p', leaf('Status', 'IN', [ 'Received', 'InProgress' ]), { Role: 'TupleSide' }) },
					{ Name: 'r', Alias: 'u1', Rel: rel('MaterialTypeFormRequirement', 'u1', leaf('Required', 'EQ', 1), { Role: 'TupleSide' }) }
				],
			On: [ { Left: { Alias: 'p', Field: 'IDMaterialType' }, Right: { Alias: 'u1', Field: 'IDMaterialType' } } ],
			Key: [ { Alias: 'p', Field: 'IDMaterialIntake' }, { Alias: 'u1', Field: 'IDLabFormType' } ],
			Names: { i: 'p', r: 'u1' }
		};
	let tmpWhere = and(
		exists(rel('LabQueue', 'j1', null), [ on('p', 'IDLabQueue', 'IDLabQueue') ],
			exists(rel('LabQueueMember', 'j2', allOf(leaf('IDUser', 'EQ', pUser), leaf('Active', 'EQ', 1))), [ on('j1', 'IDLabQueue', 'IDLabQueue') ])),
		notExists(rel('LabForm', 'j3', leaf('Status', 'EQ', 'Complete'), { Scope: 'TenantOnly', ScopeReason: 'Any technician\'s completed form satisfies the requirement.' }),
			[ on('p', 'IDMaterialIntake', 'IDMaterialIntake'), on('u1', 'IDLabFormType', 'IDLabFormType') ]));
	let tmpDeclared = { Tuple: tmpTuple, Where: tmpWhere, WhereHash: 'wh:formstodo', CountMode: 'KeyDistinct', Exclude: 'None', Relaxed: true };
	let tmpVariant = variant('v1', 'MaterialIntake', [], null);
	tmpVariant.Where = tmpWhere;
	return (
		{
			Variants: { v1: tmpVariant },
			Aggs:
				[
					agg('ToDo', 'Terms', 'v1', Object.assign({ Dimensions: [ columnDim('IDLabFormType', 'Numeric', { Alias: 'u1' }) ], Field: 'IDLabFormType' }, tmpDeclared)),
					agg('Queue', 'Terms', 'v1', Object.assign({ Dimensions: [ columnDim('IDLabQueue', 'Numeric', { Alias: 'p' }) ], Field: 'IDLabQueue' }, tmpDeclared)),
					agg('Week', 'DateHistogram', 'v1', Object.assign({ Dimensions: [ dateDim('ReceivedDate', 'week', { Alias: 'p' }) ], Field: 'ReceivedDate' }, tmpDeclared))
				]
		});
};

// The motivating request bodies (internal-contracts §31.5).
const e1Body = (pTraps) =>
{
	return (
		{
			Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead' ] } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
			Clauses:
				[
					{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active', 'AtRisk' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' },
					{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: pTraps.E1ClientIDs, FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' },
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
		});
};

const e2Body = (pTraps) =>
{
	return (
		{
			Clauses:
				[
					{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'FormType', JoinInternalConnectionColumn: 'IDFormType', JoinExternalConnectionColumn: 'IDFormType', Values: [ pTraps.E2FormTypeID ], FilterKey: 'IDFormType', Hash: 'IDFormType-IJ-1' },
					{ Type: 'DateRange', FilterByColumn: 'DocumentDate', Values: { Start: '2026-01-01 00:00:00', End: '2026-07-01 00:00:00' }, EndExclusive: true, FilterKey: 'DocumentDate', Hash: 'DocumentDate-DR-1' }
				],
			Facets: [ { Key: 'ByMonth', Facet: 'Document.DocumentDate', Interval: 'month', Chart: true }, { Key: 'ByForm', Facet: 'Document.IDFormType', Top: 20 }, { Key: 'Status', Facet: 'Document.Status', Exclude: 'None' } ],
			Records: { Begin: 0, Cap: 100 }
		});
};

const E3A_BODY = Object.freeze(
	{
		Facets:
			[
				{ Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' },
				{ Key: 'Week', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek' }, { Key: 'Discipline', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' },
				{ Key: 'Started', Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started' }
			]
	});

const E3B_BODY = Object.freeze(
	{
		Facets: [ { Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntake.FormsToDo/ByQueue' }, { Key: 'Week', Facet: 'MaterialIntake.FormsToDo/ByWeek' } ]
	});

/**
 * Deep copy (request bodies are mutated by nothing, but tests hand them around).
 *
 * @param {any} pValue
 * @return {any}
 */
const clone = (pValue) =>
{
	return JSON.parse(JSON.stringify(pValue));
};

suite
(
	'Facet-Reference-M2',
	() =>
	{
		// ================================================================ 1. fixtures
		suite
		(
			'ProjectTrack and LabTrack fixtures',
			() =>
			{
				let _ProjectTrack = libProjectTrackSeed.generate();
				let _LabTrack = libLabTrackSeed.generate();

				/**
				 * Rows of a table for one tenant.
				 */
				let fTenantRows = (pGenerated, pTable, pTenant) =>
				{
					return pGenerated.Rows[pTable].filter((pRow) => { return pRow.IDCustomer === pTenant; });
				};

				test('generation is deterministic per seed, differs across seeds, and Medium is ×4 filler',
					() =>
					{
						[ libProjectTrackSeed, libLabTrackSeed ].forEach(
							(pSeed) =>
							{
								let tmpA = new DatabaseSync(':memory:');
								let tmpB = new DatabaseSync(':memory:');
								let tmpC = new DatabaseSync(':memory:');
								let tmpBuiltA = pSeed.build(tmpA);
								pSeed.build(tmpB, { Seed: pSeed.DEFAULT_SEED });
								pSeed.build(tmpC, { Seed: 7 });
								Expect(libBookstoreSeed.fingerprint(tmpA, tmpBuiltA.Model)).to.equal(libBookstoreSeed.fingerprint(tmpB, tmpBuiltA.Model));
								Expect(libBookstoreSeed.fingerprint(tmpA, tmpBuiltA.Model)).to.not.equal(libBookstoreSeed.fingerprint(tmpC, tmpBuiltA.Model));
								[ tmpA, tmpB, tmpC ].forEach((pDB) => { pDB.close(); });
								let tmpSmall = pSeed.generate({ Scale: 'Small' });
								let tmpMedium = pSeed.generate({ Scale: 'Medium' });
								Expect(tmpMedium.Rows.User.length).to.equal(tmpSmall.Rows.User.length * 4);
								Expect(() => { pSeed.generate({ Scale: 'Huge' }); }).to.throw(/scale/);
								Expect(tmpSmall.Order).to.deep.equal(pSeed.GENERATION_ORDER.slice());
								Expect(tmpSmall.Tenants).to.deep.equal([ 1, 2 ]);
								Expect(tmpSmall.TenantColumn).to.equal('IDCustomer');
								Expect(tmpSmall.Traps.TestNow).to.equal('2026-10-08T12:00:00Z');
							});
					});

				test('build() returns the counts, both tenants, traps, principals and the rows (internal-contracts §31.6)',
					() =>
					{
						let tmpDB = new DatabaseSync(':memory:');
						let tmpBuilt = libProjectTrackSeed.build(tmpDB);
						Expect(tmpBuilt.Fixture).to.equal('ProjectTrack');
						Expect(tmpBuilt.Counts.Project).to.equal(72);
						Expect(tmpBuilt.TenantCounts[1].Project).to.equal(60);
						Expect(tmpBuilt.TenantCounts[2].Project).to.equal(12);
						Expect(tmpBuilt.TenantLiveCounts[1].FormType).to.equal(12);
						Expect(tmpBuilt.LiveCounts.Project).to.equal(Number(tmpDB.prepare('SELECT count(*) AS N FROM Project WHERE Deleted = 0').get().N));
						Expect(Object.keys(tmpBuilt.Principals).sort()).to.deep.equal([ 'Lead', 'Member', 'OtherLead', 'Outsider' ]);
						Expect(tmpBuilt.Rows.Task.length).to.equal(tmpBuilt.Counts.Task);
						tmpDB.close();
						let tmpLabDB = new DatabaseSync(':memory:');
						let tmpLab = libLabTrackSeed.build(tmpLabDB);
						Expect(Object.keys(tmpLab.Principals).sort()).to.deep.equal([ 'Colleague', 'Newbie', 'OtherTech', 'Tech' ]);
						Expect(tmpLab.Principals.OtherTech.Tenant).to.equal(2);
						tmpLabDB.close();
					});

				test('the models build a graph with the documented bridges and hubs (internal-contracts §31.1)',
					() =>
					{
						let tmpGraph = new libRetoldFacetingGraph(new libFable({ LogStreams: [ { streamtype: 'console', level: 'fatal' } ] }));
						tmpGraph.rebuild(libLabTrackSeed.model());
						Expect(tmpGraph.isBridge('MaterialIntakeRequirement')).to.equal(true);
						Expect(tmpGraph.isBridge('LabQueueMember')).to.equal(false);
						Expect(tmpGraph.isBridge('MaterialTypeFormRequirement')).to.equal(false);
						Expect(tmpGraph.edge('LabForm.IDMaterialIntake')).to.be.an('object');
						tmpGraph.rebuild(libProjectTrackSeed.model());
						Expect(tmpGraph.isBridge('ProjectMembership')).to.equal(false);
						Expect(tmpGraph.edge('Document.IDFormType')).to.be.an('object');
					});

				test('two tenants: tenant 2 has its own rows (≥ 15 % of tenant 1), distinct IDs, and a soft-deleted row per table per tenant',
					() =>
					{
						[ _ProjectTrack, _LabTrack ].forEach(
							(pGenerated) =>
							{
								Object.keys(pGenerated.Rows).forEach(
									(pTable) =>
									{
										let tmpPK = libBookstoreSeed.primaryKeyOf(pGenerated.Model, pTable);
										let tmpIDs = pGenerated.Rows[pTable].map((pRow) => { return pRow[tmpPK]; });
										Expect(new Set(tmpIDs).size, `${pTable} IDs are unique`).to.equal(tmpIDs.length);
										Expect(tmpIDs.every((pID) => { return Number.isInteger(pID) && (pID > 0); }), `${pTable} explicit IDs`).to.equal(true);
										let tmpHasTenant = pGenerated.Model.Tables[pTable].Columns.some((pColumn) => { return pColumn.Column === 'IDCustomer'; });
										if (!tmpHasTenant || (pTable === 'Customer'))
										{
											return;
										}
										let tmpOne = fTenantRows(pGenerated, pTable, 1);
										let tmpTwo = fTenantRows(pGenerated, pTable, 2);
										Expect(tmpTwo.length, `${pTable} tenant 2 ≥ 15 %`).to.be.at.least(Math.ceil(tmpOne.length * 0.15));
										Expect(tmpOne.some((pRow) => { return pRow.Deleted === 1; }), `${pTable} tenant 1 soft-deleted`).to.equal(true);
										Expect(tmpTwo.some((pRow) => { return pRow.Deleted === 1; }), `${pTable} tenant 2 soft-deleted`).to.equal(true);
									});
							});
						// Global lookups have no tenant and no soft delete
						Expect(_ProjectTrack.Rows.FormType.length).to.equal(12);
						Expect(_LabTrack.Rows.LabFormType.length).to.equal(12);
						Expect(Object.keys(_ProjectTrack.Rows.FormType[0]).sort()).to.deep.equal([ 'Category', 'GUIDFormType', 'IDFormType', 'Name' ]);
					});

				test('every date is canonical, and every $Now-compared date is far from any plausible clock',
					() =>
					{
						[ _ProjectTrack, _LabTrack ].forEach(
							(pGenerated) =>
							{
								Object.keys(pGenerated.Rows).forEach(
									(pTable) =>
									{
										let tmpDateColumns = pGenerated.Model.Tables[pTable].Columns.filter((pColumn) => { return pColumn.DataType === 'DateTime'; }).map((pColumn) => { return pColumn.Column; });
										pGenerated.Rows[pTable].forEach(
											(pRow) =>
											{
												tmpDateColumns.forEach(
													(pColumn) =>
													{
														if (pRow[pColumn] !== null)
														{
															Expect(pRow[pColumn], `${pTable}.${pColumn}`).to.match(DATETIME_PATTERN);
														}
													});
											});
									});
							});
						_ProjectTrack.Rows.Task.forEach(
							(pTask) =>
							{
								let tmpDue = pTask.DueDate;
								Expect((tmpDue === null) || (tmpDue <= '2025-12-31 23:59:59') || (tmpDue >= '2031-01-01 00:00:00'), `Task ${pTask.IDTask} DueDate ${tmpDue}`).to.equal(true);
							});
						Expect(_ProjectTrack.Rows.Task.some((pTask) => { return pTask.DueDate === '2025-12-31 23:59:59'; })).to.equal(true);
						Expect(_ProjectTrack.Rows.Task.some((pTask) => { return pTask.DueDate === '2031-01-01 00:00:00'; })).to.equal(true);
					});

				test('ProjectTrack: Lead\'s memberships, ownership, overdue bands, issues and clients are the story of §31.3',
					() =>
					{
						let tmpRows = _ProjectTrack.Rows;
						let tmpTraps = _ProjectTrack.Traps;
						let tmpLeadMemberships = tmpRows.ProjectMembership.filter((pRow) => { return (pRow.IDUser === 1) && (pRow.IDCustomer === 1) && ((pRow.Role === 'Owner') || (pRow.Role === 'Lead')); });
						Expect(new Set(tmpLeadMemberships.map((pRow) => { return pRow.IDProject; })).size).to.be.at.least(6);
						Expect(tmpLeadMemberships.some((pRow) => { return pRow.Active === 0; })).to.equal(true);
						Expect(tmpLeadMemberships.some((pRow) => { return pRow.Deleted === 1; })).to.equal(true);
						let tmpMemberProjects = new Set(tmpRows.ProjectMembership.filter((pRow) => { return pRow.IDUser === 1; }).map((pRow) => { return pRow.IDProject; }));
						let tmpOwned = tmpRows.Project.filter((pRow) => { return (pRow.OwnerIDUser === 1) && (pRow.IDCustomer === 1); });
						Expect(tmpOwned.filter((pRow) => { return !tmpMemberProjects.has(pRow.IDProject); }).length).to.be.at.least(3);
						Expect(tmpOwned.filter((pRow) => { return tmpMemberProjects.has(pRow.IDProject); }).length).to.be.at.least(1);
						// Member: Member / Reviewer roles only; owns nothing.  Outsider: no memberships, owns nothing, no tasks.
						Expect(tmpRows.ProjectMembership.filter((pRow) => { return (pRow.IDUser === 2) && (pRow.IDCustomer === 1); }).every((pRow) => { return (pRow.Role === 'Member') || (pRow.Role === 'Reviewer'); })).to.equal(true);
						Expect(tmpRows.Project.some((pRow) => { return pRow.OwnerIDUser === 2; })).to.equal(false);
						Expect(tmpRows.ProjectMembership.some((pRow) => { return pRow.IDUser === 3; })).to.equal(false);
						Expect(tmpRows.Project.some((pRow) => { return pRow.OwnerIDUser === 3; })).to.equal(false);
						Expect(tmpRows.Task.some((pRow) => { return pRow.AssignedIDUser === 3; })).to.equal(false);
						// Project.Status values, StartDate window with NULLs
						let tmpStatuses = new Set(tmpRows.Project.filter((pRow) => { return pRow.IDCustomer === 1; }).map((pRow) => { return pRow.Status; }));
						[ 'Active', 'AtRisk', 'OnHold', 'Done', '' ].forEach((pStatus) => { Expect(tmpStatuses.has(pStatus), pStatus).to.equal(true); });
						Expect(tmpStatuses.has('Cancelled')).to.equal(false);
						Expect(tmpRows.Project.some((pRow) => { return (pRow.IDCustomer === 2) && (pRow.Status === 'Cancelled'); })).to.equal(true);
						Expect(tmpRows.Project.some((pRow) => { return pRow.StartDate === null; })).to.equal(true);
						Expect(tmpRows.Project.every((pRow) => { return (pRow.StartDate === null) || ((pRow.StartDate >= '2024-01-01 00:00:00') && (pRow.StartDate < '2027-07-01 00:00:00')); })).to.equal(true);
						// Blocker issues: open on 6, closed on 2, open Major on 3, soft-deleted open on 4, tenant-2 open on 5
						let fIssue = (pProject, pTenant, pSeverity, pState, pDeleted) =>
						{
							return tmpRows.Issue.some((pRow) => { return (pRow.IDProject === pProject) && (pRow.IDCustomer === pTenant) && (pRow.Severity === pSeverity) && (pRow.State === pState) && (pRow.Deleted === pDeleted); });
						};
						Expect(fIssue(6, 1, 'Blocker', 'Open', 0)).to.equal(true);
						Expect(fIssue(2, 1, 'Blocker', 'Closed', 0)).to.equal(true);
						Expect(fIssue(3, 1, 'Major', 'Open', 0)).to.equal(true);
						Expect(fIssue(4, 1, 'Blocker', 'Open', 1)).to.equal(true);
						Expect(fIssue(5, 2, 'Blocker', 'Open', 0)).to.equal(true);
						// Clients: the soft-deleted client is referenced by live projects; a tenant-2 client from tenant 1 and back
						let tmpDeletedClient = tmpRows.Client.find((pRow) => { return pRow.IDClient === tmpTraps.DeletedClientID; });
						Expect(tmpDeletedClient.Deleted).to.equal(1);
						Expect(tmpDeletedClient.IDCustomer).to.equal(1);
						Expect(tmpRows.Project.some((pRow) => { return (pRow.IDClient === tmpTraps.DeletedClientID) && (pRow.Deleted === 0); })).to.equal(true);
						Expect(tmpRows.Client.find((pRow) => { return pRow.IDClient === tmpTraps.CrossTenantClientID; }).IDCustomer).to.equal(2);
						Expect(tmpRows.Project.some((pRow) => { return (pRow.IDCustomer === 1) && (pRow.IDClient === tmpTraps.CrossTenantClientID); })).to.equal(true);
						Expect(tmpRows.Project.some((pRow) => { return (pRow.IDCustomer === 2) && (tmpTraps.E1ClientIDs.indexOf(pRow.IDClient) >= 0); })).to.equal(true);
						Expect(tmpRows.Project.some((pRow) => { return (pRow.IDCustomer === 1) && (pRow.IDClient === null); })).to.equal(true);
						// Documents: dates across 2025–2026 with NULLs, every form type, NULL and dangling form types
						let tmpDocuments = tmpRows.Document.filter((pRow) => { return pRow.IDCustomer === 1; });
						Expect(tmpDocuments.some((pRow) => { return pRow.DocumentDate === null; })).to.equal(true);
						Expect(tmpDocuments.every((pRow) => { return (pRow.DocumentDate === null) || ((pRow.DocumentDate >= '2025-01-01 00:00:00') && (pRow.DocumentDate < '2027-01-01 00:00:00')); })).to.equal(true);
						Expect(new Set(tmpDocuments.map((pRow) => { return pRow.IDFormType; }).filter((pID) => { return (pID !== null) && (pID <= 12); })).size).to.equal(12);
						Expect(tmpDocuments.some((pRow) => { return pRow.IDFormType === null; })).to.equal(true);
						Expect(tmpDocuments.some((pRow) => { return pRow.IDFormType === tmpTraps.DanglingFormTypeID; })).to.equal(true);
						Expect(tmpRows.Document.some((pRow) => { return (pRow.IDCustomer === 2) && (pRow.IDProject === 1); })).to.equal(true);
						Expect(tmpRows.Task.some((pRow) => { return (pRow.IDCustomer === 2) && (pRow.IDProject === 1) && (pRow.AssignedIDUser === 1); })).to.equal(true);
						// Terms columns hold '' somewhere
						Expect(tmpRows.Task.some((pRow) => { return pRow.Status === ''; })).to.equal(true);
						Expect(tmpRows.Document.some((pRow) => { return pRow.Status === ''; })).to.equal(true);
					});

				test('LabTrack: queues, memberships, intakes, requirements and every LabForm case are the story of §31.3',
					() =>
					{
						let tmpRows = _LabTrack.Rows;
						let tmpTraps = _LabTrack.Traps;
						let fMember = (pUser, pQueue) => { return tmpRows.LabQueueMember.filter((pRow) => { return (pRow.IDUser === pUser) && (pRow.IDLabQueue === pQueue) && (pRow.IDCustomer === 1); }); };
						tmpTraps.TechQueueIDs.forEach((pQueue) => { Expect(fMember(1, pQueue).some((pRow) => { return (pRow.Active === 1) && (pRow.Deleted === 0); })).to.equal(true); });
						Expect(fMember(1, tmpTraps.TechInactiveQueueID)[0].Active).to.equal(0);
						Expect(fMember(1, tmpTraps.TechDeletedMembershipQueueID)[0].Deleted).to.equal(1);
						Expect(fMember(2, tmpTraps.TechQueueIDs[0])[0].Active).to.equal(1);
						Expect(tmpRows.LabQueueMember.some((pRow) => { return (pRow.IDUser === 3) && (pRow.IDCustomer === 1); })).to.equal(false);
						Expect(tmpRows.LabQueue.find((pRow) => { return pRow.IDLabQueue === tmpTraps.DeletedQueueID; }).Deleted).to.equal(1);
						Expect(tmpRows.MaterialIntake.some((pRow) => { return (pRow.IDLabQueue === tmpTraps.DeletedQueueID) && (pRow.Deleted === 0); })).to.equal(true);
						let tmpIntakes = tmpRows.MaterialIntake.filter((pRow) => { return pRow.IDCustomer === 1; });
						[ 'Received', 'InProgress', 'Complete', '' ].forEach((pStatus) => { Expect(tmpIntakes.some((pRow) => { return pRow.Status === pStatus; }), pStatus).to.equal(true); });
						Expect(tmpIntakes.some((pRow) => { return pRow.ReceivedDate === null; })).to.equal(true);
						Expect(tmpIntakes.some((pRow) => { return pRow.IDLabQueue === null; })).to.equal(true);
						Expect(tmpRows.MaterialIntake.find((pRow) => { return pRow.IDMaterialIntake === tmpTraps.DeletedIntakeID; }).Deleted).to.equal(1);
						Expect(tmpRows.MaterialIntakeRequirement.some((pRow) => { return (pRow.IDMaterialIntake === tmpTraps.DeletedIntakeID) && (pRow.Deleted === 0); })).to.equal(true);
						// Type requirements: Required 0 and 1, the duplicate (type, form) pair, a soft-deleted row
						let tmpDuplicate = tmpRows.MaterialTypeFormRequirement.filter(
							(pRow) =>
							{
								return (pRow.IDCustomer === 1) && (pRow.Deleted === 0) && (pRow.IDMaterialType === tmpTraps.DuplicateTypeRequirement.IDMaterialType) && (pRow.IDLabFormType === tmpTraps.DuplicateTypeRequirement.IDLabFormType);
							});
						Expect(tmpDuplicate.length).to.equal(2);
						Expect(tmpRows.MaterialTypeFormRequirement.some((pRow) => { return pRow.Required === 0; })).to.equal(true);
						Expect(tmpRows.MaterialTypeFormRequirement.some((pRow) => { return (pRow.IDCustomer === 1) && (pRow.Deleted === 1); })).to.equal(true);
						Expect(tmpRows.LabFormType.some((pRow) => { return pRow.Discipline === ''; })).to.equal(true);
						// The colleague-completed trap pairs really are completed by Colleague (and only by them)
						Expect(tmpTraps.ColleagueCompleted.length).to.be.at.least(5);
						tmpTraps.ColleagueCompleted.forEach(
							(pPair) =>
							{
								let tmpForms = tmpRows.LabForm.filter((pRow) => { return (pRow.IDMaterialIntake === pPair.IDMaterialIntake) && (pRow.IDLabFormType === pPair.IDLabFormType) && (pRow.IDCustomer === 1); });
								Expect(tmpForms.length).to.equal(1);
								Expect(tmpForms[0].OwnerIDUser).to.equal(2);
								Expect(tmpForms[0].Status).to.equal('Complete');
							});
						// Every LabForm case exists among E3A-eligible requirements of Tech (live intake, Received /
						// InProgress, Tech's queues): pending by Tech, complete by Tech, deleted complete, tenant-2 complete
						let tmpEligible = new Set(tmpIntakes.filter((pRow) => { return (pRow.Deleted === 0) && ((pRow.Status === 'Received') || (pRow.Status === 'InProgress')) && (tmpTraps.TechQueueIDs.indexOf(pRow.IDLabQueue) >= 0); }).map((pRow) => { return pRow.IDMaterialIntake; }));
						let fCase = (fTest) => { return tmpRows.LabForm.some((pRow) => { return tmpEligible.has(pRow.IDMaterialIntake) && fTest(pRow); }); };
						Expect(fCase((pRow) => { return (pRow.OwnerIDUser === 1) && (pRow.Status === 'Pending') && (pRow.Deleted === 0); })).to.equal(true);
						Expect(fCase((pRow) => { return (pRow.OwnerIDUser === 1) && (pRow.Status === 'Complete') && (pRow.Deleted === 0); })).to.equal(true);
						Expect(fCase((pRow) => { return (pRow.OwnerIDUser === 1) && (pRow.Status === 'Complete') && (pRow.Deleted === 1); })).to.equal(true);
						Expect(fCase((pRow) => { return (pRow.IDCustomer === 2) && (pRow.Status === 'Complete'); })).to.equal(true);
						Expect(fCase((pRow) => { return (pRow.OwnerIDUser === 1) && (pRow.Status === null); })).to.equal(true);
						Expect(fCase((pRow) => { return (pRow.OwnerIDUser === 3) && (pRow.Status === 'Complete'); })).to.equal(true);
						// ≥ 20 ISO weeks of ReceivedDate
						let tmpDB = new DatabaseSync(':memory:');
						libLabTrackSeed.build(tmpDB);
						let tmpWeeks = sqlAll(tmpDB, `SELECT count(DISTINCT ${sqlWeek('ReceivedDate')}) AS N FROM MaterialIntake WHERE ReceivedDate IS NOT NULL`)[0].N;
						Expect(tmpWeeks).to.be.at.least(20);
						tmpDB.close();
					});
			}
		);

		// ================================================================ 2–3. ProjectTrack: harness, Reference across entities
		suite
		(
			'ProjectTrack (harness, hand-built FoldIR vs hand-written SQL)',
			() =>
			{
				let _Harness = null;
				let _DB = null;
				let _Traps = null;

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Domain: 'ProjectTrack' },
						(pError) =>
						{
							if (!pError)
							{
								_DB = _Harness.db;
								_Traps = _Harness.traps;
							}
							return fDone(pError);
						});
				});
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				// ------------------------------------------------------------ harness
				test('the harness exposes the domain: principals, traps, as(), the merged options and the provider',
					() =>
					{
						Expect(_Harness.options.Fixture).to.equal('ProjectTrack');
						Expect(_Harness.provider).to.equal('SQLite');
						Expect(_Harness.connection.Provider).to.equal('SQLite');
						Expect(_Harness.as('Lead')).to.deep.equal({ Tenant: 1, User: 1 });
						Expect(_Harness.as('OtherLead')).to.deep.equal({ Tenant: 2, User: 31 });
						Expect(() => { _Harness.as('Nobody'); }).to.throw(/unknown principal/);
						Expect(_Traps.E1ClientIDs).to.deep.equal([ 3, 9 ]);
						Expect(_Harness.facetingOptions.Scope.Policy.Column).to.equal('IDCustomer');
						Expect(_Harness.facetingOptions.Definitions.Files).to.deep.equal([ libProjectTrackSeed.DEFINITIONS_PATH ]);
						Expect(_Harness.facetingOptions.Catalog.GlobalEntities).to.deep.equal([ 'FormType' ]);
						Expect(_Harness.tenancyEntities.indexOf('FormType')).to.equal(-1);
						Expect(_Harness.tenancyEntities.indexOf('Project')).to.be.at.least(0);
						Expect(libHarness.DOMAINS.LabTrack).to.equal(libLabTrackSeed);
						Expect(libHarness.domainOptions('Bookstore')).to.deep.equal({});
						Expect(libHarness.domainOptions('Bookstore-Tenant').Scope.Policy.Column).to.equal('IDTenant');
						Expect(() => { libHarness.domainSeed('Nope'); }).to.throw(/unknown fixture/);
					});

				test('the domain tenancy behavior scopes every list (and its count) to the session tenant; FormType is global; anonymous is 401',
					(fDone) =>
					{
						_Harness.listRows('Project', null, _Harness.as('Lead'),
							(pError, pRows) =>
							{
								Expect(pError).to.not.exist;
								Expect(pRows.length).to.equal(_Harness.seed.TenantLiveCounts[1].Project);
								Expect(pRows.every((pRow) => { return pRow.IDCustomer === 1; })).to.equal(true);
								_Harness.listCount('Project', null, _Harness.as('OtherLead'),
									(pCountError, pCount) =>
									{
										Expect(pCount).to.equal(_Harness.seed.TenantLiveCounts[2].Project);
										_Harness.listCount('FormType', null, _Harness.as('OtherLead'),
											(pFormError, pForms) =>
											{
												Expect(pForms).to.equal(12);
												_Harness.listCount('Project', null, {},
													(pAnonymousError) =>
													{
														Expect(pAnonymousError).to.be.an('error');
														Expect(pAnonymousError.message).to.match(/401/);
														return fDone();
													});
											});
									});
							});
					});

				test('auto facets on the domain: Live == Reference (O1) as every principal, and O2 through the list',
					(fDone) =>
					{
						let tmpBody =
							{
								Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active', 'AtRisk' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' } ],
								Facets: [ { Key: 'Status', Facet: 'Project.Status' }, { Key: 'Client', Facet: 'Project.IDClient', Top: 20 }, { Key: 'Started', Facet: 'Project.StartDate', Interval: 'quarter' } ],
								Total: true
							};
						let tmpNames = [ 'Lead', 'Member', 'Outsider', 'OtherLead' ];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpNames.length)
							{
								return fDone();
							}
							let tmpPrincipal = _Harness.as(tmpNames[pIndex]);
							_Harness.compare('Project', tmpBody, tmpPrincipal,
								(pError, pResult) =>
								{
									Expect(pError).to.not.exist;
									Expect(pResult.Live.Status).to.equal(200);
									Expect(pResult.LiveNormalized).to.deep.equal(pResult.ReferenceNormalized);
									_Harness.assertSelectionRoundTrip('Project', tmpBody, pResult.Live.Body, tmpPrincipal,
										(pRoundTripError, pReport) =>
										{
											Expect(pRoundTripError, JSON.stringify(pReport && pReport.Mismatches)).to.not.exist;
											Expect(pReport.CountVia).to.equal('List');
											Expect(pReport.Checked).to.be.above(5);
											return fNext(pIndex + 1);
										});
								});
						};
						return fNext(0);
					});

				test('O2 counted through the Reference (CountVia: Reference) agrees with the list on the same body',
					(fDone) =>
					{
						let tmpBody =
							{
								Clauses: [ { Type: 'DateRange', FilterByColumn: 'StartDate', Values: { Start: '2026-01-01 00:00:00', End: '2027-01-01 00:00:00' }, EndExclusive: true, FilterKey: 'StartDate', Hash: 'StartDate-DR-1' } ],
								Facets: [ { Key: 'Status', Facet: 'Project.Status' }, { Key: 'Started', Facet: 'Project.StartDate', Interval: 'month' } ],
								Total: true
							};
						let tmpPrincipal = Object.assign({ CountVia: 'Reference', Now: TEST_NOW }, _Harness.as('Lead'));
						_Harness.facetQuery('Project', tmpBody, tmpPrincipal,
							(pError, pResponse) =>
							{
								Expect(pResponse.Status).to.equal(200);
								_Harness.assertSelectionRoundTrip('Project', tmpBody, pResponse.Body, tmpPrincipal,
									(pRoundTripError, pReport) =>
									{
										Expect(pRoundTripError, JSON.stringify(pReport && pReport.Mismatches)).to.not.exist;
										Expect(pReport.CountVia).to.equal('Reference');
										Expect(pReport.Checked).to.be.above(5);
										// A wrong count is caught (the oracle is not tautological)
										let tmpBroken = clone(pResponse.Body);
										tmpBroken.Facets.Status.Buckets[0].Count += 1;
										_Harness.assertSelectionRoundTrip('Project', tmpBody, tmpBroken, tmpPrincipal,
											(pBrokenError, pBrokenReport) =>
											{
												Expect(pBrokenError).to.be.an('error');
												Expect(pBrokenReport.Mismatches.some((pMismatch) => { return pMismatch.Check === 'BucketCount'; })).to.equal(true);
												return fDone();
											});
									});
							});
					});

				test('FK labels never resolve through another tenant\'s row; bucket keys come only from rows the principal sees (isolation helper)',
					(fDone) =>
					{
						let tmpBody = { Facets: [ { Key: 'Client', Facet: 'Project.IDClient', Top: 50 }, { Key: 'Status', Facet: 'Project.Status' } ], Total: true };
						_Harness.facetQuery('Project', tmpBody, _Harness.as('Lead'),
							(pError, pLead) =>
							{
								let tmpBuckets = pLead.Body.Facets.Client.Buckets;
								let tmpCross = tmpBuckets.find((pBucket) => { return pBucket.Key === _Traps.CrossTenantClientID; });
								let tmpDeleted = tmpBuckets.find((pBucket) => { return pBucket.Key === _Traps.DeletedClientID; });
								let tmpOwn = tmpBuckets.find((pBucket) => { return pBucket.Key === 3; });
								Expect(tmpCross.LabelResolved).to.equal(false);
								Expect(tmpCross.Label).to.equal(String(_Traps.CrossTenantClientID));
								Expect(tmpDeleted.LabelResolved).to.equal(false);
								Expect(tmpOwn.LabelResolved).to.equal(true);
								Expect(tmpOwn.Label).to.equal('Cobalt Works');
								Expect(pLead.Body.Facets.Status.Buckets.some((pBucket) => { return pBucket.Key === 'Cancelled'; })).to.equal(false);
								_Harness.facetQuery('Project', tmpBody, _Harness.as('OtherLead'),
									(pOtherError, pOther) =>
									{
										let tmpTenantOneClient = pOther.Body.Facets.Client.Buckets.find((pBucket) => { return pBucket.Key === 3; });
										Expect(tmpTenantOneClient.LabelResolved).to.equal(false);
										Expect(tmpTenantOneClient.Label).to.equal('3');
										_Harness.assertTenantIsolation('Project', tmpBody, [ 'Lead', 'Member', 'OtherLead' ], { Keys: false },
											(pIsolationError, pReport) =>
											{
												Expect(pIsolationError, JSON.stringify(pReport && pReport.Mismatches)).to.not.exist;
												Expect(pReport.Principals.Lead.Buckets).to.be.above(5);
												Expect(pReport.Principals.OtherLead.Buckets).to.be.above(2);
												return fDone();
											});
									});
							});
					});

				test('visibleRows (the isolation oracle\'s view of the seed) follows the tenant, the soft delete and global lookups',
					(fDone) =>
					{
						let tmpVisible = _Harness.visibleRows('Client', _Harness.as('Lead')).map((pRow) => { return pRow.IDClient; });
						Expect(tmpVisible.indexOf(_Traps.CrossTenantClientID)).to.equal(-1);
						Expect(tmpVisible.indexOf(_Traps.DeletedClientID)).to.equal(-1);
						Expect(tmpVisible.indexOf(3)).to.be.at.least(0);
						Expect(_Harness.visibleRows('FormType', _Harness.as('OtherLead')).length).to.equal(12);
						return fDone();
					});

				test('expectedExclusion learns join clauses (L3 → the connection column) and never excludes scopes; needsReferenceCount',
					() =>
					{
						let tmpBody = e1Body({ E1ClientIDs: [ 3, 9 ] });
						Expect(libHarness.expectedExclusion(tmpBody, { Key: 'Client', Facet: 'Project.IDClient' })).to.deep.equal([ 'IDClient-IJ-1' ]);
						Expect(libHarness.expectedExclusion(tmpBody, { Key: 'Status', Facet: 'Project.Status' })).to.deep.equal([ 'Status-DSVL-1' ]);
						Expect(libHarness.expectedExclusion(tmpBody, { Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' })).to.deep.equal([]);
						Expect(libHarness.expectedExclusion(tmpBody, { Key: 'X', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' })).to.equal(null);
						let tmpNamed = { Clauses: [ { Type: 'NamedScope', Scope: 'Project.HasMyOverdue' }, { Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active' ] } ] };
						Expect(libHarness.expectedExclusion(tmpNamed, { Key: 'Status', Facet: 'Project.Status' })).to.deep.equal([ 'c2' ]);
						let tmpMatch = { Clauses: [ { Type: 'InternalJoinMatch', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', ExternalFilterByColumns: [ 'Name' ], Values: [ 'Acme' ] } ] };
						Expect(libHarness.expectedExclusion(tmpMatch, { Key: 'Client', Facet: 'Project.IDClient' })).to.deep.equal([]);
						Expect(libHarness.needsReferenceCount(tmpBody)).to.equal(true);
						Expect(libHarness.needsReferenceCount(tmpNamed)).to.equal(true);
						Expect(libHarness.needsReferenceCount({ Clauses: [ { Type: 'DateRange', FilterByColumn: 'StartDate', Values: { Start: '2026-01-01' } } ] })).to.equal(false);
						Expect(libHarness.internalOptions({ Now: TEST_NOW, PlanForm: { Cube: 'Never' }, Tenant: 1 }, { ForceEngine: 'Reference' })).to.deep.equal({ ForceEngine: 'Reference', Now: TEST_NOW, PlanForm: { Cube: 'Never' } });
					});

				// ------------------------------------------------------------ E1 (hand-built FoldIR)
				test('E1 as Lead: Total, Status, Client, Started, MyOverdue bands and Status × Client equal hand-written SQL',
					(fDone) =>
					{
						let tmpIR = e1FoldIR(1);
						runReference(_Harness, 'Project', tmpIR.Variants, tmpIR.Aggs, 'Lead',
							(pError, pExecution, pContext) =>
							{
								Expect(pError).to.not.exist;
								Expect(pExecution.Errors).to.deep.equal({});
								let tmpBinds = { t: 1, u: 1, now: NOW };
								let tmpResults = pExecution.Results;

								let tmpIDs = sqlAll(_DB, `SELECT p.IDProject AS ID FROM Project p WHERE ${e1Where({})}`, tmpBinds).map((pRow) => { return pRow.ID; });
								Expect(tmpResults['#Total'].Total).to.equal(tmpIDs.length);
								_Traps.E1StoryProjectIDs.forEach((pID) => { Expect(tmpIDs, `project ${pID} is in E1`).to.include(pID); });
								// blocked, inactive / deleted membership, no overdue, deleted project, OnHold, 2025, other clients, Member role
								[ 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19 ].forEach((pID) => { Expect(tmpIDs, `project ${pID} is not in E1`).to.not.include(pID); });

								let tmpStatus = splitNull(keyCounts(sqlAll(_DB, `SELECT p.Status AS K, count(*) AS N FROM Project p WHERE ${e1Where({ Status: false })} GROUP BY p.Status`, tmpBinds)));
								Expect(groupMap(tmpResults.Status.Groups)).to.deep.equal(tmpStatus[0]);
								Expect(tmpResults.Status.MissingCount).to.equal(tmpStatus[1]);
								Expect(tmpStatus[0].OnHold).to.be.at.least(1);

								let tmpClient = splitNull(keyCounts(sqlAll(_DB, `SELECT p.IDClient AS K, count(*) AS N FROM Project p WHERE ${e1Where({ Client: false })} GROUP BY p.IDClient`, tmpBinds)));
								Expect(groupMap(tmpResults.Client.Groups)).to.deep.equal(tmpClient[0]);
								Expect(tmpResults.Client.MissingCount).to.equal(tmpClient[1]);
								Expect(tmpClient[0][String(_Traps.DeletedClientID)]).to.be.at.least(1);
								Expect(tmpClient[0][String(_Traps.CrossTenantClientID)]).to.be.at.least(1);

								let tmpStarted = splitNull(keyCounts(sqlAll(_DB, `SELECT strftime('%Y-%m-01 00:00:00', p.StartDate) AS K, count(*) AS N FROM Project p WHERE ${e1Where({ Start: false })} GROUP BY K`, tmpBinds)));
								Expect(groupMap(tmpResults.Started.Groups)).to.deep.equal(tmpStarted[0]);
								Expect(tmpResults.Started.MissingCount).to.equal(tmpStarted[1]);
								Expect(tmpStarted[1]).to.be.at.least(1);
								Expect(tmpStarted[0]['2025-12-01 00:00:00']).to.be.at.least(1);
								let tmpBounds = sqlAll(_DB, `SELECT min(p.StartDate) AS Lo, max(p.StartDate) AS Hi FROM Project p WHERE ${e1Where({ Start: false })}`, tmpBinds)[0];
								Expect(tmpResults.Started.Bounds).to.deep.equal({ Lo: tmpBounds.Lo, Hi: tmpBounds.Hi });

								let tmpBands = keyCounts(sqlAll(_DB, `SELECT ${BAND_SQL} AS K, count(*) AS N FROM Project p WHERE ${e1Where({})} GROUP BY K`, tmpBinds));
								Expect(groupMap(tmpResults.MyOverdue.Groups)).to.deep.equal(tmpBands);
								Expect(tmpResults.MyOverdue.MissingCount).to.equal(0);
								Expect(tmpResults.MyOverdue.Total).to.equal(tmpIDs.length);
								[ '1', '2', '3' ].forEach((pBand) => { Expect(tmpBands[pBand], `band ${pBand}`).to.be.at.least(1); });

								let tmpCells = {};
								sqlAll(_DB, `SELECT p.Status AS A, p.IDClient AS B, count(*) AS N FROM Project p WHERE ${e1Where({})} GROUP BY p.Status, p.IDClient`, tmpBinds).forEach((pRow) => { tmpCells[JSON.stringify([ pRow.A, pRow.B ])] = pRow.N; });
								let tmpActualCells = {};
								tmpResults.StatusByClient.Cells.forEach((pCell) => { tmpActualCells[JSON.stringify(pCell.Keys)] = pCell.Count; });
								Expect(tmpActualCells).to.deep.equal(tmpCells);

								// Every hop entity was read through its own list, under its own capture fingerprint
								[ 'Project', 'Client', 'ProjectMembership', 'Task', 'Issue' ].forEach((pEntity) => { Expect(pExecution.Captures[pEntity], pEntity).to.be.an('object'); });
								Expect(pExecution.Captures.Client.Fingerprint).to.match(/^ref:hop:Client\|Inherit\|wh:/);
								Expect(pExecution.Captures.Project.Fingerprint).to.match(/^ref:/);
								// One read for the Task hop AND the band's child (same relation, alias excluded from the memo)
								Expect(Object.keys(pContext.Memo.HopRows).filter((pKey) => { return /^Task\|/.test(pKey); }).length).to.equal(1);
								// The Or's OwnerIDUser leaf is list MEMBERSHIP: one Project read narrowed by it
								Expect(Object.keys(pContext.Memo.HopRows).some((pKey) => { return /^Project\|Inherit\|c1,c3\|Explicit\|wh:/.test(pKey); })).to.equal(true);
								Expect(pExecution.Statements).to.equal(pContext.Counters.Statements);
								return fDone();
							});
					});

				test('E1 as every other principal equals the same SQL (Member and Outsider see nothing; OtherLead sees tenant 2 only)',
					(fDone) =>
					{
						let tmpNames = [ 'Member', 'Outsider', 'OtherLead' ];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpNames.length)
							{
								return fDone();
							}
							let tmpPrincipal = _Harness.as(tmpNames[pIndex]);
							let tmpIR = e1FoldIR(tmpPrincipal.User);
							runReference(_Harness, 'Project', tmpIR.Variants, tmpIR.Aggs, tmpNames[pIndex],
								(pError, pExecution) =>
								{
									Expect(pError).to.not.exist;
									let tmpBinds = { t: tmpPrincipal.Tenant, u: tmpPrincipal.User, now: NOW };
									Expect(pExecution.Results['#Total'].Total).to.equal(sqlAll(_DB, `SELECT count(*) AS N FROM Project p WHERE ${e1Where({})}`, tmpBinds)[0].N);
									let tmpClient = splitNull(keyCounts(sqlAll(_DB, `SELECT p.IDClient AS K, count(*) AS N FROM Project p WHERE ${e1Where({ Client: false })} GROUP BY p.IDClient`, tmpBinds)));
									Expect(groupMap(pExecution.Results.Client.Groups)).to.deep.equal(tmpClient[0]);
									if (tmpNames[pIndex] === 'OtherLead')
									{
										// The tenant-2 project on tenant-1 client 3 is in the Client facet (its own FK value)…
										Expect(tmpClient[0]['3']).to.be.at.least(1);
										// …but no E1 row: client 3 is invisible to tenant 2, so the existence check fails
										Expect(pExecution.Results['#Total'].Total).to.equal(0);
									}
									if (tmpNames[pIndex] !== 'OtherLead')
									{
										Expect(pExecution.Results['#Total'].Total).to.equal(0);
									}
									return fNext(pIndex + 1);
								});
						};
						return fNext(0);
					});

				test('an anonymous request is FACET_UNAUTHENTICATED for the whole request (the pivot list behavior is 401)',
					(fDone) =>
					{
						let tmpIR = e1FoldIR(1);
						runReference(_Harness, 'Project', tmpIR.Variants, tmpIR.Aggs, {},
							(pError) =>
							{
								Expect(pError).to.be.an('error');
								Expect(pError.Code).to.equal('FACET_UNAUTHENTICATED');
								// …and the engine itself (no principal): the pivot read's behavior answers 401
								newContext(_Harness, 'Project', tmpIR.Variants, { Tenant: 1, User: 1 },
									(pContextError, pContext) =>
									{
										pContext.Request = libHarness.syntheticRequest('Project', {});
										_Harness.fable.RetoldFacetingEngineReference.execute(pContext, tmpIR.Aggs,
											(pEngineError) =>
											{
												setImmediate(
													() =>
													{
														Expect(pEngineError.Code).to.equal('FACET_UNAUTHENTICATED');
														return fDone();
													});
											});
									});
							});
					});

				test('Records / Count / Keys oracle helpers: the E1 base ordered by StartDate (NULLs last both ways, PK tie-break) and paged',
					(fDone) =>
					{
						let tmpIR = e1FoldIR(1);
						// A wider base (no Status / Client / StartDate clause) so NULL StartDates and ties occur
						let tmpBase = { Variant: variant('v0', 'Project', [], tmpIR.Variants.v2.PathPred), Pivot: 'Project' };
						let tmpBinds = { t: 1, u: 1, now: NOW };
						let tmpWhere = e1Where({ Status: false, Client: false, Start: false });
						let tmpDescending = sqlAll(_DB, `SELECT p.IDProject AS ID FROM Project p WHERE ${tmpWhere} ORDER BY CASE WHEN p.StartDate IS NULL THEN 1 ELSE 0 END, p.StartDate DESC, p.IDProject ASC`, tmpBinds).map((pRow) => { return pRow.ID; });
						let tmpAscending = sqlAll(_DB, `SELECT p.IDProject AS ID FROM Project p WHERE ${tmpWhere} ORDER BY CASE WHEN p.StartDate IS NULL THEN 1 ELSE 0 END, p.StartDate ASC, p.IDProject ASC`, tmpBinds).map((pRow) => { return pRow.ID; });
						Expect(tmpDescending.length).to.be.above(8);
						newContext(_Harness, 'Project', {}, 'Lead',
							(pContextError, pContext) =>
							{
								let tmpEngine = _Harness.fable.RetoldFacetingEngineReference;
								tmpEngine.recordKeys(pContext, tmpBase, { Sort: [ { Field: 'StartDate', Dir: 'DESC' } ], Begin: 0, Cap: 500 },
									(pError, pResult) =>
									{
										Expect(pError).to.not.exist;
										Expect(pResult.Keys).to.deep.equal(tmpDescending);
										tmpEngine.recordKeys(pContext, tmpBase, { Sort: [ { Field: 'StartDate', Dir: 'ASC' } ], Begin: 2, Cap: 3 },
											(pPageError, pPage) =>
											{
												Expect(pPage.Keys).to.deep.equal(tmpAscending.slice(2, 5));
												// The base rows are memoized per context: the second page read nothing new
												Expect(pPage.Statements).to.equal(0);
												tmpEngine.countBase(pContext, tmpBase,
													(pCountError, pCount) =>
													{
														Expect(pCount).to.equal(tmpDescending.length);
														tmpEngine.keys(pContext, tmpBase, { Cap: 3 },
															(pKeysError, pKeys) =>
															{
																Expect(pKeys.Keys).to.deep.equal(tmpDescending.slice().sort((pA, pB) => { return pA - pB; }).slice(0, 3));
																Expect(pKeys.Count).to.equal(tmpDescending.length);
																Expect(pKeys.Truncated).to.equal(true);
																return fDone();
															});
													});
											});
									});
							});
					});

				// ------------------------------------------------------------ coverage kinds (hand-built FoldIR)
				test('K8 over two hops (Document → Project → Client): invisible, deleted and cross-tenant targets land in Missing',
					(fDone) =>
					{
						let tmpLookup = (pEntity, pAs) => { return rel(pEntity, pAs, null, { Role: 'Lookup' }); };
						let tmpAggs =
							[
								agg('ByClient', 'Terms', 'v0', { Dimensions: [ columnDim('IDClient', 'Numeric', { Via: [ { Rel: tmpLookup('Project', 'l1'), On: [ on('p', 'IDProject', 'IDProject') ] }, { Rel: tmpLookup('Client', 'l2'), On: [ on('l1', 'IDClient', 'IDClient') ] } ] }) ] })
							];
						runReference(_Harness, 'Document', { v0: variant('v0', 'Document', [], null) }, tmpAggs, 'Lead',
							(pError, pExecution) =>
							{
								Expect(pError).to.not.exist;
								let tmpSQL = 'SELECT (SELECT c.IDClient FROM Project pr JOIN Client c ON c.IDClient = pr.IDClient WHERE pr.IDProject = d.IDProject AND pr.IDCustomer = $t AND pr.Deleted = 0 AND c.IDCustomer = $t AND c.Deleted = 0) AS K, count(*) AS N'
									+ ' FROM Document d WHERE d.IDCustomer = $t AND d.Deleted = 0 GROUP BY K';
								let tmpExpected = splitNull(keyCounts(sqlAll(_DB, tmpSQL, { t: 1 })));
								Expect(groupMap(pExecution.Results.ByClient.Groups)).to.deep.equal(tmpExpected[0]);
								Expect(pExecution.Results.ByClient.MissingCount).to.equal(tmpExpected[1]);
								// Documents on the deleted project, a tenant-2 project, or no project are Missing
								let tmpMissingFloor = sqlAll(_DB, 'SELECT count(*) AS N FROM Document d WHERE d.IDCustomer = 1 AND d.Deleted = 0 AND (d.IDProject IS NULL OR d.IDProject = $deleted OR d.IDProject = $cross)', { deleted: _Traps.DeletedProjectID, cross: _Traps.CrossTenantProjectID })[0].N;
								Expect(pExecution.Results.ByClient.MissingCount).to.be.at.least(tmpMissingFloor);
								Expect(tmpMissingFloor).to.be.at.least(3);
								Expect(tmpExpected[0][String(_Traps.DeletedClientID)]).to.equal(undefined);
								Expect(tmpExpected[0][String(_Traps.CrossTenantClientID)]).to.equal(undefined);
								return fDone();
							});
					});

				test('K9 multi-valued (projects by active member): distinct pivot rows per key, Missing = no key, tenant-2 rows never count',
					(fDone) =>
					{
						let tmpMulti = { Kind: 'Multi', Chain: [ { Rel: rel('ProjectMembership', 'm1', leaf('Active', 'EQ', 1), { Role: 'Multi' }), On: [ on('p', 'IDProject', 'IDProject') ] } ], Where: null, KeyField: 'IDUser', DataType: 'Numeric', IsInteger: true, Scale: 0 };
						let tmpAggs = [ agg('ByMember', 'Terms', 'v0', { Dimensions: [ tmpMulti ], CountMode: 'PivotDistinct', MultiValued: true }) ];
						runReference(_Harness, 'Project', { v0: variant('v0', 'Project', [], null) }, tmpAggs, 'Lead',
							(pError, pExecution) =>
							{
								Expect(pError).to.not.exist;
								let tmpRaw = pExecution.Results.ByMember;
								let tmpGroups = keyCounts(sqlAll(_DB, 'SELECT m.IDUser AS K, count(DISTINCT p.IDProject) AS N FROM Project p JOIN ProjectMembership m ON m.IDProject = p.IDProject'
									+ ' WHERE p.IDCustomer = 1 AND p.Deleted = 0 AND m.IDCustomer = 1 AND m.Deleted = 0 AND m.Active = 1 AND m.IDUser IS NOT NULL GROUP BY m.IDUser'));
								Expect(groupMap(tmpRaw.Groups)).to.deep.equal(tmpGroups);
								Expect(tmpRaw.DistinctKeys).to.equal(Object.keys(tmpGroups).length);
								let tmpMissing = sqlAll(_DB, 'SELECT count(*) AS N FROM Project p WHERE p.IDCustomer = 1 AND p.Deleted = 0 AND NOT EXISTS (SELECT 1 FROM ProjectMembership m WHERE m.IDProject = p.IDProject AND m.IDCustomer = 1 AND m.Deleted = 0 AND m.Active = 1 AND m.IDUser IS NOT NULL)')[0].N;
								Expect(tmpRaw.MissingCount).to.equal(tmpMissing);
								Expect(tmpRaw.Total).to.equal(_Harness.seed.TenantLiveCounts[1].Project);
								// Multi-valued: the sum of the groups exceeds the pivot rows that have a key
								let tmpSum = tmpRaw.Groups.reduce((pSum, pGroup) => { return pSum + pGroup.Count; }, 0);
								Expect(tmpSum).to.be.above(tmpRaw.Total - tmpRaw.MissingCount);
								// The tenant-2 membership of OtherLead on tenant-1 project 1 never counts
								Expect(tmpGroups['31']).to.equal(undefined);
								return fDone();
							});
					});

				test('K10 two hops (documents in my projects), K19 HavingCount and K20 ExistsSplit equal SQL',
					(fDone) =>
					{
						let tmpInMyProjects = exists(rel('Project', 'h1', null), [ on('p', 'IDProject', 'IDProject') ],
							exists(rel('ProjectMembership', 'h2', allOf(leaf('IDUser', 'EQ', 1), leaf('Active', 'EQ', 1))), [ on('h1', 'IDProject', 'IDProject') ]));
						runReference(_Harness, 'Document', { v0: variant('v0', 'Document', [], tmpInMyProjects) },
							[ agg('#Total', 'Count', 'v0'), agg('Status', 'Terms', 'v0', { Dimensions: [ columnDim('Status', 'String') ] }) ], 'Lead',
							(pError, pExecution) =>
							{
								Expect(pError).to.not.exist;
								let tmpDocuments = 'FROM Document d WHERE d.IDCustomer = 1 AND d.Deleted = 0 AND EXISTS (SELECT 1 FROM Project pr WHERE pr.IDProject = d.IDProject AND pr.IDCustomer = 1 AND pr.Deleted = 0'
									+ ' AND EXISTS (SELECT 1 FROM ProjectMembership m WHERE m.IDProject = pr.IDProject AND m.IDCustomer = 1 AND m.Deleted = 0 AND m.IDUser = 1 AND m.Active = 1))';
								Expect(pExecution.Results['#Total'].Total).to.equal(sqlAll(_DB, `SELECT count(*) AS N ${tmpDocuments}`)[0].N);
								Expect(groupMap(pExecution.Results.Status.Groups)).to.deep.equal(splitNull(keyCounts(sqlAll(_DB, `SELECT d.Status AS K, count(*) AS N ${tmpDocuments} GROUP BY d.Status`)))[0]);

								let tmpOverdue = rel('Task', 'h1', allOf(leaf('DueDate', 'LT', NOW), leaf('Status', 'NE', 'Done')));
								let tmpVariants =
									{
										v0: variant('v0', 'Project', [], countCmp(tmpOverdue, [ on('p', 'IDProject', 'IDProject') ], null, 'GE', 2)),
										v1: variant('v1', 'Project', [], countCmp(tmpOverdue, [ on('p', 'IDProject', 'IDProject') ], null, 'LT', 2)),
										v2: variant('v2', 'Project', [], countCmp(tmpOverdue, [ on('p', 'IDProject', 'IDProject') ], null, 'EQ', 0)),
										v3: variant('v3', 'Project', [], null)
									};
								let tmpSplit = { Kind: 'ExistsFlag', DataType: 'Boolean', IsInteger: true, Scale: 0, Pred: exists(rel('Issue', 'e1', leaf('State', 'EQ', 'Open')), [ on('p', 'IDProject', 'IDProject') ]) };
								runReference(_Harness, 'Project', tmpVariants,
									[ agg('Many', 'Count', 'v0'), agg('Few', 'Count', 'v1'), agg('None', 'Count', 'v2'), agg('HasOpen', 'ExistsSplit', 'v3', { Dimensions: [ tmpSplit ] }) ], 'Lead',
									(pProjectError, pProjects) =>
									{
										Expect(pProjectError).to.not.exist;
										let tmpCount = '(SELECT count(*) FROM Task k WHERE k.IDProject = p.IDProject AND k.IDCustomer = 1 AND k.Deleted = 0 AND k.DueDate < $now AND k.Status != \'Done\')';
										let fProjects = (pCondition) => { return sqlAll(_DB, `SELECT count(*) AS N FROM Project p WHERE p.IDCustomer = 1 AND p.Deleted = 0 AND ${pCondition}`, (pCondition.indexOf('$now') >= 0) ? { now: NOW } : null)[0].N; };
										Expect(pProjects.Results.Many.Total).to.equal(fProjects(`${tmpCount} >= 2`));
										Expect(pProjects.Results.Few.Total).to.equal(fProjects(`${tmpCount} < 2`));
										Expect(pProjects.Results.None.Total).to.equal(fProjects(`${tmpCount} = 0`));
										Expect(pProjects.Results.Many.Total + pProjects.Results.Few.Total).to.equal(_Harness.seed.TenantLiveCounts[1].Project);
										let tmpOpen = fProjects('EXISTS (SELECT 1 FROM Issue i WHERE i.IDProject = p.IDProject AND i.IDCustomer = 1 AND i.Deleted = 0 AND i.State = \'Open\')');
										Expect(groupMap(pProjects.Results.HasOpen.Groups)).to.deep.equal({ 1: tmpOpen, 0: _Harness.seed.TenantLiveCounts[1].Project - tmpOpen });
										Expect(pProjects.Results.HasOpen.Groups[0].Key).to.equal(1);
										return fDone();
									});
							});
					});

				test('a definition Where of column leaves is ONE membership read (Or with IS NULL), equal to SQL',
					(fDone) =>
					{
						let tmpWhere = or(cmp('p', 'Status', 'IN', [ 'Active', 'AtRisk' ]), cmp('p', 'StartDate', 'NULL'));
						runReference(_Harness, 'Project', { v0: variant('v0', 'Project', [], null) },
							[ agg('Status', 'Terms', 'v0', { Dimensions: [ columnDim('Status', 'String') ], Where: tmpWhere, WhereHash: 'wh:x' }) ], 'Lead',
							(pError, pExecution, pContext) =>
							{
								Expect(pError).to.not.exist;
								let tmpExpected = splitNull(keyCounts(sqlAll(_DB, 'SELECT p.Status AS K, count(*) AS N FROM Project p WHERE p.IDCustomer = 1 AND p.Deleted = 0 AND (p.Status IN (\'Active\', \'AtRisk\') OR p.StartDate IS NULL) GROUP BY p.Status')));
								Expect(groupMap(pExecution.Results.Status.Groups)).to.deep.equal(tmpExpected[0]);
								Expect(pExecution.Results.Status.MissingCount).to.equal(tmpExpected[1]);
								Expect(Object.keys(pContext.Memo.HopRows).filter((pKey) => { return /^Project\|/.test(pKey); }).length).to.equal(2);
								return fDone();
							});
					});

				test('O1 on the hand-built FoldIR: the Live engine equals the Reference for E1 (every principal) and the coverage kinds',
					(fDone) =>
					{
						let tmpLookup = (pEntity, pAs) => { return rel(pEntity, pAs, null, { Role: 'Lookup' }); };
						let tmpOverdue = rel('Task', 'h1', allOf(leaf('DueDate', 'LT', NOW), leaf('Status', 'NE', 'Done')));
						let tmpCases = [ 'Lead', 'Member', 'OtherLead' ].map(
							(pName) =>
							{
								let tmpIR = e1FoldIR(_Harness.as(pName).User);
								return { Entity: 'Project', Variants: tmpIR.Variants, Aggs: tmpIR.Aggs, Principal: pName };
							});
						tmpCases.push(
							{
								Entity: 'Document', Principal: 'Lead',
								Variants: { v0: variant('v0', 'Document', [], exists(rel('Project', 'h1', null), [ on('p', 'IDProject', 'IDProject') ], exists(rel('ProjectMembership', 'h2', allOf(leaf('IDUser', 'EQ', 1), leaf('Active', 'EQ', 1))), [ on('h1', 'IDProject', 'IDProject') ]))), v1: variant('v1', 'Document', [], null) },
								Aggs:
									[
										agg('#Total', 'Count', 'v0'),
										agg('ByClient', 'Terms', 'v1', { Dimensions: [ columnDim('IDClient', 'Numeric', { Via: [ { Rel: tmpLookup('Project', 'l1'), On: [ on('p', 'IDProject', 'IDProject') ] }, { Rel: tmpLookup('Client', 'l2'), On: [ on('l1', 'IDClient', 'IDClient') ] } ] }) ] })
									]
							});
						tmpCases.push(
							{
								Entity: 'Project', Principal: 'Lead',
								Variants: { v0: variant('v0', 'Project', [], countCmp(tmpOverdue, [ on('p', 'IDProject', 'IDProject') ], null, 'GE', 2)), v1: variant('v1', 'Project', [], null) },
								Aggs:
									[
										agg('Many', 'Count', 'v0'),
										agg('ByMember', 'Terms', 'v1', { CountMode: 'PivotDistinct', MultiValued: true, Dimensions: [ { Kind: 'Multi', Chain: [ { Rel: rel('ProjectMembership', 'm1', leaf('Active', 'EQ', 1), { Role: 'Multi' }), On: [ on('p', 'IDProject', 'IDProject') ] } ], Where: null, KeyField: 'IDUser', DataType: 'Numeric', IsInteger: true, Scale: 0 } ] }),
										agg('HasOpen', 'ExistsSplit', 'v1', { Dimensions: [ { Kind: 'ExistsFlag', DataType: 'Boolean', IsInteger: true, Scale: 0, Pred: exists(rel('Issue', 'e1', leaf('State', 'EQ', 'Open')), [ on('p', 'IDProject', 'IDProject') ]) } ] }),
										agg('Status', 'Terms', 'v1', { Dimensions: [ columnDim('Status', 'String') ], Where: or(cmp('p', 'Status', 'IN', [ 'Active', 'AtRisk' ]), cmp('p', 'StartDate', 'NULL')), WhereHash: 'wh:x' })
									]
							});
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpCases.length)
							{
								return fDone();
							}
							let tmpCase = tmpCases[pIndex];
							crossCheck(_Harness, tmpCase.Entity, tmpCase.Variants, tmpCase.Aggs, tmpCase.Principal,
								(pError, pResult) =>
								{
									Expect(pError).to.not.exist;
									tmpCase.Aggs.forEach(
										(pAgg) =>
										{
											let tmpLabel = `${tmpCase.Entity} ${tmpCase.Principal} ${pAgg.Key}`;
											Expect(pResult.Live.Errors[pAgg.Key], `${tmpLabel} Live error`).to.equal(undefined);
											Expect(rawMismatch(pAgg, pResult.Live.Results[pAgg.Key], pResult.Reference.Results[pAgg.Key], _Harness.faceting.options.Limits.DefaultTop), tmpLabel).to.equal(null);
										});
									return fNext(pIndex + 1);
								});
						};
						return fNext(0);
					});

				test('TenantOnly on an entity without a personal scope is refused like Live: per facet for a facet hop, whole request for a filter hop',
					(fDone) =>
					{
						let tmpRelaxed = exists(rel('Task', 'h1', leaf('Status', 'EQ', 'Open'), { Scope: 'TenantOnly', ScopeReason: 'test' }), [ on('p', 'IDProject', 'IDProject') ]);
						runReference(_Harness, 'Project', { v0: variant('v0', 'Project', [], null) },
							[ agg('#Total', 'Count', 'v0'), agg('Open', 'Count', 'v0', { Where: tmpRelaxed, WhereHash: 'wh:open' }) ], 'Lead',
							(pError, pExecution) =>
							{
								Expect(pError).to.not.exist;
								Expect(pExecution.Results['#Total'].Total).to.equal(_Harness.seed.TenantLiveCounts[1].Project);
								Expect(pExecution.Errors.Open.Code).to.equal('FACET_SCOPE_POLICY_VIOLATION');
								Expect(pExecution.Errors.Open.Status).to.equal(500);
								Expect(pExecution.Errors.Open.Detail).to.equal(undefined);
								runReference(_Harness, 'Project', { v0: variant('v0', 'Project', [], tmpRelaxed) }, [ agg('#Total', 'Count', 'v0') ], 'Lead',
									(pWholeError) =>
									{
										Expect(pWholeError.Code).to.equal('FACET_SCOPE_POLICY_VIOLATION');
										Expect(pWholeError.Detail.Reason).to.equal('TenantOnlyRefused:NoPersonalScope');
										return fDone();
									});
							});
					});

				test('malformed FoldIR is FACET_INTERNAL, never a silent wrong answer',
					(fDone) =>
					{
						let tmpVariant = variant('v0', 'Project', [], null);
						// A Path-shaped conjunct the planner forgot to lower
						tmpVariant.Conjuncts = [ Object.assign(conjunct('c1', leaf('Status', 'EQ', 'Active')), { Shape: 'Path' }) ];
						runReference(_Harness, 'Project', { v0: tmpVariant }, [ agg('#Total', 'Count', 'v0') ], 'Lead',
							(pError) =>
							{
								Expect(pError.Code).to.equal('FACET_INTERNAL');
								let tmpUnbound = exists(rel('Task', 'h1', null), [ on('zz', 'IDProject', 'IDProject') ]);
								runReference(_Harness, 'Project', { v0: variant('v0', 'Project', [], null) }, [ agg('X', 'Count', 'v0', { Where: tmpUnbound }) ], 'Lead',
									(pAggError, pExecution) =>
									{
										Expect(pAggError).to.not.exist;
										Expect(pExecution.Errors.X.Code).to.equal('FACET_INTERNAL');
										let tmpEngine = new libRetoldFacetingEngineReference(new libFable({ LogStreams: [ { streamtype: 'console', level: 'fatal' } ] }));
										Expect(tmpEngine.capable({ Kind: 'ChildRollup' }, { ForceEngine: 'Reference' }).Capable).to.equal(true);
										Expect(tmpEngine.capable({ Kind: 'ExistsSplit' }, { ForceEngine: 'Reference' }).Capable).to.equal(true);
										Expect(tmpEngine.capable({ Kind: 'Terms' }, {}).Capable).to.equal(false);
										Expect(tmpEngine.bandOf(0, [ 1, 3, 10 ])).to.equal(0);
										Expect(tmpEngine.bandOf(2, [ 1, 3, 10 ])).to.equal(1);
										Expect(tmpEngine.bandOf(9, [ 1, 3, 10 ])).to.equal(2);
										Expect(tmpEngine.bandOf(10, [ 1, 3, 10 ])).to.equal(3);
										Expect(tmpEngine.equalityIdentity(null)).to.equal(null);
										Expect(tmpEngine.equalityIdentity(5)).to.equal(tmpEngine.equalityIdentity('5'));
										Expect(tmpEngine.equalityIdentity('a')).to.not.equal(tmpEngine.equalityIdentity('A'));
										// SQL equality is typed: a text column compares exactly ('007' is not '7'); a numeric
										// column compares the numbers ('007' = 7).
										Expect(tmpEngine.equalityIdentity('007', false)).to.not.equal(tmpEngine.equalityIdentity('7', false));
										Expect(tmpEngine.equalityIdentity('007', true)).to.equal(tmpEngine.equalityIdentity(7, true));
										Expect(tmpEngine.tupleIdentity([ '007', 3 ], [ false, true ])).to.not.equal(tmpEngine.tupleIdentity([ '7', '3' ], [ false, true ]));
										Expect(tmpEngine.tupleIdentity([ '007', 3 ], [ false, true ])).to.equal(tmpEngine.tupleIdentity([ '007', '3' ], [ false, true ]));
										// The Reference types an On pair by the inner column of the catalog.
										let tmpReal = _Harness.fable.RetoldFacetingEngineReference;
										Expect(tmpReal.numericColumn('Project', 'IDClient')).to.equal(true);
										Expect(tmpReal.numericColumn('Project', 'Status')).to.equal(false);
										Expect(tmpReal.numericColumn('Project', 'Nope')).to.equal(undefined);
										return fDone();
									});
							});
					});
			}
		);

		// ================================================================ 3. LabTrack: Reference across entities
		suite
		(
			'LabTrack (hand-built FoldIR vs hand-written SQL: co-reference anti-join, TenantOnly, owner scope, TuplePivot)',
			() =>
			{
				let _Harness = null;
				let _DB = null;
				let _Traps = null;

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'LabTrack' },
						(pError) =>
						{
							if (!pError)
							{
								_DB = _Harness.db;
								_Traps = _Harness.traps;
							}
							return fDone(pError);
						});
				});
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				test('the owner scope (PersonalScopes) is installed on LabForm: each technician\'s list holds only their own forms',
					(fDone) =>
					{
						Expect(_Harness.tenancyEntities.indexOf('LabFormType')).to.equal(-1);
						_Harness.listRows('LabForm', null, _Harness.as('Tech'),
							(pError, pRows) =>
							{
								let tmpOwn = sqlAll(_DB, 'SELECT count(*) AS N FROM LabForm WHERE IDCustomer = 1 AND Deleted = 0 AND OwnerIDUser = 1')[0].N;
								Expect(pRows.length).to.equal(tmpOwn);
								Expect(pRows.every((pRow) => { return (pRow.OwnerIDUser === 1) && (pRow.IDCustomer === 1); })).to.equal(true);
								_Harness.compare('LabForm', { Facets: [ { Key: 'Status', Facet: 'LabForm.Status' }, { Key: 'Type', Facet: 'LabForm.IDLabFormType' } ] }, _Harness.as('Colleague'),
									(pCompareError, pResult) =>
									{
										Expect(pResult.Live.Status).to.equal(200);
										Expect(pResult.LiveNormalized).to.deep.equal(pResult.ReferenceNormalized);
										Expect(pResult.Live.Body.Total).to.equal(sqlAll(_DB, 'SELECT count(*) AS N FROM LabForm WHERE IDCustomer = 1 AND Deleted = 0 AND OwnerIDUser = 2')[0].N);
										return fDone();
									});
							});
					});

				test('E3 variant A as Tech: ToDo, ByQueue, ByWeek, ByDiscipline and Started equal hand-written SQL; the story cases land as designed',
					(fDone) =>
					{
						let tmpIR = e3aFoldIR(1);
						runReference(_Harness, 'MaterialIntakeRequirement', tmpIR.Variants, tmpIR.Aggs, 'Tech',
							(pError, pExecution, pContext) =>
							{
								Expect(pError).to.not.exist;
								Expect(pExecution.Errors).to.deep.equal({});
								let tmpBinds = { t: 1, u: 1 };
								let tmpResults = pExecution.Results;
								let tmpToDo = sqlAll(_DB, `SELECT r.IDMaterialIntake AS I, r.IDLabFormType AS F FROM MaterialIntakeRequirement r WHERE ${e3aWhere()}`, tmpBinds);
								Expect(tmpResults.ToDo.Total).to.equal(tmpToDo.length);
								Expect(tmpToDo.length).to.be.above(20);
								Expect(tmpResults['#Total'].Total).to.equal(_Harness.seed.TenantLiveCounts[1].MaterialIntakeRequirement);
								Expect(groupMap(tmpResults.ToDo.Groups)).to.deep.equal(splitNull(keyCounts(sqlAll(_DB, `SELECT r.IDLabFormType AS K, count(*) AS N FROM MaterialIntakeRequirement r WHERE ${e3aWhere()} GROUP BY K`, tmpBinds)))[0]);

								let tmpQueue = splitNull(keyCounts(sqlAll(_DB, `SELECT i.IDLabQueue AS K, count(*) AS N FROM MaterialIntakeRequirement r LEFT JOIN MaterialIntake i ON i.IDMaterialIntake = r.IDMaterialIntake AND i.IDCustomer = $t AND i.Deleted = 0 WHERE ${e3aWhere()} GROUP BY K`, tmpBinds)));
								Expect(groupMap(tmpResults.Queue.Groups)).to.deep.equal(tmpQueue[0]);
								Expect(Object.keys(tmpQueue[0]).sort()).to.deep.equal(_Traps.TechQueueIDs.map(String).sort());

								let tmpWeek = splitNull(keyCounts(sqlAll(_DB, `SELECT ${sqlWeek('i.ReceivedDate')} AS K, count(*) AS N FROM MaterialIntakeRequirement r LEFT JOIN MaterialIntake i ON i.IDMaterialIntake = r.IDMaterialIntake AND i.IDCustomer = $t AND i.Deleted = 0 WHERE ${e3aWhere()} GROUP BY K`, tmpBinds)));
								Expect(groupMap(tmpResults.Week.Groups)).to.deep.equal(tmpWeek[0]);
								Expect(tmpResults.Week.MissingCount).to.equal(tmpWeek[1]);
								Expect(tmpWeek[0]['2025-12-29 00:00:00']).to.be.at.least(1);

								let tmpDiscipline = splitNull(keyCounts(sqlAll(_DB, `SELECT ft.Discipline AS K, count(*) AS N FROM MaterialIntakeRequirement r LEFT JOIN LabFormType ft ON ft.IDLabFormType = r.IDLabFormType WHERE ${e3aWhere()} GROUP BY K`, tmpBinds)));
								Expect(groupMap(tmpResults.Discipline.Groups)).to.deep.equal(tmpDiscipline[0]);
								Expect(tmpResults.Discipline.MissingCount).to.equal(tmpDiscipline[1]);

								let tmpStarted = sqlAll(_DB, `SELECT count(*) AS N FROM MaterialIntakeRequirement r WHERE ${e3aWhere()} AND EXISTS (SELECT 1 FROM LabForm f WHERE f.IDMaterialIntake = r.IDMaterialIntake AND f.IDLabFormType = r.IDLabFormType AND f.IDCustomer = $t AND f.Deleted = 0 AND f.OwnerIDUser = $u AND f.Status != 'Complete')`, tmpBinds)[0].N;
								let tmpStartedExpected = {};
								if (tmpStarted > 0)
								{
									tmpStartedExpected['1'] = tmpStarted;
								}
								if (tmpToDo.length - tmpStarted > 0)
								{
									tmpStartedExpected['0'] = tmpToDo.length - tmpStarted;
								}
								Expect(groupMap(tmpResults.Started.Groups)).to.deep.equal(tmpStartedExpected);
								Expect(tmpStarted).to.be.above(0);

								// The story: colleague- and newbie-completed pairs are done (TenantOnly); deleted, tenant-2
								// and pending forms leave them to do; dropped intakes never appear
								let tmpPairs = new Set(tmpToDo.map((pRow) => { return `${pRow.I}|${pRow.F}`; }));
								_Traps.ColleagueCompleted.forEach((pPair) => { Expect(tmpPairs.has(`${pPair.IDMaterialIntake}|${pPair.IDLabFormType}`)).to.equal(false); });
								let tmpIntakes = new Set(tmpToDo.map((pRow) => { return pRow.I; }));
								[ _Traps.DeletedIntakeID, 2, 3, 4, 5, 6 ].forEach((pIntake) => { Expect(tmpIntakes.has(pIntake), `intake ${pIntake}`).to.equal(false); });
								[ 7, 8, 9, 10 ].forEach((pIntake) => { Expect(tmpIntakes.has(pIntake) || (tmpResults.ToDo.Total === 0), `intake ${pIntake}`).to.equal(true); });
								let tmpTenantTwoForms = sqlAll(_DB, 'SELECT f.IDMaterialIntake AS I, f.IDLabFormType AS F FROM LabForm f JOIN MaterialIntake i ON i.IDMaterialIntake = f.IDMaterialIntake WHERE f.IDCustomer = 2 AND i.IDCustomer = 1 AND i.Deleted = 0 AND i.Status IN (\'Received\', \'InProgress\') AND i.IDLabQueue IN (1, 2)');
								Expect(tmpTenantTwoForms.length).to.be.above(0);
								tmpTenantTwoForms.forEach(
									(pPair) =>
									{
										let tmpRequired = sqlAll(_DB, 'SELECT count(*) AS N FROM MaterialIntakeRequirement r WHERE r.IDCustomer = 1 AND r.Deleted = 0 AND r.IDMaterialIntake = $i AND r.IDLabFormType = $f', { i: pPair.I, f: pPair.F })[0].N;
										if (tmpRequired > 0)
										{
											Expect(tmpPairs.has(`${pPair.I}|${pPair.F}`), `tenant-2 form ${pPair.I}|${pPair.F} does not satisfy`).to.equal(true);
										}
									});
								// The relaxed hop fingerprints as TenantOnly; the owner-scoped Started hop as Inherit
								Expect(pExecution.Captures.LabForm.Hops.some((pHop) => { return /^ref:hop:LabForm\|TenantOnly\|/.test(pHop); })).to.equal(true);
								Expect(pExecution.Captures.LabForm.Hops.some((pHop) => { return /^ref:hop:LabForm\|Inherit\|/.test(pHop); })).to.equal(true);
								Expect(pContext.Memo.HopRows).to.be.an('object');
								return fDone();
							});
					});

				test('E3A without the TenantOnly relaxation is NoVisibleMatch: only my own completed forms count (colleague-completed pairs come back)',
					(fDone) =>
					{
						let tmpIR = e3aFoldIR(1, 'Inherit');
						runReference(_Harness, 'MaterialIntakeRequirement', tmpIR.Variants, [ tmpIR.Aggs[1] ], 'Tech',
							(pError, pExecution) =>
							{
								Expect(pError).to.not.exist;
								let tmpToDo = sqlAll(_DB, `SELECT r.IDMaterialIntake AS I, r.IDLabFormType AS F FROM MaterialIntakeRequirement r WHERE ${e3aWhere(false)}`, { t: 1, u: 1 });
								Expect(pExecution.Results.ToDo.Total).to.equal(tmpToDo.length);
								let tmpPairs = new Set(tmpToDo.map((pRow) => { return `${pRow.I}|${pRow.F}`; }));
								Expect(_Traps.ColleagueCompleted.filter((pPair) => { return tmpPairs.has(`${pPair.IDMaterialIntake}|${pPair.IDLabFormType}`); }).length).to.be.above(0);
								let tmpRelaxed = sqlAll(_DB, `SELECT count(*) AS N FROM MaterialIntakeRequirement r WHERE ${e3aWhere()}`, { t: 1, u: 1 })[0].N;
								Expect(tmpToDo.length).to.be.above(tmpRelaxed);
								return fDone();
							});
					});

				test('E3A as Colleague, Newbie and OtherTech equals the same SQL (Newbie: nothing; OtherTech: tenant 2 only)',
					(fDone) =>
					{
						let tmpNames = [ 'Colleague', 'Newbie', 'OtherTech' ];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpNames.length)
							{
								return fDone();
							}
							let tmpPrincipal = _Harness.as(tmpNames[pIndex]);
							let tmpIR = e3aFoldIR(tmpPrincipal.User);
							runReference(_Harness, 'MaterialIntakeRequirement', tmpIR.Variants, tmpIR.Aggs, tmpNames[pIndex],
								(pError, pExecution) =>
								{
									Expect(pError).to.not.exist;
									let tmpBinds = { t: tmpPrincipal.Tenant, u: tmpPrincipal.User };
									let tmpExpected = sqlAll(_DB, `SELECT r.IDLabFormType AS K, count(*) AS N FROM MaterialIntakeRequirement r WHERE ${e3aWhere()} GROUP BY K`, tmpBinds);
									Expect(groupMap(pExecution.Results.ToDo.Groups)).to.deep.equal(keyCounts(tmpExpected));
									let tmpTotal = tmpExpected.reduce((pSum, pRow) => { return pSum + pRow.N; }, 0);
									Expect(pExecution.Results.ToDo.Total).to.equal(tmpTotal);
									if (tmpNames[pIndex] === 'Newbie')
									{
										Expect(tmpTotal).to.equal(0);
									}
									else
									{
										Expect(tmpTotal).to.be.above(0);
									}
									return fNext(pIndex + 1);
								});
						};
						return fNext(0);
					});

				test('E3 variant B (TuplePivot) as Tech: distinct (intake, form type) tuples minus completed forms equal SQL; the duplicate requirement row counts once',
					(fDone) =>
					{
						let tmpIR = e3bFoldIR(1);
						runReference(_Harness, 'MaterialIntake', tmpIR.Variants, tmpIR.Aggs, 'Tech',
							(pError, pExecution) =>
							{
								Expect(pError).to.not.exist;
								Expect(pExecution.Errors).to.deep.equal({});
								let tmpBinds = { t: 1, u: 1 };
								let tmpAll = sqlAll(_DB, e3bSelect(), tmpBinds);
								let tmpDistinct = sqlAll(_DB, `SELECT DISTINCT I, F, Q, D FROM (${e3bSelect()})`, tmpBinds);
								Expect(pExecution.Results.ToDo.Total).to.equal(tmpDistinct.length);
								// The duplicate type requirement makes the plain join count tuples twice
								Expect(tmpAll.length).to.be.above(tmpDistinct.length);
								Expect(groupMap(pExecution.Results.ToDo.Groups)).to.deep.equal(keyCounts(sqlAll(_DB, `SELECT F AS K, count(*) AS N FROM (SELECT DISTINCT I, F, Q, D FROM (${e3bSelect()})) GROUP BY F`, tmpBinds)));
								Expect(groupMap(pExecution.Results.Queue.Groups)).to.deep.equal(splitNull(keyCounts(sqlAll(_DB, `SELECT Q AS K, count(*) AS N FROM (SELECT DISTINCT I, F, Q, D FROM (${e3bSelect()})) GROUP BY Q`, tmpBinds)))[0]);
								let tmpWeek = splitNull(keyCounts(sqlAll(_DB, `SELECT ${sqlWeek('D')} AS K, count(*) AS N FROM (SELECT DISTINCT I, F, Q, D FROM (${e3bSelect()})) GROUP BY K`, tmpBinds)));
								Expect(groupMap(pExecution.Results.Week.Groups)).to.deep.equal(tmpWeek[0]);
								Expect(pExecution.Results.Week.MissingCount).to.equal(tmpWeek[1]);
								// Every tuple of type 1's duplicated form type is present once
								let tmpDuplicateTuples = tmpDistinct.filter((pRow) => { return pRow.F === _Traps.DuplicateTypeRequirement.IDLabFormType; }).length;
								Expect(tmpDuplicateTuples).to.be.above(0);
								return fDone();
							});
					});

				test('a co-reference with CheckParent re-checks the parent: requirements of the soft-deleted intake drop out',
					(fDone) =>
					{
						let tmpWithParent = exists(rel('LabForm', 'e2', null), [ on('p', 'IDMaterialIntake', 'IDMaterialIntake'), on('p', 'IDLabFormType', 'IDLabFormType') ],
							exists(rel('MaterialIntake', 'e3', null, { Role: 'Parent' }), [ on('e2', 'IDMaterialIntake', 'IDMaterialIntake') ]));
						let tmpWithoutParent = exists(rel('LabForm', 'e2', null), [ on('p', 'IDMaterialIntake', 'IDMaterialIntake'), on('p', 'IDLabFormType', 'IDLabFormType') ]);
						runReference(_Harness, 'MaterialIntakeRequirement', { v0: variant('v0', 'MaterialIntakeRequirement', [], tmpWithParent), v1: variant('v1', 'MaterialIntakeRequirement', [], tmpWithoutParent) },
							[ agg('WithParent', 'Count', 'v0'), agg('WithoutParent', 'Count', 'v1') ], 'Tech',
							(pError, pExecution) =>
							{
								Expect(pError).to.not.exist;
								let tmpForms = 'EXISTS (SELECT 1 FROM LabForm f WHERE f.IDMaterialIntake = r.IDMaterialIntake AND f.IDLabFormType = r.IDLabFormType AND f.IDCustomer = 1 AND f.Deleted = 0 AND f.OwnerIDUser = 1';
								let tmpParent = ' AND EXISTS (SELECT 1 FROM MaterialIntake i WHERE i.IDMaterialIntake = f.IDMaterialIntake AND i.IDCustomer = 1 AND i.Deleted = 0)';
								let fCount = (pSQL) => { return sqlAll(_DB, `SELECT count(*) AS N FROM MaterialIntakeRequirement r WHERE r.IDCustomer = 1 AND r.Deleted = 0 AND ${pSQL})`)[0].N; };
								Expect(pExecution.Results.WithParent.Total).to.equal(fCount(tmpForms + tmpParent));
								Expect(pExecution.Results.WithoutParent.Total).to.equal(fCount(tmpForms));
								Expect(pExecution.Results.WithoutParent.Total).to.be.above(pExecution.Results.WithParent.Total);
								return fDone();
							});
					});
			}
		);

		// ================================================================ TenantOnly refused when the owner column appears twice
		suite
		(
			'LabTrack TenantOnly refusal (a second owner predicate from another behavior)',
			() =>
			{
				let _Harness = null;

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'LabTrack' },
						(pError) =>
						{
							if (!pError)
							{
								_Harness.installBehavior('LabForm', 'Reads-QueryConfiguration',
									function (pRequest, pRequestState, fCallback)
									{
										pRequestState.Query.addFilter('OwnerIDUser', pRequestState.SessionData.UserID, '=', 'AND', 'SecondOwner');
										return fCallback();
									});
							}
							return fDone(pError);
						});
				});
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				test('the relaxation is refused (ColumnElsewhere): the facet fails with 500 FACET_SCOPE_POLICY_VIOLATION, the unrelaxed facet still answers',
					(fDone) =>
					{
						let tmpIR = e3aFoldIR(1);
						runReference(_Harness, 'MaterialIntakeRequirement', tmpIR.Variants, tmpIR.Aggs, 'Tech',
							(pError, pExecution) =>
							{
								Expect(pError).to.not.exist;
								[ 'ToDo', 'Queue', 'Week', 'Discipline', 'Started' ].forEach((pKey) => { Expect(pExecution.Errors[pKey].Code, pKey).to.equal('FACET_SCOPE_POLICY_VIOLATION'); });
								Expect(pExecution.Results['#Total'].Total).to.be.above(0);
								let tmpPath = variant('v0', 'MaterialIntakeRequirement', [], tmpIR.Where);
								runReference(_Harness, 'MaterialIntakeRequirement', { v0: tmpPath }, [ agg('#Total', 'Count', 'v0') ], 'Tech',
									(pWholeError) =>
									{
										Expect(pWholeError.Code).to.equal('FACET_SCOPE_POLICY_VIOLATION');
										Expect(pWholeError.Detail.Reason).to.equal('TenantOnlyRefused:ColumnElsewhere');
										return fDone();
									});
							});
					});
			}
		);

		// ================================================================ 4. end to end (the wired M2 pipeline)
		suite
		(
			'End to end: E1, E2, E3A, E3B through the pipeline (O1, O-hand, O2, isolation)',
			() =>
			{
				let _ProjectTrack = null;
				let _LabTrack = null;

				suiteSetup((fDone) =>
				{
					_ProjectTrack = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack' },
						(pError) =>
						{
							if (pError)
							{
								return fDone(pError);
							}
							_LabTrack = libHarness.start({ Port: PORT, Fixture: 'LabTrack' },
								(pLabError) =>
								{
									if (pLabError)
									{
										return fDone(pLabError);
									}
									// Every piece of the M2 pipeline must be in place: a missing one (e.g. a definition the
									// registry disabled) is a hard failure here, never a pending test.
									let tmpProject = pipelineReadiness(_ProjectTrack, 'Project.MyProjects');
									let tmpLab = pipelineReadiness(_LabTrack, 'MaterialIntakeRequirement.ToDoForMe');
									Expect(tmpProject.Missing.concat(tmpLab.Missing), 'the M2 pipeline').to.deep.equal([]);
									return fDone();
								});
						});
				});
				suiteTeardown((fDone) =>
				{
					let tmpLab = _LabTrack;
					_ProjectTrack.stop(() => { return tmpLab ? tmpLab.stop(fDone) : fDone(); });
				});

				/**
				 * O1 in-process with the pinned clock, then O2 through the Reference, as each principal.
				 */
				let fConformance = (pHarness, pEntity, pBody, pNames, fCheck, fDone) =>
				{
					let fNext = (pIndex) =>
					{
						if (pIndex >= pNames.length)
						{
							return fDone();
						}
						let tmpOptions = Object.assign({ Now: TEST_NOW }, pHarness.as(pNames[pIndex]));
						pHarness.compareInProcess(pEntity, pBody, tmpOptions,
							(pError, pResult) =>
							{
								Expect(pError, pNames[pIndex]).to.not.exist;
								Expect(pResult.Live.Errors || {}, `${pNames[pIndex]} Live errors`).to.deep.equal({});
								Expect(pResult.LiveNormalized, `${pNames[pIndex]}: Live == Reference`).to.deep.equal(pResult.ReferenceNormalized);
								fCheck(pNames[pIndex], pResult.Reference);
								pHarness.assertSelectionRoundTrip(pEntity, pBody, pResult.Live, tmpOptions,
									(pRoundTripError, pReport) =>
									{
										Expect(pRoundTripError, `${pNames[pIndex]} O2 ${JSON.stringify(pReport && pReport.Mismatches)}`).to.not.exist;
										return fNext(pIndex + 1);
									});
							});
					};
					return fNext(0);
				};

				test('E1 (ProjectTrack, Project): O1, O-hand and O2 as Lead, Member, Outsider and OtherLead; Records order; isolation',
					function (fDone)
					{
						let tmpDB = _ProjectTrack.db;
						let tmpBody = e1Body(_ProjectTrack.traps);
						fConformance(_ProjectTrack, 'Project', tmpBody, [ 'Lead', 'Member', 'Outsider', 'OtherLead' ],
							(pName, pEnvelope) =>
							{
								let tmpPrincipal = _ProjectTrack.as(pName);
								let tmpBinds = { t: tmpPrincipal.Tenant, u: tmpPrincipal.User, now: NOW };
								Expect(pEnvelope.Total).to.equal(sqlAll(tmpDB, `SELECT count(*) AS N FROM Project p WHERE ${e1Where({})}`, tmpBinds)[0].N);
								let tmpStatus = splitNull(keyCounts(sqlAll(tmpDB, `SELECT p.Status AS K, count(*) AS N FROM Project p WHERE ${e1Where({ Status: false })} GROUP BY p.Status`, tmpBinds)));
								pEnvelope.Facets.Status.Buckets.filter((pBucket) => { return pBucket.Count > 0; }).forEach((pBucket) => { Expect(pBucket.Count, `Status ${pBucket.Key}`).to.equal(tmpStatus[0][String(pBucket.Key)]); });
								let tmpBands = keyCounts(sqlAll(tmpDB, `SELECT ${BAND_SQL} AS K, count(*) AS N FROM Project p WHERE ${e1Where({})} GROUP BY K`, tmpBinds));
								pEnvelope.Facets.MyOverdue.Buckets.forEach((pBucket) => { Expect(pBucket.Count, `band ${pBucket.Key}`).to.equal(tmpBands[String(pBucket.Key)] || 0); });
								let tmpClient = splitNull(keyCounts(sqlAll(tmpDB, `SELECT p.IDClient AS K, count(*) AS N FROM Project p WHERE ${e1Where({ Client: false })} GROUP BY p.IDClient`, tmpBinds)));
								pEnvelope.Facets.Client.Buckets.filter((pBucket) => { return pBucket.Count > 0; }).forEach((pBucket) => { Expect(pBucket.Count, `Client ${pBucket.Key}`).to.equal(tmpClient[0][String(pBucket.Key)]); });
							},
							() =>
							{
								let tmpLead = Object.assign({ Now: TEST_NOW }, _ProjectTrack.as('Lead'));
								_ProjectTrack.compareInProcess('Project', tmpBody, tmpLead,
									(pError, pResult) =>
									{
										let tmpExpected = sqlAll(tmpDB, `SELECT p.IDProject AS ID FROM Project p WHERE ${e1Where({})} ORDER BY CASE WHEN p.StartDate IS NULL THEN 1 ELSE 0 END, p.StartDate DESC, p.IDProject ASC LIMIT 50`, { t: 1, u: 1, now: NOW }).map((pRow) => { return pRow.ID; });
										Expect(pResult.Live.Records.map((pRecord) => { return pRecord.IDProject; })).to.deep.equal(tmpExpected);
										_ProjectTrack.assertTenantIsolation('Project', tmpBody, [ 'Lead', 'OtherLead' ],
											(pIsolationError, pReport) =>
											{
												Expect(pIsolationError, JSON.stringify(pReport && pReport.Mismatches)).to.not.exist;
												return fDone();
											});
									});
							});
					});

				test('E2 (ProjectTrack, Document): O1, O-hand and O2 as Lead and OtherLead',
					function (fDone)
					{
						let tmpDB = _ProjectTrack.db;
						let tmpTraps = _ProjectTrack.traps;
						fConformance(_ProjectTrack, 'Document', e2Body(tmpTraps), [ 'Lead', 'OtherLead' ],
							(pName, pEnvelope) =>
							{
								let tmpBinds = { t: _ProjectTrack.as(pName).Tenant, f: tmpTraps.E2FormTypeID };
								let tmpForm = 'EXISTS (SELECT 1 FROM FormType ft WHERE ft.IDFormType = d.IDFormType AND ft.IDFormType = $f)';
								let tmpWindow = 'd.DocumentDate >= \'2026-01-01 00:00:00\' AND d.DocumentDate < \'2026-07-01 00:00:00\'';
								let tmpBase = 'FROM Document d WHERE d.IDCustomer = $t AND d.Deleted = 0';
								Expect(pEnvelope.Total).to.equal(sqlAll(tmpDB, `SELECT count(*) AS N ${tmpBase} AND ${tmpForm} AND ${tmpWindow}`, tmpBinds)[0].N);
								let tmpMonths = splitNull(keyCounts(sqlAll(tmpDB, `SELECT strftime('%Y-%m-01 00:00:00', d.DocumentDate) AS K, count(*) AS N ${tmpBase} AND ${tmpForm} GROUP BY K`, tmpBinds)));
								pEnvelope.Facets.ByMonth.Buckets.forEach((pBucket) => { Expect(pBucket.Count, `ByMonth ${pBucket.Key}`).to.equal(tmpMonths[0][pBucket.Key] || 0); });
								Expect(pEnvelope.Facets.ByMonth.MissingCount).to.equal(tmpMonths[1]);
								let tmpForms = splitNull(keyCounts(sqlAll(tmpDB, `SELECT d.IDFormType AS K, count(*) AS N ${tmpBase} AND ${tmpWindow} GROUP BY K`, tmpBinds)));
								pEnvelope.Facets.ByForm.Buckets.filter((pBucket) => { return pBucket.Count > 0; }).forEach((pBucket) => { Expect(pBucket.Count, `ByForm ${pBucket.Key}`).to.equal(tmpForms[0][String(pBucket.Key)]); });
							}, fDone);
					});

				test('E3A (LabTrack, MaterialIntakeRequirement): O1, O-hand and O2 as every principal; ToDo.Total == the ToDoForMe Records/Count route',
					function (fDone)
					{
						let tmpDB = _LabTrack.db;
						fConformance(_LabTrack, 'MaterialIntakeRequirement', clone(E3A_BODY), [ 'Tech', 'Colleague', 'Newbie', 'OtherTech' ],
							(pName, pEnvelope) =>
							{
								let tmpPrincipal = _LabTrack.as(pName);
								let tmpBinds = { t: tmpPrincipal.Tenant, u: tmpPrincipal.User };
								Expect(pEnvelope.Facets.ToDo.Total).to.equal(sqlAll(tmpDB, `SELECT count(*) AS N FROM MaterialIntakeRequirement r WHERE ${e3aWhere()}`, tmpBinds)[0].N);
								let tmpToDo = keyCounts(sqlAll(tmpDB, `SELECT r.IDLabFormType AS K, count(*) AS N FROM MaterialIntakeRequirement r WHERE ${e3aWhere()} GROUP BY K`, tmpBinds));
								pEnvelope.Facets.ToDo.Buckets.filter((pBucket) => { return pBucket.Count > 0; }).forEach((pBucket) => { Expect(pBucket.Count, `ToDo ${pBucket.Key}`).to.equal(tmpToDo[String(pBucket.Key)]); });
								Expect(pEnvelope.Facets.ToDo.Relaxed).to.equal(true);
							},
							() =>
							{
								let tmpTech = _LabTrack.as('Tech');
								_LabTrack.scopeRecordsCount('MaterialIntakeRequirement', 'MaterialIntakeRequirement.ToDoForMe', { Clauses: [] }, tmpTech,
									(pError, pCount) =>
									{
										Expect(pCount.Status).to.equal(200);
										Expect(pCount.Body.Count).to.equal(sqlAll(tmpDB, `SELECT count(*) AS N FROM MaterialIntakeRequirement r WHERE ${e3aWhere()}`, { t: 1, u: 1 })[0].N);
										_LabTrack.assertTenantIsolation('MaterialIntakeRequirement', clone(E3A_BODY), [ 'Tech', 'OtherTech' ],
											(pIsolationError, pReport) =>
											{
												Expect(pIsolationError, JSON.stringify(pReport && pReport.Mismatches)).to.not.exist;
												return fDone();
											});
									});
							});
					});

				test('E3B (LabTrack, MaterialIntake TuplePivot): O1 and O-hand as every principal',
					function (fDone)
					{
						let tmpDB = _LabTrack.db;
						fConformance(_LabTrack, 'MaterialIntake', clone(E3B_BODY), [ 'Tech', 'Colleague', 'Newbie', 'OtherTech' ],
							(pName, pEnvelope) =>
							{
								let tmpPrincipal = _LabTrack.as(pName);
								let tmpBinds = { t: tmpPrincipal.Tenant, u: tmpPrincipal.User };
								Expect(pEnvelope.Facets.ToDo.Total).to.equal(sqlAll(tmpDB, `SELECT count(*) AS N FROM (SELECT DISTINCT I, F FROM (${e3bSelect()}))`, tmpBinds)[0].N);
								Expect(pEnvelope.Facets.ToDo.Buckets.every((pBucket) => { return pBucket.Clause === null; })).to.equal(true);
							}, fDone);
					});

				test('two-tenant isolation and owner scope on the plain LabForm entity as every LabTrack principal',
					function (fDone)
					{
						_LabTrack.assertTenantIsolation('LabForm', { Facets: [ { Key: 'Status', Facet: 'LabForm.Status' }, { Key: 'Type', Facet: 'LabForm.IDLabFormType' } ], Total: true }, [ 'Tech', 'Colleague', 'Newbie', 'OtherTech' ],
							(pError, pReport) =>
							{
								Expect(pError, JSON.stringify(pReport && pReport.Mismatches)).to.not.exist;
								return fDone();
							});
					});
			}
		);
	}
);
