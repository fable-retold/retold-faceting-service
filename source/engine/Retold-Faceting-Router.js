/**
 * Retold Faceting - Router
 *
 * Chooses the engine for a request's Aggs (03 §10).  Milestone 1: pContext.ForceEngine when set
 * (the Reference oracle, in-process only), otherwise the first registered engine whose
 * capable() accepts every Agg (Live).
 *
 * Milestone 5 (internal-contracts §62.1): a store engine (ClickHouse) registered with
 * register(pEngine, { Store: true }) goes BEFORE Live (preference order) and is asked per Agg:
 *
 *   ForceEngine set                                 → that engine only (the Reference never reads a store)
 *   no store engine, or Mode ≠ 'Query'              → M4 behavior over the non-store engines (Live)
 *   Prefer = NormalizedRequest.Engine 'Live' ? 'Live' : (pContext.PreferEngine || 'Auto')
 *   per Agg: Prefer 'Live' → Live ('Requested'); else the store iff capable (static, no I/O) and —
 *            unless the in-process PreferEngine names the store — admitted by Freshness for the Agg's
 *            DepSet under the request's effective Freshness; else Live with the reason
 *   the store Aggs (one EngineClickHouse.execute, within DEADLINE_SHARE of the remaining deadline) and
 *   the Live Aggs (one EngineLive.execute) run CONCURRENTLY; a store error (.StoreError) fails the store
 *   Aggs over to Live in the same request (Warning FACET_STORE_FALLBACK); capture-time refusals
 *   (Execution.Refused) re-run on Live without a warning; the fallbacks run in a second Live execution;
 *   each engine sees the request's cube plans restricted to its own Aggs; the executions merge
 *   (Results, Errors, Captures, Statements, CubeFallbacks) with per-Agg Engines and Freshness.
 *   The read breaker counts only store-health failures (network, time-outs with a real budget,
 *   non-deterministic 5xx), charged to the failed Agg's pivot entity; a half-open breaker admits one
 *   probe (claimed by the admission, released when it produced no outcome).
 *
 * A store error whose cause is a missing database / table (.Wipe) asks Materializer.suspectWipe: it
 * confirms the loss (EXISTS) and rebuilds only what is gone, at most once per cooldown.
 *
 * A non-store error of the store engine (a 401, a Strict guard 500, FACET_TOO_LARGE raised while
 * capturing the scope) is returned exactly as Live would return it: a store never hides a security
 * error behind a fallback.  The decisions go to pContext.Store (§53.5).
 *
 * Contract: internal-contracts §9.4, §62.1.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');

// ClickHouse error codes of a statement that ran out of time (TIMEOUT_EXCEEDED, TOO_SLOW).
const TIMEOUT_CODES = Object.freeze([ 159, 160 ]);

// The Live answer's freshness fields (a Live answer is always Exact, as of the request clock).
const LIVE_ENGINE = 'Live';

// The store attempt's share of the remaining request deadline (§62.1): the rest is kept for Live.
const DEADLINE_SHARE = 0.4;

// A rate-limited warning repeats at most this often per key.
const WARN_EVERY_MS = 10000;

class RetoldFacetingRouter extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingRouter';

		// Ordered list of engines (registration order is preference order; store engines first)
		this._Engines = [];
		// M5: the store engines among them (asked per Agg, never by the M4 whole-request rule)
		this._StoreEngines = [];
	}

	/**
	 * Register an engine (anything implementing the EngineBase contract).  Idempotent per engine
	 * object.  pOptions.Store: a store engine (M5): registered before every other engine and routed per
	 * Agg (§62.1).
	 *
	 * @param {any} pEngine
	 * @param {{ Store?: boolean }} [pOptions]
	 * @return {boolean}
	 */
	register(pEngine, pOptions)
	{
		if (!pEngine || (typeof(pEngine.execute) !== 'function'))
		{
			return false;
		}
		let tmpStore = !!(pOptions && (pOptions.Store === true));
		if (this._Engines.indexOf(pEngine) >= 0)
		{
			if (tmpStore && (this._StoreEngines.indexOf(pEngine) < 0))
			{
				this._StoreEngines.push(pEngine);
				this._Engines.splice(this._Engines.indexOf(pEngine), 1);
				this._Engines.unshift(pEngine);
			}
			return true;
		}
		if (tmpStore)
		{
			this._Engines.unshift(pEngine);
			this._StoreEngines.push(pEngine);
			return true;
		}
		this._Engines.push(pEngine);
		return true;
	}

	/**
	 * Remove an engine (a store whose configuration went away on a model reload).
	 *
	 * @param {any} pEngine
	 * @return {boolean} true when it was registered
	 */
	unregister(pEngine)
	{
		let tmpIndex = this._Engines.indexOf(pEngine);
		if (tmpIndex < 0)
		{
			return false;
		}
		this._Engines.splice(tmpIndex, 1);
		let tmpStoreIndex = this._StoreEngines.indexOf(pEngine);
		if (tmpStoreIndex >= 0)
		{
			this._StoreEngines.splice(tmpStoreIndex, 1);
		}
		return true;
	}

	/**
	 * The registered engine with this EngineName, or null.
	 *
	 * @param {string} pEngineName
	 * @return {any|null}
	 */
	engine(pEngineName)
	{
		for (let i = 0; i < this._Engines.length; i++)
		{
			if (this._Engines[i].EngineName === pEngineName)
			{
				return this._Engines[i];
			}
		}
		return null;
	}

	/**
	 * The registered store engine (M5: at most one, ClickHouse), or null.
	 *
	 * @return {any|null}
	 */
	storeEngine()
	{
		return (this._StoreEngines.length > 0) ? this._StoreEngines[0] : null;
	}

	/**
	 * The engine names in preference order (Describe / status).
	 *
	 * @return {Array<string>}
	 */
	engineNames()
	{
		return this._Engines.map((pEngine) => { return pEngine.EngineName; });
	}

	/**
	 * Route and execute.
	 *
	 * @param {Array<Record<string, any>>} pAggs
	 * @param {Record<string, any>} pContext
	 * @param {(pError?: Error, pExecution?: Record<string, any>) => void} fCallback
	 */
	route(pAggs, pContext, fCallback)
	{
		let tmpAggs = Array.isArray(pAggs) ? pAggs : [];
		if (pContext && (typeof(pContext.ForceEngine) === 'string') && (pContext.ForceEngine.length > 0))
		{
			// In-process only (tests, fixture CLI): never reachable from a client.
			let tmpForced = this.engine(pContext.ForceEngine);
			if (!tmpForced)
			{
				return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The forced engine is not registered.'));
			}
			return this.executeOn(tmpForced, pContext, tmpAggs, fCallback);
		}
		let tmpStore = this.storeEngine();
		if (tmpStore && pContext && ((typeof(pContext.Mode) !== 'string') || (pContext.Mode === 'Query')))
		{
			return this.routeWithStore(tmpStore, tmpAggs, pContext, fCallback);
		}
		// M4: the first registered (non-store) engine that accepts every Agg answers the whole request.
		let tmpEngine = null;
		for (let i = 0; (i < this._Engines.length) && !tmpEngine; i++)
		{
			let tmpCandidate = this._Engines[i];
			if (this._StoreEngines.indexOf(tmpCandidate) >= 0)
			{
				continue;
			}
			let tmpAllCapable = true;
			for (let j = 0; j < tmpAggs.length; j++)
			{
				let tmpCapable = tmpCandidate.capable(tmpAggs[j], pContext);
				if (!tmpCapable || !tmpCapable.Capable)
				{
					tmpAllCapable = false;
					break;
				}
			}
			if (tmpAllCapable)
			{
				tmpEngine = tmpCandidate;
			}
		}
		if (!tmpEngine)
		{
			// No engine takes every Agg: the Live engine reports the ones it refuses per facet.
			tmpEngine = this.engine(LIVE_ENGINE);
		}
		if (!tmpEngine)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'No facet engine is registered.'));
		}
		return this.executeOn(tmpEngine, pContext, tmpAggs, fCallback);
	}

	/**
	 * Run one engine's execute, guarded: called back exactly once; a throw becomes a logged
	 * FACET_INTERNAL (a facet error passes through).
	 *
	 * @param {any} pEngine
	 * @param {Record<string, any>} pContext
	 * @param {Array<Record<string, any>>} pAggs
	 * @param {(pError?: Error, pExecution?: Record<string, any>) => void} fCallback
	 */
	executeOn(pEngine, pContext, pAggs, fCallback)
	{
		let tmpCalledBack = false;
		try
		{
			return pEngine.execute(pContext, pAggs,
				(pError, pExecution) =>
				{
					if (tmpCalledBack)
					{
						this.fable.log.error(`RetoldFaceting Router: engine ${pEngine.EngineName} called back more than once.`);
						return;
					}
					tmpCalledBack = true;
					return fCallback(pError, pExecution);
				});
		}
		catch (pExecuteError)
		{
			if (tmpCalledBack)
			{
				// Thrown by our caller's own continuation: not ours to swallow.
				throw pExecuteError;
			}
			tmpCalledBack = true;
			this.fable.log.error(`RetoldFaceting Router: engine ${pEngine.EngineName} threw: ${pExecuteError.message}`);
			return fCallback(libFacetErrors.isFacetError(pExecuteError) ? pExecuteError : libFacetErrors.create('FACET_INTERNAL'));
		}
	}

	/**
	 * The request's cube plans restricted to the Aggs one engine answers (a cube with none of them is
	 * dropped; one with some keeps only those members, which marginalize independently).
	 *
	 * @param {Array<Record<string, any>>} pCubes
	 * @param {Array<Record<string, any>>} pAggs
	 * @return {Array<Record<string, any>>}
	 */
	restrictCubes(pCubes, pAggs)
	{
		let tmpKeys = new Set(pAggs.map((pAgg) => { return pAgg.Key; }));
		let tmpRestricted = [];
		(Array.isArray(pCubes) ? pCubes : []).forEach(
			(pCube) =>
			{
				if (!pCube || !Array.isArray(pCube.Members))
				{
					return;
				}
				let tmpMembers = pCube.Members.filter((pMember) => { return pMember && tmpKeys.has(pMember.AggKey); });
				if (tmpMembers.length < 1)
				{
					return;
				}
				tmpRestricted.push((tmpMembers.length === pCube.Members.length) ? pCube : Object.assign({}, pCube, { Members: tmpMembers }));
			});
		return tmpRestricted;
	}

	/**
	 * Run an engine over some Aggs with the cube plans restricted to them.  Both engines read
	 * pContext.Cubes synchronously when execute() is called, so it is restored as soon as the call
	 * returns — two engines may run concurrently over the same context.
	 *
	 * @param {any} pEngine
	 * @param {Record<string, any>} pContext
	 * @param {Array<Record<string, any>>} pAggs
	 * @param {Array<Record<string, any>>} pAllCubes - the request's cube plans
	 * @param {(pError?: Error, pExecution?: Record<string, any>) => void} fCallback
	 */
	executeRestricted(pEngine, pContext, pAggs, pAllCubes, fCallback)
	{
		pContext.Cubes = this.restrictCubes(pAllCubes, pAggs);
		try
		{
			return this.executeOn(pEngine, pContext, pAggs, fCallback);
		}
		finally
		{
			pContext.Cubes = pAllCubes;
		}
	}

	/**
	 * Is a store error a timeout (the statement ran out of its share of the deadline)?
	 *
	 * @param {Error} pError
	 * @return {boolean}
	 */
	isTimeout(pError)
	{
		let tmpCandidates = [ pError, pError ? pError.Cause : null ];
		for (let i = 0; i < tmpCandidates.length; i++)
		{
			let tmpError = tmpCandidates[i];
			if (!tmpError)
			{
				continue;
			}
			if ((TIMEOUT_CODES.indexOf(tmpError.Code) >= 0) || (tmpError.Code === 'FACET_TIMEOUT') || (tmpError.TimedOut === true))
			{
				return true;
			}
			if (/TIMEOUT|TIMEDOUT/i.test(String(tmpError.Name || '')) || /TIMEDOUT/i.test(String(tmpError.NetworkCode || '')))
			{
				return true;
			}
		}
		return false;
	}

	/**
	 * Does a store error say the store is unwell (counted on the read breaker), rather than the
	 * statement that hit it?  Never: a deterministic error (4xx, a parse / parameter / type error the
	 * request's own values caused), a per-query limit, a parameter refused for size, a busy store, or a
	 * time-out under Stores.ClickHouse.HealthMinTimeoutMS of budget (a client asking a tiny TimeoutMS).
	 *
	 * @param {any} pError
	 * @return {boolean}
	 */
	isHealthFailure(pError)
	{
		let tmpCause = (pError && pError.Cause) ? pError.Cause : pError;
		if (!tmpCause)
		{
			return false;
		}
		let tmpStore = this.fable.RetoldFacetingStoreClickHouse;
		if (tmpStore && (typeof(tmpStore.isHealthFailure) === 'function'))
		{
			return tmpStore.isHealthFailure(tmpCause, tmpCause.BudgetMS);
		}
		return !tmpCause.Deterministic && !tmpCause.Busy && (tmpCause.Retryable === true);
	}

	/**
	 * A warning at most once per WARN_EVERY_MS per key (a store outage must not log three lines per
	 * request); the suppressed count goes with the next one.
	 *
	 * @param {string} pKey
	 * @param {string} pMessage
	 */
	warnRateLimited(pKey, pMessage)
	{
		if (!this._Warned)
		{
			this._Warned = new Map();
		}
		let tmpNow = Date.now();
		let tmpEntry = this._Warned.get(pKey);
		if (tmpEntry && ((tmpNow - tmpEntry.At) < WARN_EVERY_MS))
		{
			tmpEntry.Suppressed++;
			return;
		}
		let tmpSuppressed = tmpEntry ? tmpEntry.Suppressed : 0;
		this._Warned.set(pKey, { At: tmpNow, Suppressed: 0 });
		this.fable.log.warn(`${pMessage}${(tmpSuppressed > 0) ? ` (${tmpSuppressed} similar warning(s) suppressed)` : ''}`);
	}

	/**
	 * Per-Agg routing with a store engine (internal-contracts §62.1).
	 *
	 * The store attempt gets DEADLINE_SHARE of the remaining request deadline (pContext.Store.DeadlineAt:
	 * every statement's client time-out and max_execution_time come from it), the Live Aggs run
	 * CONCURRENTLY with it, and the Aggs the store could not answer run Live afterwards with what is left.
	 *
	 * @param {any} pStore - the store engine
	 * @param {Array<Record<string, any>>} pAggs
	 * @param {Record<string, any>} pContext
	 * @param {(pError?: Error, pExecution?: Record<string, any>) => void} fCallback
	 */
	routeWithStore(pStore, pAggs, pContext, fCallback)
	{
		let tmpLive = this.engine(LIVE_ENGINE);
		if (!tmpLive)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'No facet engine is registered.'));
		}
		let tmpStoreName = pStore.EngineName;
		let tmpFreshnessService = this.fable.RetoldFacetingFreshness || null;
		let tmpStart = Date.now();
		let tmpRequestEngine = (pContext.NormalizedRequest && (typeof(pContext.NormalizedRequest.Engine) === 'string')) ? pContext.NormalizedRequest.Engine : 'Auto';
		let tmpPreferred = (typeof(pContext.PreferEngine) === 'string') ? pContext.PreferEngine : null;
		let tmpPrefer = (tmpRequestEngine === LIVE_ENGINE) ? LIVE_ENGINE
			: ((tmpPreferred === LIVE_ENGINE) || (tmpPreferred === tmpStoreName)) ? tmpPreferred
			: 'Auto';
		let tmpState = ((typeof(pContext.Store) === 'object') && (pContext.Store !== null)) ? pContext.Store : {};
		tmpState.Name = tmpStoreName;
		tmpState.Prefer = tmpPrefer;
		tmpState.Decisions = tmpState.Decisions || {};
		tmpState.Fallback = tmpState.Fallback || null;
		tmpState.Statements = tmpState.Statements || 0;
		tmpState.DepSets = tmpState.DepSets || {};
		tmpState.Probes = tmpState.Probes || {};
		pContext.Store = tmpState;

		let tmpNow = Date.now();
		let tmpStoreAggs = [];
		let tmpLiveAggs = [];
		// A half-open breaker lets one probe REQUEST through: its Aggs share the claim.
		let tmpProbeToken = `probe:${pContext.RequestID || ''}:${tmpNow}:${Math.random().toString(36).slice(2, 10)}`;
		for (let i = 0; i < pAggs.length; i++)
		{
			let tmpAgg = pAggs[i];
			let tmpKey = (tmpAgg && (typeof(tmpAgg.Key) === 'string')) ? tmpAgg.Key : `#${i}`;
			let fLive = (pReason, pFreshness) =>
			{
				tmpState.Decisions[tmpKey] = { Engine: LIVE_ENGINE, Reason: pReason || null, Freshness: pFreshness || null };
				tmpLiveAggs.push(tmpAgg);
			};
			if (tmpPrefer === LIVE_ENGINE)
			{
				fLive('Requested', null);
				continue;
			}
			let tmpCapable = null;
			try
			{
				tmpCapable = pStore.capable(tmpAgg, pContext);
			}
			catch (pCapableError)
			{
				this.fable.log.error(`RetoldFaceting Router: ${tmpStoreName}.capable threw: ${pCapableError.message}`);
				tmpCapable = { Capable: false, Reason: 'StoreUnavailable' };
			}
			if (!tmpCapable || !tmpCapable.Capable)
			{
				fLive((tmpCapable && tmpCapable.Reason) ? tmpCapable.Reason : 'StoreUnavailable', null);
				continue;
			}
			let tmpDepSet = (typeof(pStore.depSet) === 'function') ? pStore.depSet(pContext, tmpAgg) : {};
			tmpState.DepSets[tmpKey] = tmpDepSet;
			if (tmpPrefer === tmpStoreName)
			{
				// In-process (tests, O3): every capable Agg on the store, without the freshness admission.
				tmpState.Decisions[tmpKey] = { Engine: tmpStoreName, Reason: null, Freshness: null };
				tmpStoreAggs.push(tmpAgg);
				continue;
			}
			// The admission claims a half-open breaker's single probe (released again on a refusal).
			let tmpAdmission = tmpFreshnessService
				? tmpFreshnessService.admits(tmpStoreName, tmpDepSet, pContext.Freshness || { Mode: 'Exact' }, tmpNow, { ClaimProbe: tmpProbeToken })
				: { Admit: false, Reason: 'StoreUnavailable', Freshness: null };
			if (!tmpAdmission.Admit)
			{
				fLive(tmpAdmission.Reason || 'StoreUnavailable', tmpAdmission.Freshness || null);
				continue;
			}
			if (Array.isArray(tmpAdmission.Probes) && (tmpAdmission.Probes.length > 0))
			{
				tmpState.Probes[tmpKey] = tmpAdmission.Probes.slice();
			}
			tmpState.Decisions[tmpKey] = { Engine: tmpStoreName, Reason: null, Freshness: tmpAdmission.Freshness || null };
			tmpStoreAggs.push(tmpAgg);
		}

		// The store attempt's share of the deadline: its statements' client time-outs and
		// max_execution_time come from DeadlineAt, so a slow or hung store leaves the rest to Live.
		tmpState.RoutedAt = tmpNow;
		if (typeof(pContext.Deadline) === 'number')
		{
			tmpState.DeadlineAt = tmpNow + Math.floor(DEADLINE_SHARE * Math.max(0, pContext.Deadline - tmpNow));
		}

		let tmpAllCubes = Array.isArray(pContext.Cubes) ? pContext.Cubes : ((pContext.Plan && Array.isArray(pContext.Plan.Cubes)) ? pContext.Plan.Cubes : []);
		let tmpAggsByKey = new Map(pAggs.map((pAgg) => { return [ pAgg.Key, pAgg ]; }));
		// The breaker: a success proves every entity it read; a store-health failure is charged to the
		// entity whose statement failed (the Agg's pivot) — never a deterministic error the request's own
		// values caused; a claimed half-open probe with no outcome is given back.
		let fBreaker = (pSucceededKeys, pFailures) =>
		{
			if (!tmpFreshnessService)
			{
				return;
			}
			let tmpAt = Date.now();
			let tmpOutcome = new Set();
			let tmpSucceeded = new Set();
			pSucceededKeys.forEach((pKey) => { Object.keys(tmpState.DepSets[pKey] || {}).forEach((pEntity) => { tmpSucceeded.add(pEntity); }); });
			tmpSucceeded.forEach((pEntity) => { tmpFreshnessService.recordSuccess(tmpStoreName, pEntity, tmpAt, 'Read'); tmpOutcome.add(pEntity); });
			let tmpFailed = new Set();
			pFailures.forEach(
				(pFailure) =>
				{
					let tmpAgg = tmpAggsByKey.get(pFailure.Key);
					let tmpPivot = (tmpAgg && (typeof(tmpAgg.Pivot) === 'string')) ? tmpAgg.Pivot : null;
					if (tmpPivot && this.isHealthFailure(pFailure.Error) && !tmpSucceeded.has(tmpPivot))
					{
						tmpFailed.add(tmpPivot);
					}
				});
			tmpFailed.forEach((pEntity) => { tmpFreshnessService.recordFailure(tmpStoreName, pEntity, tmpAt, 'Read'); tmpOutcome.add(pEntity); });
			Object.keys(tmpState.Probes).forEach(
				(pKey) =>
				{
					tmpState.Probes[pKey].forEach((pEntity) => { if (!tmpOutcome.has(pEntity)) { tmpFreshnessService.releaseProbe(tmpStoreName, pEntity, 'Read'); } });
				});
		};
		let fFallback = (pAggKeys, pError, pWhy) =>
		{
			let tmpReason = this.isTimeout(pError) ? 'Timeout' : 'Error';
			let tmpCause = (pError && pError.Cause) ? pError.Cause : pError;
			tmpState.Fallback = { Reason: tmpReason, Detail: { Aggs: pAggKeys.slice(), Code: (tmpCause && (tmpCause.Code !== undefined)) ? tmpCause.Code : null, Why: pWhy } };
			pContext.Warnings = Array.isArray(pContext.Warnings) ? pContext.Warnings : [];
			if (!pContext.Warnings.some((pWarning) => { return pWarning && (pWarning.Code === 'FACET_STORE_FALLBACK'); }))
			{
				pContext.Warnings.push({ Code: 'FACET_STORE_FALLBACK', Detail: { Store: tmpStoreName, Reason: tmpReason } });
			}
			if (tmpCause && tmpCause.Busy)
			{
				return;
			}
			this.warnRateLimited(`fallback:${tmpStoreName}:${tmpReason}`, `RetoldFaceting request ${pContext.RequestID || '?'}: the ${tmpStoreName} store failed (${pWhy}, ${tmpReason}); ${pAggKeys.length} facet(s) answered Live.`);
		};
		let fSuspectWipe = (pError) =>
		{
			let tmpCause = (pError && pError.Cause) ? pError.Cause : pError;
			let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
			if (tmpCause && (tmpCause.Wipe === true) && tmpMaterializer && (typeof(tmpMaterializer.suspectWipe) === 'function'))
			{
				// A read noticed a missing table: the materializer confirms it (EXISTS) before rebuilding
				// only what is really gone, at most once per cooldown.  The request itself goes Live.
				tmpMaterializer.suspectWipe(tmpStoreName);
			}
		};

		let tmpLiveFirst = null;
		let tmpStoreOutcome = null;
		let tmpPending = 0;
		let tmpFinished = false;
		let fBothDone = () =>
		{
			if (tmpFinished || (tmpPending > 0))
			{
				return;
			}
			tmpFinished = true;
			if (tmpLiveFirst && tmpLiveFirst.Error)
			{
				return fCallback(tmpLiveFirst.Error);
			}
			if (tmpStoreOutcome && tmpStoreOutcome.Error)
			{
				return fCallback(tmpStoreOutcome.Error);
			}
			let tmpStoreExecution = tmpStoreOutcome ? tmpStoreOutcome.Execution : null;
			let tmpFallbackAggs = tmpStoreOutcome ? tmpStoreOutcome.Fallback : [];
			if (tmpFallbackAggs.length < 1)
			{
				return fMerge(tmpStoreExecution, [ tmpLiveFirst ? tmpLiveFirst.Execution : null ]);
			}
			let tmpOrder = new Map(pAggs.map((pAgg, pIndex) => { return [ pAgg, pIndex ]; }));
			tmpFallbackAggs.sort((pA, pB) => { return tmpOrder.get(pA) - tmpOrder.get(pB); });
			this.executeRestricted(tmpLive, pContext, tmpFallbackAggs, tmpAllCubes,
				(pFallbackError, pFallbackExecution) =>
				{
					if (pFallbackError)
					{
						return fCallback(pFallbackError);
					}
					return fMerge(tmpStoreExecution, [ tmpLiveFirst ? tmpLiveFirst.Execution : null, pFallbackExecution ]);
				});
		};

		let fMerge = (pStoreExecution, pLiveExecutions) =>
		{
			let tmpMerged = (
				{
					Engine: LIVE_ENGINE,
					AsOf: pContext.Now,
					Exact: true,
					LagMS: 0,
					Results: {},
					Errors: {},
					Captures: {},
					Statements: 0,
					CubeFallbacks: [],
					Staged: { Relations: 0, Keys: 0 },
					Engines: {},
					Freshness: {}
				});
			let fFold = (pExecution, pEngineName) =>
			{
				if (!pExecution)
				{
					return;
				}
				Object.keys(pExecution.Results || {}).forEach(
					(pKey) =>
					{
						tmpMerged.Results[pKey] = pExecution.Results[pKey];
						tmpMerged.Engines[pKey] = pEngineName;
						if (pEngineName !== LIVE_ENGINE)
						{
							let tmpFresh = (pExecution.Freshness && pExecution.Freshness[pKey]) ? pExecution.Freshness[pKey] : null;
							tmpMerged.Freshness[pKey] = tmpFresh || { Exact: false, LagMS: Infinity, AsOf: null, State: null };
						}
					});
				Object.keys(pExecution.Errors || {}).forEach(
					(pKey) =>
					{
						tmpMerged.Errors[pKey] = pExecution.Errors[pKey];
						tmpMerged.Engines[pKey] = pEngineName;
					});
				Object.keys(pExecution.Captures || {}).forEach(
					(pEntity) =>
					{
						let tmpCapture = pExecution.Captures[pEntity] || {};
						let tmpEntry = tmpMerged.Captures[pEntity] || { Fingerprint: null, Fingerprints: [], Repaired: false };
						(Array.isArray(tmpCapture.Fingerprints) ? tmpCapture.Fingerprints : (tmpCapture.Fingerprint ? [ tmpCapture.Fingerprint ] : [])).forEach(
							(pFingerprint) =>
							{
								if (tmpEntry.Fingerprints.indexOf(pFingerprint) < 0)
								{
									tmpEntry.Fingerprints.push(pFingerprint);
								}
							});
						tmpEntry.Fingerprints.sort();
						tmpEntry.Fingerprint = tmpEntry.Fingerprints.join(',');
						tmpEntry.Repaired = tmpEntry.Repaired || !!tmpCapture.Repaired;
						tmpMerged.Captures[pEntity] = tmpEntry;
					});
				tmpMerged.Statements += (typeof(pExecution.Statements) === 'number') ? pExecution.Statements : 0;
				if (Array.isArray(pExecution.CubeFallbacks))
				{
					pExecution.CubeFallbacks.forEach((pCubeId) => { if (tmpMerged.CubeFallbacks.indexOf(pCubeId) < 0) { tmpMerged.CubeFallbacks.push(pCubeId); } });
				}
				if (pExecution.Staged)
				{
					tmpMerged.Staged.Relations += pExecution.Staged.Relations || 0;
					tmpMerged.Staged.Keys += pExecution.Staged.Keys || 0;
				}
			};
			fFold(pStoreExecution, tmpStoreName);
			pLiveExecutions.forEach((pExecution) => { fFold(pExecution, LIVE_ENGINE); });
			let tmpStoreKeys = Object.keys(tmpMerged.Engines).filter((pKey) => { return tmpMerged.Engines[pKey] === tmpStoreName; });
			tmpStoreKeys.forEach(
				(pKey) =>
				{
					let tmpFresh = tmpMerged.Freshness[pKey];
					if (tmpFresh && (tmpFresh.Exact !== true))
					{
						tmpMerged.Exact = false;
					}
					if (tmpFresh && (typeof(tmpFresh.LagMS) === 'number') && (tmpFresh.LagMS > tmpMerged.LagMS))
					{
						tmpMerged.LagMS = tmpFresh.LagMS;
					}
				});
			tmpState.Used = tmpStoreKeys.filter((pKey) => { return Object.prototype.hasOwnProperty.call(tmpMerged.Results, pKey); });
			tmpState.ElapsedMS = Date.now() - tmpStart;
			tmpMerged.Store = tmpState;
			return fCallback(null, tmpMerged);
		};

		// Both runs are counted before either starts (an engine may call back synchronously).
		tmpPending = ((tmpLiveAggs.length > 0) ? 1 : 0) + ((tmpStoreAggs.length > 0) ? 1 : 0);
		if (tmpStoreAggs.length < 1)
		{
			tmpStoreOutcome = { Error: null, Execution: null, Fallback: [] };
		}
		if (tmpPending < 1)
		{
			return fBothDone();
		}
		// The Live Aggs, concurrently with the store attempt (never behind its latency).
		if (tmpLiveAggs.length > 0)
		{
			let tmpLiveRun = tmpLiveAggs.slice();
			let tmpOrder = new Map(pAggs.map((pAgg, pIndex) => { return [ pAgg, pIndex ]; }));
			tmpLiveRun.sort((pA, pB) => { return tmpOrder.get(pA) - tmpOrder.get(pB); });
			this.executeRestricted(tmpLive, pContext, tmpLiveRun, tmpAllCubes,
				(pLiveError, pLiveExecution) =>
				{
					tmpLiveFirst = { Error: pLiveError || null, Execution: pLiveExecution || null };
					tmpPending--;
					return fBothDone();
				});
		}
		if (tmpStoreAggs.length < 1)
		{
			return;
		}
		this.executeRestricted(pStore, pContext, tmpStoreAggs, tmpAllCubes,
			(pStoreError, pStoreExecution) =>
			{
				tmpPending--;
				if (pStoreError)
				{
					if (!pStoreError.StoreError)
					{
						// A capture error Live would raise too (401, a Strict guard 500, TOO_LARGE): the
						// client gets exactly that (never hidden behind a fallback).
						tmpStoreOutcome = { Error: pStoreError, Execution: null, Fallback: [] };
						return fBothDone();
					}
					let tmpKeys = tmpStoreAggs.map((pAgg) => { return pAgg.Key; });
					fBreaker([], tmpKeys.map((pKey) => { return { Key: pKey, Error: pStoreError }; }));
					fSuspectWipe(pStoreError);
					tmpKeys.forEach((pKey) => { tmpState.Decisions[pKey] = { Engine: LIVE_ENGINE, Reason: 'StoreError', Freshness: null }; });
					fFallback(tmpKeys, pStoreError, 'Request');
					tmpStoreOutcome = { Error: null, Execution: null, Fallback: tmpStoreAggs.slice() };
					return fBothDone();
				}
				let tmpExecution = pStoreExecution || { Results: {}, Errors: {}, Refused: {} };
				let tmpRefused = tmpExecution.Refused || {};
				let tmpStoreErrors = tmpExecution.StoreErrors || {};
				let tmpFallbackAggs = [];
				let tmpFailed = [];
				tmpStoreAggs.forEach(
					(pAgg) =>
					{
						if (!Object.prototype.hasOwnProperty.call(tmpRefused, pAgg.Key))
						{
							return;
						}
						tmpState.Decisions[pAgg.Key] = { Engine: LIVE_ENGINE, Reason: tmpRefused[pAgg.Key], Freshness: null };
						tmpFallbackAggs.push(pAgg);
						if (tmpRefused[pAgg.Key] === 'StoreError')
						{
							tmpFailed.push({ Key: pAgg.Key, Error: tmpStoreErrors[pAgg.Key] || tmpExecution.StoreError || null });
						}
					});
				let tmpSucceeded = tmpStoreAggs.map((pAgg) => { return pAgg.Key; }).filter((pKey) => { return Object.prototype.hasOwnProperty.call(tmpExecution.Results || {}, pKey); });
				fBreaker(tmpSucceeded, tmpFailed);
				if (tmpFailed.length > 0)
				{
					tmpFailed.forEach((pFailure) => { fSuspectWipe(pFailure.Error); });
					fFallback(tmpFailed.map((pFailure) => { return pFailure.Key; }), tmpFailed[0].Error, 'Statement');
				}
				tmpStoreOutcome = { Error: null, Execution: tmpExecution, Fallback: tmpFallbackAggs };
				return fBothDone();
			});
	}
}

module.exports = RetoldFacetingRouter;
module.exports.serviceType = 'RetoldFacetingRouter';
module.exports.TIMEOUT_CODES = TIMEOUT_CODES;
