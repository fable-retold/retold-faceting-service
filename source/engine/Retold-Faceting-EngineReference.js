/**
 * Retold Faceting - Reference Engine (oracle O1)
 *
 * A pure-JS fold over the rows the LIST endpoint waterfall returns (Reads with Cap 0 through the
 * real route-bound controller and its behaviors).  Every test compares Live against it, so it must
 * stay independent of the Live machinery: it never uses the ScopedRelationBuilder,
 * PredicateCompiler, StagedKeys, CubeExecutor, Dialects, ShellTemplates or EngineLive, never adds
 * an explicit soft-delete (FoxHound's implicit one, exactly as the list), and folds with the
 * canonical contract math (contract/Facet-Contract-Buckets.js).
 *
 * Single-entity Aggs (M1, internal-contracts §9.3): per Variant (memoized in
 * pContext.Memo.VariantRows), the list waterfall is replayed on the route-bound controller
 *
 *   state = controller.initializeRequestState(pContext.Request, 'Reads')
 *   state.Query = controller.DAL.query ; setCap(0) ; setBegin(0)
 *   ( FilterAST.applyToQuery(Variant.Conjuncts) )          ← the client fence
 *   runBehavior(Scope.Behavior)                             ← tenancy / owner scope, as the list
 *   controller.DAL.doReads(state.Query)                     ← FoxHound adds Deleted = 0 implicitly
 *   runBehavior('Reads-PostOperation')
 *
 * then every Agg on that Variant is folded in JS into the RawFacetResult shapes of §9.2.
 *
 * Cross-entity Aggs (M2, internal-contracts §27.2) interpret the SAME FoldIR the Planner lowered
 * (§24) without any SQL composition:
 *   - every relation (pivot, hop, lookup, multi chain, child, tuple side) is read through ITS OWN
 *     entity's list waterfall as the same principal (listRows: memoized in pContext.Memo.HopRows by
 *     Entity | Scope | client conjunct Ids | SoftDelete | WhereHash); its column Where is fenced into
 *     that read, so the database evaluates it exactly as the list would (LIKE, collation, text in
 *     numeric columns);
 *   - Scope 'TenantOnly' relaxes the read with ScopeCapture.relaxPersonalScope (the one function the
 *     Live capture uses); a refusal is 500 FACET_SCOPE_POLICY_VIOLATION, as on Live;
 *   - a column predicate outside a Rel (a Cmp leaf, or a column-only And / Or over one alias) is
 *     row MEMBERSHIP: the row's primary key is in listRows(that alias's Rel ∧ predicate) — never a
 *     JS comparison of values;
 *   - Exists / NotExists / CountCmp walk the related rows in JS: On pairs are SQL equality (NULL is
 *     never equal; numbers compared after FacetBuckets.numericValue, strings exactly), nested Where
 *     evaluated with the related row bound to its alias;
 *   - base rows: the entity pivot's list rows under the Variant's Column conjuncts (or each tuple
 *     side's rows, hash-joined on On and made distinct by Key), kept where Variant.PathPred and
 *     Agg.Where hold; then Via (follow each to-one link: none → NULL key, more than one →
 *     FACET_INTERNAL), Multi (distinct keys over every chain, distinct pivot rows per key), ChildAgg
 *     (matching children → band) and ExistsFlag (1 / 0) dimensions, folded by the M1 functions.
 * Reads happen in a prefetch pass (every relation a tree mentions, in tree order, one at a time);
 * evaluation is synchronous over the memoized rows.
 *
 * Missing is the same rule on every engine: NULL; for a numeric DataType also any value that is
 * not a number (FacetBuckets.numericValue: '', ' ', text); for DateTime any value canonicalDateTime
 * refuses.  Behavior errors map through FacetErrors.fromBehaviorError, exactly as ScopeCapture's.
 *
 * Records / Count / Keys oracle helpers (Live signatures of §26.5): countBase, recordKeys, keys.
 *
 * Contract: internal-contracts §9.3, §24, §27.2.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libCrypto = require('crypto');

const libRetoldFacetingEngineBase = require('./Retold-Faceting-EngineBase.js');
// The TenantOnly relaxation is a pure static shared with the Live capture (internal-contracts §26.2,
// §36.16); nothing else of the capture service is used here.
const libRetoldFacetingScopeCapture = require('../security/Retold-Faceting-ScopeCapture.js');

const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetBuckets = require('../contract/Facet-Contract-Buckets.js');
const libFacetEnvelope = require('../contract/Facet-Contract-Envelope.js');
const libFacetClauses = require('../contract/Facet-Contract-Clauses.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

// Kinds this engine folds (internal-contracts §5.3, §24.5).
const FOLD_KINDS = [ 'Count', 'Terms', 'DateHistogram', 'NumericHistogram', 'Ranges', 'Stats', 'DistinctCount', 'Missing', 'Pivot', 'ChildRollup', 'ExistsSplit' ];

// Pivot axis kinds allowed in M1 (internal-contracts §5.2).
const PIVOT_AXIS_KINDS = libRetoldFacetingEngineBase.PIVOT_AXIS_KINDS;

// Dimension kinds that make an Agg cross-entity (internal-contracts §24.3).
const CROSS_ENTITY_DIMENSIONS = Object.freeze([ 'Multi', 'ChildAgg', 'ExistsFlag' ]);

// FoldPred comparison operators of a CountCmp (internal-contracts §24.2).
const COUNT_OPERATORS = Object.freeze([ 'EQ', 'NE', 'GT', 'GE', 'LT', 'LE' ]);

// Pred ops that take no Value.
const VALUELESS_OPS = Object.freeze([ 'NULL', 'NOTNULL' ]);

// The relationKey memo's key for "no membership predicate".
const NO_EXTRA = Object.freeze({ NoExtra: true });

const hasOwn = libRetoldFacetingUtil.hasOwn;

class RetoldFacetingEngineReference extends libRetoldFacetingEngineBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options (resolved by the base)
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'RetoldFacetingEngineReference';
	}

	get EngineName()
	{
		return 'Reference';
	}

	/**
	 * The Reference engine is only ever used when forced (pContext.ForceEngine === 'Reference').
	 *
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pContext
	 * @return {{ Capable: boolean, Reason?: string }}
	 */
	capable(pAgg, pContext)
	{
		if (!pContext || (pContext.ForceEngine !== 'Reference'))
		{
			return { Capable: false, Reason: 'OracleOnly' };
		}
		if (!pAgg || (FOLD_KINDS.indexOf(pAgg.Kind) < 0))
		{
			return { Capable: false, Reason: 'UnknownKind' };
		}
		return { Capable: true };
	}

	/**
	 * The Reference reads the source of truth: always exact.
	 *
	 * @param {Record<string, Array<string>>} pDepSet
	 * @return {{ Exact: boolean, AsOf: string, LagMS: number }}
	 */
	freshness(pDepSet)
	{
		return { Exact: true, AsOf: new Date().toISOString(), LagMS: 0 };
	}

	/**
	 * Execute every Agg of one request: one list read per Variant (memoized) and per relation the
	 * cross-entity Aggs mention, then a JS fold per Agg.
	 *
	 * Whole-request errors (behavior 401, DB failure, missing controller, a failure of the Variant's
	 * own path predicates) go to fCallback(pError); per-Agg failures (unknown Variant, fold errors,
	 * deadline, a failure of a relation only that Agg reads) go to Execution.Errors[Key].
	 *
	 * @param {Record<string, any>} pContext - internal-contracts §2.2
	 * @param {Array<Record<string, any>>} pAggs - internal-contracts §5.1 / §24.5
	 * @param {(pError?: Error, pExecution?: Record<string, any>) => void} fCallback
	 */
	execute(pContext, pAggs, fCallback)
	{
		let tmpExecution = this.newExecution(pContext);
		let tmpAggs = Array.isArray(pAggs) ? pAggs : [];
		let tmpVariants = (pContext && pContext.Variants) ? pContext.Variants : {};
		this.ensureMemo(pContext);
		let tmpStatementsBefore = pContext.Counters.Statements;

		// Group the Aggs by Variant, in order of first appearance (so reads are deterministic).
		let tmpVariantOrder = [];
		let tmpAggsByVariant = Object.create(null);
		for (let i = 0; i < tmpAggs.length; i++)
		{
			let tmpAgg = tmpAggs[i];
			let tmpVariantId = tmpAgg.VariantId || 'v0';
			if (!hasOwn(tmpVariants, tmpVariantId))
			{
				tmpExecution.Errors[tmpAgg.Key] = libFacetErrors.toEntry(libFacetErrors.create('FACET_INTERNAL', 'The facet references an unknown variant.'));
				continue;
			}
			if (!hasOwn(tmpAggsByVariant, tmpVariantId))
			{
				tmpAggsByVariant[tmpVariantId] = [];
				tmpVariantOrder.push(tmpVariantId);
			}
			tmpAggsByVariant[tmpVariantId].push(tmpAgg);
		}

		// Entity → { First, Variants, Hops } (the capture fingerprints of §27.2)
		let tmpFingerprints = Object.create(null);

		// One Variant at a time (memoized reads, deterministic order); a read error stops the request.
		this.fable.Utility.eachLimit(tmpVariantOrder, 1,
			(pVariantId, fNextVariant) =>
			{
				let tmpVariant = tmpVariants[pVariantId];
				let tmpVariantAggs = tmpAggsByVariant[pVariantId];

				if ((typeof(pContext.Deadline) === 'number') && (Date.now() > pContext.Deadline))
				{
					for (let i = 0; i < tmpVariantAggs.length; i++)
					{
						tmpExecution.Errors[tmpVariantAggs[i].Key] = libFacetErrors.toEntry(libFacetErrors.create('FACET_TIMEOUT'));
					}
					return fNextVariant();
				}

				if (this.isCrossEntity(tmpVariant, tmpVariantAggs))
				{
					return this.executeCrossEntity(pContext, pVariantId, tmpVariant, tmpVariantAggs, tmpExecution, tmpFingerprints, fNextVariant);
				}

				if (this.hasPathConjuncts(tmpVariant))
				{
					// A Variant with Path-shaped conjuncts and no lowered PathPred is a planner bug: never
					// answer it as if the conjuncts were not there.
					return fNextVariant(libFacetErrors.create('FACET_INTERNAL', 'The variant has path conjuncts but no lowered path predicate.'));
				}

				this.readVariantRows(pContext, tmpVariant,
					(pReadError, pRecords) =>
					{
						if (pReadError)
						{
							return fNextVariant(pReadError);
						}

						let tmpEntity = tmpVariant.Entity || pContext.Entity;
						this.addFingerprint(tmpFingerprints, tmpEntity, pVariantId, `ref:${(typeof(tmpVariant.Hash) === 'string') ? tmpVariant.Hash : ''}`);

						for (let i = 0; i < tmpVariantAggs.length; i++)
						{
							let tmpAgg = tmpVariantAggs[i];
							try
							{
								let tmpRaw = this.fold(tmpAgg, pRecords);
								tmpRaw.VariantId = pVariantId;
								tmpExecution.Results[tmpAgg.Key] = tmpRaw;
							}
							catch (pFoldError)
							{
								tmpExecution.Errors[tmpAgg.Key] = this.foldErrorEntry(tmpAgg, pFoldError);
							}
						}
						return fNextVariant();
					});
			},
			(pError) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpEntities = Object.keys(tmpFingerprints);
				for (let i = 0; i < tmpEntities.length; i++)
				{
					let tmpEntity = tmpEntities[i];
					let tmpEntry = tmpFingerprints[tmpEntity];
					tmpExecution.Captures[tmpEntity] = (
						{
							// The Reference runs no ScopeGuard; its fingerprint is 'ref:' + VariantHash
							// (the first Variant read; every Variant's is listed under Variants) and
							// 'ref:hop:' + Entity + '|' + Scope + '|' + WhereHash for a hop entity.
							Fingerprint: tmpEntry.First,
							Repaired: false,
							Variants: tmpEntry.Variants
						});
					if (tmpEntry.Hops.length > 0)
					{
						tmpExecution.Captures[tmpEntity].Hops = tmpEntry.Hops.slice().sort();
					}
				}
				tmpExecution.Statements = pContext.Counters.Statements - tmpStatementsBefore;
				return fCallback(null, tmpExecution);
			});
	}

	/**
	 * Record a capture fingerprint for an entity (the first one is the entity's Fingerprint).
	 *
	 * @param {Record<string, any>} pFingerprints
	 * @param {string} pEntity
	 * @param {string|null} pVariantId - a pivot read; null for a hop
	 * @param {string} pFingerprint
	 */
	addFingerprint(pFingerprints, pEntity, pVariantId, pFingerprint)
	{
		if (!hasOwn(pFingerprints, pEntity))
		{
			pFingerprints[pEntity] = { First: pFingerprint, Variants: {}, Hops: [] };
		}
		if (pVariantId)
		{
			pFingerprints[pEntity].Variants[pVariantId] = pFingerprint;
		}
		else if (pFingerprints[pEntity].Hops.indexOf(pFingerprint) < 0)
		{
			pFingerprints[pEntity].Hops.push(pFingerprint);
		}
	}

	/**
	 * The per-Agg error entry of a fold failure (a non-facet error is logged, never echoed).
	 *
	 * @param {Record<string, any>} pAgg
	 * @param {any} pError
	 * @return {Record<string, any>}
	 */
	foldErrorEntry(pAgg, pError)
	{
		if (!libFacetErrors.isFacetError(pError))
		{
			this.fable.log.error(`RetoldFacetingEngineReference: fold of ${libRetoldFacetingUtil.logSafe(pAgg.Key)} (${pAgg.Kind}) failed: ${(pError && pError.message) ? pError.message : pError}`);
		}
		return libFacetErrors.toEntry(pError);
	}

	/**
	 * Create the per-request memo and counters this engine uses (lazily; newContext keeps the M1
	 * Memo shape, internal-contracts §19.5).
	 *
	 * @param {Record<string, any>} pContext
	 */
	ensureMemo(pContext)
	{
		if (!pContext.Memo)
		{
			pContext.Memo = { Relations: {}, Captures: {}, VariantRows: {} };
		}
		if (!pContext.Memo.VariantRows)
		{
			pContext.Memo.VariantRows = {};
		}
		if (!pContext.Counters)
		{
			pContext.Counters = { Relations: 0, BehaviorRuns: 0, Statements: 0 };
		}
		if (typeof(pContext.Counters.Statements) !== 'number')
		{
			pContext.Counters.Statements = 0;
		}
	}

	/**
	 * The memo key of a Variant's rows (per request).
	 *
	 * @param {Record<string, any>} pVariant
	 * @return {string}
	 */
	variantMemoKey(pVariant)
	{
		let tmpIds = Array.isArray(pVariant.ConjunctIds) ? pVariant.ConjunctIds.join(',') : ((typeof(pVariant.Hash) === 'string') ? pVariant.Hash : '');
		return `${pVariant.Entity}|${tmpIds}`;
	}

	/**
	 * The Column-shaped conjuncts of a Variant (the pivot's client fence): Variant.ColumnConjuncts
	 * when the Planner set it (M2), else every conjunct that is not Path-shaped (M1 Variants).
	 *
	 * @param {Record<string, any>} pVariant
	 * @return {Array<Record<string, any>>}
	 */
	columnConjuncts(pVariant)
	{
		if (pVariant && Array.isArray(pVariant.ColumnConjuncts))
		{
			return pVariant.ColumnConjuncts;
		}
		let tmpConjuncts = (pVariant && Array.isArray(pVariant.Conjuncts)) ? pVariant.Conjuncts : [];
		return tmpConjuncts.filter((pConjunct) => { return !pConjunct || (pConjunct.Shape !== 'Path'); });
	}

	/**
	 * Does a Variant keep a Path-shaped conjunct (internal-contracts §23.1)?
	 *
	 * @param {Record<string, any>} pVariant
	 * @return {boolean}
	 */
	hasPathConjuncts(pVariant)
	{
		let tmpConjuncts = (pVariant && Array.isArray(pVariant.Conjuncts)) ? pVariant.Conjuncts : [];
		return tmpConjuncts.some((pConjunct) => { return pConjunct && (pConjunct.Shape === 'Path'); });
	}

	/**
	 * Read a Variant's rows through the list waterfall (memoized in pContext.Memo.VariantRows).
	 *
	 * Records are plain objects from meadow's marshaller (DefaultObject + every selected column,
	 * NULLs preserved).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pVariant - internal-contracts §6.3
	 * @param {(pError?: Error, pRecords?: Array<Record<string, any>>) => void} fCallback
	 */
	readVariantRows(pContext, pVariant, fCallback)
	{
		this.ensureMemo(pContext);
		let tmpMemoKey = this.variantMemoKey(pVariant);
		if (hasOwn(pContext.Memo.VariantRows, tmpMemoKey))
		{
			return fCallback(null, pContext.Memo.VariantRows[tmpMemoKey]);
		}
		let tmpEntity = pVariant.Entity || pContext.Entity;
		return this.readList(pContext, tmpEntity, this.columnConjuncts(pVariant), null, 'Inherit',
			(pError, pRecords) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				pContext.Memo.VariantRows[tmpMemoKey] = pRecords;
				return fCallback(null, pRecords);
			});
	}

	/**
	 * One list waterfall read (not memoized): the entity's route-bound controller and DAL, Cap 0,
	 * the client conjuncts fenced, the column Where fenced, the entity's own scope behavior,
	 * TenantOnly relaxation, doReads (FoxHound's implicit soft delete, as the list), and
	 * Reads-PostOperation.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pEntity
	 * @param {Array<Record<string, any>>|null} pClient - conjuncts (client fence)
	 * @param {Record<string, any>|null} pWhere - a column-only Pred (its own fence)
	 * @param {string} pScope - 'Inherit' | 'TenantOnly'
	 * @param {(pError?: Error, pRecords?: Array<Record<string, any>>) => void} fCallback
	 */
	readList(pContext, pEntity, pClient, pWhere, pScope, fCallback)
	{
		this.ensureMemo(pContext);
		let tmpHost = pContext.Host;
		if (!tmpHost)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The reference engine has no host.'));
		}
		let tmpController = tmpHost.getRouteBoundController(pEntity);
		// The DAL the list itself reads through: the route-bound controller's (=== Host.getDAL(Entity)
		// until an RDS model reload, after which the routes keep the old controller and its DAL, D-31).
		let tmpDAL = (tmpController && tmpController.DAL) ? tmpController.DAL : tmpHost.getDAL(pEntity);
		if (!tmpController || !tmpDAL)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The reference engine could not reach the entity list path.'));
		}
		let tmpFilterAST = this.fable.RetoldFacetingFilterAST;
		let tmpConjuncts = Array.isArray(pClient) ? pClient : [];
		if (((tmpConjuncts.length > 0) || pWhere) && (!tmpFilterAST || (typeof(tmpFilterAST.applyToQuery) !== 'function')))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The reference engine has no FilterAST service.'));
		}
		if ((pScope !== 'Inherit') && (pScope !== 'TenantOnly'))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The reference engine got an unknown relation scope.'));
		}

		let tmpOptions = pContext.Options || this.options;
		let tmpScope = (tmpOptions && tmpOptions.Scope) ? tmpOptions.Scope : {};
		let tmpBehavior = (tmpScope.BehaviorOverrides && (typeof(tmpScope.BehaviorOverrides[pEntity]) === 'string'))
			? tmpScope.BehaviorOverrides[pEntity]
			: (tmpScope.Behavior || 'Reads-QueryConfiguration');
		let tmpDialectName = (pContext.Dialect) ? pContext.Dialect
			: ((typeof(tmpHost.getDialectProfile) === 'function') ? tmpHost.getDialectProfile(pEntity).Name : 'SQLite');
		let tmpLimits = (tmpOptions && tmpOptions.Limits) ? tmpOptions.Limits : {};

		let tmpRequest = pContext.Request || { params: {}, headers: {}, query: {} };
		let tmpState;
		try
		{
			tmpState = tmpController.initializeRequestState(tmpRequest, 'Reads');
			tmpState.Query = tmpDAL.query;
			tmpState.Query.setCap(0).setBegin(0);
			if (tmpConjuncts.length > 0)
			{
				tmpState.Query.addFilter('', '', '(', 'AND', 'FacetFenceOpen');
				tmpFilterAST.applyToQuery(tmpConjuncts, tmpState.Query, { Dialect: tmpDialectName, ParameterPrefix: 'c' });
				tmpState.Query.addFilter('', '', ')', 'AND', 'FacetFenceClose');
			}
			if (pWhere)
			{
				tmpState.Query.addFilter('', '', '(', 'AND', 'FacetWhereOpen');
				tmpFilterAST.applyToQuery([ { Id: 'w', Pred: pWhere } ], tmpState.Query, { Dialect: tmpDialectName, ParameterPrefix: 'w' });
				tmpState.Query.addFilter('', '', ')', 'AND', 'FacetWhereClose');
			}
		}
		catch (pBuildError)
		{
			return fCallback(libFacetErrors.isFacetError(pBuildError) ? pBuildError : this.internalError('building the list query', pBuildError));
		}

		let tmpInjection = tmpController.BehaviorInjection;

		pContext.Counters.BehaviorRuns++;
		if ((typeof(tmpLimits.MaxBehaviorRunsPerRequest) === 'number') && (pContext.Counters.BehaviorRuns > tmpLimits.MaxBehaviorRunsPerRequest))
		{
			return fCallback(libFacetErrors.create('FACET_TOO_LARGE', 'The request needs too many scope behavior runs.', { Limit: 'MaxBehaviorRunsPerRequest' }));
		}

		tmpInjection.runBehavior(tmpBehavior, tmpController, tmpRequest, tmpState,
			(pBehaviorError) =>
			{
				if (pBehaviorError)
				{
					return fCallback(this.behaviorError(pBehaviorError));
				}
				if (pScope === 'TenantOnly')
				{
					// The declared relaxation, exactly as the Live capture does it (§26.2).
					let tmpPolicy = (typeof(tmpHost.getScopePolicy) === 'function') ? tmpHost.getScopePolicy() : null;
					let tmpRelaxed = libRetoldFacetingScopeCapture.relaxPersonalScope(tmpState.Query.parameters.filter, tmpPolicy, pContext.Principal, pEntity);
					if (tmpRelaxed.Refused)
					{
						this.fable.log.error(`RetoldFacetingEngineReference: TenantOnly relaxation of ${libRetoldFacetingUtil.logSafe(pEntity)} refused (${tmpRelaxed.Refused}).`);
						return fCallback(libFacetErrors.create('FACET_SCOPE_POLICY_VIOLATION', null, { Entity: pEntity, Reason: `TenantOnlyRefused:${tmpRelaxed.Refused}` }));
					}
					tmpState.Query.parameters.filter = tmpRelaxed.Filter;
				}
				pContext.Counters.Statements++;
				let tmpDoReadsCalledBack = false;
				try
				{
					tmpDAL.doReads(tmpState.Query,
						(pReadError, pQuery, pRecords) =>
						{
							if (tmpDoReadsCalledBack)
							{
								return;
							}
							tmpDoReadsCalledBack = true;
							if (pReadError)
							{
								return fCallback(this.internalError('reading the list', pReadError));
							}
							tmpState.Records = Array.isArray(pRecords) ? pRecords : [];
							tmpInjection.runBehavior('Reads-PostOperation', tmpController, tmpRequest, tmpState,
								(pPostError) =>
								{
									if (pPostError)
									{
										return fCallback(this.behaviorError(pPostError));
									}
									return fCallback(null, Array.isArray(tmpState.Records) ? tmpState.Records : []);
								});
						});
				}
				catch (pReadException)
				{
					if (tmpDoReadsCalledBack)
					{
						// Thrown downstream of our own callback: not a read failure, never swallow it.
						throw pReadException;
					}
					tmpDoReadsCalledBack = true;
					return fCallback(this.internalError('reading the list', pReadException));
				}
			});
	}

	/**
	 * Map a behavior error with the shared FacetErrors.fromBehaviorError (the one ScopeCapture
	 * uses, so Live and the oracle agree on the status); an unmapped error is logged.
	 *
	 * @param {any} pError
	 * @return {Error}
	 */
	behaviorError(pError)
	{
		let tmpMapped = libFacetErrors.fromBehaviorError(pError);
		if ((tmpMapped.Code === 'FACET_INTERNAL') && !libFacetErrors.isFacetError(pError))
		{
			return this.internalError('running a scope behavior', pError);
		}
		return tmpMapped;
	}

	/**
	 * A logged FACET_INTERNAL (the cause is never echoed to the client).
	 *
	 * @param {string} pWhile
	 * @param {any} pError
	 * @return {Error}
	 */
	internalError(pWhile, pError)
	{
		let tmpMessage = (pError && pError.message) ? pError.message : String(pError);
		this.fable.log.error(`RetoldFacetingEngineReference: error ${pWhile}: ${tmpMessage}`);
		return libFacetErrors.create('FACET_INTERNAL');
	}

	// ------------------------------------------------------------------ cross-entity (M2, §27.2)

	/**
	 * Does a Variant (or one of its Aggs) need the cross-entity interpreter?
	 *
	 * @param {Record<string, any>} pVariant
	 * @param {Array<Record<string, any>>} pAggs
	 * @return {boolean}
	 */
	isCrossEntity(pVariant, pAggs)
	{
		if (pVariant && (pVariant.PathPred || pVariant.Where))
		{
			return true;
		}
		let tmpAggs = Array.isArray(pAggs) ? pAggs : [];
		return tmpAggs.some((pAgg) => { return this.isCrossEntityAgg(pAgg); });
	}

	/**
	 * Is an Agg cross-entity (a definition Where, a TuplePivot, an M2 kind or dimension)?
	 *
	 * @param {Record<string, any>} pAgg
	 * @return {boolean}
	 */
	isCrossEntityAgg(pAgg)
	{
		if (!pAgg)
		{
			return false;
		}
		if (pAgg.Tuple || pAgg.Where || (pAgg.Kind === 'ChildRollup') || (pAgg.Kind === 'ExistsSplit'))
		{
			return true;
		}
		let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
		return tmpDimensions.some(
			(pDimension) =>
			{
				return !!pDimension && ((Array.isArray(pDimension.Via) && (pDimension.Via.length > 0))
					|| ((typeof(pDimension.Alias) === 'string') && (pDimension.Alias !== 'p'))
					|| (CROSS_ENTITY_DIMENSIONS.indexOf(pDimension.Kind) >= 0));
			});
	}

	/**
	 * The pseudo-Rel of an entity pivot under a Variant (alias 'p'; the Variant's Column conjuncts
	 * are its client fence).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pVariant
	 * @param {string} [pEntity]
	 * @return {Record<string, any>}
	 */
	pivotRel(pContext, pVariant, pEntity)
	{
		return (
			{
				Entity: pEntity || pVariant.Entity || pContext.Entity,
				As: 'p',
				Role: 'Pivot',
				Client: this.columnConjuncts(pVariant),
				Where: null,
				Scope: 'Inherit',
				SoftDelete: pVariant.IncludesDeleted ? 'ClientControlled' : 'Explicit'
			});
	}

	/**
	 * A column-only Pred as a stable short hash ('' for none).
	 *
	 * @param {Record<string, any>|null} pWhere
	 * @return {string}
	 */
	whereHash(pWhere)
	{
		if (!pWhere)
		{
			return '';
		}
		return `wh:${libCrypto.createHash('sha1').update(libFacetClauses.canonicalJSON(pWhere)).digest('hex').slice(0, 12)}`;
	}

	/**
	 * A Rel's Where and an extra column predicate, ANDed (null when both are absent).
	 *
	 * @param {Record<string, any>|null} pWhere
	 * @param {Record<string, any>|null} pExtra
	 * @return {Record<string, any>|null}
	 */
	combineWhere(pWhere, pExtra)
	{
		if (pWhere && pExtra)
		{
			return { And: [ pWhere, pExtra ] };
		}
		return pWhere || pExtra || null;
	}

	/**
	 * The memo key of one relation read (alias excluded: the same hop under two aliases is one read).
	 *
	 * @param {Record<string, any>} pRel
	 * @param {Record<string, any>|null} pExtra - a membership predicate ANDed to the Rel's Where
	 * @return {string}
	 */
	relationKey(pRel, pExtra)
	{
		// Memoized by object identity (Rels and membership predicates are per-plan objects): the
		// per-row hot path (memberSet / relationIndex / memoRows) never re-hashes a Where.
		if (!this._RelationKeys)
		{
			this._RelationKeys = new WeakMap();
		}
		let tmpByExtra = this._RelationKeys.get(pRel);
		if (!tmpByExtra)
		{
			tmpByExtra = new Map();
			this._RelationKeys.set(pRel, tmpByExtra);
		}
		let tmpExtraKey = pExtra || NO_EXTRA;
		let tmpKey = tmpByExtra.get(tmpExtraKey);
		if (typeof(tmpKey) === 'string')
		{
			return tmpKey;
		}
		let tmpClient = Array.isArray(pRel.Client) ? pRel.Client.map((pConjunct) => { return pConjunct.Id; }).join(',') : '';
		tmpKey = [ pRel.Entity, pRel.Scope || 'Inherit', tmpClient, pRel.SoftDelete || 'Explicit', this.whereHash(this.combineWhere(pRel.Where || null, pExtra || null)) ].join('|');
		tmpByExtra.set(tmpExtraKey, tmpKey);
		return tmpKey;
	}

	/**
	 * Read (memoized) the rows of a relation, optionally narrowed by a membership predicate.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pRel - FoldIR Rel (or the pivot pseudo-Rel)
	 * @param {Record<string, any>|null} pExtra
	 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
	 */
	listRows(pContext, pRel, pExtra, fCallback)
	{
		this.ensureMemo(pContext);
		if (!pContext.Memo.HopRows)
		{
			pContext.Memo.HopRows = {};
		}
		if (!pRel || (typeof(pRel.Entity) !== 'string'))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The reference engine got a relation without an entity.'));
		}
		let tmpKey = this.relationKey(pRel, pExtra);
		if (hasOwn(pContext.Memo.HopRows, tmpKey))
		{
			return fCallback(null, pContext.Memo.HopRows[tmpKey]);
		}
		return this.readList(pContext, pRel.Entity, Array.isArray(pRel.Client) ? pRel.Client : null, this.combineWhere(pRel.Where || null, pExtra || null), pRel.Scope || 'Inherit',
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				pContext.Memo.HopRows[tmpKey] = pRows;
				return fCallback(null, pRows);
			});
	}

	/**
	 * The memoized rows of a relation (it must have been read in the prefetch pass).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pRel
	 * @param {Record<string, any>|null} pExtra
	 * @return {Array<Record<string, any>>}
	 */
	memoRows(pContext, pRel, pExtra)
	{
		let tmpKey = this.relationKey(pRel, pExtra);
		if (!pContext.Memo || !pContext.Memo.HopRows || !hasOwn(pContext.Memo.HopRows, tmpKey))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The reference engine evaluated a relation it did not read.');
		}
		return pContext.Memo.HopRows[tmpKey];
	}

	/**
	 * The SQL-equality identity of a key value: null for NULL (never equal to anything); for a column
	 * of a numeric type the number (FacetBuckets.numericValue, so '7' and 7 are equal, as the
	 * database's numeric comparison); for a text column the exact string (SQL text equality: '007' is
	 * not '7').  The registry requires both sides of an On / Correlate pair to be of the same class
	 * (CorrelateType), so typing by the inner column is exact for both.  Without a type (pNumeric
	 * undefined) a numeric-looking value compares as a number.
	 *
	 * @param {any} pValue
	 * @param {boolean} [pNumeric] - the column's type class (true numeric, false text)
	 * @return {string|null}
	 */
	equalityIdentity(pValue, pNumeric)
	{
		if ((pValue === null) || (typeof(pValue) === 'undefined'))
		{
			return null;
		}
		if (pNumeric !== false)
		{
			// A number, or a numeric literal (numeric column / SQL numeric affinity), compares as the number.
			let tmpNumber = libFacetBuckets.numericValue(pValue);
			if (tmpNumber !== null)
			{
				return `n:${tmpNumber}`;
			}
		}
		return `s:${String(pValue)}`;
	}

	/**
	 * The type class of an entity column for SQL equality: true numeric, false text, undefined when
	 * the catalog does not know the column (memoized per process: the catalog is rebuilt on reload,
	 * which rebuilds the service).
	 *
	 * @param {string} pEntity
	 * @param {string} pField
	 * @return {boolean|undefined}
	 */
	numericColumn(pEntity, pField)
	{
		if (!this._NumericColumns)
		{
			this._NumericColumns = new Map();
		}
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		let tmpModelVersion = (tmpCatalog && (typeof(tmpCatalog.modelVersion) === 'function')) ? tmpCatalog.modelVersion() : '';
		let tmpKey = `${tmpModelVersion}|${pEntity}.${pField}`;
		if (this._NumericColumns.has(tmpKey))
		{
			return this._NumericColumns.get(tmpKey);
		}
		let tmpColumn = (tmpCatalog && (typeof(tmpCatalog.column) === 'function')) ? tmpCatalog.column(pEntity, pField) : null;
		let tmpNumeric = tmpColumn ? (libFacetBuckets.isNumericType(tmpColumn.DataType) || (tmpColumn.DataType === 'Boolean')) : undefined;
		this._NumericColumns.set(tmpKey, tmpNumeric);
		return tmpNumeric;
	}

	/**
	 * The identity of a value tuple (null when any part is NULL).
	 *
	 * @param {Array<any>} pValues
	 * @param {Array<boolean|undefined>} [pNumeric] - per part, the column type class (equalityIdentity)
	 * @return {string|null}
	 */
	tupleIdentity(pValues, pNumeric)
	{
		let tmpParts = [];
		for (let i = 0; i < pValues.length; i++)
		{
			let tmpIdentity = this.equalityIdentity(pValues[i], Array.isArray(pNumeric) ? pNumeric[i] : undefined);
			if (tmpIdentity === null)
			{
				return null;
			}
			tmpParts.push(tmpIdentity);
		}
		return JSON.stringify(tmpParts);
	}

	/**
	 * The rows of a relation indexed by the identity of its inner On columns (memoized).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pRel
	 * @param {Array<string>} pInnerFields
	 * @return {Map<string, Array<Record<string, any>>>}
	 */
	relationIndex(pContext, pRel, pInnerFields)
	{
		if (!pContext.Memo.HopIndex)
		{
			pContext.Memo.HopIndex = new Map();
		}
		let tmpKey = `${this.relationKey(pRel, null)}#${pInnerFields.join(',')}`;
		let tmpIndex = pContext.Memo.HopIndex.get(tmpKey);
		if (tmpIndex)
		{
			return tmpIndex;
		}
		tmpIndex = new Map();
		let tmpRows = this.memoRows(pContext, pRel, null);
		let tmpTypes = pInnerFields.map((pField) => { return this.numericColumn(pRel.Entity, pField); });
		for (let i = 0; i < tmpRows.length; i++)
		{
			let tmpIdentity = this.tupleIdentity(pInnerFields.map((pField) => { return tmpRows[i][pField]; }), tmpTypes);
			if (tmpIdentity === null)
			{
				continue;
			}
			if (!tmpIndex.has(tmpIdentity))
			{
				tmpIndex.set(tmpIdentity, []);
			}
			tmpIndex.get(tmpIdentity).push(tmpRows[i]);
		}
		pContext.Memo.HopIndex.set(tmpKey, tmpIndex);
		return tmpIndex;
	}

	/**
	 * The primary-key identities of a relation narrowed by a membership predicate (memoized).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pRel
	 * @param {Record<string, any>} pPred
	 * @return {Set<string>}
	 */
	memberSet(pContext, pRel, pPred)
	{
		if (!pContext.Memo.HopMembers)
		{
			pContext.Memo.HopMembers = new Map();
		}
		let tmpKey = this.relationKey(pRel, pPred);
		let tmpSet = pContext.Memo.HopMembers.get(tmpKey);
		if (tmpSet)
		{
			return tmpSet;
		}
		let tmpPK = this.primaryKeyOf(pContext, pRel.Entity);
		let tmpPKNumeric = this.numericColumn(pRel.Entity, tmpPK);
		tmpSet = new Set();
		let tmpRows = this.memoRows(pContext, pRel, pPred);
		for (let i = 0; i < tmpRows.length; i++)
		{
			let tmpIdentity = this.equalityIdentity(tmpRows[i][tmpPK], tmpPKNumeric);
			if (tmpIdentity !== null)
			{
				tmpSet.add(tmpIdentity);
			}
		}
		pContext.Memo.HopMembers.set(tmpKey, tmpSet);
		return tmpSet;
	}

	/**
	 * The primary key column of an entity (the Host owns PK resolution).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pEntity
	 * @return {string}
	 */
	primaryKeyOf(pContext, pEntity)
	{
		let tmpPK = (pContext.Host && (typeof(pContext.Host.getPrimaryKey) === 'function')) ? pContext.Host.getPrimaryKey(pEntity) : null;
		if ((typeof(tmpPK) !== 'string') || (tmpPK.length < 1))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The reference engine could not resolve a primary key.');
		}
		return tmpPK;
	}

	/**
	 * A FoldPred subtree that is column-only over ONE alias, as { Alias, Pred } (Part I Pred
	 * grammar, ready for FilterAST.applyToQuery), else null.
	 *
	 * @param {Record<string, any>} pNode
	 * @return {{ Alias: string, Pred: Record<string, any> }|null}
	 */
	columnGroup(pNode)
	{
		if (!pNode || (typeof(pNode) !== 'object'))
		{
			return null;
		}
		// Memoized per node (FoldPred nodes are per-plan objects): evalPred calls this once per row,
		// and the returned Pred object is the stable identity relationKey memoizes on.
		if (!this._ColumnGroups)
		{
			this._ColumnGroups = new WeakMap();
		}
		if (this._ColumnGroups.has(pNode))
		{
			return this._ColumnGroups.get(pNode);
		}
		let tmpGroup = this._columnGroup(pNode);
		this._ColumnGroups.set(pNode, tmpGroup);
		return tmpGroup;
	}

	/**
	 * columnGroup() without the memo.
	 *
	 * @param {Record<string, any>} pNode
	 * @return {{ Alias: string, Pred: Record<string, any> }|null}
	 */
	_columnGroup(pNode)
	{
		if (pNode.Node === 'Cmp')
		{
			if ((typeof(pNode.Alias) !== 'string') || (typeof(pNode.Field) !== 'string'))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'The reference engine got a malformed column predicate.');
			}
			let tmpPred = { Field: pNode.Field, Op: pNode.Op };
			if (VALUELESS_OPS.indexOf(pNode.Op) < 0)
			{
				tmpPred.Value = pNode.Value;
			}
			return { Alias: pNode.Alias, Pred: tmpPred };
		}
		if ((pNode.Node === 'And') || (pNode.Node === 'Or'))
		{
			let tmpItems = Array.isArray(pNode.Items) ? pNode.Items : [];
			if (tmpItems.length < 1)
			{
				return null;
			}
			let tmpAlias = null;
			let tmpPreds = [];
			for (let i = 0; i < tmpItems.length; i++)
			{
				let tmpGroup = this.columnGroup(tmpItems[i]);
				if (!tmpGroup || ((tmpAlias !== null) && (tmpGroup.Alias !== tmpAlias)))
				{
					return null;
				}
				tmpAlias = tmpGroup.Alias;
				tmpPreds.push(tmpGroup.Pred);
			}
			if (tmpPreds.length === 1)
			{
				return { Alias: tmpAlias, Pred: tmpPreds[0] };
			}
			let tmpPred = {};
			tmpPred[pNode.Node] = tmpPreds;
			return { Alias: tmpAlias, Pred: tmpPred };
		}
		return null;
	}

	/**
	 * Collect every relation read a FoldPred needs (prefetch pass), in tree order.
	 *
	 * @param {Record<string, any>|null} pNode
	 * @param {Record<string, Record<string, any>>} pAliases - alias → Rel in scope
	 * @param {Array<{ Rel: Record<string, any>, Extra: Record<string, any>|null }>} pReads
	 */
	collectPred(pNode, pAliases, pReads)
	{
		if (!pNode)
		{
			return;
		}
		if ((typeof(pNode) !== 'object') || (typeof(pNode.Node) !== 'string'))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The reference engine got a malformed predicate.');
		}
		switch (pNode.Node)
		{
			case 'True':
			case 'False':
				return;
			case 'Cmp':
			case 'And':
			case 'Or':
			{
				let tmpGroup = this.columnGroup(pNode);
				if (tmpGroup)
				{
					if (!hasOwn(pAliases, tmpGroup.Alias))
					{
						throw libFacetErrors.create('FACET_INTERNAL', 'A column predicate names an alias that is not in scope.');
					}
					pReads.push({ Rel: pAliases[tmpGroup.Alias], Extra: tmpGroup.Pred });
					return;
				}
				let tmpItems = Array.isArray(pNode.Items) ? pNode.Items : [];
				for (let i = 0; i < tmpItems.length; i++)
				{
					this.collectPred(tmpItems[i], pAliases, pReads);
				}
				return;
			}
			case 'Exists':
			case 'NotExists':
			case 'CountCmp':
			{
				this.checkExistence(pNode, pAliases);
				pReads.push({ Rel: pNode.Rel, Extra: null });
				this.collectPred(pNode.Where || null, this.withAlias(pAliases, pNode.Rel), pReads);
				return;
			}
			default:
				throw libFacetErrors.create('FACET_INTERNAL', 'The reference engine got an unknown predicate node.');
		}
	}

	/**
	 * Validate an existence node's shape (Rel with an alias, On pairs whose outer aliases are in scope).
	 *
	 * @param {Record<string, any>} pNode
	 * @param {Record<string, Record<string, any>>} pAliases
	 */
	checkExistence(pNode, pAliases)
	{
		if (!pNode.Rel || (typeof(pNode.Rel.Entity) !== 'string') || (typeof(pNode.Rel.As) !== 'string'))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'An existence predicate has no relation.');
		}
		let tmpOn = Array.isArray(pNode.On) ? pNode.On : [];
		if (tmpOn.length < 1)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'An existence predicate has no On pairs.');
		}
		for (let i = 0; i < tmpOn.length; i++)
		{
			if (!tmpOn[i] || !tmpOn[i].Outer || !hasOwn(pAliases, tmpOn[i].Outer.Alias) || (typeof(tmpOn[i].Inner) !== 'string'))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'An existence predicate correlates an alias that is not in scope.');
			}
		}
		if ((pNode.Node === 'CountCmp') && ((COUNT_OPERATORS.indexOf(pNode.Op) < 0) || (typeof(pNode.N) !== 'number')))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A HavingCount predicate is malformed.');
		}
	}

	/**
	 * A copy of an alias map with one more Rel.
	 *
	 * @param {Record<string, Record<string, any>>} pAliases
	 * @param {Record<string, any>} pRel
	 * @return {Record<string, Record<string, any>>}
	 */
	withAlias(pAliases, pRel)
	{
		let tmpAliases = Object.assign({}, pAliases);
		tmpAliases[pRel.As] = pRel;
		return tmpAliases;
	}

	/**
	 * Collect the reads of an Agg's dimensions (Via links, Multi chains and their Where, ChildAgg
	 * children and their Where, ExistsFlag predicates).
	 *
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, Record<string, any>>} pAliases
	 * @param {Array<Record<string, any>>} pReads
	 */
	collectDimensions(pAgg, pAliases, pReads)
	{
		let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
		for (let i = 0; i < tmpDimensions.length; i++)
		{
			let tmpDimension = tmpDimensions[i];
			if (!tmpDimension)
			{
				continue;
			}
			if (Array.isArray(tmpDimension.Via))
			{
				let tmpAliases = pAliases;
				for (let j = 0; j < tmpDimension.Via.length; j++)
				{
					let tmpLink = tmpDimension.Via[j];
					this.checkExistence({ Node: 'Exists', Rel: tmpLink.Rel, On: tmpLink.On }, tmpAliases);
					pReads.push({ Rel: tmpLink.Rel, Extra: null });
					tmpAliases = this.withAlias(tmpAliases, tmpLink.Rel);
				}
			}
			switch (tmpDimension.Kind)
			{
				case 'Multi':
				{
					let tmpChain = Array.isArray(tmpDimension.Chain) ? tmpDimension.Chain : [];
					if (tmpChain.length < 1)
					{
						throw libFacetErrors.create('FACET_INTERNAL', 'A multi-valued dimension has no chain.');
					}
					let tmpAliases = pAliases;
					for (let j = 0; j < tmpChain.length; j++)
					{
						this.checkExistence({ Node: 'Exists', Rel: tmpChain[j].Rel, On: tmpChain[j].On }, tmpAliases);
						pReads.push({ Rel: tmpChain[j].Rel, Extra: null });
						tmpAliases = this.withAlias(tmpAliases, tmpChain[j].Rel);
					}
					this.collectPred(tmpDimension.Where || null, tmpAliases, pReads);
					break;
				}
				case 'ChildAgg':
					this.checkExistence({ Node: 'Exists', Rel: tmpDimension.Rel, On: tmpDimension.On }, pAliases);
					pReads.push({ Rel: tmpDimension.Rel, Extra: null });
					this.collectPred(tmpDimension.Where || null, this.withAlias(pAliases, tmpDimension.Rel), pReads);
					break;
				case 'ExistsFlag':
					this.collectPred(tmpDimension.Pred || null, pAliases, pReads);
					break;
				default:
					break;
			}
		}
	}

	/**
	 * Perform the collected reads, one at a time, in order (memoized); record each hop's fingerprint.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Array<{ Rel: Record<string, any>, Extra: Record<string, any>|null }>} pReads
	 * @param {Record<string, any>} pFingerprints
	 * @param {(pError?: Error) => void} fCallback
	 */
	performReads(pContext, pReads, pFingerprints, fCallback)
	{
		this.fable.Utility.eachLimit(pReads, 1,
			(pRead, fNextRead) =>
			{
				this.listRows(pContext, pRead.Rel, pRead.Extra,
					(pError) =>
					{
						if (pError)
						{
							return fNextRead(pError);
						}
						if ((pRead.Rel.Role !== 'Pivot') && (pRead.Rel.As !== 'p'))
						{
							this.addFingerprint(pFingerprints, pRead.Rel.Entity, null, `ref:hop:${pRead.Rel.Entity}|${pRead.Rel.Scope || 'Inherit'}|${this.whereHash(pRead.Rel.Where || null)}`);
						}
						return fNextRead();
					});
			},
			(pError) =>
			{
				return fCallback(pError || null);
			});
	}

	/**
	 * Bind a related row to its alias (a new environment; environments are never mutated).
	 *
	 * @param {Record<string, any>} pEnv - alias → { Rel, Row }
	 * @param {Record<string, any>} pRel
	 * @param {Record<string, any>} pRow
	 * @return {Record<string, any>}
	 */
	extendEnv(pEnv, pRel, pRow)
	{
		let tmpEnv = Object.assign({}, pEnv);
		tmpEnv[pRel.As] = { Rel: pRel, Row: pRow };
		return tmpEnv;
	}

	/**
	 * The related rows of an existence-shaped node for one environment: On pairs equal (SQL
	 * equality), then the nested Where.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {{ Rel: Record<string, any>, On: Array<Record<string, any>>, Where?: Record<string, any>|null }} pNode
	 * @param {Record<string, any>} pEnv
	 * @param {boolean} [pFirstOnly] - stop at the first match (Exists)
	 * @return {Array<Record<string, any>>}
	 */
	relatedRows(pContext, pNode, pEnv, pFirstOnly)
	{
		let tmpOn = pNode.On;
		let tmpOuter = [];
		for (let i = 0; i < tmpOn.length; i++)
		{
			let tmpBinding = pEnv[tmpOn[i].Outer.Alias];
			if (!tmpBinding)
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'An existence predicate correlates an unbound alias.');
			}
			tmpOuter.push(tmpBinding.Row[tmpOn[i].Outer.Field]);
		}
		// Both sides of a pair share the inner column's type class (CorrelateType at load).
		let tmpIdentity = this.tupleIdentity(tmpOuter, tmpOn.map((pPair) => { return this.numericColumn(pNode.Rel.Entity, pPair.Inner); }));
		if (tmpIdentity === null)
		{
			return [];
		}
		let tmpIndex = this.relationIndex(pContext, pNode.Rel, tmpOn.map((pPair) => { return pPair.Inner; }));
		let tmpCandidates = tmpIndex.get(tmpIdentity) || [];
		if (!pNode.Where)
		{
			return pFirstOnly ? tmpCandidates.slice(0, 1) : tmpCandidates;
		}
		let tmpMatches = [];
		for (let i = 0; i < tmpCandidates.length; i++)
		{
			if (this.evalPred(pContext, pNode.Where, this.extendEnv(pEnv, pNode.Rel, tmpCandidates[i])))
			{
				tmpMatches.push(tmpCandidates[i]);
				if (pFirstOnly)
				{
					break;
				}
			}
		}
		return tmpMatches;
	}

	/**
	 * Evaluate a FoldPred for one environment (internal-contracts §24.2, §27.2).  There is no
	 * negation over column predicates (Not is pushed down at load), so SQL UNKNOWN collapses to false.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>|null} pNode
	 * @param {Record<string, any>} pEnv
	 * @return {boolean}
	 */
	evalPred(pContext, pNode, pEnv)
	{
		if (!pNode)
		{
			return true;
		}
		switch (pNode.Node)
		{
			case 'True':
				return true;
			case 'False':
				return false;
			case 'Cmp':
			case 'And':
			case 'Or':
			{
				let tmpGroup = this.columnGroup(pNode);
				if (tmpGroup)
				{
					let tmpBinding = pEnv[tmpGroup.Alias];
					if (!tmpBinding)
					{
						throw libFacetErrors.create('FACET_INTERNAL', 'A column predicate names an unbound alias.');
					}
					let tmpBindingPK = this.primaryKeyOf(pContext, tmpBinding.Rel.Entity);
					let tmpIdentity = this.equalityIdentity(tmpBinding.Row[tmpBindingPK], this.numericColumn(tmpBinding.Rel.Entity, tmpBindingPK));
					return (tmpIdentity !== null) && this.memberSet(pContext, tmpBinding.Rel, tmpGroup.Pred).has(tmpIdentity);
				}
				let tmpItems = Array.isArray(pNode.Items) ? pNode.Items : [];
				if (pNode.Node === 'And')
				{
					return tmpItems.every((pItem) => { return this.evalPred(pContext, pItem, pEnv); });
				}
				return tmpItems.some((pItem) => { return this.evalPred(pContext, pItem, pEnv); });
			}
			case 'Exists':
				return (this.relatedRows(pContext, pNode, pEnv, true).length > 0);
			case 'NotExists':
				return (this.relatedRows(pContext, pNode, pEnv, true).length < 1);
			case 'CountCmp':
				return this.compareCount(this.relatedRows(pContext, pNode, pEnv, false).length, pNode.Op, pNode.N);
			default:
				throw libFacetErrors.create('FACET_INTERNAL', 'The reference engine got an unknown predicate node.');
		}
	}

	/**
	 * (count) Op N.
	 *
	 * @param {number} pCount
	 * @param {string} pOp
	 * @param {number} pN
	 * @return {boolean}
	 */
	compareCount(pCount, pOp, pN)
	{
		switch (pOp)
		{
			case 'EQ':
				return pCount === pN;
			case 'NE':
				return pCount !== pN;
			case 'GT':
				return pCount > pN;
			case 'GE':
				return pCount >= pN;
			case 'LT':
				return pCount < pN;
			case 'LE':
				return pCount <= pN;
			default:
				throw libFacetErrors.create('FACET_INTERNAL', 'A HavingCount predicate has an unknown operator.');
		}
	}

	/**
	 * The ChildRollup band of a child count (01 §4.6): 0 below Edges[0] (no visible child), band i
	 * for [Edges[i−1], Edges[i]), the last band open.
	 *
	 * @param {number} pCount
	 * @param {Array<number>} pEdges
	 * @return {number}
	 */
	bandOf(pCount, pEdges)
	{
		let tmpBand = 0;
		for (let i = 0; i < pEdges.length; i++)
		{
			if (pCount >= pEdges[i])
			{
				tmpBand = i + 1;
			}
		}
		return tmpBand;
	}

	/**
	 * Read and filter the base environments of an entity pivot under a Variant: the pivot's list rows
	 * (Column conjuncts fenced), kept where Variant.PathPred holds.  Memoized per Variant.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pVariantKey - memo key (VariantId or a base-plan marker)
	 * @param {Record<string, any>} pVariant
	 * @param {string} pPivot
	 * @param {Record<string, any>} pFingerprints
	 * @param {(pError?: Error, pEnvs?: Array<Record<string, any>>, pPivotRel?: Record<string, any>) => void} fCallback
	 */
	variantEnvs(pContext, pVariantKey, pVariant, pPivot, pFingerprints, fCallback)
	{
		this.ensureMemo(pContext);
		if (!pContext.Memo.VariantEnvs)
		{
			pContext.Memo.VariantEnvs = new Map();
		}
		let tmpPivotRel = this.pivotRel(pContext, pVariant, pPivot);
		let tmpMemoKey = `${this.relationKey(tmpPivotRel, null)}|${pVariantKey}`;
		if (pContext.Memo.VariantEnvs.has(tmpMemoKey))
		{
			return fCallback(null, pContext.Memo.VariantEnvs.get(tmpMemoKey), tmpPivotRel);
		}
		let tmpReads = [ { Rel: tmpPivotRel, Extra: null } ];
		let tmpAliases = { p: tmpPivotRel };
		try
		{
			this.collectPred(pVariant.PathPred || null, tmpAliases, tmpReads);
		}
		catch (pCollectError)
		{
			return fCallback(pCollectError);
		}
		this.performReads(pContext, tmpReads, pFingerprints,
			(pReadError) =>
			{
				if (pReadError)
				{
					return fCallback(pReadError);
				}
				let tmpEnvs = [];
				try
				{
					let tmpRows = this.memoRows(pContext, tmpPivotRel, null);
					for (let i = 0; i < tmpRows.length; i++)
					{
						let tmpEnv = { p: { Rel: tmpPivotRel, Row: tmpRows[i] } };
						if (!pVariant.PathPred || this.evalPred(pContext, pVariant.PathPred, tmpEnv))
						{
							tmpEnvs.push(tmpEnv);
						}
					}
				}
				catch (pEvalError)
				{
					return fCallback(pEvalError);
				}
				pContext.Memo.VariantEnvs.set(tmpMemoKey, tmpEnvs);
				return fCallback(null, tmpEnvs, tmpPivotRel);
			});
	}

	/**
	 * Execute the Aggs of one Variant through the cross-entity interpreter.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pVariantId
	 * @param {Record<string, any>} pVariant
	 * @param {Array<Record<string, any>>} pAggs
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pFingerprints
	 * @param {(pError?: Error) => void} fNext
	 */
	executeCrossEntity(pContext, pVariantId, pVariant, pAggs, pExecution, pFingerprints, fNext)
	{
		let tmpPivot = pVariant.Entity || pContext.Entity;
		// The Variant's own predicates first: their failure fails the whole request.
		this.variantEnvs(pContext, pVariantId, pVariant, tmpPivot, pFingerprints,
			(pVariantError, pEnvs, pPivotRel) =>
			{
				if (pVariantError)
				{
					return fNext(pVariantError);
				}
				this.addFingerprint(pFingerprints, tmpPivot, pVariantId, `ref:${(typeof(pVariant.Hash) === 'string') ? pVariant.Hash : ''}`);
				this.fable.Utility.eachLimit(pAggs, 1,
					(pAgg, fNextAgg) =>
					{
						if ((typeof(pContext.Deadline) === 'number') && (Date.now() > pContext.Deadline))
						{
							pExecution.Errors[pAgg.Key] = libFacetErrors.toEntry(libFacetErrors.create('FACET_TIMEOUT'));
							return fNextAgg();
						}
						this.foldCrossEntity(pContext, pVariant, pAgg, pEnvs, pPivotRel, pFingerprints,
							(pAggError, pRaw) =>
							{
								if (pAggError)
								{
									if (pAggError.Code === 'FACET_UNAUTHENTICATED')
									{
										// A behavior 401 is never a per-facet answer (fail closed, as M1).
										return fNextAgg(pAggError);
									}
									pExecution.Errors[pAgg.Key] = this.foldErrorEntry(pAgg, pAggError);
									return fNextAgg();
								}
								pRaw.VariantId = pVariantId;
								pExecution.Results[pAgg.Key] = pRaw;
								return fNextAgg();
							});
					},
					(pError) =>
					{
						return fNext(pError || null);
					});
			});
	}

	/**
	 * Fold one cross-entity Agg over the Variant's base environments: prefetch its relations, keep
	 * the environments where Agg.Where holds (TuplePivot: build the tuple environments first), then
	 * fold its dimensions.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pVariant
	 * @param {Record<string, any>} pAgg
	 * @param {Array<Record<string, any>>} pEnvs - the Variant's entity-pivot environments
	 * @param {Record<string, any>} pPivotRel
	 * @param {Record<string, any>} pFingerprints
	 * @param {(pError?: Error, pRaw?: Record<string, any>) => void} fCallback
	 */
	foldCrossEntity(pContext, pVariant, pAgg, pEnvs, pPivotRel, pFingerprints, fCallback)
	{
		// The definition Where (W_def): the Agg's own, else the one its Variant shares (§24.6: facets
		// group by WhereHash, so the two are the same tree when both are set).
		let tmpWhere = pAgg.Where || pVariant.Where || null;
		let tmpReads = [];
		let tmpAliases;
		let tmpSides = null;
		try
		{
			if (FOLD_KINDS.indexOf(pAgg.Kind) < 0)
			{
				throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', 'The reference engine cannot fold this kind.', { Feature: String(pAgg.Kind), Milestone: 2 });
			}
			if (pAgg.Tuple)
			{
				tmpSides = this.tupleSides(pVariant, pAgg);
				tmpAliases = {};
				for (let i = 0; i < tmpSides.length; i++)
				{
					tmpAliases[tmpSides[i].Alias] = tmpSides[i].Rel;
					tmpReads.push({ Rel: tmpSides[i].Rel, Extra: null });
				}
				// The Variant's path predicates apply to the Home side ('p') unchanged.
				this.collectPred(pVariant.PathPred || null, tmpAliases, tmpReads);
			}
			else
			{
				tmpAliases = { p: pPivotRel };
			}
			this.collectPred(tmpWhere, tmpAliases, tmpReads);
			this.collectDimensions(pAgg, tmpAliases, tmpReads);
		}
		catch (pCollectError)
		{
			return fCallback(pCollectError);
		}
		this.performReads(pContext, tmpReads, pFingerprints,
			(pReadError) =>
			{
				if (pReadError)
				{
					return fCallback(pReadError);
				}
				let tmpRaw;
				try
				{
					let tmpEnvs = pEnvs;
					if (tmpSides)
					{
						tmpEnvs = this.tupleEnvs(pContext, pVariant, pAgg, tmpSides);
						if (pVariant.PathPred)
						{
							tmpEnvs = tmpEnvs.filter((pEnv) => { return this.evalPred(pContext, pVariant.PathPred, pEnv); });
						}
					}
					if (tmpWhere)
					{
						tmpEnvs = tmpEnvs.filter((pEnv) => { return this.evalPred(pContext, tmpWhere, pEnv); });
					}
					if (tmpSides)
					{
						tmpEnvs = this.distinctTuples(pAgg, tmpEnvs);
					}
					tmpRaw = this.foldEnvs(pContext, pAgg, tmpEnvs);
				}
				catch (pFoldError)
				{
					return fCallback(pFoldError);
				}
				return fCallback(null, tmpRaw);
			});
	}

	/**
	 * The sides of a TuplePivot with their effective Rels: the Home side ('p') reads with the
	 * Variant's Column conjuncts as its client fence (internal-contracts §24.4).
	 *
	 * @param {Record<string, any>} pVariant
	 * @param {Record<string, any>} pAgg
	 * @return {Array<{ Name: string, Alias: string, Rel: Record<string, any> }>}
	 */
	tupleSides(pVariant, pAgg)
	{
		let tmpTuple = pAgg.Tuple;
		let tmpSides = Array.isArray(tmpTuple.Sides) ? tmpTuple.Sides : [];
		if ((tmpSides.length < 2) || !tmpSides.some((pSide) => { return pSide && (pSide.Alias === 'p'); }))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A tuple pivot needs a Home side and at least one other side.');
		}
		return tmpSides.map(
			(pSide) =>
			{
				if (!pSide || !pSide.Rel || (typeof(pSide.Alias) !== 'string'))
				{
					throw libFacetErrors.create('FACET_INTERNAL', 'A tuple side is malformed.');
				}
				let tmpRel = Object.assign({}, pSide.Rel, { As: pSide.Alias });
				tmpRel.Client = (pSide.Alias === 'p') ? this.columnConjuncts(pVariant) : null;
				if (pSide.Alias === 'p')
				{
					tmpRel.SoftDelete = pVariant.IncludesDeleted ? 'ClientControlled' : 'Explicit';
				}
				return { Name: pSide.Name, Alias: pSide.Alias, Rel: tmpRel };
			});
	}

	/**
	 * The joined environments of a TuplePivot: the Home side's rows, each other side hash-joined on
	 * the On pairs that connect it to an already-bound side (SQL equality).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pVariant
	 * @param {Record<string, any>} pAgg
	 * @param {Array<Record<string, any>>} pSides
	 * @return {Array<Record<string, any>>}
	 */
	tupleEnvs(pContext, pVariant, pAgg, pSides)
	{
		let tmpOn = Array.isArray(pAgg.Tuple.On) ? pAgg.Tuple.On : [];
		let tmpHome = pSides.find((pSide) => { return pSide.Alias === 'p'; });
		let tmpEnvs = this.memoRows(pContext, tmpHome.Rel, null).map((pRow) => { return { p: { Rel: tmpHome.Rel, Row: pRow } }; });
		let tmpBound = new Set([ 'p' ]);
		let tmpPending = pSides.filter((pSide) => { return pSide.Alias !== 'p'; });
		while (tmpPending.length > 0)
		{
			let tmpNextIndex = -1;
			let tmpPairs = null;
			for (let i = 0; i < tmpPending.length; i++)
			{
				let tmpAlias = tmpPending[i].Alias;
				let tmpConnecting = [];
				for (let j = 0; j < tmpOn.length; j++)
				{
					let tmpPair = tmpOn[j];
					if ((tmpPair.Left.Alias === tmpAlias) && tmpBound.has(tmpPair.Right.Alias))
					{
						tmpConnecting.push({ Inner: tmpPair.Left.Field, Outer: tmpPair.Right });
					}
					else if ((tmpPair.Right.Alias === tmpAlias) && tmpBound.has(tmpPair.Left.Alias))
					{
						tmpConnecting.push({ Inner: tmpPair.Right.Field, Outer: tmpPair.Left });
					}
				}
				if (tmpConnecting.length > 0)
				{
					tmpNextIndex = i;
					tmpPairs = tmpConnecting;
					break;
				}
			}
			if (tmpNextIndex < 0)
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'A tuple side is not joined to the other sides.');
			}
			let tmpSide = tmpPending.splice(tmpNextIndex, 1)[0];
			let tmpNode = { Rel: tmpSide.Rel, On: tmpPairs.map((pPair) => { return { Outer: pPair.Outer, Inner: pPair.Inner }; }), Where: null };
			let tmpJoined = [];
			for (let i = 0; i < tmpEnvs.length; i++)
			{
				let tmpMatches = this.relatedRows(pContext, tmpNode, tmpEnvs[i], false);
				for (let j = 0; j < tmpMatches.length; j++)
				{
					tmpJoined.push(this.extendEnv(tmpEnvs[i], tmpSide.Rel, tmpMatches[j]));
				}
			}
			tmpEnvs = tmpJoined;
			tmpBound.add(tmpSide.Alias);
		}
		return tmpEnvs;
	}

	/**
	 * Distinct tuples by Key (the first environment of each tuple is kept; dimensions are functions
	 * of the Key, so any one is representative).
	 *
	 * @param {Record<string, any>} pAgg
	 * @param {Array<Record<string, any>>} pEnvs
	 * @return {Array<Record<string, any>>}
	 */
	distinctTuples(pAgg, pEnvs)
	{
		let tmpKey = Array.isArray(pAgg.Tuple.Key) ? pAgg.Tuple.Key : [];
		if (tmpKey.length < 1)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A tuple pivot has no Key.');
		}
		let tmpSeen = new Set();
		let tmpDistinct = [];
		for (let i = 0; i < pEnvs.length; i++)
		{
			let tmpValues = tmpKey.map((pPart) => { return pEnvs[i][pPart.Alias] ? pEnvs[i][pPart.Alias].Row[pPart.Field] : null; });
			// A Key part that is NULL is still a tuple (SELECT DISTINCT keeps NULLs as one value).
			let tmpIdentity = JSON.stringify(tmpValues.map((pValue, pIndex) =>
			{
				let tmpPart = tmpKey[pIndex];
				let tmpEntity = (pEnvs[i][tmpPart.Alias] && pEnvs[i][tmpPart.Alias].Rel) ? pEnvs[i][tmpPart.Alias].Rel.Entity : null;
				return ((pValue === null) || (typeof(pValue) === 'undefined')) ? null : this.equalityIdentity(pValue, tmpEntity ? this.numericColumn(tmpEntity, tmpPart.Field) : undefined);
			}));
			if (tmpSeen.has(tmpIdentity))
			{
				continue;
			}
			tmpSeen.add(tmpIdentity);
			tmpDistinct.push(pEnvs[i]);
		}
		return tmpDistinct;
	}

	/**
	 * The value of a single-valued dimension for one environment: the dimension's alias's column, or
	 * the Field of the LAST Via link (NULL when any link has no visible row; more than one is a
	 * planner bug).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pDimension
	 * @param {Record<string, any>} pEnv
	 * @return {any}
	 */
	dimensionValue(pContext, pDimension, pEnv)
	{
		if (Array.isArray(pDimension.Via) && (pDimension.Via.length > 0))
		{
			let tmpEnv = pEnv;
			let tmpRow = null;
			for (let i = 0; i < pDimension.Via.length; i++)
			{
				let tmpLink = pDimension.Via[i];
				let tmpMatches = this.relatedRows(pContext, { Rel: tmpLink.Rel, On: tmpLink.On, Where: null }, tmpEnv, false);
				if (tmpMatches.length < 1)
				{
					return null;
				}
				if (tmpMatches.length > 1)
				{
					throw libFacetErrors.create('FACET_INTERNAL', 'A to-one dimension path reached more than one row.');
				}
				tmpRow = tmpMatches[0];
				tmpEnv = this.extendEnv(tmpEnv, tmpLink.Rel, tmpRow);
			}
			return tmpRow[pDimension.Field];
		}
		let tmpAlias = (typeof(pDimension.Alias) === 'string') ? pDimension.Alias : 'p';
		if (!pEnv[tmpAlias])
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A dimension reads an unbound alias.');
		}
		return pEnv[tmpAlias].Row[pDimension.Field];
	}

	/**
	 * Fold an Agg over environments (internal-contracts §24.9).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pAgg
	 * @param {Array<Record<string, any>>} pEnvs
	 * @return {Record<string, any>} RawFacetResult
	 */
	foldEnvs(pContext, pAgg, pEnvs)
	{
		let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
		let tmpFirst = (tmpDimensions.length > 0) ? tmpDimensions[0] : null;
		if (tmpFirst && (tmpFirst.Kind === 'Multi'))
		{
			return this.foldMulti(pContext, pAgg, tmpFirst, pEnvs);
		}
		if (pAgg.Kind === 'ChildRollup')
		{
			return this.foldChildRollup(pContext, pAgg, tmpFirst, pEnvs);
		}
		if (pAgg.Kind === 'ExistsSplit')
		{
			return this.foldExistsSplit(pContext, pAgg, tmpFirst, pEnvs);
		}
		for (let i = 0; i < tmpDimensions.length; i++)
		{
			if (tmpDimensions[i] && (CROSS_ENTITY_DIMENSIONS.indexOf(tmpDimensions[i].Kind) >= 0))
			{
				// Multi / ChildAgg / ExistsFlag axes of a Pivot are refused at load (§20.5).
				throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', 'This dimension cannot be a pivot axis.', { Feature: `PivotAxis:${tmpDimensions[i].Kind}`, Milestone: 2 });
			}
		}
		// Single-valued dimensions: project each environment onto a virtual record and fold it with
		// the single-entity folds (identical key math).
		let tmpVirtualAgg = Object.assign({}, pAgg);
		tmpVirtualAgg.Dimensions = tmpDimensions.map((pDimension, pIndex) => { return Object.assign({}, pDimension, { Field: `#d${pIndex}` }); });
		let tmpMeasured = (typeof(pAgg.Field) === 'string') && ([ 'Stats', 'DistinctCount', 'Missing' ].indexOf(pAgg.Kind) >= 0);
		if (tmpMeasured)
		{
			tmpVirtualAgg.Field = '#m';
			tmpVirtualAgg.FieldInfo = Object.assign({}, pAgg.FieldInfo || {}, { Column: '#m' });
		}
		let tmpRecords = new Array(pEnvs.length);
		for (let i = 0; i < pEnvs.length; i++)
		{
			let tmpRecord = {};
			for (let j = 0; j < tmpDimensions.length; j++)
			{
				tmpRecord[`#d${j}`] = this.dimensionValue(pContext, tmpDimensions[j], pEnvs[i]);
			}
			if (tmpMeasured)
			{
				tmpRecord['#m'] = (tmpFirst && Array.isArray(tmpFirst.Via) && (tmpFirst.Via.length > 0))
					? tmpRecord['#d0']
					: this.dimensionValue(pContext, { Alias: (tmpFirst && tmpFirst.Alias) ? tmpFirst.Alias : 'p', Field: pAgg.Field }, pEnvs[i]);
			}
			tmpRecords[i] = tmpRecord;
		}
		return this.fold(tmpVirtualAgg, tmpRecords);
	}

	/**
	 * An empty RawFacetResult for an Agg.
	 *
	 * @param {Record<string, any>} pAgg
	 * @param {number} pTotal
	 * @return {Record<string, any>}
	 */
	emptyRaw(pAgg, pTotal)
	{
		return (
			{
				Key: pAgg.Key,
				Kind: pAgg.Kind,
				VariantId: pAgg.VariantId || null,
				Total: pTotal,
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
	 * K9 BridgeTerms: the distinct keys of every visible chain per pivot row; Groups count distinct
	 * pivot rows per key, MissingCount the pivot rows with no (non-null) key.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pDimension - Kind 'Multi'
	 * @param {Array<Record<string, any>>} pEnvs
	 * @return {Record<string, any>}
	 */
	foldMulti(pContext, pAgg, pDimension, pEnvs)
	{
		let tmpRaw = this.emptyRaw(pAgg, pEnvs.length);
		let tmpChain = pDimension.Chain;
		let tmpDataType = pDimension.DataType || 'Numeric';
		let tmpMap = new Map();
		let fWalk = (pIndex, pEnv, pKeys) =>
		{
			let tmpLink = tmpChain[pIndex];
			let tmpLast = (pIndex === tmpChain.length - 1);
			let tmpMatches = this.relatedRows(pContext, { Rel: tmpLink.Rel, On: tmpLink.On, Where: tmpLast ? (pDimension.Where || null) : null }, pEnv, false);
			for (let i = 0; i < tmpMatches.length; i++)
			{
				if (tmpLast)
				{
					let tmpKey = this.valueKey(tmpMatches[i][pDimension.KeyField], tmpDataType);
					if (tmpKey !== null)
					{
						pKeys.set(this.keyIdentity(tmpKey), tmpKey);
					}
				}
				else
				{
					fWalk(pIndex + 1, this.extendEnv(pEnv, tmpLink.Rel, tmpMatches[i]), pKeys);
				}
			}
		};
		for (let i = 0; i < pEnvs.length; i++)
		{
			let tmpKeys = new Map();
			fWalk(0, pEnvs[i], tmpKeys);
			if (tmpKeys.size < 1)
			{
				tmpRaw.MissingCount++;
				continue;
			}
			tmpKeys.forEach((pKey) => { this.countKey(tmpMap, pKey); });
		}
		tmpRaw.Groups = this.canonicalGroups(tmpMap);
		tmpRaw.DistinctKeys = tmpMap.size;
		return tmpRaw;
	}

	/**
	 * K12 ChildRollup: the number of visible matching children per pivot row → band.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pDimension - Kind 'ChildAgg'
	 * @param {Array<Record<string, any>>} pEnvs
	 * @return {Record<string, any>}
	 */
	foldChildRollup(pContext, pAgg, pDimension, pEnvs)
	{
		if (!pDimension || (pDimension.Kind !== 'ChildAgg') || !Array.isArray(pDimension.Edges) || (pDimension.Edges.length < 1))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A child rollup needs a ChildAgg dimension with Edges.');
		}
		if ((pDimension.Agg || 'count') !== 'count')
		{
			throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', 'Only count child rollups are supported.', { Feature: 'ChildRollupAgg', Milestone: 2 });
		}
		let tmpRaw = this.emptyRaw(pAgg, pEnvs.length);
		let tmpMap = new Map();
		let tmpNode = { Rel: pDimension.Rel, On: pDimension.On, Where: pDimension.Where || null };
		for (let i = 0; i < pEnvs.length; i++)
		{
			this.countKey(tmpMap, this.bandOf(this.relatedRows(pContext, tmpNode, pEnvs[i], false).length, pDimension.Edges));
		}
		tmpRaw.Groups = this.keyOrderedGroups(tmpMap);
		return tmpRaw;
	}

	/**
	 * K20 ExistsSplit: 1 when the existence predicate holds for the pivot row, else 0.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pDimension - Kind 'ExistsFlag'
	 * @param {Array<Record<string, any>>} pEnvs
	 * @return {Record<string, any>}
	 */
	foldExistsSplit(pContext, pAgg, pDimension, pEnvs)
	{
		if (!pDimension || (pDimension.Kind !== 'ExistsFlag') || !pDimension.Pred)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'An exists split needs an ExistsFlag dimension.');
		}
		let tmpRaw = this.emptyRaw(pAgg, pEnvs.length);
		let tmpYes = 0;
		for (let i = 0; i < pEnvs.length; i++)
		{
			if (this.evalPred(pContext, pDimension.Pred, pEnvs[i]))
			{
				tmpYes++;
			}
		}
		let tmpNo = pEnvs.length - tmpYes;
		if (tmpYes > 0)
		{
			tmpRaw.Groups.push({ Key: 1, Count: tmpYes });
		}
		if (tmpNo > 0)
		{
			tmpRaw.Groups.push({ Key: 0, Count: tmpNo });
		}
		return tmpRaw;
	}

	// ------------------------------------------------------------------ Records / Count / Keys oracle (§26.5)

	/**
	 * The base environments of a Records / Count / Keys plan (v0 lowered).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pBasePlan - { Variant, Pivot, … } (Planner.planBase)
	 * @param {(pError?: Error, pEnvs?: Array<Record<string, any>>, pPivot?: string) => void} fCallback
	 */
	baseEnvs(pContext, pBasePlan, fCallback)
	{
		if (!pBasePlan || !pBasePlan.Variant)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The reference engine got a base plan without a variant.'));
		}
		let tmpVariant = pBasePlan.Variant;
		if (this.hasPathConjuncts(tmpVariant) && !tmpVariant.PathPred)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The variant has path conjuncts but no lowered path predicate.'));
		}
		let tmpPivot = pBasePlan.Pivot || tmpVariant.Entity || pContext.Entity;
		this.variantEnvs(pContext, `base:${tmpVariant.VariantId || 'v0'}`, tmpVariant, tmpPivot, Object.create(null),
			(pError, pEnvs) =>
			{
				return fCallback(pError || null, pEnvs, tmpPivot);
			});
	}

	/**
	 * Count of the base set (oracle for EngineLive.countBase).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pBasePlan
	 * @param {(pError?: Error, pCount?: number) => void} fCallback
	 */
	countBase(pContext, pBasePlan, fCallback)
	{
		this.baseEnvs(pContext, pBasePlan,
			(pError, pEnvs) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				return fCallback(null, pEnvs.length);
			});
	}

	/**
	 * A sortable form of a column value: NULL → null (always last); numbers (numeric DataTypes, and
	 * numeric literals there) before text, as SQLite orders storage classes; DateTime canonicalized.
	 *
	 * @param {any} pValue
	 * @param {string} pDataType
	 * @return {{ Class: number, Value: any }|null}
	 */
	sortValue(pValue, pDataType)
	{
		if ((pValue === null) || (typeof(pValue) === 'undefined'))
		{
			return null;
		}
		if (libFacetBuckets.isNumericType(pDataType) || (pDataType === 'Boolean'))
		{
			let tmpNumber = libFacetBuckets.numericValue(pValue);
			return (tmpNumber !== null) ? { Class: 0, Value: tmpNumber } : { Class: 1, Value: String(pValue) };
		}
		if (pDataType === 'DateTime')
		{
			let tmpCanonical = libFacetBuckets.canonicalDateTime(pValue);
			return { Class: 1, Value: (tmpCanonical !== null) ? tmpCanonical : String(pValue) };
		}
		return (typeof(pValue) === 'number') ? { Class: 0, Value: pValue } : { Class: 1, Value: String(pValue) };
	}

	/**
	 * Compare two sortable values (non-null).
	 *
	 * @param {{ Class: number, Value: any }} pA
	 * @param {{ Class: number, Value: any }} pB
	 * @return {number}
	 */
	compareSortValues(pA, pB)
	{
		if (pA.Class !== pB.Class)
		{
			return pA.Class - pB.Class;
		}
		if (pA.Value < pB.Value)
		{
			return -1;
		}
		if (pA.Value > pB.Value)
		{
			return 1;
		}
		return 0;
	}

	/**
	 * Primary keys of the base set in the Records order: each Sort field with NULLs last in both
	 * directions, the primary key ascending as the final tie-break (internal-contracts §26.5, §36.31);
	 * then [Begin, Begin + Cap).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pBasePlan
	 * @param {{ Sort?: Array<{ Field: string, Dir?: string }>, Begin?: number, Cap?: number }} pOptions
	 * @param {(pError?: Error, pResult?: { Keys: Array<any>, Statements: number }) => void} fCallback
	 */
	recordKeys(pContext, pBasePlan, pOptions, fCallback)
	{
		let tmpOptions = pOptions || {};
		this.ensureMemo(pContext);
		let tmpStatementsBefore = pContext.Counters.Statements;
		this.baseEnvs(pContext, pBasePlan,
			(pError, pEnvs, pPivot) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpKeys;
				try
				{
					let tmpPK = this.primaryKeyOf(pContext, pPivot);
					let tmpSort = Array.isArray(tmpOptions.Sort) ? tmpOptions.Sort : [];
					let tmpCatalog = this.fable.RetoldFacetingCatalog;
					let tmpTypes = tmpSort.map(
						(pSort) =>
						{
							let tmpColumn = (tmpCatalog && (typeof(tmpCatalog.column) === 'function')) ? tmpCatalog.column(pPivot, pSort.Field) : null;
							return tmpColumn ? tmpColumn.DataType : 'String';
						});
					let tmpRows = pEnvs.map((pEnv) => { return pEnv.p.Row; });
					tmpRows.sort(
						(pA, pB) =>
						{
							for (let i = 0; i < tmpSort.length; i++)
							{
								let tmpA = this.sortValue(pA[tmpSort[i].Field], tmpTypes[i]);
								let tmpB = this.sortValue(pB[tmpSort[i].Field], tmpTypes[i]);
								if ((tmpA === null) || (tmpB === null))
								{
									if ((tmpA === null) && (tmpB === null))
									{
										continue;
									}
									return (tmpA === null) ? 1 : -1;
								}
								let tmpOrder = this.compareSortValues(tmpA, tmpB);
								if (tmpOrder !== 0)
								{
									return (String(tmpSort[i].Dir).toUpperCase() === 'DESC') ? -tmpOrder : tmpOrder;
								}
							}
							return this.compareSortValues(this.sortValue(pA[tmpPK], 'ID'), this.sortValue(pB[tmpPK], 'ID'));
						});
					let tmpBegin = (typeof(tmpOptions.Begin) === 'number') ? tmpOptions.Begin : 0;
					let tmpCap = (typeof(tmpOptions.Cap) === 'number') ? tmpOptions.Cap : tmpRows.length;
					tmpKeys = tmpRows.slice(tmpBegin, tmpBegin + tmpCap).map((pRow) => { return pRow[tmpPK]; });
				}
				catch (pSortError)
				{
					return fCallback(pSortError);
				}
				return fCallback(null, { Keys: tmpKeys, Statements: pContext.Counters.Statements - tmpStatementsBefore });
			});
	}

	/**
	 * Primary keys of the base set by primary key (oracle for EngineLive.keys): the first Cap keys,
	 * the Count, Truncated when more exist.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pBasePlan
	 * @param {{ Cap?: number }} pOptions
	 * @param {(pError?: Error, pResult?: { Keys: Array<any>, Count: number, Truncated: boolean }) => void} fCallback
	 */
	keys(pContext, pBasePlan, pOptions, fCallback)
	{
		let tmpOptions = pOptions || {};
		this.recordKeys(pContext, pBasePlan, { Sort: [], Begin: 0 },
			(pError, pResult) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpLimits = (pContext.Options && pContext.Options.Limits) ? pContext.Options.Limits : this.options.Limits;
				let tmpCap = (typeof(tmpOptions.Cap) === 'number') ? tmpOptions.Cap : ((tmpLimits && (typeof(tmpLimits.MaxKeys) === 'number')) ? tmpLimits.MaxKeys : pResult.Keys.length);
				return fCallback(null, { Keys: pResult.Keys.slice(0, tmpCap), Count: pResult.Keys.length, Truncated: (pResult.Keys.length > tmpCap) });
			});
	}

	// ------------------------------------------------------------------ folding (pure)

	/**
	 * Fold rows into a RawFacetResult for one Agg (pure; internal-contracts §5.3 / §9.2).
	 *
	 * @param {Record<string, any>} pAgg
	 * @param {Array<Record<string, any>>} pRecords
	 * @return {Record<string, any>} RawFacetResult (internal-contracts §9.2)
	 */
	fold(pAgg, pRecords)
	{
		let tmpRecords = Array.isArray(pRecords) ? pRecords : [];
		let tmpRaw = (
			{
				Key: pAgg.Key,
				Kind: pAgg.Kind,
				VariantId: pAgg.VariantId || null,
				Total: tmpRecords.length,
				MissingCount: 0,
				Groups: [],
				DistinctKeys: null,
				Bounds: null,
				Geometry: null,
				Stats: null,
				DistinctCount: null,
				Cells: null
			});

		switch (pAgg.Kind)
		{
			case 'Count':
				return tmpRaw;
			case 'Terms':
				return this.foldTerms(pAgg, tmpRecords, tmpRaw);
			case 'DateHistogram':
				return this.foldDateHistogram(pAgg, tmpRecords, tmpRaw);
			case 'NumericHistogram':
				return this.foldNumericHistogram(pAgg, tmpRecords, tmpRaw);
			case 'Ranges':
				return this.foldRanges(pAgg, tmpRecords, tmpRaw);
			case 'Stats':
				return this.foldStats(pAgg, tmpRecords, tmpRaw);
			case 'DistinctCount':
				return this.foldDistinctCount(pAgg, tmpRecords, tmpRaw);
			case 'Missing':
				return this.foldMissing(pAgg, tmpRecords, tmpRaw);
			case 'Pivot':
				return this.foldPivot(pAgg, tmpRecords, tmpRaw);
			default:
				throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', 'The reference engine cannot fold this kind.', { Feature: String(pAgg.Kind), Milestone: 1 });
		}
	}

	/**
	 * The single dimension of a bucketed fold.
	 *
	 * @param {Record<string, any>} pAgg
	 * @return {Record<string, any>}
	 */
	singleDimension(pAgg)
	{
		let tmpDimension = (Array.isArray(pAgg.Dimensions) && (pAgg.Dimensions.length > 0)) ? pAgg.Dimensions[0] : null;
		if (!tmpDimension || (typeof(tmpDimension.Field) !== 'string'))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The facet has no dimension.');
		}
		return tmpDimension;
	}

	/**
	 * The measured column (Stats / DistinctCount / Missing): Agg.Field, else the first dimension's.
	 *
	 * @param {Record<string, any>} pAgg
	 * @return {{ Field: string, DataType: string, IsInteger: boolean, Scale: number }}
	 */
	measuredField(pAgg)
	{
		let tmpInfo = pAgg.FieldInfo || {};
		let tmpDimension = (Array.isArray(pAgg.Dimensions) && (pAgg.Dimensions.length > 0)) ? pAgg.Dimensions[0] : {};
		let tmpField = pAgg.Field || tmpInfo.Column || tmpDimension.Field;
		if (typeof(tmpField) !== 'string')
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The facet has no measured field.');
		}
		return (
			{
				Field: tmpField,
				DataType: tmpInfo.DataType || tmpDimension.DataType || 'String',
				IsInteger: (typeof(tmpInfo.IsInteger) === 'boolean') ? tmpInfo.IsInteger : !!tmpDimension.IsInteger,
				Scale: (typeof(tmpInfo.Scale) === 'number') ? tmpInfo.Scale : ((typeof(tmpDimension.Scale) === 'number') ? tmpDimension.Scale : 0)
			});
	}

	/**
	 * A raw column value as a number, or null when it is Missing (NULL, '', ' ', any non-numeric
	 * text): the contract rule FacetBuckets.numericValue, which matches the Live SQL (only the
	 * INTEGER / REAL storage classes are values on SQLite).
	 *
	 * @param {any} pValue
	 * @return {number|null}
	 */
	numericValue(pValue)
	{
		return libFacetBuckets.numericValue(pValue);
	}

	/**
	 * The Terms / Pivot-Column / DistinctCount key of a raw value: numeric DataTypes go through
	 * numericValue (a non-number is Missing → null), everything else through normalizeKey.
	 *
	 * @param {any} pValue
	 * @param {string} pDataType
	 * @return {any}
	 */
	valueKey(pValue, pDataType)
	{
		if (libFacetBuckets.isNumericType(pDataType))
		{
			return this.numericValue(pValue);
		}
		return libFacetEnvelope.normalizeKey(pValue, pDataType);
	}

	/**
	 * A Map-safe identity for a key (keeps 1 and '1' apart; null distinct).
	 *
	 * @param {any} pKey
	 * @return {string}
	 */
	keyIdentity(pKey)
	{
		return JSON.stringify(pKey);
	}

	/**
	 * Count keys into a Map (insertion keeps the first key object for each identity).
	 *
	 * @param {Map<string, { Key: any, Count: number }>} pMap
	 * @param {any} pKey
	 */
	countKey(pMap, pKey)
	{
		let tmpIdentity = this.keyIdentity(pKey);
		let tmpEntry = pMap.get(tmpIdentity);
		if (tmpEntry)
		{
			tmpEntry.Count++;
		}
		else
		{
			pMap.set(tmpIdentity, { Key: pKey, Count: 1 });
		}
	}

	/**
	 * Groups in the canonical order (Count descending, then Key ascending by compareKeys).
	 *
	 * @param {Map<string, { Key: any, Count: number }>} pMap
	 * @return {Array<{ Key: any, Count: number }>}
	 */
	canonicalGroups(pMap)
	{
		let tmpGroups = Array.from(pMap.values());
		tmpGroups.sort(
			(pA, pB) =>
			{
				if (pA.Count !== pB.Count)
				{
					return pB.Count - pA.Count;
				}
				return libFacetBuckets.compareKeys(pA.Key, pB.Key);
			});
		return tmpGroups;
	}

	/**
	 * Groups in key order (compareKeys ascending).
	 *
	 * @param {Map<string, { Key: any, Count: number }>} pMap
	 * @return {Array<{ Key: any, Count: number }>}
	 */
	keyOrderedGroups(pMap)
	{
		let tmpGroups = Array.from(pMap.values());
		tmpGroups.sort((pA, pB) => { return libFacetBuckets.compareKeys(pA.Key, pB.Key); });
		return tmpGroups;
	}

	/**
	 * K1 Terms: every non-null key (the post-processor applies Top), NULL → Missing.
	 */
	foldTerms(pAgg, pRecords, pRaw)
	{
		let tmpDimension = this.singleDimension(pAgg);
		let tmpDataType = tmpDimension.DataType || ((pAgg.FieldInfo && pAgg.FieldInfo.DataType) ? pAgg.FieldInfo.DataType : 'String');
		let tmpMap = new Map();
		for (let i = 0; i < pRecords.length; i++)
		{
			let tmpKey = this.valueKey(pRecords[i][tmpDimension.Field], tmpDataType);
			if (tmpKey === null)
			{
				pRaw.MissingCount++;
				continue;
			}
			this.countKey(tmpMap, tmpKey);
		}
		pRaw.Groups = this.canonicalGroups(tmpMap);
		pRaw.DistinctKeys = tmpMap.size;
		return pRaw;
	}

	/**
	 * K2 DateHistogram: dateKey per row (NULL, '' or unparseable → Missing), Bounds over the
	 * canonical values of rows with a key.
	 */
	foldDateHistogram(pAgg, pRecords, pRaw)
	{
		let tmpDimension = this.singleDimension(pAgg);
		let tmpInterval = tmpDimension.Interval || 'month';
		let tmpMap = new Map();
		let tmpLo = null;
		let tmpHi = null;
		for (let i = 0; i < pRecords.length; i++)
		{
			let tmpValue = pRecords[i][tmpDimension.Field];
			let tmpKey = libFacetBuckets.dateKey(tmpValue, tmpInterval);
			if (tmpKey === null)
			{
				pRaw.MissingCount++;
				continue;
			}
			this.countKey(tmpMap, tmpKey);
			let tmpCanonical = libFacetBuckets.canonicalDateTime(tmpValue);
			if ((tmpLo === null) || (tmpCanonical < tmpLo))
			{
				tmpLo = tmpCanonical;
			}
			if ((tmpHi === null) || (tmpCanonical > tmpHi))
			{
				tmpHi = tmpCanonical;
			}
		}
		pRaw.Groups = this.keyOrderedGroups(tmpMap);
		pRaw.Bounds = (tmpLo === null) ? null : { Lo: tmpLo, Hi: tmpHi };
		return pRaw;
	}

	/**
	 * K3 NumericHistogram: Nice geometry from the bounds of the non-null values (or the declared
	 * Edges), then numericIndex per row; rows outside an Edges geometry are in no group.
	 */
	foldNumericHistogram(pAgg, pRecords, pRaw)
	{
		let tmpDimension = this.singleDimension(pAgg);
		let tmpScale = (typeof(tmpDimension.Scale) === 'number') ? tmpDimension.Scale : 0;
		let tmpValues = [];
		let tmpLo = null;
		let tmpHi = null;
		for (let i = 0; i < pRecords.length; i++)
		{
			let tmpValue = this.numericValue(pRecords[i][tmpDimension.Field]);
			if (tmpValue === null)
			{
				pRaw.MissingCount++;
				continue;
			}
			tmpValues.push(tmpValue);
			if ((tmpLo === null) || (tmpValue < tmpLo))
			{
				tmpLo = tmpValue;
			}
			if ((tmpHi === null) || (tmpValue > tmpHi))
			{
				tmpHi = tmpValue;
			}
		}
		pRaw.Bounds = (tmpLo === null) ? null : { Lo: tmpLo, Hi: tmpHi };

		let tmpGeometry;
		if (tmpDimension.Mode === 'Edges')
		{
			tmpGeometry = libFacetBuckets.edgesGeometry(tmpDimension.Edges, !!tmpDimension.OpenEnded, tmpScale);
		}
		else
		{
			let tmpBuckets = (typeof(tmpDimension.Buckets) === 'number') ? tmpDimension.Buckets : this.options.Limits.DefaultBuckets;
			tmpGeometry = libFacetBuckets.numericGeometry(tmpLo, tmpHi, tmpBuckets, tmpScale, this.options.Limits.MaxBuckets);
		}
		pRaw.Geometry = tmpGeometry;

		let tmpMap = new Map();
		if (tmpGeometry && (tmpGeometry.N > 0))
		{
			for (let i = 0; i < tmpValues.length; i++)
			{
				let tmpIndex = libFacetBuckets.numericIndex(tmpValues[i], tmpGeometry);
				if ((tmpIndex === null) || (typeof(tmpIndex) === 'undefined'))
				{
					continue;
				}
				this.countKey(tmpMap, tmpIndex);
			}
		}
		pRaw.Groups = this.keyOrderedGroups(tmpMap);
		return pRaw;
	}

	/**
	 * The Key of the first declared range containing a (non-null) number, or null (CASE semantics:
	 * From inclusive, To exclusive, a missing bound is open).
	 *
	 * @param {number} pValue
	 * @param {Array<Record<string, any>>} pRanges
	 * @return {string|null}
	 */
	rangeKey(pValue, pRanges)
	{
		for (let i = 0; i < pRanges.length; i++)
		{
			let tmpRange = pRanges[i];
			let tmpFrom = ((tmpRange.From === null) || (typeof(tmpRange.From) === 'undefined')) ? null : Number(tmpRange.From);
			let tmpTo = ((tmpRange.To === null) || (typeof(tmpRange.To) === 'undefined')) ? null : Number(tmpRange.To);
			if (((tmpFrom === null) || (pValue >= tmpFrom)) && ((tmpTo === null) || (pValue < tmpTo)))
			{
				return tmpRange.Key;
			}
		}
		return null;
	}

	/**
	 * K4 Ranges: first matching declared range; NULL → Missing; no range → no group.
	 */
	foldRanges(pAgg, pRecords, pRaw)
	{
		let tmpDimension = this.singleDimension(pAgg);
		let tmpRanges = Array.isArray(tmpDimension.Ranges) ? tmpDimension.Ranges : [];
		let tmpMap = new Map();
		for (let i = 0; i < pRecords.length; i++)
		{
			let tmpValue = this.numericValue(pRecords[i][tmpDimension.Field]);
			if (tmpValue === null)
			{
				pRaw.MissingCount++;
				continue;
			}
			let tmpKey = this.rangeKey(tmpValue, tmpRanges);
			if (tmpKey === null)
			{
				continue;
			}
			this.countKey(tmpMap, tmpKey);
		}
		// Declared order
		pRaw.Groups = [];
		for (let i = 0; i < tmpRanges.length; i++)
		{
			let tmpEntry = tmpMap.get(this.keyIdentity(tmpRanges[i].Key));
			if (tmpEntry)
			{
				pRaw.Groups.push(tmpEntry);
				tmpMap.delete(this.keyIdentity(tmpRanges[i].Key));
			}
		}
		return pRaw;
	}

	/**
	 * K5 Stats: Rows, NonNull, Min, Max; numeric SumUnits = Σ round(v × 10^Scale) (exact integer);
	 * DateTime Min/Max are canonical strings (NULL, '' and unparseable values are Missing).
	 */
	foldStats(pAgg, pRecords, pRaw)
	{
		let tmpField = this.measuredField(pAgg);
		let tmpStats = { Rows: pRecords.length, NonNull: 0, Min: null, Max: null, SumUnits: null, Factor: null };
		if (tmpField.DataType === 'DateTime')
		{
			for (let i = 0; i < pRecords.length; i++)
			{
				let tmpCanonical = libFacetBuckets.canonicalDateTime(pRecords[i][tmpField.Field]);
				if (tmpCanonical === null)
				{
					continue;
				}
				tmpStats.NonNull++;
				if ((tmpStats.Min === null) || (tmpCanonical < tmpStats.Min))
				{
					tmpStats.Min = tmpCanonical;
				}
				if ((tmpStats.Max === null) || (tmpCanonical > tmpStats.Max))
				{
					tmpStats.Max = tmpCanonical;
				}
			}
		}
		else if (libFacetBuckets.isNumericType(tmpField.DataType))
		{
			let tmpScale = tmpField.IsInteger ? 0 : tmpField.Scale;
			tmpStats.Factor = Math.pow(10, tmpScale);
			tmpStats.SumUnits = 0;
			for (let i = 0; i < pRecords.length; i++)
			{
				let tmpValue = this.numericValue(pRecords[i][tmpField.Field]);
				if (tmpValue === null)
				{
					continue;
				}
				tmpStats.NonNull++;
				tmpStats.SumUnits += libFacetBuckets.units(tmpValue, tmpScale);
				if ((tmpStats.Min === null) || (tmpValue < tmpStats.Min))
				{
					tmpStats.Min = tmpValue;
				}
				if ((tmpStats.Max === null) || (tmpValue > tmpStats.Max))
				{
					tmpStats.Max = tmpValue;
				}
			}
		}
		else
		{
			// Strings: count / min / max by code unit; no sum
			for (let i = 0; i < pRecords.length; i++)
			{
				let tmpValue = pRecords[i][tmpField.Field];
				if ((tmpValue === null) || (typeof(tmpValue) === 'undefined'))
				{
					continue;
				}
				let tmpString = String(tmpValue);
				tmpStats.NonNull++;
				if ((tmpStats.Min === null) || (tmpString < tmpStats.Min))
				{
					tmpStats.Min = tmpString;
				}
				if ((tmpStats.Max === null) || (tmpString > tmpStats.Max))
				{
					tmpStats.Max = tmpString;
				}
			}
		}
		pRaw.Stats = tmpStats;
		pRaw.MissingCount = tmpStats.Rows - tmpStats.NonNull;
		return pRaw;
	}

	/**
	 * Is this a Missing value for the measured column (NULL; for DateTime also '' / unparseable;
	 * for a numeric DataType also any non-number: '', ' ', text)?
	 *
	 * @param {any} pValue
	 * @param {string} pDataType
	 * @return {boolean}
	 */
	isMissing(pValue, pDataType)
	{
		if ((pValue === null) || (typeof(pValue) === 'undefined'))
		{
			return true;
		}
		if (pDataType === 'DateTime')
		{
			return (libFacetBuckets.canonicalDateTime(pValue) === null);
		}
		if (libFacetBuckets.isNumericType(pDataType))
		{
			return (this.numericValue(pValue) === null);
		}
		return false;
	}

	/**
	 * K6 DistinctCount: distinct non-null values (binary comparison of the normalized key).
	 */
	foldDistinctCount(pAgg, pRecords, pRaw)
	{
		let tmpField = this.measuredField(pAgg);
		let tmpSeen = new Set();
		for (let i = 0; i < pRecords.length; i++)
		{
			let tmpValue = pRecords[i][tmpField.Field];
			if (this.isMissing(tmpValue, tmpField.DataType))
			{
				pRaw.MissingCount++;
				continue;
			}
			let tmpKey = (tmpField.DataType === 'DateTime')
				? libFacetBuckets.canonicalDateTime(tmpValue)
				: this.valueKey(tmpValue, tmpField.DataType);
			tmpSeen.add(this.keyIdentity(tmpKey));
		}
		pRaw.DistinctCount = tmpSeen.size;
		return pRaw;
	}

	/**
	 * K7 Missing: NULL rows (for DateTime also '' / unparseable).
	 */
	foldMissing(pAgg, pRecords, pRaw)
	{
		let tmpField = this.measuredField(pAgg);
		for (let i = 0; i < pRecords.length; i++)
		{
			if (this.isMissing(pRecords[i][tmpField.Field], tmpField.DataType))
			{
				pRaw.MissingCount++;
			}
		}
		return pRaw;
	}

	/**
	 * One pivot axis key for a row, computed exactly as the axis's single-dimension fold does: null
	 * for Missing; NO_RANGE_KEY for a Range-axis value in no declared range (Other, like Ranges).
	 *
	 * @param {Record<string, any>} pDimension
	 * @param {Record<string, any>} pRecord
	 * @return {any} the key, or null
	 */
	axisKey(pDimension, pRecord)
	{
		let tmpValue = pRecord[pDimension.Field];
		switch (pDimension.Kind)
		{
			case 'Column':
				return this.valueKey(tmpValue, pDimension.DataType || 'String');
			case 'DateBucket':
				return libFacetBuckets.dateKey(tmpValue, pDimension.Interval || 'month');
			case 'Range':
			{
				let tmpNumber = this.numericValue(tmpValue);
				if (tmpNumber === null)
				{
					return null;
				}
				let tmpKey = this.rangeKey(tmpNumber, Array.isArray(pDimension.Ranges) ? pDimension.Ranges : []);
				return (tmpKey === null) ? libFacetBuckets.NO_RANGE_KEY : tmpKey;
			}
			default:
				throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', 'This pivot axis is not supported.', { Feature: `PivotAxis:${pDimension.Kind}`, Milestone: 1 });
		}
	}

	/**
	 * K14 Pivot (2-D): every non-empty cell, including cells with a null key on either axis
	 * (post-processing moves those into MissingCount) and NO_RANGE_KEY cells (into OtherCount).
	 */
	foldPivot(pAgg, pRecords, pRaw)
	{
		let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
		if (tmpDimensions.length !== 2)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A pivot needs exactly two dimensions.');
		}
		for (let i = 0; i < tmpDimensions.length; i++)
		{
			if (PIVOT_AXIS_KINDS.indexOf(tmpDimensions[i].Kind) < 0)
			{
				throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', 'This pivot axis is not supported.', { Feature: `PivotAxis:${tmpDimensions[i].Kind}`, Milestone: 1 });
			}
		}
		let tmpMap = new Map();
		for (let i = 0; i < pRecords.length; i++)
		{
			let tmpKeys = [ this.axisKey(tmpDimensions[0], pRecords[i]), this.axisKey(tmpDimensions[1], pRecords[i]) ];
			let tmpIdentity = this.keyIdentity(tmpKeys);
			let tmpCell = tmpMap.get(tmpIdentity);
			if (tmpCell)
			{
				tmpCell.Count++;
			}
			else
			{
				tmpMap.set(tmpIdentity, { Keys: tmpKeys, Count: 1 });
			}
		}
		let tmpCells = Array.from(tmpMap.values());
		let tmpMaxCells = (this.options.Limits && (this.options.Limits.CubeMaxGroups >= 1)) ? this.options.Limits.CubeMaxGroups : 100000;
		if (tmpCells.length > tmpMaxCells)
		{
			// The same refusal as Live (its shell stops at CubeMaxGroups + 1 cells).
			throw libFacetErrors.create('FACET_TOO_LARGE', 'The pivot has too many cells.', { Limit: 'CubeMaxGroups', Max: tmpMaxCells, Suggest: { Top: true, Filter: true } });
		}
		tmpCells.sort(
			(pA, pB) =>
			{
				let tmpFirst = libFacetBuckets.compareKeys(pA.Keys[0], pB.Keys[0]);
				return (tmpFirst !== 0) ? tmpFirst : libFacetBuckets.compareKeys(pA.Keys[1], pB.Keys[1]);
			});
		pRaw.Cells = tmpCells;
		return pRaw;
	}
}

module.exports = RetoldFacetingEngineReference;
module.exports.serviceType = 'RetoldFacetingEngineReference';
module.exports.FOLD_KINDS = FOLD_KINDS;
module.exports.PIVOT_AXIS_KINDS = PIVOT_AXIS_KINDS;
module.exports.CROSS_ENTITY_DIMENSIONS = CROSS_ENTITY_DIMENSIONS;
