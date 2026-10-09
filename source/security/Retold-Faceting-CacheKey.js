/**
 * Retold Faceting - Cache Key
 *
 * Everything the result cache and the generation Version need to know about one Query, decided
 * BEFORE anything executes (design 06 §7, 05 §6.1):
 *
 *   depSet()        the cache DepSet: the plan's DepSet (pivot and every hop), the readable label
 *                   targets, '#cols' on the pivot when Records were asked for, and the entities read
 *                   through a TenantOnly Rel;
 *   captureScopes() one scope probe per DepSet entity, as this principal (the entity's own
 *                   Reads-QueryConfiguration + ScopeGuard on a scratch context; never an error);
 *   cacheability()  the pre-execution Bypass reasons (incl. 'NoChangeSource': a DepSet entity whose
 *                   writes no change source sees; 'ModelReload': the model changed since newContext);
 *   key()           sha256 of { Instance, Boot, Model, EngineClass, Entity, Mode, Request, Client,
 *                   Applied, Scope (probe fingerprints + what they appended + the guard's required
 *                   values), Bind, Gate, PlanForm, PinnedNow } — never a SessionID, a header or the
 *                   request object;
 *   dependencies()  the (Entity, TenantKeys, Columns) the GenVector reads;
 *   version()       'fv1:' + 16 hex of sha256(Key | GenVector hash);
 *   scopeDrift()    after execution: did any scope capture of the execution append something the
 *                   probe of its entity did not (the key would name a scope the answer was not
 *                   computed under → Bypass 'ScopeChanged', never stored, never shared)?
 *
 * Two principals share a key iff their captured scopes, bound values and role sets are equal: same-
 * tenant users share answers over tenant-only entities; a $CurrentUser binding, an owner-scoped
 * entity or a tenant switch under one session splits it (06 §7).
 *
 * Contract: internal-contracts §42 (DepSet §42.1, probes §42.2, cacheability §42.3, material §42.4,
 * dependencies §42.5, Version §42.6, API §42.7).  Owner: builder A (M4).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libCrypto = require('crypto');

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetClauses = require('../contract/Facet-Contract-Clauses.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

// The version of the key material (internal-contracts §42.4).
const KEY_VERSION = 1;

// Every reason an answer is not cached (internal-contracts §42.3): pre-execution, then post-execution.
const UNCACHEABLE_REASONS = Object.freeze(
	[
		'Mode', 'ForceEngine', 'PlanErrors', 'NoChangeSource', 'ModelReload', 'TooManyEntities', 'ProbeError', 'Opaque', 'RecordsPostOperation', 'NotCacheable',
		'Errors', 'Staged', 'ScopeChanged', 'TooLarge'
	]);

// The probe reasons, in the precedence cacheability() reports them.
const PROBE_REASONS = Object.freeze([ 'TooManyEntities', 'ProbeError', 'Opaque', 'NotCacheable' ]);

// Pseudo-columns of a DepSet (internal-contracts §41.1 / §42.1).
const ROW = '#row';
const ALL = '#all';
const COLS = '#cols';

// Fold tenant keys when no Generations service is registered: '#any' and '*' are bumped by every
// write of an entity, so nothing is ever reported fresh that is not.
const FALLBACK_TENANT_KEYS = Object.freeze([ '#any', '*' ]);

const hasOwn = libRetoldFacetingUtil.hasOwn;
const isPlainObject = libRetoldFacetingUtil.isPlainObject;
const canonicalJSON = libFacetClauses.canonicalJSON;

/**
 * Is this DepSet column a real (model) column, not a pseudo-column ('#cols') or a signature ('@…')?
 *
 * @param {any} pColumn
 * @return {boolean}
 */
const isRealColumn = (pColumn) =>
{
	return (typeof(pColumn) === 'string') && (pColumn.length > 0) && (pColumn.charAt(0) !== '#') && (pColumn.charAt(0) !== '@');
};

/**
 * sha256 hex of a string.
 *
 * @param {string} pText
 * @return {string}
 */
const sha256 = (pText) =>
{
	return libCrypto.createHash('sha256').update(pText, 'utf8').digest('hex');
};

class RetoldFacetingCacheKey extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingCacheKey';

		// Entities already warned about (appended scope filters on a host without a policy, S4).
		this._UnpolicedWarned = new Set();
	}

	/**
	 * The options of a request (the context's, else this service's).
	 *
	 * @param {Record<string, any>} pContext
	 * @return {Record<string, any>}
	 */
	_options(pContext)
	{
		return (pContext && isPlainObject(pContext.Options)) ? pContext.Options : this.options;
	}

	/**
	 * Add the structural columns of an entity (primary key, delete column, policy columns) to a
	 * column set, from its catalog descriptor.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, boolean>} pColumns
	 */
	_addStructural(pEntity, pColumns)
	{
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		let tmpDescriptor = (tmpCatalog && (typeof(tmpCatalog.getFacetable) === 'function')) ? tmpCatalog.getFacetable(pEntity) : null;
		if (!tmpDescriptor)
		{
			return;
		}
		[ tmpDescriptor.PK, tmpDescriptor.DeleteColumn ].forEach((pColumn) => { if (isRealColumn(pColumn)) { pColumns[pColumn] = true; } });
		let tmpColumns = isPlainObject(tmpDescriptor.Columns) ? tmpDescriptor.Columns : {};
		Object.keys(tmpColumns).forEach(
			(pColumn) =>
			{
				if (tmpColumns[pColumn] && tmpColumns[pColumn].IsPolicyColumn)
				{
					pColumns[pColumn] = true;
				}
			});
	}

	/**
	 * The cache DepSet of a planned Query (internal-contracts §42.1):
	 *
	 *   Plan.DepSet (every Agg over its Rels and its Variant's PathPred)
	 *   ∪ each readable Agg.LabelLookup target { Entity: [ KeyColumn, LabelColumn, PK, delete, policy ] }
	 *   ∪ '#cols' on the pivot when the body asks for Records (hydrated records carry every column),
	 *     plus, with Records, every entity a filter conjunct reads (the Records rows are the full
	 *     filter's, whatever Variant the facets planned);
	 *   TenantOnly = the entities some Rel reads with Scope 'TenantOnly'.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPlan - Planner.plan result
	 * @return {{ DepSet: Record<string, Array<string>>, Entities: Array<string>, TenantOnly: Array<string>, LabelTargets: Array<string>, Records: boolean }}
	 */
	depSet(pContext, pPlan)
	{
		let tmpContext = pContext || {};
		let tmpPlan = isPlainObject(pPlan) ? pPlan : {};
		let tmpSets = {};
		let fAdd = (pEntity, pColumn) =>
		{
			if ((typeof(pEntity) !== 'string') || (pEntity.length < 1) || (typeof(pColumn) !== 'string') || (pColumn.length < 1))
			{
				return;
			}
			if (!hasOwn(tmpSets, pEntity))
			{
				tmpSets[pEntity] = {};
			}
			tmpSets[pEntity][pColumn] = true;
		};

		let tmpPlanDepSet = isPlainObject(tmpPlan.DepSet) ? tmpPlan.DepSet : {};
		Object.keys(tmpPlanDepSet).forEach(
			(pEntity) =>
			{
				if (!hasOwn(tmpSets, pEntity))
				{
					tmpSets[pEntity] = {};
				}
				(Array.isArray(tmpPlanDepSet[pEntity]) ? tmpPlanDepSet[pEntity] : []).forEach((pColumn) => { fAdd(pEntity, pColumn); });
			});

		// Label targets: only those the principal can read (an unreadable one contributes no labels,
		// so no data and no dependency).
		let tmpAggs = Array.isArray(tmpPlan.Aggs) ? tmpPlan.Aggs : [];
		let tmpAuthorizer = this.fable.RetoldFacetingAuthorizer;
		let tmpLabelTargets = {};
		tmpAggs.forEach(
			(pAgg) =>
			{
				let tmpLookup = (pAgg && isPlainObject(pAgg.LabelLookup)) ? pAgg.LabelLookup : null;
				if (!tmpLookup || (typeof(tmpLookup.Entity) !== 'string') || (typeof(tmpLookup.LabelColumn) !== 'string'))
				{
					return;
				}
				let tmpReadable = false;
				try
				{
					tmpReadable = !!tmpAuthorizer && (tmpAuthorizer.canFacet(tmpContext, tmpLookup.Entity) === true);
				}
				catch (pGateError)
				{
					tmpReadable = false;
				}
				if (!tmpReadable)
				{
					return;
				}
				tmpLabelTargets[tmpLookup.Entity] = true;
				let tmpColumns = {};
				tmpColumns[tmpLookup.KeyColumn] = true;
				tmpColumns[tmpLookup.LabelColumn] = true;
				this._addStructural(tmpLookup.Entity, tmpColumns);
				Object.keys(tmpColumns).forEach((pColumn) => { fAdd(tmpLookup.Entity, pColumn); });
			});

		// Records: the pivot's hydrated rows carry every column ('#cols'), and they are the FULL
		// filter's rows, so every entity a conjunct reads is a dependency even when no planned Variant
		// keeps that conjunct.
		let tmpRequest = isPlainObject(tmpContext.NormalizedRequest) ? tmpContext.NormalizedRequest : {};
		let tmpRecords = isPlainObject(tmpRequest.Records);
		let tmpPivot = (typeof(tmpContext.Entity) === 'string') ? tmpContext.Entity : null;
		if (tmpRecords && tmpPivot)
		{
			fAdd(tmpPivot, COLS);
			this._addStructural(tmpPivot, tmpSets[tmpPivot]);
			let tmpFilterEntities = (tmpContext.FilterAST && Array.isArray(tmpContext.FilterAST.Entities)) ? tmpContext.FilterAST.Entities : [];
			tmpFilterEntities.forEach(
				(pEntity) =>
				{
					if ((typeof(pEntity) !== 'string') || hasOwn(tmpSets, pEntity))
					{
						return;
					}
					tmpSets[pEntity] = {};
					fAdd(pEntity, COLS);
					this._addStructural(pEntity, tmpSets[pEntity]);
				});
		}

		// TenantOnly: every Rel of every Agg and every Variant (PathPred / Where).
		let tmpTenantOnly = {};
		let tmpFoldIR = this.fable.RetoldFacetingFoldIR;
		if (tmpFoldIR && (typeof(tmpFoldIR.relations) === 'function'))
		{
			let tmpVariants = isPlainObject(tmpPlan.Variants) ? Object.keys(tmpPlan.Variants).map((pVariantId) => { return tmpPlan.Variants[pVariantId]; }) : [];
			tmpFoldIR.relations(tmpAggs.concat(tmpVariants)).forEach(
				(pRel) =>
				{
					if (pRel && (pRel.Scope === 'TenantOnly') && (typeof(pRel.Entity) === 'string'))
					{
						tmpTenantOnly[pRel.Entity] = true;
					}
				});
		}

		let tmpDepSet = {};
		Object.keys(tmpSets).sort().forEach((pEntity) => { tmpDepSet[pEntity] = Object.keys(tmpSets[pEntity]).sort(); });
		return (
			{
				DepSet: tmpDepSet,
				Entities: Object.keys(tmpDepSet),
				TenantOnly: Object.keys(tmpTenantOnly).sort(),
				LabelTargets: Object.keys(tmpLabelTargets).sort(),
				Records: tmpRecords
			});
	}

	/**
	 * One scope probe per DepSet entity (internal-contracts §42.2), in sorted order, as this
	 * principal, on a scratch context (fresh Memo and Counters: probes never touch the request's memo
	 * or its behavior budget).  Each probe is exactly a hop relation without client conjuncts: a fresh
	 * DAL query, the explicit soft delete, then ScopeCapture.capture(…, 'Inherit', { Columns }) — the
	 * entity's own Reads-QueryConfiguration on its route-bound controller, ScopeGuard and the read-side
	 * audit.  No SQL runs.  Never calls back an error: a failure (behavior 401, guard refusal, no
	 * controller), an Opaque capture or a FacetCacheable === false request state is reported in
	 * Uncacheable and the request proceeds uncached.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pDeps - depSet() result
	 * @param {(pError: null, pProbe: { Captures: Record<string, any>, Uncacheable: Array<{ Entity: string, Reason: string }>, ProbeRuns: number, ScopeRepaired: boolean }) => void} fCallback
	 */
	captureScopes(pContext, pDeps, fCallback)
	{
		let tmpContext = pContext || {};
		let tmpEntities = (pDeps && Array.isArray(pDeps.Entities)) ? pDeps.Entities.slice().sort() : [];
		let tmpDepSet = (pDeps && isPlainObject(pDeps.DepSet)) ? pDeps.DepSet : {};
		let tmpResult = { Captures: {}, Uncacheable: [], ProbeRuns: 0, ScopeRepaired: false };
		let tmpOptions = this._options(tmpContext);
		let tmpMaxRelations = (tmpOptions.Limits && Number.isSafeInteger(tmpOptions.Limits.MaxRelationsPerRequest)) ? tmpOptions.Limits.MaxRelationsPerRequest : 32;
		if (tmpEntities.length > tmpMaxRelations)
		{
			tmpResult.Uncacheable.push({ Entity: (typeof(tmpContext.Entity) === 'string') ? tmpContext.Entity : '', Reason: 'TooManyEntities' });
			return fCallback(null, tmpResult);
		}
		let tmpScopeCapture = this.fable.RetoldFacetingScopeCapture;
		let tmpHost = tmpContext.Host || null;
		let tmpScratch = Object.assign({}, tmpContext,
			{
				Memo: { Relations: {}, Captures: {}, VariantRows: {} },
				Counters: { Relations: 0, BehaviorRuns: 0, Statements: 0 },
				// Probes are not the execution: never logged as execution captures (scopeDrift).
				ScopeLog: null
			});
		let tmpPolicy = (tmpHost && (typeof(tmpHost.getScopePolicy) === 'function')) ? tmpHost.getScopePolicy() : null;
		let tmpPoliced = !!tmpPolicy && (tmpPolicy.Kind === 'Policy');

		let fUncacheable = (pEntity, pReason, pDetail) =>
		{
			tmpResult.Uncacheable.push({ Entity: pEntity, Reason: pReason });
			this.fable.log.debug(`RetoldFaceting CacheKey: ${tmpContext.RequestID || 'request'} is uncacheable: ${pReason} on ${libRetoldFacetingUtil.logSafe(pEntity)}${pDetail ? ` (${pDetail})` : ''}.`);
		};

		let tmpCalledBack = false;
		let fFinish = () =>
		{
			if (tmpCalledBack)
			{
				return;
			}
			tmpCalledBack = true;
			tmpResult.ProbeRuns = tmpScratch.Counters.BehaviorRuns || 0;
			return fCallback(null, tmpResult);
		};

		let fProbe = (pIndex) =>
		{
			if (pIndex >= tmpEntities.length)
			{
				return fFinish();
			}
			let tmpEntity = tmpEntities[pIndex];
			let tmpQuery = null;
			try
			{
				let tmpDAL = (tmpHost && (typeof(tmpHost.getExecutionDAL) === 'function')) ? tmpHost.getExecutionDAL(tmpEntity) : null;
				tmpQuery = tmpDAL ? tmpDAL.query : null;
				if (!tmpQuery || !tmpQuery.parameters || !tmpScopeCapture)
				{
					fUncacheable(tmpEntity, 'ProbeError', 'no execution DAL');
					return fProbe(pIndex + 1);
				}
				if ((typeof(tmpHost.hasDeleteColumn) === 'function') && tmpHost.hasDeleteColumn(tmpEntity))
				{
					tmpQuery.addFilter(tmpHost.getDeleteColumn(tmpEntity), 0, '=', 'AND', 'FacetSoftDelete');
				}
			}
			catch (pPrepareError)
			{
				fUncacheable(tmpEntity, 'ProbeError', 'prepare');
				return fProbe(pIndex + 1);
			}
			let tmpColumns = (Array.isArray(tmpDepSet[tmpEntity]) ? tmpDepSet[tmpEntity] : []).filter(isRealColumn);
			let tmpProbeCalledBack = false;
			let fCaptured = (pCaptureError, pCapture) =>
			{
				if (tmpProbeCalledBack)
				{
					return;
				}
				tmpProbeCalledBack = true;
				if (pCaptureError || !pCapture)
				{
					// The guard refuses an untrusted Opaque capture: report it as what it is.
					let tmpViolations = (pCaptureError && pCaptureError.Detail && Array.isArray(pCaptureError.Detail.Violations)) ? pCaptureError.Detail.Violations : [];
					let tmpOpaque = tmpViolations.some((pViolation) => { return pViolation && (pViolation.Rule === 'OpaqueUntrusted'); });
					fUncacheable(tmpEntity, tmpOpaque ? 'Opaque' : 'ProbeError', pCaptureError ? (pCaptureError.Code || 'error') : 'no capture');
					return fProbe(pIndex + 1);
				}
				tmpResult.Captures[tmpEntity] = pCapture;
				if (!tmpPoliced && Array.isArray(pCapture.Appended) && (pCapture.Appended.length > 0) && !this._UnpolicedWarned.has(tmpEntity))
				{
					// The cache key splits by what the behavior appended, but generations and the change
					// stream know tenants only through Scope.Policy (S4).
					this._UnpolicedWarned.add(tmpEntity);
					this.fable.log.warn(`RetoldFaceting CacheKey: the Reads behaviors of ${libRetoldFacetingUtil.logSafe(tmpEntity)} append scope filters but no Scope.Policy is configured: answers are keyed by those filters, yet every write invalidates (and, with SSE.Enabled true, signals) every principal's answers over it; configure Scope.Policy to isolate tenants.`);
				}
				if (pCapture.Guard && pCapture.Guard.Repaired)
				{
					tmpResult.ScopeRepaired = true;
				}
				if (pCapture.Opaque)
				{
					fUncacheable(tmpEntity, 'Opaque', (pCapture.OpaqueReasons || []).join(','));
				}
				else if (pCapture.RequestState && (pCapture.RequestState.FacetCacheable === false))
				{
					fUncacheable(tmpEntity, 'NotCacheable');
				}
				return fProbe(pIndex + 1);
			};
			try
			{
				tmpScopeCapture.capture(tmpScratch, tmpEntity, tmpQuery, 'Inherit', { Columns: tmpColumns }, fCaptured);
			}
			catch (pCaptureThrow)
			{
				if (tmpProbeCalledBack)
				{
					// Thrown by the continuation after the capture called back: it belongs to the caller.
					throw pCaptureThrow;
				}
				fCaptured(pCaptureThrow);
			}
		};
		return fProbe(0);
	}

	/**
	 * The quick pre-execution checks that need no probe (internal-contracts §42.3 / §44.3 step 1):
	 * 'Mode', 'ForceEngine', 'PlanErrors', then
	 *
	 *   'NoChangeSource'  some entity of the cache DepSet (pContext.CacheDeps) has writes no change
	 *                     source sees: no route-bound controller the interim intake wraps, and not
	 *                     declared ChangeCapture.NotifyManaged (ChangeIntake.covers; a write path
	 *                     replaced since the install is wrapped again and invalidated first);
	 *   'ModelReload'     the catalog's ModelVersion is no longer the one newContext snapshotted (the
	 *                     plan may be the old model's).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPlan
	 * @return {{ Cacheable: boolean, Reason: string|null }}
	 */
	precheck(pContext, pPlan)
	{
		let tmpContext = pContext || {};
		if (tmpContext.Mode !== 'Query')
		{
			return { Cacheable: false, Reason: 'Mode' };
		}
		if (tmpContext.ForceEngine)
		{
			return { Cacheable: false, Reason: 'ForceEngine' };
		}
		if (pPlan && isPlainObject(pPlan.Errors) && (Object.keys(pPlan.Errors).length > 0))
		{
			return { Cacheable: false, Reason: 'PlanErrors' };
		}
		let tmpIntake = this.fable.RetoldFacetingChangeIntake;
		let tmpEntities = (tmpContext.CacheDeps && Array.isArray(tmpContext.CacheDeps.Entities)) ? tmpContext.CacheDeps.Entities : [];
		if (tmpIntake && (typeof(tmpIntake.uncovered) === 'function') && (tmpIntake.uncovered(tmpEntities).length > 0))
		{
			return { Cacheable: false, Reason: 'NoChangeSource' };
		}
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		if ((typeof(tmpContext.ModelVersion) === 'string') && tmpCatalog && (typeof(tmpCatalog.modelVersion) === 'function')
			&& (tmpCatalog.modelVersion() !== tmpContext.ModelVersion))
		{
			return { Cacheable: false, Reason: 'ModelReload' };
		}
		return { Cacheable: true, Reason: null };
	}

	/**
	 * The pre-execution cacheability of a Query (internal-contracts §42.3); the first reason that
	 * applies wins: Mode, ForceEngine, PlanErrors, TooManyEntities, ProbeError, Opaque,
	 * RecordsPostOperation, NotCacheable.  Fails closed: without a probe that captured EVERY DepSet
	 * entity the answer is 'ProbeError' (a key without the scope of each entity must never be used).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPlan
	 * @param {Record<string, any>} pDeps
	 * @param {Record<string, any>} pProbe
	 * @return {{ Cacheable: boolean, Reason: string|null }}
	 */
	cacheability(pContext, pPlan, pDeps, pProbe)
	{
		let tmpPrecheck = this.precheck(pContext, pPlan);
		if (!tmpPrecheck.Cacheable)
		{
			return tmpPrecheck;
		}
		if (!isPlainObject(pProbe) || !isPlainObject(pProbe.Captures) || !isPlainObject(pDeps) || !Array.isArray(pDeps.Entities))
		{
			return { Cacheable: false, Reason: 'ProbeError' };
		}
		let tmpUncacheable = Array.isArray(pProbe.Uncacheable) ? pProbe.Uncacheable : [];
		for (let i = 0; i < PROBE_REASONS.length; i++)
		{
			if ((PROBE_REASONS[i] !== 'NotCacheable') && tmpUncacheable.some((pEntry) => { return pEntry && (pEntry.Reason === PROBE_REASONS[i]); }))
			{
				return { Cacheable: false, Reason: PROBE_REASONS[i] };
			}
		}
		for (let i = 0; i < pDeps.Entities.length; i++)
		{
			let tmpCapture = pProbe.Captures[pDeps.Entities[i]];
			if (!tmpCapture || (typeof(tmpCapture.Fingerprint) !== 'string'))
			{
				return { Cacheable: false, Reason: 'ProbeError' };
			}
			if (tmpCapture.Opaque)
			{
				return { Cacheable: false, Reason: 'Opaque' };
			}
		}
		let tmpPivot = (pContext && (typeof(pContext.Entity) === 'string')) ? pContext.Entity : null;
		let tmpPivotCapture = (tmpPivot && hasOwn(pProbe.Captures, tmpPivot)) ? pProbe.Captures[tmpPivot] : null;
		if ((pDeps.Records === true) && tmpPivotCapture && tmpPivotCapture.PostOperation)
		{
			// Hydrated records go through the read-side behaviors, whose decorations may depend on the
			// session or other tables: not cacheable, even when trusted or safe-column.
			return { Cacheable: false, Reason: 'RecordsPostOperation' };
		}
		let tmpNotCacheable = tmpUncacheable.some((pEntry) => { return pEntry && (pEntry.Reason === 'NotCacheable'); })
			|| Object.keys(pProbe.Captures).some((pEntity) => { let tmpState = pProbe.Captures[pEntity] ? pProbe.Captures[pEntity].RequestState : null; return !!tmpState && (tmpState.FacetCacheable === false); });
		if (tmpNotCacheable)
		{
			return { Cacheable: false, Reason: 'NotCacheable' };
		}
		return { Cacheable: true, Reason: null };
	}

	/**
	 * The request part of the key material: the NormalizedRequest minus the raw Clauses /
	 * FilterString (their compiled conjuncts are the Client part), Freshness and TimeoutMS.
	 *
	 * @param {Record<string, any>} pContext
	 * @return {Record<string, any>}
	 */
	_requestMaterial(pContext)
	{
		let tmpRequest = (pContext && isPlainObject(pContext.NormalizedRequest)) ? pContext.NormalizedRequest : {};
		return (
			{
				Facets: Array.isArray(tmpRequest.Facets) ? tmpRequest.Facets : [],
				Total: (tmpRequest.Total !== false),
				Scopes: Array.isArray(tmpRequest.Scopes) ? tmpRequest.Scopes : [],
				Params: isPlainObject(tmpRequest.Params) ? tmpRequest.Params : {},
				Records: isPlainObject(tmpRequest.Records) ? tmpRequest.Records : null,
				Warnings: Array.isArray(tmpRequest.Warnings) ? tmpRequest.Warnings : []
			});
	}

	/**
	 * The client part of the key material: every canonical conjunct (bound values, clause Hashes and
	 * scope Params included: they shape Excluded and Filter.Applied).
	 *
	 * @param {Record<string, any>} pContext
	 * @return {Array<Record<string, any>>}
	 */
	_clientMaterial(pContext)
	{
		let tmpConjuncts = (pContext && pContext.FilterAST && Array.isArray(pContext.FilterAST.Conjuncts)) ? pContext.FilterAST.Conjuncts : [];
		return tmpConjuncts.map(
			(pConjunct) =>
			{
				return (
					{
						Id: pConjunct.Id,
						Origin: pConjunct.Origin || null,
						Shape: pConjunct.Shape || 'Column',
						NeverExclude: (pConjunct.NeverExclude === true),
						Pred: pConjunct.Pred
					});
			});
	}

	/**
	 * The canonical key material (internal-contracts §42.4).  Reads only the context fields named
	 * here: never the SessionID, the request object, cookies or headers.  Principal.ScopeValues are
	 * deliberately not material: the scope part carries the values the SQL uses (what each probe's
	 * behavior appended, and the values the guard required).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPlan
	 * @param {Record<string, any>} pProbe
	 * @return {Record<string, any>}
	 */
	material(pContext, pPlan, pProbe)
	{
		let tmpContext = pContext || {};
		let tmpOptions = this._options(tmpContext);
		let tmpGenerations = this.fable.RetoldFacetingGenerations;
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		let tmpFilterAST = tmpContext.FilterAST || {};
		let tmpCaptures = (pProbe && isPlainObject(pProbe.Captures)) ? pProbe.Captures : {};
		let tmpScope = Object.keys(tmpCaptures).sort().map(
			(pEntity) =>
			{
				let tmpCapture = tmpCaptures[pEntity] || {};
				let tmpGuard = tmpCapture.Guard || {};
				return (
					[
						pEntity,
						tmpCapture.Fingerprint || null,
						{
							// The fingerprint hashes these already; carried whole so the key never
							// rests on a 48-bit fingerprint alone.
							Appended: Array.isArray(tmpCapture.Appended) ? tmpCapture.Appended : [],
							Transformed: Array.isArray(tmpCapture.Transformed) ? tmpCapture.Transformed : [],
							Behavior: tmpCapture.Behavior || null,
							ScopeMode: tmpCapture.ScopeMode || 'Inherit',
							// A Repair-mode guard adds the policy predicate after the capture's diff: its
							// required values are what the SQL filters on.
							Required: Array.isArray(tmpGuard.Required) ? tmpGuard.Required : [],
							Repaired: (tmpGuard.Repaired === true),
							PostOperation: tmpCapture.PostOperation || null
						}
					]);
			});
		let tmpPinnedNow = ((typeof(tmpContext.PinnedNow) === 'string') || (typeof(tmpContext.PinnedNow) === 'number')) ? String(tmpContext.PinnedNow) : null;
		return (
			{
				v: KEY_VERSION,
				Instance: (typeof(tmpOptions.InstanceID) === 'string') ? tmpOptions.InstanceID : '',
				Boot: (tmpGenerations && (typeof(tmpGenerations.BootEpoch) === 'string')) ? tmpGenerations.BootEpoch : null,
				// The ModelVersion the request was planned under (snapshotted in newContext, §51.51).
				Model: (typeof(tmpContext.ModelVersion) === 'string') ? tmpContext.ModelVersion
					: ((tmpCatalog && (typeof(tmpCatalog.modelVersion) === 'function')) ? tmpCatalog.modelVersion() : null),
				EngineClass: 'Live',
				Entity: (typeof(tmpContext.Entity) === 'string') ? tmpContext.Entity : '',
				Mode: 'Query',
				Request: this._requestMaterial(tmpContext),
				Client: this._clientMaterial(tmpContext),
				Applied: Array.isArray(tmpFilterAST.Applied) ? tmpFilterAST.Applied : [],
				FilterWarnings: Array.isArray(tmpFilterAST.Warnings) ? tmpFilterAST.Warnings : [],
				ContextWarnings: Array.isArray(tmpContext.Warnings) ? tmpContext.Warnings : [],
				Scope: tmpScope,
				Bind: (pPlan && (typeof(pPlan.BindHash) === 'string')) ? pPlan.BindHash : null,
				Gate: (tmpContext.Principal && (typeof(tmpContext.Principal.RoleSetHash) === 'string')) ? tmpContext.Principal.RoleSetHash : '',
				PlanForm: isPlainObject(tmpContext.PlanForm) ? tmpContext.PlanForm : null,
				PinnedNow: tmpPinnedNow
			});
	}

	/**
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPlan
	 * @param {Record<string, any>} pProbe
	 * @return {{ Key: string, Short: string }} 'ck:' + 64 hex, and its first 15 characters
	 */
	key(pContext, pPlan, pProbe)
	{
		let tmpKey = `ck:${sha256(canonicalJSON(this.material(pContext, pPlan, pProbe)))}`;
		return { Key: tmpKey, Short: tmpKey.slice(0, 15) };
	}

	/**
	 * 'ph:' + 16 hex of the request and client parts of the material (logs).
	 *
	 * @param {Record<string, any>} pContext
	 * @return {string}
	 */
	planHash(pContext)
	{
		let tmpMaterial = canonicalJSON({ Entity: (pContext && pContext.Entity) || '', Request: this._requestMaterial(pContext), Client: this._clientMaterial(pContext) });
		return `ph:${sha256(tmpMaterial).slice(0, 16)}`;
	}

	/**
	 * The generation dependencies of the cache DepSet (internal-contracts §42.5, §41.4), one per
	 * entity (sorted):
	 *
	 *   TenantKeys = Generations.foldTenantKeys(Principal, E, E ∈ TenantOnly)
	 *   Columns    = (DepSet[E] ∪ the probe's Appended columns) − RowColumns ∪ '#row', '#all'
	 *                (∪ '#cols' when DepSet[E] holds it); granularity 'Entity': '#row', '#all'.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pDeps
	 * @param {Record<string, any>} pProbe
	 * @return {Array<{ Entity: string, TenantKeys: Array<string>, Columns: Array<string> }>}
	 */
	dependencies(pContext, pDeps, pProbe)
	{
		let tmpContext = pContext || {};
		let tmpDepSet = (pDeps && isPlainObject(pDeps.DepSet)) ? pDeps.DepSet : {};
		let tmpTenantOnly = (pDeps && Array.isArray(pDeps.TenantOnly)) ? pDeps.TenantOnly : [];
		let tmpCaptures = (pProbe && isPlainObject(pProbe.Captures)) ? pProbe.Captures : {};
		let tmpGenerations = this.fable.RetoldFacetingGenerations;
		let tmpOptions = this._options(tmpContext);
		let tmpEntityGranularity = !!(tmpOptions.Cache && (tmpOptions.Cache.GenerationGranularity === 'Entity'));
		return Object.keys(tmpDepSet).sort().map(
			(pEntity) =>
			{
				let tmpTenantKeys = tmpGenerations
					? tmpGenerations.foldTenantKeys(tmpContext.Principal || null, pEntity, tmpTenantOnly.indexOf(pEntity) >= 0)
					: FALLBACK_TENANT_KEYS.slice();
				if (tmpEntityGranularity)
				{
					return { Entity: pEntity, TenantKeys: tmpTenantKeys, Columns: [ ALL, ROW ] };
				}
				let tmpScope = tmpGenerations ? tmpGenerations.scopeColumns(pEntity) : { RowColumns: [] };
				let tmpRowColumns = Array.isArray(tmpScope.RowColumns) ? tmpScope.RowColumns : [];
				let tmpColumns = {};
				let tmpEntityColumns = Array.isArray(tmpDepSet[pEntity]) ? tmpDepSet[pEntity] : [];
				tmpEntityColumns.forEach((pColumn) => { if (isRealColumn(pColumn)) { tmpColumns[pColumn] = true; } });
				let tmpCapture = tmpCaptures[pEntity];
				(tmpCapture && Array.isArray(tmpCapture.Appended) ? tmpCapture.Appended : []).forEach(
					(pEntry) =>
					{
						let tmpColumn = pEntry ? libRetoldFacetingUtil.stripColumn(pEntry.Column) : null;
						if (isRealColumn(tmpColumn))
						{
							tmpColumns[tmpColumn] = true;
						}
					});
				tmpRowColumns.forEach((pColumn) => { delete tmpColumns[pColumn]; });
				tmpColumns[ROW] = true;
				tmpColumns[ALL] = true;
				if (tmpEntityColumns.indexOf(COLS) >= 0)
				{
					tmpColumns[COLS] = true;
				}
				return { Entity: pEntity, TenantKeys: tmpTenantKeys, Columns: Object.keys(tmpColumns).sort() };
			});
	}

	/**
	 * Did the execution run under a scope its probes did not capture (S1 / C4)?  ScopeCapture logs,
	 * on pContext.ScopeLog (armed by the Cache stage of a cacheable request), what the behaviors of
	 * every capture the execution ran appended BEFORE any TenantOnly relaxation; each must equal what
	 * the probe of its entity appended (canonical JSON, entry by entry).  An execution capture of an
	 * entity the probes never saw is drift too (its scope is in no key).  Client-operator transforms
	 * are not compared (the probe has no client conjuncts; they are covered by the key's Client part).
	 *
	 * @param {Record<string, any>} pContext
	 * @return {{ Drift: boolean, Entity: string|null }}
	 */
	scopeDrift(pContext)
	{
		let tmpLog = (pContext && Array.isArray(pContext.ScopeLog)) ? pContext.ScopeLog : [];
		let tmpProbe = (pContext && pContext.Cache && isPlainObject(pContext.Cache.Probe)) ? pContext.Cache.Probe : null;
		let tmpCaptures = (tmpProbe && isPlainObject(tmpProbe.Captures)) ? tmpProbe.Captures : {};
		let tmpProbed = {};
		for (let i = 0; i < tmpLog.length; i++)
		{
			let tmpEntry = tmpLog[i];
			if (!tmpEntry || (typeof(tmpEntry.Entity) !== 'string'))
			{
				continue;
			}
			if (!hasOwn(tmpCaptures, tmpEntry.Entity) || !tmpCaptures[tmpEntry.Entity])
			{
				return { Drift: true, Entity: tmpEntry.Entity };
			}
			if (!hasOwn(tmpProbed, tmpEntry.Entity))
			{
				let tmpAppended = tmpCaptures[tmpEntry.Entity].Appended;
				tmpProbed[tmpEntry.Entity] = canonicalJSON(Array.isArray(tmpAppended) ? tmpAppended : []);
			}
			if (canonicalJSON(Array.isArray(tmpEntry.Appended) ? tmpEntry.Appended : []) !== tmpProbed[tmpEntry.Entity])
			{
				return { Drift: true, Entity: tmpEntry.Entity };
			}
		}
		return { Drift: false, Entity: null };
	}

	/**
	 * The generation Version (internal-contracts §42.6): the M1 'fv1:' + 16 hex shape, so the ETag
	 * patterns hold.
	 *
	 * @param {string} pKey
	 * @param {string} pGenVectorHash
	 * @return {string} 'fv1:' + 16 hex
	 */
	version(pKey, pGenVectorHash)
	{
		return `fv1:${sha256(`${pKey}|${pGenVectorHash}`).slice(0, 16)}`;
	}
}

module.exports = RetoldFacetingCacheKey;
module.exports.serviceType = 'RetoldFacetingCacheKey';
module.exports.KEY_VERSION = KEY_VERSION;
module.exports.UNCACHEABLE_REASONS = UNCACHEABLE_REASONS;
