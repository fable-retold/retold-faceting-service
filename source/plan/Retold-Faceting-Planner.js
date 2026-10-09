/**
 * Retold Faceting - Planner
 *
 * NormalizedRequest + FilterAST + catalog + definitions → Aggs (FoldIR), Variants (via the
 * DisjunctivePlanner), the cube plans and the request DepSet (03 §2).
 *
 *   M1: within-entity folds K1–K7 and K14 on auto facets (unchanged; an M1 request plans exactly
 *       as before, plus the M2 fields every Agg / Variant now carries).
 *   M2: declared facets and siblings, PathAuto facets ('E.c>T.col'), named scopes / join clauses
 *       (Path-shaped conjuncts lowered once into FoldPreds and AND-ed into each Variant's PathPred),
 *       definition Wheres (W_def, never excluded; Variants group by kept set AND WhereHash), the
 *       cross-entity dimensions K8 (Via), K9 (Multi), K12 (ChildAgg), K20 (ExistsFlag), K18
 *       TuplePivots, the conditional disjunctive scan (CubePlan, internal-contracts §25) and the
 *       Records / Count / Keys base plan.
 *
 * Per-facet failures (unknown facet, refused fold, 403 on a facet's own hop, unsupported feature,
 * invalid facet params) go to Errors[Key]; they never fail the request.  Whole-request failures:
 * an unknown top-level Param, a 401 from binding (an unset $CurrentUser / $Scope value), a lowering
 * failure of a request filter conjunct.
 *
 * Aliases are plan-wide unique (Lowering.AliasCounter, one per request in pContext.Memo.Plan).
 *
 * Contract: internal-contracts §5.4 (M1), §20.8, §24, §25.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');
const libFacetClauses = require('../contract/Facet-Contract-Clauses.js');
const libFacetBuckets = require('../contract/Facet-Contract-Buckets.js');
const libFacetUtil = require('../contract/Facet-Contract-Util.js');
const libRetoldFacetingFoldIR = require('./Retold-Faceting-FoldIR.js');
const libLowering = require('./Retold-Faceting-Lowering.js');
const libRetoldFacetingFilterAST = require('../request/Retold-Faceting-FilterAST.js');

// The Agg Key of the envelope Total (internal-contracts §5.1).
const TOTAL_KEY = '#Total';

// Canonical facet origins (internal-contracts §20.7); a catalog descriptor has none.
const CANONICAL_ORIGINS = Object.freeze([ 'Declared', 'Sibling', 'PathAuto' ]);

// The bucketed folds a dimension kind maps to.
const BUCKET_FOLDS = Object.freeze([ 'Terms', 'DateHistogram', 'NumericHistogram', 'Ranges' ]);

// Agg kinds that may be cube members (internal-contracts §25.1).
// Stats and Missing join the cube as per-group measures (count / min / max / unit sum), §25.1.
const CUBE_KINDS = Object.freeze([ 'Count', 'Terms', 'DateHistogram', 'NumericHistogram', 'Ranges', 'Pivot', 'ChildRollup', 'ExistsSplit', 'Stats', 'Missing' ]);

// The single-row aggregate kinds a cube answers through a measure (no dimension).
const CUBE_MEASURE_KINDS = Object.freeze([ 'Stats', 'Missing' ]);

// Dimension kinds a cube member may carry.
const CUBE_DIMENSION_KINDS = Object.freeze([ 'Column', 'DateBucket', 'NumericBucket', 'Range', 'ChildAgg', 'ExistsFlag' ]);

const hasOwn = libFacetUtil.hasOwn;
const isPlainObject = libFacetUtil.isPlainObject;

/**
 * Sorted unique strings.
 *
 * @param {Array<any>} pItems
 * @return {Array<string>}
 */
const uniqueSorted = (pItems) =>
{
	let tmpSet = new Set();
	(Array.isArray(pItems) ? pItems : []).forEach((pItem) => { if (typeof(pItem) === 'string') { tmpSet.add(pItem); } });
	return Array.from(tmpSet).sort();
};

/**
 * The Raw step strings of a PathPlan.
 *
 * @param {Record<string, any>} pPathPlan
 * @return {Array<string>}
 */
const pathRaw = (pPathPlan) =>
{
	return (isPlainObject(pPathPlan) && Array.isArray(pPathPlan.Steps)) ? pPathPlan.Steps.map((pStep) => { return pStep.Raw; }) : [];
};

/**
 * The Signature of a PathPlan (given, else the Raw steps joined by ' ').
 *
 * @param {Record<string, any>} pPathPlan
 * @return {string}
 */
const pathSignature = (pPathPlan) =>
{
	if (isPlainObject(pPathPlan) && (typeof(pPathPlan.Signature) === 'string') && (pPathPlan.Signature.length > 0))
	{
		return pPathPlan.Signature;
	}
	return pathRaw(pPathPlan).join(' ');
};

class RetoldFacetingPlanner extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingPlanner';
	}

	// ------------------------------------------------------------ Plan state

	/**
	 * The per-request planning state (alias counter, lowering memo, BindContext, gate), kept in
	 * pContext.Memo.Plan so every lowering of one request draws from one alias counter.
	 *
	 * @param {Record<string, any>} pContext
	 * @return {Record<string, any>}
	 */
	_state(pContext)
	{
		if (!isPlainObject(pContext.Memo))
		{
			pContext.Memo = {};
		}
		if (isPlainObject(pContext.Memo.Plan))
		{
			return pContext.Memo.Plan;
		}
		let tmpBinder = this.fable.RetoldFacetingBinder;
		if (!pContext.Bind && tmpBinder)
		{
			// The wiring's Bind stage normally set it (internal-contracts §22.6).
			pContext.Bind = tmpBinder.context(pContext);
		}
		let tmpAuthorizer = this.fable.RetoldFacetingAuthorizer;
		pContext.Memo.Plan =
			{
				Env:
					{
						Catalog: this.fable.RetoldFacetingCatalog,
						Graph: this.fable.RetoldFacetingGraph,
						Counter: libLowering.newAliasCounter(),
						Memo: new Map()
					},
				WhereMemo: new Map(),
				Lowered: {},
				CanFacet: (pEntity) =>
				{
					if (!tmpAuthorizer || (typeof(tmpAuthorizer.canFacet) !== 'function'))
					{
						return true;
					}
					return (tmpAuthorizer.canFacet(pContext, pEntity) === true);
				}
			};
		return pContext.Memo.Plan;
	}

	/**
	 * The resolved options of a request.
	 *
	 * @param {Record<string, any>} pContext
	 * @return {Record<string, any>}
	 */
	_options(pContext)
	{
		return (pContext && isPlainObject(pContext.Options) && isPlainObject(pContext.Options.Limits)) ? pContext.Options : this.options;
	}

	/**
	 * Lower every Path-shaped conjunct of the FilterAST once (scope 'p', 'h' hops) into
	 * pState.Lowered[ConjunctId]; a failure fails the whole request.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pState
	 */
	_lowerConjuncts(pContext, pState)
	{
		let tmpAST = this.fable.RetoldFacetingFilterAST;
		let tmpConjuncts = Array.isArray(pContext.FilterAST.Conjuncts) ? pContext.FilterAST.Conjuncts : [];
		for (let i = 0; i < tmpConjuncts.length; i++)
		{
			let tmpConjunct = tmpConjuncts[i];
			let tmpIsPath = (tmpAST && (typeof(tmpAST.isPathConjunct) === 'function')) ? tmpAST.isPathConjunct(tmpConjunct) : (tmpConjunct.Shape === 'Path');
			if (!tmpIsPath || hasOwn(pState.Lowered, tmpConjunct.Id))
			{
				continue;
			}
			pState.Lowered[tmpConjunct.Id] = libLowering.lowerPred(tmpConjunct.Pred, { Alias: 'p', Entity: pContext.Entity, Prefix: 'h' }, pState.Env);
		}
	}

	/**
	 * Fill a Variant's PathPred (the And of its kept Path conjuncts' lowered FoldPreds).
	 *
	 * @param {Record<string, any>} pVariant
	 * @param {Record<string, any>} pState
	 */
	_fillVariant(pVariant, pState)
	{
		let tmpPathConjuncts = Array.isArray(pVariant.PathConjuncts) ? pVariant.PathConjuncts : [];
		pVariant.PathPred = libLowering.combineNodes('And', tmpPathConjuncts.map((pConjunct) => { return pState.Lowered[pConjunct.Id]; }));
	}

	// ------------------------------------------------------------ plan()

	/**
	 * Plan a request.  Requires pContext.NormalizedRequest and pContext.FilterAST; sets
	 * pContext.Variants (and pContext.Bind when the wiring's Bind stage did not).
	 *
	 * Every requested facet is resolved (step 5, registry first) and lowered into an Agg; a facet
	 * that fails lands in Errors[Key].  The surviving Aggs (plus '#Total' when Total is requested)
	 * go through the DisjunctivePlanner, which assigns each its Variant; Aggs with the same kept
	 * conjunct set and the same definition Where share one Variant.  Path conjuncts are lowered once
	 * (scope 'p') and every Variant's PathPred is the And of its kept ones.  Then the Rel
	 * projections, DepSets, the cube plan and BindHash (computed last).
	 *
	 * @param {Record<string, any>} pContext - internal-contracts §2.2 / §19.5
	 * @param {(pError?: Error, pPlan?: { Aggs: Array<Record<string, any>>, Variants: Record<string, any>, Cubes: Array<Record<string, any>>, DepSet: Record<string, Array<string>>, Entities: Array<string>, BindHash: string, Errors: Record<string, any>, Lowered: Record<string, any> }) => void} fCallback
	 */
	plan(pContext, fCallback)
	{
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		let tmpFoldIR = this.fable.RetoldFacetingFoldIR;
		let tmpDisjunctivePlanner = this.fable.RetoldFacetingDisjunctivePlanner;
		let tmpRequest = pContext ? pContext.NormalizedRequest : null;
		let tmpFilterAST = pContext ? pContext.FilterAST : null;
		if (!tmpCatalog || !tmpFoldIR || !tmpDisjunctivePlanner || !tmpRequest || !tmpFilterAST)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The planner is not wired.'));
		}

		let tmpState;
		try
		{
			tmpState = this._state(pContext);
			// The request filter's path conjuncts first ('h' hops): a failure fails the request.
			this._lowerConjuncts(pContext, tmpState);
		}
		catch (pFilterError)
		{
			return fCallback(this._requestError(pContext, pFilterError));
		}

		let tmpErrors = {};
		let tmpFacets = Array.isArray(tmpRequest.Facets) ? tmpRequest.Facets : [];

		// Step 5: resolve every facet (registry first, internal-contracts §20.8).
		let tmpResolved = [];
		for (let i = 0; i < tmpFacets.length; i++)
		{
			let tmpSpec = tmpFacets[i];
			try
			{
				tmpResolved.push({ Spec: tmpSpec, Resolved: this.resolveFacets(tmpSpec, pContext) });
			}
			catch (pResolveError)
			{
				tmpErrors[tmpSpec.Key] = this._facetErrorEntry(pContext, tmpSpec, pResolveError);
				tmpResolved.push({ Spec: tmpSpec, Resolved: null });
			}
		}

		// The top-level Params validate against every referenced declared facet (and request scope).
		try
		{
			this._checkRequestParams(pContext, tmpResolved);
		}
		catch (pParamsError)
		{
			return fCallback(this._requestError(pContext, pParamsError));
		}

		let tmpAggs = [];
		for (let i = 0; i < tmpResolved.length; i++)
		{
			if (!tmpResolved[i].Resolved)
			{
				continue;
			}
			let tmpSpec = tmpResolved[i].Spec;
			try
			{
				tmpAggs.push(this.lower(tmpSpec, tmpResolved[i].Resolved, pContext));
			}
			catch (pFacetError)
			{
				if (libFacetErrors.isFacetError(pFacetError) && (pFacetError.Code === 'FACET_UNAUTHENTICATED'))
				{
					// Fail closed: an unset principal value fails the whole request (internal-contracts §22.4).
					return fCallback(pFacetError);
				}
				tmpErrors[tmpSpec.Key] = this._facetErrorEntry(pContext, tmpSpec, pFacetError);
			}
		}

		let tmpTotalAgg = null;
		if (tmpRequest.Total !== false)
		{
			tmpTotalAgg = tmpFoldIR.agg({ Key: TOTAL_KEY, Kind: 'Count', Pivot: pContext.Entity, Exclude: 'None', VariantId: 'v0', DisplayName: 'Total', Entities: [ pContext.Entity ] });
		}

		// Variants (internal-contracts §6, §24.6): one per distinct (kept-conjunct set, WhereHash).
		let tmpSpecs = tmpAggs.map(
			(pAgg) =>
			{
				return { Key: pAgg.Key, OwnedFields: pAgg.OwnedFields, FilterKey: pAgg.FilterKey, Exclude: pAgg.Exclude, Fold: pAgg.Kind, WhereHash: pAgg.WhereHash || '', Where: pAgg.Where || null };
			});
		if (tmpTotalAgg)
		{
			tmpSpecs.push({ Key: TOTAL_KEY, OwnedFields: [], FilterKey: null, Exclude: 'None', Fold: 'Count', WhereHash: '', Where: null });
		}
		let tmpVariantPlan;
		try
		{
			tmpVariantPlan = tmpDisjunctivePlanner.variants(tmpFilterAST, tmpSpecs);
		}
		catch (pVariantError)
		{
			return fCallback(pVariantError);
		}
		pContext.Variants = tmpVariantPlan.Variants;
		Object.keys(pContext.Variants).forEach((pVariantId) => { this._fillVariant(pContext.Variants[pVariantId], tmpState); });

		let tmpConjunctsById = {};
		(Array.isArray(tmpFilterAST.Conjuncts) ? tmpFilterAST.Conjuncts : []).forEach((pConjunct) => { tmpConjunctsById[pConjunct.Id] = pConjunct; });

		let tmpAllAggs = tmpTotalAgg ? tmpAggs.concat([ tmpTotalAgg ]) : tmpAggs;
		for (let i = 0; i < tmpAllAggs.length; i++)
		{
			let tmpAgg = tmpAllAggs[i];
			let tmpFacetPlan = tmpVariantPlan.Facets[tmpAgg.Key];
			if (!tmpFacetPlan)
			{
				return fCallback(libFacetErrors.create('FACET_INTERNAL', 'A facet has no variant.'));
			}
			tmpAgg.VariantId = tmpFacetPlan.VariantId;
			tmpAgg.Disjunctive =
				{
					Mode: tmpFacetPlan.Mode,
					Excluded: tmpFacetPlan.Excluded.slice(),
					ExcludedHashes: tmpFacetPlan.ExcludedHashes.slice(),
					KeptMixed: tmpFacetPlan.KeptMixed.slice(),
					Owned: tmpFacetPlan.Owned.slice()
				};
			let tmpVariant = pContext.Variants[tmpAgg.VariantId];
			if (tmpAgg.Tuple)
			{
				// The Home side carries the Variant's client conjuncts (internal-contracts §24.4).
				tmpAgg.Tuple.Sides.forEach((pSide) => { if (pSide.Alias === 'p') { pSide.Rel.Client = tmpVariant.ColumnConjuncts.slice(); } });
			}
			if (tmpAgg.Kind === 'Terms')
			{
				// Selected keys come back even when they rank below Top (internal-contracts §10.4): the
				// engines must return their real counts, so the Live statement returns every group then.
				let tmpOwned = tmpAgg.Disjunctive.Owned.map((pId) => { return tmpConjunctsById[pId]; }).filter((pConjunct) => { return !!pConjunct; });
				try
				{
					tmpAgg.SelectedKeys = libFacetClauses.selectedFrom(tmpAgg, tmpOwned).Keys;
				}
				catch (pSelectedError)
				{
					this.fable.log.warn(`RetoldFaceting Planner: selected keys of facet ${libFacetUtil.logSafe(tmpAgg.Key)} could not be derived (${pSelectedError.message}).`);
					tmpAgg.SelectedKeys = [];
				}
			}
		}

		// Projections of every Rel: plan-wide unique aliases make one pass over the whole forest exact
		// for every alias but 'p'; a TuplePivot Home side ('p') is projected from its own Agg and
		// Variant (what its tuple, its Where, its dimensions and the Variant's PathPred read).
		let tmpVariantList = Object.keys(pContext.Variants).map((pVariantId) => { return pContext.Variants[pVariantId]; });
		libLowering.assignProjects(tmpVariantList.concat(tmpAllAggs), tmpState.Env, null, { SkipAliases: [ 'p' ] });
		for (let i = 0; i < tmpAllAggs.length; i++)
		{
			if (tmpAllAggs[i].Tuple)
			{
				libLowering.assignProjects([ tmpAllAggs[i], pContext.Variants[tmpAllAggs[i].VariantId] ], tmpState.Env, null, { OnlyAliases: [ 'p' ] });
			}
		}
		tmpVariantList.forEach((pVariant) => { pVariant.Relations = libLowering.relationListing(pVariant); });

		let tmpEntities = [ pContext.Entity ].concat(Array.isArray(tmpFilterAST.Entities) ? tmpFilterAST.Entities : []);
		for (let i = 0; i < tmpAllAggs.length; i++)
		{
			let tmpAgg = tmpAllAggs[i];
			tmpAgg.Relations = libLowering.relationListing(tmpAgg);
			tmpAgg.DepSet = tmpFoldIR.depSet(tmpAgg, pContext.Variants[tmpAgg.VariantId], tmpCatalog);
			tmpEntities = tmpEntities.concat(tmpAgg.Entities || []);
		}
		tmpVariantList.forEach((pVariant) => { tmpEntities = tmpEntities.concat(libLowering.relationListing(pVariant).map((pRel) => { return pRel.Entity; })); });

		let tmpCubes = this.cubes(tmpAllAggs, pContext.Variants, pContext, tmpState);

		let tmpBinder = this.fable.RetoldFacetingBinder;
		let tmpBindHash = tmpBinder ? tmpBinder.bindHash(pContext.Bind) : null;

		return fCallback(null,
			{
				Aggs: tmpAllAggs,
				Variants: pContext.Variants,
				Cubes: tmpCubes,
				DepSet: this.depSet(tmpAllAggs),
				Entities: uniqueSorted(tmpEntities),
				BindHash: tmpBindHash,
				Errors: tmpErrors,
				Lowered: tmpState.Lowered
			});
	}

	/**
	 * A whole-request error (facet errors pass through; anything else is logged as FACET_INTERNAL).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {any} pError
	 * @return {Error}
	 */
	_requestError(pContext, pError)
	{
		if (libFacetErrors.isFacetError(pError))
		{
			return pError;
		}
		this.fable.log.error(`RetoldFaceting Planner could not plan the filter of request ${(pContext && pContext.RequestID) || '?'}: ${(pError && pError.message) ? pError.message : pError}`);
		return libFacetErrors.create('FACET_INTERNAL');
	}

	/**
	 * A per-facet error entry (non-facet errors logged as FACET_INTERNAL).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pSpec
	 * @param {any} pError
	 * @return {Record<string, any>}
	 */
	_facetErrorEntry(pContext, pSpec, pError)
	{
		if (!libFacetErrors.isFacetError(pError))
		{
			this.fable.log.error(`RetoldFaceting Planner could not lower facet ${libFacetUtil.logSafe(pSpec.Key)} of request ${(pContext && pContext.RequestID) || '?'}: ${(pError && pError.message) ? pError.message : pError}`);
		}
		return libFacetErrors.toEntry(pError);
	}

	/**
	 * Is a resolved item a canonical facet (registry) rather than a catalog descriptor?
	 *
	 * @param {any} pItem
	 * @return {boolean}
	 */
	isCanonical(pItem)
	{
		return isPlainObject(pItem) && (CANONICAL_ORIGINS.indexOf(pItem.Origin) >= 0);
	}

	/**
	 * Top-level Params: every name must be declared by a referenced declared facet or by a scope the
	 * request names (the /Scope/:Scope/ route form copies that scope's params from here, §22.3).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Array<{ Spec: any, Resolved: any }>} pResolved
	 */
	_checkRequestParams(pContext, pResolved)
	{
		let tmpParams = isPlainObject(pContext.NormalizedRequest.Params) ? pContext.NormalizedRequest.Params : {};
		let tmpNames = Object.keys(tmpParams);
		if (tmpNames.length < 1)
		{
			return;
		}
		let tmpDeclared = new Set();
		for (let i = 0; i < pResolved.length; i++)
		{
			(Array.isArray(pResolved[i].Resolved) ? pResolved[i].Resolved : []).forEach(
				(pItem) =>
				{
					if (this.isCanonical(pItem) && isPlainObject(pItem.Params))
					{
						Object.keys(pItem.Params).forEach((pName) => { tmpDeclared.add(pName); });
					}
				});
		}
		let tmpRegistry = this.fable.RetoldFacetingDefinitionRegistry;
		let tmpScopes = Array.isArray(pContext.NormalizedRequest.Scopes) ? pContext.NormalizedRequest.Scopes : [];
		for (let i = 0; i < tmpScopes.length; i++)
		{
			let tmpScope = (tmpRegistry && tmpScopes[i] && (typeof(tmpScopes[i].Scope) === 'string')) ? tmpRegistry.scope(tmpScopes[i].Scope) : null;
			if (tmpScope && isPlainObject(tmpScope.Params))
			{
				Object.keys(tmpScope.Params).forEach((pName) => { tmpDeclared.add(pName); });
			}
		}
		for (let i = 0; i < tmpNames.length; i++)
		{
			if (!tmpDeclared.has(tmpNames[i]))
			{
				throw libFacetErrors.create('FACET_PARAM_INVALID', null, { Param: tmpNames[i].substring(0, 64), Reason: 'Unknown' });
			}
		}
	}

	/**
	 * The public form of the top-level Params check (the Records / Count / Keys pipeline calls it
	 * with no facets: every name must then be declared by a scope the request names).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Array<{ Spec: any, Resolved: any }>} [pResolved]
	 */
	checkRequestParams(pContext, pResolved)
	{
		return this._checkRequestParams(pContext, Array.isArray(pResolved) ? pResolved : []);
	}

	/**
	 * OF(f): the fields a facet owns (internal-contracts §6.1, §23.5) — every pivot dimension field,
	 * else the measured field; path dimensions own '@path:<Signature>#<Field | KeyField>'.
	 *
	 * @param {Record<string, any>} pAgg
	 * @return {Array<string>}
	 */
	ownedFields(pAgg)
	{
		if (Array.isArray(pAgg.OwnedFields) && (pAgg.OwnedFields.length > 0))
		{
			return pAgg.OwnedFields.slice();
		}
		let tmpFields = [];
		let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
		for (let i = 0; i < tmpDimensions.length; i++)
		{
			if (tmpDimensions[i] && (typeof(tmpDimensions[i].Field) === 'string') && !tmpDimensions[i].Via && (tmpFields.indexOf(tmpDimensions[i].Field) < 0))
			{
				tmpFields.push(tmpDimensions[i].Field);
			}
		}
		if ((typeof(pAgg.Field) === 'string') && (tmpFields.indexOf(pAgg.Field) < 0) && (tmpDimensions.length < 1))
		{
			tmpFields.push(pAgg.Field);
		}
		return tmpFields;
	}

	// ------------------------------------------------------------ Step 5: resolution

	/**
	 * Step 5: resolve a facet spec's FacetIDs (internal-contracts §11.2, §20.8):
	 *   Auto 'E.Name'        → registry.facet first (a declared name never equals a column), else the catalog;
	 *   Declared 'E.Name/S'  → registry.facet;
	 *   Path 'E.c>T.col'     → registry.resolveFacet (synthesized PathAuto, one hop).
	 * The FacetID's entity must be the route entity; unknown / disabled → 400 FACET_UNKNOWN_FACET.
	 *
	 * @param {Record<string, any>} pFacetSpec - NormalizedRequest.Facets[i]
	 * @param {Record<string, any>} pContext
	 * @return {Array<Record<string, any>>} catalog descriptors and / or CanonicalFacets (throws a per-facet FacetError)
	 */
	resolveFacets(pFacetSpec, pContext)
	{
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		let tmpRegistry = this.fable.RetoldFacetingDefinitionRegistry;
		let tmpFacetIDs = Array.isArray(pFacetSpec.FacetIDs) ? pFacetSpec.FacetIDs : [];
		if (tmpFacetIDs.length < 1)
		{
			throw libFacetErrors.create('FACET_REQUEST_INVALID', 'Facet is required.', { Field: 'Facet', Key: pFacetSpec.Key });
		}
		let tmpResolved = [];
		for (let i = 0; i < tmpFacetIDs.length; i++)
		{
			let tmpFacetID = tmpFacetIDs[i];
			let tmpParsed = libFacetRequest.parseFacetID(tmpFacetID);
			if (tmpParsed === null)
			{
				throw libFacetErrors.create('FACET_REQUEST_INVALID', 'Facet is not a valid FacetID.', { Field: 'Facet', Key: pFacetSpec.Key, Reason: 'InvalidFacetID' });
			}
			if (tmpParsed.Entity !== pContext.Entity)
			{
				throw libFacetErrors.create('FACET_UNKNOWN_FACET', null, { Facet: tmpFacetID });
			}
			let tmpItem = null;
			if (tmpRegistry)
			{
				if (tmpParsed.Kind === 'Path')
				{
					tmpItem = (typeof(tmpRegistry.resolveFacet) === 'function') ? tmpRegistry.resolveFacet(tmpFacetID) : null;
				}
				else if (typeof(tmpRegistry.facet) === 'function')
				{
					tmpItem = tmpRegistry.facet(tmpFacetID);
				}
			}
			if (!tmpItem && (tmpParsed.Kind === 'Auto'))
			{
				tmpItem = tmpCatalog.facet(tmpFacetID);
			}
			if (!tmpItem || (tmpItem.Entity !== pContext.Entity))
			{
				throw libFacetErrors.create('FACET_UNKNOWN_FACET', null, { Facet: tmpFacetID });
			}
			if (this.isCanonical(tmpItem))
			{
				// The per-facet gate runs during resolution (§19.6), before the request Params are
				// checked against the facets' declarations: a facet the principal may not read
				// declares nothing (its params read as Unknown, like a nonexistent facet's).
				let tmpGate = this._canonicalEntities(tmpItem);
				let tmpState = this._state(pContext);
				if (tmpGate.some((pEntity) => { return !tmpState.CanFacet(pEntity); }))
				{
					// A PathAuto facet whose target the principal cannot facet is answered exactly like
					// a path that does not exist (no 403-vs-400 oracle on hidden entities and edges).
					throw (tmpItem.Origin === 'PathAuto')
						? libFacetErrors.create('FACET_UNKNOWN_FACET', null, { Facet: tmpFacetID })
						: libFacetErrors.create('FACET_FORBIDDEN');
				}
			}
			tmpResolved.push(tmpItem);
		}
		return tmpResolved;
	}

	// ------------------------------------------------------------ Lowering one facet

	/**
	 * Lower one facet spec on its resolved descriptors into an Agg (without Variant info).
	 *
	 * @param {Record<string, any>} pFacetSpec - NormalizedRequest.Facets[i]
	 * @param {Array<Record<string, any>>} pDescriptors - resolveFacets() result
	 * @param {Record<string, any>} pContext
	 * @return {Record<string, any>} Agg (throws a per-facet FacetError)
	 */
	lower(pFacetSpec, pDescriptors, pContext)
	{
		let tmpDescriptors = Array.isArray(pDescriptors) ? pDescriptors : [];
		let tmpSpec = pFacetSpec || {};
		if (tmpDescriptors.length < 1)
		{
			throw libFacetErrors.create('FACET_UNKNOWN_FACET', null, { Key: tmpSpec.Key });
		}
		let tmpCanonical = tmpDescriptors.filter((pItem) => { return this.isCanonical(pItem); });
		if (tmpCanonical.length < 1)
		{
			return this._lowerAuto(tmpSpec, tmpDescriptors, pContext);
		}
		if ((tmpDescriptors.length === 1) && (tmpSpec.Fold !== 'Pivot'))
		{
			return this._lowerDeclared(tmpSpec, tmpDescriptors[0], pContext);
		}
		return this._lowerPivot(tmpSpec, tmpDescriptors, pContext);
	}

	/**
	 * M1: an auto facet (or a pivot of two auto facets) on its catalog descriptors.
	 *
	 * @param {Record<string, any>} pFacetSpec
	 * @param {Array<Record<string, any>>} pDescriptors
	 * @param {Record<string, any>} pContext
	 * @return {Record<string, any>}
	 */
	_lowerAuto(pFacetSpec, pDescriptors, pContext)
	{
		let tmpFoldIR = this.fable.RetoldFacetingFoldIR;
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		let tmpLimits = this._options(pContext).Limits;
		let tmpSpec = pFacetSpec;
		let tmpDescriptors = pDescriptors;
		let tmpEntity = (pContext && (typeof(pContext.Entity) === 'string')) ? pContext.Entity : tmpDescriptors[0].Entity;
		let tmpFold = (typeof(tmpSpec.Fold) === 'string') ? tmpSpec.Fold
			: (tmpDescriptors.length === 2) ? 'Pivot'
			: tmpDescriptors[0].DefaultFold;
		let tmpExclude = ((tmpSpec.Exclude === null) || (typeof(tmpSpec.Exclude) === 'undefined')) ? libFacetRequest.defaultExcludeFor(tmpFold) : tmpSpec.Exclude;
		let tmpFields =
			{
				Key: tmpSpec.Key,
				Kind: tmpFold,
				Pivot: tmpEntity,
				Order: (typeof(tmpSpec.Order) === 'string') ? tmpSpec.Order : 'CountDesc',
				Missing: (tmpSpec.Missing !== false),
				EmptyBuckets: (tmpSpec.EmptyBuckets !== false),
				Chart: (tmpSpec.Chart === true),
				Exclude: Array.isArray(tmpExclude) ? tmpExclude.slice() : tmpExclude,
				CountMode: 'Rows',
				Entities: [ tmpEntity ]
			};

		if (tmpFold === 'Pivot')
		{
			if (tmpDescriptors.length !== 2)
			{
				throw libFacetErrors.create('FACET_REQUEST_INVALID', 'A Pivot takes exactly two FacetIDs.', { Field: 'Facet', Key: tmpSpec.Key, Reason: 'PivotDimensions' });
			}
			let tmpAgg = tmpFoldIR.agg(Object.assign(tmpFields,
				{
					FacetID: tmpDescriptors.map((pDescriptor) => { return pDescriptor.Facet; }).join('|'),
					FacetIDs: tmpDescriptors.map((pDescriptor) => { return pDescriptor.Facet; }),
					Dimensions: tmpDescriptors.map((pDescriptor) => { return tmpFoldIR.pivotAxisFor(pDescriptor, tmpSpec); }),
					Field: null,
					FieldInfo: null,
					Top: (typeof(tmpSpec.Top) === 'number') ? tmpSpec.Top : null,
					ClauseType: null,
					FilterKey: null,
					Selectable: false,
					DisplayName: tmpDescriptors.map((pDescriptor) => { return pDescriptor.DisplayName; }).join(' × ')
				}));
			tmpAgg.OwnedFields = this.ownedFields(tmpAgg);
			return tmpAgg;
		}

		if (tmpDescriptors.length !== 1)
		{
			throw libFacetErrors.create('FACET_REQUEST_INVALID', 'An array of FacetIDs requires Fold: Pivot.', { Field: 'Facet', Key: tmpSpec.Key, Reason: 'FacetArrayNeedsPivot' });
		}
		let tmpDescriptor = tmpDescriptors[0];
		let tmpFolds = Array.isArray(tmpDescriptor.Folds) ? tmpDescriptor.Folds : [];
		if (tmpFolds.indexOf(tmpFold) < 0)
		{
			throw libFacetErrors.create('FACET_UNKNOWN_FOLD', null, { Facet: tmpDescriptor.Facet, Fold: tmpFold, Folds: tmpFolds.slice() });
		}
		let tmpBucketed = (libFacetRequest.SELECTABLE_FOLDS.indexOf(tmpFold) >= 0);
		let tmpFieldInfo = null;
		if (!tmpBucketed)
		{
			tmpFieldInfo = tmpCatalog.column(tmpEntity, tmpDescriptor.Field);
			if (!tmpFieldInfo)
			{
				throw libFacetErrors.create('FACET_UNKNOWN_FACET', null, { Facet: tmpDescriptor.Facet });
			}
		}
		let tmpLabelLookup = null;
		if ((tmpFold === 'Terms') && (tmpSpec.Labels !== false) && tmpDescriptor.LabelLookup && (typeof(tmpDescriptor.LabelLookup.LabelColumn) === 'string'))
		{
			tmpLabelLookup = tmpDescriptor.LabelLookup;
		}
		let tmpAgg = tmpFoldIR.agg(Object.assign(tmpFields,
			{
				FacetID: tmpDescriptor.Facet,
				FacetIDs: [ tmpDescriptor.Facet ],
				Dimensions: tmpBucketed ? [ tmpFoldIR.dimensionFor(tmpFold, tmpDescriptor, tmpSpec) ] : [],
				Field: tmpDescriptor.Field,
				FieldInfo: tmpFieldInfo,
				Top: (tmpFold === 'Terms') ? ((typeof(tmpSpec.Top) === 'number') ? tmpSpec.Top : tmpLimits.DefaultTop) : null,
				ClauseType: libFacetRequest.clauseTypeFor(tmpFold),
				FilterKey: tmpDescriptor.FilterKey || tmpDescriptor.Field,
				Selectable: tmpBucketed,
				DisplayName: tmpDescriptor.DisplayName,
				LabelLookup: tmpLabelLookup
			}));
		tmpAgg.OwnedFields = this.ownedFields(tmpAgg);
		return tmpAgg;
	}

	/**
	 * Every entity a canonical facet reads (the per-facet gate list): the registry's Entities, the
	 * pivot / tuple sides, and every hop of its Where, dimension paths, dimension Wheres and child
	 * relations (label targets are gated by the LabelResolver instead).
	 *
	 * @param {Record<string, any>} pCanonical
	 * @return {Array<string>}
	 */
	_canonicalEntities(pCanonical)
	{
		let tmpEntities = Array.isArray(pCanonical.Entities) ? pCanonical.Entities.slice() : [];
		tmpEntities.push(pCanonical.Entity);
		let tmpPivot = isPlainObject(pCanonical.Pivot) ? pCanonical.Pivot : null;
		if (tmpPivot && (tmpPivot.Kind === 'Tuple') && Array.isArray(tmpPivot.Sides))
		{
			tmpPivot.Sides.forEach(
				(pSide) =>
				{
					tmpEntities.push(pSide.Entity);
					tmpEntities = tmpEntities.concat(libRetoldFacetingFilterAST.entitiesOf(pSide.Where));
				});
		}
		tmpEntities = tmpEntities.concat(libRetoldFacetingFilterAST.entitiesOf(pCanonical.Where));
		(Array.isArray(pCanonical.Dimensions) ? pCanonical.Dimensions : []).forEach(
			(pDimension) =>
			{
				let tmpPaths = [];
				if (isPlainObject(pDimension.Path))
				{
					tmpPaths.push({ Path: pDimension.Path, Where: pDimension.Where || null });
				}
				if (isPlainObject(pDimension.Child) && isPlainObject(pDimension.Child.Path))
				{
					tmpPaths.push({ Path: pDimension.Child.Path, Where: pDimension.Child.Where || null });
				}
				tmpPaths.forEach((pPath) => { tmpEntities = tmpEntities.concat(libRetoldFacetingFilterAST.entitiesOf({ Exists: pPath })); });
			});
		return uniqueSorted(tmpEntities);
	}

	/**
	 * Bind a dimension path (and the predicate evaluated on its last entity) with the facet's
	 * params: the Binder walks the step Wheres of an Exists node.
	 *
	 * @param {Record<string, any>} pPathPlan
	 * @param {any} pWhere
	 * @param {any} pCorrelate
	 * @param {Record<string, any>} pBindOptions
	 * @param {Record<string, any>} pParams
	 * @param {Record<string, any>} pContext
	 * @return {{ Path: Record<string, any>, Where: any, Correlate: any }}
	 */
	_bindPath(pPathPlan, pWhere, pCorrelate, pBindOptions, pParams, pContext)
	{
		let tmpBound = this._binder().bind({ Exists: { From: null, Path: pPathPlan, Where: (pWhere === undefined) ? null : pWhere, Correlate: Array.isArray(pCorrelate) ? pCorrelate : [] } },
			pContext.Bind, pParams, pBindOptions);
		return { Path: tmpBound.Exists.Path, Where: tmpBound.Exists.Where, Correlate: tmpBound.Exists.Correlate };
	}

	/**
	 * @return {any} the Binder service
	 */
	_binder()
	{
		let tmpBinder = this.fable.RetoldFacetingBinder;
		if (!tmpBinder)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The planner needs the RetoldFacetingBinder service.');
		}
		return tmpBinder;
	}

	/**
	 * The keyed column info of a dimension (canonical typing first, then the catalog).
	 *
	 * @param {Record<string, any>} pDimension - CanonicalDim
	 * @param {string} pEntity - the entity the keyed column belongs to
	 * @param {string} pColumn
	 * @return {{ DataType: string|null, IsInteger: boolean, Scale: number }}
	 */
	_typing(pDimension, pEntity, pColumn)
	{
		if (pDimension && (typeof(pDimension.DataType) === 'string'))
		{
			return { DataType: pDimension.DataType, IsInteger: !!pDimension.IsInteger, Scale: (typeof(pDimension.Scale) === 'number') ? pDimension.Scale : 0 };
		}
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		let tmpColumn = (tmpCatalog && (typeof(pEntity) === 'string')) ? tmpCatalog.column(pEntity, pColumn) : null;
		if (!tmpColumn)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A declared dimension keys a column the catalog does not know.');
		}
		return { DataType: tmpColumn.DataType, IsInteger: !!tmpColumn.IsInteger, Scale: (typeof(tmpColumn.Scale) === 'number') ? tmpColumn.Scale : 0 };
	}

	/**
	 * The effective fold of one canonical dimension under a request (PathAuto facets may ask for any
	 * of their Folds; declared facets have one).
	 *
	 * @param {Record<string, any>} pDimension
	 * @param {Record<string, any>} pCanonical
	 * @param {Record<string, any>} pSpec
	 * @return {string}
	 */
	_dimensionFold(pDimension, pCanonical, pSpec)
	{
		let tmpKind = pDimension.Kind;
		if ((pCanonical.Origin === 'PathAuto') && (typeof(pSpec.Fold) === 'string') && (BUCKET_FOLDS.indexOf(pSpec.Fold) >= 0))
		{
			return pSpec.Fold;
		}
		return tmpKind;
	}

	/**
	 * Lower one canonical dimension (internal-contracts §24.3, §24.8).
	 *
	 * @param {Record<string, any>} pDimension - CanonicalDim
	 * @param {string} pFold - the effective fold of this dimension
	 * @param {Record<string, any>} pSpec - the request facet spec (overrides)
	 * @param {Record<string, any>} pScope - { Alias, Entity, Names, SideEntities } of the pivot / Home side
	 * @param {Record<string, any>} pBindOptions
	 * @param {Record<string, any>} pParams
	 * @param {Record<string, any>} pContext
	 * @param {string} pFacetID
	 * @return {Record<string, any>} Dim
	 */
	_lowerDimension(pDimension, pFold, pSpec, pScope, pBindOptions, pParams, pContext, pFacetID)
	{
		let tmpFoldIR = this.fable.RetoldFacetingFoldIR;
		let tmpState = this._state(pContext);
		let tmpEnv = tmpState.Env;

		if (pFold === 'ChildRollup')
		{
			let tmpChild = isPlainObject(pDimension.Child) ? pDimension.Child : null;
			if (!tmpChild || !isPlainObject(tmpChild.Path))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'A ChildRollup dimension has no Child path.');
			}
			if ((tmpChild.Agg || 'count') !== 'count')
			{
				throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', null, { Feature: 'ChildRollupAgg', Milestone: 2 });
			}
			let tmpBound = this._bindPath(tmpChild.Path, tmpChild.Where, null, pBindOptions, pParams, pContext);
			let tmpLowered = libLowering.lowerChild({ Path: tmpBound.Path, Where: tmpBound.Where, Agg: 'count' }, pScope.Alias, tmpEnv);
			let tmpEdges = Array.isArray(pDimension.Edges) ? pDimension.Edges.slice() : [];
			if (!libFacetBuckets.isBandEdges(tmpEdges))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'A ChildRollup dimension needs strictly ascending positive integer Edges starting at 1.');
			}
			let tmpChildDimension = { Kind: 'ChildAgg', Rel: tmpLowered.Rel, On: tmpLowered.On, Where: tmpLowered.Where, Agg: 'count', Field: null, Edges: tmpEdges, DataType: 'Numeric', IsInteger: true, Scale: 0 };
			if (isPlainObject(pDimension.Labels))
			{
				// The declared band labels (internal-contracts §29.2: Labels['<band>'] wins).
				tmpChildDimension.Labels = Object.assign({}, pDimension.Labels);
			}
			return tmpChildDimension;
		}

		if (pFold === 'ExistsSplit')
		{
			if (!isPlainObject(pDimension.Path))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'An ExistsSplit dimension has no Path.');
			}
			let tmpBound = this._bindPath(pDimension.Path, pDimension.Where, pDimension.Correlate, pBindOptions, pParams, pContext);
			let tmpPred = libLowering.lowerExistsFlag({ Path: tmpBound.Path, Where: tmpBound.Where, Correlate: tmpBound.Correlate }, pScope, tmpEnv);
			let tmpFlagDimension = { Kind: 'ExistsFlag', Pred: tmpPred, DataType: 'Boolean', IsInteger: true, Scale: 0 };
			if (isPlainObject(pDimension.Labels))
			{
				// The declared split labels (internal-contracts §29.2: Labels.true / Labels.false).
				tmpFlagDimension.Labels = Object.assign({}, pDimension.Labels);
			}
			return tmpFlagDimension;
		}

		let tmpPath = isPlainObject(pDimension.Path) ? pDimension.Path : null;
		let tmpToMany = !!tmpPath && Array.isArray(tmpPath.Steps) && tmpPath.Steps.some((pStep) => { return pStep.Direction !== 'Forward'; });
		if (tmpToMany)
		{
			// K9: a multi-valued Terms dimension through a to-many path.
			if (pFold !== 'Terms')
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'A to-many path dimension must be Terms.');
			}
			let tmpKeyField = (typeof(pDimension.KeyField) === 'string') ? pDimension.KeyField : pDimension.Field;
			let tmpBound = this._bindPath(tmpPath, pDimension.Where, null, pBindOptions, pParams, pContext);
			let tmpMulti = libLowering.lowerMulti(tmpBound.Path, tmpBound.Where, pScope.Alias, tmpEnv);
			let tmpTyping = this._typing(pDimension, tmpPath.To, tmpKeyField);
			return { Kind: 'Multi', Chain: tmpMulti.Chain, Where: tmpMulti.Where, KeyField: tmpKeyField, DataType: tmpTyping.DataType, IsInteger: tmpTyping.IsInteger, Scale: tmpTyping.Scale };
		}

		// A bucketing dimension on a column of the pivot / a tuple side, or through a to-one path (K8).
		let tmpField = pDimension.Field;
		let tmpKeyEntity = tmpPath ? tmpPath.To : ((typeof(pDimension.Alias) === 'string' && isPlainObject(pScope.SideEntities) && hasOwn(pScope.SideEntities, pDimension.Alias)) ? pScope.SideEntities[pDimension.Alias] : pScope.Entity);
		let tmpTyping = this._typing(pDimension, tmpKeyEntity, tmpField);
		let tmpDescriptor =
			{
				Facet: pFacetID,
				Field: tmpField,
				DataType: tmpTyping.DataType,
				IsInteger: tmpTyping.IsInteger,
				Scale: tmpTyping.Scale,
				Intervals: libFacetRequest.INTERVALS,
				DefaultInterval: (typeof(pDimension.Interval) === 'string') ? pDimension.Interval : this.options.Time.DefaultInterval
			};
		let tmpDimensionSpec =
			{
				Interval: (typeof(pSpec.Interval) === 'string') ? pSpec.Interval : pDimension.Interval,
				Mode: (typeof(pSpec.Mode) === 'string') ? pSpec.Mode : pDimension.Mode,
				Buckets: (typeof(pSpec.Buckets) === 'number') ? pSpec.Buckets : pDimension.Buckets,
				Edges: Array.isArray(pSpec.Edges) ? pSpec.Edges : pDimension.Edges,
				OpenEnded: (pSpec.OpenEnded === true) || ((pSpec.OpenEnded !== false) && (pDimension.OpenEnded === true)),
				Ranges: Array.isArray(pSpec.Ranges) ? pSpec.Ranges : pDimension.Ranges
			};
		if (Array.isArray(pSpec.Edges) && (typeof(pSpec.Mode) !== 'string'))
		{
			tmpDimensionSpec.Mode = 'Edges';
		}
		let tmpDim = tmpFoldIR.dimensionFor(pFold, tmpDescriptor, tmpDimensionSpec);
		if (tmpPath)
		{
			let tmpBound = this._bindPath(tmpPath, null, null, pBindOptions, pParams, pContext);
			tmpDim.Alias = pScope.Alias;
			tmpDim.Via = libLowering.lowerVia(tmpBound.Path, pScope.Alias, tmpEnv);
		}
		else if (typeof(pDimension.Alias) === 'string')
		{
			// A TuplePivot side column.
			let tmpNames = isPlainObject(pScope.Names) ? pScope.Names : {};
			if (!hasOwn(tmpNames, pDimension.Alias))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'A tuple dimension names an unknown side.');
			}
			tmpDim.Alias = tmpNames[pDimension.Alias];
		}
		return tmpDim;
	}

	/**
	 * The clause type a bucket of a declared / path facet writes back (internal-contracts §29.3).
	 *
	 * @param {string} pFold
	 * @param {Record<string, any>} pDimension - lowered Dim
	 * @param {Record<string, any>|null} pPathPlan
	 * @param {boolean} pTuple
	 * @return {string|null}
	 */
	_clauseType(pFold, pDimension, pPathPlan, pTuple)
	{
		if (pTuple || (BUCKET_FOLDS.indexOf(pFold) < 0))
		{
			return null;
		}
		if (!pPathPlan)
		{
			return libFacetRequest.clauseTypeFor(pFold);
		}
		if (libFacetClauses.pathRestricted(pDimension, pPathPlan))
		{
			// A step Where / TenantOnly / CheckParent or a dimension Where: no join clause carries it.
			return null;
		}
		let tmpSteps = Array.isArray(pPathPlan.Steps) ? pPathPlan.Steps : [];
		let tmpGraph = this.fable.RetoldFacetingGraph;
		if (pDimension.Kind === 'Multi')
		{
			// K9 over exactly '<J.a >J.b' ending at the target key.
			if ((tmpSteps.length === 2) && (tmpSteps[0].Direction === 'Reverse') && (tmpSteps[1].Direction === 'Forward'))
			{
				let tmpEdge = tmpGraph ? tmpGraph.edge(tmpSteps[1].Edge) : null;
				if (tmpEdge && (tmpEdge.ToColumn === pDimension.KeyField))
				{
					return 'ExternalJoinSelectedValueList';
				}
			}
			return null;
		}
		if ((tmpSteps.length !== 1) || (tmpSteps[0].Direction !== 'Forward'))
		{
			return null;
		}
		if (pFold === 'Terms')
		{
			let tmpEdge = tmpGraph ? tmpGraph.edge(tmpSteps[0].Edge) : null;
			return (tmpEdge && (tmpEdge.ToColumn === pDimension.Field)) ? 'InternalJoinSelectedValueList' : 'InternalJoinMatch';
		}
		return (pFold === 'DateHistogram') ? 'InternalJoinDateRange' : 'InternalJoinNumericRange';
	}

	/**
	 * Lower a declared facet, a sibling or a PathAuto facet (internal-contracts §20.7, §24.8).
	 *
	 * Order: gate (403, per facet) → Supported (422) → Fold (400) → params (400) → bind (401 is
	 * whole-request) → lower.
	 *
	 * @param {Record<string, any>} pSpec
	 * @param {Record<string, any>} pCanonical
	 * @param {Record<string, any>} pContext
	 * @return {Record<string, any>} Agg
	 */
	_lowerDeclared(pSpec, pCanonical, pContext)
	{
		let tmpFoldIR = this.fable.RetoldFacetingFoldIR;
		let tmpState = this._state(pContext);
		let tmpEnv = tmpState.Env;
		let tmpLimits = this._options(pContext).Limits;
		let tmpFacetID = pCanonical.Facet;

		// 1. The per-facet gate (before anything about those entities is validated).
		let tmpGateEntities = this._canonicalEntities(pCanonical);
		for (let i = 0; i < tmpGateEntities.length; i++)
		{
			if (!tmpState.CanFacet(tmpGateEntities[i]))
			{
				throw libFacetErrors.create('FACET_FORBIDDEN');
			}
		}
		// 2. Supported in M2.
		if (pCanonical.Supported === false)
		{
			let tmpUnsupported = isPlainObject(pCanonical.Unsupported) ? pCanonical.Unsupported : {};
			throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', null, { Feature: tmpUnsupported.Feature || 'Definition', Milestone: 2 });
		}
		let tmpDimensions = Array.isArray(pCanonical.Dimensions) ? pCanonical.Dimensions : [];
		if ((tmpDimensions.length < 1) || (tmpDimensions.length > 2))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A canonical facet has no dimension.');
		}
		// 3. The requested fold.
		let tmpCanonicalFold = (typeof(pCanonical.Fold) === 'string') ? pCanonical.Fold : ((tmpDimensions.length === 2) ? 'Pivot' : tmpDimensions[0].Kind);
		let tmpFolds = (Array.isArray(pCanonical.Folds) && (pCanonical.Folds.length > 0)) ? pCanonical.Folds : [ tmpCanonicalFold ];
		if ((typeof(pSpec.Fold) === 'string') && (tmpFolds.indexOf(pSpec.Fold) < 0))
		{
			throw libFacetErrors.create('FACET_UNKNOWN_FOLD', null, { Facet: tmpFacetID, Fold: pSpec.Fold, Folds: tmpFolds.slice() });
		}
		let tmpFold = (typeof(pSpec.Fold) === 'string') ? pSpec.Fold : tmpCanonicalFold;

		// 4. Params (the top-level request Params this facet declares).
		let tmpRequestParams = isPlainObject(pContext.NormalizedRequest && pContext.NormalizedRequest.Params) ? pContext.NormalizedRequest.Params : {};
		let tmpDeclaredParams = isPlainObject(pCanonical.Params) ? pCanonical.Params : {};
		let tmpOwnParams = {};
		Object.keys(tmpRequestParams).forEach((pName) => { if (hasOwn(tmpDeclaredParams, pName)) { tmpOwnParams[pName] = tmpRequestParams[pName]; } });
		let tmpParams = this._binder().validateParams(tmpDeclaredParams, tmpOwnParams, { Facet: tmpFacetID });

		// 5. Bind and lower.
		let tmpPivot = isPlainObject(pCanonical.Pivot) ? pCanonical.Pivot : { Kind: 'Entity', Entity: pCanonical.Entity };
		let tmpTuple = (tmpPivot.Kind === 'Tuple');
		let tmpOwner = (typeof(pCanonical.SiblingOf) === 'string') ? pCanonical.SiblingOf : tmpFacetID;
		let tmpScope = { Alias: 'p', Entity: pCanonical.Entity, Prefix: 'j', Names: null, SideEntities: null };
		let tmpBindOptions = { Entity: pCanonical.Entity, Owner: tmpOwner, OwnerKind: 'Facet' };
		let tmpAggTuple = null;
		let tmpWhereItems = [];
		let tmpWhereKey = null;
		let tmpBoundWhere = null;
		if (tmpTuple)
		{
			let tmpLoweredTuple = this._lowerTuple(tmpPivot, pCanonical, tmpParams, pContext);
			tmpAggTuple = tmpLoweredTuple.Tuple;
			tmpScope = tmpLoweredTuple.Scope;
			tmpBindOptions = tmpLoweredTuple.BindOptions;
			tmpWhereItems = tmpLoweredTuple.WhereItems;
			tmpBoundWhere = this._binder().bind(pCanonical.Where || null, pContext.Bind, tmpParams, tmpBindOptions);
			tmpWhereKey = { Tuple: tmpLoweredTuple.BoundPivot, Where: tmpBoundWhere };
			tmpWhereItems.push(libLowering.lowerPred(tmpBoundWhere, tmpScope, tmpEnv));
		}
		else
		{
			if (tmpPivot.Entity && (tmpPivot.Entity !== pCanonical.Entity))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'An entity pivot must be the facet Home.');
			}
			tmpBoundWhere = this._binder().bind(pCanonical.Where || null, pContext.Bind, tmpParams, tmpBindOptions);
			tmpWhereKey = tmpBoundWhere;
		}
		let tmpWhereHash = (tmpTuple || (tmpBoundWhere !== null)) ? libRetoldFacetingFoldIR.whereHash(tmpWhereKey) : '';
		let tmpAggWhere = null;
		if (tmpTuple)
		{
			tmpAggWhere = libLowering.combineNodes('And', tmpWhereItems);
		}
		else if (tmpWhereHash)
		{
			// One lowering per distinct W_def: facets sharing it share the FoldPred (the cube's w flag).
			if (!tmpState.WhereMemo.has(tmpWhereHash))
			{
				tmpState.WhereMemo.set(tmpWhereHash, libLowering.lowerPred(tmpBoundWhere, tmpScope, tmpEnv));
			}
			tmpAggWhere = tmpState.WhereMemo.get(tmpWhereHash);
		}

		let tmpLoweredDims = tmpDimensions.map(
			(pDimension) =>
			{
				let tmpDimensionFold = (tmpDimensions.length === 2) ? this._axisFold(pDimension, pSpec) : this._dimensionFold(pDimension, pCanonical, Object.assign({}, pSpec, { Fold: tmpFold }));
				return this._lowerDimension(pDimension, tmpDimensionFold, pSpec, tmpScope, tmpBindOptions, tmpParams, pContext, tmpFacetID);
			});
		if (tmpDimensions.length === 2)
		{
			tmpLoweredDims.forEach(
				(pDim) =>
				{
					if ([ 'Column', 'DateBucket', 'Range' ].indexOf(pDim.Kind) < 0)
					{
						throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', null, { Feature: 'PivotAxis', Milestone: 2 });
					}
				});
			if (tmpTuple)
			{
				throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', null, { Feature: 'TuplePivotPivot', Milestone: 2 });
			}
		}

		let tmpKind = (tmpDimensions.length === 2) ? 'Pivot' : tmpFold;
		let tmpFirst = tmpDimensions[0];
		let tmpFirstDim = tmpLoweredDims[0];
		let tmpPathPlan = isPlainObject(tmpFirst.Path) ? tmpFirst.Path : null;
		let tmpMulti = (tmpFirstDim.Kind === 'Multi');
		let tmpBucketed = (BUCKET_FOLDS.indexOf(tmpKind) >= 0);

		// OF(f) (internal-contracts §23.5).
		let tmpOwnedFields = [];
		if ((tmpKind !== 'ChildRollup') && (tmpKind !== 'ExistsSplit') && !tmpTuple)
		{
			for (let i = 0; i < tmpDimensions.length; i++)
			{
				let tmpDimension = tmpDimensions[i];
				let tmpDim = tmpLoweredDims[i];
				if (isPlainObject(tmpDimension.Path))
				{
					tmpOwnedFields.push(`@path:${pathSignature(tmpDimension.Path)}#${(tmpDim.Kind === 'Multi') ? tmpDim.KeyField : tmpDim.Field}`);
				}
				else if (typeof(tmpDim.Field) === 'string')
				{
					tmpOwnedFields.push(tmpDim.Field);
				}
			}
		}
		let tmpDefaultFilterKey = (tmpPathPlan || tmpTuple || (tmpKind === 'ChildRollup') || (tmpKind === 'ExistsSplit')) ? tmpFacetID : ((typeof(tmpFirstDim.Field) === 'string') ? tmpFirstDim.Field : tmpFacetID);
		let tmpDefaultExclude = (tmpTuple || (tmpKind === 'ChildRollup') || (tmpKind === 'ExistsSplit') || (tmpKind === 'Pivot')) ? 'None' : 'Self';
		let tmpCanonicalExclude = ((typeof(pCanonical.Exclude) === 'string') || Array.isArray(pCanonical.Exclude)) ? pCanonical.Exclude : tmpDefaultExclude;
		let tmpExclude = ((pSpec.Exclude === null) || (typeof(pSpec.Exclude) === 'undefined')) ? tmpCanonicalExclude : pSpec.Exclude;
		let tmpTop = null;
		if (tmpKind === 'Terms')
		{
			tmpTop = (typeof(pSpec.Top) === 'number') ? pSpec.Top : ((typeof(tmpFirst.Top) === 'number') ? tmpFirst.Top : tmpLimits.DefaultTop);
			tmpTop = Math.min(tmpTop, tmpLimits.MaxTop);
		}
		else if (tmpKind === 'Pivot')
		{
			tmpTop = (typeof(pSpec.Top) === 'number') ? pSpec.Top : null;
		}
		let tmpCountMode = tmpTuple ? 'KeyDistinct' : (tmpMulti ? 'PivotDistinct' : 'Rows');

		let tmpAgg = tmpFoldIR.agg(
			{
				Key: pSpec.Key,
				FacetID: tmpFacetID,
				FacetIDs: [ tmpFacetID ],
				Kind: tmpKind,
				Pivot: pCanonical.Entity,
				Dimensions: tmpLoweredDims,
				Field: (tmpKind === 'Pivot') ? null : (tmpMulti ? tmpFirstDim.KeyField : ((typeof(tmpFirstDim.Field) === 'string') ? tmpFirstDim.Field : null)),
				FieldInfo: null,
				CountMode: tmpCountMode,
				Top: tmpTop,
				Order: (typeof(pSpec.Order) === 'string') ? pSpec.Order : ((typeof(tmpFirst.Order) === 'string') ? tmpFirst.Order : 'CountDesc'),
				Missing: (pSpec.Missing === false) ? false : (tmpFirst.Missing !== false),
				EmptyBuckets: (pSpec.EmptyBuckets === false) ? false : (tmpFirst.EmptyBuckets !== false),
				Chart: (pSpec.Chart === true),
				Exclude: Array.isArray(tmpExclude) ? tmpExclude.slice() : tmpExclude,
				ClauseType: (tmpKind === 'Pivot') ? null : this._clauseType(tmpKind, tmpFirstDim, tmpPathPlan, tmpTuple),
				FilterKey: ((typeof(pCanonical.FilterKey) === 'string') && (pCanonical.FilterKey.length > 0)) ? pCanonical.FilterKey : tmpDefaultFilterKey,
				Selectable: tmpBucketed || (tmpKind === 'ChildRollup') || (tmpKind === 'ExistsSplit'),
				DisplayName: pCanonical.DisplayName || pCanonical.Title || tmpFacetID.substring(tmpFacetID.indexOf('.') + 1),
				LabelLookup: ((pSpec.Labels === false) || (tmpKind !== 'Terms')) ? null : (isPlainObject(tmpFirst.LabelLookup) ? tmpFirst.LabelLookup : null),
				Origin: pCanonical.Origin,
				Definition: (pCanonical.Origin === 'PathAuto') ? null :
					{
						Facet: tmpFacetID,
						Version: pCanonical.Version,
						DefinitionHash: pCanonical.DefinitionHash || null,
						FoldHash: pCanonical.FoldHash || null,
						SiblingOf: (typeof(pCanonical.SiblingOf) === 'string') ? pCanonical.SiblingOf : null
					},
				Where: tmpAggWhere,
				WhereHash: tmpWhereHash,
				Tuple: tmpAggTuple,
				MultiValued: tmpMulti,
				Relaxed: (pCanonical.Relaxed === true),
				Semantics: (typeof(pCanonical.Semantics) === 'string') ? pCanonical.Semantics : null,
				Path: tmpPathPlan ? pathRaw(tmpPathPlan) : ((tmpKind === 'ChildRollup') && isPlainObject(tmpFirst.Child) ? pathRaw(tmpFirst.Child.Path) : null),
				OwnedFields: uniqueSorted(tmpOwnedFields)
			});
		if (tmpKind === 'Pivot')
		{
			tmpAgg.Path = null;
		}
		tmpAgg.Entities = this._aggEntities(tmpAgg);
		return tmpAgg;
	}

	/**
	 * The fold of one axis of a declared 2-D facet (Terms / DateHistogram / Ranges map to the M1
	 * axis kinds; a NumericHistogram axis is refused like an auto numeric axis).
	 *
	 * @param {Record<string, any>} pDimension
	 * @param {Record<string, any>} pSpec
	 * @return {string}
	 */
	_axisFold(pDimension, pSpec)
	{
		if ([ 'Terms', 'DateHistogram', 'Ranges' ].indexOf(pDimension.Kind) < 0)
		{
			throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', null, { Feature: 'PivotAxis', Milestone: 2 });
		}
		return pDimension.Kind;
	}

	/**
	 * Every entity an Agg reads (the pivot / tuple sides and every Rel).
	 *
	 * @param {Record<string, any>} pAgg
	 * @return {Array<string>}
	 */
	_aggEntities(pAgg)
	{
		return uniqueSorted([ pAgg.Pivot ].concat(libRetoldFacetingFoldIR.relationsOf(pAgg).map((pRel) => { return pRel.Entity; })));
	}

	/**
	 * Lower a TuplePivot (internal-contracts §24.4): the Home side is SQL alias 'p', other sides
	 * 'u<n>'; each side's Where splits col → the side Rel, path → the Agg Where (at that side).
	 *
	 * @param {Record<string, any>} pPivot - canonical { Kind: 'Tuple', Sides, On, Key, Home }
	 * @param {Record<string, any>} pCanonical
	 * @param {Record<string, any>} pParams
	 * @param {Record<string, any>} pContext
	 * @return {{ Tuple: Record<string, any>, Scope: Record<string, any>, BindOptions: Record<string, any>, WhereItems: Array<any>, BoundPivot: Record<string, any> }}
	 */
	_lowerTuple(pPivot, pCanonical, pParams, pContext)
	{
		let tmpState = this._state(pContext);
		let tmpEnv = tmpState.Env;
		let tmpSides = Array.isArray(pPivot.Sides) ? pPivot.Sides : [];
		let tmpHome = (typeof(pPivot.Home) === 'string') ? pPivot.Home : null;
		let tmpNames = {};
		let tmpSideEntities = {};
		let tmpHomeSeen = false;
		for (let i = 0; i < tmpSides.length; i++)
		{
			let tmpSide = tmpSides[i];
			tmpSideEntities[tmpSide.Name] = tmpSide.Entity;
			if (!tmpHomeSeen && (((tmpHome !== null) && (tmpSide.Name === tmpHome)) || ((tmpHome === null) && (tmpSide.Entity === pCanonical.Entity))))
			{
				tmpNames[tmpSide.Name] = 'p';
				tmpHomeSeen = true;
			}
		}
		if (!tmpHomeSeen || (tmpSideEntities[Object.keys(tmpNames)[0]] !== pCanonical.Entity))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A TuplePivot has no Home side on the route entity.');
		}
		for (let i = 0; i < tmpSides.length; i++)
		{
			if (!hasOwn(tmpNames, tmpSides[i].Name))
			{
				tmpNames[tmpSides[i].Name] = tmpEnv.Counter.next('u');
			}
		}
		let tmpOwner = (typeof(pCanonical.SiblingOf) === 'string') ? pCanonical.SiblingOf : pCanonical.Facet;
		let tmpBindOptions = { Entity: pCanonical.Entity, Sides: tmpSideEntities, Owner: tmpOwner, OwnerKind: 'Facet' };
		let tmpScope = { Alias: 'p', Entity: pCanonical.Entity, Prefix: 'j', Names: tmpNames, SideEntities: tmpSideEntities };
		let tmpWhereItems = [];
		let tmpBoundSides = [];
		let tmpTupleSides = tmpSides.map(
			(pSide) =>
			{
				let tmpAlias = tmpNames[pSide.Name];
				let tmpBound = this._binder().bind(pSide.Where || null, pContext.Bind, pParams, Object.assign({}, tmpBindOptions, { Entity: pSide.Entity }));
				tmpBoundSides.push({ Name: pSide.Name, Entity: pSide.Entity, Where: tmpBound });
				let tmpSplit = libLowering.splitWhere(tmpBound);
				let tmpSideScope = { Alias: tmpAlias, Entity: pSide.Entity, Prefix: 'j', Names: tmpNames, SideEntities: tmpSideEntities };
				tmpSplit.Path.forEach((pItem) => { tmpWhereItems.push(libLowering.lowerPred(pItem, tmpSideScope, tmpEnv)); });
				return (
					{
						Name: pSide.Name,
						Alias: tmpAlias,
						Rel: libRetoldFacetingFoldIR.newRel({ Entity: pSide.Entity, As: tmpAlias, Role: 'TupleSide', Where: tmpSplit.Col, Client: (tmpAlias === 'p') ? [] : null })
					});
			});
		let fRef = (pRef) =>
		{
			if (!isPlainObject(pRef) || !hasOwn(tmpNames, pRef.Name) || (typeof(pRef.Field) !== 'string'))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'A TuplePivot names an unknown side.');
			}
			return { Alias: tmpNames[pRef.Name], Field: pRef.Field };
		};
		let tmpTupleOn = (Array.isArray(pPivot.On) ? pPivot.On : []).map((pPair) => { return { Left: fRef(pPair.Left), Right: fRef(pPair.Right) }; });
		// Connectivity order: the Home side ('p') first, then each side as soon as an On pair links it
		// to a side already placed, so every engine joins each later side to an earlier one whatever
		// order the definition declared them in (the registry proved every side reachable).
		let tmpOrdered = tmpTupleSides.filter((pSide) => { return pSide.Alias === 'p'; });
		let tmpPending = tmpTupleSides.filter((pSide) => { return pSide.Alias !== 'p'; });
		while (tmpPending.length > 0)
		{
			let tmpPlaced = tmpOrdered.map((pSide) => { return pSide.Alias; });
			let tmpNext = tmpPending.findIndex(
				(pSide) =>
				{
					return tmpTupleOn.some((pPair) =>
					{
						return ((pPair.Left.Alias === pSide.Alias) && (tmpPlaced.indexOf(pPair.Right.Alias) >= 0))
							|| ((pPair.Right.Alias === pSide.Alias) && (tmpPlaced.indexOf(pPair.Left.Alias) >= 0));
					});
				});
			if (tmpNext < 0)
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'A TuplePivot side is not joined to the Home side.');
			}
			tmpOrdered.push(tmpPending.splice(tmpNext, 1)[0]);
		}
		let tmpTuple =
			{
				Sides: tmpOrdered,
				On: tmpTupleOn,
				Key: (Array.isArray(pPivot.Key) ? pPivot.Key : []).map(fRef),
				Names: tmpNames
			};
		if ((tmpTuple.On.length < 1) || (tmpTuple.Key.length < 1))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A TuplePivot needs On and Key.');
		}
		return (
			{
				Tuple: tmpTuple,
				Scope: tmpScope,
				BindOptions: tmpBindOptions,
				WhereItems: tmpWhereItems,
				BoundPivot: { Sides: tmpBoundSides, On: pPivot.On, Key: pPivot.Key, Home: tmpHome }
			});
	}

	/**
	 * A 2-D Pivot request whose axes include a PathAuto facet (K14 with Via axes).  Declared
	 * facets cannot be request pivot axes (a declared 2-D facet is the way to pivot declared dims).
	 *
	 * @param {Record<string, any>} pSpec
	 * @param {Array<Record<string, any>>} pResolved
	 * @param {Record<string, any>} pContext
	 * @return {Record<string, any>} Agg
	 */
	_lowerPivot(pSpec, pResolved, pContext)
	{
		let tmpFoldIR = this.fable.RetoldFacetingFoldIR;
		let tmpState = this._state(pContext);
		if (pResolved.length !== 2)
		{
			throw libFacetErrors.create('FACET_REQUEST_INVALID', 'A Pivot takes exactly two FacetIDs.', { Field: 'Facet', Key: pSpec.Key, Reason: 'PivotDimensions' });
		}
		if ((typeof(pSpec.Fold) === 'string') && (pSpec.Fold !== 'Pivot'))
		{
			throw libFacetErrors.create('FACET_REQUEST_INVALID', 'An array of FacetIDs requires Fold: Pivot.', { Field: 'Facet', Key: pSpec.Key, Reason: 'FacetArrayNeedsPivot' });
		}
		let tmpOwnedFields = [];
		let tmpDimensions = pResolved.map(
			(pItem) =>
			{
				if (!this.isCanonical(pItem))
				{
					let tmpAxis = tmpFoldIR.pivotAxisFor(pItem, pSpec);
					tmpOwnedFields.push(tmpAxis.Field);
					return tmpAxis;
				}
				if (pItem.Origin !== 'PathAuto')
				{
					throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', null, { Feature: 'DeclaredPivotAxis', Milestone: 2 });
				}
				let tmpGate = this._canonicalEntities(pItem);
				for (let i = 0; i < tmpGate.length; i++)
				{
					if (!tmpState.CanFacet(tmpGate[i]))
					{
						throw libFacetErrors.create('FACET_FORBIDDEN');
					}
				}
				let tmpDimension = pItem.Dimensions[0];
				let tmpTyping = this._typing(tmpDimension, tmpDimension.Path.To, tmpDimension.Field);
				let tmpAxis = tmpFoldIR.pivotAxisFor(
					{
						Facet: pItem.Facet, Field: tmpDimension.Field, DataType: tmpTyping.DataType, IsInteger: tmpTyping.IsInteger, Scale: tmpTyping.Scale,
						Folds: Array.isArray(pItem.Folds) ? pItem.Folds : [ pItem.Fold ], DefaultFold: pItem.Fold || tmpDimension.Kind,
						Intervals: libFacetRequest.INTERVALS, DefaultInterval: tmpDimension.Interval || this.options.Time.DefaultInterval
					}, pSpec);
				let tmpBound = this._bindPath(tmpDimension.Path, null, null, { Entity: pContext.Entity, Owner: pItem.Facet, OwnerKind: 'Facet' }, {}, pContext);
				tmpAxis.Alias = 'p';
				tmpAxis.Via = libLowering.lowerVia(tmpBound.Path, 'p', tmpState.Env);
				tmpOwnedFields.push(`@path:${pathSignature(tmpDimension.Path)}#${tmpDimension.Field}`);
				return tmpAxis;
			});
		let tmpExclude = ((pSpec.Exclude === null) || (typeof(pSpec.Exclude) === 'undefined')) ? 'None' : pSpec.Exclude;
		let tmpAgg = tmpFoldIR.agg(
			{
				Key: pSpec.Key,
				FacetID: pResolved.map((pItem) => { return pItem.Facet; }).join('|'),
				FacetIDs: pResolved.map((pItem) => { return pItem.Facet; }),
				Kind: 'Pivot',
				Pivot: pContext.Entity,
				Dimensions: tmpDimensions,
				Field: null,
				FieldInfo: null,
				Top: (typeof(pSpec.Top) === 'number') ? pSpec.Top : null,
				Order: (typeof(pSpec.Order) === 'string') ? pSpec.Order : 'CountDesc',
				Missing: (pSpec.Missing !== false),
				EmptyBuckets: (pSpec.EmptyBuckets !== false),
				Chart: (pSpec.Chart === true),
				Exclude: Array.isArray(tmpExclude) ? tmpExclude.slice() : tmpExclude,
				ClauseType: null,
				FilterKey: null,
				Selectable: false,
				DisplayName: pResolved.map((pItem) => { return pItem.DisplayName || pItem.Facet; }).join(' × '),
				Origin: 'PathAuto',
				OwnedFields: uniqueSorted(tmpOwnedFields)
			});
		tmpAgg.Entities = this._aggEntities(tmpAgg);
		return tmpAgg;
	}

	/**
	 * Lower a BOUND predicate at a scope (public form of the lowering, internal-contracts §24.11).
	 *
	 * @param {any} pBoundPred
	 * @param {{ Alias: string, Entity: string, Prefix?: string, Names?: Record<string, string>, SideEntities?: Record<string, string> }} pScope
	 * @param {any} [pAliasCounter] - Lowering.AliasCounter (a fresh one when omitted)
	 * @return {Record<string, any>|null} FoldPred
	 */
	lowerPred(pBoundPred, pScope, pAliasCounter)
	{
		let tmpScope = isPlainObject(pScope) ? pScope : {};
		let tmpEnv =
			{
				Catalog: this.fable.RetoldFacetingCatalog,
				Graph: this.fable.RetoldFacetingGraph,
				Counter: (pAliasCounter && (typeof(pAliasCounter.next) === 'function')) ? pAliasCounter : libLowering.newAliasCounter(),
				Memo: new Map()
			};
		let tmpLowered = libLowering.lowerPred(pBoundPred,
			{
				Alias: (typeof(tmpScope.Alias) === 'string') ? tmpScope.Alias : 'p',
				Entity: tmpScope.Entity,
				Prefix: (typeof(tmpScope.Prefix) === 'string') ? tmpScope.Prefix : 'h',
				Names: tmpScope.Names || null,
				SideEntities: tmpScope.SideEntities || null
			}, tmpEnv);
		// The tree is self-contained: its own Rels are projected from it (the scope alias is not a Rel here).
		libLowering.assignProjects(tmpLowered, tmpEnv, null, { SkipAliases: [ tmpScope.Alias || 'p' ] });
		return tmpLowered;
	}

	// ------------------------------------------------------------ Cube (internal-contracts §25)

	/**
	 * Is an Agg a cube member (internal-contracts §25.1)?
	 *
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pVariant
	 * @param {Record<string, any>} pConjunctsById
	 * @param {string} pEntity
	 * @return {boolean}
	 */
	cubeEligible(pAgg, pVariant, pConjunctsById, pEntity)
	{
		if (!pAgg || pAgg.Tuple || pAgg.MultiValued || (CUBE_KINDS.indexOf(pAgg.Kind) < 0) || (pAgg.Pivot !== pEntity) || !pVariant)
		{
			return false;
		}
		if ((CUBE_MEASURE_KINDS.indexOf(pAgg.Kind) >= 0) && ((typeof(pAgg.Field) !== 'string') || (pAgg.Field.length < 1)))
		{
			return false;
		}
		let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
		for (let i = 0; i < tmpDimensions.length; i++)
		{
			let tmpDim = tmpDimensions[i];
			if (CUBE_DIMENSION_KINDS.indexOf(tmpDim.Kind) < 0)
			{
				return false;
			}
			if ((tmpDim.Kind === 'NumericBucket') && (tmpDim.Mode !== 'Edges'))
			{
				return false;
			}
		}
		if (pVariant.IncludesDeleted)
		{
			return false;
		}
		let tmpExcluded = Array.isArray(pVariant.ExcludedIds) ? pVariant.ExcludedIds : [];
		for (let i = 0; i < tmpExcluded.length; i++)
		{
			if (pConjunctsById[tmpExcluded[i]] && pConjunctsById[tmpExcluded[i]].NamesDeleted)
			{
				return false;
			}
		}
		return true;
	}

	/**
	 * The conditional disjunctive scan (01 §8.4, internal-contracts §25.2): every cube-eligible Agg
	 * of the route pivot as one CubePlan when PlanForm.Cube is 'Always' (≥ 1 member) or 'Auto' (≥ 2
	 * members).  Each member keeps its full per-Variant form and gets CubeId.
	 *
	 * CubePlan additions for the executor (additive to §25.2): each Flag carries Shape and, for a
	 * Path conjunct, its lowered Pred; CommonColumn / CommonPath list the Common conjuncts by shape,
	 * CommonPathPred is the And of the Common Path conjuncts' lowered Preds, and ConjunctPreds maps
	 * every Path conjunct Id to its lowered FoldPred (the plan's Lowered map).
	 *
	 * @param {Array<Record<string, any>>} pAggs
	 * @param {Record<string, any>} pVariants
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} [pState]
	 * @return {Array<Record<string, any>>} CubePlans
	 */
	cubes(pAggs, pVariants, pContext, pState)
	{
		let tmpOptions = this._options(pContext);
		let tmpPlanForm = (pContext && isPlainObject(pContext.PlanForm)) ? pContext.PlanForm : {};
		let tmpForm = ([ 'Auto', 'Always', 'Never' ].indexOf(tmpPlanForm.Cube) >= 0) ? tmpPlanForm.Cube
			: ((tmpOptions.Execution && ([ 'Auto', 'Always', 'Never' ].indexOf(tmpOptions.Execution.Cube) >= 0)) ? tmpOptions.Execution.Cube : 'Auto');
		if (tmpForm === 'Never')
		{
			return [];
		}
		let tmpConjuncts = (pContext && pContext.FilterAST && Array.isArray(pContext.FilterAST.Conjuncts)) ? pContext.FilterAST.Conjuncts : [];
		let tmpConjunctsById = {};
		tmpConjuncts.forEach((pConjunct) => { tmpConjunctsById[pConjunct.Id] = pConjunct; });
		let tmpMembers = (Array.isArray(pAggs) ? pAggs : []).filter((pAgg) => { return this.cubeEligible(pAgg, pVariants[pAgg.VariantId], tmpConjunctsById, pContext.Entity); });
		if (((tmpForm === 'Always') && (tmpMembers.length < 1)) || ((tmpForm === 'Auto') && (tmpMembers.length < 2)))
		{
			return [];
		}
		let tmpLowered = (pState && isPlainObject(pState.Lowered)) ? pState.Lowered : {};
		let tmpAST = this.fable.RetoldFacetingFilterAST;
		let fIsPath = (pConjunct) => { return (tmpAST && (typeof(tmpAST.isPathConjunct) === 'function')) ? tmpAST.isPathConjunct(pConjunct) : (pConjunct.Shape === 'Path'); };

		// Flags: every conjunct some member excludes, in conjunct order.
		let tmpExcludedByAny = new Set();
		tmpMembers.forEach((pAgg) => { (pVariants[pAgg.VariantId].ExcludedIds || []).forEach((pId) => { tmpExcludedByAny.add(pId); }); });
		let tmpFlags = [];
		let tmpFlagByConjunct = {};
		let tmpCommon = [];
		tmpConjuncts.forEach(
			(pConjunct) =>
			{
				if (!tmpExcludedByAny.has(pConjunct.Id))
				{
					tmpCommon.push(pConjunct.Id);
					return;
				}
				let tmpFlag = `b${tmpFlags.length + 1}`;
				let tmpPath = fIsPath(pConjunct);
				tmpFlags.push({ Flag: tmpFlag, ConjunctId: pConjunct.Id, Shape: tmpPath ? 'Path' : 'Column', Pred: tmpPath ? (tmpLowered[pConjunct.Id] || null) : null });
				tmpFlagByConjunct[pConjunct.Id] = tmpFlag;
			});

		// W_def flags: one per distinct non-empty member WhereHash.
		let tmpWhereFlags = [];
		let tmpWhereFlagByHash = {};
		tmpMembers.forEach(
			(pAgg) =>
			{
				if ((typeof(pAgg.WhereHash) === 'string') && (pAgg.WhereHash.length > 0) && !hasOwn(tmpWhereFlagByHash, pAgg.WhereHash))
				{
					let tmpFlag = `w${tmpWhereFlags.length + 1}`;
					tmpWhereFlags.push({ Flag: tmpFlag, WhereHash: pAgg.WhereHash, Where: pAgg.Where });
					tmpWhereFlagByHash[pAgg.WhereHash] = tmpFlag;
				}
			});

		// Dims, de-duplicated by canonical JSON; DateHistogram bounds per date column.
		let tmpDims = [];
		let tmpDimByKey = new Map();
		let tmpBounds = [];
		let tmpBoundsByColumn = {};
		// Measures (Stats / Missing): one per distinct (Kind, Field), de-duplicated like Dims.
		let tmpMeasures = [];
		let tmpMeasureByKey = new Map();
		let tmpMemberPlans = tmpMembers.map(
			(pAgg) =>
			{
				let tmpMeasureColumn = null;
				if (CUBE_MEASURE_KINDS.indexOf(pAgg.Kind) >= 0)
				{
					let tmpInfo = isPlainObject(pAgg.FieldInfo) ? pAgg.FieldInfo : {};
					let tmpMeasureKey = `${pAgg.Kind}|${pAgg.Field}`;
					if (!tmpMeasureByKey.has(tmpMeasureKey))
					{
						let tmpMeasure = { Column: `m${tmpMeasures.length + 1}`, Kind: pAgg.Kind, Field: pAgg.Field, DataType: tmpInfo.DataType || null, Scale: (typeof(tmpInfo.Scale) === 'number') ? tmpInfo.Scale : 0, Members: [] };
						tmpMeasures.push(tmpMeasure);
						tmpMeasureByKey.set(tmpMeasureKey, tmpMeasure);
					}
					let tmpMeasure = tmpMeasureByKey.get(tmpMeasureKey);
					tmpMeasure.Members.push(pAgg.Key);
					tmpMeasureColumn = tmpMeasure.Column;
				}
				let tmpColumns = (Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : []).map(
					(pDim) =>
					{
						let tmpKey = libFacetClauses.canonicalJSON(pDim);
						if (!tmpDimByKey.has(tmpKey))
						{
							let tmpEntry = { Column: `d${tmpDims.length + 1}`, Dim: pDim, Members: [] };
							tmpDims.push(tmpEntry);
							tmpDimByKey.set(tmpKey, tmpEntry);
						}
						let tmpEntry = tmpDimByKey.get(tmpKey);
						if (tmpEntry.Members.indexOf(pAgg.Key) < 0)
						{
							tmpEntry.Members.push(pAgg.Key);
						}
						return tmpEntry.Column;
					});
				if ((pAgg.Kind === 'DateHistogram') && (tmpColumns.length === 1) && !hasOwn(tmpBoundsByColumn, tmpColumns[0]))
				{
					let tmpIndex = tmpBounds.length + 1;
					let tmpBound = { Lo: `lo${tmpIndex}`, Hi: `hi${tmpIndex}`, Dim: tmpColumns[0] };
					tmpBounds.push(tmpBound);
					tmpBoundsByColumn[tmpColumns[0]] = tmpBound;
				}
				let tmpExcluded = new Set(pVariants[pAgg.VariantId].ExcludedIds || []);
				let tmpMemberPlan =
					{
						AggKey: pAgg.Key,
						Dims: tmpColumns,
						RequireFlags: tmpFlags.filter((pFlag) => { return !tmpExcluded.has(pFlag.ConjunctId); }).map((pFlag) => { return pFlag.Flag; }),
						RequireWhere: ((typeof(pAgg.WhereHash) === 'string') && (pAgg.WhereHash.length > 0)) ? tmpWhereFlagByHash[pAgg.WhereHash] : null
					};
				if (tmpMeasureColumn)
				{
					tmpMemberPlan.Measure = tmpMeasureColumn;
				}
				return tmpMemberPlan;
			});
		let tmpCommonPath = tmpCommon.filter((pId) => { return fIsPath(tmpConjunctsById[pId]); });
		let tmpConjunctPreds = {};
		tmpConjuncts.forEach((pConjunct) => { if (hasOwn(tmpLowered, pConjunct.Id)) { tmpConjunctPreds[pConjunct.Id] = tmpLowered[pConjunct.Id]; } });
		let tmpCubePlan =
			{
				CubeId: 'cube0',
				Pivot: pContext.Entity,
				Flags: tmpFlags,
				Common: tmpCommon,
				CommonColumn: tmpCommon.filter((pId) => { return !fIsPath(tmpConjunctsById[pId]); }),
				CommonPath: tmpCommonPath,
				CommonPathPred: libLowering.combineNodes('And', tmpCommonPath.map((pId) => { return tmpLowered[pId]; })),
				ConjunctPreds: tmpConjunctPreds,
				WhereFlags: tmpWhereFlags,
				Dims: tmpDims,
				Bounds: tmpBounds,
				Measures: tmpMeasures,
				Members: tmpMemberPlans,
				MaxGroups: tmpOptions.Limits.CubeMaxGroups
			};
		tmpMembers.forEach((pAgg) => { pAgg.CubeId = tmpCubePlan.CubeId; });
		return [ tmpCubePlan ];
	}

	// ------------------------------------------------------------ Records / Count / Keys

	/**
	 * The base plan of Records / Count / Keys (internal-contracts §24.11, §28.3): the full filter
	 * (v0) with its PathPred lowered, the DepSet (plus the Records sort fields), the entities it
	 * reads and BindHash.  Sets pContext.Variants = { v0 } (a Query body with Records reuses the v0
	 * plan() already built for the request, so both share one lowering and pContext.Variants stays).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {(pError?: Error, pBasePlan?: { Variant: Record<string, any>, Pivot: string, DepSet: Record<string, Array<string>>, Entities: Array<string>, BindHash: string, Lowered: Record<string, any> }) => void} fCallback
	 */
	planBase(pContext, fCallback)
	{
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		let tmpFoldIR = this.fable.RetoldFacetingFoldIR;
		let tmpDisjunctivePlanner = this.fable.RetoldFacetingDisjunctivePlanner;
		let tmpFilterAST = pContext ? pContext.FilterAST : null;
		if (!tmpCatalog || !tmpFoldIR || !tmpDisjunctivePlanner || !tmpFilterAST)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The planner is not wired.'));
		}
		let tmpState;
		let tmpVariant;
		try
		{
			tmpState = this._state(pContext);
			this._lowerConjuncts(pContext, tmpState);
			if (isPlainObject(pContext.Variants) && isPlainObject(pContext.Variants.v0) && (pContext.Variants.v0.Entity === pContext.Entity))
			{
				// A Query body with Records: plan() already built (and lowered) v0 for this request.
				tmpVariant = pContext.Variants.v0;
			}
			else
			{
				tmpVariant = tmpDisjunctivePlanner.variants(tmpFilterAST, []).Variants.v0;
				pContext.Variants = { v0: tmpVariant };
			}
		}
		catch (pError)
		{
			return fCallback(this._requestError(pContext, pError));
		}
		this._fillVariant(tmpVariant, tmpState);
		libLowering.assignProjects([ tmpVariant ], tmpState.Env);
		tmpVariant.Relations = libLowering.relationListing(tmpVariant);

		let tmpBaseAgg = tmpFoldIR.agg({ Key: TOTAL_KEY, Kind: 'Count', Pivot: pContext.Entity, Exclude: 'None', VariantId: 'v0' });
		let tmpDepSet = tmpFoldIR.depSet(tmpBaseAgg, tmpVariant, tmpCatalog);
		let tmpRecords = (pContext.NormalizedRequest && isPlainObject(pContext.NormalizedRequest.Records)) ? pContext.NormalizedRequest.Records : null;
		if (tmpRecords && Array.isArray(tmpRecords.Sort))
		{
			let tmpPivotColumns = tmpDepSet[pContext.Entity] || [];
			tmpRecords.Sort.forEach((pSort) => { if (pSort && (typeof(pSort.Field) === 'string') && (tmpPivotColumns.indexOf(pSort.Field) < 0)) { tmpPivotColumns.push(pSort.Field); } });
			tmpDepSet[pContext.Entity] = tmpPivotColumns.sort();
		}
		let tmpEntities = uniqueSorted([ pContext.Entity ].concat(Array.isArray(tmpFilterAST.Entities) ? tmpFilterAST.Entities : [], tmpVariant.Relations.map((pRel) => { return pRel.Entity; })));
		let tmpBinder = this.fable.RetoldFacetingBinder;
		return fCallback(null,
			{
				Variant: tmpVariant,
				Pivot: pContext.Entity,
				DepSet: tmpDepSet,
				Entities: tmpEntities,
				BindHash: tmpBinder ? tmpBinder.bindHash(pContext.Bind) : null,
				Lowered: tmpState.Lowered
			});
	}

	/**
	 * The request-level DepSet: the union of every Agg's DepSet.
	 *
	 * @param {Array<Record<string, any>>} pAggs
	 * @return {Record<string, Array<string>>}
	 */
	depSet(pAggs)
	{
		let tmpUnion = {};
		let tmpAggs = Array.isArray(pAggs) ? pAggs : [];
		for (let i = 0; i < tmpAggs.length; i++)
		{
			let tmpDepSet = tmpAggs[i].DepSet || {};
			let tmpEntities = Object.keys(tmpDepSet);
			for (let j = 0; j < tmpEntities.length; j++)
			{
				let tmpColumns = tmpUnion[tmpEntities[j]] || {};
				for (let k = 0; k < tmpDepSet[tmpEntities[j]].length; k++)
				{
					tmpColumns[tmpDepSet[tmpEntities[j]][k]] = true;
				}
				tmpUnion[tmpEntities[j]] = tmpColumns;
			}
		}
		let tmpResult = {};
		let tmpEntities = Object.keys(tmpUnion);
		for (let i = 0; i < tmpEntities.length; i++)
		{
			tmpResult[tmpEntities[i]] = Object.keys(tmpUnion[tmpEntities[i]]).sort();
		}
		return tmpResult;
	}
}

module.exports = RetoldFacetingPlanner;
module.exports.serviceType = 'RetoldFacetingPlanner';
module.exports.TOTAL_KEY = TOTAL_KEY;
module.exports.CUBE_KINDS = CUBE_KINDS;
module.exports.CUBE_DIMENSION_KINDS = CUBE_DIMENSION_KINDS;
