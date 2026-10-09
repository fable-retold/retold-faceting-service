/**
 * Retold Faceting - Cube Executor (Live)
 *
 * The conditional disjunctive scan (01 §8.4, D-05): all cube-eligible facets of one pivot answered
 * by ONE plain GROUP BY over the pivot's Common relation (only the conjuncts no member owns), with
 * every owned conjunct projected as a 0/1 flag "b<n>" and every member's definition Where as a flag
 * "w<n>", then marginalized in JS: member m sums the grain rows whose RequireFlags are all 1 (and
 * whose RequireWhere flag is 1), grouped by its dimensions.  The result for every member must equal
 * its per-Variant statement (oracle O5), so marginalize() reproduces each shell's own row caps
 * (the Terms rank cut and selected keys, the DateHistogram key cap, the Pivot cell limit).
 *
 * Falls back (FellBack: true, never an error) when: the grain has more than Limits.CubeMaxGroups
 * rows; the Common relation's capture shows a behavior rewrote client operators (Transformed — the
 * flags would bypass that transform); a Path-shape conjunct has no lowered FoldPred; or building a
 * relation failed for any reason but a refused principal (the per-Variant path then attributes the
 * error to the right facets).
 *
 * Path-shape conjuncts are taken lowered at scope 'p' from, in order: the flag's own Pred,
 * CubePlan.ConjunctPreds[ConjunctId], the conjunct's FoldPred / Lowered, any Variant's
 * PathPreds[ConjunctId], or Planner.lowerPred(Pred, { Alias: 'p', Entity }, CubePlan.AliasCounter);
 * the Common path conjuncts may come as CubePlan.CommonPathPred.
 *
 * marginalize() is pure (no I/O) so the O5 tests can feed it grain rows directly.
 *
 * Contract: internal-contracts §25.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../../contract/Facet-Contract-Errors.js');
const libFacetEnvelope = require('../../contract/Facet-Contract-Envelope.js');
const libFacetBuckets = require('../../contract/Facet-Contract-Buckets.js');
const libFacetRequest = require('../../contract/Facet-Contract-Request.js');
const libRetoldFacetingUtil = require('../../Retold-Faceting-Util.js');
const libRetoldFacetingEngineBase = require('../Retold-Faceting-EngineBase.js');
const libRetoldFacetingStatementComposer = require('./Retold-Faceting-StatementComposer.js');

const hasOwn = libRetoldFacetingUtil.hasOwn;
const toNumber = libRetoldFacetingUtil.toFiniteNumber;
const toCount = libRetoldFacetingUtil.toCount;
const toDateString = libRetoldFacetingEngineBase.toDateString;
const dimensionKey = libRetoldFacetingEngineBase.dimensionKey;
const andOf = libRetoldFacetingStatementComposer.andOf;

// Agg kinds a cube may answer (§25.1); Stats and Missing through a per-group measure.
const CUBE_KINDS = Object.freeze([ 'Count', 'Terms', 'DateHistogram', 'NumericHistogram', 'Ranges', 'Pivot', 'ChildRollup', 'ExistsSplit', 'Stats', 'Missing' ]);
const CUBE_MEASURE_KINDS = Object.freeze([ 'Stats', 'Missing' ]);

class RetoldFacetingCubeExecutor extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingCubeExecutor';
	}

	/**
	 * Can this Agg be a cube member (§25.1)?  (The planner decides; the executor re-checks.)
	 *
	 * @param {Record<string, any>} pAgg
	 * @return {boolean}
	 */
	eligible(pAgg)
	{
		if (!pAgg || (CUBE_KINDS.indexOf(pAgg.Kind) < 0) || pAgg.Tuple || (pAgg.MultiValued === true))
		{
			return false;
		}
		let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
		if (tmpDimensions.some((pDimension) => { return !pDimension || (pDimension.Kind === 'Multi'); }))
		{
			return false;
		}
		if (pAgg.Kind === 'NumericHistogram')
		{
			return (tmpDimensions[0].Mode === 'Edges') && Array.isArray(tmpDimensions[0].Edges) && (tmpDimensions[0].Edges.length >= 2);
		}
		if (CUBE_MEASURE_KINDS.indexOf(pAgg.Kind) >= 0)
		{
			return (typeof(pAgg.Field) === 'string') && (pAgg.Field.length > 0) && (tmpDimensions.length < 1);
		}
		return true;
	}

	/**
	 * The conjuncts of the request (FilterAST order), by Id.
	 *
	 * @param {Record<string, any>} pContext
	 * @return {Map<string, Record<string, any>>}
	 */
	conjunctsById(pContext)
	{
		let tmpMap = new Map();
		let fAdd = (pConjuncts) =>
		{
			(Array.isArray(pConjuncts) ? pConjuncts : []).forEach((pConjunct) => { if (pConjunct && !tmpMap.has(pConjunct.Id)) { tmpMap.set(pConjunct.Id, pConjunct); } });
		};
		if (pContext && pContext.FilterAST)
		{
			fAdd(pContext.FilterAST.Conjuncts);
		}
		let tmpVariants = (pContext && pContext.Variants) ? pContext.Variants : {};
		Object.keys(tmpVariants).forEach((pId) => { fAdd(tmpVariants[pId].Conjuncts); fAdd(tmpVariants[pId].ColumnConjuncts); });
		return tmpMap;
	}

	/**
	 * The lowered FoldPred (scope 'p') of a Path-shape conjunct, or null when none is available.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pCubePlan
	 * @param {Record<string, any>} pConjunct
	 * @return {Record<string, any>|null}
	 */
	pathPredFor(pContext, pCubePlan, pConjunct)
	{
		let tmpId = pConjunct.Id;
		if (pCubePlan.ConjunctPreds && hasOwn(pCubePlan.ConjunctPreds, tmpId))
		{
			return pCubePlan.ConjunctPreds[tmpId];
		}
		if (pConjunct.FoldPred)
		{
			return pConjunct.FoldPred;
		}
		if (pConjunct.Lowered)
		{
			return pConjunct.Lowered;
		}
		let tmpVariants = (pContext && pContext.Variants) ? pContext.Variants : {};
		let tmpIds = Object.keys(tmpVariants);
		for (let i = 0; i < tmpIds.length; i++)
		{
			let tmpPreds = tmpVariants[tmpIds[i]].PathPreds;
			if (tmpPreds && hasOwn(tmpPreds, tmpId))
			{
				return tmpPreds[tmpId];
			}
		}
		let tmpPlanner = this.fable.RetoldFacetingPlanner;
		if (tmpPlanner && (typeof(tmpPlanner.lowerPred) === 'function') && pCubePlan.AliasCounter)
		{
			try
			{
				return tmpPlanner.lowerPred(pConjunct.Pred, { Alias: 'p', Entity: pCubePlan.Pivot }, pCubePlan.AliasCounter);
			}
			catch (pLowerError)
			{
				this.fable.log.warn(`RetoldFaceting cube ${pCubePlan.CubeId}: conjunct ${tmpId} could not be lowered (${pLowerError.message}).`);
			}
		}
		return null;
	}

	/**
	 * The bound columns of the grain (§25.2 Bounds): one value column per dimension a DateHistogram
	 * or Edges NumericHistogram member needs bounds of.  CubePlan.Bounds names them when present.
	 *
	 * @param {Record<string, any>} pCubePlan
	 * @param {Array<Record<string, any>>} pMemberAggs
	 * @return {Array<{ Dim: string, Column: string, Lo: string, Hi: string, NonNull: string, Kind: string }>}
	 */
	boundsSpec(pCubePlan, pMemberAggs)
	{
		let tmpDims = Array.isArray(pCubePlan.Dims) ? pCubePlan.Dims : [];
		let tmpDeclared = Array.isArray(pCubePlan.Bounds) ? pCubePlan.Bounds : [];
		let tmpSpec = [];
		let tmpMembers = Array.isArray(pCubePlan.Members) ? pCubePlan.Members : [];
		for (let i = 0; i < tmpMembers.length; i++)
		{
			let tmpAgg = pMemberAggs[i];
			if (!tmpAgg || ((tmpAgg.Kind !== 'DateHistogram') && (tmpAgg.Kind !== 'NumericHistogram')))
			{
				continue;
			}
			let tmpDimColumn = tmpMembers[i].Dims[0];
			if (tmpSpec.some((pEntry) => { return pEntry.Dim === tmpDimColumn; }))
			{
				continue;
			}
			let tmpSuffix = tmpDimColumn.replace(/^d/, '');
			let tmpDeclaredEntry = tmpDeclared.find((pEntry) => { return pEntry && (pEntry.Dim === tmpDimColumn); });
			tmpSpec.push(
				{
					Dim: tmpDimColumn,
					Column: `v${tmpSuffix}`,
					Lo: tmpDeclaredEntry ? tmpDeclaredEntry.Lo : `lo${tmpSuffix}`,
					Hi: tmpDeclaredEntry ? tmpDeclaredEntry.Hi : `hi${tmpSuffix}`,
					NonNull: (tmpDeclaredEntry && tmpDeclaredEntry.NonNull) ? tmpDeclaredEntry.NonNull : `nn${tmpSuffix}`,
					Kind: (tmpAgg.Kind === 'DateHistogram') ? 'Date' : 'Numeric'
				});
		}
		return tmpSpec.filter((pEntry) => { return tmpDims.some((pDim) => { return pDim.Column === pEntry.Dim; }); });
	}

	/**
	 * Run one CubePlan.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution - the engine's Execution (Statements and Captures are recorded on it)
	 * @param {Record<string, any>} pCubePlan - internal-contracts §25.2
	 * @param {Array<Record<string, any>>} pMemberAggs - the Aggs of pCubePlan.Members, in order
	 * @param {(pError?: Error, pResult?: { Results: Record<string, Record<string, any>>, Errors?: Record<string, any>, FellBack: boolean }) => void} fCallback - FellBack true = the caller runs the members per Variant
	 */
	execute(pContext, pExecution, pCubePlan, pMemberAggs, fCallback)
	{
		let tmpEngine = this.fable.RetoldFacetingEngineLive;
		let tmpComposer = tmpEngine ? tmpEngine.composer : null;
		let fFallBack = (pReason, pError) =>
		{
			let tmpCubeId = pCubePlan ? pCubePlan.CubeId : '?';
			if (/^(Statement|Compose|Collect|Relation)/.test(pReason))
			{
				// A cube SQL / composition bug on one dialect must be visible: it silently multiplies the
				// statement count otherwise.  The driver's code and message only (never bound values).
				let tmpDetail = pError ? ` (${pError.code || pError.Code || 'Error'}: ${libRetoldFacetingUtil.logSafe(String(pError.message || '').slice(0, 300))})` : '';
				this.fable.log.warn(`RetoldFaceting cube ${tmpCubeId} fell back to per-Variant statements: ${pReason}${tmpDetail}`);
			}
			else
			{
				this.fable.log.info(`RetoldFaceting cube ${tmpCubeId} fell back to per-Variant statements: ${pReason}`);
			}
			return fCallback(null, { Results: {}, FellBack: true, Reason: pReason });
		};
		if (!tmpComposer || !pCubePlan || !Array.isArray(pCubePlan.Members) || (pCubePlan.Members.length < 1) || !Array.isArray(pMemberAggs) || (pMemberAggs.length !== pCubePlan.Members.length))
		{
			return fFallBack('Malformed');
		}
		if (pMemberAggs.some((pAgg) => { return !this.eligible(pAgg); }))
		{
			return fFallBack('Ineligible');
		}

		// Conjuncts: Common column ones fence the pivot; Common path ones and every flag are lowered.
		let tmpConjuncts = this.conjunctsById(pContext);
		let tmpCommonColumn = [];
		let tmpCommonPath = [];
		let tmpCommon = Array.isArray(pCubePlan.Common) ? pCubePlan.Common : [];
		for (let i = 0; i < tmpCommon.length; i++)
		{
			let tmpConjunct = tmpConjuncts.get(tmpCommon[i]);
			if (!tmpConjunct)
			{
				return fFallBack(`UnknownConjunct:${tmpCommon[i]}`);
			}
			if (tmpConjunct.NamesDeleted === true)
			{
				return fFallBack('IncludesDeleted');
			}
			if (tmpConjunct.Shape === 'Path')
			{
				tmpCommonPath.push(tmpConjunct);
			}
			else
			{
				tmpCommonColumn.push(tmpConjunct);
			}
		}
		let tmpCommonPathPred = pCubePlan.CommonPathPred || null;
		if (!tmpCommonPathPred && (tmpCommonPath.length > 0))
		{
			let tmpLowered = tmpCommonPath.map((pConjunct) => { return this.pathPredFor(pContext, pCubePlan, pConjunct); });
			if (tmpLowered.some((pPred) => { return !pPred; }))
			{
				return fFallBack('CommonPathNotLowered');
			}
			tmpCommonPathPred = andOf(tmpLowered);
		}
		let tmpFlags = [];
		let tmpFlagNames = [];
		let tmpFlagEntries = Array.isArray(pCubePlan.Flags) ? pCubePlan.Flags : [];
		for (let i = 0; i < tmpFlagEntries.length; i++)
		{
			let tmpConjunct = tmpConjuncts.get(tmpFlagEntries[i].ConjunctId);
			if (!tmpConjunct)
			{
				return fFallBack(`UnknownConjunct:${tmpFlagEntries[i].ConjunctId}`);
			}
			if (tmpConjunct.NamesDeleted === true)
			{
				return fFallBack('IncludesDeleted');
			}
			if (tmpConjunct.Shape === 'Path')
			{
				let tmpPred = tmpFlagEntries[i].Pred || this.pathPredFor(pContext, pCubePlan, tmpConjunct);
				if (!tmpPred)
				{
					return fFallBack('FlagNotLowered');
				}
				tmpFlags.push({ Column: tmpFlagEntries[i].Flag, Pred: tmpPred });
			}
			else
			{
				tmpFlags.push({ Column: tmpFlagEntries[i].Flag, ColumnPred: tmpConjunct.Pred });
			}
			tmpFlagNames.push(tmpFlagEntries[i].Flag);
		}
		let tmpWhereFlags = Array.isArray(pCubePlan.WhereFlags) ? pCubePlan.WhereFlags : [];
		for (let i = 0; i < tmpWhereFlags.length; i++)
		{
			tmpFlags.push({ Column: tmpWhereFlags[i].Flag, Pred: tmpWhereFlags[i].Where });
			tmpFlagNames.push(tmpWhereFlags[i].Flag);
		}

		// Needs: every Rel and pivot column the Common predicates, flags and dimensions read.
		let tmpNeeds = tmpComposer.newNeeds();
		let tmpDims = Array.isArray(pCubePlan.Dims) ? pCubePlan.Dims : [];
		try
		{
			tmpComposer.collectPred(tmpNeeds, tmpCommonPathPred);
			tmpFlags.forEach(
				(pFlag) =>
				{
					if (pFlag.Pred)
					{
						tmpComposer.collectPred(tmpNeeds, pFlag.Pred);
					}
					else
					{
						this.columnPredFields(pFlag.ColumnPred).forEach((pField) => { tmpComposer.need(tmpNeeds, 'p', pField); });
						tmpComposer.noteColumnPred(tmpNeeds, 'p', pFlag.ColumnPred);
					}
				});
			tmpDims.forEach((pDim) => { tmpComposer.collectDimension(tmpNeeds, pDim.Dim, 'p'); });
			(Array.isArray(pCubePlan.Measures) ? pCubePlan.Measures : []).forEach((pMeasure) => { tmpComposer.need(tmpNeeds, 'p', pMeasure.Field); });
		}
		catch (pCollectError)
		{
			return fFallBack('Collect', pCollectError);
		}

		let tmpRelations = {};
		let tmpVariant = { VariantId: pCubePlan.CubeId, Conjuncts: tmpCommonColumn, PathPred: tmpCommonPathPred, IncludesDeleted: false };
		let fRelationError = (pError) =>
		{
			if (libFacetErrors.isFacetError(pError) && (pError.Code === 'FACET_UNAUTHENTICATED'))
			{
				return fCallback(pError);
			}
			return fFallBack(`Relation:${libFacetErrors.isFacetError(pError) ? pError.Code : 'Error'}`);
		};
		this.fable.RetoldFacetingScopedRelationBuilder.buildRelation(pContext, tmpEngine.pivotRel(pContext, pCubePlan.Pivot, tmpVariant, tmpComposer.columnsOf(tmpNeeds, 'p')),
			(pPivotError, pPivot) =>
			{
				if (pPivotError)
				{
					return fRelationError(pPivotError);
				}
				if (pPivot.Capture && Array.isArray(pPivot.Capture.Transformed) && (pPivot.Capture.Transformed.length > 0))
				{
					return fFallBack('Transformed');
				}
				tmpRelations.p = pPivot;
				tmpComposer.buildUses(pContext, tmpNeeds, tmpRelations,
					(pHopError, pProbe) =>
					{
						if (pHopError)
						{
							return fRelationError(pHopError);
						}
						if (pProbe && (pProbe.Transformed > 0))
						{
							// A behavior rewrites an operator of a flag / W_def / Common column leaf: those are
							// rendered outside the pivot's own Scoped Relation, so the cube falls back (the
							// per-Variant statements put the owned conjuncts back inside the relation).
							return fFallBack('Transformed');
						}
						tmpEngine.recordCaptures(pExecution, tmpRelations);
						let tmpBounds = this.boundsSpec(pCubePlan, pMemberAggs);
						let tmpSession;
						let tmpBase;
						let tmpShellCube;
						try
						{
							tmpSession = tmpComposer.newSession(pPivot.Dialect, tmpRelations);
							tmpBase = tmpComposer.entityBase(pContext, tmpSession,
								{
									Columns: pPivot.Columns,
									Preds: [ tmpCommonPathPred ],
									Flags: tmpFlags,
									Dimensions: tmpDims.map((pDim) => { return pDim.Dim; }),
									ChildAggForm: (pContext.PlanForm && (pContext.PlanForm.ChildAgg === 'Restricted')) ? 'Restricted' : 'Correlated'
								});
							tmpShellCube = (
								{
									Dims: tmpDims.map((pDim, pIndex) => { return { Column: pDim.Column, Dim: tmpBase.Dimensions[pIndex] }; }),
									Measures: Array.isArray(pCubePlan.Measures) ? pCubePlan.Measures : [],
									Flags: tmpFlagNames,
									Values: tmpBounds.map(
										(pBound) =>
										{
											let tmpIndex = tmpDims.findIndex((pDim) => { return pDim.Column === pBound.Dim; });
											return Object.assign({}, pBound, { Dim: tmpBase.Dimensions[tmpIndex] });
										})
								});
						}
						catch (pComposeError)
						{
							return fFallBack('Compose', pComposeError);
						}
						let tmpOptions = pContext.Options || this.options;
						let tmpMaxGroups = (tmpOptions.Limits && (tmpOptions.Limits.CubeMaxGroups >= 1)) ? Math.floor(tmpOptions.Limits.CubeMaxGroups) : 100000;
						if ((typeof(pCubePlan.MaxGroups) === 'number') && (pCubePlan.MaxGroups >= 1))
						{
							tmpMaxGroups = Math.min(tmpMaxGroups, Math.floor(pCubePlan.MaxGroups));
						}
						let tmpCubeAgg = { Key: `#Cube:${pCubePlan.CubeId}`, Kind: 'Count', Pivot: pCubePlan.Pivot, Dimensions: [] };
						tmpEngine.runStatement(pContext, pExecution, tmpCubeAgg, { SQL: tmpBase.SQL, Params: tmpSession.Params, ParamTypes: tmpSession.ParamTypes, Dialect: pPivot.Dialect },
							{ Shell: 'Cube', Cube: tmpShellCube, MaxGroups: tmpMaxGroups },
							(pRunError, pRows) =>
							{
								if (pRunError)
								{
									if (pRunError.Code === 'FACET_TIMEOUT')
									{
										return fCallback(null, { Results: {}, Errors: pMemberAggs.reduce((pErrors, pAgg) => { pErrors[pAgg.Key] = libFacetErrors.toEntry(pRunError); return pErrors; }, {}), FellBack: false });
									}
									return fFallBack('Statement', pRunError.Cause || pRunError);
								}
								if (pRows.length > tmpMaxGroups)
								{
									return fFallBack('CubeMaxGroups');
								}
								let tmpMarginal = this.marginalize(Object.assign({}, pCubePlan, { Bounds: tmpBounds }), pMemberAggs, pRows, tmpOptions);
								return fCallback(null, { Results: tmpMarginal.Results, Errors: tmpMarginal.Errors, FellBack: false });
							});
					});
			});
	}

	/**
	 * Every Field of a Part I column Pred.
	 *
	 * @param {Record<string, any>} pPred
	 * @return {Array<string>}
	 */
	columnPredFields(pPred)
	{
		let tmpFields = [];
		let fWalk = (pNode) =>
		{
			if (!pNode)
			{
				return;
			}
			if (Array.isArray(pNode.And) || Array.isArray(pNode.Or))
			{
				(pNode.And || pNode.Or).forEach(fWalk);
				return;
			}
			if (typeof(pNode.Field) === 'string')
			{
				tmpFields.push(pNode.Field);
			}
		};
		fWalk(pPred);
		return tmpFields;
	}

	/**
	 * Marginalize grain rows into one RawFacetResult per member (pure).
	 *
	 * @param {Record<string, any>} pCubePlan - with Bounds (boundsSpec) when histogram members need bounds
	 * @param {Array<Record<string, any>>} pMemberAggs
	 * @param {Array<Record<string, any>>} pGrainRows - { d<n>…, b<n>…, w<n>…, N, lo<n>…, hi<n>…, nn<n>… }
	 * @param {Record<string, any>} [pOptions] - resolved RetoldFaceting options (Limits); default this.options
	 * @return {{ Results: Record<string, Record<string, any>>, Errors: Record<string, any> }} Agg Key → RawFacetResult (internal-contracts §9.2 / §24.9)
	 */
	marginalize(pCubePlan, pMemberAggs, pGrainRows, pOptions)
	{
		let tmpOptions = pOptions || this.options;
		let tmpLimits = tmpOptions.Limits || {};
		let tmpResults = {};
		let tmpErrors = {};
		let tmpDims = Array.isArray(pCubePlan.Dims) ? pCubePlan.Dims : [];
		let tmpBounds = Array.isArray(pCubePlan.Bounds) ? pCubePlan.Bounds : [];
		let tmpRows = Array.isArray(pGrainRows) ? pGrainRows : [];
		let fFlag = (pValue) => { return toNumber(libRetoldFacetingEngineBase.rawKey(pValue)) === 1; };
		let fDim = (pColumn) =>
		{
			let tmpEntry = tmpDims.find((pDim) => { return pDim.Column === pColumn; });
			if (!tmpEntry)
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'A cube member names an unknown dimension.');
			}
			return tmpEntry.Dim;
		};
		for (let m = 0; m < pCubePlan.Members.length; m++)
		{
			let tmpMember = pCubePlan.Members[m];
			let tmpAgg = pMemberAggs[m];
			try
			{
				let tmpRequire = Array.isArray(tmpMember.RequireFlags) ? tmpMember.RequireFlags : [];
				let tmpSelected = tmpRows.filter(
					(pRow) =>
					{
						for (let i = 0; i < tmpRequire.length; i++)
						{
							if (!fFlag(pRow[tmpRequire[i]]))
							{
								return false;
							}
						}
						return !tmpMember.RequireWhere || fFlag(pRow[tmpMember.RequireWhere]);
					});
				tmpResults[tmpAgg.Key] = this.foldMember(tmpAgg, tmpMember, tmpSelected, fDim, tmpBounds, tmpLimits);
			}
			catch (pFoldError)
			{
				tmpErrors[tmpAgg.Key] = libFacetErrors.toEntry(libFacetErrors.isFacetError(pFoldError) ? pFoldError : libFacetErrors.create('FACET_INTERNAL'));
			}
		}
		return { Results: tmpResults, Errors: tmpErrors };
	}

	/**
	 * One member's RawFacetResult from its grain rows (exactly the per-Variant statement's answer).
	 *
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pMember
	 * @param {Array<Record<string, any>>} pRows - grain rows passing the member's flags
	 * @param {(pColumn: string) => Record<string, any>} fDim
	 * @param {Array<Record<string, any>>} pBounds
	 * @param {Record<string, any>} pLimits
	 * @return {Record<string, any>}
	 */
	foldMember(pAgg, pMember, pRows, fDim, pBounds, pLimits)
	{
		let tmpRaw = (
			{
				Key: pAgg.Key, Kind: pAgg.Kind, VariantId: (typeof(pAgg.VariantId) === 'string') ? pAgg.VariantId : 'v0',
				Total: 0, MissingCount: 0, Groups: [], DistinctKeys: null, Bounds: null, Geometry: null, Stats: null, DistinctCount: null, Cells: null
			});
		let tmpColumns = Array.isArray(pMember.Dims) ? pMember.Dims : [];
		let fN = (pRow) => { return toCount(pRow.N); };
		for (let i = 0; i < pRows.length; i++)
		{
			tmpRaw.Total += fN(pRows[i]);
		}
		let fGroupBy = (pColumn, fKey) =>
		{
			let tmpDim = fDim(pColumn);
			let tmpGroups = new Map();
			let tmpMissing = 0;
			for (let i = 0; i < pRows.length; i++)
			{
				let tmpKey = fKey ? fKey(pRows[i][pColumn]) : dimensionKey(tmpDim, pRows[i][pColumn]);
				if (tmpKey === null)
				{
					tmpMissing += fN(pRows[i]);
					continue;
				}
				let tmpSignature = `${typeof(tmpKey)}:${String(tmpKey)}`;
				let tmpEntry = tmpGroups.get(tmpSignature);
				if (!tmpEntry)
				{
					tmpEntry = { Key: tmpKey, Count: 0, Rows: [] };
					tmpGroups.set(tmpSignature, tmpEntry);
				}
				tmpEntry.Count += fN(pRows[i]);
				tmpEntry.Rows.push(pRows[i]);
			}
			return { Groups: Array.from(tmpGroups.values()), Missing: tmpMissing, Dim: tmpDim };
		};
		switch (pAgg.Kind)
		{
			case 'Count':
				break;

			case 'Stats':
			case 'Missing':
				{
					// The member's measure marginalized over its grain rows (Σ count, min of min, max of
					// max, Σ unit sums), then folded by the SAME function the per-Variant single-row
					// statement's row goes through, so the RawFacetResult is identical (O5).
					let tmpColumn = pMember.Measure;
					if (typeof(tmpColumn) !== 'string')
					{
						throw libFacetErrors.create('FACET_INTERNAL', 'A cube measure member has no measure column.');
					}
					let tmpIsDate = (((pAgg.FieldInfo || {}).DataType) === 'DateTime');
					let tmpRow = { Rows: tmpRaw.Total, NonNull: 0, Min: null, Max: null, SumUnits: null };
					let fBetter = (pCandidate, pCurrent, pWantLow) =>
					{
						if ((pCandidate === null) || (typeof(pCandidate) === 'undefined'))
						{
							return pCurrent;
						}
						let tmpCandidate = tmpIsDate ? toDateString(pCandidate) : toNumber(pCandidate);
						if (tmpCandidate === null)
						{
							return pCurrent;
						}
						if (pCurrent === null)
						{
							return tmpCandidate;
						}
						return (pWantLow ? (tmpCandidate < pCurrent) : (tmpCandidate > pCurrent)) ? tmpCandidate : pCurrent;
					};
					for (let i = 0; i < pRows.length; i++)
					{
						tmpRow.NonNull += toCount(pRows[i][`${tmpColumn}nn`]);
						if (pAgg.Kind !== 'Stats')
						{
							continue;
						}
						tmpRow.Min = fBetter(pRows[i][`${tmpColumn}lo`], tmpRow.Min, true);
						tmpRow.Max = fBetter(pRows[i][`${tmpColumn}hi`], tmpRow.Max, false);
						let tmpSum = tmpIsDate ? null : toNumber(pRows[i][`${tmpColumn}su`]);
						if (tmpSum !== null)
						{
							tmpRow.SumUnits = (tmpRow.SumUnits === null) ? tmpSum : (tmpRow.SumUnits + tmpSum);
						}
					}
					return this.fable.RetoldFacetingEngineLive.foldRows({ Options: { Limits: pLimits } }, pAgg, [ tmpRow ]);
				}

			case 'Terms':
				{
					let tmpGrouped = fGroupBy(tmpColumns[0]);
					tmpRaw.MissingCount = tmpGrouped.Missing;
					tmpRaw.DistinctKeys = tmpGrouped.Groups.length;
					tmpRaw.Groups = this.termsCut(pAgg, tmpGrouped.Groups, tmpGrouped.Dim, pLimits).map((pGroup) => { return { Key: pGroup.Key, Count: pGroup.Count }; });
				}
				break;

			case 'DateHistogram':
				{
					let tmpGrouped = fGroupBy(tmpColumns[0], toDateString);
					tmpRaw.MissingCount = tmpGrouped.Missing;
					let tmpBound = pBounds.find((pEntry) => { return pEntry.Dim === tmpColumns[0]; });
					let tmpLo = null;
					let tmpHi = null;
					for (let i = 0; i < tmpGrouped.Groups.length; i++)
					{
						for (let j = 0; tmpBound && (j < tmpGrouped.Groups[i].Rows.length); j++)
						{
							let tmpRowLo = toDateString(tmpGrouped.Groups[i].Rows[j][tmpBound.Lo]);
							let tmpRowHi = toDateString(tmpGrouped.Groups[i].Rows[j][tmpBound.Hi]);
							if ((tmpRowLo !== null) && ((tmpLo === null) || (tmpRowLo < tmpLo)))
							{
								tmpLo = tmpRowLo;
							}
							if ((tmpRowHi !== null) && ((tmpHi === null) || (tmpRowHi > tmpHi)))
							{
								tmpHi = tmpRowHi;
							}
						}
					}
					let tmpGroups = tmpGrouped.Groups.map((pGroup) => { return { Key: pGroup.Key, Count: pGroup.Count }; });
					// The shell's key cap (MaxDateBuckets + 2 rows, the NULL-key row included).
					let tmpCap = ((pLimits.MaxDateBuckets >= 1) ? Math.floor(pLimits.MaxDateBuckets) : libFacetRequest.LIMIT_DEFAULTS.MaxDateBuckets) + 2 - ((tmpRaw.MissingCount > 0) ? 1 : 0);
					if (tmpGroups.length > tmpCap)
					{
						tmpGroups = tmpGroups.sort((pA, pB) => { return libFacetBuckets.compareKeys(pA.Key, pB.Key); }).slice(0, Math.max(0, tmpCap));
					}
					tmpRaw.Groups = tmpGroups;
					tmpRaw.Bounds = (tmpLo !== null) ? { Lo: tmpLo, Hi: tmpHi } : null;
				}
				break;

			case 'NumericHistogram':
				{
					let tmpDim = fDim(tmpColumns[0]);
					let tmpBound = pBounds.find((pEntry) => { return pEntry.Dim === tmpColumns[0]; });
					let tmpNonNull = 0;
					let tmpLo = null;
					let tmpHi = null;
					for (let i = 0; tmpBound && (i < pRows.length); i++)
					{
						tmpNonNull += toCount(pRows[i][tmpBound.NonNull]);
						let tmpRowLo = toNumber(libRetoldFacetingEngineBase.rawKey(pRows[i][tmpBound.Lo]));
						let tmpRowHi = toNumber(libRetoldFacetingEngineBase.rawKey(pRows[i][tmpBound.Hi]));
						if ((tmpRowLo !== null) && ((tmpLo === null) || (tmpRowLo < tmpLo)))
						{
							tmpLo = tmpRowLo;
						}
						if ((tmpRowHi !== null) && ((tmpHi === null) || (tmpRowHi > tmpHi)))
						{
							tmpHi = tmpRowHi;
						}
					}
					tmpRaw.MissingCount = tmpRaw.Total - tmpNonNull;
					tmpRaw.Bounds = (tmpNonNull > 0) ? { Lo: tmpLo, Hi: tmpHi } : null;
					tmpRaw.Geometry = libFacetBuckets.edgesGeometry(tmpDim.Edges, !!tmpDim.OpenEnded, (typeof(tmpDim.Scale) === 'number') ? tmpDim.Scale : 0);
					if (tmpRaw.Bounds !== null)
					{
						let tmpGrouped = fGroupBy(tmpColumns[0]);
						tmpRaw.Groups = tmpGrouped.Groups.map((pGroup) => { return { Key: pGroup.Key, Count: pGroup.Count }; });
					}
				}
				break;

			case 'Ranges':
				{
					let tmpDim = fDim(tmpColumns[0]);
					let tmpCounts = new Map();
					for (let i = 0; i < pRows.length; i++)
					{
						let tmpIndex = toNumber(libRetoldFacetingEngineBase.rawKey(pRows[i][tmpColumns[0]]));
						if (tmpIndex === -1)
						{
							tmpRaw.MissingCount += fN(pRows[i]);
						}
						else if ((tmpIndex !== null) && (tmpIndex >= 0) && (tmpIndex < tmpDim.Ranges.length))
						{
							tmpCounts.set(tmpIndex, (tmpCounts.get(tmpIndex) || 0) + fN(pRows[i]));
						}
					}
					tmpRaw.Groups = Array.from(tmpCounts.keys()).map((pIndex) => { return { Key: tmpDim.Ranges[pIndex].Key, Count: tmpCounts.get(pIndex) }; });
				}
				break;

			case 'Pivot':
				{
					let tmpDim0 = fDim(tmpColumns[0]);
					let tmpDim1 = fDim(tmpColumns[1]);
					let tmpCells = new Map();
					for (let i = 0; i < pRows.length; i++)
					{
						let tmpKeys = [ dimensionKey(tmpDim0, pRows[i][tmpColumns[0]]), dimensionKey(tmpDim1, pRows[i][tmpColumns[1]]) ];
						let tmpSignature = JSON.stringify(tmpKeys.map((pKey) => { return [ typeof(pKey), pKey ]; }));
						let tmpCell = tmpCells.get(tmpSignature);
						if (!tmpCell)
						{
							tmpCell = { Keys: tmpKeys, Count: 0 };
							tmpCells.set(tmpSignature, tmpCell);
						}
						tmpCell.Count += fN(pRows[i]);
					}
					let tmpMaxCells = (pLimits.CubeMaxGroups >= 1) ? pLimits.CubeMaxGroups : 100000;
					if (tmpCells.size > tmpMaxCells)
					{
						throw libFacetErrors.create('FACET_TOO_LARGE', 'The pivot has too many cells.', { Limit: 'CubeMaxGroups', Max: tmpMaxCells, Suggest: { Top: true, Filter: true } });
					}
					tmpRaw.Cells = Array.from(tmpCells.values());
				}
				break;

			case 'ChildRollup':
			case 'ExistsSplit':
				{
					let tmpGrouped = fGroupBy(tmpColumns[0]);
					if (tmpGrouped.Missing > 0)
					{
						throw libFacetErrors.create('FACET_INTERNAL', 'A band / flag key was not a number.');
					}
					let tmpCounts = new Map(tmpGrouped.Groups.map((pGroup) => { return [ pGroup.Key, pGroup.Count ]; }));
					if (pAgg.Kind === 'ExistsSplit')
					{
						tmpRaw.Groups = [ { Key: 1, Count: tmpCounts.get(1) || 0 }, { Key: 0, Count: tmpCounts.get(0) || 0 } ];
					}
					else
					{
						tmpRaw.Groups = Array.from(tmpCounts.keys()).sort((pA, pB) => { return pA - pB; }).map((pKey) => { return { Key: pKey, Count: tmpCounts.get(pKey) }; });
					}
				}
				break;

			default:
				throw libFacetErrors.create('FACET_INTERNAL', 'This fold kind is not a cube member.');
		}
		return tmpRaw;
	}

	/**
	 * The Terms shell's own row cut (Retold-Faceting-ShellTemplates Terms): groups ranked by count
	 * (rank() with ties) within Top + 1, at most max(Top + 1, MaxTermsGroups) rows in (count desc,
	 * key asc) order, plus every selected key — so the cube's raw Terms equals the per-Variant one.
	 *
	 * @param {Record<string, any>} pAgg
	 * @param {Array<{ Key: any, Count: number }>} pGroups - non-null keys
	 * @param {Record<string, any>} pDim
	 * @param {Record<string, any>} pLimits
	 * @return {Array<{ Key: any, Count: number }>}
	 */
	termsCut(pAgg, pGroups, pDim, pLimits)
	{
		let fPositive = (pValue, pDefault) => { return ((typeof(pValue) === 'number') && Number.isFinite(pValue) && (pValue >= 1)) ? Math.floor(pValue) : pDefault; };
		let tmpTop = fPositive(pAgg.Top, fPositive(pLimits.DefaultTop, libFacetRequest.LIMIT_DEFAULTS.DefaultTop));
		let tmpMaxGroups = Math.max(tmpTop + 1, fPositive(pLimits.MaxTermsGroups, 10000));
		let tmpSorted = pGroups.slice().sort((pA, pB) => { return (pB.Count - pA.Count) || libFacetBuckets.compareKeys(pA.Key, pB.Key); });
		let tmpSelected = (Array.isArray(pAgg.SelectedKeys) ? pAgg.SelectedKeys : []).map((pKey) => { return libFacetEnvelope.normalizeKey(pKey, pDim.DataType); });
		let fSelected = (pKey) => { return tmpSelected.some((pSelectedKey) => { return pSelectedKey === pKey; }); };
		let tmpKept = [];
		let tmpRank = 0;
		for (let i = 0; i < tmpSorted.length; i++)
		{
			// rank() = 1 + the number of groups with a strictly larger count (sorted: the first index
			// holding this count).
			if ((i === 0) || (tmpSorted[i].Count !== tmpSorted[i - 1].Count))
			{
				tmpRank = i + 1;
			}
			let tmpRowNumber = i + 1;
			if (((tmpRank <= (tmpTop + 1)) && (tmpRowNumber <= tmpMaxGroups)) || fSelected(tmpSorted[i].Key))
			{
				tmpKept.push(tmpSorted[i]);
			}
		}
		return tmpKept;
	}
}

module.exports = RetoldFacetingCubeExecutor;
module.exports.serviceType = 'RetoldFacetingCubeExecutor';
module.exports.CUBE_KINDS = CUBE_KINDS;
