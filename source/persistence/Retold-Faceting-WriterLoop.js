/**
 * Retold Faceting - WriterLoop
 *
 * ONE serialized writer per (store, entity) (design 04 §6; internal-contracts §58.5): every write into
 * the store — stream hints, Resync / Scrub / Fill ranges, rebuild pages — goes through its cycles:
 *
 *   v = WriterClock.next() BEFORE a fresh trusted source read (MaterializeSource-InProcess, no
 *   behaviors, soft-deleted rows included) → the keymap before-image of every target (the store's
 *   keymap with this loop's buffered, not yet flushed intents / retirements applied) → diff
 *   (tombstones for missing / not-live / quarantined rows and for every old key of a moved row,
 *   rows at the new key, keymap intents and retirements) → FlushBuffer → flush (keymap intents →
 *   ONE mirror INSERT with rows + tombstones → keymap retirements, per target, dedup tokens) → ack
 *   (PendingSet.ack, Range task callbacks, AppliedSeq, state row) only after every target's inserts
 *   were acknowledged.
 *
 * Exactly one operation runs at a time: a cycle, a flush, or a control step (beginRebuild,
 * finishRebuild, abortRebuild, flush()), so a swap always happens between two flushes with nothing in
 * flight.  Work is taken in priority order: control steps → a due flush → Stream (≤ BatchIDs pending
 * IDs) → Range tasks (Resync, Scrub, Fill) → RebuildPage.  Stream hints are batched: a cycle starts
 * once BatchIDs IDs wait or the oldest has waited a flush interval (or a flush / quiesce / stop asks),
 * and the flush follows it at once — one source read, one keymap read and one insert set per flush
 * interval per entity, not per write.  A flush is due after FlushIntervalMS (stretched while the store
 * has too many active parts), at FlushRows rows, on request, while stopping, or when a Resync /
 * RebuildPage page waits for it and nothing else is runnable (Scrub / Fill pages wait for the interval).
 * A flush is refused (NotLeader) while this process does not hold the store's lease.
 *
 * Latest-read-wins (04 §6.3); at-least-once and idempotent.  Keymap superset invariant (§58.5): the
 * three inserts of a flush go intents → mirror → retirements, so a partial flush can only leave an
 * extra intent or tombstone, never a ghost row.
 *
 * Constructed by the Materializer (new libX(fable, options, '<Store>:<Entity>')) and attach()ed to its
 * collaborators; never registered.  D's Rebuilder / Reconciler drive addRangeTask / beginRebuild /
 * finishRebuild / abortRebuild.
 *
 * Contract: internal-contracts §58.5–§58.6, §59.  Owner: builder B (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPerfHooks = require('perf_hooks');

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libStoreBase = require('../store/Retold-Faceting-StoreBase.js');
const libTypeMap = require('../store/clickhouse/ClickHouse-TypeMap.js');
const libFlushBuffer = require('./Retold-Faceting-FlushBuffer.js');
const libMaterializeSource = require('./MaterializeSource-InProcess.js');

// Work kinds in priority order (§58.5).
const WORK_KINDS = Object.freeze([ 'Stream', 'Resync', 'Scrub', 'Fill', 'RebuildPage' ]);

// The Range kinds (a queue each, taken in this order after Stream).
const RANGE_KINDS = Object.freeze([ 'Resync', 'Scrub', 'Fill', 'RebuildPage' ]);

// Test-only hook points (§58.5): setTestHook(pName, fHook).
const TEST_HOOKS = Object.freeze([ 'afterRead', 'afterFlushBeforeAck', 'beforeSwap' ]);

// ClickHouse codes of a missing database / table (StoreClickHouse.WIPE_ERROR_CODES, §59.3).
const DEFAULT_WIPE_CODES = Object.freeze([ 60, 81 ]);

// The first back-off step after a failure (doubles up to Materializer.MaxBackoffMS).
const FIRST_BACKOFF_MS = 100;

// Stream cycles in a row before a runnable Range task gets one (no starvation under a firehose).
const STREAM_BURST = 8;

// Range kinds whose callers wait on the flush (a rebuild page, a Resync pass): their pages flush at
// once when nothing else is runnable.  Scrub / Fill pages wait for the normal flush interval.
const PROMPT_KINDS = Object.freeze([ 'Resync', 'RebuildPage' ]);

// Per column, the most IDs whose Lossy value the loop tracks; beyond it the flag sticks until the next
// full Scrub rotation or rebuild re-establishes it.
const LOSSY_ID_CAP = 10000;

const keyText = libFlushBuffer.keyText;
const toID = libMaterializeSource.toID;

/**
 * A loop error (never carries values).
 *
 * @param {string} pMessage
 * @param {string} [pCode]
 * @return {Error}
 */
const loopError = (pMessage, pCode) =>
{
	let tmpError = new Error(`RetoldFacetingWriterLoop: ${pMessage}`);
	tmpError.LoopError = pCode || 'Loop';
	return tmpError;
};

/**
 * Merge Lossy flags ('Value' beats 'Compare'); returns true when anything changed.
 *
 * @param {Record<string, string>} pInto
 * @param {Record<string, string>} pFrom
 * @return {boolean}
 */
const mergeLossy = (pInto, pFrom) =>
{
	let tmpChanged = false;
	if (!pFrom || (typeof(pFrom) !== 'object'))
	{
		return false;
	}
	Object.keys(pFrom).forEach(
		(pColumn) =>
		{
			let tmpFlag = pFrom[pColumn];
			if ((tmpFlag !== 'Value') && (tmpFlag !== 'Compare'))
			{
				return;
			}
			if ((pInto[pColumn] === 'Value') || (pInto[pColumn] === tmpFlag))
			{
				return;
			}
			pInto[pColumn] = tmpFlag;
			tmpChanged = true;
		});
	return tmpChanged;
};

class RetoldFacetingWriterLoop extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash] - '<Store>:<Entity>'
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingWriterLoop';

		let tmpMaterializer = this.options.Materializer || {};
		this.BatchIDs = ((typeof(tmpMaterializer.BatchIDs) === 'number') && (tmpMaterializer.BatchIDs > 0)) ? tmpMaterializer.BatchIDs : 2000;
		this.RebuildPageSize = ((typeof(tmpMaterializer.RebuildPageSize) === 'number') && (tmpMaterializer.RebuildPageSize > 0)) ? tmpMaterializer.RebuildPageSize : 100000;
		this.MaxBackoffMS = ((typeof(tmpMaterializer.MaxBackoffMS) === 'number') && (tmpMaterializer.MaxBackoffMS > 0)) ? tmpMaterializer.MaxBackoffMS : 30000;
		this.IdleTickMS = ((typeof(tmpMaterializer.IdleTickMS) === 'number') && (tmpMaterializer.IdleTickMS > 0)) ? tmpMaterializer.IdleTickMS : 50;
		// How long a stream hint waits for company before its cycle: 'Auto' = the flush interval in force
		// (batched: about one cycle and one flush per interval); 0 = a cycle as soon as a hint arrives,
		// buffered until the flush interval (the unit tests drive cycles and flushes that way).
		this.StreamDelayMS = ((typeof(tmpMaterializer.StreamDelayMS) === 'number') && (tmpMaterializer.StreamDelayMS >= 0)) ? tmpMaterializer.StreamDelayMS : 'Auto';
		// The Range kinds whose pages flush as soon as nothing else is runnable (their callers wait on the
		// flush); the others wait for the flush interval.
		this.PromptKinds = Array.isArray(tmpMaterializer.PromptRangeKinds) ? tmpMaterializer.PromptRangeKinds.filter((pKind) => { return RANGE_KINDS.indexOf(pKind) >= 0; }) : PROMPT_KINDS.slice();

		// Collaborators (attach()); nothing runs before.
		this._Context = null;
		this._Spec = null;
		// Target → the spec that target's tables were built with (the live tables keep the old spec
		// through a SpecChange rebuild); absent = this._Spec.
		this._TargetSpecs = {};

		this._Targets = [];
		this._Hooks = {};
		this._Tasks = { Resync: [], Scrub: [], Fill: [], RebuildPage: [] };
		this._Control = [];
		this._Busy = false;
		this._StreamBurst = 0;
		this._Halted = false;
		this._Stopping = false;
		this._ForceFlush = false;
		this._Immediate = null;
		this._Timer = null;
		this._TimerAt = null;
		this._BackoffMS = 0;
		this._BackoffUntil = 0;
		this._LastFlushOK = true;
		this._Rebuild = null;
		this._SwapBlocked = null;
		this._Resync = null;
		// Lossy flags (§56.3): per column, the IDs of the LIVE mirror's rows whose value is lossy (a row
		// re-read with a clean value, or tombstoned, leaves its column's set — a corrected value clears
		// the flag), plus 'sticky' flags whose rows are unknown (seeded from the state row, an
		// unparseable identity, a set over LOSSY_ID_CAP) until a full Scrub rotation or a rebuild.
		this._LossyIDs = {};
		this._LossySticky = {};
		this._LossyStickySince = 0;
		this._RebuildLossy = null;
		this._Quarantined = new Set();
		this._Stats = { Cycles: 0, StreamCycles: 0, RangeCycles: 0, Flushes: 0, FlushErrors: 0, ReadErrors: 0, Rows: 0, Tombstones: 0, Inserts: 0, LastFlushAt: null, LastError: null, LastErrorCode: null };

		// The local monotonic clock (tests may replace it, together with the Materializer's).
		this.monotonicNow = () => { return libPerfHooks.performance.now(); };
		// The value conversion (TypeMap; a test may replace it).
		this.toStoreRow = libTypeMap.toStoreRow;
	}

	// ---- wiring -------------------------------------------------------------------------------

	/**
	 * Attach the collaborators (the Materializer calls it once the store is up and the spec compiled).
	 *
	 * @param {{ StoreName: string, Entity: string, Store: any, Spec: Record<string, any>, Clock: any, PendingSet: any, FlushBuffer: any, Source: any, Freshness?: any, Targets?: Array<string>, Dialect?: string|null, onFlushed?: Function, onWipe?: Function, onSwapped?: Function }} pContext
	 * @return {RetoldFacetingWriterLoop}
	 */
	attach(pContext)
	{
		this._Context = Object.assign({}, pContext);
		this._Halted = false;
		this.setSpec(pContext.Spec, { LiveChanged: true });
		this._Targets = Array.isArray(pContext.Targets) ? pContext.Targets.slice() : [ libStoreBase.TARGET_LIVE ];
		this.kick();
		return this;
	}

	/**
	 * @return {boolean}
	 */
	attached()
	{
		return !!this._Context && !this._Halted;
	}

	/**
	 * Replace the spec (a model reload).  The spec each target's tables follow is kept: a pinned live
	 * spec (a SpecChange rebuild in flight) and a shadow's spec stay pinned until finishRebuild /
	 * abortRebuild / reset — a second reload never retargets tables whose layout did not change.
	 * KeepLiveSpec: pin the current spec as the live tables' layout first (a non-additive change: the
	 * live tables keep it until the shadow is swapped in).  LiveChanged: the live tables now follow the
	 * new spec (attach, an additive ALTER that succeeded, a wipe recovery) — every pin is dropped.
	 *
	 * @param {Record<string, any>} pSpec
	 * @param {{ KeepLiveSpec?: boolean, LiveChanged?: boolean }} [pOptions]
	 */
	setSpec(pSpec, pOptions)
	{
		let tmpOptions = pOptions || {};
		if (tmpOptions.LiveChanged)
		{
			this._TargetSpecs = {};
		}
		else if (tmpOptions.KeepLiveSpec && this._Spec && !this._TargetSpecs[libStoreBase.TARGET_LIVE])
		{
			this._TargetSpecs[libStoreBase.TARGET_LIVE] = this._Spec;
		}
		this._Spec = pSpec;
		this._keyColumnsChanged();
	}

	/**
	 * @return {Record<string, any>|null} the current (newest) spec
	 */
	spec()
	{
		return this._Spec;
	}

	/**
	 * The spec a target's tables follow.
	 *
	 * @param {string} pTarget
	 * @return {Record<string, any>}
	 */
	specFor(pTarget)
	{
		return this._TargetSpecs[pTarget] || this._Spec;
	}

	/**
	 * Tell the FlushBuffer which columns form a key (the live spec's, the only one that differs during
	 * a SpecChange rebuild is the shadow's, whose keys are written fresh).
	 */
	_keyColumnsChanged()
	{
		let tmpBuffer = this._Context ? this._Context.FlushBuffer : null;
		let tmpSpec = this.specFor(libStoreBase.TARGET_LIVE);
		if (tmpBuffer && tmpSpec && (typeof(tmpBuffer.setKeyColumns) === 'function'))
		{
			tmpBuffer.setKeyColumns(tmpSpec.Identity, libTypeMap.keyColumnsOf(tmpSpec));
		}
	}

	/**
	 * @return {Array<string>}
	 */
	targets()
	{
		return this._Targets.slice();
	}

	/**
	 * Set the targets (the Materializer: [ 'Live' ] when a live table exists, [] before a backfill).
	 *
	 * @param {Array<string>} pTargets
	 */
	setTargets(pTargets)
	{
		this._Targets = Array.isArray(pTargets) ? pTargets.slice() : [];
		this.kick();
	}

	/**
	 * @param {string} pName - one of TEST_HOOKS
	 * @param {Function|null} fHook - (pInfo) or (pInfo, fNext)
	 */
	setTestHook(pName, fHook)
	{
		if (TEST_HOOKS.indexOf(pName) < 0)
		{
			throw new Error(`RetoldFacetingWriterLoop: unknown test hook ${pName}.`);
		}
		this._Hooks[pName] = (typeof(fHook) === 'function') ? fHook : null;
	}

	/**
	 * Run a test hook (sync or async); production has none.
	 *
	 * @param {string} pName
	 * @param {Record<string, any>} pInfo
	 * @param {() => void} fNext
	 */
	_hook(pName, pInfo, fNext)
	{
		let fHook = this._Hooks[pName];
		if (!fHook)
		{
			return fNext();
		}
		if (fHook.length >= 2)
		{
			return fHook(pInfo, () => { return fNext(); });
		}
		fHook(pInfo);
		return fNext();
	}

	/**
	 * The entity's Lossy flags (a copy).
	 *
	 * @return {Record<string, string>}
	 */
	lossy()
	{
		let tmpLossy = Object.assign({}, this._LossySticky);
		Object.keys(this._LossyIDs).forEach(
			(pColumn) =>
			{
				let tmpFlags = this._LossyIDs[pColumn];
				if (tmpFlags.size < 1)
				{
					return;
				}
				let tmpFlag = 'Compare';
				for (let tmpValue of tmpFlags.values())
				{
					if (tmpValue === 'Value')
					{
						tmpFlag = 'Value';
						break;
					}
				}
				let tmpOne = {};
				tmpOne[pColumn] = tmpFlag;
				mergeLossy(tmpLossy, tmpOne);
			});
		return tmpLossy;
	}

	/**
	 * Seed the Lossy flags (from the persisted state row): sticky — the rows behind them are unknown
	 * until a full Scrub rotation (or a rebuild) re-reads every row.
	 *
	 * @param {Record<string, string>} pLossy
	 */
	seedLossy(pLossy)
	{
		if (mergeLossy(this._LossySticky, pLossy))
		{
			this._LossyStickySince = Date.now();
		}
	}

	/**
	 * A full Scrub rotation that started at pPassStartMS (wall clock) re-read every live row: sticky
	 * flags seeded before it started are now known row by row (the per-ID sets), so they clear.
	 *
	 * @param {number} pPassStartMS
	 * @return {boolean} something cleared
	 */
	clearStickyLossy(pPassStartMS)
	{
		if (!Number.isFinite(pPassStartMS) || (pPassStartMS < this._LossyStickySince) || (Object.keys(this._LossySticky).length < 1))
		{
			return false;
		}
		this._LossySticky = {};
		return true;
	}

	/**
	 * Track one row's Lossy columns (§56.3): set for its lossy columns, cleared for the rest.
	 *
	 * @param {Record<string, Map<number, string>>} pIDs - the per-column ID maps to update
	 * @param {Record<string, string>} pSticky
	 * @param {number} pID
	 * @param {Record<string, string>|null} pLossy - the row's flags; null = the row left the mirror
	 */
	_trackLossy(pIDs, pSticky, pID, pLossy)
	{
		let tmpLossy = pLossy || {};
		Object.keys(pIDs).forEach(
			(pColumn) =>
			{
				if (!Object.prototype.hasOwnProperty.call(tmpLossy, pColumn))
				{
					pIDs[pColumn].delete(pID);
				}
			});
		Object.keys(tmpLossy).forEach(
			(pColumn) =>
			{
				let tmpFlag = tmpLossy[pColumn];
				if ((tmpFlag !== 'Value') && (tmpFlag !== 'Compare'))
				{
					return;
				}
				if (!pIDs[pColumn])
				{
					pIDs[pColumn] = new Map();
				}
				pIDs[pColumn].set(pID, tmpFlag);
				if (pIDs[pColumn].size > LOSSY_ID_CAP)
				{
					// Too many to track: the column stays flagged until the next full rotation / rebuild.
					let tmpOne = {};
					tmpOne[pColumn] = 'Compare';
					for (let tmpValue of pIDs[pColumn].values())
					{
						if (tmpValue === 'Value')
						{
							tmpOne[pColumn] = 'Value';
							break;
						}
					}
					mergeLossy(pSticky, tmpOne);
					delete pIDs[pColumn];
				}
			});
	}


	/**
	 * @return {number} rows currently quarantined (live except an unset tenant)
	 */
	quarantined()
	{
		return this._Quarantined.size;
	}

	/**
	 * @return {null|{ BuildID: string, FirstEnable: boolean, Target: string }}
	 */
	rebuild()
	{
		return this._Rebuild ? { BuildID: this._Rebuild.BuildID, FirstEnable: this._Rebuild.FirstEnable, Target: this._Rebuild.Target } : null;
	}

	/**
	 * Range tasks queued per kind, and whether a Resync pass is running.
	 *
	 * @return {{ Resync: number, Scrub: number, Fill: number, RebuildPage: number, ResyncRunning: boolean, Total: number }}
	 */
	taskInfo()
	{
		let tmpInfo = { ResyncRunning: !!this._Resync, Total: 0 };
		RANGE_KINDS.forEach((pKind) => { tmpInfo[pKind] = this._Tasks[pKind].length; tmpInfo.Total += this._Tasks[pKind].length; });
		return tmpInfo;
	}

	// ---- scheduling ---------------------------------------------------------------------------

	/**
	 * New work may be available: run soon.
	 */
	kick()
	{
		this._schedule(0);
	}

	/**
	 * @param {number} pDelayMS
	 */
	_schedule(pDelayMS)
	{
		if (this._Halted || !this._Context || this._Busy)
		{
			return;
		}
		let tmpNow = Date.now();
		let tmpDelay = Math.max(0, pDelayMS || 0);
		if (tmpNow < this._BackoffUntil)
		{
			tmpDelay = Math.max(tmpDelay, this._BackoffUntil - tmpNow);
		}
		if (tmpDelay === 0)
		{
			if (!this._Immediate)
			{
				this._Immediate = setImmediate(() => { this._Immediate = null; this._tick(); });
			}
			return;
		}
		let tmpAt = tmpNow + tmpDelay;
		if (this._Timer && (this._TimerAt <= tmpAt))
		{
			return;
		}
		if (this._Timer)
		{
			clearTimeout(this._Timer);
		}
		this._TimerAt = tmpAt;
		this._Timer = setTimeout(() => { this._Timer = null; this._TimerAt = null; this._tick(); }, tmpDelay);
		if (typeof(this._Timer.unref) === 'function')
		{
			this._Timer.unref();
		}
	}

	/**
	 * Clear the timers.
	 */
	_clearTimers()
	{
		if (this._Immediate)
		{
			clearImmediate(this._Immediate);
			this._Immediate = null;
		}
		if (this._Timer)
		{
			clearTimeout(this._Timer);
			this._Timer = null;
			this._TimerAt = null;
		}
	}

	/**
	 * Run the next operation, if any.
	 */
	_tick()
	{
		if (this._Halted || !this._Context || this._Busy)
		{
			return;
		}
		if (Date.now() < this._BackoffUntil)
		{
			return this._schedule(this._BackoffUntil - Date.now());
		}
		let fOperation = this._nextOperation();
		if (!fOperation)
		{
			// Idle: wake up when the buffer's interval makes a flush due, or the oldest waiting hint's cycle.
			let tmpDue = this._Context.FlushBuffer.dueInMS(Date.now());
			let tmpPending = this._Context.PendingSet;
			if ((this._Targets.length > 0) && (tmpPending.available() > 0) && (typeof(tmpPending.oldestAvailableFirstSeen) === 'function'))
			{
				let tmpOldest = tmpPending.oldestAvailableFirstSeen();
				let tmpStreamIn = (tmpOldest === null) ? null : Math.max(0, this._streamDelayMS() - (this.monotonicNow() - tmpOldest));
				tmpDue = (tmpDue === null) ? tmpStreamIn : ((tmpStreamIn === null) ? tmpDue : Math.min(tmpDue, tmpStreamIn));
			}
			if (tmpDue !== null)
			{
				this._schedule(Math.max(1, Math.min(tmpDue, this.IdleTickMS)));
			}
			return;
		}
		this._Busy = true;
		let tmpDone = false;
		let fDone = () =>
		{
			if (tmpDone)
			{
				return;
			}
			tmpDone = true;
			this._Busy = false;
			if (!this._Halted)
			{
				this._schedule(0);
			}
		};
		try
		{
			fOperation(fDone);
		}
		catch (pError)
		{
			this.fable.log.error(`RetoldFaceting WriterLoop ${this.Hash || ''}: an operation threw: ${pError.message}`);
			this._fail(pError, null);
			fDone();
		}
	}

	/**
	 * The next runnable operation (a function of fDone), or null.
	 *
	 * @return {Function|null}
	 */
	_nextOperation()
	{
		if (this._Control.length > 0)
		{
			let tmpControl = this._Control.shift();
			return (fDone) => { return tmpControl.Run(fDone); };
		}
		if (this._SwapBlocked)
		{
			// A swap failed part way (one table exchanged, the other not): nothing is written until the
			// Rebuilder's retry of finishRebuild completes it (the targets' tables are not consistent).
			return null;
		}
		let tmpBuffer = this._Context.FlushBuffer;
		let tmpNow = Date.now();
		let tmpHasTargets = (this._Targets.length > 0);
		let tmpStreamReady = tmpHasTargets && this._streamDue();
		if (tmpBuffer.size() > 0)
		{
			let tmpTaskWaiting = !tmpStreamReady && !this._runnableTask() && this._bufferHasTask();
			if ((this._ForceFlush && !tmpStreamReady) || this._Stopping || tmpBuffer.due(tmpNow) || tmpTaskWaiting)
			{
				return (fDone) => { return this._flush(fDone); };
			}
		}
		// Stream first (freshness), but never so long that Range work (a rebuild page, a Resync) starves
		// under a write firehose: after STREAM_BURST stream cycles in a row a runnable Range task goes.
		if (tmpStreamReady && ((this._StreamBurst < STREAM_BURST) || !this._runnableTask()))
		{
			this._StreamBurst++;
			return (fDone) =>
			{
				return this._streamCycle(
					() =>
					{
						// Batched: the hints waited their flush interval already — flush with this cycle at
						// once (one cycle per flush, never a cycle per write).  Eager (StreamDelayMS 0): the
						// buffer's own interval decides.
						if (this._Context && (this._Context.FlushBuffer.size() > 0) && (this._streamDelayMS() > 0))
						{
							this._ForceFlush = true;
						}
						return fDone();
					});
			};
		}
		this._StreamBurst = 0;
		if (tmpHasTargets && !this._Resync)
		{
			let tmpDirty = this._Context.PendingSet.dirty();
			if (tmpDirty)
			{
				this._Resync = { Generation: tmpDirty.Generation };
				this._Tasks.Resync.unshift({ Kind: 'Resync', Target: null, AfterID: null, ToID: null, Cap: this.RebuildPageSize, Internal: true, fOnDone: null });
			}
		}
		let tmpTask = this._runnableTask();
		if (tmpTask)
		{
			return (fDone) => { return this._rangeCycle(tmpTask, fDone); };
		}
		return null;
	}

	/**
	 * Is a stream cycle due?  Hints are batched: a cycle starts once BatchIDs IDs wait, or the oldest
	 * waiting hint is a flush interval old, or a flush / quiesce / stop asks for it — so source reads and
	 * keymap reads run about once per flush interval per entity, not once per write (the flush follows
	 * the cycle at once, so the lag stays about one flush interval).
	 *
	 * @return {boolean}
	 */
	_streamDue()
	{
		let tmpPending = this._Context.PendingSet;
		let tmpAvailable = tmpPending.available();
		if (tmpAvailable < 1)
		{
			return false;
		}
		if (this._ForceFlush || this._Stopping || (tmpAvailable >= this.BatchIDs) || (typeof(tmpPending.oldestAvailableFirstSeen) !== 'function'))
		{
			return true;
		}
		let tmpOldest = tmpPending.oldestAvailableFirstSeen();
		return (tmpOldest !== null) && ((this.monotonicNow() - tmpOldest) >= this._streamDelayMS());
	}

	/**
	 * How long a hint waits for company before its cycle (the flush interval in force).
	 *
	 * @return {number}
	 */
	_streamDelayMS()
	{
		if (typeof(this.StreamDelayMS) === 'number')
		{
			return this.StreamDelayMS;
		}
		let tmpBuffer = this._Context ? this._Context.FlushBuffer : null;
		return (tmpBuffer && (typeof(tmpBuffer.intervalMS) === 'function')) ? tmpBuffer.intervalMS() : 0;
	}

	/**
	 * The first queued Range task that may run now (it stays queued until its cycle starts).
	 *
	 * @return {Record<string, any>|null}
	 */
	_runnableTask()
	{
		for (let i = 0; i < RANGE_KINDS.length; i++)
		{
			let tmpKind = RANGE_KINDS[i];
			if (this._Stopping && (tmpKind !== 'Resync'))
			{
				continue;
			}
			if ((tmpKind === 'Resync') && (this._Targets.length < 1))
			{
				continue;
			}
			if (this._Tasks[tmpKind].length > 0)
			{
				return this._Tasks[tmpKind][0];
			}
		}
		return null;
	}

	/**
	 * @return {boolean} a buffered cycle belongs to a Range task (its caller waits for the flush)
	 */
	_bufferHasTask()
	{
		return this._Context.FlushBuffer.hasTaskCycle(this.PromptKinds);
	}

	/**
	 * Remove a task from its queue.
	 *
	 * @param {Record<string, any>} pTask
	 */
	_dequeue(pTask)
	{
		let tmpQueue = this._Tasks[pTask.Kind];
		let tmpIndex = tmpQueue.indexOf(pTask);
		if (tmpIndex >= 0)
		{
			tmpQueue.splice(tmpIndex, 1);
		}
	}

	/**
	 * Put a task back at the front of its queue (its cycle or flush failed; a retry is a new cycle).
	 *
	 * @param {Record<string, any>} pTask
	 */
	_requeue(pTask)
	{
		if (this._Tasks[pTask.Kind].indexOf(pTask) < 0)
		{
			this._Tasks[pTask.Kind].unshift(pTask);
		}
	}

	/**
	 * Call a task's callback (never twice; never throws into the loop).
	 *
	 * @param {Record<string, any>} pTask
	 * @param {Error|null} pError
	 * @param {Record<string, any>} [pResult]
	 */
	_finishTask(pTask, pError, pResult)
	{
		if (pTask.Done)
		{
			return;
		}
		pTask.Done = true;
		if (typeof(pTask.fOnDone) !== 'function')
		{
			return;
		}
		// fOnDone is deferred (addRangeTask): it never runs inside the loop's own stack.
		pTask.fOnDone(pError || null, pResult);
	}

	/**
	 * Fail every queued task matching a predicate.
	 *
	 * @param {(pTask: Record<string, any>) => boolean} fMatch
	 * @param {Error} pError
	 */
	_failTasks(fMatch, pError)
	{
		RANGE_KINDS.forEach(
			(pKind) =>
			{
				let tmpKeep = [];
				let tmpFail = [];
				this._Tasks[pKind].forEach((pTask) => { (fMatch(pTask) ? tmpFail : tmpKeep).push(pTask); });
				this._Tasks[pKind] = tmpKeep;
				tmpFail.forEach(
					(pTask) =>
					{
						if (pTask.Internal && (pTask.Kind === 'Resync'))
						{
							this._Resync = null;
						}
						this._finishTask(pTask, pError);
					});
			});
	}

	/**
	 * A failure: count it, back off (×2 from 100 ms to MaxBackoffMS), report a wipe.
	 *
	 * @param {Error} pError
	 * @param {'Read'|'Store'|null} pKind - 'Store' failures count on the write breaker
	 */
	_fail(pError, pKind)
	{
		this._Stats.LastError = (pError && pError.message) ? String(pError.message).slice(0, 400) : 'error';
		this._Stats.LastErrorCode = (pError && (pError.Code !== undefined)) ? pError.Code : null;
		this._BackoffMS = this._BackoffMS ? Math.min(this._BackoffMS * 2, this.MaxBackoffMS) : FIRST_BACKOFF_MS;
		this._BackoffUntil = Date.now() + this._BackoffMS;
		if ((pKind === 'Store') && !(pError && pError.NotLeader))
		{
			let tmpFreshness = this._Context ? this._Context.Freshness : null;
			if (tmpFreshness && (typeof(tmpFreshness.recordWriteFailure) === 'function'))
			{
				tmpFreshness.recordWriteFailure(this._Context.StoreName, this._Context.Entity);
			}
			if (this._isWipe(pError) && this._Context && (typeof(this._Context.onWipe) === 'function'))
			{
				let tmpStoreName = this._Context.StoreName;
				setImmediate(() => { this._Context.onWipe(tmpStoreName, pError); });
			}
		}
	}

	/**
	 * Is this a missing database / table error (a wiped store, §59.3)?
	 *
	 * @param {Error} pError
	 * @return {boolean}
	 */
	_isWipe(pError)
	{
		if (!pError || (pError.Code === undefined) || (pError.Code === null))
		{
			return false;
		}
		let tmpStore = this._Context ? this._Context.Store : null;
		let tmpCodes = (tmpStore && tmpStore.constructor && Array.isArray(tmpStore.constructor.WIPE_ERROR_CODES)) ? tmpStore.constructor.WIPE_ERROR_CODES : DEFAULT_WIPE_CODES;
		return tmpCodes.indexOf(Number(pError.Code)) >= 0;
	}

	/**
	 * The source dialect of the entity.
	 *
	 * @return {string}
	 */
	_dialect()
	{
		if (this._Context.Dialect)
		{
			return this._Context.Dialect;
		}
		let tmpSource = this._Context.Source;
		let tmpDialect = (tmpSource && (typeof(tmpSource.dialect) === 'function')) ? tmpSource.dialect(this._Context.Entity) : null;
		return tmpDialect || 'SQLite';
	}

	/**
	 * The columns a read projects: every target spec's SourceColumns.
	 *
	 * @param {Array<string>} pTargets
	 * @return {Array<string>}
	 */
	_sourceColumns(pTargets)
	{
		let tmpColumns = [];
		let fAdd = (pSpec) =>
		{
			let tmpList = (pSpec && Array.isArray(pSpec.SourceColumns)) ? pSpec.SourceColumns
				: ((pSpec && Array.isArray(pSpec.Columns)) ? pSpec.Columns.map((pColumn) => { return pColumn.Column; }) : []);
			tmpList.forEach((pColumn) => { if (tmpColumns.indexOf(pColumn) < 0) { tmpColumns.push(pColumn); } });
		};
		fAdd(this._Spec);
		(pTargets || []).forEach((pTarget) => { fAdd(this.specFor(pTarget)); });
		return tmpColumns;
	}

	// ---- cycles -------------------------------------------------------------------------------

	/**
	 * A Stream cycle: ≤ BatchIDs pending IDs.
	 *
	 * @param {() => void} fDone
	 */
	_streamCycle(fDone)
	{
		let tmpContext = this._Context;
		let tmpVersion = tmpContext.Clock.next();
		let tmpTaken = tmpContext.PendingSet.take(this.BatchIDs);
		if (tmpTaken.length < 1)
		{
			return fDone();
		}
		let tmpReadStart = this.monotonicNow();
		let tmpIDs = tmpTaken.map((pEntry) => { return pEntry.ID; });
		let tmpTargets = this.targets();
		let fRelease = (pError, pKind) =>
		{
			tmpContext.PendingSet.release(tmpTaken);
			this._fail(pError, pKind);
			return fDone();
		};
		tmpContext.Source.readRows(tmpContext.Entity, tmpIDs, { Columns: this._sourceColumns(tmpTargets) },
			(pReadError, pRows) =>
			{
				if (this._Halted)
				{
					return fDone();
				}
				if (pReadError)
				{
					this._Stats.ReadErrors++;
					this.fable.log.warn(`RetoldFaceting WriterLoop ${this.Hash || ''}: the source read failed (${pReadError.message}); retrying.`);
					return fRelease(pReadError, 'Read');
				}
				this._hook('afterRead', { Kind: 'Stream', IDs: tmpIDs.slice(), Version: tmpVersion },
					() =>
					{
						if (this._Halted)
						{
							return fDone();
						}
						let tmpSourceByID = this._indexSource(pRows);
						this._diffTargets(tmpTargets, tmpIDs, tmpSourceByID, null, tmpVersion,
							(pDiffError, pBatches) =>
							{
								if (this._Halted)
								{
									return fDone();
								}
								if (pDiffError)
								{
									return fRelease(pDiffError, 'Store');
								}
								let tmpCycle = { Version: tmpVersion, ReadStart: tmpReadStart, Taken: tmpTaken, Kind: 'Stream', Task: null, Result: null };
								this._append(tmpTargets, pBatches, tmpCycle);
								this._Stats.Cycles++;
								this._Stats.StreamCycles++;
								return fDone();
							});
					});
			});
	}

	/**
	 * A Range cycle: one page of a Resync / Scrub / Fill / RebuildPage task.
	 *
	 * @param {Record<string, any>} pTask
	 * @param {() => void} fDone
	 */
	_rangeCycle(pTask, fDone)
	{
		let tmpContext = this._Context;
		this._dequeue(pTask);
		// The targets this task writes: a rebuild page only its shadow, a Resync every target (hinted
		// changes dual-write), a Scrub / Fill its own target.
		let tmpTargets;
		if (pTask.Kind === 'Resync')
		{
			tmpTargets = this.targets();
		}
		else
		{
			tmpTargets = (this._Targets.indexOf(pTask.Target) >= 0) ? [ pTask.Target ] : [];
			if ((pTask.Kind === 'RebuildPage') && (!this._Rebuild || (this._Rebuild.Target !== pTask.Target)))
			{
				tmpTargets = [];
			}
		}
		if (tmpTargets.length < 1)
		{
			if (pTask.Kind === 'Resync')
			{
				// No table to write yet: wait for one.
				this._requeue(pTask);
				return fDone();
			}
			this._finishTask(pTask, loopError(`the target ${pTask.Target} of a ${pTask.Kind} task is not a current target.`, 'TargetGone'));
			return fDone();
		}
		let tmpVersion = tmpContext.Clock.next();
		let tmpReadStart = this.monotonicNow();
		let tmpAfterID = ((pTask.AfterID === null) || (pTask.AfterID === undefined)) ? null : pTask.AfterID;
		let tmpToID = ((pTask.ToID === null) || (pTask.ToID === undefined)) ? null : pTask.ToID;
		let fRetry = (pError, pKind) =>
		{
			this._requeue(pTask);
			this._fail(pError, pKind);
			return fDone();
		};
		tmpContext.Source.readRange(tmpContext.Entity, tmpAfterID, pTask.Cap, { Columns: this._sourceColumns(tmpTargets), ToID: tmpToID },
			(pReadError, pRows) =>
			{
				if (this._Halted)
				{
					return fDone();
				}
				if (pReadError)
				{
					this._Stats.ReadErrors++;
					this.fable.log.warn(`RetoldFaceting WriterLoop ${this.Hash || ''}: a ${pTask.Kind} read failed (${pReadError.message}); retrying.`);
					return fRetry(pReadError, 'Read');
				}
				this._hook('afterRead', { Kind: pTask.Kind, AfterID: tmpAfterID, Rows: pRows.length, Version: tmpVersion },
					() =>
					{
						if (this._Halted)
						{
							return fDone();
						}
						let tmpSourceByID = this._indexSource(pRows);
						let tmpLastID = null;
						tmpSourceByID.forEach((pRow, pID) => { if ((tmpLastID === null) || (pID > tmpLastID)) { tmpLastID = pID; } });
						let tmpExhausted = (pRows.length < pTask.Cap);
						// A short page ends the pass: its keymap coverage runs to ToID (or +∞), so a
						// hard-deleted tail is tombstoned too.
						let tmpCoverTo = tmpExhausted ? tmpToID : tmpLastID;
						this._diffTargets(tmpTargets, null, tmpSourceByID, { AfterID: tmpAfterID, ToID: tmpCoverTo }, tmpVersion,
							(pDiffError, pBatches) =>
							{
								if (this._Halted)
								{
									return fDone();
								}
								if (pDiffError)
								{
									return fRetry(pDiffError, 'Store');
								}
								let tmpCycle = (
									{
										Version: tmpVersion,
										ReadStart: tmpReadStart,
										Taken: null,
										Kind: pTask.Kind,
										Task: pTask,
										Result: { LastID: tmpLastID, Rows: pRows.length, Exhausted: tmpExhausted }
									});
								this._append(tmpTargets, pBatches, tmpCycle);
								this._Stats.Cycles++;
								this._Stats.RangeCycles++;
								return fDone();
							});
					});
			});
	}

	/**
	 * Source rows by (safe integer) identity; a row whose identity is not one is skipped and makes the
	 * identity Lossy (the entity becomes ineligible, §56.3).
	 *
	 * @param {Array<Record<string, any>>} pRows
	 * @return {Map<number, Record<string, any>>}
	 */
	_indexSource(pRows)
	{
		let tmpIdentity = this._Spec.Identity;
		let tmpByID = new Map();
		(Array.isArray(pRows) ? pRows : []).forEach(
			(pRow) =>
			{
				let tmpID = toID(pRow[tmpIdentity]);
				if (tmpID === null)
				{
					let tmpFlag = {};
					tmpFlag[tmpIdentity] = 'Value';
					if (mergeLossy(this._LossySticky, tmpFlag))
					{
						this._LossyStickySince = Date.now();
					}
					if (this._RebuildLossy)
					{
						mergeLossy(this._RebuildLossy.Sticky, tmpFlag);
					}
					return;
				}
				tmpByID.set(tmpID, pRow);
			});
		return tmpByID;
	}

	/**
	 * Read the before-image of every target and diff (serially, one target after the other).
	 *
	 * @param {Array<string>} pTargets
	 * @param {Array<number>|null} pIDs - Stream: the IDs; Range: null (source ∪ keymap ∪ buffered IDs of the range)
	 * @param {Map<number, Record<string, any>>} pSourceByID
	 * @param {{ AfterID: number|null, ToID: number|null }|null} pRange
	 * @param {number} pVersion
	 * @param {(pError?: Error, pBatches?: Record<string, Record<string, Array<any>>>) => void} fCallback
	 */
	_diffTargets(pTargets, pIDs, pSourceByID, pRange, pVersion, fCallback)
	{
		let tmpContext = this._Context;
		let tmpBatches = {};
		let tmpDialect = this._dialect();
		let tmpConverted = new Map();
		let tmpIndex = 0;
		let fNext = () =>
		{
			if (tmpIndex >= pTargets.length)
			{
				return fCallback(null, tmpBatches);
			}
			let tmpTarget = pTargets[tmpIndex++];
			let fKeys = (pKeysDone) =>
			{
				if (pRange)
				{
					return tmpContext.Store.readKeyRange(tmpContext.Entity, pRange.AfterID, pRange.ToID, tmpTarget, pKeysDone);
				}
				return tmpContext.Store.readKeys(tmpContext.Entity, pIDs, tmpTarget, pKeysDone);
			};
			fKeys(
				(pKeysError, pKeys) =>
				{
					if (this._Halted)
					{
						return fCallback(loopError('halted.', 'Halted'));
					}
					if (pKeysError)
					{
						return fCallback(pKeysError);
					}
					let tmpKeys = (pKeys instanceof Map) ? pKeys : new Map();
					let tmpIDs;
					if (pRange)
					{
						let tmpSet = new Set();
						pSourceByID.forEach((pRow, pID) => { tmpSet.add(pID); });
						tmpKeys.forEach((pList, pID) => { let tmpID = toID(pID); if (tmpID !== null) { tmpSet.add(tmpID); } });
						this._bufferedIDs(tmpTarget).forEach(
							(pID) =>
							{
								if (((pRange.AfterID === null) || (pID > pRange.AfterID)) && ((pRange.ToID === null) || (pID <= pRange.ToID)))
								{
									tmpSet.add(pID);
								}
							});
						tmpIDs = Array.from(tmpSet).sort((pA, pB) => { return pA - pB; });
					}
					else
					{
						tmpIDs = pIDs;
					}
					try
					{
						tmpBatches[tmpTarget] = this._diff(tmpTarget, tmpIDs, pSourceByID, tmpKeys, pVersion, tmpDialect, tmpConverted);
					}
					catch (pDiffError)
					{
						this.fable.log.error(`RetoldFaceting WriterLoop ${this.Hash || ''}: the diff failed: ${pDiffError.message}`);
						return fCallback(loopError('the diff failed.', 'Diff'));
					}
					return fNext();
				});
		};
		fNext();
	}

	/**
	 * IDs with buffered (unflushed) keymap changes in a target.
	 *
	 * @param {string} pTarget
	 * @return {Array<number>}
	 */
	_bufferedIDs(pTarget)
	{
		return this._Context.FlushBuffer.bufferedIDs(pTarget).map((pID) => { return toID(pID); }).filter((pID) => { return pID !== null; });
	}

	/**
	 * The diff of one target (§58.5 step 5).
	 *
	 * @param {string} pTarget
	 * @param {Array<number>} pIDs
	 * @param {Map<number, Record<string, any>>} pSourceByID
	 * @param {Map<any, Array<Record<string, any>>>} pKeys - the store's live keymap keys per ID
	 * @param {number} pVersion
	 * @param {string} pDialect
	 * @param {Map<any, Map<number, Record<string, any>>>} pConverted - spec → ID → toStoreRow result (shared across targets)
	 * @return {{ Rows: Array<any>, Tombstones: Array<any>, KeyIntents: Array<any>, KeyRetires: Array<any> }}
	 */
	_diff(pTarget, pIDs, pSourceByID, pKeys, pVersion, pDialect, pConverted)
	{
		let tmpSpec = this.specFor(pTarget);
		let tmpKeyColumns = libTypeMap.keyColumnsOf(tmpSpec);
		let tmpBatch = libFlushBuffer.emptyBatch();
		let tmpShadow = (libStoreBase.isShadowTarget(pTarget) !== null);
		if (!pConverted.has(tmpSpec))
		{
			pConverted.set(tmpSpec, new Map());
		}
		let tmpConversions = pConverted.get(tmpSpec);
		for (let i = 0; i < pIDs.length; i++)
		{
			let tmpID = pIDs[i];
			let tmpSource = pSourceByID.get(tmpID);
			let tmpStoreKeys = pKeys.get(tmpID);
			if (!tmpStoreKeys)
			{
				// Keys from the store may be keyed by a numeric string.
				tmpStoreKeys = pKeys.get(String(tmpID)) || [];
			}
			let tmpKeys = this._Context.FlushBuffer.keys(pTarget, tmpID, tmpStoreKeys, tmpKeyColumns);
			let tmpLive = false;
			let tmpConversion = null;
			if (tmpSource)
			{
				tmpConversion = tmpConversions.get(tmpID);
				if (!tmpConversion)
				{
					tmpConversion = this.toStoreRow(tmpSpec, tmpSource, pDialect);
					tmpConversions.set(tmpID, tmpConversion);
				}
				// §56.4: the delete column exactly 0 as SQL `= 0` sees it (NULL or any other value is not
				// live: Live's explicit soft delete excludes it too).
				let tmpSourceLive = (!tmpSpec.DeleteColumn || libMaterializeSource.isZero(tmpSource[tmpSpec.DeleteColumn])) && libTypeMap.isLive(tmpSpec, tmpSource);
				tmpLive = !!tmpConversion.Row && !tmpConversion.Quarantined && tmpSourceLive;
				if (tmpSourceLive && (tmpConversion.Quarantined === 'TenantUnset'))
				{
					this._Quarantined.add(tmpID);
				}
				else
				{
					this._Quarantined.delete(tmpID);
				}
			}
			else
			{
				this._Quarantined.delete(tmpID);
			}
			// The Lossy flags of the rows this target will hold (the live tables', or the rebuild's).
			if (tmpShadow)
			{
				if (this._RebuildLossy && this._Rebuild && (this._Rebuild.Target === pTarget))
				{
					this._trackLossy(this._RebuildLossy.IDs, this._RebuildLossy.Sticky, tmpID, tmpLive ? tmpConversion.Lossy : null);
				}
			}
			else
			{
				this._trackLossy(this._LossyIDs, this._LossySticky, tmpID, tmpLive ? tmpConversion.Lossy : null);
			}
			if (tmpLive)
			{
				let tmpRow = tmpConversion.Row;
				let tmpText = keyText(tmpKeyColumns, tmpRow);
				tmpBatch.Rows.push(this._mirrorRow(tmpSpec, tmpRow, pVersion));
				tmpBatch.KeyIntents.push(this._keymapRow(tmpSpec, tmpRow, pVersion));
				for (let k = 0; k < tmpKeys.length; k++)
				{
					if (keyText(tmpKeyColumns, tmpKeys[k].Key) !== tmpText)
					{
						tmpBatch.Tombstones.push(this._tombstone(tmpSpec, tmpID, tmpKeys[k].Key, pVersion));
						tmpBatch.KeyRetires.push(this._retire(tmpSpec, tmpID, tmpKeys[k].Key, pVersion));
					}
				}
			}
			else
			{
				for (let k = 0; k < tmpKeys.length; k++)
				{
					tmpBatch.Tombstones.push(this._tombstone(tmpSpec, tmpID, tmpKeys[k].Key, pVersion));
					tmpBatch.KeyRetires.push(this._retire(tmpSpec, tmpID, tmpKeys[k].Key, pVersion));
				}
			}
		}
		return tmpBatch;
	}

	/**
	 * @param {Record<string, any>} pSpec
	 * @return {Array<string>}
	 */
	_columnNames(pSpec)
	{
		return Array.isArray(pSpec.Columns) ? pSpec.Columns.map((pColumn) => { return pColumn.Column; }) : [];
	}

	/**
	 * @param {Record<string, any>} pSpec
	 * @return {Array<string>}
	 */
	_keymapColumns(pSpec)
	{
		if (Array.isArray(pSpec.KeymapColumns) && (pSpec.KeymapColumns.length > 0))
		{
			return pSpec.KeymapColumns;
		}
		return [ pSpec.Identity ].concat(libTypeMap.keyColumnsOf(pSpec));
	}

	/**
	 * A mirror row: every spec column + _Version + _IsDeleted 0.
	 *
	 * @param {Record<string, any>} pSpec
	 * @param {Record<string, any>} pRow - TypeMap.toStoreRow(…).Row
	 * @param {number} pVersion
	 * @return {Record<string, any>}
	 */
	_mirrorRow(pSpec, pRow, pVersion)
	{
		let tmpOut = {};
		let tmpColumns = this._columnNames(pSpec);
		for (let i = 0; i < tmpColumns.length; i++)
		{
			let tmpValue = pRow[tmpColumns[i]];
			tmpOut[tmpColumns[i]] = (typeof(tmpValue) === 'undefined') ? null : tmpValue;
		}
		tmpOut._Version = pVersion;
		tmpOut._IsDeleted = 0;
		return tmpOut;
	}

	/**
	 * A keymap intent: every keymap column + _Version + _IsDeleted 0.
	 *
	 * @param {Record<string, any>} pSpec
	 * @param {Record<string, any>} pRow
	 * @param {number} pVersion
	 * @return {Record<string, any>}
	 */
	_keymapRow(pSpec, pRow, pVersion)
	{
		let tmpOut = {};
		let tmpColumns = this._keymapColumns(pSpec);
		for (let i = 0; i < tmpColumns.length; i++)
		{
			let tmpValue = pRow[tmpColumns[i]];
			tmpOut[tmpColumns[i]] = (typeof(tmpValue) === 'undefined') ? null : tmpValue;
		}
		tmpOut._Version = pVersion;
		tmpOut._IsDeleted = 0;
		return tmpOut;
	}

	/**
	 * A mirror tombstone at a key: identity + sort-key columns, every other column NULL, _IsDeleted 1.
	 *
	 * @param {Record<string, any>} pSpec
	 * @param {number} pID
	 * @param {Record<string, any>} pKey
	 * @param {number} pVersion
	 * @return {Record<string, any>}
	 */
	_tombstone(pSpec, pID, pKey, pVersion)
	{
		let tmpOut = {};
		let tmpKeyColumns = libTypeMap.keyColumnsOf(pSpec);
		let tmpColumns = this._columnNames(pSpec);
		for (let i = 0; i < tmpColumns.length; i++)
		{
			let tmpColumn = tmpColumns[i];
			if (tmpColumn === pSpec.Identity)
			{
				tmpOut[tmpColumn] = pID;
			}
			else if (tmpKeyColumns.indexOf(tmpColumn) >= 0)
			{
				let tmpValue = pKey ? pKey[tmpColumn] : null;
				tmpOut[tmpColumn] = (typeof(tmpValue) === 'undefined') ? null : tmpValue;
			}
			else
			{
				tmpOut[tmpColumn] = null;
			}
		}
		tmpOut._Version = pVersion;
		tmpOut._IsDeleted = 1;
		return tmpOut;
	}

	/**
	 * A keymap retirement at a key: identity + sort-key scope columns, other keymap columns NULL,
	 * _IsDeleted 1.
	 *
	 * @param {Record<string, any>} pSpec
	 * @param {number} pID
	 * @param {Record<string, any>} pKey
	 * @param {number} pVersion
	 * @return {Record<string, any>}
	 */
	_retire(pSpec, pID, pKey, pVersion)
	{
		let tmpOut = {};
		let tmpKeyColumns = libTypeMap.keyColumnsOf(pSpec);
		let tmpColumns = this._keymapColumns(pSpec);
		for (let i = 0; i < tmpColumns.length; i++)
		{
			let tmpColumn = tmpColumns[i];
			if (tmpColumn === pSpec.Identity)
			{
				tmpOut[tmpColumn] = pID;
			}
			else if (tmpKeyColumns.indexOf(tmpColumn) >= 0)
			{
				let tmpValue = pKey ? pKey[tmpColumn] : null;
				tmpOut[tmpColumn] = (typeof(tmpValue) === 'undefined') ? null : tmpValue;
			}
			else
			{
				tmpOut[tmpColumn] = null;
			}
		}
		tmpOut._Version = pVersion;
		tmpOut._IsDeleted = 1;
		return tmpOut;
	}

	/**
	 * Buffer a cycle's batches (every target, the same cycle object).
	 *
	 * @param {Array<string>} pTargets
	 * @param {Record<string, Record<string, Array<any>>>} pBatches
	 * @param {Record<string, any>} pCycle
	 */
	_append(pTargets, pBatches, pCycle)
	{
		let tmpBuffer = this._Context.FlushBuffer;
		for (let i = 0; i < pTargets.length; i++)
		{
			tmpBuffer.append(pTargets[i], pBatches[pTargets[i]] || libFlushBuffer.emptyBatch(), pCycle, Date.now(), libTypeMap.keyColumnsOf(this.specFor(pTargets[i])));
		}
	}

	// ---- flush --------------------------------------------------------------------------------

	/**
	 * Write everything buffered (§58.6), then ack.
	 *
	 * @param {(pError?: Error) => void} fDone
	 */
	_flush(fDone)
	{
		let tmpContext = this._Context;
		this._ForceFlush = false;
		if (tmpContext.FlushBuffer.size() < 1)
		{
			return fDone();
		}
		if ((typeof(tmpContext.leaseValid) === 'function') && !tmpContext.leaseValid())
		{
			// This process no longer holds the store's lease: it must not write (another may materialize).
			let tmpNotLeader = loopError('this process does not hold the store lease.', 'NotLeader');
			tmpNotLeader.NotLeader = true;
			return this._flushFailed(tmpContext.FlushBuffer.take(), tmpNotLeader, fDone);
		}
		let tmpTaken = tmpContext.FlushBuffer.take();
		if (tmpTaken.Cycles.length < 1)
		{
			return fDone();
		}
		let tmpTargets = Object.keys(tmpTaken.Targets).filter(
			(pTarget) =>
			{
				let tmpBatch = tmpTaken.Targets[pTarget];
				return (tmpBatch.Rows.length + tmpBatch.Tombstones.length + tmpBatch.KeyIntents.length + tmpBatch.KeyRetires.length) > 0;
			});
		let tmpIndex = 0;
		let tmpRows = 0;
		let tmpTombstones = 0;
		let fNext = () =>
		{
			if (this._Halted)
			{
				return fDone();
			}
			if (tmpIndex >= tmpTargets.length)
			{
				return this._flushed(tmpTaken, tmpRows, tmpTombstones, fDone);
			}
			let tmpTarget = tmpTargets[tmpIndex++];
			let tmpBatch = tmpTaken.Targets[tmpTarget];
			let tmpToken = `${tmpContext.Entity}:${tmpTaken.FlushID}:${tmpTarget}`;
			let tmpCalled = false;
			let fWritten = (pError) =>
			{
				if (tmpCalled)
				{
					return;
				}
				tmpCalled = true;
				if (this._Halted)
				{
					return fDone();
				}
				if (pError)
				{
					return this._flushFailed(tmpTaken, pError, fDone);
				}
				this._Stats.Inserts += 3;
				tmpRows += tmpBatch.Rows.length;
				tmpTombstones += tmpBatch.Tombstones.length;
				return fNext();
			};
			try
			{
				tmpContext.Store.writeBatch(tmpContext.Entity, tmpBatch, tmpToken, tmpTarget, fWritten);
			}
			catch (pWriteError)
			{
				fWritten(pWriteError);
			}
		};
		fNext();
	}

	/**
	 * A flush failed: every covered hint goes back to pending, every covered Range task back to its
	 * queue (the retry is a NEW cycle: a new version and a fresh read), back off.
	 *
	 * @param {Record<string, any>} pTaken
	 * @param {Error} pError
	 * @param {() => void} fDone
	 */
	_flushFailed(pTaken, pError, fDone)
	{
		let tmpContext = this._Context;
		this._Stats.FlushErrors++;
		this._LastFlushOK = false;
		this.fable.log.warn(`RetoldFaceting WriterLoop ${this.Hash || ''}: a flush failed (${pError.message}); ${pTaken.Cycles.length} cycles will be re-read.`);
		for (let i = 0; i < pTaken.Cycles.length; i++)
		{
			let tmpCycle = pTaken.Cycles[i];
			if (tmpCycle.Taken)
			{
				tmpContext.PendingSet.release(tmpCycle.Taken);
			}
			if (tmpCycle.Task && !tmpCycle.Task.Done)
			{
				this._requeue(tmpCycle.Task);
			}
		}
		this._fail(pError, 'Store');
		return fDone(pError);
	}

	/**
	 * Every target of the flush landed: test hook, acks, Range progress, the Materializer's state write.
	 *
	 * @param {Record<string, any>} pTaken
	 * @param {number} pRows
	 * @param {number} pTombstones
	 * @param {() => void} fDone
	 */
	_flushed(pTaken, pRows, pTombstones, fDone)
	{
		this._hook('afterFlushBeforeAck', { FlushID: pTaken.FlushID, Cycles: pTaken.Cycles.length, Rows: pRows, Tombstones: pTombstones },
			() =>
			{
				if (this._Halted)
				{
					// A crash between the flush and the ack: nothing in memory survives.
					return fDone();
				}
				let tmpContext = this._Context;
				for (let i = 0; i < pTaken.Cycles.length; i++)
				{
					let tmpCycle = pTaken.Cycles[i];
					if (tmpCycle.Taken)
					{
						tmpContext.PendingSet.ack(tmpCycle.Taken, tmpCycle.ReadStart);
					}
				}
				this._Stats.Flushes++;
				this._Stats.Rows += pRows;
				this._Stats.Tombstones += pTombstones;
				this._Stats.LastFlushAt = Date.now();
				this._LastFlushOK = true;
				this._BackoffMS = 0;
				this._BackoffUntil = 0;
				if (tmpContext.Freshness && (typeof(tmpContext.Freshness.recordWriteSuccess) === 'function'))
				{
					tmpContext.Freshness.recordWriteSuccess(tmpContext.StoreName, tmpContext.Entity);
				}
				// Range progress (after the ack, §58.5 step 8).
				let tmpTasks = [];
				for (let i = 0; i < pTaken.Cycles.length; i++)
				{
					let tmpCycle = pTaken.Cycles[i];
					if (tmpCycle.Task)
					{
						tmpTasks.push(tmpCycle);
					}
				}
				let fComplete = () =>
				{
					tmpTasks.forEach(
						(pCycle) =>
						{
							if (pCycle.Task.Internal && (pCycle.Task.Kind === 'Resync'))
							{
								return this._resyncProgress(pCycle.Task, pCycle.Result);
							}
							return this._finishTask(pCycle.Task, null, Object.assign({}, pCycle.Result));
						});
					return fDone();
				};
				if (typeof(tmpContext.onFlushed) !== 'function')
				{
					return fComplete();
				}
				let tmpCalled = false;
				try
				{
					tmpContext.onFlushed(this, { FlushID: pTaken.FlushID, Version: (pTaken.Cycles.length > 0) ? pTaken.Cycles[pTaken.Cycles.length - 1].Version : null, Rows: pRows, Tombstones: pTombstones, Cycles: pTaken.Cycles.length },
						() =>
						{
							if (tmpCalled)
							{
								return;
							}
							tmpCalled = true;
							return fComplete();
						});
				}
				catch (pError)
				{
					this.fable.log.error(`RetoldFaceting WriterLoop ${this.Hash || ''}: onFlushed threw: ${pError.message}`);
					if (!tmpCalled)
					{
						tmpCalled = true;
						return fComplete();
					}
				}
			});
	}

	/**
	 * A Resync page was acked: queue the next page, or end the pass (clearDirty when no newer
	 * markDirty arrived since it started).
	 *
	 * @param {Record<string, any>} pTask
	 * @param {Record<string, any>} pResult
	 */
	_resyncProgress(pTask, pResult)
	{
		pTask.Done = true;
		if (!this._Resync)
		{
			return;
		}
		if (pResult && !pResult.Exhausted && (pResult.LastID !== null))
		{
			this._Tasks.Resync.unshift({ Kind: 'Resync', Target: null, AfterID: pResult.LastID, ToID: null, Cap: pTask.Cap, Internal: true, fOnDone: null });
			return;
		}
		let tmpGeneration = this._Resync.Generation;
		this._Resync = null;
		let tmpCleared = this._Context.PendingSet.clearDirty(tmpGeneration);
		if (!tmpCleared)
		{
			this.fable.log.info(`RetoldFaceting WriterLoop ${this.Hash || ''}: a newer whole-entity change arrived during the Resync; another pass follows.`);
		}
	}

	// ---- the public API -----------------------------------------------------------------------

	/**
	 * Queue one page of a Range task (internal-contracts §58.5); fOnDone after the flush carrying the
	 * page acked: { LastID, Rows, Exhausted } (LastID null when the page read nothing).
	 *
	 * @param {{ Kind: string, Target: string, AfterID: number|null, ToID: number|null, Cap: number }} pTask
	 * @param {(pError?: Error, pResult?: { LastID: number|null, Rows: number, Exhausted: boolean }) => void} fOnDone
	 */
	addRangeTask(pTask, fOnDone)
	{
		let fDone = this._deferred(fOnDone);
		let tmpTask = (pTask && (typeof(pTask) === 'object')) ? pTask : {};
		if ((RANGE_KINDS.indexOf(tmpTask.Kind) < 0))
		{
			return fDone(loopError(`a Range task Kind is one of ${RANGE_KINDS.join(' | ')}.`, 'TaskInvalid'));
		}
		let tmpCap = Number(tmpTask.Cap);
		if (!Number.isSafeInteger(tmpCap) || (tmpCap < 1))
		{
			return fDone(loopError('a Range task needs a positive integer Cap.', 'TaskInvalid'));
		}
		let tmpAfter = ((tmpTask.AfterID === null) || (tmpTask.AfterID === undefined)) ? null : toID(tmpTask.AfterID);
		let tmpTo = ((tmpTask.ToID === null) || (tmpTask.ToID === undefined)) ? null : toID(tmpTask.ToID);
		if (((tmpTask.AfterID !== null) && (tmpTask.AfterID !== undefined) && (tmpAfter === null))
			|| ((tmpTask.ToID !== null) && (tmpTask.ToID !== undefined) && (tmpTo === null)))
		{
			return fDone(loopError('AfterID / ToID must be safe integers or null.', 'TaskInvalid'));
		}
		if ((tmpTask.Kind !== 'Resync') && (typeof(tmpTask.Target) !== 'string'))
		{
			return fDone(loopError('a Range task needs a Target.', 'TaskInvalid'));
		}
		if (this._Halted)
		{
			return fDone(loopError('the loop is stopped.', 'Stopped'));
		}
		if (this._Stopping && (tmpTask.Kind !== 'Resync'))
		{
			return fDone(loopError('the loop is stopping.', 'Stopped'));
		}
		this._Tasks[tmpTask.Kind].push({ Kind: tmpTask.Kind, Target: tmpTask.Target || null, AfterID: tmpAfter, ToID: tmpTo, Cap: tmpCap, Internal: false, fOnDone: fDone, Done: false });
		this.kick();
	}

	/**
	 * A caller's callback, always called on a later tick (a caller that throws never breaks the loop's
	 * bookkeeping, and its exception surfaces as its own).
	 *
	 * @param {Function} [fCallback]
	 * @return {Function}
	 */
	_deferred(fCallback)
	{
		if (typeof(fCallback) !== 'function')
		{
			return () => {};
		}
		return (...pArgs) => { setImmediate(() => { fCallback(...pArgs); }); };
	}

	/**
	 * Queue a control step (runs exclusively, between two operations).  A halt before it runs calls
	 * fAbort(pError) instead (no store call is made by a stopped loop).
	 *
	 * @param {(fDone: () => void) => void} fStep
	 * @param {(pError: Error) => void} fAbort
	 */
	_control(fStep, fAbort)
	{
		this._Control.push({ Run: fStep, Abort: fAbort });
		this.kick();
	}

	/**
	 * Start a rebuild: create the shadow tables; targets gain the shadow (first enable: the shadow only,
	 * so stream hints that arrive during the build land in it).
	 *
	 * @param {string} pBuildID
	 * @param {boolean} pFirstEnable
	 * @param {(pError?: Error) => void} fCallback
	 */
	beginRebuild(pBuildID, pFirstEnable, fCallback)
	{
		let fDone = this._deferred(fCallback);
		let tmpTarget;
		try
		{
			tmpTarget = libStoreBase.shadowTarget(pBuildID);
		}
		catch (pError)
		{
			return fDone(pError);
		}
		if (!this._Context || this._Halted)
		{
			return fDone(loopError('the loop is not running.', 'Stopped'));
		}
		this._control(
			(fStepDone) =>
			{
				if (this._Rebuild)
				{
					fDone(loopError(`a rebuild (${this._Rebuild.BuildID}) is already in progress.`, 'Busy'));
					return fStepDone();
				}
				if (!pFirstEnable && (this._Targets.indexOf(libStoreBase.TARGET_LIVE) < 0))
				{
					fDone(loopError('there is no live table to rebuild beside.', 'NoLiveTable'));
					return fStepDone();
				}
				let tmpContext = this._Context;
				tmpContext.Store.beginShadow(tmpContext.Entity, pBuildID, this._Spec,
					(pError) =>
					{
						if (this._Halted)
						{
							fDone(loopError('the loop stopped.', 'Stopped'));
							return fStepDone();
						}
						if (pError)
						{
							this._fail(pError, 'Store');
							fDone(pError);
							return fStepDone();
						}
						this._Rebuild = { BuildID: pBuildID, FirstEnable: !!pFirstEnable, Target: tmpTarget, Spec: this._Spec };
						// The shadow follows the spec it was created with, whatever a later reload brings.
						this._TargetSpecs[tmpTarget] = this._Spec;
						this._RebuildLossy = { IDs: {}, Sticky: {} };
						this._Targets = pFirstEnable ? [ tmpTarget ] : [ libStoreBase.TARGET_LIVE, tmpTarget ];
						fDone(null);
						return fStepDone();
					});
			}, fDone);
	}

	/**
	 * Finish a rebuild between two flushes: flush everything, swap (RENAME on a first enable, EXCHANGE
	 * otherwise), drop the shadows (they now hold the old data), targets = [ 'Live' ], Epoch++, the
	 * Lossy flags become what the rebuild saw.
	 *
	 * @param {string} pBuildID
	 * @param {(pError?: Error) => void} fCallback
	 */
	finishRebuild(pBuildID, fCallback)
	{
		let fDone = this._deferred(fCallback);
		if (!this._Context || this._Halted)
		{
			return fDone(loopError('the loop is not running.', 'Stopped'));
		}
		this._control(
			(fStepDone) =>
			{
				if (!this._Rebuild || (this._Rebuild.BuildID !== pBuildID))
				{
					fDone(loopError(`no rebuild ${pBuildID} is in progress.`, 'NoRebuild'));
					return fStepDone();
				}
				let tmpRebuild = this._Rebuild;
				this._flush(
					(pFlushError) =>
					{
						if (this._Halted)
						{
							fDone(loopError('the loop stopped.', 'Stopped'));
							return fStepDone();
						}
						if (pFlushError || (this._Context.FlushBuffer.size() > 0))
						{
							fDone(loopError('the final flush before the swap failed.', 'FlushFailed'));
							return fStepDone();
						}
						this._hook('beforeSwap', { BuildID: pBuildID, FirstEnable: tmpRebuild.FirstEnable },
							() =>
							{
								let tmpContext = this._Context;
								tmpContext.Store.swapShadow(tmpContext.Entity, pBuildID, tmpRebuild.FirstEnable,
									(pSwapError) =>
									{
										if (this._Halted)
										{
											fDone(loopError('the loop stopped.', 'Stopped'));
											return fStepDone();
										}
										if (pSwapError)
										{
											// Never dropped on a swap error: the Rebuilder retries finishRebuild,
											// which completes whichever half did not land.  Writes wait for it.
											this._SwapBlocked = pBuildID;
											this._fail(pSwapError, 'Store');
											fDone(pSwapError);
											return fStepDone();
										}
										this._SwapBlocked = null;
										this._Targets = [ libStoreBase.TARGET_LIVE ];
										// The live tables now hold the shadow's layout: pinned when a reload changed the spec
										// meanwhile (the Materializer then rebuilds again, onSwapped Current: false).
										let tmpShadowSpec = this._TargetSpecs[tmpRebuild.Target] || tmpRebuild.Spec || this._Spec;
										this._TargetSpecs = {};
										if (tmpShadowSpec && (tmpShadowSpec !== this._Spec))
										{
											this._TargetSpecs[libStoreBase.TARGET_LIVE] = tmpShadowSpec;
										}
										this._keyColumnsChanged();
										this._Rebuild = null;
										if (this._RebuildLossy)
										{
											// What the rebuild saw, row by row, is now the live tables' truth.
											this._LossyIDs = this._RebuildLossy.IDs;
											this._LossySticky = this._RebuildLossy.Sticky;
											this._LossyStickySince = Date.now();
										}
										this._RebuildLossy = null;
										this._failTasks((pTask) => { return pTask.Target === tmpRebuild.Target; }, loopError('the rebuild finished.', 'TargetGone'));
										tmpContext.Store.dropShadow(tmpContext.Entity, pBuildID,
											(pDropError) =>
											{
												if (pDropError)
												{
													this.fable.log.warn(`RetoldFaceting WriterLoop ${this.Hash || ''}: dropping the old tables after the swap failed (${pDropError.message}).`);
												}
												if (typeof(tmpContext.onSwapped) === 'function')
												{
													try
													{
														tmpContext.onSwapped(this, { BuildID: pBuildID, FirstEnable: tmpRebuild.FirstEnable, Spec: tmpShadowSpec, Current: (tmpShadowSpec === this._Spec) });
													}
													catch (pHookError)
													{
														this.fable.log.error(`RetoldFaceting WriterLoop ${this.Hash || ''}: onSwapped threw: ${pHookError.message}`);
													}
												}
												fDone(null);
												return fStepDone();
											});
									});
							});
					});
			}, fDone);
	}

	/**
	 * Abandon a rebuild: the shadow's buffered writes are dropped, targets go back to [ 'Live' ] (none
	 * on a first enable: there is no live table), the shadow tables are dropped.  Idempotent.
	 *
	 * @param {string} pBuildID
	 * @param {(pError?: Error) => void} fCallback
	 */
	abortRebuild(pBuildID, fCallback)
	{
		let fDone = this._deferred(fCallback);
		let fAbort = (fStepDone) =>
		{
			let tmpRebuild = this._Rebuild;
			let tmpContext = this._Context;
			if (tmpRebuild && (tmpRebuild.BuildID === pBuildID))
			{
				tmpContext.FlushBuffer.dropTarget(tmpRebuild.Target);
				this._Targets = tmpRebuild.FirstEnable ? [] : [ libStoreBase.TARGET_LIVE ];
				delete this._TargetSpecs[tmpRebuild.Target];
				this._Rebuild = null;
				this._SwapBlocked = null;
				this._RebuildLossy = null;
				this._failTasks((pTask) => { return pTask.Target === tmpRebuild.Target; }, loopError('the rebuild was aborted.', 'Aborted'));
			}
			if (!tmpContext)
			{
				fDone(null);
				return fStepDone();
			}
			tmpContext.Store.dropShadow(tmpContext.Entity, pBuildID,
				(pError) =>
				{
					if (pError)
					{
						this.fable.log.warn(`RetoldFaceting WriterLoop ${this.Hash || ''}: dropping the shadow of an aborted rebuild failed (${pError.message}).`);
					}
					fDone(null);
					return fStepDone();
				});
		};
		if (!this._Context || this._Halted)
		{
			// Nothing runs any more: forget the rebuild in memory, touch no table.
			if (this._Rebuild && (this._Rebuild.BuildID === pBuildID))
			{
				this._Targets = this._Rebuild.FirstEnable ? [] : [ libStoreBase.TARGET_LIVE ];
				delete this._TargetSpecs[this._Rebuild.Target];
				this._Rebuild = null;
				this._SwapBlocked = null;
				this._RebuildLossy = null;
			}
			return fDone(null);
		}
		this._control(fAbort, () => { return fDone(null); });
	}

	/**
	 * Forget every table (a wiped store, §59.3), between two operations: buffered cycles are dropped
	 * (their hints go back to pending), queued Range tasks fail, an in-flight rebuild is forgotten, and
	 * the loop has no target until the next backfill's beginRebuild.
	 *
	 * @param {string} pReason
	 * @param {(pError?: Error) => void} fCallback
	 */
	reset(pReason, fCallback)
	{
		let fDone = this._deferred(fCallback);
		let fReset = (fStepDone) =>
		{
			let tmpError = loopError(`the store was reset (${pReason || 'Reset'}).`, pReason || 'Reset');
			if (this._Context)
			{
				let tmpTaken = this._Context.FlushBuffer.take();
				tmpTaken.Cycles.forEach((pCycle) => { if (pCycle.Taken) { this._Context.PendingSet.release(pCycle.Taken); } });
				tmpTaken.Cycles.forEach((pCycle) => { if (pCycle.Task && !pCycle.Task.Internal) { this._finishTask(pCycle.Task, tmpError); } });
			}
			this._failTasks(() => { return true; }, tmpError);
			this._Resync = null;
			this._Rebuild = null;
			this._SwapBlocked = null;
			this._RebuildLossy = null;
			this._TargetSpecs = {};
			this._Targets = [];
			this._BackoffMS = 0;
			this._BackoffUntil = 0;
			fDone(null);
			return fStepDone();
		};
		if (!this._Busy)
		{
			// Nothing in flight: reset now (a control step would wait for the queue).
			return fReset(() => { this.kick(); });
		}
		this._control(fReset, () => { return fDone(); });
	}

	/**
	 * Make the buffered cycles due now (no callback; quiesce and MinSeq-style nudges).
	 */
	requestFlush()
	{
		if (this._Context && !this._Halted && ((this._Context.FlushBuffer.size() > 0) || (this._Context.PendingSet.available() > 0)))
		{
			this._ForceFlush = true;
			this.kick();
		}
	}

	/**
	 * Apply everything pending and flush it now (after the operation in flight): the waiting stream hints
	 * are read first (batched cycles never wait for their interval here), then everything buffered is
	 * flushed; calls back after the ack.
	 *
	 * @param {(pError?: Error) => void} fCallback
	 */
	flush(fCallback)
	{
		let fDone = this._deferred(fCallback);
		if (!this._Context || this._Halted)
		{
			return fDone();
		}
		this._control(
			(fStepDone) =>
			{
				let fFlush = () =>
				{
					this._flush(
						(pError) =>
						{
							fDone(pError ? loopError('the flush failed.', 'FlushFailed') : null);
							return fStepDone();
						});
				};
				let fStream = () =>
				{
					if (this._Halted || !this._Context)
					{
						fDone(loopError('the loop stopped.', 'Stopped'));
						return fStepDone();
					}
					if ((this._Targets.length < 1) || (this._Context.PendingSet.available() < 1) || this._SwapBlocked)
					{
						return fFlush();
					}
					return this._streamCycle(() => { setImmediate(fStream); });
				};
				return fStream();
			}, () => { return fDone(); });
	}

	/**
	 * @return {boolean} no operation in flight, nothing buffered, no control step queued
	 */
	idle()
	{
		if (!this._Context)
		{
			return true;
		}
		return !this._Busy && (this._Control.length < 1) && (this._Context.FlushBuffer.size() < 1);
	}

	/**
	 * Is an operation running or runnable now (a cycle, a control step, stream hints whose batched cycle
	 * is due, a queued Range task)?  Buffered cycles waiting for their flush, and hints still waiting for
	 * company (their cycle is not due yet), do not count.
	 *
	 * @return {boolean}
	 */
	working()
	{
		if (!this._Context || this._Halted)
		{
			return false;
		}
		if (this._Busy || (this._Control.length > 0))
		{
			return true;
		}
		if ((this._Targets.length > 0) && !this._SwapBlocked && (this._streamDue() || (this._Context.PendingSet.dirty() && !this._Resync)))
		{
			return true;
		}
		return !this._SwapBlocked && !!this._runnableTask();
	}

	/**
	 * Nothing left to do (the quiescence test): idle, no pending or in-flight hints, no Dirty mark, no
	 * Range task queued or running.
	 *
	 * @return {boolean}
	 */
	quiet()
	{
		if (!this._Context)
		{
			return true;
		}
		let tmpPending = this._Context.PendingSet;
		return this.idle() && (tmpPending.size() < 1) && !tmpPending.dirty() && !this._Resync && (this.taskInfo().Total < 1);
	}

	/**
	 * Drain for a graceful stop (§58.1): Range tasks other than a Resync are failed ('Stopped'), stream
	 * hints and a Resync are applied and flushed until nothing is left or pDeadlineMS passes.
	 *
	 * @param {number} pDeadlineMS - Date.now() deadline
	 * @param {(pDrained: boolean) => void} fCallback
	 */
	drain(pDeadlineMS, fCallback)
	{
		if (!this._Context || this._Halted)
		{
			return fCallback(false);
		}
		this._Stopping = true;
		this._failTasks((pTask) => { return pTask.Kind !== 'Resync'; }, loopError('the loop is stopping.', 'Stopped'));
		this.kick();
		let fCheck = () =>
		{
			if (this._Halted)
			{
				return fCallback(false);
			}
			let tmpPending = this._Context.PendingSet;
			let tmpNothingToDo = this.idle() && ((this._Targets.length < 1) || ((tmpPending.size() < 1) && !tmpPending.dirty() && !this._Resync));
			if (tmpNothingToDo)
			{
				let tmpDrained = this._LastFlushOK && (tmpPending.size() < 1) && !tmpPending.dirty() && (this._Targets.length > 0);
				this.halt();
				return fCallback(tmpDrained);
			}
			if (Date.now() >= pDeadlineMS)
			{
				this.halt();
				return fCallback(false);
			}
			let tmpTimer = setTimeout(fCheck, Math.min(this.IdleTickMS, Math.max(1, pDeadlineMS - Date.now())));
			if (typeof(tmpTimer.unref) === 'function')
			{
				tmpTimer.unref();
			}
		};
		setImmediate(fCheck);
	}

	/**
	 * Stop at once (a crash, or the end of a drain): no new operation starts, timers cleared, queued
	 * tasks and control steps fail ('Stopped').  An operation in flight finishes on its own and writes
	 * nothing further.
	 *
	 * @param {string} [pReason]
	 */
	halt(pReason)
	{
		if (this._Halted)
		{
			return;
		}
		this._Halted = true;
		this._clearTimers();
		let tmpError = loopError(`the loop was stopped (${pReason || 'Stopped'}).`, pReason || 'Stopped');
		let tmpControl = this._Control.splice(0);
		this._failTasks(() => { return true; }, tmpError);
		this._Resync = null;
		// Control steps report the stop to their callers; none of them runs.
		tmpControl.forEach((pControl) => { try { pControl.Abort(tmpError); } catch (pError) { /* a caller's own problem */ } });
	}

	/**
	 * @return {boolean}
	 */
	halted()
	{
		return this._Halted;
	}

	/**
	 * @return {Record<string, any>}
	 */
	stats()
	{
		return Object.assign({}, this._Stats,
			{
				Targets: this.targets(),
				Tasks: this.taskInfo(),
				Busy: this._Busy,
				BackoffMS: this._BackoffMS,
				Quarantined: this._Quarantined.size,
				Rebuild: this.rebuild()
			});
	}
}

module.exports = RetoldFacetingWriterLoop;
module.exports.serviceType = 'RetoldFacetingWriterLoop';
module.exports.WORK_KINDS = WORK_KINDS;
module.exports.RANGE_KINDS = RANGE_KINDS;
module.exports.TEST_HOOKS = TEST_HOOKS;
module.exports.mergeLossy = mergeLossy;
