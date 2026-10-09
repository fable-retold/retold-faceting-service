/**
 * Retold Faceting - Live Engine (Tier A)
 *
 * In-process SQL composed from Scoped Relations (03 §3, D-03): one fresh, behavior-scoped,
 * fenced, explicitly soft-deleted relation per entity, harvested with renamed parameters,
 * spliced through _Params into a dialect shell template, executed with the pivot DAL's
 * provider.Read (raw rows).  Never FoxHound addJoin; never client-supplied SQL or identifiers.
 *
 * execute() runs in phases so scope captures are never raced:
 *   0. capability, and one group per (Pivot, Variant) — every TuplePivot Agg is its own group;
 *   1. the conditional disjunctive scans (RetoldFacetingCubeExecutor, §25): one GROUP BY answers
 *      every cube member of a pivot; a fallback leaves the members to the per-Variant path;
 *   2. per group, sequentially: the pivot relation (projecting every column the group reads), the
 *      Variant's path-predicate hops, then per Agg its own hops (definition Where, Via / Multi /
 *      child / exists dimensions) and its composed statements (RetoldFacetingStatementComposer);
 *   3. the statements, bounded by Execution.MaxParallelStatements.
 * Results are RawFacetResults (internal-contracts §9.2, §24.9); envelope arithmetic is never done here.
 *
 * Records / Count / Keys (§26.5) compose the full-filter base the same way: countBase, recordKeys,
 * keys.
 *
 * Contract: internal-contracts §7, §9, §24–§27.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libRetoldFacetingEngineBase = require('./Retold-Faceting-EngineBase.js');
const libRetoldFacetingStatementComposer = require('./live/Retold-Faceting-StatementComposer.js');

const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetEnvelope = require('../contract/Facet-Contract-Envelope.js');
const libFacetBuckets = require('../contract/Facet-Contract-Buckets.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

// Agg kinds Live answers (M1 + K12 ChildRollup, K20 ExistsSplit; K8/K9/K18 are dimension forms).
const LIVE_KINDS = Object.freeze([ 'Count', 'Terms', 'DateHistogram', 'NumericHistogram', 'Ranges', 'Stats', 'DistinctCount', 'Missing', 'Pivot', 'ChildRollup', 'ExistsSplit' ]);

// Every contract interval has a shell expression on every dialect (the boot check proves it).
const LIVE_INTERVALS = libFacetRequest.INTERVALS;

const PIVOT_AXIS_KINDS = libRetoldFacetingEngineBase.PIVOT_AXIS_KINDS;

const hasOwn = libRetoldFacetingUtil.hasOwn;
const toNumber = libRetoldFacetingUtil.toFiniteNumber;
const toCount = libRetoldFacetingUtil.toCount;
const rawKey = libRetoldFacetingEngineBase.rawKey;
const toDateString = libRetoldFacetingEngineBase.toDateString;
const andOf = libRetoldFacetingStatementComposer.andOf;

// Errors raised while building a relation that fail only the Aggs that need it; every other
// relation error (scope violation, behavior 401, internal) fails the whole request.
const PER_AGG_RELATION_ERRORS = Object.freeze([ 'FACET_TOO_LARGE', 'FACET_FOLD_UNSUPPORTED', 'FACET_TIMEOUT' ]);

// Errors of a facet's OWN relations (definition Where, dimensions) that still fail the whole
// request: the principal itself is refused.
const WHOLE_REQUEST_AGG_ERRORS = Object.freeze([ 'FACET_UNAUTHENTICATED' ]);

// Kinds whose Agg.Field is a measured pivot column (§5.1).
const MEASURE_KINDS = Object.freeze([ 'Stats', 'DistinctCount', 'Missing' ]);

// The CountMode each Agg shape answers in (§24.5).
const COUNT_MODE_FOR = Object.freeze({ Entity: 'Rows', Multi: 'PivotDistinct', Tuple: 'KeyDistinct' });

class RetoldFacetingEngineLive extends libRetoldFacetingEngineBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options (resolved by the base)
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'RetoldFacetingEngineLive';

		this._Composer = null;
	}

	get EngineName()
	{
		return 'Live';
	}

	/**
	 * The statement composer (a helper over this fable's services; not a registered service).
	 *
	 * @return {Record<string, any>}
	 */
	get composer()
	{
		if (!this._Composer)
		{
			this._Composer = new libRetoldFacetingStatementComposer(this.fable);
		}
		return this._Composer;
	}

	// ================================================================== capability

	/**
	 * Pure, no I/O (§27.1).  Accepts every kind of §24.9; refuses TuplePivot Pivots, Multi /
	 * ChildAgg / ExistsFlag pivot axes, a CountMode other than the Agg's own, and unknown shapes.
	 *
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pContext
	 * @return {{ Capable: boolean, Reason?: string }}
	 */
	capable(pAgg, pContext)
	{
		if ((typeof(pAgg) !== 'object') || (pAgg === null) || (LIVE_KINDS.indexOf(pAgg.Kind) < 0))
		{
			return { Capable: false, Reason: 'UnsupportedKind' };
		}
		if ((typeof(pAgg.Pivot) !== 'string') || (pAgg.Pivot.length < 1))
		{
			return { Capable: false, Reason: 'TuplePivot' };
		}
		let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
		let tmpTuple = this.isTuple(pAgg);
		let tmpMulti = (pAgg.Kind === 'Terms') && (tmpDimensions.length > 0) && tmpDimensions[0] && (tmpDimensions[0].Kind === 'Multi');
		let tmpShape = tmpTuple ? 'Tuple' : (tmpMulti ? 'Multi' : 'Entity');
		let tmpCountMode = ((pAgg.CountMode === null) || (typeof(pAgg.CountMode) === 'undefined')) ? COUNT_MODE_FOR[tmpShape] : pAgg.CountMode;
		if (tmpCountMode !== COUNT_MODE_FOR[tmpShape])
		{
			return { Capable: false, Reason: `CountMode:${pAgg.CountMode}` };
		}
		if (tmpTuple)
		{
			if (pAgg.Kind === 'Pivot')
			{
				return { Capable: false, Reason: 'TuplePivotPivot' };
			}
			if ([ 'Stats', 'DistinctCount', 'Missing', 'ChildRollup', 'ExistsSplit' ].indexOf(pAgg.Kind) >= 0)
			{
				return { Capable: false, Reason: `TupleKind:${pAgg.Kind}` };
			}
			if (!this.tupleShapeOK(pAgg.Tuple))
			{
				return { Capable: false, Reason: 'TupleShape' };
			}
			for (let i = 0; i < tmpDimensions.length; i++)
			{
				if (tmpDimensions[i] && (Array.isArray(tmpDimensions[i].Via) || (typeof(tmpDimensions[i].Alias) !== 'string')))
				{
					return { Capable: false, Reason: 'TupleDimension' };
				}
			}
		}
		let fFieldOK = (pDimension) =>
		{
			return pDimension && (typeof(pDimension.Field) === 'string') && (pDimension.Field.length > 0) && this.viaOK(pDimension);
		};
		switch (pAgg.Kind)
		{
			case 'Count':
				return { Capable: true };
			case 'Terms':
				if (tmpMulti)
				{
					return this.multiOK(tmpDimensions[0]) ? { Capable: true } : { Capable: false, Reason: 'Dimension' };
				}
				return (fFieldOK(tmpDimensions[0]) && (tmpDimensions[0].Kind === 'Column')) ? { Capable: true } : { Capable: false, Reason: 'Dimension' };
			case 'DateHistogram':
				return (fFieldOK(tmpDimensions[0]) && (tmpDimensions[0].Kind === 'DateBucket') && (LIVE_INTERVALS.indexOf(tmpDimensions[0].Interval) >= 0)) ? { Capable: true } : { Capable: false, Reason: 'Dimension' };
			case 'NumericHistogram':
				if (!fFieldOK(tmpDimensions[0]) || (tmpDimensions[0].Kind !== 'NumericBucket'))
				{
					return { Capable: false, Reason: 'Dimension' };
				}
				if ((tmpDimensions[0].Mode === 'Edges') && Array.isArray(tmpDimensions[0].Edges) && (tmpDimensions[0].Edges.length >= 2))
				{
					return { Capable: true };
				}
				return ((tmpDimensions[0].Mode === 'Nice') || (tmpDimensions[0].Mode === null) || (typeof(tmpDimensions[0].Mode) === 'undefined')) ? { Capable: true } : { Capable: false, Reason: `NumericMode:${tmpDimensions[0].Mode}` };
			case 'Ranges':
				return (fFieldOK(tmpDimensions[0]) && (tmpDimensions[0].Kind === 'Range') && Array.isArray(tmpDimensions[0].Ranges) && (tmpDimensions[0].Ranges.length > 0)) ? { Capable: true } : { Capable: false, Reason: 'Dimension' };
			case 'Stats':
			case 'DistinctCount':
			case 'Missing':
				return ((typeof(pAgg.Field) === 'string') && (pAgg.Field.length > 0)) ? { Capable: true } : { Capable: false, Reason: 'Field' };
			case 'Pivot':
				if (tmpDimensions.length !== 2)
				{
					return { Capable: false, Reason: 'Dimension' };
				}
				for (let i = 0; i < 2; i++)
				{
					// Axes are single-valued: no Multi, ChildAgg or ExistsFlag axis (§20.5, §27.1).
					if (!tmpDimensions[i] || (PIVOT_AXIS_KINDS.indexOf(tmpDimensions[i].Kind) < 0))
					{
						return { Capable: false, Reason: `PivotAxis:${tmpDimensions[i] ? tmpDimensions[i].Kind : 'None'}` };
					}
					if (!fFieldOK(tmpDimensions[i]))
					{
						return { Capable: false, Reason: 'Dimension' };
					}
					if ((tmpDimensions[i].Kind === 'DateBucket') && (LIVE_INTERVALS.indexOf(tmpDimensions[i].Interval) < 0))
					{
						return { Capable: false, Reason: 'Dimension' };
					}
				}
				return { Capable: true };
			case 'ChildRollup':
				{
					let tmpDimension = tmpDimensions[0];
					let tmpEdges = (tmpDimension && Array.isArray(tmpDimension.Edges)) ? tmpDimension.Edges : [];
					let tmpAscending = libFacetBuckets.isBandEdges(tmpEdges) && tmpEdges.every((pEdge) => { return Number.isSafeInteger(pEdge); });
					if (!tmpDimension || (tmpDimension.Kind !== 'ChildAgg') || !tmpAscending || !tmpDimension.Rel || !Array.isArray(tmpDimension.On) || (tmpDimension.On.length < 1))
					{
						return { Capable: false, Reason: 'Dimension' };
					}
					return ((tmpDimension.Agg === 'count') || (typeof(tmpDimension.Agg) === 'undefined')) ? { Capable: true } : { Capable: false, Reason: 'ChildRollupAgg' };
				}
			case 'ExistsSplit':
				{
					let tmpDimension = tmpDimensions[0];
					return (tmpDimension && (tmpDimension.Kind === 'ExistsFlag') && tmpDimension.Pred && (tmpDimension.Pred.Node === 'Exists')) ? { Capable: true } : { Capable: false, Reason: 'Dimension' };
				}
			default:
				return { Capable: false, Reason: 'UnsupportedKind' };
		}
	}

	/**
	 * Is an Agg a TuplePivot (Agg.Tuple set)?
	 *
	 * @param {Record<string, any>} pAgg
	 * @return {boolean}
	 */
	isTuple(pAgg)
	{
		return !!(pAgg && pAgg.Tuple && (typeof(pAgg.Tuple) === 'object'));
	}

	/**
	 * @param {Record<string, any>} pTuple
	 * @return {boolean}
	 */
	tupleShapeOK(pTuple)
	{
		if (!pTuple || !Array.isArray(pTuple.Sides) || (pTuple.Sides.length < 2) || !Array.isArray(pTuple.Key) || (pTuple.Key.length < 1) || !Array.isArray(pTuple.On) || (pTuple.On.length < 1))
		{
			return false;
		}
		if (pTuple.Sides[0].Alias !== 'p')
		{
			return false;
		}
		return pTuple.Sides.every((pSide) => { return pSide && pSide.Rel && (typeof(pSide.Rel.Entity) === 'string') && (pSide.Rel.As === pSide.Alias); });
	}

	/**
	 * A Via chain (K8) is well formed when every link has a Rel and On pairs.
	 *
	 * @param {Record<string, any>} pDimension
	 * @return {boolean}
	 */
	viaOK(pDimension)
	{
		if (!Array.isArray(pDimension.Via))
		{
			return true;
		}
		return (pDimension.Via.length > 0) && pDimension.Via.every((pLink) => { return pLink && pLink.Rel && Array.isArray(pLink.On) && (pLink.On.length > 0); });
	}

	/**
	 * @param {Record<string, any>} pDimension
	 * @return {boolean}
	 */
	multiOK(pDimension)
	{
		return !!pDimension && (typeof(pDimension.KeyField) === 'string') && Array.isArray(pDimension.Chain) && (pDimension.Chain.length > 0)
			&& pDimension.Chain.every((pLink) => { return pLink && pLink.Rel && Array.isArray(pLink.On) && (pLink.On.length > 0); });
	}

	// ================================================================== variants

	/**
	 * The Variant of an Agg (pContext.Variants, §6.3 / §24.6), normalized for Live:
	 * { Conjuncts (Column-shape, the pivot's client fence), PathPred, IncludesDeleted, VariantId }.
	 * A Variant holding Path-shape conjuncts without a lowered PathPred is a plan bug (null).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pAgg
	 * @return {{ VariantId: string, Conjuncts: Array<Record<string, any>>, PathPred: Record<string, any>|null, IncludesDeleted: boolean }|null}
	 */
	variantFor(pContext, pAgg)
	{
		let tmpVariantId = (typeof(pAgg.VariantId) === 'string') ? pAgg.VariantId : 'v0';
		let tmpVariants = (pContext && pContext.Variants) ? pContext.Variants : null;
		let fNormalize = (pVariant, pConjuncts) =>
		{
			let tmpAll = Array.isArray(pConjuncts) ? pConjuncts : [];
			let tmpColumn = Array.isArray(pVariant && pVariant.ColumnConjuncts) ? pVariant.ColumnConjuncts : tmpAll.filter((pConjunct) => { return pConjunct.Shape !== 'Path'; });
			let tmpPathPred = (pVariant && pVariant.PathPred) ? pVariant.PathPred : null;
			if (!tmpPathPred && tmpAll.some((pConjunct) => { return pConjunct.Shape === 'Path'; }))
			{
				return null;
			}
			let tmpIncludesDeleted = (pVariant && (pVariant.IncludesDeleted === true)) || tmpColumn.some((pConjunct) => { return pConjunct.NamesDeleted === true; });
			return { VariantId: tmpVariantId, Conjuncts: tmpColumn, PathPred: tmpPathPred, IncludesDeleted: tmpIncludesDeleted };
		};
		if (tmpVariants && hasOwn(tmpVariants, tmpVariantId))
		{
			let tmpVariant = tmpVariants[tmpVariantId];
			return fNormalize(tmpVariant, tmpVariant.Conjuncts);
		}
		if ((tmpVariantId === 'v0') && pContext && pContext.FilterAST && Array.isArray(pContext.FilterAST.Conjuncts))
		{
			return fNormalize({ IncludesDeleted: pContext.FilterAST.IncludesDeleted === true }, pContext.FilterAST.Conjuncts);
		}
		if ((tmpVariantId === 'v0') && (!tmpVariants || (Object.keys(tmpVariants).length < 1)))
		{
			return { VariantId: 'v0', Conjuncts: [], PathPred: null, IncludesDeleted: false };
		}
		return null;
	}

	/**
	 * Every column an Agg reads from its pivot relation directly (M1 dimensions / measure).
	 *
	 * @param {Record<string, any>} pAgg
	 * @return {Array<string>}
	 */
	aggColumns(pAgg)
	{
		let tmpColumns = [];
		let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
		for (let i = 0; i < tmpDimensions.length; i++)
		{
			let tmpDimension = tmpDimensions[i];
			// (a TuplePivot dimension reads its own side's alias: the needs collector places it)
			if (tmpDimension && (typeof(tmpDimension.Field) === 'string') && !Array.isArray(tmpDimension.Via)
				&& ((typeof(tmpDimension.Alias) !== 'string') || (tmpDimension.Alias === 'p'))
				&& ([ 'Multi', 'ChildAgg', 'ExistsFlag' ].indexOf(tmpDimension.Kind) < 0))
			{
				tmpColumns.push(tmpDimension.Field);
			}
		}
		// The measured column of Stats / DistinctCount / Missing (for a bucketed fold Agg.Field only
		// repeats its dimension's field, which for a Via / Multi / TuplePivot dimension is NOT a pivot
		// column).
		if ((typeof(pAgg.Field) === 'string') && (MEASURE_KINDS.indexOf(pAgg.Kind) >= 0))
		{
			tmpColumns.push(pAgg.Field);
		}
		return tmpColumns;
	}

	/**
	 * The needs (Rels and per-alias columns) of one Agg's OWN trees: definition Where and
	 * dimensions (not the Variant's PathPred, which the group collects once).
	 *
	 * @param {Record<string, any>} pAgg
	 * @return {Record<string, any>}
	 */
	aggNeeds(pAgg)
	{
		let tmpComposer = this.composer;
		let tmpNeeds = tmpComposer.newNeeds();
		tmpComposer.collectPred(tmpNeeds, pAgg.Where || null);
		let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
		for (let i = 0; i < tmpDimensions.length; i++)
		{
			tmpComposer.collectDimension(tmpNeeds, tmpDimensions[i], 'p');
		}
		let tmpColumns = this.aggColumns(pAgg);
		for (let i = 0; i < tmpColumns.length; i++)
		{
			tmpComposer.need(tmpNeeds, 'p', tmpColumns[i]);
		}
		if (this.isTuple(pAgg))
		{
			let tmpTuple = pAgg.Tuple;
			for (let i = 0; i < tmpTuple.Sides.length; i++)
			{
				let tmpProject = Array.isArray(tmpTuple.Sides[i].Rel.Project) ? tmpTuple.Sides[i].Rel.Project : [];
				tmpProject.forEach((pColumn) => { tmpComposer.need(tmpNeeds, tmpTuple.Sides[i].Alias, pColumn); });
			}
			tmpTuple.Key.forEach((pKey) => { tmpComposer.need(tmpNeeds, pKey.Alias, pKey.Field); });
			tmpTuple.On.forEach((pPair) => { tmpComposer.need(tmpNeeds, pPair.Left.Alias, pPair.Left.Field); tmpComposer.need(tmpNeeds, pPair.Right.Alias, pPair.Right.Field); });
		}
		return tmpNeeds;
	}

	/**
	 * The Rel for the pivot relation of one (Pivot, Variant) group.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pEntity
	 * @param {{ Conjuncts: Array<Record<string, any>>, IncludesDeleted: boolean }} pVariant
	 * @param {Array<string>} pColumns - every column the group's Aggs read on the pivot
	 * @return {Record<string, any>}
	 */
	pivotRel(pContext, pEntity, pVariant, pColumns)
	{
		let tmpHost = pContext.Host;
		let tmpPrimaryKey = (tmpHost && (typeof(tmpHost.getPrimaryKey) === 'function')) ? tmpHost.getPrimaryKey(pEntity) : null;
		let tmpProject = this.composer.projection((typeof(tmpPrimaryKey) === 'string') ? tmpPrimaryKey : null, pColumns);
		if ((tmpProject.length < 1) && tmpHost && (typeof(tmpHost.getDeleteColumn) === 'function') && tmpHost.getDeleteColumn(pEntity))
		{
			tmpProject.push(tmpHost.getDeleteColumn(pEntity));
		}
		return (
			{
				Entity: pEntity,
				As: 'p',
				Role: 'Pivot',
				Project: tmpProject,
				Client: pVariant.Conjuncts,
				Where: null,
				Scope: 'Inherit',
				SoftDelete: pVariant.IncludesDeleted ? 'ClientControlled' : 'Explicit'
			});
	}

	// ================================================================== execute

	/**
	 * Execute every Agg of one request (all Variants).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Array<Record<string, any>>} pAggs
	 * @param {(pError?: Error, pExecution?: Record<string, any>) => void} fCallback
	 */
	execute(pContext, pAggs, fCallback)
	{
		let tmpContext = pContext || {};
		if (!tmpContext.Counters)
		{
			tmpContext.Counters = { Relations: 0, BehaviorRuns: 0, Statements: 0 };
		}
		let tmpExecution = this.newExecution(tmpContext);
		tmpExecution.CubeFallbacks = [];
		tmpExecution.Staged = { Relations: 0, Keys: 0 };
		let tmpStagedStart = { Relations: tmpContext.Counters.StagedRelations || 0, Keys: tmpContext.Counters.StagedKeys || 0 };
		let tmpAggs = Array.isArray(pAggs) ? pAggs : [];
		if (!this.fable.RetoldFacetingScopedRelationBuilder || !this.fable.RetoldFacetingShellTemplates || !tmpContext.Host)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The live engine is not wired.'));
		}

		// Phase 0: capability, and one group per (Pivot, Variant); each TuplePivot Agg alone.
		let tmpGroups = [];
		let tmpGroupsByKey = Object.create(null);
		let tmpCapable = [];
		for (let i = 0; i < tmpAggs.length; i++)
		{
			let tmpAgg = tmpAggs[i];
			let tmpCheck = this.capable(tmpAgg, tmpContext);
			if (!tmpCheck.Capable)
			{
				tmpExecution.Errors[tmpAgg && tmpAgg.Key ? tmpAgg.Key : `#${i}`] = libFacetErrors.toEntry(libFacetErrors.create('FACET_FOLD_UNSUPPORTED', null, { Feature: tmpCheck.Reason, Milestone: 2 }));
				continue;
			}
			let tmpVariant = this.variantFor(tmpContext, tmpAgg);
			if (!tmpVariant)
			{
				tmpExecution.Errors[tmpAgg.Key] = libFacetErrors.toEntry(libFacetErrors.create('FACET_INTERNAL', 'The facet has no plan variant.'));
				continue;
			}
			tmpCapable.push(tmpAgg);
			let tmpGroupKey = this.isTuple(tmpAgg) ? `tuple|${tmpAgg.Key}` : `${tmpAgg.Pivot}|${tmpVariant.VariantId}`;
			if (!hasOwn(tmpGroupsByKey, tmpGroupKey))
			{
				tmpGroupsByKey[tmpGroupKey] = { Entity: tmpAgg.Pivot, Variant: tmpVariant, Tuple: this.isTuple(tmpAgg), Aggs: [], Relations: {}, Error: null, PivotColumns: [] };
				tmpGroups.push(tmpGroupsByKey[tmpGroupKey]);
			}
			tmpGroupsByKey[tmpGroupKey].Aggs.push(tmpAgg);
		}

		let tmpWork = [];
		let tmpDone = new Set();

		// Phase 1: cubes (sequential).
		let fCubes = (fNext) =>
		{
			let tmpCubes = this.cubePlans(tmpContext);
			let tmpCubeExecutor = this.fable.RetoldFacetingCubeExecutor;
			if ((tmpCubes.length < 1) || !tmpCubeExecutor || (tmpContext.PlanForm && (tmpContext.PlanForm.Cube === 'Never')))
			{
				return fNext();
			}
			this.fable.Utility.eachLimit(tmpCubes, 1,
				(pCubePlan, fCubeDone) =>
				{
					let tmpMembers = (Array.isArray(pCubePlan.Members) ? pCubePlan.Members : []).map(
						(pMember) =>
						{
							return tmpCapable.find((pAgg) => { return (pAgg.Key === pMember.AggKey) && !this.isTuple(pAgg); });
						});
					if ((tmpMembers.length < 1) || tmpMembers.some((pAgg) => { return !pAgg; }))
					{
						// A member was refused or is missing: every member runs per Variant.
						tmpExecution.CubeFallbacks.push(pCubePlan.CubeId);
						return fCubeDone();
					}
					tmpCubeExecutor.execute(tmpContext, tmpExecution, pCubePlan, tmpMembers,
						(pCubeError, pCubeResult) =>
						{
							if (pCubeError)
							{
								return fCubeDone(pCubeError);
							}
							if (!pCubeResult || pCubeResult.FellBack)
							{
								tmpExecution.CubeFallbacks.push(pCubePlan.CubeId);
								return fCubeDone();
							}
							let tmpKeys = Object.keys(pCubeResult.Results || {});
							for (let i = 0; i < tmpKeys.length; i++)
							{
								tmpExecution.Results[tmpKeys[i]] = pCubeResult.Results[tmpKeys[i]];
								tmpDone.add(tmpKeys[i]);
							}
							let tmpErrorKeys = Object.keys(pCubeResult.Errors || {});
							for (let i = 0; i < tmpErrorKeys.length; i++)
							{
								tmpExecution.Errors[tmpErrorKeys[i]] = pCubeResult.Errors[tmpErrorKeys[i]];
								tmpDone.add(tmpErrorKeys[i]);
							}
							return fCubeDone();
						});
				},
				(pError) =>
				{
					if (pError)
					{
						return fCallback(pError);
					}
					return fNext();
				});
		};

		// Phase 2: per group, sequentially: relations and composed statements.
		let fCompose = (pIndex) =>
		{
			if (pIndex >= tmpGroups.length)
			{
				return fRunStatements();
			}
			let tmpGroup = tmpGroups[pIndex];
			tmpGroup.Aggs = tmpGroup.Aggs.filter((pAgg) => { return !tmpDone.has(pAgg.Key); });
			if (tmpGroup.Aggs.length < 1)
			{
				return fCompose(pIndex + 1);
			}
			let fGroupFinished = (pGroupError) =>
			{
				if (pGroupError)
				{
					return fCallback(pGroupError);
				}
				return fCompose(pIndex + 1);
			};
			this.composeGroup(tmpContext, tmpExecution, tmpGroup, tmpWork, fGroupFinished);
		};

		// Phase 3: statements, bounded parallelism (per-Agg failures land in Execution.Errors).
		let fRunStatements = () =>
		{
			let tmpOptions = tmpContext.Options || this.options;
			let tmpParallel = (tmpOptions.Execution && (tmpOptions.Execution.MaxParallelStatements >= 1)) ? Math.floor(tmpOptions.Execution.MaxParallelStatements) : 4;
			this.fable.Utility.eachLimit(tmpWork, tmpParallel,
				(pItem, fItemDone) =>
				{
					this.runComposed(tmpContext, tmpExecution, pItem.Agg, pItem.Composed,
						(pAggError, pRaw) =>
						{
							if (pAggError)
							{
								tmpExecution.Errors[pItem.Agg.Key] = libFacetErrors.toEntry(pAggError);
							}
							else
							{
								tmpExecution.Results[pItem.Agg.Key] = pRaw;
							}
							return fItemDone();
						});
				},
				() =>
				{
					tmpExecution.Staged = (
						{
							Relations: (tmpContext.Counters.StagedRelations || 0) - tmpStagedStart.Relations,
							Keys: (tmpContext.Counters.StagedKeys || 0) - tmpStagedStart.Keys
						});
					return fCallback(null, tmpExecution);
				});
		};

		return fCubes(() => { return fCompose(0); });
	}

	/**
	 * The cube plans of the request (Plan.Cubes, §25.2), wherever the pipeline put them.
	 *
	 * @param {Record<string, any>} pContext
	 * @return {Array<Record<string, any>>}
	 */
	cubePlans(pContext)
	{
		let tmpCubes = (pContext && Array.isArray(pContext.Cubes)) ? pContext.Cubes
			: (pContext && pContext.Plan && Array.isArray(pContext.Plan.Cubes)) ? pContext.Plan.Cubes
			: [];
		return tmpCubes.filter((pCube) => { return pCube && (typeof(pCube.CubeId) === 'string'); });
	}

	/**
	 * Fold a relation's capture into Execution.Captures[Entity] (Fingerprint and Repaired for Version
	 * and the X-Retold-Facet-Scope-Repaired header).
	 *
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pRelation
	 */
	recordCapture(pExecution, pRelation)
	{
		this.recordEntityCapture(pExecution, pRelation.Entity, pRelation.Capture);
	}

	/**
	 * Record every relation of a relations map (§26.6).
	 *
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, Record<string, any>>} pRelations
	 */
	recordCaptures(pExecution, pRelations)
	{
		let tmpAliases = Object.keys(pRelations || {});
		for (let i = 0; i < tmpAliases.length; i++)
		{
			let tmpRelation = pRelations[tmpAliases[i]];
			if (tmpRelation && tmpRelation.Capture)
			{
				this.recordCapture(pExecution, tmpRelation);
			}
		}
	}

	/**
	 * Is a relation error whole-request (the caller fails the request) or per Agg?
	 *
	 * @param {Error} pError
	 * @param {boolean} pFilterLevel - true for the pivot / Variant path-predicate relations
	 * @return {boolean}
	 */
	isWholeRequestError(pError, pFilterLevel)
	{
		if (!libFacetErrors.isFacetError(pError))
		{
			return true;
		}
		if (WHOLE_REQUEST_AGG_ERRORS.indexOf(pError.Code) >= 0)
		{
			return true;
		}
		if (pFilterLevel)
		{
			// The request filter's hops (§19.7): a path too broad fails the request; budgets and
			// unsupported shapes stay with the Aggs that need them (M1 behavior for the pivot).
			return (PER_AGG_RELATION_ERRORS.indexOf(pError.Code) < 0);
		}
		// A facet's own relations fail that facet only (§19.7), except a refused principal.
		return false;
	}

	/**
	 * Phase 2 for one group: build the pivot relation (entity groups), the Variant's path-predicate
	 * hops, then compose each Agg.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pGroup
	 * @param {Array<Record<string, any>>} pWork - receives { Agg, Composed }
	 * @param {(pError?: Error) => void} fCallback - pError only for whole-request failures
	 */
	composeGroup(pContext, pExecution, pGroup, pWork, fCallback)
	{
		let tmpComposer = this.composer;
		let fFailGroup = (pError) =>
		{
			for (let i = 0; i < pGroup.Aggs.length; i++)
			{
				pExecution.Errors[pGroup.Aggs[i].Key] = libFacetErrors.toEntry(pError);
			}
			return fCallback(null);
		};

		// The Variant's path predicates (shared by every Agg of the group).
		let tmpVariantNeeds = tmpComposer.newNeeds();
		try
		{
			tmpComposer.collectPred(tmpVariantNeeds, pGroup.Variant.PathPred);
		}
		catch (pCollectError)
		{
			return fFailGroup(libFacetErrors.isFacetError(pCollectError) ? pCollectError : libFacetErrors.create('FACET_INTERNAL'));
		}

		let fComposeAggs = () =>
		{
			let tmpAggs = pGroup.Aggs.slice();
			let fNextAgg = (pIndex) =>
			{
				if (pIndex >= tmpAggs.length)
				{
					return fCallback(null);
				}
				let tmpAgg = tmpAggs[pIndex];
				this.composeAgg(pContext, pExecution, tmpAgg, pGroup, tmpVariantNeeds,
					(pError, pComposed) =>
					{
						if (pError)
						{
							if (this.isWholeRequestError(pError, false))
							{
								return fCallback(pError);
							}
							pExecution.Errors[tmpAgg.Key] = libFacetErrors.toEntry(pError);
							return fNextAgg(pIndex + 1);
						}
						pWork.push({ Agg: tmpAgg, Composed: pComposed });
						return fNextAgg(pIndex + 1);
					});
			};
			return fNextAgg(0);
		};

		if (pGroup.Tuple)
		{
			// TuplePivot sides are built per Agg (composeAgg); the Variant's path-predicate hops (they
			// correlate with the Home side 'p') are the request filter's: whole-request errors.
			return tmpComposer.buildUses(pContext, tmpVariantNeeds, pGroup.Relations,
				(pHopError) =>
				{
					this.recordCaptures(pExecution, pGroup.Relations);
					if (pHopError)
					{
						if (!this.isWholeRequestError(pHopError, true))
						{
							return fFailGroup(pHopError);
						}
						return fCallback(pHopError);
					}
					return fComposeAggs();
				});
		}

		// The pivot relation: every column any Agg of the group (or the Variant) reads on 'p'.
		let tmpColumns = tmpComposer.columnsOf(tmpVariantNeeds, 'p');
		try
		{
			for (let i = 0; i < pGroup.Aggs.length; i++)
			{
				tmpColumns = tmpColumns.concat(tmpComposer.columnsOf(this.aggNeeds(pGroup.Aggs[i]), 'p'));
			}
		}
		catch (pNeedsError)
		{
			return fFailGroup(libFacetErrors.isFacetError(pNeedsError) ? pNeedsError : libFacetErrors.create('FACET_INTERNAL'));
		}
		pGroup.PivotColumns = tmpColumns;
		this.fable.RetoldFacetingScopedRelationBuilder.buildRelation(pContext, this.pivotRel(pContext, pGroup.Entity, pGroup.Variant, tmpColumns),
			(pRelationError, pRelation) =>
			{
				if (pRelationError)
				{
					if (!this.isWholeRequestError(pRelationError, true))
					{
						return fFailGroup(pRelationError);
					}
					return fCallback(pRelationError);
				}
				pGroup.Relations.p = pRelation;
				this.recordCapture(pExecution, pRelation);
				tmpComposer.buildUses(pContext, tmpVariantNeeds, pGroup.Relations,
					(pHopError) =>
					{
						this.recordCaptures(pExecution, pGroup.Relations);
						if (pHopError)
						{
							if (!this.isWholeRequestError(pHopError, true))
							{
								return fFailGroup(pHopError);
							}
							return fCallback(pHopError);
						}
						return fComposeAggs();
					});
			});
	}

	/**
	 * Compose one Agg: build its own relations, then its base and statement specs.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pGroup
	 * @param {Record<string, any>} pVariantNeeds
	 * @param {(pError?: Error, pComposed?: Record<string, any>) => void} fCallback
	 */
	composeAgg(pContext, pExecution, pAgg, pGroup, pVariantNeeds, fCallback)
	{
		let tmpComposer = this.composer;
		let tmpNeeds;
		try
		{
			tmpNeeds = this.aggNeeds(pAgg);
		}
		catch (pNeedsError)
		{
			return fCallback(libFacetErrors.isFacetError(pNeedsError) ? pNeedsError : libFacetErrors.create('FACET_INTERNAL'));
		}
		let tmpRelations = Object.assign({}, pGroup.Relations);

		let fComposed = () =>
		{
			this.recordCaptures(pExecution, tmpRelations);
			let tmpComposed;
			try
			{
				tmpComposed = this.composeStatements(pContext, pAgg, pGroup, tmpRelations, tmpNeeds);
			}
			catch (pComposeError)
			{
				if (!libFacetErrors.isFacetError(pComposeError))
				{
					this.fable.log.error(`RetoldFaceting Live could not compose facet ${libRetoldFacetingUtil.logSafe(pAgg.Key)} (${pAgg.Kind}): ${pComposeError.message}`);
				}
				return fCallback(libFacetErrors.isFacetError(pComposeError) ? pComposeError : libFacetErrors.create('FACET_INTERNAL'));
			}
			return fCallback(null, tmpComposed);
		};

		if (pGroup.Tuple)
		{
			// The sides (the Home side 'p' carries the Variant's column conjuncts; the Variant hops are
			// already built at group level), then the Agg's own hops.
			let tmpSides = pAgg.Tuple.Sides;
			let fSide = (pIndex) =>
			{
				if (pIndex >= tmpSides.length)
				{
					return tmpComposer.buildUses(pContext, tmpNeeds, tmpRelations,
						(pAggHopError) =>
						{
							return pAggHopError ? fCallback(pAggHopError) : fComposed();
						});
				}
				let tmpSide = tmpSides[pIndex];
				let tmpPrimaryKey = pContext.Host.getPrimaryKey(tmpSide.Rel.Entity);
				let tmpHome = (pIndex === 0);
				let tmpColumns = tmpComposer.columnsOf(tmpNeeds, tmpSide.Alias).concat(tmpHome ? tmpComposer.columnsOf(pVariantNeeds, 'p') : []);
				let tmpRel = Object.assign({ Scope: 'Inherit' }, tmpSide.Rel,
					{
						Project: tmpComposer.projection(tmpPrimaryKey, tmpColumns),
						Client: tmpHome ? (Array.isArray(tmpSide.Rel.Client) ? tmpSide.Rel.Client : pGroup.Variant.Conjuncts) : null,
						SoftDelete: tmpSide.Rel.SoftDelete || ((tmpHome && pGroup.Variant.IncludesDeleted) ? 'ClientControlled' : 'Explicit')
					});
				this.fable.RetoldFacetingScopedRelationBuilder.buildRelation(pContext, tmpRel,
					(pSideError, pSideRelation) =>
					{
						if (pSideError)
						{
							return fCallback(pSideError);
						}
						tmpRelations[tmpSide.Alias] = pSideRelation;
						return fSide(pIndex + 1);
					});
			};
			return fSide(0);
		}

		return tmpComposer.buildUses(pContext, tmpNeeds, tmpRelations,
			(pHopError) =>
			{
				if (pHopError)
				{
					return fCallback(pHopError);
				}
				return fComposed();
			});
	}

	/**
	 * The composed base and statement specs of one Agg (synchronous; every relation is built).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pGroup
	 * @param {Record<string, Record<string, any>>} pRelations
	 * @param {Record<string, any>} pNeeds - the Agg's own needs (Multi chain columns)
	 * @return {{ Agg: Record<string, any>, Base: { SQL: string, Params: Record<string, any>, ParamTypes: Record<string, any>, Dialect: string }, Slots: Record<string, any>, Multi: boolean }}
	 */
	composeStatements(pContext, pAgg, pGroup, pRelations, pNeeds)
	{
		let tmpComposer = this.composer;
		let tmpPivot = pRelations.p;
		let tmpDialect = tmpPivot.Dialect;
		let tmpSession = tmpComposer.newSession(tmpDialect, pRelations);
		let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
		let tmpShellAgg = Object.assign({}, pAgg);
		let tmpSlots = {};
		let tmpBaseSQL;

		if (pGroup.Tuple)
		{
			let tmpTupleBase = tmpComposer.tupleBase(pContext, tmpSession, pAgg.Tuple, [ pGroup.Variant.PathPred, pAgg.Where || null ], tmpDimensions);
			tmpBaseSQL = tmpTupleBase.SQL;
			tmpShellAgg.Dimensions = tmpTupleBase.Dimensions;
		}
		else
		{
			let tmpMulti = (tmpDimensions.length > 0) && (tmpDimensions[0].Kind === 'Multi');
			let tmpEntityBase = tmpComposer.entityBase(pContext, tmpSession,
				{
					Columns: tmpPivot.Columns,
					Preds: [ pGroup.Variant.PathPred, pAgg.Where || null ],
					Flags: [],
					Dimensions: tmpMulti ? [] : tmpDimensions,
					ChildAggForm: (pContext.PlanForm && (pContext.PlanForm.ChildAgg === 'Restricted')) ? 'Restricted' : 'Correlated'
				});
			tmpBaseSQL = tmpEntityBase.SQL;
			if (tmpMulti)
			{
				let tmpPieces = tmpComposer.multiPieces(pContext, tmpSession, tmpDimensions[0], pNeeds);
				tmpSlots.JOINS = tmpPieces.JOINS;
				tmpSlots.AND_WHERE = tmpPieces.AND_WHERE;
				tmpSlots.KeyAlias = tmpPieces.KeyAlias;
				tmpSlots.PrimaryKey = pContext.Host.getPrimaryKey(pAgg.Pivot);
			}
			else
			{
				tmpShellAgg.Dimensions = tmpEntityBase.Dimensions;
			}
		}
		return (
			{
				Agg: tmpShellAgg,
				Multi: (tmpDimensions.length > 0) && (tmpDimensions[0].Kind === 'Multi'),
				Base: { SQL: tmpBaseSQL, Params: tmpSession.Params, ParamTypes: tmpSession.ParamTypes, Dialect: tmpDialect },
				Slots: tmpSlots
			});
	}

	// ================================================================== statements

	/**
	 * An empty RawFacetResult for an Agg (internal-contracts §9.2).
	 *
	 * @param {Record<string, any>} pAgg
	 * @return {Record<string, any>}
	 */
	newRaw(pAgg)
	{
		return (
			{
				Key: pAgg.Key,
				Kind: pAgg.Kind,
				VariantId: (typeof(pAgg.VariantId) === 'string') ? pAgg.VariantId : 'v0',
				Total: 0,
				MissingCount: 0,
				Groups: [],
				DistinctKeys: null,
				Bounds: null,
				Geometry: null,
				Stats: null,
				DistinctCount: null,
				Cells: null
			});
	}

	/**
	 * The dialect statements are composed in: the relation's (the ScopedRelationBuilder resolved it
	 * through the Host and refused an unknown one).  A relation without one is a wiring bug.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pRelation
	 * @return {string}
	 */
	dialectFor(pContext, pAgg, pRelation)
	{
		if (pRelation && (typeof(pRelation.Dialect) === 'string') && (pRelation.Dialect.length > 0))
		{
			return pRelation.Dialect;
		}
		throw libFacetErrors.create('FACET_INTERNAL', 'The scoped relation has no dialect.');
	}

	/**
	 * Compose one statement on a fresh pivot query: relations spliced through _Params, their binds
	 * merged, the shell's slots / binds / override applied.  Nothing executes.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pAgg
	 * @param {Array<Record<string, any>>} pRelations - [ pivot relation | composed base ] (SR0, SR1, …)
	 * @param {string} pDialectName
	 * @param {Record<string, any>} pSlots - ShellTemplates.render options (Shell, Geometry, JOINS, …)
	 * @return {{ DAL: any, Query: any, Shell: Record<string, any> }}
	 */
	composeStatement(pContext, pAgg, pRelations, pDialectName, pSlots)
	{
		let tmpDAL = pContext.Host.getExecutionDAL(pAgg.Pivot);
		if (!tmpDAL)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The pivot entity has no DAL.');
		}
		let tmpShell = this.fable.RetoldFacetingShellTemplates.render(pDialectName, pAgg, pSlots || {});
		let tmpQuery = tmpDAL.query;
		// The relations carry every filter, scope and soft-delete; the outer statement adds none.
		tmpQuery.setDisableDeleteTracking(true);
		let tmpDialects = this.fable.RetoldFacetingDialects;
		for (let i = 0; i < pRelations.length; i++)
		{
			tmpQuery.parameters[`SR${i}`] = pRelations[i].SQL;
			Object.assign(tmpQuery.query.parameters, pRelations[i].Params);
			if (tmpDialects)
			{
				tmpDialects.mergeParameterTypes(tmpQuery, pRelations[i].ParamTypes || {});
			}
		}
		this.fable.RetoldFacetingShellTemplates.applyToQuery(tmpQuery, tmpShell);
		return { DAL: tmpDAL, Query: tmpQuery, Shell: tmpShell };
	}

	/**
	 * Compose and dry-build one statement (SQL text + binds), no provider.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pAgg
	 * @param {Array<Record<string, any>>} pRelations
	 * @param {string} pDialectName
	 * @param {Record<string, any>} [pSlots]
	 * @return {{ Name: string, SQL: string, Params: Record<string, any>, ParamTypes: Record<string, any> }}
	 */
	compileStatement(pContext, pAgg, pRelations, pDialectName, pSlots)
	{
		let tmpComposed = this.composeStatement(pContext, pAgg, pRelations, pDialectName, pSlots);
		tmpComposed.Query.setDialect(pDialectName).buildReadQuery();
		let tmpBody = tmpComposed.Query.query.body;
		if ((typeof(tmpBody) !== 'string') || (tmpBody.length < 1))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The facet statement did not build.');
		}
		return (
			{
				Name: tmpComposed.Shell.Name,
				SQL: tmpBody,
				Params: Object.assign({}, tmpComposed.Query.query.parameters),
				ParamTypes: Object.assign({}, tmpComposed.Query.query.parameterTypes || {})
			});
	}

	/**
	 * Compile one Agg to SQL without executing (the O9 golden entry point).  A Nice NumericHistogram
	 * needs its bounds first, so its bucket statement is included only when pOptions.Geometry is given.
	 * pRelations is [ the pivot relation ] (M1 shape) or the composed base { SQL, Params, ParamTypes }.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pAgg - the Agg (for an M2 Agg: the composed shell Agg)
	 * @param {Array<Record<string, any>>} pRelations - ScopedRelationBuilder results (internal-contracts §7.3)
	 * @param {string} pDialectName - 'SQLite' | 'PostgreSQL' | 'MySQL' | 'MSSQL'
	 * @param {{ Geometry?: Record<string, any>, Slots?: Record<string, any>, Multi?: boolean }} [pOptions]
	 * @return {{ Dialect: string, SQL: string, Params: Record<string, any>, ParamTypes: Record<string, any>, Statements: Array<Record<string, any>> }}
	 */
	compileAgg(pContext, pAgg, pRelations, pDialectName, pOptions)
	{
		let tmpOptions = pOptions || {};
		let tmpSlots = tmpOptions.Slots || {};
		let tmpStatements = [];
		let fSlots = (pExtra) => { return Object.assign({}, tmpSlots, pExtra); };
		if (tmpOptions.Multi)
		{
			tmpStatements.push(this.compileStatement(pContext, pAgg, pRelations, pDialectName, fSlots({ Shell: 'MultiTerms' })));
			tmpStatements.push(this.compileStatement(pContext, pAgg, pRelations, pDialectName, { Shell: 'Count' }));
			tmpStatements.push(this.compileStatement(pContext, pAgg, pRelations, pDialectName, fSlots({ Shell: 'MultiCovered' })));
		}
		else if (pAgg.Kind === 'NumericHistogram')
		{
			tmpStatements.push(this.compileStatement(pContext, pAgg, pRelations, pDialectName, fSlots({ Shell: 'NumericBounds' })));
			let tmpDimension = pAgg.Dimensions[0];
			let tmpGeometry = tmpOptions.Geometry || null;
			if (!tmpGeometry && (tmpDimension.Mode === 'Edges'))
			{
				tmpGeometry = { Mode: 'Edges', Edges: tmpDimension.Edges, OpenEnded: !!tmpDimension.OpenEnded };
			}
			if (tmpGeometry)
			{
				tmpStatements.push(this.compileStatement(pContext, pAgg, pRelations, pDialectName, fSlots({ Geometry: tmpGeometry })));
			}
		}
		else
		{
			tmpStatements.push(this.compileStatement(pContext, pAgg, pRelations, pDialectName, fSlots({})));
		}
		return (
			{
				Dialect: pDialectName,
				SQL: tmpStatements[0].SQL,
				Params: tmpStatements[0].Params,
				ParamTypes: tmpStatements[0].ParamTypes,
				Statements: tmpStatements
			});
	}

	/**
	 * Compose an Agg end to end (relations built in pContext.Dialect, memoized) and dry-build its
	 * statements without executing: the O9 golden entry point for M2 Aggs.
	 *
	 * @param {Record<string, any>} pContext - Variants set; Dialect pins the rendering dialect
	 * @param {Record<string, any>} pAgg
	 * @param {{ Geometry?: Record<string, any> }} [pOptions]
	 * @param {(pError?: Error, pCompiled?: Record<string, any>) => void} fCallback
	 */
	compileComposedAgg(pContext, pAgg, pOptions, fCallback)
	{
		let tmpVariant = this.variantFor(pContext, pAgg);
		if (!tmpVariant)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The facet has no plan variant.'));
		}
		let tmpExecution = this.newExecution(pContext);
		let tmpGroup = { Entity: pAgg.Pivot, Variant: tmpVariant, Tuple: this.isTuple(pAgg), Aggs: [ pAgg ], Relations: {}, Error: null, PivotColumns: [] };
		let tmpWork = [];
		this.composeGroup(pContext, tmpExecution, tmpGroup, tmpWork,
			(pError) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if (tmpWork.length < 1)
				{
					let tmpEntry = tmpExecution.Errors[pAgg.Key];
					return fCallback(libFacetErrors.create(tmpEntry ? tmpEntry.Code : 'FACET_INTERNAL', null, tmpEntry ? tmpEntry.Detail : undefined));
				}
				let tmpComposed = tmpWork[0].Composed;
				let tmpCompiled;
				try
				{
					tmpCompiled = this.compileAgg(pContext, tmpComposed.Agg, [ tmpComposed.Base ], tmpComposed.Base.Dialect, Object.assign({}, pOptions || {}, { Slots: tmpComposed.Slots, Multi: tmpComposed.Multi }));
				}
				catch (pCompileError)
				{
					return fCallback(libFacetErrors.isFacetError(pCompileError) ? pCompileError : libFacetErrors.create('FACET_INTERNAL', pCompileError.message));
				}
				tmpCompiled.Captures = tmpExecution.Captures;
				return fCallback(null, tmpCompiled);
			});
	}

	/**
	 * Execute one composed statement with the pivot DAL's provider.Read; raw rows copied to plain objects.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pRelation - the pivot relation or the composed base (SQL, Params, ParamTypes, Dialect)
	 * @param {Record<string, any>} pSlots
	 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
	 */
	runStatement(pContext, pExecution, pAgg, pRelation, pSlots, fCallback)
	{
		if ((typeof(pContext.Deadline) === 'number') && (Date.now() > pContext.Deadline))
		{
			return fCallback(libFacetErrors.create('FACET_TIMEOUT'));
		}
		let tmpComposed;
		try
		{
			tmpComposed = this.composeStatement(pContext, pAgg, [ pRelation ], this.dialectFor(pContext, pAgg, pRelation), pSlots);
		}
		catch (pComposeError)
		{
			this.fable.log.error(`RetoldFaceting Live could not compose facet ${libRetoldFacetingUtil.logSafe(pAgg.Key)} (${pAgg.Kind}) of request ${pContext.RequestID || '?'}: ${pComposeError.message}`);
			return fCallback(libFacetErrors.isFacetError(pComposeError) ? pComposeError : libFacetErrors.create('FACET_INTERNAL'));
		}
		return this.readQuery(pContext, pExecution, tmpComposed.DAL, tmpComposed.Query, `facet ${libRetoldFacetingUtil.logSafe(pAgg.Key)} (${pAgg.Kind})`, fCallback);
	}

	/**
	 * Run a composed FoxHound query through a DAL's provider.Read (synchronous providers are
	 * continued after Read returns); raw rows copied to plain objects.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>|null} pExecution - Statements counter (may be null)
	 * @param {any} pDAL
	 * @param {any} pQuery
	 * @param {string} pWhat - for the log
	 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
	 */
	readQuery(pContext, pExecution, pDAL, pQuery, pWhat, fCallback)
	{
		pContext.Counters.Statements = (pContext.Counters.Statements || 0) + 1;
		if (pExecution)
		{
			pExecution.Statements++;
		}

		let tmpCalledBack = false;
		let tmpSynchronous = true;
		let tmpPending = null;
		let fFinish = (pError) =>
		{
			if (pError)
			{
				// Driver messages never carry bound values on SQLite/PG; the SQL text is ours.
				this.fable.log.error(`RetoldFaceting Live statement failed for ${pWhat} of request ${pContext.RequestID || '?'}: ${pError.message}`);
				return fCallback(libFacetErrors.create('FACET_INTERNAL'));
			}
			let tmpResult = pQuery.parameters.result || {};
			let tmpRows = Array.isArray(tmpResult.value) ? tmpResult.value : [];
			// node:sqlite rows are null-prototype objects; hand back plain ones.
			return fCallback(null, tmpRows.map((pRow) => { return Object.assign({}, pRow); }));
		};
		let fReadDone = () =>
		{
			if (tmpCalledBack)
			{
				return;
			}
			tmpCalledBack = true;
			let tmpResult = pQuery.parameters.result || {};
			let tmpError = tmpResult.error ? tmpResult.error : null;
			if (tmpSynchronous)
			{
				tmpPending = { Error: tmpError };
				return;
			}
			return fFinish(tmpError);
		};
		try
		{
			// A broken override throws synchronously on PostgreSQL (03 §1).
			pDAL.provider.Read(pQuery, fReadDone);
		}
		catch (pReadError)
		{
			if (!tmpCalledBack)
			{
				tmpCalledBack = true;
				tmpPending = { Error: pReadError };
			}
		}
		tmpSynchronous = false;
		if (tmpPending)
		{
			return fFinish(tmpPending.Error);
		}
	}

	/**
	 * Run one Agg (M1 signature: the pivot relation).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pRelation
	 * @param {(pError?: Error, pRaw?: Record<string, any>) => void} fCallback
	 */
	runAgg(pContext, pExecution, pAgg, pRelation, fCallback)
	{
		return this.runComposed(pContext, pExecution, pAgg, { Agg: pAgg, Base: pRelation, Slots: {}, Multi: false }, fCallback);
	}

	/**
	 * Run a composed Agg (one statement; NumericHistogram: bounds then buckets; K9: terms, total,
	 * covered) into a RawFacetResult.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pAgg - the original Agg (Key, Kind)
	 * @param {{ Agg: Record<string, any>, Base: Record<string, any>, Slots: Record<string, any>, Multi: boolean }} pComposed
	 * @param {(pError?: Error, pRaw?: Record<string, any>) => void} fCallback
	 */
	runComposed(pContext, pExecution, pAgg, pComposed, fCallback)
	{
		let tmpShellAgg = pComposed.Agg;
		if (pComposed.Multi)
		{
			return this.runMulti(pContext, pExecution, tmpShellAgg, pComposed, fCallback);
		}
		if (tmpShellAgg.Kind === 'NumericHistogram')
		{
			return this.runNumericHistogram(pContext, pExecution, tmpShellAgg, pComposed.Base, fCallback);
		}
		this.runStatement(pContext, pExecution, tmpShellAgg, pComposed.Base, Object.assign({}, pComposed.Slots),
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpRaw;
				try
				{
					tmpRaw = this.foldRows(pContext, tmpShellAgg, pRows);
				}
				catch (pFoldError)
				{
					this.fable.log.error(`RetoldFaceting Live could not read the rows of facet ${libRetoldFacetingUtil.logSafe(pAgg.Key)} (${pAgg.Kind}): ${pFoldError.message}`);
					return fCallback(libFacetErrors.isFacetError(pFoldError) ? pFoldError : libFacetErrors.create('FACET_INTERNAL'));
				}
				return fCallback(null, tmpRaw);
			});
	}

	/**
	 * K9 (Multi): the ranked two-level-distinct Terms statement, the pivot Total, and the pivot rows
	 * with at least one key (MissingCount = Total - Covered).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pComposed
	 * @param {(pError?: Error, pRaw?: Record<string, any>) => void} fCallback
	 */
	runMulti(pContext, pExecution, pAgg, pComposed, fCallback)
	{
		let tmpRaw = this.newRaw(pAgg);
		let tmpDimension = pAgg.Dimensions[0];
		this.runStatement(pContext, pExecution, pAgg, pComposed.Base, Object.assign({ Shell: 'MultiTerms' }, pComposed.Slots),
			(pTermsError, pTermsRows) =>
			{
				if (pTermsError)
				{
					return fCallback(pTermsError);
				}
				this.runStatement(pContext, pExecution, pAgg, pComposed.Base, { Shell: 'Count' },
					(pTotalError, pTotalRows) =>
					{
						if (pTotalError)
						{
							return fCallback(pTotalError);
						}
						this.runStatement(pContext, pExecution, pAgg, pComposed.Base, Object.assign({ Shell: 'MultiCovered' }, pComposed.Slots),
							(pCoveredError, pCoveredRows) =>
							{
								if (pCoveredError)
								{
									return fCallback(pCoveredError);
								}
								tmpRaw.Total = toCount(pTotalRows[0] ? pTotalRows[0].Total : 0);
								tmpRaw.MissingCount = Math.max(0, tmpRaw.Total - toCount(pCoveredRows[0] ? pCoveredRows[0].Covered : 0));
								tmpRaw.DistinctKeys = (pTermsRows.length > 0) ? toCount(pTermsRows[0].FacetDistinct) : 0;
								for (let i = 0; i < pTermsRows.length; i++)
								{
									let tmpKey = rawKey(pTermsRows[i].Key);
									if (tmpKey === null)
									{
										continue;
									}
									tmpRaw.Groups.push({ Key: libFacetEnvelope.normalizeKey(tmpKey, tmpDimension.DataType), Count: toCount(pTermsRows[i].Count) });
								}
								return fCallback(null, tmpRaw);
							});
					});
			});
	}

	/**
	 * NumericHistogram: the bounds statement, the geometry (canonical contract math), then the bucket
	 * statement over non-null values.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pRelation
	 * @param {(pError?: Error, pRaw?: Record<string, any>) => void} fCallback
	 */
	runNumericHistogram(pContext, pExecution, pAgg, pRelation, fCallback)
	{
		let tmpOptions = pContext.Options || this.options;
		let tmpLimits = tmpOptions.Limits || {};
		let tmpDimension = pAgg.Dimensions[0];
		let tmpRaw = this.newRaw(pAgg);
		this.runStatement(pContext, pExecution, pAgg, pRelation, { Shell: 'NumericBounds' },
			(pBoundsError, pBoundsRows) =>
			{
				if (pBoundsError)
				{
					return fCallback(pBoundsError);
				}
				let tmpGeometry;
				try
				{
					let tmpRow = pBoundsRows[0] || {};
					let tmpRows = toCount(tmpRow.Rows);
					let tmpNonNull = toCount(tmpRow.NonNull);
					tmpRaw.Total = tmpRows;
					tmpRaw.MissingCount = tmpRows - tmpNonNull;
					tmpRaw.Bounds = (tmpNonNull > 0) ? { Lo: toNumber(tmpRow.Lo), Hi: toNumber(tmpRow.Hi) } : null;
					tmpGeometry = this.numericGeometryFor(pContext, tmpDimension, tmpRaw.Bounds);
					tmpRaw.Geometry = tmpGeometry;
				}
				catch (pGeometryError)
				{
					this.fable.log.error(`RetoldFaceting Live could not compute the geometry of facet ${libRetoldFacetingUtil.logSafe(pAgg.Key)}: ${pGeometryError.message}`);
					return fCallback(libFacetErrors.isFacetError(pGeometryError) ? pGeometryError : libFacetErrors.create('FACET_INTERNAL'));
				}
				if ((tmpRaw.Bounds === null) || !(tmpGeometry.N >= 1))
				{
					return fCallback(null, tmpRaw);
				}
				let tmpShellGeometry = (tmpDimension.Mode === 'Edges')
					? { Mode: 'Edges', Edges: tmpGeometry.Edges || tmpDimension.Edges, OpenEnded: !!tmpDimension.OpenEnded }
					: { Mode: 'Nice', Factor: tmpGeometry.Factor, LoUnits: tmpGeometry.LoUnits, WidthUnits: tmpGeometry.WidthUnits, N: tmpGeometry.N };
				this.runStatement(pContext, pExecution, pAgg, pRelation, { Geometry: tmpShellGeometry },
					(pBucketError, pBucketRows) =>
					{
						if (pBucketError)
						{
							return fCallback(pBucketError);
						}
						for (let i = 0; i < pBucketRows.length; i++)
						{
							let tmpIndex = toNumber(pBucketRows[i].Key);
							if (tmpIndex === null)
							{
								// Outside an Edges geometry: no group (it surfaces as OtherCount).
								continue;
							}
							tmpRaw.Groups.push({ Key: tmpIndex, Count: toCount(pBucketRows[i].Count) });
						}
						return fCallback(null, tmpRaw);
					});
			});
	}

	/**
	 * The geometry of a numeric dimension (Edges, or Nice over the bounds).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pDimension
	 * @param {{ Lo: number, Hi: number }|null} pBounds
	 * @return {Record<string, any>}
	 */
	numericGeometryFor(pContext, pDimension, pBounds)
	{
		let tmpOptions = pContext.Options || this.options;
		let tmpLimits = tmpOptions.Limits || {};
		let tmpScale = (typeof(pDimension.Scale) === 'number') ? pDimension.Scale : 0;
		if (pDimension.Mode === 'Edges')
		{
			return libFacetBuckets.edgesGeometry(pDimension.Edges, !!pDimension.OpenEnded, tmpScale);
		}
		let tmpBuckets = (typeof(pDimension.Buckets) === 'number') ? pDimension.Buckets : (tmpLimits.DefaultBuckets || 20);
		return libFacetBuckets.numericGeometry(pBounds ? pBounds.Lo : null, pBounds ? pBounds.Hi : null, tmpBuckets, tmpScale, tmpLimits.MaxBuckets);
	}

	/**
	 * Turn the rows of a single-statement Agg into its RawFacetResult (§5.3, §24.9).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pAgg
	 * @param {Array<Record<string, any>>} pRows
	 * @return {Record<string, any>}
	 */
	foldRows(pContext, pAgg, pRows)
	{
		let tmpRaw = this.newRaw(pAgg);
		let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
		switch (pAgg.Kind)
		{
			case 'Count':
				tmpRaw.Total = toCount(pRows[0] ? pRows[0].Total : 0);
				break;

			case 'Terms':
				{
					let tmpDataType = tmpDimensions[0].DataType;
					tmpRaw.DistinctKeys = 0;
					if (pRows.length > 0)
					{
						tmpRaw.Total = toCount(pRows[0].FacetTotal);
						tmpRaw.MissingCount = toCount(pRows[0].FacetMissing);
						tmpRaw.DistinctKeys = toCount(pRows[0].FacetDistinct);
					}
					for (let i = 0; i < pRows.length; i++)
					{
						let tmpKey = rawKey(pRows[i].Key);
						if (tmpKey === null)
						{
							continue;
						}
						tmpRaw.Groups.push({ Key: libFacetEnvelope.normalizeKey(tmpKey, tmpDataType), Count: toCount(pRows[i].Count) });
					}
				}
				break;

			case 'DateHistogram':
				{
					let tmpLo = null;
					let tmpHi = null;
					for (let i = 0; i < pRows.length; i++)
					{
						let tmpCount = toCount(pRows[i].Count);
						tmpRaw.Total += tmpCount;
						let tmpKey = toDateString(pRows[i].Key);
						if (tmpKey === null)
						{
							tmpRaw.MissingCount += tmpCount;
							continue;
						}
						tmpRaw.Groups.push({ Key: tmpKey, Count: tmpCount });
						let tmpRowLo = toDateString(pRows[i].Lo);
						let tmpRowHi = toDateString(pRows[i].Hi);
						if ((tmpRowLo !== null) && ((tmpLo === null) || (tmpRowLo < tmpLo)))
						{
							tmpLo = tmpRowLo;
						}
						if ((tmpRowHi !== null) && ((tmpHi === null) || (tmpRowHi > tmpHi)))
						{
							tmpHi = tmpRowHi;
						}
					}
					tmpRaw.Bounds = (tmpLo !== null) ? { Lo: tmpLo, Hi: tmpHi } : null;
				}
				break;

			case 'Ranges':
				{
					let tmpRanges = tmpDimensions[0].Ranges;
					for (let i = 0; i < pRows.length; i++)
					{
						let tmpCount = toCount(pRows[i].Count);
						let tmpIndex = toNumber(pRows[i].Key);
						tmpRaw.Total += tmpCount;
						if (tmpIndex === -1)
						{
							tmpRaw.MissingCount += tmpCount;
						}
						else if ((tmpIndex !== null) && (tmpIndex >= 0) && (tmpIndex < tmpRanges.length))
						{
							tmpRaw.Groups.push({ Key: tmpRanges[tmpIndex].Key, Count: tmpCount });
						}
					}
				}
				break;

			case 'Stats':
				{
					let tmpRow = pRows[0] || {};
					let tmpInfo = pAgg.FieldInfo || {};
					let tmpScale = (typeof(tmpInfo.Scale) === 'number') ? tmpInfo.Scale : 0;
					let tmpIsDate = (tmpInfo.DataType === 'DateTime');
					let tmpRows = toCount(tmpRow.Rows);
					let tmpNonNull = toCount(tmpRow.NonNull);
					tmpRaw.Total = tmpRows;
					tmpRaw.MissingCount = tmpRows - tmpNonNull;
					tmpRaw.Stats = (
						{
							Rows: tmpRows,
							NonNull: tmpNonNull,
							Min: tmpIsDate ? toDateString(tmpRow.Min) : toNumber(tmpRow.Min),
							Max: tmpIsDate ? toDateString(tmpRow.Max) : toNumber(tmpRow.Max),
							SumUnits: tmpIsDate ? null : toNumber(tmpRow.SumUnits),
							Factor: tmpIsDate ? null : Math.pow(10, tmpScale)
						});
					if (tmpNonNull === 0)
					{
						tmpRaw.Stats.Min = null;
						tmpRaw.Stats.Max = null;
						tmpRaw.Stats.SumUnits = null;
					}
				}
				break;

			case 'DistinctCount':
				{
					let tmpRow = pRows[0] || {};
					let tmpRows = toCount(tmpRow.Rows);
					tmpRaw.Total = tmpRows;
					tmpRaw.MissingCount = tmpRows - toCount(tmpRow.NonNull);
					tmpRaw.DistinctCount = toCount(tmpRow.Distinct);
				}
				break;

			case 'Missing':
				{
					let tmpRow = pRows[0] || {};
					let tmpRows = toCount(tmpRow.Rows);
					tmpRaw.Total = tmpRows;
					tmpRaw.MissingCount = tmpRows - toCount(tmpRow.NonNull);
				}
				break;

			case 'Pivot':
				{
					let tmpOptions = (pContext && pContext.Options) ? pContext.Options : this.options;
					let tmpMaxCells = (tmpOptions.Limits && (tmpOptions.Limits.CubeMaxGroups >= 1)) ? tmpOptions.Limits.CubeMaxGroups : 100000;
					if (pRows.length > tmpMaxCells)
					{
						// The shell returned one cell past the limit (fMaxGroups = CubeMaxGroups + 1).
						throw libFacetErrors.create('FACET_TOO_LARGE', 'The pivot has too many cells.', { Limit: 'CubeMaxGroups', Max: tmpMaxCells, Suggest: { Top: true, Filter: true } });
					}
					tmpRaw.Cells = [];
					for (let i = 0; i < pRows.length; i++)
					{
						let tmpCount = toCount(pRows[i].Count);
						tmpRaw.Total += tmpCount;
						tmpRaw.Cells.push({ Keys: [ this.axisKey(tmpDimensions[0], pRows[i].K1), this.axisKey(tmpDimensions[1], pRows[i].K2) ], Count: tmpCount });
					}
				}
				break;

			case 'ChildRollup':
			case 'ExistsSplit':
				{
					// KeyGroups rows: one per band (K12) / flag (K20); MissingCount is always 0.
					let tmpCounts = new Map();
					for (let i = 0; i < pRows.length; i++)
					{
						let tmpCount = toCount(pRows[i].Count);
						let tmpKey = toNumber(rawKey(pRows[i].Key));
						tmpRaw.Total += tmpCount;
						if (tmpKey === null)
						{
							throw libFacetErrors.create('FACET_INTERNAL', 'A band / flag key was not a number.');
						}
						tmpCounts.set(tmpKey, (tmpCounts.get(tmpKey) || 0) + tmpCount);
					}
					if (pAgg.Kind === 'ExistsSplit')
					{
						// Always both keys, 1 then 0 (§24.9).
						tmpRaw.Groups = [ { Key: 1, Count: tmpCounts.get(1) || 0 }, { Key: 0, Count: tmpCounts.get(0) || 0 } ];
					}
					else
					{
						tmpRaw.Groups = Array.from(tmpCounts.keys()).sort((pA, pB) => { return pA - pB; }).map((pKey) => { return { Key: pKey, Count: tmpCounts.get(pKey) }; });
					}
				}
				break;

			default:
				throw libFacetErrors.create('FACET_INTERNAL', 'Unknown fold kind.');
		}
		return tmpRaw;
	}

	/**
	 * A pivot axis key exactly as the axis's single-dimension fold computes it (§5.3): on a Range
	 * axis index -1 (NULL) is null and -2 (in no declared range) is NO_RANGE_KEY, which the
	 * post-processor counts as Other, like the Ranges fold.
	 *
	 * @param {Record<string, any>} pDimension
	 * @param {any} pValue
	 * @return {any}
	 */
	axisKey(pDimension, pValue)
	{
		return libRetoldFacetingEngineBase.dimensionKey(pDimension, pValue);
	}

	// ================================================================== Records / Count / Keys

	/**
	 * Compose the full-filter base of a Records / Count / Keys request (§26.5): the pivot relation
	 * with the Variant's column conjuncts, the Variant's path predicates at the W level.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pBasePlan - { Variant, Pivot }
	 * @param {Array<string>} pExtraColumns - sort fields to project
	 * @param {(pError?: Error, pBase?: { Base: Record<string, any>, PrimaryKey: string, Captures: Record<string, any> }) => void} fCallback
	 */
	composeBase(pContext, pBasePlan, pExtraColumns, fCallback)
	{
		let tmpContext = pContext || {};
		if (!tmpContext.Counters)
		{
			tmpContext.Counters = { Relations: 0, BehaviorRuns: 0, Statements: 0 };
		}
		if (!pBasePlan || (typeof(pBasePlan.Pivot) !== 'string'))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'A base plan needs its pivot.'));
		}
		let tmpVariantIn = pBasePlan.Variant || {};
		let tmpConjuncts = Array.isArray(tmpVariantIn.Conjuncts) ? tmpVariantIn.Conjuncts : [];
		let tmpColumnConjuncts = Array.isArray(tmpVariantIn.ColumnConjuncts) ? tmpVariantIn.ColumnConjuncts : tmpConjuncts.filter((pConjunct) => { return pConjunct.Shape !== 'Path'; });
		if (!tmpVariantIn.PathPred && tmpConjuncts.some((pConjunct) => { return pConjunct.Shape === 'Path'; }))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The base plan has Path conjuncts but no lowered PathPred.'));
		}
		let tmpVariant = (
			{
				VariantId: tmpVariantIn.VariantId || 'v0',
				Conjuncts: tmpColumnConjuncts,
				PathPred: tmpVariantIn.PathPred || null,
				IncludesDeleted: (tmpVariantIn.IncludesDeleted === true) || tmpColumnConjuncts.some((pConjunct) => { return pConjunct.NamesDeleted === true; })
			});
		let tmpComposer = this.composer;
		let tmpNeeds = tmpComposer.newNeeds();
		try
		{
			tmpComposer.collectPred(tmpNeeds, tmpVariant.PathPred);
		}
		catch (pCollectError)
		{
			return fCallback(libFacetErrors.isFacetError(pCollectError) ? pCollectError : libFacetErrors.create('FACET_INTERNAL'));
		}
		let tmpPrimaryKey = tmpContext.Host.getPrimaryKey(pBasePlan.Pivot);
		let tmpColumns = tmpComposer.columnsOf(tmpNeeds, 'p').concat(Array.isArray(pExtraColumns) ? pExtraColumns : []);
		let tmpRelations = {};
		let tmpCaptures = { Captures: {} };
		this.fable.RetoldFacetingScopedRelationBuilder.buildRelation(tmpContext, this.pivotRel(tmpContext, pBasePlan.Pivot, tmpVariant, tmpColumns),
			(pRelationError, pRelation) =>
			{
				if (pRelationError)
				{
					return fCallback(pRelationError);
				}
				tmpRelations.p = pRelation;
				tmpComposer.buildUses(tmpContext, tmpNeeds, tmpRelations,
					(pHopError) =>
					{
						this.recordCaptures(tmpCaptures, tmpRelations);
						if (pHopError)
						{
							return fCallback(pHopError);
						}
						let tmpBase;
						try
						{
							let tmpSession = tmpComposer.newSession(pRelation.Dialect, tmpRelations);
							let tmpEntity = tmpComposer.entityBase(tmpContext, tmpSession, { Columns: pRelation.Columns, Preds: [ tmpVariant.PathPred ], Flags: [], Dimensions: [] });
							tmpBase = { SQL: tmpEntity.SQL, Params: tmpSession.Params, ParamTypes: tmpSession.ParamTypes, Dialect: pRelation.Dialect };
						}
						catch (pComposeError)
						{
							if (!libFacetErrors.isFacetError(pComposeError))
							{
								this.fable.log.error(`RetoldFaceting Live could not compose the base of ${pBasePlan.Pivot}: ${pComposeError.message}`);
							}
							return fCallback(libFacetErrors.isFacetError(pComposeError) ? pComposeError : libFacetErrors.create('FACET_INTERNAL'));
						}
						return fCallback(null, { Base: tmpBase, PrimaryKey: tmpPrimaryKey, Captures: tmpCaptures.Captures });
					});
			});
	}

	/**
	 * The full-filter row count (§26.5).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pBasePlan - Planner.planBase result
	 * @param {(pError?: Error, pCount?: number, pMeta?: { Captures: Record<string, any> }) => void} fCallback - pMeta (additive): the captures, for the Version (§30.2)
	 */
	countBase(pContext, pBasePlan, fCallback)
	{
		this.composeBase(pContext, pBasePlan, [],
			(pError, pComposed) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpAgg = { Key: '#Count', Kind: 'Count', Pivot: pBasePlan.Pivot, Dimensions: [] };
				this.runStatement(pContext, null, tmpAgg, pComposed.Base, {},
					(pRunError, pRows) =>
					{
						if (pRunError)
						{
							return fCallback(pRunError);
						}
						return fCallback(null, toCount(pRows[0] ? pRows[0].Total : 0), { Captures: pComposed.Captures });
					});
			});
	}

	/**
	 * One ordered page of primary keys (§26.5): NULLs last in both directions, the primary key the
	 * final tie-break, LIMIT Cap OFFSET Begin.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pBasePlan
	 * @param {{ Sort?: Array<{ Field: string, Dir: string }>, Begin: number, Cap: number }} pPage
	 * @param {(pError?: Error, pResult?: { Keys: Array<any>, Statements: number, Captures: Record<string, any> }) => void} fCallback
	 */
	recordKeys(pContext, pBasePlan, pPage, fCallback)
	{
		let tmpPage = pPage || {};
		let tmpSort = Array.isArray(tmpPage.Sort) ? tmpPage.Sort : [];
		let tmpBegin = (typeof(tmpPage.Begin) === 'number') ? tmpPage.Begin : 0;
		let tmpCap = tmpPage.Cap;
		let tmpStart = (pContext && pContext.Counters) ? (pContext.Counters.Statements || 0) : 0;
		this.composeBase(pContext, pBasePlan, tmpSort.map((pSort) => { return pSort ? pSort.Field : null; }),
			(pError, pComposed) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpAgg = { Key: '#Records', Kind: 'Count', Pivot: pBasePlan.Pivot, Dimensions: [] };
				this.runStatement(pContext, null, tmpAgg, pComposed.Base, { Shell: 'RecordKeys', PrimaryKey: pComposed.PrimaryKey, Sort: tmpSort, Begin: tmpBegin, Cap: tmpCap },
					(pRunError, pRows) =>
					{
						if (pRunError)
						{
							return fCallback(pRunError);
						}
						return fCallback(null, { Keys: pRows.map((pRow) => { return rawKey(pRow.Key); }), Statements: (pContext.Counters.Statements || 0) - tmpStart, Captures: pComposed.Captures });
					});
			});
	}

	/**
	 * Every primary key of the full filter, ordered by the key, at most Cap (one more tells
	 * Truncated), with the full Count (§26.5).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pBasePlan
	 * @param {{ Cap: number }} pOptions
	 * @param {(pError?: Error, pResult?: { Keys: Array<any>, Count: number, Truncated: boolean, Captures: Record<string, any> }) => void} fCallback
	 */
	keys(pContext, pBasePlan, pOptions, fCallback)
	{
		let tmpCap = (pOptions && (typeof(pOptions.Cap) === 'number')) ? pOptions.Cap : null;
		this.composeBase(pContext, pBasePlan, [],
			(pError, pComposed) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpAgg = { Key: '#Keys', Kind: 'Count', Pivot: pBasePlan.Pivot, Dimensions: [] };
				this.runStatement(pContext, null, tmpAgg, pComposed.Base, { Shell: 'Keys', PrimaryKey: pComposed.PrimaryKey, Cap: tmpCap },
					(pRunError, pRows) =>
					{
						if (pRunError)
						{
							return fCallback(pRunError);
						}
						let tmpKeys = pRows.map((pRow) => { return rawKey(pRow.Key); });
						let tmpTruncated = (typeof(tmpCap) === 'number') && (tmpKeys.length > tmpCap);
						if (!tmpTruncated)
						{
							// Every key came back: the count IS the key list (one statement, one snapshot).
							return fCallback(null, { Keys: tmpKeys, Count: tmpKeys.length, Truncated: false, Captures: pComposed.Captures });
						}
						this.runStatement(pContext, null, { Key: '#Count', Kind: 'Count', Pivot: pBasePlan.Pivot, Dimensions: [] }, pComposed.Base, {},
							(pCountError, pCountRows) =>
							{
								if (pCountError)
								{
									return fCallback(pCountError);
								}
								// Truncated: the full count needs its own statement (on PostgreSQL READ COMMITTED it
								// may see a later snapshot than the keys; Count ≥ Cap + 1 either way).
								return fCallback(null, { Keys: tmpKeys.slice(0, tmpCap), Count: toCount(pCountRows[0] ? pCountRows[0].Total : 0), Truncated: true, Captures: pComposed.Captures });
							});
					});
			});
	}
}

module.exports = RetoldFacetingEngineLive;
module.exports.serviceType = 'RetoldFacetingEngineLive';
module.exports.LIVE_KINDS = LIVE_KINDS;
module.exports.COUNT_MODE_FOR = COUNT_MODE_FOR;
