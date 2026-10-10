/**
 * Retold Faceting - Rebuilder
 *
 * Backfill and rebuild through shadow tables (design 04 §7; internal-contracts §59): a first enable
 * builds <E>__shadow_<BuildID> page by page (keyset by identity through the entity's WriterLoop, so
 * pages and stream cycles share one serialized writer and one clock) and RENAMEs it live; a rebuild
 * dual-writes stream cycles to the live table and the shadow while pages fill the shadow, then the
 * WriterLoop EXCHANGEs the tables between two flushes (nothing in flight) and drops the old data.  A
 * divergence-triggered rebuild ends Unverified.  A wiped store (missing database / table) is rebuilt
 * from scratch (Reason 'Wipe').
 *
 *   backfill(pStore, pEntity, pOptions, fCallback)       first enable: Building → RENAME → CatchingUp → Live
 *   rebuild(pStore, pEntity, { Reason }, fCallback)      Rebuilding → EXCHANGE → Live (Unverified for 'Divergence')
 *   status(pStore, pEntity) / cancel(pStore, pEntity, fCallback) / lastCompleted(pStore, pEntity)
 *
 * One build is in flight per (store, entity): a second backfill or rebuild JOINS the first (its
 * callback gets the first one's result), except Reason 'Wipe', which supersedes it (the tables it was
 * writing are gone): the old build is aborted and its callers get the new build's result.
 *
 * The Rebuilder never writes rows itself: it only drives the WriterLoop's documented rebuild API
 * (beginRebuild / addRangeTask 'RebuildPage' / finishRebuild / abortRebuild, internal-contracts §58.5)
 * and moves the entity's state through the Materializer (setState → Freshness, persisted with the next
 * state write).  Never throws: every outcome is a callback.
 *
 * Contract: internal-contracts §59.  Owner: builder D (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libCrypto = require('crypto');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libStoreBase = require('../store/Retold-Faceting-StoreBase.js');

// Why a rebuild runs (§59.2).
const REBUILD_REASONS = Object.freeze([ 'Admin', 'SpecChange', 'Divergence', 'Wipe' ]);

// The reason a first-enable build reports when its caller names none.
const BACKFILL_REASON = 'Backfill';

// The phases of a build (status().Phase): pages fill the shadow, the WriterLoop swaps it in, then
// (first enable only) the entity drains the hints that arrived before the swap.
const PHASES = Object.freeze([ 'Pages', 'Swapping', 'CatchingUp' ]);

// How long a backfill's callback waits for the catch-up before reporting { CaughtUp: false } (the
// CatchingUp → Live watch keeps running in the background).
const CATCH_UP_CALLBACK_MS = 30000;

/**
 * A fresh BuildID: 8 lowercase hex (StoreBase.BUILD_ID_PATTERN).
 *
 * @return {string}
 */
const newBuildID = () =>
{
	return libCrypto.randomBytes(4).toString('hex');
};

/**
 * 'YYYY-MM-DD HH:mm:ss.SSS' (UTC) of an epoch-ms instant: the DateTime64(3, 'UTC') text the state
 * row's date columns take.
 *
 * @param {number} pEpochMS
 * @return {string}
 */
const formatUTC = (pEpochMS) =>
{
	return new Date(pEpochMS).toISOString().replace('T', ' ').replace('Z', '');
};

/**
 * Call every waiter of a joined operation.  A waiter that throws does not keep the others from their
 * result; the first such error is re-thrown on the next tick (a throwing callback is the caller's
 * bug, never swallowed).
 *
 * @param {Array<Function>} pCallbacks
 * @param {Array<any>} pArguments
 */
const callAll = (pCallbacks, pArguments) =>
{
	let tmpThrown = null;
	for (let i = 0; i < pCallbacks.length; i++)
	{
		try
		{
			pCallbacks[i].apply(null, pArguments);
		}
		catch (pError)
		{
			tmpThrown = tmpThrown || pError;
		}
	}
	if (tmpThrown)
	{
		process.nextTick(() => { throw tmpThrown; });
	}
};

/**
 * The store service of a store name: the Materializer's own lookup when it has one, else the
 * registered 'RetoldFacetingStore<Name>' service.
 *
 * @param {Record<string, any>} pFable
 * @param {string} pStore
 * @return {Record<string, any>|null}
 */
const storeService = (pFable, pStore) =>
{
	let tmpMaterializer = pFable.RetoldFacetingMaterializer;
	if (tmpMaterializer && (typeof(tmpMaterializer.store) === 'function'))
	{
		let tmpStore = tmpMaterializer.store(pStore);
		if (tmpStore)
		{
			return tmpStore;
		}
	}
	let tmpService = pFable[`RetoldFacetingStore${pStore}`];
	return ((typeof(tmpService) === 'object') && (tmpService !== null)) ? tmpService : null;
};

/**
 * Move an entity's state: through the Materializer (which routes it to Freshness and persists it
 * with the next state write), else Freshness directly.  Never throws.
 *
 * @param {Record<string, any>} pFable
 * @param {string} pStore
 * @param {string} pEntity
 * @param {string} pState
 * @param {string|null} pReason
 */
const setEntityState = (pFable, pStore, pEntity, pState, pReason) =>
{
	try
	{
		let tmpMaterializer = pFable.RetoldFacetingMaterializer;
		if (tmpMaterializer && (typeof(tmpMaterializer.setState) === 'function'))
		{
			tmpMaterializer.setState(pStore, pEntity, pState, pReason);
			return;
		}
		let tmpFreshness = pFable.RetoldFacetingFreshness;
		if (tmpFreshness && (typeof(tmpFreshness.setState) === 'function'))
		{
			tmpFreshness.setState(pStore, pEntity, pState, pReason);
		}
	}
	catch (pError)
	{
		// A state machine that throws must not take the build down with it.
	}
};

/**
 * The entity's current state record ({ State, Since, Reason, Epoch, Divergence }) from Freshness.
 *
 * @param {Record<string, any>} pFable
 * @param {string} pStore
 * @param {string} pEntity
 * @return {{ State: string, Since: any, Reason: any, Divergence: boolean }}
 */
const entityState = (pFable, pStore, pEntity) =>
{
	try
	{
		let tmpFreshness = pFable.RetoldFacetingFreshness;
		if (tmpFreshness && (typeof(tmpFreshness.state) === 'function'))
		{
			let tmpState = tmpFreshness.state(pStore, pEntity);
			if (tmpState && (typeof(tmpState.State) === 'string'))
			{
				return tmpState;
			}
		}
	}
	catch (pError)
	{
		// fall through
	}
	return { State: 'Absent', Since: null, Reason: null, Divergence: false };
};

/**
 * Hand fields of the entity's state row (_rfs_entity_state, internal-contracts §56.2) to its one
 * writer: the Materializer owns the in-memory state object every state write serializes, so the
 * Rebuilder and the Reconciler never write the row themselves (a read-merge-write here could put a
 * stale CleanShutdown / SpecHash back over a newer row).  Two seams, either is enough:
 *
 *   push  Materializer.updateState(pStore, pEntity, pFields, fCallback) when it exists;
 *   pull  the Materializer merges Rebuilder.stateFields(S, E) / Reconciler.stateFields(S, E) into
 *         every state row it writes.
 *
 * Best effort by design: every field persisted here (watermark, cursor, timestamps) is an
 * optimization a restart may lose without a wrong answer (a lost watermark makes the next Sweep a
 * full pass), so a failure is reported, never fatal.
 *
 * @param {Record<string, any>} pFable
 * @param {string} pStore
 * @param {string} pEntity
 * @param {Record<string, any>} pFields
 * @param {(pError?: Error|null) => void} fCallback
 */
const persistStateFields = (pFable, pStore, pEntity, pFields, fCallback) =>
{
	let tmpDone = false;
	let fFinish = (pError) =>
	{
		if (tmpDone)
		{
			return;
		}
		tmpDone = true;
		return fCallback(pError || null);
	};
	try
	{
		let tmpMaterializer = pFable.RetoldFacetingMaterializer;
		if (tmpMaterializer && (typeof(tmpMaterializer.updateState) === 'function'))
		{
			return tmpMaterializer.updateState(pStore, pEntity, Object.assign({}, pFields), fFinish);
		}
		return fFinish(null);
	}
	catch (pError)
	{
		return fFinish(pError);
	}
};

class RetoldFacetingRebuilder extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingRebuilder';

		// 'S:E' → the build in flight (internal record; status() returns a copy)
		this._Running = new Map();
		// 'S:E' → { BuildID, Reason, At, Pages, Rows, ElapsedMS, State }
		this._Completed = new Map();
		// catch-up watch timers (unref'd)
		this._Timers = new Set();
		this._Stats = { Builds: 0, Completed: 0, Failed: 0, Cancelled: 0, Superseded: 0, Joined: 0 };
		this._Stopped = false;
	}

	// ---- helpers ------------------------------------------------------------------------------

	/**
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {string}
	 */
	_key(pStore, pEntity)
	{
		return `${pStore}:${pEntity}`;
	}

	/**
	 * Materializer.RebuildPageSize (at least 1).
	 *
	 * @return {number}
	 */
	pageSize()
	{
		let tmpMaterializer = this.options.Materializer || {};
		let tmpSize = Number(tmpMaterializer.RebuildPageSize);
		return (Number.isFinite(tmpSize) && (tmpSize >= 1)) ? Math.floor(tmpSize) : 100000;
	}

	/**
	 * The catch-up poll period (Materializer.IdleTickMS, at least 10 ms).
	 *
	 * @return {number}
	 */
	pollMS()
	{
		let tmpMaterializer = this.options.Materializer || {};
		let tmpTick = Number(tmpMaterializer.IdleTickMS);
		return (Number.isFinite(tmpTick) && (tmpTick >= 10)) ? Math.floor(tmpTick) : 50;
	}

	/**
	 * The entity's WriterLoop, or null (not materialized in that store).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {Record<string, any>|null}
	 */
	_loop(pStore, pEntity)
	{
		let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
		if (!tmpMaterializer || (typeof(tmpMaterializer.loop) !== 'function'))
		{
			return null;
		}
		try
		{
			return tmpMaterializer.loop(pStore, pEntity) || null;
		}
		catch (pError)
		{
			return null;
		}
	}

	/**
	 * Is the pending work that existed at pSince (performance.now()) gone?  Pending entries keep their
	 * FirstSeen until acked (in flight and buffered ones too), so "the oldest FirstSeen is newer than
	 * the swap" means every hint from before the swap has been applied — which still converges under
	 * a steady write stream, where the set is never empty.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {number} pSince
	 * @return {boolean}
	 */
	_drainedSince(pStore, pEntity, pSince)
	{
		let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
		if (!tmpMaterializer || (typeof(tmpMaterializer.pendingInfo) !== 'function'))
		{
			return true;
		}
		let tmpInfo = null;
		try
		{
			tmpInfo = tmpMaterializer.pendingInfo(pStore, pEntity);
		}
		catch (pError)
		{
			return false;
		}
		if (!tmpInfo || (typeof(tmpInfo) !== 'object'))
		{
			return true;
		}
		let tmpDirtyOld = !!tmpInfo.Dirty && !((typeof(tmpInfo.Dirty.Since) === 'number') && (tmpInfo.Dirty.Since > pSince));
		if (tmpDirtyOld || (Number(tmpInfo.Resolving) > 0))
		{
			return false;
		}
		let tmpOutstanding = (Number(tmpInfo.Pending) || 0) + (Number(tmpInfo.InFlight) || 0) + (Number(tmpInfo.Buffered) || 0);
		if (tmpOutstanding === 0)
		{
			return true;
		}
		return (typeof(tmpInfo.OldestFirstSeen) === 'number') && (tmpInfo.OldestFirstSeen > pSince);
	}

	// ---- API ----------------------------------------------------------------------------------

	/**
	 * First enable (and wipe recovery): build the shadow page by page, RENAME it live, then CatchingUp
	 * until the hints that arrived before the swap are applied, then Live.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {{ Reason?: string }} [pOptions]
	 * @param {(pError?: Error|null, pResult?: { BuildID: string, Pages: number, Rows: number, ElapsedMS: number, State: string, CaughtUp: boolean }) => void} fCallback
	 */
	backfill(pStore, pEntity, pOptions, fCallback)
	{
		let tmpOptions = ((typeof(pOptions) === 'object') && (pOptions !== null)) ? pOptions : {};
		let fDone = (typeof(fCallback) === 'function') ? fCallback : (typeof(pOptions) === 'function' ? pOptions : () => {});
		let tmpReason = (typeof(tmpOptions.Reason) === 'string') && (tmpOptions.Reason.length > 0) ? tmpOptions.Reason : BACKFILL_REASON;
		return this._begin(pStore, pEntity, tmpReason, true, fDone);
	}

	/**
	 * Rebuild through a shadow and EXCHANGE (or, with no live table yet / after a wipe, a backfill).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {{ Reason: string }} pOptions
	 * @param {(pError?: Error|null, pResult?: Record<string, any>) => void} fCallback
	 */
	rebuild(pStore, pEntity, pOptions, fCallback)
	{
		let tmpOptions = ((typeof(pOptions) === 'object') && (pOptions !== null)) ? pOptions : {};
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		let tmpReason = tmpOptions.Reason;
		if (REBUILD_REASONS.indexOf(tmpReason) < 0)
		{
			return fDone(libFacetErrors.create('FACET_REQUEST_INVALID', `A rebuild Reason is one of ${REBUILD_REASONS.join(' | ')}.`, { Field: 'Reason' }));
		}
		// No live table to exchange with: a wipe lost it, or the entity never got one (a backfill
		// that failed, an entity still Absent) → the first-enable path.
		let tmpState = entityState(this.fable, pStore, pEntity).State;
		let tmpFirstEnable = (tmpReason === 'Wipe') || (tmpState === 'Absent') || (tmpState === 'Building');
		return this._begin(pStore, pEntity, tmpReason, tmpFirstEnable, fDone);
	}

	/**
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {null|{ BuildID: string, Reason: string, Phase: string, Pages: number, Rows: number, StartedAt: string, FirstEnable: boolean }}
	 */
	status(pStore, pEntity)
	{
		let tmpBuild = this._Running.get(this._key(pStore, pEntity));
		if (!tmpBuild)
		{
			return null;
		}
		return (
			{
				BuildID: tmpBuild.BuildID,
				Reason: tmpBuild.Reason,
				Phase: tmpBuild.Phase,
				Pages: tmpBuild.Pages,
				Rows: tmpBuild.Rows,
				StartedAt: tmpBuild.StartedAt,
				FirstEnable: tmpBuild.FirstEnable
			});
	}

	/**
	 * The last build that completed for (store, entity), or null (storeAdmin's RebuildCooldownMS).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {null|{ BuildID: string, Reason: string, At: string, AtMS: number, Pages: number, Rows: number, ElapsedMS: number, State: string }}
	 */
	lastCompleted(pStore, pEntity)
	{
		let tmpCompleted = this._Completed.get(this._key(pStore, pEntity));
		return tmpCompleted ? Object.assign({}, tmpCompleted) : null;
	}

	/**
	 * Abort the build in flight (abortRebuild; the state goes back to the prior one — Absent for a
	 * first enable, Unverified when the rebuild was divergence-triggered).  A build that is swapping
	 * cannot be cancelled; one that is catching up has already completed.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {(pError?: Error|null, pResult?: { Cancelled: boolean, BuildID?: string, Reason?: string }) => void} fCallback
	 */
	cancel(pStore, pEntity, fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		let tmpBuild = this._Running.get(this._key(pStore, pEntity));
		if (!tmpBuild)
		{
			return fDone(null, { Cancelled: false, Reason: 'NotRunning' });
		}
		if (tmpBuild.Phase !== 'Pages')
		{
			return fDone(null, { Cancelled: false, BuildID: tmpBuild.BuildID, Reason: (tmpBuild.Phase === 'Swapping') ? 'Swapping' : 'Completed' });
		}
		let tmpError = new Error(`RetoldFacetingRebuilder: the build of ${pStore}.${pEntity} was cancelled.`);
		tmpError.Cancelled = true;
		this._Stats.Cancelled++;
		this._abort(tmpBuild, tmpError,
			() =>
			{
				return fDone(null, { Cancelled: true, BuildID: tmpBuild.BuildID });
			});
	}

	/**
	 * The state-row fields the Rebuilder owns (the pull seam of persistStateFields): the last
	 * completed build's time as LastRebuild, when there is one in this process.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {{ LastRebuild?: string }}
	 */
	stateFields(pStore, pEntity)
	{
		let tmpCompleted = this._Completed.get(this._key(pStore, pEntity));
		return (tmpCompleted && (typeof(tmpCompleted.SwappedAtMS) === 'number')) ? { LastRebuild: formatUTC(tmpCompleted.SwappedAtMS) } : {};
	}

	/**
	 * Service shutdown: clear the catch-up timers; a build that already swapped and was only waiting
	 * for its catch-up completes now (its callers get { CaughtUp: false } and the current state).
	 * Builds still paging or swapping end through their WriterLoop: a stopped loop fails their tasks
	 * ('Stopped'), which aborts them.
	 */
	stop()
	{
		this._Stopped = true;
		this._Timers.forEach((pTimer) => { clearTimeout(pTimer); });
		this._Timers.clear();
		Array.from(this._Running.values()).forEach(
			(pBuild) =>
			{
				if (pBuild.Phase === 'CatchingUp')
				{
					this._complete(pBuild, entityState(this.fable, pBuild.Store, pBuild.Entity).State, false);
				}
			});
	}

	/**
	 * @return {Record<string, any>}
	 */
	stats()
	{
		let tmpRunning = {};
		this._Running.forEach((pBuild, pKey) => { tmpRunning[pKey] = { BuildID: pBuild.BuildID, Reason: pBuild.Reason, Phase: pBuild.Phase, Pages: pBuild.Pages, Rows: pBuild.Rows }; });
		return Object.assign({ Running: tmpRunning }, this._Stats);
	}

	// ---- the build ----------------------------------------------------------------------------

	/**
	 * Start (or join) a build.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {string} pReason
	 * @param {boolean} pFirstEnable
	 * @param {Function} fCallback
	 */
	_begin(pStore, pEntity, pReason, pFirstEnable, fCallback)
	{
		let tmpKey = this._key(pStore, pEntity);
		let tmpInFlight = this._Running.get(tmpKey);
		if (tmpInFlight)
		{
			if ((pReason !== 'Wipe') || (tmpInFlight.Reason === 'Wipe' && tmpInFlight.Phase === 'Pages' && tmpInFlight.Pages === 0 && !tmpInFlight.Begun))
			{
				// A second request joins the first (a fresh full build either way).
				this._Stats.Joined++;
				tmpInFlight.Callbacks.push(fCallback);
				return;
			}
			// A wipe supersedes: the tables the old build wrote are gone.  Its callers get the new
			// build's result.
			this._Stats.Superseded++;
			let tmpCarried = tmpInFlight.Callbacks.splice(0);
			let tmpSuperseded = new Error(`RetoldFacetingRebuilder: the build of ${pStore}.${pEntity} was superseded by a wipe recovery.`);
			tmpSuperseded.Superseded = true;
			this._abort(tmpInFlight, tmpSuperseded,
				() =>
				{
					// _abort may already have started nothing else; begin the wipe build and carry
					// the old callers over.
					this._begin(pStore, pEntity, pReason, true,
						(pError, pResult) =>
						{
							return callAll(tmpCarried.concat([ fCallback ]), [ pError, pResult ]);
						});
				}, true);
			return;
		}

		let tmpLoop = this._loop(pStore, pEntity);
		if (!tmpLoop)
		{
			return fCallback(libFacetErrors.create('FACET_UNKNOWN_ENTITY', `RetoldFacetingRebuilder: ${pStore}.${pEntity} is not materialized.`, { Store: pStore, Entity: pEntity }));
		}

		this._Stopped = false;
		let tmpPrior = entityState(this.fable, pStore, pEntity);
		let tmpBuild = (
			{
				Key: tmpKey,
				Store: pStore,
				Entity: pEntity,
				BuildID: newBuildID(),
				Reason: pReason,
				FirstEnable: !!pFirstEnable,
				Phase: 'Pages',
				Pages: 0,
				Rows: 0,
				StartedAt: new Date().toISOString(),
				StartMS: Date.now(),
				PriorState: tmpPrior.State,
				PriorDivergence: !!tmpPrior.Divergence || (tmpPrior.Reason === 'Divergence'),
				Loop: tmpLoop,
				Callbacks: [ fCallback ],
				Begun: false,
				Ended: false
			});
		this._Running.set(tmpKey, tmpBuild);
		this._Stats.Builds++;

		this.log.info(`RetoldFaceting: ${pFirstEnable ? 'backfill' : 'rebuild'} of ${pStore}.${pEntity} started (BuildID ${tmpBuild.BuildID}, Reason ${pReason}).`);
		setEntityState(this.fable, pStore, pEntity, pFirstEnable ? 'Building' : 'Rebuilding', pReason);

		let tmpBeginDone = false;
		let fBegin = () =>
		{
			try
			{
				tmpLoop.beginRebuild(tmpBuild.BuildID, !!pFirstEnable,
					(pError) =>
					{
						if (tmpBeginDone || tmpBuild.Ended)
						{
							return;
						}
						tmpBeginDone = true;
						if (pError)
						{
							return this._fail(tmpBuild, pError, 'beginRebuild', false);
						}
						tmpBuild.Begun = true;
						return this._nextPage(tmpBuild, null);
					});
			}
			catch (pError)
			{
				tmpBeginDone = true;
				return this._fail(tmpBuild, pError, 'beginRebuild', false);
			}
		};
		// The Sweep watermark of the build: MAX(UpdateDate) before the first page (best effort).
		let tmpSpec = this._spec(pStore, pEntity);
		let tmpSource = this.fable.RetoldFacetingMaterializeSourceInProcess;
		if (!tmpSpec || !tmpSpec.Watermark || !tmpSource || (typeof(tmpSource.maxStamp) !== 'function'))
		{
			return fBegin();
		}
		tmpSource.maxStamp(pEntity, tmpSpec.Watermark,
			(pStampError, pStamp) =>
			{
				if (!pStampError && (typeof(pStamp) === 'string') && (pStamp.length > 0))
				{
					tmpBuild.Watermark = pStamp;
				}
				if (tmpBuild.Ended)
				{
					return;
				}
				return fBegin();
			});
	}

	/**
	 * The MirrorSpec of (S, E), or null.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {Record<string, any>|null}
	 */
	_spec(pStore, pEntity)
	{
		try
		{
			let tmpMirrorSpec = this.fable.RetoldFacetingMirrorSpec;
			return (tmpMirrorSpec && (typeof(tmpMirrorSpec.spec) === 'function')) ? (tmpMirrorSpec.spec(pStore, pEntity) || null) : null;
		}
		catch (pError)
		{
			return null;
		}
	}

	/**
	 * Queue the next RebuildPage on the WriterLoop (it interleaves them with stream cycles by
	 * priority, internal-contracts §58.5).
	 *
	 * @param {Record<string, any>} pBuild
	 * @param {number|null} pAfterID
	 */
	_nextPage(pBuild, pAfterID)
	{
		if (pBuild.Ended)
		{
			return;
		}
		let tmpTask = (
			{
				Kind: 'RebuildPage',
				Target: libStoreBase.shadowTarget(pBuild.BuildID),
				AfterID: pAfterID,
				ToID: null,
				Cap: this.pageSize()
			});
		let tmpCalled = false;
		try
		{
			pBuild.Loop.addRangeTask(tmpTask,
				(pError, pResult) =>
				{
					if (tmpCalled || pBuild.Ended)
					{
						// A late completion of an aborted / superseded build: ignore.
						return;
					}
					tmpCalled = true;
					if (pError)
					{
						return this._fail(pBuild, pError, 'RebuildPage', true);
					}
					let tmpResult = pResult || {};
					let tmpRows = Number(tmpResult.Rows) || 0;
					pBuild.Pages++;
					pBuild.Rows += tmpRows;
					let tmpLastID = ((tmpResult.LastID === null) || (tmpResult.LastID === undefined)) ? pAfterID : tmpResult.LastID;
					// A page that read nothing, or did not advance, ends the pass (never loop forever).
					let tmpExhausted = (tmpResult.Exhausted === true) || (tmpRows === 0) || (tmpLastID === pAfterID);
					if (tmpExhausted)
					{
						return this._swap(pBuild);
					}
					return this._nextPage(pBuild, tmpLastID);
				});
		}
		catch (pError)
		{
			tmpCalled = true;
			return this._fail(pBuild, pError, 'RebuildPage', true);
		}
	}

	/**
	 * Every page is in: the WriterLoop flushes and swaps between two flushes (RENAME on a first enable,
	 * EXCHANGE TABLES otherwise), drops the shadows and goes back to [ 'Live' ].
	 *
	 * @param {Record<string, any>} pBuild
	 */
	_swap(pBuild)
	{
		if (pBuild.Ended)
		{
			return;
		}
		pBuild.Phase = 'Swapping';
		let tmpCalled = false;
		try
		{
			pBuild.Loop.finishRebuild(pBuild.BuildID,
				(pError) =>
				{
					if (tmpCalled || pBuild.Ended)
					{
						return;
					}
					tmpCalled = true;
					if (pError)
					{
						return this._swapFailed(pBuild, pError);
					}
					return this._swapped(pBuild);
				});
		}
		catch (pError)
		{
			tmpCalled = true;
			return this._swapFailed(pBuild, pError);
		}
	}

	/**
	 * A swap failed.  The shadow is NEVER dropped now: the mirror may already be exchanged while the
	 * keymap is not (or the client saw an error after a statement landed).  The WriterLoop holds every
	 * write, the entity stays non-Exact (a first enable stays Building; a rebuild is marked like a
	 * divergence rebuild), and finishRebuild is retried with back-off (×2 from 500 ms to MaxBackoffMS):
	 * the store's swap resumes whichever half did not land (it checks the table UUIDs).  Only a loop
	 * that no longer runs this build (stopped, reset by a wipe, crashed) ends it.
	 *
	 * @param {Record<string, any>} pBuild
	 * @param {Error} pError
	 */
	_swapFailed(pBuild, pError)
	{
		let tmpCurrent = (typeof(pBuild.Loop.rebuild) === 'function') ? pBuild.Loop.rebuild() : null;
		let tmpLoopError = pError && pError.LoopError;
		if (!tmpCurrent || (tmpCurrent.BuildID !== pBuild.BuildID) || (tmpLoopError === 'Stopped') || (tmpLoopError === 'NoRebuild') || this._Stopped)
		{
			return this._fail(pBuild, pError, 'finishRebuild', true);
		}
		pBuild.SwapAttempts = (pBuild.SwapAttempts || 0) + 1;
		if (!pBuild.FirstEnable && !pBuild.SwapMarked)
		{
			// Its live table may already be the new build while its keymap is not: never Exact until done.
			pBuild.SwapMarked = true;
			setEntityState(this.fable, pBuild.Store, pBuild.Entity, 'Rebuilding', 'Divergence');
		}
		let tmpMaterializer = this.options.Materializer || {};
		let tmpMax = (Number(tmpMaterializer.MaxBackoffMS) > 0) ? Number(tmpMaterializer.MaxBackoffMS) : 30000;
		let tmpDelay = Math.min(tmpMax, 500 * Math.pow(2, Math.min(10, pBuild.SwapAttempts - 1)));
		this.log.warn(`RetoldFaceting: the swap of ${pBuild.Store}.${pBuild.Entity} (BuildID ${pBuild.BuildID}) failed (${(pError && pError.message) || pError}); retrying in ${tmpDelay} ms (writes wait).`);
		let tmpTimer = setTimeout(
			() =>
			{
				this._Timers.delete(tmpTimer);
				if (pBuild.Ended || this._Stopped)
				{
					return;
				}
				return this._swap(pBuild);
			}, tmpDelay);
		if (typeof(tmpTimer.unref) === 'function')
		{
			tmpTimer.unref();
		}
		this._Timers.add(tmpTimer);
	}

	/**
	 * After the swap: a rebuild is Live at once (its live table was dual-written all along), or
	 * Unverified when divergence triggered it; a first enable is CatchingUp until the hints that
	 * arrived before the swap are applied.
	 *
	 * @param {Record<string, any>} pBuild
	 */
	_swapped(pBuild)
	{
		let tmpSwappedAt = performance.now();
		pBuild.SwappedAtMS = Date.now();
		let tmpLastRebuild = formatUTC(pBuild.SwappedAtMS);
		let tmpFields = { LastRebuild: tmpLastRebuild };
		if (typeof(pBuild.Watermark) === 'string')
		{
			// The source's largest stamp before the first page was read: everything stamped up to it is in
			// the build, so the next Sweep starts there instead of re-reading the whole table.
			tmpFields.SweepWatermark = pBuild.Watermark;
			let tmpReconciler = this.fable.RetoldFacetingReconciler;
			if (tmpReconciler && (typeof(tmpReconciler.seedWatermark) === 'function'))
			{
				tmpReconciler.seedWatermark(pBuild.Store, pBuild.Entity, pBuild.Watermark);
			}
		}
		persistStateFields(this.fable, pBuild.Store, pBuild.Entity, tmpFields,
			(pError) =>
			{
				if (pError)
				{
					this.log.warn(`RetoldFaceting: could not persist LastRebuild of ${pBuild.Store}.${pBuild.Entity}: ${pError.message}`);
				}
			});

		if (!pBuild.FirstEnable)
		{
			let tmpState = (pBuild.Reason === 'Divergence') ? 'Unverified' : 'Live';
			setEntityState(this.fable, pBuild.Store, pBuild.Entity, tmpState, `Rebuilt:${pBuild.Reason}`);
			return this._complete(pBuild, tmpState, true);
		}

		pBuild.Phase = 'CatchingUp';
		setEntityState(this.fable, pBuild.Store, pBuild.Entity, 'CatchingUp', `Rebuilt:${pBuild.Reason}`);

		let tmpReported = false;
		let tmpCallbackTimer = null;
		let fReport = (pState, pCaughtUp) =>
		{
			if (tmpReported)
			{
				return;
			}
			tmpReported = true;
			if (tmpCallbackTimer)
			{
				clearTimeout(tmpCallbackTimer);
				this._Timers.delete(tmpCallbackTimer);
			}
			return this._complete(pBuild, pState, pCaughtUp);
		};
		tmpCallbackTimer = setTimeout(
			() =>
			{
				this._Timers.delete(tmpCallbackTimer);
				tmpCallbackTimer = null;
				fReport(entityState(this.fable, pBuild.Store, pBuild.Entity).State, false);
			}, CATCH_UP_CALLBACK_MS);
		if (typeof(tmpCallbackTimer.unref) === 'function')
		{
			tmpCallbackTimer.unref();
		}
		this._Timers.add(tmpCallbackTimer);

		let fWatch = () =>
		{
			let tmpState = entityState(this.fable, pBuild.Store, pBuild.Entity).State;
			if (tmpState !== 'CatchingUp')
			{
				// Someone else moved it on (the WriterLoop's own drain rule, a write breaker →
				// Degraded, a wipe → Absent): the state machine is theirs now.
				return fReport(tmpState, tmpState === 'Live');
			}
			if (this._drainedSince(pBuild.Store, pBuild.Entity, tmpSwappedAt))
			{
				setEntityState(this.fable, pBuild.Store, pBuild.Entity, 'Live', 'CaughtUp');
				return fReport('Live', true);
			}
			let tmpTimer = setTimeout(
				() =>
				{
					this._Timers.delete(tmpTimer);
					fWatch();
				}, this.pollMS());
			if (typeof(tmpTimer.unref) === 'function')
			{
				tmpTimer.unref();
			}
			this._Timers.add(tmpTimer);
		};
		fWatch();
	}

	/**
	 * The build is done: record it, call every caller back.
	 *
	 * @param {Record<string, any>} pBuild
	 * @param {string} pState
	 * @param {boolean} pCaughtUp
	 */
	_complete(pBuild, pState, pCaughtUp)
	{
		if (pBuild.Ended)
		{
			return;
		}
		pBuild.Ended = true;
		if (this._Running.get(pBuild.Key) === pBuild)
		{
			this._Running.delete(pBuild.Key);
		}
		let tmpElapsed = Date.now() - pBuild.StartMS;
		let tmpResult = { BuildID: pBuild.BuildID, Reason: pBuild.Reason, Pages: pBuild.Pages, Rows: pBuild.Rows, ElapsedMS: tmpElapsed, State: pState, CaughtUp: !!pCaughtUp, FirstEnable: pBuild.FirstEnable };
		this._Completed.set(pBuild.Key, Object.assign({ At: new Date().toISOString(), AtMS: Date.now(), SwappedAtMS: pBuild.SwappedAtMS || Date.now() }, tmpResult));
		this._Stats.Completed++;
		this.log.info(`RetoldFaceting: ${pBuild.FirstEnable ? 'backfill' : 'rebuild'} of ${pBuild.Store}.${pBuild.Entity} done (BuildID ${pBuild.BuildID}, ${pBuild.Pages} pages, ${pBuild.Rows} rows, ${tmpElapsed} ms, ${pState}).`);
		let tmpCallbacks = pBuild.Callbacks.splice(0);
		callAll(tmpCallbacks.map((fCallback) => { return () => { fCallback(null, Object.assign({}, tmpResult)); }; }), []);
	}

	/**
	 * A step failed: abort the build (drop the shadow, targets back to [ 'Live' ]), restore the prior
	 * state and report the error (messages carry no values: store errors never include them).
	 *
	 * @param {Record<string, any>} pBuild
	 * @param {Error} pError
	 * @param {string} pStep
	 * @param {boolean} pAbortLoop - false when beginRebuild itself failed (nothing to abort... but drop leftovers)
	 */
	_fail(pBuild, pError, pStep, pAbortLoop)
	{
		if (pBuild.Ended)
		{
			return;
		}
		this._Stats.Failed++;
		let tmpMessage = (pError && pError.message) ? pError.message : String(pError);
		this.log.error(`RetoldFaceting: ${pBuild.FirstEnable ? 'backfill' : 'rebuild'} of ${pBuild.Store}.${pBuild.Entity} failed at ${pStep} (BuildID ${pBuild.BuildID}): ${tmpMessage}`);
		let tmpError = (pError instanceof Error) ? pError : new Error(tmpMessage);
		if (!tmpError.Step)
		{
			try
			{
				tmpError.Step = pStep;
			}
			catch (pIgnored)
			{
				// a frozen error
			}
		}
		return this._abort(pBuild, tmpError, () => {}, false);
	}

	/**
	 * Abort a build: mark it ended (late completions are ignored), abortRebuild on its loop (best
	 * effort), restore the prior state (unless pKeepState: a superseding wipe sets its own), and call
	 * its callers back with pError.
	 *
	 * @param {Record<string, any>} pBuild
	 * @param {Error} pError
	 * @param {Function} fAfter
	 * @param {boolean} [pKeepState]
	 */
	_abort(pBuild, pError, fAfter, pKeepState)
	{
		if (pBuild.Ended)
		{
			return fAfter();
		}
		pBuild.Ended = true;
		if (this._Running.get(pBuild.Key) === pBuild)
		{
			this._Running.delete(pBuild.Key);
		}
		if (!pKeepState)
		{
			let tmpRestore = pBuild.FirstEnable ? 'Absent' : pBuild.PriorState;
			if (!pBuild.FirstEnable && ((pBuild.Reason === 'Divergence') || pBuild.PriorDivergence))
			{
				// The live table is known to diverge: it may serve Bounded / Fast, never Exact.
				tmpRestore = 'Unverified';
			}
			if ((tmpRestore === 'Rebuilding') || (tmpRestore === 'Building') || (tmpRestore === 'CatchingUp') || (tmpRestore === 'Degraded') || (typeof(tmpRestore) !== 'string'))
			{
				// A catch-up / a write outage the build interrupted is not finished: unproven, verified below.
				tmpRestore = pBuild.FirstEnable ? 'Absent' : 'Unverified';
			}
			setEntityState(this.fable, pBuild.Store, pBuild.Entity, tmpRestore, `RebuildAborted:${pBuild.Reason}`);
			let tmpReconciler = this.fable.RetoldFacetingReconciler;
			if ((tmpRestore === 'Unverified') && !pError.Cancelled && !this._Stopped && tmpReconciler && (typeof(tmpReconciler.verify) === 'function'))
			{
				// Nobody else would lift it: verify in the background (Bisect + a full Scrub).
				let tmpTimer = setTimeout(
					() =>
					{
						this._Timers.delete(tmpTimer);
						if (!this._Stopped)
						{
							tmpReconciler.verify(pBuild.Store, pBuild.Entity, () => {});
						}
					}, 0);
				if (typeof(tmpTimer.unref) === 'function')
				{
					tmpTimer.unref();
				}
				this._Timers.add(tmpTimer);
			}
		}
		let tmpCallbacks = pBuild.Callbacks.splice(0);
		let fNotify = () =>
		{
			callAll(tmpCallbacks, [ pError ]);
			return fAfter();
		};
		let tmpCalled = false;
		try
		{
			pBuild.Loop.abortRebuild(pBuild.BuildID,
				(pAbortError) =>
				{
					if (tmpCalled)
					{
						return;
					}
					tmpCalled = true;
					if (pAbortError)
					{
						this.log.warn(`RetoldFaceting: abortRebuild of ${pBuild.Store}.${pBuild.Entity} (BuildID ${pBuild.BuildID}) reported: ${pAbortError.message}`);
					}
					return fNotify();
				});
		}
		catch (pAbortError)
		{
			if (!tmpCalled)
			{
				tmpCalled = true;
				return fNotify();
			}
		}
	}
}

module.exports = RetoldFacetingRebuilder;
module.exports.serviceType = 'RetoldFacetingRebuilder';
module.exports.REBUILD_REASONS = REBUILD_REASONS;
module.exports.BACKFILL_REASON = BACKFILL_REASON;
module.exports.PHASES = PHASES;
module.exports.CATCH_UP_CALLBACK_MS = CATCH_UP_CALLBACK_MS;
// Shared with the Reconciler (same file family, same owner).
module.exports.newBuildID = newBuildID;
module.exports.callAll = callAll;
module.exports.formatUTC = formatUTC;
module.exports.storeService = storeService;
module.exports.setEntityState = setEntityState;
module.exports.entityState = entityState;
module.exports.persistStateFields = persistStateFields;
