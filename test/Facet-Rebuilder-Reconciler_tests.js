/**
 * Facet-Rebuilder-Reconciler (internal-contracts §59, §60, §66.2; owner: builder D, port 19144).
 *
 *   unit (no ClickHouse): the Rebuilder and the Reconciler against a small in-memory world — a source
 *   (MaterializeSource-shaped), a store (keymap / mirror per target), a WriterLoop with the documented
 *   rebuild + Range-task API and a Materializer / Freshness / MirrorSpec with the documented calls —
 *   so every orchestration rule is pinned without the other builders' services:
 *     backfill (Building → RENAME → CatchingUp → Live), rebuild and its dual-write window (a write after
 *     its page was read ends in the shadow at a higher version, a delete after its page is tombstoned
 *     in the shadow), finishRebuild only between flushes, join / supersede / cancel / failure;
 *     Sweep compound keyset (more than SweepCap rows on one stamp, a lower ID stamped later, the
 *     watermark only after a complete pass, the overlap), Bisect (an insert, a hard delete, one delete
 *     + one insert with equal counts caught by IDSum, the divergence ratio excluding pending / recent
 *     IDs, escalation to a rebuild ending Unverified), Scrub (cursor, wrap, Full, Fill), verify → Live,
 *     timers unref'd and cleared by stop();
 *   CH-gated: the same on a real store through the harness Store option (internal-contracts §62.6),
 *   plus the admin triggers (storeAdmin: busy → 429, unknown → 404) and the guarded admin routes.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libBuilders = require('./support/Facet-Test-Builders.js');
const libSupport = require('./support/Facet-ClickHouse-Support.js');
const libRetoldFacetingRebuilder = require('../source/persistence/Retold-Faceting-Rebuilder.js');
const libRetoldFacetingReconciler = require('../source/persistence/Retold-Faceting-Reconciler.js');
const libStoreBase = require('../source/store/Retold-Faceting-StoreBase.js');

const PORT = 19144;
const STORE = 'ClickHouse';
const ENTITY = 'Task';

// ================================================================ the in-memory world

/**
 * 'YYYY-MM-DD HH:MM:SS' of an epoch-ms instant (the SQLite datetime('now') text).
 *
 * @param {number} pMS
 * @return {string}
 */
const stamp = (pMS) =>
{
	return new Date(pMS).toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * A row is live per internal-contracts §56.4: present, Deleted exactly 0, tenant set.
 *
 * @param {Record<string, any>|undefined} pRow
 * @return {boolean}
 */
const isLive = (pRow) =>
{
	return !!pRow && (pRow.Deleted === 0) && (typeof(pRow.IDCustomer) === 'number') && (pRow.IDCustomer > 0);
};

class WorldSource
{
	constructor(pWorld)
	{
		this.World = pWorld;
		this.Rows = new Map();
		this.Calls = { readRange: 0, readIDs: 0, sweep: [], checksums: 0 };
		this.Fail = {};
	}

	put(pRow)
	{
		this.Rows.set(pRow.IDTask, Object.assign({ IDCustomer: 1, Deleted: 0, UpdateDate: stamp(Date.parse('2025-01-01T00:00:00Z')), Name: 'x' }, pRow));
	}

	sortedIDs()
	{
		return Array.from(this.Rows.keys()).sort((pA, pB) => { return pA - pB; });
	}

	_fail(pMethod, fCallback)
	{
		if (this.Fail[pMethod])
		{
			let tmpError = this.Fail[pMethod];
			delete this.Fail[pMethod];
			setImmediate(() => { fCallback(tmpError); });
			return true;
		}
		return false;
	}

	readRange(pEntity, pAfterID, pCap, pOptions, fCallback)
	{
		this.Calls.readRange++;
		let tmpTo = (pOptions && (typeof(pOptions.ToID) === 'number')) ? pOptions.ToID : Infinity;
		let tmpAfter = (typeof(pAfterID) === 'number') ? pAfterID : -Infinity;
		let tmpRows = this.sortedIDs().filter((pID) => { return (pID > tmpAfter) && (pID <= tmpTo); }).slice(0, pCap).map((pID) => { return Object.assign({}, this.Rows.get(pID)); });
		return fCallback(null, tmpRows);
	}

	readIDs(pEntity, pAfterID, pToID, fCallback)
	{
		this.Calls.readIDs++;
		if (this._fail('readIDs', fCallback))
		{
			return;
		}
		let tmpIDs = this.sortedIDs().filter((pID) => { return (pID > pAfterID) && (pID <= pToID); });
		setImmediate(() => { fCallback(null, tmpIDs.map((pID) => { return { ID: pID, Live: isLive(this.Rows.get(pID)) }; })); });
	}

	sweep(pEntity, pOptions, fCallback)
	{
		this.Calls.sweep.push(JSON.parse(JSON.stringify(pOptions)));
		if (this._fail('sweep', fCallback))
		{
			return;
		}
		let tmpFrom = pOptions.From || { At: null, ID: null };
		let tmpRows = [];
		this.Rows.forEach(
			(pRow) =>
			{
				let tmpAt = pRow[pOptions.Column];
				if ((tmpAt === null) || (tmpAt === undefined))
				{
					return;
				}
				if (tmpFrom.At !== null)
				{
					if (tmpAt < tmpFrom.At)
					{
						return;
					}
					if ((tmpAt === tmpFrom.At) && (tmpFrom.ID !== null) && !(pRow.IDTask > tmpFrom.ID))
					{
						return;
					}
				}
				tmpRows.push({ ID: pRow.IDTask, At: tmpAt });
			});
		tmpRows.sort((pA, pB) => { return (pA.At < pB.At) ? -1 : ((pA.At > pB.At) ? 1 : (pA.ID - pB.ID)); });
		tmpRows = tmpRows.slice(0, pOptions.Cap);
		let tmpLast = tmpRows[tmpRows.length - 1];
		setImmediate(() => { fCallback(null, { Rows: tmpRows, Next: tmpLast ? { At: tmpLast.At, ID: tmpLast.ID } : null }); });
	}

	checksums(pEntity, pLeafRange, fCallback)
	{
		this.Calls.checksums++;
		let tmpBuckets = {};
		this.Rows.forEach(
			(pRow) =>
			{
				if (!isLive(pRow))
				{
					return;
				}
				let tmpBucket = String(Math.trunc(pRow.IDTask / pLeafRange));
				tmpBuckets[tmpBucket] = tmpBuckets[tmpBucket] || { Count: 0, IDSum: 0 };
				tmpBuckets[tmpBucket].Count++;
				tmpBuckets[tmpBucket].IDSum += pRow.IDTask;
			});
		setImmediate(() => { fCallback(null, tmpBuckets); });
	}

	dialect()
	{
		return 'SQLite';
	}
}

/**
 * A store: per table, the mirror (ID → { Row, Version }) and the keymap (ID → Version) — FINAL
 * semantics with one key per ID (the fake has no tenant moves; the CH suites cover those).
 */
class WorldStore
{
	constructor()
	{
		this.Tables = { Live: { Mirror: new Map(), Keymap: new Map() } };
		this.States = new Map();
		this.Fail = {};
	}

	table(pTarget)
	{
		let tmpBuildID = libStoreBase.isShadowTarget(pTarget);
		let tmpName = tmpBuildID ? `Shadow:${tmpBuildID}` : 'Live';
		return this.Tables[tmpName] || null;
	}

	readKeyRange(pEntity, pAfterID, pToID, pTarget, fCallback)
	{
		let tmpTable = this.table(pTarget);
		let tmpKeys = new Map();
		if (tmpTable)
		{
			tmpTable.Keymap.forEach((pVersion, pID) => { if ((pID > pAfterID) && ((pToID === null) || (pID <= pToID))) { tmpKeys.set(pID, [ { Key: { IDCustomer: 1 }, Version: pVersion } ]); } });
		}
		setImmediate(() => { fCallback(null, tmpKeys); });
	}

	bucketChecksums(pEntity, pLeafRange, pTarget, fCallback)
	{
		if (this.Fail.bucketChecksums)
		{
			let tmpError = this.Fail.bucketChecksums;
			delete this.Fail.bucketChecksums;
			return setImmediate(() => { fCallback(tmpError); });
		}
		let tmpBuckets = {};
		this.table(pTarget).Keymap.forEach(
			(pVersion, pID) =>
			{
				let tmpBucket = String(Math.trunc(pID / pLeafRange));
				tmpBuckets[tmpBucket] = tmpBuckets[tmpBucket] || { Count: 0, IDSum: '0' };
				tmpBuckets[tmpBucket].Count++;
				// IDSum as a decimal string (ClickHouse quotes 64-bit sums): sameNumber must cope.
				tmpBuckets[tmpBucket].IDSum = String(Number(tmpBuckets[tmpBucket].IDSum) + pID);
			});
		setImmediate(() => { fCallback(null, tmpBuckets); });
	}

	readState(pEntity, fCallback)
	{
		let tmpState = this.States.get(pEntity);
		setImmediate(() => { fCallback(null, tmpState ? Object.assign({}, tmpState) : null); });
	}

	/**
	 * Apply one cycle's diff to a target (the WriterLoop's job; the fake loop calls it).
	 */
	apply(pTarget, pSourceRows, pIDsRead, pVersion, pCoverRange)
	{
		let tmpTable = this.table(pTarget);
		let tmpRead = new Map();
		pSourceRows.forEach((pRow) => { tmpRead.set(pRow.IDTask, pRow); });
		let fApplyID = (pID) =>
		{
			let tmpRow = tmpRead.get(pID);
			if (isLive(tmpRow))
			{
				let tmpCurrent = tmpTable.Mirror.get(pID);
				if (!tmpCurrent || (tmpCurrent.Version < pVersion))
				{
					tmpTable.Mirror.set(pID, { Row: Object.assign({}, tmpRow), Version: pVersion });
					tmpTable.Keymap.set(pID, pVersion);
				}
			}
			else if (tmpTable.Keymap.has(pID))
			{
				let tmpCurrent = tmpTable.Mirror.get(pID);
				if (!tmpCurrent || (tmpCurrent.Version < pVersion))
				{
					tmpTable.Mirror.delete(pID);
					tmpTable.Keymap.delete(pID);
				}
			}
		};
		pIDsRead.forEach(fApplyID);
		if (pCoverRange)
		{
			// Keymap IDs inside the covered range that the source no longer has: hard deletes.
			Array.from(tmpTable.Keymap.keys()).forEach(
				(pID) =>
				{
					if ((pID > pCoverRange.AfterID) && ((pCoverRange.ToID === null) || (pID <= pCoverRange.ToID)) && !tmpRead.has(pID))
					{
						fApplyID(pID);
					}
				});
		}
	}
}

/**
 * A WriterLoop with the documented rebuild + Range-task API; work runs asynchronously, serialized,
 * Stream cycles before Range tasks.
 */
class WorldLoop
{
	constructor(pWorld)
	{
		this.World = pWorld;
		this.Targets = [ 'Live' ];
		this.Queue = [];
		this.Busy = false;
		this.Events = [];
		this.InFlightPages = 0;
		this.PageHook = null;
		this.FailPages = 0;
		this.FailFinish = null;
		this.Tasks = [];
		this.HoldRange = false;
	}

	targets()
	{
		return this.Targets.slice();
	}

	_pump()
	{
		if (this.Busy || (this.Queue.length < 1) || (this.HoldRange && this.Queue.every((pWork) => { return pWork.Kind !== 'Stream'; })))
		{
			return;
		}
		// Stream first (priority), then Range tasks in order.
		let tmpIndex = this.Queue.findIndex((pWork) => { return pWork.Kind === 'Stream'; });
		if (tmpIndex < 0)
		{
			tmpIndex = 0;
		}
		let tmpWork = this.Queue.splice(tmpIndex, 1)[0];
		this.Busy = true;
		setImmediate(
			() =>
			{
				tmpWork.Run(
					() =>
					{
						this.Busy = false;
						this._pump();
					});
			});
	}

	stream(pIDs, fDone)
	{
		this.Queue.push(
			{
				Kind: 'Stream',
				Run: (fNext) =>
				{
					let tmpVersion = this.World.clock();
					let tmpRows = pIDs.filter((pID) => { return this.World.Source.Rows.has(pID); }).map((pID) => { return Object.assign({}, this.World.Source.Rows.get(pID)); });
					this.Targets.forEach((pTarget) => { this.World.Store.apply(pTarget, tmpRows, pIDs, tmpVersion, null); });
					this.Events.push({ Event: 'stream', IDs: pIDs.slice(), Version: tmpVersion, Targets: this.Targets.slice() });
					if (typeof(fDone) === 'function')
					{
						fDone(tmpVersion);
					}
					fNext();
				}
			});
		this._pump();
	}

	addRangeTask(pTask, fOnDone)
	{
		this.Tasks.push(Object.assign({}, pTask));
		this.Queue.push(
			{
				Kind: pTask.Kind,
				Run: (fNext) =>
				{
					if (pTask.Kind === 'RebuildPage')
					{
						this.InFlightPages++;
					}
					let tmpVersion = this.World.clock();
					this.World.Source.readRange(ENTITY, pTask.AfterID, pTask.Cap, { ToID: pTask.ToID },
						(pError, pRows) =>
						{
							let tmpRows = pRows || [];
							let fFinish = () =>
							{
								if (pTask.Kind === 'RebuildPage')
								{
									this.InFlightPages--;
								}
								if ((pTask.Kind === 'RebuildPage') && (this.FailPages > 0))
								{
									this.FailPages--;
									fNext();
									return fOnDone(new Error('injected page failure'));
								}
								let tmpExhausted = tmpRows.length < pTask.Cap;
								let tmpLast = tmpRows.length ? tmpRows[tmpRows.length - 1].IDTask : null;
								let tmpCover = { AfterID: (typeof(pTask.AfterID) === 'number') ? pTask.AfterID : -Infinity, ToID: tmpExhausted ? pTask.ToID : tmpLast };
								if (!this.World.Store.table(pTask.Target))
								{
									fNext();
									return fOnDone(new Error('no such target table'));
								}
								this.World.Store.apply(pTask.Target, tmpRows, tmpRows.map((pRow) => { return pRow.IDTask; }), tmpVersion, tmpCover);
								this.Events.push({ Event: pTask.Kind, Target: pTask.Target, AfterID: pTask.AfterID, LastID: tmpLast, Rows: tmpRows.length, Version: tmpVersion });
								fNext();
								return fOnDone(null, { LastID: tmpLast, Rows: tmpRows.length, Exhausted: tmpExhausted });
							};
							if (this.PageHook && (pTask.Kind === 'RebuildPage'))
							{
								// The page has been READ (at tmpVersion); writes may land before it flushes.
								return this.PageHook(tmpRows, fFinish);
							}
							return fFinish();
						});
				}
			});
		this._pump();
	}

	beginRebuild(pBuildID, pFirstEnable, fCallback)
	{
		this.Events.push({ Event: 'beginRebuild', BuildID: pBuildID, FirstEnable: pFirstEnable });
		this.World.Store.Tables[`Shadow:${pBuildID}`] = { Mirror: new Map(), Keymap: new Map() };
		this.Targets = pFirstEnable ? [ libStoreBase.shadowTarget(pBuildID) ] : [ 'Live', libStoreBase.shadowTarget(pBuildID) ];
		setImmediate(() => { fCallback(null); });
	}

	finishRebuild(pBuildID, fCallback)
	{
		let tmpQueuedPages = this.Queue.filter((pWork) => { return pWork.Kind === 'RebuildPage'; }).length;
		this.Events.push({ Event: 'finishRebuild', BuildID: pBuildID, InFlightPages: this.InFlightPages, QueuedPages: tmpQueuedPages, Busy: this.Busy });
		if (this.FailFinish)
		{
			let tmpError = this.FailFinish;
			this.FailFinish = null;
			return setImmediate(() => { fCallback(tmpError); });
		}
		let tmpShadow = this.World.Store.Tables[`Shadow:${pBuildID}`];
		let tmpFirstEnable = (this.Targets.length === 1);
		if (tmpFirstEnable)
		{
			this.World.Store.Tables.Live = tmpShadow;
		}
		else
		{
			let tmpOld = this.World.Store.Tables.Live;
			this.World.Store.Tables.Live = tmpShadow;
			this.World.Store.Tables[`Shadow:${pBuildID}`] = tmpOld;
		}
		delete this.World.Store.Tables[`Shadow:${pBuildID}`];
		this.Targets = [ 'Live' ];
		this.World.Epoch++;
		setImmediate(() => { fCallback(null); });
	}

	abortRebuild(pBuildID, fCallback)
	{
		this.Events.push({ Event: 'abortRebuild', BuildID: pBuildID });
		delete this.World.Store.Tables[`Shadow:${pBuildID}`];
		this.Targets = [ 'Live' ];
		setImmediate(() => { fCallback(null); });
	}
}

class WorldFreshness
{
	constructor()
	{
		this.States = new Map();
		this.History = [];
	}

	setState(pStore, pEntity, pState, pReason)
	{
		let tmpKey = `${pStore}:${pEntity}`;
		let tmpEntry = this.States.get(tmpKey) || { State: 'Absent', Since: 0, Reason: null, Divergence: false };
		if (tmpEntry.State !== pState)
		{
			tmpEntry.State = pState;
			tmpEntry.Since = Date.now() + (this.History.length / 1000);
		}
		tmpEntry.Reason = pReason;
		if ((pState === 'Rebuilding') || (pState === 'Unverified'))
		{
			tmpEntry.Divergence = (pReason === 'Divergence') || ((pState === 'Unverified') && tmpEntry.Divergence);
		}
		else
		{
			tmpEntry.Divergence = false;
		}
		this.States.set(tmpKey, tmpEntry);
		this.History.push({ State: pState, Reason: pReason });
	}

	state(pStore, pEntity)
	{
		let tmpEntry = this.States.get(`${pStore}:${pEntity}`);
		return tmpEntry ? Object.assign({}, tmpEntry) : { State: 'Absent', Since: null, Reason: null, Divergence: false };
	}
}

class WorldMaterializer
{
	constructor(pWorld)
	{
		this.World = pWorld;
		this.Enqueued = [];
		this.Pending = new Map();
		this.AutoApply = true;
		this.PendingOverride = null;
		this.StateFields = [];
	}

	loop(pStore, pEntity)
	{
		return ((pStore === STORE) && (pEntity === ENTITY)) ? this.World.Loop : null;
	}

	enqueue(pStore, pEntity, pIDs, pOptions)
	{
		this.Enqueued.push({ IDs: pIDs.slice(), Source: pOptions.Source });
		pIDs.forEach((pID) => { this.Pending.set(pID, performance.now()); });
		if (this.AutoApply)
		{
			this.World.Loop.stream(pIDs.slice(), () => { pIDs.forEach((pID) => { this.Pending.delete(pID); }); });
		}
		return pIDs.length;
	}

	enqueuedIDs(pSource)
	{
		let tmpIDs = [];
		this.Enqueued.forEach((pEntry) => { if (!pSource || (pEntry.Source === pSource)) { tmpIDs.push(...pEntry.IDs); } });
		return tmpIDs;
	}

	pendingInfo(pStore, pEntity)
	{
		if (this.PendingOverride)
		{
			return this.PendingOverride();
		}
		let tmpOldest = null;
		this.Pending.forEach((pFirstSeen) => { tmpOldest = (tmpOldest === null) ? pFirstSeen : Math.min(tmpOldest, pFirstSeen); });
		return { Pending: this.Pending.size, InFlight: 0, Buffered: 0, Resolving: 0, OldestFirstSeen: tmpOldest, MinSeqN: null, Dirty: null, Overflow: false };
	}

	setState(pStore, pEntity, pState, pReason)
	{
		this.World.Freshness.setState(pStore, pEntity, pState, pReason);
	}

	updateState(pStore, pEntity, pFields, fCallback)
	{
		this.StateFields.push(Object.assign({}, pFields));
		return fCallback(null);
	}

	entityInfo(pStore, pEntity)
	{
		return { Spec: this.World.Spec };
	}
}

/**
 * A world: source rows 1..pRows, the live mirror loaded from them, state Live.
 *
 * @param {{ Rows?: number, Watermark?: string|null, Options?: Record<string, any>, Loaded?: boolean }} [pOptions]
 * @return {Record<string, any>}
 */
const newWorld = (pOptions) =>
{
	let tmpOptions = pOptions || {};
	let tmpVersion = 1000;
	let tmpWorld = { Epoch: 0, clock: () => { tmpVersion++; return tmpVersion; } };
	tmpWorld.Source = new WorldSource(tmpWorld);
	tmpWorld.Store = new WorldStore();
	tmpWorld.Loop = new WorldLoop(tmpWorld);
	tmpWorld.Freshness = new WorldFreshness();
	tmpWorld.Materializer = new WorldMaterializer(tmpWorld);
	tmpWorld.Spec = (
		{
			Entity: ENTITY, Store: STORE, Identity: 'IDTask',
			Watermark: Object.prototype.hasOwnProperty.call(tmpOptions, 'Watermark') ? tmpOptions.Watermark : 'UpdateDate',
			ColumnNames: [ 'Deleted', 'IDCustomer', 'IDTask', 'Name', 'UpdateDate' ]
		});
	tmpWorld.MirrorSpec = (
		{
			spec: (pStore, pEntity) => { return ((pStore === STORE) && (pEntity === ENTITY)) ? tmpWorld.Spec : null; },
			entities: (pStore) => { return (pStore === STORE) ? [ ENTITY ] : []; }
		});
	let tmpRows = (typeof(tmpOptions.Rows) === 'number') ? tmpOptions.Rows : 30;
	for (let i = 1; i <= tmpRows; i++)
	{
		tmpWorld.Source.put({ IDTask: i, Name: `Task ${i}` });
	}
	if (tmpOptions.Loaded !== false)
	{
		let tmpLoadVersion = tmpWorld.clock();
		tmpWorld.Store.apply('Live', Array.from(tmpWorld.Source.Rows.values()), tmpWorld.Source.sortedIDs(), tmpLoadVersion, null);
		tmpWorld.Freshness.setState(STORE, ENTITY, 'Live', 'Test');
	}

	let tmpFable = libBuilders.newFable('RetoldFacetingRebuilderTests');
	tmpFable.RetoldFacetingMaterializer = tmpWorld.Materializer;
	tmpFable.RetoldFacetingFreshness = tmpWorld.Freshness;
	tmpFable.RetoldFacetingMaterializeSourceInProcess = tmpWorld.Source;
	tmpFable.RetoldFacetingMirrorSpec = tmpWorld.MirrorSpec;
	tmpFable.RetoldFacetingStoreClickHouse = tmpWorld.Store;
	let tmpServiceOptions = Object.assign({ Materializer: { RebuildPageSize: 7, IdleTickMS: 10, BatchIDs: 5 }, Reconcile: { AutoStart: false, SweepCap: 4, LeafRange: 10 } }, tmpOptions.Options || {});
	tmpWorld.Rebuilder = new libRetoldFacetingRebuilder(tmpFable, tmpServiceOptions);
	tmpWorld.Reconciler = new libRetoldFacetingReconciler(tmpFable, tmpServiceOptions);
	tmpFable.RetoldFacetingRebuilder = tmpWorld.Rebuilder;
	tmpFable.RetoldFacetingReconciler = tmpWorld.Reconciler;
	tmpWorld.fable = tmpFable;
	return tmpWorld;
};

/**
 * The live mirror's rows (by ID) vs the source's live rows: equal, row for row.
 *
 * @param {Record<string, any>} pWorld
 * @param {string} [pWhy]
 */
const expectMirrorEqualsSource = (pWorld, pWhy) =>
{
	let tmpExpected = {};
	pWorld.Source.Rows.forEach((pRow, pID) => { if (isLive(pRow)) { tmpExpected[pID] = pRow; } });
	let tmpActual = {};
	pWorld.Store.Tables.Live.Mirror.forEach((pEntry, pID) => { tmpActual[pID] = pEntry.Row; });
	Expect(tmpActual, pWhy).to.deep.equal(tmpExpected);
	Expect(Array.from(pWorld.Store.Tables.Live.Keymap.keys()).sort((pA, pB) => { return pA - pB; }), `${pWhy} (keymap)`).to.deep.equal(Object.keys(tmpExpected).map(Number).sort((pA, pB) => { return pA - pB; }));
};

/**
 * Wait until a predicate holds (polling every 5 ms, up to pTimeoutMS).
 *
 * @param {() => boolean} fPredicate
 * @param {number} pTimeoutMS
 * @param {(pError?: Error) => void} fCallback
 */
const waitFor = (fPredicate, pTimeoutMS, fCallback) =>
{
	let tmpStart = Date.now();
	let fCheck = () =>
	{
		if (fPredicate())
		{
			return fCallback();
		}
		if ((Date.now() - tmpStart) > pTimeoutMS)
		{
			return fCallback(new Error('waitFor: timed out'));
		}
		setTimeout(fCheck, 5);
	};
	fCheck();
};

// ================================================================ the suites

suite
(
	'Facet-Rebuilder-Reconciler',
	() =>
	{
		suite
		(
			'Pure helpers',
			() =>
			{
				test('toEpochMS / formatSecond / formatUTC read and write the stamp texts both dialects use',
					() =>
					{
						let R = libRetoldFacetingReconciler;
						Expect(R.toEpochMS('2025-03-04 05:06:07')).to.equal(Date.UTC(2025, 2, 4, 5, 6, 7));
						Expect(R.toEpochMS('2025-03-04T05:06:07.250Z')).to.equal(Date.UTC(2025, 2, 4, 5, 6, 7, 250));
						Expect(R.toEpochMS('2025-03-04T05:06:07+02:00')).to.equal(Date.UTC(2025, 2, 4, 3, 6, 7));
						Expect(R.toEpochMS('2025-03-04')).to.equal(Date.UTC(2025, 2, 4));
						Expect(R.toEpochMS(new Date(Date.UTC(2020, 0, 1)))).to.equal(Date.UTC(2020, 0, 1));
						Expect(R.toEpochMS('yesterday')).to.equal(null);
						Expect(R.toEpochMS(null)).to.equal(null);
						Expect(R.toEpochMS('')).to.equal(null);
						Expect(R.formatSecond(Date.UTC(2025, 2, 4, 5, 6, 7, 999))).to.equal('2025-03-04 05:06:07');
						Expect(libRetoldFacetingRebuilder.formatUTC(Date.UTC(2025, 2, 4, 5, 6, 7, 9))).to.equal('2025-03-04 05:06:07.009');
					});

				test('leafBounds: buckets truncate toward zero on every side (bucket 0 spans both signs)',
					() =>
					{
						let R = libRetoldFacetingReconciler;
						Expect(R.leafBounds(3, 10)).to.deep.equal({ AfterID: 29, ToID: 39 });
						Expect(R.leafBounds(0, 10)).to.deep.equal({ AfterID: -10, ToID: 9 });
						Expect(R.leafBounds(-2, 10)).to.deep.equal({ AfterID: -30, ToID: -20 });
						// Every ID lands in the bounds of its own bucket.
						[ -25, -20, -11, -9, -1, 0, 1, 9, 10, 19, 39 ].forEach(
							(pID) =>
							{
								let tmpBounds = R.leafBounds(Math.trunc(pID / 10), 10);
								Expect(pID > tmpBounds.AfterID && pID <= tmpBounds.ToID, `ID ${pID}`).to.equal(true);
							});
					});

				test('sameNumber / diffChecksums / leafDifference compare numbers, bigints and decimal strings',
					() =>
					{
						let R = libRetoldFacetingReconciler;
						Expect(R.sameNumber(15, '15')).to.equal(true);
						Expect(R.sameNumber('9007199254740993', '9007199254740993')).to.equal(true);
						Expect(R.sameNumber('9007199254740993', '9007199254740992')).to.equal(false);
						Expect(R.sameNumber(null, 0)).to.equal(true);
						Expect(R.sameNumber(3, 4)).to.equal(false);
						let tmpDiff = R.diffChecksums({ '0': { Count: 5, IDSum: 15 }, '1': { Count: 2, IDSum: 21 }, '2': { Count: 1, IDSum: 20 } }, { 0: { Count: '5', IDSum: '16' }, '1': { Count: 2, IDSum: '21' }, '3': { Count: 1, IDSum: 30 } });
						Expect(tmpDiff).to.deep.equal({ Buckets: 4, Differing: [ 0, 2, 3 ], SourceTotal: 8 });
						let tmpKeys = new Map([ [ 1, [] ], [ 2, [] ], [ 5, [] ] ]);
						Expect(R.leafDifference([ { ID: 1, Live: true }, { ID: '2', Live: 1 }, { ID: 3, Live: true }, { ID: 5, Live: false } ], tmpKeys).sort()).to.deep.equal([ 3, 5 ]);
					});
			}
		);

		suite
		(
			'Rebuilder (unit, in-memory world)',
			() =>
			{
				test('backfill: Building → pages into the shadow → RENAME → CatchingUp → Live; the live mirror equals the source',
					(fDone) =>
					{
						let W = newWorld({ Loaded: false });
						W.Store.Tables = {};
						W.Freshness.setState(STORE, ENTITY, 'Absent', 'Test');
						W.Rebuilder.backfill(STORE, ENTITY, {},
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.Pages).to.equal(5);
								Expect(pResult.Rows).to.equal(30);
								Expect(pResult.State).to.equal('Live');
								Expect(pResult.CaughtUp).to.equal(true);
								Expect(pResult.Reason).to.equal('Backfill');
								Expect(pResult.BuildID).to.match(libStoreBase.BUILD_ID_PATTERN);
								Expect(W.Freshness.History.map((pEntry) => { return pEntry.State; })).to.deep.equal([ 'Absent', 'Building', 'CatchingUp', 'Live' ]);
								let tmpEvents = W.Loop.Events.map((pEvent) => { return pEvent.Event; });
								Expect(tmpEvents[0]).to.equal('beginRebuild');
								Expect(W.Loop.Events[0].FirstEnable).to.equal(true);
								Expect(tmpEvents.filter((pEvent) => { return pEvent === 'RebuildPage'; }).length).to.equal(5);
								Expect(tmpEvents[tmpEvents.length - 1]).to.equal('finishRebuild');
								W.Loop.Tasks.forEach((pTask) => { Expect(pTask.Target).to.equal(libStoreBase.shadowTarget(pResult.BuildID)); Expect(pTask.Cap).to.equal(7); });
								expectMirrorEqualsSource(W, 'after the backfill');
								Expect(W.Rebuilder.status(STORE, ENTITY)).to.equal(null);
								Expect(W.Rebuilder.lastCompleted(STORE, ENTITY).BuildID).to.equal(pResult.BuildID);
								Expect(W.Rebuilder.stateFields(STORE, ENTITY).LastRebuild).to.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
								Expect(W.Materializer.StateFields.some((pFields) => { return typeof(pFields.LastRebuild) === 'string'; })).to.equal(true);
								fDone();
							});
						Expect(W.Rebuilder.status(STORE, ENTITY).Phase).to.equal('Pages');
						Expect(W.Freshness.state(STORE, ENTITY).State).to.equal('Building');
					});

				test('finishRebuild only between flushes: no page in flight or queued when the swap starts',
					(fDone) =>
					{
						let W = newWorld();
						// Stream hints keep arriving while pages run.
						let tmpStreamed = 0;
						W.Loop.PageHook = (pRows, fFinish) =>
						{
							tmpStreamed++;
							W.Loop.stream([ (tmpStreamed % 30) + 1 ]);
							fFinish();
						};
						W.Rebuilder.rebuild(STORE, ENTITY, { Reason: 'Admin' },
							(pError) =>
							{
								Expect(pError).to.equal(null);
								let tmpFinish = W.Loop.Events.filter((pEvent) => { return pEvent.Event === 'finishRebuild'; });
								Expect(tmpFinish.length).to.equal(1);
								Expect(tmpFinish[0].InFlightPages).to.equal(0);
								Expect(tmpFinish[0].QueuedPages).to.equal(0);
								// Every page completed before the swap.
								let tmpSwapAt = W.Loop.Events.indexOf(tmpFinish[0]);
								Expect(W.Loop.Events.slice(tmpSwapAt + 1).some((pEvent) => { return pEvent.Event === 'RebuildPage'; })).to.equal(false);
								fDone();
							});
					});

				test('rebuild: the dual-write window — a write after its page was read lands in the shadow at a higher version, a delete after its page is tombstoned there, an insert past the pages is paged in',
					(fDone) =>
					{
						let W = newWorld();
						let tmpPageVersions = {};
						let tmpPage = 0;
						W.Loop.PageHook = (pRows, fFinish) =>
						{
							tmpPage++;
							if (tmpPage === 2)
							{
								// Pages 1 (IDs 1..7) and 2 (8..14) are read.  Now: update 3, delete 5 (soft),
								// hard-delete 9, insert 31; each write hints a stream cycle (dual-write).
								let tmpRow3 = W.Source.Rows.get(3);
								tmpRow3.Name = 'renamed after its page';
								W.Source.Rows.get(5).Deleted = 1;
								W.Source.Rows.delete(9);
								W.Source.put({ IDTask: 31, Name: 'new' });
								W.Materializer.enqueue(STORE, ENTITY, [ 3, 5, 9, 31 ], { Source: 'Change' });
							}
							fFinish();
						};
						let tmpLiveBefore = W.Store.Tables.Live;
						W.Rebuilder.rebuild(STORE, ENTITY, { Reason: 'SpecChange' },
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.State).to.equal('Live');
								Expect(W.Freshness.History.map((pEntry) => { return pEntry.State; })).to.deep.equal([ 'Live', 'Rebuilding', 'Live' ]);
								Expect(W.Loop.Events[0].FirstEnable).to.equal(false);
								// The stream cycle during the build wrote BOTH tables.
								let tmpStream = W.Loop.Events.find((pEvent) => { return pEvent.Event === 'stream'; });
								Expect(tmpStream.Targets).to.deep.equal([ 'Live', libStoreBase.shadowTarget(pResult.BuildID) ]);
								// The shadow (now live) has row 3 at the stream's version, above its page's.
								let tmpPage1 = W.Loop.Events.find((pEvent) => { return (pEvent.Event === 'RebuildPage') && (pEvent.AfterID === null); });
								let tmpRow3 = W.Store.Tables.Live.Mirror.get(3);
								Expect(tmpRow3.Row.Name).to.equal('renamed after its page');
								Expect(tmpRow3.Version).to.equal(tmpStream.Version);
								Expect(tmpRow3.Version).to.be.above(tmpPage1.Version);
								Expect(W.Store.Tables.Live.Mirror.has(5), 'soft delete after its page: tombstoned in the shadow').to.equal(false);
								Expect(W.Store.Tables.Live.Mirror.has(9), 'hard delete after its page: tombstoned in the shadow').to.equal(false);
								Expect(W.Store.Tables.Live.Mirror.has(31)).to.equal(true);
								Expect(W.Store.Tables.Live).to.not.equal(tmpLiveBefore);
								Expect(W.Epoch).to.equal(1);
								expectMirrorEqualsSource(W, 'after the rebuild');
								fDone();
							});
						Expect(W.Freshness.state(STORE, ENTITY).State).to.equal('Rebuilding');
					});

				test('a divergence-triggered rebuild is Rebuilding (divergence-marked) and ends Unverified',
					(fDone) =>
					{
						let W = newWorld();
						W.Rebuilder.rebuild(STORE, ENTITY, { Reason: 'Divergence' },
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.State).to.equal('Unverified');
								let tmpState = W.Freshness.state(STORE, ENTITY);
								Expect(tmpState.State).to.equal('Unverified');
								Expect(tmpState.Divergence).to.equal(true);
								Expect(W.Freshness.History[1]).to.deep.equal({ State: 'Rebuilding', Reason: 'Divergence' });
								fDone();
							});
					});

				test('a second request joins the build in flight (one beginRebuild, one BuildID)',
					(fDone) =>
					{
						let W = newWorld();
						let tmpResults = [];
						let fOne = (pError, pResult) =>
						{
							Expect(pError).to.equal(null);
							tmpResults.push(pResult);
							if (tmpResults.length < 3)
							{
								return;
							}
							Expect(tmpResults[0].BuildID).to.equal(tmpResults[1].BuildID);
							Expect(tmpResults[1].BuildID).to.equal(tmpResults[2].BuildID);
							Expect(W.Loop.Events.filter((pEvent) => { return pEvent.Event === 'beginRebuild'; }).length).to.equal(1);
							Expect(W.Rebuilder.stats().Joined).to.equal(2);
							fDone();
						};
						W.Rebuilder.rebuild(STORE, ENTITY, { Reason: 'Admin' }, fOne);
						W.Rebuilder.rebuild(STORE, ENTITY, { Reason: 'SpecChange' }, fOne);
						W.Rebuilder.backfill(STORE, ENTITY, {}, fOne);
					});

				test('cancel: abortRebuild, the shadow dropped, the prior state back (Unverified after a divergence trigger, Absent for a first enable)',
					(fDone) =>
					{
						let W = newWorld();
						let tmpCancelled = false;
						W.Loop.PageHook = (pRows, fFinish) =>
						{
							if (!tmpCancelled)
							{
								tmpCancelled = true;
								W.Rebuilder.cancel(STORE, ENTITY,
									(pError, pResult) =>
									{
										Expect(pError).to.equal(null);
										Expect(pResult.Cancelled).to.equal(true);
									});
							}
							fFinish();
						};
						W.Rebuilder.rebuild(STORE, ENTITY, { Reason: 'Admin' },
							(pError) =>
							{
								Expect(pError).to.be.an('error');
								Expect(pError.Cancelled).to.equal(true);
								Expect(W.Loop.Events.some((pEvent) => { return pEvent.Event === 'abortRebuild'; })).to.equal(true);
								Expect(W.Loop.Events.some((pEvent) => { return pEvent.Event === 'finishRebuild'; })).to.equal(false);
								Expect(Object.keys(W.Store.Tables)).to.deep.equal([ 'Live' ]);
								Expect(W.Freshness.state(STORE, ENTITY).State).to.equal('Live');
								Expect(W.Rebuilder.status(STORE, ENTITY)).to.equal(null);
								// The late page completion of the aborted build is ignored (no swap later).
								setTimeout(
									() =>
									{
										Expect(W.Loop.Events.some((pEvent) => { return pEvent.Event === 'finishRebuild'; })).to.equal(false);
										W.Rebuilder.cancel(STORE, ENTITY,
											(pCancelError, pNothing) =>
											{
												Expect(pNothing).to.deep.equal({ Cancelled: false, Reason: 'NotRunning' });
												// A divergence rebuild that is cancelled leaves the entity Unverified.
												let W2 = newWorld();
												W2.Loop.PageHook = (pRows2, fFinish2) => { W2.Rebuilder.cancel(STORE, ENTITY, () => {}); fFinish2(); };
												W2.Rebuilder.rebuild(STORE, ENTITY, { Reason: 'Divergence' },
													(pError2) =>
													{
														Expect(pError2.Cancelled).to.equal(true);
														Expect(W2.Freshness.state(STORE, ENTITY)).to.include({ State: 'Unverified', Divergence: true });
														// A first enable that is cancelled goes back to Absent.
														let W3 = newWorld({ Loaded: false });
														W3.Store.Tables = {};
														W3.Loop.PageHook = (pRows3, fFinish3) => { W3.Rebuilder.cancel(STORE, ENTITY, () => {}); fFinish3(); };
														W3.Rebuilder.backfill(STORE, ENTITY, {},
															(pError3) =>
															{
																Expect(pError3.Cancelled).to.equal(true);
																Expect(W3.Freshness.state(STORE, ENTITY).State).to.equal('Absent');
																fDone();
															});
													});
											});
									}, 30);
							});
					});

				test('a wipe supersedes the build in flight: it is aborted and its callers get the new (first-enable) build',
					(fDone) =>
					{
						let W = newWorld();
						let tmpWiped = false;
						let tmpResults = [];
						let fCheck = () =>
						{
							if (tmpResults.length < 2)
							{
								return;
							}
							Expect(tmpResults[0].Error).to.equal(null);
							Expect(tmpResults[1].Error).to.equal(null);
							Expect(tmpResults[0].Result.BuildID).to.equal(tmpResults[1].Result.BuildID);
							Expect(tmpResults[1].Result.Reason).to.equal('Wipe');
							Expect(tmpResults[1].Result.FirstEnable).to.equal(true);
							let tmpBegins = W.Loop.Events.filter((pEvent) => { return pEvent.Event === 'beginRebuild'; });
							Expect(tmpBegins.length).to.equal(2);
							Expect(tmpBegins[1].FirstEnable).to.equal(true);
							Expect(W.Loop.Events.some((pEvent) => { return (pEvent.Event === 'abortRebuild') && (pEvent.BuildID === tmpBegins[0].BuildID); })).to.equal(true);
							Expect(W.Rebuilder.stats().Superseded).to.equal(1);
							expectMirrorEqualsSource(W, 'after the wipe build');
							Expect(W.Freshness.state(STORE, ENTITY).State).to.equal('Live');
							fDone();
						};
						W.Loop.PageHook = (pRows, fFinish) =>
						{
							if (!tmpWiped)
							{
								tmpWiped = true;
								// The store lost its tables; the Materializer's recoverWipe asks for a backfill.
								W.Store.Tables = {};
								W.Freshness.setState(STORE, ENTITY, 'Absent', 'Wipe');
								W.Rebuilder.backfill(STORE, ENTITY, { Reason: 'Wipe' }, (pError, pResult) => { tmpResults.push({ Error: pError, Result: pResult }); fCheck(); });
							}
							fFinish();
						};
						W.Rebuilder.rebuild(STORE, ENTITY, { Reason: 'Admin' }, (pError, pResult) => { tmpResults.unshift({ Error: pError, Result: pResult }); fCheck(); });
					});

				test('a failed page or swap aborts the build, restores the state and reports the error',
					(fDone) =>
					{
						let W = newWorld();
						W.Loop.FailPages = 1;
						W.Rebuilder.rebuild(STORE, ENTITY, { Reason: 'Admin' },
							(pError) =>
							{
								Expect(pError).to.be.an('error');
								Expect(pError.Step).to.equal('RebuildPage');
								Expect(W.Freshness.state(STORE, ENTITY).State).to.equal('Live');
								Expect(Object.keys(W.Store.Tables)).to.deep.equal([ 'Live' ]);
								Expect(W.Rebuilder.stats().Failed).to.equal(1);
								W.Loop.FailFinish = new Error('EXCHANGE failed');
								W.Rebuilder.rebuild(STORE, ENTITY, { Reason: 'Admin' },
									(pSwapError) =>
									{
										Expect(pSwapError.message).to.equal('EXCHANGE failed');
										Expect(pSwapError.Step).to.equal('finishRebuild');
										Expect(W.Freshness.state(STORE, ENTITY).State).to.equal('Live');
										// And the next rebuild works.
										W.Rebuilder.rebuild(STORE, ENTITY, { Reason: 'Admin' },
											(pFinalError, pResult) =>
											{
												Expect(pFinalError).to.equal(null);
												Expect(pResult.State).to.equal('Live');
												expectMirrorEqualsSource(W, 'after a clean rebuild');
												fDone();
											});
									});
							});
					});

				test('a first enable stays CatchingUp until the hints from before the swap are applied',
					(fDone) =>
					{
						let W = newWorld({ Loaded: false });
						W.Store.Tables = {};
						W.Freshness.setState(STORE, ENTITY, 'Absent', 'Test');
						let tmpOld = performance.now() - 1000;
						let tmpDrained = false;
						W.Materializer.PendingOverride = () =>
						{
							return tmpDrained ? { Pending: 2, InFlight: 0, Buffered: 0, Resolving: 0, OldestFirstSeen: performance.now() + 1000, Dirty: null }
								: { Pending: 1, InFlight: 0, Buffered: 0, Resolving: 0, OldestFirstSeen: tmpOld, Dirty: null };
						};
						let tmpCallbackAt = null;
						W.Rebuilder.backfill(STORE, ENTITY, {},
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.State).to.equal('Live');
								tmpCallbackAt = Date.now();
							});
						waitFor(() => { return W.Freshness.state(STORE, ENTITY).State === 'CatchingUp'; }, 2000,
							(pError) =>
							{
								Expect(pError).to.equal(undefined);
								setTimeout(
									() =>
									{
										Expect(W.Freshness.state(STORE, ENTITY).State, 'the old hint is still pending').to.equal('CatchingUp');
										Expect(W.Rebuilder.status(STORE, ENTITY).Phase).to.equal('CatchingUp');
										Expect(tmpCallbackAt).to.equal(null);
										// Newer hints may keep arriving; only the ones from before the swap matter.
										tmpDrained = true;
										waitFor(() => { return tmpCallbackAt !== null; }, 2000,
											(pWaitError) =>
											{
												Expect(pWaitError).to.equal(undefined);
												Expect(W.Freshness.state(STORE, ENTITY).State).to.equal('Live');
												fDone();
											});
									}, 60);
							});
					});

				test('stop() completes a build that only waits for its catch-up (CaughtUp false) and leaves no timer',
					(fDone) =>
					{
						let W = newWorld({ Loaded: false });
						W.Store.Tables = {};
						W.Freshness.setState(STORE, ENTITY, 'Absent', 'Test');
						W.Materializer.PendingOverride = () => { return { Pending: 1, InFlight: 0, Buffered: 0, Resolving: 0, OldestFirstSeen: 0, Dirty: null }; };
						W.Rebuilder.backfill(STORE, ENTITY, {},
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.CaughtUp).to.equal(false);
								Expect(pResult.State).to.equal('CatchingUp');
								Expect(W.Rebuilder._Timers.size).to.equal(0);
								Expect(W.Rebuilder.status(STORE, ENTITY)).to.equal(null);
								fDone();
							});
						waitFor(() => { return W.Freshness.state(STORE, ENTITY).State === 'CatchingUp'; }, 2000, () => { W.Rebuilder.stop(); });
					});

				test('refusals: an unmaterialized entity is FACET_UNKNOWN_ENTITY, an unknown Reason FACET_REQUEST_INVALID; cancel on a swap is refused',
					(fDone) =>
					{
						let W = newWorld();
						W.Rebuilder.rebuild(STORE, 'Nope', { Reason: 'Admin' },
							(pError) =>
							{
								Expect(pError.Code).to.equal('FACET_UNKNOWN_ENTITY');
								Expect(pError.Status).to.equal(404);
								W.Rebuilder.rebuild(STORE, ENTITY, { Reason: 'Because' },
									(pReasonError) =>
									{
										Expect(pReasonError.Code).to.equal('FACET_REQUEST_INVALID');
										Expect(libRetoldFacetingRebuilder.REBUILD_REASONS).to.deep.equal([ 'Admin', 'SpecChange', 'Divergence', 'Wipe' ]);
										// Hold the swap: cancel is refused while the tables are being exchanged.
										let tmpFinish = W.Loop.finishRebuild.bind(W.Loop);
										W.Loop.finishRebuild = (pBuildID, fCallback) =>
										{
											W.Rebuilder.cancel(STORE, ENTITY,
												(pCancelError, pCancel) =>
												{
													Expect(pCancel).to.include({ Cancelled: false, Reason: 'Swapping' });
													tmpFinish(pBuildID, fCallback);
												});
										};
										W.Rebuilder.rebuild(STORE, ENTITY, { Reason: 'Admin' },
											(pFinalError, pResult) =>
											{
												Expect(pFinalError).to.equal(null);
												Expect(pResult.State).to.equal('Live');
												fDone();
											});
									});
							});
					});
			}
		);

		suite
		(
			'Reconciler: Sweep (unit)',
			() =>
			{
				test('compound keyset: more than SweepCap rows on one stamp and a lower ID stamped later are each enqueued once; the watermark advances after the complete pass',
					(fDone) =>
					{
						let W = newWorld({ Rows: 0 });
						W.Materializer.AutoApply = false;
						let tmpBase = Date.parse('2025-06-01T12:00:00Z');
						// 9 rows (> SweepCap 4) share one stamp; ID 2 is stamped later than every other.
						for (let i = 1; i <= 12; i++)
						{
							W.Source.put({ IDTask: i, UpdateDate: stamp(tmpBase + ((i > 9) ? 1000 : 0)) });
						}
						W.Source.Rows.get(2).UpdateDate = stamp(tmpBase + 5000);
						W.Source.put({ IDTask: 13, UpdateDate: null });
						W.Reconciler.sweep(STORE, ENTITY, {},
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								let tmpIDs = W.Materializer.enqueuedIDs('Sweep');
								Expect(tmpIDs.slice().sort((pA, pB) => { return pA - pB; })).to.deep.equal([ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 ]);
								Expect(new Set(tmpIDs).size).to.equal(tmpIDs.length);
								Expect(pResult.Enqueued).to.equal(12);
								// 4 + 4 + 4 (a full page) + an empty page that ends the pass.
								Expect(pResult.Pages).to.equal(4);
								Expect(pResult.Watermark).to.equal(libRetoldFacetingRebuilder.formatUTC(tmpBase + 5000));
								// The first page of a pass with no watermark has no lower bound.
								Expect(W.Source.Calls.sweep[0]).to.deep.equal({ Column: 'UpdateDate', From: { At: null, ID: null }, Cap: 4 });
								// Later pages continue from the last (At, ID) of the page before.
								Expect(W.Source.Calls.sweep[1].From).to.deep.equal({ At: stamp(tmpBase), ID: 5 });
								Expect(W.Source.Calls.sweep[2].From).to.deep.equal({ At: stamp(tmpBase), ID: 9 });
								Expect(W.Source.Calls.sweep[3].From).to.deep.equal({ At: stamp(tmpBase + 5000), ID: 2 });
								Expect(W.Reconciler.status(STORE, ENTITY).Watermark).to.equal(pResult.Watermark);
								Expect(W.Reconciler.stateFields(STORE, ENTITY).SweepWatermark).to.equal(pResult.Watermark);
								Expect(W.Materializer.StateFields.some((pFields) => { return pFields.SweepWatermark === pResult.Watermark; })).to.equal(true);
								fDone();
							});
					});

				test('the next pass starts at Watermark − OverlapMS: rows inside the overlap are re-read, older ones are not',
					(fDone) =>
					{
						let W = newWorld({ Rows: 0, Options: { Reconcile: { AutoStart: false, SweepCap: 4, LeafRange: 10, MaxTxnMS: 60000 } } });
						W.Materializer.AutoApply = false;
						let tmpBase = Date.parse('2025-06-01T12:00:00Z');
						W.Source.put({ IDTask: 1, UpdateDate: stamp(tmpBase - 3600000) });
						W.Source.put({ IDTask: 2, UpdateDate: stamp(tmpBase - 30000) });
						W.Source.put({ IDTask: 3, UpdateDate: stamp(tmpBase) });
						W.Reconciler.sweep(STORE, ENTITY, {},
							(pError) =>
							{
								Expect(pError).to.equal(null);
								W.Materializer.Enqueued = [];
								// A raw stamped update after the pass.
								W.Source.put({ IDTask: 4, UpdateDate: stamp(tmpBase + 2000) });
								W.Reconciler.sweep(STORE, ENTITY, {},
									(pSecondError, pSecond) =>
									{
										Expect(pSecondError).to.equal(null);
										let tmpFrom = W.Source.Calls.sweep[W.Source.Calls.sweep.length - 1].From;
										Expect(tmpFrom).to.deep.equal({ At: stamp(tmpBase - 60000), ID: null });
										Expect(W.Materializer.enqueuedIDs('Sweep').sort()).to.deep.equal([ 2, 3, 4 ]);
										Expect(pSecond.Watermark).to.equal(libRetoldFacetingRebuilder.formatUTC(tmpBase + 2000));
										fDone();
									});
							});
					});

				test('a restart resumes from the persisted state row: the Sweep from its watermark, the Scrub from its cursor (a resumed rotation never vouches for ScrubbedThrough)',
					(fDone) =>
					{
						let W = newWorld({ Rows: 12 });
						W.Materializer.AutoApply = false;
						let tmpPersisted = { SweepWatermark: '2025-06-01 12:00:00', ScrubCursor: 8, ScrubbedThrough: Date.UTC(2025, 4, 1), LastBisect: '2025-05-31 00:00:00.000' };
						W.Materializer.stateRow = (pStore, pEntity) => { return ((pStore === STORE) && (pEntity === ENTITY)) ? tmpPersisted : null; };
						W.Reconciler.sweep(STORE, ENTITY, {},
							(pError) =>
							{
								Expect(pError).to.equal(null);
								Expect(W.Source.Calls.sweep[0].From).to.deep.equal({ At: '2025-06-01 11:59:00', ID: null });
								let tmpStatus = W.Reconciler.status(STORE, ENTITY);
								Expect(tmpStatus.ScrubCursor).to.equal(8);
								Expect(tmpStatus.ScrubbedThrough).to.equal('2025-05-01 00:00:00.000');
								Expect(tmpStatus.LastBisect).to.equal('2025-05-31 00:00:00.000');
								W.Reconciler.scrub(STORE, ENTITY, { Cap: 10 },
									(pScrubError, pScrub) =>
									{
										Expect(pScrubError).to.equal(null);
										Expect(W.Loop.Tasks[0].AfterID).to.equal(8);
										Expect(pScrub).to.deep.equal({ Ranges: 1, Rows: 4, Wrapped: true });
										// The rotation resumed mid-pass in an earlier process: its wrap keeps the old high-water.
										Expect(W.Reconciler.status(STORE, ENTITY).ScrubbedThrough).to.equal('2025-05-01 00:00:00.000');
										Expect(W.Reconciler.status(STORE, ENTITY).ScrubCursor).to.equal(null);
										fDone();
									});
							});
					});

				test('the watermark moves only after a complete pass (a failing page leaves it where it was)',
					(fDone) =>
					{
						let W = newWorld({ Rows: 10 });
						W.Materializer.AutoApply = false;
						W.Reconciler.sweep(STORE, ENTITY, {},
							(pError, pFirst) =>
							{
								Expect(pError).to.equal(null);
								let tmpWatermark = pFirst.Watermark;
								W.Source.put({ IDTask: 50, UpdateDate: '2030-01-01 00:00:00' });
								let tmpSweep = W.Source.sweep.bind(W.Source);
								let tmpCalls = 0;
								W.Source.sweep = (pEntity, pOptions, fCallback) =>
								{
									tmpCalls++;
									if (tmpCalls === 2)
									{
										return setImmediate(() => { fCallback(new Error('source went away')); });
									}
									return tmpSweep(pEntity, pOptions, fCallback);
								};
								W.Reconciler.sweep(STORE, ENTITY, {},
									(pSecondError) =>
									{
										Expect(pSecondError.message).to.equal('source went away');
										Expect(W.Reconciler.status(STORE, ENTITY).Watermark).to.equal(tmpWatermark);
										fDone();
									});
							});
					});

				test('no watermark (NoWatermark entity): the Sweep is skipped; concurrent sweeps join one pass',
					(fDone) =>
					{
						let W = newWorld({ Watermark: null });
						W.Reconciler.sweep(STORE, ENTITY, {},
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult).to.deep.equal({ Enqueued: 0, Watermark: null, Pages: 0, Skipped: 'NoWatermark' });
								Expect(W.Source.Calls.sweep.length).to.equal(0);
								let W2 = newWorld({ Rows: 6 });
								W2.Materializer.AutoApply = false;
								let tmpResults = [];
								let fOne = (pOneError, pOne) =>
								{
									tmpResults.push(pOne);
									if (tmpResults.length === 2)
									{
										Expect(tmpResults[0]).to.deep.equal(tmpResults[1]);
										Expect(W2.Source.Calls.sweep.length).to.equal(2);
										Expect(W2.Materializer.enqueuedIDs('Sweep').length).to.equal(6);
										fDone();
									}
								};
								W2.Reconciler.sweep(STORE, ENTITY, {}, fOne);
								Expect(W2.Reconciler.isRunning(STORE, ENTITY, 'Sweep')).to.equal(true);
								Expect(W2.Reconciler.status(STORE, ENTITY).Running).to.deep.equal([ 'Sweep' ]);
								W2.Reconciler.sweep(STORE, ENTITY, {}, fOne);
							});
					});
			}
		);

		suite
		(
			'Reconciler: Bisect (unit)',
			() =>
			{
				test('an insert and a hard delete the hints missed are found and repaired',
					(fDone) =>
					{
						let W = newWorld({ Rows: 40 });
						// Raw writes, no hint: an insert (41), a hard delete (17), and a soft delete (23).
						W.Source.put({ IDTask: 41 });
						W.Source.Rows.delete(17);
						W.Source.Rows.get(23).Deleted = 1;
						W.Reconciler.bisect(STORE, ENTITY, { Escalate: false },
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.Buckets).to.equal(5);
								Expect(pResult.DifferingLeaves).to.equal(3);
								Expect(pResult.Enqueued).to.equal(3);
								Expect(W.Materializer.enqueuedIDs('Bisect').sort((pA, pB) => { return pA - pB; })).to.deep.equal([ 17, 23, 41 ]);
								Expect(pResult.Rebuilt).to.equal(false);
								Expect(W.Reconciler.status(STORE, ENTITY).LastBisect).to.match(/^\d{4}-\d{2}-\d{2} /);
								waitFor(() => { return W.Materializer.Pending.size === 0; }, 2000,
									() =>
									{
										expectMirrorEqualsSource(W, 'after the Bisect repairs');
										fDone();
									});
							});
					});

				test('one hard delete + one insert in the same leaf (equal counts) is caught by IDSum',
					(fDone) =>
					{
						let W = newWorld({ Rows: 8 });
						W.Materializer.AutoApply = false;
						// Bucket 0 (LeafRange 10): source {1,2,3,4,6,7,8,9}, keymap {1..8} — 8 rows each side.
						W.Source.Rows.delete(5);
						W.Source.put({ IDTask: 9 });
						W.Reconciler.bisect(STORE, ENTITY, { Escalate: false },
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.Buckets).to.equal(1);
								Expect(pResult.DifferingLeaves).to.equal(1);
								Expect(W.Materializer.enqueuedIDs('Bisect').sort()).to.deep.equal([ 5, 9 ]);
								fDone();
							});
					});

				test('the divergence ratio excludes pending / in-flight IDs and rows stamped since BisectStart − OverlapMS',
					(fDone) =>
					{
						let W = newWorld({ Rows: 100 });
						W.Materializer.AutoApply = false;
						let tmpRebuilds = 0;
						W.Rebuilder.rebuild = (pStore, pEntity, pOptions, fCallback) => { tmpRebuilds++; fCallback(null, {}); };
						// 5 differing rows (5% > 1%): 3 freshly stamped (in-flight writes), 1 already pending.
						let tmpNow = stamp(Date.now());
						[ 101, 102, 103 ].forEach((pID) => { W.Source.put({ IDTask: pID, UpdateDate: tmpNow }); });
						W.Source.put({ IDTask: 104 });
						W.Source.put({ IDTask: 105 });
						W.Materializer.isPending = (pStore, pEntity, pID) => { return pID === 104; };
						W.Reconciler.bisect(STORE, ENTITY, {},
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.Enqueued).to.equal(5);
								// Only 105 counts: 1 / 105.
								Expect(pResult.Divergence).to.be.closeTo(1 / 105, 1e-9);
								Expect(pResult.Rebuilt).to.equal(false);
								Expect(tmpRebuilds).to.equal(0);
								// Without isPending, the pending COUNT bounds the exclusion (never over-counting).
								delete W.Materializer.isPending;
								W.Materializer.Pending = new Map([ [ 104, 0 ], [ 999, 0 ] ]);
								W.Materializer.Enqueued = [];
								W.Reconciler.bisect(STORE, ENTITY, {},
									(pSecondError, pSecond) =>
									{
										Expect(pSecondError).to.equal(null);
										// 5 differing − 3 recent − 2 pending (count bound) = 0.
										Expect(pSecond.Divergence).to.equal(0);
										Expect(tmpRebuilds).to.equal(0);
										fDone();
									});
							});
					});

				test('divergence above RebuildDivergenceRatio escalates to a rebuild that ends Unverified, then a verify lifts it to Live',
					(fDone) =>
					{
						let W = newWorld({ Rows: 100 });
						// 10 rows the mirror never saw, stamped long ago (lost hints, not in-flight writes).
						for (let i = 101; i <= 110; i++)
						{
							W.Source.put({ IDTask: i, UpdateDate: '2020-01-01 00:00:00' });
						}
						W.Materializer.AutoApply = false;
						W.Reconciler.bisect(STORE, ENTITY, {},
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.Divergence).to.be.closeTo(10 / 110, 1e-9);
								Expect(pResult.Rebuilt).to.equal(true);
								Expect(W.Freshness.History.map((pEntry) => { return pEntry.State; })).to.include.members([ 'Rebuilding', 'Unverified' ]);
								expectMirrorEqualsSource(W, 'after the divergence rebuild');
								W.Materializer.AutoApply = true;
								W.Materializer.Pending.clear();
								// The background verify (Bisect + full Scrub) ends Live.
								waitFor(() => { return W.Freshness.state(STORE, ENTITY).State === 'Live'; }, 3000,
									(pWaitError) =>
									{
										Expect(pWaitError).to.equal(undefined);
										Expect(W.Freshness.History[W.Freshness.History.length - 1]).to.deep.equal({ State: 'Live', Reason: 'Verified' });
										Expect(W.Reconciler.stats().Rebuilds).to.equal(1);
										fDone();
									});
							});
					});

				test('a store error fails the Bisect and changes nothing',
					(fDone) =>
					{
						let W = newWorld({ Rows: 20 });
						W.Store.Fail.bucketChecksums = Object.assign(new Error('ClickHouse 500: boom'), { StoreError: true });
						W.Reconciler.bisect(STORE, ENTITY, {},
							(pError) =>
							{
								Expect(pError.StoreError).to.equal(true);
								Expect(W.Materializer.Enqueued.length).to.equal(0);
								Expect(W.Reconciler.isRunning(STORE, ENTITY, 'Bisect')).to.equal(false);
								Expect(W.Reconciler.stats().Errors).to.equal(1);
								fDone();
							});
					});
			}
		);

		suite
		(
			'Reconciler: Scrub and verify (unit)',
			() =>
			{
				test('a tick re-reads Cap rows from the rotating cursor; the short read wraps it and sets ScrubbedThrough to the pass start',
					(fDone) =>
					{
						let W = newWorld({ Rows: 10 });
						// An unstamped in-place update the Sweep and Bisect cannot see.
						W.Source.Rows.get(4).Name = 'changed in place';
						W.Source.Rows.get(9).Name = 'changed too';
						let tmpPassStart = Date.now();
						W.Reconciler.scrub(STORE, ENTITY, { Cap: 4 },
							(pError, pFirst) =>
							{
								Expect(pError).to.equal(null);
								Expect(pFirst).to.deep.equal({ Ranges: 1, Rows: 4, Wrapped: false });
								Expect(W.Reconciler.status(STORE, ENTITY).ScrubCursor).to.equal(4);
								Expect(W.Store.Tables.Live.Mirror.get(4).Row.Name).to.equal('changed in place');
								Expect(W.Store.Tables.Live.Mirror.get(9).Row.Name).to.equal('Task 9');
								W.Reconciler.scrub(STORE, ENTITY, { Cap: 4 },
									(pSecondError, pSecond) =>
									{
										Expect(pSecond).to.deep.equal({ Ranges: 1, Rows: 4, Wrapped: false });
										W.Reconciler.scrub(STORE, ENTITY, { Cap: 4 },
											(pThirdError, pThird) =>
											{
												Expect(pThird).to.deep.equal({ Ranges: 1, Rows: 2, Wrapped: true });
												let tmpStatus = W.Reconciler.status(STORE, ENTITY);
												Expect(tmpStatus.ScrubCursor).to.equal(null);
												Expect(libRetoldFacetingReconciler.toEpochMS(tmpStatus.ScrubbedThrough)).to.be.within(tmpPassStart - 5, tmpPassStart + 1000);
												Expect(W.Loop.Tasks.map((pTask) => { return [ pTask.Kind, pTask.Target, pTask.AfterID, pTask.Cap ]; })).to.deep.equal([ [ 'Scrub', 'Live', null, 4 ], [ 'Scrub', 'Live', 4, 4 ], [ 'Scrub', 'Live', 8, 4 ] ]);
												expectMirrorEqualsSource(W, 'after one rotation');
												Expect(W.Materializer.StateFields.some((pFields) => { return pFields.ScrubbedThrough === tmpStatus.ScrubbedThrough; })).to.equal(true);
												fDone();
											});
									});
							});
					});

				test('{ Full: true } runs one complete pass now (Kind Fill for the additive fill); Building / Absent entities are skipped',
					(fDone) =>
					{
						let W = newWorld({ Rows: 23, Options: { Reconcile: { AutoStart: false, ScrubRowsPerSecond: 2, ScrubTickMS: 1000 } } });
						W.Reconciler.scrub(STORE, ENTITY, { Full: true },
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								// BatchIDs 5 > tick ceiling 2: 5 tasks of 5 (the last one short).
								Expect(pResult).to.deep.equal({ Ranges: 5, Rows: 23, Wrapped: true });
								W.Loop.Tasks = [];
								W.Reconciler.scrub(STORE, ENTITY, { Full: true, Kind: 'Fill', Cap: 100 },
									(pFillError, pFill) =>
									{
										Expect(pFill).to.deep.equal({ Ranges: 1, Rows: 23, Wrapped: true });
										Expect(W.Loop.Tasks[0]).to.deep.equal({ Kind: 'Fill', Target: 'Live', AfterID: null, ToID: null, Cap: 100 });
										W.Freshness.setState(STORE, ENTITY, 'Building', 'Test');
										W.Reconciler.scrub(STORE, ENTITY, { Full: true },
											(pSkipError, pSkip) =>
											{
												Expect(pSkip).to.deep.equal({ Ranges: 0, Rows: 0, Wrapped: false, Skipped: 'State:Building' });
												fDone();
											});
									});
							});
					});

				test('a full Scrub requested while a tick runs waits for it and then runs (never joins it)',
					(fDone) =>
					{
						let W = newWorld({ Rows: 12 });
						let tmpOrder = [];
						W.Reconciler.scrub(STORE, ENTITY, { Cap: 3 }, (pError, pTick) => { tmpOrder.push([ 'Tick', pTick.Rows ]); });
						W.Reconciler.scrub(STORE, ENTITY, { Full: true },
							(pError, pFull) =>
							{
								tmpOrder.push([ 'Full', pFull.Rows ]);
								Expect(tmpOrder).to.deep.equal([ [ 'Tick', 3 ], [ 'Full', 12 ] ]);
								fDone();
							});
					});

				test('verify: an Unverified entity gets a Bisect + a full Scrub and goes Live; the mirror equals the source',
					(fDone) =>
					{
						let W = newWorld({ Rows: 30, Options: { Reconcile: { AutoStart: false, LeafRange: 10, RebuildDivergenceRatio: 0.5 } } });
						// What a crash between flush and ack can leave: hints lost, the mirror behind.
						W.Source.Rows.get(7).Name = 'lost update';
						W.Source.Rows.delete(12);
						W.Source.put({ IDTask: 44 });
						W.Freshness.setState(STORE, ENTITY, 'Unverified', 'UncleanShutdown');
						W.Reconciler.verify(STORE, ENTITY,
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.Verified).to.equal(true);
								Expect(pResult.State).to.equal('Live');
								Expect(pResult.Bisect.Enqueued).to.equal(2);
								Expect(pResult.Scrub.Wrapped).to.equal(true);
								Expect(W.Freshness.state(STORE, ENTITY).State).to.equal('Live');
								waitFor(() => { return W.Materializer.Pending.size === 0; }, 2000,
									() =>
									{
										expectMirrorEqualsSource(W, 'after verify');
										fDone();
									});
							});
					});

				test('verify does not lift a newer Unverified trigger that arrived during its pass; a verify of a Live entity leaves it Live',
					(fDone) =>
					{
						let W = newWorld({ Rows: 10 });
						W.Freshness.setState(STORE, ENTITY, 'Unverified', 'UncleanShutdown');
						let tmpTriggers = 0;
						let tmpAddRange = W.Loop.addRangeTask.bind(W.Loop);
						W.Loop.addRangeTask = (pTask, fOnDone) =>
						{
							if (tmpTriggers < 3)
							{
								// Every pass sees a new trigger (a divergence rebuild elsewhere, say).
								tmpTriggers++;
								W.Freshness.setState(STORE, ENTITY, 'Rebuilding', 'Divergence');
								W.Freshness.setState(STORE, ENTITY, 'Unverified', 'Rebuilt:Divergence');
							}
							return tmpAddRange(pTask, fOnDone);
						};
						W.Reconciler.verify(STORE, ENTITY,
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.Verified).to.equal(false);
								Expect(pResult.Reason).to.equal('NewerTrigger');
								Expect(pResult.Attempts).to.equal(libRetoldFacetingReconciler.VERIFY_MAX_ATTEMPTS);
								Expect(W.Freshness.state(STORE, ENTITY).State).to.equal('Unverified');
								let W2 = newWorld({ Rows: 5 });
								W2.Reconciler.verify(STORE, ENTITY,
									(pLiveError, pLive) =>
									{
										Expect(pLive).to.include({ Verified: true, State: 'Live' });
										Expect(W2.Freshness.History.length).to.equal(1);
										fDone();
									});
							});
					});

				test('unknown entity → FACET_UNKNOWN_ENTITY for every level; no store → FACET_ENGINE_UNAVAILABLE',
					(fDone) =>
					{
						let W = newWorld();
						let tmpLevels = [ 'sweep', 'bisect', 'scrub', 'verify' ];
						let tmpDone = 0;
						tmpLevels.forEach(
							(pLevel) =>
							{
								let fCheck = (pError) =>
								{
									Expect(pError.Code, pLevel).to.equal('FACET_UNKNOWN_ENTITY');
									tmpDone++;
									if (tmpDone === tmpLevels.length)
									{
										W.fable.RetoldFacetingStoreClickHouse = null;
										W.Reconciler.bisect(STORE, ENTITY, {},
											(pUnavailable) =>
											{
												Expect(pUnavailable.Code).to.equal('FACET_ENGINE_UNAVAILABLE');
												fDone();
											});
									}
								};
								if (pLevel === 'verify')
								{
									return W.Reconciler.verify(STORE, 'Nope', fCheck);
								}
								W.Reconciler[pLevel](STORE, 'Nope', {}, fCheck);
							});
					});
			}
		);

		suite
		(
			'Reconciler: timers (unit)',
			() =>
			{
				test('start() arms unref\'d timers per entity (Sweep only with a watermark, Bisect, paced Scrub); stop() clears them; AutoStart false arms nothing',
					(fDone) =>
					{
						let W = newWorld({ Rows: 6, Options: { Reconcile: { AutoStart: true, SweepIntervalMS: 20, BisectIntervalMS: 25, ScrubTickMS: 10, ScrubRowsPerSecond: 300, ScrubPeriodMS: 50, SweepCap: 4, LeafRange: 10 } } });
						let tmpRuns = { Sweep: 0, Bisect: 0, Scrub: 0 };
						[ 'sweep', 'bisect', 'scrub' ].forEach(
							(pLevel) =>
							{
								let fOriginal = W.Reconciler[pLevel].bind(W.Reconciler);
								W.Reconciler[pLevel] = (pStore, pEntity, pOptions, fCallback) =>
								{
									tmpRuns[pLevel[0].toUpperCase() + pLevel.slice(1)]++;
									return fOriginal(pStore, pEntity, pOptions, fCallback);
								};
							});
						W.Reconciler.start(STORE);
						W.Reconciler.start(STORE);
						Expect(W.Reconciler._Timers.length, 'idempotent: three timers once').to.equal(3);
						W.Reconciler._Timers.forEach((pTimer) => { Expect(pTimer.hasRef()).to.equal(false); });
						setTimeout(
							() =>
							{
								Expect(tmpRuns.Sweep).to.be.above(0);
								Expect(tmpRuns.Bisect).to.be.above(0);
								Expect(tmpRuns.Scrub).to.be.above(0);
								W.Reconciler.stop();
								Expect(W.Reconciler._Timers.length).to.equal(0);
								let tmpFrozen = Object.assign({}, tmpRuns);
								setTimeout(
									() =>
									{
										Expect(tmpRuns).to.deep.equal(tmpFrozen);
										// A NoWatermark entity gets no Sweep timer; AutoStart false arms nothing.
										let W2 = newWorld({ Watermark: null, Options: { Reconcile: { AutoStart: true } } });
										W2.Reconciler.start(STORE);
										Expect(W2.Reconciler._Timers.length).to.equal(2);
										W2.Reconciler.stop();
										let W3 = newWorld();
										W3.Reconciler.start(STORE);
										Expect(W3.Reconciler._Timers.length).to.equal(0);
										fDone();
									}, 80);
							}, 150);
					});

				test('timers skip entities that are Building / Absent / Degraded / Rebuilding',
					(fDone) =>
					{
						let W = newWorld({ Rows: 6, Options: { Reconcile: { AutoStart: true, SweepIntervalMS: 10, BisectIntervalMS: 10, ScrubTickMS: 10 } } });
						W.Freshness.setState(STORE, ENTITY, 'Building', 'Test');
						W.Reconciler.start(STORE);
						setTimeout(
							() =>
							{
								W.Reconciler.stop();
								Expect(W.Source.Calls.sweep.length).to.equal(0);
								Expect(W.Source.Calls.checksums).to.equal(0);
								Expect(W.Loop.Tasks.length).to.equal(0);
								fDone();
							}, 60);
					});

				test('the paced rotation: one pass per ScrubPeriodMS once the entity size is known, batched for small entities',
					() =>
					{
						let W = newWorld({ Rows: 6, Options: { Reconcile: { AutoStart: false, ScrubTickMS: 1000, ScrubRowsPerSecond: 2000, ScrubPeriodMS: 86400000 } } });
						let tmpCaps = [];
						W.Reconciler.scrub = (pStore, pEntity, pOptions, fCallback) => { tmpCaps.push(pOptions.Cap); fCallback(null, {}); };
						W.Freshness.setState(STORE, ENTITY, 'Live', 'Test');
						// Unknown size (no seed, no wrap yet): the conservative pace (ScrubUnknownTotalRowsPerTick), never
						// the ceiling — after a restart every large entity would otherwise be re-read at full speed.
						W.Reconciler._scrubTick(STORE, ENTITY);
						Expect(tmpCaps).to.deep.equal([ 256 ]);
						// 85 M rows: ~984 rows per tick (one pass a day).
						let tmpRecord = W.Reconciler._record(STORE, ENTITY);
						tmpRecord.Total = 85000000;
						tmpRecord.Owed = 0;
						W.Reconciler._scrubTick(STORE, ENTITY);
						Expect(tmpCaps[1]).to.equal(Math.floor(85000000 * 1000 / 86400000));
						// 6 rows: nothing until the whole entity is owed (once a day), then 6 at once.
						tmpRecord.Total = 6;
						tmpRecord.Owed = 0;
						for (let i = 0; i < 86410; i++)
						{
							W.Reconciler._scrubTick(STORE, ENTITY);
						}
						Expect(tmpCaps.length).to.equal(3);
						Expect(tmpCaps[2]).to.equal(6);
					});
			}
		);

		// ------------------------------------------------------------------ ClickHouse-gated

		suite
		(
			'On ClickHouse: the real WriterLoop, store and source (gated)',
			function ()
			{
				let tmpAvailable = libSupport.available();
				if (!tmpAvailable.Available)
				{
					test.skip(`ClickHouse suites are gated (${tmpAvailable.Reason})`, () => {});
					return;
				}
				this.timeout(120000);

				const libHarness = require('./support/Facet-Test-Harness.js');
				const libWriterLoop = require('../source/persistence/Retold-Faceting-WriterLoop.js');
				const libPendingSet = require('../source/persistence/Retold-Faceting-PendingSet.js');
				const libFlushBuffer = require('../source/persistence/Retold-Faceting-FlushBuffer.js');
				const libWriterClock = require('../source/persistence/Retold-Faceting-WriterClock.js');
				const libDDL = require('../source/store/clickhouse/ClickHouse-DDL.js');

				// Task and Project are loaded statically (Live); Issue is declared but left for a backfill.
				const MATERIALIZE = { Task: { Store: [ STORE ], Watermark: 'UpdateDate' }, Project: { Store: [ STORE ] }, Issue: { Store: [ STORE ] } };
				const OPTIONS = (
					{
						Materializer: { FlushIntervalMS: 50, IdleTickMS: 10, RebuildPageSize: 60, BatchIDs: 500 },
						Reconcile: { AutoStart: false, LeafRange: 100, SweepCap: 40, MaxTxnMS: 5000 }
					});

				let _Harness = null;
				let _Database = null;
				let _Original = null;
				let M = null;

				/**
				 * The Materializer's documented surface over B's real per-entity classes (WriterLoop,
				 * PendingSet, FlushBuffer, WriterClock) attached to A's real store and B's real source:
				 * no ChangeIntake subscription (tests hint through enqueue), no state writes.
				 */
				class MiniMaterializer
				{
					constructor(pHarness, pSpecs, pStates)
					{
						this.fable = pHarness.faceting.fable;
						this.Store = this.fable.RetoldFacetingStoreClickHouse;
						this.Freshness = this.fable.RetoldFacetingFreshness;
						this.Clock = new libWriterClock(this.fable, pHarness.faceting.options, STORE);
						this.Entities = {};
						Object.keys(pSpecs).forEach(
							(pEntity) =>
							{
								let tmpOptions = pHarness.faceting.options;
								let tmpPending = new libPendingSet(this.fable, tmpOptions, `${STORE}:${pEntity}`);
								let tmpBuffer = new libFlushBuffer(this.fable, tmpOptions, `${STORE}:${pEntity}`);
								let tmpLoop = new libWriterLoop(this.fable, tmpOptions, `${STORE}:${pEntity}`);
								let tmpLive = (pStates[pEntity] !== 'Absent');
								tmpLoop.attach(
									{
										StoreName: STORE, Entity: pEntity, Store: this.Store, Spec: pSpecs[pEntity], Clock: this.Clock,
										PendingSet: tmpPending, FlushBuffer: tmpBuffer, Source: this.fable.RetoldFacetingMaterializeSourceInProcess,
										Freshness: this.Freshness, Targets: tmpLive ? [ 'Live' ] : []
									});
								this.Freshness.register(STORE, pEntity, { State: pStates[pEntity] });
								this.Entities[pEntity] = { Loop: tmpLoop, PendingSet: tmpPending, FlushBuffer: tmpBuffer };
							});
					}

					loop(pStore, pEntity)
					{
						return ((pStore === STORE) && this.Entities[pEntity]) ? this.Entities[pEntity].Loop : null;
					}

					enqueue(pStore, pEntity, pIDs, pOptions)
					{
						let tmpEntity = this.Entities[pEntity];
						if ((pStore !== STORE) || !tmpEntity)
						{
							return 0;
						}
						pIDs.forEach((pID) => { tmpEntity.PendingSet.add(pID, null, performance.now()); });
						tmpEntity.Loop.kick();
						return pIDs.length;
					}

					isPending(pStore, pEntity, pID)
					{
						return !!this.Entities[pEntity] && this.Entities[pEntity].PendingSet.has(pID);
					}

					pendingInfo(pStore, pEntity)
					{
						let tmpEntity = this.Entities[pEntity];
						if (!tmpEntity)
						{
							return null;
						}
						return Object.assign({}, tmpEntity.PendingSet.info(), { Buffered: tmpEntity.FlushBuffer.size(), Resolving: 0 });
					}

					setState(pStore, pEntity, pState, pReason)
					{
						this.Freshness.setState(pStore, pEntity, pState, pReason);
					}

					quiesce(fCallback)
					{
						waitFor(() => { return Object.keys(this.Entities).every((pEntity) => { return this.Entities[pEntity].Loop.quiet(); }); }, 30000, fCallback);
					}

					halt()
					{
						Object.keys(this.Entities).forEach((pEntity) => { this.Entities[pEntity].Loop.halt('Test'); });
					}
				}

				let rawSQL = (pSQL, pParams) => { return _Harness.db.prepare(pSQL).run(...(pParams || [])); };
				let getSQL = (pSQL, pParams) => { return _Harness.db.prepare(pSQL).get(...(pParams || [])); };
				let fable = () => { return _Harness.faceting.fable; };
				let state = (pEntity) => { return fable().RetoldFacetingFreshness.state(STORE, pEntity).State; };
				let assertMirror = (pEntity, fCallback) =>
				{
					M.quiesce(
						(pQuiesceError) =>
						{
							if (pQuiesceError)
							{
								return fCallback(pQuiesceError);
							}
							libSupport.assertMirrorEqualsSource(_Harness, STORE, pEntity,
								(pError) =>
								{
									if (pError)
									{
										pError.message = `${pEntity}: ${pError.message} ${JSON.stringify(pError.Report || {})}`;
									}
									return fCallback(pError || null);
								});
						});
				};
				let shadowTables = (fCallback) =>
				{
					fable().RetoldFacetingStoreClickHouse.queryRows('SELECT name FROM system.tables WHERE database = {db:String} AND position(name, {infix:String}) > 0',
						{ db: _Database, infix: libDDL.SHADOW_INFIX }, null, null,
						(pError, pRows) => { return fCallback(pError, (pRows || []).map((pRow) => { return pRow.name; })); });
				};

				suiteSetup(
					(fDone) =>
					{
						libSupport.ensure(
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								_Harness = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Faceting: OPTIONS },
									(pStartError) =>
									{
										if (pStartError)
										{
											return fDone(pStartError);
										}
										_Database = libSupport.freshDatabase();
										libSupport.loadMirrors(_Harness, { Database: _Database, Materialize: { Task: MATERIALIZE.Task, Project: MATERIALIZE.Project } },
											(pLoadError) =>
											{
												if (pLoadError)
												{
													return fDone(pLoadError);
												}
												let tmpMirrorSpec = fable().RetoldFacetingMirrorSpec;
												let tmpCompiled = tmpMirrorSpec.compile(MATERIALIZE, { Stores: [ STORE ] });
												let tmpSpecs = tmpCompiled.Specs[STORE];
												Expect(Object.keys(tmpSpecs).sort()).to.deep.equal([ 'Issue', 'Project', 'Task' ]);
												fable().RetoldFacetingStoreClickHouse.ensureSchema(tmpSpecs,
													(pSchemaError, pSchema) =>
													{
														if (pSchemaError)
														{
															return fDone(pSchemaError);
														}
														Expect(pSchema.Entities.Issue.MirrorExists).to.equal(false);
														fable().RetoldFacetingStoreClickHouse.maxVersion(
															(pVersionError, pMax) =>
															{
																if (pVersionError)
																{
																	return fDone(pVersionError);
																}
																_Original = fable().RetoldFacetingMaterializer;
																M = new MiniMaterializer(_Harness, tmpSpecs, { Task: 'Live', Project: 'Live', Issue: 'Absent' });
																M.Clock.seed(pMax);
																fable().RetoldFacetingMaterializer = M;
																return fDone();
															});
													});
											});
									});
							});
					});

				suiteTeardown(
					(fDone) =>
					{
						if (M)
						{
							M.halt();
						}
						if (_Harness && _Original)
						{
							fable().RetoldFacetingMaterializer = _Original;
						}
						let fStop = () => { return _Harness ? _Harness.stop(fDone) : fDone(); };
						if (!_Database)
						{
							return fStop();
						}
						libSupport.release(_Database, () => { fStop(); });
					});

				test('backfill (first enable) of Issue over the real loop: Building → RENAME → CatchingUp → Live; the mirror equals the source',
					(fDone) =>
					{
						fable().RetoldFacetingRebuilder.backfill(STORE, 'Issue', {},
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.State).to.equal('Live');
								Expect(pResult.Pages).to.be.at.least(2);
								Expect(state('Issue')).to.equal('Live');
								shadowTables(
									(pShadowError, pShadows) =>
									{
										Expect(pShadowError || null).to.equal(null);
										Expect(pShadows, 'the RENAMEd shadow is gone').to.deep.equal([]);
										assertMirror('Issue', fDone);
									});
							});
					});

				test('rebuild of Task while hinted writes stream in (dual-write window on the real loop): EXCHANGE → Live; the mirror equals the source',
					(fDone) =>
					{
						let tmpIDs = _Harness.db.prepare('SELECT IDTask FROM Task WHERE Deleted = 0 ORDER BY IDTask LIMIT 60').all().map((pRow) => { return pRow.IDTask; });
						let tmpWrites = 0;
						let tmpStates = new Set();
						let tmpTimer = setInterval(
							() =>
							{
								tmpWrites++;
								let tmpID = tmpIDs[tmpWrites % tmpIDs.length];
								if (tmpWrites % 9 === 0)
								{
									rawSQL('UPDATE Task SET Deleted = 1 WHERE IDTask = ?', [ tmpID ]);
								}
								else if (tmpWrites % 13 === 0)
								{
									rawSQL('DELETE FROM Task WHERE IDTask = ?', [ tmpID ]);
								}
								else
								{
									rawSQL('UPDATE Task SET Status = ? WHERE IDTask = ?', [ `w${tmpWrites}`, tmpID ]);
								}
								M.enqueue(STORE, 'Task', [ tmpID ], { Source: 'Change' });
								tmpStates.add(state('Task'));
							}, 10);
						fable().RetoldFacetingRebuilder.rebuild(STORE, 'Task', { Reason: 'Admin' },
							(pError, pResult) =>
							{
								clearInterval(tmpTimer);
								Expect(pError).to.equal(null);
								Expect(pResult.State).to.equal('Live');
								Expect(pResult.Pages).to.be.at.least(5);
								Expect(tmpStates.has('Rebuilding')).to.equal(true);
								Expect(tmpWrites).to.be.at.least(3);
								shadowTables(
									(pShadowError, pShadows) =>
									{
										Expect(pShadows, 'the old tables were dropped after the EXCHANGE').to.deep.equal([]);
										assertMirror('Task', fDone);
									});
							});
					});

				test('cancel on the real loop: the shadow tables are dropped and the entity is Live again',
					(fDone) =>
					{
						let tmpLoop = M.loop(STORE, 'Project');
						let tmpCancelled = false;
						tmpLoop.setTestHook('afterRead',
							(pInfo) =>
							{
								if (!tmpCancelled)
								{
									tmpCancelled = true;
									fable().RetoldFacetingRebuilder.cancel(STORE, 'Project', () => {});
								}
							});
						fable().RetoldFacetingRebuilder.rebuild(STORE, 'Project', { Reason: 'Admin' },
							(pError) =>
							{
								tmpLoop.setTestHook('afterRead', null);
								Expect(pError && pError.Cancelled).to.equal(true);
								Expect(state('Project')).to.equal('Live');
								waitFor(() => { return tmpLoop.targets().length === 1; }, 5000,
									() =>
									{
										Expect(tmpLoop.targets()).to.deep.equal([ 'Live' ]);
										M.quiesce(
											() =>
											{
												shadowTables(
													(pShadowError, pShadows) =>
													{
														Expect(pShadows).to.deep.equal([]);
														assertMirror('Project', fDone);
													});
											});
									});
							});
					});

				test('raw SQL without hints: the Sweep repairs a stamped update, the Scrub an unstamped one, Bisect a raw insert and a raw hard delete',
					(fDone) =>
					{
						let tmpReconciler = fable().RetoldFacetingReconciler;
						let tmpIDs = _Harness.db.prepare('SELECT IDTask FROM Task WHERE Deleted = 0 ORDER BY IDTask LIMIT 3 OFFSET 100').all().map((pRow) => { return pRow.IDTask; });
						rawSQL("UPDATE Task SET Status = 'swept', UpdateDate = datetime('now') WHERE IDTask = ?", [ tmpIDs[0] ]);
						tmpReconciler.sweep(STORE, 'Task', {},
							(pSweepError, pSweep) =>
							{
								Expect(pSweepError).to.equal(null);
								Expect(pSweep.Pages).to.be.at.least(1);
								Expect(pSweep.Enqueued).to.be.at.least(1);
								Expect(pSweep.Watermark).to.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
								// A second Sweep reads only the overlap window.
								tmpReconciler.sweep(STORE, 'Task', {},
									(pSecondError, pSecond) =>
									{
										Expect(pSecondError).to.equal(null);
										Expect(pSecond.Enqueued).to.be.below(pSweep.Enqueued + 1);
										rawSQL("UPDATE Task SET Status = 'scrubbed' WHERE IDTask = ?", [ tmpIDs[1] ]);
										tmpReconciler.scrub(STORE, 'Task', { Full: true },
											(pScrubError, pScrub) =>
											{
												Expect(pScrubError).to.equal(null);
												Expect(pScrub.Wrapped).to.equal(true);
												let tmpMax = getSQL('SELECT MAX(IDTask) AS M FROM Task').M;
												let tmpTemplate = getSQL('SELECT * FROM Task WHERE IDTask = ?', [ tmpIDs[2] ]);
												tmpTemplate.IDTask = tmpMax + 1;
												tmpTemplate.GUIDTask = `rr-${tmpMax + 1}`;
												let tmpColumns = Object.keys(tmpTemplate);
												rawSQL(`INSERT INTO Task (${tmpColumns.join(', ')}) VALUES (${tmpColumns.map(() => { return '?'; }).join(', ')})`, tmpColumns.map((pColumn) => { return tmpTemplate[pColumn]; }));
												rawSQL('DELETE FROM Task WHERE IDTask = ?', [ tmpIDs[2] ]);
												M.quiesce(
													() =>
													{
														// The source side of Bisect: one bucket per LeafRange IDs, summing to the live rows.
														fable().RetoldFacetingMaterializeSourceInProcess.checksums('Task', 100,
															(pSumsError, pSums) =>
															{
																Expect(pSumsError || null).to.equal(null);
																let tmpLive = getSQL('SELECT COUNT(*) AS N FROM Task WHERE Deleted = 0 AND IDCustomer IS NOT NULL AND IDCustomer <> 0').N;
																let tmpTotal = Object.keys(pSums).reduce((pSum, pKey) => { return pSum + Number(pSums[pKey].Count); }, 0);
																Expect(tmpTotal, 'MaterializeSource.checksums counts every live row once (bucket = ID / LeafRange, integer division)').to.equal(tmpLive);
														tmpReconciler.bisect(STORE, 'Task', { Escalate: false },
															(pBisectError, pBisect) =>
															{
																Expect(pBisectError).to.equal(null);
																Expect(pBisect.DifferingLeaves).to.be.within(1, 2);
																Expect(pBisect.Enqueued).to.equal(2);
																assertMirror('Task',
																	(pMirrorError) =>
																	{
																		if (pMirrorError)
																		{
																			return fDone(pMirrorError);
																		}
																		// Repaired: a second Bisect finds nothing.
																		tmpReconciler.bisect(STORE, 'Task', { Escalate: false },
																			(pAgainError, pAgain) =>
																			{
																				Expect(pAgainError).to.equal(null);
																				Expect(pAgain.Enqueued).to.equal(0);
																				Expect(pAgain.Divergence).to.equal(0);
																				fDone();
																			});
																	});
															});
															});
													});
											});
									});
							});
					});

				test('divergence above the ratio escalates to a rebuild that ends Unverified; the verify that follows makes it Live; identical',
					(fDone) =>
					{
						let tmpReconciler = fable().RetoldFacetingReconciler;
						// ~8% of Project rows changed behind the hints' back (raw hard deletes, never hinted).
						let tmpRows = _Harness.db.prepare('SELECT IDProject FROM Project WHERE Deleted = 0 AND IDProject > 20 ORDER BY IDProject').all();
						let tmpVictims = tmpRows.slice(0, Math.ceil(tmpRows.length * 0.08));
						tmpVictims.forEach((pRow) => { rawSQL('DELETE FROM ProjectMembership WHERE IDProject = ?', [ pRow.IDProject ]); rawSQL('DELETE FROM Project WHERE IDProject = ?', [ pRow.IDProject ]); });
						let tmpSeen = new Set();
						let tmpWatch = setInterval(() => { tmpSeen.add(state('Project')); }, 2);
						tmpReconciler.bisect(STORE, 'Project', {},
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.Divergence).to.be.above(0.01);
								Expect(pResult.Rebuilt).to.equal(true);
								waitFor(() => { return state('Project') === 'Live'; }, 30000,
									(pWaitError) =>
									{
										clearInterval(tmpWatch);
										Expect(pWaitError || null).to.equal(null);
										Expect(tmpSeen.has('Unverified'), 'the divergence rebuild ended Unverified').to.equal(true);
										Expect(fable().RetoldFacetingFreshness.state(STORE, 'Project').Reason).to.equal('Verified');
										assertMirror('Project', fDone);
									});
							});
					});

				test('verify: an Unverified entity (an unclean boot) gets a Bisect and a full Scrub over the real loop and goes Live',
					(fDone) =>
					{
						// Lost hints: in-place updates and an insert nobody announced.
						let tmpIDs = _Harness.db.prepare('SELECT IDIssue FROM Issue WHERE Deleted = 0 ORDER BY IDIssue LIMIT 2').all().map((pRow) => { return pRow.IDIssue; });
						rawSQL("UPDATE Issue SET State = 'lost' WHERE IDIssue = ?", [ tmpIDs[0] ]);
						rawSQL('UPDATE Issue SET Deleted = 1 WHERE IDIssue = ?', [ tmpIDs[1] ]);
						fable().RetoldFacetingFreshness.setState(STORE, 'Issue', 'Unverified', 'UncleanShutdown');
						fable().RetoldFacetingReconciler.verify(STORE, 'Issue',
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.Verified).to.equal(true);
								Expect(state('Issue')).to.equal('Live');
								assertMirror('Issue', fDone);
							});
					});
			}
		);

		suite
		(
			'On ClickHouse: admin triggers and routes (gated; needs the wiring)',
			function ()
			{
				let tmpAvailable = libSupport.available();
				const libRetoldFacetingService = require('../source/Retold-Faceting-Service.js');
				let tmpWired = (typeof(libRetoldFacetingService.prototype.installStores) === 'function') && (typeof(libRetoldFacetingService.prototype.storeAdmin) === 'function');
				if (!tmpAvailable.Available || !tmpWired)
				{
					test.skip(!tmpAvailable.Available ? `ClickHouse suites are gated (${tmpAvailable.Reason})`
						: 'storeAdmin / the harness Store option are the wiring\'s (internal-contracts §60.5, §62.6): not present yet', () => {});
					return;
				}
				this.timeout(120000);

				const libHarness = require('./support/Facet-Test-Harness.js');
				let _Harness = null;

				suiteSetup(
					(fDone) =>
					{
						libSupport.ensure(
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								_Harness = libHarness.start(
									{
										Port: PORT, Fixture: 'ProjectTrack', Store: 'ClickHouse',
										StoreOptions: { Materialize: { Task: { Store: [ STORE ], Watermark: 'UpdateDate' }, Project: { Store: [ STORE ] } }, Reconcile: { AutoStart: false } },
										Faceting: { Materializer: { RebuildPageSize: 100, FlushIntervalMS: 50, IdleTickMS: 10 }, Reconcile: { AutoStart: false, LeafRange: 100, SweepCap: 40 }, Admin: { RebuildCooldownMS: 60000 } }
									}, fDone);
							});
					});

				suiteTeardown(
					(fDone) =>
					{
						if (!_Harness)
						{
							return fDone();
						}
						_Harness.stop(fDone);
					});

				let quiesce = (fCallback) =>
				{
					if (typeof(_Harness.quiesce) === 'function')
					{
						return _Harness.quiesce(fCallback);
					}
					_Harness.materializer.quiesce(STORE, null, 20000, fCallback);
				};

				test('storeAdmin: Rebuild / Sweep / Bisect / Scrub / Verify run; busy → 429, cooldown → 429, unknown → 404',
					(fDone) =>
					{
						let tmpService = _Harness.faceting;
						tmpService.storeAdmin('Bisect', STORE, ENTITY, {},
							(pError, pResult) =>
							{
								Expect(pError || null).to.equal(null);
								Expect(pResult).to.be.an('object');
								tmpService.storeAdmin('Sweep', STORE, 'NoSuchEntity', {},
									(pUnknown) =>
									{
										Expect(pUnknown.Status).to.equal(404);
										Expect(pUnknown.Code).to.equal('FACET_UNKNOWN_ENTITY');
										let tmpFirst = null;
										tmpService.storeAdmin('Scrub', STORE, ENTITY, { Full: true }, (pScrubError) => { tmpFirst = pScrubError || false; });
										tmpService.storeAdmin('Scrub', STORE, ENTITY, { Full: true },
											(pBusy) =>
											{
												Expect(pBusy.Status).to.equal(429);
												Expect(pBusy.Code).to.equal('FACET_RATE_LIMITED');
												Expect(pBusy.Detail.Limit).to.equal('Admin.InFlight');
												waitFor(() => { return tmpFirst !== null; }, 20000,
													() =>
													{
														Expect(tmpFirst).to.equal(false);
														tmpService.storeAdmin('Verify', STORE, ENTITY, {},
															(pVerifyError) =>
															{
																Expect(pVerifyError || null).to.equal(null);
																tmpService.storeAdmin('Rebuild', STORE, ENTITY, {},
																	(pRebuildError) =>
																	{
																		Expect(pRebuildError || null).to.equal(null);
																		tmpService.storeAdmin('Rebuild', STORE, ENTITY, {},
																			(pCooldown) =>
																			{
																				Expect(pCooldown.Status).to.equal(429);
																				Expect(pCooldown.Detail.Limit).to.equal('Admin.RebuildCooldownMS');
																				quiesce(
																					() =>
																					{
																						libSupport.assertMirrorEqualsSource(_Harness, STORE, ENTITY, (pMirrorError) => { fDone(pMirrorError || undefined); });
																					});
																			});
																	});
															});
													});
											});
									});
							});
					});

				test('admin routes: not mounted unless Admin.Routes; mounted without authorize → 403',
					(fDone) =>
					{
						_Harness.request('POST', `/1.0/Facet/Admin/Rebuild/${STORE}/${ENTITY}`, {}, _Harness.as('Lead'),
							(pError, pResponse) =>
							{
								Expect(pError || null).to.equal(null);
								Expect(pResponse.Status, 'Admin.Routes is off by default').to.be.oneOf([ 404, 405 ]);
								let tmpGuarded = libHarness.start(
									{
										Port: PORT, Fixture: 'ProjectTrack', Store: 'ClickHouse',
										StoreOptions: { Materialize: { Task: { Store: [ STORE ] } }, Reconcile: { AutoStart: false } },
										Faceting: { Admin: { Routes: true, authorize: null } }
									},
									(pStartError) =>
									{
										Expect(pStartError || null).to.equal(null);
										tmpGuarded.request('POST', `/1.0/Facet/Admin/Rebuild/${STORE}/${ENTITY}`, {}, tmpGuarded.as('Lead'),
											(pRouteError, pRoute) =>
											{
												Expect(pRoute.Status).to.equal(403);
												Expect(pRoute.Body.Error.Code).to.equal('FACET_FORBIDDEN');
												tmpGuarded.stop(fDone);
											});
									});
							});
					});
			}
		);
	}
);
